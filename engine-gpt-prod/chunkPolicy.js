'use strict';

function shouldPassThrough(value) {
  const compact = String(value || '').replace(/\s+/g, '');
  return compact.length < 50 && !/[.!?…다요죠함임음까]$/.test(compact);
}

function shouldCallModel(chunk, mode = 'assignment') {
  if (!chunk || chunk.locked) return false;
  return mode === 'polish' || !shouldPassThrough(chunk.text);
}

function shouldPreserveVoiceSentenceBoundaries(source, voiceProfile, mode = '') {
  const sentence = voiceProfile?.sentence || {};
  const count = Number(sentence.count) || 0;
  const cv = Number(sentence.cv) || 0;
  const compactLength = String(source || '').replace(/\s+/gu, '').length;
  // 짧은 문서에서 이미 성립하는 장·단문 대비만 구조로 보존한다.
  // 구두점이 거의 없는 원문, 장문 문서, 창작 행갈이는 모델이 의미 단위로
  // 고칠 여지를 남겨 두며 naturalness shadow 점수는 이 결정에 사용하지 않는다.
  const minimumCount = mode === 'polish' ? 3 : 4;
  const maximumCount = mode === 'polish' ? 12 : 20;
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
