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
stub(path.join(base, 'engine', 'evidence.js'), { suggestEvidence: async () => ({ candidates: [] }) });
stub(path.join(base, 'engine', 'evidencereview.js'), { reviewCandidates: c => c, hostOf: () => '' });
// 스텁 인증·과금: idToken을 그대로 uid로 — 멀티 유저 시뮬레이션
stub(path.join(base, 'routes', 'analyze.js'), {
  precheckCredits: async (idToken) => { if (!idToken) throw Object.assign(new Error('AUTH_REQUIRED'), { status: 401 }); return { uid: idToken, plan: 'free' }; },
  commitCreditDeduct: async () => {},
  retryAsync: async (fn) => fn(),
  authErrorMessage: (m) => String(m)
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
  const get = (p) => fetch(url + p).then(async r => ({ status: r.status, body: await r.json() }));

  try {
    // 1) 사용자당 동시 1개
    const a1 = await post('/transform', { text: TEXT, idToken: 'u1' });
    check('u1 첫 시작 200', a1.status === 200 && a1.body.jobId, a1);
    const a2 = await post('/transform', { text: TEXT, idToken: 'u1' });
    check('u1 중복 시작 409(동시 1개)', a2.status === 409, a2);

    // 2) 취소하면 슬롯 해제 + 일일 카운트는 누적 → 3회 소진 후 429
    await post(`/transform/${a1.body.jobId}/cancel`);
    const a3 = await post('/transform', { text: TEXT, idToken: 'u1' });
    check('u1 취소 후 재시작 200(슬롯 해제)', a3.status === 200, a3);
    await post(`/transform/${a3.body.jobId}/cancel`);
    const a4 = await post('/transform', { text: TEXT, idToken: 'u1' });
    check('u1 3번째 시작 200', a4.status === 200, a4);
    await post(`/transform/${a4.body.jobId}/cancel`);
    const a5 = await post('/transform', { text: TEXT, idToken: 'u1' });
    check('u1 4번째 시작 429(일일 한도 3)', a5.status === 429, a5);

    // 3) 전역 동시 한도 2
    const b1 = await post('/transform', { text: TEXT, idToken: 'u2' });
    const b2 = await post('/transform', { text: TEXT, idToken: 'u3' });
    check('u2·u3 시작 200(전역 2 자리)', b1.status === 200 && b2.status === 200, { b1, b2 });
    const b3 = await post('/transform', { text: TEXT, idToken: 'u4' });
    check('u4 시작 503(전역 동시 한도)', b3.status === 503, b3);

    // 4) 완료 폴링 — 스텁 2.5초 후 done + 결과
    await sleep(3200);
    const d1 = await get(`/transform/${b1.body.jobId}`);
    check('u2 job done + 결과 수신', d1.body.status === 'done' && d1.body.result && d1.body.result.outputText === '재구성 결과', d1.body);

    // 5) 슬롯이 비면 다시 수용
    const c1 = await post('/transform', { text: TEXT, idToken: 'u4' });
    check('완료 후 u4 시작 200(슬롯 회수)', c1.status === 200, c1);

    // 6) shutdown: running job 중단 정정 + 신규 거부(드레인)
    await transform.shutdown();
    const s1 = await get(`/transform/${c1.body.jobId}`);
    check('shutdown 후 running job → error(중단 안내)', s1.body.status === 'error' && /재시작/.test(s1.body.error || ''), s1.body);
    const s2 = await post('/transform', { text: TEXT, idToken: 'u5' });
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
