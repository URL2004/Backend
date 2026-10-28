'use strict';

const { syntaxSpans } = require('../engine/textSyntax');
// Explicit punctuation distinguishes enumeration from family/order nouns
// (첫째 아이, 두 번째 실험). Never infer or renumber a missing item.
const ORDINAL = '(?:(?:첫|둘|셋|넷|다섯|여섯|일곱|여덟|아홉|열|열한|열두|열세|열네|열다섯|열여섯|열일곱|열여덟|열아홉|스무)째|(?:첫|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\\s*번째)';
const ORDINAL_END = '(?:(?:로|으로)(?:는)?(?:[,，:：]\\s*|\\s+)|[,，:：]\\s*|[.．]\\s+)';
// Adverb particles stay editable; their ordinal identity is checked below.
const PREFIX = new RegExp(`^(\\s*${ORDINAL}(?:[,，:：]\\s*|[.．]\\s+))(\\S[\\s\\S]*)$`, 'u');
// Explicit enumerative predicate frames, not arbitrary ordinal adjectives
// such as "첫 번째 실험" or "첫째 아이". These may have no comma.
const FRAME_LEAD = '(?:(?:본|이번|해당)\\s*(?:연구|조사|분석|프로젝트)의\\s+|[가-힣]{2,16}(?:이|가|은|는)\\s+(?:중요한|필요한|유용한|효과적인)\\s+)?';
const FRAME_NOUN = '(?:의의|이유|목적|한계|원칙|특징|과제|장점|문제|요인|방안|방법|대안|해결책)';
const LIST_INTRO = '(?:장점|단점|특징|이유|문제|방법|원칙)(?:으로는|로는|은|는)';
const FRAME_TAIL = `\\s+${FRAME_NOUN}(?:(?:은|는|로는|으로는)\\s+|(?:로|으로)[,，:：]\\s*)`;
function ordinalPrefix(value) {
  // A comma enumerator is syntactically independent; a frame such as
  // "본 연구의 첫 번째 의의는" is not. Keep the entire frame sentence
  // editable, and enforce its ordinal through the structural signature.
  // Splitting even just "첫 번째" can create "첫 번째 개 물림 사고...".
  return String(value || '').match(PREFIX);
}

function ordinalNumber(value) {
  const ordinal = String(value).replace(/\s+/gu, '');
  const roots = ['첫', '둘', '셋', '넷', '다섯', '여섯', '일곱', '여덟', '아홉', '열', '열한', '열두', '열세', '열네', '열다섯', '열여섯', '열일곱', '열여덟', '열아홉', '스무'];
  const root = ordinal.replace(/(?:번째|째)$/u, '');
  return roots.indexOf(({ 두: '둘', 세: '셋', 네: '넷' })[root] || root) + 1;
}

function ordinalMarkers(value, { source } = {}) {
  const text = String(value || '');
  const literals = syntaxSpans(text);
  const re = new RegExp(`((?:^[ \\t]*|\\n[ \\t]*|[.!?。！？][ \\t]+)(?:(?:반면|하지만|그러나|한편|또한|다만|그리고)[,，]?[ \\t]+)?)(${ORDINAL})(?:(?:로|으로)(?:는)?(?:[,，:：](?=\\s|[가-힣A-Za-z])|(?=\\s))|[,，:：](?=\\s|[가-힣A-Za-z])|[.．](?=\\s))`, 'gu');
  const markers = [];
  for (const match of text.matchAll(re)) {
    const start = match.index + match[1].length;
    if (literals.some(span => span.start <= start && span.end > start)) continue;
    // "첫 번째 사례" and "첫 번째로 볼 사례" are the same noun frame.
    if (/^(?:로|으로)(?:는)?\s+(?:볼|살펴볼|다룰|제시할|소개할|검토할)\s+(?:표현|문장|사례|항목|대상)/u.test(text.slice(start + match[2].length))) continue;
    // These explicit reference frames describe an ordered noun. An arbitrary
    // adjective cannot prove that: `첫째로 안전한 장비를 사용한다` is an item.
    const tail = text.slice(start + match[2].length);
    if (/^(?:로|으로)(?:는)?\s+비판할\s+(?:점|대목|부분)(?:은|는|이|가)(?=\s)/u.test(tail)
        || /번째$/u.test(match[2])
          && /^(?:로|으로)(?:는)?\s+(?:소개|제시|언급|설명)되는\s/u.test(tail)) continue;
    markers.push({ marker: match[2].replace(/\s+/gu, ''), number: ordinalNumber(match[2]), start,
      lineOrdinal: text.slice(0, start).split('\n').length });
  }
  // An explicit list introduction may precede the first item in its sentence.
  // Without it a pair "장점은 첫째, ... 둘째, ..." was counted as [2], making
  // repeated advantage/disadvantage lists impossible to align or restore.
  const introduced = new RegExp(`(^[ \\t]*|\\n[ \\t]*|[.!?。！？][ \\t]+)(${LIST_INTRO}[ \\t]+)(${ORDINAL})[,，:：](?=\\s|[가-힣A-Za-z])`, 'gu');
  for (const match of text.matchAll(introduced)) {
    const start = match.index + match[1].length + match[2].length;
    if (literals.some(span => span.start <= start && span.end > start)) continue;
    markers.push({ marker: match[3].replace(/\s+/gu, ''), number: ordinalNumber(match[3]), start,
      lineOrdinal: text.slice(0, start).split('\n').length });
  }
  const inlineAdverbs = new RegExp(`([,，][ \\t]+)(${ORDINAL})(?:로|으로)(?:는)?(?=\\s|[,，])`, 'gu');
  for (const match of text.matchAll(inlineAdverbs)) {
    const start = match.index + match[1].length, number = ordinalNumber(match[2]);
    const previous = markers.reduce((best, item) => item.start < start
      && (!best || item.start > best.start) ? item : best, null);
    if (!previous || previous.number + 1 !== number
        || literals.some(span => span.start <= start && span.end > start)) continue;
    markers.push({ marker: match[2].replace(/\s+/gu, ''), number, start,
      lineOrdinal: text.slice(0, start).split('\n').length });
  }
  // An enumerator used as the topic still owns its item: 둘째, X -> 둘째는 X.
  // A predicate is required so family references (첫째는 학교에 갔다) are not
  // promoted to structural markers merely because they contain an ordinal.
  const topics = new RegExp(`(^[ \\t]*|\\n[ \\t]*|[.!?。！？][ \\t]+)(${ORDINAL})(?:은|는)\\s+([^.!?。！？\\n]{1,160}(?:이다|입니다|것이다|것입니다|여부다|여부입니다))(?=[.!?。！？]|$)`, 'gu');
  const hasEnumeration = markers.length > 0 || /(?:이유|목적|원칙|특징|과제|장점|단점|문제|요인|항목|방법)[^.!?\n]{0,30}(?:[두세네]|다섯|여섯|\d+)\s*가지/u.test(text)
    || /(?:[두세네]|다섯|여섯|\d+)\s*가지\s*(?:이유|목적|원칙|특징|과제|장점|단점|문제|요인|항목|방법)/u.test(text);
  // A source item inside a comma series (`…, 셋째, …`) is not a counted
  // marker; promoting it to a sentence topic is a split, not an addition.
  const sourceMarkers = source != null ? ordinalMarkers(source) : null;
  const topicMatches = [...text.matchAll(topics)].filter(match => {
    const start = match.index + match[1].length;
    return !literals.some(span => span.start <= start && span.end > start);
  });
  const inlineSources = source != null ? inlineOrdinalItems(source, sourceMarkers) : [];
  const inlinePairs = topicMatches.map(match => inlineSources.filter(item =>
    item.number === ordinalNumber(match[2])
      && !sourceMarkers.some(marker => marker.number === item.number)
      && inlineOrdinalBodyMatches(source, item.start, text, match.index + match[1].length)));
  for (const [index, match] of topicMatches.entries()) {
    if (!hasEnumeration) continue;
    const start = match.index + match[1].length;
    const pair = inlinePairs[index];
    if (pair.length === 1 && inlinePairs.filter(items => items.includes(pair[0])).length === 1) continue;
    markers.push({ marker: match[2].replace(/\s+/gu, ''), number: ordinalNumber(match[2]), start,
      lineOrdinal: text.slice(0, start).split('\n').length });
  }
  // Admit output topics through a unique source item/body witness, without
  // inferring a new list from the rewritten document's vocabulary.
  if (source != null) {
    const before = sourceMarkers;
    const topicRe = new RegExp(`(^[ \\t]*|\\n[ \\t]*|[.!?。！？][ \\t]+)(${ORDINAL})(?:은|는)\\s+`, 'gu');
    const candidates = [...text.matchAll(topicRe)].map(match => ({
      marker: match[2].replace(/\s+/gu, ''), number: ordinalNumber(match[2]),
      start: match.index + match[1].length
    })).filter(item => !literals.some(span => span.start <= item.start && span.end > item.start));
    const pairs = candidates.map(item => before.filter(original => original.number === item.number
      && ordinalBodyMatches(source, original.start, text, item.start)));
    candidates.forEach((item, index) => {
      if (markers.some(marker => marker.start === item.start)
          || pairs[index].length !== 1 || pairs.filter(pair => pair.includes(pairs[index][0])).length !== 1) return;
      markers.push({ ...item, lineOrdinal: text.slice(0, item.start).split('\n').length });
    });
  }
  const frames = new RegExp(`(^[ \\t]*|\\n[ \\t]*|[.!?。！？][ \\t]+)(${FRAME_LEAD})(${ORDINAL})${FRAME_TAIL}`, 'gu');
  for (const match of text.matchAll(frames)) {
    const boundaryStart = match.index + match[1].length;
    const start = boundaryStart + match[2].length;
    if (literals.some(span => span.start <= start && span.end > start)) continue;
    markers.push({ marker: match[3].replace(/\s+/gu, ''), number: ordinalNumber(match[3]), start,
      boundaryStart, lineOrdinal: text.slice(0, start).split('\n').length });
  }
  // An editable frame may move its ordinal into the predicate without
  // losing the enumeration: "첫 번째 의의는 X다" -> "X가 첫 번째 의의다".
  // Count only explicit affirmative copulas, never arbitrary ordinal nouns,
  // quoted discussion, negation or references to another item's contents.
  const predicates = new RegExp(`(?<![가-힣])(${ORDINAL})\\s+${FRAME_NOUN}(?:이다|다|입니다)(?=[.!?。！？\\s(]|$)`, 'gu');
  for (const match of text.matchAll(predicates)) {
    const start = match.index;
    if (literals.some(span => span.start <= start && span.end > start)) continue;
    markers.push({ marker: match[1].replace(/\s+/gu, ''), number: ordinalNumber(match[1]), start,
      predicateFrame: true, lineOrdinal: text.slice(0, start).split('\n').length });
  }
  // Rephrasing a source topic as a noun frame (셋째는 -> 셋째 결론은,
  // 첫 번째는 '코너'이다 -> 첫 번째 '코너'에서는) keeps the same item.
  // Require a unique source/body witness, not ordinal vocabulary alone.
  if (sourceMarkers?.length) {
    const loose = new RegExp(`(^[ \\t]*|\\n[ \\t]*|[.!?。！？][ \\t]+)(${ORDINAL})(?=\\s|은\\s|는\\s)`, 'gu');
    const candidates = [...text.matchAll(loose)].map(match => ({
      marker: match[2].replace(/\s+/gu, ''), number: ordinalNumber(match[2]), start: match.index + match[1].length
    })).filter(item => !literals.some(span => span.start <= item.start && span.end > item.start));
    const pairs = candidates.map(item => sourceMarkers.filter(before => before.number === item.number
      && (ordinalBodyMatches(source, before.start, text, item.start)
        || ordinalFrameBodyMatches(source, before.start, text, item.start)
        || ordinalExpandedFrameBodyMatches(source, before.start, text, item.start)
        || quotedOrdinalBodyMatches(source, before.start, text, item.start))));
    candidates.forEach((item, index) => {
      if (markers.some(marker => marker.start === item.start) || pairs[index].length !== 1
          || pairs.filter(pair => pair.includes(pairs[index][0])).length !== 1) return;
      markers.push({ ...item, lineOrdinal: text.slice(0, item.start).split('\n').length });
    });
  }
  return markers.sort((a, b) => a.start - b.start);
}

function quotedOrdinalBodyMatches(source, sourceStart, output, outputStart) {
  const before = String(source).slice(sourceStart).split(/[.!?。！？\n]/u)[0];
  const after = String(output).slice(outputStart).split(/[.!?。！？\n]/u)[0];
  const labels = [...before.matchAll(/(?:‘([^’\n]{4,60})’|“([^”\n]{4,60})”|'([^'\n]{4,60})'|"([^"\n]{4,60})")/gu)]
    .map(match => match[1] || match[2] || match[3] || match[4]);
  return labels.some(label => after.includes(label) && String(source).split(label).length === 2
    && String(output).split(label).length === 2);
}

function ordinalFrameBodyMatches(source, sourceStart, output, outputStart) {
  const words = (text, start) => new Set(String(text).slice(start).split(/[.!?。！？\n]/u)[0]
    .replace(new RegExp(`^${ORDINAL}(?:은|는)?\\s*`, 'u'), '').match(/[가-힣A-Za-z0-9]{2,}/gu) || []);
  const before = words(source, sourceStart), after = words(output, outputStart);
  const common = [...before].filter(word => after.has(word)).length;
  return common >= 4 && common * 2 / Math.max(1, before.size + after.size) >= 0.55;
}

// Splitting a long item into "두 번째 사례는 X이다. ..." does not lose its
// ordinal. A short predicate alone has too few words for the ordinary owner
// check. Inspect at most three sentences in that SAME paragraph, stopping
// before any other ordinal; the caller still requires unique mutual ownership.
function ordinalExpandedFrameBodyMatches(source, sourceStart, output, outputStart) {
  const tail=String(output).slice(outputStart);
  if (!new RegExp(`^${ORDINAL}\\s+[^.!?。！？\\n]{1,60}(?:이다|입니다)[.!?。！？]`, 'u').test(tail)) return false;
  const words=(value,start)=>{
    const body=String(value).slice(start).replace(new RegExp(`^${ORDINAL}(?:${ORDINAL_END}|(?:은|는)\\s+|\\s+)`, 'u'),'')
      .split(/\r?\n/u)[0].split(new RegExp(`(?<![가-힣])${ORDINAL}`, 'u'))[0];
    return new Set(require('../engine/koreanText').splitSentenceSpans(body).slice(0,3)
      .map(s=>s.text).join(' ').match(/[가-힣A-Za-z0-9]{2,}/gu)||[]);
  };
  const before=words(source,sourceStart),after=words(output,outputStart);
  const common=[...before].filter(w=>after.has(w)).length;
  return common>=4 && common/Math.max(before.size,after.size)>=.6;
}

// Only an unquoted, consecutive item in the same comma series can own a split
// topic. A mention elsewhere in the source is not evidence for a new item.
function inlineOrdinalItems(value, counted) {
  const text = String(value || ''), literals = syntaxSpans(text), items = [];
  const re = new RegExp(`([,，][ \\t]*)(${ORDINAL})[,，](?=\\s|[가-힣A-Za-z])`, 'gu');
  for (const match of text.matchAll(re)) {
    const start = match.index + match[1].length, number = ordinalNumber(match[2]);
    if (literals.some(span => span.start <= start && span.end > start)) continue;
    const previous = [...counted, ...items].reduce((best, item) => item.start < start
      && (!best || item.start > best.start) ? item : best, null);
    if (!previous || previous.number + 1 !== number
        || /[.!?。！？\n]/u.test(text.slice(previous.start, start))) continue;
    items.push({ start, number });
  }
  return items;
}

function inlineOrdinalBodyMatches(source, sourceStart, output, outputStart) {
  const nextItem = new RegExp(`[,，][ \\t]*${ORDINAL}(?:[,，]|(?:은|는)\\s+)`, 'u');
  const words = (text, start) => new Set(String(text).slice(start)
    .replace(new RegExp(`^${ORDINAL}(?:${ORDINAL_END}|(?:은|는)\\s+)`, 'u'), '')
    .split(nextItem)[0].split(/[.!?。！？\n]/u)[0].match(/[가-힣A-Za-z0-9]{2,}/gu) || []);
  const before = words(source, sourceStart), after = words(output, outputStart);
  const common = [...before].filter(word => after.has(word)).length;
  return common >= 3 && common / Math.max(before.size, after.size) >= 0.6;
}

function ordinalBodyMatches(source, sourceStart, output, outputStart) {
  const words = (text, start) => new Set(String(text).slice(start)
    .replace(new RegExp(`^${ORDINAL}(?:${ORDINAL_END}|(?:은|는)\\s+)`, 'u'), '')
    .split(/[.!?。！？\n]/u)[0].match(/[가-힣A-Za-z0-9]{2,}/gu) || []);
  const before = words(source, sourceStart), after = words(output, outputStart);
  const common = [...before].filter(word => after.has(word)).length;
  return common >= 3 && common / Math.max(before.size, after.size) >= 0.6;
}

// Only restore a visual boundary for a source-backed list. Never invent a
// missing ordinal, infer a list from family nouns, or move an item's words.
function restoreOrdinalParagraphGaps(source, value) {
  let text = String(value || '');
  const sourceText = String(source || '');
  const before = ordinalMarkers(sourceText), after = ordinalMarkers(text, { source: sourceText });
  if (before.length < 2 || before.length !== after.length
      || before.some((item, i) => item.number !== after[i].number)) return { text, repairCount: 0 };
  let repairCount = 0;
  for (let i = after.length - 1; i >= 0; i--) {
    // A predicate is part of its sentence, not an item-start boundary.
    if (after[i].predicateFrame || before[i].predicateFrame) continue;
    const sourceStart = before[i].boundaryStart ?? before[i].start;
    const sourceLine = sourceText.slice(sourceText.lastIndexOf('\n', sourceStart - 1) + 1, sourceStart);
    if (sourceLine.trim()) {
      // A developed, consecutive inline item also starts a paragraph. Period
      // vs comma is presentation, not a new ordinal. Do not split compact
      // summaries, family nouns or quoted examples.
      const prev = before[i - 1];
      if (!prev || before[i].number !== prev.number + 1) continue;
      const body = sourceText.slice(prev.start, sourceStart);
      const nextBody = sourceText.slice(sourceStart, before[i + 1]?.start ?? sourceText.length);
      if (body.length < 100 || nextBody.length < 80
          || require('../engine/koreanText').splitSentenceSpans(body).length < 2
          || require('./layoutStructure').buildLineRecords(body).some(r => ['heading','title','code','table'].includes(r.role))) continue;
    }
    const right = after[i].boundaryStart ?? after[i].start;
    let left = right;
    while (left > 0 && /\s/u.test(text[left - 1])) left--;
    if (!left || left === right || /\n[ \t]*\n/u.test(text.slice(left, right))) continue;
    text = text.slice(0, left) + '\n\n' + text.slice(right);
    repairCount++;
  }
  return { text, repairCount };
}


// Restore only a missing punctuation prefix, at a unique unchanged body
// anchor, with a unique monotone alignment of every surviving ordinal.
function restoreMissingOrdinalMarkers(source, value) {
  const original = String(source || ''), output = String(value || '');
  const before = ordinalMarkers(original), after = ordinalMarkers(output, { source: original });
  const exact = restoreAnchoredOrdinalMarkers(original, output, before, after);
  // Every prefix can be lost even while the explicit enumeration header
  // survives. Its exact, unique item count plus heading ownership and mutual
  // body alignment below distinguish a damaged list from free restructuring.
  if (!after.length && before.length >= 2 && before.length <= 6
      && before.every((m, i) => m.number === i + 1)) {
    const header = original.slice(0, before[0].start).match(/([^.!?\n]{0,100}(?:시사점|이유|원칙|특징|장점|단점|방법|과제)(?:은|는)\s*(두|세|네|다섯|여섯)\s*가지(?:입니다|이다)\.)\s*$/u);
    const count = { 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6 }[header?.[2]];
    if (header && count === before.length && original.indexOf(header[1]) === original.lastIndexOf(header[1])
        && output.includes(header[1]) && output.indexOf(header[1]) === output.lastIndexOf(header[1])) {
      const owned = restoreHeadingOwnedOrdinals(original, output, before, after)
        || restoreLostOrdinalSeries(original, output, before, after);
      if (owned) {
        const start = owned.text.indexOf(header[1]) + header[1].length;
        const end = owned.text.indexOf('\n\n', start);
        if (ordinalMarkers(owned.text).every(m => m.start >= start && (end < 0 || m.start < end))) return owned;
      }
    }
  }
  // A document whose every ordinal was removed is treated as restructured,
  // not as a damaged list; only a series lost beside surviving ones returns.
  if (exact.repairCount || !after.length || before.length <= after.length || before.length > 64) return exact;
  const owned = restoreHeadingOwnedOrdinals(original, output, before, after);
  if (owned) return owned;
  return restoreLostOrdinalSeries(original, output, before, after) || exact;
}

function restoreHeadingOwnedOrdinals(original, output, before, after) {
  const { splitSentenceSpans } = require('../engine/koreanText');
  const { sentenceSimilarity } = require('./sentenceAlignment');
  const left = splitSentenceSpans(original), right = splitSentenceSpans(output);
  if (left.length > 400 || right.length > 400) return null;
  const owners = require('./relationAlignment').sentenceOwners(original, output, left, right);
  if (!owners) return null;
  const ownerOf = (marker, spans, labels) => labels[spans.findIndex(s => s.start <= marker.start && s.end > marker.start)];
  const surviving = new Map();
  for (const owner of new Set(owners.source.filter(v => v != null))) {
    const a = before.filter(m => ownerOf(m,left,owners.source) === owner);
    const b = after.filter(m => ownerOf(m,right,owners.candidate) === owner);
    // An unambiguous ordinal subsequence identifies the surviving PREFIXES.
    // Their bodies may be freely paraphrased. Only the missing item below
    // requires mutual body evidence before any insertion can be made.
    const memo = new Map();
    const paths = (i,j) => {
      if (j === b.length) return [[]];
      if (i === a.length) return [];
      const key = `${i}:${j}`;
      if (memo.has(key)) return memo.get(key);
      const found = a[i].number === b[j].number
        ? paths(i+1,j+1).map(p => [[a[i],b[j]],...p]) : [];
      if (found.length < 2) found.push(...paths(i+1,j));
      memo.set(key,found.slice(0,2));return memo.get(key);
    };
    const matches = paths(0,0);
    if (matches.length === 1) for (const [a,b] of matches[0]) surviving.set(a,b);
  }
  const introPattern = new RegExp(`^${LIST_INTRO}\\s+`, 'u');
  const bodyOf = text => text.replace(introPattern, '').replace(PREFIX, '$2');
  const bodies = left.map(s => bodyOf(s.text));
  const itemSentences = new Set();
  for (const marker of before) {
    const i = left.findIndex(s => s.start <= marker.start && s.end > marker.start);
    const prefix = ordinalPrefix(original.slice(marker.start));
    if (i < 0 || !prefix || itemSentences.has(i)) return null;
    itemSentences.add(i);
    // A markdown heading fragment can share a sentence span with the first
    // body sentence. The explicit item prefix, not that fragment, owns its body.
    bodies[i] = original.slice(marker.start + prefix[1].length, left[i].end);
  }
  const best = scores => { const sorted = scores.filter(s => s.score >= .60).sort((a,b) => b.score-a.score);
    return sorted[0] && sorted[0].score-(sorted[1]?.score || 0) >= .10 ? sorted[0] : null; };
  const edits = [], positions = [], covered = new Set(), literals = syntaxSpans(output);
  for (const marker of before) {
    const i = left.findIndex(s => s.start <= marker.start && s.end > marker.start);
    const prefix = ordinalPrefix(original.slice(marker.start));
    if (i < 0 || !prefix || owners.source[i] == null || marker.predicateFrame || marker.boundaryStart != null) return null;
    if (surviving.has(marker)) {
      const current = surviving.get(marker);
      covered.add(current);positions.push(current.start);continue;
    }
    const forward = best(right.flatMap((s,j) => owners.candidate[j] === owners.source[i]
      ? [{index:j,score:sentenceSimilarity(bodies[i],bodyOf(s.text))}] : []));
    if (!forward) return null;
    const j=forward.index, span=right[j];
    const backward=best(left.flatMap((s,k) => owners.source[k] === owners.candidate[j]
      ? [{index:k,score:sentenceSimilarity(bodies[k],bodyOf(span.text))}] : []));
    if (!backward || backward.index !== i) return null;
    const existing=after.filter(m=>m.start>=span.start && m.start<span.end);
    if (existing.length) {
      if (existing.length !== 1 || existing[0].number !== marker.number || covered.has(existing[0])) return null;
      covered.add(existing[0]);positions.push(existing[0].start);continue;
    }
    // A discourse lead or an unfamiliar introduction can hide an existing
    // prefix from the structural parser. Never prepend another ordinal to it.
    if (new RegExp(`(?<![가-힣])${ORDINAL}(?:${ORDINAL_END}|(?:은|는)\\s+)`, 'u').test(span.text)) return null;
    let position=span.start;
    const intro=output.slice(position).match(introPattern)?.[0] || '';
    position+=intro.length;
    if (literals.some(s=>s.start<=position && s.end>position)) return null;
    const connector=output.slice(position).match(marker.number === 1
      ? /^(?:먼저|또한|또|그리고)[,，]?[ \t]+/u : /^(?:또한|또|그리고)[,，]?[ \t]+/u)?.[0] || '';
    positions.push(position);edits.push({position,remove:connector.length,prefix:prefix[1]});
  }
  if (!edits.length || covered.size!==after.length || positions.some((p,i)=>i>0 && p<=positions[i-1])) return null;
  let text=output;
  for(const e of edits.sort((a,b)=>b.position-a.position)) text=text.slice(0,e.position)+e.prefix+text.slice(e.position+e.remove);
  const repaired=ordinalMarkers(text,{source:original});
  if(repaired.length!==before.length || repaired.some((m,i)=>m.number!==before[i].number)) return null;
  return {text,repairCount:edits.length};
}

function restoreAnchoredOrdinalMarkers(original, output, before, after) {
  const unchanged = { text: output, repairCount: 0 };
  if (before.length < 2 || !after.length || before.length <= after.length || before.length > 64) return unchanged;
  const ways = Array.from({ length: before.length + 1 }, () => Array(after.length + 1).fill(0));
  ways[before.length][after.length] = 1;
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length; j >= 0; j--) {
      ways[i][j] = Math.min(2, ways[i + 1][j]
        + (j < after.length && before[i].number === after[j].number ? ways[i + 1][j + 1] : 0));
    }
  }
  if (ways[0][0] !== 1) return unchanged;
  const positions = [], edits = [], literals = syntaxSpans(output);
  let cursor = 0;
  for (let i = 0; i < before.length; i++) {
    if (cursor < after.length && before[i].number === after[cursor].number && ways[i + 1][cursor + 1]) {
      positions.push(after[cursor++].start);
      continue;
    }
    const prefix = ordinalPrefix(original.slice(before[i].start));
    if (!prefix) return unchanged;
    const bodyStart = before[i].start + prefix[1].length;
    const body = original.slice(bodyStart).split(/[.!?。！？\n]/u)[0];
    const anchor = body.match(/^\S+(?:[ \t]+\S+){3}/u)?.[0];
    if (!anchor || anchor.replace(/\s/gu, '').length < 12
        || original.indexOf(anchor) !== bodyStart || original.indexOf(anchor, bodyStart + 1) !== -1) return unchanged;
    const position = output.indexOf(anchor);
    if (position < 0 || output.indexOf(anchor, position + 1) !== -1
        || !/(?:^|\n|[.!?。！？][ \t]+)$/u.test(output.slice(0, position))
        || literals.some(span => span.start <= position && span.end > position)) return unchanged;
    positions.push(position);
    edits.push({ position, prefix: prefix[1] });
  }
  if (positions.some((position, i) => i > 0 && position <= positions[i - 1])) return unchanged;
  let text = output;
  for (const edit of edits.reverse()) text = text.slice(0, edit.position) + edit.prefix + text.slice(edit.position);
  const repaired = ordinalMarkers(text, { source: original });
  if (repaired.length !== before.length || repaired.some((item, i) => item.number !== before[i].number)) return unchanged;
  return { text, repairCount: edits.length };
}

// One whole punctuated 1..n series (2-6 items) lost every ordinal and its
// item bodies were paraphrased, so no exact anchor survives. Every surviving
// output ordinal must belong to the other source series in order, and at
// least one must survive. Each lost
// item sentence must map to exactly one unmarked output sentence by mutual
// best similarity with a clear margin, monotone with the survivors. Only the
// source prefix is inserted; a lead additive connector standing in for it
// (또, 또한, 그리고) is dropped. A removed enumeration header is not restored.
function restoreLostOrdinalSeries(original, output, before, after) {
  const series = [];
  for (const [index, item] of before.entries()) {
    if (item.number === 1 || !series.length || item.number !== before[index - 1].number + 1) series.push([]);
    series.at(-1).push(index);
  }
  const results = series.filter(indices => indices.length >= 2 && indices.length <= 6)
    .map(indices => restoreOrdinalSeriesPrefixes(original, output, before, after, indices)).filter(Boolean);
  return results.length === 1 ? results[0] : null;
}

function restoreOrdinalSeriesPrefixes(original, output, before, after, lostIndices) {
  const { splitSentenceSpans } = require('../engine/koreanText');
  const { sentenceSimilarity } = require('./sentenceAlignment');
  const lost = new Set(lostIndices);
  const kept = before.filter((item, index) => !lost.has(index));
  if (kept.length !== after.length || kept.some((item, i) => item.number !== after[i].number)) return null;
  if (lostIndices.some(index => before[index].predicateFrame || before[index].boundaryStart != null)) return null;
  const sourceSentences = splitSentenceSpans(original), outputSentences = splitSentenceSpans(output);
  // This fallback is optional; cap both axes before mutual-owner comparisons.
  // Long sentence inventories keep the existing anchored restoration path.
  if (!sourceSentences.length || sourceSentences.length > 400 || outputSentences.length > 400) return null;
  const sourceBodies = sourceSentences.map(span => String(span.text).replace(PREFIX, '$2'));
  const literals = syntaxSpans(output);
  const lines = require('./layoutStructure').buildLineRecords(output);
  const best = scores => {
    const order = scores.map((score, index) => ({ score, index })).sort((a, b) => b.score - a.score);
    return order[0] && order[0].score - (order[1]?.score || 0) >= 0.08 ? order[0] : null;
  };
  const positions = new Map(kept.map((item, i) => [before.indexOf(item), after[i].start]));
  const edits = [];
  for (const index of lostIndices) {
    const marker = before[index];
    const prefix = ordinalPrefix(original.slice(marker.start));
    const sentence = sourceSentences.findIndex(span => span.start <= marker.start && span.end > marker.start);
    if (!prefix || sentence < 0 || original.slice(sourceSentences[sentence].start, marker.start).trim()) return null;
    const forward = best(outputSentences.map(span => sentenceSimilarity(sourceBodies[sentence], span.text)));
    if (!forward || forward.score < 0.55) return null;
    const backward = best(sourceBodies.map(body => sentenceSimilarity(body, outputSentences[forward.index].text)));
    if (!backward || backward.index !== sentence) return null;
    const span = outputSentences[forward.index];
    const position = span.start + output.slice(span.start).match(/^[ \t]*/u)[0].length;
    const row = lines.find(record => record.start <= position && record.end >= position);
    if (!row || row.role !== 'prose' || literals.some(s => s.start <= position && s.end > position)
        || after.some(item => item.start >= span.start && item.start < span.end)) return null;
    const connector = output.slice(position).match(marker.number === 1
      ? /^(?:먼저|또한|또|그리고)[,，]?[ \t]+(?=[가-힣A-Za-z0-9“‘"'(])/u
      : /^(?:또한|또|그리고)[,，]?[ \t]+(?=[가-힣A-Za-z0-9“‘"'(])/u)?.[0] || '';
    positions.set(index, position);
    edits.push({ position, remove: connector.length, prefix: prefix[1] });
  }
  const ordered = before.map((item, index) => positions.get(index));
  if (ordered.some((position, i) => i > 0 && position <= ordered[i - 1])) return null;
  let text = output;
  for (const edit of [...edits].sort((a, b) => b.position - a.position))
    text = text.slice(0, edit.position) + edit.prefix + text.slice(edit.position + edit.remove);
  const repaired = ordinalMarkers(text, { source: original });
  if (repaired.length !== before.length || repaired.some((item, i) => item.number !== before[i].number)) return null;
  return { text, repairCount: edits.length };
}

module.exports = { ordinalPrefix, ordinalMarkers, restoreOrdinalParagraphGaps, restoreMissingOrdinalMarkers };
