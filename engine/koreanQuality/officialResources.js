'use strict';

const fs = require('fs');
const path = require('path');
const { splitSentences } = require('./styleConsistency');

const RESOURCE_DIR = path.join(__dirname, 'resources');
const VERSION = 'nikl-official-resources-v1';

let cache = null;

function loadOfficialResources() {
  if (cache) return cache;
  cache = {
    publicLanguage: readJson('publicLanguageTerms.json', { terms: [] }),
    normRegulations: readJson('normRegulations.json', { codes: [], rules: [] }),
    corpusStats: readJson('corpusStats.json', { rows: [], aggregate: {} }),
    sources: readJson('sources.json', { datasets: {} })
  };
  cache.available = {
    publicLanguage: Array.isArray(cache.publicLanguage.terms) && cache.publicLanguage.terms.length > 0,
    normRegulations: Array.isArray(cache.normRegulations.rules) && cache.normRegulations.rules.length > 0,
    corpusStats: Array.isArray(cache.corpusStats.rows) && cache.corpusStats.rows.length > 0
  };
  return cache;
}

function analyzeOfficialQuality(text, opts = {}) {
  const source = String(text || '');
  const resources = loadOfficialResources();
  const publicMatches = scanPublicLanguage(source, resources.publicLanguage.terms || [], opts);
  const normSignals = analyzeNormSurface(source, resources.normRegulations);
  const corpusSignals = analyzeCorpusSurface(source, resources.corpusStats);
  const publicLanguageRisk = riskFromCount(publicMatches.length, source.length, 10);
  const normReferenceRisk = normSignals.risk;
  const corpusReferenceRisk = corpusSignals.risk;
  const officialResourceRisk = round3(
    publicLanguageRisk * 0.46 +
    normReferenceRisk * 0.20 +
    corpusReferenceRisk * 0.34
  );

  return {
    version: VERSION,
    enabled: true,
    resourceStatus: resources.available,
    publicLanguageRisk,
    normReferenceRisk,
    corpusReferenceRisk,
    officialResourceRisk,
    publicLanguageMatches: publicMatches,
    normSignals,
    corpusSignals,
    topPatterns: rankPatterns([
      ...publicMatchesToPatterns(publicMatches),
      ...normSignals.patterns,
      ...corpusSignals.patterns
    ]).slice(0, opts.maxPatterns || 10)
  };
}

function evaluateOfficialQuality(source, output, opts = {}) {
  const before = opts.beforeAnalysis || analyzeOfficialQuality(source, opts);
  const after = opts.afterAnalysis || analyzeOfficialQuality(output, opts);
  const beforeTerms = new Set((before.publicLanguageMatches || []).map(m => m.term));
  const afterTerms = new Set((after.publicLanguageMatches || []).map(m => m.term));
  const addedPublicTerms = [...afterTerms].filter(term => !beforeTerms.has(term));
  const removedPublicTerms = [...beforeTerms].filter(term => !afterTerms.has(term));
  const riskDelta = round3((after.officialResourceRisk || 0) - (before.officialResourceRisk || 0));
  let action = 'pass';
  let reason = '';
  const warnings = [];
  const violations = [];

  if (addedPublicTerms.length >= 3 || riskDelta >= 0.08) {
    action = 'repair_candidate';
    reason = 'official_korean_resource_regression';
    warnings.push(reason);
    violations.push({ gate: reason, addedPublicTerms: addedPublicTerms.slice(0, 12), riskDelta });
  } else if (addedPublicTerms.length || riskDelta >= 0.03) {
    action = 'warn';
    reason = 'official_korean_resource_warning';
    warnings.push(reason);
  }

  return {
    version: VERSION,
    enabled: true,
    action,
    reason,
    blocking: false,
    riskDelta,
    beforeRisk: before.officialResourceRisk,
    afterRisk: after.officialResourceRisk,
    addedPublicTerms,
    removedPublicTerms,
    source: compactOfficialAnalysis(before),
    output: compactOfficialAnalysis(after),
    topPatterns: after.topPatterns || [],
    warnings: [...new Set(warnings)],
    violations
  };
}

function buildOfficialPromptHints(analysis, opts = {}) {
  if (!analysis) return '';
  const maxTerms = Math.max(1, Math.min(6, Number(opts.maxTerms || 4) || 4));
  const matches = (analysis.publicLanguageMatches || []).slice(0, maxTerms);
  const patterns = (analysis.topPatterns || []).slice(0, Math.max(1, Math.min(6, Number(opts.maxPatterns || 4) || 4)));
  if (!matches.length && !patterns.length) return '';
  const lines = [
    '[공식 한국어 자료 기반 힌트]',
    '상용 적용 가능한 공공누리 제1유형/인증키 자료의 내부 분석 결과다. 공식 원문을 길게 인용하지 말고, 품질 회귀 방지 힌트로만 사용한다.',
    '공공언어 지적 대상 표현이 있더라도 고유명, 제품명, 기술명, 인용문은 보존한다.'
  ];
  for (const match of matches) {
    const alts = (match.alternatives || []).slice(0, 3).join(', ');
    lines.push(`- 공공언어 후보 "${match.term}"${alts ? `: 쉬운 말 후보 ${alts}` : ''}`);
  }
  for (const pattern of patterns) {
    if (pattern.category === 'public_language') continue;
    lines.push(`- ${pattern.label}: ${pattern.advice || '결과에서 더 악화되지 않게 점검한다.'}`);
  }
  return lines.join('\n');
}

function compactOfficialAnalysis(analysis) {
  if (!analysis) return null;
  return {
    version: analysis.version || VERSION,
    resourceStatus: analysis.resourceStatus || {},
    officialResourceRisk: round3(analysis.officialResourceRisk),
    publicLanguageRisk: round3(analysis.publicLanguageRisk),
    normReferenceRisk: round3(analysis.normReferenceRisk),
    corpusReferenceRisk: round3(analysis.corpusReferenceRisk),
    publicLanguageMatches: (analysis.publicLanguageMatches || []).slice(0, 8).map(m => ({
      term: m.term,
      alternatives: (m.alternatives || []).slice(0, 3),
      count: m.count
    })),
    topPatterns: (analysis.topPatterns || []).slice(0, 6).map(compactPattern)
  };
}

function compactOfficialReport(report) {
  if (!report) return null;
  return {
    version: report.version || VERSION,
    enabled: report.enabled === true,
    action: report.action,
    reason: report.reason || '',
    riskDelta: report.riskDelta,
    beforeRisk: report.beforeRisk,
    afterRisk: report.afterRisk,
    addedPublicTerms: (report.addedPublicTerms || []).slice(0, 12),
    removedPublicTerms: (report.removedPublicTerms || []).slice(0, 12),
    source: report.source,
    output: report.output,
    topPatterns: (report.topPatterns || []).slice(0, 8).map(compactPattern)
  };
}

function getResourceStatus() {
  const resources = loadOfficialResources();
  return {
    version: VERSION,
    available: resources.available,
    counts: {
      publicLanguageTerms: resources.publicLanguage.terms?.length || 0,
      normCodes: resources.normRegulations.codes?.length || 0,
      normRules: resources.normRegulations.rules?.length || 0,
      corpusRows: resources.corpusStats.rows?.length || 0
    },
    sources: resources.sources?.datasets || {}
  };
}

function scanPublicLanguage(text, terms, opts = {}) {
  const source = String(text || '');
  if (!source || !Array.isArray(terms) || !terms.length) return [];
  const max = Math.max(3, Math.min(40, Number(opts.maxPublicMatches || 16) || 16));
  const matches = [];
  for (const item of terms) {
    const candidates = [item.term, ...(item.variants || [])]
      .map(clean)
      .filter(isUsablePublicLanguageCandidate);
    let count = 0;
    const samples = [];
    for (const candidate of candidates) {
      const found = countOccurrences(source, candidate);
      if (!found) continue;
      count += found;
      if (samples.length < 3) samples.push(candidate);
    }
    if (!count) continue;
    matches.push({
      id: 'official_public_language_term',
      category: 'public_language',
      severity: 'S3',
      label: '공공언어 쉬운 말 후보',
      term: item.term,
      alternatives: item.alternatives || [],
      count,
      samples,
      advice: '문맥상 일반 표현이면 쉬운 대체어 후보를 참고하되, 고유명과 전문 용어는 보존한다.',
      score: 0.8 * Math.log1p(count)
    });
    if (matches.length >= max) break;
  }
  return matches.sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
}

function analyzeNormSurface(text, normRegulations) {
  const source = String(text || '');
  const rules = Array.isArray(normRegulations?.rules) ? normRegulations.rules : [];
  const codeSet = new Set(rules.map(r => r.code).filter(Boolean));
  const directSignals = [];
  for (const code of codeSet) {
    if (code && source.includes(code)) directSignals.push(code);
  }
  const normWords = [
    ['맞춤법', '한글 맞춤법'],
    ['띄어쓰기', '띄어쓰기'],
    ['표준어', '표준어 규정'],
    ['문장 부호', '문장 부호'],
    ['외래어 표기', '외래어 표기법'],
    ['로마자 표기', '국어의 로마자 표기법']
  ];
  const topicSignals = normWords
    .filter(([needle]) => source.includes(needle))
    .map(([, label]) => label);
  const count = directSignals.length + topicSignals.length;
  const risk = count ? Math.min(0.25, count * 0.04) : 0;
  return {
    directSignals,
    topicSignals,
    ruleCount: rules.length,
    risk: round3(risk),
    patterns: count ? [{
      id: 'official_norm_reference_surface',
      category: 'norm_reference',
      severity: 'S3',
      label: '어문규범 관련 표면 표현',
      count,
      samples: [...directSignals, ...topicSignals].slice(0, 4),
      advice: '규범명은 사실 정보이므로 임의로 바꾸지 말고, 주변 문장만 자연스럽게 다듬는다.',
      score: 0.4 * Math.log1p(count)
    }] : []
  };
}

function analyzeCorpusSurface(text, corpusStats) {
  const source = String(text || '');
  const chars = source.replace(/\s+/g, '').length;
  const paragraphs = source.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const sentences = splitSentences(source);
  const oneBlockLongText = chars >= 900 && paragraphs.length <= 1;
  const sentencePerParagraph = paragraphs.length ? sentences.length / paragraphs.length : sentences.length;
  const corpusRows = Array.isArray(corpusStats?.rows) ? corpusStats.rows.length : 0;
  let risk = 0;
  const patterns = [];
  if (oneBlockLongText) {
    risk += 0.25;
    patterns.push({
      id: 'official_corpus_paragraph_collapse',
      category: 'corpus_reference',
      severity: 'S2',
      label: '장문 문단 뭉침',
      count: 1,
      samples: [],
      advice: '장문을 한 문단으로 합치지 말고 원문 문단 단위 또는 의미 단위 문단을 유지한다.',
      score: 1.8
    });
  }
  if (paragraphs.length >= 2 && sentencePerParagraph >= 7) {
    risk += 0.12;
    patterns.push({
      id: 'official_corpus_dense_paragraph',
      category: 'corpus_reference',
      severity: 'S3',
      label: '문단당 문장 밀도 높음',
      count: Math.round(sentencePerParagraph),
      samples: [],
      advice: '문단 안에서 의미가 바뀌는 지점은 빈 줄로 나누어 읽기 흐름을 유지한다.',
      score: 0.8
    });
  }
  return {
    corpusRows,
    paragraphCount: paragraphs.length,
    sentenceCount: sentences.length,
    sentencePerParagraph: round3(sentencePerParagraph),
    risk: round3(Math.min(1, risk)),
    patterns
  };
}

function publicMatchesToPatterns(matches) {
  if (!matches.length) return [];
  return [{
    id: 'official_public_language_terms',
    category: 'public_language',
    severity: matches.length >= 5 ? 'S2' : 'S3',
    label: '공공언어 쉬운 말 후보 감지',
    count: matches.reduce((n, m) => n + (m.count || 0), 0),
    samples: matches.slice(0, 4).map(m => m.term),
    advice: '쉬운 말 후보는 참고만 하고, 장르상 필요한 전문어와 고유명은 바꾸지 않는다.',
    score: Math.min(4, matches.length * 0.8)
  }];
}

function rankPatterns(patterns) {
  return [...(patterns || [])]
    .filter(p => (p.count || 0) > 0)
    .sort((a, b) => (b.score || 0) - (a.score || 0) || (b.count || 0) - (a.count || 0));
}

function riskFromCount(count, chars, denominator) {
  if (!count || chars <= 0) return 0;
  const densityFactor = Math.min(1.4, Math.max(0.75, 900 / Math.max(450, chars)));
  return round3(Math.min(1, (count * densityFactor) / denominator));
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = text.indexOf(needle, pos);
    if (idx < 0) break;
    count += 1;
    pos = idx + needle.length;
  }
  return count;
}

function readJson(fileName, fallback) {
  try {
    const target = path.join(RESOURCE_DIR, fileName);
    if (!fs.existsSync(target)) return fallback;
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return fallback;
  }
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

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isUsablePublicLanguageCandidate(value) {
  const text = clean(value);
  if (text.length < 2) return false;
  const compact = text.replace(/\s+/g, '');
  if (/^[가-힣]+$/.test(compact) && compact.length < 3) return false;
  return true;
}

function round3(v) {
  return Number(Number(v || 0).toFixed(3));
}

module.exports = {
  VERSION,
  loadOfficialResources,
  getResourceStatus,
  analyzeOfficialQuality,
  evaluateOfficialQuality,
  buildOfficialPromptHints,
  compactOfficialAnalysis,
  compactOfficialReport
};
