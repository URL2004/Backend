'use strict';

const baseChunk = require('../engine/chunk');

const VERSION = 'gpt-structure-chunk-v1';
const UNSAFE_END_RE = /(?:보다|및|과|와|의|을|를|은|는|이|가|에|에서|으로|로|부터|까지|처럼|대한|관한|그리고|그러나|하지만|또한|따라서|때문에|위해|통해|하며|하고)$/;

function splitChunksForGpt(text) {
  const base = baseChunk.splitChunks(text);
  const chunks = [];
  const state = {
    referenceMode: false,
    tocMode: false,
    currentSection: ''
  };

  for (const chunk of base) {
    const expanded = expandBaseChunk(chunk, state);
    if (!expanded.length) {
      chunks.push(chunk);
      continue;
    }
    chunks.push(...expanded);
  }

  reindexChunks(chunks);
  return {
    version: VERSION,
    chunks,
    audit: buildPlanAudit(chunks)
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
    const info = classifyPiece(piece.text, state);
    if (info.sectionLabel) state.currentSection = info.sectionLabel;
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

function classifyPiece(line, state) {
  const raw = String(line || '');
  const s = raw.trim();
  if (!s) return { locked: false, lockType: 'blank' };

  if (state.referenceMode) {
    return { locked: true, lockType: 'reference_item', sectionLabel: '참고문헌' };
  }

  if (isReferenceHeading(s)) {
    state.referenceMode = true;
    return { locked: true, lockType: 'reference_heading', sectionLabel: s };
  }

  if (state.tocMode && isMainBodyHeading(s)) {
    state.tocMode = false;
  } else if (state.tocMode) {
    return { locked: true, lockType: 'toc_item', sectionLabel: '목차' };
  }

  if (isTocHeading(s)) {
    state.tocMode = true;
    return { locked: true, lockType: 'toc_heading', sectionLabel: s };
  }

  if (isHeadingLine(s)) {
    return { locked: true, lockType: 'heading', sectionLabel: s };
  }
  if (isHypothesisLine(s)) return { locked: true, lockType: 'hypothesis', sectionLabel: state.currentSection };
  if (isTableLine(s)) return { locked: true, lockType: 'table', sectionLabel: state.currentSection };
  if (isStatLine(s)) return { locked: true, lockType: 'stat_line', sectionLabel: state.currentSection };
  if (isReferenceLine(s)) return { locked: true, lockType: 'reference_item', sectionLabel: state.currentSection };

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
  return /^(?:참고문헌|References|Bibliography|Works\s+Cited)$/i.test(s);
}

function isTocHeading(s) {
  return /^(?:목차|차례|Table\s+of\s+Contents)$/i.test(s);
}

function isMainBodyHeading(s) {
  return /^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]\s*[.)．]\s*(?:서론|본론|결론|초록|이론|연구|논의|참고문헌)/.test(s);
}

function isHeadingLine(s) {
  if (/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]\s*[.)．]\s*\S.{0,100}$/.test(s)) return true;
  if (/^\d{1,2}(?:\.\d{1,2}){0,3}\s*[.)]?\s+\S.{0,100}$/.test(s) && s.length <= 120) return true;
  if (/^제\s?\d{1,3}\s?(?:장|절|항)\s+\S.{0,100}$/.test(s)) return true;
  if (/^(?:서론|본론|결론|초록|연구\s*방법|연구\s*결과|논의|결과\s*분석\s*및\s*함의)$/.test(s)) return true;
  return false;
}

function isHypothesisLine(s) {
  return /^(?:가설|연구가설|H)\s*\d+[a-zA-Z]?\s*[.:)]?\s+/.test(s);
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

function isReferenceLine(s) {
  if (s.length > 500) return false;
  if (/https?:\/\/|doi\s*:|DOI\s*:|학술지|출판사|교육부|보건복지부|한국학술정보|KCI|RISS/i.test(s) && /\d{4}/.test(s)) return true;
  if (/^[가-힣A-Za-z,\s·.-]+\(?(?:19|20)\d{2}\)?[.)]/.test(s) && s.length <= 360) return true;
  return false;
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
  looksUnsafeChunkEnd
};
