'use strict';

// A terminal mark inside a quotation does not terminate its surrounding
// sentence: `“확인했다.”라고` is one syntactic unit. Match the entire attached
// suffix, not a prefix (`이` must not exempt `이것은`, `가` must not exempt
// `가장`). This helper only inserts missing spaces; the caller owns literal
// shielding and any source-evidenced correction of existing spaces.
const SUFFIX_BOUNDARY = '(?=$|[\\s,.;:!?。！？”’"\'」』》〉）)\\]】〕])';
const QUOTATIVE_SUFFIX = '(?:이?라(?:고|는|며|면서|면|니|는데|더니|던|든(?:지)?))(?:도|는|만)?';
const COPULA_SUFFIX = '(?:란|라(?:고|는|며|면)|인(?:가|데|지|바|셈|것|경우|만큼|듯|채|줄)?|이(?:라(?:고|는|며|면)?|란|나|라도|든(?:지)?|기(?:도|만|는)|지(?:만)?|다|고|며|어서|므로|었(?:습니다|다|던|고|지만|으면|다면|다는|을|는데|으며)?|었던)|였(?:습니다|다|던|고|지만|으면|다면|다는|을|는데|으며)?|입니다|일(?:수|지|까|뿐|때|경우)?|임(?:을|이|은|도)?)';
const PARTICLE_SUFFIX = '(?:에서는|에서도|에서만|에게는|에게도|에게만|으로는|으로도|으로만|로는|로도|로만|에는|에도|에만|부터는|부터도|까지는|까지도|에서|에게|께서|으로|처럼|보다|부터|까지|라도|이나|나|조차|마저|밖에|마다|은|는|이|가|을|를|의|에|와|과|도|만|로|고)';
const COMPOUND_PARTICLE_SUFFIX = '(?:(?:만|부터|까지|조차|마저|밖에|처럼|보다)(?:으로|로|의|은|는|도|만)?(?:는|도|만)?|(?:으로|로)(?:서|써)(?:는|도|만)?|(?:와|과|에|에서|에게|으로|로)(?:의|는|도|만))';
const ATTACHED_SUFFIX_RE = new RegExp(
  `^(?:${QUOTATIVE_SUFFIX}|(?:까지|부터|만)(?:${COPULA_SUFFIX}|다)|(?:이?라기(?:보다는|보다|보단))|${COPULA_SUFFIX}|${COMPOUND_PARTICLE_SUFFIX}|${PARTICLE_SUFFIX})${SUFFIX_BOUNDARY}`,
  'u'
);
const NEW_SENTENCE_DEMONSTRATIVE_RE = /^(?:이|그|저)\s+(?:문장|말씀|구절|발언|문구|이야기|인용|말)(?:은|는|이|가|을|를|에서|로|에|도)?(?:\s|[,.!?。！？]|$)/u;
const MISSING_SENTENCE_SPACE_RE = /([가-힣][.!?。！？]+)([”’"'」』》〉）)\]】〕]*)(?=[가-힣A-Z(])/gu;

function repairMissingSentenceSpacingLine(value) {
  const text = String(value || '');
  return text.replace(MISSING_SENTENCE_SPACE_RE, (match, terminal, closers, offset) => {
    if (closers) {
      const right = text.slice(offset + match.length);
      if (ATTACHED_SUFFIX_RE.test(right) && !NEW_SENTENCE_DEMONSTRATIVE_RE.test(right)) return match;
    }
    return `${terminal}${closers} `;
  });
}

module.exports = { repairMissingSentenceSpacingLine };
