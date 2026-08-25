'use strict';

const crypto = require('crypto');
const { GENRES, normalizeGenre, normalizeSubtype } = require('./genres');

const ANSWER_MAX = 4000;

function cleanText(value, max = ANSWER_MAX) {
  return String(value == null ? '' : value)
    .normalize('NFC')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\t\f\v]+/gu, ' ')
    .trim()
    .slice(0, max);
}

function normalizeMode(value) {
  return ['with_space', 'no_space', 'byte2'].includes(String(value || '')) ? String(value) : 'with_space';
}

function normalizeTone(value) {
  return ['formal', 'friendly'].includes(String(value || '')) ? String(value) : '';
}

function normalizeInput(body = {}) {
  const genre = normalizeGenre(body.genre);
  const subtype = normalizeSubtype(genre, body.subtype);
  const schema = GENRES[genre];
  const rawAnswers = body.answers && typeof body.answers === 'object' ? body.answers : legacyAnswers(genre, body);
  const answers = {};
  for (const spec of schema.fields) {
    const value = cleanText(rawAnswers[spec.key], spec.maxLength);
    if (spec.type === 'select' && Array.isArray(spec.options)) {
      const allowed = new Set(spec.options.map(option => Array.isArray(option) ? String(option[0]) : String(option.value || '')));
      answers[spec.key] = allowed.has(value) ? value : '';
    } else {
      answers[spec.key] = value;
    }
  }
  const rawTarget = Number(body.targetChars);
  const targetChars = Number.isFinite(rawTarget) && rawTarget > 0
    ? Math.max(60, Math.min(3000, Math.round(rawTarget)))
    : 0;
  return {
    version: 'writing-input-v1',
    genre,
    subtype,
    answers,
    targetChars,
    charLimitMode: normalizeMode(body.charLimitMode),
    tone: normalizeTone(body.tone),
    humanizeMode: body.humanizeMode === 'skip' ? 'skip' : 'auto',
    emphasis: cleanText(body.emphasis, 300)
  };
}

function legacyAnswers(genre, body) {
  const memo = body.memo && typeof body.memo === 'object' ? body.memo : {};
  if (genre === 'resume') return {
    prompt: body.topic || body.question,
    company: body.context1 || body.company,
    role: body.context2 || body.role,
    situation: memo.experience,
    personalActions: memo.caseExample,
    result: memo.numbers,
    learning: memo.thoughts
  };
  if (genre === 'review_blog') return {
    subject: body.topic || body.question,
    observations: memo.experience,
    items: memo.caseExample,
    spending: memo.numbers,
    impressions: memo.thoughts
  };
  if (genre === 'marketing') return {
    product: body.context1 || body.topic,
    audience: body.context2,
    features: memo.experience,
    process: memo.caseExample,
    evidence: memo.numbers,
    problem: memo.thoughts
  };
  return {
    purpose: body.topic || body.question,
    audience: body.context2,
    keyMessage: memo.experience,
    mustInclude: memo.caseExample,
    dateTime: memo.numbers,
    stance: memo.thoughts
  };
}

function buildLedger(inputBody = {}) {
  const input = inputBody.version === 'writing-input-v1' ? inputBody : normalizeInput(inputBody);
  const genre = GENRES[input.genre];
  const facts = [];
  for (const spec of genre.fields) {
    const rawValue = cleanText(input.answers[spec.key], spec.maxLength);
    if (!rawValue) continue;
    const selectOption = spec.type === 'select' && Array.isArray(spec.options)
      ? spec.options.find(option => String(Array.isArray(option) ? option[0] : option.value) === rawValue)
      : null;
    const value = selectOption ? String(Array.isArray(selectOption) ? selectOption[1] : selectOption.label) : rawValue;
    facts.push({
      id: `F${String(facts.length + 1).padStart(2, '0')}`,
      field: spec.key,
      label: spec.label,
      kind: inferKind(spec.key, spec.categories, value),
      categories: [...spec.categories],
      value,
      ...(selectOption ? { enumValue: rawValue } : {}),
      source: 'user_confirmed',
      certainty: 'confirmed',
      importance: spec.importance
    });
  }
  const ledger = {
    schemaVersion: 'writing-ledger-v1',
    genre: input.genre,
    subtype: input.subtype,
    facts,
    opinions: facts.filter(item => item.categories.includes('evaluation') || item.categories.includes('stance')).map(item => item.id),
    constraints: facts.filter(item => item.categories.includes('constraint')).map(item => item.id),
    goal: {
      targetChars: input.targetChars,
      charLimitMode: input.charLimitMode,
      tone: input.tone,
      emphasis: input.emphasis
    }
  };
  return { input, ledger: { ...ledger, hash: ledgerHash(ledger) } };
}

function inferKind(key, categories, value) {
  if (key === 'spending' || key === 'pricing' || /(?:원|만원|억원|가격|비용|결제)/u.test(value)) return 'money_or_terms';
  if (key === 'dateTime' || key === 'timing' || key === 'deadline' || /\d{1,4}\s*(?:년|월|일|시|분)/u.test(value)) return 'date_or_time';
  if (categories.includes('evaluation') || categories.includes('stance') || categories.includes('reflection')) return 'opinion';
  if (categories.includes('action')) return 'action';
  if (categories.includes('source') || categories.includes('evidence')) return 'evidence';
  return 'fact';
}

function ledgerHash(ledger) {
  return crypto.createHash('sha256').update(stableStringify(ledger)).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function factsheet(ledger, factIds = null) {
  const allowed = factIds ? new Set(factIds) : null;
  return (ledger?.facts || [])
    .filter(fact => !allowed || allowed.has(fact.id))
    .map(fact => `[${fact.id}][${fact.label}] ${fact.value}`)
    .join('\n');
}

module.exports = { ANSWER_MAX, cleanText, normalizeInput, buildLedger, ledgerHash, stableStringify, factsheet };
