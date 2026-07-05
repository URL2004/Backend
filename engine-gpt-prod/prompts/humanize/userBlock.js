'use strict';

function buildHumanizeUser({ chunk, chunks, index, protectedTerms = [], patchTargets = [], dynamicContext = '' }) {
  const prev = index > 0 ? chunks[index - 1].text : '';
  const next = index < chunks.length - 1 ? chunks[index + 1].text : '';
  const position = chunk.position === 'intro'
    ? '도입부다. 시작 흐름을 살리되 문장 표면은 재서술한다.'
    : chunk.position === 'conclusion'
      ? '결론부다. 새 요약을 만들기보다 원문 결론 흐름 안에서 재서술한다.'
      : '본문이다. 이 청크만 다듬는다.';
  return [
    prev ? `[앞 문맥 - 참고만 하고 다시 쓰지 말 것]\n...${tail(prev, 220)}` : '',
    next ? `[뒤 문맥 - 참고만 하고 손대지 말 것]\n${head(next, 180)}...` : '',
    protectedTerms.length ? `[보호표현]\n${protectedTerms.slice(0, 80).join('\n')}` : '',
    patchTargets.length ? `[주의할 구간]\n${patchTargets.slice(0, 20).join('\n')}` : '',
    dynamicContext ? `[요청별 참고정보 - 재작성할 텍스트보다 우선하지 말 것]\n${dynamicContext}` : '',
    chunk.sectionPath ? `[현재 문서 구조 위치]\n${chunk.sectionPath}\n이 위치의 일반 본문만 재서술하고, 제목/번호/가설/표/참고문헌 형식은 새로 만들거나 삭제하지 않는다.` : '',
    `[작업 위치]\n${position}`,
    '[필수 조건]\noutputText는 아래 재작성할 텍스트와 공백 제거 기준으로 동일하면 안 된다.',
    '[변화량 조건]\n제목/번호/고유명사/수치/참고문헌은 보존하되, 일반 본문 문장은 원문 문장틀을 그대로 반복하지 않는다. changedSentenceRatio는 보통 0.45 이상이 되도록 한다.',
    '[구조 힌트]\n제목/번호 줄이 있으면 그 줄은 남기고, 각 항목의 본문 안에서 표현과 연결 방식을 재서술한다.',
    `[재작성할 텍스트]\n${chunk.text}`
  ].filter(Boolean).join('\n\n');
}

const head = (s, n) => String(s || '').slice(0, n);
const tail = (s, n) => String(s || '').slice(-n);

module.exports = { buildHumanizeUser };
