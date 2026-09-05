'use strict';

const POLISH_BAND = Object.freeze({ A: '30~55%', B: '60~85%', C: '85%+' });
const BLOG_BAND = Object.freeze({ A: '30~45%', B: '35~50%', C: '40~55%' });
const RESTRUCTURE_BAND = '35~60%';

const COPY = Object.freeze({
  A: Object.freeze({
    title: '구체적 정보가 풍부한 글이에요',
    desc: '구체적인 수치·사례·이름이 있어요. 내용은 유지하고 문체에서 다듬을 부분을 확인해 보세요.'
  }),
  B: Object.freeze({
    title: '추상과 구체가 섞인 글이에요',
    desc: '일부 문단이 일반론에 가까워요. AI 티 줄이기로 더 사람이 쓴 글에 가깝게 만들 수 있어요.'
  }),
  C: Object.freeze({
    title: '추상적 일반론 비중이 높은 글이에요',
    desc: '일반적인 설명이 많아요. 원문에 있는 구체적인 근거를 연결하고 반복되는 표현을 확인해 보세요.'
  })
});

const BANDS = Object.freeze({ POLISH_BAND, BLOG_BAND, RESTRUCTURE_BAND });

module.exports = {
  POLISH_BAND,
  BLOG_BAND,
  RESTRUCTURE_BAND,
  BANDS,
  COPY
};
