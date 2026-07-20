'use strict';

const { splitSentences } = require('../engine/koreanText');
const { splitLogicalProseParagraphs } = require('./proseParagraphs');

const VERSION = 1;

// 기관명·전공명 같은 특정 테스트 문구가 아니라 지원서 전반에 공통인 의미
// 기능을 본다. 형태소 분석기 없이 활용할 수 있도록 활용형 어근까지 포함한다.
const FAMILY_PATTERNS = Object.freeze({
  choice: /(?:전공|진로|직무|학과|분야|관심사|진학|선택|방향)/u,
  uncertainty: /(?:정하지|정해지지|좁혀지지|결정하지|확신|막연|고민|성급|가능성|열어\s*두)/u,
  exploration: /(?:탐색|비교|살펴|알아보|확인|시험해|접하|경험|질문|조사|찾(?:고|아|을)|부딪혀)/u,
  fit: /(?:맞는|적성|흥미|관심|적합|기준|요구되는|필요한\s*역량)/u,
  application: /(?:지원|신청|참여|선발|기회|캠프|프로그램|체험)/u,
  motivation: /(?:이유|동기|원하|싶|절실|생각했|필요(?:하다고|했습니다|합니다|했다|했|한\s*(?:과정|기회|자리|이유)))/u,
  growth: /(?:성장|역량|능력|강점|배우|익히|향상|다졌|길렀)/u,
  diligence: /(?:성실|노력|꾸준|끝까지|책임|적극|꼼꼼)/u,
  future: /(?:앞으로|이후|계획|포부|되겠습니다|하겠습니다|만들겠습니다)/u,
  contribution: /(?:기여|활용|적용|도움|성과|변화)/u
});

const THEMES = Object.freeze([
  { code: 'choice_uncertainty', families: ['choice', 'uncertainty'] },
  { code: 'choice_exploration', families: ['choice', 'exploration'] },
  { code: 'exploration_fit', families: ['exploration', 'fit'] },
  { code: 'application_motivation', families: ['application', 'motivation'] },
  { code: 'growth_diligence', families: ['growth', 'diligence'] },
  { code: 'future_contribution', families: ['future', 'contribution'] }
]);

function buildResumeRepetitionPlan(source, documentProfile = null) {
  const profile = String(documentProfile?.profile || documentProfile?.contentGenre || documentProfile || 'unknown');
  const safetyProfiles = Array.isArray(documentProfile?.safetyProfiles) ? documentProfile.safetyProfiles : [];
  const protectedProfile = profile === 'resume_application' || safetyProfiles.includes('resume_application');
  const analysis = analyze(source);
  const repeatedThemes = analysis.themes.filter(theme => theme.occurrenceCount >= 3 && theme.paragraphCount >= 2);
  const targetIndices = [...new Set(repeatedThemes.flatMap(theme => theme.sentenceIndices.slice(1)))].sort((a, b) => a - b);
  const sourcePairCount = repeatedThemes.reduce((sum, theme) => sum + Math.max(0, theme.occurrenceCount - 1), 0);
  const applicable = protectedProfile
    && analysis.sentenceCount >= 8
    && analysis.paragraphCount >= 2
    && repeatedThemes.length > 0
    && targetIndices.length >= 2;
  const requiredReduction = applicable ? Math.max(1, Math.ceil(sourcePairCount * 0.25)) : 0;
  return {
    version: VERSION,
    applicable,
    protectedProfile,
    sourceSentenceCount: analysis.sentenceCount,
    sourceParagraphCount: analysis.paragraphCount,
    themeCount: applicable ? repeatedThemes.length : 0,
    themeCodes: applicable ? repeatedThemes.map(theme => theme.code) : [],
    sourcePairCount: applicable ? sourcePairCount : 0,
    requiredReduction,
    targetSentenceCount: applicable ? targetIndices.length : 0,
    targetIndices: applicable ? targetIndices : []
  };
}

function compareResumeRepetition(output, plan) {
  if (!plan?.applicable) return {
    version: VERSION,
    applicable: false,
    pass: true,
    sourcePairCount: 0,
    residualPairCount: 0,
    requiredReduction: 0,
    achievedReduction: 0,
    coverage: 1,
    themeCount: 0
  };
  const analysis = analyze(output);
  const byCode = new Map(analysis.themes.map(theme => [theme.code, theme]));
  const residualPairCount = (plan.themeCodes || []).reduce((sum, code) => {
    const count = Number(byCode.get(code)?.occurrenceCount || 0);
    return sum + Math.max(0, count - 1);
  }, 0);
  const achievedReduction = Math.max(0, Number(plan.sourcePairCount || 0) - residualPairCount);
  const requiredReduction = Number(plan.requiredReduction || 0);
  return {
    version: VERSION,
    applicable: true,
    pass: achievedReduction >= requiredReduction,
    sourcePairCount: Number(plan.sourcePairCount || 0),
    residualPairCount,
    requiredReduction,
    achievedReduction,
    coverage: round4(requiredReduction > 0 ? Math.min(1, achievedReduction / requiredReduction) : 1),
    themeCount: Number(plan.themeCount || 0)
  };
}

function analyze(value) {
  const paragraphs = splitLogicalProseParagraphs(value);
  const records = [];
  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    for (const sentence of splitSentences(paragraph)) {
      const text = String(sentence || '').trim();
      if (text.replace(/[\p{P}\p{S}\s]/gu, '').length < 3) continue;
      records.push({ index: records.length, paragraphIndex, text });
    }
  }
  const themes = THEMES.map(theme => {
    const matches = records.filter(record => theme.families.every(family => FAMILY_PATTERNS[family].test(record.text)));
    return {
      code: theme.code,
      occurrenceCount: matches.length,
      paragraphCount: new Set(matches.map(record => record.paragraphIndex)).size,
      sentenceIndices: matches.map(record => record.index)
    };
  });
  return { sentenceCount: records.length, paragraphCount: paragraphs.length, themes };
}

function publicResumeRepetitionPlan(plan) {
  const { targetIndices: _targetIndices, ...safe } = plan || {};
  return safe;
}

function round4(value) {
  const number = Number(value);
  return Math.round((Number.isFinite(number) ? number : 0) * 10000) / 10000;
}

module.exports = {
  VERSION,
  buildResumeRepetitionPlan,
  compareResumeRepetition,
  publicResumeRepetitionPlan
};
