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

// 문서 전체 중복 지표(게이트용)
function measureDuplication(text) {
  return {
    openingDup: sg.measureOpeningDuplication(text),
    nearDup: measureNearDupSentences(text),
  };
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
function _isStructureFragment(s) {
  const raw = (s || '').trim();
  if (!raw) return false;
  if (/https?:\/\/|www\.|[a-z0-9-]+\.(?:go\.kr|or\.kr|co\.kr|com|org|net|kr)\b/i.test(raw)) return true;
  if (/국가법령정보센터|법령정보센터|참고문헌|출처/.test(raw) && raw.length <= 90) return true;
  const t = raw
    .replace(/^(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+|[IVX]+|[가-힣]|\d+)[.)]\s*/, '')
    .replace(/[.!?。]\s*$/, '')
    .trim();
  if (!t || t.length > 70) return false;
  if (/^(?:서론|본론|결론|참고문헌|요약)$/.test(t)) return true;
  if (/(?:목적|주요\s*내용|문제점|개정\s*방향|개정\s*필요성|조문안|개선안|실천\s*현장에\s*미치는\s*영향|분석|제시)$/.test(t)
    && !/(다|요|죠|함|임|음|까)$/.test(t)) return true;
  return false;
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

function dedupeSentences(text) {
  const paras = (text || '').split(/\n{2,}/);
  const keptNorm = new Set();     // 정확 중복용
  const keptGrams = [];           // 근접 중복용(길이≥MIN_LEN 문장만)
  const keptShort = new Map();     // floor.shortFragCount와 같은 짧은 조각 반복용
  let removed = 0;
  const out = paras.map(p => {
    const parts = p.split(/(?<=[.!?。])\s+|\n+/);      // floor.measureRepetition과 동일 문장분리
    const keep = [];
    let prevKey = '';                                   // 문단 내 직전 보존 문장(에코 판정용)
    for (const part of parts) {
      if (_isStructureFragment(part)) { keep.push(part); prevKey = _normSent(part); continue; }
      const key = _normSent(part);
      if (_isTailEcho(key, prevKey)) { removed++; continue; }  // 꼬리 에코 → 삭제
      if (key.length < 15) {
        if (key.length >= 4) {
          const n = keptShort.get(key) || 0;
          if (n >= 3) { removed++; continue; }           // 4회째부터 삭제(floor shortFrag threshold와 정합)
          keptShort.set(key, n + 1);
        }
        keep.push(part); prevKey = key; continue;        // 짧은 문장은 exact/fuzzy 대상 아님
      }
      if (keptNorm.has(key)) { removed++; continue; }        // 정확 중복 → 후속 삭제
      let dup = false;
      if (key.length >= _DEDUP_MIN_LEN) {
        const g = _bigrams(key);
        for (const kg of keptGrams) { if (jaccard(g, kg) >= _DEDUP_FUZZY_SIM) { dup = true; break; } }
        if (!dup) keptGrams.push(g);
      }
      if (dup) { removed++; continue; }                      // 근접 중복 → 후속 삭제
      keptNorm.add(key);
      keep.push(part);
      prevKey = key;
    }
    return keep.join(' ').trim();
  }).filter(p => p.length > 0);
  return { text: out.join('\n\n'), removed };
}

module.exports = { measureNearDupSentences, boundaryLeak, measureDuplication, contentTokens, dedupeSentences };
