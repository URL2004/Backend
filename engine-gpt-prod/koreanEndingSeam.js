'use strict';

// A list-looking syllable can be the last part of an unfinished predicate.
// Require a developed prose clause; short verse and unknown stems stay intact.
function isEndingSeam(left, right) {
  const a = String(left || '').trim(), b = String(right || '').trim();
  if (a.length < 24 || a.split(/\s+/u).length < 4) return false;
  const stem = a.match(/([가-힣]+)$/u)?.[1] || '';
  if (/^다\.(?=\s|$)/u.test(b)) {
    if (/(?:[가-힣]이|했|됐|였|었|났|랐|렸|겠|있|없|않|습니|[합입됩]니)$/u.test(stem)) return true;
    // Present-tense `-ㄴ다` cut before its last syllable (`해야 한/다.`,
    // `초점을 둔/다.`, `검토한/다.`). Only predicate shapes are accepted: a
    // bare noun tail (권한, 기한, 시간) before a real `다.` item is not one, and
    // a row that is itself a 가나다 item never donates its tail to the marker.
    if (/^[가-하][.)](?=\s|$)/u.test(a)) return false;
    if (stem === '한') return /야\s+한$/u.test(a);
    if (stem === '둔') return /[을를에]\s+둔$/u.test(a);
    if (stem === '된') return /게\s+된$/u.test(a);
    // Whole lexical stems avoid treating 기간/시간/공간 as a predicate.
    if (/^(?:이어간|나아간|아니)$/u.test(stem)) return true;
    return /[가-힣]된$/u.test(stem)
      || /[가-힣]한$/u.test(stem) && !/(?:[제권기시상하무유극북남대원]한|최대한|최소한)$/u.test(stem);
  }
  return /^며\.(?=\s|$)/u.test(b) && /(?:있|없|않|했|었|였)으$/u.test(stem);
}

// A copied list need not begin at 가. Consecutive same-level siblings anywhere
// nearby outrank the seam heuristic, including an intervening wrapped body.
function siblingIndices(records) {
  const result = new Set(), order = '가나다라마바사아자차카타파하';
  let previous = null;
  for (const record of records) {
    const match = String(record.raw || '').match(/^([ \t]*)([가나다라마바사아자차카타파하])([.)])(?=\s|$)/u);
    if (!match) continue;
    const current = { index: record.index, indent: match[1], ordinal: order.indexOf(match[2]), marker: match[3] };
    if (previous && current.index - previous.index <= 12 && current.indent === previous.indent
        && current.marker === previous.marker && current.ordinal === previous.ordinal + 1) {
      result.add(previous.index); result.add(current.index);
    }
    previous = current;
  }
  return result;
}

module.exports = { isEndingSeam, siblingIndices };
