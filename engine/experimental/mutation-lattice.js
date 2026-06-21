'use strict';
// [engine/copykiller/mutation-lattice.js] 생성 0콜 재랭커 (P1 MVP).
//   원문(또는 LLM 1콜 결과)에 무API 결정론 변형을 여러 벌 적용 → 프록시로 채점 →
//   무날조·길이 게이트 통과한 것 중 최저 위험 선택. (생성 N콜 재랭커의 무료 대체)
//   ※ 핵심(보정 1): 절대위험만 보지 않고 "타깃 태그" 확률 변화도 본다.
//   ※ 핵심(보정 2, Goodhart): 변형은 정당한 품질편집만 — 프록시는 그 사이 "순위"만 매긴다.
const { MUTATORS } = require('./mutators');
const { stripSectionMeta } = require('./meta-strip');
const { checkFabrication } = require('./fidelity-guard');
const proxy = require('../copykiller-proxy');

// 결정론 변형이 줄일 수 있는 "문체" 태그(내용 태그인 추상/근거부족은 변형으로 안 내려감)
const TARGET_TAGS = ['무견해, 판단 회피적 성향', '주관성의 지나친 배제', '간접 화법, 비인칭 서술'];

const LEN_LO = 0.85, LEN_HI = 1.15;
const chars = s => String(s || '').replace(/\s/g, '').length;

// 원문 → 후보 변형들(중복 제거). 모든 후보에 meta-strip 선적용(항상 이득).
function buildVariants(original) {
  const base = stripSectionMeta(String(original || ''));
  const H = MUTATORS.hedge, I = MUTATORS.impersonal;
  const raw = [
    { label: 'meta-only', text: base },
    { label: 'hedge', text: H(base) },
    { label: 'impersonal', text: I(base) },
    { label: 'hedge+impersonal', text: I(H(base)) },
  ];
  const seen = new Set();
  const out = [];
  for (const v of raw) {
    if (seen.has(v.text)) continue;
    seen.add(v.text);
    out.push(v);
  }
  return out;
}

function tagProbs(pred) {
  const o = {};
  for (const t of TARGET_TAGS) o[t] = pred ? (pred['tag:' + t] || 0) : 0;
  return o;
}

// 원문 대비 후보들을 채점·정렬. proxy 없으면 null.
function rerank(original) {
  if (!proxy.available()) return null;
  const orig = String(original || '');
  const op = proxy.predict(orig);
  const origRisk = op ? op.composite_risk : null;
  const origTags = tagProbs(op);
  const origLen = chars(orig) || 1;

  const variants = buildVariants(orig);
  const scored = variants.map(v => {
    const p = proxy.predict(v.text);
    const risk = p ? p.composite_risk : 1;
    const vt = tagProbs(p);
    const tagDeltas = {};
    let targetGain = 0;
    for (const t of TARGET_TAGS) { tagDeltas[t] = origTags[t] - vt[t]; targetGain += tagDeltas[t]; }
    const fab = checkFabrication(orig, v.text);
    const lengthRatio = chars(v.text) / origLen;
    const ok = fab.ok && lengthRatio >= LEN_LO && lengthRatio <= LEN_HI;
    return { label: v.label, text: v.text, risk, compositeDelta: (origRisk ?? risk) - risk, targetGain, tagDeltas, fab, lengthRatio, ok };
  });

  const pool = scored.filter(s => s.ok);
  // 1순위 절대위험 최저, 동률 시 타깃 태그 감소 합 최대
  pool.sort((a, b) => (a.risk - b.risk) || (b.targetGain - a.targetGain));
  const winner = pool[0] || null;
  // 개선이 없으면(또는 후보 전멸) 원문 보존
  const improved = winner && winner.risk < (origRisk ?? 1) - 1e-6;
  return { origRisk, origTags, scored, winner: improved ? winner : null, preserved: !improved };
}

module.exports = { buildVariants, rerank, TARGET_TAGS };
