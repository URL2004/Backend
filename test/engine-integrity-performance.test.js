'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const structure = require('../engine-gpt-prod/structureChunk');
const { alignedReviewPairs } = require('../engine-gpt-prod/reviewAlignment');
const { createRecoveryBudget } = require('../engine-gpt-prod/recoveryBudget');
const { createShortChunkBatch, buildChunkWorkUnits } = require('../engine-gpt-prod/shortChunkBatch');
const ledger = require('../engine-gpt-prod/callLedger');

const source = Array.from({length: 20}, (_, i) => Array.from({length: 6}, (_, j) =>
  `자료 ${i + 1}의 검토 과정 ${j + 1}에서는 참여자가 남긴 기록을 분류하고 관찰 내용과 응답 결과를 대조하였다.`).join(' ')).join('\n\n');
const outputText = source.replaceAll('검토 과정', '검토 단계').replaceAll('대조하였다', '비교하였다');
const options = { source, outputText, chunks: [], mode: 'blog', requestStrength: 'basic', documentProfile: { profile: 'report_assignment', confidence: .9 } };
test('20 paragraph / 120 sentence unchanged layout takes fast path below 500ms p95', async () => {
  const times = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    const result = await structure.restoreParagraphLayoutAsync(options);
    times.push(performance.now() - start);
    assert.equal(result.text, outputText);
    assert.equal(result.alignmentMetrics.fastPath, true);
    assert.equal(result.alignmentMetrics.states, 0);
  }
  assert.ok(times.sort((a,b) => a-b)[18] < 500, JSON.stringify(times));
});
test('uncertain paragraph alignment yields to cancellation and preserves character order', async () => {
  const controller = new AbortController();
  const pending = structure.restoreParagraphLayoutAsync({ ...options, outputText: outputText.replaceAll('\n\n', ' '), signal: controller.signal });
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(pending, { name: 'AbortError' });
});

test('same paragraph counts and matching edges do not hide moved interior sentences', () => {
  const { hasStableSentenceOwnership } = require('../engine-gpt-prod/paragraphAlignment');
  const groups = Array.from({length:3},(_,i)=>Array.from({length:3},(_,j)=>`자료 ${i}번의 단계 ${j}를 검토하고 분석하였다.`));
  const moved = groups.map(x=>[...x]);
  [moved[0][1],moved[1][1]]=[moved[1][1],moved[0][1]];
  assert.equal(hasStableSentenceOwnership(groups,groups),true);
  assert.equal(hasStableSentenceOwnership(groups,moved),false);
});
test('shared source boundaries survive uneven expansion without crossing facts', () => {
  const a = Array.from({length: 300}, (_, i) => `고유 자료 ${i}번의 관찰 내용을 비교하고 검증하였다. ${'가'.repeat(i < 150 ? 100 : 10)}.`);
  const b = Array.from({length: 300}, (_, i) => `고유 자료 ${i}번의 관찰 내용을 비교하고 확인하였다. ${'나'.repeat(i < 150 ? 10 : 100)}.`);
  const pairs = alignedReviewPairs(a.join('\n\n'), b.join('\n\n'), 5000);
  assert.ok(pairs.length > 1);
  assert.equal(pairs.map(p=>p.sourceContext).join(''), a.join('\n\n'));
  assert.equal(pairs.map(p=>p.output).join(''), b.join('\n\n'));
  for (const pair of pairs) assert.deepEqual(pair.sourceContext.match(/자료 \d+번/gu), pair.output.match(/자료 \d+번/gu));
});
test('reordered or ambiguous anchors permit whole-document judgement only', () => {
  const a = Array.from({length: 20}, (_, i) => `자료 ${i}의 독립적인 관측 내용을 조사했다.`);
  const b = [...a].reverse();
  const pair = alignedReviewPairs(a.join(' '), b.join(' '), 100);
  assert.equal(pair.length, 1); assert.equal(pair[0].repairSafe, false);
});

test('one crossed region expands both review windows without disabling the other sections', () => {
  const a = Array.from({ length: 30 }, (_, i) => `고유 자료 ${i}번의 독립적인 관측 내용을 조사하고 결과를 기록하였다.`);
  const b = [...a];
  [b[10], b[11]] = [b[11], b[10]];
  const pairs = alignedReviewPairs(a.join(' '), b.join(' '), 230);
  assert.ok(pairs.length > 2);
  assert.equal(pairs.map(p => p.sourceContext).join(''), a.join(' '));
  assert.equal(pairs.map(p => p.output).join(''), b.join(' '));
  const crossed = pairs.find(p => p.sourceContext.includes('자료 10번'));
  assert.ok(crossed.sourceContext.includes('자료 11번'));
  assert.ok(crossed.output.includes('자료 10번') && crossed.output.includes('자료 11번'));
  for (const p of pairs) assert.deepEqual(
    [...p.sourceContext.matchAll(/자료 (\d+)번/g)].map(m => m[1]).sort(),
    [...p.output.matchAll(/자료 (\d+)번/g)].map(m => m[1]).sort());
});

test('unique shared headings align differently sized bodies; merged sentence anchors are not repair positions', () => {
  const a = ['Ⅰ. 서론\n'+'가'.repeat(3000), 'Ⅱ. 방법\n'+'나'.repeat(600), 'Ⅲ. 결론\n'+'다'.repeat(1800)].join('\n\n');
  const b = ['Ⅰ. 서론\n'+'라'.repeat(600), 'Ⅱ. 방법\n'+'마'.repeat(3000), 'Ⅲ. 결론\n'+'바'.repeat(1800)].join('\n\n');
  const pairs = alignedReviewPairs(a,b,2000);
  assert.ok(pairs.length>1);
  for(const pair of pairs) assert.deepEqual(pair.sourceContext.match(/[ⅠⅡⅢ]\. [^\n]+/g),pair.output.match(/[ⅠⅡⅢ]\. [^\n]+/g));
  const source = '첫째 기관은 대상자의 기록을 검토하고 검증하였다. 둘째 기관은 운영 결과를 별도로 분석하고 평가하였다. 마지막 기관은 결과를 문서로 정리하였다.';
  const merged = source.replace('검증하였다. 둘째','검증하였으며 둘째');
  const joined = alignedReviewPairs(source,merged,40);
  assert.equal(joined.length,1);
  assert.equal(joined[0].repairSafe,false);
});
test('concurrent call reservations cannot exceed cap; unknown failure is not zero cost', () => {
  const budget = createRecoveryBudget(.02);
  const a = budget.reserveCall(.008), b = budget.reserveCall(.008);
  assert.ok(a && b); assert.equal(budget.reserveCall(.008), null);
  budget.settleCall(a, { estimatedUsd: .004 }); budget.settleCall(b, null);
  assert.equal(budget.snapshot().spentUsd, .004);
  assert.equal(budget.snapshot().unknownUsageUsd, .008);
  assert.equal(budget.snapshot().reservedUsd, 0);
  assert.ok(budget.reserveCall(.008));
  assert.equal(budget.settleCall(a, { estimatedUsd: 1 }), false);
});

test('optional recovery admission retains time for a repair and final verdict', () => {
  let now = 1000;
  const budget = createRecoveryBudget(.2, { clock: () => now, jobDeadlineMs: 300000 });
  assert.equal(budget.canStart(), true);
  assert.equal(budget.deadlineMs(), 180000);
  now = 61000;
  assert.equal(budget.canStart(), false);
  assert.equal(budget.denialReason(), 'recovery_final_audit_time_reserved');
});

test('route execution deadline reaches worker calls and structural fallback keeps one job deadline', () => {
  const fs = require('node:fs'), path = require('node:path');
  const route = fs.readFileSync(path.join(__dirname,'../routes/transform.js'),'utf8');
  assert.match(route,/job\.executionDeadlineMs = Date\.now\(\) \+ limit/);
  assert.equal((route.match(/deadlineMs: job\.executionDeadlineMs/g)||[]).length,4);
  const worker = fs.readFileSync(path.join(__dirname,'../lib/humanizeWorkerPool.js'),'utf8');
  assert.match(worker,/const \{ signal, \.\.\.serializable \} = options/);
  const engine = fs.readFileSync(path.join(__dirname,'../engine-gpt-prod/index.js'),'utf8');
  assert.match(engine,/options = \{ \.\.\.options, deadlineMs:/);
  assert.match(engine,/runEngine\(\{ \.\.\.options, approvedStructure: null \}\)/);
});
test('append-only call ledger includes rejected usage and separates HTTP attempts', async () => {
  let result;
  await ledger.run(async () => {
    await assert.rejects(ledger.track({ model: 'test', meta: { phase: 'first' } }, async () => {
      throw Object.assign(new Error('schema'), { usage: { estimatedUsd: .03, totalTokens: 30 }, httpAttemptCount: 2 });
    }));
    await ledger.track({ model: 'test', meta: { phase: 'second' } }, async () => ({ usage: { estimatedUsd: .01, totalTokens: 10 }, httpAttemptCount: 1 }));
  }, (_, value) => { result = value; });
  assert.equal(result.modelCallCount, 2); assert.equal(result.httpAttemptCount, 3);
  assert.equal(result.usage.estimatedUsd, .04); assert.equal(result.failedEstimatedUsd, .03);
  assert.doesNotMatch(JSON.stringify(result), /system|prompt|원문/);
});

test('nested audit defaults cannot erase the absolute job deadline', async () => {
  await ledger.run(() => ledger.withPolicy({ deadlineMs: 12345 }, () =>
    ledger.withPolicy({ optional: false, deadlineMs: undefined }, async () => {
      await ledger.track({ model: 'test' }, async options => {
        assert.equal(options.deadlineMs, 12345);
        return { usage: null, httpAttemptCount: 0 };
      });
    })));
});
test('batch validates IDs, keeps valid edits and individually recovers only missing IDs', async () => {
  const calls = [];
  const batch = createShortChunkBatch(async options => {
    calls.push(options);
    return options.schemaName === 'gpt_prod_humanize_chunk_batch'
      ? { json: { items: [{ id: '1', result: { outputText: '둘째 결과' } }, { id: 'unknown', result: { outputText: '외부' } }] }, usage: { estimatedUsd: .01 } }
      : { json: { outputText: '첫째 결과' }, usage: { estimatedUsd: .005 } };
  }, { enabled: true });
  const result = await Promise.all([0, 1].map(chunkIndex => batch.complete({ system: 'same', user: `contract ${chunkIndex}`, model: 'test',
    schema: { type: 'object' }, maxOutputTokens: 100, meta: { phase: 'primary', mode: 'assignment', chunkIndex } }, 100)));
  assert.deepEqual(result.map(r=>r.json.outputText), ['첫째 결과', '둘째 결과']);
  assert.equal(calls.length, 2); assert.equal(batch.metrics.individualRecoveryCount, 1);
});

test('tiny source units are grouped before workers without joining their bodies', () => {
  const chunks = Array.from({length:10},(_,i)=>({text:'가'.repeat(i===8?400:200),locked:i%2===1}));
  const units = buildChunkWorkUnits(chunks,true);
  assert.ok(units.some(unit=>unit.join(',')==='0,2,4,6'));
  assert.deepEqual(units.flat().sort((a,b)=>a-b), Array.from({length:10},(_,i)=>i));
  assert.ok(units.every(unit=>unit.length<=4));
  assert.ok(units.find(unit=>unit.includes(8)).length===1);
});

test('batch failures and escalations share two provider slots and queued cancellation', async () => {
  let active=0,max=0;
  const batch=createShortChunkBatch(async()=>{active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,10));active--;return {json:{}};},{enabled:true});
  const controller=new AbortController();
  const pending=Array.from({length:8},(_,i)=>batch.complete({meta:{phase:'escalation'},signal:i===7?controller.signal:undefined},100));
  controller.abort();
  const outcomes=await Promise.allSettled(pending);
  assert.equal(max,2);assert.equal(outcomes[7].status,'rejected');
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,7);
});
