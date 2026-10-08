'use strict';

// Presentation-only observations. These never enter detector scoring, routing,
// calibration or claims that a described event actually happened.
const sg = require('../engine/surfaceguard');
const { splitSentenceSpans } = require('../engine/koreanText');
const VERSION = 'content-context-v1';
const ACTION = /(?:제작|배포|분주|재분주|측정|수집|기록|정리|분류|삭제|전송|발송|비교|검토|관찰|수정|작성|실험|분석|확인|저장|배양|혼합|설치|제출|추출|안내|재배치)(?:하|해|했|한|할|된|되|를|을| 중| 작업| 계획| 예정|\s*[,，·]|\s+등)|(?:만들|나누어|나눠|보내|옮기|고치|덜어|채워)/u;
const OBJECT = /(?:[가-힣A-Za-z0-9]{2,}(?:을|를)\s)|(?:가이드|안내서|시료|용액|검체|이메일|메일|자료|문서|표본|보고서|결과표|질문지|설문지|장비|접시|well|웰|오류|배양액|파일|목록|도표)/iu;
const SITUATION = /(?:때|중에|과정에서|실험에서|수업에서|현장에서|오류|누락|문제|담당|참여|회의|수업|동아리|실험|조사)/u;
const OUTPUT = /(?:가이드|안내서|결과표|보고서|기록지|목록|도표|질문지|설문지|완성|제작|배포|제출|저장)/u;
const PLAN = /(?:계획|예정|목표|앞으로|하려고|겠(?:다|습니다)|할 것이다|하기로|할 생각|고\s*싶|하고자)/u;
const SCHEDULE = /(?:매주|매일|매월|격주|[월화수목금토일]요일|\d+\s*(?:일|주|개월|시|분|회|개|건|명|장|통)|경우에|때마다|완료하면)/u;

function sentenceContext(text) {
  const action = ACTION.test(text), object = OBJECT.test(text);
  const plan = PLAN.test(text);
  const concretePlan = plan && action && object && SCHEDULE.test(text);
  const situatedAction = !plan && action && object && (SITUATION.test(text) || OUTPUT.test(text));
  // A present-tense polite ending alone is not evidence of a personal stance.
  const role = /^\s*(?:>|[“「『"])/u.test(text) && /[”」』"]\s*[.!?]?$/u.test(text) ? 'quotation'
    : /(?:나는|저는|내가|제가|나에게|저에게|생각한다|생각합니다|느꼈|깨달|돌아보|배웠|공감한다|동의한다)/u.test(text) ? 'reflection'
    : /(?:라고 정의|으로 정의|을 의미|를 의미|란\s|이란\s|라 함은|뜻한다|일컫)/u.test(text) ? 'definition'
    : /(?:먼저|다음으로|그다음|마지막으로|순서대로|단계에서|절차에 따라)/u.test(text) && action ? 'procedure'
    : /(?:관찰되|측정되|보고되|나타났|확인되|기록되|결과는|연구에 따르면)/u.test(text) ? 'observation'
    : /(?:주장한다|주장합니다|반론|따라서|그러므로|근거로|동의하지)/u.test(text) ? 'argument'
    : concretePlan ? 'plan' : 'unknown';
  return { role, concretePlan, situatedAction,
    grounded: sg.isLivedScene(text) || sg.classifyParagraphKind(text) === 'concrete' || concretePlan || situatedAction,
    cautious: /(?:가능성이|일 수 있|수도 있|일반화할 수 없|단정할 수 없|보고되었다|추정된다)/u.test(text) };
}

function paragraphContext(text) {
  const sentences = splitSentenceSpans(String(text || '')).map(span => sentenceContext(span.text));
  const roles = [...new Set(sentences.map(item => item.role).filter(role => role !== 'unknown'))];
  const role = roles.length === 1 ? roles[0] : roles.length ? 'mixed' : 'unknown';
  const stanceApplicable = roles.some(value => ['reflection', 'argument'].includes(value));
  return { version: VERSION, role, roles, stanceApplicable,
    cautious: sentences.some(item => item.cautious),
    concretePlans: sentences.filter(item => item.concretePlan).length,
    situatedActions: sentences.filter(item => item.situatedAction).length,
    grounded: sentences.filter(item => item.grounded).length,
    sentenceCount: sentences.length };
}

function presentationDetails(paragraphs, details) {
  return details.map((item, index) => {
    if (item.excluded || typeof paragraphs?.[index] !== 'string') return { ...item };
    const context = paragraphContext(paragraphs[index]);
    // Never add independently counted signals: the same sentence can carry
    // a date, an action and an output. The union is counted once above.
    return { ...item, grounded: context.grounded, contentContext: context };
  });
}

module.exports = { VERSION, sentenceContext, paragraphContext, presentationDetails };
