'use strict';

// 줄바꿈 없이 붙여 넣은 긴 글에서, 문장 끝 뒤의 넓은 공백(3칸 이상)을 문단 경계로 되돌린다.
//
// 2026-10-11 운영 글: 1,714자가 한 줄로 들어왔고 문단 사이마다 공백이 3칸 있었다(22개 문장
// 경계 중 4곳). 엔진은 이 흔적을 쓰지 않고 한 덩어리를 새로 나눴고, "첫째로·둘째로"가 문단
// 중간에 묻히고 결론이 앞 문단에 붙었다. 문단 구분은 글쓴이가 남긴 흔적을 따른다.
//
// 넓은 공백이 버릇(모든 문장 뒤 두세 칸)인 글, 표처럼 탭이 있는 줄, 짧은 줄은 건드리지 않는다.

const MIN_LINE_CHARS = 400;
const MIN_SEGMENT_CHARS = 60;
const MIN_WIDE_GAPS = 2;
// 한글 종결 뒤의 문장부호(닫는 따옴표·괄호 포함) + 가로 공백 + 다음 글자.
const BOUNDARY_RE = /([가-힣][.!?…]["'”’)\]」』]?)([  　]+)(?=\S)/gu;

function gapWidth(run) {
  let width = 0;
  for (const char of run) width += char === '　' ? 2 : 1;
  return width;
}

function restoreLine(line) {
  if (line.length < MIN_LINE_CHARS || /[\t|]/u.test(line)) return null;
  const boundaries = [...line.matchAll(BOUNDARY_RE)];
  const wide = boundaries.filter(match => gapWidth(match[2]) >= 3);
  // 넓은 공백이 둘 이상이고, 보통 공백으로 이어진 문장 경계가 그보다 많거나 같아야 한다.
  if (wide.length < MIN_WIDE_GAPS || boundaries.length - wide.length < wide.length) return null;
  const segments = [];
  let cursor = 0;
  for (const match of wide) {
    const end = match.index + match[1].length;
    segments.push(line.slice(cursor, end));
    cursor = end + match[2].length;
  }
  segments.push(line.slice(cursor));
  if (segments.some(segment => segment.trim().length < MIN_SEGMENT_CHARS)) return null;
  // 줄 맨 앞의 들여쓰기는 글쓴이의 것이므로 그대로 둔다.
  const text = segments.map((segment, index) => (index === 0 ? segment.trimEnd() : segment.trim())).join('\n\n');
  return { text, restored: wide.length };
}

function restoreWideGapParagraphs(value) {
  const source = String(value ?? '');
  if (source.length < MIN_LINE_CHARS || !/[.!?…]["'”’)\]」』]?[  　]{2,}\S/u.test(source)) {
    return { text: source, restoredCount: 0 };
  }
  let restoredCount = 0;
  const lines = source.split('\n').map(line => {
    const restored = restoreLine(line);
    if (!restored) return line;
    restoredCount += restored.restored;
    return restored.text;
  });
  return restoredCount ? { text: lines.join('\n'), restoredCount } : { text: source, restoredCount: 0 };
}

module.exports = { restoreWideGapParagraphs };
