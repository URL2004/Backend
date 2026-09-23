'use strict';

const { db } = require('../config');
const gptRuntimeConfig = require('../lib/gptRuntimeConfig');

async function main() {
  if (!db) throw new Error('Firestore is not initialized');
  const config = await gptRuntimeConfig.getRuntimeConfig({ db, force: true });
  const apply = process.argv.includes('--apply');
  // Preserve cache, thresholds and explicit stage tuning. Migration is limited
  // to supported predecessor model aliases and obsolete effort values.
  if (apply) await db.collection(gptRuntimeConfig.SETTINGS_COLLECTION).doc(gptRuntimeConfig.SETTINGS_DOC).set({
    models: config.models,
    reasoning: config.reasoning,
    version: gptRuntimeConfig.VERSION,
    updatedBy: 'apply-gpt-runtime-defaults',
    updatedAtMs: Date.now(),
    note: 'GPT-6 Luna/Sol role-based migration requested 2026-09-23'
  }, { merge: true });
  console.log(JSON.stringify({
    ok: true,
    applied: apply,
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
