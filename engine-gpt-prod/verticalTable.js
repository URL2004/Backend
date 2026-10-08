'use strict';

// Clipboard tables can arrive as one cell per line without tabs or pipes.
// Protect evidenced cell sequences, never invent a rectangular representation.
function verticalTableIndices(records, excluded = new Set()) {
  const result = new Set();
  const header = /^(?:항목|구분|영역|상황|목적|[^.!?\n]{1,22}(?:유형|종류|사례|특징|주의점|고려사항|경로|의미|기준|장점|단점|내용|방법|비용|기간|요인|과제|대책|지표))$/u;
  let group = [];
  const flush = () => {
    if (group.length >= 9 && group.length <= 300) {
      const text = group.map(r => r.text.trim());
      // Multiple adjacent header labels plus repeated short row keys are
      // required. A mere run of short prose/verse lines is not table evidence.
      for (let width = 3; width <= 6; width++) {
        if (Math.floor(text.length / width) < 3) continue;
        const labels = text.slice(0, width);
        const peers = labels.slice(1);
        const parallel = peers.length >= 3 && new Set(peers).size === peers.length
          && peers.every(s => s.length >= 3 && s.length <= 12 && !/\s/u.test(s)
            && s.slice(-2) === peers[0].slice(-2));
        if (!header.test(labels[0]) || (!parallel && labels.filter(s => header.test(s)).length < 2)
            || labels.some(s => s.length > 28)) continue;
        // A partially copied last row must retain its physical cells too.
        // Require every header to be explicit before accepting a ragged tail;
        // this protects the source, without guessing missing cells or columns.
        if (text.length % width && !labels.every(s => header.test(s))) continue;
        const keys = text.filter((_, i) => i >= width && i % width === 0);
        if (new Set(keys).size !== keys.length || keys.some(s => s.length > 22)) continue;
        for (const row of group) result.add(row.index);
        break;
      }
    }
    group = [];
  };
  for (const r of records) {
    const s = r.text.trim();
    if (!s || excluded.has(r.index) || s.length > 90
        || /[.!?。！？][”’"')\]]*$|(?:습니다|한다|이다|했다|된다)$/u.test(s)
        || /^(?:#{1,6}\s|>|[-*•]\s|\d+[.)]\s|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ][.)]|[①-⑳]|[“‘「『"'])/u.test(s)
        || /[\t|]/u.test(s)) { flush(); continue; }
    group.push(r);
  }
  flush();
  return result;
}

module.exports = { verticalTableIndices };
