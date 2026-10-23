'use strict';
const bare = s => String(s || '').replace(/\s/gu, '');
const blocks = s => String(s || '').split(/\n\s*\n/u).map(x => x.trim()).filter(Boolean);

// Independent textual evidence for a completed omission verdict. A model fail
// alone is insufficient: a newly orphaned literal fragment or a clipped subject
// and list prefix must also be witnessed in exactly one source paragraph.
function residualSourceLoss(source, candidate) {
  const before = blocks(source).map(bare), after = blocks(candidate);
  const findings = [];
  for (const paragraph of after) {
    const first = paragraph.match(/^[\s\S]*?[.!?。！？](?=\s|$)/u)?.[0] || paragraph;
    const kept = bare(first);
    if (kept.length < 7 || kept.length > 240 || before.includes(kept)
      || String(source).split('\n').some(line => bare(line) === kept)) continue;
    const witnesses = before.filter(s => s.includes(kept) && s.indexOf(kept) === s.lastIndexOf(kept));
    if (witnesses.length !== 1) continue;
    const original = witnesses[0], at = original.indexOf(kept), prefix = original.slice(0, at);
    const orphan = first === paragraph && !/[.!?。！？][”’"']?$/u.test(kept)
      && original.length >= 40 && kept.length / original.length < 0.35
      && !/[\n\t|]/u.test(paragraph) && at > 15;
    const clippedSubject = at >= 12 && at <= 120 && /[은는이가]/u.test(prefix)
      && /[,，]/u.test(prefix) && /[.·,，]$/u.test(prefix)
      && !after.some(p => bare(p).includes(prefix));
    if (orphan || clippedSubject) findings.push({ kind: orphan ? 'orphaned_source_fragment' : 'clipped_subject_prefix', sourceChars: original.length, retainedChars: kept.length,
      sourceWitness: original, candidateWitness: kept });
  }
  return findings;
}

// A closing request to whoever edits the text ("…도 적어줘") is not body prose.
const EDIT_REQUEST = /(?:적어|써|넣어|추가해|덧붙여|고쳐|바꿔|수정해|다듬어|늘려|줄여|요약해|작성해|포함해|반영해|정리해|보완해)\s?(?:줘|줘요|주세요|주십시오|줄래|주라|주길\s?바람|주시기\s?바랍니다)[\s.!?~。！？]*$/u;

// A heading and an author/year citation can survive while the definition
// between them vanishes. They are sentence-splitter furniture, not evidence
// that the body sentence survived. Require the quoted WHOLE first sentence,
// the same unique citation, identical heading prefix and following sentence,
// and independent lexical absence. This never infers a synonym's meaning.
function droppedCitedLead(text, output, before, after, spans) {
  if (!Array.isArray(spans) || before.length < 3 || !after.length) return [];
  const { contentTokens, sentenceSimilarity } = require('./sentenceAlignment');
  const rows = [];
  for (const span of spans.slice(0, 32)) {
    const claim = text.slice(span.start, span.end);
    if (span.start < before[0].start || span.end > before[0].end
        || claim.length < 30 || claim.length > 400 || /\n/u.test(claim)
        || !/[.!?。！？]$/u.test(claim) || bare(output).includes(bare(claim))) continue;
    const prefix = text.slice(0, span.start);
    const prefixRows = require('./layoutStructure').buildLineRecords(prefix).filter(r => !r.blank);
    if (prefixRows.some(r => !['title', 'heading', 'label'].includes(r.role))) continue;
    const citationSentence = span.end === before[0].end
      && /^\([^()\n]{1,80}(?:19|20)\d{2}[^()\n]{0,30}\)[.!?。！？]?$/u.test(before[1].text) ? 1 : 0;
    const tail = text.slice(span.end, before[citationSentence].end);
    const citation = tail.match(/^(\s*)(\([^()\n]{1,80}(?:19|20)\d{2}[^()\n]{0,30}\)[.!?。！？]?)\s*$/u);
    if (!citation) continue;
    const at = output.indexOf(citation[2]);
    if (at < 0 || at !== output.lastIndexOf(citation[2]) || bare(output.slice(0, at)) !== bare(prefix)) continue;
    const next = before[citationSentence + 1].text, following = output.slice(at + citation[2].length);
    if (!following.trimStart().startsWith(next) || next.length < 24
        || text.indexOf(next) !== text.lastIndexOf(next) || output.indexOf(next) !== output.lastIndexOf(next)) continue;
    const outside = text.slice(0, span.start) + text.slice(span.end);
    const words = contentTokens(claim).filter(w => w.length >= 2 && !bare(outside).includes(w));
    const absent = words.filter(w => !bare(output).includes(w));
    if (absent.length < 3 || absent.length / words.length < .75
        || after.some(s => sentenceSimilarity(claim, s.text) >= .55)) continue;
    rows.push({ kind: 'dropped_cited_lead', sourceStart: span.start, sourceEnd: span.end,
      sourceChars: bare(claim).length, sourceWitness: claim, insertionAt: at, insertionGap: citation[1],
      previousEnd: -1, nextStart: at, leadingGap: '', trailingGap: citation[1] });
  }
  return rows.slice(0, 1);
}

// F02: a whole source sentence that left no fragment behind. Lexical absence
// alone cannot tell a deletion from a synonym rewrite, so every condition is
// required: no counterpart sentence anywhere (not moved), its own key words
// are gone from the result (not restated; a claim the source repeats has no
// own key words), and its source neighbours survive as mutual best matches
// that now sit next to each other (a rewritten sentence would still stand
// between them) without having grown or taken on a clause of their own source
  // lacks (not merged into a neighbour). The
// sentence a following reference pointed at is then physically absent; no
// pronoun is interpreted. `spans` limits the search to judge-quoted ranges.
//
// Two things hid a real deletion from those conditions and are handled without
// relaxing them. A neighbour rewritten only in its endings (확인하였으며 →
// 확인했으며) scores as a weak match; it may anchor on two-syllable stems
// instead, and the dropped sentence must then be absent at stem level too,
// with more words of its own. And one unanswered edit request closing the
// source is not the last body sentence: the sentence before it is. The request
// is only stepped over for adjacency; neither text is altered and the request
// itself is never witnessed, so it cannot be copied into the result.
function droppedSourceSentences(source, candidate, { spans = null } = {}) {
  const { splitSentenceSpans } = require('../engine/koreanText');
  const { sentenceSimilarity, contentTokens } = require('./sentenceAlignment');
  const text = String(source || ''), output = String(candidate || '');
  const before = splitSentenceSpans(text), after = splitSentenceSpans(output);
  if (before.length < 3 || before.length > 400 || !after.length || after.length > 400) return [];
  const outputBare = bare(output), stems = before.map(s => contentTokens(s.text));
  const short = tokens => [...new Set(tokens.map(t => t.slice(0, 2)))];
  const roots = new Map(), scores = new Map();
  const root = value => roots.get(value) || roots.set(value, short(contentTokens(value))).get(value);
  const exact = (a, b) => {
    const key = a + '\u0000' + b;
    if (!scores.has(key)) scores.set(key, sentenceSimilarity(a, b));
    return scores.get(key);
  };
  // Same weighting as the coverage term of sentenceSimilarity, on stems.
  const inflected = (a, b) => {
    const own = root(a), other = new Set(root(b)), x = bare(a).length, y = bare(b).length;
    const stemmed = own.length < 4 ? 0 : own.filter(t => other.has(t)).length / own.length * 0.82
      + Math.min(x, y) / Math.max(1, x, y) * 0.08;
    return Math.max(exact(a, b), stemmed);
  };
  const best = (needle, rows, score) => {
    let top = -1, first = 0, second = 0;
    rows.forEach((row, index) => {
      const value = score(needle, row.text);
      if (value > first) { second = first; first = value; top = index; } else if (value > second) second = value;
    });
    return first >= 0.55 && first - second >= 0.08 ? top : -1;
  };
  // A neighbour can stay within the length bound and still host the missing
  // claim in other words ("…확인하였고 복원력도 쟀다"). Three consecutive words
  // its own source sentence lacks, on the side facing the gap, are such a clause.
  // Two words can also carry an entire proposition ("복원력도 쟀다"); such
  // a neighbour is not independent evidence that the claim was deleted.
  const hosts = (kept, original, facingEnd) => {
    const known = new Set(root(original)), words = contentTokens(kept).map(t => t.slice(0, 2)), half = words.length / 2;
    if (facingEnd) {
      const clauses = kept.split(/(?:고|며|지만)\s*[,，]?\s+/u);
      const tail = clauses.length > 1 ? root(clauses.at(-1)) : [];
      if (tail.length >= 2 && tail.length <= 4 && tail.every(word => !known.has(word))) return true;
    }
    for (let i = 0, run = 0; i < words.length; i++) {
      run = known.has(words[i]) ? 0 : run + 1;
      if (run >= 3 && (facingEnd ? i >= half : i - run + 1 < half)) return true;
    }
    return false;
  };
  const mergedContrast = (kept, original, missing, facingEnd) => {
    const boundary = /지만\s*[,，]?\s*|반면(?:에)?\s*[,，]?\s*/u;
    if (boundary.test(original)) return false;
    const clauses = kept.split(boundary);
    if (clauses.length !== 2) return false;
    const facing = facingEnd ? clauses[1] : clauses[0];
    const missingRoots = new Set(root(missing));
    return bare(facing).length >= 8 && root(facing).filter(word => missingRoots.has(word)).length >= 2;
  };
  const anchor = (index, facingEnd, missing) => {
    const row = before[index];
    for (const score of row ? [exact, inflected] : []) {
      const at = best(row.text, after, score);
      if (at >= 0 && best(after[at].text, before, score) === index
        && bare(after[at].text).length <= bare(row.text).length * 1.3 + 8
        && !hosts(after[at].text, row.text, facingEnd)
        && !mergedContrast(after[at].text, row.text, missing, facingEnd)) return { at, stemmed: score === inflected };
    }
    return { at: -1, stemmed: false };
  };
  const gap = (left, right) => {
    const between = left && right ? text.slice(left.end, right.start) : '';
    return /^\s+$/u.test(between) ? between : '';
  };
  const last = before.length - 1, asks = row => EDIT_REQUEST.test(row.text.trim());
  const request = asks(before[last]) && !before.slice(0, last).some(asks) ? last : -1;
  const tail = request >= 0 && !after.some(s => inflected(before[last].text, s.text) >= 0.55) ? last - 1 : last;
  // Two body sentences leave one anchor with nothing to be a better match than.
  if (tail < 2) return [];
  const outputRoots = new Set(after.flatMap(s => root(s.text)));
  const findings = droppedCitedLead(text, output, before, after, spans);
  for (let i = 0; i <= tail && findings.length < 4; i++) {
    const row = before[i], kept = bare(row.text), own = stems[i];
    if (i === request) continue;
    if (Array.isArray(spans) && !spans.some(s => s.start < row.end && s.end > row.start)) continue;
    if (kept.length < 12 || kept.length > 400 || !/[.!?。！？][”’"')\]]*$/u.test(kept) || outputBare.includes(kept)) continue;
    const distinctive = own.filter(t => !stems.some((other, j) => j !== i && other.includes(t)));
    const absent = distinctive.filter(t => !outputBare.includes(t));
    if (absent.length < 2 || absent.length / distinctive.length < 0.67) continue;
    if (after.some(s => exact(row.text, s.text) >= 0.55)) continue;
    const previous = anchor(i - 1, true, row.text), next = anchor(i + 1, false, row.text);
    const bracketed = i === 0 ? next.at === 0 : i === tail ? previous.at === after.length - 1
      : previous.at >= 0 && next.at === previous.at + 1;
    if (!bracketed) continue;
    if (i === 0 ? next.stemmed : i === tail ? previous.stemmed : previous.stemmed || next.stemmed) {
      const ownRoots = root(row.text).filter(t => !before.some((other, j) => j !== i && root(other.text).includes(t)));
      const gone = ownRoots.filter(t => !outputRoots.has(t));
      if (gone.length < 3 || gone.length / ownRoots.length < 0.75
        || after.some(s => inflected(row.text, s.text) >= 0.55)) continue;
    }
    findings.push({ kind: 'dropped_source_sentence', sourceStart: row.start, sourceEnd: row.end,
      sourceChars: kept.length, sourceWitness: row.text,
      leadingGap: gap(before[i - 1], row), trailingGap: gap(row, before[i + 1]),
      previousEnd: previous.at >= 0 ? after[previous.at].end : -1, nextStart: next.at >= 0 ? after[next.at].start : -1 });
  }
  return findings;
}

// Mixed scripts already present elsewhere in a document are not a whitelist
// for newly corrupting a Korean word. Only mark a one-character substitution
// with a unique, longer Korean witness; never guess a replacement.
function mixedScriptWordChanges(source, candidate) {
  const words = [...new Set(String(source || '').match(/[가-힣]{3,}/gu) || [])];
  return [...String(candidate || '').matchAll(/[가-힣\u3040-\u30ff]{3,}/gu)]
    .filter(m => /[가-힣]/u.test(m[0]) && /[\u3040-\u30ff]/u.test(m[0]) && !String(source).includes(m[0]))
    .filter(m => {
      const suffix = String(candidate).slice(m.index + m[0].length).match(/^\s+[가-힣]{2,}/u)?.[0];
      return suffix && words.filter(s => s.length === m[0].length
        && [...s].filter((c,i) => c !== m[0][i]).length === 1 && String(source).includes(s + suffix)).length === 1;
    }).map(m => ({ code: 'mixed_script_word_changed', chars: m[0].length }));
}
module.exports = { residualSourceLoss, mixedScriptWordChanges, droppedSourceSentences };
