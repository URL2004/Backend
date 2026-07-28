'use strict';

const VERSION = 'copykiller-naturalness-lab-v1';
const PROMPT_HINT_MAX = 8;

const CONNECTOR_PATTERNS = [
  /또한/g,
  /따라서/g,
  /이에\s*따라/g,
  /이러한/g,
  /이를\s*통해/g,
  /나아가/g,
  /한편/g,
  /결론적으로/g,
  /즉[, ]/g,
  /첫째/g,
  /둘째/g,
  /셋째/g
];

const STOCK_REPORT_PATTERNS = [
  /할\s*수\s*있(?:다|습니다)/g,
  /볼\s*수\s*있(?:다|습니다)/g,
  /필요가\s*있(?:다|습니다)/g,
  /중요(?:하|한)\s*(?:의미|역할|요인)?/g,
  /의미를\s*가진(?:다|다고|다고\s*볼)/g,
  /긍정적인\s*영향/g,
  /체계적으로\s*(?:정리|분석|관리|운영)/g,
  /기반으로\s*(?:한|하여|한다|합니다)/g,
  /핵심\s*인프라/g,
  /전략적\s*이점/g,
  /효율(?:성|적)/g
];

const GENERIC_ABSTRACT_PATTERNS = [
  /중요/g,
  /필요/g,
  /효율/g,
  /전략/g,
  /체계/g,
  /역할/g,
  /경험/g,
  /가치/g,
  /역량/g,
  /기반/g,
  /영향/g,
  /과정/g,
  /측면/g,
  /요인/g,
  /문제/g,
  /개선/g,
  /확대/g,
  /강화/g
];

const OVER_POLISHED_ENDINGS = [
  /(?:할|될)\s*수\s*있(?:다|습니다)[.?!]?$/g,
  /(?:라고|다고)\s*볼\s*수\s*있(?:다|습니다)[.?!]?$/g,
  /필요가\s*있(?:다|습니다)[.?!]?$/g,
  /중요(?:하다고\s*생각한다|하다|합니다)[.?!]?$/g,
  /마무리(?:되었다|되었습니다|된다|됩니다)[.?!]?$/g,
  /이어(?:진다|집니다)[.?!]?$/g
];

function buildProfile(text, opts = {}) {
  const source = String(text || '');
  const sentences = splitSentences(source);
  const paragraphs = splitParagraphs(source);
  const compactLen = source.replace(/\s+/g, '').length;
  const connectorCount = countMany(source, CONNECTOR_PATTERNS);
  const stockCount = countMany(source, STOCK_REPORT_PATTERNS);
  const genericCount = countMany(source, GENERIC_ABSTRACT_PATTERNS);
  const endingCount = countSentenceEndings(sentences, OVER_POLISHED_ENDINGS);
  const rhythm = measureRhythm(sentences);
  const paragraphShape = measureParagraphShape(paragraphs);
  const concrete = measureConcreteAnchors(source, sentences.length);
  const sentenceCount = Math.max(1, sentences.length);
  const risks = {
    connectorRepetition: round3(Math.min(1, connectorCount / Math.max(4, sentenceCount * 0.65))),
    stockReportPhrase: round3(Math.min(1, stockCount / Math.max(3, sentenceCount * 0.45))),
    genericAbstractness: round3(Math.min(1, genericCount / Math.max(8, compactLen / 120))),
    uniformSentenceRhythm: rhythm.risk,
    paragraphSymmetry: paragraphShape.risk,
    overPolishedEnding: round3(Math.min(1, endingCount / Math.max(3, sentenceCount * 0.40))),
    concreteAnchorScarcity: concrete.scarcityRisk
  };
  risks.overall = round3(Math.min(1,
    risks.connectorRepetition * 0.17 +
    risks.stockReportPhrase * 0.19 +
    risks.genericAbstractness * 0.14 +
    risks.uniformSentenceRhythm * 0.18 +
    risks.paragraphSymmetry * 0.10 +
    risks.overPolishedEnding * 0.14 +
    risks.concreteAnchorScarcity * 0.08
  ));
  const profile = {
    version: VERSION,
    mode: opts.mode || '',
    register: opts.register || '',
    charLen: compactLen,
    paragraphCount: paragraphs.length,
    sentenceCount: sentences.length,
    counts: {
      connectorCount,
      stockCount,
      genericCount,
      overPolishedEndingCount: endingCount,
      concreteAnchorCount: concrete.anchorCount
    },
    risks,
    rhythm,
    paragraphShape,
    concrete,
    topIssues: buildTopIssues(source, risks, { connectorCount, stockCount, genericCount, endingCount, rhythm, paragraphShape, concrete })
      .slice(0, opts.maxIssues || 12)
  };
  return profile;
}

function buildPromptHints(profile, opts = {}) {
  const max = Math.max(1, Math.min(12, Number(opts.max || PROMPT_HINT_MAX) || PROMPT_HINT_MAX));
  const issues = (profile?.topIssues || []).slice(0, max);
  const lines = [
    '[카피킬러 자연성 테스트 모드]',
    '이 모드는 외부 검사 점수 보장이나 조작이 아니라, 이전 검사 결과에서 관찰된 "너무 정돈된 문체"를 줄이는 로컬 실험이다.',
    '원문 의미, 장르, 화자, 사실, 수치, 고유명사, 참고문헌은 보존한다.',
    '원문에 없는 개인 경험, 새로운 사례, 새로운 감정, 새로운 근거는 만들지 않는다.',
    '문장을 더 예쁘게 정리하는 방향이 아니라, 접속어 반복과 보고서식 상투 표현을 줄이고 문장 호흡을 덜 균일하게 만든다.',
    '문단 구조를 무너뜨리지 말고, 한 문단 안에서만 자연스러운 리듬 차이를 만든다.',
    `과정돈 위험도 ${formatRisk(profile?.risks?.overall)} / 주요 조정 대상 ${issues.length}개`
  ];
  for (const issue of issues) {
    const sample = issue.samples?.length ? ` 예: ${issue.samples.slice(0, 2).join(', ')}` : '';
    lines.push(`- ${issue.label}: ${issue.advice}${sample}`);
  }
  return lines.join('\n');
}

function buildAudit(source, output, opts = {}) {
  const before = opts.beforeProfile || buildProfile(source, opts);
  const after = opts.afterProfile || buildProfile(output, opts);
  const delta = buildDelta(before, after);
  const protectedReport = buildProtectedTermReport(source, output, opts.protectedTerms);
  const warnings = [];
  const blockers = [];
  if (delta.riskDelta >= 0.04) warnings.push('over_polished_risk_increased');
  if (delta.byMetric?.connectorRepetition > 0.08) warnings.push('connector_repetition_increased');
  if (delta.byMetric?.stockReportPhrase > 0.08) warnings.push('stock_report_phrase_increased');
  if (delta.byMetric?.uniformSentenceRhythm > 0.08) warnings.push('uniform_rhythm_increased');
  if (delta.byMetric?.concreteAnchorScarcity > 0.08) warnings.push('concrete_anchor_scarcity_increased');
  if (protectedReport.lossCount > 0) warnings.push('protected_term_loss');
  if (!String(output || '').trim()) blockers.push('empty_output');
  if (looksLikePromptLeak(output)) blockers.push('prompt_instruction_leak');
  if (looksEncodingCorrupted(source, output)) blockers.push('encoding_corruption');
  if (looksTruncated(output)) blockers.push('sentence_truncated');
  const action = blockers.length ? 'blocked' : warnings.length ? 'needs_review' : 'pass';
  return {
    version: VERSION,
    profileBefore: before,
    profileAfter: after,
    delta,
    protectedTermReport: protectedReport,
    auditTrail: {
      action,
      warnings: [...new Set(warnings)],
      blockers,
      notes: buildNotes(delta, protectedReport)
    }
  };
}

function compactAudit(audit) {
  if (!audit) return null;
  return {
    version: audit.version || VERSION,
    profileBefore: compactProfile(audit.profileBefore),
    profileAfter: compactProfile(audit.profileAfter),
    delta: audit.delta,
    protectedTermReport: audit.protectedTermReport,
    auditTrail: audit.auditTrail
  };
}

function compactProfile(profile) {
  if (!profile) return null;
  return {
    version: profile.version || VERSION,
    mode: profile.mode || '',
    register: profile.register || '',
    charLen: profile.charLen,
    paragraphCount: profile.paragraphCount,
    sentenceCount: profile.sentenceCount,
    counts: profile.counts,
    risks: profile.risks,
    rhythm: profile.rhythm,
    paragraphShape: profile.paragraphShape,
    concrete: profile.concrete,
    topIssues: (profile.topIssues || []).slice(0, 8)
  };
}

function buildTopIssues(text, risks, counts) {
  const issues = [];
  if (risks.connectorRepetition >= 0.18) issues.push(issue('connector_repetition', '접속어 반복', risks.connectorRepetition, counts.connectorCount, sampleMatches(text, unionRegex(CONNECTOR_PATTERNS)), '또한/따라서/이러한 같은 연결어를 줄이고 문장 내부의 의미 연결로 풀어 쓴다.'));
  if (risks.stockReportPhrase >= 0.18) issues.push(issue('stock_report_phrase', '보고서식 상투 표현', risks.stockReportPhrase, counts.stockCount, sampleMatches(text, unionRegex(STOCK_REPORT_PATTERNS)), '할 수 있다/볼 수 있다/중요하다 같은 틀을 필요한 곳만 남기고 더 구체적인 서술로 바꾼다.'));
  if (risks.uniformSentenceRhythm >= 0.18) issues.push(issue('uniform_sentence_rhythm', '문장 길이 균일', risks.uniformSentenceRhythm, counts.rhythm?.sentenceCount || 0, [], '짧은 문장과 중간 길이 문장을 섞되, 문장 절단이나 단문 남발은 피한다.'));
  if (risks.paragraphSymmetry >= 0.18) issues.push(issue('paragraph_symmetry', '문단 길이 과균형', risks.paragraphSymmetry, counts.paragraphShape?.paragraphCount || 0, [], '모든 문단을 같은 길이와 같은 구조로 맞추지 말고 원문 구조 안에서 자연스러운 차이를 둔다.'));
  if (risks.genericAbstractness >= 0.18) issues.push(issue('generic_abstractness', '일반론/추상어 과다', risks.genericAbstractness, counts.genericCount, sampleMatches(text, unionRegex(GENERIC_ABSTRACT_PATTERNS)), '원문에 있는 구체 대상, 행동, 장면을 우선 쓰고 넓은 일반론으로 마무리하는 습관을 줄인다.'));
  if (risks.overPolishedEnding >= 0.18) issues.push(issue('over_polished_ending', '매끈한 종결 반복', risks.overPolishedEnding, counts.endingCount, [], '문장 끝을 같은 보고서식 종결로 반복하지 않고 장르에 맞게 자연스럽게 분산한다.'));
  if (risks.concreteAnchorScarcity >= 0.45) issues.push(issue('concrete_anchor_scarcity', '구체 장면/행동 부족', risks.concreteAnchorScarcity, counts.concrete?.anchorCount || 0, [], '새 사실은 만들지 말고, 원문에 이미 있는 장소, 대상, 행동, 수치, 인용을 더 앞세운다.'));
  return issues.sort((a, b) => b.score - a.score);
}

function issue(id, label, score, count, samples, advice) {
  return {
    id,
    label,
    category: 'naturalness',
    severity: score >= 0.45 ? 'S2' : 'S3',
    score: round3(score),
    count: Number(count || 0),
    samples: (samples || []).slice(0, 3),
    advice
  };
}

function buildDelta(before, after) {
  const keys = ['connectorRepetition', 'stockReportPhrase', 'genericAbstractness', 'uniformSentenceRhythm', 'paragraphSymmetry', 'overPolishedEnding', 'concreteAnchorScarcity'];
  const byMetric = {};
  for (const key of keys) byMetric[key] = round3((after?.risks?.[key] || 0) - (before?.risks?.[key] || 0));
  const beforeIssues = new Map((before?.topIssues || []).map(v => [v.id, v]));
  const afterIssues = new Map((after?.topIssues || []).map(v => [v.id, v]));
  const ids = new Set([...beforeIssues.keys(), ...afterIssues.keys()]);
  const reduced = [];
  const increased = [];
  for (const id of ids) {
    const b = beforeIssues.get(id) || { score: 0, count: 0, id };
    const a = afterIssues.get(id) || { score: 0, count: 0, id };
    const item = {
      id,
      label: a.label || b.label || id,
      beforeScore: round3(b.score || 0),
      afterScore: round3(a.score || 0),
      deltaScore: round3((a.score || 0) - (b.score || 0)),
      beforeCount: b.count || 0,
      afterCount: a.count || 0
    };
    if (item.deltaScore <= -0.03) reduced.push(item);
    if (item.deltaScore >= 0.03) increased.push(item);
  }
  return {
    beforeRisk: round3(before?.risks?.overall),
    afterRisk: round3(after?.risks?.overall),
    riskDelta: round3((after?.risks?.overall || 0) - (before?.risks?.overall || 0)),
    byMetric,
    reducedPatterns: reduced.sort((a, b) => a.deltaScore - b.deltaScore).slice(0, 10),
    increasedPatterns: increased.sort((a, b) => b.deltaScore - a.deltaScore).slice(0, 10),
    reducedCount: reduced.length,
    increasedCount: increased.length
  };
}

function splitParagraphs(text) {
  return String(text || '').split(/\n{2,}/).map(v => v.trim()).filter(Boolean);
}

function splitSentences(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  const matches = normalized.match(/[^.!?。？！\n]+[.!?。？！]?/g) || [];
  return matches
    .map(v => v.trim())
    .filter(v => v.replace(/\s+/g, '').length >= 3);
}

function measureRhythm(sentences) {
  const lengths = sentences.map(s => s.replace(/\s+/g, '').length).filter(Boolean);
  if (lengths.length < 4) return { sentenceCount: lengths.length, avg: avg(lengths), cv: 1, risk: 0 };
  const a = avg(lengths);
  const sd = Math.sqrt(avg(lengths.map(v => Math.pow(v - a, 2))));
  const cv = a ? sd / a : 1;
  const sameBand = lengths.filter(v => Math.abs(v - a) <= Math.max(8, a * 0.18)).length / lengths.length;
  const risk = round3(Math.max(0, Math.min(1, (0.42 - cv) * 1.9 + Math.max(0, sameBand - 0.55))));
  return { sentenceCount: lengths.length, avg: round3(a), min: Math.min(...lengths), max: Math.max(...lengths), cv: round3(cv), sameBand: round3(sameBand), risk };
}

function measureParagraphShape(paragraphs) {
  const lengths = paragraphs.map(p => p.replace(/\s+/g, '').length).filter(v => v >= 20);
  if (lengths.length < 4) return { paragraphCount: lengths.length, avg: avg(lengths), cv: 1, risk: 0 };
  const a = avg(lengths);
  const sd = Math.sqrt(avg(lengths.map(v => Math.pow(v - a, 2))));
  const cv = a ? sd / a : 1;
  const risk = round3(Math.max(0, Math.min(1, (0.34 - cv) * 1.8)));
  return { paragraphCount: lengths.length, avg: round3(a), min: Math.min(...lengths), max: Math.max(...lengths), cv: round3(cv), risk };
}

function measureConcreteAnchors(text, sentenceCount) {
  const source = String(text || '');
  const anchors = [
    ...(source.match(/\d+(?:[.,]\d+)?\s*(?:%|원|명|개|회|년|월|일|시간|분|평|건)?/g) || []),
    ...(source.match(/["“”'‘’][^"“”'‘’]{2,40}["“”'‘’]/g) || []),
    ...(source.match(/[A-Z][A-Za-z0-9-]{2,}/g) || []),
    ...(source.match(/[가-힣A-Za-z0-9·-]{2,}(?:시스템|서비스|제품|기관|회사|학교|병원|터미널|소방서|우체국|플랫폼|프로그램)/g) || [])
  ];
  const anchorCount = anchors.length;
  const density = anchorCount / Math.max(1, sentenceCount || 1);
  const scarcityRisk = round3(Math.max(0, Math.min(1, 0.55 - density)));
  return { anchorCount, density: round3(density), scarcityRisk, samples: [...new Set(anchors)].slice(0, 8) };
}

function countSentenceEndings(sentences, patterns) {
  let count = 0;
  for (const sentence of sentences) {
    const tail = String(sentence || '').trim().slice(-40);
    if (patterns.some(re => new RegExp(re.source, re.flags).test(tail))) count++;
  }
  return count;
}

function countMany(text, patterns) {
  return patterns.reduce((sum, re) => sum + countRe(text, re), 0);
}

function countRe(text, re) {
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  const rx = new RegExp(re.source, flags);
  return (String(text || '').match(rx) || []).length;
}

function sampleMatches(text, re) {
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  const rx = new RegExp(re.source, flags);
  return [...String(text || '').matchAll(rx)].map(m => m[0]).filter(Boolean).slice(0, 5);
}

function unionRegex(patterns) {
  return new RegExp(patterns.map(p => `(?:${p.source})`).join('|'), 'g');
}

function avg(values) {
  if (!values || !values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function buildProtectedTermReport(source, output, protectedTerms = []) {
  const terms = unique([...(Array.isArray(protectedTerms) ? protectedTerms : []), ...extractTermCandidates(source)]).slice(0, 120);
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
  return { termCount: terms.length, keptCount: kept.length, lossCount: lost.length, lost: lost.slice(0, 20), keptSample: kept.slice(0, 12) };
}

function extractTermCandidates(text) {
  const source = String(text || '');
  const out = [];
  const patterns = [
    /[A-Z][A-Za-z0-9&+_.-]{1,}(?:\s+[A-Z][A-Za-z0-9&+_.-]{1,}){0,4}/g,
    /[가-힣A-Za-z0-9·-]{2,}(?:시스템|기술|서비스|제품|기관|회사|학교|병원|정책|자료|과정|분석|모델|플랫폼|프로그램|터미널|소방서|우체국)/g,
    /[가-힣]{2,}(?:택배|교육|복지|행정|경영|마케팅|청소|병원|소방|우편)[가-힣A-Za-z0-9·-]*/g
  ];
  for (const re of patterns) {
    for (const match of source.match(re) || []) {
      const v = match.trim();
      if (v.length >= 2 && v.length <= 40) out.push(v);
    }
  }
  return out;
}

function compactSurface(text) {
  return String(text || '').replace(/\s+/g, '').toLowerCase();
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const v = String(value || '').trim();
    const key = v.toLowerCase();
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function buildNotes(delta, protectedReport) {
  const notes = [];
  if (delta.riskDelta < -0.03) notes.push('과정돈 위험이 감소했다.');
  if (delta.riskDelta > 0.03) notes.push('과정돈 위험이 증가했다.');
  if (protectedReport.lossCount > 0) notes.push('보호표현 손실 후보가 있어 원문 대조가 필요하다.');
  return notes;
}

function looksLikePromptLeak(text) {
  return /(재작성할\s*텍스트|카피킬러\s*자연성\s*테스트\s*모드|작업\s*위치|필수\s*조건|출력\s*형식)/.test(String(text || ''));
}

function looksEncodingCorrupted(original, output) {
  const src = String(original || '');
  const out = String(output || '');
  if (!/[가-힣]/.test(src)) return false;
  const q = (out.match(/\?/g) || []).length;
  return q >= 8 && q / Math.max(1, out.length) >= 0.08;
}

function looksTruncated(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  return /(?:그리고|그러나|하지만|또한|따라서|때문에|위해|통해|하며|하고|거나|지만)$/.test(s);
}

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

function formatRisk(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0.000';
  return n.toFixed(3);
}

module.exports = {
  VERSION,
  buildProfile,
  buildPromptHints,
  buildAudit,
  compactAudit,
  splitSentences
};
