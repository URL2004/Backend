'use strict';

const INLINE_CODE_RE = /(?<!`)`([^`\n]+)`(?!`)/gu;

function freezeInlineCode(value) {
  const source = String(value || '');
  const blocks = [];
  const text = source.replace(INLINE_CODE_RE, match => {
    const token = `ZXQCODE${String(blocks.length).padStart(4, '0')}QXZ`;
    blocks.push({ token, value: match });
    return token;
  });
  return { text, blocks, count: blocks.length };
}

function restoreInlineCode(value, frozen) {
  let text = String(value || '');
  const missing = [];
  for (const block of frozen?.blocks || []) {
    const occurrences = text.split(block.token).length - 1;
    if (occurrences !== 1) {
      missing.push(block.token);
      continue;
    }
    text = text.replace(block.token, block.value);
  }
  return {
    text,
    pass: missing.length === 0,
    restoredCount: (frozen?.blocks || []).length - missing.length,
    missingCount: missing.length
  };
}

module.exports = { freezeInlineCode, restoreInlineCode };
