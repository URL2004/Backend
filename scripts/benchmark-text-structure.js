'use strict';
// Offline, synthetic-only regression probe. Never calls a model or production.
// Timing is reported, not asserted in the parallel unit suite (host load varies).
const assert = require('node:assert/strict');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { dependentQuoteLayout } = require('../engine-gpt-prod/dependentQuoteLayout');
const { detectDocumentProfile } = require('../engine-gpt-prod/documentProfile');
const { restoreParagraphLayoutAsync } = require('../engine-gpt-prod/structureChunk');
const rounds = 10;
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50Ms: sorted[Math.ceil(sorted.length * .5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maxMs: sorted.at(-1) };
};
async function main() {
  const result = { syntheticOnly: true, paidCalls: 0, rounds, limits: [] };
  for (const length of [30000, 50000]) {
    const source = '관찰 내용은\n“기록”\n이라는 문장으로 작성했다.\n'.repeat(2000).slice(0, length);
    detectDocumentProfile(source); // Record warm work separately from startup/JIT.
    const profileTimes = [], quoteTimes = [];
    for (let i = 0; i < rounds; i++) {
      let start = performance.now();
      const quote = dependentQuoteLayout(source);
      quoteTimes.push(performance.now() - start);
      assert.equal(quote.text.replace(/\s/gu, ''), source.replace(/\s/gu, ''));
      start = performance.now();
      const profile = detectDocumentProfile(source);
      profileTimes.push(performance.now() - start);
      assert.notEqual(profile.profile, 'creative');
      await new Promise(setImmediate);
    }
    result.limits.push({ length, profile: stats(profileTimes), quote: stats(quoteTimes) });
  }
  const source = Array.from({ length: 20 }, (_, i) => Array.from({ length: 6 }, (_, j) =>
    `자료 ${i+1}의 검토 과정 ${j+1}에서는 참여자가 남긴 기록을 분류하고 관찰 내용과 응답 결과를 대조하였다.`).join(' ')).join('\n\n');
  const outputText = source.replaceAll('검토 과정', '검토 단계').replaceAll('대조하였다', '비교하였다');
  const args = { source, outputText, chunks: [], mode: 'blog', requestStrength: 'basic', documentProfile: 'report_assignment' };
  await restoreParagraphLayoutAsync(args);
  const lag = monitorEventLoopDelay({ resolution: 1 });
  lag.enable();
  await new Promise(resolve => setTimeout(resolve, 20));
  const times = [];
  for (let i = 0; i < rounds; i++) {
    const start = performance.now();
    const documents = await Promise.all([0, 1, 2].map(() => restoreParagraphLayoutAsync(args)));
    times.push(performance.now() - start);
    documents.forEach(document => assert.equal(document.text, outputText));
  }
  await new Promise(resolve => setTimeout(resolve, 20));
  lag.disable();
  const controller = new AbortController();
  const pending = restoreParagraphLayoutAsync({ ...args, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  result.concurrent = { jobs: 3, paragraphs: 20, sentences: 120, batch: stats(times),
    eventLoopP95Ms: lag.percentile(95) / 1e6, eventLoopMaxMs: lag.max / 1e6,
    ordered: true, contentPreserved: true, queuedCancellation: true };
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
