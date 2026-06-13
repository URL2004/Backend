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
const { db, verifyToken } = require('../config');
const { logger, setLogContext } = require('../lib/logger');
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
const MAX_ACTIVE_GLOBAL = Number(process.env.RESTRUCTURE_MAX_ACTIVE) || 3;   // 전역 동시 실행(LLM 점유) 상한 — formal(재구성)
const BLOG_MAX_ACTIVE = Number(process.env.BLOG_MAX_ACTIVE) || 4;            // blog(기본 피하기) 전역 동시 — 짧고 저원가라 별도 풀
const DAILY_CAP_PER_UID = Number(process.env.RESTRUCTURE_DAILY_CAP) || 8;    // 사용자당 일일 시작 횟수(취소·차단 포함) — formal만
const dailyStarts = new Map();   // uid → { day, count } — 메모리 보관(재시작 시 리셋은 사용자에게 유리한 방향이라 허용)

function tokenFromReq(req) {
  const auth = req.get('authorization') || '';
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  return (req.body && req.body.idToken) || (req.query && req.query.idToken) || '';
}

async function requireJobOwner(req, res, job) {
  if (job.devNoAuth && !process.env.FIREBASE_SERVICE_ACCOUNT && process.env.DEV_NO_AUTH === '1') {
    return job.uid || 'dev-local';
  }
  const uid = await verifyToken(tokenFromReq(req));
  if (!uid) {
    res.status(401).json({ error: '로그인이 필요해요.' });
    return null;
  }
  setLogContext({ uid });
  if (uid !== job.uid) {
    res.status(403).json({ error: '본인의 작업만 확인할 수 있어요.' });
    return null;
  }
  return uid;
}

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

// 동시 실행 풀: formal(5~90분·고원가)과 short(blog·polish, 1~3분·저원가)를 분리 — 한 풀에 섞으면 서로 굶김.
function poolOf(mode) { return (mode || 'formal') === 'formal' ? 'formal' : 'short'; }

function countActive(uid, mode) {
  let running = 0, mine = 0;
  const pool = poolOf(mode);
  for (const j of jobs.values()) {
    if (j.status === 'running' && poolOf(j.mode) === pool) running++;
    // 승인 대기는 LLM을 안 쓰지만 사용자 기준으로는 "진행 중 작업" — 같은 사용자가 쌓아두는 건 모드 무관 차단.
    if (j.uid === uid && (j.status === 'running' || j.status === 'awaiting_approval')) mine++;
  }
  return { running, mine };
}

function checkLimits(uid, mode) {
  const { running, mine } = countActive(uid, mode);
  if (mine >= 1) return { status: 409, error: '이미 진행 중인 작업이 있어요. 완료(또는 취소) 후 다시 시작해 주세요.' };
  const cap = poolOf(mode) === 'short' ? BLOG_MAX_ACTIVE : MAX_ACTIVE_GLOBAL;
  if (running >= cap) return { status: 503, error: '지금 요청이 몰려 있어요. 잠시 후(5~10분) 다시 시도해 주세요.' };
  // 일일 시작 한도는 formal(고원가)만 — short 모드는 저원가라 레이트리밋·동시 1개로 충분.
  if (mode === 'formal') {
    const day = kstDay();
    const d = dailyStarts.get(uid);
    if (d && d.day === day && d.count >= DAILY_CAP_PER_UID) {
      return { status: 429, error: `재구성은 하루 ${DAILY_CAP_PER_UID}회까지 시작할 수 있어요. 내일 다시 시도해 주세요.` };
    }
  }
  return null;
}

function recordStart(uid) {
  const day = kstDay();
  const d = dailyStarts.get(uid);
  if (d && d.day === day) d.count++;
  else dailyStarts.set(uid, { day, count: 1 });
}

function blockedReason(gates, mode) {
  const set = new Set(Array.isArray(gates) ? gates : []);
  if (set.has('semanticJudge')) return '변환 결과에 원문에 없던 사실이나 주장이 섞여 차단했어요.';
  if (set.has('lostFacts')) return '변환 결과에서 원문의 핵심 사실이나 수치가 빠져 차단했어요.';
  if (set.has('novelty')) return '변환 결과에 새 정보가 추가되어 차단했어요.';
  if (set.has('evidence_pairing')) return '수치와 출처의 짝이 맞지 않아 차단했어요.';
  if (mode === 'polish') return '문장을 다듬는 중 원문 보존 기준을 통과하지 못해 차단했어요.';
  return '품질 게이트를 통과하지 못해 결과를 내보내지 않았어요.';
}

function blockedNextActions(gates, mode) {
  const set = new Set(Array.isArray(gates) ? gates : []);
  if (mode === 'formal') {
    if (set.has('semanticJudge') || set.has('novelty')) {
      return [
        '같은 설정으로 반복하기보다 그대로 다듬기를 사용해 주세요.',
        '고급 피하기를 다시 쓸 경우 근거 보강을 끄거나 글을 2~3개로 나눠 주세요.',
        '연도, 기관명, 정책 판단처럼 원문에 없는 내용이 들어가기 쉬운 문장을 줄여 주세요.'
      ];
    }
    if (set.has('lostFacts') || set.has('evidence_pairing')) {
      return [
        '사실과 수치가 많은 문단은 짧게 나눠 다시 시도해 주세요.',
        '근거 보강을 켠 경우 승인 근거 수를 줄이거나 핵심 근거만 남겨 주세요.',
        '바로 결과가 필요하면 그대로 다듬기를 사용해 주세요.'
      ];
    }
  }
  if (mode === 'blog') {
    return [
      '글을 2~3개로 나눠 짧게 시도해 주세요.',
      '경험 메모를 줄이거나 원문에 없는 사례가 들어가지 않게 해 주세요.',
      '바로 결과가 필요하면 그대로 다듬기를 사용해 주세요.'
    ];
  }
  return [
    '원문을 더 짧게 나눠 다시 시도해 주세요.',
    '사실, 수치, 고유명사가 많은 부분은 원문 표현을 더 유지해 주세요.'
  ];
}

function blockedResponse(job) {
  const actions = blockedNextActions(job.gates || [], job.mode || 'formal');
  return {
    error: `${blockedReason(job.gates || [], job.mode || 'formal')} 크레딧은 차감되지 않았어요. ${actions[0]}`,
    reason: blockedReason(job.gates || [], job.mode || 'formal'),
    nextActions: actions
  };
}

// ── job 영속화(2026-06-12): Firestore transformJobs — 재시작에도 결과·승인대기 생존.
//   90분짜리 job이 도는 서비스에서 영속화 없는 배포 = 누군가의 90분이 증발. 로컬(db 없음)은 무동작.
//   AbortController 등 비직렬화 필드는 제외하고 상태 전이 시점마다 스냅샷 저장(fire-and-forget — 저장 실패가 job을 죽이면 안 됨).
const PERSIST_FIELDS = ['id', 'status', 'stage', 'createdAt', 'uid', 'plan', 'needed', 'devNoAuth', 'deducted',
  'text', 'estSec', 'note', 'gates', 'gateDetail', 'candidates', 'approvedCount', 'result', 'error',
  'mode', 'memo', 'lang'];

function persistJob(job) {
  if (!db) return;
  const doc = {};
  for (const k of PERSIST_FIELDS) if (job[k] !== undefined) doc[k] = job[k];
  db.collection('transformJobs').doc(job.id).set(doc, { merge: true })
    .catch(e => logger.warn('transform.persist_failed', { jobId: job.id, uid: job.uid, status: job.status, err: e }));
}

function deletePersisted(id) {
  if (!db) return;
  db.collection('transformJobs').doc(id).delete()
    .catch(e => logger.warn('transform.persist_delete_failed', { jobId: id, err: e }));
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
    if (kept || expired) {
      logger.info('transform.jobs_restored', { kept, interrupted, expired });
    }
  } catch (e) {
    logger.warn('transform.jobs_restore_failed', { err: e });
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
      logger.warn('transform.evidence_empty', { jobId: job.id, uid: job.uid });
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
    logger.info('transform.awaiting_evidence_approval', {
      jobId: job.id,
      uid: job.uid,
      candidates: job.candidates.length,
      gradeA: job.candidates.filter(c => c.grade === 'A').length,
      gradeB: job.candidates.filter(c => c.grade === 'B').length,
      gradeC: job.candidates.filter(c => c.grade === 'C').length,
      conflicts: job.candidates.filter(c => c.conflict).length
    });
  } catch (e) {
    if (job.ac.signal.aborted) {
      if (job.status !== 'error') { job.status = 'cancelled'; job.stage = '중단됨'; persistJob(job); }
      return;
    }
    logger.error('transform.evidence_search_failed', { jobId: job.id, uid: job.uid, err: e });
    job.note = '근거 검색이 실패해 근거 없이 진행했어요.';
    return runJob(job, text, '');
  }
}

// ── 차단 시 자동 폴백(2026-06-13) ─────────────────────────────────────────────
//   문제: 재생성(genreTransferV2)은 기준금리·정책 같은 구체 사실이 많은 격식체에서 원문에 없는
//   주장을 만들어내 semanticJudge에 막힌다. 같은 글·같은 설정으로 재시도하면 결정론적으로 다시 막혀
//   "그 글은 영원히 변환 불가"인 막다른 길이 된다(차단=결과 0).
//   해결: 차단되면 원문 보존형 경로(runHumanizeChunked·floorV2 — 재생성이 아니라 보존 재작성이라
//   날조가 원천적으로 없어 게이트를 통과)로 재처리해 "약하더라도 실제 결과"를 보장한다.
//   끄려면 env TRANSFORM_BLOCK_FALLBACK=0.
function fallbackEnabled() {
  const v = (process.env.TRANSFORM_BLOCK_FALLBACK || '').toLowerCase();
  return v !== '0' && v !== 'off' && v !== 'false';
}

// 보존형 폴백 단가: 고급(재구성) 정액이 아니라 보존형(다듬기)과 동일한 100자당 1.
//   고급 변환을 못 받았으므로 보존형 결과엔 보존형 가격만 받는다(과금 분쟁 차단).
function preservationFallbackCredit(len) {
  return Math.max(1, Math.ceil(len / 100));
}

// 반환: true = job을 완전히 처리함(호출부는 즉시 return) / false = 폴백 실패(원래대로 blocked 진행)
async function tryPreservationFallback(job, text) {
  try {
    if (job.ac.signal.aborted) {
      if (job.status !== 'error') { job.status = 'cancelled'; job.stage = '중단됨'; persistJob(job); }
      return true;   // 이미 취소됨 — 차단으로 덮지 않음
    }
    job.stage = '원문 보존형으로 재처리 중';
    job.note = (job.note ? job.note + ' ' : '')
      + '고급 변환 결과가 원문 보존 기준을 통과하지 못해, 원문을 최대한 보존하는 방식으로 처리했어요.';
    persistJob(job);

    // 보존형(=polish) 경로 그대로 재사용 — 이미 운영 중인 검증된 경로.
    const out = await analyze.runHumanizeChunked({
      text, mode: 'assignment', lang: job.lang || 'ko', signal: job.ac.signal,
      floorV2: true, optIn: false, judge: true, grounding: true, userNotes: ''
    });
    if ((out.floorReport && out.floorReport.status === 'blocked') || !out.result || !out.result.outputText) {
      logger.warn('transform.fallback_blocked', { jobId: job.id, uid: job.uid, mode: job.mode });
      return false;   // 보존형마저 막힘 → 원래 차단으로
    }

    // 과금: 보존형 단가로. 멱등 키는 동일(job_<id>)이라 중복 차감 불가.
    const fbNeeded = preservationFallbackCredit(text.length);
    if (!job.devNoAuth && job.plan !== 'unlimited') {
      try {
        await analyze.retryAsync(() => analyze.commitCreditDeduct(job.uid, fbNeeded, 'humanize', 'job_' + job.id));
        job.deducted = true;
      } catch (e) {
        logger.error('transform.fallback_credit_deduct_failed_manual_action', {
          jobId: job.id, uid: job.uid, needed: fbNeeded, opType: 'humanize', err: e
        });
      }
    }
    job.needed = fbNeeded;   // 표시·영속화가 실제 차감액과 일치하도록 갱신
    job.status = 'done';
    job.result = {
      outputText: out.result.outputText,
      preservationFallback: true,   // UI가 "보존형으로 처리됨" 배지를 띄울 수 있게
      metrics: {
        novelty: 0, lostFacts: 0, repetition: 0,
        judge: 'pass',
        lengthRatio: out.floorReport?.metrics?.lengthRatio,
        evidenceUsed: 0,
        pairingClean: true,
        preservationFallback: true
      },
      chunkCount: out.chunkCount,
      fallbackCount: out.fallbackCount
    };
    persistJob(job);
    logger.info('transform.fallback_done', {
      jobId: job.id, uid: job.uid, mode: job.mode, needed: fbNeeded, deducted: job.deducted
    });
    return true;
  } catch (e) {
    if (job.ac.signal.aborted) {
      if (job.status !== 'error') { job.status = 'cancelled'; job.stage = '중단됨'; persistJob(job); }
      return true;   // 취소는 처리 완료로 간주(원래 차단으로 덮지 않음)
    }
    logger.error('transform.fallback_failed', { jobId: job.id, uid: job.uid, mode: job.mode, err: e });
    return false;
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
      logger.warn('transform.blocked', {
        jobId: job.id,
        uid: job.uid,
        mode: job.mode,
        gates,
        gateDetail
      });

      // 막다른 길 방지: 차단되면 보존형 경로로 재처리해 결과를 보장한다(formal 한정, env로 off 가능).
      if (job.mode === 'formal' && fallbackEnabled()) {
        const handled = await tryPreservationFallback(job, text);
        if (handled) return;   // 폴백이 done/cancelled로 처리 완료
        // 폴백 실패 시 아래로 떨어져 원래대로 차단
      }

      job.status = 'blocked';
      job.gates = gates;
      job.gateDetail = gateDetail;
      persistJob(job);
      return;
    }
    // ★ 완료 시 차감 — 실패·차단 경로는 여기 도달하지 않으므로 결과 없는 차감이 구조적으로 불가능.
    //   멱등 키로 job.id를 넘겨 재시작·재시도 중복 차감까지 차단(job.deducted 플래그 + 이중 안전).
    if (!job.devNoAuth && job.plan !== 'unlimited') {
      try {
        await analyze.retryAsync(() => analyze.commitCreditDeduct(job.uid, job.needed, 'restructure', 'job_' + job.id));
        job.deducted = true;
      } catch (e) {
        // 차감 실패(그 사이 잔액 소진 등) — 결과는 이미 만들어졌으니 사용자에겐 전달(고객 우선), 수동 보정 로그.
        logger.error('transform.credit_deduct_failed_manual_action', {
          jobId: job.id,
          uid: job.uid,
          needed: job.needed,
          opType: 'restructure',
          err: e
        });
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
    logger.info('transform.done', {
      jobId: job.id,
      uid: job.uid,
      mode: job.mode,
      needed: job.needed,
      deducted: job.deducted,
      skeleton: out.skeleton,
      genreRisk: out.risk?.score
    });
  } catch (e) {
    if (job.ac.signal.aborted) {
      // shutdown이 이미 error(서버 재시작 안내)로 표시한 job을 "사용자 취소"로 덮어쓰면 안 됨 — abort 출처 구분.
      if (job.status !== 'error') { job.status = 'cancelled'; job.stage = '중단됨'; persistJob(job); }
      return;
    }
    logger.error('transform.failed', { jobId: job.id, uid: job.uid, mode: job.mode, err: e });
    job.status = 'error';
    job.error = '재구성 처리 중 오류가 발생했어요. 크레딧은 차감되지 않았어요.';
    persistJob(job);
  }
}

// ── short job 러너(2026-06-13): 직접 fetch였던 블로그 변환·다듬기를 job으로 — 새로고침·창닫기 생존.
//   엔진은 기존 floorV2 청크 경로(analyze.runHumanizeChunked) 그대로(blog→blog, polish→assignment 보존형),
//   차감·게이트 원칙은 formal과 동일.
async function runHumanizeJob(job, text) {
  try {
    job.status = 'running';
    job.stage = '문장 다듬는 중';
    persistJob(job);
    const out = await analyze.runHumanizeChunked({
      text, mode: job.mode === 'polish' ? 'assignment' : 'blog', lang: job.lang || 'ko', signal: job.ac.signal,
      floorV2: true, optIn: false, judge: true, grounding: true, userNotes: job.memo || ''
    });
    // FLOOR 차단 = 날조·소실을 조용히 내보내지 않는다(노출 게이트 원칙) — 차감 없음.
    if (out.floorReport && out.floorReport.status === 'blocked') {
      const gates = (out.floorReport.criticals || []).map(c => c.gate);
      logger.warn('transform.humanize_blocked', {
        jobId: job.id,
        uid: job.uid,
        mode: job.mode,
        gates
      });
      job.status = 'blocked';
      job.gates = gates;
      job.gateDetail = { criticals: (out.floorReport.criticals || []).slice(0, 8) };
      persistJob(job);
      return;
    }
    if (!out.result || !out.result.outputText) throw new Error('humanize_incomplete');
    if (!job.devNoAuth && job.plan !== 'unlimited') {
      try {
        await analyze.retryAsync(() => analyze.commitCreditDeduct(job.uid, job.needed, 'humanize', 'job_' + job.id));
        job.deducted = true;
      } catch (e) {
        logger.error('transform.humanize_credit_deduct_failed_manual_action', {
          jobId: job.id,
          uid: job.uid,
          mode: job.mode,
          needed: job.needed,
          err: e
        });
      }
    }
    job.status = 'done';
    job.result = {
      outputText: out.result.outputText,
      floorReport: {
        status: out.floorReport.status,
        criticals: out.floorReport.criticals,
        warnings: (out.floorReport.warnings || []).map(w => w.gate),
        metrics: out.floorReport.metrics
      },
      metrics: out.floorReport.metrics,   // 배지 렌더 호환(formal과 동일 접근 경로)
      chunkCount: out.chunkCount,
      fallbackCount: out.fallbackCount
    };
    persistJob(job);
    logger.info('transform.humanize_done', {
      jobId: job.id,
      uid: job.uid,
      mode: job.mode,
      needed: job.needed,
      deducted: job.deducted,
      chunkCount: out.chunkCount,
      fallbackCount: out.fallbackCount
    });
  } catch (e) {
    if (job.ac.signal.aborted) {
      if (job.status !== 'error') { job.status = 'cancelled'; job.stage = '중단됨'; persistJob(job); }
      return;
    }
    logger.error('transform.humanize_failed', { jobId: job.id, uid: job.uid, mode: job.mode, err: e });
    job.status = 'error';
    job.error = '처리 중 오류가 발생했어요. 크레딧은 차감되지 않았어요.';
    persistJob(job);
  }
}

router.post('/transform', async (req, res) => {
  const { text, idToken } = req.body || {};
  const mode = ['blog', 'polish'].includes(req.body?.mode) ? req.body.mode : 'formal';   // 화이트리스트 — 그 외 값은 formal
  // 최소 길이: formal은 구조를 다시 짜는 작업이라 200자, short(blog·polish)는 50자(짧은 글 다듬기 허용)
  // 글자수 기준 통일: 표시·과금(needed)과 동일하게 공백 포함 raw length으로 판정.
  const minLen = mode === 'formal' ? 200 : 50;
  if (typeof text !== 'string' || text.length < minLen) {
    return res.status(400).json({ error: `변환하려면 최소 ${minLen}자가 필요해요.` });
  }
  if (text.length > 30000) {
    return res.status(400).json({ error: '텍스트가 너무 깁니다. (최대 30,000자)' });
  }
  if (draining) {
    return res.status(503).json({ error: '서버가 점검을 위해 재시작 중이에요. 1~2분 후 다시 시도해 주세요.' });
  }

  const devNoAuth = !process.env.FIREBASE_SERVICE_ACCOUNT && process.env.DEV_NO_AUTH === '1';
  const wantEvidence = mode === 'formal' && req.body.evidence === true;   // 근거 보강은 formal 전용(UI 잠금과 일치)
  // 과금(기존 /analyze 산식과 동일 — 단가 변화 없음): blog=100자당 2 / polish(다듬기)=100자당 1 / formal=만자 구간 정액
  const needed = mode === 'blog'
    ? Math.max(2, Math.ceil(text.length / 100) * 2)
    : mode === 'polish'
      ? Math.max(1, Math.ceil(text.length / 100))
      : restructureCredit(text.length, wantEvidence);
  let pre;
  try {
    pre = devNoAuth ? { uid: 'dev-local', plan: 'unlimited' } : await analyze.precheckCredits(idToken, needed);
  } catch (e) {
    logger.warn('transform.precheck_failed', { mode, needed, billingMode: 'credit', err: e });
    return res.status(e.status || 500).json({ error: analyze.authErrorMessage(e.message) });
  }
  setLogContext({ uid: pre.uid });
  // 한도는 인증 후(uid 확정) 검사 — 비용 방어의 본체. 시작 성공 시에만 일일 카운트(formal만).
  const limited = checkLimits(pre.uid, mode);
  if (limited) return res.status(limited.status).json({ error: limited.error });
  if (mode === 'formal') recordStart(pre.uid);

  const id = crypto.randomBytes(8).toString('hex');
  const bare = text.replace(/\s+/g, '').length;
  const isShort = mode !== 'formal';
  // 예상 시간: formal=슬롯 순차라 길이 선형(상한 90분). short(blog·polish)=청크 병렬이라 짧음(프론트 ticker 공식과 동일).
  const estSec = isShort
    ? Math.max(90, Math.min(1200, Math.round(bare / 12)))
    : Math.max(240, Math.min(5400, Math.round(bare / 4) + (wantEvidence ? 480 : 0)));
  const job = {
    id, mode, status: 'running', stage: isShort ? '문장 다듬는 중' : (wantEvidence ? '근거 검색' : '구조 계획'), createdAt: Date.now(),
    uid: pre.uid, plan: pre.plan, needed, devNoAuth, deducted: false,
    text,   // 승인 후 재개용(v1 메모리 보관 — TTL로 정리)
    memo: mode === 'blog' && typeof req.body.memo === 'string' ? req.body.memo.slice(0, 2000) : '',
    lang: req.body.lang === 'en' ? 'en' : 'ko',
    estSec,
    ac: new AbortController()   // 명시적 취소용(/cancel)
  };
  jobs.set(id, job);
  persistJob(job);
  if (isShort) runHumanizeJob(job, text);            // await 없음 — 백그라운드 진행(새로고침 생존)
  else if (wantEvidence) runSearchPhase(job, text);
  else runJob(job, text, '');
  logger.info('transform.started', {
    jobId: id,
    uid: pre.uid,
    mode,
    textLength: text.length,
    bareLength: bare,
    evidence: wantEvidence,
    needed,
    plan: pre.plan,
    estSec
  });
  res.json({ ok: true, jobId: id, estSec, mode });
});

// ── 명시적 취소: 진행 중 LLM 호출을 abort — 차감은 완료 시에만 일어나므로 취소=항상 무과금.
router.post('/transform/:id/cancel', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없어요.' });
  if (!(await requireJobOwner(req, res, job))) return;
  if (job.status === 'done' || job.status === 'blocked' || job.status === 'error') {
    return res.status(409).json({ error: '이미 끝난 작업이에요.' });
  }
  job.ac.abort();
  job.status = 'cancelled';
  job.stage = '중단됨';
  persistJob(job);
  logger.info('transform.cancelled_by_user', { jobId: job.id, uid: job.uid, mode: job.mode });
  res.json({ ok: true });
});

// ── P4: 근거 승인 — 승인된 후보만 evidence로 재구성 재개. "미승인은 엔진이 차단"의 구현부:
//   엔진에 전달되는 허용 세계 자체가 승인 목록뿐이므로 미승인 사실은 novelty 게이트가 자동 차단.
router.post('/transform/:id/approve', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없어요. (만료되었거나 서버가 재시작됨)' });
  if (!(await requireJobOwner(req, res, job))) return;
  if (job.status !== 'awaiting_approval') return res.status(409).json({ error: '지금은 승인 단계가 아니에요.' });
  if (draining) return res.status(503).json({ error: '서버가 점검을 위해 재시작 중이에요. 1~2분 후 다시 승인해 주세요. (작업은 사라지지 않아요)' });
  // 승인 = LLM 재구성 시작이므로 전역 동시 한도를 여기서도 검사 — 승인 화면에 머물던 job들이 한꺼번에 풀리는 경로.
  if (countActive('', 'formal').running >= MAX_ACTIVE_GLOBAL) {
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
    logger.warn('transform.evidence_approval_capped', {
      jobId: job.id,
      uid: job.uid,
      requested: ids.length,
      cap
    });
  }
  const lines = approved.map(c => `${c.fact} (출처: ${c.sourceTitle || c.host})`);
  job.approvedCount = approved.length;
  logger.info('transform.evidence_approved', {
    jobId: job.id,
    uid: job.uid,
    approved: approved.length,
    candidates: (job.candidates || []).length
  });
  runJob(job, job.text, lines.join('\n'));   // await 없음
  res.json({ ok: true, approved: approved.length });
});

router.get('/transform/:id', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없어요. (만료되었거나 서버가 재시작됨)' });
  if (!(await requireJobOwner(req, res, job))) return;
  const base = { ok: true, status: job.status, stage: job.stage, mode: job.mode || 'formal', elapsedSec: Math.round((Date.now() - job.createdAt) / 1000), estSec: job.estSec, ...(job.note ? { note: job.note } : {}) };
  if (job.status === 'done') return res.json({ ...base, result: job.result });
  if (job.status === 'awaiting_approval') return res.json({ ...base, candidates: job.candidates });
  if (job.status === 'cancelled') return res.json(base);
  if (job.status === 'blocked') return res.json({ ...base, gates: job.gates, gateDetail: job.gateDetail, ...blockedResponse(job) });
  if (job.status === 'error') return res.json({ ...base, error: job.error });
  res.json(base);
});

module.exports = router;
