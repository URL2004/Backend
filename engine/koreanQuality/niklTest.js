'use strict';

const { analyzeText } = require('./detector');
const { splitSentences } = require('./styleConsistency');
const { normalizeSentence } = require('./grammarPrecheck');
const officialResources = require('./officialResources');

const VERSION = 'nikl-quality-test-v1';

const NORM_PATTERNS = [
  {
    id: 'dwae_doe_confusion',
    category: 'norm',
    severity: 'S1',
    label: '돼/되 표기 의심',
    re: /(?:되요|안되요|됬|됬다|됬습니다|됬던|됬고)/g,
    advice: '돼/되가 섞인 표기는 문맥에 맞게 점검한다.'
  },
  {
    id: 'few_days_confusion',
    category: 'norm',
    severity: 'S1',
    label: '며칠 표기 의심',
    re: /몇\s*일/g,
    advice: '기간을 뜻하면 보통 "며칠"로 쓰는지 확인한다.'
  },
  {
    id: 'common_spelling_suspect',
    category: 'norm',
    severity: 'S2',
    label: '흔한 맞춤법 의심 표현',
    re: /(?:왠만|어떻해|금새|일일히|역활|희안|오랫만|설겆|뵈요|바램|구지|웬지)/g,
    advice: '일상적으로 틀리기 쉬운 표기는 결과에서 더 늘어나지 않게 한다.'
  },
  {
    id: 'double_particle',
    category: 'grammar',
    severity: 'S1',
    label: '조사 중복 의심',
    // "차이가·깊이가·고양이가"처럼 명사 자체가 '이'로 끝나는 정상 표현을
    // 일반적인 '이가' 중복으로 세지 않는다. 이/가 중복은 보수적인 명사
    // 앵커에서만 잡고, 나머지 비모호 중복 조사는 일반 패턴으로 검사한다.
    re: /(?:[가-힣]+(?:은는|는은|을를|를을|와과|으로로|에게에|에서서|에게게)|(?:학생|사람|사용자|작성자|지원자|참여자|응답자|대상자|연구자|교수|교사|기관|기업|정부|학교|대학|회사|팀|원문|결과|문장|문서|내용|자료|보고서|과제|논문|글|표현|구조|문단|제목|항목|광고|정책|기술|문제|방법|과정|활동|경험|목표|역할|관점|상황|영향|효과|수치|모델|엔진|시스템|서비스|프로그램|제품|브랜드|플랫폼|연구팀)이가)(?=$|[^가-힣A-Za-z0-9_])/g,
    advice: '조사가 겹쳐 붙은 부분은 문장 성분에 맞게 하나만 남긴다.'
  },
  {
    id: 'broken_spacing_particle',
    category: 'grammar',
    severity: 'S2',
    label: '조사 띄어쓰기 의심',
    re: /[가-힣]\s+(?:은|는|이|가|을|를|에|에서|으로|로|와|과|도|만)\s+/g,
    advice: '조사는 앞말에 붙는 것이 자연스러운지 점검한다.'
  },
  {
    id: 'noun_stack_public_language',
    category: 'public_language',
    severity: 'S3',
    label: '명사화/공문서식 표현 밀도',
    re: /(?:관련|추진|운영|실시|확대|제고|강화|도모|확보|진행|제공|수행|활용|구축|개선)(?:을|를|이|가|의|에|로|하고|하며|된다|되었다|하였다|했다)/g,
    advice: '필요한 용어는 유지하되, 문장이 딱딱해지면 동사 중심으로 풀어 쓴다.'
  },
  {
    id: 'foreign_romanization_cluster',
    category: 'term',
    severity: 'S2',
    label: '외래어/영문 표기 후보',
    re: /[A-Za-z][A-Za-z0-9+.#-]*(?:\s+[A-Za-z][A-Za-z0-9+.#-]*){0,3}/g,
    advice: '영문 약어, 제품명, 기관명은 원문 표기를 보존한다.'
  }
];

function analyzeNiklQuality(text, opts = {}) {
  const source = String(text || '');
  const base = analyzeText(source, opts);
  const official = safeOfficialAnalysis(source, opts);
  const normMatches = scanPatterns(source, NORM_PATTERNS);
  const terms = extractTermCandidates(source);
  const sentences = splitSentences(source);
  const publicLanguageHardnessRisk = measurePublicLanguageRisk(source, sentences, normMatches);
  const corpusOutlierRisk = measureCorpusOutlierRisk(source, sentences);
  const normRisk = categoryRisk(normMatches.filter(m => m.category === 'norm' || m.category === 'grammar'), base.charLen, 10);
  const termSurfaceRisk = categoryRisk(normMatches.filter(m => m.category === 'term'), base.charLen, 18);
  const grammarBreakRisk = Math.min(1, (base.grammarRisk || 0) + normRisk * 0.35);
  const copykillerSurrogateRisk = Math.min(1, (base.gptStyleRisk || 0) * 0.58 + (base.styleConsistencyRisk || 0) * 0.22 + (base.translationeseRisk || 0) * 0.20);
  const topPatterns = rankPatterns([
    ...(base.topPatterns || []),
    ...normMatches,
    ...publicLanguagePatterns(publicLanguageHardnessRisk),
    ...corpusPatterns(corpusOutlierRisk),
    ...(official?.topPatterns || [])
  ]).slice(0, opts.maxPatterns || 12);

  return {
    version: VERSION,
    charLen: base.charLen,
    sentenceCount: base.sentenceCount,
    copykillerSurrogateRisk: round3(copykillerSurrogateRisk),
    niklNormViolationRisk: round3(normRisk),
    termSurfaceRisk: round3(termSurfaceRisk),
    translationeseRisk: round3(base.translationeseRisk),
    publicLanguageHardnessRisk: round3(publicLanguageHardnessRisk),
    corpusOutlierRisk: round3(corpusOutlierRisk),
    grammarBreakRisk: round3(grammarBreakRisk),
    baseKoreanSkillRisk: round3(base.koreanSkillRisk),
    terms,
    normPatterns: normMatches,
    topPatterns,
    grade: gradeFor(weightedRisk({
      copykillerSurrogateRisk,
      niklNormViolationRisk: normRisk,
      termDriftRisk: termSurfaceRisk,
      translationeseRisk: base.translationeseRisk,
      publicLanguageHardnessRisk,
      corpusOutlierRisk,
      grammarBreakRisk,
      officialResourceRisk: official?.officialResourceRisk || 0
    })),
    official
  };
}

function evaluateNiklQuality(source, output, opts = {}) {
  const before = opts.beforeAnalysis || analyzeNiklQuality(source, opts);
  const after = opts.afterAnalysis || analyzeNiklQuality(output, opts);
  const termDrift = compareTerms(before.terms || [], output);
  const termDriftRisk = before.terms?.length
    ? Math.min(1, termDrift.missing.length / Math.max(1, before.terms.length))
    : 0;
  const beforeRisk = weightedRisk({
    copykillerSurrogateRisk: before.copykillerSurrogateRisk,
    niklNormViolationRisk: before.niklNormViolationRisk,
    termDriftRisk: before.termSurfaceRisk,
    translationeseRisk: before.translationeseRisk,
    publicLanguageHardnessRisk: before.publicLanguageHardnessRisk,
    corpusOutlierRisk: before.corpusOutlierRisk,
    grammarBreakRisk: before.grammarBreakRisk,
    officialResourceRisk: before.official?.officialResourceRisk || 0
  });
  const afterRisk = weightedRisk({
    copykillerSurrogateRisk: after.copykillerSurrogateRisk,
    niklNormViolationRisk: after.niklNormViolationRisk,
    termDriftRisk,
    translationeseRisk: after.translationeseRisk,
    publicLanguageHardnessRisk: after.publicLanguageHardnessRisk,
    corpusOutlierRisk: after.corpusOutlierRisk,
    grammarBreakRisk: after.grammarBreakRisk,
    officialResourceRisk: after.official?.officialResourceRisk || 0
  });
  const officialGate = safeOfficialGate(source, output, {
    beforeAnalysis: before.official,
    afterAnalysis: after.official
  });
  const riskDelta = round3(afterRisk - beforeRisk);
  const grammarDelta = round3((after.grammarBreakRisk || 0) - (before.grammarBreakRisk || 0));
  const normDelta = round3((after.niklNormViolationRisk || 0) - (before.niklNormViolationRisk || 0));
  const warnings = [];
  const violations = [];
  let action = 'pass';
  let reason = '';

  if (termDrift.missing.length) {
    action = 'repair_candidate';
    reason = 'nikl_quality_term_drift';
    warnings.push(reason);
    violations.push({ gate: reason, missingTerms: termDrift.missing.slice(0, 12) });
  }
  if (grammarDelta >= 0.08 || normDelta >= 0.10) {
    action = 'repair_candidate';
    reason = reason || 'nikl_quality_norm_regression';
    warnings.push(reason);
    violations.push({ gate: reason, grammarDelta, normDelta });
  } else if (riskDelta >= 0.08 && action === 'pass') {
    action = 'repair_candidate';
    reason = 'nikl_quality_risk_regression';
    warnings.push(reason);
  } else if (riskDelta >= 0.03 && action === 'pass') {
    action = 'warn';
    reason = 'nikl_quality_risk_warning';
    warnings.push(reason);
  }
  if (officialGate && officialGate.action && officialGate.action !== 'pass') {
    warnings.push(...(officialGate.warnings || []));
    if (officialGate.action === 'repair_candidate' && action === 'pass') {
      action = 'repair_candidate';
      reason = officialGate.reason || 'official_korean_resource_regression';
    } else if (officialGate.action === 'warn' && action === 'pass') {
      action = 'warn';
      reason = officialGate.reason || 'official_korean_resource_warning';
    }
    violations.push(...(officialGate.violations || []).map(v => ({ ...v, officialResource: true })));
  }

  for (const p of (after.topPatterns || []).slice(0, 5)) {
    warnings.push(`nikl_pattern:${p.id}`);
  }

  return {
    version: VERSION,
    enabled: true,
    action,
    reason,
    blocking: false,
    riskDelta,
    beforeRisk: round3(beforeRisk),
    afterRisk: round3(afterRisk),
    termDriftRisk: round3(termDriftRisk),
    missingTerms: termDrift.missing,
    grammarDelta,
    normDelta,
    source: compactNiklAnalysis(before),
    output: compactNiklAnalysis(after),
    official: officialResources.compactOfficialReport(officialGate),
    topPatterns: after.topPatterns || [],
    warnings: [...new Set(warnings)],
    violations
  };
}

function buildNiklPromptHints(analysis, opts = {}) {
  if (!analysis) return '';
  const max = Math.max(1, Math.min(8, Number(opts.max || 6) || 6));
  const patterns = (analysis.topPatterns || []).slice(0, max);
  if (!patterns.length && !(analysis.terms || []).length) return '';
  const lines = [
    '[국립국어원식 한국어 품질 테스트 힌트]',
    '관리자 테스트 전용 로컬 기준이다. 공식 문구를 복사하거나 모든 표현을 표준어처럼 경직되게 바꾸지 않는다.',
    '맞춤법 의심, 용어 표기, 번역투, 공문서식 명사화가 결과에서 늘어나지 않게 하되 휴머나이징 강도는 유지한다.',
    `테스트 위험도 ${formatRisk(weightedRisk({
      copykillerSurrogateRisk: analysis.copykillerSurrogateRisk,
      niklNormViolationRisk: analysis.niklNormViolationRisk,
      termDriftRisk: analysis.termSurfaceRisk,
      translationeseRisk: analysis.translationeseRisk,
      publicLanguageHardnessRisk: analysis.publicLanguageHardnessRisk,
      corpusOutlierRisk: analysis.corpusOutlierRisk,
      grammarBreakRisk: analysis.grammarBreakRisk,
      officialResourceRisk: analysis.official?.officialResourceRisk || 0
    }))} / 등급 ${analysis.grade || 'A'}`
  ];
  const officialHints = safeOfficialHints(analysis.official);
  if (officialHints) lines.push(officialHints);
  const terms = (analysis.terms || []).slice(0, 10);
  if (terms.length) lines.push(`- 표기 보존 후보: ${terms.join(', ')}`);
  for (const pattern of patterns) {
    const sample = Array.isArray(pattern.samples) && pattern.samples.length
      ? ` 예: ${pattern.samples.slice(0, 2).join(', ')}`
      : '';
    lines.push(`- ${pattern.label}(${pattern.severity || 'S3'}, ${pattern.count || 1}회): ${pattern.advice || '결과에서 더 늘어나지 않게 점검한다.'}${sample}`);
  }
  return lines.join('\n');
}

function compactNiklReport(report) {
  if (!report) return null;
  return {
    version: report.version || VERSION,
    enabled: report.enabled === true,
    action: report.action,
    reason: report.reason || '',
    niklRiskDelta: report.riskDelta,
    beforeRisk: report.beforeRisk,
    afterRisk: report.afterRisk,
    termDriftRisk: report.termDriftRisk,
    missingTerms: (report.missingTerms || []).slice(0, 12),
    grammarDelta: report.grammarDelta,
    normDelta: report.normDelta,
    source: report.source,
    output: report.output,
    official: report.official || null,
    topPatterns: (report.topPatterns || []).slice(0, 8).map(compactPattern)
  };
}

function compactNiklAnalysis(analysis) {
  if (!analysis) return null;
  return {
    copykillerSurrogateRisk: round3(analysis.copykillerSurrogateRisk),
    niklNormViolationRisk: round3(analysis.niklNormViolationRisk),
    translationeseRisk: round3(analysis.translationeseRisk),
    publicLanguageHardnessRisk: round3(analysis.publicLanguageHardnessRisk),
    corpusOutlierRisk: round3(analysis.corpusOutlierRisk),
    grammarBreakRisk: round3(analysis.grammarBreakRisk),
    officialResourceRisk: round3(analysis.official?.officialResourceRisk || 0),
    official: officialResources.compactOfficialAnalysis(analysis.official),
    grade: analysis.grade,
    termCount: (analysis.terms || []).length,
    topPatterns: (analysis.topPatterns || []).slice(0, 6).map(compactPattern)
  };
}

function scanPatterns(text, patterns) {
  const out = [];
  for (const pattern of patterns) {
    const re = cloneRegex(pattern.re);
    let match;
    let count = 0;
    const samples = [];
    while ((match = re.exec(text)) !== null) {
      const value = String(match[0] || '').trim();
      if (value.length) {
        count += 1;
        if (samples.length < 3) samples.push(value);
      }
      if (match[0] === '') re.lastIndex += 1;
    }
    if (!count) continue;
    out.push({
      id: pattern.id,
      category: pattern.category,
      severity: pattern.severity,
      label: pattern.label,
      count,
      samples,
      advice: pattern.advice,
      score: patternScore(pattern, count)
    });
  }
  return out;
}

function extractTermCandidates(text) {
  const source = String(text || '');
  const terms = new Map();
  addMatches(terms, source.match(/[A-Z][A-Za-z0-9+.#-]*(?:\s+[A-Z][A-Za-z0-9+.#-]*){0,3}/g));
  addMatches(terms, source.match(/[A-Za-z][A-Za-z0-9+.#-]*\s*API/g));
  addMatches(terms, source.match(/['"“”‘’『』「」][^'"“”‘’『』「」\n]{2,40}['"“”‘’『』「」]/g), cleanQuotedTerm);
  addMatches(terms, source.match(/[가-힣A-Za-z0-9]+(?:·[가-힣A-Za-z0-9]+){1,5}/g));
  return [...terms.values()]
    .filter(t => t.length >= 2 && t.length <= 60)
    .filter(t => !/^[A-Z]$/.test(t))
    .slice(0, 40);
}

function addMatches(map, matches, normalize = normalizeTerm) {
  for (const raw of matches || []) {
    const term = normalize(raw);
    if (!term) continue;
    const key = term.toLowerCase().replace(/\s+/g, ' ');
    if (!map.has(key)) map.set(key, term);
  }
}

function cleanQuotedTerm(raw) {
  return normalizeTerm(String(raw || '').replace(/^['"“”‘’『』「」]+|['"“”‘’『』「」]+$/g, ''));
}

function normalizeTerm(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

function compareTerms(terms, output) {
  const out = String(output || '');
  const compactOut = normalizeSentence(out);
  const missing = [];
  for (const term of terms || []) {
    const normalized = normalizeTerm(term);
    if (!normalized) continue;
    if (out.includes(normalized)) continue;
    if (normalizeSentence(normalized).length >= 3 && compactOut.includes(normalizeSentence(normalized))) continue;
    missing.push(normalized);
  }
  return { missing: [...new Set(missing)] };
}

function measurePublicLanguageRisk(text, sentences, matches) {
  const chars = String(text || '').replace(/\s+/g, '').length;
  if (!chars) return 0;
  const nominal = countRe(text, /(?:화|성|적|화된|성을|적인|적으로|관련|대상|경우|부분|방향|측면)/g);
  const passive = countRe(text, /(?:되었다|되고|된다|되어|하였다|함으로써|통하여|관련하여)/g);
  const longSentences = (sentences || []).filter(s => s.replace(/\s+/g, '').length >= 90).length;
  const publicPatternScore = (matches || []).filter(m => m.category === 'public_language').reduce((n, m) => n + (m.count || 0), 0);
  return round3(Math.min(1, (nominal * 0.35 + passive * 0.55 + longSentences * 1.4 + publicPatternScore) / Math.max(12, chars / 110)));
}

function measureCorpusOutlierRisk(text, sentences) {
  const list = sentences || [];
  if (list.length < 4) return 0;
  const lengths = list.map(s => s.replace(/\s+/g, '').length).filter(Boolean);
  const avg = lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length);
  const variance = lengths.reduce((n, len) => n + Math.pow(len - avg, 2), 0) / Math.max(1, lengths.length);
  const cv = avg ? Math.sqrt(variance) / avg : 0;
  const tooUniform = cv < 0.18 ? (0.18 - cv) * 2.5 : 0;
  const tooLong = lengths.filter(n => n >= 110).length / Math.max(1, lengths.length);
  const tooShortRun = measureShortSentenceRun(list);
  const paragraphs = String(text || '').split(/\n[ \t]*\n+/).map(p => p.trim()).filter(Boolean);
  const paragraphOutlier = paragraphs.length <= 1 && String(text || '').length >= 900 ? 0.25 : 0;
  return round3(Math.min(1, tooUniform + tooLong * 0.55 + tooShortRun * 0.12 + paragraphOutlier));
}

function measureShortSentenceRun(sentences) {
  let run = 0;
  let max = 0;
  for (const sentence of sentences || []) {
    const len = sentence.replace(/\s+/g, '').length;
    if (len > 0 && len <= 18) {
      run += 1;
      max = Math.max(max, run);
    } else {
      run = 0;
    }
  }
  return max >= 4 ? Math.min(3, max - 3) : 0;
}

function publicLanguagePatterns(risk) {
  if (risk < 0.28) return [];
  return [{
    id: 'public_language_hardness',
    category: 'public_language',
    severity: risk >= 0.55 ? 'S2' : 'S3',
    label: '공문서식 딱딱함 증가 위험',
    count: Math.max(1, Math.round(risk * 10)),
    samples: [],
    advice: '장르가 보고서가 아니면 명사화와 수동 표현을 줄이고 동사 중심으로 풀어 쓴다.',
    score: risk * 4
  }];
}

function corpusPatterns(risk) {
  if (risk < 0.25) return [];
  return [{
    id: 'corpus_outlier_rhythm',
    category: 'corpus',
    severity: risk >= 0.50 ? 'S2' : 'S3',
    label: '장르 평균에서 벗어난 문장 리듬',
    count: Math.max(1, Math.round(risk * 10)),
    samples: [],
    advice: '문장 길이와 문단 단위를 균일하게 만들지 말고 원문 흐름에 맞춘다.',
    score: risk * 4
  }];
}

function weightedRisk(v) {
  return round3(
    (Number(v.copykillerSurrogateRisk) || 0) * 0.25 +
    (Number(v.niklNormViolationRisk) || 0) * 0.15 +
    (Number(v.termDriftRisk) || 0) * 0.15 +
    (Number(v.translationeseRisk) || 0) * 0.15 +
    (Number(v.publicLanguageHardnessRisk) || 0) * 0.10 +
    (Number(v.corpusOutlierRisk) || 0) * 0.10 +
    (Number(v.grammarBreakRisk) || 0) * 0.08 +
    (Number(v.officialResourceRisk) || 0) * 0.02
  );
}

function rankPatterns(matches) {
  return [...(matches || [])]
    .filter(m => (m.count || 0) > 0)
    .sort((a, b) => (b.score || 0) - (a.score || 0) || (b.count || 0) - (a.count || 0));
}

function categoryRisk(matches, chars, denominator) {
  if (!matches.length || chars <= 0) return 0;
  const densityFactor = Math.min(1.35, Math.max(0.75, 900 / Math.max(450, chars)));
  const sum = matches.reduce((acc, m) => acc + (m.score || patternScore(m, m.count || 0)), 0);
  return round3(Math.min(1, (sum * densityFactor) / denominator));
}

function patternScore(pattern, count) {
  const weight = pattern.severity === 'S1' ? 3 : pattern.severity === 'S2' ? 1.8 : 0.8;
  return round3(weight * Math.log1p(Math.max(0, count)));
}

function compactPattern(pattern) {
  return {
    id: pattern.id,
    label: pattern.label,
    category: pattern.category,
    severity: pattern.severity,
    count: pattern.count
  };
}

function cloneRegex(re) {
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  return new RegExp(re.source, flags);
}

function countRe(text, re) {
  const m = String(text || '').match(re);
  return m ? m.length : 0;
}

function gradeFor(risk) {
  if (risk < 0.16) return 'A';
  if (risk < 0.33) return 'B';
  if (risk < 0.55) return 'C';
  return 'D';
}

function formatRisk(v) {
  return Number.isFinite(Number(v)) ? Number(v).toFixed(3) : '0.000';
}

function round3(v) {
  return Number(Number(v || 0).toFixed(3));
}

function safeOfficialAnalysis(text, opts = {}) {
  try { return officialResources.analyzeOfficialQuality(text, opts); } catch { return null; }
}

function safeOfficialGate(source, output, opts = {}) {
  try { return officialResources.evaluateOfficialQuality(source, output, opts); } catch { return null; }
}

function safeOfficialHints(analysis) {
  try { return officialResources.buildOfficialPromptHints(analysis, { maxTerms: 4, maxPatterns: 4 }); } catch { return ''; }
}

module.exports = {
  VERSION,
  analyzeNiklQuality,
  evaluateNiklQuality,
  buildNiklPromptHints,
  compactNiklAnalysis,
  compactNiklReport
};
