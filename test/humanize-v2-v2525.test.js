'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const layout = require('../engine-gpt-prod/layoutStructure');
const structure = require('../engine-gpt-prod/structureChunk');
const korean = require('../engine-gpt-prod/koreanRefinement');
const voice = require('../engine-gpt-prod/voiceProfile');
const sourcePreflight = require('../engine-gpt-prod/sourcePreflight');
const discourse = require('../engine-gpt-prod/discourseAudit');
const resumeCoverage = require('../engine-gpt-prod/resumeCoverage');
const engine = require('../engine-gpt-prod');

test('빈 행으로 분리된 중간 소제목과 쟁점 번호를 같은 구조 판정기로 잠근다', () => {
  const source = [
    '도입 문장은 작품을 처음 읽었을 때의 혼란을 설명합니다.',
    '',
    '이 질문을 어떻게 전달할 것인가',
    '',
    '나는 가르치는 사람이 되고 싶다. 이 문단은 소제목 아래에서 문학교육의 방향과 학생에게 질문을 전달하는 방법을 충분히 길게 설명합니다.',
    '',
    '쟁점 1. 광고는 알리기 위함인가, 이익을 얻기 위함인가',
    '광고는 정보를 제공하지만 기업이 비용을 지불한다는 점에서 판매와 이익이라는 목적도 함께 지닙니다.'
  ].join('\n');
  const records = layout.buildLineRecords(source).filter(record => !record.blank);
  assert.equal(records.find(record => record.text === '이 질문을 어떻게 전달할 것인가')?.role, 'heading');
  assert.equal(records.find(record => record.text.startsWith('쟁점 1.'))?.role, 'heading');
});

test('번호·복합 제목·대괄호 부제를 한 접두부로 잠그고 줄 분절도 원래 행으로 복원한다', () => {
  const prefix = '4. 지원 동기 및 포부 [농촌의 정서와 디지털 혁신을 잇는 동반자]';
  const body = '농협은행의 상생 비전에 공감해 지원했습니다.';
  const source = `${prefix} ${body}`;
  const pieces = structure.splitEditablePrefixPiece({ text: source, start: 0, end: source.length });
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].forceLockType, 'heading_prefix');
  assert.equal(pieces[0].text.trim(), prefix);
  assert.equal(pieces[1].text, body);

  const broken = '4. 지원 동기\n및 포부 [농촌의 정서와 디지털 혁신을 잇는 동반자] 농협은행의 상생 비전에 공감해 지원했습니다.';
  const restored = structure.restoreLockedHeadingLayout(source, broken, [{
    locked: true,
    lockType: 'heading_prefix',
    text: `${prefix} `
  }]);
  assert.equal(restored.missingCount, 0);
  assert.equal(restored.text, source);
});

test('닫는 따옴표 뒤 복합 조사와 서술격을 붙여 쓴다', () => {
  const source = '이것은 ‘놓아주는 일’이기도 하고 ‘순한 맛’이나 담백함과도 관련됩니다.';
  const outputText = '이것은 ‘놓아주는 일’ 이기도 하고 ‘순한 맛’ 이나 담백함과도 관련됩니다.';
  const repaired = korean.applySafeFormattingRepairs({ source, outputText });
  assert.equal(repaired.text, source);
  assert.ok(repaired.changeCodes.includes('closed_quote_particle_spacing'));
});

test('주제 조사와 예시 서술어의 논항이 어긋난 신규 문장을 잡아 원문 문장으로 복원한다', () => {
  const source = '이처럼 신라면 광고는 제품 속성 중심 포지셔닝과 경쟁 제품 대비 포지셔닝을 함께 적용한 예입니다.';
  const outputText = '이처럼 신라면 광고에는 제품 속성 중심 포지셔닝과 경쟁 제품 대비 포지셔닝이 함께 적용된 예로 볼 수 있습니다.';
  const audit = korean.analyzeKoreanRefinement({ source, outputText });
  const issue = audit.issues.find(item => item.code === 'case_frame_corruption');
  assert.equal(issue?.introducedCount, 1);
  const restored = korean.restoreIntroducedIntegritySentences({ source, outputText, audit });
  assert.equal(restored.applied, true);
  assert.equal(restored.text, source);
});

test('제목 번호의 공백 정규화는 제목 구조 변화로 오인하지 않는다', () => {
  const sourceProfile = voice.buildVoiceProfile('3.탐구내용\n자료를 분석하고 결과를 정리했습니다.');
  const outputProfile = voice.buildVoiceProfile('3. 탐구내용\n자료를 검토한 뒤 결과를 정리했습니다.');
  assert.equal(sourceProfile.headingCount, 1);
  assert.equal(outputProfile.headingCount, 1);
});

test('본문 앞에 붙은 생성 안내·AI 검사 회피 메타 세 줄을 제거한다', () => {
  const source = [
    '글자 수 기준(공백 포함 600자 이상, 1500바이트 내외)을 여유롭게 넘기면서도, 질문자님이 직접 작성하신 문장의 고유한 틀과 과학적 핵심 개념을 그대로 유지한 완성본입니다.',
    'AI 검사기가 예측할 수 없도록 문장의 연결 방식을 더 입체적으로 늘렸고, 교과서에 나오는 과학적 메커니즘을 아주 상세하게 묘사하여 글의 분량과 학술적 깊이를 모두 확보했습니다.',
    '### 🧬 [600자 이상 완벽 회피용 최종 제출본]',
    '* **선택 주제:** 2. 유전자 가위',
    '* **자신의 입장:** 찬성'
  ].join('\n');
  const result = sourcePreflight.auditAndSanitizeSource(source);
  assert.equal(result.removedLineCount, 3);
  assert.equal(result.issueCodes.filter(code => code === 'source_generation_meta_artifact').length, 1);
  assert.equal(result.text.startsWith('* **선택 주제:**'), true);
});

test('깨닫게 되었다를 깨달았다로 바꾼 성찰 의역을 신규 평가로 보지 않는다', () => {
  const source = '이 경험을 통해 협업의 의미를 새삼 깨닫게 되었습니다.';
  const outputText = '이 경험을 통해 협업의 의미를 새삼 깨달았습니다.';
  const audit = discourse.compareDiscourse(source, outputText);
  assert.equal(audit.codes.includes('new_evaluation'), false);
  assert.equal(audit.codes.includes('rhetorical_role_shift'), false);
});

test('책을 발견했다를 책을 알게 되었다로 바꾼 것을 신규 교훈으로 보지 않는다', () => {
  const source = '그러다 미술 이론을 만화로 풀어낸 이 책을 발견했고, 예술적 안목을 기르고자 읽게 되었습니다.';
  const outputText = '그러던 중 미술 이론을 만화로 풀어낸 이 책을 알게 되었고, 예술적 안목을 기르고자 읽게 되었습니다.';
  const audit = discourse.compareDiscourse(source, outputText);
  assert.equal(audit.codes.includes('new_evaluation'), false);
});

test('문단 재배치 뒤에도 문서 전체에 남은 자소서 핵심 주장을 누락으로 오인하지 않는다', () => {
  const source = [
    '고객 문의 데이터를 분석해 반복되는 불편의 원인을 찾고 개선안을 설계했습니다.',
    '부서와 협업해 개선안을 적용한 결과 처리 시간을 20% 줄였습니다.',
    '이 경험을 바탕으로 지원 직무에서도 고객 중심의 업무 개선에 기여하겠습니다.'
  ].join(' ');
  const outputText = [
    '지원 직무에서도 고객 중심의 업무 개선에 기여하겠습니다.',
    '부서와 함께 개선안을 현장에 적용했고 처리 시간은 20% 줄었습니다.',
    '그에 앞서 고객 문의 데이터를 분석하면서 반복되는 불편의 원인을 찾고 개선안을 설계했습니다.'
  ].join(' ');
  const audit = resumeCoverage.auditResumeCoverage(source, outputText, { profile: 'resume_application' });
  assert.equal(audit.pass, true, JSON.stringify(audit.omissions));
});

test('실질 편집은 충분하지만 구조 커버리지만 낮으면 정확한 효과 코드로 설명한다', () => {
  const notices = engine.depthQualityWarnings({
    reasons: ['structural_rewrite_coverage_low', 'paragraph_rewrite_coverage_low'],
    minimumEffectPass: true
  });
  assert.deepEqual(
    notices.map(item => item.code),
    ['humanization_structure_depth_below_target', 'humanization_paragraph_coverage_below_target']
  );
  assert.equal(engine.effectStatusForNotices(notices, {
    humanizationDepthReport: {
      applicable: true,
      minimumEffectPass: true,
      metrics: {
        substantiveEditRatio: 0.22,
        substantiveChangedSentenceRatio: 0.6,
        substantiveChangedSentenceCount: 6
      },
      plan: {
        hardMinimumSubstantiveEditRatio: 0.08,
        hardRequiredChangedSentenceCount: 2
      }
    }
  }), 'normal');
});
