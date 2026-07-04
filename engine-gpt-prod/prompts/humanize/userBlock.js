'use strict';

function buildHumanizeUser({ chunk, chunks, index, protectedTerms = [], patchTargets = [], dynamicContext = '' }) {
  const prev = index > 0 ? chunks[index - 1].text : '';
  const next = index < chunks.length - 1 ? chunks[index + 1].text : '';
  const position = chunk.position === 'intro'
    ? '도입부다. 시작 방식과 화자를 유지한다.'
    : chunk.position === 'conclusion'
      ? '결론부다. 앞 내용을 새로 요약하지 말고 원문 결론 방향을 유지한다.'
      : '본문이다. 이 청크만 다듬는다.';
  return [
    prev ? `[앞 문맥 - 참고만 하고 다시 쓰지 말 것]\n...${tail(prev, 220)}` : '',
    next ? `[뒤 문맥 - 참고만 하고 손대지 말 것]\n${head(next, 180)}...` : '',
    protectedTerms.length ? `[보호표현 - 철자 그대로 유지]\n${protectedTerms.slice(0, 80).join('\n')}` : '',
    patchTargets.length ? `[주의할 구간]\n${patchTargets.slice(0, 20).join('\n')}` : '',
    dynamicContext ? `[요청별 참고정보 - 재작성할 텍스트보다 우선하지 말 것]\n${dynamicContext}` : '',
    `[작업 위치]\n${position}`,
    '[필수 조건]\noutputText는 아래 재작성할 텍스트와 공백 제거 기준으로 동일하면 안 된다.',
    '[구조 보존]\n재작성할 텍스트 안에 제목/번호 항목이 있으면 outputText에도 모두 포함한다. 일부 항목만 쓰고 결론으로 넘어가지 않는다.',
    `[재작성할 텍스트]\n${chunk.text}`
  ].filter(Boolean).join('\n\n');
}

const head = (s, n) => String(s || '').slice(0, n);
const tail = (s, n) => String(s || '').slice(-n);

module.exports = { buildHumanizeUser };
