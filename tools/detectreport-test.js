// [tools/detectreport-test.js] /detect-report 검증 — LLM·인증 스텁(비용 0)으로 보고서 형태·일일 한도 검사.
// 실행: node tools/detectreport-test.js
process.env.DETECT_DAILY_CAP = '2';
delete process.env.DEV_NO_AUTH;
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const path = require('path');
const base = path.join(__dirname, '..');
function stub(p, exports) {
  const full = require.resolve(p);
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
}

// LLM 경로 스텁: detect는 88%, 미리보기는 고정 문장
stub(path.join(base, 'routes', 'analyze.js'), {
  callClaude: async ({ tool }) => ({ _tool: tool.name }),
  buildDetectTool: () => ({ name: 'return_detection_result' }),
  extractClaudeResult: (data, name) => name === 'return_detection_result'
    ? { probability: 88, summary: 'AI 패턴이 강하게 보입니다.', detail: '균일한 문장 종결과 일반론 위주 구성이 관찰됩니다. 구체적 경험 진술이 없습니다.' }
    : { rewritten: '사실 처음엔 저도 반신반의했는데, 직접 써 보니 생각이 좀 달라졌어요.' }
});
// transform이 당기는 엔진들 스텁(여기선 미사용 — require 통과용)
stub(path.join(base, 'engine', 'genretransfer.js'), { genreTransferV2: async () => ({}) });
stub(path.join(base, 'engine', 'evidence.js'), { suggestEvidence: async () => ({}) });
stub(path.join(base, 'engine', 'evidencereview.js'), { reviewCandidates: c => c, hostOf: () => '' });

const express = require('express');
const report = require(path.join(base, 'routes', 'detectreport.js'));
const app = express();
app.use(express.json());
app.use('/', report);

// 추상 위험 문단(일반론) + 구체 문단(경험·수치) 섞은 샘플
const RISKY = '인공지능 기술의 발전은 현대 사회에 많은 영향을 미치고 있다. 이러한 변화는 다양한 분야에서 나타나고 있으며, 우리는 이에 대한 적절한 대응 방안을 모색해야 한다. 기술의 발전과 함께 윤리적 고려 또한 중요해지고 있다.';
const SAFE = '저는 지난 학기에 교내 해커톤에 참가해 사흘 동안 챗봇을 만들었다. 팀원 4명과 새벽 3시까지 디버깅을 했고, 결국 2위로 입상해 상금 50만 원을 받았다.';
const TEXT = RISKY + '\n\n' + SAFE;

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ' — ' + JSON.stringify(extra).slice(0, 300) : ''}`); }
}

const srv = app.listen(0, async () => {
  const url = `http://127.0.0.1:${srv.address().port}`;
  const post = (body) => fetch(url + '/detect-report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));

  try {
    const short = await post({ text: '너무 짧은 글' });
    check('100자 미만 400', short.status === 400, short);

    const r1 = await post({ text: TEXT });
    check('보고서 200 + 무과금 표시', r1.status === 200 && r1.body.ok && r1.body.free === true, r1);
    check('LLM 판정 수치(88%) 수신', r1.body.probability === 88, r1.body.probability);
    check('문단 지도 2건 + 위험/안전 구분', r1.body.paragraphs.length === 2 && r1.body.paragraphs[0].kind !== 'concrete' && r1.body.paragraphs[1].kind === 'concrete', r1.body.paragraphs);
    check('문단 사유 한국어 카피', /일반론|구체/.test(r1.body.paragraphs[0].reason), r1.body.paragraphs[0]);
    check('미리보기 before=위험 문단 문장', !!r1.body.example && RISKY.includes(r1.body.example.before.slice(0, 20)), r1.body.example);
    const len = TEXT.length;
    const sol = r1.body.solutions;
    check('비용 산식 일치(다듬기·블로그·재구성)', sol.polish.credits === Math.ceil(len / 100) && sol.blog.credits === Math.ceil(len / 100) * 2 && sol.restructure.credits === 200 && sol.restructure.creditsEvidence === 300, sol);
    check('밴드 3종 포함', !!sol.polish.band && !!sol.blog.band && !!sol.restructure.band, sol);
    check('잔여 횟수 1', r1.body.remainingToday === 1, r1.body.remainingToday);

    const r2 = await post({ text: TEXT });
    check('2회차 200·잔여 0', r2.status === 200 && r2.body.remainingToday === 0, r2.body.remainingToday);
    const r3 = await post({ text: TEXT });
    check('3회차 429(일일 한도 2)', r3.status === 429, r3);

    // 로컬 개발 모드(이중 게이트): 한도 미적용 + 잔여 표기 null — devNoAuth는 요청 시점에 env를 읽으므로 같은 프로세스에서 검증 가능
    process.env.DEV_NO_AUTH = '1';
    const r4 = await post({ text: TEXT });
    check('DEV_NO_AUTH=1이면 한도 무시(200)·잔여 null', r4.status === 200 && r4.body.remainingToday === null, { status: r4.status, remain: r4.body.remainingToday });
    delete process.env.DEV_NO_AUTH;
  } catch (e) {
    failed++;
    console.error('  ✗ 테스트 실행 오류:', e);
  }
  console.log(`\n결과: ${passed}통과 / ${failed}실패`);
  srv.close(() => process.exit(failed ? 1 : 0));   // close 콜백 뒤 exit — Windows libuv 종료 레이스 회피
  setTimeout(() => process.exit(failed ? 1 : 0), 1500).unref();
});
