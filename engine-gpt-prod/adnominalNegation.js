'use strict';

const { sentenceSimilarity } = require('./sentenceAlignment');

const CODE = 'introduced_adnominal_negation';
const MAX_FINDINGS = 40;

// Spans arrive with protected syntax masked at its original UTF-16 positions.
// This is a source-backed grammar witness, not a Korean morphological parser:
// a noun/topic ending in 는 is insufficient, and no replacement is proposed.
function introducedAdnominalNegations(sourceSpans, outputSpans) {
  const findings = [];
  for (const output of outputSpans) {
    for (const match of malformedFrames(output.editable)) {
      const stem = match[1];
      const sources = sourceSpans.map(source => ({
        source,
        inherited: malformedFrames(source.editable).some(item => item[1] === stem),
        verbWitness: sourceVerbFrames(source.editable, stem).length > 0,
        localContext: matchingClauseContext(source.editable, stem, output.editable, match.index)
      })).filter(row => row.inherited || row.verbWitness)
        .map(row => ({ ...row, score: sentenceSimilarity(row.source.editable, output.editable) }))
        .sort((a, b) => b.score - a.score);
      const contextual = sources.filter(row => row.localContext);
      const uniqueContext = contextual.length === 1;
      const best = uniqueContext ? contextual[0] : sources[0];
      // An old defect belongs to its corresponding source sentence. A defect
      // elsewhere cannot cancel a newly introduced one by document-wide count.
      // Repeated/ambiguous source matches do not establish a safe grammar claim.
      if (!best || (!uniqueContext && (best.score < 0.5 || (sources[1] && best.score - sources[1].score < 0.08)))
          || best.inherited || !best.verbWitness) continue;
      findings.push({ code: CODE, ordinal: output.ordinal,
        sourceOrdinal: best.source.ordinal,
        outputStart: output.start + match.index,
        outputEnd: output.start + match.index + match[0].length });
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}

function malformedFrames(text) {
  return [...String(text || '').matchAll(/(?<![\p{L}\p{N}_])([가-힣]{1,40})는[ \t]+않[가-힣]+(?=$|[^\p{L}\p{N}_])/gu)];
}

function sourceVerbFrames(text, stem) {
  // Do not blanket-exclude tokens ending in 지는: both the legitimate
  // contrastive 하지+는 and adnominal 커지+는 end that way. The exact source
  // stem must instead own a valid negative or bound-noun construction.
  const prefix = `(?<![\\p{L}\\p{N}_])${stem}`;
  return [...text.matchAll(new RegExp(prefix + '지(?:는|도|만)?[ \\t]+않[가-힣]+(?=$|[^\\p{L}\\p{N}_])', 'gu')),
    ...text.matchAll(new RegExp(prefix + '는[ \\t]+(?:것(?:이|은|을|도|만|과|에|으로|처럼|보다)?|게|데|바)(?=$|[^\\p{L}\\p{N}_])', 'gu'))];
}

function matchingClauseContext(source, stem, output, outputIndex) {
  const leftWords = (text, index) => (text.slice(0, index).match(/[\p{L}\p{N}·_-]+/gu) || []).slice(-2);
  const expected = leftWords(output, outputIndex);
  if (expected.length !== 2 || expected.join('').replace(/[^\p{L}\p{N}]/gu, '').length < 6) return false;
  // A split output arm can be much shorter than its compound source sentence.
  // Exact adjacent clause words plus the same verb frame establish local
  // ownership without reducing the whole-sentence similarity threshold.
  const frames = [...sourceVerbFrames(source, stem), ...malformedFrames(source).filter(item => item[1] === stem)];
  return frames.filter(frame => leftWords(source, frame.index).join(' ') === expected.join(' ')).length === 1;
}

module.exports = { CODE, introducedAdnominalNegations };
