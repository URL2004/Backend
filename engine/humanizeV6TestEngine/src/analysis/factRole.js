const { splitSentences, normalizeText, escapeRegExp } = require('./textStats');

const FUNCTIONAL_CONNECTORS = /(와 더불어|과 더불어|와 함께|과 함께|동시에|또한|및|그리고|더불어|아울러)/;
const EFFECT_PREDICATES = /(줄이|감소|낮추|최소화|예방|방지|차단|기여|연동|확보|확대|제공|처리|분류|운영|개선|강화|만들어낸|이어진|작동|지원|가능하게)/;

function analyzeFactRoleDrift(sourceText, outputText, protectedTerms = [], options = {}) {
  const terms = normalizeTerms([...(protectedTerms || []), ...extractDomainRoleTerms(sourceText)]);
  if (terms.length < 2) return { issues: [], sourceSentenceMap: [] };

  const sourceSentences = splitSentences(sourceText);
  const outputSentences = splitSentences(outputText);
  const sourceMap = sourceSentences.map((sentence, idx) => ({ idx, sentence, terms: termsIn(sentence, terms) }));
  const pairSourceDistance = buildPairDistance(sourceMap);

  const issues = [];
  for (const outSentence of outputSentences) {
    const outTerms = termsIn(outSentence, terms);
    if (outTerms.length < 2) continue;
    if (!FUNCTIONAL_CONNECTORS.test(outSentence) && !EFFECT_PREDICATES.test(outSentence)) continue;

    const pairs = pairsOf(outTerms);
    for (const [a, b] of pairs) {
      const key = pairKey(a, b);
      const distance = pairSourceDistance.get(key);
      if (distance == null) continue;

      // If two protected terms never appeared together and came from distant source sentences,
      // putting them into one causal/function sentence is a fact-role drift risk.
      if (distance.minDistance > (options.maxSafeSentenceDistance ?? 0)) {
        const functional = FUNCTIONAL_CONNECTORS.test(outSentence) || EFFECT_PREDICATES.test(outSentence);
        issues.push({
          type: 'unverified_term_relation_mix',
          terms: [a, b],
          sourceSentenceIndexes: distance.indexes,
          distance: distance.minDistance,
          outputSentence: outSentence.slice(0, 180),
          severityHint: functional ? 'hard' : 'soft'
        });
      }
    }
  }

  return { issues: dedupeIssues(issues), sourceSentenceMap: sourceMap };
}


function extractDomainRoleTerms(text) {
  const s = String(text || '');
  const out = [];
  const patterns = [
    /[A-Z]{2,}\s*[가-힣]{1,12}(?:\s*(?:기술|기능|구조|서비스|시스템|데이터|연동|개방|전환))?/g,
    /[가-힣A-Za-z0-9]{2,12}\s*(?:인식|분류|추적|조회|연동|보전|예방|예측|자동|관리)?\s*(?:기술|기능|설비|시스템|서비스|플랫폼|구조|인프라|클라우드|터미널|포털|데이터|API)/g,
    /[가-힣]{2,12}\s*개방/g,
    /[가-힣]{2,12}\s*보전\s*기능/g
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(s))) {
      const t = cleanTerm(normalizeText(m[0]).replace(/\s+/g, ' '));
      if (t && t.length >= 2 && t.length <= 40) out.push(t);
    }
  }
  return out;
}

function normalizeTerms(terms) {
  const seen = new Set();
  const out = [];
  for (const raw of terms || []) {
    const t = cleanTerm(normalizeText(raw));
    if (!t || t.length < 2) continue;
    if (/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\.?$/.test(t)) continue;
    if (/^\d+\.?$/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.slice(0, 140);
}

function termsIn(sentence, terms) {
  const s = String(sentence || '');
  return terms.filter(t => new RegExp(escapeRegExp(t), 'i').test(s));
}

function buildPairDistance(sourceMap) {
  const termIndexes = new Map();
  for (const row of sourceMap) {
    for (const term of row.terms) {
      if (!termIndexes.has(term)) termIndexes.set(term, []);
      termIndexes.get(term).push(row.idx);
    }
  }
  const allTerms = [...termIndexes.keys()];
  const map = new Map();
  for (let i = 0; i < allTerms.length; i++) {
    for (let j = i + 1; j < allTerms.length; j++) {
      const a = allTerms[i];
      const b = allTerms[j];
      const ia = termIndexes.get(a) || [];
      const ib = termIndexes.get(b) || [];
      let minDistance = Infinity;
      let best = [];
      for (const x of ia) {
        for (const y of ib) {
          const d = Math.abs(x - y);
          if (d < minDistance) { minDistance = d; best = [x, y]; }
        }
      }
      map.set(pairKey(a, b), { minDistance, indexes: best });
    }
  }
  return map;
}

function pairsOf(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) out.push([arr[i], arr[j]]);
  }
  return out;
}

function pairKey(a, b) {
  return [a, b].sort().join('↔');
}

function dedupeIssues(issues) {
  const seen = new Set();
  const out = [];
  for (const issue of issues) {
    const key = issue.type + '|' + issue.terms.join('|') + '|' + issue.outputSentence;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

function cleanTerm(t) {
  return String(t || '')
    .replace(/\s+/g, ' ')
    .replace(/(은|는|이|가|을|를|와|과|도|만|부터|까지)$/g, '')
    .replace(/\s+(은|는|이|가|을|를|와|과)$/g, '')
    .trim();
}

module.exports = { analyzeFactRoleDrift };
