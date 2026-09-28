'use strict';

const { splitSentenceSpans } = require('../engine/koreanText');
const { syntaxSpans } = require('../engine/textSyntax');
const { sentenceSimilarity } = require('./sentenceAlignment');
const { auditRelationCandidates, hasAdjacentRelationCoverage } = require('./relationAudit');
const PAIRED_RESTORATION_TYPES = Object.freeze(['distortion', 'omission', 'scope_expansion', 'experience_novelty', 'intensity_amplification']);

// A relation heuristic is not proof. Only a judge-confirmed, uniquely grounded
// distortion may nominate a sentence; mutual, unambiguous one-to-one matching
// supplies its original. The caller must verify the resulting candidate again.
function restoreConfirmedRelations(source, output, report, { priorReports = [] } = {}) {
  const text = String(output || '');
  const unchanged = { text, applied: false, restoredCount: 0 };
  if (!canNominateConfirmed(report)) return unchanged;
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
  // Exact paired findings do not use guessed nearest-sentence ownership. They
  // may nominate up to eight local windows, still bounded by half the sentence
  // count and 30% of both replaced and replacement text. Legacy retrieval
  // keeps its original four-window cap. Every proposal needs a fresh verdict.
  const pairedLimit = Math.min(8, Math.floor(results.length / 2));
  if (!limit) return unchanged;
  const candidates = auditRelationCandidates(source, text).candidates;
  const violations = (report.uncertain ? [] : report.violations || []).filter(v => v.type === 'distortion'
    // A paired finding that fails its stronger ownership/budget checks must
    // not bypass them through the legacy nearest-sentence route below.
    && !Object.hasOwn(v, 'sourceSpan') && !Object.hasOwn(v, 'candidateSpan')
    && v.spanVerified === true && v.repairable === true && v.grounding === 'unique_exact_span'
    && typeof v.span === 'string' && v.span.length >= 8
    && text.indexOf(v.span) >= 0 && text.indexOf(v.span) === text.lastIndexOf(v.span));
  const replacements = [];
  // The relation may cover an antecedent plus its next sentence (3 -> 2 is a
  // legitimate rewrite). Restore only an exact, judge-confirmed paired window,
  // never an inferred insertion. Full sentence boundaries, stable quotations,
  // source order and downstream integrity/re-judging remain mandatory.
  const rawOriginals = splitSentenceSpans(String(source || ''));
  const completeWindow = (spans, start, end, limit = 3, leadingBoundary = false) => (leadingBoundary || spans.some(s => s.start === start))
    && spans.some(s => s.end === end) && spans.filter(s => s.end > start && s.start < end).length <= limit;
  const protectedText = s => syntaxSpans(s).filter(p => p.spanType !== 'parenthetical')
    .map(p => {
      const literal = s.slice(p.start,p.end);
      // Paired semantic evidence may contain straight/typographic variants of
      // the SAME quotation. Canonicalize only matched outer glyphs, never the
      // contents, quote class, nested marks, whitespace or code literals.
      if (p.spanType === 'quote' && /^(?:'[^]*'|‘[^]*’)$/u.test(literal)) return 'single:' + literal.slice(1,-1);
      if (p.spanType === 'quote' && /^(?:"[^]*"|“[^]*”)$/u.test(literal)) return 'double:' + literal.slice(1,-1);
      return p.spanType + ':' + literal;
    }).sort().join('\n');
  const pairedFindings = collectPairedNominations(report, priorReports)
    .sort((left, right) => String(source).indexOf(left.sourceSpan) - String(source).indexOf(right.sourceSpan)
      || text.indexOf(left.candidateSpan) - text.indexOf(right.candidateSpan));
  for (const v of pairedFindings) {
    if (replacements.length >= pairedLimit || v.origin !== 'introduced' || v.relationGrounded !== true
        || !['actor_action_target','condition_result','quantity_target','variable_definition',
          'antecedent','modality_negation_causality','genre_naturalness','other'].includes(v.relation)) continue;
    const a=String(v.sourceSpan||''),b=String(v.candidateSpan||'');
    const from=String(source).indexOf(a),start=text.indexOf(b),end=start+b.length;
    const sourcePrefix = boundaryPrefix(rawOriginals,from,String(source));
    const outputPrefix = boundaryPrefix(results,start,text);
    const sharedLeadingBoundary = sourcePrefix !== null && sourcePrefix === outputPrefix
      && uniqueProtectedLines(sourcePrefix,String(source),text);
    const minimal = restoreConfirmedAlternative(a, b, v)
      || require('./confirmedMicroRepair').confirmedMicroRepair(a, b, v);
    if(a.length<20||b.length<20||a.length>700||b.length>700||a.length/b.length>2.5
      ||from<0||start<0||String(source).indexOf(a,from+1)>=0||text.indexOf(b,start+1)>=0
      ||!completeWindow(rawOriginals,from,from+a.length,minimal?6:3,sharedLeadingBoundary)||!completeWindow(results,start,end,minimal?6:3,sharedLeadingBoundary)
      // Multi-sentence paraphrases need not share single-sentence surface
      // similarity. This is proposal retrieval only; the exact paired judge
      // finding and the caller's fresh semantic pass are the safety gates.
      ||(!minimal && sentenceSimilarity(a,b)<.35)||protectedText(a)!==protectedText(b)
      ||(!minimal && require('./restorationOwnership').hasOutsideSourceContribution(String(source),from,from+a.length,b,a))
      ||(!minimal && hasAdjacentRelationCoverage(a,b,text))
      ||!sameProtectedPrefix(a,b,String(source),text)
      ||replacements.some(r=>start<r.end&&end>r.start||from<r.sourceEnd||start<=r.start)
      ||replacements.reduce((n,r)=>n+r.end-r.start,0)+b.length>text.length*.3
      ||replacements.reduce((n,r)=>n+r.text.length,0)+(minimal || a).length>text.length*.3)continue;
    replacements.push({start,end,text:minimal || a,sourceStart:from,sourceEnd:from+a.length,sourceIndex:rawOriginals.findIndex(s=>s.start===from)});
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
    if(require('./restorationOwnership').hasOutsideSourceContribution(String(source),original.start,original.end,target.text,original.text))continue;
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

// The sentence analyzer may include a standalone heading with its first body
// sentence. A paired repair can retain that EXACT, unique leading heading;
// it cannot copy a changed heading, cross a later structural block, or infer
// a missing label. All complete-window, ownership and fresh-audit gates apply.
function sameProtectedPrefix(a,b,source,output) {
  const records=s=>require('./layoutStructure').buildLineRecords(s).filter(r=>!r.blank);
  const split=s=>{
    const rows=records(s), firstBody=rows.findIndex(r=>r.role==='prose');
    if(firstBody<0)return null;
    const prefix=rows.slice(0,firstBody),body=rows.slice(firstBody);
    if(body.some(r=>r.role!=='prose')||prefix.some(r=>!['title','heading','label','list'].includes(r.role)
      ||r.raw.length>60||/[.!?。！？]$/u.test(r.raw.trim())))return null;
    return prefix.map(r=>r.raw);
  };
  const left=split(a),right=split(b);
  if(!left||!right||left.length!==right.length||left.some((line,i)=>line!==right[i]))return false;
  return left.every(line=>[source,output].every(document=>document.split(/\r?\n/u).filter(l=>l===line).length===1));
}

function boundaryPrefix(spans,start,text) {
  const span=spans.find(s=>s.start<start&&s.end>start);
  if(!span)return null;
  const prefix=text.slice(span.start,start);
  return /\n[ \t]*$/u.test(prefix)?prefix:null;
}
function uniqueProtectedLines(prefix,source,output) {
  const rows=require('./layoutStructure').buildLineRecords(prefix).filter(r=>!r.blank);
  return rows.length>0&&rows.every(r=>['title','heading','label','list'].includes(r.role)
    &&r.raw.length<=60&&!/[.!?。！？]$/u.test(r.raw.trim())
    &&[source,output].every(document=>document.split(/\r?\n/u).filter(line=>line===r.raw).length===1));
}

// If a source sentence was legitimately split, copying it back can duplicate
// its continuation. For a CONFIRMED alternative/conjunction finding only,
// restore the attested connective between identical operands instead. All
// paired grounding, window, ordering, quote, budget and re-judge gates remain.
function restoreConfirmedAlternative(source, candidate, finding) {
  if (finding.type !== 'distortion' || finding.relation !== 'modality_negation_causality'
      || finding.spanVerified !== true || String(finding.span || '').length < 8) return '';
  const changes = [];
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  for (const match of source.matchAll(/(?<![가-힣])([가-힣]{2,16}?)(?:이나|나)[ \t]+((?:[가-힣]{1,12}[ \t]+)?[가-힣]{2,16}?)(?=(?:을|를|에|의|이|가|은|는)(?:[ \t]|$))/gu)) {
    const pattern = new RegExp(`(?<![가-힣])${escape(match[1])}(?:과|와)[ \\t]+${escape(match[2])}(?=(?:을|를|에|의|이|가|은|는)(?:[ \\t]|$))`, 'gu');
    for (const target of candidate.matchAll(pattern)) {
      if (!String(finding.span).includes(target[0])) continue;
      if (syntaxSpans(candidate).some(p => p.start < target.index + target[0].length && p.end > target.index)) continue;
      changes.push({ start: target.index, end: target.index + target[0].length, text: match[0] });
    }
  }
  if (changes.length !== 1) return '';
  const change = changes[0];
  return candidate.slice(0, change.start) + change.text + candidate.slice(change.end);
}

// A later judge can omit a previously confirmed finding without repairing its
// text. Preserve that finding only as a proposal, never as the official verdict.
// Stale/ambiguous source or candidate pairs are rejected again by the exact
// complete-window checks above. No taxonomy inference or fuzzy relocation.
function collectPairedNominations(report, priorReports) {
  const findings = [], seen = new Set(), visited = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object' || visited.has(value) || findings.length >= 64) return;
    visited.add(value);
    // One ungrounded finding must not veto an unrelated, exactly grounded
    // introduced error. This only nominates a bounded source replacement;
    // uncertainty is never cleared here and a fresh whole verdict is required.
    if (!canNominateConfirmed(value)) return;
    for (const v of [...(value.violations || []), ...(value.initialViolations || [])]) {
      if (findings.length >= 64) break;
      if (!PAIRED_RESTORATION_TYPES.includes(v?.type) || v.origin !== 'introduced'
          || v.relationGrounded !== true || v.repairable !== true || v.grounding !== 'unique_exact_span'
          || typeof v.sourceSpan !== 'string' || typeof v.candidateSpan !== 'string') continue;
      const key = `${v.sourceSpan}\u0000${v.candidateSpan}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(v);
    }
    for (const child of Array.isArray(value.reports) ? value.reports : []) visit(child);
    for (const child of Array.isArray(value.restorationNominationReports) ? value.restorationNominationReports : []) visit(child);
  };
  visit(report);
  for (const prior of Array.isArray(priorReports) ? priorReports : []) visit(prior);
  return findings;
}

function canNominateConfirmed(report) {
  if (!report || report.pass !== false || report.skipped || report.verificationCompleted === false) return false;
  // Only split an aggregate uncertainty with an explicit unresolved member.
  // An unexplained global uncertainty (e.g. incomplete correspondence) must
  // not be downgraded just because the surviving findings look grounded.
  return !report.uncertain || (report.violations || []).some(v => v?.origin === 'unconfirmed'
    || v?.repairable === false || v?.relationGrounded === false);
}

function assessConfirmedRestorationSafety(safety) {
  if (safety?.pass === true) return { eligible: true, warnings: [] };
  const integrity = safety?.sharedIntegrity || safety;
  const korean = integrity?.candidate?.korean;
  const before = integrity?.before?.korean;
  const oldCounts = before?.issueCounts, newCounts = korean?.issueCounts;
  // A pre-existing warning elsewhere must not veto restoring an attested
  // source register. Compare every family; never allow a NEW non-register
  // defect or a newly introduced register expression through this exception.
  const registerOnlyDelta = oldCounts && newCounts
    && Number(newCounts.formal_register_residual?.count || 0) > Number(oldCounts.formal_register_residual?.count || 0)
    && Number(newCounts.formal_register_residual?.introduced || 0) === 0
    && Number(korean.introducedIssueCount || 0) <= Number(before.introducedIssueCount || 0)
    && Object.entries(newCounts).every(([code, value]) => code === 'formal_register_residual'
      || (Number(value.count || 0) <= Number(oldCounts[code]?.count || 0)
        && Number(value.introduced || 0) <= Number(oldCounts[code]?.introduced || 0)));
  // Copying an attested source sentence may restore its informal connector.
  // That is not a NEW grammar error and cannot outrank the confirmed meaning
  // repair. This exception is only for this exact-source proposal; the caller
  // still needs a fresh semantic pass, and preserves the register warning.
  const sourceRegisterOnly = safety?.reasons?.length > 0
    && safety.reasons.every(reason => reason === 'korean_integrity_worsened')
    && (registerOnlyDelta || (korean?.introducedIssueCount === 0 && korean.issueCodes?.length > 0
      && korean.issueCodes.every(code => code === 'formal_register_residual')));
  return { eligible: sourceRegisterOnly, warnings: sourceRegisterOnly ? ['restored_source_register'] : [] };
}

module.exports = { restoreConfirmedRelations, assessConfirmedRestorationSafety, PAIRED_RESTORATION_TYPES };
