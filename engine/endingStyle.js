'use strict';

// 종결체 판정의 단일 기준. 문서·문장·shadow 분석기가 서로 다른 정규식을
// 사용하면 ‘주요·수요·필요·개요’의 명사 끝 ‘요’를 해요체로 세거나,
// 같은 결과를 단계마다 다른 문체로 판정할 수 있다.

function detectRegister(value) {
  const text = String(value || '').replace(/\r\n?/gu, '\n');
  const END = `(?=(?:[.!?…。！？]+["”'’」』)\\]]*\\s*|["”'’」』)\\]]*(?:\\n|$)))`;
  const polite = matchCount(text, new RegExp(`(?:니다|니까)${END}`, 'gmu'));
  const haeyo = matchCount(text, new RegExp(
    `(?:어요|아요|해요|돼요|예요|이에요|네요|죠|지요|군요|나요|거든요|잖아요)${END}`,
    'gmu'
  ));
  const plain = matchCount(text, new RegExp(
    `(?<![니요])(?:이?다|한다|된다|않다|없다|있다|었다|였다|진다|간다|난다|온다|본다|했다|됐다)${END}`,
    'gmu'
  ));
  const honorific = polite + haeyo;
  if (plain + honorific === 0) return 'unknown';
  if (plain >= honorific * 1.5) return 'plain';
  if (honorific >= plain * 1.5) return haeyo >= polite ? 'haeyo' : 'polite';
  return 'mixed';
}

function classifySentenceEnding(value, { includeNominal = true } = {}) {
  const text = String(value || '')
    .replace(/[.!?…。！？"'”’」』】)\]]+$/gu, '')
    .trim();
  if (!text) return 'unknown';
  if (includeNominal && /(?:함|됨|임|음)$/u.test(text)) return 'nominal';
  const register = detectRegister(text);
  return ['plain', 'polite', 'haeyo'].includes(register) ? register : 'unknown';
}

function endingHistogram(sentences, { includeNominal = true } = {}) {
  const out = { plain: 0, polite: 0, haeyo: 0, nominal: 0, other: 0 };
  for (const sentence of sentences || []) {
    const style = classifySentenceEnding(sentence, { includeNominal });
    out[style === 'unknown' ? 'other' : style] += 1;
  }
  return out;
}

function matchCount(value, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return (String(value || '').match(new RegExp(pattern.source, flags)) || []).length;
}

module.exports = {
  detectRegister,
  classifySentenceEnding,
  endingHistogram
};
