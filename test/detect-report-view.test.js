'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildDetectReportView,
  pickAiSentence,
  resolveProfessorRadar,
  PARA_HOT_RATIO,
  splitExamplePreview,
  mostChangedSpan,
  changedSpans,
  EXAMPLE_PREVIEW_MIN,
  EXAMPLE_PREVIEW_MAX
} = require('../lib/detectReportView');

test('교수님 레이더는 공식 표시 점수와 같은 값으로 20·21·49·50 경계를 나눈다', () => {
  const cases = [
    [0, 'low', '피하기에 유리한 편'],
    [20, 'low', '피하기에 유리한 편'],
    [21, 'revise', '보완 후 제출 권장'],
    [49, 'revise', '보완 후 제출 권장'],
    [50, 'hard', '지금은 피하기 어려운 편'],
    [100, 'hard', '지금은 피하기 어려운 편']
  ];
  for (const [score, band, label] of cases) {
    const radar = resolveProfessorRadar(score);
    assert.equal(radar.score, score);
    assert.equal(radar.band, band);
    assert.equal(radar.label, label);
    assert.match(radar.disclaimer, /보장하지 않아요/u);
  }
});

test('72점 대표 사례는 엔진 측정값과 두 축 설명을 그대로 보존한다', () => {
  const reportView = buildDetectReportView({
    probability: 72,
    probSource: 'llm',
    riskLevel: 'high',
    measurements: {
      uniformity: { maxEndingRun: 5, avgLength: 57.0, lengthCV: 0.188, paragraphCountCV: 0 },
      genericness: { ratio: 0.375, count: 3, total: 8 },
      realAnchorDensity: { ratio: 0, count: 0, total: 8 },
      detail: [{ lived: 1, specific: 0, generic: 3, sents: 8, kind: 'concrete' }]
    }
  });

  assert.equal(reportView.version, 'evidence-v2');
  assert.equal(reportView.status, 'ready');
  assert.equal(reportView.styleSignal.score, 72);
  assert.equal(reportView.professorRadar.score, 72, '교수님 레이더 점수는 표시 점수와 달라지면 안 된다');
  assert.equal(reportView.professorRadar.band, 'hard');
  assert.equal(reportView.professorRadar.label, '지금은 피하기 어려운 편');
  assert.deepEqual(reportView.contentEvidence, {
    status: 'mixed', label: '구체 근거 일부', lived: 1, specific: 0,
    generic: 3, total: 8, groundedRatio: 0.125
  });
  assert.equal(reportView.measuredEvidence.maxEndingRun, 5);
  assert.equal(reportView.measuredEvidence.avgLength, 57);
  assert.equal(reportView.measuredEvidence.lengthCV, 0.188);
  assert.equal(reportView.measuredEvidence.genericCount, 3);
  assert.equal(reportView.measuredEvidence.livedCount, 1);
  assert.equal(reportView.measuredEvidence.specificCount, 0);
  assert.equal(reportView.synthesis.headline, '문장 패턴은 정형적이고, 구체적인 근거는 일부만 확인됐어요.');
  assert.match(reportView.synthesis.limitation, /작성 주체나 외부 검사 결과를 확정하지 않아요/u);
});

test('점수나 문장 근거가 불완전하면 판정을 제한하고 전환 CTA 대상에서 제외한다', () => {
  const reportView = buildDetectReportView({ probability: null, measurements: {} });
  assert.equal(reportView.status, 'limited');
  assert.equal(reportView.alignment.status, 'limited');
  assert.equal(reportView.professorRadar.band, 'unknown');
  assert.equal(reportView.conversion.eligible, false);
  assert.match(reportView.synthesis.description, /유료 수정을 권하지 않고/u);
});

test('AI 모델 실패로 엔진 간이 추정을 쓴 결과는 출처를 밝히고 판매 CTA에서 제외한다', () => {
  const reportView = buildDetectReportView({
    probability: 72,
    probSource: 'engine',
    riskLevel: 'high',
    measurements: {
      uniformity: { maxEndingRun: 5, avgLength: 57, lengthCV: 0.188 },
      genericness: { count: 3, total: 8, ratio: 0.375 },
      detail: [{ lived: 1, specific: 0, sents: 8 }]
    }
  });

  assert.equal(reportView.status, 'limited');
  assert.equal(reportView.styleSignal.status, 'limited');
  assert.equal(reportView.styleSignal.source, 'engine');
  assert.equal(reportView.styleSignal.sourceLabel, '문체 엔진 간이 추정');
  assert.equal(reportView.professorRadar.band, 'unknown');
  // 금지 표현('판정 보류')을 화면에 내지 않으면서 모델 판정처럼 단정하지도 않는다.
  assert.equal(reportView.professorRadar.label, '간이 추정 기준');
  assert.ok(!/판정 보류/u.test(reportView.professorRadar.label), '금지 표현이 화면 값에 들어가지 않는다');
  assert.equal(reportView.conversion.eligible, false);
  assert.match(reportView.synthesis.headline, /간이 추정/u);
});

test('미리보기는 구체 문단 전체가 아니라 문장별로 골라 경험·사실 문장을 보존한다', () => {
  const lived = '지난 학기에 저는 팀 회의에서 의견을 직접 정리했고 발표 자료를 다시 만들었습니다.';
  const generic = '현대 사회에서 협업의 중요성은 조직의 지속적인 성장과 안정적인 운영을 위해 반드시 고려해야 하는 핵심 요소라고 할 수 있습니다.';
  const paragraph = `${lived} ${generic}`;
  const picked = pickAiSentence([paragraph], [{ kind: 'concrete' }]);
  assert.equal(picked, generic, '구체 문단 안의 일반론 문장은 미리보기 후보가 되어야 한다');

  const factOnly = '연구 참여자는 12명이었으며 결과를 여러 단계로 나누어 표로 정리하고 다시 검토했습니다.';
  assert.equal(pickAiSentence([factOnly], [{ kind: 'concrete' }]), null, '구체 수치가 있는 사실 문장은 미리보기에서 제외한다');
});

test('문단 사유는 작성 주체를 단정하지 않고 관찰 가능한 내용 근거만 설명한다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'detectreport.js'), 'utf8');
  const concreteReason = src.match(/concrete:\s*'([^']+)'/u)?.[1] || '';
  assert.ok(concreteReason);
  assert.doesNotMatch(concreteReason, /사람이\s*쓴\s*글/u);
  assert.match(concreteReason, /관찰/u);
});

// ── 문장 지도 ────────────────────────────────────────────────────────────────
const sg = require('../engine/surfaceguard');
const { buildSentenceMap, SENTENCE_SHOW_CAP } = require('../lib/detectReportView');

const SAMPLE = '기업 연계형 프로젝트에서 보고서 양식이 갑작스럽게 변경된 상황에서 AI를 활용해 제한된 시간 안에 보고서를 재구성했습니다. 기존 보고서의 내용과 실험자료를 버리고 새로 작성하기보다, 유지해야 할 내용과 새 양식에서 추가된 항목을 먼저 구분했습니다. 이후 프로젝트를 진행하며 축적한 실험 결과와 소재별 특성, 제품의 장점 등을 AI에게 제공하고 기존 내용과 새 요구사항을 연결하도록 요청했습니다. 저는 AI가 만든 결과를 그대로 사용하지 않고 실제 수행 내용과 일치하는지, 기술적으로 부정확한 부분은 없는지, 제품의 장점이 과장되지 않았는지를 직접 검토하고 수정했습니다. 또한 처음 접하는 용어나 소재 특성이 등장하면 AI를 활용해 관련 내용을 확인한 뒤 필요한 정보만 선별해 반영했습니다. 그 결과 기존 프로젝트의 핵심 내용을 유지하면서 변경된 양식에 맞는 보고서를 완성할 수 있었습니다. 이 경험을 통해 AI의 활용 가치는 답을 대신 생성하는 데 있는 것이 아니라, 목적과 기준을 먼저 정하고 결과를 검증, 조정하는 과정에서 높아진다는 것을 배웠습니다. 입사 후에도 AI와 데이터 기반 도구를 업무 목적에 맞게 활용하되, 결과에 대한 판단과 책임은 스스로 지겠습니다.';

// 일반론만 있는 문단 — 문단 지도가 "신호 많음"으로 진하게 칠하는 쪽
const GENERIC_PARA = '일반적으로 이러한 접근은 조직 전반에 걸쳐 중요하다고 할 수 있습니다. 결국 중요한 것은 도구가 아니라 사용하는 사람의 태도라고 볼 수 있습니다. 따라서 앞으로도 지속적인 관심과 노력이 필요하다고 생각합니다.';

function mapFor(text) {
  const paras = sg.splitParagraphsForReport(text);
  const detail = sg.analyzeParagraphs(paras.join('\n\n')).detail;
  return buildSentenceMap(paras, detail);
}

test('문장 지도는 같은 활용이 이어진 길이를 문서 순서로 계산한다', () => {
  const map = mapFor(SAMPLE);
  assert.equal(map.total, 8);
  assert.equal(map.capped, false);
  // 3글자("습니다")로 자르면 합니다체 전부가 같은 종결이 되어 신호가 아니다. 4글자 활용 단위로 본다.
  assert.equal(map.sentences[0].ending, '했습니다');
  assert.equal(map.sentences[7].ending, '겠습니다');
  assert.deepEqual(map.sentences.map(s => s.endingRun), [5, 5, 5, 5, 5, 0, 0, 0], '가장 긴 묶음(했습니다 ×5)만 표시하고 나머지는 칠하지 않는다');
  assert.equal(map.sentences.filter(s => s.runStart).length, 1);
  assert.equal(map.maxEndingRun, 5);
  assert.equal(map.sentences.filter(s => s.kind === 'lived').length, 1);
  assert.equal(map.sentences.filter(s => s.kind === 'generic').length, 3);
});

test('문장 지도는 문단 집계를 항상 전량으로 준다', () => {
  const map = mapFor(SAMPLE);
  assert.equal(map.paragraphs.length, 1);
  assert.equal(map.paragraphs[0].sentences, 8);
  assert.equal(map.paragraphs[0].maxEndingRun, 5);
  assert.equal(map.paragraphs[0].avgLength, 73.9);
});

test('장문은 문장 마크를 상한까지만 보내되 유지할 근거를 함께 남긴다', () => {
  const long = Array.from({ length: 60 }, () => SAMPLE).join('\n\n').slice(0, 30000);
  const map = mapFor(long);
  assert.ok(map.total > SENTENCE_SHOW_CAP, '3만자는 상한을 넘는 문장 수를 만든다');
  assert.equal(map.capped, true);
  assert.equal(map.sentences.length, SENTENCE_SHOW_CAP);
  assert.ok(map.sentences.some(s => s.kind === 'lived' || s.kind === 'specific'), '유지할 근거가 잘려 사라지지 않는다');
  assert.ok(map.sentences.some(s => s.kind === 'generic'), '다듬을 후보도 함께 남는다');
  const indexes = map.sentences.map(s => s.index);
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b), '원문 순서를 유지한다');
  assert.ok(map.paragraphs.length > 1 && map.paragraphs.every(p => p.sentences > 0), '문단 집계는 잘리지 않는다');
});

test('장문에서도 문단 지도가 진하게 칠할 문단은 모두 열린다', () => {
  // 실사고: 3만자 글에서 문단 지도 269칸 중 153칸이 눌러도 빈 목록이었고,
  //   그중 "신호 많음"으로 진하게 칠한 칸도 49개가 죽어 있었다(원문 순서로만 예산을 채운 탓).
  //   지도가 진하게 칠한 칸은 반드시 발췌가 있어야 한다 — 지도가 한 약속이다.
  // 신호가 짙은 문단(상투 문구만 있는 문단)과 구체 문단을 섞어 실제 장문에 가깝게 만든다.
  const long = Array.from({ length: 90 }, (_, i) => (i % 2 ? GENERIC_PARA : SAMPLE)).join('\n\n').slice(0, 30000);
  const map = mapFor(long);
  assert.equal(map.capped, true);

  const ratioOf = row => (row.sentences ? row.generic / row.sentences : 0);
  const hot = map.paragraphs.filter(row => ratioOf(row) >= PARA_HOT_RATIO);
  assert.ok(hot.length > 0, '3만자 글에는 신호가 짙은 문단이 존재한다');
  const deadHot = hot.filter(row => !row.excerpt);
  assert.equal(deadHot.length, 0,
    `진한 칸 ${hot.length}개 중 ${deadHot.length}개가 눌러도 빈 목록이다`);

  // excerpt는 실제 전달량과 일치해야 프론트가 칸을 정확히 고른다.
  const perParagraph = new Map();
  map.sentences.forEach(s => perParagraph.set(s.paragraph, (perParagraph.get(s.paragraph) || 0) + 1));
  map.paragraphs.forEach(row => {
    assert.equal(row.excerpt, perParagraph.get(row.index) || 0, `${row.index}번 문단 excerpt 불일치`);
  });
  assert.equal(
    map.paragraphs.reduce((sum, row) => sum + row.excerpt, 0),
    map.sentences.length,
    'excerpt 합계는 전달 문장 수와 같다'
  );
});

test('상한 안에 드는 글은 모든 문단에 발췌가 있다', () => {
  const map = mapFor(SAMPLE);
  assert.equal(map.capped, false);
  assert.ok(map.paragraphs.every(row => row.excerpt > 0), '자르지 않은 글은 문단 지도 전 칸이 열린다');
});

test('문장 지도 응답은 장문에서도 전송 가능한 크기를 유지한다', () => {
  const long = Array.from({ length: 60 }, () => SAMPLE).join('\n\n').slice(0, 30000);
  const bytes = Buffer.byteLength(JSON.stringify(mapFor(long)), 'utf8');
  assert.ok(bytes < 120 * 1024, `문장 지도가 ${Math.round(bytes / 1024)}KB로 커지면 상한을 다시 봐야 한다`);
});

test('보고서 상단 계측은 문장 지도와 같은 종결 기준으로 통일된다', () => {
  // 문장 지도와 엔진 measureUniformity가 같은 4글자 활용 기준을 쓰므로 값이 일치해야 한다.
  // 한 화면이 같은 것을 두 숫자로 말하던 사고(5 vs 8)의 재발을 막는다.
  const paras = sg.splitParagraphsForReport(SAMPLE);
  const joined = paras.join('\n\n');
  const detail = sg.analyzeParagraphs(joined).detail;
  const map = buildSentenceMap(paras, detail);
  const engineUniformity = sg.measureUniformity(joined);
  assert.equal(engineUniformity.maxEndingRun, map.maxEndingRun, '문장 지도와 엔진이 같은 4글자 활용 기준으로 같은 값을 낸다');

  const view = buildDetectReportView({
    probability: 72,
    probSource: 'llm',
    riskLevel: 'high',
    measurements: {
      uniformity: { ...engineUniformity, maxEndingRun: map.maxEndingRun },
      genericness: sg.measureGenericness(joined),
      realAnchorDensity: sg.measureRealAnchorDensity(joined),
      detail
    }
  });
  assert.equal(view.measuredEvidence.maxEndingRun, map.maxEndingRun);
  assert.equal(view.measuredEvidence.maxEndingRun, 5);
});

test('라우트는 문장 지도 값을 상단 계측에 넘겨 한 화면이 두 숫자를 말하지 않게 한다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'detectreport.js'), 'utf8');
  assert.match(src, /maxEndingRun: sentenceMap\.maxEndingRun/u);
  const mapAt = src.indexOf('buildSentenceMap(paras, detail)');
  const viewAt = src.indexOf('buildDetectReportView({');
  assert.ok(mapAt > 0 && viewAt > mapAt, '문장 지도를 먼저 만든 뒤 판정 뷰를 만든다');
});

test('같은 활용 묶음은 첫 문장에만 연속 길이를 표시하고, 4문장 미만이면 표시하지 않는다', () => {
  const map = mapFor(SAMPLE);
  const starts = map.sentences.filter(s => s.runStart);
  assert.equal(starts.length, 1, '가장 긴 묶음 하나의 첫 문장만');
  assert.equal(starts[0].index, 0);
  // 짧은 반복(3 이하)은 한국어 격식체에서 흔해 표시하지 않는다.
  const short = '저는 학교에 갔습니다. 친구를 만났습니다. 밥을 먹었습니다. 집에 왔어요.';
  const shortMap = mapFor(short);
  assert.ok(shortMap.sentences.every(s => s.endingRun === 0), '갔/만났/먹었은 서로 다른 활용이라 묶이지 않는다');
});

test('라우트는 미리보기 실패와 후보 없음을 다른 사유로 내려보낸다', () => {
  // 화면이 "원문에서 못 찾았다"와 "우리 쪽에서 실패했다"를 같은 말로 하면
  // 우리 오류를 사용자 글 탓으로 돌리게 된다.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'detectreport.js'), 'utf8');
  assert.match(src, /exampleStatus: example \? 'ready' : \(before \? 'unavailable' : 'no_candidate'\)/u);
  const beforeAt = src.indexOf('const before = pickAiSentence');
  const statusAt = src.indexOf('exampleStatus:');
  assert.ok(beforeAt > 0 && statusAt > beforeAt, '사유 판정은 후보 선정 뒤에 온다');
});

test('다듬기 프롬프트는 종결어미와 문체를 유지하도록 지시한다', () => {
  // 보고서가 "'습니다' 8문장 연속"을 지적하면서 예시는 평서체로 바꿔 보여주면
  // 자소서 사용자가 따라 할 수 없는 수정을 가르치게 된다.
  const src = fs.readFileSync(path.join(__dirname, '..', 'engine-gpt-prod', 'prompts', 'repair.js'), 'utf8');
  assert.match(src, /종결어미와 문체/u);
  assert.match(src, /그대로 유지한다/u);
});


test('미리보기 문장은 가장 많이 바뀐 자리만 공개하고 나머지는 원문이 아닌 가짜 글자로 보낸다', () => {
  // 감지만 돌려 짧은 글을 다듬어 가는 구멍(사장님 9/2). 원문 나머지는 응답 어디에도 실리지 않는다.
  const before = '이 경험을 통해 AI의 활용 가치는 답을 대신 생성하는 데 있는 것이 아니라, 목적과 기준을 먼저 정하고 결과를 검증, 조정하는 과정에서 높아진다는 것을 배웠습니다.';
  const after = '이 경험에서 배운 것은, AI가 답을 대신 만들어 주는 도구가 아니라 목적과 기준을 먼저 정해 두고 나온 결과를 검증하고 조정할 때 비로소 쓸모가 커진다는 사실입니다.';
  const span = mostChangedSpan(before, after);
  assert.ok(span && span.len > 0, '새로 쓰인 낱말 구간을 찾는다');
  const gate = splitExamplePreview(after, before);
  assert.equal(gate.gated, true);
  assert.equal(gate.anchor, 'changed', '공개 창은 가장 많이 바뀐 자리');
  assert.ok(gate.preview.length >= EXAMPLE_PREVIEW_MIN && gate.preview.length <= EXAMPLE_PREVIEW_MAX + 1, `preview=${gate.preview}`);
  assert.ok(after.includes(gate.preview), '공개 조각은 원문 그대로');
  const visible = gate.parts.filter(p => p.visible).map(p => p.text).join('');
  assert.equal(visible, gate.preview);
  const hidden = gate.parts.filter(p => !p.visible).map(p => p.text).join('');
  assert.equal(hidden.length, gate.hiddenLength);
  assert.equal(gate.parts.map(p => p.text.length).reduce((a, b) => a + b, 0), after.length, '길이는 원문과 같아 자리가 유지된다');
  const original = after.replace(gate.preview, '');
  assert.notEqual(hidden, original, '가려진 부분은 원문이 아니다');
  assert.ok(!hidden.includes('도구가 아니라') && !hidden.includes('쓸모가 커진다'), '원문 조각이 새지 않는다');
  const tiny = splitExamplePreview('짧은 문장입니다.', '짧은 문장이다.');
  assert.equal(tiny.gated, false);
  assert.equal(tiny.parts.length, 1);

  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'detectreport.js'), 'utf8');
  assert.match(route, /afterParts: gate\.parts/u, '라우트는 조각 배열을 내려보낸다');
  assert.ok(!/after: r\.rewritten/u.test(route), '다듬은 문장 원문을 통째로 보내던 경로가 없다');
});


test('미리보기는 원문에서 바뀌는 자리(beforeFocus)도 함께 돌려준다', () => {
  const before = '이 경험을 통해 AI의 활용 가치는 답을 대신 생성하는 데 있는 것이 아니라, 목적과 기준을 먼저 정하고 결과를 검증, 조정하는 과정에서 높아진다는 것을 배웠습니다.';
  const after = '이 경험에서 배운 것은, AI가 답을 대신 만들어 주는 도구가 아니라 목적과 기준을 먼저 정해 두고 나온 결과를 검증하고 조정할 때 비로소 쓸모가 커진다는 사실입니다.';
  const spans = changedSpans(before, after);
  assert.ok(spans.before && spans.before.len > 0);
  const gate = splitExamplePreview(after, before);
  assert.ok(gate.beforeFocus && gate.beforeFocus.end > gate.beforeFocus.start);
  assert.ok(gate.beforeFocus.end <= before.length);
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'detectreport.js'), 'utf8');
  assert.match(route, /beforeFocus: gate\.beforeFocus/u);
});
