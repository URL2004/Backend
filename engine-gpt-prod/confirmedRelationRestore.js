'use strict';

const { splitSentenceSpans } = require('../engine/koreanText');
const { syntaxSpans } = require('../engine/textSyntax');
const { sentenceSimilarity } = require('./sentenceAlignment');
const { auditRelationCandidates } = require('./relationAudit');

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
  for (let i = 0; i < results.length && replacements.length < limit; i++) {
    const target = results[i];
    if (!violations.some(v => { const start = text.indexOf(v.span); return start >= target.start && start + v.span.length <= target.end; })) continue;
    if (!candidates.some(c => c.outputOrdinal === i + 1 && ['certainty_scope_candidate', 'comparison_negation_candidate', 'action_direction_candidate', 'technical_concept_substitution_candidate'].includes(c.code))) continue;
    const ranked = originals.map((s, index) => ({ index, score: sentenceSimilarity(s.text, target.text) })).sort((a,b) => b.score-a.score);
    const best = ranked[0];
    if (!best || best.score < .55 || (ranked[1] && best.score - ranked[1].score < .08)) continue;
    const original = originals[best.index];
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
  for (const r of replacements.reverse()) restored = restored.slice(0,r.start) + r.text + restored.slice(r.end);
  return { text: restored, applied: restored !== text, restoredCount: replacements.length };
}

module.exports = { restoreConfirmedRelations };
