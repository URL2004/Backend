'use strict';

// Source-attested, whitespace-only repairs. A citation number is not a list
// label merely because a paragraphizer moved it to the start of a line.
const PAGE = /\bpp?\.[ \t\r\n]*\d+(?:[ \t]*[–—~-][ \t]*\d+)?/giu;
const NUMBER = /(?<![\d(])\d{1,4}\)/gu;
const bare = s => s.replace(/\s/gu, '');
function maskCode(text) {
  return text.replace(/(^[ \t]*(`{3,}|~{3,})[^\n]*\n)[\s\S]*?(?:^[ \t]*\2[^\n]*(?:\n|$)|$(?![\s\S]))|`[^`\n]*`/gmu,
    span => span.replace(/[^\r\n]/gu, ' '));
}
function inventory(text, pattern) {
  const masked = maskCode(text);
  return [...masked.matchAll(pattern)].map(m => ({ start: m.index, end: m.index + m[0].length,
    text: text.slice(m.index, m.index + m[0].length), key: bare(m[0]).toLowerCase() }));
}
function restoreInlineCitationLayout(source, output) {
  const src = String(source ?? '').replace(/\r\n?/g, '\n');
  const out = String(output ?? '').replace(/\r\n?/g, '\n');
  const edits = []; let unresolvedCount = 0;
  const sourcePages = inventory(src, PAGE), outputPages = inventory(out, PAGE);
  const pages = new Map();
  for (const p of sourcePages) { if (!pages.has(p.key)) pages.set(p.key, []); pages.get(p.key).push(p); }
  const outputGroups = new Map();
  for (const p of outputPages) { if (!outputGroups.has(p.key)) outputGroups.set(p.key, []); outputGroups.get(p.key).push(p); }
  for (const [key, originals] of pages) {
    const candidates = outputGroups.get(key) || [];
    if (candidates.length !== originals.length) { unresolvedCount++; continue; }
    candidates.forEach((p, i) => {
      // Preserve the source spelling and spacing inside the page atom only.
      const literal = originals[i].text.replace(/\s*\n\s*/gu, '');
      if (p.text.includes('\n') && p.text !== literal && bare(p.text).toLowerCase() === bare(literal).toLowerCase())
        edits.push({start:p.start, end:p.end, text:literal});
    });
  }
  const sourceNumbers = inventory(src, NUMBER), outputNumbers = inventory(out, NUMBER);
  let lineStart = 0, lineContentStart = 0, scanned = 0;
  const sourceGaps = [];
  const inline = sourceNumbers.map(p => {
    // Scan each source character once. Re-scanning the entire paragraph for
    // every footnote makes a dense 30,000-character input quadratic.
    while (scanned < p.start) {
      if (src[scanned] === '\n') lineStart = lineContentStart = scanned + 1;
      else if (lineContentStart === scanned && /\s/u.test(src[scanned])) lineContentStart++;
      scanned++;
    }
    let gapStart = p.start;
    while (gapStart > lineStart && /[ \t]/u.test(src[gapStart - 1])) gapStart--;
    sourceGaps.push(src.slice(gapStart, p.start));
    // Parenthesized page numbers are handled above. A genuine standalone
    // numbered item, equation, date, or code line is never an inline footnote.
    return gapStart - lineContentStart >= 8 && /[\p{L}.!?。！？”’"']/u.test(src[gapStart - 1] || '')
      && !/\bpp?\.$/iu.test(src.slice(Math.max(lineStart, gapStart - 4), gapStart))
      && !/[|\t]/u.test(src[lineStart] || '');
  });
  if (inline.some(Boolean)) {
    const aligned = sourceNumbers.length === outputNumbers.length
      && sourceNumbers.every((p,i) => p.key === outputNumbers[i].key);
    if (!aligned) unresolvedCount++;
    else outputNumbers.forEach((p,i) => {
      if (!inline[i]) return;
      let start=p.start; while (start>0 && /\s/u.test(out[start-1])) start--;
      if (!out.slice(start,p.start).includes('\n')) return;
      // No content is moved across another sentence: only the gap directly
      // before this same ordered occurrence can be changed.
      if (start===0 || !/[\p{L}.!?。！？”’"')\]]/u.test(out[start-1])) { unresolvedCount++; return; }
      edits.push({start,end:p.start,text:sourceGaps[i]});
    });
  }
  const chunks=[]; let cursor=0;
  for (const edit of edits.sort((a,b)=>a.start-b.start)) {
    if (edit.start<cursor) { unresolvedCount++; continue; }
    chunks.push(out.slice(cursor,edit.start),edit.text); cursor=edit.end;
  }
  chunks.push(out.slice(cursor));
  const text=chunks.join('');
  return {text, pass:unresolvedCount===0, repairCount:edits.length, unresolvedCount,
    contentPreserved:bare(text)===bare(out)};
}
module.exports={restoreInlineCitationLayout};
