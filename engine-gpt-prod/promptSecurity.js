'use strict';

const {
  createPromptEnvelope,
  promptEnvelopeSystemRule
} = require('./promptEnvelope');

const INTERNAL_PROMPT_PATTERNS = Object.freeze([
  /<<<(?:END_)?GPT_PROD_DATA:[A-Z0-9_]+:[a-f0-9]{16,64}>>>/iu,
  /\[GPT-PROD-[A-Z0-9_-]+\]/iu,
  /\[서비스\s*어댑터\s*규칙\]/u,
  /(?:재작성할\s*텍스트|작업\s*위치|앞\s*문맥\s*-\s*참고만|뒤\s*문맥\s*-\s*참고만)/u,
  /본문이다\.\s*이\s*청크만\s*(?:다듬는다|선택한\s*강도에\s*맞게\s*변환한다)/u,
  /(?:system|developer)\s*prompt\s*(?:is|:)/iu
]);

function appendPromptSecurityRule(systemText) {
  const system = String(systemText || '');
  const rule = promptEnvelopeSystemRule();
  return system.includes(rule) ? system : [system, rule].filter(Boolean).join('\n\n');
}

function envelopeUntrustedText(value, label = 'USER_INPUT', envelope = null) {
  const active = envelope || createPromptEnvelope();
  return { text: active.wrap(label, value), nonce: active.nonce, envelope: active };
}

function securePromptPair({ systemText = '', userText = '', label = 'USER_INPUT' } = {}) {
  const wrapped = envelopeUntrustedText(userText, label);
  return {
    systemText: appendPromptSecurityRule(systemText),
    userText: wrapped.text,
    nonce: wrapped.nonce
  };
}

function looksLikePromptLeak(value) {
  const text = String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '');
  return INTERNAL_PROMPT_PATTERNS.some(pattern => pattern.test(text));
}

function findPromptLeak(value, path = '$', seen = new Set()) {
  if (typeof value === 'string') return looksLikePromptLeak(value) ? path : '';
  if (!value || typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findPromptLeak(value[index], `${path}[${index}]`, seen);
      if (found) return found;
    }
    return '';
  }
  for (const [key, item] of Object.entries(value)) {
    const found = findPromptLeak(item, `${path}.${key}`, seen);
    if (found) return found;
  }
  return '';
}

function collectStringValues(value, out = [], seen = new Set()) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out, seen);
    return out;
  }
  for (const item of Object.values(value)) collectStringValues(item, out, seen);
  return out;
}

function assertNoPromptLeak(value) {
  let path = findPromptLeak(value);
  if (!path) {
    // Structured outputs can split one internal marker across summary/detail or
    // array entries. The UI may render those fields together, so evaluate the
    // aggregate in addition to every individual string.
    const fragments = collectStringValues(value);
    if (fragments.length > 1
        && (looksLikePromptLeak(fragments.join('')) || looksLikePromptLeak(fragments.join('\n')))) {
      path = '$.[aggregate]';
    }
  }
  if (!path) return value;
  const error = new Error('Model output contained an internal prompt instruction.');
  error.code = 'PROMPT_INSTRUCTION_LEAK';
  error.path = path;
  throw error;
}

module.exports = {
  INTERNAL_PROMPT_PATTERNS,
  appendPromptSecurityRule,
  assertNoPromptLeak,
  collectStringValues,
  envelopeUntrustedText,
  findPromptLeak,
  looksLikePromptLeak,
  securePromptPair
};
