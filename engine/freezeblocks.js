// [engine/freezeblocks.js] 학술 논문의 '재작성 금지' 블록(참고문헌·목차) 동결 — 인용 날조·절번호 붕괴 방지.
// ────────────────────────────────────────────────────────────────
// 왜(2026-06-19 실측 #43 한남대 소논문): 청크-충실(구조보존) 재작성조차 참고문헌 저자명을
//   "신춘성, 이영호, 윤효석. (2020)." → "신춘성부터 윤효석까지. (2020)."로 의역(저자 목록 날조 = 학술 부정),
//   목차 절번호 "3.1." → "3."로 붕괴시켰다. 참고문헌·목차는 '문장'이 아니라 '데이터'라 윤문 대상이 아니다.
// 해법: 참고문헌(꼬리)·목차(상단 블록)를 본문에서 떼어 verbatim 보존하고 본문만 우회한 뒤, 원래 순서
//   (front=제목/제출자 → 목차 → 본문 → 참고문헌)로 재조립한다. 플레이스홀더 대신 split 방식(meta_leak 오탐·
//   토큰 훼손 위험 0, 순서 보존). SMILES·각주 박제와 같은 '동결' 철학.

// ★ heading 정규화(2026-06-19 실측 #18: "[참고자료]" 처럼 괄호로 감싼 변형이 분리되지 않아 참고문헌이 통째 누락).
//   대괄호·꺾쇠·【】 어떤 조합이든, 끝에 콜론(:：)이 붙든, 일괄 허용한다(괄호 변형마다 패턴을 따로 두던 누락 제거).
// ★ 번호·(option) 머리 허용(2026-06-20 #66: "4.\t(option) 참고문헌"이 미인식돼 참고문헌 "조푸른솔…2025,14-32" 손실).
//   "N. " 번호 목록 머리 + "(option)" 같은 접두를 헤딩 앞에 허용.
const REF_HEADING = /(^|\n)[ \t]*(?:[-–—][ \t]*)?(?:\d+[.)][ \t]*)?(?:\(\s*option\s*\)[ \t]*)?[<【\[**]*\s*(?:참고\s*문헌|참고\s*자료|인용\s*문헌|참고\s*및\s*인용\s*자료|참고\s*및\s*인용\s*문헌|References|REFERENCES|Bibliography|Works\s+Cited)\s*[>】\]**]*[ \t]*[:：]?[ \t]*(?:\n|$)/;
const TOC_HEADING = /(^|\n)[ \t]*(?:[-–—][ \t]*)?(?:\d+[.)][ \t]*)?[<【\[**]*\s*(?:목\s*차|차\s*례|Contents|CONTENTS)\s*[>】\]**]*[ \t]*[:：]?[ \t]*(?:\n|$)/;

// 참고문헌 한 줄 entry: "저자명. (연도). 제목…" — 줄머리에 (선택)번호 + 이름 + 근방 (YYYY).
const CITE_LINE = /^(?:\d+[.)]\s*)?[가-힣A-Za-z][^\n]{0,60}\(\s*(?:19|20)\d{2}[a-z]?\s*\)/;
const APPENDIX_HEADING_LINE = /^\s*(?:(?:제\s*\d+\s*)?부록|Appendix)(?:\s+[A-Z0-9가-힣.-]+)?\s*(?::.*)?$/iu;

// 참고문헌 블록 시작 char index 탐지. ① 후반부 heading 기반 ② heading 없는 꼬리 인용런(≥3줄 연속). 없으면 -1.
function detectRefStart(work) {
  const refM = work.match(REF_HEADING);
  if (refM && refM.index > work.length * 0.4) return refM.index + (refM[1] ? refM[1].length : 0);
  // heading 없는 꼬리 인용런: 끝에서부터 인용패턴 줄이 연속되는 시작점(빈 줄은 건너뜀).
  const lines = work.split('\n');
  let i = lines.length - 1, cite = 0, firstCite = -1;
  while (i >= 0) {
    const ln = lines[i].trim();
    if (!ln) { i--; continue; }
    if (CITE_LINE.test(ln)) { cite++; firstCite = i; i--; }
    else break;
  }
  if (cite >= 3 && firstCite > 0) {
    const charIdx = lines.slice(0, firstCite).join('\n').length + 1;   // firstCite 줄 시작 위치
    if (charIdx > work.length * 0.4) return charIdx;
  }
  return -1;
}

function detectAcademicSpans(text) {
  const source = String(text || '');
  const lines = lineRecords(source);
  const spans = [];
  let tocSpan = null;

  const tocHeadingIndex = lines.findIndex(line => isTocHeadingLine(line.text) && line.start < source.length * 0.5);
  if (tocHeadingIndex >= 0) {
    let entries = 0;
    let sawBlankAfterEntries = false;
    const seenEntries = new Set();
    let end = lines[tocHeadingIndex].endWithNewline;
    for (let i = tocHeadingIndex + 1; i < lines.length; i += 1) {
      const raw = lines[i].text;
      const trimmed = raw.trim();
      if (!trimmed) {
        if (entries >= 2) sawBlankAfterEntries = true;
        end = lines[i].endWithNewline;
        continue;
      }
      if (isProseLine(trimmed)) break;
      const tocLike = isTocEntryLine(trimmed) || isTocSubentryLine(trimmed);
      const entryKey = normalizeTocEntry(trimmed);
      // 목차와 본문 사이 빈 줄 뒤의 첫 표제, 또는 목차에서 이미 본 표제가
      // 다시 나타나면 그 지점부터 실제 본문이다. 중첩된 무번호 목차 항목은
      // 짧은 명사구인 동안 계속 목차에 포함한다.
      if (entries >= 2 && (
        (sawBlankAfterEntries && isBodyHeadingLine(trimmed))
        || (entryKey && seenEntries.has(entryKey))
      )) break;
      if (!tocLike) break;
      entries += 1;
      if (entryKey) seenEntries.add(entryKey);
      end = lines[i].endWithNewline;
    }
    if (entries >= 2) {
      tocSpan = { type: 'toc', start: lines[tocHeadingIndex].start, end };
      spans.push(tocSpan);
    }
  }

  const refHeadingCandidates = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!isRefHeadingLine(lines[i].text)) continue;
    // 목차의 `4. 참고문헌`은 목차 항목이지 참고문헌 블록의 시작이 아니다.
    // 같은 행을 두 상태 머신이 동시에 소비하면 서론부터 문서 끝까지가
    // reference_item으로 잠기는 치명적인 오탐이 생긴다.
    if (tocSpan && lines[i].start >= tocSpan.start && lines[i].end <= tocSpan.end) continue;
    refHeadingCandidates.push(i);
  }
  // 문서에 참고문헌 표제가 둘 이상 남아 있으면 실제 목록에 가장 가까운
  // 마지막 독립 표제를 선택한다. 앞쪽의 보고서 개요·샘플 목차 표제를
  // 본문 시작으로 오인하지 않게 하는 보조 안전장치다.
  const refHeadingIndex = refHeadingCandidates.at(-1) ?? -1;
  if (refHeadingIndex >= 0) {
    let end = source.length;
    for (let i = refHeadingIndex + 1; i < lines.length; i += 1) {
      if (APPENDIX_HEADING_LINE.test(lines[i].text.trim())) {
        end = lines[i].start;
        break;
      }
    }
    spans.push({ type: 'references', start: lines[refHeadingIndex].start, end });
  } else {
    const citationRun = detectTrailingCitationRun(lines, source.length);
    if (citationRun) spans.push(citationRun);
  }
  return spans.sort((a, b) => a.start - b.start);
}

function academicSpanAt(spans, start, end) {
  return (spans || []).find(span => start >= span.start && end <= span.end) || null;
}

function tocEntryKeys(text, spans = null) {
  const source = String(text || '');
  const academicSpans = Array.isArray(spans) ? spans : detectAcademicSpans(source);
  const keys = new Set();
  for (const span of academicSpans) {
    if (span?.type !== 'toc') continue;
    for (const line of lineRecords(source.slice(span.start, span.end))) {
      const value = line.text.trim();
      if (!value || isTocHeadingLine(value)) continue;
      const key = normalizeTocEntry(value);
      if (key.length >= 2 && key.length <= 180) keys.add(key);
    }
  }
  return keys;
}

function lineRecords(source) {
  const out = [];
  let start = 0;
  for (let i = 0; i <= source.length; i += 1) {
    if (i < source.length && source[i] !== '\n') continue;
    const rawEnd = i > start && source[i - 1] === '\r' ? i - 1 : i;
    out.push({ text: source.slice(start, rawEnd), start, end: rawEnd, endWithNewline: i < source.length ? i + 1 : i });
    start = i + 1;
  }
  return out;
}

function isTocHeadingLine(value) {
  return /^(?:\s*(?:[-–—]\s*)?(?:\d+[.)]\s*)?[<【\[]*\s*)?(?:목\s*차|차\s*례|Contents|Table\s+of\s+Contents)\s*[>】\]]*\s*[:：]?\s*$/iu.test(String(value || ''));
}

function isRefHeadingLine(value) {
  return /^(?:\s*(?:[-–—]\s*)?(?:\d+[.)]\s*)?(?:\(\s*option\s*\)\s*)?[<【\[]*\s*)?(?:참고\s*문헌|참고\s*자료|인용\s*문헌|참고\s*및\s*인용\s*자료|References|Bibliography|Works\s+Cited)\s*[>】\]]*\s*[:：]?\s*$/iu.test(String(value || ''));
}

function isTocEntryLine(value) {
  const s = String(value || '').trim();
  if (!s || s.length > 180) return false;
  if (/^(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)]?|[IVX]{1,8}[.)．]|제\s*\d+\s*(?:장|절|항)|\d+(?:\.\d+){0,4}[.)]?|[가-힣][.)])\s*\S/u.test(s)) return true;
  return /\.{2,}\s*\d+\s*$/u.test(s);
}

function isTocSubentryLine(value) {
  const s = String(value || '').trim();
  if (!s || s.length > 180) return false;
  if (/[.!?。！？]\s*[”’"'」』》〉)\]]*$/u.test(s)) return false;
  if (/(?:다|요|니다|한다|된다|있다|없다|않다|했다|하였다|되었다)$/u.test(s)) return false;
  return s.split(/\s+/u).filter(Boolean).length <= 18;
}

function normalizeTocEntry(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\.{2,}\s*\d+\s*$/u, '')
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

function isBodyHeadingLine(value) {
  return /^(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)]?\s*|[IVX]{1,8}[.)．]\s*|제\s*\d+\s*(?:장|절|항)\s*|\d+(?:\.\d+){0,3}[.)]?\s+)(?:서론|본론|결론|초록|연구|분석|논의|시사점|\S)/u.test(String(value || '').trim());
}

function isProseLine(value) {
  const s = String(value || '').trim();
  return s.length >= 70 && /(?:다|요|니다|한다|된다)[.!?。！？]?$/u.test(s);
}

function detectTrailingCitationRun(lines, sourceLength) {
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].text.trim()) last -= 1;
  if (last < 0) return null;
  let first = last;
  let citations = 0;
  for (let i = last; i >= 0; i -= 1) {
    const s = lines[i].text.trim();
    if (!s) continue;
    if (APPENDIX_HEADING_LINE.test(s)) break;
    if (CITE_LINE.test(s) || (/(?:19|20)\d{2}/u.test(s) && /(?:doi|https?:\/\/|학술지|출판사)/iu.test(s))) {
      citations += 1;
      first = i;
      continue;
    }
    break;
  }
  if (citations < 3 || lines[first].start <= sourceLength * 0.4) return null;
  return { type: 'references', start: lines[first].start, end: sourceLength };
}

// text → { front, toc, body, refs, hasFrozen }. body만 우회 대상, 나머지는 verbatim.
function splitAcademicBlocks(text) {
  let work = String(text || '');
  let refs = '', toc = '', front = '';

  // ① 참고문헌: 후반부 heading 또는 꼬리 인용런 이후 전부 = refs.
  const refAt = detectRefStart(work);
  if (refAt >= 0) {
    refs = work.slice(refAt).trim();
    work = work.slice(0, refAt);
  }

  // ② 목차: 글 전반(50% 이전)의 목차 heading + 그 뒤 한 문단(다음 빈 줄 전까지). front = 목차 앞(제목·제출자).
  const tocM = work.match(TOC_HEADING);
  if (tocM && tocM.index < work.length * 0.5) {
    const start = tocM.index + (tocM[1] ? tocM[1].length : 0);
    const headingEnd = start + (tocM[0].length - (tocM[1] ? tocM[1].length : 0));
    const nextBlank = work.indexOf('\n\n', headingEnd);
    const end = nextBlank === -1 ? headingEnd : nextBlank;
    front = work.slice(0, start).trim();
    toc = work.slice(start, end).trim();
    work = work.slice(end);
  }

  const body = work.trim();
  // 본문이 너무 짧으면(동결 후 우회할 게 거의 없음) 동결 취소 — 통째로 우회.
  if (body.replace(/\s+/g, '').length < 200) {
    return { front: '', toc: '', body: String(text || '').trim(), refs: '', hasFrozen: false };
  }
  return { front, toc, body, refs, hasFrozen: !!(refs || toc) };
}

// 동결 블록 + 우회된 본문을 원래 순서로 재조립.
function reassembleAcademic(parts, humanizedBody) {
  return [parts.front, parts.toc, humanizedBody, parts.refs]
    .map(s => (s || '').trim()).filter(Boolean).join('\n\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

// ★ 본문 인라인 인용의 '다저자 목록' 박제(2026-06-19 #43: 본문에 박힌 전체 인용을 청크 재작성이
//   "신춘성, 이영호, 윤효석. (2020)" → "신춘성부터 윤효석까지. (2020)"로 의역=인용 날조). 2명+ 저자 목록 +
//   (연도)를 토큰으로 묶어 보존 후 복원. 단일저자("홍진철. (2023)")는 의역할 목록이 없어 제외. 토큰은 ⟨REF⟩
//   (⟦⟧ 아님 → meta_leak 오탐 없음). 본문 split 후 적용.
const MULTI_AUTHOR_CITE = /[가-힣]{2,4}(?:\s*,\s*[가-힣]{2,4}){1,6}\.\s*\(\s*(?:19|20)\d{2}[a-z]?\s*\)/g;
function protectInlineCites(text) {
  const map = [];
  const out = String(text || '').replace(MULTI_AUTHOR_CITE, (m) => { const tok = `⟨REF${map.length}⟩`; map.push([tok, m]); return tok; });
  return { text: out, count: map.length, restore: (s) => { let r = String(s || ''); for (const [tok, v] of map) r = r.split(tok).join(v); return r; }, tokens: map.map(x => x[0]) };
}

module.exports = {
  splitAcademicBlocks,
  reassembleAcademic,
  protectInlineCites,
  detectAcademicSpans,
  academicSpanAt,
  tocEntryKeys,
  REF_HEADING,
  TOC_HEADING,
  APPENDIX_HEADING_LINE
};
