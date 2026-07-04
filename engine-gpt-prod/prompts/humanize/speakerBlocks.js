'use strict';

function speakerBlock(speakerType) {
  if (speakerType === 'organization') return '화자는 조직/업체/팀이다. 개인 1인칭을 새로 만들지 않는다.';
  if (speakerType === 'impersonal') return '원문은 비인칭 설명문이다. 저/제가/우리 같은 화자를 새로 넣지 않는다.';
  return '원문에 개인 1인칭이 있으면 유지하되, 원문에 없는 경험이나 감정은 추가하지 않는다.';
}

module.exports = { speakerBlock };
