'use strict';

const STATES = {
  done: ['작업 완료', '결과가 준비됐어요. 작업 기록에서 확인해 주세요.', 'history'],
  error: ['작업 확인 필요', '작업을 완료하지 못했어요. 작업 화면에서 상태를 확인하고 다시 시도해 주세요.', 'main'],
  blocked: ['결과 확인 필요', '검수 기준을 충족하지 못한 부분이 있어요. 작업 화면에서 가능한 다음 단계를 확인해 주세요.', 'main'],
  awaiting_payment: ['결과 보관 중', '결과를 보관하고 있어요. 작업 화면에서 잔액 확인 후 결과 받기를 진행해 주세요.', 'main'],
  awaiting_approval: ['근거 승인 필요', '사용할 근거 자료가 준비됐어요. 작업 화면에서 확인하고 승인해 주세요.', 'main'],
  cancelled: ['작업 중단', '작업이 중단됐어요. 필요하면 입력을 확인한 뒤 다시 시작해 주세요.', 'main']
};

function jobNotification(job, previous, nowMs) {
  if (!job || !job.uid || !job.id || job.adminHumanizeLab || job.structurePreview) return null;
  const state = STATES[job.status];
  if (!state || previous?.status === job.status) return null;
  const revision = (Number(previous?.notificationRevision) || 0) + 1;
  const id = `job_event_${job.id}_${revision}`;
  return { id, revision, data: {
    clientId: id, type: job.status === 'done' ? 'job_done' : 'job_status',
    title: state[0], message: state[1], read: false,
    action: { tab: state[2] }, jobId: job.id, jobStatus: job.status,
    createdAt: new Date(nowMs), createdAtMs: nowMs, writeSource: 'server_job_transition'
  }};
}
module.exports = { jobNotification };
