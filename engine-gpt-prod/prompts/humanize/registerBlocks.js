'use strict';

function registerBlock(register) {
  if (register === 'polite') return '문체 통일: 글 전체를 ~습니다/~입니다 계열로 유지한다. ~다체나 해요체와 섞지 않는다.';
  if (register === 'haeyo') return '문체 통일: 글 전체를 해요체로 유지한다. 합니다체나 평어체로 문단이 바뀌지 않게 한다.';
  if (register === 'plain') return '문체 통일: 글 전체를 평어체로 유지한다. 존댓말로 바꾸거나 섞지 않는다.';
  return '문체 통일: 원문에서 우세한 종결체를 따르고, 문단마다 말투가 바뀌지 않게 한다.';
}

module.exports = { registerBlock };
