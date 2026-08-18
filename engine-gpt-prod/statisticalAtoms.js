'use strict';

// 통계 기호와 값은 숫자 낱개가 아니라 한 원자로 보존한다. 숫자 multiset만
// 비교하면 `p<.001`이 `p<.0\n01`로 갈라져도 어느 단계에서 깨졌는지 알기
// 어렵고, 레이아웃 수리가 숫자 두 개로 오인해 되돌리지 못할 수 있다.
const VERSION = 1;
const STAT_SYMBOL = '(?:(?:Δ[ \\t]*)?(?:R(?:[ \\t]*(?:²|\\^[ \\t]*2|2))?|χ(?:[ \\t]*(?:²|\\^[ \\t]*2|2))?|η(?:[ \\t]*(?:²|\\^[ \\t]*2|2))?|β|α|γ|p|r|F|t|z|B|SE|M|SD|N))';
const STAT_VALUE = '[+−-]?(?:\\d+(?:,\\d{3})*(?:\\.\\d+)?|\\.\\d+)';
const STAT_ASSIGNMENT_SOURCE = `(?<![가-힣A-Za-z0-9_])${STAT_SYMBOL}[ \\t]*(?:=|<|>|≤|≥)[ \\t]*${STAT_VALUE}`;
const KOREAN_STAT_SOURCE = `(?<![가-힣A-Za-z0-9_])(?:기울기|회귀[ \\t]*계수|표준[ \\t]*오차)[ \\t]*=[ \\t]*${STAT_VALUE}`;
const CI_SOURCE = '(?<![A-Za-z0-9_])\\d+(?:\\.\\d+)?[ \\t]*%[ \\t]*CI(?:[ \\t]*(?:=|:)?[ \\t]*\\[[^\\]\\r\\n]{1,80}\\])?';

function statisticalAtomRegex() {
  return new RegExp(`(?:${STAT_ASSIGNMENT_SOURCE}|${KOREAN_STAT_SOURCE}|${CI_SOURCE})`, 'giu');
}

function extractStatisticalAtoms(value) {
  const text = String(value || '').normalize('NFC');
  const out = [];
  for (const match of text.matchAll(statisticalAtomRegex())) {
    out.push({
      raw: match[0],
      canonical: normalizeStatisticalAtom(match[0]),
      start: match.index,
      end: match.index + match[0].length
    });
  }
  return out.filter(item => item.canonical);
}

function normalizeStatisticalAtom(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[−–—]/gu, '-')
    .replace(/\s+/gu, '');
}

function auditStatisticalAtoms(source, outputText) {
  const sourceAtoms = extractStatisticalAtoms(source);
  const outputAtoms = extractStatisticalAtoms(outputText);
  const sourceCounts = countCanonical(sourceAtoms);
  const outputCounts = countCanonical(outputAtoms);
  const removed = difference(sourceCounts, outputCounts);
  const added = difference(outputCounts, sourceCounts);
  const broken = findWhitespaceBrokenAtoms(sourceAtoms, outputText);
  return {
    version: VERSION,
    applicable: sourceAtoms.length > 0,
    pass: removed.count === 0 && added.count === 0,
    sourceAtomCount: sourceAtoms.length,
    outputAtomCount: outputAtoms.length,
    removedCount: removed.count,
    addedCount: added.count,
    removedAtoms: removed.items.slice(0, 12),
    addedAtoms: added.items.slice(0, 12),
    whitespaceBrokenCount: broken.length,
    whitespaceBrokenAtoms: broken.slice(0, 12).map(item => item.canonical)
  };
}

function restoreWhitespaceBrokenStatisticalAtoms(source, outputText) {
  const original = String(outputText || '');
  const sourceAtoms = extractStatisticalAtoms(source);
  if (!sourceAtoms.length || !original) {
    return {
      text: original,
      applied: false,
      repairCount: 0,
      repairedAtoms: [],
      audit: auditStatisticalAtoms(source, original)
    };
  }
  const compact = whitespaceCompactMap(original);
  const edits = [];
  const repairedAtoms = [];
  let compactCursor = 0;
  for (const atom of sourceAtoms) {
    const needle = atom.canonical;
    if (!needle) continue;
    const at = compact.text.indexOf(needle, compactCursor);
    if (at < 0) continue;
    compactCursor = at + needle.length;
    const start = compact.map[at];
    const endIndex = compact.map[at + needle.length - 1];
    if (!Number.isInteger(start) || !Number.isInteger(endIndex)) continue;
    const end = endIndex + 1;
    const raw = original.slice(start, end);
    if (normalizeStatisticalAtom(raw) !== needle) continue;
    if (raw === atom.raw) continue;
    // 공백·줄바꿈만 제거하면 같은 원자일 때만 원문 표기로 복원한다.
    // 빈 문단을 건너뛰어 서로 무관한 두 값을 붙이는 일은 허용하지 않는다.
    if (raw.replace(/[^\r\n]/gu, '').length > 1 || /\r?\n[ \t]*\r?\n/u.test(raw)) continue;
    edits.push({ start, end, replacement: atom.raw });
    repairedAtoms.push(needle);
  }
  const text = applyEdits(original, edits);
  return {
    text,
    applied: text !== original,
    repairCount: edits.length,
    repairedAtoms,
    audit: auditStatisticalAtoms(source, text)
  };
}

function findWhitespaceBrokenAtoms(sourceAtoms, outputText) {
  const compact = whitespaceCompactMap(outputText);
  const actualCounts = countCanonical(extractStatisticalAtoms(outputText));
  const seen = new Map();
  const broken = [];
  let cursor = 0;
  for (const atom of sourceAtoms || []) {
    const ordinal = (seen.get(atom.canonical) || 0) + 1;
    seen.set(atom.canonical, ordinal);
    if ((actualCounts.get(atom.canonical) || 0) >= ordinal) continue;
    const at = compact.text.indexOf(atom.canonical, cursor);
    if (at < 0) continue;
    cursor = at + atom.canonical.length;
    const start = compact.map[at];
    const endIndex = compact.map[at + atom.canonical.length - 1];
    if (!Number.isInteger(start) || !Number.isInteger(endIndex)) continue;
    const raw = String(outputText || '').slice(start, endIndex + 1);
    if (/\r?\n/u.test(raw) && normalizeStatisticalAtom(raw) === atom.canonical) {
      broken.push(atom);
    }
  }
  return broken;
}

function whitespaceCompactMap(value) {
  const source = String(value || '').normalize('NFC');
  let text = '';
  const map = [];
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (/\s/u.test(ch)) continue;
    const normalized = normalizeStatisticalAtom(ch);
    for (const item of normalized) {
      text += item;
      map.push(index);
    }
  }
  return { text, map };
}

function countCanonical(atoms) {
  const out = new Map();
  for (const atom of atoms || []) {
    out.set(atom.canonical, Number(out.get(atom.canonical) || 0) + 1);
  }
  return out;
}

function difference(left, right) {
  let count = 0;
  const items = [];
  for (const [atom, occurrences] of left.entries()) {
    const delta = occurrences - Number(right.get(atom) || 0);
    if (delta <= 0) continue;
    count += delta;
    items.push({ atom, count: delta });
  }
  return { count, items };
}

function applyEdits(value, edits) {
  let text = String(value || '');
  for (const edit of [...(edits || [])].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
  }
  return text;
}

module.exports = {
  VERSION,
  extractStatisticalAtoms,
  normalizeStatisticalAtom,
  auditStatisticalAtoms,
  restoreWhitespaceBrokenStatisticalAtoms
};
