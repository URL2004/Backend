'use strict';

const { compareQuantities } = require('./numberAst');
const { postGenerationPolicyCheck } = require('./policy');

const META_PATTERNS = [
  /기록(?:돼|되어|이)?\s*있지\s*않/gu,
  /확인할\s*수\s*없/gu,
  /정보가\s*(?:부족|필요)/gu,
  /추가로\s*확인/gu,
  /다음에는\s*(?:기록|확인)/gu,
  /사실\s*카드/gu,
  /입력(?:된)?\s*내용/gu,
  /제공(?:된)?\s*정보/gu
];

const CLICHE_PATTERNS = [
  ['그치지 않고', /(?:에|에서)?\s*그치지\s*않(?:고|았)/gu],
  ['머무르지 않고', /(?:에|에서)?\s*머무르지\s*않(?:고|았)/gu],
  ['단순히 ~을 넘어', /단순(?:히|한)\s*[^,.\n]{0,14}(?:을|를)?\s*넘어/gu],
  ['뿐만 아니라', /뿐만\s*아니라/gu],
  ['나아가', /(?:^|[\s,.])나아가(?=[\s,])/gu]
];

function charCounts(text) {
  const value = String(text || '');
  const chars = Array.from(value);
  let byte2 = 0;
  for (const char of chars) byte2 += char.codePointAt(0) > 0x7f ? 2 : 1;
  return {
    withSpace: chars.length,
    noSpace: Array.from(value.replace(/\s+/gu, '')).length,
    byte2,
    utf8: Buffer.byteLength(value, 'utf8')
  };
}

function limitCheck(counts, target, mode, { minRatio = 0.88, maxRatio = 1 } = {}) {
  if (!target) return { applicable: false, pass: true };
  const used = mode === 'no_space' ? counts.noSpace : mode === 'byte2' ? counts.byte2 : counts.withSpace;
  const ratio = used / target;
  const status = ratio < minRatio ? 'under' : ratio > maxRatio ? 'over' : 'pass';
  return {
    applicable: true,
    mode,
    target,
    minimum: Math.ceil(target * minRatio),
    maximum: Math.floor(target * maxRatio),
    used,
    under: Math.max(0, Math.ceil(target * minRatio) - used),
    over: Math.max(0, used - Math.floor(target * maxRatio)),
    usageRatio: Math.round(ratio * 1000) / 1000,
    status,
    pass: status === 'pass'
  };
}

function validateStructuredOutput(structured, ledger) {
  const facts = new Map((ledger?.facts || []).map(fact => [fact.id, fact]));
  const paragraphs = Array.isArray(structured?.paragraphs) ? structured.paragraphs : [];
  const sentenceRows = [];
  const issues = [];
  const referenced = new Set();
  for (let p = 0; p < paragraphs.length; p += 1) {
    const sentences = Array.isArray(paragraphs[p]?.sentences) ? paragraphs[p].sentences : [];
    for (let s = 0; s < sentences.length; s += 1) {
      const row = sentences[s] || {};
      const text = String(row.text || '').trim();
      const kind = ['fact', 'opinion', 'connector'].includes(row.kind) ? row.kind : 'fact';
      const factRefs = Array.isArray(row.factRefs) ? [...new Set(row.factRefs.map(String))] : [];
      if (!text) { issues.push({ code: 'EMPTY_SENTENCE', paragraph: p, sentence: s }); continue; }
      const unknown = factRefs.filter(id => !facts.has(id));
      if (unknown.length) issues.push({ code: 'UNKNOWN_FACT_REF', paragraph: p, sentence: s, factRefs: unknown });
      if (kind !== 'connector' && factRefs.length === 0) issues.push({ code: 'FACT_REF_REQUIRED', paragraph: p, sentence: s });
      if (kind === 'connector' && factRefs.length > 0) issues.push({ code: 'CONNECTOR_HAS_FACT_REF', paragraph: p, sentence: s });
      factRefs.filter(id => facts.has(id)).forEach(id => referenced.add(id));
      sentenceRows.push({ text, kind, factRefs, paragraph: p, sentence: s });
    }
  }
  if (!sentenceRows.length) issues.push({ code: 'NO_SENTENCES' });
  const required = (ledger?.facts || [])
    .filter(fact => fact.importance === 'core'
      && !fact.categories.includes('prompt')
      && !fact.categories.includes('constraint')
      && !fact.categories.includes('policy'))
    .map(fact => fact.id);
  const missingCore = required.filter(id => !referenced.has(id));
  if (missingCore.length) issues.push({ code: 'CORE_FACT_NOT_USED', factRefs: missingCore });
  return {
    pass: issues.length === 0,
    issues,
    sentenceRows,
    referencedFactIds: [...referenced],
    missingCore
  };
}

function assembleDraft(structured) {
  return (structured?.paragraphs || [])
    .map(paragraph => (paragraph?.sentences || []).map(row => String(row?.text || '').trim()).filter(Boolean).join(' '))
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function metaCheck(text) {
  const found = [];
  for (const pattern of META_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of String(text || '').matchAll(pattern)) {
      if (!found.includes(match[0])) found.push(match[0]);
    }
  }
  return { pass: found.length === 0, found: found.slice(0, 12) };
}

function clicheCheck(text) {
  const found = [];
  let total = 0;
  for (const [phrase, pattern] of CLICHE_PATTERNS) {
    pattern.lastIndex = 0;
    const count = [...String(text || '').matchAll(pattern)].length;
    if (count) { total += count; found.push({ phrase, count }); }
  }
  return { pass: total === 0, total, found };
}

function deterministicChecks({ text, structured, ledger, targetChars, charLimitMode, policy }) {
  const counts = charCounts(text);
  const structure = structured ? validateStructuredOutput(structured, ledger) : { pass: true, issues: [], referencedFactIds: [] };
  const numbers = compareQuantities((ledger?.facts || []).map(fact => fact.value).join('\n'), text);
  const meta = metaCheck(text);
  const cliches = clicheCheck(text);
  const length = limitCheck(counts, targetChars, charLimitMode);
  const policyCheck = postGenerationPolicyCheck(text, policy);
  const hardPass = structure.pass && numbers.pass && meta.pass && length.pass && policyCheck.pass;
  return { version: 'writing-checks-v1', hardPass, counts, length, structure, numbers, meta, policy: policyCheck, cliches };
}

function releaseReport(checks, semantic) {
  const semanticPass = semantic?.pass === true;
  const pass = checks?.hardPass === true && semanticPass;
  const reasons = [];
  if (!checks?.structure?.pass) reasons.push('claim_structure');
  if (!checks?.numbers?.pass) reasons.push('unsupported_number');
  if (!checks?.meta?.pass) reasons.push('meta_filler');
  if (!checks?.length?.pass) reasons.push(`length_${checks?.length?.status || 'failed'}`);
  if (!checks?.policy?.pass) reasons.push('policy');
  if (!semanticPass) reasons.push('semantic_grounding');
  return {
    version: 'writing-release-gate-v1',
    status: pass ? 'READY' : 'BLOCKED',
    pass,
    reasons,
    semantic: semantic || { pass: false, error: 'semantic_check_missing' }
  };
}

module.exports = {
  META_PATTERNS,
  charCounts,
  limitCheck,
  validateStructuredOutput,
  assembleDraft,
  metaCheck,
  clicheCheck,
  deterministicChecks,
  releaseReport
};
