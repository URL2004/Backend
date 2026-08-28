// [tools/transform-refine-test.js] 사후 문단 보강(refine-paragraph) 상태기계 검증
// GPT 호환 엔진·과금을 require.cache로 스텁해 비용 없이 라우트 로직만 검사한다(transform-limits-test.js 패턴).
// 실행: node tools/transform-refine-test.js  (서버 구동 불필요 — 자체 포트에 라우터만 마운트)
process.env.PARAGRAPH_REFINE = '1';
process.env.REFINE_FREE_COUNT = '1';   // 2회차부터 유료 경로가 바로 검증되게 축소
process.env.TRANSFORM_SAFE_ACTIVE_CAP = '2';
delete process.env.DEV_NO_AUTH;
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const path = require('path');
const base = path.join(__dirname, '..');

function stub(p, exports) {
  const full = require.resolve(p);
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
}

// ── 픽스처(실물 surfaceguard로 사전 검증된 분류) ──
//   P0·C = concrete, P1(원본 추상)·B(보강했지만 여전히 추상) = abstract_risk
const P0 = '2026년 3월 서울의 한 대학교 도서관에서 학생 20명을 인터뷰했다. 평균 학습 시간은 하루 2.5시간이었고, 35%는 주 3회 이상 도서관을 찾았다.';
const P1 = '성실함은 인생에서 가장 중요한 가치라고 할 수 있다. 사람들은 꾸준히 노력해야 비로소 성장할 수 있다. 이러한 태도는 우리 사회 전반에 긍정적인 영향을 준다. 결국 중요한 것은 꾸준함이라고 볼 수 있다.';
const P2 = '인터뷰 후 연구팀은 설문 문항 12개를 추가로 분석했고, 4월 10일 보고서 초안을 공유했다.';
const ABSTRACT_B = '노력은 언제나 배신하지 않는다고 할 수 있다. 사람들은 성실한 자세를 통해 더 나은 결과를 얻게 된다. 이러한 관점은 어느 분야에서나 통용되는 보편적인 원리라고 볼 수 있다. 결국 태도가 모든 것을 결정한다.';
// 위빙 성공 픽스처: 사실(30분·막차·편의점)이 전부 메모에 근거 → measureNovelty(allowedExtra=memo) 통과
const MEMO_OK = '작년 겨울 편의점 야간 알바에서 정산이 30분 늦어 막차를 놓친 적이 있다';
const WOVEN_C = '성실함이 중요하다는 말은 흔하지만, 나는 그것을 몸으로 배웠다. 작년 겨울 편의점 야간 알바에서 정산이 30분 늦어 막차를 놓친 날에도 그만두는 대신 순서를 바꿔 봤다. 그 뒤로 꾸준함이 결과를 만든다는 사실을 의심하지 않는다.';
// 날조 픽스처: 문단·메모 어디에도 없는 수치(2019·87) → 게이트가 차단해야 한다
const FABRICATED = '2019년 하버드 대학교 연구에 따르면 사람들의 87%는 성실함을 최고의 덕목으로 꼽았다. 성실한 태도는 조직과 사회 전반에 긍정적인 영향을 준다. 결국 태도가 모든 것을 결정한다.';
const FIXTURE_OUT = P0 + '\n\n' + P1 + '\n\n' + P2;

stub(path.join(base, 'engine', 'evidencereview.js'), { reviewCandidates: c => c, hostOf: () => '' });
stub(path.join(base, 'config.js'), { admin: null, db: null, ADMIN_UIDS: [], verifyToken: async (t) => t || null });

// 과금 스파이: 호출 기록으로 "무료=무호출·유료=refine 전용 멱등키" 계약을 검증
const billing = { prechecks: [], commits: [] };
stub(path.join(base, 'lib', 'usageBilling.js'), {
  authenticate: async (idToken) => {
    if (!idToken) throw Object.assign(new Error('AUTH_REQUIRED'), { status: 401 });
    return { uid: idToken };
  },
  precheckCredits: async (idToken, amount) => {
    if (!idToken) throw Object.assign(new Error('AUTH_REQUIRED'), { status: 401 });
    billing.prechecks.push({ idToken, amount });
    return { uid: idToken, plan: 'free' };
  },
  precheckCoupon: async (idToken) => ({ uid: idToken, plan: 'free', tier: 'test' }),
  commitCreditDeduct: async (uid, amount, opType, requestId, meta) => { billing.commits.push({ uid, amount, opType, requestId, meta }); },
  commitCouponUsage: async () => {},
  retryAsync: async (fn) => fn(),
  authErrorMessage: (m) => String(m)
});

// 엔진 스텁: 초기 변환 = runHumanizeChunked → 3문단 픽스처. refine = callGpt(전용 프롬프트) → 메모 마커로 분기.
stub(path.join(base, 'routes', 'analyze-gpt.js'), {
  suggestEvidence: async () => ({ candidates: [] }),
  runHumanizeChunked: ({ signal }) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve({
      result: { outputText: FIXTURE_OUT },
      floorReport: { status: 'clean', criticals: [], warnings: [], metrics: {} },
      engineMeta: { schemaVersion: 3 },
      chunkCount: 3, fallbackCount: 0
    }), 250);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
  }),
  callGpt: ({ userText, signal }) => new Promise((resolve, reject) => {
    const para = (String(userText || '').split(/\[문단\]\n/)[1] || '').split(/\n\n\[저자의 실제 경험 메모\]/)[0];
    const memo = String(userText || '').split(/\[저자의 실제 경험 메모\]\n/)[1] || '';
    const delay = memo.includes('슬로우') ? 800 : 120;
    const outputText = memo.includes('NOOP') ? para        // 무변화(모델이 원문 유지)
      : memo.includes('날조') ? FABRICATED                  // 새 수치 날조 → 게이트가 차단해야 함
      : memo.includes('추상유지') ? ABSTRACT_B               // 바뀌었지만 여전히 추상 → 타겟 잔존
      : WOVEN_C;                                            // 메모 근거 위빙 성공 → 타겟 이탈
    const t = setTimeout(() => resolve({
      content: [{ type: 'structured_result', name: 'return_refined_paragraph', input: { outputText } }]
    }), delay);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
  }),
  extractGptResult: (data, toolName) => {
    const block = (data && data.content || []).find(b => b && b.type === 'structured_result' && (!toolName || b.name === toolName));
    return block ? block.input : {};
  }
});

const sg = require(path.join(base, 'engine', 'surfaceguard.js'));
const { shortHumanizeCredit } = require(path.join(base, 'lib', 'humanizePricing.js'));
const express = require('express');
const transform = require(path.join(base, 'routes', 'transform.js'));
const app = express();
app.use(express.json());
app.use('/', transform);

const TEXT = '2026년 한국대학교 연구팀은 서울 지역 학생 20명을 대상으로 학습 환경을 조사했다. 참여자 35%는 주 3회 이상 도서관을 이용했고, 평균 학습 시간은 하루 2.5시간이었다. 성실함의 가치에 대해서도 함께 물었다.';
let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const srv = app.listen(0, async () => {
  const url = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, body) => fetch(url + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...(p === '/transform' ? { effectNoticeAccepted: true } : {}), ...(body || {}) })
  }).then(async r => ({ status: r.status, body: await r.json() }));
  const get = (p, uid) => fetch(url + p, { headers: uid ? { authorization: 'Bearer ' + uid } : {} }).then(async r => ({ status: r.status, body: await r.json() }));
  const waitRefine = async (jobId, uid) => {
    for (let i = 0; i < 40; i++) {
      const r = await get(`/transform/${jobId}`, uid);
      if (r.body.refine && r.body.refine.status !== 'running') return r.body;
      await sleep(100);
    }
    return null;
  };

  try {
    // 0) 픽스처 자가검증 — 실물 surfaceguard·floor가 의도대로 판정하는지 (게이트·분류기 변경 시 여기서 먼저 깨진다)
    const floorGuard = require(path.join(base, 'engine', 'floor.js'));
    check('픽스처: P1·B=abstract_risk, P0·WOVEN_C=concrete',
      sg.classifyParagraphKind(P1) === 'abstract_risk' && sg.classifyParagraphKind(ABSTRACT_B) === 'abstract_risk'
      && sg.classifyParagraphKind(P0) === 'concrete' && sg.classifyParagraphKind(WOVEN_C) === 'concrete');
    check('픽스처: WOVEN_C는 메모 허용세계 통과·FABRICATED는 novelty 검출',
      floorGuard.measureNovelty(ABSTRACT_B, WOVEN_C, MEMO_OK).count === 0
      && floorGuard.measureNovelty(ABSTRACT_B, FABRICATED, '날조검사 유발 메모다').count > 0,
      { woven: floorGuard.measureNovelty(ABSTRACT_B, WOVEN_C, MEMO_OK), fab: floorGuard.measureNovelty(ABSTRACT_B, FABRICATED, '날조검사 유발 메모다') });

    // 1) blog 완료 → refineTargets 부착
    const a1 = await post('/transform', { text: TEXT, idToken: 'u1', mode: 'blog' });
    check('u1 blog 시작 200', a1.status === 200 && a1.body.jobId, a1);
    const jobA = a1.body.jobId;
    await sleep(600);
    const d1 = await get(`/transform/${jobA}`, 'u1');
    const t1 = d1.body.result && d1.body.result.refineTargets;
    check('done + refineTargets=[P1] (index 1·credit·snippet)',
      d1.body.status === 'done' && Array.isArray(t1) && t1.length === 1 && t1[0].index === 1
      && t1[0].credit === shortHumanizeCredit(P1.length) && P1.startsWith(t1[0].snippet.slice(0, 20)), t1);
    check('refine 메타: freeLeft=1/freeTotal=1', d1.body.result.refine && d1.body.result.refine.freeLeft === 1 && d1.body.result.refine.freeTotal === 1, d1.body.result.refine);
    // 원 작업 자체의 정상 과금(시작 precheck + 완료 커밋)은 기준선으로 제외하고 refine 델타만 잰다.
    const basePre = billing.prechecks.length, baseCommit = billing.commits.length;

    // 2) 플래그 OFF → 404 (env를 요청마다 읽는 계약)
    process.env.PARAGRAPH_REFINE = '0';
    const off = await post(`/transform/${jobA}/refine-paragraph`, { idToken: 'u1', paragraphIndex: 1, memo: '실제 겪은 일 다섯 자 이상' });
    check('플래그 OFF → 404', off.status === 404, off);
    process.env.PARAGRAPH_REFINE = '1';

    // 3) 검증 실패 케이스
    const badMemo = await post(`/transform/${jobA}/refine-paragraph`, { idToken: 'u1', paragraphIndex: 1, memo: '짧다' });
    check('memo 5자 미만 → 400', badMemo.status === 400, badMemo);
    const badIdx = await post(`/transform/${jobA}/refine-paragraph`, { idToken: 'u1', paragraphIndex: 0, memo: '구체 문단은 대상이 아니다' });
    check('타겟이 아닌 문단 → 400', badIdx.status === 400, badIdx);
    const wrongOwner = await post(`/transform/${jobA}/refine-paragraph`, { idToken: 'u9', paragraphIndex: 1, memo: '남의 작업 보강 시도' });
    check('타인 작업 → 403', wrongOwner.status === 403, wrongOwner);

    // 4) 무료 1회차: 변경 성공(여전히 추상 → 타겟 잔존), 과금 무호출
    const r1 = await post(`/transform/${jobA}/refine-paragraph`, { idToken: 'u1', paragraphIndex: 1, memo: '작년 겨울 편의점 야간 알바 추상유지' });
    check('무료 refine 시작 200 + needed 0', r1.status === 200 && r1.body.refine.status === 'running' && r1.body.refine.needed === 0, r1);
    const f1 = await waitRefine(jobA, 'u1');
    check('무료 refine done + changed', f1 && f1.refine.status === 'done' && f1.refine.changed === true, f1 && f1.refine);
    const splice1 = P0 + '\n\n' + ABSTRACT_B + '\n\n' + P2;
    check('P1만 교체·나머지 문단/구분자 보존', f1.result.outputText === splice1, f1 && f1.result.outputText);
    check('보강한 문단은 재영업 제외(여전히 추상이어도 타겟에서 빠짐) + freeLeft 0', f1.result.refineTargets.length === 0 && f1.result.refine.freeLeft === 0, f1.result.refineTargets);
    check('무료 회차 과금 무호출(기준선 대비 델타 0)', billing.prechecks.length === basePre && billing.commits.length === baseCommit, billing);

    // 5) 유료 2회차(재시도 — 타겟에선 빠졌지만 refineHistory로 허용): precheck + refine 전용 멱등키 커밋
    const paidCredit = shortHumanizeCredit(ABSTRACT_B.length);
    const r2 = await post(`/transform/${jobA}/refine-paragraph`, { idToken: 'u1', paragraphIndex: 1, memo: MEMO_OK });
    check('보강 이력 문단 재시도 허용 + 유료 needed=' + paidCredit, r2.status === 200 && r2.body.refine.needed === paidCredit, r2);
    const f2 = await waitRefine(jobA, 'u1');
    check('유료 refine done + deducted', f2 && f2.refine.status === 'done' && f2.refine.changed === true && f2.refine.deducted === true, f2 && f2.refine);
    const refineCommits = billing.commits.filter(c => c.opType === 'humanize_refine');
    check('precheck +1회 + 커밋 키 job_<id>_refine2', billing.prechecks.length === basePre + 1 && refineCommits.length === 1
      && refineCommits[0].requestId === 'job_' + jobA + '_refine2' && refineCommits[0].amount === paidCredit, billing);
    check('구체화 성공 → 타겟 비움(긍정 신호)', Array.isArray(f2.result.refineTargets) && f2.result.refineTargets.length === 0, f2.result.refineTargets);
    check('최종 본문 = P0+WOVEN_C+P2', f2.result.outputText === P0 + '\n\n' + WOVEN_C + '\n\n' + P2);

    // 6) 타겟도 이력도 아닌 문단은 400
    const r3 = await post(`/transform/${jobA}/refine-paragraph`, { idToken: 'u1', paragraphIndex: 2, memo: '대상이 아닌 문단에 시도한다' });
    check('타겟·이력 밖 문단 → 400', r3.status === 400, r3);

    // 7) 동시 보강 409 + noop(무변화)은 과금·무료횟수 미소진
    const b1 = await post('/transform', { text: TEXT, idToken: 'u2', mode: 'blog' });
    const jobB = b1.body.jobId;
    await sleep(600);
    const slow = await post(`/transform/${jobB}/refine-paragraph`, { idToken: 'u2', paragraphIndex: 1, memo: '슬로우 추상유지 실제 경험' });
    check('u2 슬로우 refine 시작 200', slow.status === 200, slow);
    const dup = await post(`/transform/${jobB}/refine-paragraph`, { idToken: 'u2', paragraphIndex: 1, memo: '동시에 또 보강 시도한다' });
    check('진행 중 중복 refine → 409', dup.status === 409, dup);
    const fb1 = await waitRefine(jobB, 'u2');
    check('u2 슬로우 refine done(무료 소진)', fb1 && fb1.refine.changed === true && fb1.result.refine.freeLeft === 0, fb1 && fb1.result.refine);
    const commitsBefore = billing.commits.length;
    const noop = await post(`/transform/${jobB}/refine-paragraph`, { idToken: 'u2', paragraphIndex: 1, memo: 'NOOP 반영해도 그대로다' });
    check('noop refine 시작 200(유료 회차)', noop.status === 200 && noop.body.refine.needed > 0, noop);
    const fb2 = await waitRefine(jobB, 'u2');
    check('noop → changed:false + note', fb2 && fb2.refine.status === 'done' && fb2.refine.changed === false && /무료 횟수/.test(fb2.refine.note || ''), fb2 && fb2.refine);
    check('noop은 커밋 없음 + 본문 불변', billing.commits.length === commitsBefore && fb2.result.outputText === P0 + '\n\n' + ABSTRACT_B + '\n\n' + P2, billing.commits.length);
    // noop 이후 재시도 + 날조 게이트: 새 수치를 지어낸 결과는 차단(무과금·본문 불변)
    const retryAfterNoop = await post(`/transform/${jobB}/refine-paragraph`, { idToken: 'u2', paragraphIndex: 1, memo: '날조검사 유발 메모다' });
    check('noop 이후 재시도 허용(멱등키 refine2 유지)', retryAfterNoop.status === 200 && retryAfterNoop.body.refine.n === 2, retryAfterNoop);
    const fb3 = await waitRefine(jobB, 'u2');
    check('날조 결과 → 게이트 차단(changed:false + 안전 검증 note)', fb3 && fb3.refine.changed === false && /안전 검증/.test(fb3.refine.note || ''), fb3 && fb3.refine);
    check('날조 차단은 무과금·본문 불변', billing.commits.filter(c => c.opType === 'humanize_refine').length === 1
      && fb3.result.outputText === P0 + '\n\n' + ABSTRACT_B + '\n\n' + P2, billing.commits);

    // 8) formal은 이번 단계 제외 — 타겟 미부착 + 409
    const c1 = await post('/transform', { text: TEXT.repeat(2), idToken: 'u3', mode: 'formal' });
    check('u3 formal 시작 200', c1.status === 200, c1);
    await sleep(700);
    const dc = await get(`/transform/${c1.body.jobId}`, 'u3');
    check('formal done + refineTargets 미부착', dc.body.status === 'done' && dc.body.result.refineTargets === undefined, dc.body.result && Object.keys(dc.body.result));
    const rc = await post(`/transform/${c1.body.jobId}/refine-paragraph`, { idToken: 'u3', paragraphIndex: 0, memo: '고급 결과에 보강 시도한다' });
    check('formal refine → 409(모드 가드)', rc.status === 409, rc);
  } catch (e) {
    failed++;
    console.error('  ✗ 테스트 실행 오류:', e);
  }
  console.log(`\n결과: ${passed}통과 / ${failed}실패`);
  srv.close();
  process.exit(failed ? 1 : 0);
});
