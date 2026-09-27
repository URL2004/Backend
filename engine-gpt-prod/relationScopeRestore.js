'use strict';

const { splitSentenceSpans } = require('../engine/koreanText');
const { syntaxSpans } = require('../engine/textSyntax');
const { sentenceSimilarity } = require('./sentenceAlignment');

// Restore only an attested particle/frame on an identical nominal anchor.
// This is a proposal before final semantic verification, never a pass verdict.
const RULES = [
  { code: 'comparison_exclusion', source: /(?<![가-힣])(?<anchor>(?!무엇|누구)[가-힣]{2,20})(?<frame>보다는|보다)(?=\s)/gu,
    target: anchor => `${anchor}(?:이|가)\\s+아니라(?=\\s)` },
  { code: 'concession_sufficiency', source: /(?<![가-힣])(?<anchor>[가-힣]{2,20})(?<frame>(?:이|가)\s+있어도)(?=\s)/gu,
    target: anchor => `${anchor}만으로(?:는)?(?=\\s)` }
];

function restoreRelationScopes(source, output) {
  source = String(source || '');
  const text = String(output || '');
  const before = splitSentenceSpans(source), after = splitSentenceSpans(text);
  const protectedSource = syntaxSpans(source).filter(s => s.spanType !== 'parenthetical');
  const protectedOutput = syntaxSpans(text).filter(s => s.spanType !== 'parenthetical');
  const overlaps = (ranges, start, end) => ranges.some(s => s.start < end && s.end > start);
  const changes = [];
  for (const rule of RULES) for (const original of before) {
    for (const match of original.text.matchAll(rule.source)) {
      if (changes.length >= 8) break;
      const from = original.start + match.index;
      if (overlaps(protectedSource, from, from + match[0].length)) continue;
      const anchor = match.groups.anchor;
      const clause = original.text.slice(original.text.lastIndexOf(',', match.index) + 1).trim();
      const similarity = value => Math.max(sentenceSimilarity(original.text, value), sentenceSimilarity(clause, value));
      const pattern = new RegExp(`(?<![가-힣])${rule.target(anchor)}`, 'gu');
      const candidates = after.flatMap(span => [...span.text.matchAll(pattern)].map(target => ({
        span, target, score: similarity(span.text)
      }))).sort((a, b) => b.score - a.score);
      const best = candidates[0];
      const prefix = original.text.slice(0, match.index).match(/(?:[가-힣]+\s+){2,3}$/u)?.[0] || '';
      const specificAnchor = prefix.length >= 7 && best?.span.text.slice(0,best.target.index).endsWith(prefix);
      if (!best || best.score < (specificAnchor ? 0.35 : 0.55)
          || (candidates[1] && best.score - candidates[1].score < 0.10)) continue;
      // A different source sentence, including one with legitimate exclusion,
      // must not own this output. Repeated equal source sentences abstain too.
      if (before.some(span => span !== original && sentenceSimilarity(span.text, best.span.text) + 0.10 >= best.score)) continue;
      if (text.slice(best.span.start, best.span.end) !== best.span.text) continue;
      const start = best.span.start + best.target.index, end = start + best.target[0].length;
      if (overlaps(protectedOutput, start, end) || overlaps(changes, start, end)) continue;
      // Never turn a source's own explicit exclusion into a mere comparison.
      if (new RegExp(rule.target(anchor), 'u').test(original.text)) continue;
      // Particle-only restoration may create "...할 때도 ... 있어도".
      // In that case restore the uniquely aligned source clause, not invented
      // grammar or the entire document. Existing quoted/code clauses abstain.
      const clauseStart = best.span.text.lastIndexOf(',', best.target.index) + 1;
      const targetPrefix = best.span.text.slice(clauseStart, best.target.index);
      if (rule.code === 'concession_sufficiency' && /때도\s/u.test(targetPrefix)
          && !/때도\s/u.test(clause)) {
        const left = best.span.start + clauseStart;
        const right = best.span.end;
        if (clause.length <= 250 && right-left <= 250
            && !overlaps(protectedOutput,left,right) && !overlaps(changes,left,right)
            && !syntaxSpans(clause).some(s=>s.spanType!=='parenthetical')) {
          changes.push({start:left,end:right,text:(clauseStart ? ' ' : '')+clause,code:rule.code});
        }
        continue;
      }
      changes.push({ start, end, text: match[0], code: rule.code });
    }
  }
  let restored = text;
  for (const item of changes.sort((a, b) => b.start - a.start)) {
    restored = restored.slice(0, item.start) + item.text + restored.slice(item.end);
  }
  return { text: restored, applied: restored !== text, restoredCount: changes.length,
    codes: [...new Set(changes.map(item => item.code))] };
}

module.exports = { restoreRelationScopes };
