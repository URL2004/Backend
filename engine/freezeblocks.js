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
const REF_HEADING = /(^|\n)[ \t]*(?:[-–—][ \t]*)?(?:\d+[.)][ \t]*)?(?:\(\s*option\s*\)[ \t]*)?[<【\[**]*\s*(?:참고\s*문헌|참고\s*자료|인용\s*문헌|참고\s*및\s*인용\s*자료|참고\s*및\s*인용\s*문헌|출처|References|REFERENCES|Bibliography|Works\s+Cited)\s*[>】\]**]*[ \t]*[:：]?[ \t]*(?:\n|$)/;
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
    if (!isRefHeadingCandidateLine(lines[i].text)) continue;
    // 목차의 `4. 참고문헌`은 목차 항목이지 참고문헌 블록의 시작이 아니다.
    // 같은 행을 두 상태 머신이 동시에 소비하면 서론부터 문서 끝까지가
    // reference_item으로 잠기는 치명적인 오탐이 생긴다.
    if (tocSpan && lines[i].start >= tocSpan.start && lines[i].end <= tocSpan.end) continue;
    refHeadingCandidates.push(i);
  }
  // 표제 모양만으로 참고문헌 시작을 정하지 않는다(2026-10-09 점검 F-02).
  //   ① `목차` 표제 없는 목차 안의 `참고문헌` 한 줄에서 문서 끝까지(12,669자 중 98%)가 잠겨
  //      같은 글이 12번 연속 "변환할 본문 없음"으로 막혔다.
  //   ② 문서 중간 참고문헌 4줄 뒤의 본문 절(문서의 29~37%)이 reference_item으로 잠겨 그대로 전달됐다.
  // 각 후보 뒤를 실제로 읽어 서지가 뒤따르는 후보만 인정하고, 본문이 다시 시작하는 줄에서 구간을 끝낸다.
  // 인정된 후보가 여럿이면 종전처럼 마지막 것을 쓴다. 다만 확실한 서지가 뒤따른 구간을 서지 없는
  // 꼬리 표제로 바꾸지는 않는다. 앞 구간 안에 놓인 표제는 그 구간의 소제목이다.
  let referenceSpan = null;
  let referenceSpanHasEntries = false;
  let coveredUntilLine = -1;
  for (const index of refHeadingCandidates) {
    if (index < coveredUntilLine) continue;
    const block = measureReferenceBlock(lines, index, source.length);
    if (!block.valid) continue;
    coveredUntilLine = block.endLine;
    if (referenceSpanHasEntries && !block.hasEntries) continue;
    referenceSpan = { type: 'references', start: lines[index].start, end: block.end };
    referenceSpanHasEntries = block.hasEntries;
  }
  if (referenceSpan) {
    spans.push(referenceSpan);
  } else {
    const citationRun = detectTrailingCitationRun(lines, source.length);
    if (citationRun) spans.push(citationRun);
  }
  return spans.sort((a, b) => a.start - b.start);
}

function academicSpanAt(spans, start, end) {
  return (spans || []).find(span => start >= span.start && end <= span.end) || null;
}

// 줄마다(text.split('\n') 순서) 참고문헌 구간 안인지 알려 준다. isRefHeadingLine 한 줄만 보고 "그 뒤는 전부
// 참고문헌"으로 치는 줄 단위 상태 머신이 구간 탐지와 같은 판정을 쓸 수 있게 내보낸다.
function referenceLineFlags(text, spans = null) {
  const source = String(text || '');
  const academicSpans = Array.isArray(spans) ? spans : detectAcademicSpans(source);
  const reference = academicSpans.find(span => span?.type === 'references') || null;
  return lineRecords(source).map(line => Boolean(reference && line.start >= reference.start && line.start < reference.end));
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
  const text = String(value || '').replace(/^\s*(?:[IVX]{1,8}|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+)[.)．]\s*/u, '');
  return /^(?:\s*(?:[-–—]\s*)?(?:\d+[.)]\s*)?(?:\(\s*option\s*\)\s*)?[<【\[]*\s*)?(?:참고\s*문헌|참고\s*자료|인용\s*문헌|참고\s*및\s*인용\s*자료|참고\s*및\s*인용\s*문헌|출처|References|Bibliography|Works\s+Cited)\s*[>】\]]*\s*[:：]?\s*$/iu.test(text);
}

function isAppendixHeadingLine(value) {
  return /^(?:\s*(?:[-–—]\s*)?(?:\d+[.)]\s*)?[<【\[]*\s*)?(?:부록|Appendix)(?:\s+[A-Za-z0-9가-힣.-]+)?\s*[>】\]]*\s*[:：]?\s*$/iu
    .test(String(value || ''));
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

// Markdown 표제(`## 참고문헌`)와 굵은 표제(`**참고문헌**`)도 같은 참고문헌 표제다. 구간 탐지에서만 받아들이고
// 다른 모듈이 쓰는 isRefHeadingLine의 판정은 바꾸지 않는다.
function isRefHeadingCandidateLine(value) {
  const text = String(value || '');
  if (isRefHeadingLine(text)) return true;
  const bare = text
    .replace(/^\s*#{1,6}[ \t]+/u, '').replace(/[ \t]+#+[ \t]*$/u, '')
    .replace(/^\s*(\*\*|__)\s*(.*?)\s*\1\s*$/u, '$2');
  return bare !== text && isRefHeadingLine(bare);
}

// ── 참고문헌 구간의 끝 찾기 ─────────────────────────────────────────────────────
// 줄 하나를 서지(strong·weak)·산문(prose)·미정(other)으로 나눈다.
//   strong: 서지 항목이 확실한 줄. 산문 문장이 섞여 있어도 서지로 본다(제목이 문장인 문헌).
//   prose : 완결된 한국어 문장이 있는 줄. 본문이 다시 시작했다는 유일한 증거로 쓴다.
//   weak  : 연도·URL·서명 괄호처럼 서지 흔적만 있는 줄. 구간 안에 남기되 단독으로는 표제를 인정하지 않는다.
//   other : 짧은 소제목·이어지는 줄 조각. 앞뒤 줄을 보고 정한다.
// 판정이 틀렸을 때의 비용이 다르다. 서지를 본문으로 보면 모델이 문헌 정보를 고쳐 쓸 수 있고(이 파일이
// 막으려는 사고), 본문 한두 줄을 서지로 보면 그 줄이 원문 그대로 남을 뿐이다. 애매하면 잠그는 쪽으로 둔다.
const REFERENCE_YEAR = '(?:1[5-9]|20)\\d{2}';
const KOREAN_SENTENCE_END = /[가-힣](?:다[.!?。！？]|(?:[어아여에예해세네지나까래데군든]요|죠|시오)[.!?。！？]|까[?？])["'”’」』)\]]*(?:\s|$)/u;
const AUTHOR_YEAR_HEAD = new RegExp(`\\(\\s*${REFERENCE_YEAR}[a-z]?\\s*(?:[,.]\\s*[^()]{0,24})?\\)\\s*[.,:：]`, 'u');
const REFERENCE_TAIL = new RegExp([
  // "…, 학지사, 2024." · "…", 2026. 3. 16." — 쉼표·마침표 뒤의 연도(날짜)로 끝난다.
  `[,.]\\s*${REFERENCE_YEAR}(?:\\s*[.년]\\s*\\d{1,2}\\s*[.월](?:\\s*\\d{1,2}\\s*[.일]?)?)?\\s*\\.?$`,
  // "…, 45-68." · "pp. 12-30" · "…, 45쪽."
  '(?:[,:]\\s*|pp?\\.\\s*)\\d+\\s*[-–~]\\s*\\d+\\s*(?:쪽|면)?\\.?$',
  '\\d+\\s*(?:쪽|면)\\.?$',
  // "… 가상신문 (2034. 3. 1.)" — 연도 괄호로 끝난다.
  `\\(\\s*${REFERENCE_YEAR}[^()]{0,16}\\)\\s*\\.?$`
].join('|'), 'iu');
const REFERENCE_TRACE = new RegExp([
  `(?<!\\d)${REFERENCE_YEAR}(?!\\d)`,
  'https?:\\/\\/|www\\.|\\bdoi\\b',
  '[『「《〈]',
  'pp?\\.\\s*\\d|\\d+\\(\\d+\\)',
  '출판|학회|학술지|연구원|연구소|대학교|검색일|확인일|접속일|열람일',
  '\\b(?:Press|Journal|University|Publishing|Retrieved)\\b|et al\\.'
].join('|'), 'iu');
// 서지 사이에 낀 산문을 주석으로 봐 줄 한도. 이보다 길면 본문 문단이다.
const REFERENCE_ANNOTATION_MAX_LINES = 2;
const REFERENCE_ANNOTATION_MAX_CHARS = 200;
// 소제목 없이 문서 끝까지 이어지는 산문을 목록에 딸린 메모로 남겨 둘 한도(첫 산문 줄부터 문서 끝까지).
const REFERENCE_TAIL_NOTE_MAX_CHARS = 500;

function hasKoreanSentence(value) {
  const s = String(value || '').trim();
  return s.length >= 12 && (KOREAN_SENTENCE_END.test(s) || isProseLine(s));
}

function referenceLineKind(value) {
  const s = String(value || '').trim();
  if (!s) return 'blank';
  if (/^\[\d{1,3}\]\s*\S/u.test(s)) return 'strong';
  const body = s.replace(/^(?:[-–—•·*▪◦○●]\s*|\(?\d{1,3}[.)]\s*)+/u, '');
  // 주소가 든 줄은 설명 문장이 붙어 있어도 출처 항목이다.
  if (/https?:\/\/\S|www\.\S|\bdoi\s*[:：]|^URL\s*[:：]/iu.test(body)) return 'strong';
  if (/^[A-Z][A-Za-z'’-]+,\s+(?:[A-Z]\.\s*)+/u.test(body)) return 'strong';
  const authorYear = AUTHOR_YEAR_HEAD.exec(body);
  if (authorYear && authorYear.index <= 80 && !KOREAN_SENTENCE_END.test(body.slice(0, authorYear.index))) return 'strong';
  if (REFERENCE_TAIL.test(s)) return 'strong';
  // A bibliographic title/publisher followed by a year and a dangling comma
  // is a truncated entry, including in a document containing only references.
  if (/[「『《〈]|출판|학술지|학회/u.test(body)
      && /[,，]\s*(?:19|20)\d{2}\s*[,，]$/u.test(body) && !hasKoreanSentence(body)) return 'strong';
  const sentence = hasKoreanSentence(s);
  if (!sentence && CITE_LINE.test(s)) return 'strong';
  if (sentence) return 'prose';
  return REFERENCE_TRACE.test(s) ? 'weak' : 'other';
}

// 줄머리 모양. 목록 항목과 그 뒤 본문 소제목을 가르는 데 쓴다.
function referenceLeadShape(value) {
  const s = String(value || '').trim();
  if (/^\[\d{1,3}\]/u.test(s)) return 'bracket_number';
  if (/^\(?\d{1,3}\)\s*\S/u.test(s)) return 'number_paren';
  if (/^\d{1,3}\.\s*\S/u.test(s)) return 'number_dot';
  if (/^[가-하]\.\s*\S/u.test(s)) return 'hangul_dot';
  if (/^[①-⑳]/u.test(s)) return 'circled';
  if (/^[-–—•·*▪◦○●]\s*\S/u.test(s)) return 'bullet';
  return 'plain';
}

function isStructuralBreakLine(value) {
  const s = String(value || '').trim();
  return /^#{1,6}[ \t]+\S/u.test(s)
    || /^(?:[-*_=]\s*){3,}$/u.test(s)
    || /^(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)]?\s*\S|[IVX]{1,8}[.)．]\s*\S|제\s*\d+\s*(?:장|절|항)\s*\S)/u.test(s);
}

// 첫 산문 줄(firstProse) 바로 위의 줄이 그 문단의 소제목인지 본다. 소제목이면 본문은 그 줄에서 시작한다.
//   · 80자 이하이고, 모양이 분명한 표제(Markdown·로마 숫자·괄호 표제·쌍점으로 끝나는 줄)이거나
//     줄머리 모양이 앞의 서지 항목들과 다른 줄만 소제목으로 본다.
//   · 서지 항목과 줄머리 모양이 같은 줄(연도 없는 항목일 수 있다)은 목록에 남긴다.
//   · 그 위로는 Markdown 표제·구분선·로마 숫자 표제처럼 모양이 분명한 줄만 더 올라간다.
function referenceBodyStart(lines, firstProse, lastKept, entryShapes) {
  let cursor = firstProse - 1;
  while (cursor > lastKept && !lines[cursor].text.trim()) cursor -= 1;
  if (cursor <= lastKept) return { line: firstProse, headed: false };
  const above = lines[cursor].text.trim();
  const headed = above.length <= 80 && (
    isStructuralBreakLine(above)
    || /[:：]$/u.test(above)
    || /^[\[<【（(].*[\]>】）)]$/u.test(above)
    || !entryShapes.has(referenceLeadShape(above))
  );
  if (!headed) return { line: firstProse, headed: false };
  let line = cursor;
  for (cursor -= 1; cursor > lastKept; cursor -= 1) {
    const s = lines[cursor].text.trim();
    if (!s) continue;
    if (!isStructuralBreakLine(s)) break;
    line = cursor;
  }
  return { line, headed: true };
}

// 표제(headingIndex) 뒤를 읽어 { valid, hasEntries, end, endLine }을 돌려준다.
//   valid: 이 표제를 참고문헌 시작으로 인정하는가.
//   hasEntries: 확실한 서지 항목이 한 줄 이상 뒤따랐는가.
//   end·endLine: 구간이 끝나는 문자 위치와 줄 번호(그 줄부터 구간 밖).
function measureReferenceBlock(lines, headingIndex, sourceLength) {
  let strong = 0;
  let weak = 0;
  let annotation = 0;          // 서지 줄 사이에 끼어 구간에 남은 산문 줄
  let lastKept = headingIndex; // 구간에 남기로 정해진 마지막 줄
  let pending = null;          // 아직 주석인지 본문인지 정하지 못한 산문 { first, lines, chars }
  let boundary = -1;           // 구간이 끝나는 줄
  let bodyResumed = false;     // 산문 때문에 끝났는가(부록 표제로 끝난 것과 구분)
  let tailNotes = false;       // 문서 끝의 짧은 산문을 목록에 딸린 메모로 두기로 했는가
  // 문서 앞쪽(40% 이전)의 표제는 더 엄격하게 본다. 옛 탐지기(detectRefStart)의 "문서 40% 뒤" 조건을 이어받은 것.
  const pastOpening = lines[headingIndex].start > sourceLength * 0.4;
  const entryShapes = new Set();
  const keep = (index, text) => { lastKept = index; entryShapes.add(referenceLeadShape(text)); };
  const closeAtBody = () => {
    boundary = referenceBodyStart(lines, pending.first, lastKept, entryShapes).line;
    bodyResumed = true;
  };
  // 짧은 산문이 판정 없이 남았을 때: 바로 위에 소제목이 있으면 새 절의 본문이고, 없으면 목록에 딸린 주석으로 둔다.
  const pendingIsHeadedBody = () => referenceBodyStart(lines, pending.first, lastKept, entryShapes).headed;

  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    const s = lines[i].text.trim();
    if (!s) continue;
    if (APPENDIX_HEADING_LINE.test(s)) {
      if (pending && pendingIsHeadedBody()) closeAtBody();
      else boundary = i;
      break;
    }
    const kind = isRefHeadingCandidateLine(s) ? 'heading' : referenceLineKind(s);
    if (kind === 'strong') {
      if (pending && !tailNotes) annotation += pending.lines;
      pending = null;
      strong += 1;
      keep(i, s);
      continue;
    }
    if (kind === 'weak' && !pending) {
      weak += 1;
      keep(i, s);
      continue;
    }
    if (kind === 'prose') {
      if (!pending) pending = { first: i, lines: 0, chars: 0 };
      pending.lines += 1;
      pending.chars += s.length;
      if (!tailNotes && (pending.lines > REFERENCE_ANNOTATION_MAX_LINES || pending.chars > REFERENCE_ANNOTATION_MAX_CHARS)) {
        // 소제목 없이 문서 끝까지 이어지는 짧은 산문(출처를 문장으로 적은 목록, 맺음말)은 종전처럼 잠가 둔다.
        // 이번에 고치는 사고는 수천 자 본문이 잠긴 것이고, 이 정도 꼬리는 그대로 두어도 잃는 것이 작다.
        const tailChars = sourceLength - lines[pending.first].start;
        if (pastOpening && tailChars <= REFERENCE_TAIL_NOTE_MAX_CHARS && !pendingIsHeadedBody()) {
          tailNotes = true;
          continue;
        }
        closeAtBody();
        break;
      }
      continue;
    }
    // 소제목 달린 산문 뒤에 새 참고문헌 표제가 나오면, 그 산문은 두 목록 사이의 본문이다.
    if (kind === 'heading' && pending && pendingIsHeadedBody()) {
      closeAtBody();
      break;
    }
  }
  // 문서가 짧은 산문으로 끝났다. 소제목이 없으면 종전처럼 끝까지 잠가 둔다(문장으로 끝나는 마지막 항목일 수 있다).
  if (boundary < 0 && pending && pendingIsHeadedBody()) closeAtBody();

  const bibliographic = strong + weak;
  const endLine = boundary >= 0 ? boundary : lines.length;
  let insideLines = 0;
  for (let i = headingIndex + 1; i < endLine; i += 1) if (lines[i].text.trim()) insideLines += 1;
  // 문서 앞쪽의 표제는 확실한 서지가 뒤따르고 구간의 절반 이상이 서지일 때만 인정한다(앞쪽에 놓인 실제 목록은 살린다).
  const valid = bibliographic > 0
    ? bibliographic >= annotation && (pastOpening || (strong > 0 && bibliographic * 2 >= insideLines))
    // 서지로 읽히는 줄이 하나도 없어도, 문서 뒤쪽 표제 뒤에 본문이 없으면 종전처럼 끝까지 보존한다.
    : pastOpening && !bodyResumed;
  return {
    valid,
    hasEntries: strong > 0,
    end: boundary >= 0 ? lines[boundary].start : sourceLength,
    endLine
  };
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
  referenceLineFlags,
  tocEntryKeys,
  isRefHeadingLine,
  isAppendixHeadingLine,
  REF_HEADING,
  TOC_HEADING,
  APPENDIX_HEADING_LINE
};
