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
    const evidenceFrame = /^(?:(?:따라서|이에)\s+)?((?:이번|본|해당)\s+(?:탐구|연구|분석|조사|실험))에서는\s+([가-힣A-Za-z0-9]+(?:\s+[가-힣A-Za-z0-9]+){0,2})(?:은|는)\s/u.exec(target.text);
    const reflection = /(점|사실)은\s+(생각|관점|인식)을\s+(?:바꾸었다|바꿨다|바꾸었습니다|바꿨습니다)[.!?]?$/u.exec(target.text);
    if (!nominal.length && !condition && !displaced && !evidenceFrame && !reflection) continue;
    if (reflection) {
      // One source sentence can become two output sentences. Whole-sentence
      // similarity can rank a generic earlier sentence above the true source.
      // Require a unique, exact proposition tail AND the original experience
      // predicate instead of lowering the global alignment threshold.
      const tail = target.text.slice(0, reflection.index).trim().split(/\s+/u).slice(-4).join(' ');
      const compact = value => value.replace(/\s+/gu, '');
      const evidencePattern = /(점|사실)을\s+알게\s*되면서\s+(생각|관점|인식)이\s+(?:달라졌다|바뀌었다|달라졌습니다|바뀌었습니다)[.!?]?$/u;
      const matches = sources.map(span => ({span, evidence: evidencePattern.exec(span.text)}))
        .filter(({span,evidence}) => evidence && compact(tail).length >= 10
          && evidence[1] === reflection[1] && evidence[2] === reflection[2]
          && compact(span.text.slice(0, evidence.index)).endsWith(compact(tail)));
      if (matches.length === 1) {
        const code = 'introduced_reflection_agency_shift';
        findings.push({code, ordinal:target.ordinal, repair:{
          start:target.start+reflection.index, end:target.end,
          replacement:matches[0].evidence[0], ordinal:target.ordinal, code
        }});
      }
    }
    const ranked = sources.map(span => ({ span, score: sentenceSimilarity(span.text, target.text) }))
      .sort((a,b) => b.score-a.score);
    const best = ranked[0];
    if (!best || best.score < .5 || (ranked[1] && best.score-ranked[1].score < .1)) continue;
    const original = best.span.text;
    if (original === target.text) continue;
    // Restore the source's evidential frame, not arbitrary repeated 은/는.
    // Contrast topics and a setting already present in SOURCE are valid.
    if (evidenceFrame && /(?:결론\s*내|결론을\s*내|판단하|판단했|확인하|확인했)/u.test(target.text)
        && !/(?:반면|한편|각각|대조)/u.test(target.text)) {
      const sourceFrame = new RegExp(`${escape(evidenceFrame[1])}(?:을|를)\\s+통해(?=\\s)`, 'u').exec(original);
      const sourceTopic = new RegExp(`${escape(evidenceFrame[2])}(?:은|는)(?=\\s)`, 'u').test(original);
      if (sourceFrame && sourceTopic) {
        const start = target.start + target.text.indexOf(evidenceFrame[1]);
        const code = 'introduced_evidential_topic_frame';
        findings.push({ code, ordinal: target.ordinal, repair: {
          start, end: start + evidenceFrame[1].length + '에서는'.length,
          replacement: sourceFrame[0], ordinal: target.ordinal, code
        }});
      }
    }
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
