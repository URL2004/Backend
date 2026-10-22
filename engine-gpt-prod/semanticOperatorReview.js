'use strict';

const { textDigest } = require('./semanticProvenance');
const CODES = new Set(['temporal_limit_candidate', 'sole_reason_candidate',
  'mental_onset_strength_candidate', 'additive_concession_candidate', 'certainty_scope_candidate',
  'alternative_conjunction_candidate', 'alias_owner_binding_candidate',
  'volitional_modality_candidate', 'repetition_condition_candidate',
  'action_exclusivity_candidate', 'experienced_conditional_candidate', 'purpose_simultaneity_candidate',
  'subject_exclusivity_candidate', 'parallel_dependency_candidate', 'coordination_causal_candidate',
  'necessity_condition_candidate', 'temporal_actor_candidate',
  'source_suffix_replay_candidate', 'introduced_adjacent_duplicate_candidate',
  ...require('./auditMeaningRelations').CODES,
  ...require('./referenceRelationReview').CODES,
  'source_label_binding_candidate', 'introduced_delimiter_imbalance_candidate']);
const unique = (text, span) => typeof span === 'string' && span.length >= 12
  && text.indexOf(span) >= 0 && text.indexOf(span) === text.lastIndexOf(span);

// A candidate is a question, not an error. Explicit answers prevent a fluent
// rewrite's small logical operators from disappearing in an empty verdict.
function targets(source, candidate, discourseSignals = []) {
  const grouped = new Map();
  // Section-owned alias hints may use other names in the whole source to
  // nominate a swap. Only exact, unique CURRENT pair spans enter this contract.
  const contextual = require('./currentReviewHints').currentReviewHints(discourseSignals, source, candidate).flatMap(value => {
    try { const item = JSON.parse(value); return ['alias_owner_binding_candidate', 'source_label_binding_candidate', 'introduced_delimiter_imbalance_candidate'].includes(item?.code) ? [item] : []; }
    catch { return []; }
  });
  for (const c of [...require('./relationAudit').auditRelationCandidates(source, candidate, { includeAllCandidates: true }).candidates,
    ...require('./adjacentDuplicateReview').candidates(source,candidate),
    ...require('./adjacentDuplicateReview').introducedCandidates(source,candidate), ...contextual]) {
    if (!CODES.has(c.code) || !unique(source, c.sourceSpan) || !unique(candidate, c.outputSpan)) continue;
    const id = textDigest(c.sourceSpan + '\u0000' + c.outputSpan).slice(0, 24);
    if (!grouped.has(id)) grouped.set(id, { id, sourceSpan: c.sourceSpan, candidateSpan: c.outputSpan, codes: [] });
    const t = grouped.get(id);
    if (!t.codes.includes(c.code)) t.codes.push(c.code);
  }
  return [...grouped.values()];
}

function schema(base, selected) {
  if (!selected.length) return base;
  return { ...base, properties: { ...base.properties, operatorReviews: { type: 'array', items: {
    type: 'object', additionalProperties: false, properties: {
      // Request-specific IDs belong in OPERATOR_REVIEW_TARGETS, never in
      // the cacheable output schema. assess enforces the exact ID set.
      id: { type: 'string' },
      status: { type: 'string', enum: ['preserved', 'changed', 'uncertain'] },
      sourceSpan: { type: 'string' }, candidateSpan: { type: 'string' }, detail: { type: 'string' }
    }, required: ['id', 'status', 'sourceSpan', 'candidateSpan', 'detail']
  } } }, required: [...base.required, 'operatorReviews'] };
}

function assess(all, reviews, findings, source, candidate) {
  const pending = [], accepted = [];
  const createLocator = require('./evidenceSpan').createEvidenceLocator;
  const sourceLocator = createLocator(source), candidateLocator = createLocator(candidate);
  const canonical = (text, locate, value) => { const at = locate(value, 12); return at ? text.slice(at.start, at.end) : value; };
  const expectedIds = new Set(all.map(t => t.id));
  const validIds = Array.isArray(reviews) && reviews.every(r => expectedIds.has(r?.id));
  for (const t of all) {
    const answers = (reviews || []).filter(r => r?.id === t.id);
    // Empty quotes explicitly reference the immutable spans carried by this ID.
    // Omitted fields and an absent answer are NOT references and remain invalid.
    const answer = answers[0], r = answer && { ...answer,
      sourceSpan: answer.sourceSpan === '' ? t.sourceSpan : canonical(source, sourceLocator, answer.sourceSpan),
      candidateSpan: answer.candidateSpan === '' ? t.candidateSpan : canonical(candidate, candidateLocator, answer.candidateSpan) };
    // A reviewer can expand a split sentence to its actual adjacent context,
    // but cannot cite another occurrence or evade the nominated owner.
    const valid = validIds && answers.length === 1 && ['preserved', 'changed', 'uncertain'].includes(r.status)
      && unique(source, r.sourceSpan) && unique(candidate, r.candidateSpan)
      && r.sourceSpan.includes(t.sourceSpan) && r.candidateSpan.includes(t.candidateSpan)
      && typeof r.detail === 'string' && r.detail.trim().length >= 8;
    const substantive = findings.some(v => v.origin === 'introduced' && v.repairable
      && v.sourceSpan && (v.sourceSpan.includes(t.sourceSpan) || t.sourceSpan.includes(v.sourceSpan)));
    const uncertaintyReasons = !valid ? [!validIds ? 'operator_unknown_id'
      : answers.length !== 1 ? 'operator_answer_missing_or_duplicate'
      : !unique(source, r?.sourceSpan) ? 'operator_source_unlocated'
      : !unique(candidate, r?.candidateSpan) ? 'operator_candidate_unlocated'
      : !r.sourceSpan.includes(t.sourceSpan) || !r.candidateSpan.includes(t.candidateSpan) ? 'operator_pair_mismatch'
      : 'operator_verdict_incomplete']
      : r.status === 'uncertain' ? ['interpretation_unconfirmed'] : [];
    accepted.push({ id: t.id, status: valid ? r.status : 'unconfirmed',
      sourceSpan: valid ? r.sourceSpan : t.sourceSpan, candidateSpan: valid ? r.candidateSpan : t.candidateSpan,
      detail: valid ? r.detail : 'The nominated relationship was not explicitly grounded and adjudicated.', uncertaintyReasons,
      ...(!valid && answer ? { submittedReview: { status: answer.status, sourceSpan: answer.sourceSpan,
        candidateSpan: answer.candidateSpan, detail: answer.detail } } : {}) });
    if (substantive || (valid && r.status === 'preserved')) continue;
    // A complete changed verdict already names and compares an exact pair.
    // Requiring the same verdict a second time in violations caused mechanical
    // uncertainty and wasted tokens. judge.js still grounds this materialized
    // finding against the current input before it can be repaired.
    const changed = valid && r.status === 'changed';
    pending.push({ type: 'distortion', origin: changed ? 'introduced' : 'unconfirmed', relation: t.codes.some(code => ['alias_owner_binding_candidate', 'source_label_binding_candidate'].includes(code)) ? 'actor_action_target'
      : t.codes.some(code => ['source_suffix_replay_candidate', 'introduced_delimiter_imbalance_candidate'].includes(code)) ? 'other' : 'modality_negation_causality',
      sourceSpan: valid ? r.sourceSpan : t.sourceSpan, candidateSpan: valid ? r.candidateSpan : t.candidateSpan,
      span: changed ? r.candidateSpan : '', repairable: false, uncertaintyReasons,
      relationGrounded: false, grounding: 'unresolved_operator_review',
      detail: valid ? r.detail : 'The nominated operator relationship was not explicitly adjudicated.' });
  }
  return { pending, reviews: accepted };
}

const instruction = 'OPERATOR_REVIEW_TARGETS는 오류 정답이 아니라 대응 관계 질문이다. 각 id에 operatorReviews를 반드시 반환한다. SOURCE·REWRITE의 앞뒤 문장까지 읽고 같은 주체의 시점 한정·유일 원인·감정의 발생/증가·추가/양보·확신·선택 관계가 유지되면 preserved, 실제 신규 변화이면 changed, 대응을 확정하지 못하면 uncertain으로 판정한다. 다른 문장에 같은 단어가 있다는 이유만으로 preserved를 주지 않는다. 자연스러운 동의 표현·같은 주체의 공유 양태·정상적인 문장 분리는 허용한다. sourceSpan/candidateSpan은 대상 구절을 포함하는 정확한 현재 인용이어야 하며 필요하면 인접 문장까지 확장한다. detail에는 실제 논리 비교 근거를 짧게 쓴다. changed 판정에는 현재 위치를 찾을 수 있는 인용과 실제 관계 변화의 근거가 필요하다. 이 목록만 검사하지 말고 나머지 문서도 검수한다.';
const compactInstruction = '출력 중복 방지: operatorReviews의 sourceSpan/candidateSpan이 해당 id의 입력 구절과 정확히 같으면 긴 구절을 다시 쓰지 말고 빈 문자열로 해당 구절을 참조한다. 앞뒤 문맥을 확장해야 할 때만 실제 확장된 인용을 쓴다. id·status·detail은 생략하지 않는다. detail은 결론을 지지하는 관계 비교 한 문장으로 쓴다. violations의 실제 오류 근거는 빈 문자열로 줄이지 않는다.';
const aliasInstruction = 'alias_owner_binding_candidate는 인명과 괄호 속 병기 이름의 연결을 대조하는 질문이다. SOURCE에서 연결된 인물과 REWRITE의 인물이 같은지 확인한다. 정상적인 인물 나열 순서 변경·같은 이름의 표기 확장·호칭 변경은 허용하고, 인용문헌·수식·일반 용어 정의를 인명으로 확정하지 않는다. 원문 자체의 모호한 연결을 신규 오류로 단정하거나 외부 지식으로 이름을 수정하지 않는다.';
const volitionalRepeatInstruction = 'volitional_modality_candidate와 repetition_condition_candidate도 오류 정답이 아니라 검토 질문이다. 같은 행동의 의향(-려 한다)과 희망(-고 싶다)이 문맥에서 실제로 달라졌는지, 추가된 다시·재차가 같은 행동의 반복을 새로 전제하여 조건 범위를 좁혔는지 확인한다. 부정과 인용의 소유권을 유지하고, 같은 행동의 자연스러운 동의 표현이나 문맥상 반복이 이미 명시·함의되면 preserved로 답한다. 특히 다음 날에도 같은 표현의 반복 함의를 함께 읽고 다시라는 단어만으로 오류를 확정하지 않는다. 필요한 경우 앞뒤 문장까지 정확한 인용을 확장하며, changed에는 실제 관계 변화의 근거를 쓴다.';
function instructionsFor(selected) {
  const codes = new Set(selected.flatMap(t => t.codes || []));
  const has = list => list.some(code => codes.has(code));
  return [instruction, compactInstruction,
    '제시한 짝이 실제 대응 문장과 어긋나면 인용을 다른 문장으로 교체하지 않는다. 해당 대상 구절과 실제 대응 문장을 모두 포함하는 정확한 연속 구간으로 인용을 확장하고, 어느 문장이 같은 주체·조건·행동을 보존하는지 설명한다. 대상 구절을 포함할 수 없거나 대응 소속이 불명확하면 uncertain으로 남긴다.',
    '정확한 대응 구절과 구체 비교 근거를 갖춘 changed 응답은 그 자체로 해당 관계의 오류 판정이다. 동일한 오류를 violations에 중복 작성할 필요는 없으며 서버가 현재 인용의 위치를 검증해 연결한다. 다른 오류나 별도의 구체 문제 구절은 violations에 적는다. uncertain이나 누락된 답변은 통과가 아니다.',
    has(['alias_owner_binding_candidate']) ? aliasInstruction : '',
    has(['volitional_modality_candidate', 'repetition_condition_candidate']) ? volitionalRepeatInstruction : '',
    has(['action_exclusivity_candidate', 'experienced_conditional_candidate', 'purpose_simultaneity_candidate',
      'subject_exclusivity_candidate', 'parallel_dependency_candidate', 'coordination_causal_candidate',
      'necessity_condition_candidate', 'temporal_actor_candidate']) ? require('./eventRelationOperators').instruction : '',
    has(['source_suffix_replay_candidate', 'introduced_adjacent_duplicate_candidate']) ? require('./adjacentDuplicateReview').instruction : '',
    has(require('./auditMeaningRelations').CODES) ? require('./auditMeaningRelations').instruction : '',
    has(require('./referenceRelationReview').CODES) ? require('./referenceRelationReview').instruction : '',
    has(['source_label_binding_candidate', 'introduced_delimiter_imbalance_candidate']) ? require('./sourceArtifactRelations').instruction : ''
  ].filter(Boolean).join('\n');
}
module.exports = { targets, schema, assess, instructionsFor,
  instruction: instructionsFor([{ codes: [...CODES] }]) };
