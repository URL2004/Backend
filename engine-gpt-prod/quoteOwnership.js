'use strict';

// 원문이 소유한 직접 인용 구간의 감사와 복원.
//
// 기존 voiceProfile.QUOTED_SPAN_RE는 개행을 포함하는 인용과 닫는 자리에
// 여는 곡선 따옴표를 쓴 인용(“말이다.“)을 보지 못한다. 이 경우 원문과
// 결과가 모두 0개로 세어져 내용이 바뀌어도 통과한다. 이 모듈은 그 구간을
// 원문 기준으로 식별하고, 절(heading) 단위로만 대조·복원한다.
//
// - 대상: “…”, ‘…’, "…". 개행을 포함할 수 있다. 『』「」《》〈〉는 출처 제목
//   괄호로 쓰이므로 citationOwnership이 따로 다룬다.
// - 인용 후보는 번호·Markdown 제목 행과 명시적 출처 접두부를 넘지 않는다.
// - 짧은 작품명·용어 인용은 기존 감사(중복 축약 허용)에 맡긴다. 이 모듈은
//   문장 부호가 있거나 긴 직접 인용, 여러 줄 인용, 형식 불확정 후보만 소유한다.
// - 판정할 수 없는 후보(중첩·미닫힘·짝 없는 닫는 기호)는 추측해 고치지 않고
//   원문 창과 결과 창이 같을 때만 통과시킨다.
// - 감사 결과에는 원문 문자열을 담지 않는다. 개수와 순번만 남긴다.
// - 인용 길이는 구조 경계(제목·출처 접두부·표 칸)로 제한한다. 길이 상한을
//   넘은 후보는 넘은 구간 전체를 판정 불가 창으로 남겨 무조건 통과를 막는다.
// - restoreOwnedQuoteLayout은 내용이 압축 기준으로 같은 인용의 내부 공백과
//   원래 따옴표 글리프만 되돌린다. 내용은 바꾸지 않는다.

const DOUBLE_DELIMITERS = new Set(['“', '”', '"']);
const SINGLE_DELIMITERS = new Set(['‘', '’']);
const CLOSERS = Object.freeze({ '“': ['”', '"'], '‘': ['’'], '"': ['"', '”'] });
const TERMINAL_RE = /[.!?。！？…]/u;
const SENTENCE_PUNCT_RE = /[.!?。！？…]/u;
const OWNED_MIN_COMPACT_LENGTH = 25;
// 보고서 인용은 한 절 전체(수천 자)일 수 있다. 이 값은 성능 안전장치일 뿐이다.
const MAX_QUOTE_SPAN = 20000;
const MAX_HEADING_LENGTH = 80;
const HEADING_LINE_RE = /^[ \t]*(?:#{1,6}[ \t]+\S|(?:\d{1,3}(?:\.\d{1,3}){1,4}\.?|\d{1,3}[.)]|[IVXivx]{1,5}\.|[가-하]\.)[ \t]+\S)/u;
const CITATION_PREFIX_RE = /[(（[]?[ \t]*(?<![가-힣A-Za-z0-9])(?:(?:교재[ \t]*)?(?:출처|참고(?:[ \t]*(?:자료|문헌))?)|인용[ \t]*출처|자료[ \t]*출처|sources?|references?)[ \t]*[:：]/giu;
const PAGE_REFERENCE_RE = /^pp?\.[ \t]*\d/u;
const TABLE_ROW_RE = /^[ \t]*\|.*\|[ \t]*$/u;
const FENCED_CODE_RE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gmu;

function normalizeNewlines(value) {
  return String(value ?? '').replace(/\r\n?/gu, '\n');
}

function compact(value) {
  return String(value ?? '').normalize('NFC').replace(/\s+/gu, '');
}

function blankOut(value) {
  return value.replace(/[^\n]/gu, ' ');
}

// 코드 안의 따옴표는 인용이 아니다. 위치를 보존하도록 같은 길이의 공백으로 가린다.
// 닫히지 않은 펜스는 가리지 않는다. 끝까지 가리면 뒤의 인용이 모두 사라져
// 감사가 0개로 통과한다. 행 첫머리가 아닌 ~~~(예: "좋아요~~~")도 펜스가 아니다.
function maskCode(text) {
  return text
    .replace(FENCED_CODE_RE, blankOut)
    .replace(/```[^\n]*?```/gu, blankOut)
    .replace(/`[^`\n]+`/gu, blankOut);
}

function isHeadingLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > MAX_HEADING_LENGTH) return false;
  if (!HEADING_LINE_RE.test(line)) return false;
  if (/^#/u.test(trimmed)) return true;
  return !/[.!?。！？]["”’]?$/u.test(trimmed);
}

function isApostrophe(masked, index) {
  return /[A-Za-z0-9]/u.test(masked[index - 1] || '') && /[A-Za-z0-9]/u.test(masked[index + 1] || '');
}

// 열린 인용 밖에서 로마자 뒤에 붙은 ’는 소유격·축약(students’)이다.
// 바로 뒤에 한글 조사가 오면(Apple’이라는) 짝 잃은 닫는 기호로 본다.
function isTrailingApostrophe(masked, index) {
  return masked[index] === '’'
    && /[A-Za-z0-9]/u.test(masked[index - 1] || '')
    && !/[가-힣]/u.test(masked[index + 1] || '');
}

function familyOf(glyph) {
  if (DOUBLE_DELIMITERS.has(glyph)) return 'double';
  if (SINGLE_DELIMITERS.has(glyph)) return 'single';
  return '';
}

function lineEnd(masked, index, limit) {
  const found = masked.indexOf('\n', index);
  return found < 0 || found > limit ? limit : Math.max(found, index + 1);
}

function lineStart(masked, index, floor) {
  const found = masked.lastIndexOf('\n', index - 1);
  return Math.max(floor, found + 1);
}

function paragraphEnd(masked, from, limit) {
  const match = /\n[ \t]*\n/gu;
  match.lastIndex = from;
  const found = match.exec(masked);
  return found && found.index < limit ? found.index : limit;
}

function makeCandidate(text, kind, start, end, reason = '') {
  const open = text[start];
  const close = text[end - 1];
  const delimited = kind !== 'unresolved';
  const content = delimited ? text.slice(start + 1, end - 1) : '';
  const family = delimited ? familyOf(open) : '';
  const window = delimited ? '' : text.slice(start, end);
  const contentCompact = compact(content);
  const owned = kind !== 'closed' || isOwnedContent(content, contentCompact);
  return {
    kind,
    reason,
    start,
    end,
    open: delimited ? open : '',
    close: delimited ? close : '',
    family,
    content,
    multiline: /\n/u.test(delimited ? content : window),
    owned,
    key: delimited ? `${family}:${contentCompact}` : `U:${compact(window)}`,
    windowCompact: compact(window),
    section: 0
  };
}

function isOwnedContent(content, contentCompact = compact(content)) {
  if (contentCompact.length < 2) return false;
  return /\n/u.test(content)
    || contentCompact.length >= OWNED_MIN_COMPACT_LENGTH
    || SENTENCE_PUNCT_RE.test(content);
}

// 닫는 자리에 같은 여는 기호를 쓴 경우는 강한 종결 부호 바로 뒤이고,
// 그 뒤가 출처 접두부·쪽 표기(p.12)·행 끝·구간 끝일 때만 닫힘으로 인정한다.
// 같은 문단 뒤쪽에 짝 없는 진짜 닫는 기호가 남아 있으면 중첩일 수 있으므로 거절한다.
function isSameGlyphClose(masked, open, openIndex, index, limit) {
  if (index - openIndex < 2) return false;
  if (!TERMINAL_RE.test(masked[index - 1] || '')) return false;
  let cursor = index + 1;
  while (cursor < limit && (masked[cursor] === ' ' || masked[cursor] === '\t')) cursor += 1;
  if (cursor < limit && masked[cursor] !== '\n'
      && !PAGE_REFERENCE_RE.test(masked.slice(cursor, Math.min(limit, cursor + 8)))) return false;
  const end = paragraphEnd(masked, index + 1, limit);
  const closers = CLOSERS[open];
  let depth = 0;
  for (let position = index + 1; position < end; position += 1) {
    const glyph = masked[position];
    if (glyph === open) depth += 1;
    else if (closers.includes(glyph) && glyph !== open) {
      if (depth > 0) depth -= 1;
      else return false;
    }
  }
  return true;
}

function scanOpener(text, masked, openIndex, limit) {
  const open = masked[openIndex];
  const family = familyOf(open);
  const closers = CLOSERS[open];
  const cap = Math.min(limit, openIndex + MAX_QUOTE_SPAN);
  for (let index = openIndex + 1; index < cap; index += 1) {
    const glyph = masked[index];
    if (familyOf(glyph) !== family) continue;
    if (family === 'single' && isApostrophe(masked, index)) continue;
    if (closers.includes(glyph)) return makeCandidate(text, 'closed', openIndex, index + 1);
    if (glyph === open && isSameGlyphClose(masked, open, openIndex, index, limit)) {
      return makeCandidate(text, 'same_glyph_close', openIndex, index + 1);
    }
    return makeCandidate(text, 'unresolved', openIndex, lineEnd(masked, openIndex, limit), 'nested_or_ambiguous');
  }
  // 상한을 넘으면 구간 끝까지를 창으로 남긴다. 상한 뒤나 첫 행 뒤를 비우면
  // 그 부분의 변경이 감사 밖으로 빠진다.
  if (cap < limit) return makeCandidate(text, 'unresolved', openIndex, limit, 'too_long');
  return makeCandidate(text, 'unresolved', openIndex, lineEnd(masked, openIndex, limit), 'unclosed');
}

function scanSegment(text, masked, start, limit, candidates) {
  let index = start;
  let floor = start;
  while (index < limit) {
    const glyph = masked[index];
    const opener = glyph === '“' || glyph === '"' || (glyph === '‘' && !isApostrophe(masked, index));
    if (opener) {
      const candidate = scanOpener(text, masked, index, limit);
      candidates.push(candidate);
      index = candidate.end;
      floor = index;
      continue;
    }
    if (glyph === '”' || (glyph === '’' && !isApostrophe(masked, index) && !isTrailingApostrophe(masked, index))) {
      candidates.push(makeCandidate(text, 'unresolved', lineStart(masked, index, floor), index + 1, 'stray_close'));
      index += 1;
      floor = index;
      continue;
    }
    index += 1;
  }
}

/**
 * 원문 또는 결과의 인용 후보를 식별한다. 좌표는 CRLF를 LF로 정규화한
 * `text` 기준이다.
 */
function parseQuoteOwnership(value) {
  const text = normalizeNewlines(value);
  const masked = maskCode(text);
  const sections = [{ index: 0, key: '', start: 0, end: text.length }];
  const cuts = new Set([0, text.length]);
  let offset = 0;
  for (const line of masked.split('\n')) {
    const start = offset;
    const end = offset + line.length;
    offset = end + 1;
    // 표의 칸 경계를 넘는 인용은 없다. 칸마다 따로 훑는다.
    if (TABLE_ROW_RE.test(line)) {
      cuts.add(start);
      cuts.add(end);
      for (let bar = line.indexOf('|'); bar >= 0; bar = line.indexOf('|', bar + 1)) cuts.add(start + bar);
      continue;
    }
    if (!isHeadingLine(line)) continue;
    sections[sections.length - 1].end = start;
    sections.push({ index: sections.length, key: compact(text.slice(start, end)), start, end: text.length });
    cuts.add(start);
    cuts.add(end);
  }
  for (const match of masked.matchAll(new RegExp(CITATION_PREFIX_RE.source, CITATION_PREFIX_RE.flags))) {
    cuts.add(match.index);
  }
  const boundaries = [...cuts].sort((left, right) => left - right);
  const candidates = [];
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    scanSegment(text, masked, boundaries[index], boundaries[index + 1], candidates);
  }
  for (const candidate of candidates) {
    candidate.section = sections.findLast(section => section.start <= candidate.start)?.index ?? 0;
  }
  return { text, sections, cuts: boundaries, candidates };
}

function sameSectionKeys(left, right) {
  return left.sections.length === right.sections.length
    && left.sections.every((section, index) => section.key === right.sections[index].key);
}

function countStrings(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, Number(counts.get(value) || 0) + 1);
  return counts;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

// 순서를 보존하는 최장 공통 부분열. 같은 키가 반복될 때도 결정적이다.
function alignKeys(left, right) {
  const rows = left.length;
  const cols = right.length;
  if (rows === cols && left.every((key, i) => key === right[i])) return left.map((_, i) => [i, i]);
  // Bound memory for quote-dense documents. A monotone exact-key match may
  // conservatively leave ambiguous quotes unresolved; it never fabricates a
  // match or treats an unmatched source quote as preserved.
  if (rows * cols > 250000) {
    const positions = new Map();
    right.forEach((key, i) => {
      if (!positions.has(key)) positions.set(key, { indexes: [], cursor: 0 });
      positions.get(key).indexes.push(i);
    });
    const pairs = [];
    let last = -1;
    left.forEach((key, i) => {
      const found = positions.get(key);
      if (!found) return;
      while (found.cursor < found.indexes.length && found.indexes[found.cursor] <= last) found.cursor += 1;
      if (found.cursor < found.indexes.length) {
        last = found.indexes[found.cursor++];
        pairs.push([i, last]);
      }
    });
    return pairs;
  }
  const table = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (left[i] === right[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) i += 1;
    else j += 1;
  }
  return pairs;
}

function multisetMatchCount(left, right) {
  const rightCounts = countStrings(right);
  let total = 0;
  for (const [key, count] of countStrings(left)) total += Math.min(count, Number(rightCounts.get(key) || 0));
  return total;
}

function groupsFor(parsed, aligned) {
  return aligned
    ? parsed.sections.map(section => ({ index: section.index, start: section.start, end: section.end }))
    : [{ index: null, start: 0, end: parsed.text.length }];
}

function inGroup(candidate, group) {
  return group.index === null || candidate.section === group.index;
}

function ownedDelimited(parsed, group) {
  return parsed.candidates.filter(candidate => (
    inGroup(candidate, group) && candidate.kind !== 'unresolved' && candidate.owned
  ));
}

function participatingDelimited(parsed, group, sourceOwnedKeys) {
  return parsed.candidates.filter(candidate => (
    inGroup(candidate, group)
      && candidate.kind !== 'unresolved'
      && (candidate.owned || sourceOwnedKeys.has(candidate.key))
  ));
}

function compareGroup(src, out, sourceGroup, outputGroup) {
  const sourceItems = ownedDelimited(src, sourceGroup);
  const sourceOwnedKeys = new Set(sourceItems.map(item => item.key));
  const outputItems = participatingDelimited(out, outputGroup, sourceOwnedKeys);
  const sourceKeys = sourceItems.map(item => item.key);
  const outputKeys = outputItems.map(item => item.key);
  const pairs = alignKeys(sourceKeys, outputKeys);
  return {
    sourceItems,
    outputItems,
    pairs,
    orderPreserved: pairs.length === multisetMatchCount(sourceKeys, outputKeys)
  };
}

function unresolvedMismatches(src, out, sourceGroup, outputGroup) {
  const sourceText = compact(src.text.slice(sourceGroup.start, sourceGroup.end));
  const outputText = compact(out.text.slice(outputGroup.start, outputGroup.end));
  let count = 0;
  const sourceWindows = new Set(src.candidates
    .filter(candidate => inGroup(candidate, sourceGroup) && candidate.kind === 'unresolved')
    .map(candidate => candidate.windowCompact));
  for (const window of sourceWindows) {
    if (countOccurrences(outputText, window) !== countOccurrences(sourceText, window)) count += 1;
  }
  const outputWindows = new Set(out.candidates
    .filter(candidate => inGroup(candidate, outputGroup) && candidate.kind === 'unresolved')
    .map(candidate => candidate.windowCompact));
  for (const window of outputWindows) {
    if (sourceWindows.has(window)) continue;
    if (countOccurrences(outputText, window) !== countOccurrences(sourceText, window)) count += 1;
  }
  return count;
}

/**
 * 원문 소유 인용의 감사. 기존 auditDirectQuoteIntegrity를 대체하지 않는다.
 * 최종 통과는 기존 감사 AND 이 감사로 판정한다.
 */
function auditQuoteOwnership(source, output) {
  const src = parseQuoteOwnership(source);
  const out = parseQuoteOwnership(output);
  const exact = src.text === out.text;
  const sectionAligned = sameSectionKeys(src, out);
  const sourceGroups = groupsFor(src, sectionAligned);
  const outputGroups = groupsFor(out, sectionAligned);
  let sourceCount = 0;
  let outputCount = 0;
  let missingCount = 0;
  let introducedCount = 0;
  let introducedMalformedCount = 0;
  let delimiterRepairedCount = 0;
  let unresolvedCount = 0;
  let orderPreserved = true;
  const changedSections = [];
  for (let index = 0; index < sourceGroups.length; index += 1) {
    const sourceGroup = sourceGroups[index];
    const outputGroup = outputGroups[index];
    const group = compareGroup(src, out, sourceGroup, outputGroup);
    const matchedOutput = new Set(group.pairs.map(([, right]) => right));
    const missing = group.sourceItems.length - group.pairs.length;
    const introduced = group.outputItems.length - group.pairs.length;
    const unresolved = unresolvedMismatches(src, out, sourceGroup, outputGroup);
    sourceCount += group.sourceItems.length
      + src.candidates.filter(candidate => inGroup(candidate, sourceGroup) && candidate.kind === 'unresolved').length;
    outputCount += group.outputItems.length
      + out.candidates.filter(candidate => inGroup(candidate, outputGroup) && candidate.kind === 'unresolved').length;
    missingCount += missing;
    introducedCount += introduced;
    introducedMalformedCount += group.outputItems
      .filter((item, itemIndex) => !matchedOutput.has(itemIndex) && item.kind === 'same_glyph_close').length;
    delimiterRepairedCount += group.pairs
      .filter(([left, right]) => group.sourceItems[left].kind !== group.outputItems[right].kind).length;
    unresolvedCount += unresolved;
    orderPreserved = orderPreserved && group.orderPreserved;
    if (missing || unresolved || !group.orderPreserved) {
      changedSections.push({ section: sourceGroup.index, missing, introduced, unresolved });
    }
  }
  const contentChanged = !exact && (missingCount > 0 || !orderPreserved || unresolvedCount > 0);
  return {
    version: 1,
    pass: exact || (!contentChanged && introducedMalformedCount === 0),
    exact,
    sectionAligned,
    sourceCount,
    outputCount,
    malformedSourceCount: src.candidates.filter(candidate => candidate.kind === 'same_glyph_close').length,
    multilineSourceCount: src.candidates.filter(candidate => candidate.kind !== 'unresolved' && candidate.multiline).length,
    unresolvedSourceCount: src.candidates.filter(candidate => candidate.kind === 'unresolved').length,
    contentChanged,
    missingCount,
    introducedCount,
    introducedMalformedCount,
    delimiterRepairedCount,
    unresolvedCount,
    orderPreserved,
    changedSections
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

// 따옴표만 빠진 경우: 같은 절 안의 같은 빈자리에서, 원문 절과 결과 절에
// 그 문구가 각각 정확히 한 번 있을 때만 원문 기호로 다시 감싼다.
function findUniqueUnquoted(src, out, sourceSection, outputSection, slotStart, slotEnd, missing) {
  const needle = compact(missing.content);
  if (needle.length < 2) return null;
  if (countOccurrences(compact(src.text.slice(sourceSection.start, sourceSection.end)), needle) !== 1) return null;
  if (countOccurrences(compact(out.text.slice(outputSection.start, outputSection.end)), needle) !== 1) return null;
  const pattern = new RegExp([...needle].map(escapeRegExp).join('\\s*'), 'u');
  const found = pattern.exec(out.text.slice(slotStart, slotEnd));
  if (!found) return null;
  const start = slotStart + found.index;
  const end = start + found[0].length;
  if (out.candidates.some(candidate => candidate.start < end && start < candidate.end)) return null;
  if (out.cuts.some(cut => cut > start && cut < end)) return null;
  return { start, end };
}

function planSectionEdits(src, out, section, edits) {
  const outputSection = out.sections[section.index];
  const group = compareGroup(src, out, section, outputSection);
  const sourceKeyCounts = countStrings(src.candidates
    .filter(candidate => candidate.section === section.index && candidate.kind !== 'unresolved')
    .map(candidate => candidate.key));
  const matchedSource = new Map(group.pairs.map(([left, right]) => [left, right]));
  const matchedOutput = new Set(group.pairs.map(([, right]) => right));
  let refused = 0;
  for (let sourceIndex = 0; sourceIndex < group.sourceItems.length; sourceIndex += 1) {
    if (matchedSource.has(sourceIndex)) continue;
    const missing = group.sourceItems[sourceIndex];
    // 같은 절에 같은 인용이 여러 번 있으면 어느 자리가 빠졌는지 알 수 없다.
    if (sourceKeyCounts.get(missing.key) !== 1) {
      refused += 1;
      continue;
    }
    const previous = group.pairs.filter(([left]) => left < sourceIndex).at(-1) || null;
    const next = group.pairs.find(([left]) => left > sourceIndex) || null;
    const lowSource = previous ? previous[0] : -1;
    const highSource = next ? next[0] : group.sourceItems.length;
    const lowOutput = previous ? previous[1] : -1;
    const highOutput = next ? next[1] : group.outputItems.length;
    const slotStart = previous ? group.outputItems[previous[1]].end : outputSection.start;
    const slotEnd = next ? group.outputItems[next[1]].start : outputSection.end;
    const missingInSlot = [];
    for (let index = lowSource + 1; index < highSource; index += 1) {
      if (!matchedSource.has(index)) missingInSlot.push(index);
    }
    const introducedInSlot = [];
    for (let index = lowOutput + 1; index < highOutput; index += 1) {
      if (!matchedOutput.has(index)) introducedInSlot.push(group.outputItems[index]);
    }
    if (missingInSlot.length === 1 && introducedInSlot.length === 1) {
      const rewritten = introducedInSlot[0];
      // 원문의 다른 인용과 같은 내용이면 이동한 정상 인용이므로 덮어쓰지 않는다.
      if (rewritten.family !== missing.family || sourceKeyCounts.has(rewritten.key)) {
        refused += 1;
        continue;
      }
      edits.push({ start: rewritten.start, end: rewritten.end, text: src.text.slice(missing.start, missing.end) });
      continue;
    }
    if (introducedInSlot.length === 0) {
      const found = findUniqueUnquoted(src, out, section, outputSection, slotStart, slotEnd, missing);
      if (!found) {
        refused += 1;
        continue;
      }
      edits.push({
        start: found.start,
        end: found.end,
        text: `${missing.open}${out.text.slice(found.start, found.end)}${missing.close}`
      });
      continue;
    }
    refused += 1;
  }
  return refused;
}

/**
 * 원문 소유 인용을 절 단위 증거가 있을 때만 복원한다. 검증을 통과하지 못한
 * 문자열은 반환하지 않는다. `auditAfter`는 항상 반환한 `text`에 대한 감사다.
 */
function restoreOwnedQuotes(source, output) {
  const original = String(output ?? '');
  const auditBefore = auditQuoteOwnership(source, original);
  const result = (text, applied, restoredCount, reason, auditAfter, extra = {}) => ({
    text, applied, restoredCount, reason, auditBefore, auditAfter, ...extra
  });
  if (auditBefore.pass) return result(original, false, 0, 'quote_ownership_pass', auditBefore);
  if (!auditBefore.sectionAligned) return result(original, false, 0, 'quote_ownership_section_unaligned', auditBefore);
  const src = parseQuoteOwnership(source);
  const out = parseQuoteOwnership(original);
  const edits = [];
  let refusedCount = 0;
  for (const section of src.sections) {
    if ([src, out].some(parsed => parsed.candidates.some(candidate => candidate.section === section.index && candidate.kind === 'unresolved'))) {
      refusedCount += 1;
      continue;
    }
    refusedCount += planSectionEdits(src, out, section, edits);
  }
  if (!edits.length) {
    return result(original, false, 0, 'quote_ownership_not_safely_restorable', auditBefore, { refusedCount });
  }
  edits.sort((left, right) => left.start - right.start);
  for (let index = 1; index < edits.length; index += 1) {
    if (edits[index].start < edits[index - 1].end) {
      return result(original, false, 0, 'quote_ownership_overlapping_edits', auditBefore, { refusedCount });
    }
  }
  let text = out.text;
  for (const edit of [...edits].reverse()) {
    text = `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`;
  }
  if (/\r\n/u.test(original)) text = text.replace(/\n/gu, '\r\n');
  const candidateAudit = auditQuoteOwnership(source, text);
  if (!quoteOwnershipNotWorse(auditBefore, candidateAudit)) {
    return result(original, false, 0, 'post_restore_validation_failed', auditBefore, {
      refusedCount,
      rejectedAudit: candidateAudit
    });
  }
  return result(text, true, edits.length, 'restored', candidateAudit, { refusedCount });
}

function quoteOwnershipNotWorse(before, after) {
  if (before.pass && !after.pass) return false;
  if (before.orderPreserved && !after.orderPreserved) return false;
  for (const key of ['missingCount', 'unresolvedCount', 'introducedCount', 'introducedMalformedCount']) {
    if (after[key] > before[key]) return false;
  }
  for (const section of after.changedSections) {
    const prior = before.changedSections.find(item => item.section === section.section);
    if (!prior || section.missing > prior.missing || section.unresolved > prior.unresolved) return false;
  }
  return true;
}

function delimitedInSection(parsed, index) {
  return parsed.candidates.filter(candidate => candidate.section === index && candidate.kind !== 'unresolved');
}

/**
 * 기존 순번 기반 복원(restoreDirectQuoteContents/restoreMissingQuoteDelimiters)의
 * 결과를 채택해도 되는지 판정한다. 소유 인용이 없어도 적용된다.
 * - 원문 절에 있던 인용 내용을 다른 내용으로 덮어쓰면 거부한다(A,B→B,C).
 * - 원문의 같은 절에 없는 인용을 새로 만들거나, 원문보다 많이 만들면 거부한다.
 * - 소유 인용 감사가 나빠지면 거부한다.
 */
function assessLegacyQuoteRestore(source, before, after) {
  if (normalizeNewlines(before) === normalizeNewlines(after)) return { veto: false, reason: 'unchanged' };
  const src = parseQuoteOwnership(source);
  const previous = parseQuoteOwnership(before);
  const next = parseQuoteOwnership(after);
  if (!sameSectionKeys(src, next) || !sameSectionKeys(previous, next)) {
    return { veto: true, reason: 'legacy_restore_section_unaligned' };
  }
  for (const section of src.sections) {
    const sourceCounts = countStrings(delimitedInSection(src, section.index).map(item => item.key));
    const beforeKeys = delimitedInSection(previous, section.index).map(item => item.key);
    const afterKeys = delimitedInSection(next, section.index).map(item => item.key);
    if (beforeKeys.length === afterKeys.length) {
      for (let index = 0; index < beforeKeys.length; index += 1) {
        if (beforeKeys[index] === afterKeys[index]) continue;
        if (sourceCounts.has(beforeKeys[index])) {
          return { veto: true, reason: 'legacy_restore_overwrote_source_quote', section: section.index };
        }
        if (!sourceCounts.has(afterKeys[index])) {
          return { veto: true, reason: 'legacy_restore_inserted_unowned_quote', section: section.index };
        }
      }
    } else {
      const pairs = alignKeys(beforeKeys, afterKeys);
      const matchedBefore = new Set(pairs.map(([left]) => left));
      const matchedAfter = new Set(pairs.map(([, right]) => right));
      if (beforeKeys.some((key, index) => !matchedBefore.has(index) && sourceCounts.has(key))) {
        return { veto: true, reason: 'legacy_restore_removed_source_quote', section: section.index };
      }
      if (afterKeys.some((key, index) => !matchedAfter.has(index) && !sourceCounts.has(key))) {
        return { veto: true, reason: 'legacy_restore_inserted_unowned_quote', section: section.index };
      }
    }
    const beforeCounts = countStrings(beforeKeys);
    for (const [key, count] of countStrings(afterKeys)) {
      if (count > Number(beforeCounts.get(key) || 0) && count > Number(sourceCounts.get(key) || 0)) {
        return { veto: true, reason: 'legacy_restore_multiplicity_exceeds_source', section: section.index };
      }
    }
  }
  const ownershipBefore = auditQuoteOwnership(source, before);
  const ownershipAfter = auditQuoteOwnership(source, after);
  if (ownershipAfter.missingCount > ownershipBefore.missingCount
      || ownershipAfter.unresolvedCount > ownershipBefore.unresolvedCount
      || (ownershipBefore.orderPreserved && !ownershipAfter.orderPreserved)) {
    return { veto: true, reason: 'legacy_restore_ownership_regressed' };
  }
  return { veto: false, reason: 'legacy_restore_section_safe' };
}

// 절이 맞으면 절 안의 정렬 쌍을, 맞지 않으면 원문과 결과에서 각각 한 번뿐인
// 내용만 짝짓는다. 키(계열:압축 내용)가 같은 쌍만 나오므로 내용은 같다.
function mappedOwnedPairs(src, out) {
  const aligned = sameSectionKeys(src, out);
  const sourceGroups = groupsFor(src, aligned);
  const outputGroups = groupsFor(out, aligned);
  const pairs = [];
  let sourceOwnedCount = 0;
  for (let index = 0; index < sourceGroups.length; index += 1) {
    const group = compareGroup(src, out, sourceGroups[index], outputGroups[index]);
    sourceOwnedCount += group.sourceItems.length;
    const sourceCounts = countStrings(group.sourceItems.map(item => item.key));
    const outputCounts = countStrings(group.outputItems.map(item => item.key));
    for (const [left, right] of group.pairs) {
      const sourceItem = group.sourceItems[left];
      const outputItem = group.outputItems[right];
      if (!aligned && (sourceCounts.get(sourceItem.key) !== 1 || outputCounts.get(outputItem.key) !== 1)) continue;
      pairs.push({ source: sourceItem, output: outputItem });
    }
  }
  return { aligned, pairs, sourceOwnedCount };
}

function gapBounds(text, index, before) {
  let cursor = index;
  if (before) {
    while (cursor > 0 && /\s/u.test(text[cursor - 1])) cursor -= 1;
    return [cursor, index];
  }
  while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1;
  return [index, cursor];
}

function isStandaloneGap(text, [start, end], before) {
  if (before ? start === 0 : end === text.length) return true;
  return text.slice(start, end).includes('\n');
}

function lineAround(text, index) {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const found = text.indexOf('\n', index);
  return text.slice(start, found < 0 ? text.length : found);
}

// 인용 앞뒤가 원문에서 행 안(inline)인지 독립 행(standalone)인지만 맞춘다.
// 공백 양식(빈 줄 개수 등)은 결과를 따른다. 제목 행과 붙이거나 제목 행을
// 쪼개는 편집은 만들지 않는다.
function boundaryEdit(src, out, sourceIndex, outputIndex, before) {
  const sourceGap = gapBounds(src.text, sourceIndex, before);
  const outputGap = gapBounds(out.text, outputIndex, before);
  const sourceStandalone = isStandaloneGap(src.text, sourceGap, before);
  if (sourceStandalone === isStandaloneGap(out.text, outputGap, before)) return null;
  if (before ? outputGap[0] === 0 : outputGap[1] === out.text.length) return null;
  const neighbor = lineAround(out.text, before ? outputGap[0] - 1 : outputGap[1]);
  if (isHeadingLine(neighbor)) return null;
  let replacement = src.text.slice(sourceGap[0], sourceGap[1]);
  if (sourceStandalone && !replacement.includes('\n')) replacement = '\n';
  return { start: outputGap[0], end: outputGap[1], text: replacement };
}

function planLayoutEdits(src, out, pairs, withBoundaries) {
  const edits = new Map();
  let conflict = false;
  const put = edit => {
    if (!edit || (edit.start === edit.end && !edit.text)) return;
    const key = `${edit.start}:${edit.end}`;
    if (edits.has(key) && edits.get(key).text !== edit.text) conflict = true;
    edits.set(key, edit);
  };
  for (const { source: sourceItem, output: outputItem } of pairs) {
    const span = src.text.slice(sourceItem.start, sourceItem.end);
    if (out.text.slice(outputItem.start, outputItem.end) !== span) {
      put({ start: outputItem.start, end: outputItem.end, text: span });
    }
    if (!withBoundaries) continue;
    put(boundaryEdit(src, out, sourceItem.start, outputItem.start, true));
    put(boundaryEdit(src, out, sourceItem.end, outputItem.end, false));
  }
  if (conflict) return null;
  const list = [...edits.values()].sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < list.length; index += 1) {
    if (list[index].start < list[index - 1].end) return null;
  }
  return list;
}

function applyEdits(text, edits) {
  let result = text;
  for (const edit of [...edits].reverse()) result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`;
  return result;
}

// 같은 자리의 삽입(앞 경계 줄바꿈)은 인용 앞에 들어가므로 시작 위치를 민다.
function shiftedPosition(edits, position) {
  let shift = 0;
  for (const edit of edits) {
    if (edit.end <= position) shift += edit.text.length - (edit.end - edit.start);
  }
  return position + shift;
}

function glyphFree(value) {
  return compact(value).replace(/[“”"]/gu, '"').replace(/[‘’]/gu, '\'');
}

function crlfOffset(lfText, offset) {
  return offset + countOccurrences(lfText.slice(0, offset), '\n');
}

/**
 * 압축 내용이 원문과 같은 소유 인용 구간의 배치를 원문대로 되돌린다.
 * - 구간 안: 원문의 공백·줄바꿈과 원래 따옴표 글리프(“…“ 포함)를 그대로 쓴다.
 * - 구간 밖: 앞뒤가 행 안/독립 행인 관계만 원문에 맞춘다. 제목은 넘지 않는다.
 * - 내용(따옴표 계열 안의 글리프 차이 제외)과 절 제목은 바뀌지 않음을 검증한다.
 * `protectedBlocks`는 반환한 `text` 기준 좌표이며 뒤 단계가 쪼개지 말아야 할 구간이다.
 */
function restoreOwnedQuoteLayout(source, output) {
  const original = String(output ?? '');
  const crlf = /\r\n/u.test(original);
  const src = parseQuoteOwnership(source);
  const out = parseQuoteOwnership(original);
  const auditBefore = auditQuoteOwnership(source, original);
  const { aligned, pairs, sourceOwnedCount } = mappedOwnedPairs(src, out);
  const finish = (lfText, edits, active, applied, reason, auditAfter) => {
    const text = applied ? (crlf ? lfText.replace(/\n/gu, '\r\n') : lfText) : original;
    const protectedBlocks = active.map(({ source: sourceItem, output: outputItem }) => {
      const start = shiftedPosition(edits, outputItem.start);
      const end = applied ? start + sourceItem.end - sourceItem.start : outputItem.end;
      return {
        start: crlf ? crlfOffset(lfText, start) : start,
        end: crlf ? crlfOffset(lfText, end) : end,
        section: sourceItem.section,
        kind: sourceItem.kind,
        multiline: sourceItem.multiline,
        sourceStart: sourceItem.start,
        sourceEnd: sourceItem.end
      };
    }).filter(block => block.end > block.start);
    return {
      text,
      applied,
      sectionAligned: aligned,
      changedCount: applied ? edits.length : 0,
      reason,
      mappedCount: protectedBlocks.length,
      unmappedSourceCount: sourceOwnedCount - protectedBlocks.length,
      protectedBlocks,
      auditBefore,
      auditAfter
    };
  };
  if (!pairs.length) return finish(out.text, [], [], false, 'quote_layout_no_mapped_quotes', auditBefore);
  let active = pairs.slice();
  let withBoundaries = true;
  for (let attempt = 0; attempt <= pairs.length + 1; attempt += 1) {
    const edits = planLayoutEdits(src, out, active, withBoundaries);
    if (!edits) {
      if (!withBoundaries) break;
      withBoundaries = false;
      continue;
    }
    if (!edits.length) {
      return finish(out.text, [], active, false, 'quote_layout_already_source', auditBefore);
    }
    const text = applyEdits(out.text, edits);
    const parsed = parseQuoteOwnership(text);
    const globallySafe = glyphFree(text) === glyphFree(out.text) && sameSectionKeys(parsed, out);
    const bad = new Set(active.filter(({ source: sourceItem, output: outputItem }) => {
      const start = shiftedPosition(edits, outputItem.start);
      const end = start + sourceItem.end - sourceItem.start;
      return !parsed.candidates.some(candidate => (
        candidate.start === start && candidate.end === end && candidate.kind === sourceItem.kind
      ));
    }));
    const auditAfter = globallySafe && !bad.size ? auditQuoteOwnership(source, text) : null;
    const regressed = auditAfter && (auditAfter.missingCount > auditBefore.missingCount
      || auditAfter.unresolvedCount > auditBefore.unresolvedCount
      || (auditBefore.pass && !auditAfter.pass));
    if (auditAfter && !regressed) return finish(text, edits, active, true, 'quote_layout_restored', auditAfter);
    if (bad.size) {
      active = active.filter(pair => !bad.has(pair));
    } else if (withBoundaries) {
      withBoundaries = false;
    } else {
      // 원문 글리프(예: “…“)가 결과 문맥에서 닫힘으로 읽히지 않는 쌍을 빼고 다시 본다.
      const kept = active.filter(({ source: sourceItem, output: outputItem }) => (
        sourceItem.open === outputItem.open && sourceItem.close === outputItem.close
      ));
      if (kept.length === active.length) break;
      active = kept;
    }
    if (!active.length) break;
  }
  // 되돌리지 못해도 내용이 같은 인용은 결과 좌표 그대로 보호 구간으로 알린다.
  return finish(out.text, [], pairs, false, 'quote_layout_not_safely_restorable', auditBefore);
}

module.exports = {
  quoteOwnershipNotWorse,
  parseQuoteOwnership,
  auditQuoteOwnership,
  restoreOwnedQuotes,
  restoreOwnedQuoteLayout,
  assessLegacyQuoteRestore,
  isOwnedContent
};
