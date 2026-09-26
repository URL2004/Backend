'use strict';

const { syntaxSpans } = require('../engine/textSyntax');
const TOP = /^(?:#{1}\s|[IVXLCDMⅠⅡⅢⅣⅤⅥ]+[.．)]?\s|제\s*\d+\s*장|(?:서론|본론|결론|참고\s*문헌|목차)$)/u;
const NUMBERED = /^(?:#+\s*)?(?:\d+[.)]|\d+(?:\.\d+)+\s|[가-하][.)])/u;

// Recognize literal chart layout only with a caption, at least three monotonic
// vertical ticks and a separate horizontal numeric axis. Do not infer cells,
// values or an absent chart from prose mentioning decimals or years.
function numericSeriesRanges(records, source) {
  const number = /^[+\-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?[%％]?$/u;
  const numericValue = value => Number(value.replace(/[,％%]/gu, '').replace('−', '-'));
  const nonEmpty = records.filter(r => r.raw.trim());
  const spans = syntaxSpans(source);
  const ranges = new Map();
  let references = false;
  for (let i = 0; i < nonEmpty.length; i++) {
    const caption = nonEmpty[i], label = caption.raw.trim();
    if (['heading', 'title'].includes(caption.role) && /참고\s*문헌|references|bibliography/iu.test(label)) references = true;
    if (references || !['prose', 'body', 'text', 'heading', 'title'].includes(caption.role)
        || label.length > 100 || !/[\p{L}]/u.test(label) || TOP.test(label) || NUMBERED.test(label)
        || /[\t|]|[.!?。！？:：]$|(?:다|요|니다)$/u.test(label)) continue;
    let end = i + 1;
    const ticks = [];
    while (end < nonEmpty.length && ticks.length < 32 && number.test(nonEmpty[end].raw.trim())
        && ['prose', 'body', 'text'].includes(nonEmpty[end].role)) {
      ticks.push(numericValue(nonEmpty[end].raw.trim())); end++;
    }
    if (ticks.length < 3 || end >= nonEmpty.length) continue;
    const direction = Math.sign(ticks[1] - ticks[0]);
    if (!direction || ticks.some((value, n) => n && Math.sign(value - ticks[n - 1]) !== direction)) continue;
    const axis = nonEmpty[end];
    const labels = axis.raw.trim().split(/[ \t]+/u);
    if (labels.length < 2 || labels.length > 32 || !labels.every(value => number.test(value))
        || !['prose', 'body', 'text', 'table'].includes(axis.role)
        || axis.index - caption.index > 100
        || spans.some(span => span.start < axis.end && span.end > caption.start)) continue;
    ranges.set(caption.index, axis.index);
    i = end;
  }
  return ranges;
}

module.exports = { numericSeriesRanges };
