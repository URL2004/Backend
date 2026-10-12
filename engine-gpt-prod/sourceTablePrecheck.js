'use strict';
// Interleaved worksheet columns cannot safely be reconstructed from plain text.
// Ordinary prose mentioning these labels and well-separated fields are valid.
function check(text) {
  const source = String(text || '');
  const labels = [...source.matchAll(/\((Known|Wanted|Learned)\)/giu)];
  if (new Set(labels.map(x => x[1].toLowerCase())).size < 2 || !source.includes('\t')) return null;
  const embedded = labels.filter(x => /[가-힣A-Za-z][ \t]*$/u.test(source.slice(Math.max(0,x.index-8),x.index))
    && !/(?:알고|배운|배우고|궁금한|알고\s*싶은)[ \t]*$/u.test(source.slice(Math.max(0,x.index-20),x.index)));
  if (!embedded.length) return null;
  const audit = require('./sourcePreflight').auditAndSanitizeSource(source);
  if (!audit.issueCodes.includes('source_layout_repair_skipped') || !audit.issueCodes.includes('source_unclosed_delimiter')) return null;
  return { code: 'SOURCE_TABLE_LAYOUT_UNCLEAR', noCharge: true,
    error: '표의 질문 항목과 본문이 섞여 문장 경계를 확인하기 어려워요. 표를 문단별 텍스트로 정리하거나 PDF에서 필요한 본문만 복사해 다시 넣어 주세요. 크레딧은 차감되지 않았어요.' };
}
module.exports = { check };
