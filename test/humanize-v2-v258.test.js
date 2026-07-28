'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const preflight = require('../engine-gpt-prod/sourcePreflight');
const layoutStructure = require('../engine-gpt-prod/layoutStructure');
const documentProfile = require('../engine-gpt-prod/documentProfile');
const structureChunk = require('../engine-gpt-prod/structureChunk');
const freezeBlocks = require('../engine/freezeblocks');
const koreanRefinement = require('../engine-gpt-prod/koreanRefinement');
const dedupe = require('../engine/dedupe');
const engine = require('../engine-gpt-prod');
const omissionRestore = require('../engine-gpt-prod/omissionRestore');
const sectionRecovery = require('../engine-gpt-prod/sectionRecovery');
const judge = require('../engine-gpt-prod/judge');
const humanizePrompts = require('../engine-gpt-prod/prompts/humanize');
const endingStyle = require('../engine-gpt-prod/endingStyleAudit');
const fingerprint = require('../engine-gpt-prod/fingerprintAudit');
const voiceProfile = require('../engine-gpt-prod/voiceProfile');
const humanizationDepth = require('../engine-gpt-prod/humanizationDepth');

test('붙어 들어온 번호 제목과 본문 경계를 모델 호출 전에 복원한다', () => {
  const source = '1. 서론지원 동기를 설명합니다. 이 경험을 바탕으로 확신합니다.2. 합격 후 계획현장에서 역량을 쌓겠습니다.';
  const result = preflight.auditAndSanitizeSource(source);
  assert.equal(result.changed, true);
  assert.equal(
    result.text,
    '1. 서론\n지원 동기를 설명합니다. 이 경험을 바탕으로 확신합니다.\n\n2. 합격 후 계획\n현장에서 역량을 쌓겠습니다.'
  );
  assert.ok(result.issueCodes.includes('source_inline_heading_repaired'));
});

test('정상 다단계 제목과 콜론 부제는 보존하고 다음 본문과 합치지 않는다', () => {
  const source = [
    '1. 서론: 문학, 도시, 그리고 개인의 삶이 만나는 지점',
    '첫 절의 본문은 원래 줄에서 시작한다.',
    '',
    '3.2 타인의 고통의 소비와 윤리적 무감각',
    '이 작품은 타인의 고통이 소비되는 양상을 보여 준다.'
  ].join('\n');
  const result = preflight.auditAndSanitizeSource(source);
  assert.equal(result.text, source);
  assert.match(result.text, /^1\. 서론: 문학, 도시/mu);
  assert.match(result.text, /^3\.2 타인의 고통.+\n이 작품/mu);
});

test('공백이 있는 원형번호 콜론 제목과 다음 콜론 라벨 행은 임의 분리·병합하지 않는다', () => {
  const source = [
    '① 농업기술센터: 딸기 정밀 생육 관리 시스템',
    '인공지능은 공급 시점을 자동으로 판단함',
    '자동 관개 시스템: 밸브가 설정값에 따라 구동됨.'
  ].join('\n');
  const result = preflight.auditAndSanitizeSource(source);
  assert.equal(result.text, source);
  assert.equal(result.issueCodes.includes('source_inline_heading_repaired'), false);
  assert.equal(result.issueCodes.includes('source_forced_linewrap_repaired'), false);
});

test('한 행에 무너진 원형번호 소제목·인용 부제·결론 경계를 반복 복원한다', () => {
  const source = '2. 본론① 체액성 면역: "길거리의 도둑을 잡는 그물망"체액성 면역은 항체를 사용합니다.② 세포매개적 면역: "감염된 세포를 직접 타격"세포독성 T 림프구가 작용합니다.4. 결론두 체계는 함께 작동합니다.';
  const result = preflight.auditAndSanitizeSource(source);
  assert.match(result.text, /^2\. 본론\n① 체액성 면역:\n"길거리의 도둑을 잡는 그물망"\n체액성 면역/mu);
  assert.match(result.text, /\n\n② 세포매개적 면역:\n"감염된 세포를 직접 타격"\n세포독성/u);
  assert.match(result.text, /\n\n4\. 결론\n두 체계/u);
  const records = layoutStructure.buildLineRecords(result.text).filter(record => !record.blank);
  assert.equal(records.find(record => /^①/u.test(record.text))?.role, 'heading');
  assert.equal(records.find(record => /^②/u.test(record.text))?.role, 'heading');
  assert.ok(records.filter(record => record.role === 'quote').length >= 2);
});

test('ASCII 로마 절·일반 번호 소제목·닫는 인용부호 뒤에 붙은 본문을 구조적으로 분리한다', () => {
  const source = [
    'I. 서론이번 보고서는 포트폴리오의 방향을 분석한다. II. 본론1. 핵심 개념 및 영역별 비즈니스 특성보스턴 컨설팅 그룹은 사업 단위를 네 영역으로 분류한다.',
    '④ 제품군 (Dog) → "특수 채널 중심의 효율적 다이어트와 마진 회수"경영학 교과서의 단순 처방만으로는 현장 조건을 설명하기 어렵다.'
  ].join('\n');
  const result = preflight.auditAndSanitizeSource(source);
  assert.match(result.text, /^I\. 서론\n이번 보고서는/mu);
  assert.match(result.text, /\n\nII\. 본론\n1\. 핵심 개념 및 영역별 비즈니스 특성\n보스턴 컨설팅 그룹/u);
  assert.match(result.text, /"특수 채널 중심의 효율적 다이어트와 마진 회수"\n경영학 교과서/u);

  const records = layoutStructure.buildLineRecords(result.text).filter(record => !record.blank);
  assert.equal(records.find(record => record.text === 'I. 서론')?.role, 'heading');
  assert.equal(records.find(record => record.text === 'II. 본론')?.role, 'heading');
  assert.equal(records.find(record => /^1\. 핵심 개념/u.test(record.text))?.role, 'heading');
});

test('따옴표 제목 뒤의 조사는 본문 경계로 오인하지 않는다', () => {
  const source = [
    '① "A이면서 동시에 A가 아닌 것" — 역설의 이데올로기',
    "② '인간적 변수'의 반영 한계",
    "③ '어서 오세요'는 환영 인사다."
  ].join('\n');
  assert.equal(preflight.auditAndSanitizeSource(source).text, source);
});

test('미분 기호의 작은따옴표를 직접 인용으로 오인해 사이 본문을 삭제하지 않는다', () => {
  const source = "로지스틱 모델 p'(t) = ap - bp^2를 적용해 **'수용 밀도 가이드라인'**을 도출하고 '데이터 기반 전문성'을 기릅니다.";
  const changedQuotes = "로지스틱 모델 p'(t) = ap - bp^2를 적용해 **'밀도 기준'**을 도출하고 '자료 기반 역량'을 기릅니다.";
  const audit = require('../engine-gpt-prod/voiceProfile').auditDirectQuoteIntegrity(source, changedQuotes);
  assert.equal(audit.sourceCount, 2, JSON.stringify(audit));
  assert.equal(audit.outputCount, 2, JSON.stringify(audit));
  const restored = require('../engine-gpt-prod/voiceProfile').restoreDirectQuoteContents(source, changedQuotes);
  assert.equal(restored.applied, true, JSON.stringify(restored));
  assert.equal(restored.text, source);
  assert.match(restored.text, /p'\(t\) = ap - bp\^2/u);
});

test('원형번호 번역 병기 소제목과 붙은 본문을 분리하고 제목 전체를 잠근다', () => {
  const source = '① 자유주의 복지국가 체제 (Liberal Welfare State)자유주의 체제는 시장 효율성과 개인 책임을 강조한다.';
  const sanitized = preflight.auditAndSanitizeSource(source);
  assert.equal(
    sanitized.text,
    '① 자유주의 복지국가 체제 (Liberal Welfare State)\n자유주의 체제는 시장 효율성과 개인 책임을 강조한다.'
  );
  const plan = structureChunk.splitChunksForGpt(sanitized.text);
  assert.ok(plan.chunks.some(chunk => (
    chunk.lockType === 'heading'
    && chunk.text === '① 자유주의 복지국가 체제 (Liberal Welfare State)'
  )));
  assert.ok(plan.chunks.some(chunk => !chunk.locked && /^자유주의 체제는/u.test(chunk.text)));

  const possessive = '① 에릭슨(Erikson)의 심리사회적 발달이론을 적용한다.';
  assert.equal(preflight.auditAndSanitizeSource(possessive).text, possessive);
});

test('세로 탭·폼 피드 줄 경계를 LF로 정규화한다', () => {
  const source = '목차\u000b1. 서론\u000b2. 본론\u000c\u000c1. 서론\u2028본문을 설명한다.';
  const result = preflight.auditAndSanitizeSource(source);
  assert.equal(result.text, '목차\n1. 서론\n2. 본론\n\n1. 서론\n본문을 설명한다.');
});

test('PDF 강제 줄바꿈과 조사 분리는 복원하되 코드와 독립 인용행은 보존한다', () => {
  const source = [
    '기업의 책임 의식을',
    '변화시킬 수 있다는 사실은 중요한 시사점을 준다.',
    '',
    '인간',
    '은 환경과 상호작용한다.',
    '',
    '```text',
    '기업의 책임 의식을',
    '변화시킨다',
    '```',
    '',
    '「문장 중간',
    '줄바꿈」'
  ].join('\n');
  const result = preflight.auditAndSanitizeSource(source);
  assert.match(result.text, /기업의 책임 의식을 변화시킬 수 있다는/u);
  assert.match(result.text, /인간은 환경과/u);
  assert.match(result.text, /```text\n기업의 책임 의식을\n변화시킨다\n```/u);
  assert.match(result.text, /「문장 중간\n줄바꿈」/u);
});

test('조사와 같은 음절로 시작하는 정상 어절을 앞말에 잘못 붙이지 않는다', () => {
  const source = [
    '이 문장은 고정 폭 PDF에서 충분히 길게 이어지다가 여러 판단 근거를 차례로 설명한 뒤 마지막에 분석 기준',
    '이러한 조건은 다음 문장에서 별도의 판단 근거로 사용된다.',
    '',
    '자료를 생산하는 소비',
    '자의 선택 과정을 함께 살폈다.',
    '',
    '문제가 반복해서 발생',
    '하는 원인도 같은 기준으로 확인했다.'
  ].join('\n');
  const result = preflight.auditAndSanitizeSource(source);
  assert.match(result.text, /분석 기준 이러한 조건/u);
  assert.doesNotMatch(result.text, /기준이러한/u);
  assert.match(result.text, /소비자의 선택/u);
  assert.match(result.text, /발생하는 원인/u);
});

test('문장 사이 누락 공백은 preflight에서만 고치고 장문 청커는 원문을 정확히 왕복한다', () => {
  const jammed = '고객 자료를 분석하였다.다음 결과를 정리하였다.';
  const repaired = preflight.auditAndSanitizeSource(jammed);
  assert.equal(repaired.text, '고객 자료를 분석하였다. 다음 결과를 정리하였다.');
  assert.ok(repaired.issueCodes.includes('source_sentence_spacing_repaired'));

  const longSource = Array.from(
    { length: 90 },
    (_, index) => `${index + 1}번째 문장은 충분한 길이의 분석 결과를 설명한다.`
  ).join('');
  const chunks = require('../engine/chunk').splitChunks(longSource);
  assert.ok(chunks.length > 1);
  assert.equal(require('../engine/chunk').mergeChunks(chunks), longSource);
});

test('본문 끝에 붙은 복합 보완 지시문은 제거한다', () => {
  const source = [
    '플랫폼 규제의 필요성과 한계를 비교하였다.',
    '이 내용을 보완해서 써줘. 보고서에 들어갈 내용이야.'
  ].join('\n');
  const result = preflight.auditAndSanitizeSource(source);
  assert.equal(result.text, '플랫폼 규제의 필요성과 한계를 비교하였다.');
  assert.ok(result.issueCodes.includes('source_rewrite_request_artifact'));
});

test('따옴표로 감싼 긴 본문 뒤 재작성 지시는 바깥 래퍼와 함께 제거한다', () => {
  const payload = '공공 정책은 시민의 의견을 초기 기획 단계부터 반영해야 한다. '
    + '전문가는 설계와 기술 검토를 맡고 유지관리 기관은 실행 가능성을 함께 확인해야 한다. '
    + '이러한 역할 분담은 형식적인 의견 수렴을 넘어 공동 결정의 기반을 마련한다.';
  const source = `"${payload}"이 내용을 보완해서 써줘. 보고서에 들어갈 내용이야.`;
  const result = preflight.auditAndSanitizeSource(source);
  assert.equal(result.text, payload);
  assert.equal(result.text.startsWith('"'), false);
  assert.equal(result.text.includes('보완해서 써줘'), false);
  assert.ok(result.issueCodes.includes('source_rewrite_request_artifact'));
});

test('한 행의 긴 본문 전체를 감싼 작성용 큰따옴표는 직접 인용 잠금에서 제외한다', () => {
  const payload = [
    '스포츠 활동을 즐기는 청년에게 부상 관리 비용은 적지 않은 부담이 됩니다.',
    '관련 학과 학생에게 회복과 자기관리 비용을 지원하는 바우처가 있으면 좋겠습니다.',
    '지원 조건과 이용 범위는 실제 수요를 확인해 정할 필요가 있습니다.',
    '운영 기관과 청년 당사자가 함께 기준을 점검하는 절차도 마련해야 합니다.'
  ].join(' ');
  const result = preflight.auditAndSanitizeSource(`"${payload}"`);
  assert.equal(result.text, payload);
  assert.ok(result.issueCodes.includes('source_document_quote_wrapper_removed'));
  const profile = documentProfile.detectDocumentProfile(result.text);
  const plan = structureChunk.splitChunksForGpt(result.text, { formatProfile: profile.formatProfile });
  assert.ok(plan.chunks.some(chunk => !chunk.locked && chunk.text.includes('스포츠 활동')));
});

test('닫는 인용부호 앞에는 문장 간 공백을 잘못 삽입하지 않는다', () => {
  const quoted = '"짧은 독립 발화입니다."';
  assert.equal(preflight.auditAndSanitizeSource(quoted).text, quoted);
  assert.equal(
    preflight.auditAndSanitizeSource('첫 문장이다."다음 문장이다.').text,
    '첫 문장이다." 다음 문장이다.'
  );
});

test('문장부호 없는 첫 산문을 제목으로 잠그지 않는다', () => {
  const source = [
    '1984는 조지 오웰이 쓴 디스토피아 소설이다',
    '',
    '이 작품은 감시 사회와 언어 통제를 다룬다.'
  ].join('\n');
  const records = layoutStructure.buildLineRecords(source).filter(record => !record.blank);
  assert.equal(records[0].role, 'prose', JSON.stringify(records));
});

test('표지·표 설명 산문과 통계 수식 산문을 표·통계 데이터 행으로 잠그지 않는다', () => {
  const source = [
    '표지 디자인부터 시작해서 정보를 표로 정리하고 카드뉴스에 담았습니다.',
    '귀무가설을 검토한 결과 p = 0.288이었으므로 유의수준 0.05에서 기각할 수 없다고 결론 내렸습니다.',
    '반감기 식 N(t)=N₀×(1/2)^(t/5730)을 실제 수치에 적용해 제작 시기를 계산함.'
  ].join('\n');
  const profile = documentProfile.detectDocumentProfile(source);
  const plan = structureChunk.splitChunksForGpt(source, { formatProfile: profile.formatProfile });
  const editable = plan.chunks.filter(chunk => !chunk.locked).map(chunk => chunk.text).join('\n');
  assert.match(editable, /표지 디자인/u);
  assert.match(editable, /p = 0\.288/u);
  assert.match(editable, /N\(t\)=/u);
  assert.equal(plan.chunks.some(chunk => ['table', 'stat_line'].includes(chunk.lockType)), false);

  const data = '표 1 연구 결과\nM = 3.20, SD = 0.42, p < 0.05';
  const dataPlan = structureChunk.splitChunksForGpt(data);
  assert.ok(dataPlan.chunks.some(chunk => chunk.lockType === 'table'));
  assert.ok(dataPlan.chunks.some(chunk => chunk.lockType === 'stat_line'));

  const collapsedComparison = '비교 항목체액성 면역 (Humoral)세포매개적 면역 (Cell-mediated)핵심 세포B 림프구 (무기 공장)세포독성 T 림프구 (특수부대)공격 수단항체 (날아가는 그물 무기)T 세포 자체가 직접 가서 타격적이 있는 위치세포 외부 (혈액, 림프액 등)세포 내부 (이미 침투함)결과물기억 B 세포가 생겨 훗날을 대비기억 T 세포가 생겨 훗날을 대비';
  assert.equal(layoutStructure.classifyLine(collapsedComparison), 'table');
});

test('목차의 참고문헌 항목은 실제 참고문헌 상태를 시작하지 않는다', () => {
  const source = [
    '목차',
    '1. 서론',
    '2. 본론',
    '3. 결론',
    '4. 참고문헌',
    '',
    '1. 서론',
    '정보시스템의 역할을 설명하는 본문입니다.',
    '',
    '2. 본론',
    '핵심 구성 요소와 적용 사례를 비교합니다.',
    '',
    '4. 참고문헌',
    '홍길동. (2020). 정보시스템 연구.',
    '김철수. (2021). 경영정보 연구.',
    '이영희. (2022). 데이터 활용 연구.'
  ].join('\n');
  const spans = freezeBlocks.detectAcademicSpans(source);
  assert.deepEqual(spans.map(span => span.type), ['toc', 'references']);
  const bodyStart = source.indexOf('정보시스템의 역할');
  assert.equal(freezeBlocks.academicSpanAt(spans, bodyStart, bodyStart + 10), null);
  const plan = structureChunk.splitChunksForGpt(source);
  assert.ok(plan.chunks.some(chunk => !chunk.locked && /정보시스템의 역할/u.test(chunk.text)));
  assert.ok(plan.chunks.some(chunk => chunk.lockType === 'reference_item' && /홍길동/u.test(chunk.text)));
  assert.equal(structureChunk.mergeChunks(plan.chunks), source);
});

test('무번호 하위 항목과 ASCII 로마 번호가 있는 목차만 잠그고 반복된 본문부터 편집한다', () => {
  const source = [
    '보고서 제목',
    '목차',
    'I. 서론',
    '연구의 배경 및 목적',
    'II. 본론',
    '핵심 구성 요소',
    'III. 결론',
    '연구 결과 요약',
    '',
    'I. 서론',
    '연구 배경을 구체적으로 설명하는 본문입니다.',
    '',
    'II. 본론',
    '핵심 구성 요소와 실제 적용 사례를 비교하는 본문입니다.'
  ].join('\n');
  const spans = freezeBlocks.detectAcademicSpans(source);
  assert.deepEqual(spans.map(span => span.type), ['toc']);
  const bodyStart = source.indexOf('I. 서론', source.indexOf('I. 서론') + 1);
  assert.equal(spans[0].end, bodyStart);

  const plan = structureChunk.splitChunksForGpt(source);
  const body = plan.chunks.find(chunk => !chunk.locked && /연구 배경을/u.test(chunk.text));
  assert.equal(body?.sectionPath, 'I. 서론');
  const audit = structureChunk.buildStructureAudit({
    source,
    outputText: source,
    chunks: plan.chunks,
    plan
  });
  assert.equal(audit.sectionPathErrorCount, 0, JSON.stringify(audit.sectionPathErrors));
  assert.equal(structureChunk.mergeChunks(plan.chunks), source);
});

test('목차에서 반복된 무번호 소제목은 실제 본문에서 독립 제목으로 잠근다', () => {
  const source = [
    '목차',
    '1. 서론',
    '연구의 배경 및 목적',
    '2. 본론',
    '지속 가능한 활성화 방안',
    '',
    '1. 서론',
    '연구의 배경 및 목적',
    '본문의 연구 배경을 설명한다.',
    '',
    '2. 본론',
    '지속 가능한 활성화 방안',
    '구체적인 실행 전략을 설명한다.'
  ].join('\n');
  const plan = structureChunk.splitChunksForGpt(source);
  const repeated = plan.chunks.filter(chunk => (
    chunk.lockType === 'heading'
    && ['연구의 배경 및 목적', '지속 가능한 활성화 방안'].includes(chunk.text)
  ));
  assert.equal(repeated.length, 2, JSON.stringify(plan.chunks));
  assert.equal(
    plan.chunks.find(chunk => !chunk.locked && /구체적인 실행 전략/u.test(chunk.text))?.sectionPath,
    '지속 가능한 활성화 방안'
  );
  assert.equal(structureChunk.mergeChunks(plan.chunks), source);
});

test('의미 감사 뒤에도 라벨·불릿 접두부의 원래 행 경계를 복원한다', () => {
  const source = [
    '강점 (Strength): 교통 접근성이 높습니다.',
    '약점 (Weakness): 야간 치안이 불안합니다.',
    '기회 (Opportunity): 국제 행사가 예정되어 있습니다.',
    '① 첫 번째 전략을 설명합니다.'
  ].join('\n');
  const plan = structureChunk.splitChunksForGpt(source, { coalesceEditable: true });
  const mergedOutput = '강점 (Strength): 교통 접근성이 좋습니다. 약점 (Weakness): 야간 치안이 불안합니다. 기회 (Opportunity): 국제 행사가 예정되어 있습니다. ① 첫 번째 전략을 구체적으로 설명합니다.';
  const restored = structureChunk.restorePostSemanticLayout({
    source,
    outputText: mergedOutput,
    chunks: plan.chunks,
    mode: 'assignment',
    requestStrength: 'advanced',
    documentProfile: 'report_assignment',
    profileConfidence: 0.9
  });
  assert.match(restored.text, /^강점 \(Strength\): 교통/mu);
  assert.match(restored.text, /^약점 \(Weakness\): 야간/mu);
  assert.match(restored.text, /^기회 \(Opportunity\): 국제/mu);
  assert.match(restored.text, /^① 첫 번째 전략/mu);

  const profile = documentProfile.detectDocumentProfile(source);
  const sourceVoice = require('../engine-gpt-prod/voiceProfile').buildVoiceProfile(source, {
    documentProfile: profile
  });
  const voiceAudit = require('../engine-gpt-prod/voiceProfile').auditVoice(sourceVoice, restored.text, {
    documentProfile: profile,
    sourceText: source
  });
  assert.equal(
    voiceAudit.warnings.some(item => item.code === 'structural_line_loss'),
    false,
    JSON.stringify(voiceAudit.warnings)
  );
});

test('시장 내 표현을 자연스러운 목적어 문장으로 바꿔도 전문성 저하로 오인하지 않는다', () => {
  const source = '그러나 시장 내에는 이미 선발 주자들이 강하게 자리를 선점하고 있다.';
  const output = '다만 이미 선발 주자들이 시장을 강하게 선점하고 있다.';
  const issue = koreanRefinement.detectProfessionalDowngrade(source, output, 'report_assignment');
  assert.equal(issue, null);
});

test('목차라는 번호 제목 뒤에 곧바로 일반 산문이 오면 문서 전체를 목차로 잠그지 않는다', () => {
  const source = [
    '1. 목차',
    '영화는 사회와 문화를 반영하는 대표적인 예술 장르 중 하나이다.',
    '2. 서론',
    '1. 작품 소개',
    '작품의 특징과 흥행 배경을 구체적으로 설명한다.'
  ].join('\n');
  assert.deepEqual(freezeBlocks.detectAcademicSpans(source), []);
  const plan = structureChunk.splitChunksForGpt(source);
  assert.ok(plan.chunks.some(chunk => !chunk.locked && /영화는 사회와/u.test(chunk.text)));
});

test('문서 전체 Markdown 편지 래퍼는 > 기호만 잠그고 본문을 편집한다', () => {
  const source = [
    '### 담임 선생님께 드리는 글',
    '> 안녕하세요, 선생님. 학생입니다.',
    '> 어제 등교 과정에서 늦었고 규정을 지키지 못한 점을 반성하고 있습니다.',
    '> 앞으로는 출발 시각을 앞당겨 같은 일이 다시 생기지 않도록 관리하겠습니다.',
    '> 바쁘시겠지만 제 설명을 살펴봐 주시기를 부탁드립니다. 감사합니다.'
  ].join('\n');
  const profile = documentProfile.detectDocumentProfile(source);
  assert.ok(profile.formatProfile.flags.includes('editable_blockquote_wrapper'), JSON.stringify(profile.formatProfile));
  const plan = structureChunk.splitChunksForGpt(source, { formatProfile: profile.formatProfile });
  assert.equal(structureChunk.mergeChunks(plan.chunks), source);
  assert.ok(plan.chunks.some(chunk => chunk.lockType === 'blockquote_prefix'));
  const editable = plan.chunks.filter(chunk => !chunk.locked).map(chunk => chunk.text).join('\n');
  assert.match(editable, /안녕하세요/u);
  assert.match(editable, /출발 시각/u);

  const restored = structureChunk.restorePostSemanticLayout({
    source,
    outputText: source,
    chunks: plan.chunks,
    mode: 'assignment',
    requestStrength: 'advanced',
    documentProfile: profile
  });
  assert.equal(restored.text, source, JSON.stringify(restored));
});

test('독립된 짧은 직접 발화와 실제 표 전용 문서는 계속 편집 불가 구조로 보존한다', () => {
  const dialogue = '"나는 가짜 발을 만들어 이동해!"\n\n"나는 가짜 발로 먹이를 감싸 흡수해!"';
  const dialogueProfile = documentProfile.detectDocumentProfile(dialogue);
  const dialoguePlan = structureChunk.splitChunksForGpt(dialogue, {
    formatProfile: dialogueProfile.formatProfile
  });
  assert.equal(dialoguePlan.chunks.filter(chunk => !chunk.locked && chunk.text.trim()).length, 0);
  assert.equal(structureChunk.mergeChunks(dialoguePlan.chunks), dialogue);

  const table = '항목\t사례 A\t사례 B\n목표\t경제 활성화\t생태 보전\n결과\t사업 추진\t서식지 확대';
  const tableProfile = documentProfile.detectDocumentProfile(table);
  const tablePlan = structureChunk.splitChunksForGpt(table, { formatProfile: tableProfile.formatProfile });
  assert.equal(tablePlan.chunks.filter(chunk => !chunk.locked && chunk.text.trim()).length, 0);
  assert.equal(structureChunk.mergeChunks(tablePlan.chunks), table);
});

test('평가 문항은 문제·대화·선택지·정답을 잠그고 해설 본문만 편집한다', () => {
  const source = [
    '[듣기 평가 문항]',
    '남자: 오늘 도서관에 갈까요?',
    '여자: 네, 좋아요.',
    '다음 대화의 내용과 일치하는 것을 고르시오.',
    '① 남자는 학교에 간다.',
    '② 여자는 도서관에 간다.',
    '[정답] ②',
    '[해설]',
    '여자는 도서관에 가자는 제안에 동의했다.'
  ].join('\n');
  const profile = documentProfile.detectDocumentProfile(source);
  assert.ok(profile.formatProfile.flags.includes('assessment_item'), JSON.stringify(profile.formatProfile));
  const plan = structureChunk.splitChunksForGpt(source, { formatProfile: profile.formatProfile });
  const editable = plan.chunks.filter(chunk => !chunk.locked).map(chunk => chunk.text).join('\n');
  const locked = plan.chunks.filter(chunk => chunk.locked).map(chunk => chunk.text).join('\n');
  assert.match(editable, /여자는 도서관에 가자는 제안에 동의했다/u);
  assert.doesNotMatch(editable, /남자:|①|정답/u);
  assert.match(locked, /남자: 오늘 도서관에 갈까요/u);
  assert.match(locked, /① 남자는 학교에 간다/u);
  assert.match(locked, /\[정답\] ②/u);
  const prompt = humanizePrompts.buildHumanizePrompt('assignment', 'ko', {
    register: 'formal',
    requestStrength: 'advanced',
    documentProfile: profile
  });
  assert.match(prompt.stable, /\[형식: 평가 문항·정답·해설\]/u);
  assert.match(prompt.stable, /해설 제목 뒤의 설명 본문만 편집/u);
});

test('한 행 정답표는 번호 제목으로 쪼개지 않고 질문지 sectionPath를 정상 추적한다', () => {
  const answerKey = '[정답]\n1. ① 2. ① 3. ② 4. ③ 5. ④';
  assert.equal(preflight.auditAndSanitizeSource(answerKey).text, answerKey);

  const source = [
    '1. 첫 번째 경험에서 배운 점은 무엇인가?',
    '첫 경험에서 자료를 비교하는 법을 배웠다.',
    '',
    '2. 다음 활동에서 개선할 점은 무엇인가?',
    '다음에는 기록 기준을 먼저 정하고 싶다.'
  ].join('\n');
  const profile = documentProfile.detectDocumentProfile(source);
  const plan = structureChunk.splitChunksForGpt(source, {
    coalesceEditable: true,
    formatProfile: profile.formatProfile
  });
  const audit = structureChunk.buildStructureAudit({
    source,
    outputText: source,
    chunks: plan.chunks,
    plan
  });
  assert.equal(audit.sectionPathErrorCount, 0, JSON.stringify(audit.sectionPathErrors));
});

test('평가 해설 제목과 본문이 같은 줄이면 접두부만 잠그고 설명은 편집한다', () => {
  const source = [
    '[읽기 평가 문항]',
    '다음 글의 내용과 일치하는 것을 고르시오.',
    '① 첫 번째 설명이다.',
    '② 두 번째 설명이다.',
    '[정답] ②',
    '[해설] 두 번째 선택지는 지문의 핵심 내용과 일치한다.'
  ].join('\n');
  const profile = documentProfile.detectDocumentProfile(source);
  const plan = structureChunk.splitChunksForGpt(source, {
    coalesceEditable: true,
    formatProfile: profile.formatProfile
  });
  assert.ok(profile.formatProfile.flags.includes('assessment_item'));
  assert.equal(structureChunk.mergeChunks(plan.chunks), source);
  assert.ok(plan.chunks.some(item => item.locked && item.lockType === 'assessment_explanation_heading'));
  assert.ok(plan.chunks.some(item => !item.locked && /두 번째 선택지는/u.test(item.text)));
  assert.equal(profile.formatProfile.assessmentExplanationLineCount, 1);
});

test('명시적 해설 표지가 없어도 정답표 뒤 번호형 해설만 편집한다', () => {
  const source = [
    '[듣기 평가 문항]',
    '1. 다음을 듣고 알맞은 것을 고르세요.',
    '남자: 안녕하세요.',
    '① 안녕히 가세요',
    '② 안녕하세요',
    '[정답]',
    '1. ②',
    '',
    '1.',
    '같은 인사로 자연스럽게 응답하는지를 확인하는 문항이므로 정답은 ②이다.'
  ].join('\n');
  const profile = documentProfile.detectDocumentProfile(source);
  const plan = structureChunk.splitChunksForGpt(source, {
    coalesceEditable: true,
    formatProfile: profile.formatProfile
  });
  assert.equal(structureChunk.mergeChunks(plan.chunks), source);
  assert.ok(plan.chunks.some(item => item.lockType === 'assessment_answer_key'));
  assert.ok(plan.chunks.some(item => item.lockType === 'assessment_explanation_heading'));
  assert.ok(plan.chunks.some(item => !item.locked && /자연스럽게 응답/u.test(item.text)));
  assert.equal(profile.formatProfile.assessmentExplanationLineCount, 1);
  const audit = structureChunk.buildStructureAudit({
    source,
    outputText: source,
    chunks: plan.chunks,
    plan
  });
  assert.equal(audit.sectionPathErrorCount, 0, JSON.stringify(audit.sectionPathErrors));
});

test('새로 섞인 종결체만 대응 원문으로 되돌리고 기존 대화체는 보존한다', () => {
  const source = [
    '남자: 도와줘서 고마워요.',
    '여자: 아니에요.',
    ...Array.from({ length: 8 }, (_, index) => `${index + 1}번째 해설은 원문의 판단을 설명한다.`)
  ].join('\n');
  const output = [
    '남자: 도와줘서 고마워요.',
    '여자: 아니에요.',
    ...Array.from({ length: 8 }, (_, index) => index >= 6
      ? `${index + 1}번째 해설은 원문의 판단을 설명해요.`
      : `${index + 1}번째 해설은 원문의 판단을 설명한다.`)
  ].join('\n');
  const before = endingStyle.auditEndingStyle(source, output);
  assert.equal(before.pass, false, JSON.stringify(before));
  const restored = endingStyle.restoreIntroducedEndingSentences(source, output, before);
  assert.equal(restored.applied, true, JSON.stringify(restored));
  assert.equal(restored.audit.pass, true, JSON.stringify(restored.audit));
  assert.equal(restored.text, source);
});

test('모델이 청크 경계에서 새로 만든 짧은 인지 결론만 제거한다', () => {
  const source = '이 사례를 검토하면서 책임의 범위가 어디까지인지 질문을 떠올리게 되었습니다.';
  const output = '이 사례를 검토하면서 책임의 범위가 어디까지인지 질문을 떠올리게 되었습니다. 책임 범위에 관한 질문이 생겼습니다.';
  const result = dedupe.removeGeneratedAdjacentRestatements(source, output);
  assert.equal(result.applied, true, JSON.stringify(result));
  assert.equal(result.text.trim(), source);

  const sourceAuthored = `${source} 책임 범위에 관한 질문이 생겼습니다.`;
  const preserved = dedupe.removeGeneratedAdjacentRestatements(sourceAuthored, sourceAuthored);
  assert.equal(preserved.applied, false);
  assert.equal(preserved.text, sourceAuthored);
});

test('학술·보고서의 구어적 격하와 짧은 인접 재진술을 감지한다', () => {
  const source = '기업은 시장에서 경쟁해야 한다. 분석 대상을 교재로 전환한다. 구매할 때 지불하는 금액을 가격이라고 한다.';
  const output = '기업은 시장에서 맞붙어야 한다. 분석 대상을 교재 쪽으로 옮긴다. 살 때 내는 금액을 가격이라고 한다.';
  const audit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'report_assignment', targetRegister: 'academic_formal' },
    mode: 'assignment'
  });
  assert.ok(audit.issueCodes.includes('formal_register_residual'), JSON.stringify(audit));

  const repeated = koreanRefinement.analyzeKoreanRefinement({
    source: '책임의 범위를 검토했다.',
    outputText: '검토 과정에서 책임의 범위가 어디까지인지 질문을 떠올리게 되었습니다. 책임 범위에 관한 질문이 생겼습니다.',
    documentProfile: { profile: 'general_essay', targetRegister: 'formal' },
    mode: 'assignment'
  });
  assert.ok(repeated.issueCodes.includes('adjacent_semantic_repetition'), JSON.stringify(repeated));
});

test('띄어쓰기 교정은 polish에서는 유효 편집이고 일반 피하기에서는 깊이 편집이 아니다', () => {
  const source = '한걸음 더 나아가 보여주는 사례다.';
  const output = '한 걸음 더 나아가 보여 주는 사례다.';
  assert.equal(engine.isNoopEquivalent(source, output, 'polish'), false);
  assert.equal(engine.isNoopEquivalent(source, output, 'assignment'), true);
});

test('확인된 결론 누락은 원문의 정확한 문장을 같은 위치에 복원한다', () => {
  const source = [
    '첫째, 자료 수집 기준을 세웠다.',
    '둘째, 기준에 따라 사례를 비교했다.',
    '이 과정을 통해 분석 결과의 재현 가능성을 확인했다.'
  ].join(' ');
  const output = [
    '우선 자료를 수집할 기준부터 정했다.',
    '이후 그 기준으로 여러 사례를 비교했다.'
  ].join(' ');
  const report = {
    ran: true,
    pass: false,
    uncertain: false,
    violations: [{
      type: 'omission',
      span: '이 과정을 통해 분석 결과의 재현 가능성을 확인했다.',
      detail: '마지막 결론이 누락되었다.'
    }]
  };
  const restored = omissionRestore.restoreConfirmedSemanticOmissions({
    source,
    outputText: output,
    semanticReport: report
  });
  assert.equal(restored.applied, true, JSON.stringify(restored));
  assert.match(restored.text, /이 과정을 통해 분석 결과의 재현 가능성을 확인했다\.$/u);
  assert.equal(restored.restoredCount, 1);
  assert.equal(restored.remainingViolations.length, 0);
});

test('불명확하거나 구조 행에 속한 누락은 결정론적으로 삽입하지 않는다', () => {
  const source = '1. 연구 방법\n자료를 비교했다.\n2. 연구 결과\n차이를 확인했다.';
  const output = '1. 연구 방법\n자료를 대조했다.\n2. 연구 결과\n차이를 확인했다.';
  const restored = omissionRestore.restoreConfirmedSemanticOmissions({
    source,
    outputText: output,
    semanticReport: {
      violations: [{ type: 'omission', span: '1. 연구 방법', detail: '제목 누락' }]
    }
  });
  assert.equal(restored.applied, false);
  assert.equal(restored.text, output);
});

test('장문 회복의 상위 모델 승격은 운영 기본 1개이며 안전 거부 후보는 승격하지 않는다', { concurrency: false }, async t => {
  const previousEnabled = process.env.HUMANIZE_SECTION_RECOVERY_ENABLED;
  const previousMaximum = process.env.HUMANIZE_SECTION_ESCALATION_MAX;
  process.env.HUMANIZE_SECTION_RECOVERY_ENABLED = '1';
  delete process.env.HUMANIZE_SECTION_ESCALATION_MAX;
  t.after(() => {
    if (previousEnabled === undefined) delete process.env.HUMANIZE_SECTION_RECOVERY_ENABLED;
    else process.env.HUMANIZE_SECTION_RECOVERY_ENABLED = previousEnabled;
    if (previousMaximum === undefined) delete process.env.HUMANIZE_SECTION_ESCALATION_MAX;
    else process.env.HUMANIZE_SECTION_ESCALATION_MAX = previousMaximum;
  });
  const paragraph = '또한 이 자료는 중요한 역할을 할 수 있습니다. 따라서 관련 내용을 체계적으로 검토할 필요가 있습니다. ';
  const makeSection = index => {
    let text = '';
    while (text.length < 1300) text += `${index + 1}번째 ${paragraph}`;
    return text;
  };
  const chunks = Array.from({ length: 3 }, (_, index) => ({
    index,
    text: makeSection(index),
    outputText: makeSection(index),
    locked: false
  }));
  const calls = [];
  const report = await sectionRecovery.recoverSections({
    chunks,
    sourceLength: 3900,
    mode: 'assignment',
    requestStrength: 'advanced',
    documentProfile: { profile: 'long_explainer' },
    inputRisk: { abstractRiskRatio: 1 },
    retrySection: async entry => {
      calls.push(entry.tier);
      return { outputText: entry.output, safeChangeFound: false };
    },
    validateCandidate: () => true
  });
  assert.equal(report.metrics.escalationMaximum, 1);
  assert.equal(report.metrics.escalationAttemptCount, 1);
  assert.equal(calls.filter(tier => tier === 'escalation').length, 1);
  assert.ok(report.metrics.escalationSkipCodes.includes('escalation_budget_exhausted'));
});

test('원문에 정확히 있는 omission만 남으면 비싼 의미 재판정보다 결정론 복원을 우선한다', () => {
  const source = '자료를 수집했다. 분석 결과의 재현 가능성을 확인했다.';
  const omissionOnly = {
    violations: [{
      type: 'omission',
      span: '분석 결과의 재현 가능성을 확인했다.',
      detail: '결론 누락'
    }]
  };
  assert.equal(judge.shouldEscalateSemanticReport(omissionOnly, source), false);
  assert.equal(judge.shouldEscalateSemanticReport({
    violations: [{ type: 'distortion', span: '재현 가능성이 없다.', detail: '의미 반전' }]
  }, source), true);
  assert.equal(judge.shouldEscalateSemanticReport({
    violations: [{ type: 'omission', span: '핵심 결론', detail: '위치가 불명확함' }]
  }, source), true);
});

test('것에 그치지 않고를 데서 그치지 않고로 바꾼 문장은 신규 지문으로 세지 않는다', () => {
  const source = [
    '과거 방식대로 단순히 행사를 여는 것에 그치지 않고 대안을 검토한다.',
    '문제는 단순한 매출 감소가 아니라 목표 대비 이탈이라는 점이다.'
  ].join(' ');
  const output = [
    '과거 방식처럼 단순히 행사를 여는 데서 그치지 않고 대안을 검토한다.',
    '문제를 단순한 매출 감소로 보는 데서 그치지 않고 목표 대비 이탈인지 확인한다.'
  ].join(' ');
  const audit = fingerprint.auditFingerprint(source, output, 'report_assignment');
  const family = audit.families.find(item => item.code === 'limitative_additive');
  assert.equal(family.sourceCount, 1);
  assert.equal(family.outputCount, 2);
  assert.equal(family.introducedCount, 1);
  assert.deepEqual(family.introducedSentenceOrdinals, [2]);
  assert.ok(audit.issueCodes.includes('contrast_relation_shift'), JSON.stringify(audit));

  const restored = fingerprint.restoreUnsafeRelationSentences(source, output, audit);
  assert.equal(restored.applied, true, JSON.stringify(restored));
  assert.match(restored.text, /행사를 여는 데서 그치지 않고 대안을 검토한다/u);
  assert.match(restored.text, /매출 감소가 아니라 목표 대비 이탈/u);
  assert.equal(fingerprint.auditFingerprint(source, restored.text, 'report_assignment').pass, true);
});

test('잠긴 라벨 접두부가 남아도 행 경계가 합쳐지면 구조 서명에서 거부한다', () => {
  const source = [
    '의사결정 조건을 구분한다.',
    '확실성하의 의사결정: 결과를 확정할 수 있다.',
    '위험하의 의사결정: 확률을 추정할 수 있다.',
    '불확실성하의 의사결정: 확률도 알 수 없다.'
  ].join('\n');
  const plan = structureChunk.splitChunksForGpt(source, { coalesceEditable: true });
  const collapsed = source.replace(/\n/gu, ' ');
  const audit = structureChunk.buildStructureAudit({
    source,
    outputText: collapsed,
    chunks: plan.chunks,
    plan
  });
  assert.equal(audit.lostLockedCount, 0);
  assert.equal(audit.structureSignaturePass, false);
  assert.ok(
    audit.structuralRoleLosses.some(item => item.role === 'label' && item.sourceCount === 3),
    JSON.stringify(audit.structuralRoleLosses)
  );
  assert.equal(audit.pass, false);
});

test('국소 의미 수리 뒤 무너진 라벨 행은 최종 구조 복원과 공백 보정 뒤에도 유지한다', () => {
  const source = [
    '의사결정 조건을 구분한다.',
    '확실성하의 의사결정: 결과를 확정할 수 있다.',
    '위험하의 의사결정: 확률을 추정할 수 있다.',
    '불확실성하의 의사결정: 확률도 알 수 없다.'
  ].join('\n');
  const plan = structureChunk.splitChunksForGpt(source, { coalesceEditable: true });
  const collapsed = '의사결정 조건을 나눈다. 확실성하의 의사결정: 결과를 확정할 수 있다. 위험하의 의사결정: 확률을 추정할 수 있다. 불확실성하의 의사결정: 확률도 알 수 없다.';
  const restored = structureChunk.restoreLockedStructureLayout({
    source,
    outputText: collapsed,
    chunks: plan.chunks
  });
  const formatted = koreanRefinement.applySafeFormattingRepairs({
    source,
    outputText: restored.text,
    documentProfile: { profile: 'report_assignment' }
  });
  assert.equal(restored.pass, true);
  assert.match(formatted.text, /^확실성하의 의사결정:/mu);
  assert.match(formatted.text, /^위험하의 의사결정:/mu);
  assert.match(formatted.text, /^불확실성하의 의사결정:/mu);
  assert.equal(layoutStructure.analyzeLineStructure(formatted.text).labelLineCount, 3);
});

test('독립 제목 때문에 문장 번호가 밀려도 상투구 수리는 인접한 다른 문장을 덮어쓰지 않는다', () => {
  const source = [
    '6. 환경윤리학의 본질',
    '단순히 머릿속으로 판단을 내리는 수준에서 벗어나, 직접 현실에서 행동하는 실천 수준의 윤리학이 되어야 한다.',
    '실천 수준의 윤리학이란 인간과 자연환경 사이의 도덕적 관계를 설명하고 그 실천을 지지하는 학문이다.',
    '<나의 생각 정리>',
    '이는 과학의 객관성의 신화가 위험한 환상이었음을 보여 주는 예시라고 볼 수 있다.'
  ].join('\n');
  const output = [
    '6. 환경윤리학의 본질',
    '',
    '단순히 머릿속에서 판단을 내리는 수준에 머무르지 않고, 현실에서 직접 행동으로 이어지는 실천 수준의 윤리학이어야 한다.',
    '실천 수준의 윤리학이란 인간과 자연환경 사이의 도덕적 관계를 설명하고 그 실천을 지지하는 학문이다.',
    '',
    '<나의 생각 정리>',
    '',
    '과학의 객관성의 신화가 위험한 환상이었음을 이 사례는 분명히 보여 준다.'
  ].join('\n');
  const audit = fingerprint.auditFingerprint(source, output, 'report_assignment');
  assert.ok(audit.issueCodes.includes('engine_phrase_fingerprint'), JSON.stringify(audit));
  assert.ok(audit.issueCodes.includes('semantic_relation_shift'), JSON.stringify(audit));

  const restored = fingerprint.restoreUnsafeRelationSentences(source, output, audit);
  assert.equal(restored.applied, true, JSON.stringify(restored));
  assert.match(restored.text, /^6\. 환경윤리학의 본질$/mu);
  assert.match(restored.text, /머릿속으로 판단을 내리는 수준에서 벗어나/u);
  assert.match(restored.text, /예시라고 볼 수 있다/u);
  assert.equal(
    (restored.text.match(/실천 수준의 윤리학이란/gu) || []).length,
    1,
    restored.text
  );
  assert.equal(fingerprint.auditFingerprint(source, restored.text, 'report_assignment').pass, true);
});

test('가능하다는 결과를 목적이라고 바꾸면 확정 강화와 구분해 원문 의미로 복원한다', () => {
  const source = '이 방식은 비용을 줄이면서도 시설을 안전하게 지켜낼 수 있다.';
  const output = '이 방식은 비용을 줄이면서 시설을 안전하게 보호하는 데 목적이 있다.';
  const audit = fingerprint.auditFingerprint(source, output, 'long_explainer');
  assert.equal(audit.pass, false, JSON.stringify(audit));
  assert.ok(
    audit.semanticRelations.shifts.some(item => item.family === 'possibility_changed_to_goal'),
    JSON.stringify(audit)
  );
  assert.equal(
    audit.semanticRelations.shifts.some(item => item.family === 'possibility_hardened_to_certainty'),
    false,
    JSON.stringify(audit)
  );
  const restored = fingerprint.restoreUnsafeRelationSentences(source, output, audit);
  assert.equal(restored.applied, true, JSON.stringify(restored));
  assert.equal(restored.text, source);
});

test('앞 단계의 기존 사실 누락이 무관한 국소 의미 복원을 가로막지 않되 새 손실은 거부한다', () => {
  const source = '서울대학교 연구팀은 2025년에 3건을 확인했다. 이 방식은 시설을 안전하게 지켜낼 수 있다.';
  const before = '연구팀은 3건을 확인했다. 이 방식은 시설을 안전하게 보호하는 데 목적이 있다.';
  const candidate = '연구팀은 3건을 확인했다. 이 방식은 시설을 안전하게 지켜낼 수 있다.';
  assert.equal(engine.isSafeLocalizedLanguageCandidate({
    source,
    before,
    candidate,
    documentProfile: { profile: 'report_assignment' },
    mode: 'assignment',
    protectedTerms: ['서울대학교'],
    maxLocalEditRatio: 0.4,
    minLocalLengthRatio: 0.78,
    maxLocalLengthRatio: 1.22,
    allowDepthRegression: true
  }), true);

  assert.equal(engine.isSafeLocalizedLanguageCandidate({
    source,
    before,
    candidate: '연구팀은 4건을 확인했다. 이 방식은 시설을 안전하게 지켜낼 수 있다.',
    documentProfile: { profile: 'report_assignment' },
    mode: 'assignment',
    protectedTerms: ['서울대학교'],
    maxLocalEditRatio: 0.4,
    minLocalLengthRatio: 0.78,
    maxLocalLengthRatio: 1.22,
    allowDepthRegression: true
  }), false);
});

test('의미 수리 뒤 목표 미달 상태에서 최소 체감선까지 무너지면 최종 회복을 다시 실행한다', () => {
  assert.equal(engine.isMaterialDepthRegression(
    {
      pass: false,
      minimumEffectPass: true,
      score: 0.81,
      substantiveEditRatio: 0.09,
      structuralChangedCount: 2
    },
    {
      pass: false,
      minimumEffectPass: false,
      score: 0.79,
      substantiveEditRatio: 0.057,
      structuralChangedCount: 2
    }
  ), true);
  assert.equal(engine.isMaterialDepthRegression(
    {
      pass: false,
      minimumEffectPass: true,
      score: 0.81,
      substantiveEditRatio: 0.09,
      structuralChangedCount: 2
    },
    {
      pass: false,
      minimumEffectPass: true,
      score: 0.80,
      substantiveEditRatio: 0.085,
      structuralChangedCount: 2
    }
  ), false);
  assert.equal(engine.isMaterialDepthRegression(
    {
      pass: true,
      minimumEffectPass: true,
      targetDepthMet: true,
      score: 1,
      substantiveEditRatio: 0.19,
      structuralChangedCount: 4
    },
    {
      pass: true,
      minimumEffectPass: true,
      targetDepthMet: false,
      score: 1,
      substantiveEditRatio: 0.16,
      structuralChangedCount: 4
    }
  ), true);
});

test('휴머나이징 최소선 통과와 권장 목표 미달은 서로 다른 효과 코드로 기록한다', () => {
  const targetOnly = engine.depthQualityWarnings({
    minimumEffectPass: true,
    reasons: ['substantive_edit_ratio_low']
  });
  assert.deepEqual(targetOnly.map(item => item.code), [
    'humanization_depth_below_target'
  ]);

  const belowMinimum = engine.depthQualityWarnings({
    minimumEffectPass: false,
    reasons: ['substantive_edit_ratio_low']
  });
  assert.deepEqual(belowMinimum.map(item => item.code), [
    'humanization_depth_below_minimum'
  ]);
});

test('라벨이 많은 polish 문서는 대표 본문만 1차 호출하고 잔여 오류를 문서 감사에 맡긴다', () => {
  const chunks = Array.from({ length: 36 }, (_, index) => ({
    index,
    text: index === 35
      ? '메세지 표현은 고쳐야 합니다.'
      : `짧은 답변 ${index + 1}`,
    locked: false
  }));
  const documentProfile = {
    formatProfile: {
      flags: ['label_heavy']
    }
  };
  const deferred = chunks.map((chunk, index) => engine.shouldDeferPolishLabelMicroFragment({
    chunk,
    chunks,
    index,
    documentProfile
  }));

  assert.equal(deferred.filter(Boolean).length, 28);
  assert.equal(deferred.filter(value => !value).length, 8);
  assert.equal(deferred[35], false, 'known Korean repair target must stay in the primary-call set');
});

test('라벨이 많은 일반 문서도 미세 본문 호출 수를 제한하고 대표 문장은 유지한다', () => {
  const chunks = Array.from({ length: 30 }, (_, index) => ({
    index,
    text: index === 29
      ? '메세지 표현은 고쳐야 하며 보고서의 핵심 판단을 설명합니다.'
      : `항목 ${index + 1}에 관한 짧은 설명입니다.`,
    locked: false
  }));
  const documentProfile = {
    formatProfile: {
      flags: ['label_heavy']
    }
  };
  const deferred = chunks.map((chunk, index) => engine.shouldDeferLabelMicroFragment({
    chunk,
    chunks,
    index,
    documentProfile,
    mode: 'assignment'
  }));

  assert.equal(deferred.filter(Boolean).length, 18);
  assert.equal(deferred.filter(value => !value).length, 12);
  assert.equal(deferred[29], false, 'known Korean repair target must stay in the primary-call set');
});

test('과도하게 긴 원문 문단을 가독성 목표 안에서 나눈 결과는 구조 손상으로 경고하지 않는다', () => {
  const paragraphs = Array.from({ length: 3 }, (_, paragraphIndex) => (
    Array.from({ length: 10 }, (_, sentenceIndex) => (
      `${paragraphIndex + 1}-${sentenceIndex + 1}번째 설명은 같은 논지의 근거와 맥락을 충분히 담고 있습니다.`
    )).join(' ')
  ));
  const source = paragraphs.join('\n\n');
  const readable = paragraphs
    .flatMap(paragraph => {
      const sentences = paragraph.match(/[^.]+[.]/gu) || [paragraph];
      return [
        sentences.slice(0, 5).join(' '),
        sentences.slice(5).join(' ')
      ];
    })
    .join('\n\n');
  const fragmented = paragraphs
    .flatMap(paragraph => paragraph.match(/[^.]+[.]/gu) || [paragraph])
    .join('\n\n');
  const sourceVoice = voiceProfile.buildVoiceProfile(source, {
    documentProfile: 'report_assignment',
    mode: 'assignment'
  });

  const readableAudit = voiceProfile.auditVoice(sourceVoice, readable, {
    documentProfile: 'report_assignment',
    mode: 'assignment',
    sourceText: source
  });
  assert.equal(
    readableAudit.warnings.some(item => item.code === 'paragraph_structure_changed'),
    false
  );

  const fragmentedAudit = voiceProfile.auditVoice(sourceVoice, fragmented, {
    documentProfile: 'report_assignment',
    mode: 'assignment',
    sourceText: source
  });
  assert.equal(
    fragmentedAudit.warnings.some(item => item.code === 'paragraph_structure_changed'),
    true
  );
});

test('대시형·완결형 번호 제목에 붙은 본문을 모델 호출 전에 분리한다', () => {
  const source = [
    '2. 죽음의 신체를 읽다 - 조토의 <애도> 조토, 애도(Lamentation), 프레스코화 작품을 보며 죽음의 표현을 살펴보았다.',
    '4. 왜 나는 무감각하지 않았는가 - 신경과학적 접근 생명과학을 공부하는 나는 그 이미지 앞에서 완전히 무덤덤하지 않았다.',
    '5. 생명과학이 설명하지 못하는 자리에서 예술이 시작된다 생명과학은 현상을 냉정하게 설명하지만 감상의 의미까지 대신하지는 않는다.'
  ].join('\n\n');
  const result = preflight.auditAndSanitizeSource(source);
  assert.equal(result.changed, true);
  assert.match(result.text, /<애도>\n조토, 애도/u);
  assert.match(result.text, /신경과학적 접근\n생명과학을/u);
  assert.match(result.text, /예술이 시작된다\n생명과학은/u);
  const lines = result.text.split('\n').filter(Boolean);
  assert.equal(lines.filter(line => /^[245]\.\s/u.test(line)).length, 3);
});

test('강한 회복 후보는 문단 역할을 보존한 읽기용 분할 때문에 폐기되지 않는다', () => {
  const source = [
    '자료 수집 기준을 먼저 정한 뒤 관련 사례를 분류했습니다.',
    '분류 결과를 항목별로 비교하여 공통점과 차이점을 확인했습니다.',
    '확인한 내용은 표에 정리하고 판단 근거를 함께 기록했습니다.',
    '마지막에는 분석 범위와 남은 한계를 검토했습니다.'
  ].join(' ');
  const candidate = [
    '먼저 자료를 모을 기준부터 정하고 관련 사례를 나누었습니다.',
    '그런 다음 항목별 결과를 대조해 공통점과 차이점을 살폈습니다.',
    '',
    '확인한 내용은 판단 근거와 함께 표로 정리했습니다.',
    '끝으로 분석 범위와 남은 한계도 검토했습니다.'
  ].join('\n');
  const profile = { profile: 'report_assignment', formatProfile: { flags: [] } };
  const plan = humanizationDepth.buildHumanizationPlan(source, {
    requestStrength: 'advanced',
    documentProfile: profile
  });
  const audit = engine.auditGeneralSurfaceCandidate(
    source,
    candidate,
    null,
    profile,
    'assignment',
    source,
    plan
  );
  assert.equal(audit.pass, true, JSON.stringify(audit));
  assert.equal(audit.codes.includes('structure_loss'), false, JSON.stringify(audit));
  assert.ok(audit.limits.maxEdit >= 0.52, JSON.stringify(audit.limits));
});

test('라벨·목록 문서는 구조 행 수를 보존하면 본문 문장 분리와 빈 줄을 허용한다', () => {
  const source = [
    '강점: 고객 요청을 빠르게 정리하고 처리 과정을 기록했습니다.',
    '약점: 여러 자료가 한꺼번에 들어오면 우선순위 판단이 늦어졌습니다.',
    '계획: 기준표를 만들어 처리 순서를 먼저 확인하겠습니다.'
  ].join('\n');
  const candidate = [
    '강점: 고객 요청의 핵심을 먼저 추렸습니다. 처리 과정도 기록했습니다.',
    '',
    '약점: 자료가 몰리면 우선순위를 정하는 데 시간이 걸렸습니다.',
    '',
    '계획: 기준표로 처리 순서를 먼저 확인하겠습니다.'
  ].join('\n');
  const profile = {
    profile: 'resume_application',
    formatProfile: { flags: ['label_heavy', 'list_heavy'] }
  };
  const plan = humanizationDepth.buildHumanizationPlan(source, {
    requestStrength: 'advanced',
    documentProfile: profile
  });
  const audit = engine.auditGeneralSurfaceCandidate(
    source,
    candidate,
    null,
    profile,
    'assignment',
    source,
    plan
  );
  assert.equal(audit.pass, true, JSON.stringify(audit));

  const missingLabel = candidate.replace(/^약점:\s*/mu, '');
  const rejected = engine.auditGeneralSurfaceCandidate(
    source,
    missingLabel,
    null,
    profile,
    'assignment',
    source,
    plan
  );
  assert.equal(rejected.pass, false);
  assert.ok(rejected.codes.includes('structure_loss'), JSON.stringify(rejected));
});

test('구조 행 사이의 읽기용 빈 줄은 실제 행 병합으로 오인하지 않는다', () => {
  const source = [
    '강점: 고객 요청을 분류했습니다.',
    '약점: 처리 순서가 늦었습니다.',
    '계획: 기준표를 만들겠습니다.',
    '결과: 처리 시간을 줄였습니다.'
  ].join('\n');
  const output = source.split('\n').join('\n\n');
  const sourceVoice = voiceProfile.buildVoiceProfile(source, {
    documentProfile: {
      profile: 'resume_application',
      formatProfile: { flags: ['label_heavy'] }
    },
    mode: 'assignment'
  });
  const audit = voiceProfile.auditVoice(sourceVoice, output, {
    documentProfile: {
      profile: 'resume_application',
      formatProfile: { flags: ['label_heavy'] }
    },
    mode: 'assignment',
    sourceText: source
  });
  assert.equal(
    audit.warnings.some(item => item.code === 'line_structure_changed'),
    false,
    JSON.stringify(audit.warnings)
  );
  assert.equal(
    audit.warnings.some(item => item.code === 'paragraph_structure_changed'),
    false,
    JSON.stringify(audit.warnings)
  );
});

test('깊이 측정은 한 문장을 두 문장으로 나눈 재구성을 단일 문장 오정렬 없이 센다', () => {
  const source = [
    '자료를 수집한 뒤 기준에 따라 분류하고 결과를 표로 정리했습니다.',
    '이 결과를 바탕으로 공통점과 차이점을 검토했습니다.'
  ].join(' ');
  const output = [
    '먼저 자료를 수집했습니다.',
    '정한 기준으로 자료를 분류한 뒤 결과는 표에 정리했습니다.',
    '그 결과를 토대로 공통점과 차이점을 살폈습니다.'
  ].join(' ');
  const metrics = humanizationDepth.measureSubstantiveEdit(source, output);
  assert.equal(metrics.sourceSentenceCount, 2);
  assert.equal(metrics.outputSentenceCount, 3);
  assert.ok(metrics.substantiveChangedSentenceCount >= 2, JSON.stringify(metrics));
  assert.ok(metrics.structurallyChangedSentenceCount >= 1, JSON.stringify(metrics));
  assert.equal(metrics.sentenceEdits[0].outputEndIndex - metrics.sentenceEdits[0].outputIndex, 2);
});

test('강도별 화자·리듬 프롬프트가 문장 재구성 지시와 충돌하지 않는다', () => {
  const source = '짧은 문장입니다. 이 문장은 조금 더 길게 이어집니다. 다시 짧습니다. 마지막 문장은 근거를 충분히 설명하며 마무리됩니다.';
  const profile = voiceProfile.buildVoiceProfile(source, {
    documentProfile: 'general_essay',
    mode: 'assignment'
  });
  const advanced = voiceProfile.voicePromptBlock(profile, {
    requestStrength: 'advanced',
    mode: 'assignment'
  });
  assert.match(advanced, /의미 단위를 자연스럽게 합치거나 나눌 수 있다/u);
  assert.doesNotMatch(advanced, /문법적으로 성립하는 원문 문장은.+합치거나 쪼개지 않는다/u);

  const polish = voiceProfile.voicePromptBlock(profile, {
    requestStrength: 'polish',
    mode: 'polish'
  });
  assert.match(polish, /문장을 합치거나 쪼개지 않고/u);
});

test('회복 후보는 앞 단계의 기존 사실 손실 때문에 전부 폐기되지 않되 새 손실은 거부한다', () => {
  const source = [
    '서울대학교 연구팀은 2025년에 자료 3건을 수집했습니다.',
    '이후 자료를 기준에 따라 분류하고 결과를 비교했습니다.'
  ].join(' ');
  const current = [
    '연구팀은 2025년에 자료 3건을 수집했습니다.',
    '이후 자료를 기준에 따라 분류하고 결과를 비교했습니다.'
  ].join(' ');
  const candidate = [
    '연구팀은 2025년에 자료 3건을 수집했습니다.',
    '그다음 정한 기준으로 자료를 나누어 결과를 대조했습니다.'
  ].join(' ');
  const profile = { profile: 'report_assignment', formatProfile: { flags: [] } };
  const plan = humanizationDepth.buildHumanizationPlan(source, {
    requestStrength: 'advanced',
    documentProfile: profile
  });
  const accepted = engine.auditGeneralSurfaceCandidate(
    source,
    candidate,
    null,
    profile,
    'assignment',
    current,
    plan
  );
  assert.equal(accepted.pass, true, JSON.stringify(accepted));

  const newlyUnsafe = candidate.replace('2025년에 ', '');
  const rejected = engine.auditGeneralSurfaceCandidate(
    source,
    newlyUnsafe,
    null,
    profile,
    'assignment',
    current,
    plan
  );
  assert.equal(rejected.pass, false);
  assert.ok(
    rejected.codes.includes('number_changed') || rejected.codes.includes('semantic_shift'),
    JSON.stringify(rejected)
  );
});

test('잠긴 라벨 행이 공백으로 합쳐진 강한 후보는 구조만 복원한 뒤 감사한다', () => {
  const source = [
    '의사결정 조건을 구분합니다.',
    '확실성하의 의사결정: 결과를 확정할 수 있습니다.',
    '위험하의 의사결정: 확률을 추정할 수 있습니다.',
    '불확실성하의 의사결정: 확률도 알 수 없습니다.'
  ].join('\n');
  const plan = structureChunk.splitChunksForGpt(source, { coalesceEditable: true });
  const collapsed = source.replace(/\n/gu, ' ');
  const prepared = engine.prepareGeneralSurfaceCandidate({
    source,
    candidate: collapsed,
    chunks: plan.chunks
  });
  assert.equal(prepared.applied, true, JSON.stringify(prepared));
  assert.match(prepared.text, /^확실성하의 의사결정:/mu);
  assert.match(prepared.text, /^위험하의 의사결정:/mu);
  assert.match(prepared.text, /^불확실성하의 의사결정:/mu);
});
