'use strict';

const VERSION = 'citation-ownership-v1';
const WS_RE = /\s/u;
const PREFIX_SRC = '(?<![\\p{L}\\p{N}])(?:교재[ \\t]*참고|출처|참고)[ \\t]*[:：]';
const PAGE_RE = /\bpp?\.\s*\d+(?:\s*[~\-–—]\s*\d+)?|\d+(?:\s*[~\-–—]\s*\d+)?\s*(?:쪽|페이지)/u;
const CHAPTER_RE = /^제?\s*\d+\s*(?:장|절|단원)/u;
const TITLE_OPEN_RE = /^[『「《〈“"]/u;
const PROSE_END_RE = /(?:다|요|까|음|함)[.?!]?$/u;
const HEADING_ROW_RE = /^(?:#{1,6}\s+\S|\d+(?:\.\d+)*[.)]\s+\S|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩIVX]+\.\s+\S|제\s*\d+\s*[장절]\s)/u;
const PAGE_EVIDENCE_WINDOW = 80;
const HEADING_MAX_LENGTH = 60;
const REFUSED = Object.freeze({ refused: true });
const CONTENT_VERSION = 'citation-content-v1';
const PAGE_ALL_RE = new RegExp(PAGE_RE.source, 'gu');
const CONTENT_MAX_BARE = 600;
const CONTENT_MIN_SIMILARITY = 0.6;

function normalizeLf(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n');
}

// 부모가 마스킹된 코드 위치를 바로잡아 넘긴 layoutSourceStart/End가 있으면 그 값을 쓴다.
function chunkRange(chunk) {
  const start = Number.isFinite(chunk.layoutSourceStart) ? chunk.layoutSourceStart : chunk.start;
  const end = Number.isFinite(chunk.layoutSourceEnd) ? chunk.layoutSourceEnd : chunk.end;
  return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
}

function bare(value) {
  return String(value ?? '').replace(/\s/gu, '');
}

// 청크 오프셋은 원본(CRLF 포함) 기준일 수 있으므로 LF 정규화 좌표로 옮긴다.
function lfOffsetMapper(raw) {
  if (!raw.includes('\r\n')) return offset => offset;
  const pairs = [];
  let pos = raw.indexOf('\r\n');
  while (pos !== -1) {
    pairs.push(pos);
    pos = raw.indexOf('\r\n', pos + 2);
  }
  return offset => {
    let lo = 0;
    let hi = pairs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[mid] < offset) lo = mid + 1;
      else hi = mid;
    }
    return offset - lo;
  };
}

function lineBounds(text, pos) {
  const start = pos === 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1;
  let end = text.indexOf('\n', pos);
  if (end === -1) end = text.length;
  return { start, end };
}

// 코드는 펜스 블록과 인라인 코드 스팬만으로 판정한다. 인용부호 범위를 만드는
// syntaxSpans는 절을 넘는 스팬을 만들 수 있어 여기서 쓰지 않는다.
function codeSpans(text) {
  const spans = [];
  let pos = 0;
  let fence = null;
  while (pos <= text.length) {
    let end = text.indexOf('\n', pos);
    if (end === -1) end = text.length;
    const row = text.slice(pos, end);
    const mark = /^\s*(`{3,}|~{3,})/u.exec(row);
    if (fence) {
      if (mark && mark[1][0] === fence.mark[0] && mark[1].length >= fence.mark.length) {
        spans.push([fence.start, end]);
        fence = null;
      }
    } else if (mark) {
      fence = { start: pos, mark: mark[1] };
    } else {
      for (const match of row.matchAll(/`[^`\n]+`/g)) {
        spans.push([pos + match.index, pos + match.index + match[0].length]);
      }
    }
    if (end === text.length) break;
    pos = end + 1;
  }
  if (fence) spans.push([fence.start, text.length]);
  return spans;
}

function isTableRow(row) {
  const trimmed = row.trim();
  if (trimmed.startsWith('|') && trimmed.split('|').length > 2) return true;
  return trimmed.split('\t').length > 2;
}

function prefixOccurrences(text, extraSpans = []) {
  const spans = codeSpans(text).concat(extraSpans);
  const out = [];
  for (const match of text.matchAll(new RegExp(PREFIX_SRC, 'gu'))) {
    const start = match.index;
    if (spans.some(([s, e]) => start >= s && start < e)) continue;
    const row = lineBounds(text, start);
    if (isTableRow(text.slice(row.start, row.end))) continue;
    out.push({
      start,
      end: start + match[0].length,
      label: match[0].replace(/\s*[:：]$/u, ''),
      rowStart: row.start,
      rowEnd: row.end
    });
  }
  return out;
}

// 일반 서술문의 `출처:`·`참고:`를 인용으로 잡지 않도록 쪽수 또는 제목 구분자를
// 증거로 요구한다.
function hasCitationEvidence(label, tail) {
  const t = String(tail || '').trim();
  if (!t) return false;
  const page = PAGE_RE.exec(t);
  if (page && page.index <= PAGE_EVIDENCE_WINDOW) return true;
  const textbook = label.startsWith('교재');
  if (textbook && CHAPTER_RE.test(t)) return true;
  if (!TITLE_OPEN_RE.test(t)) return false;
  return textbook || !PROSE_END_RE.test(t);
}

function isHeadingRow(row) {
  const t = String(row || '').trim();
  return t.length > 0
    && t.length <= HEADING_MAX_LENGTH
    && HEADING_ROW_RE.test(t)
    && !/[.?!。]$/u.test(t)
    && !new RegExp(PREFIX_SRC, 'u').test(t);
}

function collectHeadings(text, chunks, toLf, spans) {
  const byStart = new Map();
  const add = (start, end) => {
    const row = text.slice(start, end);
    if (!row.trim() || new RegExp(PREFIX_SRC, 'u').test(row)) return;
    if (!byStart.has(start)) byStart.set(start, { start, end, bare: bare(row) });
  };
  for (const chunk of chunks) {
    if (!chunk || chunk.locked !== true || !/heading|title/iu.test(String(chunk.lockType || ''))) continue;
    const range = chunkRange(chunk);
    if (!range) continue;
    const chunkEnd = Math.min(toLf(range.end), text.length);
    let pos = lineBounds(text, Math.min(toLf(range.start), text.length)).start;
    while (pos < chunkEnd) {
      const row = lineBounds(text, pos);
      add(row.start, row.end);
      pos = row.end + 1;
    }
  }
  let pos = 0;
  while (pos <= text.length) {
    const row = lineBounds(text, pos);
    const inCode = spans.some(([s, e]) => row.start >= s && row.start < e);
    if (!inCode && isHeadingRow(text.slice(row.start, row.end))) add(row.start, row.end);
    if (row.end === text.length) break;
    pos = row.end + 1;
  }
  return [...byStart.values()].sort((x, y) => x.start - y.start);
}

function buildCitationOwnership(source, chunks) {
  const raw = String(source ?? '');
  const text = normalizeLf(raw);
  const toLf = lfOffsetMapper(raw);
  const list = Array.isArray(chunks) ? chunks : [];
  const lockedSpans = [];
  for (const chunk of list) {
    if (!chunk || chunk.locked !== true || !/code|table/iu.test(String(chunk.lockType || ''))) continue;
    const range = chunkRange(chunk);
    if (!range) continue;
    lockedSpans.push([toLf(range.start), toLf(range.end)]);
  }
  const headings = collectHeadings(text, list, toLf, codeSpans(text).concat(lockedSpans));
  const occurrences = prefixOccurrences(text, lockedSpans);
  const atoms = [];
  const unowned = [];

  // 같은 행의 접두부는 오른쪽부터 판정한다. 증거가 없는 접두부는 앞 인용의
  // 리터럴에 그대로 남고, 증거가 있는 접두부는 앞 인용의 끝을 자른다.
  let idx = occurrences.length - 1;
  while (idx >= 0) {
    let first = idx;
    while (first > 0 && occurrences[first - 1].rowStart === occurrences[idx].rowStart) first -= 1;
    let end = occurrences[idx].rowEnd;
    for (let k = idx; k >= first; k -= 1) {
      const occ = occurrences[k];
      if (!hasCitationEvidence(occ.label, text.slice(occ.end, end))) {
        unowned.push(bare(text.slice(occ.start, end)));
        continue;
      }
      let literalEnd = end;
      while (literalEnd > occ.end && WS_RE.test(text[literalEnd - 1])) literalEnd -= 1;
      let leadStart = occ.start;
      while (leadStart > 0 && WS_RE.test(text[leadStart - 1])) leadStart -= 1;
      let trailEnd = literalEnd;
      while (trailEnd < text.length && WS_RE.test(text[trailEnd])) trailEnd += 1;
      const literal = text.slice(occ.start, literalEnd);
      const leadText = text.slice(occ.rowStart, occ.start);
      const page = PAGE_RE.exec(literal);
      atoms.push({
        id: '',
        kind: 'citation',
        prefix: occ.label,
        section: 0,
        ordinal: 0,
        srcStart: occ.start,
        srcEnd: literalEnd,
        literal,
        bareLiteral: bare(literal),
        rowKind: leadText.trim() === '' ? 'standalone' : 'inline',
        endsRow: end === occ.rowEnd,
        leadText,
        leadGap: text.slice(leadStart, occ.start),
        prevChar: leadStart > 0 ? text[leadStart - 1] : '',
        trailGap: text.slice(literalEnd, trailEnd),
        pageAnchor: page ? bare(page[0]) : ''
      });
      end = occ.start;
    }
    idx = first - 1;
  }
  atoms.reverse();

  let section = 0;
  let ordinal = 0;
  let lastSection = -1;
  for (const atom of atoms) {
    while (section < headings.length && headings[section].start <= atom.srcStart) section += 1;
    if (section !== lastSection) ordinal = 0;
    atom.section = section;
    atom.ordinal = ordinal;
    atom.id = `${section}:citation:${ordinal}`;
    ordinal += 1;
    lastSection = section;
  }
  return {
    version: VERSION,
    text,
    atoms,
    headings,
    unowned: [...new Set(unowned)],
    prefixStarts: occurrences.map(occ => occ.start)
  };
}

function bareIndex(text) {
  const bareAt = new Int32Array(text.length + 1);
  const rawIndex = [];
  const parts = [];
  for (let i = 0; i < text.length; i += 1) {
    bareAt[i] = rawIndex.length;
    if (!WS_RE.test(text[i])) {
      rawIndex.push(i);
      parts.push(text[i]);
    }
  }
  bareAt[text.length] = rawIndex.length;
  return { bareAt, rawIndex, bareText: parts.join('') };
}

// 원문 제목을 출력에서 순서대로 찾는다. 하나라도 못 찾으면 절 단위 대응을
// 포기하고 문서 전체 순번으로 대응한다.
function locateSections(headings, out, index) {
  const bounds = [0];
  let cursor = 0;
  for (const heading of headings) {
    let pos = index.bareText.indexOf(heading.bare, cursor);
    let pick = -1;
    while (pos !== -1) {
      if (pick === -1) pick = pos;
      const rawPos = index.rawIndex[pos];
      if (out.slice(lineBounds(out, rawPos).start, rawPos).trim() === '') {
        pick = pos;
        break;
      }
      pos = index.bareText.indexOf(heading.bare, pos + 1);
    }
    if (pick === -1) return null;
    bounds.push(pick);
    cursor = pick + heading.bare.length;
  }
  return bounds;
}

function alignGroup(atoms, occs, end, ctx) {
  const matches = [];
  const extras = [];
  const missing = [];
  const literalAt = (atom, pos) => pos + atom.bareLiteral.length <= end
    && ctx.bareText.startsWith(atom.bareLiteral, pos);
  let next = 0;
  let covered = -1;
  for (const occ of occs) {
    if (occ.bare < covered) continue;
    let j = next;
    while (j < atoms.length && !literalAt(atoms[j], occ.bare)) j += 1;
    if (j < atoms.length) {
      for (let k = next; k < j; k += 1) missing.push(atoms[k]);
      covered = occ.bare + atoms[j].bareLiteral.length;
      matches.push({ atom: atoms[j], bareStart: occ.bare, bareEnd: covered });
      next = j + 1;
      continue;
    }
    if (ctx.isCitationLike(occ)) extras.push(occ);
  }
  for (let k = next; k < atoms.length; k += 1) missing.push(atoms[k]);
  return { matches, extras, missing, ok: missing.length === 0 && extras.length === 0 };
}

function planLead(match, out, ctx) {
  const { atom, a } = match;
  let gs = a;
  while (gs > 0 && WS_RE.test(out[gs - 1])) gs -= 1;
  const gap = out.slice(gs, a);
  if (atom.rowKind === 'standalone') {
    if (gs === 0 || gap.includes('\n')) return null;
    return { start: gs, end: a, text: atom.leadGap.includes('\n') ? atom.leadGap : '\n' };
  }
  // 원문에서 행을 끝낸 인용 바로 뒤에 inline 인용이 붙었으면 사이 본문이 사라진 것이다.
  const prev = ctx.endMap.get(gs);
  if (prev && prev.atom.endsRow) return REFUSED;
  if (!gap.includes('\n')) {
    if (gap || !atom.leadGap) return null;
    if (gs > 0 && out[gs - 1] === atom.prevChar) return { start: gs, end: a, text: atom.leadGap };
    return REFUSED;
  }
  if (gs === 0 || out[gs - 1] !== atom.prevChar) return REFUSED;
  const prevRow = out.slice(out.lastIndexOf('\n', gs - 1) + 1, gs);
  const prevBare = bare(prevRow);
  // 제목 행에는 절대 붙이지 않는다. 원문 행의 앞부분 자체가 그 제목일 때만 예외다.
  if ((isHeadingRow(prevRow) || ctx.headingBare.has(prevBare)) && prevBare !== bare(atom.leadText)) {
    return REFUSED;
  }
  return { start: gs, end: a, text: atom.leadGap };
}

function planTrail(match, out, ctx) {
  const { atom, b } = match;
  if (!atom.endsRow) return null;
  let ge = b;
  while (ge < out.length && WS_RE.test(out[ge])) ge += 1;
  if (ge === out.length || ctx.startSet.has(ge)) return null;
  // 공백 없이 붙은 글자는 내용 변경이므로 줄바꿈을 끼워 넣지 않는다.
  if (ge === b) return REFUSED;
  if (out.slice(b, ge).includes('\n')) return null;
  return { start: b, end: ge, text: atom.trailGap.includes('\n') ? atom.trailGap : '\n' };
}

function analyze(source, output, chunks, repair) {
  const ownership = buildCitationOwnership(source, chunks);
  const out = normalizeLf(output);
  const index = bareIndex(out);
  const ownedBare = [...new Set(ownership.atoms.map(atom => atom.bareLiteral))];
  const rawOccs = prefixOccurrences(out);
  const occs = rawOccs.map((occ, i) => {
    const following = rawOccs[i + 1];
    return {
      ...occ,
      bare: index.bareAt[occ.start],
      tailEnd: following && following.rowStart === occ.rowStart ? following.start : occ.rowEnd
    };
  });
  const ctx = {
    bareText: index.bareText,
    headingBare: new Set(ownership.headings.map(heading => heading.bare)),
    isCitationLike(occ) {
      if (ownedBare.some(literal => index.bareText.startsWith(literal, occ.bare))) return true;
      if (ownership.unowned.some(literal => index.bareText.startsWith(literal, occ.bare))) return false;
      return hasCitationEvidence(occ.label, out.slice(occ.end, occ.tailEnd));
    },
    endMap: new Map(),
    startSet: new Set()
  };

  const bounds = locateSections(ownership.headings, out, index);
  const groups = [];
  if (bounds) {
    for (let s = 0; s < bounds.length; s += 1) {
      groups.push({
        atoms: ownership.atoms.filter(atom => atom.section === s),
        start: bounds[s],
        end: s + 1 < bounds.length ? bounds[s + 1] : index.bareText.length
      });
    }
  } else {
    groups.push({ atoms: ownership.atoms, start: 0, end: index.bareText.length });
  }

  const aligned = groups.map(group => alignGroup(
    group.atoms,
    occs.filter(occ => occ.bare >= group.start && occ.bare < group.end),
    group.end,
    ctx
  ));
  for (const group of aligned) {
    for (const match of group.matches) {
      match.a = index.rawIndex[match.bareStart];
      match.b = index.rawIndex[match.bareEnd - 1] + 1;
      ctx.startSet.add(match.a);
      ctx.endMap.set(match.b, match);
    }
  }

  const edits = [];
  const state = new Map();
  const protectedBlocks = [];
  let extraCount = 0;
  let refusedCount = 0;
  for (const group of aligned) {
    for (const atom of group.missing) state.set(atom.id, { status: 'missing', block: null });
    for (const match of group.matches) {
      const { atom, a, b } = match;
      const block = { id: atom.id, start: a, end: b, raw: '', literal: atom.literal, rowKind: atom.rowKind, status: 'unresolved' };
      protectedBlocks.push(block);
      state.set(atom.id, { status: 'unresolved', block });
      if (!group.ok || !repair) {
        if (group.ok) block.status = out.slice(a, b) === atom.literal ? 'exact' : 'inexact';
        edits.push({ start: a, end: b, text: out.slice(a, b), block });
        continue;
      }
      const lead = planLead(match, out, ctx);
      const trail = planTrail(match, out, ctx);
      const planned = [lead, trail].filter(edit => edit && edit !== REFUSED);
      edits.push({ start: a, end: b, text: atom.literal, block }, ...planned);
      const changed = out.slice(a, b) !== atom.literal
        || planned.some(edit => out.slice(edit.start, edit.end) !== edit.text);
      if (lead === REFUSED || trail === REFUSED) {
        refusedCount += 1;
        block.status = 'refused';
      } else {
        block.status = changed ? 'restored' : 'exact';
      }
    }
    for (const occ of group.extras) {
      let end = occ.tailEnd;
      while (end > occ.end && WS_RE.test(out[end - 1])) end -= 1;
      const block = {
        id: `extra:${extraCount}`,
        start: occ.start,
        end,
        raw: '',
        literal: null,
        rowKind: out.slice(occ.rowStart, occ.start).trim() === '' ? 'standalone' : 'inline',
        status: 'unowned'
      };
      extraCount += 1;
      protectedBlocks.push(block);
      edits.push({ start: occ.start, end, text: out.slice(occ.start, end), block });
    }
  }

  edits.sort((x, y) => x.start - y.start || x.end - y.end);
  let text = '';
  let pos = 0;
  let repairCount = 0;
  for (const edit of edits) {
    text += out.slice(pos, edit.start);
    if (edit.block) edit.block.start = text.length;
    text += edit.text;
    if (edit.block) edit.block.end = text.length;
    if (out.slice(edit.start, edit.end) !== edit.text) repairCount += 1;
    pos = edit.end;
  }
  text += out.slice(pos);
  for (const block of protectedBlocks) block.raw = text.slice(block.start, block.end);
  protectedBlocks.sort((x, y) => x.start - y.start);

  const atoms = ownership.atoms.map(atom => {
    const entry = state.get(atom.id) || { status: 'missing', block: null };
    return {
      id: atom.id,
      kind: atom.kind,
      prefix: atom.prefix,
      section: atom.section,
      ordinal: atom.ordinal,
      rowKind: atom.rowKind,
      srcStart: atom.srcStart,
      srcEnd: atom.srcEnd,
      literal: atom.literal,
      pageAnchor: atom.pageAnchor,
      status: entry.block ? entry.block.status : entry.status,
      start: entry.block ? entry.block.start : -1,
      end: entry.block ? entry.block.end : -1
    };
  });
  const missingCount = atoms.filter(atom => atom.status === 'missing').length;
  return {
    version: VERSION,
    text,
    pass: missingCount === 0 && extraCount === 0 && refusedCount === 0,
    missingCount,
    extraCount,
    refusedCount,
    repairCount,
    sectioned: Boolean(bounds),
    atoms,
    protectedBlocks
  };
}

function restoreCitationLayout(source, output, chunks) {
  return analyze(source, output, chunks, true);
}

// 분할기용: 출력을 고치지 않고, 끊으면 안 되는 인용 리터럴 범위만 돌려준다.
// 오프셋은 LF 정규화된 출력 기준이다.
function citationProtectedBlocks(source, output, chunks) {
  return analyze(source, output, chunks, false).protectedBlocks;
}

function pageSequence(value) {
  const pages = [];
  for (const match of String(value).matchAll(PAGE_ALL_RE)) {
    pages.push(match[0].match(/\d+/g).map(Number).join('-'));
  }
  return pages;
}

function lcsLength(a, b) {
  let prev = new Uint16Array(b.length + 1);
  let cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

function similarity(a, b) {
  const longer = Math.max(a.length, b.length);
  return longer === 0 ? 1 : lcsLength(a, b) / longer;
}

// 내용 복원: 출력에서 글자가 바뀐 인용 슬롯을 원문 리터럴로 되돌린다. 절마다
// 접두부 개수가 원문과 같고, 슬롯 끝이 다음 인용·제목·문서 끝으로 확정되며,
// 쪽수 순서가 완전히 같을 때만 덮어쓴다. 하나라도 어긋난 절은 건드리지 않는다.
// 공백 배치는 고치지 않으므로 restoreCitationLayout보다 먼저 부른다.
function restoreCitationContents(source, output, chunks) {
  const ownership = buildCitationOwnership(source, chunks);
  const { text: src, atoms, headings } = ownership;
  const out = normalizeLf(output);
  const index = bareIndex(out);
  const bounds = locateSections(headings, out, index);
  const groups = Array.from({ length: bounds ? bounds.length : 1 }, () => ({ src: [], out: [], atoms: [] }));
  const sectionOf = start => {
    let section = 0;
    while (section < headings.length && headings[section].start <= start) section += 1;
    return section;
  };
  for (const start of ownership.prefixStarts) groups[bounds ? sectionOf(start) : 0].src.push(start);
  for (const occ of prefixOccurrences(out)) {
    const at = index.bareAt[occ.start];
    let g = 0;
    while (bounds && g + 1 < bounds.length && bounds[g + 1] <= at) g += 1;
    groups[g].out.push({ ...occ, bare: at });
  }
  atoms.forEach((atom, i) => groups[bounds ? atom.section : 0].atoms.push(i));

  const refused = reason => ({ status: 'refused', reason });
  const planContent = (i, paired, members) => {
    const atom = atoms[i];
    const occ = paired.get(atom.srcStart);
    if (index.bareText.startsWith(atom.bareLiteral, occ.bare)) {
      return { status: 'exact', start: occ.start, end: index.rawIndex[occ.bare + atom.bareLiteral.length - 1] + 1 };
    }
    // 이 자리에 다른 원문 인용이 그대로 있으면 순서가 바뀐 것이다.
    if (atoms.some(other => other.bareLiteral !== atom.bareLiteral
      && index.bareText.startsWith(other.bareLiteral, occ.bare))) {
      return refused('reordered');
    }
    // 원문에서 인용 끝과 다음 기준점 사이가 공백뿐일 때만 그 기준점으로 슬롯을 닫는다.
    const nextAtom = atoms[i + 1];
    const nextHeading = headings[atom.section];
    let anchor = src.length;
    let kind = 'end';
    if (nextHeading && nextHeading.start >= atom.srcEnd) {
      anchor = nextHeading.start;
      kind = 'heading';
    }
    if (nextAtom && nextAtom.srcStart < anchor) {
      anchor = nextAtom.srcStart;
      kind = 'citation';
    }
    if (/\S/u.test(src.slice(atom.srcEnd, anchor))) return refused('unbounded');
    let end = out.length;
    if (kind === 'citation') {
      const nextOcc = paired.get(nextAtom.srcStart);
      if (!nextOcc) return refused('anchor-missing');
      end = nextOcc.start;
    } else if (kind === 'heading') {
      if (!bounds) return refused('anchor-missing');
      end = index.rawIndex[bounds[atom.section + 1]];
    }
    while (end > occ.start && WS_RE.test(out[end - 1])) end -= 1;
    if (end <= occ.end) return refused('anchor-missing');
    const slot = out.slice(occ.start, end);
    const slotBare = bare(slot);
    if (slotBare.length > atom.bareLiteral.length * 1.15
        || slot.split('\n').length > atom.literal.split('\n').length + 1) return refused('expanded-slot');
    // A moved/introduced sentence between a reference and its next heading
    // is not part of the reference, even if the long title still dominates a
    // similarity score. Refuse that slot rather than erase adjacent prose.
    const proseEndings = value => (value.match(/(?:[가-힣]+(?:다|요|죠|음|함)|(?:is|are|was|were|must|should|will)\s+[^.!?\n]+)[.!?。！？]/gu) || []).length;
    if (proseEndings(slot) > proseEndings(atom.literal)) return refused('intervening-prose');
    if (slotBare.length > CONTENT_MAX_BARE || atom.bareLiteral.length > CONTENT_MAX_BARE) return refused('too-long');
    const pages = pageSequence(atom.literal);
    if (pages.length === 0) return refused('no-pages');
    if (pages.join('|') !== pageSequence(slot).join('|')) return refused('pages-changed');
    const score = similarity(slotBare, atom.bareLiteral);
    if (score < CONTENT_MIN_SIMILARITY) return refused('dissimilar');
    const rivals = new Set(members.map(k => atoms[k].bareLiteral));
    rivals.delete(atom.bareLiteral);
    for (const rival of rivals) {
      if (rival.length <= CONTENT_MAX_BARE && similarity(slotBare, rival) >= score) return refused('ambiguous');
    }
    return { status: 'restored', start: occ.start, end, text: atom.literal };
  };

  const state = atoms.map(() => ({ status: 'missing', reason: '', start: -1, end: -1 }));
  const spans = [];
  let missingCount = 0;
  let extraCount = 0;
  for (const group of groups) {
    const lack = group.src.length - group.out.length;
    if (group.atoms.length === 0) {
      // 인용이 없는 절에서는 증거가 있는 접두부가 늘었을 때만 추가 인용으로 센다.
      if (lack < 0) {
        const evident = group.out.filter(occ => hasCitationEvidence(occ.label, out.slice(occ.end, occ.rowEnd))).length;
        extraCount += Math.min(evident, -lack);
      }
      continue;
    }
    if (lack !== 0) {
      missingCount += Math.max(lack, 0);
      extraCount += Math.max(-lack, 0);
      for (const i of group.atoms) state[i] = { ...refused('count-mismatch'), start: -1, end: -1 };
      continue;
    }
    const paired = new Map(group.src.map((start, k) => [start, group.out[k]]));
    const plans = group.atoms.map(i => planContent(i, paired, group.atoms));
    const failed = plans.some(plan => plan.status === 'refused');
    plans.forEach((plan, k) => {
      const i = group.atoms[k];
      if (plan.status === 'refused') {
        state[i] = { ...plan, start: -1, end: -1 };
      } else if (plan.status === 'restored' && failed) {
        state[i] = { ...refused('group-refused'), start: -1, end: -1 };
      } else {
        state[i] = { status: plan.status, reason: '', start: -1, end: -1 };
        spans.push({ i, start: plan.start, end: plan.end, text: plan.status === 'restored' ? plan.text : null });
      }
    });
  }

  spans.sort((x, y) => x.start - y.start || x.end - y.end);
  let text = '';
  let pos = 0;
  for (const span of spans) {
    if (span.start < pos) {
      state[span.i] = { ...refused('overlap'), start: -1, end: -1 };
      continue;
    }
    text += out.slice(pos, span.start);
    state[span.i].start = text.length;
    text += span.text === null ? out.slice(span.start, span.end) : span.text;
    state[span.i].end = text.length;
    pos = span.end;
  }
  text += out.slice(pos);

  // 감사 정보에는 원문·출력 글자를 넣지 않는다.
  const audit = atoms.map((atom, i) => ({
    id: atom.id,
    section: atom.section,
    ordinal: atom.ordinal,
    rowKind: atom.rowKind,
    pageCount: pageSequence(atom.literal).length,
    status: state[i].status,
    reason: state[i].reason,
    start: state[i].start,
    end: state[i].end
  }));
  const count = status => audit.filter(atom => atom.status === status).length;
  const refusedCount = count('refused');
  missingCount += count('missing');
  return {
    version: CONTENT_VERSION,
    text,
    pass: missingCount === 0 && extraCount === 0 && refusedCount === 0,
    restoredCount: count('restored'),
    exactCount: count('exact'),
    missingCount,
    extraCount,
    refusedCount,
    sectioned: Boolean(bounds),
    atoms: audit
  };
}

module.exports = {
  VERSION,
  CONTENT_VERSION,
  buildCitationOwnership,
  restoreCitationLayout,
  restoreCitationContents,
  citationProtectedBlocks
};
