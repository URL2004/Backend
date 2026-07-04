'use strict';

require('dotenv').config();

const koreanQuality = require('../engine/koreanQuality');

async function main() {
  const status = koreanQuality.officialResources.getResourceStatus();
  const sample = [
    '본 글에서는 공공기관의 플랫폼을 통해 이용자에게 서비스를 제공할 수 있다.',
    '데이터셋과 데이터 라벨링 같은 공공언어 후보도 함께 점검한다.',
    '몇 일 뒤 안되요라고 적힌 문장을 고치고 문단 흐름도 확인한다.'
  ].join('\n\n');
  const analysis = koreanQuality.niklTest.analyzeNiklQuality(sample);
  const apiStatus = koreanQuality.officialApi.getApiStatus();
  const api = {};
  if (process.env.NIKL_API_SMOKE_TEST === '1') {
    for (const provider of ['opendict', 'stdict', 'term']) {
      try {
        api[provider] = await koreanQuality.officialApi.lookupProvider(provider, '공공기관', { timeoutMs: 3500 });
      } catch (err) {
        api[provider] = { error: err.message || String(err) };
      }
    }
  }
  console.log(JSON.stringify({
    ok: true,
    resourceStatus: status.available,
    counts: status.counts,
    apiKeysDetected: apiStatus.keys,
    smokeTestApiCalled: process.env.NIKL_API_SMOKE_TEST === '1',
    api,
    sample: {
      niklNormViolationRisk: analysis.niklNormViolationRisk,
      officialResourceRisk: analysis.official?.officialResourceRisk,
      publicLanguageMatches: analysis.official?.publicLanguageMatches?.slice(0, 5).map(m => ({
        term: m.term,
        alternatives: m.alternatives?.slice(0, 3),
        count: m.count
      })),
      topPatterns: analysis.topPatterns?.slice(0, 8).map(p => ({
        id: p.id,
        label: p.label,
        count: p.count
      }))
    }
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
