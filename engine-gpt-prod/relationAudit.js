'use strict';

const { splitSentences } = require('../engine/koreanText');
const { extractNumberTokens } = require('./factAudit');
const VERSION = 'relation-candidates-v1';

// These are review triggers, never findings of factual error or block gates.
// Exact ownership swaps are screened separately from broad semantic changes.
function auditRelationCandidates(source, outputText) {
  const before = String(source || '');
  const after = String(outputText || '');
  const candidates = [];
  const sourceBindings = numberBindings(before);
  const outputBindings = numberBindings(after);
  const owners = [...new Set(sourceBindings.map(row => row.owner))];
  if (owners.length >= 2 && bag(extractNumberTokens(before)) === bag(extractNumberTokens(after))) {
    for (const owner of owners) {
      const left = sourceBindings.filter(row => row.owner === owner);
      const right = outputBindings.filter(row => row.owner === owner);
      if (left.length && left.length === right.length && bag(left.map(row => row.value)) !== bag(right.map(row => row.value))) {
        candidates.push({ code: 'number_ownership_candidate', owner,
          sourceSpan: left[0].span, outputSpan: right[0].span });
      }
    }
  }
  const originals = splitSentences(before);
  for (const [outputIndex, sentence] of splitSentences(after).entries()) {
    const matched = closestSentence(originals, sentence);
    if (!matched || matched.similarity < 0.42 || matched.sentence === sentence) continue;
    const original = matched.sentence;
    const add = code => candidates.push({ code, sourceOrdinal: matched.index + 1,
      outputOrdinal: outputIndex + 1, sourceSpan: original, outputSpan: sentence });
    if (/(?:이후|그\s*후|\s뒤|\s후에|다음에)/u.test(original)
        && count(sentence, /(?:그\s*결과|때문에|따라서|덕분에)/gu) > count(original, /(?:그\s*결과|때문에|따라서|덕분에)/gu)) add('causal_relation_candidate');
    const left = subjectObject(original), right = subjectObject(sentence);
    if (left && right && left.subject === right.object && left.object === right.subject
        && left.subject !== left.object) add('argument_ownership_candidate');
    if (/(?:란|이란|는|은)\s+[^.]{2,100}(?:뜻한다|말한다|의미한다|이다)[.!?]?$/u.test(original)
        && left && right && left.subject !== right.subject && left.object === right.subject) add('definition_target_candidate');
    if (/수\s*없|불가능|모든|반드시|해야/u.test(original)
        && /어렵|일부|권장|좋다/u.test(sentence)
        && !/어렵|일부|권장|좋다/u.test(original)) add('claim_strength_candidate');
  }
  const seen = new Set();
  const unique = candidates.filter(row => {
    const key = JSON.stringify(row); if (seen.has(key)) return false; seen.add(key); return true;
  }).slice(0, 12);
  return { version: VERSION, candidateOnly: true, semanticRequired: unique.length > 0,
    codes: [...new Set(unique.map(row => row.code))], candidates: unique };
}

function numberBindings(value) {
  const out = [];
  for (const sentence of splitSentences(value)) {
    const subjects = [...sentence.matchAll(/([가-힣A-Za-z][가-힣A-Za-z0-9·-]{0,29}?)(?:은|는|이|가)(?=\s)/gu)];
    for (const match of sentence.matchAll(/[-+]?\d+(?:,\d{3})*(?:\.\d+)?\s*(?:개월|만원|억원|조원|시간|명|개|건|회|년|월|일|분|초|원|%|kg|km)?/gu)) {
      const subject = subjects.filter(row => row.index < match.index).at(-1);
      if (!subject || match.index - subject.index > 90) continue;
      out.push({ owner: subject[1], value: extractNumberTokens(match[0])[0] || match[0], span: sentence });
    }
  }
  return out;
}
function subjectObject(value) {
  const match = String(value).match(/([가-힣A-Za-z][가-힣A-Za-z0-9·-]{0,29}?)(?:은|는|이|가)\s+([가-힣A-Za-z][가-힣A-Za-z0-9·-]{0,29}?)(?:을|를)(?=\s)/u);
  return match ? { subject: match[1], object: match[2] } : null;
}
function closestSentence(originals, value) {
  // Light normalization is only for locating a comparable sentence. It never
  // certifies a relation or acts as an authorship feature.
  const tokens = value => new Set((String(value).match(/[가-힣A-Za-z0-9]{2,}/gu) || [])
    .map(token => token.replace(/(?:에게서|에게|에서|으로|은|는|이|가|을|를|의)$/u, '')));
  const target = tokens(value);
  return originals.map((sentence, index) => {
    const source = tokens(sentence);
    const overlap = [...target].filter(token => source.has(token)).length;
    return { sentence, index, similarity: overlap / Math.max(1, Math.min(source.size, target.size)) };
  }).sort((a, b) => b.similarity - a.similarity)[0];
}
const bag = values => JSON.stringify([...values].sort());
const count = (value, pattern) => (String(value).match(pattern) || []).length;

module.exports = { VERSION, auditRelationCandidates, numberBindings };
