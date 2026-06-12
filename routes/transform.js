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
const { db } = require('../config');
const { genreTransferV2 } = require('../engine/genretransfer');
const { suggestEvidence } = require('../engine/evidence');
const { reviewCandidates, hostOf } = require('../engine/evidencereview');

const jobs = new Map();
const JOB_TTL_MS = 6 * 60 * 60 * 1000;   // 완료 후 6시간 보관
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (now - j.createdAt > JOB_TTL_MS) { jobs.delete(id); deletePersisted(id); }
  }
  const today = kstDay();
  for (const [uid, d] of dailyStarts) if (d.day !== today) dailyStarts.delete(uid);
}, 30 * 60 * 1000).unref();

// ── 비용 방어(2026-06-12): 차감이 완료 시점이라 차단·에러·취소 job의 원가(최대 $7)는 회사 부담 →
//   동시·일일 한도로 최악 비용을 캡. 한도는 "운영자가 감당 가능한 하루 최대 손실" 기준으로 env 조정.
const MAX_ACTIVE_GLOBAL = Number(process.env.RESTRUCTURE_MAX_ACTIVE) || 3;   // 전역 동시 실행(LLM 점유) 상한
const DAILY_CAP_PER_UID = Number(process.env.RESTRUCTURE_DAILY_CAP) || 8;    // 사용자당 일일 시작 횟수(취소·차단 포함)
const dailyStarts = new Map();   // uid → { day, count } — 메모리 보관(재시작 시 리셋은 사용자에게 유리한 방향이라 허용)

function kstDay() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

// ★ 과금 정책(2026-06-12 길이 구간 정액): 재구성은 슬롯·위빙이 글자수에 비례해 원가가 길수록 큼($2.5~7) →
//   만 자 구간별 정액. 원가의 ~1.5배 마진. (~1만 200/300 · ~2만 400/500 · ~3만 600/700)
//   감지 보고서(detectreport.js)의 비용 안내도 이 함수를 재사용 — 단가 단일 출처.
function restructureCredit(len, ev) {
  var tier = len <= 10000 ? 0 : (len <= 20000 ? 1 : 2);
  var base = [200, 400, 600][tier];
  return base + (ev ? 100 : 0);
}
router.restructureCredit = restructureCredit;

function countActive(uid) {
  let running = 0, mine = 0;
  for (const j of jobs.values()) {
    if (j.status === 'running') running++;
    // 승인 대기는 LLM을 안 쓰지만 사용자 기준으로는 "진행 중 작업" — 같은 사용자가 쌓아두는 건 막는다.
    if (j.uid === uid && (j.status === 'running' || j.status === 'awaiting_approval')) mine++;
  }
  return { running, mine };
}

function checkLimits(uid) {
  const { running, mine } = countActive(uid);
  if (mine >= 1) return { status: 409, error: '이미 진행 중인 재구성 작업이 있어요. 완료(또는 취소) 후 다시 시작해 주세요.' };
  if (running >= MAX_ACTIVE_GLOBAL) return { status: 503, error: '지금 재구성 요청이 몰려 있어요. 잠시 후(5~10분) 다시 시도해 주세요.' };
  const day = kstDay();
  const d = dailyStarts.get(uid);
  if (d && d.day === day && d.count >= DAILY_CAP_PER_UID) {
    return { status: 429, error: `재구성은 하루 ${DAILY_CAP_PER_UID}회까지 시작할 수 있어요. 내일 다시 시도해 주세요.` };
  }
  return null;
}

function recordStart(uid) {
  const day = kstDay();
  const d = dailyStarts.get(uid);
  if (d && d.day === day) d.count++;
  else dailyStarts.set(uid, { day, count: 1 });
}

// ── job 영속화(2026-06-12): Firestore transformJobs — 재시작에도 결과·승인대기 생존.
//   90분짜리 job이 도는 서비스에서 영속화 없는 배포 = 누군가의 90분이 증발. 로컬(db 없음)은 무동작.
//   AbortController 등 비직렬화 필드는 제외하고 상태 전이 시점마다 스냅샷 저장(fire-and-forget — 저장 실패가 job을 죽이면 안 됨).
const PERSIST_FIELDS = ['id', 'status', 'stage', 'createdAt', 'uid', 'plan', 'needed', 'devNoAuth', 'deducted',
  'text', 'estSec', 'note', 'gates', 'gateDetail', 'candidates', 'approvedCount', 'result', 'error'];

function persistJob(job) {
  if (!db) return;
  const doc = {};
  for (const k of PERSIST_FIELDS) if (job[k] !== undefined) doc[k] = job[k];
  db.collection('transformJobs').doc(job.id).set(doc, { merge: true })
    .catch(e => console.error(`⚠️ /transform ${job.id} 영속화 실패(작업은 계속):`, e?.message));
}

function deletePersisted(id) {
  if (!db) return;
  db.collection('transformJobs').doc(id).delete()
    .catch(e => console.error(`⚠️ /transform ${id} 영속 삭제 실패:`, e?.message));
}

// 서버 시작 시 복원: done·blocked·awaiting_approval은 그대로 살리고(폴링·승인 재개 가능),
// running이었던 job은 프로세스가 죽어 실제로는 중단됨 → error로 정정(완료 차감이라 돈 사고는 없음).
async function restoreJobs() {
  if (!db) return;
  try {
    const snap = await db.collection('transformJobs').limit(500).get();
    const cutoff = Date.now() - JOB_TTL_MS;
    let kept = 0, interrupted = 0, expired = 0;
    snap.forEach(d => {
      const j = d.data();
      if (!j.createdAt || j.createdAt < cutoff) { expired++; deletePersisted(d.id); return; }
      j.ac = new AbortController();
      if (j.status === 'running') {
        j.status = 'error';
        j.stage = '중단됨(서버 재시작)';
        j.error = '서버 재시작으로 작업이 중단됐어요. 크레딧은 차감되지 않았어요 — 다시 시도해 주세요.';
        interrupted++;
        persistJob(j);
      }
      jobs.set(j.id, j);
      kept++;
    });
    if (kept || expired) console.log(`[transform] 영속 job 복원 ${kept}건 (running→중단 정정 ${interrupted}건, 만료 정리 ${expired}건)`);
  } catch (e) {
    console.error('⚠️ [transform] 영속 job 복원 실패(새 작업은 정상):', e?.message);
  }
}
restoreJobs();

// ── graceful shutdown(server.js가 SIGTERM/SIGINT에서 호출): 새 작업 거부 → 진행 중 LLM 중단(비용 차단) →
//   중단 상태 영속화. 차감은 완료 시에만 일어나므로 여기서 돈이 새는 경로는 없다.
let draining = false;
router.shutdown = async function shutdown() {
  draining = true;
  const writes = [];
  for (const j of jobs.values()) {
    if (j.status === 'running') {
      try { j.ac.abort(); } catch {}
      j.status = 'error';
      j.stage = '중단됨(서버 재시작)';
      j.error = '서버 재시작으로 작업이 중단됐어요. 크레딧은 차감되지 않았어요 — 다시 시도해 주세요.';
    }
    if (db) {
      const doc = {};
      for (const k of PERSIST_FIELDS) if (j[k] !== undefined) doc[k] = j[k];
      writes.push(db.collection('transformJobs').doc(j.id).set(doc, { merge: true }).catch(() => {}));
    }
  }
  await Promise.race([Promise.allSettled(writes), new Promise(r => setTimeout(r, 4000))]);
};
router.stats = () => {
  const { running } = countActive('');
  return { activeJobs: running, totalJobs: jobs.size, draining, maxActive: MAX_ACTIVE_GLOBAL };
};

// ── P4: 근거 검색 단계(evidence:true일 때 재구성 전에 실행) ──
//   검색(웹·환각게이트) → 결정론 검수(등급·충돌) → awaiting_approval로 멈추고 학생 승인 대기.
//   승인 전이므로 과금 없음. 후보 0건이면 근거 없이 바로 재구성 진행(차단 아님 — 검색 실패가 작업을 죽이면 안 됨).
async function runSearchPhase(job, text) {
  try {
    job.stage = '근거 검색';
    const ev = await suggestEvidence(text, { maxSegments: Number(process.env.EVIDENCE_MAX_SEGMENTS) || 6, signal: job.ac.signal });
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
    persistJob(job);   // 승인 대기는 재시작 후에도 text·후보가 살아 있어 그대로 승인→재개 가능
    console.log(`▶ /transform ${job.id} 근거 ${job.candidates.length}건 검수 대기 (A ${job.candidates.filter(c => c.grade === 'A').length}·B ${job.candidates.filter(c => c.grade === 'B').length}·C ${job.candidates.filter(c => c.grade === 'C').length}·충돌 ${job.candidates.filter(c => c.conflict).length})`);
  } catch (e) {
    if (job.ac.signal.aborted) {
      if (job.status !== 'error') { job.status = 'cancelled'; job.stage = '중단됨'; persistJob(job); }
      return;
    }
    console.error(`❌ /transform ${job.id} 근거 검색 실패 — 근거 없이 진행:`, e?.message);
    job.note = '근거 검색이 실패해 근거 없이 진행했어요.';
    return runJob(job, text, '');
  }
}

async function runJob(job, text, evidence) {
  try {
    job.status = 'running';
    job.stage = '재구성';
    persistJob(job);   // 승인 재개(awaiting→running) 전이 포함
    // 클라이언트 disconnect로는 안 죽는다(job 방식) — 단 명시적 취소(/cancel)의 AbortController만 전달.
    const out = await genreTransferV2(text, { evidence: evidence || '', signal: job.ac.signal });
    const gates = [];
    if (out.novelty?.count) gates.push('novelty');
    if (out.lostFacts?.count) gates.push('lostFacts');
    if (out.pairing?.length) gates.push('evidence_pairing');
    if (out.judge && out.judge.pass === false) gates.push('semanticJudge');
    if (gates.length) {
      // 차단 상세를 남긴다 — "왜 막혔는지" 없는 차단은 진단 불가(2753자 글 연속 차단 실사고).
      const gateDetail = {
        novelty: (out.novelty?.items || []).slice(0, 5),
        lostFacts: (out.lostFacts?.items || []).slice(0, 8),
        pairing: (out.pairing || []).slice(0, 3).map(p => `${p.num}↛${(p.owner || '').slice(0, 40)}`),
        judge: (out.judge?.violations || []).slice(0, 5).map(v => `[${v.type}] "${(v.span || '').slice(0, 70)}" — ${(v.detail || '').slice(0, 100)}`)
      };
      console.warn(`⚠️ /transform ${job.id} BLOCKED: ${gates.join(', ')}\n   상세: ${JSON.stringify(gateDetail, null, 1).slice(0, 1200)}`);
      job.status = 'blocked';
      job.gates = gates;
      job.gateDetail = gateDetail;
      persistJob(job);
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
    persistJob(job);
  } catch (e) {
    if (job.ac.signal.aborted) {
      // shutdown이 이미 error(서버 재시작 안내)로 표시한 job을 "사용자 취소"로 덮어쓰면 안 됨 — abort 출처 구분.
      if (job.status !== 'error') { job.status = 'cancelled'; job.stage = '중단됨'; persistJob(job); }
      return;
    }
    console.error(`❌ /transform ${job.id} 실패:`, e?.message);
    job.status = 'error';
    job.error = '재구성 처리 중 오류가 발생했어요. 크레딧은 차감되지 않았어요.';
    persistJob(job);
  }
}

router.post('/transform', async (req, res) => {
  const { text, idToken } = req.body || {};
  if (typeof text !== 'string' || text.replace(/\s+/g, '').length < 200) {
    return res.status(400).json({ error: '재구성하려면 최소 200자가 필요해요.' });
  }
  if (text.length > 30000) {
    return res.status(400).json({ error: '텍스트가 너무 깁니다. (재구성 최대 30,000자)' });
  }
  if (draining) {
    return res.status(503).json({ error: '서버가 점검을 위해 재시작 중이에요. 1~2분 후 다시 시도해 주세요.' });
  }

  const devNoAuth = !process.env.FIREBASE_SERVICE_ACCOUNT && process.env.DEV_NO_AUTH === '1';
  const wantEvidence = req.body.evidence === true;
  const needed = restructureCredit(text.length, wantEvidence);
  let pre;
  try {
    pre = devNoAuth ? { uid: 'dev-local', plan: 'unlimited' } : await analyze.precheckCredits(idToken, needed);
  } catch (e) {
    return res.status(e.status || 500).json({ error: analyze.authErrorMessage(e.message) });
  }
  // 한도는 인증 후(uid 확정) 검사 — 비용 방어의 본체. 시작 성공 시에만 일일 카운트.
  const limited = checkLimits(pre.uid);
  if (limited) return res.status(limited.status).json({ error: limited.error });
  recordStart(pre.uid);

  const id = crypto.randomBytes(8).toString('hex');
  const bare = text.replace(/\s+/g, '').length;
  // 예상 시간: 슬롯 순차 생성이라 길이에 거의 선형(실측 college 1.8K=11분(근거)·7분(무근거)). 약간 과대 추정이
  // 과소 추정보다 낫다(99%에 오래 머무는 것보다 60%에 끝나는 게 체감이 좋음). 상한 90분(3만자 대비).
  const estSec = Math.max(240, Math.min(5400, Math.round(bare / 4) + (wantEvidence ? 480 : 0)));
  const job = {
    id, status: 'running', stage: wantEvidence ? '근거 검색' : '구조 계획', createdAt: Date.now(),
    uid: pre.uid, plan: pre.plan, needed, devNoAuth, deducted: false,
    text,   // 승인 후 재개용(v1 메모리 보관 — TTL로 정리)
    estSec,
    ac: new AbortController()   // 명시적 취소용(/cancel)
  };
  jobs.set(id, job);
  persistJob(job);
  if (wantEvidence) runSearchPhase(job, text);   // await 없음 — 백그라운드 진행
  else runJob(job, text, '');
  console.log(`▶ /transform job ${id} 시작 (${text.length}자, uid=${pre.uid}, 근거=${wantEvidence ? 'ON' : 'OFF'}, 예상 ${Math.round(estSec / 60)}분)`);
  res.json({ ok: true, jobId: id, estSec });
});

// ── 명시적 취소: 진행 중 LLM 호출을 abort — 차감은 완료 시에만 일어나므로 취소=항상 무과금.
router.post('/transform/:id/cancel', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없어요.' });
  if (job.status === 'done' || job.status === 'blocked' || job.status === 'error') {
    return res.status(409).json({ error: '이미 끝난 작업이에요.' });
  }
  job.ac.abort();
  job.status = 'cancelled';
  job.stage = '중단됨';
  persistJob(job);
  console.log(`■ /transform ${job.id} 사용자 취소 (uid=${job.uid})`);
  res.json({ ok: true });
});

// ── P4: 근거 승인 — 승인된 후보만 evidence로 재구성 재개. "미승인은 엔진이 차단"의 구현부:
//   엔진에 전달되는 허용 세계 자체가 승인 목록뿐이므로 미승인 사실은 novelty 게이트가 자동 차단.
router.post('/transform/:id/approve', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없어요. (만료되었거나 서버가 재시작됨)' });
  if (job.status !== 'awaiting_approval') return res.status(409).json({ error: '지금은 승인 단계가 아니에요.' });
  if (draining) return res.status(503).json({ error: '서버가 점검을 위해 재시작 중이에요. 1~2분 후 다시 승인해 주세요. (작업은 사라지지 않아요)' });
  // 승인 = LLM 재구성 시작이므로 전역 동시 한도를 여기서도 검사 — 승인 화면에 머물던 job들이 한꺼번에 풀리는 경로.
  if (countActive('').running >= MAX_ACTIVE_GLOBAL) {
    return res.status(503).json({ error: '지금 재구성 요청이 몰려 있어요. 잠시 후(5~10분) 다시 승인해 주세요. (작업은 사라지지 않아요)' });
  }
  const ids = Array.isArray(req.body?.approved) ? req.body.approved : [];
  let approved = (job.candidates || []).filter(c => ids.includes(c.id));
  // ★승인 수 캡(2026-06-12 실측 캘리브레이션): 사실 밀도 ~350자당 1건 초과는 위빙 생존 검증이 못 버팀
  //   (성공 290자/건·17건 vs 실패 240자/건·24건=36분 후 lostFacts 차단). 초과분은 A등급·무충돌 우선으로 유지.
  const bare = (job.text || '').replace(/\s+/g, '').length;
  const cap = Number(process.env.EVIDENCE_APPROVE_CAP) || Math.max(8, Math.min(18, Math.floor(bare / 350)));
  if (approved.length > cap) {
    const rank = (c) => (c.conflict ? 2 : 0) + (c.grade === 'A' ? 0 : c.grade === 'B' ? 1 : 3);
    approved = approved.slice().sort((a, b) => rank(a) - rank(b)).slice(0, cap);
    job.note = `근거가 많아 사실 보존 검증이 가능한 상위 ${cap}건(공식 출처 우선)만 사용했어요.`;
    console.warn(`⚠️ /transform ${job.id} 승인 ${ids.length}건 → 캡 ${cap}건 적용`);
  }
  const lines = approved.map(c => `${c.fact} (출처: ${c.sourceTitle || c.host})`);
  job.approvedCount = approved.length;
  console.log(`▶ /transform ${job.id} 근거 승인 ${approved.length}/${(job.candidates || []).length}건 — 재구성 재개`);
  runJob(job, job.text, lines.join('\n'));   // await 없음
  res.json({ ok: true, approved: approved.length });
});

router.get('/transform/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없어요. (만료되었거나 서버가 재시작됨)' });
  const base = { ok: true, status: job.status, stage: job.stage, elapsedSec: Math.round((Date.now() - job.createdAt) / 1000), estSec: job.estSec, ...(job.note ? { note: job.note } : {}) };
  if (job.status === 'done') return res.json({ ...base, result: job.result });
  if (job.status === 'awaiting_approval') return res.json({ ...base, candidates: job.candidates });
  if (job.status === 'cancelled') return res.json(base);
  if (job.status === 'blocked') return res.json({ ...base, gates: job.gates, gateDetail: job.gateDetail, error: '품질 게이트를 통과하지 못해 결과를 내보내지 않았어요. 크레딧은 차감되지 않았어요. 같은 설정으로 다시 시도하면 통과되는 경우가 많아요.' });
  if (job.status === 'error') return res.json({ ...base, error: job.error });
  res.json(base);
});

module.exports = router;
