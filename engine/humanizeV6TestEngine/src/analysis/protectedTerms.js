const { tokenize, splitLines, escapeRegExp } = require('./textStats');

function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const t = String(x || '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function extractProtectedTerms(text, opts = {}) {
  const source = String(text || '');
  const max = opts.max || 120;
  const terms = [];

  // Numeric facts and units: 4층, 13개 동, 2026년, 35%, 2명, 약 4시간
  const numericPatterns = [
    /(?:약\s*)?\d+(?:[.,]\d+)?\s*(?:년|월|일|시|분|초|시간|회|개|명|층|동|건|%|퍼센트|원|만원|억원|kg|g|톤|km|m|cm|mm|㎡|평|대|점|배)/g,
    /\d{4}[.-]\d{1,2}[.-]\d{1,2}/g,
    /\d+(?:[.,]\d+)?\s*[~–-]\s*\d+(?:[.,]\d+)?\s*(?:회|개|명|%|퍼센트|시간|일|년|월)?/g
  ];
  for (const re of numericPatterns) pushMatches(source, re, terms);

  // Latin acronyms, APIs, model names, and English proper terms.
  pushMatches(source, /\b[A-Z]{2,}(?:[-_][A-Z0-9]+)*\b/g, terms);
  pushMatches(source, /\b[A-Za-z]+(?:\s+[A-Z][A-Za-z0-9]+){1,3}\b/g, terms);
  pushMatches(source, /\b[A-Za-z]+(?:[-_][A-Za-z0-9]+){1,4}\b/g, terms);

  // Parenthesized labels: 워터폴(Waterfall), 스쿼드(Squad), DS부문.
  pushMatches(source, /[가-힣A-Za-z0-9]{2,}\([A-Za-z0-9가-힣\s._-]{1,30}\)/g, terms);
  pushMatches(source, /\([A-Za-z0-9가-힣\s._-]{2,30}\)/g, terms);

  // Korean middle-dot lists and comma-like compact enumerations.
  pushMatches(source, /[가-힣A-Za-z0-9]{2,}(?:·[가-힣A-Za-z0-9]{1,}){1,8}/g, terms);
  pushMatches(source, /[가-힣A-Za-z0-9]{2,}(?:\/|·|,\s*)[가-힣A-Za-z0-9]{2,}(?:(?:\/|·|,\s*)[가-힣A-Za-z0-9]{2,}){0,5}/g, terms);

  // Quoted or marked terms.
  pushMatches(source, /['“”‘’\"]([^'“”‘’\"]{2,40})['“”‘’\"]/g, terms, 1);

  // Title/head-like lines must not be merged or deleted.
  for (const line of splitLines(source)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(#{1,6}\s+|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\.|\d+\.\s*)/.test(trimmed)) terms.push(trimmed);
    else if (trimmed.length <= 36 && !/[.!?。！？]$/.test(trimmed) && /[가-힣A-Za-z]/.test(trimmed)) terms.push(trimmed);
  }

  // Domain nouns: not case-specific; matches Korean term chunks ending in common entity/technical suffixes.
  const suffixes = [
    '기업', '회사', '기관', '대학교', '학교', '부문', '부서', '조직', '시스템', '서비스', '플랫폼', '포털',
    '기술', '설비', '장비', '기능', '방식', '전략', '구조', '프로세스', '터미널', '센터', '데이터',
    '인프라', '모델', '알고리즘', '아키텍처', 'API', '클라우드', '소프트웨어', '하드웨어'
  ];
  const suffixRe = new RegExp(`[가-힣A-Za-z0-9]{2,18}(?:${suffixes.map(escapeRegExp).join('|')})`, 'g');
  pushMatches(source, suffixRe, terms);

  // Repeated multi-syllable content tokens often represent topic anchors.
  const tokens = tokenize(source).filter(t => /[가-힣]/.test(t) && t.length >= 3);
  const freq = new Map();
  for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
  for (const [t, n] of freq.entries()) {
    if (n >= 2 && !isGenericToken(t)) terms.push(t);
  }

  return uniq(terms)
    .filter(t => t.length <= 80)
    .sort((a, b) => scoreTerm(b) - scoreTerm(a))
    .slice(0, max);
}

function pushMatches(text, re, out, group = 0) {
  const source = String(text || '');
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(source))) {
    out.push((m[group] || m[0]).trim());
  }
}

function isGenericToken(t) {
  return /^(그리고|하지만|따라서|이러한|이처럼|또한|나아가|결국|때문에|것이다|있다|한다|된다|중요하다|필요하다|가능하다|문제|결과|과정|방식|부분)$/.test(t);
}

function scoreTerm(t) {
  let s = 0;
  if (/\d/.test(t)) s += 6;
  if (/[A-Za-z]/.test(t)) s += 5;
  if (/[·/()]/.test(t)) s += 5;
  if (/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\.|^\d+\./.test(t)) s += 4;
  if (t.length >= 4) s += 2;
  if (t.length > 25) s -= 1;
  return s;
}

function missingProtectedTerms(sourceTerms, outputText) {
  const out = String(outputText || '');
  return (sourceTerms || []).filter(t => {
    if (!t || t.length > 100) return false;
    const normalized = t.replace(/\s+/g, ' ').trim();
    if (out.includes(t) || out.includes(normalized)) return false;
    // Allow minor spacing differences.
    const compact = t.replace(/\s+/g, '');
    return !out.replace(/\s+/g, '').includes(compact);
  });
}

module.exports = {
  extractProtectedTerms,
  missingProtectedTerms
};
