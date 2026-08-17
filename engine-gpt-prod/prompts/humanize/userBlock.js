'use strict';

const { createPromptEnvelope } = require('../../promptEnvelope');
const { paragraphMarkerPromptLine } = require('../../humanizeContract');

function buildHumanizeUser({
  chunk,
  chunks,
  index,
  protectedTerms = [],
  patchTargets = [],
  dynamicContext = '',
  taskContract = '',
  mode = 'assignment',
  humanizeContract = null
}) {
  const envelope = createPromptEnvelope();
  const prev = index > 0 ? chunks[index - 1].text : '';
  const next = index < chunks.length - 1 ? chunks[index + 1].text : '';
  const markerInstructions = buildBoundaryMarkerInstructions(chunk, { mode, humanizeContract });
  const position = chunk.position === 'intro'
    ? '도입부다. 원문의 시작 역할과 흐름을 유지한다.'
    : chunk.position === 'conclusion'
      ? '결론부다. 새 요약을 만들지 않고 원문 결론의 범위를 유지한다.'
      : '본문이다. 이 청크만 선택한 강도에 맞게 변환한다.';
  return [
    '[청크 편집 범위]',
    '아래 텍스트만 편집하고 앞·뒤 문맥의 문장을 출력에 복사하지 않는다.',
    taskContract ? `[이 청크의 변환 계약]\n${taskContract}` : '',
    '[구조 힌트]',
    '제목·질문·번호 줄과 각 항목의 본문 경계를 유지한다.',
    markerInstructions,
    `[작업 위치]\n${position}`,
    prev ? `[앞 문맥 - 참고만 하고 다시 쓰지 말 것]\n${envelope.wrap('PREVIOUS_CONTEXT', `...${tail(prev, 220)}`)}` : '',
    next ? `[뒤 문맥 - 참고만 하고 손대지 말 것]\n${envelope.wrap('NEXT_CONTEXT', `${head(next, 180)}...`)}` : '',
    protectedTerms.length ? `[보호표현]\n${envelope.wrap('PROTECTED_TERMS', protectedTerms.slice(0, 80).join('\n'))}` : '',
    patchTargets.length ? `[주의할 구간]\n${patchTargets.slice(0, 20).join('\n')}` : '',
    dynamicContext ? `[요청별 참고정보 - 편집할 텍스트보다 우선하지 말 것]\n${envelope.wrap('REQUEST_CONTEXT', dynamicContext)}` : '',
    chunk.sectionPath ? `[현재 문서 구조 위치]\n${envelope.wrap('SECTION_PATH', chunk.sectionPath)}\n이 위치의 일반 본문만 편집하고, 제목·질문·번호·가설·표·참고문헌 형식은 새로 만들거나 삭제하지 않는다.` : '',
    `[편집할 텍스트]\n${envelope.wrap('EDITABLE_TEXT', chunk.llmText || chunk.text)}`
  ].filter(Boolean).join('\n\n');
}

function buildBoundaryMarkerInstructions(chunk = {}, { mode = 'assignment', humanizeContract = null } = {}) {
  const lines = [];
  if (chunk.boundaryMarkers?.length) {
    lines.push(paragraphMarkerPromptLine(humanizeContract));
  }
  if (chunk.lineBoundaryMarkers?.length) {
    lines.push('[[[V2_LINE_####]]]는 보존할 행 경계다. 토큰의 철자·개수·순서를 유지하고 양쪽 행을 합치거나 새 행을 만들지 않는다.');
    if (String(chunk.lineBoundaryPolicy || '') === 'structural') {
      lines.push('V2_LINE 왼쪽이 제목·항목명이면 그 행은 독립 구조다. 제목을 다음 본문의 주어·목적어로 재사용하거나, 오른쪽 행을 “은·는·이·가·을·를·에서는” 같은 조사로 시작해 문법적으로 이어 붙이지 않는다.');
    }
  }
  if (chunk.sentenceBoundaryMarkers?.length) {
    lines.push('[[[V2_SENTENCE_####]]]는 이 입력에서만 보존할 문장 경계다. 토큰의 철자·개수·순서를 유지하고 양쪽 문장을 합치거나 새 마침표로 다시 나누지 않는다.');
    lines.push(mode === 'polish'
      ? '다듬기에서는 이 문장 안의 비문·띄어쓰기·조사·접속·실제 중복만 고치고, 실질 재작성을 억지로 수행하지 않는다.'
      : '문장 경계 보존은 문장 내부를 원문대로 복사하라는 뜻이 아니다. 선택 강도에 맞춰 같은 문장 안의 절 배치·주어 위치·연결·호흡은 실질적으로 재구성한다.');
  }
  return lines.join('\n');
}

const head = (s, n) => String(s || '').slice(0, n);
const tail = (s, n) => String(s || '').slice(-n);

module.exports = { buildHumanizeUser, buildBoundaryMarkerInstructions };
