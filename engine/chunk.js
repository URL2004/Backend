// [engine/chunk.js] server-side chunking 결정론 코어 (보고서 §7.2)
// ────────────────────────────────────────────────────────────────
// 프론트 분할(prevContext 300자) 폐기 → 서버가 문단 경계로 쪼개고 charRange로 다시 합친다.
// 이 파일은 LLM 없는 순수 함수: split/merge/position/charRange. 회귀를 eval로 잠근다.
//
// 핵심 불변식: outputText를 안 채우면 mergeChunks(splitChunks(text)) === text (왕복 보존).

// 청크 목표/상한 크기(공백 포함 문자수). 과대 문단은 단일 LLM 호출 부담·출력 길이 변동을 키우므로 2차 분할.
const TARGET_CHARS = 1600;   // 목표(1200~1800 중앙)
const HARD_MAX = 2500;       // 이 길이를 넘으면 반드시 분할

// 과대 청크(text > HARD_MAX)를 문장 경계로 분할. 슬라이스가 연속이고 sep은 마지막 조각만 가져 왕복 보존.
function splitLongChunk(c) {
  const text = c.text;
  if (text.length <= HARD_MAX) return [c];
  const cuts = [];                                  // 문장 끝(.!?。 뒤 공백/끝) 또는 줄바꿈 위치
  const re = /[.!?。](?=\s|$)|\n/g; let m;
  while ((m = re.exec(text)) !== null) cuts.push(m.index + 1);
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
    if (forced) cut = segStart + HARD_MAX;           // 문장경계 없음 → 강제 컷(왕복은 슬라이스 연속이라 유지)
    // ★ 컷 직후 공백을 이 조각의 sep로 흡수(2026-06-18 실데이터 "활용하였다.고객의" 잼 수정): 문장경계 컷은 구두점 직후라
    //   다음 조각이 공백으로 시작 → LLM 재작성이 그 앞 공백을 떨구면 병합 시 문장이 붙어 긴 문단이 벽글이 된다.
    //   공백을 sep에 넣고 다음 조각을 공백 뒤부터 시작 → 잼 방지 + 왕복 보존(중복 공백 없음).
    // ★ 단, 공백이 없을 때 한 칸 보강은 '문장경계 컷'에만(구두점 뒤 잼). 강제 컷(HARD_MAX·토큰 중간)은 ''로
    //   원형 보존 — URL·SMILES·코드 같은 공백 없는 런 한가운데에 팬텀 공백을 주입하지 않는다(2026-06-19 R-02).
    let wsEnd = cut;
    while (wsEnd < text.length && /[ \t]/.test(text.charAt(wsEnd))) wsEnd++;
    ranges.push([segStart, cut, wsEnd > cut ? text.slice(cut, wsEnd) : (forced ? '' : ' ')]);
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

// 참고(§리뷰#18): 작은 인접 청크 coalesce(병합)는 검토 후 제외. 이 제품의 청킹은 "문단=단위"가 설계 전제
//   (블로그 짧은 문단 유지·position 기반 intro/body/conclusion 처리·nearestChunkId·문단별 왕복 계약).
//   블로그 문단이 본래 짧아(30~250자) "합칠 조각"과 "의도된 짧은 문단"을 가를 임계가 없어, coalesce는 구조를
//   파괴한다. 대신 청크 길이 유연성은 length_short를 청크레벨에서 제외(floor.collectFloorViolations chunkLevel)로 해결.

// 문단 경계(\n{2,})로 분할. 각 청크는 원본 charRange[start,end)와 뒤따르는 구분자(sep)를 보존.
// position: intro(첫) / conclusion(끝) / body(중간) / single(1개뿐).
function splitChunks(text) {
  const t = text || '';
  const re = /\n{2,}/g;
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
