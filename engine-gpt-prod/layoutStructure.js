'use strict';

const { splitSentences } = require('../engine/koreanText');

const MAX_PARAGRAPH_BARE = 1100;
const MAX_PARAGRAPH_SENTENCES = 12;
const STRUCTURAL_ROLES = new Set([
  'title',
  'heading',
  'label',
  'label_inline',
  'list',
  'table',
  'flow',
  'quote',
  'code',
  'legal_clause',
  'signature'
]);
const PROFILE_READABILITY_LIMITS = Object.freeze({
  resume_application: Object.freeze({ maxBare: 420, maxSentences: 5 }),
  student_record: Object.freeze({ maxBare: 480, maxSentences: 6 }),
  student_record_teacher: Object.freeze({ maxBare: 480, maxSentences: 6 }),
  student_self_assessment: Object.freeze({ maxBare: 500, maxSentences: 6 }),
  academic_paper: Object.freeze({ maxBare: 700, maxSentences: 8 }),
  report_assignment: Object.freeze({ maxBare: 650, maxSentences: 7 }),
  long_explainer: Object.freeze({ maxBare: 650, maxSentences: 7 }),
  clinical_record: Object.freeze({ maxBare: 700, maxSentences: 8 }),
  legal_contract: Object.freeze({ maxBare: 700, maxSentences: 8 }),
  general_essay: Object.freeze({ maxBare: 540, maxSentences: 7 }),
  personal_essay: Object.freeze({ maxBare: 540, maxSentences: 7 }),
  blog_review: Object.freeze({ maxBare: 560, maxSentences: 7 }),
  review_blog: Object.freeze({ maxBare: 560, maxSentences: 7 }),
  marketing_ad: Object.freeze({ maxBare: 520, maxSentences: 7 }),
  marketing: Object.freeze({ maxBare: 520, maxSentences: 7 }),
  social_caption: Object.freeze({ maxBare: 520, maxSentences: 7 }),
  social: Object.freeze({ maxBare: 520, maxSentences: 7 }),
  mail_notice: Object.freeze({ maxBare: 560, maxSentences: 7 }),
  general: Object.freeze({ maxBare: 600, maxSentences: 7 }),
  unknown: Object.freeze({ maxBare: 600, maxSentences: 7 })
});

function normalizeNewlines(value) {
  return String(value || '').replace(/\r\n?/gu, '\n');
}

function visibleTrim(value) {
  return String(value || '').replace(/^[\u200B\uFEFF]+|[\u200B\uFEFF]+$/gu, '').trim();
}

function splitExplicitParagraphs(value) {
  return normalizeNewlines(value)
    .split(/\n[ \t]*\n+/u)
    .map(paragraph => paragraph.trim())
    .filter(Boolean);
}

function buildLineRecords(value) {
  const source = String(value || '');
  const records = [];
  let start = 0;
  let index = 0;
  for (const match of source.matchAll(/\r?\n/gu)) {
    const raw = source.slice(start, match.index);
    records.push({
      index,
      start,
      end: match.index,
      raw,
      text: visibleTrim(raw),
      blank: !visibleTrim(raw),
      role: 'blank'
    });
    start = match.index + match[0].length;
    index += 1;
  }
  const raw = source.slice(start);
  records.push({
    index,
    start,
    end: source.length,
    raw,
    text: visibleTrim(raw),
    blank: !visibleTrim(raw),
    role: 'blank'
  });
  const nonEmpty = records.filter(record => !record.blank);
  const codeIndices = detectCodeLineIndices(records);
  const tableIndices = detectContextTableLineIndices(records, codeIndices);
  const signatureIndices = detectSignatureLineIndices(records, codeIndices);
  const parallelSloganTitleIndices = detectParallelSloganTitleIndices(
    records,
    new Set([...codeIndices, ...tableIndices, ...signatureIndices])
  );
  const firstContentIndex = nonEmpty[0]?.index ?? -1;
  for (const record of nonEmpty) {
    if (codeIndices.has(record.index)) {
      record.role = 'code';
      continue;
    }
    const position = nonEmpty.findIndex(item => item.index === record.index);
    const previous = position > 0 ? nonEmpty[position - 1] : null;
    const next = position + 1 < nonEmpty.length ? nonEmpty[position + 1] : null;
    const previousRaw = records[record.index - 1] || null;
    record.role = classifyLine(record.text, {
      firstContent: record.index === firstContentIndex,
      previous,
      next,
      blankBefore: record.index === 0 || previousRaw?.blank === true,
      tableLike: tableIndices.has(record.index),
      signatureLike: signatureIndices.has(record.index),
      parallelSloganTitle: parallelSloganTitleIndices.has(record.index)
    });
  }
  return records;
}

function classifyLine(value, context = {}) {
  const text = visibleTrim(value);
  if (!text) return 'blank';
  if (legalClauseParts(text)) return 'legal_clause';
  if (context.signatureLike) return 'signature';
  if (context.parallelSloganTitle) return 'title';
  if (isKnownHeadingLine(text)) return 'heading';
  if (context.tableLike || isExplicitTableLine(text)) return 'table';
  if (isFlowSequenceLine(text)) return 'flow';
  if (isListLine(text)) return 'list';
  if (isQuoteLine(text)) return 'quote';
  const label = labelParts(text);
  if (label) return label.rest ? 'label_inline' : 'label';
  if (isGenericTitle(text, context)) return 'title';
  return 'prose';
}

function isKnownHeadingLine(value) {
  const text = visibleTrim(value);
  if (!text || text.length > 140) return false;
  if (/^#{1,6}\s+\S/u.test(text)) return true;
  if (/^[\[【<][^\]】>\n]{1,80}[\]】>]$/u.test(text)) return true;
  if (/^[-–—]\s*(?:서론|본론|결론|초록|요약|목\s*차|참고\s*문헌|참고\s*자료|부록)$/u.test(text)) return true;
  if (/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\s*[.)．]?\s*\S.{0,100}$/u.test(text)) return true;
  if (/^[IVX]{1,8}[.)．]\s*\S.{0,100}$/u.test(text)) return true;
  if (/^\d{1,2}(?:\.\d{1,2}){0,3}\s*[.)]?\s+\S.{0,100}$/u.test(text)) return true;
  if (/^\d{1,2}[.)]\s*[가-힣A-Za-z]\S*.{0,100}$/u.test(text)) return true;
  if (/^(?:문제|문항)\s*\d{1,3}\s*[.)：:]?\s*\S.{0,100}$/u.test(text)) return true;
  // OCR·웹 복사에서 `① 소제목: "비유"` 뒤 본문이 같은 행에 붙는
  // 형식이 자주 나온다. preflight가 본문 경계를 복원한 뒤에는 콜론을
  // 가진 짧은 원형번호 행만 소제목으로 잠근다. 일반 선택지·목록은
  // 콜론이 없으므로 계속 본문 편집 대상이다.
  if (/^[①-⑳]\s*[^.!?。！？\n:：]{2,120}[:：](?:\s*(?:"[^"\n]+"|“[^”\n]+”|'[^'\n]+'|‘[^’\n]+’))?$/u.test(text)) return true;
  if (/^[①-⑳]\s*[^.!?。！？\n]{2,120}\([A-Za-z][A-Za-z0-9 /&+·-]{2,100}\)$/u.test(text)) return true;
  if (/^\d{1,2}\.(?:19|20)\d{2}년\S*.{0,100}$/u.test(text)) return true;
  if (/^제\s?\d{1,3}\s?(?:장|절|항)(?:\s+\S.{0,100})?$/u.test(text)) return true;
  if (/^제\s?\d{1,3}\s?조(?:의\s?\d{1,3})?(?:\s*[（(][^）)\n]{1,80}[）)])?$/u.test(text)) return true;
  if (/^(?:성장\s*(?:과정|배경)(?:과\s*(?:학교|학창)\s*시절)?|나의\s*성격적\s*강점과\s*약점|성격의\s*장단점|지원\s*동기|직무\s*역량|경력\s*사항|입사\s*후(?:의)?\s*(?:포부|목표)(?:와\s*포부)?)$/u.test(text)) return true;
  if (/^(?:서론|본론|결론|초록|요약|연구\s*방법|연구\s*결과|연구\s*가설|분석\s*결과|결과\s*분석|논의|시사점|한계점|제언|부록|목\s*차|참고\s*문헌|결과\s*분석\s*및\s*함의)$/u.test(text)) return true;
  return /^(?:Abstract|Introduction|Methods?|Methodology|Results?|Discussion|Conclusion|References|Appendix)$/iu.test(text);
}

function isGenericTitle(text, context = {}) {
  if (!context.firstContent || !context.next) return false;
  if (text.length < 2 || text.length > 100) return false;
  if (/[.!?。！？]\s*["”’')\]]*$/u.test(text)) return false;
  if (/^(?:https?:|www\.|[A-Za-z]:\\)/iu.test(text)) return false;
  // 첫 문단이 문장부호 없이 복사됐다는 이유만으로 제목으로 잠그지 않는다.
  // 주제 조사와 서술어를 함께 가진 `1984는 … 소설이다` 같은 행은 정상
  // 산문이며, 이를 제목으로 분류하면 첫 문단 전체가 변환에서 빠진다.
  if (looksLikeUnpunctuatedProse(text)) return false;
  const nextLength = context.next.text.length;
  return context.blankBefore
    && (text.length <= 45 || nextLength >= Math.max(70, Math.ceil(text.length * 1.45)));
}

function looksLikeUnpunctuatedProse(value) {
  const text = visibleTrim(value);
  if (!text || text.length < 12) return false;
  const words = text.split(/\s+/u).filter(Boolean);
  const topicOrSubject = /(?:은|는|이|가)\s/u.test(text);
  const finiteEnding = /(?:이다|한다|된다|있다|없다|않다|했다|하였다|되었다|이었다|였다|합니다|됩니다|있습니다|없습니다|않습니다|했습니다|되었습니다|입니다|해요|돼요|있어요|없어요|않아요|했어요|됐어요)$/u.test(text);
  if (!finiteEnding) return false;

  // 짧은 완결문도 실제 제목으로 자주 쓰인다.
  // `운영 결과를 다시 확인했다`, `말이 안 된다고 생각하면서도 클릭했다`
  // 같은 헤드라인을 단순히 서술어가 있다는 이유로 본문 처리하지 않는다.
  // 반면 `1984는 … 소설이다`처럼 주제를 정의하는 계사문과, 제목 길이를
  // 넘어선 다절 서술문은 첫 행에 놓여도 산문으로 보는 편이 안전하다.
  const definitionalCopula = topicOrSubject
    && /(?:이다|입니다|이었다|였습니다|였다)$/u.test(text)
    && words.length >= 4;
  const multiClause = /[,;:，；：]/u.test(text)
    || /(?:하며|하고|되어|이고|이지만|했지만|때문에|통해|위해)\s+\S/u.test(text);
  const longDeclarative = text.length > 45 && words.length >= 7;
  return definitionalCopula || longDeclarative || (text.length > 55 && multiClause);
}

/**
 * 자기소개서·직무계획서에는 마침표가 붙은 짧은 다짐을 소제목으로 쓰고
 * 바로 다음 행에 긴 근거 문단을 두는 형식이 흔하다. 첫 행만 제목으로 보는
 * 일반 규칙은 이 반복 구조를 놓쳐, 모델이 소제목을 앞뒤 문단에 합쳐 버렸다.
 * 문서 안에서 같은 패턴이 세 번 이상 반복될 때만 구조로 확정해 일반 산문의
 * 짧은 문장을 과보호하지 않는다.
 */
function detectParallelSloganTitleIndices(records, excluded = new Set()) {
  const source = Array.isArray(records) ? records : [];
  const nonEmpty = source.filter(record => !record.blank && !excluded.has(record.index));
  const candidates = [];
  for (let position = 0; position < nonEmpty.length; position += 1) {
    const record = nonEmpty[position];
    const next = nonEmpty[position + 1];
    const text = String(record?.text || '').trim();
    const nextText = String(next?.text || '').trim();
    if (!next || text.length < 12 || text.length > 82) continue;
    if (!/겠습니다[.!。！？]?$/u.test(text)) continue;
    if (splitSentences(text).filter(Boolean).length !== 1) continue;
    if (isListLine(text) || labelParts(text) || isKnownHeadingLine(text) || isQuoteLine(text)) continue;
    if (nextText.length < 65 || nextText.length < Math.ceil(text.length * 1.45)) continue;
    candidates.push(record.index);
  }
  return candidates.length >= 3 ? new Set(candidates) : new Set();
}

function labelParts(value) {
  const text = visibleTrim(value);
  const match = text.match(/^(?:[*#]+\s*)?([가-힣A-Za-z][가-힣A-Za-z0-9·/&() _-]{0,48})\s*[:：]\s*(.*)$/u);
  if (!match) return null;
  const label = match[1].trim();
  if (/^(?:https?|ftp|file)$/iu.test(label) || /[.!?。！？]/u.test(label)) return null;
  return { label, rest: match[2].trim() };
}

function isListLine(value) {
  const text = visibleTrim(value);
  return /^(?:[-*+•▪◦·]|\d+(?:[-.]\d+)*[.)]|[가-힣][.)]|[①-⑳])\s+\S/u.test(text)
    || /^[●○■□◆◇▶▷※]\s*\S/u.test(text)
    // 현장 메모·세특 초안에서 `+특히 ...`처럼 공백 없이 붙은 불릿이
    // 반복된다. 양수·증감률(+5%, +3건)은 목록이 아니므로 문자로
    // 시작하는 경우만 구조 접두부로 인정한다.
    || /^\+(?=[가-힣A-Za-z“"'‘「『《〈])\S/u.test(text);
}

function isFlowSequenceLine(value) {
  const text = visibleTrim(value);
  if (!text || text.length > 1600 || /[.!?。！？]\s*$/u.test(text)) return false;
  const arrows = text.match(/(?:→|⇒|⇢|⟶|➜|->)/gu) || [];
  if (arrows.length < 2) return false;
  const nodes = text
    .split(/\s*(?:→|⇒|⇢|⟶|➜|->)\s*/u)
    .map(node => node.trim())
    .filter(Boolean);
  return nodes.length >= 3
    && nodes.length === arrows.length + 1
    && nodes.every(node => node.length <= 120 && !/[\n\r]/u.test(node));
}

function isExplicitTableLine(value) {
  const text = visibleTrim(value);
  if (/^\|.+\|$/u.test(text)) return true;
  // 스프레드시트·PDF에서 셀 구분자만 사라져 `비교 항목A열B열...`이
  // 한 행으로 붙는 경우다. 셀을 추측해 다시 나누지는 않고, 긴 비교표
  // 머리말과 다수의 괄호형 열 값이 함께 확인될 때만 원문 그대로 잠근다.
  if (/^(?:비교\s*)?항목(?=\S)/u.test(text)
      && text.length >= 160
      && !/[.!?。！？]\s*$/u.test(text)
      && (text.match(/[（(][^）)\n]{1,80}[）)]/gu) || []).length >= 3) {
    return true;
  }
  // `표지 디자인`, `표로 정리했다`, `그림이 보여 준다` 같은 정상 산문을
  // 표·그림 캡션으로 잠그지 않는다. 캡션은 표식 뒤에 실제 번호(또는
  // 로마 숫자·영문 부호)가 있고, 그 뒤에 캡션 경계가 확인될 때만 구조다.
  // 한글의 JavaScript \b 경계는 신뢰할 수 없으므로 명시적인 다음 문자
  // 조건을 사용한다.
  if (/^(?:표|그림)\s*(?:\d{1,3}(?:[-.]\d{1,3})*|[A-Z]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+)(?=$|[\s.):：-])/u.test(text)) {
    return true;
  }
  return false;
}

function detectSignatureLineIndices(records, excluded = new Set()) {
  const nonEmpty = (records || []).filter(record => !record.blank && !excluded.has(record.index));
  if (nonEmpty.length < 3) return new Set();
  const tail = nonEmpty.slice(-7);
  const dateAt = tail.findIndex(record => /^(?:(?:19|20)\d{2}[.년]\s*\d{1,2}[.월]\s*\d{1,2}(?:[.일])?|\d{1,2}월\s*\d{1,2}일)$/u.test(record.text));
  if (dateAt < 0) return new Set();
  const afterDate = tail.slice(dateAt);
  const hasInstitution = afterDate.some(record => /(?:대학교|대학|학과|전공|위원회|학생회|협회|기관|재단|회사|병원)/u.test(record.text));
  const hasRole = afterDate.some(record => /(?:위원장|회장|대표|담당자|사무국|총장|학장|원장|드림|올림)\s*[.!]?$/u.test(record.text));
  if (!hasInstitution || !hasRole) return new Set();
  return new Set(afterDate.map(record => record.index));
}

function tableColumnCount(value) {
  const text = String(value || '');
  if (/\t/u.test(text)) return text.split(/\t+/u).filter(cell => visibleTrim(cell)).length;
  if (/\S\s{2,}\S/u.test(text)) return text.split(/\s{2,}/u).filter(cell => visibleTrim(cell)).length;
  return 0;
}

function detectContextTableLineIndices(records, excluded = new Set()) {
  const out = new Set();
  for (const record of records || []) {
    if (!record.blank && !excluded.has(record.index) && isExplicitTableLine(record.text)) out.add(record.index);
  }
  let group = [];
  const flush = () => {
    if (group.length >= 2) {
      const counts = group.map(item => tableColumnCount(item.raw));
      const dominant = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)];
      for (const item of group) {
        if (tableColumnCount(item.raw) >= 2 && Math.abs(tableColumnCount(item.raw) - dominant) <= 1) out.add(item.index);
      }
    }
    group = [];
  };
  for (const record of records || []) {
    if (record.blank || excluded.has(record.index) || tableColumnCount(record.raw) < 2) {
      flush();
      continue;
    }
    group.push(record);
  }
  flush();
  return out;
}

function detectCodeLineIndices(records) {
  const out = new Set();
  let fence = null;
  for (const record of records || []) {
    const match = String(record.raw || '').match(/^\s*(`{3,}|~{3,})/u);
    if (!fence) {
      if (!match) continue;
      fence = { char: match[1][0], length: match[1].length };
      out.add(record.index);
      continue;
    }
    out.add(record.index);
    if (match && match[1][0] === fence.char && match[1].length >= fence.length) fence = null;
  }
  return out;
}

function legalClauseParts(value) {
  const text = visibleTrim(value);
  const match = text.match(/^(제\s*\d{1,3}\s*조(?:의\s*\d{1,3})?(?:\s*[（(][^）)\n]{1,80}[）)])?)(?:\s+([\s\S]+))?$/u);
  if (!match) return null;
  return { prefix: match[1], body: String(match[2] || '').trim() };
}

function isQuoteLine(value) {
  const text = visibleTrim(value);
  if (/^>\s*\S/u.test(text)) return true;
  // 따옴표로 시작한다는 이유만으로 뒤에 본문이 이어지는 긴 산문 전체를
  // 인용 블록으로 잠그지 않는다. 독립 인용 행만 구조로 취급하고, 문장
  // 첫머리의 속담·좌우명은 일반 산문으로 두어 바깥 띄어쓰기를 교정한다.
  return /^(?:“[^”\n]{1,500}”|‘[^’\n]{1,500}’|"[^"\n]{1,500}"|'[^'\n]{1,500}'|「[^」\n]{1,500}」|『[^』\n]{1,500}』|《[^》\n]{1,500}》|〈[^〉\n]{1,500}〉)$/u.test(text);
}

function isSentenceComplete(value) {
  const text = visibleTrim(value);
  if (!text) return false;
  if (/[.!?。！？…]\s*["”’')\]]*$/u.test(text)) return true;
  return text.length >= 40 && /(?:다|요|니다|했다|된다|였다|있다|없다|않다|함|됨|임|음)$/u.test(text);
}

function startsNewUnit(value) {
  return /^(?:[가-힣A-Za-z0-9“"'‘([]|[-*+•▪◦·]\s|[①②③④⑤⑥⑦⑧⑨⑩])/u.test(visibleTrim(value));
}

function isStructuralRole(role) {
  return STRUCTURAL_ROLES.has(String(role || ''));
}

function isHardProseBoundary(left, right) {
  if (!left || !right || left.blank || right.blank) return false;
  if (left.role !== 'prose' || right.role !== 'prose') return false;
  return left.text.length >= 70
    && right.text.length >= 40
    && isSentenceComplete(left.text)
    && startsNewUnit(right.text);
}

function shouldPreserveLineBoundary(left, right, policy = 'structural') {
  if (!left || !right || left.blank || right.blank) return false;
  if (policy === true || policy === 'all') return true;
  if (!policy || policy === 'none') return false;
  return isStructuralRole(left.role) || isStructuralRole(right.role) || isHardProseBoundary(left, right);
}

function analyzeLineStructure(value) {
  const records = buildLineRecords(value);
  const nonEmpty = records.filter(record => !record.blank);
  const roleCounts = {};
  for (const record of nonEmpty) roleCounts[record.role] = (roleCounts[record.role] || 0) + 1;
  let preservedBoundaryCount = 0;
  for (let index = 0; index < records.length - 1; index += 1) {
    if (shouldPreserveLineBoundary(records[index], records[index + 1], 'structural')) preservedBoundaryCount += 1;
  }
  const explicitParagraphCount = splitExplicitParagraphs(value).length;
  const paragraphs = splitReadableParagraphs(value, { records });
  const readability = measureParagraphReadability(paragraphs);
  return {
    lineCount: records.length,
    nonEmptyLineCount: nonEmpty.length,
    roleCounts,
    titleLineCount: roleCounts.title || 0,
    headingLineCount: roleCounts.heading || 0,
    labelLineCount: (roleCounts.label || 0) + (roleCounts.label_inline || 0),
    listLineCount: roleCounts.list || 0,
    tableLineCount: roleCounts.table || 0,
    flowLineCount: roleCounts.flow || 0,
    quoteLineCount: roleCounts.quote || 0,
    signatureLineCount: roleCounts.signature || 0,
    structuralLineCount: nonEmpty.filter(record => isStructuralRole(record.role)).length,
    preservedBoundaryCount,
    explicitParagraphCount,
    readableParagraphCount: paragraphs.length,
    semanticBoundaryCount: Math.max(0, paragraphs.length - 1),
    readability
  };
}

function splitReadableParagraphs(value, options = {}) {
  const records = options.records || buildLineRecords(value);
  const paragraphs = [];
  let current = [];
  const flush = () => {
    const text = current.join('\n').trim();
    if (text) paragraphs.push(text);
    current = [];
  };
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.blank) {
      flush();
      continue;
    }
    current.push(record.raw.trim());
    const next = records[index + 1];
    if (!next || next.blank) {
      flush();
      continue;
    }
    const splitForStandaloneStructure = ['title', 'heading'].includes(record.role)
      || ['title', 'heading'].includes(next.role);
    if (splitForStandaloneStructure || isHardProseBoundary(record, next)) flush();
  }
  flush();
  return paragraphs;
}

function profileNameFromOptions(options = {}) {
  const profile = options?.documentProfile;
  if (profile && typeof profile === 'object') {
    return String(profile.profile || profile.contentGenre || options.profileName || 'unknown');
  }
  return String(options?.profileName || profile || 'unknown');
}

function resolveParagraphReadabilityLimits(options = {}) {
  const profileName = profileNameFromOptions(options);
  const mode = String(options?.mode || '');
  if (mode === 'polish' || profileName === 'creative') {
    return {
      profileName,
      maxBare: MAX_PARAGRAPH_BARE,
      maxSentences: MAX_PARAGRAPH_SENTENCES
    };
  }
  const limits = PROFILE_READABILITY_LIMITS[profileName]
    || PROFILE_READABILITY_LIMITS.unknown;
  return { profileName, ...limits };
}

function paragraphSplitNeed(paragraph, options = {}) {
  if (isStructureDominatedParagraph(paragraph)) return 1;
  const limits = resolveParagraphReadabilityLimits(options);
  const compact = bare(paragraph).length;
  const sentenceCount = splitSentences(String(paragraph || '')).filter(Boolean).length;
  return Math.max(
    1,
    Math.ceil(compact / limits.maxBare),
    Math.ceil(sentenceCount / limits.maxSentences)
  );
}

function measureParagraphReadability(paragraphsOrText, options = {}) {
  const paragraphs = Array.isArray(paragraphsOrText)
    ? paragraphsOrText
    : splitReadableParagraphs(paragraphsOrText);
  const limits = resolveParagraphReadabilityLimits(options);
  const details = paragraphs.map((paragraph, index) => {
    const compact = bare(paragraph).length;
    const sentenceCount = splitSentences(String(paragraph || '')).filter(Boolean).length;
    const structureDominated = isStructureDominatedParagraph(paragraph);
    const splitNeed = structureDominated ? 1 : paragraphSplitNeed(paragraph, options);
    return { index, compact, sentenceCount, structureDominated, splitNeed, overlong: splitNeed > 1 };
  });
  return {
    paragraphCount: paragraphs.length,
    targetCount: details.reduce((sum, item) => sum + item.splitNeed, 0),
    minimumCount: minimumReadableParagraphCount(details, options),
    overlongCount: details.filter(item => item.overlong).length,
    maxBare: details.length ? Math.max(...details.map(item => item.compact)) : 0,
    maxSentences: details.length ? Math.max(...details.map(item => item.sentenceCount)) : 0,
    maxBareLimit: limits.maxBare,
    maxSentenceLimit: limits.maxSentences,
    details
  };
}

function minimumReadableParagraphCount(detailsOrParagraphs, options = {}) {
  const limits = resolveParagraphReadabilityLimits(options);
  const details = Array.isArray(detailsOrParagraphs)
    && detailsOrParagraphs.every(item => item && typeof item === 'object' && Number.isFinite(item.compact))
    ? detailsOrParagraphs
    : measureParagraphReadabilityDetails(detailsOrParagraphs, options);
  const structuralCount = details.filter(item => item.structureDominated).length;
  const prose = details.filter(item => !item.structureDominated);
  if (!prose.length) return structuralCount;
  const totalBare = prose.reduce((sum, item) => sum + item.compact, 0);
  const totalSentences = prose.reduce((sum, item) => sum + item.sentenceCount, 0);
  return structuralCount + Math.max(
    1,
    Math.ceil(totalBare / limits.maxBare),
    Math.ceil(totalSentences / limits.maxSentences)
  );
}

function measureParagraphReadabilityDetails(paragraphsOrText, options = {}) {
  const paragraphs = Array.isArray(paragraphsOrText)
    ? paragraphsOrText
    : splitReadableParagraphs(paragraphsOrText);
  return paragraphs.map((paragraph, index) => {
    const compact = bare(paragraph).length;
    const sentenceCount = splitSentences(String(paragraph || '')).filter(Boolean).length;
    const structureDominated = isStructureDominatedParagraph(paragraph);
    return { index, compact, sentenceCount, structureDominated };
  });
}

function isStructureDominatedParagraph(value) {
  const records = buildLineRecords(value).filter(record => !record.blank);
  if (!records.length) return false;
  // 표나 목록 한 줄이 섞였다는 이유로 그 뒤의 긴 산문까지 구조 블록으로
  // 면제하지 않는다. 문단의 모든 비어 있지 않은 행이 구조 행일 때만
  // 재배치 금지 대상으로 본다.
  return records.every(isPureStructuralRecord);
}

function isPureStructuralRecord(record) {
  const role = String(record?.role || '');
  if (!isStructuralRole(role)) return false;
  if (['table', 'flow', 'quote', 'code', 'legal_clause', 'signature', 'label'].includes(role)) return true;
  // "라벨: 긴 본문"이나 "1. 제목 + 여러 설명 문장"은 접두부만
  // 구조이고 나머지는 일반 산문이다. 행 전체를 구조로 면제하지 않는다.
  if (role === 'label_inline') return false;
  // 목록 한 항목 안에 설명 문장이 여러 개 있어도 다음 항목과의 행 경계는
  // 의미 구조다. 문장 수 때문에 일반 산문으로 낮추면 가독성 분할 단계가
  // `4. ...\n5. ...`를 한 줄로 다시 붙일 수 있다.
  if (role === 'list') return true;
  if (['title', 'heading'].includes(role)) {
    const sentenceCount = splitSentences(String(record?.text || '')).filter(Boolean).length;
    return sentenceCount <= 1;
  }
  return false;
}

function bare(value) {
  return String(value || '').replace(/\s+/gu, '');
}

module.exports = {
  MAX_PARAGRAPH_BARE,
  MAX_PARAGRAPH_SENTENCES,
  normalizeNewlines,
  visibleTrim,
  splitExplicitParagraphs,
  splitReadableParagraphs,
  buildLineRecords,
  classifyLine,
  analyzeLineStructure,
  measureParagraphReadability,
  minimumReadableParagraphCount,
  paragraphSplitNeed,
  resolveParagraphReadabilityLimits,
  shouldPreserveLineBoundary,
  isStructuralRole,
  isKnownHeadingLine,
  isExplicitTableLine,
  isFlowSequenceLine,
  looksLikeUnpunctuatedProse,
  detectParallelSloganTitleIndices,
  legalClauseParts,
  labelParts,
  isSentenceComplete,
  isHardProseBoundary,
  isStructureDominatedParagraph
};
