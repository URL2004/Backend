'use strict';
const { splitSentences, countOccurrences } = require('./textStats');

function analyzeSpeaker(text) {
  const sentences = splitSentences(text);
  const firstPerson = countOccurrences(text, [/\b(저는|제가|나는|내가|본인|필자|우리는|제가)\b/g]);
  // `합니다.` also ends in `다.`, so the old broad `다.` matcher counted it as
  // plain style while only recognising the narrower `습니다.` form as polite.
  // That made ordinary business-blog prose look like plain `-다` style and
  // caused a false `formal_to_polite` speaker shift whenever a model used `-요`.
  const formalPolite = countOccurrences(text, [/(?:니다|니까)[.!?。！？]/g]);
  const casualPolite = countOccurrences(text, [/요[.!?。！？]/g]);
  const plainDa = countOccurrences(text, [/(?<!니)다[.!?。！？]/g]);
  // Keep the legacy counters in diagnostics for callers that display them.
  const politeYo = formalPolite + casualPolite;
  const formalDa = plainDa;
  const imperative = countOccurrences(text, [/(해줘|해주세요|써줘|바꿔줘|늘려줘|요약해|무시해)/g]);

  let person = 'neutral';
  if (firstPerson > 0) person = 'first_person';

  let ending = 'mixed';
  if (formalPolite >= Math.max(2, casualPolite * 1.5, plainDa * 1.5)) ending = 'formal_polite';
  else if (casualPolite >= Math.max(2, formalPolite * 1.5, plainDa * 1.5)) ending = 'casual_polite';
  else if (plainDa >= Math.max(2, formalPolite * 1.5, casualPolite * 1.5)) ending = 'plain_da';
  else if (sentences.length && formalPolite + casualPolite + plainDa === 0) ending = 'plain_or_fragment';

  return {
    person,
    ending,
    firstPerson,
    formalPolite,
    casualPolite,
    plainDa,
    politeYo,
    formalDa,
    imperative
  };
}

function speakerShift(beforeProfile, afterProfile) {
  const reasons = [];
  if (beforeProfile.person === 'neutral' && afterProfile.firstPerson > beforeProfile.firstPerson) {
    reasons.push('first_person_injected');
  }
  if (beforeProfile.person === 'first_person' && afterProfile.firstPerson === 0) {
    reasons.push('first_person_removed');
  }
  if (beforeProfile.ending === 'formal_polite' && beforeProfile.casualPolite === 0 && afterProfile.casualPolite > 0) {
    reasons.push('ending_shift_formal_polite_to_casual_polite');
  }
  if (beforeProfile.ending === 'formal_polite' && beforeProfile.plainDa === 0 && afterProfile.plainDa > 0) {
    reasons.push('ending_shift_formal_polite_to_plain');
  }
  if (beforeProfile.ending === 'casual_polite' && beforeProfile.formalPolite === 0 && afterProfile.formalPolite > 0) {
    reasons.push('ending_shift_casual_polite_to_formal_polite');
  }
  if (beforeProfile.ending === 'casual_polite' && beforeProfile.plainDa === 0 && afterProfile.plainDa > 0) {
    reasons.push('ending_shift_casual_polite_to_plain');
  }
  if (beforeProfile.ending === 'plain_da' && beforeProfile.formalPolite === 0 && afterProfile.formalPolite > 0) {
    reasons.push('ending_shift_plain_to_formal_polite');
  }
  if (beforeProfile.ending === 'plain_da' && beforeProfile.casualPolite === 0 && afterProfile.casualPolite > 0) {
    reasons.push('ending_shift_plain_to_casual_polite');
  }
  return reasons;
}

module.exports = { analyzeSpeaker, speakerShift };
