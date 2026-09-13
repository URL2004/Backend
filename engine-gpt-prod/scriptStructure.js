'use strict';
// 낭독/방송 대본은 제작 지시와 짧은 발화가 섞인다. 낱말 하나가 아니라
// 반복 큐 + 기술 트랙 + 독립 무대 지시의 결합으로만 판정한다.
const SPOKEN_CUE = /^(?:나레이션|내레이션|대사|해설|NARRATION)(?:\s*[:：]|\s*[-—–]\s*[^.!?\n]{1,45})?$/iu;
const TECHNICAL_CUE = /^(?:소리|음향|효과음|영상|화면|조명|SFX|BGM)(?:\s*[:：]|\s*[-—–]\s*[^.!?\n]{1,45})?$/iu;
function detectScriptStructure(value) {
  const lines = String(value || '').split(/\r?\n/);
  let fence = null, spoken = 0, technical = 0, directions = 0;
  const cueIndices = [];
  lines.forEach((line, index) => {
    const text = line.trim(), mark = text.match(/^(`{3,}|~{3,})/);
    if (mark) { if (!fence) fence = mark[1][0]; else if (mark[1][0] === fence) fence = null; return; }
    if (fence) return;
    if (SPOKEN_CUE.test(text)) { spoken++; cueIndices.push(index); }
    if (TECHNICAL_CUE.test(text)) { technical++; cueIndices.push(index); }
    if (/^[（(][^()（）\n]{2,70}[）)]$/u.test(text)) directions++;
  });
  const isScript = spoken >= 2 && technical >= 2 && directions >= 2;
  return { isScript, cueIndices: isScript ? cueIndices : [], spoken, technical, directions };
}
module.exports = { detectScriptStructure };
