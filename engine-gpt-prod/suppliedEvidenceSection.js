'use strict';

// 과제 양식이 "AI가 작성한 기사"와 "학생이 직접 쓴 기사"처럼 번호 붙은 형제
// 제목으로 AI 산출물과 본인 글을 나란히 요구하는 경우, AI 절의 본문(사용한
// 프롬프트와 AI 답변)은 학생이 제출하는 증거 자료다. 고쳐 쓰면 비교 분석의
// 근거가 사라지므로 그 절만 원문 그대로 보존한다.
//
// 다음이 모두 명시돼 있을 때만 적용한다.
//   1) 번호형 제목 한 줄 전체가 "AI가 작성한 <산출물>" 꼴이다.
//   2) 같은 번호 체계의 뒤쪽 형제 제목이 절의 끝을 닫는다.
//   3) 같은 번호 체계의 형제 제목 중 하나가 본인 작성 또는 AI와의 비교를 말한다.
// AI 초안만 붙여 넣은 일반 입력, 본문 속 언급, 닫는 형제 제목이 없는 글은
// 대상이 아니다.

const AI_NAME = '(?:생성형\\s*)?(?:AI|인공지능|Chat\\s?GPT|챗\\s?GPT|GPT|Gemini|제미나이|Claude|클로드|Copilot|코파일럿)';
const ARTIFACT = '(?:기사|글|답변|응답|초안|결과물|결과|요약문|요약|에세이|보고서|감상문|서평|번역문|번역|시|소설)';
const TRAILING_NOTE = '(?:\\s*[（(][^（()）\\n]{1,30}[）)])?';
const AI_ARTIFACT_HEADING_RE = new RegExp(
  `^${AI_NAME}\\s*(?:가|이)\\s*(?:직접\\s*)?(?:작성한|쓴|생성한|만든|답변한|출력한|요약한|번역한)\\s*${ARTIFACT}${TRAILING_NOTE}$`,
  'iu'
);
const OWN_WORK_HEADING_RE = new RegExp(
  `^(?:학생|내|나|본인|필자|제|저)(?:이|가)?\\s*(?:직접\\s*)?(?:작성한|쓴|고쳐\\s*쓴|수정한|요약한|번역한)\\s*${ARTIFACT}`,
  'u'
);
const COMPARISON_HEADING_RE = new RegExp(
  `^${AI_NAME}\\s*(?:와|과|의\\s*${ARTIFACT}\\s*(?:와|과))\\s*(?:나|내|학생|본인|필자|저|제)(?=\\s|의(?:\\s|${ARTIFACT})|$)`,
  'iu'
);

function headingAt(line) {
  const text = String(line || '').trim();
  if (!text || text.length > 60) return null;
  const match = text.match(/^(?:([①-⑳])|(\d{1,2})[.)]|(#{1,6})(?=\s))\s*(.+)$/u);
  if (!match) return null;
  const kind = match[1] ? 'circled' : (match[2] ? 'numeric' : `hash${match[3].length}`);
  return { kind, body: match[4].replace(/[*_]+/gu, '').trim() };
}

function suppliedEvidenceSpans(value) {
  const text = String(value || '');
  const lines = [];
  let pos = 0;
  for (const part of text.split('\n')) {
    lines.push({ start: pos, end: pos + part.length, heading: headingAt(part.replace(/\r$/u, '')) });
    pos += part.length + 1;
  }
  const spans = [];
  for (let i = 0; i < lines.length; i += 1) {
    const heading = lines[i].heading;
    if (!heading || !AI_ARTIFACT_HEADING_RE.test(heading.body)) continue;
    const siblings = lines.map((line, index) => ({ line, index }))
      .filter(item => item.index !== i && item.line.heading?.kind === heading.kind);
    const closing = siblings.find(item => item.index > i);
    if (!closing) continue;
    if (!siblings.some(item => OWN_WORK_HEADING_RE.test(item.line.heading.body)
        || COMPARISON_HEADING_RE.test(item.line.heading.body))) continue;
    let last = closing.index - 1;
    while (last > i && !text.slice(lines[last].start, lines[last].end).trim()) last -= 1;
    if (last <= i) continue;
    let first = i + 1;
    while (first < last && !text.slice(lines[first].start, lines[first].end).trim()) first += 1;
    const end = lines[last].end - (text[lines[last].end - 1] === '\r' ? 1 : 0);
    spans.push({ start: lines[first].start, end, heading: heading.body });
  }
  return spans;
}

function suppliedEvidenceSpanAt(spans, start, end) {
  return (spans || []).find(span => start >= span.start && end <= span.end) || null;
}

module.exports = { suppliedEvidenceSpans, suppliedEvidenceSpanAt };
