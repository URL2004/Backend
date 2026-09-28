'use strict';

const { textDigest } = require('./semanticProvenance');
const CODES = new Set(['temporal_limit_candidate', 'sole_reason_candidate',
  'mental_onset_strength_candidate', 'additive_concession_candidate', 'certainty_scope_candidate',
  'alternative_conjunction_candidate']);
const unique = (text, span) => typeof span === 'string' && span.length >= 12
  && text.indexOf(span) >= 0 && text.indexOf(span) === text.lastIndexOf(span);

// A candidate is a question, not an error. Explicit answers prevent a fluent
// rewrite's small logical operators from disappearing in an empty verdict.
function targets(source, candidate) {
  const grouped = new Map();
  for (const c of require('./relationAudit').auditRelationCandidates(source, candidate, { includeAllCandidates: true }).candidates) {
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
      id: { type: 'string', enum: selected.map(t => t.id) },
      status: { type: 'string', enum: ['preserved', 'changed', 'uncertain'] },
      sourceSpan: { type: 'string' }, candidateSpan: { type: 'string' }, detail: { type: 'string' }
    }, required: ['id', 'status', 'sourceSpan', 'candidateSpan', 'detail']
  } } }, required: [...base.required, 'operatorReviews'] };
}

function assess(all, reviews, findings, source, candidate) {
  const pending = [], accepted = [];
  for (const t of all) {
    const answers = (reviews || []).filter(r => r?.id === t.id);
    // Empty quotes explicitly reference the immutable spans carried by this ID.
    // Omitted fields and an absent answer are NOT references and remain invalid.
    const answer = answers[0], r = answer && { ...answer,
      sourceSpan: answer.sourceSpan === '' ? t.sourceSpan : answer.sourceSpan,
      candidateSpan: answer.candidateSpan === '' ? t.candidateSpan : answer.candidateSpan };
    // A reviewer can expand a split sentence to its actual adjacent context,
    // but cannot cite another occurrence or evade the nominated owner.
    const valid = answers.length === 1 && ['preserved', 'changed', 'uncertain'].includes(r.status)
      && unique(source, r.sourceSpan) && unique(candidate, r.candidateSpan)
      && r.sourceSpan.includes(t.sourceSpan) && r.candidateSpan.includes(t.candidateSpan)
      && typeof r.detail === 'string' && r.detail.trim().length >= 8;
    const substantive = findings.some(v => v.origin === 'introduced' && v.repairable
      && v.sourceSpan && (v.sourceSpan.includes(t.sourceSpan) || t.sourceSpan.includes(v.sourceSpan)));
    accepted.push({ id: t.id, status: valid ? r.status : 'unconfirmed' });
    if (substantive || (valid && r.status === 'preserved')) continue;
    pending.push({ type: 'distortion', origin: 'unconfirmed', relation: 'modality_negation_causality',
      sourceSpan: t.sourceSpan, candidateSpan: t.candidateSpan, span: '', repairable: false,
      relationGrounded: false, grounding: 'unresolved_operator_review',
      detail: valid ? r.detail : 'The nominated operator relationship was not explicitly adjudicated.' });
  }
  return { pending, reviews: accepted };
}

const instruction = 'OPERATOR_REVIEW_TARGETS는 오류 정답이 아니라 대응 관계 질문이다. 각 id에 operatorReviews를 반드시 반환한다. SOURCE·REWRITE의 앞뒤 문장까지 읽고 같은 주체의 시점 한정·유일 원인·감정의 발생/증가·추가/양보·확신·선택 관계가 유지되면 preserved, 실제 신규 변화이면 changed, 대응을 확정하지 못하면 uncertain으로 판정한다. 다른 문장에 같은 단어가 있다는 이유만으로 preserved를 주지 않는다. 자연스러운 동의 표현·같은 주체의 공유 양태·정상적인 문장 분리는 허용한다. sourceSpan/candidateSpan은 대상 구절을 포함하는 정확한 현재 인용이어야 하며 필요하면 인접 문장까지 확장한다. detail에는 실제 논리 비교 근거를 짧게 쓴다. changed이면 별도로 violations에 현재 위치가 확인된 introduced 오류를 기록한다. 이 목록만 검사하지 말고 나머지 문서도 검수한다.';
const compactInstruction = '출력 중복 방지: operatorReviews의 sourceSpan/candidateSpan이 해당 id의 입력 구절과 정확히 같으면 긴 구절을 다시 쓰지 말고 빈 문자열로 해당 구절을 참조한다. 앞뒤 문맥을 확장해야 할 때만 실제 확장된 인용을 쓴다. id·status·detail은 생략하지 않는다. detail은 결론을 지지하는 관계 비교 한 문장으로 쓴다. violations의 실제 오류 근거는 빈 문자열로 줄이지 않는다.';
module.exports = { targets, schema, assess, instruction: instruction + '\n' + compactInstruction };
