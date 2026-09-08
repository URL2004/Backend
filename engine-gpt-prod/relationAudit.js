'use strict';

const { splitSentences } = require('../engine/koreanText');
const { extractNumberTokens } = require('./factAudit');
const VERSION = 'relation-candidates-v2';

// Certainty markers. Strong hedges qualify a claim as possible/inferred; weak
// ones (편이다) only soften it. A hedge that disappears from a comparable
// sentence, or appears where the source asserted plainly, is a scope candidate.
const STRONG_HEDGE = /(?:가능성|것으로\s*(?:보|추정|판단|여겨|알려)|보인다|보입니다|보였다|것\s*같|듯\s*하|듯하|듯\s*싶|수\s*있|수도\s*있|추정|추측|짐작|시사|생각(?:한다|합니다|된다|했다|했습니다)|여겨진다|판단된다|아마|어쩌면|일지도|지도\s*모른다|모르겠)/gu;
const WEAK_HEDGE = /편이|편입니다/gu;
// Explicit order markers between events (뒤/후/다음/나서/먼저…). A -고/-며
// coordination that gains or loses one changes the temporal relation.
const SEQUENCE_MARKER = /(?:^|[\s(])(?:그\s*)?(?:뒤|후|이후|직후|다음|나서|먼저|우선|전에)(?:에|에는|엔|으로|로|부터)?(?=$|[\s,.;!?)])/gu;
const COORDINATION = /[가-힣](?:고|며)\s/u;
const CLAUSE_JOIN = /[가-힣](?:고|며|지만)\s*,?\s/u;
const CAUSAL_MARKER = /(?:그\s*결과|때문에|따라서|덕분에|덕에|탓에|으므로|(?:로|으로)\s*인해)/gu;
// Claim strength tiers: partial (1) < general (2) < universal/intense (3).
// A comparable sentence whose tier set changes is a strength candidate.
const PARTICLE_END = '(?=$|[\\s,.;!?)]|(?:은|는|이|가|의|도|만|을|를|에|로|으로|와|과)(?![가-힣]))';
const STRENGTH_LEVELS = [
  [1, new RegExp(`(?<![가-힣])(?:일부|몇몇|부분적|조금|약간|다소|살짝|가끔|드물게|소수)${PARTICLE_END}`, 'u')],
  [2, new RegExp(`(?<![가-힣])(?:대부분|대체로|주로|거의)${PARTICLE_END}`, 'u')],
  [3, new RegExp(`(?<![가-힣])(?:모든|모두|항상|언제나|전부|반드시|무조건|꼭|늘|크게|훨씬|강하게|강력히|완전히|매우|상당히|몹시)${PARTICLE_END}|(?<![가-힣])(?:심하|심각|극심|급증|급감|폭증|폭락|급등|급락|치솟)`, 'u')]
];
const PLAIN_CHANGE = /(?:증가|감소|늘었|늘어|줄었|줄어|올랐|내렸|상승|하락)/u;
const SHARP_CHANGE = /(?:급증|급감|폭증|폭락|급등|급락|치솟|곤두박질)/u;

// These are review triggers, never findings of factual error or block gates.
// Exact ownership swaps are screened separately from broad semantic changes.
function auditRelationCandidates(source, outputText) {
  const before = String(source || '');
  const after = String(outputText || '');
  const candidates = [];
  const sourceBindings = numberBindings(before);
  const outputBindings = numberBindings(after);
  const owners = [...new Set(sourceBindings.map(row => row.owner))];
  if (owners.length >= 2 && bag(extractNumberTokens(before)) === bag(extractNumberTokens(after))) {
    for (const owner of owners) {
      const left = sourceBindings.filter(row => row.owner === owner);
      const right = outputBindings.filter(row => row.owner === owner);
      if (left.length && left.length === right.length && bag(left.map(row => row.value)) !== bag(right.map(row => row.value))) {
        candidates.push({ code: 'number_ownership_candidate', owner,
          sourceSpan: left[0].span, outputSpan: right[0].span });
      }
    }
  }
  const originals = splitSentences(before);
  for (const [outputIndex, sentence] of splitSentences(after).entries()) {
    const matched = closestSentence(originals, sentence);
    if (!matched || matched.similarity < 0.42 || matched.sentence === sentence) continue;
    const original = matched.sentence;
    const add = code => candidates.push({ code, sourceOrdinal: matched.index + 1,
      outputOrdinal: outputIndex + 1, sourceSpan: original, outputSpan: sentence });
    if (/(?:이후|직후|그\s*후|\s뒤|\s후(?=\s|$)|\s후에|다음에|나서)/u.test(original)
        && count(sentence, CAUSAL_MARKER) > count(original, CAUSAL_MARKER)) add('causal_relation_candidate');
    const left = subjectObject(original), right = subjectObject(sentence);
    if (left && right && left.subject === right.object && left.object === right.subject
        && left.subject !== left.object) add('argument_ownership_candidate');
    if (/(?:란|이란|는|은)\s+[^.]{2,100}(?:뜻한다|말한다|의미한다|이다)[.!?]?$/u.test(original)
        && left && right && left.subject !== right.subject && left.object === right.subject) add('definition_target_candidate');
    if (/수\s*없|불가능|모든|반드시|해야/u.test(original)
        && /어렵|일부|권장|좋다/u.test(sentence)
        && !/어렵|일부|권장|좋다/u.test(original)) add('claim_strength_candidate');
    else if (strengthShift(original, sentence)) add('claim_strength_candidate');
    if (certaintyScopeShift(original, sentence)) add('certainty_scope_candidate');
    if (temporalSequenceShift(original, sentence, before, after)) add('temporal_sequence_candidate');
  }
  const seen = new Set();
  const unique = candidates.filter(row => {
    const key = JSON.stringify(row); if (seen.has(key)) return false; seen.add(key); return true;
  }).slice(0, 12);
  return { version: VERSION, candidateOnly: true, semanticRequired: unique.length > 0,
    codes: [...new Set(unique.map(row => row.code))], candidates: unique };
}

function numberBindings(value) {
  const out = [];
  for (const sentence of splitSentences(value)) {
    // A one-word noun modifier stays part of the owner (서울 지점 / 부산 지점,
    // 2023년 참가자 / 2024년 참가자); a preceding verb form does not.
    const subjects = [...sentence.matchAll(/([가-힣A-Za-z][가-힣A-Za-z0-9·-]{0,29}?)(은|는|이|가)(?=\s)/gu)]
      .map(match => {
        const modifier = (sentence.slice(0, match.index).match(/(?:^|\s)([가-힣A-Za-z0-9]{1,12})\s$/u) || [])[1] || '';
        const keepModifier = modifier && !/(?:고|며|서|다|은|는|이|가|을|를|의|에|도|과|와|로)$/u.test(modifier);
        return { index: match.index, topic: match[2] === '은' || match[2] === '는',
          owner: keepModifier ? `${modifier} ${match[1]}` : match[1] };
      });
    for (const match of sentence.matchAll(/[-+]?\d+(?:,\d{3})*(?:\.\d+)?\s*(?:개월|만원|억원|조원|시간|명|개|건|회|년|월|일|분|초|원|%|kg|km)?/gu)) {
      const preceding = subjects.filter(row => row.index < match.index && match.index - row.index <= 90);
      // The 은/는 topic owns a number even when an 이/가 attribute (매출이 12%)
      // sits between them; without a topic the nearest subject owns it.
      const subject = preceding.filter(row => row.topic).at(-1) || preceding.at(-1);
      if (!subject) continue;
      out.push({ owner: subject.owner, value: extractNumberTokens(match[0])[0] || match[0], span: sentence });
    }
  }
  return out;
}
function subjectObject(value) {
  const match = String(value).match(/([가-힣A-Za-z][가-힣A-Za-z0-9·-]{0,29}?)(?:은|는|이|가)\s+([가-힣A-Za-z][가-힣A-Za-z0-9·-]{0,29}?)(?:을|를)(?=\s)/u);
  return match ? { subject: match[1], object: match[2] } : null;
}
function closestSentence(originals, value) {
  // Light normalization is only for locating a comparable sentence. It never
  // certifies a relation or acts as an authorship feature.
  const tokens = value => new Set((String(value).match(/[가-힣A-Za-z0-9]{2,}/gu) || [])
    .map(token => token.replace(/(?:에게서|에게|에서|으로|은|는|이|가|을|를|의)$/u, ''))
    .filter(token => token.length >= 2));
  // Two-character stems let an inflected verb (적용할/적용하기) still locate its
  // source sentence; the stricter token overlap is kept where it is higher.
  const stems = set => new Set([...set].map(token => token.slice(0, 2)));
  const overlapRatio = (source, target) => [...target].filter(token => source.has(token)).length
    / Math.max(1, Math.min(source.size, target.size));
  const target = tokens(value), targetStems = stems(target);
  return originals.map((sentence, index) => {
    const source = tokens(sentence);
    const similarity = Math.max(overlapRatio(source, target), overlapRatio(stems(source), targetStems));
    return { sentence, index, similarity };
  }).sort((a, b) => b.similarity - a.similarity)[0];
}
function certaintyScopeShift(original, sentence) {
  const sourceHedges = count(original, STRONG_HEDGE) + count(original, WEAK_HEDGE);
  const outputHedges = count(sentence, STRONG_HEDGE) + count(sentence, WEAK_HEDGE);
  // Hedge dropped: a possibility or opinion is now stated plainly.
  if (sourceHedges > 0 && outputHedges === 0) return true;
  // Hedge added: a plain statement is now qualified as inferred or possible.
  if (sourceHedges === 0 && count(sentence, STRONG_HEDGE) > 0) return true;
  // Scope narrowed inside one compound sentence: an embedded 이/가 subject of
  // the source was promoted to its own 은/는 topic clause ahead of the hedge.
  if (sourceHedges > 0 && outputHedges > 0 && COORDINATION.test(original) && CLAUSE_JOIN.test(sentence)) {
    const sourceTopics = topics(original), outputTopics = topics(sentence);
    if (outputTopics.length > sourceTopics.length && outputTopics.some(noun => !sourceTopics.includes(noun)
        && new RegExp(`(?:^|\\s)${escapeRegExp(noun)}(?:이|가)(?=\\s)`, 'u').test(original))) return true;
  }
  return false;
}
function temporalSequenceShift(original, sentence, before, after) {
  const sourceMarkers = count(original, SEQUENCE_MARKER), outputMarkers = count(sentence, SEQUENCE_MARKER);
  if (sourceMarkers === outputMarkers) return false;
  // Order added: two events the source merely coordinated now carry an
  // explicit before/after marker that exists nowhere in the source.
  if (outputMarkers > sourceMarkers && COORDINATION.test(original)) return count(after, SEQUENCE_MARKER) > count(before, SEQUENCE_MARKER);
  // Order removed: an explicit sequence collapsed into plain coordination.
  if (sourceMarkers > outputMarkers && COORDINATION.test(sentence)) return count(before, SEQUENCE_MARKER) > count(after, SEQUENCE_MARKER);
  return false;
}
function strengthShift(original, sentence) {
  const left = strengthLevels(original), right = strengthLevels(sentence);
  if (left.length && right.length && bag(left) !== bag(right)) return true;
  // 증가 → 급증: a plain change verb became a sharp one, or the reverse.
  return (SHARP_CHANGE.test(sentence) && !SHARP_CHANGE.test(original) && PLAIN_CHANGE.test(original))
    || (SHARP_CHANGE.test(original) && !SHARP_CHANGE.test(sentence) && PLAIN_CHANGE.test(sentence));
}
function strengthLevels(value) {
  return STRENGTH_LEVELS.filter(([, pattern]) => pattern.test(String(value))).map(([level]) => level);
}
function topics(value) {
  return [...String(value).matchAll(/([가-힣A-Za-z][가-힣A-Za-z0-9·-]{0,29}?)(?:은|는)(?=\s)/gu)].map(match => match[1]);
}
const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const bag = values => JSON.stringify([...values].sort());
const count = (value, pattern) => (String(value).match(pattern) || []).length;

module.exports = { VERSION, auditRelationCandidates, numberBindings };
