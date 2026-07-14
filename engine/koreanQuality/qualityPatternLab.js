'use strict';

const { analyzeText, splitSentences } = require('./detector');
const { compareStyle } = require('./styleConsistency');
const { compactForLog } = require('./promptBlock');

const VERSION = 'ko-quality-pattern-lab-v1';
const PROMPT_HINT_MAX = 8;

const CLAIM_STRENGTH_PATTERNS = [
  /반드시/g,
  /확실(?:히|한|하다|합니다)/g,
  /명백(?:히|한|하다|합니다)/g,
  /절대(?:로)?/g,
  /무조건/g,
  /가장\s*중요/g,
  /핵심(?:적)?/g,
  /입증(?:한다|됩니다|되었다|됐다)/g,
  /보장(?:한다|합니다|된다|됩니다)/g
];

const RHETORICAL_PATTERNS = [
  /비로소/g,
  /한층/g,
  /자리매김/g,
  /떠받치/g,
  /조용히\s*쌓/g,
  /청결감[^.?!\n]{0,24}(?:흐려|버티)/g,
  /오래\s*버티/g,
  /집중적으로\s*잡/g,
  /무너지는\s*것은/g,
  /방향을\s*가리킨다/g,
  /판을\s*깔아준다/g,
  /가지를\s*뻗어/g,
  /눈길을\s*끌/g,
  /고스란히/g,
  /빛을\s*발/g
];

function buildQualityProfile(text, opts = {}) {
  const source = String(text || '');
  const analysis = safeAnalyze(source, opts);
  const paragraphs = splitParagraphs(source);
  const sentences = splitSentences(source);
  const punctuation = measurePunctuation(source);
  const risks = {
    translationese: round3(analysis?.translationeseRisk),
    nominalization: round3(measureNominalization(source)),
    mechanicalStructure: round3(measureMechanicalStructure(analysis, paragraphs, sentences)),
    sentenceRhythm: round3(analysis?.style?.rhythm?.uniformRisk || 0),
    registerTense: round3(analysis?.styleConsistencyRisk),
    columnRhetoric: round3(measureRhetoricRisk(source)),
    punctuation: round3(punctuation.risk),
    meaningTermPreservation: round3(measureTermDensity(source))
  };
  risks.overall = round3(Math.min(1, Math.max(
    analysis?.koreanSkillRisk || 0,
    risks.translationese * 0.22 +
      risks.nominalization * 0.15 +
      risks.mechanicalStructure * 0.18 +
      risks.sentenceRhythm * 0.10 +
      risks.registerTense * 0.15 +
      risks.columnRhetoric * 0.14 +
      risks.punctuation * 0.06
  )));
  const profile = {
    version: VERSION,
    charLen: analysis?.charLen || source.replace(/\s+/g, '').length,
    paragraphCount: paragraphs.length,
    sentenceCount: sentences.length,
    risks,
    style: {
      dominantRegister: analysis?.style?.dominantRegister || 'unknown',
      dominantRatio: round3(analysis?.style?.dominantRatio),
      registerMixRisk: round3(analysis?.style?.registerMixRisk),
      firstPersonCount: analysis?.style?.firstPersonCount || 0,
      thirdPersonCueCount: analysis?.style?.thirdPersonCueCount || 0,
      oneSentenceParagraphs: analysis?.style?.oneSentenceParagraphs || 0,
      paragraphFragmentRisk: round3(analysis?.style?.paragraphFragmentRisk),
      rhythm: analysis?.style?.rhythm || null
    },
    punctuation,
    topIssues: rankTopIssues(analysis, source).slice(0, opts.maxIssues || 12),
    compact: analysis ? compactForLog(analysis, opts.maxIssues || 8) : null
  };
  return profile;
}

function buildPromptHints(profile, opts = {}) {
  const max = Math.max(1, Math.min(12, Number(opts.max || PROMPT_HINT_MAX) || PROMPT_HINT_MAX));
  const issues = (profile?.topIssues || []).slice(0, max);
  if (!issues.length) return '';
  const lines = [
    '[한국어 품질 패턴 엔진 v1]',
    '목표는 한국어 AI 문체 패턴을 줄이면서 원문 의미, 장르, 화자, 용어를 보존하는 것이다.',
    '전체 룰을 새로 적용하지 말고, 아래 감지 이슈에 해당하는 부분만 결과에서 완화한다.',
    '일반 문장은 재서술하되, 제목/번호/수치/고유명사/참고문헌/전문용어는 임의로 바꾸지 않는다.',
    `입력 품질 위험도 ${formatRisk(profile?.risks?.overall)} / 주요 패턴 ${issues.length}개`
  ];
  for (const issue of issues) {
    const sample = Array.isArray(issue.samples) && issue.samples.length
      ? ` 예: ${issue.samples.slice(0, 2).join(', ')}`
      : '';
    lines.push(`- ${issue.label}(${issue.category}, ${issue.count || 1}회): ${issue.advice || '결과에서 늘어나지 않게 점검한다.'}${sample}`);
  }
  return lines.join('\n');
}

function buildAudit(source, output, opts = {}) {
  const before = opts.beforeProfile || buildQualityProfile(source, opts);
  const after = opts.afterProfile || buildQualityProfile(output, opts);
  const patternDelta = buildPatternDelta(before, after);
  const protectedTermReport = buildProtectedTermReport(source, output, opts.protectedTerms);
  const claimStrengthDrift = measureClaimStrengthDrift(source, output);
  const rhetoricalInsertion = measureRhetoricalInsertion(source, output, before, after);
  const grammarHardError = buildGrammarHardError(before, after);
  const styleDrift = compareStyle(before?.compact?.style || before?.style, after?.compact?.style || after?.style);
  const structure = compareStructure(source, output);
  const warnings = [];
  const blockers = [];

  if (protectedTermReport.lossCount > 0) warnings.push('protected_term_loss');
  if ((patternDelta.riskDelta || 0) >= 0.03) warnings.push('korean_ai_pattern_regression');
  if (grammarHardError.introduced) warnings.push('grammar_hard_error');
  if (styleDrift?.povIntroduced || styleDrift?.firstPersonDropped) warnings.push('speaker_drift');
  if (styleDrift?.registerShiftSevere) warnings.push('register_shift');
  if (claimStrengthDrift.delta >= 2) warnings.push('claim_strength_increase');
  if (rhetoricalInsertion.insertedCount > 0) warnings.push('rhetorical_insertion');
  if (structure.paragraphDelta <= -2) warnings.push('paragraph_collapse');
  if (!String(output || '').trim()) blockers.push('empty_output');
  if (looksLikePromptLeak(output)) blockers.push('prompt_instruction_leak');
  if (looksEncodingCorrupted(source, output)) blockers.push('encoding_corruption');
  if (looksTruncated(output)) blockers.push('sentence_truncated');

  const action = blockers.length
    ? 'blocked'
    : warnings.length
      ? 'needs_review'
      : 'pass';
  return {
    version: VERSION,
    qualityProfileBefore: before,
    qualityProfileAfter: after,
    patternDelta,
    protectedTermReport,
    claimStrengthDrift,
    rhetoricalInsertion,
    grammarHardError,
    auditTrail: {
      action,
      warnings: [...new Set(warnings)],
      blockers,
      structure,
      styleDrift,
      externalApiHintsUsed: opts.externalApiHintsUsed === true,
      notes: buildAuditNotes({ patternDelta, protectedTermReport, claimStrengthDrift, rhetoricalInsertion, grammarHardError, structure })
    }
  };
}

function buildPatternDelta(before, after) {
  const beforeMap = patternMap(before?.topIssues);
  const afterMap = patternMap(after?.topIssues);
  const ids = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const increased = [];
  const reduced = [];
  const unchanged = [];
  for (const id of ids) {
    const b = beforeMap.get(id) || { count: 0, score: 0, id };
    const a = afterMap.get(id) || { count: 0, score: 0, id };
    const item = {
      id,
      label: a.label || b.label || id,
      category: a.category || b.category || '',
      beforeCount: b.count || 0,
      afterCount: a.count || 0,
      delta: (a.count || 0) - (b.count || 0)
    };
    if (item.delta > 0) increased.push(item);
    else if (item.delta < 0) reduced.push(item);
    else unchanged.push(item);
  }
  const riskDelta = round3((after?.risks?.overall || 0) - (before?.risks?.overall || 0));
  return {
    beforeRisk: round3(before?.risks?.overall),
    afterRisk: round3(after?.risks?.overall),
    riskDelta,
    byCategory: {
      translationese: deltaRisk(before, after, 'translationese'),
      nominalization: deltaRisk(before, after, 'nominalization'),
      mechanicalStructure: deltaRisk(before, after, 'mechanicalStructure'),
      sentenceRhythm: deltaRisk(before, after, 'sentenceRhythm'),
      registerTense: deltaRisk(before, after, 'registerTense'),
      columnRhetoric: deltaRisk(before, after, 'columnRhetoric'),
      punctuation: deltaRisk(before, after, 'punctuation'),
      meaningTermPreservation: deltaRisk(before, after, 'meaningTermPreservation')
    },
    reducedPatterns: reduced.sort((a, b) => a.delta - b.delta).slice(0, 12),
    increasedPatterns: increased.sort((a, b) => b.delta - a.delta).slice(0, 12),
    unchangedTop: unchanged.slice(0, 8),
    reducedCount: reduced.length,
    increasedCount: increased.length
  };
}

function buildProtectedTermReport(source, output, protectedTerms = []) {
  const terms = unique([
    ...(Array.isArray(protectedTerms) ? protectedTerms : []),
    ...extractTermCandidates(source)
  ]).slice(0, 120);
  const out = String(output || '');
  const compactOut = compactSurface(out);
  const lost = [];
  const kept = [];
  for (const term of terms) {
    const t = String(term || '').trim();
    if (!t) continue;
    const compact = compactSurface(t);
    if (out.includes(t) || (compact.length >= 3 && compactOut.includes(compact))) kept.push(t);
    else lost.push(t);
  }
  return {
    termCount: terms.length,
    keptCount: kept.length,
    lossCount: lost.length,
    lost: lost.slice(0, 20),
    keptSample: kept.slice(0, 20)
  };
}

function compactAudit(audit) {
  if (!audit) return null;
  return {
    version: audit.version || VERSION,
    qualityProfileBefore: compactQualityProfile(audit.qualityProfileBefore),
    qualityProfileAfter: compactQualityProfile(audit.qualityProfileAfter),
    patternDelta: audit.patternDelta,
    protectedTermReport: audit.protectedTermReport,
    claimStrengthDrift: audit.claimStrengthDrift,
    rhetoricalInsertion: audit.rhetoricalInsertion,
    grammarHardError: audit.grammarHardError,
    auditTrail: audit.auditTrail
  };
}

function compactQualityProfile(profile) {
  if (!profile) return null;
  return {
    version: profile.version || VERSION,
    charLen: profile.charLen,
    paragraphCount: profile.paragraphCount,
    sentenceCount: profile.sentenceCount,
    risks: profile.risks,
    style: profile.style,
    punctuation: profile.punctuation,
    topIssues: (profile.topIssues || []).slice(0, 8).map(compactIssue)
  };
}

function rankTopIssues(analysis, source) {
  const base = Array.isArray(analysis?.topPatterns) ? analysis.topPatterns : [];
  const extras = [];
  const nominal = measureNominalization(source);
  if (nominal >= 0.16) extras.push({
    id: 'nominalization_density',
    label: '명사화/공문서식 표현 밀도',
    category: 'nominalization',
    severity: 'S2',
    count: Math.ceil(nominal * 10),
    samples: sampleMatches(source, /(?:관련|추진|운영|실시|확대|제고|강화|도모|확보|진행|제공|수행|활용|구축|개선)/g),
    advice: '필요한 용어는 유지하되 동사 중심 문장으로 일부 풀어 쓴다.',
    score: nominal * 8
  });
  const punct = measurePunctuation(source);
  if (punct.risk >= 0.12) extras.push({
    id: 'punctuation_pattern',
    label: '문장부호 패턴 과밀',
    category: 'punctuation',
    severity: 'S3',
    count: punct.total,
    samples: [],
    advice: '쉼표와 괄호를 억지로 늘리지 말고 문장 단위로 정리한다.',
    score: punct.risk * 6
  });
  const rhetoric = measureRhetoricRisk(source);
  if (rhetoric >= 0.08) extras.push({
    id: 'lab_rhetorical_polish',
    label: '문학적/칼럼식 표현 후보',
    category: 'rhetoric',
    severity: 'S2',
    count: Math.max(1, sampleMatches(source, unionRegex(RHETORICAL_PATTERNS)).length),
    samples: sampleMatches(source, unionRegex(RHETORICAL_PATTERNS)),
    advice: '장르에 맞게 담백한 설명문으로 낮추고 원문 사실 역할을 유지한다.',
    score: rhetoric * 9
  });
  return [...base, ...extras]
    .filter(Boolean)
    .sort((a, b) => (b.score || 0) - (a.score || 0) || (b.count || 0) - (a.count || 0))
    .map(compactIssue);
}

function compactIssue(issue) {
  return {
    id: issue.id,
    label: issue.label,
    category: issue.category,
    severity: issue.severity || 'S3',
    count: issue.count || 0,
    samples: (issue.samples || []).slice(0, 3),
    advice: issue.advice || '',
    score: round3(issue.score)
  };
}

function measureNominalization(text) {
  const chars = compactSurface(text).length;
  if (!chars) return 0;
  const count = countRe(text, /(?:관련|추진|운영|실시|확대|제고|강화|도모|확보|진행|제공|수행|활용|구축|개선|기반|중심|방향|측면|부분|경우|대상|과정|결과|효과|전략|체계)/g);
  return round3(Math.min(1, count / Math.max(12, chars / 90)));
}

function measureMechanicalStructure(analysis, paragraphs, sentences) {
  const fragment = analysis?.style?.paragraphFragmentRisk || 0;
  const uniform = analysis?.style?.rhythm?.uniformRisk || 0;
  const oneSentenceRun = paragraphs.length >= 4
    ? paragraphs.filter(p => splitSentences(p).length <= 1 && compactSurface(p).length >= 20).length / Math.max(1, paragraphs.length)
    : 0;
  const longSentenceRatio = sentences.length
    ? sentences.filter(s => compactSurface(s).length >= 120).length / sentences.length
    : 0;
  return Math.min(1, fragment * 0.35 + uniform * 1.1 + oneSentenceRun * 0.35 + longSentenceRatio * 0.25);
}

function measureRhetoricRisk(text) {
  const chars = compactSurface(text).length;
  if (!chars) return 0;
  const count = RHETORICAL_PATTERNS.reduce((n, re) => n + countRe(text, re), 0);
  return round3(Math.min(1, count / Math.max(3, chars / 450)));
}

function measureTermDensity(text) {
  const chars = compactSurface(text).length;
  if (!chars) return 0;
  const terms = extractTermCandidates(text);
  return round3(Math.min(1, terms.length / Math.max(12, chars / 130)));
}

function measurePunctuation(text) {
  const s = String(text || '');
  const sentenceCount = Math.max(1, splitSentences(s).length);
  const comma = countRe(s, /,/g);
  const paren = countRe(s, /[()（）]/g);
  const quote = countRe(s, /["'“”‘’『』「」]/g);
  const semicolon = countRe(s, /[;:]/g);
  const total = comma + paren + quote + semicolon;
  return {
    comma,
    paren,
    quote,
    semicolon,
    total,
    perSentence: round3(total / sentenceCount),
    risk: round3(Math.min(1, Math.max(0, total / Math.max(18, sentenceCount * 3) - 0.25)))
  };
}

function measureClaimStrengthDrift(source, output) {
  const before = CLAIM_STRENGTH_PATTERNS.reduce((n, re) => n + countRe(source, re), 0);
  const after = CLAIM_STRENGTH_PATTERNS.reduce((n, re) => n + countRe(output, re), 0);
  return {
    before,
    after,
    delta: after - before,
    increased: after > before
  };
}

function measureRhetoricalInsertion(source, output, before, after) {
  const beforeCount = RHETORICAL_PATTERNS.reduce((n, re) => n + countRe(source, re), 0);
  const afterCount = RHETORICAL_PATTERNS.reduce((n, re) => n + countRe(output, re), 0);
  const afterIssue = (after?.topIssues || []).find(p => p.id === 'rhetorical_polish');
  const beforeIssue = (before?.topIssues || []).find(p => p.id === 'rhetorical_polish');
  return {
    before: beforeCount,
    after: afterCount,
    insertedCount: Math.max(0, afterCount - beforeCount),
    patternDelta: Math.max(0, (afterIssue?.count || 0) - (beforeIssue?.count || 0)),
    samples: sampleMatches(output, unionRegex(RHETORICAL_PATTERNS)).slice(0, 8)
  };
}

function buildGrammarHardError(before, after) {
  const beforeCount = before?.compact?.hardGrammarCount || before?.hardGrammarCount || 0;
  const afterCount = after?.compact?.hardGrammarCount || after?.hardGrammarCount || 0;
  const afterHard = (after?.topIssues || []).filter(p => p.category === 'grammar' && p.severity === 'S1');
  return {
    before: beforeCount,
    after: afterCount,
    delta: afterCount - beforeCount,
    introduced: afterCount > beforeCount,
    top: afterHard.slice(0, 8)
  };
}

function compareStructure(source, output) {
  const sourceParagraphs = splitParagraphs(source);
  const outputParagraphs = splitParagraphs(output);
  const sourceSentences = splitSentences(source);
  const outputSentences = splitSentences(output);
  return {
    sourceParagraphs: sourceParagraphs.length,
    outputParagraphs: outputParagraphs.length,
    paragraphDelta: outputParagraphs.length - sourceParagraphs.length,
    sourceSentences: sourceSentences.length,
    outputSentences: outputSentences.length,
    sentenceDelta: outputSentences.length - sourceSentences.length,
    lengthDelta: String(output || '').length - String(source || '').length
  };
}

function buildAuditNotes({ patternDelta, protectedTermReport, claimStrengthDrift, rhetoricalInsertion, grammarHardError, structure }) {
  const notes = [];
  if ((patternDelta?.riskDelta || 0) < 0) notes.push('한국어 품질 패턴 위험도가 감소했습니다.');
  if ((patternDelta?.riskDelta || 0) > 0) notes.push('한국어 품질 패턴 위험도가 증가했습니다.');
  if (protectedTermReport?.lossCount > 0) notes.push(`보호표현 손실 후보 ${protectedTermReport.lossCount}개가 있습니다.`);
  if (claimStrengthDrift?.delta > 0) notes.push('단정/강조 표현이 원문보다 늘었습니다.');
  if (rhetoricalInsertion?.insertedCount > 0) notes.push('칼럼식 또는 수사적 표현이 새로 늘었습니다.');
  if (grammarHardError?.introduced) notes.push('문법 hard error 후보가 새로 생겼습니다.');
  if (structure?.paragraphDelta <= -2) notes.push('문단 수가 크게 줄어 답답해질 수 있습니다.');
  if (!notes.length) notes.push('차단 이슈 없이 비교 가능한 결과입니다.');
  return notes;
}

function patternMap(patterns = []) {
  const map = new Map();
  for (const p of patterns || []) {
    if (!p?.id) continue;
    map.set(p.id, p);
  }
  return map;
}

function deltaRisk(before, after, key) {
  return {
    before: round3(before?.risks?.[key]),
    after: round3(after?.risks?.[key]),
    delta: round3((after?.risks?.[key] || 0) - (before?.risks?.[key] || 0))
  };
}

function extractTermCandidates(text) {
  const s = String(text || '');
  const terms = [];
  addMatches(terms, s.match(/\bhttps?:\/\/[^\s)]+/g));
  addMatches(terms, s.match(/\b\d{2,4}[.-]\d{1,2}[.-]\d{1,2}\b/g));
  addMatches(terms, s.match(/(?<![A-Za-z0-9_])\d+(?:\.\d+)?\s?(?:%|원|만원|억원|조원|평|명|개|건|회|년|개월|일|시간|분|km|kg|g|cm|m)(?=$|[^가-힣A-Za-z0-9_])/g));
  addMatches(terms, s.match(/[A-Z][A-Za-z0-9&.-]{1,}(?:\s+[A-Z][A-Za-z0-9&.-]{1,}){0,3}/g));
  addMatches(terms, s.match(/[가-힣A-Za-z0-9]+(?:대학교|대학원|연구소|학회|기관|공사|공단|주식회사|택배|병원|유치원|어린이집|교육부|보건복지부|AWS|API)/g));
  addMatches(terms, s.match(/[가-힣A-Za-z0-9]{2,}(?:·[가-힣A-Za-z0-9]{2,}){1,}/g));
  addMatches(terms, s.match(/[가-힣A-Za-z0-9·-]{2,}(?:시스템|기술|설비|기능|인프라|포털|터미널|플랫폼|데이터|API|AI|AWS)/g));
  addMatches(terms, s.match(/[가-힣A-Za-z0-9][가-힣A-Za-z0-9·\s-]{1,40}\([A-Za-z가-힣0-9][^)）]{1,40}\)/g), normalizeParentheticalTerm);
  addMatches(terms, s.match(/['"“”‘’『』「」][^'"“”‘’『』「」\n]{2,40}['"“”‘’『』「」]/g), v => String(v || '').replace(/^['"“”‘’『』「」]+|['"“”‘’『』「」]+$/g, ''));
  return unique(terms).filter(isTermCandidateSafe).slice(0, 120);
}

function addMatches(out, matches, normalize = normalizeTerm) {
  for (const raw of matches || []) {
    const v = normalize(raw);
    if (v) out.push(v);
  }
}

function normalizeTerm(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

function normalizeParentheticalTerm(raw) {
  const v = normalizeTerm(raw);
  const m = v.match(/^(.+?)\(([^)）]{1,60})\)$/);
  if (!m) return v;
  const inside = normalizeTerm(m[2]);
  const before = trimParenTermPrefix(m[1]);
  if (inside && /[A-Za-z0-9]/.test(inside)) return inside;
  return before ? `${before}(${inside})` : inside;
}

function trimParenTermPrefix(value) {
  const words = normalizeTerm(value).split(' ').filter(Boolean);
  let picked = words.slice(-4);
  while (picked.length > 1 && /(?:은|는|이|가|을|를|에서|으로|로|와|과|의|에)$/.test(picked[0])) {
    picked = picked.slice(1);
  }
  return picked.join(' ');
}

function isTermCandidateSafe(value) {
  const v = normalizeTerm(value);
  if (v.length < 2 || v.length > 80) return false;
  if (/[.!?。！？\r\n]/.test(v)) return false;
  const words = v.split(' ').filter(Boolean);
  if (words.length > 6) return false;
  if (v.length > 42 && /(?:은|는|이|가|을|를|에서|으로|로|와|과|의|에)(?=$|[^가-힣A-Za-z0-9_])/.test(v)) return false;
  if (v.length > 55 && !/[A-Z0-9%]/.test(v)) return false;
  return true;
}

function splitParagraphs(text) {
  return String(text || '').split(/\n[ \t]*\n+/).map(p => p.trim()).filter(Boolean);
}

function safeAnalyze(text, opts) {
  try { return analyzeText(text, opts); } catch { return null; }
}

function countRe(text, re) {
  const m = String(text || '').match(re);
  return m ? m.length : 0;
}

function sampleMatches(text, re) {
  const out = [];
  const source = String(text || '');
  if (!re) return out;
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let match;
  while ((match = rx.exec(source)) !== null) {
    const v = String(match[0] || '').trim();
    if (v) out.push(v);
    if (out.length >= 5) break;
    if (match[0] === '') rx.lastIndex += 1;
  }
  return out;
}

function unionRegex(patterns) {
  return new RegExp(patterns.map(re => `(?:${re.source})`).join('|'), 'g');
}

function unique(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const v = String(value || '').replace(/\s+/g, ' ').trim();
    const key = v.toLowerCase();
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function compactSurface(text) {
  return String(text || '').replace(/\s+/g, '');
}

function round3(v) {
  return Number(Number(v || 0).toFixed(3));
}

function formatRisk(v) {
  return Number.isFinite(Number(v)) ? Number(v).toFixed(3) : '0.000';
}

function looksLikePromptLeak(text) {
  return /(재작성할\s*텍스트|작업\s*위치|본문이다\.\s*이\s*청크만\s*다듬는다|앞\s*문맥\s*-\s*참고만|뒤\s*문맥\s*-\s*참고만)/.test(String(text || ''));
}

function looksEncodingCorrupted(original, outputText) {
  const src = String(original || '');
  const out = String(outputText || '');
  if (!/[가-힣]/.test(src)) return false;
  const q = (out.match(/\?/g) || []).length;
  if (q >= 8 && q / Math.max(1, out.length) >= 0.08) return true;
  return /\?{2,}.*\?{2,}.*\?{2,}/.test(out);
}

function looksTruncated(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  if (/[,:;，、]$/.test(s)) return true;
  return /(?:그리고|그러나|하지만|또한|따라서|때문에|위해|통해|하며|하고)$/.test(s);
}

module.exports = {
  VERSION,
  buildQualityProfile,
  buildPromptHints,
  buildAudit,
  buildPatternDelta,
  buildProtectedTermReport,
  compactAudit,
  compactQualityProfile
};
