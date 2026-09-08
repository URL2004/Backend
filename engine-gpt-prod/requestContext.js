'use strict';

// Legacy free text is conservatively partitioned. Preferences never enlarge
// the allowed fact world. Facts supplied by the author are not verified facts.
function partitionRequestContext({ userNotes = '', evidence = '' } = {}) {
  const structured = userNotes && typeof userNotes === 'object' && !Array.isArray(userNotes);
  const editPreferences = [], authorFacts = [];
  if (structured) {
    editPreferences.push(...strings(userNotes.editPreferences));
    authorFacts.push(...strings(userNotes.authorFacts));
  } else {
    for (const line of String(userNotes || '').split(/\n+/u).map(v => v.trim()).filter(Boolean)) {
      if (/^(?:사실|추가 사실|author_fact)\s*:/iu.test(line)) authorFacts.push(line.replace(/^[^:]+:\s*/u, ''));
      else if (/(?:바꿔|바꾸|써\s*줘|써\s*주|작성해|추가해|늘려|줄여|해주세요|하라|해라|무시|출력|치환|자연스럽게|문체|분량|존댓말|말투|격식|이전\s*지시)/u.test(line)) editPreferences.push(line);
      else authorFacts.push(line);
    }
  }
  const evidenceFacts = Array.isArray(evidence)
    ? evidence.filter(row => row && row.approvedForInsertion === true && row.claimSupported === true)
      .flatMap(row => strings(row.fact || row.claim))
    : strings(evidence);
  return { version: 'request-context-v1', editPreferences, authorFacts, evidenceFacts,
    legacyNotes: !structured, authorFactsVerified: false };
}
function strings(value) {
  return (Array.isArray(value) ? value : [value]).filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean);
}
module.exports = { partitionRequestContext };
