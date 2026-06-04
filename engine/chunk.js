// [engine/chunk.js] server-side chunking 결정론 코어 (보고서 §7.2)
// ────────────────────────────────────────────────────────────────
// 프론트 분할(prevContext 300자) 폐기 → 서버가 문단 경계로 쪼개고 charRange로 다시 합친다.
// 이 파일은 LLM 없는 순수 함수: split/merge/position/charRange. 회귀를 eval로 잠근다.
//
// 핵심 불변식: outputText를 안 채우면 mergeChunks(splitChunks(text)) === text (왕복 보존).

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

  const n = chunks.length;
  chunks.forEach((c, i) => {
    c.index = i;
    c.position = n === 1 ? 'single' : (i === 0 ? 'intro' : (i === n - 1 ? 'conclusion' : 'body'));
  });
  return chunks;
}

// 청크를 원본 구분자로 재조립. outputText가 있으면 그것을, 없으면 원본 text를 사용 → 문단 경계 복원.
function mergeChunks(chunks) {
  return (chunks || []).map(c => (c._lead || '') + (c.outputText != null ? c.outputText : c.text) + (c.sep || '')).join('');
}

module.exports = { splitChunks, mergeChunks };
