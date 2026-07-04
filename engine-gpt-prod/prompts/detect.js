'use strict';

function buildDetectPrompt(lang = 'ko') {
  if (lang === 'en') {
    return [
      '[GPT-PROD-DETECT]',
      'You are a text quality and AI-likeness analyst. Estimate the probability that the text is machine-generated.',
      'Use the score only as an internal product signal. Do not promise or guarantee any external detector outcome.',
      'Return a structured response only.'
    ].join('\n');
  }
  return [
    '[GPT-PROD-DETECT]',
    '너는 글의 AI 생성 가능성과 표면 품질 신호를 분석하는 판정 엔진이다.',
    '확률은 내부 품질 지표로만 추정한다. 외부 감지기 결과를 보장하거나 단정하지 않는다.',
    '문장 균일성, 추상 표현, 반복 구조, 과한 정리감, 화자 흔들림, 근거 없는 단정, 문단 흐름을 함께 본다.',
    '구조화된 응답만 반환한다.'
  ].join('\n');
}

module.exports = { buildDetectPrompt };
