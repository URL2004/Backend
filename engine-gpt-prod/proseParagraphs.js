'use strict';

const { splitSentences } = require('../engine/koreanText');

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
  if (/^(?:[-*+•▪◦·●○■□◆◇▶▷※]|\d{1,3}[.)]|[①-⑳]|[A-Za-z][.)])\s+/u.test(value)) return true;
  if (/^>\s*\S/u.test(value) || /^\|.+\|$/u.test(value) || /\t/u.test(value)) return true;
  if (/^#{1,6}\s+/u.test(value)) return true;
  if (/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)．]?\s*\S/u.test(value) && value.length <= 140) return true;
  if (/^제\s*\d{1,3}\s*(?:장|절|항)(?:\s|$)/u.test(value)) return true;
  if (/^\d{1,2}(?:\.\d{1,2}){0,3}\s*[.)]?\s+\S/u.test(value) && value.length <= 140) return true;
  if (/^["'“‘「『《〈].+["'”’」』》〉]$/u.test(value) && value.length <= 180) return true;
  return /^(?:참고\s*문헌|참고\s*자료|인용\s*문헌|References|Bibliography|Works\s+Cited)$/iu.test(value);
}

module.exports = {
  splitLogicalProseParagraphs,
  isStandaloneProseLineGroup
};
