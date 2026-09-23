'use strict';

const { syntaxSpans } = require('../engine/textSyntax');

// Restrict this lexical repair to unchanged Korean heads + unchanged balanced
// annotations with a correct source particle. Do not guess pronunciation of
// Latin names/numbers or interpret a parenthetical as a new grammatical head.
function candidates(value) {
  const text = String(value || ''), spans = syntaxSpans(text);
  const protectedSpans = spans.filter(s => s.spanType === 'quote' || s.spanType === 'code');
  // Pasted documents also mix straight and curved quotation delimiters. Be
  // conservative here without changing the shared sentence parser's policy.
  for (const match of text.matchAll(/(?:“[^”"]*[”"]|"[^"”]*["”]|‘[^’']*[’']|(?<![\p{L}\p{N}])'[^'’]*['’])/gu)) {
    protectedSpans.push({start:match.index,end:match.index+match[0].length});
  }
  return spans.filter(s => s.spanType === 'parenthetical' && /[（(]/u.test(text[s.start]))
    .flatMap(span => {
      if (spans.some(s => s !== span && s.start < span.start && s.end >= span.end)) return [];
      const head = text.slice(0, span.start).match(/(?:^|[\s,:;])([가-힣]{2,})[ \t]*$/u);
      const particle = text.slice(span.end).match(/^(으로|로)(?=\s|[,.;!?]|$)/u);
      if (!head || !particle) return [];
      const start = span.start - head[0].length;
      if (protectedSpans.some(s => s.start < span.end + particle[0].length && s.end > start)) return [];
      const noun = head[1], jong = (noun.charCodeAt(noun.length - 1) - 0xac00) % 28;
      const expected = jong === 0 || jong === 8 ? '로' : '으로';
      const key = noun + text.slice(span.start, span.end).replace(/\s+/gu, '');
      return [{ key, expected, particle:particle[0], start:span.end, end:span.end + particle[0].length }];
    });
}

function repairParentheticalParticles(source, output) {
  const sourceCandidates = candidates(source), byKey = new Map();
  for (const candidate of sourceCandidates) {
    const values = byKey.get(candidate.key) || new Set();
    values.add(candidate.particle); byKey.set(candidate.key, values);
  }
  const edits = candidates(output).filter(c => c.particle !== c.expected
    && byKey.get(c.key)?.size === 1 && byKey.get(c.key).has(c.expected));
  let text = String(output || '');
  for (const edit of edits.sort((a,b) => b.start-a.start)) {
    text = text.slice(0, edit.start) + edit.expected + text.slice(edit.end);
  }
  return { text, repairCount:edits.length };
}

module.exports = { repairParentheticalParticles };
