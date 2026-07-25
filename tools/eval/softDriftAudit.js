'use strict';

// Deterministic historical evaluation signals. These are intentionally kept
// under tools/eval: production delivery and candidate selection must not use
// these high-recall, low-precision markers.
const MARKERS = {
  emotion: /무섭|두렵|설레|벅차|뭉클|행복|슬프|짜증|화가\s*나|불안|외로|뿌듯|허전|기쁘|괴로|두근|초조|막막|울컥|반갑|scary|afraid|excited|thrilled|nervous|anxious|lonely|proud|heartbreaking|devastat/giu,
  future: /앞으로|향후|미래|장차|언젠가|머지않아|훗날|장래|\d+\s*(?:개월|년|주|일)\s*(?:후|뒤)|in the future|going forward|years from now|months from now|down the road|someday/giu,
  uncertainty: /모르겠|불확실|장담할\s*수\s*없|확신할\s*수\s*없|미지수|두고\s*봐야|살아봐야\s*알|답은\s*없|답을\s*찾|어떻게\s*될지|계속할\s*수\s*있을지|not sure|uncertain|who knows|hard to say|remains to be seen|no idea|still don'?t know|where this goes/giu,
  reaction: /솔직히|개인적으로|내\s*생각|제\s*생각|느끼기엔|돌이켜보면|새삼|처음엔|막상|honestly|personally|frankly|to be honest|in my view/giu
};

const HEDGE_RE = /(것\s*같|듯하|듯합|지도\s*모|수도\s*있|기도\s*하|생각합니다|봅니다|아닐까|지\s*않을까|maybe|perhaps|might|i think|it seems)/iu;

function count(text, pattern) {
  pattern.lastIndex = 0;
  return (String(text || '').match(pattern) || []).length;
}

function hedgeRatio(text) {
  const sentences = String(text || '')
    .split(/(?<=[.!?。])\s+|\n+/u)
    .map(value => value.trim())
    .filter(Boolean);
  if (!sentences.length) return 0;
  return sentences.filter(sentence => HEDGE_RE.test(sentence)).length / sentences.length;
}

function measureSoftDrift(source, outputText) {
  const added = {};
  let total = 0;
  for (const [key, pattern] of Object.entries(MARKERS)) {
    const delta = Math.max(0, count(outputText, pattern) - count(source, pattern));
    added[key] = delta;
    total += delta;
  }
  return {
    added,
    total,
    modalShift: Number((hedgeRatio(outputText) - hedgeRatio(source)).toFixed(2)),
    flagged: total >= 2
  };
}

function conclusionZone(text) {
  const sentences = String(text || '')
    .split(/(?<=[.!?。])\s+|\n+/u)
    .map(value => value.trim())
    .filter(Boolean);
  if (!sentences.length) return '';
  return sentences.slice(Math.floor(sentences.length * 0.8)).join(' ');
}

function measureConclusionDrift(source, outputText) {
  const sourceZone = conclusionZone(source);
  const outputZone = conclusionZone(outputText);
  if (!outputZone) return { flagged: false, markers: [] };
  const markers = ['emotion', 'future', 'uncertainty']
    .filter(key => count(outputZone, MARKERS[key]) > count(sourceZone, MARKERS[key]));
  return { flagged: markers.length > 0, markers, zone: outputZone };
}

module.exports = { measureSoftDrift, measureConclusionDrift };
