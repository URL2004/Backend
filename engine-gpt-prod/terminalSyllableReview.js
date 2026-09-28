'use strict';
const { splitSentenceSpans } = require('../engine/koreanText');
const { syntaxSpans } = require('../engine/textSyntax');

// A source-attested word gaining one repeated final syllable can be a typo,
// but a particle or a derivational suffix can also be legitimate. Nominate
// only a locally anchored prose change; NEVER delete a syllable here.
const CODE = 'introduced_terminal_syllable_candidate';
const GRAMMATICAL_ENDINGS = new Set([... '이가은는을를의에와과도만로서지고다나며면어아니데게요오든던여리라지해히기음임하워러여']);
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const blocked = (spans, start, end) => spans.some(s => s.start < end && s.end > start);

function terminalSyllableCandidates(source, output) {
  const before = String(source || ''), after = String(output || '');
  if (!before || !after || before === after) return [];
  const sourceTokens = new Set(before.match(/[가-힣]+/gu) || []);
  const sourceSyntax = syntaxSpans(before), targetSyntax = syntaxSpans(after);
  const sentences = splitSentenceSpans(after), findings = [];
  let ordinal = 0;
  for (const match of after.matchAll(/(?<![가-힣])([가-힣]{4,24})([가-힣])(?=\s+([가-힣]{2,16})(?:\s|[,.!?。！？]|$))/gu)) {
    const [, base, last, anchor] = match;
    if (!base.endsWith(last) || GRAMMATICAL_ENDINGS.has(last)
        || (!sourceTokens.has(base) && !sourceTokens.has(base + '의')) || sourceTokens.has(base + last)) continue;
    if (blocked(targetSyntax, match.index, match.index + match[0].length)) continue;
    const anchorBase = anchor.replace(/(?:에서는|으로는|에서|으로|은|는|이|가|을|를|의|에|와|과|도|만|로)$/u, '');
    if (anchorBase.length < 2) continue;
    const phrase = new RegExp(`(?<![가-힣])${escape(base)}(?:의)?\\s+${escape(anchorBase)}(?:에서는|으로는|에서|으로|은|는|이|가|을|를|의|에|와|과|도|만|로)?(?=\\s|[,.!?。！？]|$)`, 'gu');
    const evidence = [...before.matchAll(phrase)].filter(m => !blocked(sourceSyntax, m.index, m.index + m[0].length));
    // Multiple identical lexical frames can support a review question, but
    // never identify a location for automatic restoration.
    if (!evidence.length) continue;
    while (ordinal < sentences.length && sentences[ordinal].end <= match.index) ordinal++;
    if (ordinal >= sentences.length) break;
    findings.push({ code: CODE, ordinal: ordinal + 1 });
  }
  return findings;
}
module.exports = { CODE, terminalSyllableCandidates };
