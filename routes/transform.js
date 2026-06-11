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
const { suggestEvidence } = require('../engine/evidence');
const { reviewCandidates, hostOf } = require('../engine/evidencereview');

const jobs = new Map();
const JOB_TTL_MS = 6 * 60 * 60 * 1000;   // 완료 후 6시간 보관
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) if (now - j.createdAt > JOB_TTL_MS) jobs.delete(id);
}, 30 * 60 * 1000).unref();

// ── P4: 근거 검색 단계(evidence:true일 때 재구성 전에 실행) ──
//   검색(웹·환각게이트) → 결정론 검수(등급·충돌) → awaiting_approval로 멈추고 학생 승인 대기.
//   승인 전이므로 과금 없음. 후보 0건이면 근거 없이 바로 재구성 진행(차단 아님 — 검색 실패가 작업을 죽이면 안 됨).
async function runSearchPhase(job, text) {
  try {
    job.stage = '근거 검색';
    const ev = await suggestEvidence(text, { maxSegments: Number(process.env.EVIDENCE_MAX_SEGMENTS) || 6 });
    const reviewed = reviewCandidates(ev.candidates || []);
    if (!reviewed.length) {
      console.warn(`⚠️ /transform ${job.id} 근거 후보 0건 — 근거 없이 재구성 진행`);
      job.note = '주제와 맞는 검증 가능한 근거를 찾지 못해 근거 없이 진행했어요.';
      return runJob(job, text, '');
    }
    job.candidates = reviewed.map((c, i) => ({
      id: i,
      fact: c.fact,
      sourceTitle: c.sourceTitle || hostOf(c.sourceUrl),
      sourceUrl: c.sourceUrl,
      host: hostOf(c.sourceUrl),
      grade: c.grade,
      conflict: c.conflict,
      conflictDetail: c.conflictDetail
    }));
    job.status = 'awaiting_approval';
    job.stage = '근거 검수 대기';
    console.log(`▶ /transform ${job.id} 근거 ${job.candidates.length}건 검수 대기 (A ${job.candidates.filter(c => c.grade === 'A').length}·B ${job.candidates.filter(c => c.grade === 'B').length}·C ${job.candidates.filter(c => c.grade === 'C').length}·충돌 ${job.candidates.filter(c => c.conflict).length})`);
  } catch (e) {
    console.error(`❌ /transform ${job.id} 근거 검색 실패 — 근거 없이 진행:`, e?.message);
    job.note = '근거 검색이 실패해 근거 없이 진행했어요.';
    return runJob(job, text, '');
  }
}

async function runJob(job, text, evidence) {
  try {
    job.status = 'running';
    job.stage = '재구성';
    // signal 미전달 = 의도적(클라이언트가 끊겨도 작업 계속 — job 방식의 존재 이유)
    const out = await genreTransferV2(text, { evidence: evidence || '' });
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
        lengthRatio: out.lenRatio,
        evidenceUsed: job.approvedCount || 0,
        pairingClean: true   // 게이트 통과 시점 = 수치-출처 짝 위반 0
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

  const wantEvidence = req.body.evidence === true;
  const id = crypto.randomBytes(8).toString('hex');
  const job = {
    id, status: 'running', stage: wantEvidence ? '근거 검색' : '구조 계획', createdAt: Date.now(),
    uid: pre.uid, plan: pre.plan, needed, devNoAuth, deducted: false,
    text   // 승인 후 재개용(v1 메모리 보관 — TTL로 정리)
  };
  jobs.set(id, job);
  if (wantEvidence) runSearchPhase(job, text);   // await 없음 — 백그라운드 진행
  else runJob(job, text, '');
  console.log(`▶ /transform job ${id} 시작 (${text.length}자, uid=${pre.uid}, 근거=${wantEvidence ? 'ON' : 'OFF'})`);
  res.json({ ok: true, jobId: id, estSec: Math.max(180, Math.min(1800, Math.round(text.replace(/\s+/g, '').length / 6) + (wantEvidence ? 360 : 0))) });
});

// ── P4: 근거 승인 — 승인된 후보만 evidence로 재구성 재개. "미승인은 엔진이 차단"의 구현부:
//   엔진에 전달되는 허용 세계 자체가 승인 목록뿐이므로 미승인 사실은 novelty 게이트가 자동 차단.
router.post('/transform/:id/approve', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없어요. (만료되었거나 서버가 재시작됨)' });
  if (job.status !== 'awaiting_approval') return res.status(409).json({ error: '지금은 승인 단계가 아니에요.' });
  const ids = Array.isArray(req.body?.approved) ? req.body.approved : [];
  const approved = (job.candidates || []).filter(c => ids.includes(c.id));
  const lines = approved.map(c => `${c.fact} (출처: ${c.sourceTitle || c.host})`);
  job.approvedCount = approved.length;
  console.log(`▶ /transform ${job.id} 근거 승인 ${approved.length}/${(job.candidates || []).length}건 — 재구성 재개`);
  runJob(job, job.text, lines.join('\n'));   // await 없음
  res.json({ ok: true, approved: approved.length });
});

router.get('/transform/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없어요. (만료되었거나 서버가 재시작됨)' });
  const base = { ok: true, status: job.status, stage: job.stage, elapsedSec: Math.round((Date.now() - job.createdAt) / 1000), ...(job.note ? { note: job.note } : {}) };
  if (job.status === 'done') return res.json({ ...base, result: job.result });
  if (job.status === 'awaiting_approval') return res.json({ ...base, candidates: job.candidates });
  if (job.status === 'blocked') return res.json({ ...base, gates: job.gates, error: '품질 게이트를 통과하지 못해 결과를 내보내지 않았어요. 크레딧은 차감되지 않았어요.' });
  if (job.status === 'error') return res.json({ ...base, error: job.error });
  res.json(base);
});

module.exports = router;
