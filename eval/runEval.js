// [eval/runEval.js] FLOOR 가드 결정론 평가 하네스 (LLM 없음 — 비용 0, CI 가능)
// ────────────────────────────────────────────────────────────────
// 라벨된 케이스(guard-cases.js)에 가드를 돌려 기대 판정과 대조.
// recall(잡아야 할 위반을 잡았나) + FP(안 잡아야 할 걸 잡았나=오탐) 리포트.
// 보고서 §8.9(guard 정밀도 1급 요구) · §11/§12 CI hard gate(deterministic guard pass).
//
// 실행:  node eval/runEval.js   (또는 npm run eval)
// 종료코드: 불일치 1건이라도 있으면 1 (CI 실패).

const floor = require('../engine/floor');
const chunk = require('../engine/chunk');
const softguard = require('../engine/softguard');
const { buildContract } = require('../engine/contract');
const cases = require('./guard-cases');

let pass = 0, fail = 0;
const fails = [];

function check(name, ok, detail) {
  if (ok) { pass++; }
  else { fail++; fails.push(`${name} — ${detail}`); }
}

for (const c of cases) {
  const povSeed = floor.computePovSeed(c.input);
  const e = c.expect || {};

  // novelty
  if (e.noveltyHas || e.noveltyCount0) {
    const nov = floor.measureNovelty(c.input, c.output);
    if (e.noveltyHas) {
      const missing = e.noveltyHas.filter(t => !nov.items.some(it => it.includes(t) || t.includes(it)));
      check(c.name, missing.length === 0, `novelty 누락(recall): ${missing.join(', ')} | 검출=${JSON.stringify(nov.items)}`);
    }
    if (e.noveltyCount0) {
      check(c.name, nov.count === 0, `novelty 오탐(FP): ${JSON.stringify(nov.items)}`);
    }
  }

  // pov drift
  if (typeof e.povDrift === 'boolean') {
    const d = floor.measurePovDrift(c.input, c.output, povSeed);
    check(c.name, d.introducedFirstPerson === e.povDrift,
      `pov 기대=${e.povDrift} 실제=${d.introducedFirstPerson} (in=${d.input_fp_singular} out=${d.output_fp_singular})`);
  }

  // fake internal refs (thesis)
  if (e.fakeRefHas || e.fakeRefCount0) {
    const fake = floor.measureFakeInternalRefs(c.input, c.output);
    if (e.fakeRefHas) {
      const missing = e.fakeRefHas.filter(t => !fake.fabricated.some(it => it.includes(t) || t.includes(it)));
      check(c.name, missing.length === 0, `fakeRef 누락(recall): ${missing.join(', ')} | 검출=${JSON.stringify(fake.fabricated)}`);
    }
    if (e.fakeRefCount0) {
      check(c.name, fake.count === 0, `fakeRef 오탐(FP): ${JSON.stringify(fake.fabricated)}`);
    }
  }

  // length status
  if (e.lengthStatus) {
    const len = floor.measureLength(c.input, c.output, c.mode);
    check(c.name, len.status === e.lengthStatus, `length 기대=${e.lengthStatus} 실제=${len.status} (ratio=${len.ratio})`);
  }

  // lost facts (숫자 증발)
  if (e.lostHas || e.lostCount0) {
    const lost = floor.measureLostFacts(c.input, c.output);
    if (e.lostHas) {
      const missing = e.lostHas.filter(t => !lost.items.some(it => it.includes(t) || t.includes(it)));
      check(c.name, missing.length === 0, `lost 누락(recall): ${missing.join(', ')} | 검출=${JSON.stringify(lost.items)}`);
    }
    if (e.lostCount0) {
      check(c.name, lost.count === 0, `lost 오탐(FP): ${JSON.stringify(lost.items)}`);
    }
  }

  // soft drift (cheap risk detector)
  if (typeof e.softFlagged === 'boolean' || e.softHas) {
    const sd = softguard.measureSoftDrift(c.input, c.output);
    if (typeof e.softFlagged === 'boolean') {
      check(c.name, sd.flagged === e.softFlagged, `softFlagged 기대=${e.softFlagged} 실제=${sd.flagged} (added=${JSON.stringify(sd.added)} modalShift=${sd.modalShift})`);
    }
    if (e.softHas) {
      const missing = e.softHas.filter(k => (sd.added[k] || 0) < 1);
      check(c.name, missing.length === 0, `soft 누락: ${missing.join(', ')} | added=${JSON.stringify(sd.added)}`);
    }
  }
}

// ── 청킹 결정론 테스트 (split/merge 왕복·position·charRange) ──
const chunkTexts = [
  '한 문단짜리 글입니다. 줄바꿈 없음.',
  '첫 문단입니다.\n\n둘째 문단입니다.\n\n셋째 결론 문단입니다.',
  '\n\n앞에 빈 줄.\n\n본문.\n\n\n\n뒤에 여러 줄.\n\n',
  '인트로.\n\n바디1.\n\n바디2.\n\n결론.'
];
for (const t of chunkTexts) {
  const chunks = chunk.splitChunks(t);
  // 왕복 보존(불변식)
  check('chunk/round-trip', chunk.mergeChunks(chunks) === t, `merge!=원본: ${JSON.stringify(t)} -> ${JSON.stringify(chunk.mergeChunks(chunks))}`);
  // charRange 정합 (각 청크 text === 원본 슬라이스)
  const rangeOk = chunks.every(c => t.slice(c.start, c.end) === c.text);
  check('chunk/charRange', rangeOk, `charRange 불일치: ${JSON.stringify(chunks.map(c => [c.start, c.end]))}`);
}
// position 배정
const p3 = chunk.splitChunks('인트로.\n\n바디.\n\n결론.').map(c => c.position);
check('chunk/position 3문단', JSON.stringify(p3) === JSON.stringify(['intro', 'body', 'conclusion']), `position=${JSON.stringify(p3)}`);
const p1 = chunk.splitChunks('한 문단.').map(c => c.position);
check('chunk/position 1문단', JSON.stringify(p1) === JSON.stringify(['single']), `position=${JSON.stringify(p1)}`);
// outputText 치환 후 merge (재작성 시뮬레이션)
const cc = chunk.splitChunks('가.\n\n나.\n\n다.');
cc[1].outputText = '나나나.';
check('chunk/merge with outputText', chunk.mergeChunks(cc) === '가.\n\n나나나.\n\n다.', `merge=${JSON.stringify(chunk.mergeChunks(cc))}`);
// nearestChunkId: span → 해당 청크 index
const nc = chunk.splitChunks('도입 문장이다.\n\n본문 핵심 주장.\n\n결론 요약이다.');
check('chunk/nearestChunkId 본문', chunk.nearestChunkId(nc, '본문 핵심 주장') === 1, `id=${chunk.nearestChunkId(nc, '본문 핵심 주장')}`);
check('chunk/nearestChunkId 미존재', chunk.nearestChunkId(nc, '없는 문장 xyz') === null, `id=${chunk.nearestChunkId(nc, '없는 문장 xyz')}`);

// ── Contract 결정론 테스트 ──
const cKo = buildContract('이 글은 비인칭 서술이다. 기술이 사회를 바꾼다.', { mode: 'thesis', lang: 'ko', optIn: false });
check('contract/thesis 비인칭 게이트 닫힘', cKo.speakerGateClosed === true && cKo.povSeed.fp_singular === 0, `seed=${JSON.stringify(cKo.povSeed)} gate=${cKo.speakerGateClosed}`);
check('contract/thesis length 정책', cKo.lengthPolicy && cKo.lengthPolicy.hardMax === 1.3, `pol=${JSON.stringify(cKo.lengthPolicy)}`);
const cFp = buildContract('저는 작년에 그 일을 했습니다.', { mode: 'assignment', lang: 'ko', optIn: false });
check('contract/1인칭 있으면 게이트 열림', cFp.speakerGateClosed === false && cFp.povSeed.fp_singular >= 1, `seed=${JSON.stringify(cFp.povSeed)} gate=${cFp.speakerGateClosed}`);
const cOpt = buildContract('비인칭 서술.', { mode: 'assignment', lang: 'ko', optIn: true });
check('contract/optIn이면 게이트 열림', cOpt.speakerGateClosed === false, `gate=${cOpt.speakerGateClosed}`);

console.log('\n════════ FLOOR 가드 결정론 EVAL ════════');
console.log(`케이스 ${cases.length}개 · 검사 ${pass + fail}건 · 통과 ${pass} · 실패 ${fail}`);
if (fails.length) {
  console.log('\n[실패]');
  fails.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  console.log('');
  process.exit(1);
} else {
  console.log('✅ 전부 통과 (recall + FP 무결)\n');
}
