'use strict';

const layoutStructure = require('./layoutStructure');
const { compareNumberMultiset } = require('./factAudit');
const freezeBlocks = require('../engine/freezeblocks');

const VERSION = 16;

const INLINE_HEADING_MARKER = String.raw`(?:\d{1,2}(?:\.\d{1,2}){1,3}|\d{1,2}[.)]|[①-⑳]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)．]|[IVX]{1,8}[.)．]|제\s*\d{1,3}\s*(?:장|절|항))`;
const INLINE_HEADING_LABEL = String.raw`(?:서론|본론|결론|초록|요약|연구\s*배경|연구\s*목적|연구\s*방법|연구\s*결과|분석\s*결과|논의|시사점|한계점|제언|지원\s*동기|성장\s*과정|직무\s*역량|입사\s*후\s*포부|합격\s*후\s*계획|활동\s*내용|느낀\s*점|배운\s*점|향후\s*계획)`;
const INLINE_HEADING_BEFORE_RE = new RegExp(
  // 날짜·기간의 `2026. 8. ~ 11. 30.`은 절 제목이 아니다. 번호 표식 뒤에
  // 실제 제목 어휘가 시작될 때만 한 행에 붙은 새 절 경계를 복원한다.
  `([.!?。！？][”’"'」』》〉)\\]]*)[ \\t]*(?=(${INLINE_HEADING_MARKER})\\s*(?:[가-힣A-Za-z]|\\d{1,2}차(?=\\s)))`,
  'gu'
);
const INLINE_HEADING_AFTER_RE = new RegExp(
  `^(\\s*${INLINE_HEADING_MARKER}\\s*${INLINE_HEADING_LABEL})(?=[가-힣A-Za-z0-9①-⑳●○■□◆◇▶▷※])`,
  'u'
);
const INLINE_HEADING_SPACED_BODY_RE = new RegExp(
  `^(\\s*${INLINE_HEADING_MARKER}\\s*${INLINE_HEADING_LABEL})([ \\t]+)(\\S[\\s\\S]*)$`,
  'u'
);
const INLINE_KNOWN_HEADING_ANYWHERE_RE = new RegExp(
  `(?<=[가-힣A-Za-z0-9)”’」』》〉\\]])(?<![0-9IVX])(?=${INLINE_HEADING_MARKER}\\s*${INLINE_HEADING_LABEL})`,
  'gu'
);
const INLINE_CIRCLED_QUOTED_HEADING_RE = new RegExp(
  String.raw`^(\s*[①-⑳]\s+[^.!?。！？\n:：]{1,100}[:：]\s*(?:"[^"\n]{1,100}"|“[^”\n]{1,100}”|'[^'\n]{1,100}'|‘[^’\n]{1,100}’))(?=\S)`,
  'u'
);
const INLINE_CIRCLED_COLON_HEADING_RE = new RegExp(
  String.raw`^(\s*[①-⑳]\s+[^.!?。！？\n:：]{1,100}[:：])(?=(?:\S|[ \t]+["“'‘]))[ \t]*`,
  'u'
);
const INLINE_DAMAGED_TABLE_HEADING_RE = new RegExp(
  String.raw`^(\s*\d{1,2}(?:\.\d{1,2}){0,3}[.)]?\s+[^.!?。！？\n]{2,100}?\s+요약)(?=비교\s*항목)`,
  'u'
);
const GENERIC_NUMBERED_HEADING_RE = new RegExp(
  String.raw`^(\s*(?:\d{1,2}(?:\.\d{1,2}){1,3}[.)]?|\d{1,2}[.)]|[①-⑳]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)．]?|[IVX]{1,8}[.)．])\s*)(\S[\s\S]*)$`,
  'u'
);
const GENERIC_HEADING_END_RE = /(?:개념|정의|의의|유형론|특성|배경|목적|방법|결과|논의|시사점|한계|방안|과제|다원화|혼재|체제|요인|과정|현황|전략|원리|역할|기능|영향|관계|구조|사례|요약|제언|문제점|필요성|정치학|메커니즘|이데올로기|구성\s*요소|조직\s*상황|발달이론)/gu;
const STRUCTURAL_LINE_RE = new RegExp(
  String.raw`^(?:#{1,6}\s+|[-*+•▪◦·●○■□◆◇▶▷※]\s+|\d{1,3}(?:\.\d{1,3}){1,3}\s+|\d{1,3}[.)]\s+|[①-⑳]\s*|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)．]\s*|[IVX]{1,8}[.)．]\s*|제\s*\d{1,3}\s*(?:장|절|항|조)|\|.+\||(?:참고\s*문헌|참고\s*자료|References|Bibliography|부록|Appendix)(?:\s|$))`,
  'iu'
);
const FORCE_WRAP_TAIL_RE = /(?:보다|및|과|와|의|을|를|은|는|이|가|에|에서|으로|로|부터|까지|처럼|대한|관한|그리고|그러나|하지만|또한|따라서|때문에|위해|통해|하며|하고|하는|되는|된|할|했던|필요한|가능한)$/u;
// `이러한`, `가치`, `과정`, `로봇`처럼 조사와 같은 음절로 시작하는 정상
// 어절을 조사로 오인하면 `기준이러한` 같은 새 비문이 생긴다. 독립 조사와
// 조사가 붙은 흔한 접미 명사, 용언화 접미부만 별도로 인정한다.
const RIGHT_STANDALONE_PARTICLE_RE = /^(?:은|는|이|가|을|를|의|와|과|도|만|에서|에게|께서|으로|로|까지|부터|보다)(?=$|[\s,.;:!?。！？])/u;
const RIGHT_WORD_CONTINUATION_RE = /^(?:(?:자|성|화|률|율)(?:은|는|이|가|을|를|의|와|과|도|만|에게|에서)?|하(?:는|여|고|게|도록|였다|였다가|면서|지만|므로|기)|되(?:는|어|고|게|도록|었다|면서|지만|므로|기)|적(?:인|으로|이다|이며))(?=$|[\s,.;:!?。！？])/u;
const WEB_LITERAL_RE = /(?:https?:\/\/[^\s<>"'「」]+|www\.[^\s<>"'「」]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|doi\s*:\s*[^\s<>"'「」]+)/giu;
const WEB_LITERAL_TEST_RE = /(?:https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|doi\s*:)/iu;

const REMOVABLE_LINE_RULES = Object.freeze([
  {
    code: 'source_ui_artifact',
    pattern: /^(?:접기|펼치기|더\s*보기|내용\s*(?:보기|접기|펼치기)|본문\s*(?:보기|접기|펼치기))$/u,
    message: '웹 화면에서 복사된 버튼 문구를 본문에서 제외했어요.'
  },
  {
    code: 'source_instruction_artifact',
    pattern: /^(?:[([]|（)?\s*(?:이미\s*작성하신\s*내용에\s*이어\s*)?(?:내용을\s*)?(?:추가|입력|작성)(?:해\s*주세요|하세요|하십시오)\s*(?:[)\]]|）)?$/u,
    message: '본문이 아닌 작성 지시 문구를 변환 대상에서 제외했어요.'
  },
  {
    code: 'source_rewrite_request_artifact',
    boundaryOnly: true,
    pattern: /^(?:(?:이런|이\s*|위|아래|앞의|해당)\s*)?(?:내용|글|문장)(?:을|를|으로)?\s*(?:(?:AI|인공지능)\s*(?:티|느낌)(?:가|이)?\s*(?:안\s*)?(?:나게|나도록)\s*)?(?:인간처럼|사람이\s*쓴\s*것처럼|자연스럽게)?\s*(?:다시\s*)?(?:써\s*줘|써\s*주세요|작성해\s*줘|작성해\s*주세요|바꿔\s*줘|바꿔\s*주세요|다듬어\s*줘|다듬어\s*주세요|고쳐\s*줘|고쳐\s*주세요|휴머나이징해\s*줘|휴머나이징해\s*주세요)[.!?。！？~]*$/iu,
    message: '본문 끝에 함께 붙은 재작성 요청 문구를 변환 대상에서 제외했어요.'
  },
  {
    code: 'source_rewrite_request_artifact',
    boundaryOnly: true,
    // 사용자가 실제로 붙이는 짧은 구어형 요청도 본문과 분리한다.
    // `AI 느낌이 안 나게 해주면 좋을 것 같아`처럼 목적어인 "글"이
    // 생략된 경우를 기존 규칙이 놓쳤다.
    pattern: /^(?:(?:AI|인공지능)\s*(?:티|느낌)(?:가|이)?\s*)?(?:전혀\s*)?(?:안\s*|덜\s*)?(?:나게|나도록|느껴지게)\s*(?:해\s*주면|해주면|해\s*줘|해주세요|해\s*주세요|부탁해|부탁합니다)(?:\s*(?:좋을|괜찮을)\s*(?:것|거)\s*같(?:아|아요|습니다))?[.!?。！？~]*$/iu,
    message: '본문 끝에 함께 붙은 AI 문체 관련 재작성 요청을 변환 대상에서 제외했어요.'
  },
  {
    code: 'source_generation_meta_artifact',
    boundaryOnly: true,
    pattern: /^(?=[^\n]{1,280}$)(?=[^\n]*(?:소제목|제목)[^\n]*(?:제외|빼고))(?=[^\n]*(?:완성본|최종본))(?=[^\n]*(?:복사|붙여\s*넣|사용))[^\n]+$/iu,
    message: '본문이 아닌 완성본·복사용 생성 안내 문구를 변환 대상에서 제외했어요.'
  },
  {
    code: 'source_instruction_artifact',
    boundaryOnly: true,
    pattern: /^(?=[^\n]{1,280}$)(?=[^\n]*(?:적으라고|쓰라고|작성하라고))(?=[^\n]*(?:적어|써|작성해)\s*(?:보았|봤)(?:어|어요|습니다))[^\n]+$/u,
    message: '본문이 아닌 작성 경위·지시 문구를 변환 대상에서 제외했어요.'
  },
  {
    code: 'source_rewrite_request_artifact',
    boundaryOnly: true,
    pattern: /^(?:(?:이|위|앞의|해당)\s*)?(?:내용|글|문장)(?:을|를)?\s*(?:조금\s*)?(?:보완|수정|정리|각색|재구성|확장)(?:해서|하여|한\s*뒤)?\s*(?:자연스럽게\s*)?(?:써\s*줘|써\s*주세요|작성해\s*줘|작성해\s*주세요|다듬어\s*줘|다듬어\s*주세요)(?:[.!?。！？~]+\s*(?:(?:이건|이\s*글은|이\s*내용은)\s*)?(?:보고서|논문|자소서|자기소개서|과제|발표문|블로그|게시물|원고)(?:에|로)\s*(?:들어갈|쓸|사용할|제출할)\s*(?:내용|글|거|것)?(?:이야|입니다|이에요|거야|것입니다)?[.!?。！？~]*)?$/iu,
    message: '본문 끝에 함께 붙은 보완·작성 요청 문구를 변환 대상에서 제외했어요.'
  },
  {
    code: 'source_edit_instruction_artifact',
    pattern: /^(?:(?:제\s*)?\d+\s*번째\s*문단|\d+\s*번\s*문단|앞(?:의)?\s*문단|뒤(?:의)?\s*문단|마지막\s*문단)(?:을|은|에|에서|뒤에|앞에)?[^\n]{0,100}(?:추가|삭제|이동|합치|나누|분리|교체|수정|바꾸|고치)(?:해\s*주세요|하여\s*주세요|하세요|해줘|해\s*줘|해주세요)[.!?。！？~]*$/iu,
    message: '본문 사이에 섞인 문단 편집 지시를 변환 대상에서 제외했어요.'
  },
  {
    code: 'source_edit_instruction_artifact',
    pattern: /^(?:이|위|아래|앞의|뒤의|해당)\s*(?:문장|문단|표현|제목)(?:을|를)?[^\n]{0,100}(?:으로|로)\s*(?:바꿔|수정해|고쳐)\s*(?:주세요|줘|주십시오)[.!?。！？~]*$/iu,
    message: '본문 사이에 섞인 국소 편집 지시를 변환 대상에서 제외했어요.'
  },
  {
    code: 'source_generation_meta_artifact',
    boundaryOnly: true,
    pattern: /^글자\s*수\s*기준[^\n]{0,180}(?:완성본|최종본)(?:입니다|이에요|이다)?[.!?。！？]*$/u,
    message: '본문 앞에 붙은 생성 결과 안내 문구를 변환 대상에서 제외했어요.'
  },
  {
    code: 'source_generation_meta_artifact',
    boundaryOnly: true,
    pattern: /^(?:AI|인공지능)\s*(?:검사기|탐지기|판별기)[^\n]{0,220}(?:예측|감지|탐지|판별|회피|우회)[^\n]*[.!?。！？]*$/iu,
    message: '본문 앞에 붙은 AI 검사 회피 설명을 변환 대상에서 제외했어요.'
  },
  {
    code: 'source_generation_meta_artifact',
    pattern: /^#{1,6}\s*[^\n]{0,80}(?:완벽\s*)?(?:AI\s*)?(?:회피|우회)용?[^\n]{0,80}(?:최종\s*)?(?:제출본|완성본)\s*(?:[\]】>])?\s*$/iu,
    message: '본문이 아닌 생성 결과용 마크다운 제목을 변환 대상에서 제외했어요.'
  },
  {
    code: 'source_markdown_artifact',
    pattern: /^(?:\*\*|__)$/u,
    message: '내용 없이 남은 마크다운 기호를 본문에서 제외했어요.'
  }
]);

const NOTICE_MESSAGES = Object.freeze({
  source_markdown_artifact: '짝이 맞지 않는 마크다운 기호가 원문에 남아 있을 수 있어요.',
  source_draft_note: '작성 중 메모로 보이는 괄호 문구가 원문에 남아 있어요.',
  source_truncated_reference: '끝이 잘렸을 수 있는 참고문헌 표기가 있어요.',
  source_incomplete_sentence: '마지막 문장이 조사나 연결 표현에서 끝나 미완성일 수 있어요.',
  source_unclosed_delimiter: '괄호나 인용부호의 짝이 닫히지 않은 곳이 있어요.',
  source_missing_terminal_punctuation: '마지막 완결 문장의 문장부호가 빠졌을 수 있어요.',
  source_math_content_gap: '수식·행렬·행 연산이 복사 과정에서 빠진 흔적이 있어요. 원문 입력에 수식이 실제로 보이는지 확인해 주세요.',
  source_template_placeholder: '예시·빈칸·작성 지시로 보이는 템플릿 표시가 원문에 남아 있어요. 완성본으로 쓸 내용인지 확인해 주세요.'
});

function auditAndSanitizeSource(value) {
  // PDF·워드·CSV 복사 과정에서 줄 경계가 LF가 아니라 세로 탭, 폼 피드,
  // Unicode line/paragraph separator로 들어오는 경우가 있다. 이를 공백으로
  // 남기면 목차와 본문이 한 행으로 합쳐져 구조 잠금 범위가 본문까지 번진다.
  const original = normalizeSourceLineSeparators(value).trim();
  if (!original) return emptyResult('');
  const rewriteWrapper = extractQuotedRewritePayload(original);
  const documentQuoteWrapper = rewriteWrapper ? null : extractDocumentQuoteWrapper(original);
  const wrapper = rewriteWrapper || documentQuoteWrapper;
  const workingSource = wrapper?.payload || original;
  const lines = workingSource.split('\n');
  const removals = wrapper
    ? [issue(
        rewriteWrapper ? 'source_rewrite_request_artifact' : 'source_document_quote_wrapper_removed',
        Math.max(1, original.split('\n').length),
        'removed',
        rewriteWrapper
          ? '본문을 감싼 입력용 따옴표와 뒤에 붙은 재작성 요청을 변환 대상에서 제외했어요.'
          : '입력 전체를 감싼 작성용 따옴표를 본문에서 분리했어요.'
      )]
    : [];
  const notices = [];
  const kept = [];
  let inReference = false;
  const fenceState = analyzeFences(lines);

  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index] || '');
    const text = line.trim();
    if (freezeBlocks.isRefHeadingLine(text)) {
      inReference = true;
    } else if (freezeBlocks.isAppendixHeadingLine(text)) {
      inReference = false;
    }

    const removable = text && REMOVABLE_LINE_RULES.find(rule => (
      (!rule.boundaryOnly || isBoundaryContentLine(lines, index))
      && !fenceState.protectedLineIndexes.has(index)
      && !isQuotedInstructionLine(text)
      && rule.pattern.test(text)
    ));
    if (removable) {
      removals.push(issue(removable.code, index + 1, 'removed', removable.message));
      continue;
    }

    kept.push(line);
    if (!text) continue;
    if (hasUnbalancedMarkdown(text)) {
      notices.push(issue('source_markdown_artifact', index + 1, 'notice', NOTICE_MESSAGES.source_markdown_artifact));
    }
    if (/\([^)]{0,90}(?:메모|수정|추가|확인\s*필요|검토\s*필요|나옴|임시)[^)]{0,90}\)/u.test(text)) {
      notices.push(issue('source_draft_note', index + 1, 'notice', NOTICE_MESSAGES.source_draft_note));
    }
    if (hasTemplatePlaceholder(text)) {
      notices.push(issue(
        'source_template_placeholder',
        index + 1,
        'notice',
        NOTICE_MESSAGES.source_template_placeholder
      ));
    }
    if (inReference && isPossiblyTruncatedReference(text)) {
      notices.push(issue('source_truncated_reference', index + 1, 'notice', NOTICE_MESSAGES.source_truncated_reference));
    }
  }

  for (const lineIndex of fenceState.unbalancedLineIndexes) {
    notices.push(issue('source_markdown_artifact', lineIndex + 1, 'notice', NOTICE_MESSAGES.source_markdown_artifact));
  }
  for (const lineOrdinal of detectSourceMathContentGaps(kept.join('\n'))) {
    notices.push(issue(
      'source_math_content_gap',
      lineOrdinal,
      'notice',
      NOTICE_MESSAGES.source_math_content_gap
    ));
  }

  // UI·작성 지시처럼 본문이 아닌 행만 제외한 상태를 별도로 남긴다.
  // 모델 입력용 레이아웃 복구가 잘못되더라도 최종 감사가 이미 손상된
  // 텍스트를 원문으로 오인하지 않도록 하는 무결성 기준선이다.
  const joinedIntegrityText = kept.join('\n').trim();
  const creativeLineLayout = looksLikeCreativeLineLayout(joinedIntegrityText);
  const integrityText = creativeLineLayout
    ? joinedIntegrityText
    : joinedIntegrityText.replace(/\n{3,}/gu, '\n\n');
  const layoutRepair = repairSourceLayoutArtifacts(integrityText);
  for (const change of layoutRepair.changes) {
    notices.push(issue(change.code, change.lineOrdinal, change.action || 'repaired', change.message));
  }
  const sanitized = (creativeLineLayout
    ? layoutRepair.text
    : layoutRepair.text.replace(/\n{3,}/gu, '\n\n')).trim();
  const usable = sanitized || original;
  if (!sanitized) {
    const fallbackNotices = [...removals, ...notices].map(item => ({ ...item, action: 'notice' }));
    const issues = aggregateIssues(fallbackNotices);
    return {
      ...emptyResult(original),
      integrityText: integrityText || original,
      noticeCount: fallbackNotices.length,
      issueCount: issues.reduce((sum, item) => sum + item.count, 0),
      issueCodes: issues.map(item => item.code),
      issues,
      warnings: buildWarnings(fallbackNotices)
    };
  }

  const lastContentIndex = findLastContentLine(kept);
  if (lastContentIndex >= 0 && isPossiblyIncompleteSentence(kept[lastContentIndex])) {
    notices.push(issue('source_incomplete_sentence', lastContentIndex + 1, 'notice', NOTICE_MESSAGES.source_incomplete_sentence));
  } else if (lastContentIndex >= 0 && isPossiblyMissingTerminalPunctuation(kept[lastContentIndex])) {
    notices.push(issue(
      'source_missing_terminal_punctuation',
      lastContentIndex + 1,
      'notice',
      NOTICE_MESSAGES.source_missing_terminal_punctuation
    ));
  }
  if (hasUnclosedPairs(usable)
      && !notices.some(item => item.code === 'source_unclosed_delimiter')) {
    notices.push(issue(
      'source_unclosed_delimiter',
      Math.max(1, lastContentIndex + 1),
      'notice',
      NOTICE_MESSAGES.source_unclosed_delimiter
    ));
  }
  const issues = aggregateIssues([...removals, ...notices]);
  return {
    version: VERSION,
    text: usable,
    integrityText: integrityText || usable,
    changed: usable !== original,
    removedLineCount: removals.length,
    removedArtifactCount: removals.length,
    noticeCount: notices.length,
    issueCount: issues.reduce((sum, item) => sum + item.count, 0),
    issueCodes: issues.map(item => item.code),
    issues,
    warnings: buildWarnings([...removals, ...notices])
  };
}

/**
 * 입력창·PDF·CSV에서 생긴 구조 손상만 모델 호출 전에 복구한다. 문자 내용과
 * 순서는 바꾸지 않고 줄 경계와 경계 공백만 조정한다. 코드 펜스, 목록, 표,
 * 조문, 인용 행은 건드리지 않는다.
 */
function repairSourceLayoutArtifacts(value) {
  const before = String(value || '').replace(/\r\n?/gu, '\n');
  const creativeLayout = looksLikeCreativeLineLayout(before);
  // 시·창작문의 행갈이는 문장부호보다 강한 장르 구조다. 일부 시행에
  // `. 2. 단어`가 있다는 이유로 절 제목 경계를 삽입하면 이후 creative
  // 감사도 이미 손상된 행을 기준선으로 보게 된다. creative 판정 뒤에는
  // 개별 복구기를 일부만 건너뛰지 말고 레이아웃 수리 전체를 우회한다.
  if (creativeLayout) {
    return { text: before, changed: false, changes: [] };
  }
  const punctuation = repairIsolatedTerminalPunctuationLines(before);
  const heading = repairInlineHeadingBoundaries(punctuation.text);
  const wrapped = repairForcedProseWraps(heading.text);
  const sentenceSpacing = repairMissingSentenceSpacing(wrapped.text);
  const structurallySafe = preservesExistingStructuralLines(before, sentenceSpacing.text);
  const finalText = structurallySafe ? sentenceSpacing.text : before;
  const appliedChanges = structurallySafe
    ? [
        ...punctuation.changes,
        ...heading.changes,
        ...wrapped.changes,
        ...sentenceSpacing.changes
      ]
    : [{
        code: 'source_layout_repair_skipped',
        lineOrdinal: 1,
        action: 'notice',
        message: '표·제목·인용 등 원문 구조 행을 줄일 수 있는 레이아웃 복구를 적용하지 않았어요.'
      }];
  return {
    text: finalText,
    changed: finalText !== before,
    changes: appliedChanges
  };
}

function hasTemplatePlaceholder(value) {
  const text = String(value || '');
  return /\[(?=[^\]\n]{1,140}\])(?:\s*(?:예|예시)\s*[:：]|본인(?:의|이)?\s+[^\]\n]{0,80}(?:작성|입력|서술)|[^\]\n]{0,80}(?:작성해\s*주세요|입력해\s*주세요|내용\s*입력))[^\]\n]*\]/iu.test(text)
    || /<(?:기관명|학교명|회사명|직무명|성명|날짜|내용)>/u.test(text)
    || /\{\{(?:기관명|학교명|회사명|직무명|성명|날짜|내용)\}\}/u.test(text);
}

function preservesExistingStructuralLines(before, after) {
  const structuralRoles = new Set(['title', 'heading', 'table', 'quote', 'code', 'legal_clause', 'signature', 'flow']);
  const sourceRecords = layoutStructure.buildLineRecords(before)
    .filter(record => {
      if (record.blank) return false;
      const role = String(record.role || '');
      if (role === 'heading' && looksLikeFusedStructuralLine(record.text)) return false;
      if (role === 'title') {
        const tail = (String(record.text || '').match(/[가-힣A-Za-z]+$/u) || [''])[0];
        // 첫 강제개행 조각은 문맥 없는 title 휴리스틱에 자주 걸린다.
        if (FORCE_WRAP_TAIL_RE.test(tail)) return false;
      }
      if (structuralRoles.has(role)) return true;
      // 명시 불릿은 한 행 소유권을 지키되 번호형 fused heading은 정상적인
      // 제목 분리 대상이므로 exact ledger에 넣지 않는다.
      return role === 'list' && /^(?:[-*+•▪◦·●○■□◆◇▶▷※])\s+/u.test(String(record.text || ''));
    });
  if (!sourceRecords.length) return true;
  const outputRecords = layoutStructure.buildLineRecords(after)
    .filter(record => !record.blank)
    .map(record => ({ record, key: structuralLineKey(record.raw || record.text) }))
    .filter(item => item.key);
  let cursor = 0;
  for (const record of sourceRecords) {
    const key = structuralLineKey(record.raw || record.text);
    const found = outputRecords.findIndex((item, index) => index >= cursor && item.key === key);
    if (found < 0) return false;
    const outputRecord = outputRecords[found].record;
    if (record.role === 'table'
        && (Number(outputRecord.cellCount || 0) < Number(record.cellCount || 0)
          || (record.tabularSeparator === 'tab' && outputRecord.tabularSeparator !== 'tab'))) {
      return false;
    }
    cursor = found + 1;
  }
  return true;
}

function looksLikeFusedStructuralLine(value) {
  const text = String(value || '').trim();
  if (text.length < 80) return false;
  const markerCount = (text.match(/(?:^|[.!?。！？]\s*)(?:\d{1,2}(?:\.\d{1,2})*[.)]?|[①-⑳]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)．]?|[IVX]{1,8}[.)．])\s*(?:서론|본론|결론|초록|요약|[가-힣A-Za-z])/gu) || []).length;
  return markerCount >= 2
    || /^(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+|[IVX]{1,8})[.)．]\s*(?:서론|본론|결론)(?=[가-힣A-Za-z])/u.test(text);
}

function structuralLineKey(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, '').trim();
}

/**
 * PDF·OCR 내보내기에서 종결점만 다음 행으로 밀린 입력을 감사 기준 전에
 * 복구한다. 독립 기호를 임의 삭제하지 않고, 앞 행이 실제 완결 산문이며
 * 종결부호만 빠진 경우에만 그 행 끝으로 되돌린다.
 */
function repairIsolatedTerminalPunctuationLines(value) {
  const lines = String(value || '').replace(/\r\n?/gu, '\n').split('\n');
  const output = [];
  const changes = [];
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index] || '');
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/u);
    if (fenceMatch) {
      if (!fence) fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      else if (fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length) fence = null;
      output.push(line);
      continue;
    }
    const punctuation = line.trim();
    if (!fence && /^(?:[.。]|[!?！？])$/u.test(punctuation)) {
      let previousIndex = output.length - 1;
      while (previousIndex >= 0 && !String(output[previousIndex] || '').trim()) previousIndex -= 1;
      const previous = previousIndex >= 0 ? String(output[previousIndex] || '') : '';
      const role = layoutStructure.classifyLine(previous);
      if (['prose', 'list', 'label_inline'].includes(role)
          && isPossiblyMissingTerminalPunctuation(previous)) {
        output[previousIndex] = `${previous.trimEnd()}${punctuation}`;
        changes.push({
          code: 'source_isolated_terminal_punctuation_repaired',
          lineOrdinal: index + 1,
          message: '별도 행으로 밀린 문장 종결부호를 앞 문장 끝에 복원했어요.'
        });
        continue;
      }
    }
    output.push(line);
  }
  return { text: output.join('\n'), changes };
}

function looksLikeCreativeLineLayout(value) {
  const text = String(value || '').replace(/\r\n?/gu, '\n');
  if (/^\s*(?:`{3,}|~{3,})/mu.test(text)) return false;
  const lines = text.split('\n');
  const nonEmpty = lines.map(line => line.trim()).filter(Boolean);
  const blankCount = lines.length - nonEmpty.length;
  if (nonEmpty.length < 5 || blankCount < 1) return false;
  const lengths = nonEmpty.map(line => [...line].length).sort((a, b) => a - b);
  const medianLength = lengths[Math.floor(lengths.length / 2)] || 0;
  const shortRatio = lengths.filter(length => length <= 42).length / nonEmpty.length;
  const longLineCount = lengths.filter(length => length >= 80).length;
  const terminalRatio = nonEmpty.filter(line => /[.!?。！？][”’"'」』》〉)\]]*$/u.test(line)).length / nonEmpty.length;
  const structuralRatio = nonEmpty.filter(line => (
    /^(?:#{1,6}\s+|[-*+•▪◦·●○■□◆◇▶▷※]\s+|\d{1,3}[.)]\s+|[①-⑳]\s+|제\s*\d+\s*(?:장|절|항|조))/u.test(line)
    || /\t/u.test(line)
    || /^\|.*\|$/u.test(line)
  )).length / nonEmpty.length;
  const compactPoem = nonEmpty.length < 8;
  return shortRatio >= (compactPoem ? 0.84 : 0.72)
    && medianLength <= 32
    && terminalRatio <= (compactPoem ? 0.2 : 0.35)
    && structuralRatio <= 0.2
    && longLineCount <= (compactPoem ? 0 : 1);
}

function extractQuotedRewritePayload(value) {
  const source = String(value || '').trim();
  const open = source[0];
  const close = open === '“' ? '”' : (open === '"' ? '"' : '');
  if (!close || source.length < 100) return null;
  let closeIndex = source.lastIndexOf(close);
  while (closeIndex > 0) {
    const tail = source.slice(closeIndex + 1).trim();
    const payload = source.slice(1, closeIndex).trim();
    const rewriteTail = tail && REMOVABLE_LINE_RULES.some(rule => (
      rule.code === 'source_rewrite_request_artifact' && rule.pattern.test(tail)
    ));
    if (rewriteTail && payload.length >= 80) {
      return { payload, instruction: tail, wrapper: `${open}${close}` };
    }
    closeIndex = source.lastIndexOf(close, closeIndex - 1);
  }
  return null;
}

/**
 * 입력창·CSV 셀에서 긴 본문 전체가 단순 문자열처럼 큰따옴표 한 쌍에
 * 감싸져 들어오는 경우가 있다. 이를 직접 인용으로 잠그면 일반 산문이
 * 전부 편집 불가가 된다. 한 행의 장문 전체를 감싸고 완결 문장이 둘
 * 이상인 경우에만 작성용 래퍼로 보며, 「책 제목」·짧은 발화·여러 줄
 * 대화는 직접 인용으로 남긴다.
 */
function extractDocumentQuoteWrapper(value) {
  const source = String(value || '').trim();
  if (source.includes('\n') || source.length < 160) return null;
  const open = source[0];
  const close = open === '“' ? '”' : (open === '"' ? '"' : '');
  if (!close || source.at(-1) !== close) return null;
  const payload = source.slice(1, -1).trim();
  if (payload.length < 150) return null;
  const terminalCount = (payload.match(/[.!?。！？](?=$|\s|[”’"'」』》〉)])/gu) || []).length;
  if (terminalCount < 2) return null;
  return { payload, wrapper: `${open}${close}`, kind: 'document_quote_wrapper' };
}

function repairInlineHeadingBoundaries(value) {
  const lines = String(value || '').split('\n');
  const output = [];
  const changes = [];
  let fence = null;
  lines.forEach((line, index) => {
    const fenceMatch = String(line || '').match(/^\s*(`{3,}|~{3,})/u);
    if (fenceMatch) {
      if (!fence) fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      else if (fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length) fence = null;
      output.push(line);
      return;
    }
    if (fence || isWholeQuotedLine(line)) {
      output.push(line);
      return;
    }
    // `1. ① 2. ③ 3. ②`처럼 한 행으로 제시된 정답표의 마침표는
    // 문장 종결이나 다음 절 제목이 아니다. 번호마다 줄을 삽입하면 정답
    // 대응 구조 자체가 훼손되므로 이 형식은 그대로 보존한다.
    if (isCompactAnswerKeyLine(line)) {
      output.push(line);
      return;
    }

    let repaired = String(line || '');
    // 한 행에 `2. 본론① ...② ...4. 결론본문`처럼 경계가 여러 개
    // 무너진 경우가 있다. 앞 경계를 복원한 뒤 새로 드러난 행에도 같은
    // 판정을 적용하되, 최대 네 번에서 멈춰 정상 원문을 반복 변형하지 않는다.
    for (let pass = 0; pass < 4; pass += 1) {
      const previous = repaired;
      repaired = transformOutsideWebLiterals(
        repaired,
        text => text
          .replace(INLINE_HEADING_BEFORE_RE, replaceInlineHeadingBoundary)
          .replace(INLINE_KNOWN_HEADING_ANYWHERE_RE, '\n\n')
      );
      repaired = repaired.split('\n').map(piece => {
        if (INLINE_HEADING_AFTER_RE.test(piece)) return piece.replace(INLINE_HEADING_AFTER_RE, '$1\n');
        const spacedHeading = piece.match(INLINE_HEADING_SPACED_BODY_RE);
        if (spacedHeading && shouldSplitSpacedHeadingBody(spacedHeading[3])) {
          return `${spacedHeading[1]}\n${spacedHeading[3]}`;
        }
        if (INLINE_CIRCLED_QUOTED_HEADING_RE.test(piece)) {
          return piece.replace(INLINE_CIRCLED_QUOTED_HEADING_RE, '$1\n');
        }
        if (INLINE_CIRCLED_COLON_HEADING_RE.test(piece)) {
          return piece.replace(INLINE_CIRCLED_COLON_HEADING_RE, '$1\n');
        }
        if (INLINE_DAMAGED_TABLE_HEADING_RE.test(piece)) {
          return piece.replace(INLINE_DAMAGED_TABLE_HEADING_RE, '$1\n');
        }
        const parentheticalHeading = splitCircledParentheticalHeadingBody(piece);
        if (parentheticalHeading) return parentheticalHeading;
        const quotedHeading = splitCircledQuotedHeadingBody(piece);
        if (quotedHeading) return quotedHeading;
        const dashHeading = splitNumberedDashHeadingBody(piece);
        if (dashHeading) return dashHeading;
        const finiteHeading = splitNumberedFiniteHeadingBody(piece);
        if (finiteHeading) return finiteHeading;
        const genericHeading = splitGenericNumberedHeadingBody(piece);
        if (genericHeading) return genericHeading;
        return piece;
      }).join('\n');
      if (repaired === previous) break;
    }
    if (repaired !== line && isUnsafeHeadingRepair(line, repaired)) {
      repaired = line;
      changes.push({
        code: 'source_layout_repair_skipped',
        lineOrdinal: index + 1,
        action: 'notice',
        message: '절 번호나 한국어 어절을 훼손할 수 있는 자동 경계 복구를 적용하지 않았어요.'
      });
    }
    if (repaired !== line) {
      changes.push({
        code: 'source_inline_heading_repaired',
        lineOrdinal: index + 1,
        message: '본문에 붙어 있던 절 번호와 제목 경계를 복원했어요.'
      });
    }
    output.push(repaired);
  });
  return { text: output.join('\n'), changes };
}

function replaceInlineHeadingBoundary(match, terminal, marker, offset, whole) {
  const boundary = Number(offset) + String(match || '').length;
  if (isCalendarDateContinuation(whole, boundary, marker)) return match;
  return `${terminal}\n\n`;
}

// `2026. 8. 30.`과 `2026. 8. ~ 11. 30.`의 마지막 일자는 절 번호와
// 표면형이 같다. 앞쪽에 연·월 또는 연·월~월 맥락이 완성돼 있으면 제목
// 경계로 분리하지 않는다. `2. 4차 산업혁명`은 이 맥락이 없으므로 기존
// 절 제목 복구를 그대로 탄다.
function isCalendarDateContinuation(value, boundary, marker) {
  if (!/^\d{1,2}[.)]$/u.test(String(marker || '').trim())) return false;
  const prefix = String(value || '').slice(Math.max(0, Number(boundary) - 48), Number(boundary));
  return /(?:19|20)\d{2}\.\s*\d{1,2}\.\s*$/u.test(prefix)
    || /(?:19|20)\d{2}\.\s*\d{1,2}\.\s*(?:~|～|-|–|—)\s*\d{1,2}\.\s*$/u.test(prefix);
}

/**
 * 번역 병기 소제목의 닫는 괄호는 신뢰할 수 있는 경계다.
 * `① 에릭슨(Erikson)의 이론`처럼 조사로 이어지는 정상 문장은 제외하고,
 * 영어 병기 뒤에 완결 산문이 공백 없이 붙은 경우만 줄을 복원한다.
 */
function splitCircledParentheticalHeadingBody(value) {
  const source = String(value || '');
  const match = source.match(
    /^(\s*[①-⑳]\s*[^.!?。！？\n]{2,120}\([A-Za-z][A-Za-z0-9 /&+·-]{2,100}\))([가-힣A-Z][\s\S]{25,})$/u
  );
  if (!match || /^[은는이가을를와과의에도로만]/u.test(match[2])) return null;
  return looksLikeFusedProse(match[2]) ? `${match[1]}\n${match[2]}` : null;
}

function normalizeSourceLineSeparators(value) {
  return String(value || '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u000b\u000c\u0085\u2028\u2029]/gu, '\n');
}

/**
 * OCR이 `1. 소제목본문 첫 문장...`처럼 줄 경계만 지운 경우를 복구한다.
 * 임의의 어휘 목록이 아니라 보고서 제목에서 반복되는 명사형 종결과,
 * 그 뒤에 공백 없이 붙은 충분히 긴 완결 산문을 함께 요구한다. 따라서
 * 정상적인 `1. 개념 및 정의` 같은 복합 제목은 분리하지 않는다.
 */
function splitGenericNumberedHeadingBody(value) {
  const source = String(value || '');
  const match = source.match(GENERIC_NUMBERED_HEADING_RE);
  if (!match) return null;
  const marker = match[1];
  const rest = match[2];
  if (rest.length < 45) return null;

  GENERIC_HEADING_END_RE.lastIndex = 0;
  let candidate = null;
  for (const ending of rest.matchAll(GENERIC_HEADING_END_RE)) {
    const end = Number(ending.index) + ending[0].length;
    const title = rest.slice(0, end);
    const prose = rest.slice(end);
    if (title.length < 2 || title.length > 110) continue;
    // 경계에 공백이 있으면 두 어절은 애초에 붙어 있지 않다.
    if (!/^[가-힣A-Z]/u.test(prose)) continue;
    if (/^(?:은|는|이|가|을|를|와|과|의|도|만|에|에서|으로|로|에게|께서|부터|까지|보다)(?=$|\s|[,.;:!?。！？])/u.test(prose)) continue;
    if (/^(?:적|성|화|론|학|형|별|상|물|값|표)/u.test(prose)) continue;
    if (!looksLikeFusedProse(prose)) continue;
    candidate = { title, prose };
  }
  return candidate ? `${marker}${candidate.title}\n${candidate.prose}` : null;
}

/**
 * OCR 경계 복구는 문자 내용을 바꾸면 안 된다. 특히 `11.`을 `1`과
 * `1.`로 분리하거나, 제목 후보 명사 뒤의 조사를 새 행으로 밀어내는
 * 경우에는 해당 행의 복구 전체를 취소한다.
 */
function isUnsafeHeadingRepair(source, repaired) {
  const numbers = compareNumberMultiset(source, repaired);
  if (numbers.changed) return true;
  return countOrphanParticleBoundaries(repaired) > countOrphanParticleBoundaries(source);
}

function countOrphanParticleBoundaries(value) {
  return (
    String(value || '').match(
      /[가-힣]\s*\n+\s*(?:은|는|이|가|을|를|와|과|의|도|만|에|에서|으로|로|에게|께서|부터|까지|보다)(?=$|\s|[,.;:!?。！？])/gu
    ) || []
  ).length;
}

/**
 * `4. 제목 - 신경과학적 접근 생명과학을 …`처럼 대시형 제목과 본문 사이의
 * 줄만 사라진 경우를 복구한다. 닫힌 작품명 또는 제목형 명사 뒤에
 * 주제·목적 조사가 붙은 충분한 산문이 이어질 때만 적용한다.
 */
function splitNumberedDashHeadingBody(value) {
  const source = String(value || '');
  const match = source.match(GENERIC_NUMBERED_HEADING_RE);
  if (!match) return null;
  const marker = match[1];
  const rest = match[2];
  const dashIndex = rest.search(/\s[-–—]\s/u);
  if (dashIndex < 2 || rest.length < 60) return null;
  const candidates = [];
  for (const ending of rest.matchAll(/[>》〉」』”’"]/gu)) {
    const end = Number(ending.index) + ending[0].length;
    if (end <= dashIndex || end > 115) continue;
    candidates.push(end);
  }
  for (const ending of rest.matchAll(/(?:접근|관점|고찰|분석|원리|역할|기능|영향|관계|구조|사례|전략|방법|결과|의미)/gu)) {
    const end = Number(ending.index) + ending[0].length;
    if (end <= dashIndex || end > 115) continue;
    candidates.push(end);
  }
  for (const end of [...new Set(candidates)].sort((a, b) => a - b)) {
    if (!/^[ \t]+/u.test(rest.slice(end))) continue;
    const prose = rest.slice(end).trimStart();
    if (!/^[가-힣A-Za-z0-9]{2,24}(?:은|는|이|가|을|를|에서|으로|에게)(?:\s|,)/u.test(prose)
        && !/^[가-힣A-Za-z]{2,24},\s/u.test(prose)) continue;
    if (!looksLikeFusedProse(prose)) continue;
    return `${marker}${rest.slice(0, end).trimEnd()}\n${prose}`;
  }
  return null;
}

/**
 * `5. … 예술이 시작된다 생명과학은 …`처럼 완결형 제목 뒤 본문이 같은
 * 행에 남은 경우다. 제목 종결은 앞 110자 안, 본문은 조사형 주어와
 * 완결 문장을 함께 가져야 하므로 일반 번호 문장을 임의 분리하지 않는다.
 */
function splitNumberedFiniteHeadingBody(value) {
  const source = String(value || '');
  const match = source.match(GENERIC_NUMBERED_HEADING_RE);
  if (!match) return null;
  const marker = match[1];
  const rest = match[2];
  if (rest.length < 40) return null;
  const boundary = /(?:시작된다|끝난다|드러난다|이어진다|필요하다|중요하다|무엇인가|어디에서\s*오는가|왜\s*그런가)(?=[ \t]+)/gu;
  for (const ending of rest.matchAll(boundary)) {
    const end = Number(ending.index) + ending[0].length;
    if (end < 6 || end > 110) continue;
    const prose = rest.slice(end).trimStart();
    if (!/^[가-힣A-Za-z0-9]{2,24}(?:은|는|이|가|을|를)(?:\s|,)/u.test(prose)) continue;
    const shortCompleteProse = prose.length >= 12
      && prose.split(/\s+/u).filter(Boolean).length >= 3
      && /[.!?。！？]\s*[”’"'」』》〉)\]]*$/u.test(prose);
    if (!looksLikeFusedProse(prose) && !shortCompleteProse) continue;
    return `${marker}${rest.slice(0, end).trimEnd()}\n${prose}`;
  }
  return null;
}

/**
 * `④ 제품군 → "전략 제목"본문...` 유형은 닫는 따옴표가 명확한 경계다.
 * 다만 `"용어"의 의미`, `'어서 오세요'는` 같은 정상 조사 연결은 제외한다.
 */
function splitCircledQuotedHeadingBody(value) {
  const source = String(value || '');
  const match = source.match(
    /^(\s*[①-⑳]\s*[^\n]{0,120}?(?:"[^"\n]{1,120}"|“[^”\n]{1,120}”|'[^'\n]{1,120}'|‘[^’\n]{1,120}’))([가-힣A-Z][\s\S]{25,})$/u
  );
  if (!match || /^[은는이가을를와과의에도로만]/u.test(match[2])) return null;
  return looksLikeFusedProse(match[2]) ? `${match[1]}\n${match[2]}` : null;
}

function looksLikeFusedProse(value) {
  const text = String(value || '').trim();
  if (text.length < 25 || text.split(/\s+/u).filter(Boolean).length < 5) return false;
  return /[.!?。！？]/u.test(text)
    || /(?:다|요|니다|한다|된다|있다|없다|않다|했다|하였다|되었다)(?:\s|$)/u.test(text);
}

function shouldSplitSpacedHeadingBody(value) {
  const rest = String(value || '').trim();
  if (!rest || /^(?:[:：]|[([]\s*\d|[（【]\s*\d|[-–—]\s*\S)/u.test(rest)) return false;
  // `2. 본론 (1) 서울과 작품의 관계` 같은 복합 제목은 그대로 두고,
  // `1. 서론 본 보고서에서는 … 설명한다.`처럼 완결 산문이 같은 행에
  // 붙은 경우만 경계를 복원한다.
  return rest.length >= 45
    || (rest.length >= 10 && /[.!?。！？]\s*[”’"'」』》〉)\]]*$/u.test(rest));
}

function isCompactAnswerKeyLine(value) {
  const text = String(value || '').trim();
  const matches = text.match(/\d{1,3}[.)]\s*(?:[①-⑳]|[A-Ea-e]|[OXox○×])(?=$|\s)/gu) || [];
  return matches.length >= 2
    && text.replace(/\d{1,3}[.)]\s*(?:[①-⑳]|[A-Ea-e]|[OXox○×])(?=$|\s)/gu, '').trim().length === 0;
}

function repairForcedProseWraps(value) {
  const lines = String(value || '').split('\n');
  const contextualRecords = layoutStructure.buildLineRecords(value);
  const output = [];
  const changes = [];
  let fence = null;
  let index = 0;
  while (index < lines.length) {
    let current = String(lines[index] || '');
    const fenceMatch = current.match(/^\s*(`{3,}|~{3,})/u);
    if (fenceMatch) {
      if (!fence) fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      else if (fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length) fence = null;
      output.push(current);
      index += 1;
      continue;
    }
    if (fence || index + 1 >= lines.length) {
      output.push(current);
      index += 1;
      continue;
    }
    const next = String(lines[index + 1] || '');
    if (shouldJoinForcedWrap(current, next, {
      leftRole: contextualRecords[index]?.role,
      rightRole: contextualRecords[index + 1]?.role
    })) {
      const left = current.trimEnd();
      const right = next.trimStart();
      const separator = shouldAttachWithoutSpace(left, right) ? '' : ' ';
      current = `${left}${separator}${right}`;
      lines[index + 1] = current;
      changes.push({
        code: 'source_forced_linewrap_repaired',
        lineOrdinal: index + 1,
        message: 'PDF나 화면 폭 때문에 문장 중간에서 끊긴 줄을 다시 이었어요.'
      });
      index += 1;
      continue;
    }
    output.push(current);
    index += 1;
  }
  if (index === lines.length && lines.length && output[output.length - 1] !== lines[lines.length - 1]) {
    output.push(lines[lines.length - 1]);
  }
  return { text: output.join('\n'), changes };
}

function repairMissingSentenceSpacing(value) {
  const lines = String(value || '').split('\n');
  const output = [];
  const changes = [];
  let fence = null;
  lines.forEach((line, index) => {
    const fenceMatch = String(line || '').match(/^\s*(`{3,}|~{3,})/u);
    if (fenceMatch) {
      if (!fence) fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      else if (fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length) fence = null;
      output.push(line);
      return;
    }
    if (fence) {
      output.push(line);
      return;
    }
    const repaired = transformOutsideWebLiterals(
      String(line || ''),
      text => text.replace(
        // 닫는 따옴표를 새 문장의 여는 따옴표로 오인해 `문장. "`처럼
        // 원문에 없던 공백을 만들지 않는다. 닫는 부호가 있으면 부호까지
        // 소비한 뒤 실제 한글·영문 문장이 바로 이어질 때만 띄운다.
        /([가-힣][.!?。！？](?:[”’"'」』》〉)])?)(?=[가-힣A-Z(])/gu,
        '$1 '
      )
    );
    if (repaired !== line) {
      changes.push({
        code: 'source_sentence_spacing_repaired',
        lineOrdinal: index + 1,
        message: '문장부호 뒤에 빠진 문장 사이 공백을 복원했어요.'
      });
    }
    output.push(repaired);
  });
  return { text: output.join('\n'), changes };
}

function shouldJoinForcedWrap(leftValue, rightValue, context = {}) {
  const left = String(leftValue || '').trim();
  const right = String(rightValue || '').trim();
  if (!left || !right) return false;
  if (STRUCTURAL_LINE_RE.test(left) || STRUCTURAL_LINE_RE.test(right)) return false;
  // `자동 관개 시스템:`처럼 콜론 라벨로 시작하는 다음 행은 앞 문장이
  // 마침표 없이 끝났더라도 독립 구조다. 길이만 보고 합치면 항목명이 앞
  // 문장의 목적어처럼 붙고 이후 청크·문단 구조까지 연쇄적으로 무너진다.
  const leftRole = String(context.leftRole || layoutStructure.classifyLine(left));
  const rightRole = String(context.rightRole || layoutStructure.classifyLine(right));
  const leftToken = (left.match(/[가-힣A-Za-z]+$/u) || [''])[0];
  const weakTitleFragment = leftRole === 'title' && FORCE_WRAP_TAIL_RE.test(leftToken);
  if ((!weakTitleFragment && ['title', 'heading', 'label', 'label_inline', 'list', 'table', 'flow', 'quote', 'code', 'legal_clause', 'signature'].includes(leftRole))
      || ['title', 'heading', 'label', 'label_inline', 'list', 'table', 'flow', 'quote', 'code', 'legal_clause', 'signature'].includes(rightRole)) {
    return false;
  }
  if (isWholeQuotedLine(left) || isWholeQuotedLine(right)
      || isQuoteAttributionLine(left) || isQuoteAttributionLine(right)) return false;
  if (WEB_LITERAL_TEST_RE.test(left) || WEB_LITERAL_TEST_RE.test(right)) return false;
  if (/^\s*(?:`{3,}|~{3,})/u.test(left) || /^\s*(?:`{3,}|~{3,})/u.test(right)) return false;
  if (/[.!?。！？…,:;：；]\s*[”’"'」』》〉)\]]*$/u.test(left)) return false;
  if (!/^[가-힣A-Za-z0-9(“"'‘「『《〈]/u.test(right)) return false;
  if (!leftToken) return false;
  // OCR이 한글 어절과 조사를 서로 다른 행으로 자른 경우다. 다음 행이
  // 조사로 시작하는 것은 독립 문단일 수 없으므로 짧은 왼쪽 어절도 잇는다.
  if (/[가-힣]$/u.test(leftToken) && RIGHT_STANDALONE_PARTICLE_RE.test(right)) return true;
  if (/[가-힣]$/u.test(leftToken)
      && !/(?:은|는|이|가|을|를|의|와|과|도|만|에|로)$/u.test(leftToken)
      && RIGHT_WORD_CONTINUATION_RE.test(right)) return true;
  if (FORCE_WRAP_TAIL_RE.test(leftToken)) return true;
  // PDF의 고정 폭 줄바꿈은 대체로 긴 행 여러 개가 문장부호 없이 이어진다.
  // 매우 짧은 독립 행은 시·제목일 수 있으므로 이 일반 규칙에서 제외한다.
  return left.length >= 48 && right.length >= 12;
}

function shouldAttachWithoutSpace(left, right) {
  if (!/[가-힣]$/u.test(left) || !/^[가-힣]/u.test(right)) return false;
  if (RIGHT_STANDALONE_PARTICLE_RE.test(right)) return true;
  const leftToken = (String(left).match(/[가-힣]+$/u) || [''])[0];
  if (!leftToken || /(?:은|는|이|가|을|를|의|와|과|도|만|에|로)$/u.test(leftToken)) return false;
  return RIGHT_WORD_CONTINUATION_RE.test(right);
}

function isWholeQuotedLine(value) {
  const text = String(value || '').trim();
  return /^(?:“[^”\n]+”|‘[^’\n]+’|"[^"\n]+"|'[^'\n]+'|「[^」\n]+」|『[^』\n]+』|《[^》\n]+》|〈[^〉\n]+〉)$/u.test(text);
}

function isQuoteAttributionLine(value) {
  const text = String(value || '').trim();
  return /^(?:“[^”\n]+”|‘[^’\n]+’|"[^"\n]+"|'[^'\n]+'|「[^」\n]+」|『[^』\n]+』|《[^》\n]+》|〈[^〉\n]+〉)\s*[-–—]\s*\S.{0,120}$/u.test(text);
}

function transformOutsideWebLiterals(value, transform) {
  const source = String(value || '');
  const literals = [];
  const protectedText = source.replace(WEB_LITERAL_RE, match => {
    const token = `\uE000${literals.length}\uE001`;
    literals.push(match);
    return token;
  });
  const transformed = typeof transform === 'function' ? transform(protectedText) : protectedText;
  return String(transformed).replace(/\uE000(\d+)\uE001/gu, (_match, ordinal) => (
    literals[Number(ordinal)] ?? _match
  ));
}

function isBoundaryContentLine(lines, index) {
  const contentIndexes = (lines || [])
    .map((line, lineIndex) => String(line || '').trim() ? lineIndex : -1)
    .filter(lineIndex => lineIndex >= 0);
  if (!contentIndexes.length) return false;
  const position = contentIndexes.indexOf(index);
  return position >= 0 && (position <= 1 || position >= contentIndexes.length - 2);
}

function isQuotedInstructionLine(value) {
  const text = String(value || '').trim();
  return /^(?:>|[“"'‘「『《〈])/u.test(text)
    || /[”"'’」』》〉]\s*$/u.test(text);
}

function hasUnbalancedMarkdown(value) {
  const text = String(value || '');
  return countLiteral(text, '**') % 2 === 1 || countLiteral(text, '__') % 2 === 1;
}

function analyzeFences(lines) {
  let active = null;
  let openingIndex = -1;
  const unbalancedLineIndexes = [];
  const protectedLineIndexes = new Set();
  for (let index = 0; index < (lines || []).length; index += 1) {
    const match = String(lines[index] || '').match(/^\s*(`{3,}|~{3,})/u);
    if (active) protectedLineIndexes.add(index);
    if (!match) continue;
    if (!active) {
      active = { char: match[1][0], length: match[1].length };
      openingIndex = index;
      protectedLineIndexes.add(index);
    } else if (match[1][0] === active.char && match[1].length >= active.length) {
      active = null;
      openingIndex = -1;
    }
  }
  if (active && openingIndex >= 0) unbalancedLineIndexes.push(openingIndex);
  return { balanced: !active, unbalancedLineIndexes, protectedLineIndexes };
}

function isPossiblyTruncatedReference(value) {
  const text = String(value || '').trim();
  if (!text || freezeBlocks.isRefHeadingLine(text)) return false;
  if (/[,;:([{]\s*$/u.test(text)) return true;
  return hasUnclosedPairs(text);
}

function isPossiblyIncompleteSentence(value) {
  const text = String(value || '').trim();
  if (text.length < 8 || /[.!?。！？…"'”’」』】)\]]\s*$/u.test(text)) return false;
  if (/^(?:참고\s*문헌|참고\s*자료|부록|Appendix|\d+(?:\.\d+)*[.)]?\s+\S+)/iu.test(text)) return false;
  return /(?:은|는|이|가|을|를|의|에|와|과|및|그리고|그러나|하지만|통해|위해|때문에|따라|대한|관한)$/u.test(text);
}

function isPossiblyMissingTerminalPunctuation(value) {
  const text = String(value || '').trim();
  if (text.length < 12 || /[.!?。！？…"'”’」』】)\]]\s*$/u.test(text)) return false;
  if (/^(?:#{1,6}\s+|참고\s*문헌|참고\s*자료|부록|Appendix|제\s*\d+\s*(?:장|절|항|조)|\d+(?:\.\d+)*[.)]?\s+\S+$)/iu.test(text)) return false;
  if (/^(?:[-*+•▪◦·●○■□◆◇▶▷※]|\d{1,3}[.)]|[①-⑳])\s+/u.test(text)) return false;
  return /(?:다|요|죠|까|니다|했다|하였다|되었다|있다|없다|함|됨|임)$/u.test(text);
}

function hasUnclosedPairs(value) {
  const text = String(value || '');
  const pairs = [['(', ')'], ['[', ']'], ['{', '}'], ['「', '」'], ['『', '』']];
  if (pairs.some(([opening, closing]) => countLiteral(text, opening) !== countLiteral(text, closing))) {
    return true;
  }
  // 모바일·워드 붙여넣기에서는 여는 부호는 ASCII이고 닫는 부호만 곡선형인
  // `"인용문”`이 자주 생긴다. 시각적으로 닫힌 이 쌍을 미완성 인용으로
  // 오인하면 모델도 뒤 문단을 인용 내부로 처리해 잘라낼 수 있다.
  const withoutClosedQuotes = text
    .replace(/“[^”"\n]{1,}[”"]|"[^"”\n]{1,}["”]/gu, '')
    .replace(/‘[^’'\n]{1,}[’']|(?<![\p{L}\p{N}])'[^'’\n]{1,}['’]/gu, '');
  if (/[“”‘’]/u.test(withoutClosedQuotes)) return true;
  const bareDoubleQuotes = (withoutClosedQuotes.match(/"/gu) || []).length;
  return bareDoubleQuotes % 2 !== 0;
}

function countLiteral(value, token) {
  if (!token) return 0;
  let count = 0;
  let offset = 0;
  const text = String(value || '');
  while ((offset = text.indexOf(token, offset)) >= 0) {
    count += 1;
    offset += token.length;
  }
  return count;
}

function findLastContentLine(lines) {
  for (let index = (lines || []).length - 1; index >= 0; index -= 1) {
    if (String(lines[index] || '').trim()) return index;
  }
  return -1;
}

// 워드·한글의 수식 개체를 일반 텍스트로 붙여 넣을 때 수식만 사라지고
// 앞뒤 설명, 빈 괄호, 행 연산 해설만 남는 경우를 찾는다. 원문에 없는 식을
// 추측 복원하거나 작업을 차단하지 않고 사용자 확인 알림으로만 기록한다.
function detectSourceMathContentGaps(value) {
  const lines = String(value || '').replace(/\r\n?/gu, '\n').split('\n');
  const ordinals = new Set();
  const mathContext = /(?:수식|방정식|연립방정식|행렬|행렬식|역원|항등원|피벗|기본행\s*연산|미지수|가우스|소거법)/u;
  const missingInline = /(?:역원인\s*[,，]|\(\s*단\s*[,，]\s*\)|(?:영행렬|음행렬|항등행렬|역행렬|행렬)\s+(?:은|는|이|가|을|를|에|와|과)(?=\s|[,，.。()（）])|(?:따라서|그러므로)\s+이라는\s+해)/u;
  const missingOperation = /^\s*\d{1,3}[.)]\s*\([^()\n]{1,180}(?:행|원소|피벗|선행)[^()\n]*\)\s*[:：]\s*$/u;

  lines.forEach((raw, index) => {
    const line = String(raw || '').trim();
    if (!line || !mathContext.test(line)) return;
    if (missingInline.test(line) || missingOperation.test(line)) ordinals.add(index + 1);
  });

  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index] || '').trim();
    if (!/(?:다음과\s*같은|다음)\s+(?:선형\s*)?(?:연립방정식|방정식|수식|첨가행렬|행렬)/u.test(line)) continue;
    let nextIndex = index + 1;
    let crossedBlank = false;
    while (nextIndex < lines.length && !String(lines[nextIndex] || '').trim()) {
      crossedBlank = true;
      nextIndex += 1;
    }
    if (!crossedBlank || nextIndex >= lines.length) continue;
    const next = String(lines[nextIndex] || '').trim();
    if (/^(?:이\s*(?:연립방정식|방정식|수식|첨가행렬|행렬)|이제\s+(?:이\s*)?(?:식|행렬))/u.test(next)) {
      ordinals.add(index + 1);
      ordinals.add(nextIndex + 1);
    }
  }
  return [...ordinals].sort((left, right) => left - right);
}

function issue(code, lineOrdinal, action, message) {
  return { code, lineOrdinal, action, message };
}

function aggregateIssues(items) {
  const grouped = new Map();
  for (const item of items || []) {
    const key = `${item.code}:${item.action}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        code: item.code,
        action: item.action,
        message: item.message,
        count: 0,
        lineOrdinals: []
      });
    }
    const current = grouped.get(key);
    current.count += 1;
    current.lineOrdinals.push(item.lineOrdinal);
  }
  return [...grouped.values()].map(item => ({
    ...item,
    lineOrdinals: [...new Set(item.lineOrdinals)].slice(0, 20)
  }));
}

function buildWarnings(items) {
  return aggregateIssues(items).map(item => ({
    code: item.code,
    severity: 'notice',
    message: item.message,
    action: item.action,
    count: item.count,
    lineOrdinals: item.lineOrdinals
  }));
}

function emptyResult(text) {
  return {
    version: VERSION,
    text: String(text || ''),
    integrityText: String(text || ''),
    changed: false,
    removedLineCount: 0,
    removedArtifactCount: 0,
    noticeCount: 0,
    issueCount: 0,
    issueCodes: [],
    issues: [],
    warnings: []
  };
}

module.exports = {
  VERSION,
  REMOVABLE_LINE_RULES,
  auditAndSanitizeSource,
  extractQuotedRewritePayload,
  extractDocumentQuoteWrapper,
  repairSourceLayoutArtifacts,
  repairIsolatedTerminalPunctuationLines,
  looksLikeCreativeLineLayout,
  repairInlineHeadingBoundaries,
  splitNumberedDashHeadingBody,
  splitNumberedFiniteHeadingBody,
  repairForcedProseWraps,
  repairMissingSentenceSpacing,
  isUnsafeHeadingRepair,
  countOrphanParticleBoundaries,
  transformOutsideWebLiterals,
  hasUnbalancedMarkdown,
  isPossiblyTruncatedReference,
  isPossiblyIncompleteSentence,
  isPossiblyMissingTerminalPunctuation,
  hasUnclosedPairs,
  detectSourceMathContentGaps
};
