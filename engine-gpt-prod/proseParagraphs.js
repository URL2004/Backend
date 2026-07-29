'use strict';

const { splitSentences } = require('../engine/koreanText');
const layoutStructure = require('./layoutStructure');

// 입력창·CSV에서 문단 사이의 빈 줄이 소실돼도, 완결된 긴 산문 행은 원래의
// 논리 문단으로 취급한다. 반대로 화면 폭 때문에 문장 중간에서 감긴 행, 시,
// 목록, 표, 제목은 여기서 새 문단으로 추정하지 않는다.
function splitLogicalProseParagraphs(value) {
  const blocks = String(value || '')
    .replace(/\r\n?/gu, '\n')
    .split(/\n[ \t]*\n+/u)
    .map(block => block.trim())
    .filter(Boolean);
  const result = [];
  for (const block of blocks) {
    const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
    if (isStandaloneProseLineGroup(lines)) result.push(...lines);
    else result.push(block);
  }
  return result;
}

function isStandaloneProseLineGroup(lines) {
  if (!Array.isArray(lines) || lines.length < 2) return false;
  return lines.every(line => {
    if (isStructuralLine(line)) return false;
    const substantiveLength = String(line || '').replace(/[\p{P}\p{S}\s]/gu, '').length;
    if (substantiveLength < 40) return false;
    const sentences = splitSentences(line).filter(sentence => String(sentence || '').trim());
    return /[.!?…。！？]["'”’」』】)\]]*$/u.test(line) || sentences.length >= 2;
  });
}

function isStructuralLine(line) {
  const value = String(line || '').trim();
  if (!value) return true;
  const role = layoutStructure.classifyLine(value);
  if (layoutStructure.isStructuralRole(role)) return true;
  // 영문 선택지(A. / B.)는 공통 목록 판정기가 한국어 장·절 번호와
  // 구분하기 위해 다루지 않으므로 이 보조 표지만 남긴다.
  if (/^[A-Za-z][.)]\s+\S/u.test(value)) return true;
  return /^(?:참고\s*문헌|참고\s*자료|인용\s*문헌|References|Bibliography|Works\s+Cited)$/iu.test(value);
}

module.exports = {
  splitLogicalProseParagraphs,
  isStandaloneProseLineGroup
};
