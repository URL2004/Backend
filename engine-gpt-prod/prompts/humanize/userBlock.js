'use strict';

function buildHumanizeUser({ chunk, chunks, index, protectedTerms = [], patchTargets = [], dynamicContext = '', mode = 'assignment' }) {
  const prev = index > 0 ? chunks[index - 1].text : '';
  const next = index < chunks.length - 1 ? chunks[index + 1].text : '';
  const markerInstructions = buildBoundaryMarkerInstructions(chunk);
  const position = chunk.position === 'intro'
    ? '도입부다. 원문의 시작 역할과 흐름을 유지한다.'
    : chunk.position === 'conclusion'
      ? '결론부다. 새 요약을 만들지 않고 원문 결론의 범위를 유지한다.'
      : '본문이다. 이 청크만 선택한 강도에 맞게 변환한다.';
  return [
    '[청크 편집 범위]',
    '아래 텍스트만 편집하고 앞·뒤 문맥의 문장을 출력에 복사하지 않는다.',
    '[구조 힌트]',
    '제목·질문·번호 줄과 각 항목의 본문 경계를 유지한다.',
    markerInstructions,
    `[작업 위치]\n${position}`,
    prev ? `[앞 문맥 - 참고만 하고 다시 쓰지 말 것]\n...${tail(prev, 220)}` : '',
    next ? `[뒤 문맥 - 참고만 하고 손대지 말 것]\n${head(next, 180)}...` : '',
    protectedTerms.length ? `[보호표현]\n${protectedTerms.slice(0, 80).join('\n')}` : '',
    patchTargets.length ? `[주의할 구간]\n${patchTargets.slice(0, 20).join('\n')}` : '',
    dynamicContext ? `[요청별 참고정보 - 편집할 텍스트보다 우선하지 말 것]\n${dynamicContext}` : '',
    chunk.sectionPath ? `[현재 문서 구조 위치]\n${chunk.sectionPath}\n이 위치의 일반 본문만 편집하고, 제목·질문·번호·가설·표·참고문헌 형식은 새로 만들거나 삭제하지 않는다.` : '',
    `[편집할 텍스트]\n${chunk.llmText || chunk.text}`
  ].filter(Boolean).join('\n\n');
}

function buildBoundaryMarkerInstructions(chunk = {}) {
  const lines = [];
  if (chunk.boundaryMarkers?.length) {
    lines.push('[[[V2_BOUNDARY_###]]]는 원문 문단 경계다. 토큰의 철자·개수·순서를 유지하고 서로 다른 문단을 합치거나 내용을 옮기지 않는다.');
  }
  if (chunk.lineBoundaryMarkers?.length) {
    lines.push('[[[V2_LINE_####]]]는 보존할 행 경계다. 토큰의 철자·개수·순서를 유지하고 양쪽 행을 합치거나 새 행을 만들지 않는다.');
  }
  if (chunk.sentenceBoundaryMarkers?.length) {
    lines.push('[[[V2_SENTENCE_####]]]는 이 입력에서만 보존할 문장 경계다. 토큰의 철자·개수·순서를 유지하고 양쪽 문장을 합치거나 새 마침표로 다시 나누지 않는다.');
    lines.push('문장 경계 보존은 문장 내부를 원문대로 복사하라는 뜻이 아니다. 선택 강도에 맞춰 같은 문장 안의 절 배치·주어 위치·연결·호흡은 실질적으로 재구성한다.');
  }
  return lines.join('\n');
}

const head = (s, n) => String(s || '').slice(0, n);
const tail = (s, n) => String(s || '').slice(-n);

module.exports = { buildHumanizeUser, buildBoundaryMarkerInstructions };
