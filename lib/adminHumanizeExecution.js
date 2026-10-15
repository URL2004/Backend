'use strict';

const { createExecutionCoordinator } = require('./transformExecution');
const { executionLimits } = require('./humanizeCapacity');

function createAdminHumanizeExecution({ db, runHumanize, logger, env = process.env,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval } }) {
  const coordinator = createExecutionCoordinator({ db, ...executionLimits(env) });
  const configuredTimeout = Number(env.ADMIN_HUMANIZE_TEST_TIMEOUT_MS);
  const timeoutMs = Math.max(1000, Math.min(600000,
    Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 300000));
  const controllers = new Set();
  let draining = false;
  let pendingAdmissions = 0;
  const drainingError = () => Object.assign(new Error('서버 점검 중에는 운영 테스트를 시작할 수 없습니다.'), { code: 'SERVER_DRAINING', status: 503 });

  async function runAdminHumanize({ uid, options, signal }) {
    if (draining) throw drainingError();
    if (!db) throw Object.assign(new Error('운영 작업의 실행 상태를 확인할 수 없어 테스트를 시작하지 못했습니다.'), { status: 503 });
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    // Include pending acquisition and final lease release in readiness counts.
    // Shutdown must also reach requests whose transaction has not returned yet.
    controllers.add(controller);
    pendingAdmissions++;
    let lease, timer, heartbeat, acquiring = true;
    try {
      lease = await coordinator.acquireAdmin({ uid });
      pendingAdmissions--; acquiring = false;
      controller.signal.throwIfAborted();
      if (!lease) throw Object.assign(new Error('다른 작업이 처리 중이거나 계정이 이용 불가 상태입니다. 잠시 후 다시 테스트해 주세요.'), { status: 409 });
      const deadlineMs = Date.now() + timeoutMs;
      timer = timers.setTimeout(() => controller.abort(Object.assign(new Error('Admin test deadline exceeded'), { code: 'JOB_DEADLINE' })), timeoutMs);
      heartbeat = timers.setInterval(() => {
        const lost = () => controller.abort(Object.assign(new Error('Execution lease lost'), { code: 'EXECUTION_LEASE_LOST' }));
        void coordinator.renew(lease).then(ok => { if (!ok) lost(); }, lost);
      }, 20000);
      return await runHumanize({ ...options, uid, signal: controller.signal, deadlineMs });
    } finally {
      if (acquiring) pendingAdmissions--;
      if (timer !== undefined) timers.clearTimeout(timer);
      if (heartbeat !== undefined) timers.clearInterval(heartbeat);
      signal?.removeEventListener('abort', abort);
      try {
        if (lease) await coordinator.release(lease).catch(error => logger?.warn('admin.humanize_lease_release_failed', { uid, error }));
      } finally {
        controllers.delete(controller);
      }
    }
  }
  runAdminHumanize.shutdown = () => {
    draining = true;
    for (const controller of controllers) controller.abort(drainingError());
  };
  runAdminHumanize.stats = () => ({ activeJobs: controllers.size, pendingAdmissions, draining });
  return runAdminHumanize;
}

module.exports = { createAdminHumanizeExecution };
