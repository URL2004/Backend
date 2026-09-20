'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const layout = require('../engine-gpt-prod/layoutStructure');
const preflight = require('../engine-gpt-prod/sourcePreflight');
const korean = require('../engine-gpt-prod/koreanRefinement');
const { hasStanzaRefrainLayout } = require('../engine-gpt-prod/verseLayout');
const fingerprint = require('../engine-gpt-prod/fingerprintAudit');
const structure = require('../engine-gpt-prod/structureChunk');
const detectInput = require('../lib/detectInputDocument');

test('reported-speech continuation is prose, not a locked section heading', () => {
  const source = '자료를 함께 검토하며 앞으로 협력하려면 먼저 기준을 맞추어야 한다고\n생각했습니다. 이후에는 검토한 내용을 충분히 설명하고 구성원들과 협의하는 과정을 여러 차례 반복했습니다.';
  assert.equal(layout.buildLineRecords(source)[0].role, 'prose');
  assert.match(preflight.repairSourceLayoutArtifacts(source).text, /한다고 생각했습니다/);
  assert.equal(layout.isKnownHeadingLine('제1조 (목적)'), true);
});

test('explicit issue heading retains structure with presentational copula', () => {
  assert.equal(layout.isKnownHeadingLine('<쟁점 2. 제도의 변화> 입니다'), true);
  assert.equal(layout.isKnownHeadingLine('<실험> 결과를 비교했습니다.'), false);
});

test('quote copula and independent demonstrative have distinct spacing', () => {
  const source = '하나는 ‘질문 나누기’다. “Patterns matter.” 이 문장을 읽었다.';
  const outputText = '하나는 ‘질문 나누기’ 다. “Patterns matter.”이 문장을 읽었다.';
  const fixed = korean.applySafeFormattingRepairs({ source, outputText }).text;
  assert.equal(fixed, source);
  assert.equal(korean.applySafeFormattingRepairs({ source, outputText: fixed }).text, fixed);
  for (const text of ['‘질문’이 중요하다.', '‘질문’을 다 읽었다.', '‘질문’ 다음에 답한다.', 'Let’s Grow']) {
    assert.equal(korean.applySafeFormattingRepairs({ source: text, outputText: text }).text, text);
  }
});

test('punctuated refrains preserve stanza lines without matching ordinary reports', () => {
  const stanza = '나는 작은 나무다.\n나는 숲의 나무다.\n바람을 따라 흔들리고,\n다시 하늘을 바라본다.';
  const poem = `나무\n\n${stanza}\n\n새벽이 나를 깨운다.\n${stanza}`;
  assert.equal(hasStanzaRefrainLayout(poem), true);
  assert.equal(preflight.repairSourceLayoutArtifacts(poem).text, poem);
  assert.equal(hasStanzaRefrainLayout('1. 확인한다.\n2. 검토한다.\n3. 기록한다.\n\n1. 확인한다.\n2. 검토한다.\n3. 기록한다.\n4. 끝낸다.'), false);
});

test('semantic relations distinguish difficulty, current responsibility and reflective emotion', () => {
  const pairs = [
    ['일정 문제로 외근이 어려웠습니다.', '일정 문제로 외근할 수 없었습니다.', 'difficulty_strengthened_to_impossibility'],
    ['현재 자료 정리 업무를 담당하고 있습니다.', '자료 정리 업무를 담당했습니다.', 'current_responsibility_changed_to_past'],
    ['실험을 분석하며 이론의 활용에 큰 감명을 받았습니다.', '실험을 분석하며 이론의 활용을 확인했습니다.', 'reflective_emotion_removed']
  ];
  for (const [source, output, family] of pairs) {
    assert(fingerprint.detectSemanticRelationShifts(source, output).shifts.some(x => x.family === family));
    assert(!fingerprint.detectSemanticRelationShifts(source, source).shifts.some(x => x.family === family));
  }
});

test('a second proposal lead belongs with its explanation without changing content', () => {
  const source = '수업을 개선하는 방안을 두 가지 제안한다. 하나는 ‘질문 나누기’다. 질문을 익명으로 제출하고 서로 배정한다. 학생들은 다른 사람의 고민을 읽고 한 학기 동안 함께 답을 찾는다. 타인의 입장을 깊이 생각하는 경험을 얻을 수 있다. 또 하나는 ‘주장 검토하기’다. 학기 초에는 자신의 주장을 적는다. 학기 말에는 그 주장을 비판하는 글을 작성한다. 서로 다른 관점을 검토하는 방법을 배울 수 있다.';
  const outputText = source.replace('학기 초에는', '\n\n학기 초에는');
  const result = structure.restoreParagraphLayout({ source, outputText, mode: 'blog', requestStrength: 'basic', documentProfile: { profile: 'personal_essay', confidence: .9 } });
  assert.match(result.text, /\n\n또 하나는/);
  assert.doesNotMatch(result.text, /‘주장 검토하기’다\.\s*\n\n/);
  assert.equal(result.text.replace(/\s/gu, ''), source.replace(/\s/gu, ''));
  const variant = outputText.replace('또 하나는', '둘째는');
  const next = structure.restoreParagraphLayout({ source: source.replace('또 하나는', '둘째는'), outputText: variant, mode: 'blog', requestStrength: 'basic', documentProfile: { profile: 'personal_essay', confidence: .9 } });
  assert.match(next.text, /\n\n둘째는/);
  assert.equal(next.text.replace(/\s/gu, ''), variant.replace(/\s/gu, ''));
});

test('authored reflective blockquote wrappers remain detectable with exact source offsets', () => {
  const body = '실습에서 준비 과정을 직접 관찰하였다. 담당자가 도구를 확인하는 모습을 관찰하였다. 학교에서는 각 과정의 목적을 배웠다. 이번 활동에서 대상자의 상태를 확인하고 필요한 절차를 미리 준비하는 일이 중요하다고 느꼈다.';
  const text = `1. 실습 활동\n> ${body}\n2. 배운 점\n> ${body}`;
  const result = detectInput.buildDetectInputDocument(text);
  assert(result.eligibleSentenceCount >= 8);
  for (const row of result.sentences) assert.equal(text.slice(row.start, row.end), row.text);
  const cited = text.replace('> ', '> 출처: 외부 문헌. ');
  assert(detectInput.buildDetectInputDocument(cited).eligibleSentenceCount < result.eligibleSentenceCount);
  const shortQuote = '본문을 작성했다.\n> 저는 이 방식이 좋다고 생각합니다.';
  assert(detectInput.buildDetectInputDocument(shortQuote).sentences.some(x => x.spanType === 'quote' && !x.eligibleForDetection));
});

test('source orthography repair preserves quotations, homonyms and technical intent', () => {
  const text = '결과가 없을수도 있다. 스펙드럼을 확인한다. 사림을 연구한다. “스펙드럼을 확인한다.”';
  const out = korean.applySafeDeterministicRepairs({ source: text, outputText: text }).text;
  assert.match(out, /없을 수도/);
  assert.match(out, /스펙트럼을/);
  assert.match(out, /사림을 연구/);
  assert.match(out, /“스펙드럼을 확인한다\.”/);
  assert.equal(korean.applySafeDeterministicRepairs({ source: text, outputText: out }).text, out);
});
