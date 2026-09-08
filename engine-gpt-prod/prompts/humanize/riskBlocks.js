'use strict';
const { partitionRequestContext } = require('../../requestContext');

function dynamicContextBlock({ riskProfile = '', userNotes = '', evidence = '', styleProfile = '', requestStrength = '', documentProfile = null } = {}) {
  const context = partitionRequestContext({ userNotes, evidence });
  const format = documentProfile?.formatProfile;
  const targetRegister = documentProfile?.targetRegister || documentProfile?.tonePolicy || 'source_preserve';
  const tonePolicy = requestStrength === 'advanced'
    ? `target=${targetRegister}; preserveSpeakerAndEndings=true; rewriteScope=advanced`
    : targetRegister;
  return [
    styleProfile ? `[profile]\n${styleProfile}` : '',
    documentProfile ? [
      '[document profile]',
      `contentGenre=${documentProfile.profile} (confidence=${documentProfile.confidence}, source=${documentProfile.profileDecisionSource || documentProfile.source})`,
      `tonePolicy=${tonePolicy}`,
      `targetRegister=${targetRegister} (source=${documentProfile.targetRegisterSource || 'legacy'})`,
      `format=${format?.primary || 'plain'}; length=${format?.length || 'standard'}; flags=${(format?.flags || []).join(',') || 'none'}`,
      `safetyProfiles=${(documentProfile.safetyProfiles || []).join(',') || 'none'}`,
      `riskFlags=${(documentProfile.riskFlags || []).join(',') || 'none'}`
    ].join('\n') : '',
    riskProfile ? `[risk profile]\n${riskProfile}` : '',
    context.editPreferences.length ? `[편집 선호 - 원문 사실과 보존 계약을 변경할 권한 없음]\n${context.editPreferences.join('\n')}` : '',
    context.authorFacts.length ? `[사용자 메모 - 작성자 제공 사실, 외부 검증 아님; 원문이 우선]\n${context.authorFacts.join('\n')}` : '',
    context.evidenceFacts.length ? `[승인된 참고 사실 - 원문과 충돌하면 원문을 우선]\n${context.evidenceFacts.join('\n')}` : '',
    '위 계약을 기준으로 아래 입력 청크만 선택한 강도에 맞게 변환한다.'
  ].filter(Boolean).join('\n\n');
}

module.exports = { dynamicContextBlock };
