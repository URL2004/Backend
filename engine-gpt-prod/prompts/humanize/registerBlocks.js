'use strict';

function registerBlock(register) {
  if (register === 'polite') return '종결 기준: 원문은 ~습니다/~입니다 계열이다. 같은 격식 안에서 문장 표면을 재서술한다.';
  if (register === 'haeyo') return '종결 기준: 원문은 해요체다. 캐주얼한 흐름 안에서 문장 표면을 재서술한다.';
  if (register === 'plain') return '종결 기준: 원문은 평어체다. 평어체 흐름 안에서 문장 표면을 재서술한다.';
  return '종결 기준: 원문에서 우세한 종결 흐름을 참고하되, 문장 표면은 충분히 재서술한다.';
}

module.exports = { registerBlock };
