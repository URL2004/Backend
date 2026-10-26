'use strict';
const layout = require('./layoutStructure');
const bare = value => String(value || '').replace(/\s/gu, '');
const complete = value => /(?:[.!?。！？][”’"')\]]*|(?:한다|했다|된다|이다|있다|없다|습니다|어요))$/u.test(value);

// An exact, unique prefix of a complete source list sentence has been left
// as a hanging first paragraph. Its single following paragraph must still
// belong to the same numbered item. No fuzzy matching or whole-document
// replacement: only the uniquely owned source item is a repair candidate.
function findings(source, output, { preserveLines = false } = {}) {
  if (preserveLines || !/\n[ \t]*\n/u.test(output) || source.length > 50000 || output.length > 100000) return [];
  const S = layout.buildLineRecords(source), O = layout.buildLineRecords(output);
  const owned = S.map(row => ({ row, item: layout.listPrefixParts(row.text) })).filter(({ row, item }) =>
    item && /\s[-–—]\s/u.test(item.body) && complete(row.text) && item.body.length >= 60 && item.body.length <= 2000);
  if (!owned.length) return [];
  const issues = [];
  for (let i = 0; i < O.length; i++) {
    const row = O[i], item = layout.listPrefixParts(row.text);
    if (!item || complete(row.text) || item.body.split(/\s+/u).length < 8 || item.body.length > 300
        || !/\s[-–—]\s/u.test(item.body) || !O[i + 1]?.blank) continue;
    const matches = owned.filter(s => bare(s.item.prefix) === bare(item.prefix)
      && bare(s.item.body).startsWith(bare(item.body)) && s.item.body.length - item.body.length >= 20);
    if (matches.length !== 1) continue;
    let next = i + 1;
    while (O[next]?.blank) next++;
    const body = O[next];
    if (!body || body.role !== 'prose' || !complete(body.text)) continue;
    let end = next + 1;
    while (O[end]?.blank) end++;
    // A second prose paragraph might own independent claims. Abstain rather
    // than guessing how many sentences to replace or swallowing a new item.
    if (O[end] && !layout.listPrefixParts(O[end].text) && !['heading', 'title', 'label'].includes(O[end].role)) continue;
    if (row.text.length + body.text.length > matches[0].row.text.length * 1.6 + 30) continue;
    issues.push({ start: row.start, end: body.end, text: matches[0].row.text,
      code: 'introduced_dangling_list_prefix' });
    if (issues.length >= 8) break;
  }
  return issues;
}
function restore(source, output, options) {
  const issues = findings(source, output, options);
  let text = output;
  for (const issue of [...issues].reverse()) text = text.slice(0, issue.start) + issue.text + text.slice(issue.end);
  return { text, restoredCount: issues.length, applied: text !== output };
}
module.exports = { findings, restore };
