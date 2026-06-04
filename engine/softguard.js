// [engine/softguard.js] cheap risk detector (보고서 §7.3·§7.2) — 결정론, LLM 없음
// ────────────────────────────────────────────────────────────────
// hard 가드(숫자·URL·고유명사·내부참조)로 못 잡는 *soft 날조*를 싸게 선별:
//   원문에 없던 감정·미래전망·불확실·개인반응 마커 추가, modal(단정↔hedge) 강도 변화.
// 이 detector는 high-recall/low-precision → 직접 게이트하지 않고 semanticJudge 트리거로 쓴다(§7.2).
// 예: "꾸준히 기록하고 싶다"→"6개월 후 몸이 어떻게 반응할지 모르겠다"(future+uncertainty),
//     "an idea"→"half-baked idea"(sentiment/reaction).

const MARKERS = {
  emotion: /무섭|두렵|설레|벅차|뭉클|행복|슬프|짜증|화가\s*나|불안|외로|뿌듯|허전|기쁘|괴로|두근|초조|막막|울컥|반갑|scary|afraid|excited|thrilled|nervous|anxious|lonely|proud|heartbreaking|devastat/gi,
  future: /앞으로|향후|미래|장차|언젠가|머지않아|훗날|장래|\d+\s*(?:개월|년|주|일)\s*(?:후|뒤)|in the future|going forward|years from now|months from now|down the road|someday/gi,
  uncertainty: /모르겠|불확실|장담할\s*수\s*없|확신할\s*수\s*없|미지수|두고\s*봐야|살아봐야\s*알|답은\s*없|답을\s*찾|어떻게\s*될지|계속할\s*수\s*있을지|not sure|uncertain|who knows|hard to say|remains to be seen|no idea|still don'?t know|where this goes/gi,
  reaction: /솔직히|개인적으로|내\s*생각|제\s*생각|느끼기엔|돌이켜보면|새삼|처음엔|막상|더라고요|더라구요|honestly|personally|frankly|to be honest|in my view/gi
};

const HEDGE_RE = /(것\s*같|듯하|듯합|지도\s*모|수도\s*있|기도\s*하|생각합니다|봅니다|아닐까|지\s*않을까|maybe|perhaps|might|i think|it seems)/i;

function count(text, re) { return ((text || '').match(re) || []).length; }
function hedgeRatio(text) {
  const s = (text || '').split(/(?<=[.!?。])\s+|\n+/).map(x => x.trim()).filter(Boolean);
  if (!s.length) return 0;
  return s.filter(x => HEDGE_RE.test(x)).length / s.length;
}

// 원문 대비 출력에서 *추가된* soft 마커를 카테고리별로 카운트. flagged면 semanticJudge 대상.
function measureSoftDrift(rawText, outputText) {
  const added = {};
  let total = 0;
  for (const [k, re] of Object.entries(MARKERS)) {
    const a = Math.max(0, count(outputText, re) - count(rawText, re));
    added[k] = a;
    total += a;
  }
  const modalShift = Number((hedgeRatio(outputText) - hedgeRatio(rawText)).toFixed(2));
  // 마커(감정·미래·불확실·반응) 2개+ 추가 시만 judge 트리거.
  // ★ modalShift는 보고용으로만 — 휴머나이저는 원래 hedge를 의도적으로 *추가*하므로 flag 기준에서 제외(과교정 방지).
  const flagged = total >= 2;
  return { added, total, modalShift, flagged };
}

// 결론부(끝 20%) soft drift — 원문엔 없던 회의·불확실·미래·감정이 결론에 추가되면 FLOOR critical 후보(§E.5-4).
// 결론 의도 역전(긍정 의지 → "모르겠다/무릎 꿇을지")의 1차 탐지. 전체 drift보다 가중.
function conclusionZone(text) {
  const s = (text || '').split(/(?<=[.!?。])\s+|\n+/).map(x => x.trim()).filter(Boolean);
  if (!s.length) return '';
  return s.slice(Math.floor(s.length * 0.8)).join(' ');  // 끝 20%
}
// ★ raw 결론부 vs output 결론부 비교(원문 전체 비교가 아님 — 원문 중간에 '앞으로'가 있어도 결론 추가를 놓치지 않음).
function measureConclusionDrift(rawText, outputText) {
  const outZone = conclusionZone(outputText);
  if (!outZone) return { flagged: false, markers: [] };
  const rawZone = conclusionZone(rawText);
  const markers = [];
  for (const [k, re] of Object.entries(MARKERS)) {
    if (count(outZone, re) > count(rawZone, re)) markers.push(k);  // 결론부에서 *늘어난* 마커
  }
  return { flagged: markers.length > 0, markers, zone: outZone };
}

module.exports = { measureSoftDrift, measureConclusionDrift };
