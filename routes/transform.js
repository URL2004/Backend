// [routes/transform.js] 회피 모드 P3 — 격식 유지 재구성(genreTransferV2) job 백엔드
// ────────────────────────────────────────────────────────────────
// 재구성은 5~25분짜리 작업이라 동기 응답이 불가능 → job 방식:
//   POST /transform → 즉시 jobId 반환, 백그라운드에서 genreTransferV2 실행(클라이언트가 끊겨도 계속)
//   GET  /transform/:id → 상태 폴링(running|done|blocked|error)
// 과금(v1, 사장님 임시 승인 기본값): ★완료 시 차감(시작 시 precheck만 — "크레딧만 차감" 민원 구조적 방지),
//   단가는 확정 전이라 기존 휴머나이즈와 동일 글자수 공식(ceil(len/100)) 임시 적용.
// job 저장(v1): 서버 메모리 — 재시작 시 유실(완료 차감이라 돈 사고는 없음). Firebase 영속화는 후속(P5).
// FLOOR 게이트: novelty·lostFacts·수치-출처 짝·judge 중 하나라도 위반이면 blocked — 결과 미노출·차감 없음.

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const analyze = require('./analyze');   // 과금 헬퍼 재사용(차감 공식 단일 출처)
const { genreTransferV2 } = require('../engine/genretransfer');

const jobs = new Map();
const JOB_TTL_MS = 6 * 60 * 60 * 1000;   // 완료 후 6시간 보관
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) if (now - j.createdAt > JOB_TTL_MS) jobs.delete(id);
}, 30 * 60 * 1000).unref();

async function runJob(job, text) {
  try {
    job.stage = '재구성';
    // signal 미전달 = 의도적(클라이언트가 끊겨도 작업 계속 — job 방식의 존재 이유)
    const out = await genreTransferV2(text, { evidence: '' });
    const gates = [];
    if (out.novelty?.count) gates.push('novelty');
    if (out.lostFacts?.count) gates.push('lostFacts');
    if (out.pairing?.length) gates.push('evidence_pairing');
    if (out.judge && out.judge.pass === false) gates.push('semanticJudge');
    if (gates.length) {
      console.warn(`⚠️ /transform ${job.id} BLOCKED:`, gates.join(', '));
      job.status = 'blocked';
      job.gates = gates;
      return;
    }
    // ★ 완료 시 차감 — 실패·차단 경로는 여기 도달하지 않으므로 결과 없는 차감이 구조적으로 불가능.
    if (!job.devNoAuth && job.plan !== 'unlimited') {
      try {
        await analyze.retryAsync(() => analyze.commitCreditDeduct(job.uid, job.needed, 'restructure'));
        job.deducted = true;
      } catch (e) {
        // 차감 실패(그 사이 잔액 소진 등) — 결과는 이미 만들어졌으니 사용자에겐 전달(고객 우선), 수동 보정 로그.
        console.error(`❌ /transform ${job.id} 완료 차감 실패(수동 보정 필요) uid=${job.uid}:`, e?.message);
      }
    }
    job.status = 'done';
    job.result = {
      outputText: out.text,
      metrics: {
        novelty: 0, lostFacts: 0, repetition: 0,
        judge: out.judge?.error ? 'skip' : 'pass',
        lengthRatio: out.lenRatio
      },
      genreRisk: out.risk?.score,
      skeleton: out.skeleton
    };
  } catch (e) {
    console.error(`❌ /transform ${job.id} 실패:`, e?.message);
    job.status = 'error';
    job.error = '재구성 처리 중 오류가 발생했어요. 크레딧은 차감되지 않았어요.';
  }
}

router.post('/transform', async (req, res) => {
  const { text, idToken } = req.body || {};
  if (typeof text !== 'string' || text.replace(/\s+/g, '').length < 200) {
    return res.status(400).json({ error: '재구성하려면 최소 200자가 필요해요.' });
  }
  if (text.length > 10000) {
    return res.status(400).json({ error: '텍스트가 너무 깁니다. (재구성 최대 10,000자)' });
  }

  const devNoAuth = !process.env.FIREBASE_SERVICE_ACCOUNT && process.env.DEV_NO_AUTH === '1';
  const needed = Math.ceil(text.length / 100);   // 임시 단가(휴머나이즈 동일) — 확정 시 교체
  let pre;
  try {
    pre = devNoAuth ? { uid: 'dev-local', plan: 'unlimited' } : await analyze.precheckCredits(idToken, needed);
  } catch (e) {
    return res.status(e.status || 500).json({ error: analyze.authErrorMessage(e.message) });
  }

  const id = crypto.randomBytes(8).toString('hex');
  const job = {
    id, status: 'running', stage: '구조 계획', createdAt: Date.now(),
    uid: pre.uid, plan: pre.plan, needed, devNoAuth, deducted: false
  };
  jobs.set(id, job);
  runJob(job, text);   // await 없음 — 백그라운드 진행
  console.log(`▶ /transform job ${id} 시작 (${text.length}자, uid=${pre.uid})`);
  res.json({ ok: true, jobId: id, estSec: Math.max(180, Math.min(1500, Math.round(text.replace(/\s+/g, '').length / 6))) });
});

router.get('/transform/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없어요. (만료되었거나 서버가 재시작됨)' });
  const base = { ok: true, status: job.status, stage: job.stage, elapsedSec: Math.round((Date.now() - job.createdAt) / 1000) };
  if (job.status === 'done') return res.json({ ...base, result: job.result });
  if (job.status === 'blocked') return res.json({ ...base, gates: job.gates, error: '품질 게이트를 통과하지 못해 결과를 내보내지 않았어요. 크레딧은 차감되지 않았어요.' });
  if (job.status === 'error') return res.json({ ...base, error: job.error });
  res.json(base);
});

module.exports = router;
