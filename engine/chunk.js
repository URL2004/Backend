// [engine/chunk.js] server-side chunking 결정론 코어 (보고서 §7.2)
// ────────────────────────────────────────────────────────────────
// 프론트 분할(prevContext 300자) 폐기 → 서버가 문단 경계로 쪼개고 charRange로 다시 합친다.
// 이 파일은 LLM 없는 순수 함수: split/merge/position/charRange. 회귀를 eval로 잠근다.
//
// 핵심 불변식: outputText를 안 채우면 mergeChunks(splitChunks(text)) === text (왕복 보존).
const { splitSentenceSpans } = require('./koreanText');

// 청크 목표/상한 크기(공백 포함 문자수). 과대 문단은 단일 LLM 호출 부담·출력 길이 변동을 키우므로 2차 분할.
const TARGET_CHARS = 1600;   // 목표(1200~1800 중앙)
const HARD_MAX = 2500;       // 이 길이를 넘으면 반드시 분할

// 과대 청크(text > HARD_MAX)를 문장 경계로 분할. 슬라이스가 연속이고 sep은 마지막 조각만 가져 왕복 보존.
function splitLongChunk(c) {
  const text = c.text;
  if (text.length <= HARD_MAX) return [c];
  // 소수점·목차 번호·영문 약어를 보호하는 공용 분리기의 실제 char offset을 그대로 쓴다.
  const cuts = splitSentenceSpans(text).slice(0, -1).map(item => item.end);
  const ranges = [];
  let segStart = 0;
  while (text.length - segStart > HARD_MAX) {
    const ideal = segStart + TARGET_CHARS;
    let cut = -1;
    for (const x of cuts) {
      if (x <= segStart || x > segStart + HARD_MAX) continue;
      if (cut === -1 || Math.abs(x - ideal) < Math.abs(cut - ideal)) cut = x;
    }
    const forced = (cut === -1);
    if (forced) cut = chooseSafeForcedCut(text, segStart, HARD_MAX, ideal); // 문장경계 없음 → 안전한 공백 우선 강제 컷
    // 컷 직후 실제 공백은 이 조각의 sep로 흡수한다. 원문에 공백이 없으면
    // 청커가 새 공백을 만들지 않는다. `활용하였다.고객의` 같은 입력 교정은
    // sourcePreflight 한 곳에서 처리해 split/merge의 정확한 왕복 계약을 지킨다.
    let wsEnd = cut;
    while (wsEnd < text.length && /[ \t]/.test(text.charAt(wsEnd))) wsEnd++;
    ranges.push([segStart, cut, wsEnd > cut ? text.slice(cut, wsEnd) : '']);
    segStart = wsEnd;
  }
  ranges.push([segStart, text.length, null]);        // 마지막 조각: 원래 청크 sep 사용
  return ranges.map(([a, b, sepWs], k) => {
    const piece = {
      start: c.start + a, end: c.start + b,
      sep: sepWs == null ? c.sep : sepWs,
      text: text.slice(a, b), outputText: null
    };
    if (k === 0 && c._lead) piece._lead = c._lead;   // 선행 공백은 첫 조각만
    return piece;
  });
}

function chooseSafeForcedCut(text, segStart, hardMax, ideal) {
  const hardEnd = Math.min(text.length, segStart + hardMax);
  const minEnd = Math.min(hardEnd, segStart + Math.max(900, Math.floor(hardMax * 0.45)));
  let best = -1;
  let bestScore = Infinity;
  for (let i = minEnd; i < hardEnd; i += 1) {
    if (!/\s/.test(text.charAt(i))) continue;
    const left = text.slice(Math.max(segStart, i - 18), i).trim();
    const right = text.slice(i + 1, Math.min(text.length, i + 32)).trim();
    if (!left || !right) continue;
    if (looksUnsafeCutTail(left) || looksUnsafeCutHead(right)) continue;
    const score = Math.abs(i - ideal);
    if (score < bestScore) {
      best = i;
      bestScore = score;
    }
  }
  if (best !== -1) return best;
  for (let i = Math.min(hardEnd - 1, ideal + 260); i >= minEnd; i -= 1) {
    if (/\s/.test(text.charAt(i))) return i;
  }
  return hardEnd;
}

function looksUnsafeCutTail(left) {
  return /(?:보다|및|과|와|의|을|를|은|는|이|가|에|에서|으로|로|부터|까지|처럼|대한|관한|그리고|그러나|하지만|또한|따라서|때문에|위해|통해|하며|하고)$/.test(String(left || '').trim());
}

function looksUnsafeCutHead(right) {
  return /^(?:및|과|와|의|을|를|은|는|이|가|에|에서|으로|로|부터|까지|처럼|때문에|위해|통해)(?=$|[^가-힣A-Za-z0-9_])/.test(String(right || '').trim());
}

// 참고(§리뷰#18): 작은 인접 청크 coalesce(병합)는 검토 후 제외. 이 제품의 청킹은 "문단=단위"가 설계 전제
//   (블로그 짧은 문단 유지·position 기반 intro/body/conclusion 처리·nearestChunkId·문단별 왕복 계약).
//   블로그 문단이 본래 짧아(30~250자) "합칠 조각"과 "의도된 짧은 문단"을 가를 임계가 없어, coalesce는 구조를
//   파괴한다. 대신 청크 길이 유연성은 length_short를 청크레벨에서 제외(floor.collectFloorViolations chunkLevel)로 해결.

// 문단 경계(빈 줄에 공백·탭만 있어도 포함)로 분할. 각 청크는 원본
// charRange[start,end)와 뒤따르는 구분자(sep)를 그대로 보존한다.
// position: intro(첫) / conclusion(끝) / body(중간) / single(1개뿐).
function splitChunks(text) {
  const t = text || '';
  const re = /\n[ \t]*\n+/g;
  const parts = [];
  let last = 0, m;
  while ((m = re.exec(t)) !== null) {
    parts.push({ start: last, end: m.index, sep: m[0] });
    last = m.index + m[0].length;
  }
  parts.push({ start: last, end: t.length, sep: '' });

  // 내용이 있는 파트만(앞뒤 공백 문단 제외) — 단 sep은 보존돼야 왕복이 맞으므로 빈 파트의 sep을 이웃에 흡수.
  const chunks = [];
  let carrySep = '';
  for (const p of parts) {
    const slice = t.slice(p.start, p.end);
    if (slice.trim().length === 0) {
      // 빈 문단: 그 구간 텍스트(slice)+sep를 다음 청크 앞으로 넘기지 않고, 직전 청크 sep에 붙여 왕복 보존
      if (chunks.length > 0) chunks[chunks.length - 1].sep += slice + p.sep;
      else carrySep += slice + p.sep;
      continue;
    }
    chunks.push({ start: p.start, end: p.end, sep: p.sep, text: slice, outputText: null });
    if (carrySep) { chunks[chunks.length - 1]._lead = carrySep; carrySep = ''; }
  }
  // 선행 공백(carrySep) 보존
  if (carrySep && chunks.length > 0) chunks[0]._lead = (chunks[0]._lead || '') + carrySep;

  // ★ 과대 문단 2차 분할(§리뷰#9) — 문장 경계로 쪼개 단일 호출 길이/변동 억제. 왕복 불변식 유지.
  const sized = [];
  for (const c of chunks) for (const sc of splitLongChunk(c)) sized.push(sc);

  const n = sized.length;
  sized.forEach((c, i) => {
    c.index = i;
    c.position = n === 1 ? 'single' : (i === 0 ? 'intro' : (i === n - 1 ? 'conclusion' : 'body'));
  });
  return sized;
}

// 청크를 원본 구분자로 재조립. outputText가 있으면 그것을, 없으면 원본 text를 사용 → 문단 경계 복원.
function mergeChunks(chunks) {
  return (chunks || []).map(c => (c._lead || '') + (c.outputText != null ? c.outputText : c.text) + (c.sep || '')).join('');
}

// 위반 span이 어느 청크에서 나왔는지 매핑 (semanticJudge의 span→nearest_chunk_id, §7.2).
function nearestChunkId(chunks, span) {
  const norm = (s) => (s || '').replace(/\s+/g, '').toLowerCase();
  const key = norm(span).slice(0, 16);
  if (!key) return null;
  for (const c of (chunks || [])) {
    if (norm(c.outputText != null ? c.outputText : c.text).includes(key)) return c.index;
  }
  return null;
}

module.exports = { splitChunks, mergeChunks, nearestChunkId, TARGET_CHARS, HARD_MAX };
