'use strict';

const POLISH_BAND = Object.freeze({ A: '30~55%', B: '60~85%', C: '85%+' });
const BLOG_BAND = Object.freeze({ A: '30~45%', B: '35~50%', C: '40~55%' });
const RESTRUCTURE_BAND = '35~60%';

const COPY = Object.freeze({
  A: Object.freeze({
    title: '구체적 정보가 풍부한 글이에요',
    desc: '구체적인 수치·사례·이름이 있어요. 내용은 유지하고 문체에서 다듬을 부분을 확인해 보세요.'
  }),
  B: Object.freeze({
    title: '추상과 구체가 섞인 글이에요',
    desc: '일부 문단이 일반론에 가까워요. AI 티 줄이기로 더 사람이 쓴 글에 가깝게 만들 수 있어요.'
  }),
  C: Object.freeze({
    title: '추상적 일반론 비중이 높은 글이에요',
    desc: '일반적인 설명이 많아요. 원문에 있는 구체적인 근거를 연결하고 반복되는 표현을 확인해 보세요.'
  })
});

const BANDS = Object.freeze({ POLISH_BAND, BLOG_BAND, RESTRUCTURE_BAND });

function contentPresentation(reportView, detail = []) {
  const { resolveContentEvidence, applyContentEvidencePolicy } = require('./detectReportView');
  const evidence = reportView.contentEvidence;
  const policy = reportView.measuredEvidence.axisPolicy;
  const grade = evidence.findingStatus === 'not_found' ? null : { strong: 'A', mixed: 'B', weak: 'C' }[evidence.status] || null;
  const paragraphs = detail.map((item, index) => {
    if (item.excluded) return { kind: 'excluded', assessmentStatus: 'excluded',
      reason: '인용·코드·제목 등 보존 영역이라 문체 측정에서 제외했어요.' };
    const context = reportView.contentContexts?.[index];
    const local = applyContentEvidencePolicy(resolveContentEvidence({ detail: [{ ...item,
      ...(context ? { grounded: context.grounded } : {}) }] }), policy);
    const assessed = ['strong', 'mixed', 'weak'].includes(local.status);
    return { kind: !assessed ? 'not_assessed' : local.status === 'strong' ? 'concrete'
      : Number(item.generic) > 0 ? 'abstract_risk' : 'thin',
    assessmentStatus: local.status,
    findingStatus: local.findingStatus,
    ...(context ? { role: context.role, contentContext: context } : {}),
    reason: !assessed ? local.reason || '문장이 적어 내용 근거의 충분성을 평가하지 않았어요.'
      : local.findingStatus === 'not_found' ? local.reason
      : `${local.label}. 이 비율만으로 사실의 정확성이나 근거의 충분성을 단정하지 않아요.` };
  });
  return { grade, title: evidence.label, assessmentStatus: evidence.status, paragraphs };
}

function filterContentCoach(coach, reportView, { evidenceStatus, sentenceCount, findingStatus, contentContext } = {}) {
  if (!Array.isArray(coach)) return null;
  const policy = reportView.measuredEvidence.axisPolicy.axes;
  const status = evidenceStatus || reportView.contentEvidence.status;
  const finding = findingStatus || reportView.contentEvidence.findingStatus;
  const contexts = contentContext ? [contentContext] : (reportView.contentContexts || []).filter(Boolean);
  const filtered = coach.filter(item => {
    if (Number(sentenceCount) < 3 || ['limited', 'excluded', 'not_assessed'].includes(status)) return false;
    if (['구체적 근거 부족', '추상적, 일반적 내용 구성'].includes(item.tag)) {
      // A low heuristic count cannot establish an actual content deficiency.
      return policy.anchor.status === 'on' && status === 'weak' && finding === 'deficient';
    }
    if (['주관성의 지나친 배제', '무견해, 판단 회피적 성향', '간접 화법, 비인칭 서술'].includes(item.tag)) {
      return policy.stance.status === 'on' && contexts.length > 0
        && Number(reportView.measuredEvidence.stanceRatio) < policy.stance.target
        && contexts.every(context => context.stanceApplicable && !context.cautious);
    }
    return false;
  });
  return filtered.length ? filtered : null;
}

module.exports = {
  POLISH_BAND,
  BLOG_BAND,
  RESTRUCTURE_BAND,
  BANDS,
  COPY,
  contentPresentation,
  filterContentCoach
};
