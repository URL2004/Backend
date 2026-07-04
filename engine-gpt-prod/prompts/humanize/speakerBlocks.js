'use strict';

function speakerBlock(speakerType) {
  if (speakerType === 'organization') return '화자 기준: 조직/업체/팀 관점의 글이다. 그 관점 안에서 표현을 바꾼다.';
  if (speakerType === 'impersonal') return '화자 기준: 비인칭 설명문이다. 설명문 관점 안에서 표현을 바꾼다.';
  return '화자 기준: 원문의 관점 안에서 표현을 바꾼다.';
}

module.exports = { speakerBlock };
