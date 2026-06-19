// [tools/_test-usagemeter.js] 경량 usage 계측 — estimateUsd 정확도(감사 §2.3 예시) + recordUsage 안전성
const assert = require('assert');
const { estimateUsd, recordUsage } = require('../engine/usagemeter');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ✅', name); } catch (e) { fail++; console.log('  ❌', name, '\n      ', e.message); } }
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

t('Sonnet 10K입력+8K출력 ≈ $0.15 (감사 §2.3)', () => {
  const usd = estimateUsd('claude-sonnet-4-6', { input_tokens: 10000, output_tokens: 8000 });
  assert(near(usd, 0.15), `expected 0.15, got ${usd}`);
});
t('Sonnet 캐시 hit(입력 전부 read)+8K출력 ≈ $0.123', () => {
  const usd = estimateUsd('claude-sonnet-4-6', { cache_read_input_tokens: 10000, output_tokens: 8000 });
  assert(near(usd, 0.123), `expected 0.123, got ${usd}`);
});
t('Haiku 단가 1/3 (10K입력+8K출력 = $0.05)', () => {
  const usd = estimateUsd('claude-haiku-4-5', { input_tokens: 10000, output_tokens: 8000 });
  assert(near(usd, 0.05), `expected 0.05, got ${usd}`);   // 10000*1/1e6 + 8000*5/1e6 = 0.01+0.04
});
t('5분 cache write = 1.25× 입력단가', () => {
  const usd = estimateUsd('claude-sonnet-4-6', { cache_creation_input_tokens: 10000 });
  assert(near(usd, 0.0375), `expected 0.0375, got ${usd}`);   // 10000*3.75/1e6
});
t('web_search 1회 = $0.01 추가', () => {
  const usd = estimateUsd('claude-sonnet-4-6', { input_tokens: 1000, server_tool_use: { web_search_requests: 3 } });
  assert(near(usd, 0.003 + 0.03), `expected 0.033, got ${usd}`);   // 1000*3/1e6 + 3*0.01
});
t('5m/1h 분리 정보 반영', () => {
  const usd = estimateUsd('claude-sonnet-4-6', { cache_creation_input_tokens: 10000, cache_creation: { ephemeral_5m_input_tokens: 4000, ephemeral_1h_input_tokens: 6000 } });
  assert(near(usd, (4000 * 3.75 + 6000 * 6) / 1e6), `got ${usd}`);
});
t('usage 누락/undefined 안전(0)', () => {
  assert.strictEqual(estimateUsd('claude-sonnet-4-6', null), 0);
  assert.strictEqual(estimateUsd(null, {}), 0);
});
t('recordUsage는 예외 안 던짐(로그만)', () => {
  recordUsage({ model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 50 }, task: 'test' });
  recordUsage({});   // 전부 누락
  recordUsage();
});

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAIL'} (pass ${pass} / fail ${fail})`);
process.exit(fail === 0 ? 0 : 1);
