'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AsyncResource } = require('node:async_hooks');
const { withTextAnalysisCache, memoizeDistance, textAnalysisCacheStats } = require('../engine/textAnalysisCache');
const { levenshteinDistance, computeEditMetrics } = require('../engine/koreanText');

const stats = () => textAnalysisCacheStats().distance;
// Created at module load, outside every request store.
const OUTSIDE = new AsyncResource('outside');
const withoutCache = fn => OUTSIDE.runInAsyncScope(fn);

// Independent textbook reference, valid for strings without surrogates.
function referenceDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
}

// Synthetic inputs only.
const SAMPLES = [
  '', 'a', 'abc', 'kitten', 'sitting', 'The quick brown fox', 'the quick brown fax.',
  '측정값을 기록했다.', '측정값을 다시 기록하였다.', '결과는 예상과 달랐다',
  '가', '가'.normalize('NFD'), '한글 문장'.normalize('NFD'), '한글 문장',
  '😀', '😀a', 'a😀', '👨‍👩‍👧 가족', '가족 👨‍👩‍👧', '\ud83d', '\ude00x',
  'a\0b', 'a\0', '\0b', '\0', '1:a', ':a1', '3:abc', '5',
  null, undefined, 0, false, NaN, 5, 12.5, true, ['a', 'b'], { toString() { return '객체 문장'; } }
];

test('cached distance equals uncached distance for every ordered pair', () => {
  const expected = SAMPLES.map(a => SAMPLES.map(b => levenshteinDistance(a, b)));
  assert.equal(textAnalysisCacheStats(), null);
  for (const [i, a] of SAMPLES.entries()) for (const [j, b] of SAMPLES.entries()) {
    if (typeof a !== 'string' || typeof b !== 'string' || /[\ud800-\udfff]/.test(a + b)) continue;
    assert.equal(expected[i][j], referenceDistance(a, b));
  }
  withTextAnalysisCache(() => {
    for (let pass = 0; pass < 3; pass += 1) {
      for (const [i, a] of SAMPLES.entries()) for (const [j, b] of SAMPLES.entries()) {
        const actual = levenshteinDistance(a, b);
        assert.equal(typeof actual, 'number');
        assert.equal(actual, expected[i][j]);
      }
    }
    const s = stats();
    assert.ok(s.misses > 0);
    assert.ok(s.hits >= 2 * s.misses);
    assert.equal(s.calls, s.hits + s.misses + s.bypassedOversize);
    assert.equal(s.entries, s.misses);
    assert.equal(s.evictions, 0);
  });
  assert.deepEqual(SAMPLES.map(a => SAMPLES.map(b => levenshteinDistance(a, b))), expected);
});

test('coercion runs once per call and equal coerced values share one exact entry', () => {
  let conversions = 0;
  const value = { toString() { conversions += 1; return '변환된 문장'; } };
  const expected = levenshteinDistance(value, '변환한 문장');
  assert.equal(conversions, 1);
  withTextAnalysisCache(() => {
    assert.equal(levenshteinDistance(value, '변환한 문장'), expected);
    assert.equal(levenshteinDistance(value, '변환한 문장'), expected);
    assert.equal(conversions, 3);
    assert.equal(levenshteinDistance('변환된 문장', '변환한 문장'), expected);
    assert.equal(levenshteinDistance(5, '15'), levenshteinDistance('5', '15'));
    assert.deepEqual([stats().misses, stats().hits], [2, 3]);
    // Empty and identical inputs return before the store is consulted.
    for (const empty of [null, undefined, 0, false, NaN, '']) {
      assert.equal(levenshteinDistance(empty, 'abc'), 3);
      assert.equal(levenshteinDistance('가나', empty), 2);
    }
    assert.equal(levenshteinDistance('같다', '같다'), 0);
    assert.equal(stats().calls, 5);
  });
});

const COLLISION_PAIRS = [
    ['ab', 'c'], ['a', 'bc'], ['c', 'ab'], ['bc', 'a'],
    ['a\0', 'b'], ['a', '\0b'], ['a\0b', '\0'], ['a', '\0b\0'],
    ['1', ':ab'], ['1:a', 'b'], ['11', ':a'], ['1', '1:a'], ['2:ab', 'c'], ['2', ':abc'],
    ['가', '나다'], ['가나', '다'], ['가'.normalize('NFD'), '나다'], ['😀', 'a'], ['\ud83d', '\ude00a']
];

test('keys are directional and cannot collide through delimiters or lengths', () => withTextAnalysisCache(() => {
  const seen = [];
  const compute = (a, b) => { seen.push([a, b]); return seen.length; };
  const pairs = COLLISION_PAIRS;
  const first = pairs.map(([a, b]) => memoizeDistance(a, b, compute));
  assert.deepEqual(first, pairs.map((_, i) => i + 1));
  assert.deepEqual(seen, pairs);
  assert.deepEqual(pairs.map(([a, b]) => memoizeDistance(a, b, compute)), first);
  assert.equal(seen.length, pairs.length);
  assert.deepEqual([stats().misses, stats().hits, stats().entries], [pairs.length, pairs.length, pairs.length]);
}));

// A separate store: the test above filled its own store with synthetic values.
test('real distances for colliding-looking and swapped pairs match the uncached values', () => withTextAnalysisCache(() => {
  for (const [a, b] of [...COLLISION_PAIRS, ...COLLISION_PAIRS]) {
    assert.equal(withoutCache(() => textAnalysisCacheStats()), null);
    assert.equal(levenshteinDistance(a, b), withoutCache(() => levenshteinDistance(a, b)));
    assert.equal(levenshteinDistance(b, a), withoutCache(() => levenshteinDistance(b, a)));
  }
  assert.ok(stats().hits >= stats().misses);
}));

test('nested async callers share the owner store and do not release it', async () => {
  const a = '중첩 호출의 첫 문장이다.', b = '중첩 호출의 첫 문장이었다.';
  const expected = levenshteinDistance(a, b);
  await withTextAnalysisCache(async () => {
    assert.equal(levenshteinDistance(a, b), expected);
    const inner = await withTextAnalysisCache(async () => {
      await new Promise(setImmediate);
      return withTextAnalysisCache(() => levenshteinDistance(a, b));
    });
    assert.equal(inner, expected);
    assert.equal(textAnalysisCacheStats().released, false);
    await Promise.all([1, 2, 3].map(async () => {
      await new Promise(setImmediate);
      assert.equal(levenshteinDistance(a, b), expected);
    }));
    assert.deepEqual([stats().misses, stats().hits, stats().entries], [1, 4, 1]);
  });
  assert.equal(textAnalysisCacheStats(), null);
});

test('concurrent requests never see each other’s entries', async () => {
  const a = '동시 요청 문장이다.', b = '동시 요청의 문장이다.';
  const expected = levenshteinDistance(a, b);
  const results = await Promise.all([0, 1, 2].map(index => withTextAnalysisCache(async () => {
    const values = [levenshteinDistance(a, b)];
    await new Promise(resolve => setTimeout(resolve, 3 - index));
    values.push(levenshteinDistance(a, b), levenshteinDistance(b, a), levenshteinDistance('요청' + index, '요청 ' + index));
    return { values, stats: stats() };
  })));
  for (const result of results) {
    assert.deepEqual(result.values, [expected, expected, levenshteinDistance(b, a), 1]);
    assert.deepEqual([result.stats.misses, result.stats.hits, result.stats.entries], [3, 1, 3]);
  }
  await withTextAnalysisCache(async () => {
    assert.deepEqual([stats().entries, stats().calls], [0, 0]);
    assert.equal(levenshteinDistance(a, b), expected);
    assert.deepEqual([stats().misses, stats().hits], [1, 0]);
  });
});

test('a throwing computation stores nothing and a failed request is released', async () => {
  let probe;
  let attempts = 0;
  const job = withTextAnalysisCache(async () => {
    probe = new AsyncResource('probe');
    const compute = () => { attempts += 1; if (attempts === 1) throw new RangeError('synthetic'); return 7; };
    assert.throws(() => memoizeDistance('x', 'y', compute), RangeError);
    assert.equal(stats().entries, 0);
    assert.equal(memoizeDistance('x', 'y', compute), 7);
    assert.equal(memoizeDistance('x', 'y', compute), 7);
    assert.equal(attempts, 2);
    await new Promise(setImmediate);
    throw new TypeError('synthetic request failure');
  });
  await assert.rejects(job, TypeError);
  probe.runInAsyncScope(() => {
    const state = textAnalysisCacheStats();
    assert.equal(state.released, true);
    assert.deepEqual([state.distance.entries, state.distance.characters, state.spans.entries, state.spans.characters], [0, 0, 0, 0]);
    let late = 0;
    assert.equal(memoizeDistance('x', 'y', () => { late += 1; return 9; }), 9);
    assert.equal(memoizeDistance('x', 'y', () => { late += 1; return 9; }), 9);
    assert.equal(late, 2);
    assert.equal(levenshteinDistance('늦은 호출', '늦은 호출들'), 1);
    assert.equal(textAnalysisCacheStats().distance.entries, 0);
  });
  assert.throws(() => withTextAnalysisCache(() => { probe = new AsyncResource('probe'); levenshteinDistance('ab', 'cd'); throw new SyntaxError('synthetic'); }), SyntaxError);
  probe.runInAsyncScope(() => assert.equal(textAnalysisCacheStats().released, true));
});

test('cancellation releases the store and later requests start empty', async () => {
  const controller = new AbortController();
  let probe;
  const job = withTextAnalysisCache(async () => {
    probe = new AsyncResource('probe');
    levenshteinDistance('취소 전 문장', '취소 전의 문장');
    assert.equal(stats().entries, 1);
    await new Promise((resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    levenshteinDistance('도달하지 않는다', '도달하지 않음');
  });
  await new Promise(setImmediate);
  controller.abort();
  await assert.rejects(job, { name: 'AbortError' });
  probe.runInAsyncScope(() => {
    const state = textAnalysisCacheStats();
    assert.equal(state.released, true);
    assert.deepEqual([state.distance.entries, state.distance.characters, state.distance.misses], [0, 0, 1]);
  });
  await withTextAnalysisCache(async () => assert.deepEqual([stats().entries, stats().calls], [0, 0]));
});

test('entry, character and pair bounds hold; oversize pairs bypass', () => withTextAnalysisCache(() => {
  const limits = stats();
  let computed = 0;
  const compute = () => { computed += 1; return computed; };
  const left = i => 'L' + i;
  memoizeDistance(left(0), 'r', compute);
  memoizeDistance(left(1), 'r', compute);
  for (let i = 2; i < limits.maxEntries; i += 1) memoizeDistance(left(i), 'r', compute);
  assert.equal(stats().entries, limits.maxEntries);
  assert.equal(memoizeDistance(left(0), 'r', compute), 1); // refreshed, so pair 1 is now oldest
  for (let i = 0; i < 100; i += 1) memoizeDistance(left(limits.maxEntries + i), 'r', compute);
  assert.deepEqual([stats().entries, stats().evictions, stats().peakEntries], [limits.maxEntries, 100, limits.maxEntries]);
  const before = computed;
  assert.equal(memoizeDistance(left(0), 'r', compute), 1);
  assert.equal(computed, before);
  assert.equal(memoizeDistance(left(1), 'r', compute), before + 1);

  const half = Math.floor(limits.maxPairCharacters / 2);
  const wide = i => String(i).padStart(4, '0') + 'w'.repeat(half - 4);
  const count = Math.ceil(limits.maxCharacters / limits.maxPairCharacters) + 5;
  for (let i = 0; i < count; i += 1) {
    memoizeDistance(wide(i), wide(i + 1), compute);
    assert.ok(stats().characters <= limits.maxCharacters);
    assert.ok(stats().entries <= limits.maxEntries);
  }
  assert.ok(stats().peakCharacters <= limits.maxCharacters);
  assert.equal(stats().bypassedOversize, 0);

  const oversize = 'o'.repeat(limits.maxPairCharacters);
  const entries = stats().entries, characters = stats().characters;
  const calls = computed;
  memoizeDistance(oversize, 'x', compute);
  memoizeDistance(oversize, 'x', compute);
  assert.equal(computed, calls + 2);
  assert.deepEqual([stats().bypassedOversize, stats().entries, stats().characters], [2, entries, characters]);
}));

test('statistics are numeric only and edit metrics are unchanged by the store', async () => {
  const source = '첫 문장은 측정 방법을 설명한다. 둘째 문장은 결과를 요약한다.\n\nThird sentence stays in English 😀.';
  const output = '첫 문장은 측정 방법을 설명했다. 둘째 문장에서 결과를 요약한다.\n\nThird sentence stays in English.';
  const expected = computeEditMetrics(source, output);
  await withTextAnalysisCache(async () => {
    assert.deepEqual(computeEditMetrics(source, output), expected);
    await new Promise(setImmediate);
    assert.deepEqual(computeEditMetrics(source, output), expected);
    assert.deepEqual([stats().misses, stats().hits], [1, 1]);
    const walk = value => Object.values(value).forEach(item => (item && typeof item === 'object'
      ? walk(item) : assert.ok(typeof item === 'number' || typeof item === 'boolean')));
    walk(textAnalysisCacheStats());
    assert.ok(!JSON.stringify(textAnalysisCacheStats()).includes('문장'));
  });
  assert.deepEqual(computeEditMetrics(source, output), expected);
});
