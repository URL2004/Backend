'use strict';

// A PDF's physical rows are not paragraph or list ownership. Require repeated
// width AND independently witnessed word seams before changing blank lines.
// Only whitespace changes are permitted; explicit structure remains a barrier.
const { syntaxSpans } = require('../engine/textSyntax');
const { isRefHeadingLine } = require('../engine/freezeblocks');
const END = /[.!?。！？…][”’"'」』》〉)\]]*$/u;
const FINITE = /[가-힣]{2,}(?:습니다|입니다|합니다|됩니다|했다|한다|된다|이다|였다|있다|없다|않다)$/u;
const isComplete = text => END.test(text) || FINITE.test(text);
const REFERENCE = /^(?:\[|【)?(?:참고\s*문헌|참고\s*자료|References|Bibliography)(?:\]|】|\s|$)/iu;
const EXPLICIT = /^(?:#{1,6}\s|>|[-*+•▪◦·●○■□◆◇▶▷※]\s|\d+(?:\.\d+)*[.)]\s|[①-⑳]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)．]?\s|[IVX]+[.)]\s|제\s*\d+\s*(?:장|절|조)|\[[^\]\n]{1,80}\]$|【[^】\n]{1,80}】$)/u;
const NUMBERED = /^[가-하][.)](?=\s*\S)/u;
const stripParticle = word => word.replace(/(?:에서는|으로|에서|에게|처럼|은|는|이|가|을|를|의|와|과|도|만|에)$/u, '');
const isNominalHeading = text => !/[.!?。！？,]/u.test(text) && text.length <= 80
  && /(?:계획|현황|목적|방법|배경|필요성|분석|정의|개념|결과|시사점|참고문헌)$/u.test(text)
  && !/(?:은|는|을|를)\s/u.test(text);

function wordSeam(left, right, witnessed) {
  const a = left.match(/([가-힣]+)$/u)?.[1] || '';
  const b = right.match(/^([가-힣]+)(?=$|\s|[.,!?。！？(])/u)?.[1] || '';
  if (!a || !b) return false;
  if (/(?:습니?|[합입됩했겠였않없있]니)$/u.test(a) && /^(?:니다|다)$/u.test(b)) return true;
  if (a.length >= 1 && /^습니다$/u.test(b)) return true;
  if (/^[이그저]$/u.test(a) && /^(?:러한|렇게|런|렇다)$/u.test(b)) return true;
  if (/^(?:은|는|을|를|의|와|과|도|만|에서|에게|으로|까지|부터|처럼)(?:도|는|만)?$/u.test(b)) return true;
  if (/[하되]$/u.test(a) && /^(?:고|게|는|여|지|면|며|면서|었다|였다|도록)$/u.test(b)) return true;
  if (/^(?:다|니다|습니다)$/u.test(b)) return false;
  const full = stripParticle(a + b);
  return full.length >= 2 && full.length <= 16 && witnessed.has(full)
    && !(witnessed.has(stripParticle(a)) && witnessed.has(stripParticle(b)));
}

function repairPhysicalProseLines(value) {
  const source = String(value || '');
  const rows = []; let start = 0;
  for (const raw of source.split('\n')) { rows.push({ raw, text: raw.trim(), start, end: start + raw.length }); start += raw.length + 1; }
  const literals = syntaxSpans(source);
  const standaloneQuotes = literals.filter(span => {
    if (span.spanType !== 'quote' || !source.slice(span.start, span.end).includes('\n')) return false;
    const lineStart = source.lastIndexOf('\n', span.start - 1) + 1;
    const nextLine = source.indexOf('\n', span.end);
    const lineEnd = nextLine < 0 ? source.length : nextLine;
    return !source.slice(lineStart, span.start).trim() && !source.slice(span.end, lineEnd).trim();
  });
  const witnessed = new Set((source.match(/[가-힣]{2,}/gu) || []).map(stripParticle).filter(w => w.length >= 2));
  let references = false, fenced = false;
  for (const row of rows) {
    if (/^\s*(?:`{3,}|~{3,})/u.test(row.raw)) { row.protected = true; fenced = !fenced; continue; }
    const referenceHeading = row.text.replace(/^#{1,6}\s+/u, '').replace(/\s+#+$/u, '');
    if (!fenced && (REFERENCE.test(referenceHeading) || isRefHeadingLine(referenceHeading))) references = true;
    row.protected = references || fenced || EXPLICIT.test(row.text)
      || /^\d+(?:\.\d+)*[.)](?!\d)[ \t]*(?=[가-힣A-Za-z“‘"'「『《〈])/u.test(row.text)
      || /^[A-Za-z][.)](?=\s*\S)/u.test(row.text)
      || standaloneQuotes.some(span => span.start <= row.end && span.end > row.start)
      || /\t|\||\S {2,}\S|https?:\/\/|www\./u.test(row.raw)
      || /^[-+]?\d[\d.,%\s~–-]*$/u.test(row.text)
      || /^[^.!?]{1,60}[:：]$/u.test(row.text)
      || /^[가-힣A-Za-z][^.!?()（）\n]{0,25}[:：]/u.test(row.text)
      || /^\[[^\]\n]{1,40}\]\s*\S|^Q\d*[.:]\s|^\*\*[^*\n]+\*\*$/iu.test(row.text)
      || /^(?:출처|자료)\s*[:：]/u.test(row.text)
      || /^(?:“[^”]+”|‘[^’]+’|「[^」]+」|『[^』]+』|"[^"]+")$/u.test(row.text);
  }
  const content = rows.map((row, index) => ({ ...row, index })).filter(r => r.text);
  const prose = content.filter(r => !r.protected && !NUMBERED.test(r.text)
    && r.text.length >= 28 && r.text.length <= 110 && r.text.split(/\s/u).length >= 5);
  const lengths = prose.map(r => r.text.length).sort((a,b) => a-b);
  const median = lengths[Math.floor(lengths.length / 2)] || 0;
  const regular = prose.filter(r => r.text.length >= median * 0.72 && r.text.length <= median * 1.28);
  const unfinished = regular.filter(r => !isComplete(r.text));
  let seams = 0;
  for (let i = 1; i < content.length; i++) {
    const a = content[i-1], b = content[i];
    if (!a.protected && !b.protected && a.text.length >= 28 && !isComplete(a.text)
        && wordSeam(a.text, b.text, witnessed)) seams++;
  }
  const qualified = regular.length >= 8 && regular.length / Math.max(1, prose.length) >= 0.65
    && unfinished.length >= 6 && unfinished.length / Math.max(1, regular.length) >= 0.55 && seams >= 2;
  if (!qualified) return { text: source, changed: false, changes: [], joins: [] };
  // Protect evidenced charts before physical prose reflow. Otherwise a long
  // caption can be attached to an unfinished body row before the planner sees
  // the shared numeric-series role. Only qualifying PDF-like inputs need this
  // extra role pass; ordinary paragraphs take the unchanged fast path above.
  const chartLines = new Set();
  for (const row of require('./layoutStructure').buildLineRecords(source)) {
    if (!Number.isInteger(row.numericSeriesEnd)) continue;
    for (let index = row.index; index <= row.numericSeriesEnd; index++) chartLines.add(index);
  }
  for (const row of content) if (chartLines.has(row.index)) row.protected = true;
  const joins = [];
  const continuations = new Set();
  for (let i = 1; i < content.length; i++) {
    const a = content[i-1], b = content[i];
    if (a.protected || b.protected || (NUMBERED.test(a.text) && !continuations.has(a.index)) || isComplete(a.text)
        || a.text.length < Math.max(28, median * 0.65) || a.text.split(/\s/u).length < 4) continue;
    // A heading retained on its left must not be swallowed into its body on
    // the next iteration. A row already joined as proven prose is different:
    // its final noun alone cannot create a new section boundary.
    if (!continuations.has(a.index) && isNominalHeading(a.text)) continue;
    const attach = wordSeam(a.text, b.text, witnessed);
    // A real 가나다 item is never swallowed without a preceding broken polite
    // ending. A chart label, short heading or verse is not a continuation.
    if (NUMBERED.test(b.text) && !(attach && /(?:습니?|[합입됩했겠였않없있]니)$/u.test(a.text))) continue;
    // A finite clause need not carry a copied terminal point. Keep this
    // allowance narrower than ordinary punctuated continuations.
    const finiteEnding = b.text.length >= 12 && b.text.split(/\s+/u).length >= 3 && FINITE.test(b.text);
    const shortEnding = b.text.length >= 5 && END.test(b.text) && /[가-힣]/u.test(b.text) || finiteEnding;
    const from = a.end - (a.raw.length - a.raw.trimEnd().length);
    const to = b.start + b.raw.length - b.raw.trimStart().length;
    // A nested abbreviation can close on the first row while an outer inline
    // citation still owns the date on the next. Use parsed ownership, not
    // the last opening-parenthesis regex, to establish that exact relation.
    const dateTail = /^\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}\)\.?$/u.test(b.text)
      && literals.some(s => s.spanType === 'parenthetical' && s.start < from && s.end > to);
    if (!attach && isNominalHeading(b.text)) continue;
    if (!attach && !shortEnding && !dateTail && (b.text.length < Math.max(28, median * 0.72) || b.text.split(/\s/u).length < 3)) continue;
    // Do not alter exact quotations or code even if they wrap at the same width.
    if (literals.some(s => s.start < to && s.end > from
      && !(dateTail && s.spanType === 'parenthetical'))) continue;
    joins.push({ start: from, end: to, separator: attach ? '' : ' ', lineOrdinal: a.index + 1 });
    continuations.add(b.index);
  }
  let text = source;
  for (const j of [...joins].reverse()) text = text.slice(0, j.start) + j.separator + text.slice(j.end);
  if (text.replace(/\s/gu, '') !== source.replace(/\s/gu, '')) return { text: source, changed: false, changes: [], joins: [] };
  return { text, changed: text !== source, joins, changes: joins.map(j => ({
    code: 'source_physical_prose_wrap_repaired', lineOrdinal: j.lineOrdinal, action: 'repaired',
    message: '반복된 추출 행과 어절 연결 근거를 확인해 문장 중간의 줄바꿈을 정리했어요.'
  })) };
}

module.exports = { repairPhysicalProseLines };
