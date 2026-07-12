'use strict';

function registerBlock(register) {
  if (register === 'polite') return '종결 기준: 원문의 ~습니다/~입니다 계열과 격식을 유지한다.';
  if (register === 'haeyo') return '종결 기준: 원문의 해요체와 친밀도를 유지한다.';
  if (register === 'plain') return '종결 기준: 원문의 평어체를 유지한다.';
  return '종결 기준: 원문에서 우세한 종결 흐름과 혼합 비율을 유지한다.';
}

module.exports = { registerBlock };
