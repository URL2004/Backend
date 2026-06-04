#!/usr/bin/env node
// [engine-sweep.js] 다양한 모드·엣지케이스를 한 번에 돌려 일반화 결함을 찾는 테스트 스윕.
// 각 케이스: runHumanize 후 가드 한 줄 요약 + 기대치 대비 이상 플래그. case별 try/catch(플래키 격리).
// 사용: node engine-sweep.js   (LLM_BACKEND 미설정 시 claudecode)
if (!process.env.LLM_BACKEND) process.env.LLM_BACKEND = 'claudecode';
const analyze = require('./routes/analyze');

const CASES = [
  {
    name: 'resume/ko 1인칭 자소서(게이트 open 유지)',
    mode: 'resume', lang: 'ko',
    text: '저는 팀 프로젝트에서 의견이 부딪힐 때 조율하는 역할을 자주 맡았습니다. 처음에는 제 생각을 밀어붙이려 했지만, 듣는 법을 배우면서 협업이 한결 수월해졌습니다. 마감이 급할수록 역할을 다시 나누는 일이 중요하다는 것도 알게 됐습니다.',
    expect: 'pov open(저는 보존), novelty 0'
  },
  {
    name: 'thesis/ko 기존 수치·인용 보존(신규 생성 X)',
    mode: 'thesis', lang: 'ko',
    text: '본 연구는 표본 200명을 대상으로 설문을 진행했다. 분석 결과 두 변수 사이의 상관은 p < 0.05 수준에서 유의했다. 다만 표본의 지역 편중이라는 한계가 존재한다.',
    expect: 'novelty 0, lostFacts 0(200명·0.05 보존), fakeRef 0'
  },
  {
    name: 'assignment/ko 무인칭 추상(게이트 closed → 일화 주입 X)',
    mode: 'assignment', lang: 'ko',
    text: '협업은 단순히 일을 나누는 것이 아니다. 서로 다른 관점을 조율하는 과정에서 더 나은 결론이 나온다. 그러나 의견 차이를 다루는 일은 생각보다 어렵다.',
    expect: 'pov 0→0(1인칭 주입 X)'
  },
  {
    name: 'blog/ko 범위표기(틸드 보존)',
    mode: 'blog', lang: 'ko',
    text: '이번 주말에 동네 카페에 다녀왔다. 아메리카노가 4천~5천원대라 부담이 없었고, 자리도 20~30분은 충분히 머물 만큼 편했다. 다만 주차가 조금 불편했다.',
    expect: 'novelty 0, lostFacts 0(4천~5천·20~30분 보존)'
  },
  {
    name: 'en assignment 영문(대문자 오탐 X)',
    mode: 'assignment', lang: 'en',
    text: 'Most students underestimate how much consistency matters. Reviewing a little every day beats cramming the night before. But building that habit is harder than it sounds.',
    expect: 'novelty 0(문장 첫 대문자 오탐 X), pov(영문 optIn)'
  }
];

function pct(n) { return typeof n === 'number' ? (n * 100).toFixed(0) + '%' : '–'; }

(async () => {
  console.log(`\n════════ ENGINE SWEEP (${process.env.LLM_BACKEND}) ════════`);
  for (const c of CASES) {
    process.stdout.write(`\n▶ ${c.name}\n  기대: ${c.expect}\n`);
    try {
      const out = await analyze.runHumanize({ text: c.text, mode: c.mode, lang: c.lang, floorV2: true, optIn: c.lang === 'en' });
      const r = out.result, fl = r.floorLength || {}, pd = out.povDrift || {};
      const nov = r.floorNovelty || {}, lost = r.lostFacts || {}, rep = r.repetition || {};
      // FLOOR 불변식(반드시 0이어야 — 모든 글 공통). 위반 시 ✗.
      const hard = [];
      if (nov.count) hard.push('novelty주입 ' + nov.items.join(','));
      if (lost.count) hard.push('사실증발 ' + lost.items.join(','));
      if (pd.introducedFirstPerson && c.lang !== 'en') hard.push('1인칭주입');
      if (rep.count) hard.push('결론반복 ' + rep.count);
      // 경고(품질·정보 — 글에 따라 허용될 수 있음).
      const soft = [];
      if (fl.status === 'overHard') soft.push('과확장 ' + fl.ratio);
      if (fl.status === 'short') soft.push('과압축 ' + fl.ratio);
      if (pd.droppedFirstPerson) soft.push('화자손실(1인칭→0)');
      console.log(`  결과: 분량 ${fl.ratio}(${fl.status}) · pov ${pd.input_fp_singular}→${pd.output_fp_singular} · novelty ${nov.count} · lost ${lost.count} · refine ${out.refineReason}`);
      console.log(`  판정: ${hard.length ? '✗ FLOOR 위반: ' + hard.join(' | ') : '✅ FLOOR 통과'}${soft.length ? '  ⚠️ ' + soft.join(' / ') : ''}`);
    } catch (e) {
      console.log(`  💥 실패: ${e.message}`);
    }
  }
  console.log('\n════════ END ════════\n');
})();
