'use strict';
const { normalizeText, words } = require('./textStats');

function extractProtectedTerms(text) {
  const t = normalizeText(text);
  const terms = new Set();

  // Numbers, ratios, time/scale tokens.
  for (const m of t.match(/\d+(?:[.,]\d+)?\s*(?:%|회|명|시간|분|일|년|개월|개|동|층|원|만원|억원|kg|GB|TB|m²|㎡)?/g) || []) {
    if (m.trim().length >= 1) terms.add(m.trim());
  }

  // English acronyms and product/API names.
  for (const m of t.match(/\b[A-Z]{2,}(?:[-_ ]?[A-Z0-9]{2,})*\b/g) || []) terms.add(m.trim());
  for (const m of t.match(/\b[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)+\b/g) || []) terms.add(m.trim());

  // Parenthetical terms e.g. 워터폴(Waterfall), DS.
  for (const m of t.match(/[가-힣A-Za-z0-9]+\([^)\n]{1,30}\)/g) || []) terms.add(m.trim());
  for (const m of t.match(/\([A-Za-z0-9가-힣]{1,20}\)/g) || []) terms.add(m.trim());

  // Enumerations joined by middle dots/slashes.
  for (const m of t.match(/[가-힣A-Za-z0-9]+(?:[·/][가-힣A-Za-z0-9]+){1,}/g) || []) terms.add(m.trim());

  // Quoted names.
  for (const m of t.match(/["'“”‘’][^"'“”‘’\n]{2,40}["'“”‘’]/g) || []) terms.add(m.replace(/["'“”‘’]/g, '').trim());

  // Korean technical noun phrases. Conservative: phrases ending in key nouns.
  const nounEnds = '(시스템|기술|기능|설비|데이터|포털|Portal|API|클라우드|방식|터미널|서비스|플랫폼|모델|조직|구조|센터|정보|장비|주기|전략|분야|기록|유전정보|심전도|부정맥|심장마비|개방)';
  const re = new RegExp(`[가-힣A-Za-z0-9][가-힣A-Za-z0-9\\s]{1,28}${nounEnds}`, 'g');
  for (const m of t.match(re) || []) {
    const s = m.replace(/^(그리고|또한|더불어|하지만|다만|한편)\s+/, '').replace(/(은|는|이|가|을|를)\s+.*$/, '').replace(/[은는이가을를과와]$/, '').trim();
    if (s.length >= 3 && s.length <= 40) terms.add(s);
  }


  // Short key phrases ending with functional nouns.
  const shortKeyRe = /[가-힣A-Za-z0-9]+(?:\s+[가-힣A-Za-z0-9]+){0,1}\s*(?:개방|기능|기술|데이터|설비|시스템|인프라|조회|분석)(?:은|는|이|가|을|를|과|와)?/g;
  for (const m of t.match(shortKeyRe) || []) {
    const s = m.replace(/^(그리고|또한|더불어|하지만|다만|한편)\s+/, '').replace(/(은|는|이|가|을|를)\s+.*$/, '').replace(/[은는이가을를과와]$/, '').trim();
    if (s.length >= 3 && s.length <= 35) terms.add(s);
  }

  // Frequent content words can be anchors if they are not too generic.
  const generic = new Set([
    '것','수','때','등','및','이러한','그리고','하지만','분야','방식','기술','정보','데이터','시스템','문제','경우','중심','부분',
    '이번','이런','먼저','함께','이후','정도','관련','통해','위해','대한','대해','따라','매우','가운데'
  ]);
  const toks = words(t).map(contentAnchor).filter(Boolean);
  const counts = new Map();
  for (const w of toks) counts.set(w, (counts.get(w) || 0) + 1);
  for (const [w, c] of counts) {
    if (c >= 3 && /[가-힣]/.test(w)) terms.add(w);
  }

  return [...terms]
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(s => s.length >= 2 && s.length <= 60)
    .sort((a, b) => b.length - a.length)
    .slice(0, 120);
}

function contentAnchor(word) {
  const raw = String(word || '').trim();
  if (raw.length < 2) return '';
  // Verbs/adjectives and discourse words are style, not facts. Protecting their
  // exact inflected surface form prevents the model from changing sentence
  // structure and was the main cause of V9's low-effect output.
  if (/(?:습니다|습니까|합니다|됩니까|됩니다|입니다|했습니다|됐습니다|있습니다|없습니다|않습니다|해요|했어요|돼요|이에요|예요|한다|했다|된다|있다|없다|이다)$/.test(raw)) return '';
  const stem = raw
    .replace(/(?:으로|에서|에게|까지|부터|처럼|보다|마다|께서|이라도|라도)$/u, '')
    .replace(/[은는이가을를과와도의에로만]$/u, '');
  if (stem.length < 2) return '';
  const generic = new Set([
    '것','이번','이런','먼저','함께','이후','정도','관련','통해','위해','대한','대해','따라','매우','가운데',
    '작업','진행','부분','과정','경우','상태','내용','결과','환경','목적','방법','필요','중요'
  ]);
  return generic.has(stem) ? '' : stem;
}

function protectedTermLoss(before, after, terms = extractProtectedTerms(before)) {
  const lost = [];
  for (const term of terms) {
    if (!term || term.length < 2) continue;
    if (before.includes(term) && !after.includes(term)) lost.push(term);
  }
  return lost;
}

function termContextMap(text, terms) {
  const t = normalizeText(text);
  const map = new Map();
  for (const term of terms) {
    const idx = t.indexOf(term);
    if (idx < 0) continue;
    const start = Math.max(0, idx - 45);
    const end = Math.min(t.length, idx + term.length + 45);
    map.set(term, t.slice(start, end));
  }
  return map;
}

module.exports = { extractProtectedTerms, protectedTermLoss, termContextMap };
