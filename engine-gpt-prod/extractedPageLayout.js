'use strict';

// Repair only a positively identified, sequential paginated export. Ordinary
// lists, creative line breaks, tables and code are not evidence of PDF damage.
const PAGE_RE = /^[ \t]*[-–—][ \t]*(\d{1,4})[ \t]*[-–—](?:[ \t]+|$)/u;
const SECTION = '(?:[IVX]{1,8}|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+|\\d{1,2})[.)．]';
const REFERENCE_RE = new RegExp(`^\\s*(?:${SECTION}\\s*)?(?:참고\\s*문헌|참고\\s*자료|References|Bibliography)(?=\\s|$)`, 'iu');
const SECTION_RE = new RegExp(`^\\s*${SECTION}\\s*`, 'u');
const HEADING_END = /(?:서론|본론|결론|개선\s*방안|원인|고려\s*사항|영향\s*분석|분석\s*결과|연구\s*목적|연구\s*방법|시사점)$/u;
const URL_RE = /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|doi\s*:\s*[^\s<>"']+/giu;

function repairExtractedPageLayout(value) {
  const before = String(value || '');
  const lines = before.split('\n');
  const pages = [];
  let fence = null;
  lines.forEach((line, index) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/u);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (fence === marker[1][0]) fence = null;
      return;
    }
    if (fence) return;
    const match = line.match(PAGE_RE);
    if (match) pages.push({ index, number: Number(match[1]), prefix: match[0] });
  });
  const sequential = pages.length >= 3 && pages.every((p, i) => !i || p.number === pages[i - 1].number + 1);
  const proseLines = lines.filter(line => line.length > 160 && (line.match(/[가-힣]\s*\./gu) || []).length >= 2);
  const reportEvidence = /(?:[IVXⅠⅡⅢⅣ]+[.)．]\s*(?:서론|본론|결론)|참고\s*문헌)/u.test(before);
  const pageBodies = pages.map(page => lines[page.index].slice(page.prefix.length));
  const coverEvidence = pageBodies[0]?.length < 240
    && /(?:이름|성명)\s+\S+[\s\S]*학번\s+\d/u.test(pageBodies[0]);
  const headingPages = pageBodies.filter(body => SECTION_RE.test(body)).length;
  const standalonePages = pageBodies.filter(body => !body.trim()).length;
  if (!sequential || proseLines.length < 2 || !reportEvidence
      || (!coverEvidence && headingPages < 2 && standalonePages < 2)) {
    return { text: before, changed: false, removedPages: [], changes: [] };
  }

  const pageMap = new Map(pages.map(p => [p.index, p]));
  const changes = [];
  const withoutPages = lines.map((line, i) => pageMap.has(i) ? line.slice(pageMap.get(i).prefix.length) : line);
  const witnessedWords = new Set((withoutPages.join('\n').match(/[가-힣]{2,}/gu) || []));
  let inReference = false;
  fence = null;
  const normalized = withoutPages.map((line, index) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/u);
    if (marker) {
      if (!fence) fence = marker[1][0]; else if (fence === marker[1][0]) fence = null;
      return line;
    }
    if (fence || /\t|\|/u.test(line) || /^\s*>/u.test(line)) return line;
    if (index === pages[0].index && line.length < 240
        && /(?:이름|성명)\s+\S+[\s\S]*학번\s+\d/u.test(line)) {
      return line.replace(/(?<=\S)[ \t]+(?=(?:이름|성명)\s)/u, '\n\n');
    }
    if (REFERENCE_RE.test(line)) {
      inReference = true;
      // Separate the heading, but keep every reference entry and URL literal.
      const m = line.match(REFERENCE_RE);
      return m && line.slice(m[0].length).trim()
        ? `${m[0].trim()}\n\n${line.slice(m[0].length).trimStart()}` : line;
    }
    if (inReference) return line;
    if (line.length < 160 || (line.match(/[가-힣]\s*\./gu) || []).length < 2) return line;
    const denseGaps = (line.match(/ {3,}/gu) || []).length;
    let next = outsideLiterals(line, part => {
      // Two spaces can also separate legitimate words. Join only a complete
      // word witnessed elsewhere, never from gap width alone.
      if (denseGaps >= 30) part = part.replace(/([가-힣]+) {2}([가-힣]+)/gu,
        (match, left, right) => witnessedWords.has(left + right) ? left + right : match);
      return part.replace(/ {2,}/gu, ' ').replace(/(?<=[가-힣]) +(?=[.,])/gu, '');
    });
    if (next !== line) changes.push(change('source_pdf_spacing_repaired', index + 1,
      '페이지 추출 본문의 반복 공백과 명확한 어절 분절을 정리했어요.'));
    return next;
  });

  // A page break is not a paragraph break. Join a split word only when that
  // complete word occurs elsewhere in this very document; never invent it.
  const corpus = normalized.join('\n');
  for (const page of pages.slice(1)) {
    const right = normalized[page.index].trimStart();
    let previous = page.index - 1;
    while (previous >= 0 && !normalized[previous].trim()) previous -= 1;
    if (previous < 0 || !right || SECTION_RE.test(right) || REFERENCE_RE.test(right)
        || /^[-*+•▪◦]|\t|\|/u.test(right)) continue;
    const left = normalized[previous].trimEnd();
    if (/\t|\|/u.test(left) || /^\s*>/u.test(left) || endsInsideQuote(left)) continue;
    const tail = left.match(/([가-힣]{1,8})$/u);
    const head = right.match(/^([가-힣]{1,8})(?=\s|[.,])/u);
    if (!tail || !head) continue;
    const joined = tail[1] + head[1];
    const witnessed = joined.length >= 3 && joined.length <= 12
      && new RegExp(`(?:^|\\s)${joined}(?:은|는|이|가|을|를|의|과|와|에|으로|적)?(?=\\s|[.,]|$)`, 'u').test(corpus);
    if (!witnessed) {
      changes.push(change('source_pdf_boundary_review', page.index + 1,
        '페이지 경계의 끊긴 문장은 원문 확인이 필요해요. 어절을 임의로 합치지 않았어요.', 'notice'));
      continue;
    }
    normalized[previous] = left + right;
    for (let i = previous + 1; i <= page.index; i += 1) normalized[i] = '';
    changes.push(change('source_pdf_page_word_joined', page.index + 1,
      '같은 문서에서 확인되는 어절을 기준으로 페이지 사이에서 끊긴 단어를 이었어요.'));
  }
  let text = normalized.join('\n');
  // Restore only explicit headings and bullet markers already present in a
  // fused export. This never creates, renames or reorders an outline.
  for (let pass = 0; pass < 3; pass += 1) {
    const next = restoreExtractedBlockBoundaries(text);
    if (next === text) break;
    text = next;
  }
  if (text !== normalized.join('\n')) changes.push(change('source_pdf_blocks_repaired', 1,
    '페이지 본문에 붙어 있던 기존 제목과 목록의 줄 경계를 복원했어요.'));
  const expected = withoutPages.join('\n').replace(/\s/gu, '');
  if (text.replace(/\s/gu, '') !== expected) {
    return { text: before, changed: false, removedPages: [], changes: [] };
  }
  return { text, changed: text !== before, removedPages: pages.map(p => p.index + 1), changes };
}

function restoreExtractedBlockBoundaries(value) {
  let inReference = false;
  let fence = null;
  return String(value || '').split('\n').map(line => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/u);
    if (marker) { if (!fence) fence = marker[1][0]; else if (fence === marker[1][0]) fence = null; return line; }
    if (REFERENCE_RE.test(line)) inReference = true;
    if (inReference || fence || /\t|\|/u.test(line) || /^\s*>/u.test(line)) return line;
    let next = outsideLiterals(line, part => part
      .replace(new RegExp(`([가-힣][.!?])[ \\t]+(?=${SECTION}\\s+[가-힣])`, 'gu'), '$1\n\n')
      .replace(/([가-힣][.!?])[ \t]+(?=-\s+[가-힣][^.!?\n]{1,40}[:：])/gu, '$1\n'));
    return next.split('\n').map(piece => {
      const m = piece.match(SECTION_RE);
      if (!m) return piece;
      const body = piece.slice(m[0].length);
      const parenthetical = body.match(/^([^.!?()\n]{1,70}\([^()\n]{1,90}\))[ \t]+(.+)$/u);
      if (parenthetical && hasProse(parenthetical[2])) return `${m[0]}${parenthetical[1]}\n\n${parenthetical[2]}`;
      for (const gap of body.matchAll(/ +/gu)) {
        const heading = body.slice(0, gap.index);
        const prose = body.slice(gap.index + gap[0].length);
        if (heading.length <= 65 && HEADING_END.test(heading) && hasProse(prose)) return `${m[0]}${heading}\n\n${prose}`;
      }
      return piece;
    }).join('\n');
  }).join('\n');
}

function hasProse(value) { return String(value).length >= 35 && /[가-힣][.!?]/u.test(value); }
function endsInsideQuote(value) {
  const pairs = { '“': '”', '‘': '’', '「': '」', '"': '"' };
  const stack = [];
  for (const char of value) {
    if (char === stack.at(-1)) stack.pop();
    else if (pairs[char]) stack.push(pairs[char]);
  }
  return stack.length > 0;
}
function outsideLiterals(value, transform) {
  // Preserve direct quotations and literal addresses during whitespace repair.
  const protectedRe = new RegExp(`(${URL_RE.source}|“[^”\\n]*”|"[^"\\n]*"|‘[^’\\n]*’|「[^」\\n]*」)`, 'giu');
  return String(value).split(protectedRe).map((part, i) => i % 2 ? part : transform(part)).join('');
}
function change(code, lineOrdinal, message, action = 'repaired') { return { code, lineOrdinal, message, action }; }
module.exports = { repairExtractedPageLayout };
