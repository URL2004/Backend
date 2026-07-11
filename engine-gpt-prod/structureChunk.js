'use strict';

const baseChunk = require('../engine/chunk');
const freezeBlocks = require('../engine/freezeblocks');
const { splitSentenceSpans } = require('../engine/koreanText');

const VERSION = 'gpt-structure-chunk-v1';
const UNSAFE_END_RE = /(?:보다|및|과|와|의|을|를|은|는|이|가|에|에서|으로|로|부터|까지|처럼|대한|관한|그리고|그러나|하지만|또한|따라서|때문에|위해|통해|하며|하고)$/;

function splitChunksForGpt(text, {
  coalesceEditable = false,
  preserveSentenceBoundaries = false,
  sentenceBoundaryMinimum = 4,
  preserveLineBoundaries = false
} = {}) {
  const base = baseChunk.splitChunks(text);
  const academicSpans = freezeBlocks.detectAcademicSpans(text);
  const chunks = [];
  const state = {
    currentSection: '',
    lastPiece: null,
    academicSpans
  };

  for (const chunk of base) {
    const expanded = expandBaseChunk(chunk, state);
    if (!expanded.length) {
      chunks.push(chunk);
      continue;
    }
    chunks.push(...expanded);
  }

  const plannedChunks = coalesceEditable ? coalesceEditableChunks(chunks) : chunks;
  if (preserveLineBoundaries) addLineBoundaryMarkers(plannedChunks);
  if (preserveSentenceBoundaries) addSentenceBoundaryMarkers(plannedChunks, sentenceBoundaryMinimum);
  reindexChunks(plannedChunks);
  return {
    version: VERSION,
    chunks: plannedChunks,
    audit: buildPlanAudit(plannedChunks)
  };
}

function mergeChunks(chunks) {
  return baseChunk.mergeChunks(chunks);
}

function expandBaseChunk(chunk, state) {
  const pieces = splitLinePieces(chunk.text, chunk.start || 0);
  if (!pieces.length) return [];

  const groups = [];
  let current = null;

  for (const piece of pieces) {
    const info = classifyPiece(piece, state);
    if (info.sectionLabel) state.currentSection = info.sectionLabel;
    state.lastPiece = {
      text: String(piece.text || '').trim(),
      locked: info.locked,
      lockType: info.lockType || '',
      sectionLabel: info.sectionLabel || state.currentSection || ''
    };
    const key = info.locked ? `locked:${info.lockType}` : 'body';
    if (!current || current.key !== key) {
      flushGroup(groups, current, state);
      current = { key, locked: info.locked, lockType: info.lockType, pieces: [] };
    }
    current.pieces.push(piece);
  }
  flushGroup(groups, current, state);

  if (!groups.length) return [];
  if (chunk._lead) groups[0]._lead = (groups[0]._lead || '') + chunk._lead;
  groups[groups.length - 1].sep = (groups[groups.length - 1].sep || '') + (chunk.sep || '');
  return groups;
}

function splitLinePieces(text, offset = 0) {
  const source = String(text || '');
  if (!source) return [];
  const out = [];
  let pos = 0;
  while (pos < source.length) {
    const nl = source.indexOf('\n', pos);
    if (nl === -1) {
      out.push({ text: source.slice(pos), sep: '', start: offset + pos, end: offset + source.length });
      break;
    }
    let nlEnd = nl;
    while (nlEnd < source.length && source.charAt(nlEnd) === '\n') nlEnd += 1;
    out.push({ text: source.slice(pos, nl), sep: source.slice(nl, nlEnd), start: offset + pos, end: offset + nl });
    pos = nlEnd;
  }
  return out;
}

function classifyPiece(piece, state) {
  const raw = String(piece?.text || '');
  const s = raw.trim();
  if (!s) return { locked: false, lockType: 'blank' };

  const frozen = freezeBlocks.academicSpanAt(state.academicSpans, piece.start, piece.end);
  if (frozen) return { locked: true, lockType: frozen.type === 'toc' ? 'toc_item' : 'reference_item', sectionLabel: frozen.type === 'toc' ? '목차' : '참고문헌' };

  if (isHeadingLine(s)) {
    return { locked: true, lockType: 'heading', sectionLabel: s };
  }
  if (isHeadingContinuationLine(s, state.lastPiece)) {
    const sectionLabel = [state.currentSection, s].filter(Boolean).join(' ').trim() || s;
    return { locked: true, lockType: 'heading_continuation', sectionLabel };
  }
  if (isHypothesisLine(s)) return { locked: true, lockType: 'hypothesis', sectionLabel: state.currentSection };
  if (isTableLine(s)) return { locked: true, lockType: 'table', sectionLabel: state.currentSection };
  if (isStatLine(s)) return { locked: true, lockType: 'stat_line', sectionLabel: state.currentSection };
  return { locked: false, lockType: '', sectionLabel: state.currentSection };
}

function flushGroup(groups, group, state) {
  if (!group || !group.pieces.length) return;
  const pieces = group.pieces;
  const last = pieces[pieces.length - 1];
  let text = '';
  for (let i = 0; i < pieces.length; i += 1) {
    text += pieces[i].text;
    if (i < pieces.length - 1) text += pieces[i].sep || '';
  }
  const chunk = {
    start: pieces[0].start,
    end: last.end,
    sep: last.sep || '',
    text,
    outputText: null
  };
  if (group.locked) {
    chunk.locked = true;
    chunk.lockType = group.lockType || 'structure';
    chunk.skipReason = `structure_lock:${chunk.lockType}`;
  } else if (state.currentSection) {
    chunk.sectionPath = state.currentSection;
  }
  groups.push(chunk);
}

function reindexChunks(chunks) {
  const n = chunks.length;
  chunks.forEach((chunk, i) => {
    chunk.index = i;
    chunk.position = n === 1 ? 'single' : (i === 0 ? 'intro' : (i === n - 1 ? 'conclusion' : 'body'));
  });
}

function coalesceEditableChunks(chunks, targetChars = 1600, hardMaxChars = 2500) {
  const out = [];
  let current = null;
  const flush = () => {
    if (current) out.push(current);
    current = null;
  };
  for (const sourceChunk of chunks || []) {
    const chunk = { ...sourceChunk };
    if (chunk.locked) {
      flush();
      out.push(chunk);
      continue;
    }
    if (!current) {
      current = chunk;
      continue;
    }
    const sameSection = String(current.sectionPath || '') === String(chunk.sectionPath || '');
    const boundary = `${current.sep || ''}${chunk._lead || ''}`;
    const joinText = `${current.text || ''}${boundary}${chunk.text || ''}`;
    if (sameSection && current.text.length < targetChars && joinText.length <= hardMaxChars) {
      const existingMarkers = Array.isArray(current.boundaryMarkers) ? current.boundaryMarkers : [];
      const marker = `[[[V2_BOUNDARY_${String(existingMarkers.length + 1).padStart(3, '0')}]]]`;
      const start = String(current.text || '').length;
      current.llmText = `${current.llmText || current.text || ''}${marker}${chunk.llmText || chunk.text || ''}`;
      current.boundaryMarkers = [...existingMarkers, { marker, boundary, start, end: start + boundary.length }];
      current.text = joinText;
      current.end = chunk.end;
      current.sep = chunk.sep || '';
      current.outputText = null;
      continue;
    }
    flush();
    current = chunk;
  }
  flush();
  return out;
}

function restoreBoundaryMarkers(outputText, chunk) {
  const markers = [
    ...(Array.isArray(chunk?.boundaryMarkers) ? chunk.boundaryMarkers : []),
    ...(Array.isArray(chunk?.lineBoundaryMarkers) ? chunk.lineBoundaryMarkers : []),
    ...(Array.isArray(chunk?.sentenceBoundaryMarkers) ? chunk.sentenceBoundaryMarkers : [])
  ];
  if (!markers.length) return { text: String(outputText || ''), ok: true, applied: false, missing: [], duplicated: [] };
  let text = String(outputText || '');
  const missing = [];
  const duplicated = [];
  for (const item of markers) {
    const count = text.split(item.marker).length - 1;
    if (count === 0) missing.push(item.marker);
    if (count > 1) duplicated.push(item.marker);
    if (count === 1) text = text.replace(item.marker, item.boundary);
  }
  const leaked = /\[\[\[V2_(?:BOUNDARY|LINE|SENTENCE)_\d{3,4}\]\]\]/.test(text);
  const sentenceLocked = Array.isArray(chunk?.sentenceBoundaryMarkers) && chunk.sentenceBoundaryMarkers.length > 0;
  const lineLocked = Array.isArray(chunk?.lineBoundaryMarkers) && chunk.lineBoundaryMarkers.length > 0;
  const expectedSentenceCount = sentenceLocked ? splitSentenceSpans(String(chunk?.text || '')).length : null;
  const actualSentenceCount = sentenceLocked ? splitSentenceSpans(text).length : null;
  const expectedLineCount = lineLocked ? countLines(String(chunk?.text || '')) : null;
  const actualLineCount = lineLocked ? countLines(text) : null;
  const segmentationChanged = (sentenceLocked && expectedSentenceCount !== actualSentenceCount)
    || (lineLocked && expectedLineCount !== actualLineCount);
  return {
    text,
    ok: missing.length === 0 && duplicated.length === 0 && !leaked && !segmentationChanged,
    applied: true,
    missing,
    duplicated,
    leaked,
    segmentationChanged,
    expectedSentenceCount,
    actualSentenceCount,
    expectedLineCount,
    actualLineCount
  };
}

function addLineBoundaryMarkers(chunks) {
  let markerIndex = 1;
  for (const chunk of chunks || []) {
    if (!chunk || chunk.locked) continue;
    const text = String(chunk.text || '');
    const paragraphEvents = (chunk.boundaryMarkers || [])
      .filter(item => Number.isInteger(item.start) && Number.isInteger(item.end))
      .map(item => ({ ...item, kind: 'paragraph' }));
    const lineEvents = [];
    const lineBreaks = text.matchAll(/\r?\n/gu);
    for (const match of lineBreaks) {
      const start = match.index;
      const end = start + match[0].length;
      if (paragraphEvents.some(event => rangesOverlap(start, end, event.start, event.end))) continue;
      const marker = `[[[V2_LINE_${String(markerIndex).padStart(4, '0')}]]]`;
      markerIndex += 1;
      lineEvents.push({ marker, boundary: match[0], start, end, kind: 'line' });
    }
    if (!lineEvents.length) continue;
    chunk.lineBoundaryMarkers = lineEvents.map(({ kind, ...item }) => item);
    chunk.llmText = renderMarkerEvents(text, [...paragraphEvents, ...lineEvents]);
  }
}

function addSentenceBoundaryMarkers(chunks, minimumSentenceCount = 4) {
  let markerIndex = 1;
  for (const chunk of chunks || []) {
    if (!chunk || chunk.locked) continue;
    const text = String(chunk.text || '');
    const spans = splitSentenceSpans(text);
    if (spans.length < Math.max(2, Number(minimumSentenceCount) || 4)) continue;
    const paragraphEvents = (chunk.boundaryMarkers || [])
      .filter(item => Number.isInteger(item.start) && Number.isInteger(item.end))
      .map(item => ({ ...item, kind: 'paragraph' }));
    const lineEvents = (chunk.lineBoundaryMarkers || [])
      .filter(item => Number.isInteger(item.start) && Number.isInteger(item.end))
      .map(item => ({ ...item, kind: 'line' }));
    const sentenceEvents = [];
    for (let i = 0; i < spans.length - 1; i += 1) {
      const start = spans[i].end;
      const end = spans[i + 1].start;
      if ([...paragraphEvents, ...lineEvents].some(event => rangesOverlap(start, end, event.start, event.end))) continue;
      const marker = `[[[V2_SENTENCE_${String(markerIndex).padStart(4, '0')}]]]`;
      markerIndex += 1;
      sentenceEvents.push({ marker, boundary: text.slice(start, end), start, end, kind: 'sentence' });
    }
    if (!sentenceEvents.length) continue;
    chunk.sentenceBoundaryMarkers = sentenceEvents.map(({ kind, ...item }) => item);
    chunk.llmText = renderMarkerEvents(text, [...paragraphEvents, ...lineEvents, ...sentenceEvents]);
  }
}

function renderMarkerEvents(text, events) {
  const sorted = [...events].sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = 0;
  let output = '';
  for (const event of sorted) {
    if (event.start < cursor) continue;
    output += text.slice(cursor, event.start) + event.marker;
    cursor = event.end;
  }
  return output + text.slice(cursor);
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  if (aStart === aEnd) return aStart >= bStart && aStart <= bEnd;
  if (bStart === bEnd) return bStart >= aStart && bStart <= aEnd;
  return aStart < bEnd && bStart < aEnd;
}

function countLines(value) {
  return String(value || '').split(/\r?\n/u).length;
}

function repairUnsafeChunkBoundaries(chunks) {
  const repairs = [];
  for (let i = 0; i < (chunks || []).length - 1; i += 1) {
    const left = chunks[i];
    const right = chunks[i + 1];
    if (!left || !right || left.locked || right.locked) continue;
    const leftText = String(left.outputText != null ? left.outputText : left.text || '').trim();
    const rightText = String(right.outputText != null ? right.outputText : right.text || '').trim();
    if (!leftText || !rightText) continue;
    if (!/\n/.test(left.sep || '')) continue;
    if (!looksUnsafeChunkEnd(leftText)) continue;
    if (!/^[가-힣A-Za-z0-9("']/.test(rightText)) continue;
    const before = left.sep;
    left.sep = ' ';
    repairs.push({
      index: i,
      reason: 'unsafe_sentence_boundary',
      before,
      after: left.sep,
      leftTail: leftText.slice(-40),
      rightHead: rightText.slice(0, 40)
    });
  }
  return {
    applied: repairs.length > 0,
    count: repairs.length,
    repairs: repairs.slice(0, 20)
  };
}

function buildStructureAudit({ source, outputText, chunks, plan, boundaryRepair } = {}) {
  const locked = (chunks || []).filter(c => c.locked && String(c.text || '').trim());
  const output = String(outputText || '');
  const lost = [];
  for (const chunk of locked) {
    const value = String(chunk.text || '').trim();
    if (!value) continue;
    if (output.includes(value)) continue;
    const key = bare(value).slice(0, 80);
    if (key.length >= 2 && bare(output).includes(key)) continue;
    lost.push({
      index: chunk.index,
      lockType: chunk.lockType || 'structure',
      text: value.slice(0, 160)
    });
  }
  const boundaryWarnings = findUnsafeOutputBoundaries(chunks);
  const counts = plan?.audit?.lockedByType || countLockedByType(locked);
  return {
    version: VERSION,
    enabled: true,
    sourceChars: String(source || '').length,
    chunkCount: (chunks || []).length,
    lockedCount: locked.length,
    lockedByType: counts,
    lostLockedCount: lost.length,
    lostLocked: lost.slice(0, 20),
    boundaryRepair: boundaryRepair || { applied: false, count: 0, repairs: [] },
    unsafeBoundaryCount: boundaryWarnings.length,
    unsafeBoundaries: boundaryWarnings.slice(0, 20),
    pass: lost.length === 0 && boundaryWarnings.length === 0
  };
}

function buildPlanAudit(chunks) {
  const locked = (chunks || []).filter(c => c.locked);
  return {
    version: VERSION,
    chunkCount: (chunks || []).length,
    lockedCount: locked.length,
    lockedByType: countLockedByType(locked)
  };
}

function countLockedByType(locked) {
  const out = {};
  for (const chunk of locked || []) {
    const key = chunk.lockType || 'structure';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function findUnsafeOutputBoundaries(chunks) {
  const out = [];
  for (let i = 0; i < (chunks || []).length - 1; i += 1) {
    const left = chunks[i];
    const right = chunks[i + 1];
    if (!left || !right || left.locked || right.locked) continue;
    if (!/\n/.test(left.sep || '')) continue;
    const leftText = String(left.outputText != null ? left.outputText : left.text || '').trim();
    const rightText = String(right.outputText != null ? right.outputText : right.text || '').trim();
    if (!leftText || !rightText) continue;
    if (!looksUnsafeChunkEnd(leftText)) continue;
    out.push({
      index: i,
      leftTail: leftText.slice(-40),
      rightHead: rightText.slice(0, 40)
    });
  }
  return out;
}

function looksUnsafeChunkEnd(text) {
  const s = String(text || '').trim().replace(/[.,;:，、]$/, '');
  return UNSAFE_END_RE.test(s);
}

function isReferenceHeading(s) {
  return /^(?:참고\s*문헌|참고\s*자료|인용\s*문헌|출처|References|Bibliography|Works\s+Cited)$/i.test(s);
}

function isTocHeading(s) {
  return /^(?:목\s*차|차례|Table\s+of\s+Contents)$/i.test(s);
}

function isMainBodyHeading(s) {
  return /^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]\s*[.)．]?\s*(?:서론|본론|결론|초록|이론|연구|논의|참고\s*문헌)/.test(s) ||
    /^제\s?\d{1,3}\s?(?:장|절|항)(?=$|[^가-힣A-Za-z0-9_])/.test(s);
}

function isHeadingLine(s) {
  if (/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]\s*[.)．]?\s*\S.{0,100}$/.test(s)) return true;
  if (/^\d{1,2}(?:\.\d{1,2}){0,3}\s*[.)]?\s+\S.{0,100}$/.test(s) && s.length <= 120) return true;
  if (/^제\s?\d{1,3}\s?(?:장|절|항)(?:\s+\S.{0,100})?$/.test(s)) return true;
  if (/^(?:서론|본론|결론|초록|요약|연구\s*방법|연구\s*결과|연구\s*가설|분석\s*결과|결과\s*분석|논의|시사점|한계점|제언|부록|참고\s*문헌|결과\s*분석\s*및\s*함의)$/.test(s)) return true;
  if (/^(?:Abstract|Introduction|Methods?|Methodology|Results?|Discussion|Conclusion|References|Appendix)$/i.test(s)) return true;
  return false;
}

function isHeadingContinuationLine(s, lastPiece) {
  if (!lastPiece || !lastPiece.locked || !/^heading/.test(lastPiece.lockType || '')) return false;
  if (!s || s.length > 40) return false;
  if (/[.!?。！？]$/.test(s)) return false;
  if (/^(?:및|과|와|또는|그리고)\s+\S.{0,34}$/.test(s)) return true;
  return /^(?:함의|시사점|한계점|제언|논의|요약)$/.test(s);
}

function isHypothesisLine(s) {
  return /^(?:\(?\s*)?(?:가설|연구\s*가설|H)\s*[-:]?\s*\d+[a-zA-Z]?\s*[.:)：)]?(?:\s+|$)/.test(s) ||
    /^(?:\(?\s*)?(?:가설|연구\s*가설|H)\s*[-:]?\s*\d+[a-zA-Z]?\s*[.:)：)]?\S.{0,180}$/.test(s);
}

function isTableLine(s) {
  if (/^(?:표|그림)\s*[0-9A-Za-z가-힣.-]+/.test(s)) return true;
  if (/^\|.+\|$/.test(s)) return true;
  if (/\t/.test(s)) return true;
  const nums = s.match(/-?\d+(?:\.\d+)?%?/g) || [];
  return nums.length >= 4 && s.length <= 220;
}

function isStatLine(s) {
  return /\b(?:p|r|R²|R2|F|t|β|B|SE|M|SD)\s*[<=>]\s*-?\d+(?:\.\d+)?\b/i.test(s) ||
    /(?:유의확률|표준오차|회귀계수|결정계수|상관계수)\s*[:=]?\s*-?\d+(?:\.\d+)?/.test(s);
}

function bare(text) {
  return String(text || '').replace(/\s+/g, '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

module.exports = {
  VERSION,
  splitChunksForGpt,
  mergeChunks,
  repairUnsafeChunkBoundaries,
  buildStructureAudit,
  looksUnsafeChunkEnd,
  coalesceEditableChunks,
  restoreBoundaryMarkers
};
