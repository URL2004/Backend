'use strict';

const { splitSentenceSpans } = require('../engine/koreanText');
const { syntaxSpans } = require('../engine/textSyntax');
const { sentenceSimilarity } = require('./sentenceAlignment');
const layout = require('./layoutStructure');

const FORMAL = new Set(['resume_application', 'academic_paper', 'report_assignment', 'long_explainer']);
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// Source-relative review, not a ban on nominal clauses or on changing word order.
// Never use sentence length or edit percentage as proof of bad writing.
function auditNaturalnessRegression(source, output, profile = 'unknown') {
  const sources = proseSpans(source), outputs = proseSpans(output);
  const findings = [];
  for (const target of outputs) {
    const nominal = [...target.text.matchAll(/(?<![가-힣])([가-힣]{2,24})는\s+일(?:을\s+이어가|부터\s+(?:탄탄히\s+)?시작하)/gu)];
    const condition = /려면\s*,?\s*[^.!?。！？]{5,180}고\s*싶(?:습니다|다|어요)/u.test(target.text)
      && !/(?:해야|필요|조건|전제|알리|묻|물어|알아보|설명|다고|라는)/u.test(target.text);
    const displaced = FORMAL.has(profile) && /^[^,\n]{8,100}도,\s*[^,\n]{5,100}고려해\s/u.test(target.text);
    if (!nominal.length && !condition && !displaced) continue;
    const ranked = sources.map(span => ({ span, score: sentenceSimilarity(span.text, target.text) }))
      .sort((a,b) => b.score-a.score);
    const best = ranked[0];
    if (!best || best.score < .5 || (ranked[1] && best.score-ranked[1].score < .1)) continue;
    const original = best.span.text;
    if (original === target.text) continue;
    for (const match of nominal) {
      const stem = escape(match[1]);
      // Same action, same tense/modality. Continuing a real existing activity,
      // starting a new stage, contrasting occupations, etc. is not inflation.
      if (/(?:이어가|계속|지속|시작|하던|해\s*온|직업|생업)/u.test(original)) continue;
      const ending = target.text.slice(match.index + match[0].length).match(/^(고\s*싶(?:습니다|다|어요)|겠습니다)/u)?.[1];
      if (!ending) continue;
      const direct = new RegExp(`(?<![가-힣])${stem}${escape(ending)}`, 'u').exec(original);
      if (!direct) continue;
      findings.push({ code:'introduced_action_nominalization', ordinal:target.ordinal,
        // '부터 시작하다' changes particle scope too: only repair it when the
        // same multi-word object and direct predicate occur verbatim in SOURCE.
        repair: /일을\s+이어가/u.test(match[0]) ? {
          start:target.start+match.index, end:target.start+match.index+match[0].length,
          replacement:match[1], ordinal:target.ordinal, code:'introduced_action_nominalization'
        } : groundedStartRepair(original, target, match, ending) });
    }
    if (condition && !/려면/u.test(original)) {
      findings.push({code:'introduced_condition_wish_mismatch',ordinal:target.ordinal});
    }
    if (displaced) {
      const modifier = target.text.match(/도,\s*([^,\n]{5,100}고려해)\s/u)?.[1];
      if (modifier && original.startsWith(modifier)
          && !/(?:특히|반면|다만|무엇보다|만큼은)/u.test(original)) {
        findings.push({code:'introduced_modifier_dislocation',ordinal:target.ordinal});
      }
    }
  }
  return findings;
}

function groundedStartRepair(original, target, match, ending) {
  const prefix = target.text.slice(0, match.index);
  const anchor = prefix.match(/([가-힣]{2,20}\s+[가-힣]{2,20})(을|를)\s+$/u);
  if (!anchor) return null;
  const pattern = new RegExp(`(?<![가-힣])${escape(anchor[1])}(?:부터|을|를)\\s*(?:탄탄히\\s+)?${escape(match[1])}(?=${escape(ending)})`, 'gu');
  const evidence = [...original.matchAll(pattern)];
  if (evidence.length !== 1) return null;
  return {start:target.start+anchor.index, end:target.start+match.index+match[0].length,
    replacement:evidence[0][0],ordinal:target.ordinal,code:'introduced_action_nominalization'};
}

function proseSpans(value) {
  const text = String(value || ''), protectedSpans = syntaxSpans(text);
  return splitSentenceSpans(text).map((span,index)=>({...span,ordinal:index+1})).filter(span =>
    span.text.length <= 800 && !protectedSpans.some(p=>p.start<span.end && p.end>span.start)
    && layout.buildLineRecords(span.text).every(row=>row.blank || row.role==='prose'));
}

module.exports = { auditNaturalnessRegression };
