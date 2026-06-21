// [engine/dedupe.js] 중복/boundary-leak 검출 (Step 1 — 카피킬러 "동일 내용 과도한 반복" 직격)
// ────────────────────────────────────────────────────────────────
// 문제: segment 재작성(optimizer/grounding/polish)이 인접 내용을 재진술 → 병합 시 같은 내용이 두 번.
//   measureNovelty(FLOOR)는 "원문에 있는 내용 반복"을 날조로 안 봐서 못 막는다. 별도 hard gate 필요.
//   (공부 v4에서 "동일 내용 과도한 반복" 3건이 실제로 이 문제였음)

const sg = require('./surfaceguard');

const STOP = new Set(['그리고', '하지만', '그런데', '그러나', '그래서', '때문', '경우', '정도', '우리', '사람', '문제', '방식', '상황', '결국', '지금', '이것', '그것', '저것', '이런', '그런', '저런', '거예요', '거든요', '아니라', '있어요', '없어요', '해요', '대한', '위한', '통해', '대해']);
function contentTokens(s) {
  return new Set((s.match(/[가-힣]{2,}|[A-Za-z]{3,}/g) || []).filter(w => !STOP.has(w)));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
function overlapRatio(a, b) {   // a 중 b에 들어있는 비율(방향성)
  if (!a.size) return 0;
  let h = 0; for (const t of a) if (b.has(t)) h++;
  return h / a.size;
}

// 문장 단위 근접 중복 수: 앞선 문장과 토큰 Jaccard ≥ thr 이면 "같은 내용 재진술"로 카운트.
function measureNearDupSentences(text, thr = 0.6) {
  const sents = sg.splitSentences(text).filter(s => s.replace(/\s+/g, '').length >= 15);
  const toks = sents.map(contentTokens);
  let dup = 0;
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].size < 4) continue;
    for (let j = 0; j < i; j++) {
      if (toks[j].size < 4) continue;
      if (jaccard(toks[i], toks[j]) >= thr) { dup++; break; }
    }
  }
  return dup;
}

// 경계 누수: 재작성 후보가 "원본 segment에 없던 인접 segment 내용"을 끌어와 재진술하는가.
//   candidate가 이웃과의 토큰 겹침이 원본보다 유의미하게 커지면 = 인접 내용 재진술 = leak.
function boundaryLeak(candidate, originalSeg, neighbors = []) {
  const cand = contentTokens(candidate);
  const orig = contentTokens(originalSeg);
  for (const nb of neighbors) {
    if (!nb) continue;
    const nbTok = contentTokens(nb);
    if (nbTok.size < 5) continue;
    const candOv = overlapRatio(cand, nbTok);
    const origOv = overlapRatio(orig, nbTok);
    if (candOv > origOv + 0.25 && candOv > 0.4) return true;   // 이웃 내용을 새로 많이 끌어옴
  }
  return false;
}

// ── 결정론 문장 중복 제거 (floor.measureRepetition과 동일 척도) ──────────────
//   휴머나이저가 도입부 등을 중복 생성하면 카피킬러 "동일 내용 과도한 반복" + FLOOR BLOCK.
//   중복 문장은 새 정보가 0이므로 후속 등장만 삭제(첫 등장 보존) = 무손실. LLM 불필요.
function _normSent(s) {
  return (s || '').replace(/\s+/g, '').toLowerCase().replace(/[.!?。,，、'"“”‘’()[\]]/g, '');
}
function _bigrams(s) {
  const g = new Set();
  for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
  return g;
}
const _DEDUP_FUZZY_SIM = 0.6;     // char-bigram Jaccard(=floor.FUZZY_SIM) — 어미·소수 단어만 다른 근접중복
const _DEDUP_MIN_LEN = 16;        // 정규화 길이 하한(=floor.FUZZY_MIN_LEN)

// ★ 숫자집합(연도·수치) 추출/비교 — fuzzy 근접중복이 '다른 사실'을 지우는 것 방지(2026-06-19 R-03:
//   "2023…매출 100억"·"2024…매출 200억"은 표면 bigram이 ≥0.6이지만 연도·금액이 달라 서로 다른 사실).
//   숫자(쉼표·소수점 포함)를 정규화해 멀티셋으로 비교, 다르면 fuzzy 삭제 안 함(exact 중복은 영향 없음).
function _numSet(s) { return ((s || '').match(/\d[\d,]*\.?\d*/g) || []).map(x => x.replace(/[.,]+$/, '').replace(/,/g, '')).sort(); }
function _sameNums(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }

// ★ 부정·양태 시그니처(2026-06-19 R-04 확장) — fuzzy 근접중복이 '반대 극성/다른 양태'를 지우면 의미가 뒤집힌다.
//   "효과가 있다고 평가된다" vs "효과가 없다고 평가된다"(긴 문장)는 jaccard 높고 숫자 같아 fuzzy로 삭제되던 사각.
//   기존 NEG 가드는 _isShortSynEcho(≤12자)에만 있어 긴 문장은 무방비 → 시그니처가 다르면 fuzzy 삭제 금지.
const _NEG_RE = /(?:지\s*않|지\s*못|(?:^|[\s,])안\s|(?:^|[\s,])못\s|없|아니|불가)/;
const _POSS_RE = /(?:수\s*있|수\s*도|가능|할\s*만)/;     // 가능성·여지
const _OBLIG_RE = /(?:해야|하여야|반드시|필요가\s*있|당연|당위)/;  // 당위·의무
function _stanceSig(s) {
  const x = String(s || '');
  return (_NEG_RE.test(x) ? 'N' : '') + (_POSS_RE.test(x) ? 'P' : '') + (_OBLIG_RE.test(x) ? 'O' : '');
}

// 꼬리 에코: 직전 문장의 꼬리를 짧은 파편으로 되풀이("…신뢰로 전환하는 일이다. 신뢰로 전환하는 일.").
//   exact/fuzzy 둘 다 못 잡는 사각(파편이 15자 미만 + 장문 대비 jaccard 낮음). 정규화 파편이
//   직전 문장에 부분문자열로 들어있거나 bigram이 거의 전부(≥0.85) 직전 문장에 포함되면 에코로 삭제.
function _isTailEcho(key, prevKey) {
  if (!prevKey || key.length < 4 || key.length > 20) return false;
  if (key.length >= prevKey.length * 0.7) return false;     // 길이가 비슷하면 에코 아님(fuzzy 영역)
  if (prevKey.includes(key)) return true;
  const g = _bigrams(key), pg = _bigrams(prevKey);
  if (g.size < 3) return false;
  let inP = 0; for (const x of g) if (pg.has(x)) inP++;
  return inP / g.size >= 0.85;
}

// ★ 짧은 동의어 되풀이 에코(2026-06-17, #2 "…어렵다. 불가능하다."): 표면 겹침이 없어 _isTailEcho가 못 잡는,
//   직전 단정을 짧은 동의어 단정으로 다시 말하는 사각. 전체 어간으로만 매칭('가능'은 '불가능'의 부분문자열이라
//   아예 그룹에서 제외 — 반대뜻 오삭제 방지). ≤12자 + 다/음/함 종결 + 직전 문장이 더 길고 같은 어간 그룹 공유일
//   때만. 못 잡으면 그냥 유지(과삭제 0). env DEDUP_SYNECHO=0으로 해제.
const SHORT_ECHO_SYNS = [
  ['어렵', '불가능', '힘들', '곤란', '난해'],
  ['쉽', '수월', '간단', '용이'],
  ['중요', '핵심', '관건', '결정적'],
  ['필요', '필수', '불가결'],
];
function _isShortSynEcho(part, prevPart) {
  if (process.env.DEDUP_SYNECHO === '0') return false;
  const raw = (part || '').trim();
  const k = _normSent(part);
  if (k.length < 3 || k.length > 12) return false;
  if (!/(?:다|음|함)[.!?。]?$/.test(raw)) return false;
  const pp = prevPart || '';
  if (pp.length <= raw.length) return false;                // 직전 문장이 더 길어야 '짧은 되풀이'
  // ★ 부정 극성이 다르면 동의어라도 반대뜻 — 에코 아님(2026-06-19 R-04: "어렵지 않다"≠"불가능하다").
  const NEG = /(?:지\s*않|지\s*못|안\s|못\s|없|아니)/;
  if (NEG.test(pp) !== NEG.test(raw)) return false;
  for (const grp of SHORT_ECHO_SYNS) {
    if (grp.some(w => raw.includes(w)) && grp.some(w => pp.includes(w))) return true;
  }
  return false;
}

function dedupeSentences(text) {
  const paras = (text || '').split(/\n{2,}/);
  const keptNorm = new Set();     // 정확 중복용
  const keptGrams = [];           // 근접 중복용(길이≥MIN_LEN 문장만)
  let removed = 0;
  const out = paras.map(p => {
    const parts = p.split(/(?<=[.!?。])\s+/);          // floor.measureRepetition과 동일 문장분리
    const keep = [];
    let prevKey = '', prevPart = '';                    // 문단 내 직전 보존 문장(에코 판정용)
    for (const part of parts) {
      const key = _normSent(part);
      if (_isTailEcho(key, prevKey) || _isShortSynEcho(part, prevPart)) { removed++; continue; }  // 꼬리/동의어 에코 → 삭제
      if (key.length < 15) { keep.push(part); prevKey = key; prevPart = part; continue; }   // 짧은 문장은 exact/fuzzy 대상 아님
      if (keptNorm.has(key)) { removed++; continue; }        // 정확 중복 → 후속 삭제
      let dup = false;
      if (key.length >= _DEDUP_MIN_LEN) {
        const g = _bigrams(key);
        const nums = _numSet(part);
        const sig = _stanceSig(part);
        // 표면이 비슷(jaccard≥0.6)해도 숫자(R-03)나 부정/양태 시그니처(R-04 확장)가 다르면 다른 의미 → 삭제 금지
        for (const kg of keptGrams) { if (jaccard(g, kg.g) >= _DEDUP_FUZZY_SIM && _sameNums(nums, kg.nums) && sig === kg.sig) { dup = true; break; } }
        if (!dup) keptGrams.push({ g, nums, sig });
      }
      if (dup) { removed++; continue; }                      // 근접 중복 → 후속 삭제
      keptNorm.add(key);
      keep.push(part);
      prevKey = key; prevPart = part;
    }
    return keep.join(' ').trim();
  }).filter(p => p.length > 0);
  return { text: out.join('\n\n'), removed };
}

module.exports = { measureNearDupSentences, boundaryLeak, contentTokens, dedupeSentences };
