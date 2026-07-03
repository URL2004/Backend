'use strict';
const { splitSentences, countOccurrences } = require('./textStats');

function analyzeSpeaker(text) {
  const sentences = splitSentences(text);
  const firstPerson = countOccurrences(text, [/\b(저는|제가|나는|내가|본인|필자|우리는|제가)\b/g]);
  const politeYo = countOccurrences(text, [/(요\.|습니다\.|습니까\?|세요\.)/g]);
  const formalDa = countOccurrences(text, [/(다\.|한다\.|했다\.|된다\.|있다\.|없다\.|이다\.)/g]);
  const imperative = countOccurrences(text, [/(해줘|해주세요|써줘|바꿔줘|늘려줘|요약해|무시해)/g]);

  let person = 'neutral';
  if (firstPerson > 0) person = 'first_person';

  let ending = 'mixed';
  if (formalDa >= politeYo * 2 && formalDa >= 2) ending = 'formal_da';
  else if (politeYo >= formalDa * 1.2 && politeYo >= 2) ending = 'polite';
  else if (sentences.length && formalDa + politeYo === 0) ending = 'plain_or_fragment';

  return { person, ending, firstPerson, politeYo, formalDa, imperative };
}

function speakerShift(beforeProfile, afterProfile) {
  const reasons = [];
  if (beforeProfile.person === 'neutral' && afterProfile.firstPerson > beforeProfile.firstPerson) {
    reasons.push('first_person_injected');
  }
  if (beforeProfile.person === 'first_person' && afterProfile.firstPerson === 0) {
    reasons.push('first_person_removed');
  }
  if (beforeProfile.ending === 'formal_da' && afterProfile.politeYo > Math.max(2, afterProfile.formalDa * 0.35)) {
    reasons.push('ending_shift_formal_to_polite');
  }
  if (beforeProfile.ending === 'polite' && afterProfile.formalDa > Math.max(2, afterProfile.politeYo * 1.2)) {
    reasons.push('ending_shift_polite_to_formal');
  }
  return reasons;
}

module.exports = { analyzeSpeaker, speakerShift };
