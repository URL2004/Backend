'use strict';

const VERSION = 2;

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
    code: 'source_markdown_artifact',
    pattern: /^(?:\*\*|__)$/u,
    message: '내용 없이 남은 마크다운 기호를 본문에서 제외했어요.'
  }
]);

const NOTICE_MESSAGES = Object.freeze({
  source_markdown_artifact: '짝이 맞지 않는 마크다운 기호가 원문에 남아 있을 수 있어요.',
  source_draft_note: '작성 중 메모로 보이는 괄호 문구가 원문에 남아 있어요.',
  source_truncated_reference: '끝이 잘렸을 수 있는 참고문헌 표기가 있어요.',
  source_incomplete_sentence: '마지막 문장이 조사나 연결 표현에서 끝나 미완성일 수 있어요.'
});

function auditAndSanitizeSource(value) {
  const original = String(value || '').replace(/\r\n?/gu, '\n').trim();
  if (!original) return emptyResult('');
  const lines = original.split('\n');
  const removals = [];
  const notices = [];
  const kept = [];
  let inReference = false;
  const fenceState = analyzeFences(lines);

  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index] || '');
    const text = line.trim();
    if (/^(?:참고\s*문헌|참고\s*자료|인용\s*문헌|출처|References|Bibliography|Works\s+Cited)$/iu.test(text)) {
      inReference = true;
    } else if (/^(?:부록|Appendix)(?:\s|$)/iu.test(text)) {
      inReference = false;
    }

    const removable = text && REMOVABLE_LINE_RULES.find(rule => (
      (!rule.boundaryOnly || isBoundaryContentLine(lines, index))
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
    if (inReference && isPossiblyTruncatedReference(text)) {
      notices.push(issue('source_truncated_reference', index + 1, 'notice', NOTICE_MESSAGES.source_truncated_reference));
    }
  }

  for (const lineIndex of fenceState.unbalancedLineIndexes) {
    notices.push(issue('source_markdown_artifact', lineIndex + 1, 'notice', NOTICE_MESSAGES.source_markdown_artifact));
  }

  const sanitized = kept.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
  const usable = sanitized || original;
  if (!sanitized) {
    const fallbackNotices = [...removals, ...notices].map(item => ({ ...item, action: 'notice' }));
    const issues = aggregateIssues(fallbackNotices);
    return {
      ...emptyResult(original),
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
  }
  const issues = aggregateIssues([...removals, ...notices]);
  return {
    version: VERSION,
    text: usable,
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
  for (let index = 0; index < (lines || []).length; index += 1) {
    const match = String(lines[index] || '').match(/^\s*(`{3,}|~{3,})/u);
    if (!match) continue;
    if (!active) {
      active = { char: match[1][0], length: match[1].length };
      openingIndex = index;
    } else if (match[1][0] === active.char && match[1].length >= active.length) {
      active = null;
      openingIndex = -1;
    }
  }
  if (active && openingIndex >= 0) unbalancedLineIndexes.push(openingIndex);
  return { balanced: !active, unbalancedLineIndexes };
}

function isPossiblyTruncatedReference(value) {
  const text = String(value || '').trim();
  if (!text || /^(?:참고\s*문헌|참고\s*자료|인용\s*문헌|출처|References|Bibliography|Works\s+Cited)$/iu.test(text)) return false;
  if (/[,;:([{]\s*$/u.test(text)) return true;
  return hasUnclosedPairs(text);
}

function isPossiblyIncompleteSentence(value) {
  const text = String(value || '').trim();
  if (text.length < 8 || /[.!?。！？…"'”’」』】)\]]\s*$/u.test(text)) return false;
  if (/^(?:참고\s*문헌|참고\s*자료|부록|Appendix|\d+(?:\.\d+)*[.)]?\s+\S+)/iu.test(text)) return false;
  return /(?:은|는|이|가|을|를|의|에|와|과|및|그리고|그러나|하지만|통해|위해|때문에|따라|대한|관한)$/u.test(text);
}

function hasUnclosedPairs(value) {
  const text = String(value || '');
  const pairs = [['(', ')'], ['[', ']'], ['{', '}'], ['“', '”'], ['「', '」'], ['『', '』']];
  return pairs.some(([opening, closing]) => countLiteral(text, opening) !== countLiteral(text, closing));
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
  hasUnbalancedMarkdown,
  isPossiblyTruncatedReference,
  isPossiblyIncompleteSentence
};
