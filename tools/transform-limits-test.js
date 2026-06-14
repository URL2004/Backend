// [tools/transform-limits-test.js] /transform 비용 방어·드레인 검증
// 엔진·analyze를 require.cache로 스텁해 LLM 호출 없이(비용 0) 라우트 로직만 검사한다.
// 실행: node tools/transform-limits-test.js  (서버 구동 불필요 — 자체 포트에 라우터만 마운트)
process.env.RESTRUCTURE_MAX_ACTIVE = '2';
process.env.RESTRUCTURE_DAILY_CAP = '3';
delete process.env.DEV_NO_AUTH;
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const path = require('path');
const base = path.join(__dirname, '..');

function stub(p, exports) {
  const full = require.resolve(p);
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
}

// 스텁 엔진: 2.5초 뒤 게이트 전부 통과로 완료. abort 시 즉시 reject(취소·shutdown 경로 검증용).
stub(path.join(base, 'engine', 'genretransfer.js'), {
  genreTransferV2: (text, opts) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve({
      text: '재구성 결과', novelty: { count: 0 }, lostFacts: { count: 0 },
      pairing: [], judge: { pass: true }, lenRatio: 1, risk: { score: 1 }, skeleton: ''
    }), 2500);
    if (opts && opts.signal) opts.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
  })
});
stub(path.join(base, 'engine', 'evidence.js'), {
  suggestEvidence: async (text) => text.includes('근거테스트')
    ? { candidates: [{ fact: '검증된 사실', sourceTitle: '공식 자료', sourceUrl: 'https://example.com/source', grade: 'A' }] }
    : { candidates: [] }
});
stub(path.join(base, 'engine', 'evidencereview.js'), { reviewCandidates: c => c, hostOf: () => '' });
// 소유자 검증(requireJobOwner)용 config 스텁: 토큰 문자열 = uid (멀티 유저 시뮬과 일관)
stub(path.join(base, 'config.js'), { admin: null, db: null, verifyToken: async (t) => t || null });
// 스텁 인증·과금: idToken을 그대로 uid로 — 멀티 유저 시뮬레이션
stub(path.join(base, 'routes', 'analyze.js'), {
  precheckCredits: async (idToken) => { if (!idToken) throw Object.assign(new Error('AUTH_REQUIRED'), { status: 401 }); return { uid: idToken, plan: 'free' }; },
  commitCreditDeduct: async () => {},
  retryAsync: async (fn) => fn(),
  authErrorMessage: (m) => String(m),
  // blog job 러너용 스텁 엔진: 1.2초 뒤 클린 통과
  runHumanizeChunked: ({ signal }) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve({
      result: { outputText: '블로그 결과' },
      floorReport: { status: 'clean', criticals: [], warnings: [], metrics: { novelty: 0, judge: 'pass' } },
      chunkCount: 1, fallbackCount: 0
    }), 1200);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
  })
});

const express = require('express');
const transform = require(path.join(base, 'routes', 'transform.js'));
const app = express();
app.use(express.json());
app.use('/', transform);

const TEXT = '가'.repeat(300);
let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ' — ' + JSON.stringify(extra) : ''}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const srv = app.listen(0, async () => {
  const url = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, body) => fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then(async r => ({ status: r.status, body: await r.json() }));
  // 소유자 검증(requireJobOwner) 때문에 GET·cancel에도 토큰(=uid) 전달
  const get = (p, uid) => fetch(url + p + (p.indexOf('?') < 0 ? '?' : '&') + 'idToken=' + (uid || ''), {}).then(async r => ({ status: r.status, body: await r.json() }));

  try {
    // 1) 사용자당 동시 1개
    const a1 = await post('/transform', { text: TEXT, idToken: 'u1' });
    check('u1 첫 시작 200', a1.status === 200 && a1.body.jobId, a1);
    const a2 = await post('/transform', { text: TEXT, idToken: 'u1' });
    check('u1 중복 시작 409(동시 1개)', a2.status === 409, a2);

    // 2) 취소하면 슬롯 해제 + 일일 카운트는 누적 → 3회 소진 후 429
    await post(`/transform/${a1.body.jobId}/cancel`, { idToken: 'u1' });
    const a3 = await post('/transform', { text: TEXT, idToken: 'u1' });
    check('u1 취소 후 재시작 200(슬롯 해제)', a3.status === 200, a3);
    await post(`/transform/${a3.body.jobId}/cancel`, { idToken: 'u1' });
    const a4 = await post('/transform', { text: TEXT, idToken: 'u1' });
    check('u1 3번째 시작 200', a4.status === 200, a4);
    await post(`/transform/${a4.body.jobId}/cancel`, { idToken: 'u1' });
    const a5 = await post('/transform', { text: TEXT, idToken: 'u1' });
    check('u1 4번째 시작 429(일일 한도 3)', a5.status === 429, a5);

    // 3) 전역 동시 한도 2 — 초과분은 503 거절이 아니라 queued 접수
    const b1 = await post('/transform', { text: TEXT, idToken: 'u2' });
    const b2 = await post('/transform', { text: TEXT, idToken: 'u3' });
    check('u2·u3 시작 200(전역 2 자리)', b1.status === 200 && b2.status === 200, { b1, b2 });
    const b3 = await post('/transform', { text: TEXT, idToken: 'u4' });
    check('u4 시작 200 + queued(전역 동시 한도 초과)', b3.status === 200 && b3.body.queued === true && b3.body.job.status === 'queued', b3);

    // 4) 완료 폴링 — 앞 슬롯이 끝나면 queued 작업이 자동 running→done
    await sleep(3200);
    const d1 = await get(`/transform/${b1.body.jobId}`, 'u2');
    check('u2 job done + 결과 수신', d1.body.status === 'done' && d1.body.result && d1.body.result.outputText === '재구성 결과', d1.body);
    const q1 = await get(`/transform/${b3.body.jobId}`, 'u4');
    check('u4 queued job 자동 시작', q1.body.status === 'running' || q1.body.status === 'done', q1.body);
    await sleep(2600);
    const q2 = await get(`/transform/${b3.body.jobId}`, 'u4');
    check('u4 queued job done + 결과 수신', q2.body.status === 'done' && q2.body.result && q2.body.result.outputText === '재구성 결과', q2.body);

    // 4.5) blog job(기본 피하기): 새로고침 생존용 job 전환 — formal 일일 한도 미적용·별도 동시 풀·결과 형태
    const b4 = await post('/transform', { text: TEXT, idToken: 'u1', mode: 'blog' });
    check('u1 blog 시작 200(formal 일일 한도 미적용)', b4.status === 200 && b4.body.mode === 'blog', b4);
    const b5 = await post('/transform', { text: TEXT, idToken: 'u1', mode: 'blog' });
    check('u1 blog 중복 409(사용자당 1개 — 모드 무관)', b5.status === 409, b5);
    const g1 = await get(`/transform/${b4.body.jobId}`, 'u1');
    check('blog GET: running + mode=blog', g1.body.status === 'running' && g1.body.mode === 'blog', g1.body);
    await sleep(1800);
    const g2 = await get(`/transform/${b4.body.jobId}`, 'u1');
    check('blog done + 결과·floorReport 수신', g2.body.status === 'done' && g2.body.mode === 'blog' && g2.body.result.outputText === '블로그 결과' && g2.body.result.floorReport.status === 'clean', g2.body);

    // 4.6) polish job(그대로 다듬기): 같은 short 풀 — 50자부터 허용·일일 한도 미적용
    const p1 = await post('/transform', { text: '가'.repeat(80), idToken: 'u2', mode: 'polish' });
    check('u2 polish 시작 200(80자 — short 모드 50자 허용)', p1.status === 200 && p1.body.mode === 'polish', p1);
    await sleep(1800);
    const p2 = await get(`/transform/${p1.body.jobId}`, 'u2');
    check('polish done + 결과 수신', p2.body.status === 'done' && p2.body.mode === 'polish' && p2.body.result.outputText === '블로그 결과', p2.body);

    // 5) evidence 승인 후 재구성도 슬롯이 꽉 차면 queued → 자동 재개
    const evText = '근거테스트' + '가'.repeat(300);
    const ev1 = await post('/transform', { text: evText, idToken: 'u7', evidence: true });
    check('evidence job 시작 200', ev1.status === 200, ev1);
    await sleep(100);
    const evWait = await get(`/transform/${ev1.body.jobId}`, 'u7');
    check('evidence job 승인 대기', evWait.body.status === 'awaiting_approval' && evWait.body.candidates.length === 1, evWait.body);
    const f1 = await post('/transform', { text: TEXT, idToken: 'u8' });
    const f2 = await post('/transform', { text: TEXT, idToken: 'u9' });
    check('승인 전 formal 슬롯 2개 점유', f1.status === 200 && f2.status === 200, { f1, f2 });
    const evApprove = await post(`/transform/${ev1.body.jobId}/approve`, { idToken: 'u7', approved: [0] });
    check('승인 후 슬롯 만석이면 queued', evApprove.status === 200 && evApprove.body.job.status === 'queued', evApprove);
    await sleep(3200);
    const evRun = await get(`/transform/${ev1.body.jobId}`, 'u7');
    check('승인 queued job 자동 재개', evRun.body.status === 'running' || evRun.body.status === 'done', evRun.body);
    await sleep(2600);
    const evDone = await get(`/transform/${ev1.body.jobId}`, 'u7');
    check('승인 queued job done', evDone.body.status === 'done' && evDone.body.result.outputText === '재구성 결과', evDone.body);

    // 6) 슬롯이 비면 새 작업은 즉시 running으로 수용
    const c1 = await post('/transform', { text: TEXT, idToken: 'u5' });
    check('완료 후 u5 시작 200(슬롯 회수)', c1.status === 200, c1);

    // 7) shutdown: running job 중단 정정 + 신규 거부(드레인)
    await transform.shutdown();
    const s1 = await get(`/transform/${c1.body.jobId}`, 'u5');
    check('shutdown 후 running job → error(중단 안내)', s1.body.status === 'error' && /재시작/.test(s1.body.error || ''), s1.body);
    const s2 = await post('/transform', { text: TEXT, idToken: 'u6' });
    check('드레인 중 신규 시작 503', s2.status === 503, s2);
    check('stats: draining=true·activeJobs=0', transform.stats().draining === true && transform.stats().activeJobs === 0, transform.stats());
  } catch (e) {
    failed++;
    console.error('  ✗ 테스트 실행 오류:', e);
  }
  console.log(`\n결과: ${passed}통과 / ${failed}실패`);
  srv.close();
  process.exit(failed ? 1 : 0);
});
