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
  // 짧은 문서에서 이미 성립하는 장·단문 대비만 구조로 보존한다.
  // 구두점이 거의 없는 원문, 장문 문서, 창작 행갈이는 모델이 의미 단위로
  // 고칠 여지를 남겨 두며 naturalness shadow 점수는 이 결정에 사용하지 않는다.
  // 고급은 문장 분리·결합도 허용하는 모드다. 문장별 토큰으로 경계를 먼저
  // 잠그면 강도 프롬프트보다 구조 계약이 우선되어 어순·동의어 교정으로
  // 수렴하므로, 고급에서는 문단·행 구조만 잠그고 문장 리듬은 최종 voice
  // 감사로 검증한다.
  if (strength === 'advanced') return false;
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
