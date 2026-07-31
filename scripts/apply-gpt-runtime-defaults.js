'use strict';

const { db } = require('../config');
const gptRuntimeConfig = require('../lib/gptRuntimeConfig');

async function main() {
  if (!db) throw new Error('Firestore is not initialized');
  const config = gptRuntimeConfig.sanitizeConfig(gptRuntimeConfig.DEFAULT_CONFIG);
  await db.collection(gptRuntimeConfig.SETTINGS_COLLECTION).doc(gptRuntimeConfig.SETTINGS_DOC).set({
    ...config,
    version: gptRuntimeConfig.VERSION,
    updatedBy: 'apply-gpt-runtime-defaults',
    updatedAtMs: Date.now(),
    note: 'GPT-5.6 Luna/Terra runtime defaults requested 2026-07-31'
  }, { merge: true });
  console.log(JSON.stringify({
    ok: true,
    activeProvider: config.activeProvider,
    models: config.models,
    reasoning: config.reasoning,
    cache: config.cache,
    escalation: config.escalation
  }));
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err && err.message || err);
  process.exit(1);
});
