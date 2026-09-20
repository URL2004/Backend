'use strict';

// Distinguish a document-wide presentation wrapper from cited external speech.
// No attribution is inferred from one quoted sentence or a single first person.
function isAuthoredBlockquoteDocument(value) {
  const lines = String(value || '').split(/\r\n?|\n/u).map(x => x.trim()).filter(Boolean);
  const quoted = lines.filter(x => /^>\s+\S/u.test(x));
  const outside = lines.filter(x => !/^>\s+\S/u.test(x));
  if (quoted.length < 2 || quoted.some(x => x.length < 100)) return false;
  if (outside.length < 2 || outside.some(x => !/^\d{1,2}[.)]\s+[^.!?]{2,70}$/u.test(x))) return false;
  const body = quoted.join('\n');
  if (/(?:출처\s*[:：]|인용\s*[:：]|https?:\/\/|doi\s*:|저자|옮긴이|\((?:19|20)\d{2}\)|라고\s*(?:말|쓰|서술|설명))/iu.test(body)) return false;
  // Reflective practice/experience sections, not generic numbered quotations.
  if (!outside.some(x => /(?:활동|실습|경험|성찰|느낀\s*점|배운\s*점)/u.test(x))) return false;
  return /(?:실습|직접|저는|제가|학교에서는)/u.test(body)
    && (body.match(/(?:관찰하였|관찰했|배웠|느꼈|생각했|생각하였|경험했|노력했)/gu) || []).length >= 2;
}

module.exports = { isAuthoredBlockquoteDocument };
