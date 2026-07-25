'use strict';

// 한국어의 "나는"은 1인칭 대명사와 동사 '나다'의 관형형이 겹친다.
// 화자 판정기는 이 규칙을 공유해 "향이 나는 공간", "냄새 나는 음식"을
// 개인 화자로 세지 않으면서 문장 시작의 "나는"과 명확한 저/나 표지는 보존한다.
const KO_SINGULAR_STRICT_RE = /(?<![가-힣])(?:저는|저의|저도|저를|저에게|저로서|저랑|저와|저한테|제가|제\s+(?:목표|역할|경험|강점|약점|생각|관점|업무|진로|역량|꿈|일|이름|전공|성격|장점|단점|가치관|계획|관심|선택|결정|태도|능력|기여|성과|문제|과제|책임|친구|룸메)|내가|내게|나에게|나의|나도|나를|내\s+(?:목표|역할|경험|강점|약점|생각|관점|업무|진로|역량|꿈|일|이름|전공|성격|장점|단점|가치관|계획|관심|선택|결정|태도|능력|기여|성과|문제|과제|책임|친구|룸메|마음|삶|가족|부모|학교|직업|의견|입장|기준|방식|이야기|기억|감정|몸|집|방))/gu;
const KO_SINGULAR_AMBIGUOUS_GLOBAL_RE = /(?<![가-힣A-Za-z0-9_])(나는|난)(?![가-힣A-Za-z0-9_])/gu;
const NADA_CONTEXT_WITH_PARTICLE_RE = /[가-힣]{1,18}(?:이|가)\s*$/u;
const NADA_CONTEXT_WITHOUT_PARTICLE_RE = /(?:향|냄새|맛|멋|티|윤|빛|소리|열|땀|연기|김|바람|불|화|겁|신|짜증|흥|힘|기억|생각)\s*$/u;
const KO_PLURAL_RE = /(?<![가-힣A-Za-z0-9_])(우리는|우리가|우리의|우리도|우리를|우리에게|우리와|우리로서|저희는|저희가|저희의|저희도|저희를|저희에게|저희와|저희로서|우리|저희)(?![가-힣A-Za-z0-9_])/gu;
const ORG_VOICE_RE = /(본\s*보고서|본\s*연구|본\s*글|이\s*글은|이\s*보고서|본고|본\s*논문)/gu;
const EN_SINGULAR_RE = /\bI\b|\b(?:me|my|mine|myself)\b/gu;
const EN_PLURAL_RE = /\b(?:we|us|our|ours|ourselves)\b/giu;

function computePovSeed(value) {
  const text = String(value || '');
  const koStrictSingular = matchCount(text, KO_SINGULAR_STRICT_RE);
  const koAmbiguousSingular = countAmbiguousSingular(text);
  const ko_fp_singular = koStrictSingular + koAmbiguousSingular;
  const ko_fp_plural = matchCount(text, KO_PLURAL_RE);
  const en_fp_singular = matchCount(text, EN_SINGULAR_RE);
  const en_fp_plural = matchCount(text, EN_PLURAL_RE);
  return {
    ko_fp_singular,
    ko_fp_plural,
    en_fp_singular,
    en_fp_plural,
    fp_singular: ko_fp_singular + en_fp_singular,
    fp_plural: ko_fp_plural + en_fp_plural,
    org_voice_likely: matchCount(text, ORG_VOICE_RE) > 0 || en_fp_plural >= 2
  };
}

function countAmbiguousSingular(value) {
  const text = String(value || '');
  let count = 0;
  for (const match of text.matchAll(new RegExp(
    KO_SINGULAR_AMBIGUOUS_GLOBAL_RE.source,
    KO_SINGULAR_AMBIGUOUS_GLOBAL_RE.flags
  ))) {
    const prefix = text.slice(Math.max(0, Number(match.index || 0) - 24), Number(match.index || 0));
    // ‘나는/난’은 대명사와 ‘나다’의 관형형이 겹친다. 조사가 붙은
    // 선행 명사(향이 나는, 소리가 난)나 빈번한 무조사 결합(냄새 나는)
    // 뒤에서는 화자로 세지 않는다. 그 밖의 ‘어제 나는’, ‘돌아보면 나는’
    // 같은 위치는 실제 1인칭으로 센다.
    if (NADA_CONTEXT_WITH_PARTICLE_RE.test(prefix)
        || NADA_CONTEXT_WITHOUT_PARTICLE_RE.test(prefix)) continue;
    count += 1;
  }
  return count;
}

function countPovKind(value, kind) {
  const seed = computePovSeed(value);
  if (kind === 'firstSingular') return seed.fp_singular;
  if (kind === 'firstPlural') return seed.fp_plural;
  return 0;
}

function hasPovKind(value, kind) {
  return countPovKind(value, kind) > 0;
}

function matchCount(value, pattern) {
  const regex = new RegExp(pattern.source, pattern.flags);
  return (String(value || '').match(regex) || []).length;
}

module.exports = {
  computePovSeed,
  countPovKind,
  hasPovKind
};
