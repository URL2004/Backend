'use strict';

function shouldPassThrough(value) {
  const compact = String(value || '').replace(/\s+/g, '');
  return compact.length < 50 && !/[.!?…다요죠함임음까]$/.test(compact);
}

function shouldCallModel(chunk, mode = 'assignment') {
  if (!chunk || chunk.locked) return false;
  return mode === 'polish' || !shouldPassThrough(chunk.text);
}

function shouldPreserveVoiceSentenceBoundaries(source, voiceProfile, mode = '', requestStrength = '') {
  const sentence = voiceProfile?.sentence || {};
  const count = Number(sentence.count) || 0;
  const cv = Number(sentence.cv) || 0;
  const compactLength = String(source || '').replace(/\s+/gu, '').length;
  const strength = String(requestStrength || '').trim().toLowerCase();
  // 정확한 문장 경계 잠금은 문장 분리·결합을 허용하지 않는 다듬기에만 쓴다.
  // 기본도 프롬프트에서 제한적 문장 경계 조정을 허용하는데, 과거에는 짧고
  // 리듬이 다양한 글에 V2_SENTENCE 토큰을 넣어 반대 지시를 동시에 전달했다.
  // 그 충돌은 결과를 어순·동의어 교정 수준으로 수렴시켰다. 기본·고급은
  // 문단·행 역할을 잠그고 최종 voice 감사로 장단문 분포를 검증한다.
  if (mode !== 'polish' && strength !== 'polish') return false;
  const minimumCount = 3;
  const maximumCount = 12;
  return voiceProfile?.lineBreakSensitive !== true
    && compactLength <= 1500
    && count >= minimumCount
    && count <= maximumCount
    && cv >= 0.28;
}

module.exports = {
  shouldPassThrough,
  shouldCallModel,
  shouldPreserveVoiceSentenceBoundaries
};
