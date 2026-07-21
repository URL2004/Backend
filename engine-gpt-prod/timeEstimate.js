'use strict';

const { detectDocumentProfile, applyDocumentProfileOverride } = require('./documentProfile');
const { buildVoiceProfile } = require('./voiceProfile');
const { splitChunksForGpt } = require('./structureChunk');
const { shouldCallModel, shouldPreserveVoiceSentenceBoundaries } = require('./chunkPolicy');

const VERSION = 2;
const BASIS = 'v2_chunk_wave_semantic_recovery_range';
const EVIDENCE_EXTRA_SEC = 8 * 60;
const FIVE_MINUTES_SEC = 5 * 60;

/**
 * 고급 휴머나이징은 편집 가능한 청크를 순차 처리하고 마지막에 문서 감사를
 * 수행한다. 글자 수 하나로 완료 시각을 단정하지 않고, 실제 실행 계획에서
 * 모델을 호출할 청크 수와 편집 분량을 이용해 보수적인 범위를 만든다.
 *
 * 이 값은 SLA가 아니라 사용자 안내용 범위다. 재시도·상위 모델 승격·OpenAI
 * 응답 시간에 따라 범위를 벗어날 수 있으므로 완료 시각을 보장하지 않는다.
 */
function estimateAdvancedTime(source, {
  evidence = false,
  basicStyle = 'report',
  documentProfileOverride = ''
} = {}) {
  const text = String(source || '').trim();
  const sourceBareLength = bareLength(text);
  const detected = detectDocumentProfile(text, { basicStyle });
  const documentProfile = applyDocumentProfileOverride(detected, documentProfileOverride);
  const voiceProfile = buildVoiceProfile(text, { documentProfile, mode: 'assignment' });
  const lineBoundaryPolicy = String(voiceProfile?.lineBoundaryPolicy || 'none');
  const plan = splitChunksForGpt(text, {
    coalesceEditable: true,
    preserveSentenceBoundaries: shouldPreserveVoiceSentenceBoundaries(text, voiceProfile, 'assignment'),
    sentenceBoundaryMinimum: 4,
    preserveLineBoundaries: lineBoundaryPolicy,
    formatProfile: documentProfile.formatProfile
  });
  const editableChunks = plan.chunks.filter(chunk => shouldCallModel(chunk, 'assignment'));
  const editableBareLength = editableChunks.reduce((total, chunk) => total + bareLength(chunk.text), 0);
  const editableKilochars = Math.ceil(editableBareLength / 1000);
  const chunkConcurrency = Math.max(1, Math.min(3, Number(process.env.HUMANIZE_CHUNK_CONCURRENCY || 2) || 2));
  const chunkWaveCount = Math.ceil(editableChunks.length / chunkConcurrency);
  const recoveryWaveCount = sourceBareLength >= 2000
    ? Math.ceil(Math.min(8, editableChunks.length) / 3)
    : 0;

  // 하한은 정상 1차 호출, 상한은 느린 호출과 일부 재시도·승격을 포함한다.
  // 문서 전체 의미 감사의 고정 비용은 각각 3분·6분으로 잡는다.
  const evidenceExtra = evidence ? EVIDENCE_EXTRA_SEC : 0;
  const rawLowSec = (3 * 60) + (chunkWaveCount * 30) + (editableKilochars * 10)
    + (recoveryWaveCount ? recoveryWaveCount * 20 : 0) + evidenceExtra;
  const rawHighSec = (6 * 60) + (chunkWaveCount * 95) + (editableKilochars * 20)
    + (recoveryWaveCount * 70) + evidenceExtra;
  const lowSec = roundUpFiveMinutes(clamp(rawLowSec, 4 * 60, 75 * 60));
  const highFloor = Math.max(rawHighSec, lowSec + FIVE_MINUTES_SEC);
  const highSec = roundUpFiveMinutes(clamp(highFloor, 8 * 60, 90 * 60));

  return {
    version: VERSION,
    basis: BASIS,
    lowSec,
    highSec,
    evidenceIncluded: evidence === true,
    sourceBareLength,
    editableBareLength,
    editableChunkCount: editableChunks.length,
    totalChunkCount: plan.chunks.length,
    chunkConcurrency,
    chunkWaveCount,
    recoveryWaveCount
  };
}

function bareLength(value) {
  return String(value || '').replace(/\s+/gu, '').length;
}

function roundUpFiveMinutes(seconds) {
  return Math.ceil(Number(seconds || 0) / FIVE_MINUTES_SEC) * FIVE_MINUTES_SEC;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

module.exports = {
  VERSION,
  BASIS,
  EVIDENCE_EXTRA_SEC,
  estimateAdvancedTime
};
