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
const REF_HEADING = /(^|\n)[ \t]*[<【\[]?\s*(?:참고\s*문헌|참고\s*자료|인용\s*문헌|참고\s*및\s*인용\s*자료|참고\s*및\s*인용\s*문헌|References|REFERENCES|Bibliography|Works\s+Cited)\s*[>】\]]?[ \t]*[:：]?[ \t]*(?:\n|$)/;
const TOC_HEADING = /(^|\n)[ \t]*[<【\[]?\s*(?:목\s*차|차\s*례|Contents|CONTENTS)\s*[>】\]]?[ \t]*[:：]?[ \t]*(?:\n|$)/;

// 참고문헌 한 줄 entry: "저자명. (연도). 제목…" — 줄머리에 이름+근방 (YYYY).
const CITE_LINE = /^[가-힣A-Za-z][^\n]{0,55}\(\s*(?:19|20)\d{2}[a-z]?\s*\)/;

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

module.exports = { splitAcademicBlocks, reassembleAcademic, protectInlineCites, REF_HEADING, TOC_HEADING };
