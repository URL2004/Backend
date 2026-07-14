const sg = require('./surfaceguard');

const STRUCT_LINE_RE = /^\s*(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]\s*[.、)]|\d{1,2}(?!\d)\s*[.)]\s|\d{1,2}\.\d{1,2}|[가-하]\s*[.)]\s|[①②③④⑤⑥⑦⑧⑨⑩]|[-•*▪◦·]\s|\|.*\||제\s?\d{1,3}\s?(?:조|장|절|항))/;
const SENT_END_RE = /[.!?。！？…]|(?:다|요|죠|까|함|임|니다|어요|예요|이에요)\s*$/;

function compactLen(text) {
  return String(text || '').replace(/\s+/g, '').length;
}

function sentenceCount(text) {
  const sents = sg.splitSentences(String(text || ''));
  return sents.length || (String(text || '').trim() ? 1 : 0);
}

function looksLikeStructureBlock(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.some(l => STRUCT_LINE_RE.test(l))) return true;
  return lines.length === 1 && compactLen(t) <= 35 && !SENT_END_RE.test(t);
}

function isShortSingleParagraph(text) {
  const t = String(text || '').trim();
  if (!t || looksLikeStructureBlock(t)) return false;
  return sentenceCount(t) <= 1 && compactLen(t) <= 90;
}

function joinParas(a, b) {
  return `${String(a || '').trim()} ${String(b || '').trim()}`.replace(/\s+/g, ' ').trim();
}

function flowCohesion(text, options = {}) {
  const paras = String(text || '').split(/\n[ \t]*\n+/).map(p => p.trim()).filter(Boolean);
  if (options && options.preserveParagraphs) {
    return { text: paras.join('\n\n'), merged: 0, beforeParas: paras.length, afterParas: paras.length, preserveParagraphs: true };
  }
  if (paras.length < 3) {
    return { text: paras.join('\n\n'), merged: 0, beforeParas: paras.length, afterParas: paras.length };
  }

  const out = [];
  let merged = 0;
  let shortSingleRun = 0;

  for (const p of paras) {
    const mergeable = isShortSingleParagraph(p);
    const prev = out[out.length - 1] || '';
    const prevMergeable = isShortSingleParagraph(prev);
    const shouldMerge =
      mergeable &&
      prev &&
      !looksLikeStructureBlock(prev) &&
      (shortSingleRun >= 1 || prevMergeable || compactLen(p) <= 45);

    if (shouldMerge) {
      out[out.length - 1] = joinParas(prev, p);
      merged++;
      shortSingleRun = 0;
    } else {
      out.push(p);
      shortSingleRun = mergeable ? shortSingleRun + 1 : 0;
    }
  }

  const singleCount = out.filter(isShortSingleParagraph).length;
  const ratio = out.length ? singleCount / out.length : 0;
  if (ratio > 0.45 && out.length > 3) {
    for (let i = out.length - 1; i > 0; i--) {
      if (!isShortSingleParagraph(out[i]) || looksLikeStructureBlock(out[i - 1])) continue;
      out[i - 1] = joinParas(out[i - 1], out[i]);
      out.splice(i, 1);
      merged++;
      if ((out.filter(isShortSingleParagraph).length / Math.max(1, out.length)) <= 0.45) break;
    }
  }

  return { text: out.join('\n\n'), merged, beforeParas: paras.length, afterParas: out.length };
}

module.exports = { flowCohesion };
