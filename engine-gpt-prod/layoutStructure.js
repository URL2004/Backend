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
const BRACKET_HEADING_LABELS = new Set([
  '소제목',
  '제목',
  '항목 제목',
  '문항 제목',
  '섹션 제목'
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
  const parallelSectionHeadingIndices = detectParallelSectionHeadingIndices(
    records,
    new Set([...codeIndices, ...tableIndices, ...signatureIndices])
  );
  const labelGroupHeadingIndices = detectLabelGroupHeadingIndices(
    records,
    new Set([...codeIndices, ...tableIndices, ...signatureIndices])
  );
  const plainListIndices = detectPlainListLineIndices(
    records,
    new Set([
      ...codeIndices,
      ...tableIndices,
      ...signatureIndices,
      ...parallelSloganTitleIndices,
      ...parallelSectionHeadingIndices,
      ...labelGroupHeadingIndices
    ])
  );
  const firstContentIndex = nonEmpty[0]?.index ?? -1;
  for (const record of nonEmpty) {
    record.cellCount = tableIndices.has(record.index) ? tableColumnCount(record.raw) : 0;
    record.tabularSeparator = tableIndices.has(record.index) && /\t/u.test(String(record.raw || ''))
      ? 'tab'
      : (tableIndices.has(record.index) && /^\s*\|.*\|\s*$/u.test(String(record.raw || '')) ? 'pipe' : 'spacing');
    if (codeIndices.has(record.index)) {
      record.role = 'code';
      continue;
    }
    const position = nonEmpty.findIndex(item => item.index === record.index);
    const previous = position > 0 ? nonEmpty[position - 1] : null;
    const next = position + 1 < nonEmpty.length ? nonEmpty[position + 1] : null;
    const previousRaw = records[record.index - 1] || null;
    const nextRaw = records[record.index + 1] || null;
    record.role = classifyLine(record.text, {
      firstContent: record.index === firstContentIndex,
      previous,
      next,
      blankBefore: record.index === 0 || previousRaw?.blank === true,
      blankAfter: record.index === records.length - 1 || nextRaw?.blank === true,
      tableLike: tableIndices.has(record.index),
      signatureLike: signatureIndices.has(record.index),
      plainListLike: plainListIndices.has(record.index),
      parallelSloganTitle: parallelSloganTitleIndices.has(record.index),
      parallelSectionHeading: parallelSectionHeadingIndices.has(record.index),
      labelGroupHeading: labelGroupHeadingIndices.has(record.index)
    });
  }
  return records;
}

function classifyLine(value, context = {}) {
  const text = visibleTrim(value);
  if (!text) return 'blank';
  // 워드·웹 복사 과정에서 굵게 표시 마커만 한 행에 남는 경우가 있다.
  // 이를 산문으로 보내면 모델이 주변 제목·목록과 합쳐 구조를 바꾸므로
  // 내용 없는 마크다운 제어 행으로 잠근다.
  if (isStandaloneMarkdownControlLine(text)) return 'code';
  if (legalClauseParts(text)) return 'legal_clause';
  if (isExactMetadataLine(text)) return 'signature';
  if (context.signatureLike) return 'signature';
  if (isKnownHeadingLine(text)) return 'heading';
  if (context.tableLike || isExplicitTableLine(text)) return 'table';
  if (isFlowSequenceLine(text)) return 'flow';
  if (context.plainListLike) return 'list';
  // 번호·불릿이 명시된 긴 완결 문장은 유사한 행이 반복되더라도 제목
  // 묶음이 아니라 목록이다. 공백 유무가 달라졌다는 이유로 한 항목만
  // 목록으로 바뀌면 최종 voice 감사가 구조 손실을 잘못 보고한다.
  if (isListLine(text)) return 'list';
  if (context.parallelSloganTitle) return 'title';
  if (isQuoteLine(text)) return 'quote';
  if (isColonTitleLine(text, context)) return 'title';
  const label = bracketLabelParts(text) || labelParts(text);
  if (label) return label.rest ? 'label_inline' : 'label';
  if (context.labelGroupHeading) return 'heading';
  if (isGenericTitle(text, context)) return 'title';
  if (isTitleContinuation(text, context)) return 'title';
  if (context.parallelSectionHeading) return 'heading';
  if (isStandaloneSectionHeading(text, context)) return 'heading';
  return 'prose';
}

/**
 * 불릿이 사라진 세로 목록을 문장 행으로 보내면 모델이 첫 항목을 도입문에
 * 붙이거나 여러 항목을 한 문장으로 합친다. 명시적인 목록 도입문 바로 뒤에
 * 짧은 명사구가 3행 이상 이어지는 경우만 목록으로 판정한다. 도입문 증거를
 * 필수로 해 짧은 산문 여러 행을 목록으로 오인하지 않는다.
 */
function detectPlainListLineIndices(records, excluded = new Set()) {
  const selected = new Set();
  const values = Array.isArray(records) ? records : [];
  for (let index = 0; index < values.length; index += 1) {
    const intro = values[index];
    if (!intro || intro.blank || excluded.has(intro.index) || !isPlainListIntroducer(intro.text)) continue;
    const candidates = [];
    let cursor = index + 1;
    while (cursor < values.length) {
      const record = values[cursor];
      if (!record || record.blank || excluded.has(record.index) || !isPlainListCandidate(record.text)) break;
      candidates.push(record.index);
      cursor += 1;
    }
    if (candidates.length < 3) continue;
    for (const lineIndex of candidates) selected.add(lineIndex);
    index = cursor - 1;
  }
  return selected;
}

function isPlainListIntroducer(value) {
  const text = visibleTrim(value).replace(/[.:：]\s*$/u, '').trim();
  if (!text || text.length > 100) return false;
  return /(?:다음(?:과\s*같은|과\s*같다|은)|(?:제시|정리|구성|포함|구분)(?:한|하는|되는)?\s*(?:요소|항목|내용|종류|기준|특징|구성|목록|대상|방법|사항|단계|재료|준비물|변수|조건)(?:은|는|이|가)?|(?:주요\s*)?(?:요소|항목|내용|종류|기준|특징|구성|목록|대상|방법|사항|단계|재료|준비물|변수|조건)(?:은|는|이|가))$/u
    .test(text);
}

function isPlainListCandidate(value) {
  const text = visibleTrim(value);
  if (!text || text.length > 50) return false;
  if (/[.!?。！？:：;；]$/u.test(text) || /[,，;；]{2,}/u.test(text)) return false;
  if (legalClauseParts(text) || isExactMetadataLine(text) || isKnownHeadingLine(text)
      || isExplicitTableLine(text) || isFlowSequenceLine(text) || isListLine(text)
      || isQuoteLine(text) || bracketLabelParts(text) || labelParts(text)) return false;
  if (/(?:합니다|했습니다|됩니다|되었습니다|이다|였다|있다|없다|한다|했다|한다면|하였다|해요|예요|이에요)$/u.test(text)) return false;
  return /[가-힣A-Za-z0-9]/u.test(text);
}

function isKnownHeadingLine(value) {
  const text = visibleTrim(value);
  if (!text) return false;
  if (isBracketHeadingLine(text)) return true;
  if (text.length > 140) return false;
  // 중첩 목록에서 본문이 없는 굵은 라벨은 실제로 다음 하위 항목을 묶는
  // 소제목이다. `* `만 분리해 모델에 보내면 `**`가 불릿으로 오인되어
  // 독립 별표 행이 생길 수 있으므로 행 전체를 제목으로 보존한다.
  if (/^\s*[-*+]\s+(?:\*\*[^*\n]{1,120}\*\*|__[^_\n]{1,120}__)\s*$/u.test(text)) return true;
  if (/^#{1,6}\s+\S/u.test(text)) return true;
  if (/^[\[【<][^\]】>\n]{1,80}[\]】>]$/u.test(text)) return true;
  if (/^[-–—]\s*(?:서론|본론|결론|초록|요약|목\s*차|참고\s*문헌|참고\s*자료|부록)$/u.test(text)) return true;
  if (/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\s*[.)．]?\s*\S.{0,100}$/u.test(text)) return true;
  if (/^[IVX]{1,8}[.)．]\s*\S.{0,100}$/u.test(text)) return true;
  // `(1) 개념 및 의의` 같은 짧은 괄호형 소제목은 일반 산문이 아니다.
  // 이 경계를 놓치면 다음 본문과 합쳐지고 이후 재처리에서도 손상이
  // 원문처럼 굳어지므로 제목 행으로 잠근다.
  if (/^[（(]\d{1,2}[）)]\s+[^.!?。！？\n]{2,100}$/u.test(text)) return true;
  const numberedBody = text.match(/^\d{1,2}[.)]\s*([\s\S]+)$/u)?.[1] || '';
  // `1. 소제목`과 `1. 완결된 본문 문장`을 길이만으로 함께 잠그지 않는다.
  // 번호 뒤에 충분히 긴 완결 서술이 있으면 목록 본문이며, 청커가 번호만
  // 잠그고 나머지를 편집할 수 있어야 한다.
  if (numberedBody.length >= 30 && isSentenceComplete(numberedBody)) return false;
  if (/^\d{1,2}(?:\.\d{1,2}){0,3}\s*[.)]?\s+\S.{0,100}$/u.test(text)) return true;
  if (/^\d{1,2}[.)]\s*[가-힣A-Za-z]\S*.{0,100}$/u.test(text)) return true;
  if (/^(?:문제|문항)\s*\d{1,3}\s*[.)：:]?\s*\S.{0,100}$/u.test(text)) return true;
  if (/^쟁점\s*\d{1,3}\s*[.)：:]?\s*\S.{0,100}$/u.test(text)) return true;
  // OCR·웹 복사에서 `① 소제목: "비유"` 뒤 본문이 같은 행에 붙는
  // 형식이 자주 나온다. preflight가 본문 경계를 복원한 뒤에는 콜론을
  // 가진 짧은 원형번호 행만 소제목으로 잠근다. 일반 선택지·목록은
  // 콜론이 없으므로 계속 본문 편집 대상이다.
  if (/^[①-⑳]\s*[^.!?。！？\n:：]{2,120}[:：](?:\s*(?:"[^"\n]+"|“[^”\n]+”|'[^'\n]+'|‘[^’\n]+’))?$/u.test(text)) return true;
  if (/^[①-⑳]\s*[^.!?。！？\n]{2,120}\([A-Za-z][A-Za-z0-9 /&+·-]{2,100}\)$/u.test(text)) return true;
  if (/^\d{1,2}\.(?:19|20)\d{2}년\S*.{0,100}$/u.test(text)) return true;
  if (/^제\s?\d{1,3}\s?(?:장|절|항)(?:\s+\S.{0,100})?$/u.test(text)) return true;
  if (/^제\s?\d{1,3}\s?조(?:의\s?\d{1,3})?(?:\s*[（(][^）)\n]{1,80}[）)])?$/u.test(text)) return true;
  // 자소서·비교 문서에서 `라벨 — 2. 항목명` 전체가 하나의 제목 행이다.
  // 번호만 제목으로 인식하면 앞 라벨은 이전 본문에 붙고 항목명은 번호 뒤에서
  // 다시 갈라질 수 있으므로 짧은 무종결 행 전체를 잠근다.
  if (/^[^.!?。！？\n]{2,70}\s*[—–-]\s*\d{1,3}[.)]?\s+[^.!?。！？\n]{2,100}$/u.test(text)) return true;
  if (/^(?:성장\s*(?:과정|배경)(?:과\s*(?:학교|학창)\s*시절)?|나의\s*성격적\s*강점과\s*약점|성격의\s*장단점|지원\s*동기|직무\s*역량|경력\s*사항|입사\s*후(?:의)?\s*(?:포부|목표)(?:와\s*포부)?)$/u.test(text)) return true;
  if (/^(?:서론|본론|결론|초록|요약|연구\s*방법|연구\s*결과|연구\s*가설|분석\s*결과|결과\s*분석|논의|시사점|한계점|제언|부록|목\s*차|참고\s*문헌|결과\s*분석\s*및\s*함의)$/u.test(text)) return true;
  return /^(?:Abstract|Introduction|Methods?|Methodology|Results?|Discussion|Conclusion|References|Appendix)$/iu.test(text);
}

function isStandaloneMarkdownControlLine(value) {
  const text = visibleTrim(value);
  return /^(?:\*{1,3}|_{2,3}|~{2}|-{3,})$/u.test(text);
}

/**
 * 번호 표식이 없는 중간 소제목도 앞뒤의 명시적 빈 행과 뒤따르는 긴 본문이
 * 함께 확인될 때만 구조로 본다. 단순히 마침표가 빠진 산문 한 줄을 제목으로
 * 잠그지 않도록 길이와 다음 본문 비율을 동시에 제한한다.
 */
function isStandaloneSectionHeading(text, context = {}) {
  // 제목 바로 다음 행에 본문이 이어지는 워드·웹 입력도 흔하다. 앞뒤 모두
  // 빈 행이어야 한다는 옛 조건은 이런 정상 소제목을 산문으로 내려 모델이
  // 이전 문단 끝에 합치게 했다. 앞쪽 단락 경계와 뒤의 충분한 본문을 함께
  // 확인하므로 blankAfter는 필수로 두지 않는다.
  if (!context.blankBefore || !context.next) return false;
  if (text.length < 2 || text.length > 70) return false;
  if (/[.!?。！？]\s*["”’')\]]*$/u.test(text)) return false;
  if (/^(?:https?:|www\.|[A-Za-z]:\\)/iu.test(text)) return false;
  if (isListLine(text) || isQuoteLine(text) || isExplicitTableLine(text)) return false;
  if (bracketLabelParts(text) || labelParts(text)) return false;
  const nextLength = String(context.next.text || '').length;
  if (nextLength < Math.max(70, Math.ceil(text.length * 1.45))) return false;
  if (!looksLikeUnpunctuatedProse(text)) return true;
  return text.length <= 36 && nextLength >= Math.max(100, text.length * 2);
}

function isColonTitleLine(text, context = {}) {
  if (!context.firstContent || !context.next) return false;
  if (text.length < 12 || text.length > 100) return false;
  const parts = labelParts(text);
  if (!parts || parts.label.length < 4 || parts.rest.length < 4) return false;
  if (/^(?:이름|성명|학번|학과|전공|과목|과목명|담당|작성자|제출자|일시|날짜|주소|연락처)$/u.test(parts.label)) return false;
  const nextText = String(context.next.text || '');
  return nextText.length >= 4
    && nextText.length <= 70
    && !labelParts(nextText)
    && !/[.!?。！？]\s*$/u.test(nextText)
    && !looksLikeUnpunctuatedProse(nextText);
}

/**
 * 빈 줄 없이 `소제목\n긴 본문`이 반복되는 원고를 문서 패턴으로 판정한다.
 * 한두 개의 짧은 무종결 문장을 과보호하지 않도록 같은 구조가 세 번 이상
 * 확인될 때만 제목 인덱스로 승격한다.
 */
function detectParallelSectionHeadingIndices(records, excluded = new Set()) {
  const source = Array.isArray(records) ? records : [];
  const candidates = [];
  for (let index = 0; index < source.length - 1; index += 1) {
    const record = source[index];
    const next = source[index + 1];
    if (!record || !next || record.blank || next.blank || excluded.has(record.index)) continue;
    const text = String(record.text || '').trim();
    const nextText = String(next.text || '').trim();
    if (text.length < 4 || text.length > 70 || nextText.length < Math.max(100, text.length * 2)) continue;
    if (/[.!?。！？]\s*$/u.test(text)) continue;
    if (isListLine(text) || labelParts(text) || bracketLabelParts(text)
        || isKnownHeadingLine(text) || isQuoteLine(text) || isExplicitTableLine(text)
        || looksLikeUnpunctuatedProse(text)) continue;
    candidates.push(record.index);
  }
  return candidates.length >= 3 ? new Set(candidates) : new Set();
}

/**
 * `강점 (Strength - 내부 긍정 요인)\n핵심 역량: ...`처럼 빈 줄이나 번호가
 * 없는 범주 제목 뒤에 라벨 항목이 이어지는 형식을 구조로 판정한다. 기존
 * 제목 판정은 다음 행이 긴 산문일 때만 작동해 SWOT·업무 분류표의 범주
 * 제목을 산문으로 흘렸고, 모델이나 후처리가 이를 앞 라벨 본문에 합쳤다.
 *
 * 한 번만 나타나는 짧은 산문을 과보호하지 않도록 같은 문서에서 이 패턴이
 * 두 번 이상 반복되거나, 영문 병기 괄호가 있는 명시적 범주 제목일 때만
 * 승격한다.
 */
function detectLabelGroupHeadingIndices(records, excluded = new Set()) {
  const source = Array.isArray(records) ? records : [];
  const nonEmpty = source.filter(record => !record.blank);
  const candidates = [];
  for (let position = 0; position < nonEmpty.length - 1; position += 1) {
    const record = nonEmpty[position];
    const next = nonEmpty[position + 1];
    if (!record || !next || excluded.has(record.index) || excluded.has(next.index)) continue;
    const text = String(record.text || '').trim();
    const nextText = String(next.text || '').trim();
    const nextLabel = labelParts(nextText) || bracketLabelParts(nextText);
    if (!nextLabel || !nextLabel.rest) continue;
    if (text.length < 2 || text.length > 80) continue;
    if (/[.!?。！？:：]\s*["”’')\]）]*$/u.test(text)) continue;
    if (isListLine(text) || labelParts(text) || bracketLabelParts(text)
        || isKnownHeadingLine(text) || isQuoteLine(text) || isExplicitTableLine(text)
        || looksLikeUnpunctuatedProse(text)) continue;
    const bilingualDescriptor = /[（(][^）)\n]*[A-Za-z][^）)\n]*[）)]\s*$/u.test(text);
    candidates.push({ index: record.index, bilingualDescriptor });
  }
  if (candidates.length >= 2) return new Set(candidates.map(candidate => candidate.index));
  const explicit = candidates.filter(candidate => candidate.bilingualDescriptor);
  return new Set(explicit.map(candidate => candidate.index));
}

function isTitleContinuation(text, context = {}) {
  const previousRole = String(context.previous?.role || '');
  if (!['title', 'heading'].includes(previousRole) || !context.next) return false;
  if (text.length < 2 || text.length > 100) return false;
  if (/[.!?。！？]\s*["”’')\]]*$/u.test(text)) return false;
  if (/^(?:https?:|www\.|[A-Za-z]:\\)/iu.test(text)) return false;
  if (isListLine(text) || isQuoteLine(text) || isExplicitTableLine(text)) return false;
  if (bracketLabelParts(text) || labelParts(text) || looksLikeUnpunctuatedProse(text)) return false;
  const nextLength = String(context.next?.text || '').length;
  return context.blankAfter || nextLength >= Math.max(70, Math.ceil(text.length * 1.45));
}

function isBracketHeadingLine(value) {
  const parts = bracketLabelParts(value);
  if (!parts || !BRACKET_HEADING_LABELS.has(parts.label) || !parts.rest) return false;
  if (parts.rest.length > 160) return false;
  // `[소제목] 제목 본문 첫 문장...`처럼 모델이 행을 합친 결과를 다시
  // 소제목으로 인정하면 구조 손실을 놓친다. 명시적인 소제목 표식이 있어도
  // 실제 제목처럼 짧고 완결 문장이 둘 이상 붙지 않은 행만 제목으로 본다.
  return (parts.rest.match(/[.!?。！？]/gu) || []).length <= 1;
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
  const colonIndex = text.search(/[:：]/u);
  // `1:1 방문학습`, `08:30 출근`의 콜론은 라벨 구분자가 아니다. 이를
  // `라벨: 본문`으로 잠그면 정상적인 어순 변경도 line_anchor_changed로
  // 오인되고, 의미 수리 단계가 문장 앞부분을 원문으로 되돌릴 수 있다.
  if (colonIndex > 0
      && /\d/u.test(text[colonIndex - 1] || '')
      && /^\s*\d/u.test(text.slice(colonIndex + 1))) return null;
  const match = text.match(/^(?:[*#]+\s*)?(?:(?:\p{Extended_Pictographic}\uFE0F?)+\s*)?([가-힣A-Za-z][가-힣A-Za-z0-9·/&()（） _-]{0,48})\s*[:：]\s*(.*)$/u);
  if (!match) return null;
  const label = match[1].trim();
  if (/^(?:https?|ftp|file)$/iu.test(label) || /[.!?。！？]/u.test(label)) return null;
  return { label, rest: match[2].trim() };
}

function isExactMetadataLine(value) {
  const text = visibleTrim(value);
  return /^(?:[-*+•▪◦·]\s*)?(?:제출\s*일자|제출일|작성\s*일자|작성일|접수\s*일자|접수일|신청\s*일자|신청일|날짜|일시)\s*[:：]\s*(?:19|20)\d{2}\s*(?:[.\-/년]\s*\d{1,2})\s*(?:[.\-/월]\s*\d{1,2})(?:\s*일)?\s*[.]?$/u.test(text);
}

function bracketLabelParts(value) {
  const text = visibleTrim(value);
  const match = text.match(/^(\[([^\]\n]{1,80})\]\s*)(.*)$/u);
  if (!match) return null;
  const label = match[2].replace(/\s+/gu, ' ').trim();
  if (!label
      || /^\d+(?:[-.:]\d+)*$/u.test(label)
      || /^(?:https?|ftp|file|doi)$/iu.test(label)
      || !/[가-힣A-Za-z]/u.test(label)) return null;
  return {
    prefix: match[1],
    label,
    rest: match[3].trim()
  };
}

function isListLine(value) {
  return Boolean(listPrefixParts(value));
}

function listPrefixParts(value) {
  const raw = String(value || '');
  const match = raw.match(
    /^(\s*(?:[-*+]\s+|[•▪◦·]\s*|(?:\d+(?:[-.]\d+)*[.)]|[가-힣][.)]|[①-⑳])\s*|[●○■□◆◇▶▷※]\s*|\+(?=[가-힣A-Za-z“"'‘「『《〈])))(\S[\s\S]*)$/u
  );
  if (!match) return null;
  // `+특히 ...` 같은 현장 메모는 목록이지만 `+5%`, `+3건`은 수치다.
  // `*강조*`도 마크다운 강조일 수 있어 ASCII 불릿은 공백을 요구한다.
  return { prefix: match[1], body: match[2] };
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
  // `1.\t본문`, `①\t본문`처럼 목록 표식 뒤에 들여쓰기용 탭 하나가 붙은
  // 워드·한글 문서는 표가 아니다. 이 탭을 열 구분자로 세면 연속된 번호
  // 목록 전체가 table로 잠겨 실제 산문이 모델과 깊이 감사에서 빠진다.
  // 목록 접두부 직후의 탭만 공백으로 낮추고, 본문 안에 추가 열 탭이 있으면
  // 그대로 남겨 실제 표는 계속 감지한다.
  const raw = String(value || '')
    .replace(/^[\u200B\uFEFF]+|[\u200B\uFEFF]+$/gu, '')
    .replace(/^ +| +$/gu, '');
  const text = raw.replace(
    /^(\s*(?:(?:[-*+•▪◦·●○■□◆◇▶▷※]|\d+(?:[-.]\d+)*[.)]|[가-힣][.)]|[①-⑳])))[ \t]*\t+/u,
    '$1 '
  );
  if (/^\s*\|.*\|\s*$/u.test(text)) {
    // 빈 셀도 실제 열 소유권이다. Boolean 필터나 \t+ 병합을 쓰면
    // `A\t\tC`, `| A | | C |`가 2열로 축소되어 붕괴를 놓친다.
    return text.trim().slice(1, -1).split('|').length;
  }
  if (/\t/u.test(text)) return text.split('\t').length;
  if (/\S\s{2,}\S/u.test(text)) return text.split(/\s{2,}/u).filter(cell => visibleTrim(cell)).length;
  return 0;
}

function detectContextTableLineIndices(records, excluded = new Set()) {
  const out = new Set();
  for (const record of records || []) {
    if (record.blank || excluded.has(record.index)) continue;
    if (isExplicitTableLine(record.text)) out.add(record.index);
    // 탭은 워드·스프레드시트가 실제 열 경계로 내보내는 강한 구조 신호다.
    // 목록 들여쓰기용 탭은 tableColumnCount에서 이미 제거되므로, 남은
    // 2셀 이상 행은 주변 표 행이 하나뿐이어도 독립 표 행으로 잠근다.
    if (/\t/u.test(String(record.raw || '')) && tableColumnCount(record.raw) >= 2) {
      out.add(record.index);
    }
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
  let structuralBoundaryCount = 0;
  let hardProseBoundaryCount = 0;
  for (let index = 0; index < records.length - 1; index += 1) {
    const left = records[index];
    const right = records[index + 1];
    if (!left || !right || left.blank || right.blank) continue;
    const structural = isStructuralRole(left.role) || isStructuralRole(right.role);
    const hardProse = !structural && isHardProseBoundary(left, right);
    if (structural) structuralBoundaryCount += 1;
    if (hardProse) hardProseBoundaryCount += 1;
    if (structural || hardProse) preservedBoundaryCount += 1;
  }
  const explicitParagraphCount = splitExplicitParagraphs(value).length;
  const paragraphs = splitReadableParagraphs(value, { records });
  const readability = measureParagraphReadability(paragraphs);
  const tableRecords = nonEmpty.filter(record => record.role === 'table');
  const tableCellSequence = tableRecords
    .map(record => Number(record.cellCount || tableColumnCount(record.raw) || 0));
  const multiColumnLineCount = tableCellSequence.filter(count => count >= 2).length;
  const tabularLineCount = tableRecords.filter(record => record.tabularSeparator === 'tab').length;
  return {
    lineCount: records.length,
    nonEmptyLineCount: nonEmpty.length,
    roleCounts,
    titleLineCount: roleCounts.title || 0,
    headingLineCount: roleCounts.heading || 0,
    labelLineCount: (roleCounts.label || 0) + (roleCounts.label_inline || 0),
    listLineCount: roleCounts.list || 0,
    tableLineCount: roleCounts.table || 0,
    tableCellSequence,
    multiColumnLineCount,
    tabularLineCount,
    flowLineCount: roleCounts.flow || 0,
    quoteLineCount: roleCounts.quote || 0,
    signatureLineCount: roleCounts.signature || 0,
    structuralLineCount: nonEmpty.filter(record => isStructuralRole(record.role)).length,
    preservedBoundaryCount,
    structuralBoundaryCount,
    hardProseBoundaryCount,
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
    // 빈 줄 없이 이어진 `라벨: 본문` 묶음은 각 행 자체가 이미 독립적인
    // 읽기 단위다. 행 전체를 잠그지는 않되(본문은 계속 편집해야 함), 여러
    // 라벨 행의 문장 수를 한 산문 문단으로 합산해 과장문으로 판정하지 않는다.
    // 이전에는 이 묶음을 억지로 분할한 뒤 최종 구조 복원이 다시 합치면서
    // layoutRepair만 실패로 남고 실제 결과의 시각 여백도 사라졌다.
    const structureDominated = isStructureDominatedParagraph(paragraph)
      || isReadableInlineLabelGroup(paragraph);
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
    const structureDominated = isStructureDominatedParagraph(paragraph)
      || isReadableInlineLabelGroup(paragraph);
    return { index, compact, sentenceCount, structureDominated };
  });
}

function isReadableInlineLabelGroup(value) {
  const records = buildLineRecords(value).filter(record => !record.blank);
  return records.length >= 2
    && records.every(record => String(record?.role || '') === 'label_inline');
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
  isTitleContinuation,
  isExactMetadataLine,
  isBracketHeadingLine,
  isExplicitTableLine,
  tableColumnCount,
  isFlowSequenceLine,
  looksLikeUnpunctuatedProse,
  detectParallelSloganTitleIndices,
  detectParallelSectionHeadingIndices,
  detectLabelGroupHeadingIndices,
  legalClauseParts,
  labelParts,
  bracketLabelParts,
  isListLine,
  listPrefixParts,
  isSentenceComplete,
  isHardProseBoundary,
  isStructureDominatedParagraph
};
