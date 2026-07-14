// [engine/dedupe.js] 중복/boundary-leak 검출 (Step 1 — 카피킬러 "동일 내용 과도한 반복" 직격)
// ────────────────────────────────────────────────────────────────
// 문제: segment 재작성(optimizer/grounding/polish)이 인접 내용을 재진술 → 병합 시 같은 내용이 두 번.
//   measureNovelty(FLOOR)는 "원문에 있는 내용 반복"을 날조로 안 봐서 못 막는다. 별도 hard gate 필요.
//   (공부 v4에서 "동일 내용 과도한 반복" 3건이 실제로 이 문제였음)

const sg = require('./surfaceguard');
const { splitSentences, splitSentenceSpans } = require('./koreanText');

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
  const sents = splitSentences(text).filter(s => s.replace(/\s+/g, '').length >= 15);
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
  const paras = (text || '').split(/\n[ \t]*\n+/);
  let removed = 0;
  const fuzzyWarnings = [];
  let previousSentence = null;
  const out = paras.map(p => {
    if (isDedupeProtectedParagraph(p)) {
      previousSentence = null;
      return p;
    }
    const parts = splitSentences(p);
    if (!parts.length) return p;
    const keep = [];
    const seenInParagraph = new Set();
    for (const part of parts) {
      const key = _normSent(part);
      if (!key) continue;
      const exactInParagraph = seenInParagraph.has(key);
      const exactAdjacent = previousSentence && previousSentence.key === key;
      if (exactInParagraph || exactAdjacent) {
        removed += 1;
        continue;
      }
      if (previousSentence && key.length >= _DEDUP_MIN_LEN && previousSentence.key.length >= _DEDUP_MIN_LEN) {
        const similarity = jaccard(_bigrams(key), _bigrams(previousSentence.key));
        if (similarity >= _DEDUP_FUZZY_SIM && key !== previousSentence.key) {
          fuzzyWarnings.push({
            similarity: Math.round(similarity * 1000) / 1000,
            previous: previousSentence.text.slice(0, 160),
            current: part.slice(0, 160)
          });
        }
      }
      seenInParagraph.add(key);
      keep.push(part);
      previousSentence = { key, text: part };
    }
    return keep.join(' ').trim();
  }).filter(p => p.length > 0);
  return { text: out.join('\n\n'), removed, fuzzyWarnings: fuzzyWarnings.slice(0, 20) };
}

// 청크 병합이 이미 처리한 앞 구간을 뒤에 다시 붙이는 경우, 문장 하나가 아니라
// 수백 자짜리 블록이 통째로 반복될 수 있다. fuzzy 문장을 임의로 지우지 않고,
// 원문에서 한 번뿐인 완전 일치 문장들이 결과에서 같은 원문 위치로 되돌아가는
// "역행 블록"만 제거한다. 중간에 짧은 인용 표기나 한두 문장의 가벼운 윤문이
// 있어도 완전 일치 anchor 3개 이상이 있어야 하므로 단일 유사 문장에는 작동하지 않는다.
function removeNewExactDuplicateBlocks(source, text, { maxBlocks = 4 } = {}) {
  const original = String(text || '');
  let output = original;
  const blocks = [];
  let removedSentenceCount = 0;
  const limit = Math.max(1, Math.min(8, Number(maxBlocks) || 4));

  for (let round = 0; round < limit; round += 1) {
    const candidate = findNewExactDuplicateBlock(source, output);
    if (!candidate) break;
    output = removeSentenceRange(output, candidate.start, candidate.end);
    removedSentenceCount += candidate.sentenceCount;
    blocks.push({
      sentenceCount: candidate.sentenceCount,
      anchorCount: candidate.anchorCount,
      sourceStart: candidate.sourceStart,
      sourceEnd: candidate.sourceEnd
    });
  }

  return {
    text: output,
    applied: output !== original,
    removedBlockCount: blocks.length,
    removedSentenceCount,
    blocks
  };
}

function findNewExactDuplicateBlock(source, text) {
  const sourceSpans = splitSentenceSpans(source);
  const outputSpans = splitSentenceSpans(text);
  if (sourceSpans.length < 4 || outputSpans.length < sourceSpans.length + 2) return null;

  const sourceOccurrences = new Map();
  sourceSpans.forEach((span, index) => {
    const key = _normSent(span.text);
    if (key.length < _DEDUP_MIN_LEN) return;
    const values = sourceOccurrences.get(key) || [];
    values.push(index);
    sourceOccurrences.set(key, values);
  });
  const uniqueSource = new Map();
  for (const [key, indices] of sourceOccurrences.entries()) {
    if (indices.length === 1) uniqueSource.set(key, indices[0]);
  }
  if (uniqueSource.size < 3) return null;

  const sourceKeys = sourceSpans.map(span => _normSent(span.text));
  const outputKeys = outputSpans.map(span => _normSent(span.text));
  const mapped = outputKeys.map(key => uniqueSource.has(key) ? uniqueSource.get(key) : null);
  const seen = new Set();
  let priorMax = -1;

  for (let index = 0; index < mapped.length; index += 1) {
    const mappedIndex = mapped[index];
    if (mappedIndex === null || !seen.has(mappedIndex)) {
      if (mappedIndex !== null) {
        seen.add(mappedIndex);
        priorMax = Math.max(priorMax, mappedIndex);
      }
      continue;
    }

    const candidate = extendDuplicateRun({
      start: index,
      mapped,
      seen,
      priorMax,
      outputKeys,
      sourceKeys
    });
    if (candidate) {
      const startSpan = outputSpans[candidate.start];
      const endSpan = outputSpans[candidate.end];
      if (!startSpan || !endSpan) return null;
      const candidateText = String(text || '').slice(startSpan.start, endSpan.end);
      if (containsDedupeProtectedContent(candidateText)) {
        seen.add(mappedIndex);
        priorMax = Math.max(priorMax, mappedIndex);
        continue;
      }
      return {
        ...candidate,
        start: startSpan.start,
        end: endSpan.end,
        sentenceCount: candidate.end - candidate.start + 1
      };
    }

    seen.add(mappedIndex);
    priorMax = Math.max(priorMax, mappedIndex);
  }
  return null;
}

function extendDuplicateRun({ start, mapped, seen, priorMax, outputKeys, sourceKeys }) {
  const anchors = [];
  let end = start - 1;
  let gaps = 0;
  let lastSource = -1;
  for (let index = start; index < mapped.length; index += 1) {
    const sourceIndex = mapped[index];
    if (sourceIndex !== null && sourceIndex > priorMax) break;
    if (sourceIndex !== null && seen.has(sourceIndex)) {
      if (lastSource >= 0 && sourceIndex < lastSource) break;
      anchors.push({ outputIndex: index, sourceIndex });
      lastSource = sourceIndex;
      gaps = 0;
      end = index;
      continue;
    }
    gaps += 1;
    if (gaps > 2) break;
    end = index;
  }
  if (anchors.length < 3) return null;
  const sourceStart = Math.min(...anchors.map(item => item.sourceIndex));
  const sourceEnd = Math.max(...anchors.map(item => item.sourceIndex));
  if (sourceEnd - sourceStart < 2) return null;

  // 청크 seam이 앞 문장의 일부와 중복 블록의 첫 문장을 붙여 버린 형태도
  // 복구한다. 다음 문장이 그 앞부분을 원문 그대로 완성하는 경우에만 범위를
  // 한 문장 확장하므로, 새 내용을 함께 지우지 않는다.
  let safeStart = start;
  if (start > 0 && end + 1 < mapped.length && mapped[end + 1] !== null && mapped[end + 1] > priorMax) {
    const previous = outputKeys[start - 1];
    const nextSource = sourceKeys[mapped[end + 1]] || '';
    let embedded = null;
    for (const sourceIndex of seen) {
      const key = sourceKeys[sourceIndex] || '';
      if (key.length < 24) continue;
      const at = previous.indexOf(key);
      if (at <= 0) continue;
      if (!embedded || key.length > embedded.key.length) embedded = { key, at };
    }
    if (embedded) {
      const prefix = previous.slice(0, embedded.at);
      if (prefix.length >= 10 && nextSource.startsWith(prefix)) safeStart = start - 1;
    }
  }

  const normalizedChars = outputKeys.slice(safeStart, end + 1).reduce((sum, key) => sum + key.length, 0);
  if (normalizedChars < 100) return null;
  return {
    start: safeStart,
    end,
    anchorCount: anchors.length,
    sourceStart,
    sourceEnd
  };
}

function removeSentenceRange(text, start, end) {
  const left = String(text || '').slice(0, start).replace(/[ \t]+$/u, '');
  const right = String(text || '').slice(end).replace(/^[ \t]+/u, '');
  if (!left) return right.trimStart();
  if (!right) return left.trimEnd();
  const separator = /\s$/u.test(left) || /^\s/u.test(right) ? '' : ' ';
  return `${left}${separator}${right}`.replace(/\n{3,}/gu, '\n\n').trim();
}

function isDedupeProtectedParagraph(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  if (/^(?:[>#]|[-*•]\s|\d+[.)]\s|[가-힣][.)]\s)/u.test(text)) return true;
  if (/^(?:목\s*차|차례|참고\s*문헌|참고\s*자료|References|Bibliography|부록|Appendix)(?=$|[^가-힣A-Za-z0-9_])/iu.test(text)) return true;
  if (/^[“"'‘].+[”"'’]$/su.test(text)) return true;
  if (/^(?:제\s*\d+\s*(?:장|절|항)|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)]?|\d+(?:\.\d+){0,3}[.)]?\s+)\S/u.test(text) && text.length <= 140) return true;
  if (/https?:\/\/|doi\s*:/iu.test(text) && /(?:19|20)\d{2}/u.test(text)) return true;
  return false;
}

function containsDedupeProtectedContent(value) {
  const paragraphs = String(value || '').split(/\n[ \t]*\n+/u).map(item => item.trim()).filter(Boolean);
  return paragraphs.some(paragraph => isDedupeProtectedParagraph(paragraph)
    || paragraph.split(/\n/u).some(line => isDedupeProtectedParagraph(line)));
}

module.exports = {
  measureNearDupSentences,
  boundaryLeak,
  contentTokens,
  dedupeSentences,
  removeNewExactDuplicateBlocks
};
