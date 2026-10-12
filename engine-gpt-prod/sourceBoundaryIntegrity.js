'use strict';

// Repair only whitespace with an exact, unique source witness. Never move a
// word, remove a footnote, infer a table cell, or guess a Korean word join.
const bare = s => String(s || '').replace(/\s/gu, '');
function projection(value) {
  let text = ''; const positions = [];
  for (let i = 0; i < value.length; i++) if (!/\s/u.test(value[i])) { text += value[i]; positions.push(i); }
  return { text, positions };
}
function uniqueAt(text, key) {
  const at = text.indexOf(key);
  return at >= 0 && at === text.lastIndexOf(key) ? at : -1;
}
function restoreSourceBoundaries(sourceText, outputText, { preserveLines = false } = {}) {
  const source = String(sourceText || ''), output = String(outputText || '');
  if (!source || !output || source === output || source.length > 100000 || output.length > 100000)
    return { text: output, repairCount: 0, codes: [] };
  const a = projection(source), b = projection(output), edits = [];
  let sourceLines;
  const protectedSpans = require('../engine/textSyntax').syntaxSpans(output).filter(s => s.spanType === 'code');
  const add = (start, end, text, code) => {
    if (protectedSpans.some(s => s.start < end && s.end > start)
      || edits.some(e => e.start < end && e.end > start)) return;
    edits.push({ start, end, text, code });
  };
  // URLs are literal atoms even in references. Source and output must contain
  // exactly one matching atom, permitting whitespace damage only.
  const urls = [...new Set(source.match(/https?:\/\/[^\s<>"'「」]+/gu) || [])].slice(0, 200);
  for (let url of urls) {
    url = url.replace(/[.,;。)\]]+$/u, '');
    if (url.length < 10 || url.length > 2048 || uniqueAt(a.text, url) < 0) continue;
    const at = uniqueAt(b.text, url);
    if (at < 0) continue;
    const start = b.positions[at], end = b.positions[at + url.length - 1] + 1;
    if (output.slice(start, end) !== url) add(start, end, url, 'source_url_whitespace_restored');
  }
  if (!preserveLines) {
    // A year split between digits is unambiguous when the source contains the
    // intact same year+unit, the left part follows prose, and no numeric row is
    // involved. The surrounding sentence may have been paraphrased.
    for (const m of output.matchAll(/(\d{1,3})([ \t]*\n[ \t]*)(\d{1,3})(?=년(?:[에은는이가을를의도]|\s|[.,]|$))/gu)) {
      const whole = m[1] + m[3];
      const row = output.slice(output.lastIndexOf('\n', m.index - 1) + 1, m.index);
      if (!/^(?:19|20|21)\d{2}$/u.test(whole) || !/[가-힣]/u.test(row)
          || /\t|\|/u.test(row) || !source.includes(whole + '년') && !source.includes(whole + ' 년')
          || source.includes(m[0])) continue;
      const context = whole + bare(output.slice(m.index + m[0].length, m.index + m[0].length + 70)).slice(0, 18);
      const at = uniqueAt(a.text, context);
      if (context.length < 18 || at < 0 || uniqueAt(b.text, context) < 0
          || source.slice(a.positions[at], a.positions[at + whole.length - 1] + 1) !== whole) continue;
      add(m.index + m[1].length, m.index + m[1].length + m[2].length, '', 'source_number_join_restored');
    }
    for (const m of output.matchAll(/\S([ \t]*\n[ \t\r\n]*)\S/gu)) {
      const start = m.index + 1, end = start + m[1].length;
      const left = bare(output.slice(Math.max(0, start - 70), start)).slice(-18);
      const right = bare(output.slice(end, end + 70)).slice(0, 18);
      if (left.length < 4 || right.length < 10 || left.length + right.length < 24) continue;
      const key = left + right, at = uniqueAt(a.text, key);
      if (at < 0 || uniqueAt(b.text, key) < 0) continue;
      const sourceStart = a.positions[at + left.length - 1] + 1;
      const sourceEnd = a.positions[at + left.length];
      const gap = source.slice(sourceStart, sourceEnd);
      if (!/^[ \t\r\n]*$/u.test(gap) || /\n\s*\n/u.test(gap)) continue;
      const digitSplit = /\d$/u.test(left) && /^\d/u.test(right) && gap === '';
      const promotedWrap = /\n\s*\n/u.test(m[1]) && /\n/u.test(gap)
        && !/[.!?。！？:：]["”’')\]]*$/u.test(left)
        && !require('./layoutStructure').isSentenceComplete(left);
      if (promotedWrap && !digitSplit) {
        sourceLines ||= require('./layoutStructure').buildLineRecords(source);
        const before = sourceLines.find(row => row.start <= sourceStart - 1 && row.end >= sourceStart);
        const after = sourceLines.find(row => row.start <= sourceEnd && row.end > sourceEnd);
        const instruction = before && after && /^\d{1,3}[.)]\s/u.test(before.text)
          && /(?:하시오|하세요|해\s*주세요|하여라|하라|할\s*것)[.!?。！？]?(?:\s*[（(]\d+(?:\.\d+)?\s*점[）)])?$/u.test(after.text);
        if (!instruction && [before,after].some(row => !row || !['prose','physical_word_continuation'].includes(row.role))) continue;
      }
      if (digitSplit || promotedWrap) add(start, end, gap, digitSplit ? 'source_number_join_restored' : 'source_physical_wrap_restored');
    }
  }
  let text = output;
  for (const e of edits.sort((x,y) => y.start-x.start)) text = text.slice(0,e.start)+e.text+text.slice(e.end);
  if (bare(text) !== bare(output)) return { text: output, repairCount: 0, codes: [] };
  return { text, repairCount: edits.length, codes: [...new Set(edits.map(e => e.code))] };
}

function auditIntroducedReferenceBreaks(source, output) {
  const old = bare(source), issues = [];
  for (const m of String(output || '').matchAll(/[（(]\s*(표|그림)\s*([IVXⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+|\d{1,2})\s*[-–]\s*(\d{1,3})\s*\n\s*(\d{1,3})(?=[）)])/gu)) {
    if (old.includes(bare(m[0])) || !old.includes(m[1]+m[2]+'-'+m[4])) continue;
    issues.push({code:'introduced_reference_number_interleaving',outputStart:m.index,outputEnd:m.index+m[0].length});
  }
  return issues.slice(0,20);
}
module.exports = { restoreSourceBoundaries, auditIntroducedReferenceBreaks };
