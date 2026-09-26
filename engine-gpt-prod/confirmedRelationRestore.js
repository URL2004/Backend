'use strict';

const { splitSentenceSpans } = require('../engine/koreanText');
const { syntaxSpans } = require('../engine/textSyntax');
const { sentenceSimilarity } = require('./sentenceAlignment');
const { auditRelationCandidates, hasAdjacentRelationCoverage } = require('./relationAudit');

// A relation heuristic is not proof. Only a judge-confirmed, uniquely grounded
// distortion may nominate a sentence; mutual, unambiguous one-to-one matching
// supplies its original. The caller must verify the resulting candidate again.
function restoreConfirmedRelations(source, output, report) {
  const text = String(output || '');
  const unchanged = { text, applied: false, restoredCount: 0 };
  if (!report || report.pass !== false || report.uncertain || report.skipped) return unchanged;
  const originals = splitSentenceSpans(String(source || '')).map(s => {
    const lines = s.text.split(/\r?\n/u);
    // Some sources attach standalone labels to the first sentence. They may
    // be omitted from the replacement only when every prefix is already an
    // intact, unique standalone line in the result (never recreate a label).
    if (lines.length > 1 && lines.slice(0,-1).every(line => {
      const label = line.trim();
      return label.length > 0 && label.length <= 60
        && text.split(/\r?\n/u).filter(l => l.trim() === label).length === 1;
    })) return { ...s, text: lines.at(-1), prefixes: lines.slice(0,-1) };
    return s;
  });
  const results = splitSentenceSpans(text);
  const limit = Math.min(4, Math.floor(results.length / 2));
  if (!limit) return unchanged;
  const candidates = auditRelationCandidates(source, text).candidates;
  const violations = (report.violations || []).filter(v => v.type === 'distortion'
    && v.spanVerified === true && v.repairable === true && v.grounding === 'unique_exact_span'
    && typeof v.span === 'string' && v.span.length >= 8
    && text.indexOf(v.span) >= 0 && text.indexOf(v.span) === text.lastIndexOf(v.span));
  const replacements = [];
  // The relation may cover an antecedent plus its next sentence (3 -> 2 is a
  // legitimate rewrite). Restore only an exact, judge-confirmed paired window,
  // never an inferred insertion. Full sentence boundaries, stable quotations,
  // source order and downstream integrity/re-judging remain mandatory.
  const rawOriginals = splitSentenceSpans(String(source || ''));
  const completeWindow = (spans, start, end) => spans.some(s => s.start === start)
    && spans.some(s => s.end === end) && spans.filter(s => s.start >= start && s.end <= end).length <= 3;
  const protectedText = s => syntaxSpans(s).filter(p => p.spanType !== 'parenthetical')
    .map(p => s.slice(p.start,p.end)).sort().join('\n');
  const pairedFindings=(report.violations||[]).filter(v=>['distortion','omission'].includes(v.type)
    && v.repairable===true && v.grounding==='unique_exact_span');
  for (const v of pairedFindings) {
    if (replacements.length >= limit || v.origin !== 'introduced' || v.relationGrounded !== true
        || !['actor_action_target','condition_result','quantity_target','variable_definition',
          'antecedent','modality_negation_causality'].includes(v.relation)) continue;
    const a=String(v.sourceSpan||''),b=String(v.candidateSpan||'');
    const from=String(source).indexOf(a),start=text.indexOf(b),end=start+b.length;
    if(a.length<20||b.length<20||a.length>700||b.length>700||a.length/b.length>2.5
      ||from<0||start<0||String(source).indexOf(a,from+1)>=0||text.indexOf(b,start+1)>=0
      ||!completeWindow(rawOriginals,from,from+a.length)||!completeWindow(results,start,end)
      // Multi-sentence paraphrases need not share single-sentence surface
      // similarity. This is proposal retrieval only; the exact paired judge
      // finding and the caller's fresh semantic pass are the safety gates.
      ||sentenceSimilarity(a,b)<.35||protectedText(a)!==protectedText(b)
      ||hasAdjacentRelationCoverage(a,b,text)
      ||[a,b].some(s=>require('./layoutStructure').buildLineRecords(s).some(r=>!r.blank&&r.role!=='prose'))
      ||replacements.some(r=>start<r.end&&end>r.start||from<=r.sourceStart)
      ||replacements.reduce((n,r)=>n+r.end-r.start,0)+b.length>text.length*.3)continue;
    replacements.push({start,end,text:a,sourceStart:from,sourceIndex:rawOriginals.findIndex(s=>s.start===from)});
  }
  for (let i = 0; i < results.length && replacements.length < limit; i++) {
    const target = results[i];
    if(replacements.some(r=>target.start<r.end&&target.end>r.start))continue;
    const located = violations.filter(v => { const start = text.indexOf(v.span); return start >= target.start && start + v.span.length <= target.end; });
    if (!located.length) continue;
    // A paired, introduced relation finding is stronger than a keyword hint.
    // It still needs the same reciprocal, unambiguous sentence alignment below;
    // a guessed source span or merged/split target is never enough to restore.
    const paired = located.filter(v => v.origin === 'introduced' && v.relationGrounded === true
      && ['actor_action_target','condition_result','quantity_target','variable_definition',
        'modality_negation_causality'].includes(v.relation)
      && v.candidateSpan === target.text);
    if (!paired.length && !candidates.some(c => c.outputOrdinal === i + 1 && ['certainty_scope_candidate', 'comparison_negation_candidate', 'action_direction_candidate', 'technical_concept_substitution_candidate'].includes(c.code))) continue;
    const ranked = originals.map((s, index) => ({ index, score: sentenceSimilarity(s.text, target.text) })).sort((a,b) => b.score-a.score);
    const best = ranked[0];
    if (!best || best.score < .55 || (ranked[1] && best.score - ranked[1].score < .08)) continue;
    const original = originals[best.index];
    if (paired.length && !paired.some(v => v.sourceSpan === original.text)) continue;
    if (original.prefixes?.some(label => text.indexOf(label.trim()) >= target.start)) continue;
    const reverse = results.map((s,index) => ({ index, score: sentenceSimilarity(original.text, s.text) })).sort((a,b) => b.score-a.score);
    if (reverse[0].index !== i || (reverse[1] && reverse[0].score - reverse[1].score < .08)) continue;
    // Do not copy section headings, quotations, or code through a sentence
    // replacement. Uncertain merged/split or reordered ownership is left alone.
    if ([original.text, target.text].some(s => /[\r\n]/u.test(s) || syntaxSpans(s).some(p => p.spanType !== 'parenthetical'))) continue;
    if (replacements.some(r => r.sourceIndex >= best.index)) continue;
    replacements.push({ start: target.start, end: target.end, text: original.text, sourceIndex: best.index });
  }
  let restored = text;
  for (const r of replacements.sort((a,b)=>b.start-a.start)) restored = restored.slice(0,r.start) + r.text + restored.slice(r.end);
  return { text: restored, applied: restored !== text, restoredCount: replacements.length };
}

function assessConfirmedRestorationSafety(safety) {
  if (safety?.pass === true) return { eligible: true, warnings: [] };
  const integrity = safety?.sharedIntegrity || safety;
  const korean = integrity?.candidate?.korean;
  // Copying an attested source sentence may restore its informal connector.
  // That is not a NEW grammar error and cannot outrank the confirmed meaning
  // repair. This exception is only for this exact-source proposal; the caller
  // still needs a fresh semantic pass, and preserves the register warning.
  const sourceRegisterOnly = safety?.reasons?.length > 0
    && safety.reasons.every(reason => reason === 'korean_integrity_worsened')
    && korean?.introducedIssueCount === 0 && korean.issueCodes?.length > 0
    && korean.issueCodes.every(code => code === 'formal_register_residual');
  return { eligible: sourceRegisterOnly, warnings: sourceRegisterOnly ? ['restored_source_register'] : [] };
}

module.exports = { restoreConfirmedRelations, assessConfirmedRestorationSafety };
