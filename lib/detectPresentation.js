'use strict';

const POLISH_BAND = Object.freeze({ A: '30~55%', B: '60~85%', C: '85%+' });
const BLOG_BAND = Object.freeze({ A: '30~45%', B: '35~50%', C: '40~55%' });
const RESTRUCTURE_BAND = '35~60%';

const COPY = Object.freeze({
  A: Object.freeze({
    title: '구체적 정보가 풍부한 글이에요',
    desc: '실제 수치·사례·이름이 충분해서, 다듬기만으로도 탐지 위험이 낮은 편이에요.'
  }),
  B: Object.freeze({
    title: '추상과 구체가 섞인 글이에요',
    desc: '일부 문단이 일반론에 가까워요. AI 티 줄이기로 더 사람이 쓴 글에 가깝게 만들 수 있어요.'
  }),
  C: Object.freeze({
    title: '추상적 일반론 비중이 높은 글이에요',
    desc: '구체적 사례·수치가 적어, 그대로 제출하면 AI 탐지 위험이 높아요. 어떻게 할지 골라주세요.'
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
