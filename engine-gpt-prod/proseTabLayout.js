'use strict';

// Word/PDF justification can export word spaces as tabs. A tab alone is not
// enough to discard a column: require a surrounding, complete prose paragraph
// and dependent Korean cell endings. Ambiguous/empty cells remain literal.
function proseTabLineIndices(source) {
  if (!String(source || '').includes('\t')) return new Set();
  const lines = String(source || '').split(/\r?\n/u), out = new Set();
  let group = [];
  const complete = s => /[가-힣]{2,}(?:다|요|니다)[.!?][”’"']?$/u.test(s.trim());
  const flush = () => {
    const plain = group.filter(r => !r.text.includes('\t'));
    const tabs = group.filter(r => r.text.includes('\t'));
    // A leading tab can be paragraph indentation, not an empty first cell.
    // Require an adjacent developed prose witness and no actual column
    // separators anywhere in this uninterrupted block. Lone/short rows and
    // a blank first cell under a TSV header remain tables.
    const developed = s => s.trim().length >= 100 && /[가-힣](?:다|요|니다)[.!?][”’"']?$/u.test(s.trim())
      && require('../engine/koreanText').splitSentenceSpans(s.trim()).length >= 2;
    const indentationOnly = s => /^[ ]*\t[ ]*\S/u.test(s)
      && !s.trimStart().includes('\t') && !/[|\x60]/u.test(s);
    if (group.length >= 2 && tabs.length && plain.length
        && !group.some(r => /[|\x60]|^\s*(?:>|#|\[표|표\s*\d)/u.test(r.text))
        && plain.every(r => developed(r.text) && !/\S {2,}\S/u.test(r.text))
        && tabs.every(r => indentationOnly(r.text) && developed(r.text))) {
      tabs.forEach(r => out.add(r.index));
    }
    if (group.length >= 6 && tabs.length && tabs.length <= group.length / 3
        && plain.filter(r => r.text.length >= 25).length >= 4
        && complete(group[0].text) && complete(group[group.length - 1].text)
        && !group.some(r => /[|`]|^\s*(?:>|#|[-*•]|\d+[.)]|[가-하][.)]|\[표|구분\s|항목\s)/u.test(r.text))) {
      const candidates = tabs.filter(r => {
        const cells = r.text.split('\t').map(s => s.trim());
        return cells.length >= 4 && cells.every(Boolean)
          && !cells.some(c => /^[\d+−-]/u.test(c) || /[:：]$/u.test(c))
          && cells.filter(c => /(?:은|는|이|가|을|를|의|만|라고|다고|라는|에도|한다[.!?])$/u.test(c)).length >= Math.ceil(cells.length / 2);
      });
      if (candidates.length === tabs.length) candidates.forEach(r => out.add(r.index));
    }
    group = [];
  };
  lines.forEach((text, index) => { if (!text.trim()) flush(); else group.push({text, index}); });
  flush();
  return out;
}
module.exports = { proseTabLineIndices };
