'use strict';
const { normalizeText } = require('../analysis/textStats');

const REPLACEMENTS = [
  [/진짜 목적이다/g, '목적이다'],
  [/진짜 목적/g, '목적'],
  [/그치지 않고/g, '또한'],
  [/무심코 남긴 글 한 줄이/g, 'SNS나 블로그에 쌓인 글이'],
  [/소비자가 SNS에 무심코 남긴 글 한 줄이/g, 'SNS나 블로그에 쌓이는 소비자 글이'],
  [/인간의 눈이 흘려보낼 불완전한 이미지조차/g, '정보가 부족한 이미지도'],
  [/딥 러닝 앞에서는/g, '딥 러닝에서는'],
  [/신원 확인의 단서가 된다/g, '식별 단서로 활용될 수 있다'],
  [/그 경계를 빠른 속도로 밀어붙이고 있다/g, '그 활용 범위를 넓혀가고 있다'],
  [/경계를 빠른 속도로 밀어붙이고 있다/g, '활용 범위를 넓혀가고 있다'],
  [/위력이 두드러진다/g, '활용도가 높다'],
  [/핵심 레버/g, '핵심 요인'],
  [/불가능에 가까워진다/g, '어려워진다'],
  [/곧장 번진다/g, '이어질 수 있다'],
  [/자리를 내줄 위험에 놓인다/g, '경쟁력이 약화될 수 있다'],
  [/대폭 단축했다/g, '줄였다'],
  [/확 줄였다/g, '줄였다']
];

function stripRhetoric(text) {
  let out = normalizeText(text);
  for (const [re, rep] of REPLACEMENTS) out = out.replace(re, rep);
  return out;
}

function repairOrphanConnectives(text) {
  let out = String(text || '');
  out = out.replace(/\.\s*(있으며|하고|하며|이며|이고|되는 한편|하는 한편),\s*/g, '. ');
  out = out.replace(/\.\s*(그리고|또한|하지만|다만),\s*/g, '. $1 ');
  out = out.replace(/\s+(있으며|하고|하며|이며),\s*반대로/g, ' 반면');
  return out;
}

function postprocessText(text) {
  return repairOrphanConnectives(stripRhetoric(text))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { stripRhetoric, repairOrphanConnectives, postprocessText };
