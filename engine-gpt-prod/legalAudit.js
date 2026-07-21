'use strict';

const OPERATORS = Object.freeze([
  ['permission', /(?:할|될)\s*수\s*있(?:다|습니다|음)/gu],
  ['impossibility', /(?:할|될)\s*수\s*없(?:다|습니다|음)/gu],
  ['obligation', /(?:하여야|해야)\s*(?:한다|합니다|함)|의무를\s*(?:진다|부담한다)/gu],
  ['prohibition', /(?:해서는|하여서는)\s*아니\s*된다|금지(?:한다|된다|함)|아니한다/gu],
  ['condition', /(?:경우에만|한\s*경우|조건으로|때에\s*한하여)/gu],
  ['exception', /(?:다만|제외한다|예외로|불구하고)/gu],
  ['termination', /(?:해지|해제)(?:할\s*수\s*있다|한다|된다|됨)/gu]
]);

function auditLegalIntegrity(source, output, documentProfile) {
  const profiles = new Set([
    String(documentProfile?.profile || documentProfile || ''),
    ...(documentProfile?.safetyProfiles || []).map(String)
  ]);
  if (!profiles.has('legal_contract')) return { applicable: false, pass: true, issueCodes: [] };
  const before = operatorHistogram(source);
  const after = operatorHistogram(output);
  const changedOperators = [];
  for (const [name] of OPERATORS) {
    if (before[name] !== after[name]) changedOperators.push({ name, before: before[name], after: after[name] });
  }
  const sourceArticles = articleSequence(source);
  const outputArticles = articleSequence(output);
  const articleOrderPass = sourceArticles.length === outputArticles.length
    && sourceArticles.every((value, index) => value === outputArticles[index]);
  const clauseIntegrity = compareArticleClauses(source, output);
  return {
    applicable: true,
    pass: changedOperators.length === 0 && articleOrderPass && clauseIntegrity.pass,
    issueCodes: [
      ...(changedOperators.length || !clauseIntegrity.pass ? ['legal_relation_shift'] : []),
      ...(!articleOrderPass ? ['legal_article_structure_changed'] : [])
    ],
    changedOperators,
    changedClauses: clauseIntegrity.changedClauses,
    sourceArticles,
    outputArticles,
    articleOrderPass
  };
}

function compareArticleClauses(source, output) {
  const before = articleBlocks(source);
  const after = articleBlocks(output);
  if (before.length !== after.length) {
    return { pass: false, changedClauses: [{ article: 'count', before: before.length, after: after.length }] };
  }
  const changedClauses = [];
  for (let index = 0; index < before.length; index += 1) {
    const sourceClause = before[index];
    const outputClause = after[index];
    if (sourceClause.article !== outputClause.article) continue;
    const sourceSignature = clauseSignature(sourceClause.text);
    const outputSignature = clauseSignature(outputClause.text);
    if (JSON.stringify(sourceSignature) !== JSON.stringify(outputSignature)) {
      changedClauses.push({
        article: sourceClause.article,
        changedFields: Object.keys(sourceSignature).filter(key =>
          JSON.stringify(sourceSignature[key]) !== JSON.stringify(outputSignature[key])
        )
      });
    }
  }
  return { pass: changedClauses.length === 0, changedClauses };
}

function operatorHistogram(value) {
  const text = String(value || '').normalize('NFKC');
  return Object.fromEntries(OPERATORS.map(([name, pattern]) => {
    pattern.lastIndex = 0;
    return [name, (text.match(pattern) || []).length];
  }));
}

function articleSequence(value) {
  return [...String(value || '').matchAll(/^\s*(제\s*\d{1,3}\s*조(?:의\s*\d{1,3})?)/gmu)]
    .map(match => match[1].replace(/\s+/gu, ''));
}

function articleBlocks(value) {
  const lines = String(value || '').split(/\r?\n/u);
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const match = line.match(/^\s*(제\s*\d{1,3}\s*조(?:의\s*\d{1,3})?)(?:\s|$|[（(])/u);
    if (match) {
      if (current) blocks.push(current);
      current = { article: match[1].replace(/\s+/gu, ''), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) blocks.push(current);
  return blocks.map(block => ({ article: block.article, text: block.lines.join('\n') }));
}

function clauseSignature(value) {
  const text = String(value || '')
    .normalize('NFKC')
    .replace(/^\s*제\s*\d{1,3}\s*조(?:의\s*\d{1,3})?(?:\s*\([^)]*\))?/u, '');
  return {
    operators: operatorHistogram(text),
    negationCount: (text.match(/(?:아니(?:하|된|된다|함)|않(?:다|는다|습니다|음)|없(?:다|습니다|음))/gu) || []).length,
    parties: tokenHistogram(text, /(?:갑|을|병|당사자|계약자|이용자|회사)/gu),
    boundedValues: [...text.matchAll(/(?<![가-힣A-Za-z0-9_])\d+(?:[.,]\d+)?\s*(?:년|월|일|일간|주|개월|년간|원|만원|%|퍼센트|회)(?=$|[^가-힣A-Za-z0-9_])/gu)]
      .map(match => match[0].replace(/\s+/gu, ''))
      .sort()
  };
}

function tokenHistogram(value, pattern) {
  const histogram = {};
  for (const match of String(value || '').matchAll(pattern)) {
    histogram[match[0]] = (histogram[match[0]] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(histogram).sort(([a], [b]) => a.localeCompare(b, 'ko')));
}

module.exports = {
  auditLegalIntegrity,
  operatorHistogram,
  articleSequence,
  articleBlocks,
  clauseSignature,
  compareArticleClauses
};
