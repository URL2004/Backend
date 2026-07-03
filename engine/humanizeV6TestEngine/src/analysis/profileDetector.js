'use strict';
const { normalizeText, splitLines, isHeading, splitParagraphs } = require('./textStats');

function detectProfile(text) {
  const t = normalizeText(text);
  const lines = splitLines(t);
  const paras = splitParagraphs(t);
  const headingCount = lines.filter(isHeading).length;
  const hasRoman = /[ⅠⅡⅢⅣⅤ]\s*\.?\s*(서론|본론|결론)/.test(t);
  const hasNumbered = /^\s*\d+\.?\s+/m.test(t);
  const hasGreeting = /안녕하세요[,，]?\s*[^\n]{0,20}입니다/.test(t);
  const hasFieldMeta = /(작업 인원|소요 시간|사용 장비|관리 규모|주요 범위|권장 관리 주기)/.test(t);
  const hasResearch = /(연구|논문|가설|방법론|표본|분석 결과|선행연구|참고문헌)/.test(t);
  const hasApplication = /(지원동기|입사 후 포부|성장과정|자기소개|역량|직무 경험)/.test(t);
  const hasOpinion = /(필자는|주장한다|생각한다|사회적으로|관점에서|칼럼|논평)/.test(t);
  const hasFactual = /(시스템|기술|데이터|API|클라우드|설비|프로세스|서비스|인프라|운영|기능)/i.test(t);

  let type = 'generalText';
  if (hasApplication) type = 'applicationText';
  else if (hasResearch) type = 'researchText';
  else if (hasGreeting || hasFieldMeta) type = 'webArticle';
  else if (hasRoman || (headingCount >= 2 && hasNumbered)) type = hasFactual ? 'factualExposition' : 'structuredExposition';
  else if (hasFactual) type = 'factualExplainer';
  else if (hasOpinion) type = 'opinionText';
  else if (paras.length <= 4 && /(느꼈|생각했|경험|배웠)/.test(t)) type = 'narrativeReflection';

  return {
    type,
    headingCount,
    paragraphCount: paras.length,
    hasRoman,
    hasNumbered,
    hasGreeting,
    hasFieldMeta,
    hasFactual
  };
}

module.exports = { detectProfile };
