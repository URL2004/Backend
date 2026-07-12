'use strict';

function dynamicContextBlock({ riskProfile = '', userNotes = '', evidence = '', styleProfile = '', documentProfile = null } = {}) {
  const format = documentProfile?.formatProfile;
  return [
    styleProfile ? `[profile]\n${styleProfile}` : '',
    documentProfile ? [
      '[document profile]',
      `contentGenre=${documentProfile.profile} (confidence=${documentProfile.confidence}, source=${documentProfile.profileDecisionSource || documentProfile.source})`,
      `tonePolicy=${documentProfile.tonePolicy || 'source_preserve'}`,
      `format=${format?.primary || 'plain'}; length=${format?.length || 'standard'}; flags=${(format?.flags || []).join(',') || 'none'}`,
      `safetyProfiles=${(documentProfile.safetyProfiles || []).join(',') || 'none'}`,
      `riskFlags=${(documentProfile.riskFlags || []).join(',') || 'none'}`
    ].join('\n') : '',
    riskProfile ? `[risk profile]\n${riskProfile}` : '',
    userNotes ? `[사용자 메모 - 원문보다 우선하지 말 것]\n${userNotes}` : '',
    evidence ? `[승인된 참고 사실 - 원문과 충돌하면 원문을 우선]\n${evidence}` : '',
    '위 계약을 기준으로 아래 입력 청크만 다듬는다.'
  ].filter(Boolean).join('\n\n');
}

module.exports = { dynamicContextBlock };
