const { splitSentences, countMatches } = require('./textStats');

function analyzeSpeakerProfile(text) {
  const s = String(text || '');
  const sentences = splitSentences(s);
  const sentenceCount = Math.max(1, sentences.length);
  const firstPerson = countMatches(s, [/저는/g, /제가/g, /나는/g, /내가/g, /우리/g, /필자는/g]);
  const politeYo = sentences.filter(x => /(요\.|어요\.|아요\.|해요\.|됩니다요\.)$/.test(x.trim())).length;
  const formalDa = sentences.filter(x => /(다\.|한다\.|된다\.|있다\.|없다\.|였다\.|이었다\.|것이다\.|습니다\.)$/.test(x.trim())).length;
  const politeSeumnida = sentences.filter(x => /(습니다\.|입니다\.|합니다\.|됩니다\.)$/.test(x.trim())).length;
  const imperative = countMatches(s, [/해줘/g, /써줘/g, /바꿔/g, /무시/g, /지시/g]);

  let person = 'neutral';
  if (firstPerson / sentenceCount > 0.08 || firstPerson >= 3) person = 'first_person';
  let ending = 'mixed';
  if (formalDa >= Math.max(3, politeYo * 3)) ending = 'formal_da';
  else if (politeYo >= Math.max(3, formalDa * 0.6)) ending = 'polite_yo';
  else if (politeSeumnida >= 3) ending = 'polite_formal';

  return {
    person,
    ending,
    firstPersonCount: firstPerson,
    politeYoCount: politeYo,
    formalDaCount: formalDa,
    politeFormalCount: politeSeumnida,
    instructionLikeCount: imperative,
    sentenceCount
  };
}

function speakerShift(sourceProfile, afterProfile) {
  const reasons = [];
  if (sourceProfile.person === 'neutral' && afterProfile.firstPersonCount > sourceProfile.firstPersonCount) {
    reasons.push('first_person_injected');
  }
  if (sourceProfile.person === 'first_person' && afterProfile.firstPersonCount < Math.max(1, sourceProfile.firstPersonCount * 0.35)) {
    reasons.push('first_person_removed');
  }
  if (sourceProfile.ending === 'formal_da' && afterProfile.politeYoCount > Math.max(2, afterProfile.formalDaCount * 0.35)) {
    reasons.push('ending_shift_da_to_yo');
  }
  if (sourceProfile.ending === 'polite_yo' && afterProfile.formalDaCount > Math.max(4, afterProfile.politeYoCount * 2.0)) {
    reasons.push('ending_shift_yo_to_da');
  }
  return reasons;
}

module.exports = { analyzeSpeakerProfile, speakerShift };
