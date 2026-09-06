'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const VERSION = 'detect-benchmark-v1';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const normalizedHash = text => sha(text.normalize('NFC').replace(/\s+/gu, ' ').trim());
const lengthBucket = n => n < 300 ? 'under_300' : n < 1000 ? '300_999' : n <= 4000 ? '1000_4000' : 'over_4000';
const TARGETS = { human_reference: { report_assignment: 80, resume_application: 80, review_blog: 60, explainer: 50, personal_essay: 30 },
  ai: { report_assignment: 80, resume_application: 80, review_blog: 60, explainer: 50, personal_essay: 30 }, humanized: { all: 100 } };

function buildManifest(rows, { seed, developmentFraction = .6 } = {}) {
  if (!seed || !Array.isArray(rows) || !rows.length || !(developmentFraction > 0 && developmentFraction < 1)) throw Error('benchmark_invalid_input');
  const ids = new Set(), textHashes = new Set(), parents = new Map(), linked = new Map();
  function find(x) { if (!parents.has(x)) parents.set(x, x); if (parents.get(x) !== x) parents.set(x, find(parents.get(x))); return parents.get(x); }
  function join(a, b) { const x = find(a), y = find(b); if (x !== y) parents.set(y, x); }
  for (const r of rows) {
    if (!r || typeof r.id !== 'string' || !r.id || ids.has(r.id)) throw Error('benchmark_duplicate_or_missing_id');
    ids.add(r.id);
    if (typeof r.text !== 'string' || !r.text.trim() || !r.group || !r.genre || !['human_reference', 'ai', 'humanized', 'mixed', 'external_detector'].includes(r.authorship)) throw Error('benchmark_missing_provenance');
    const hash = normalizedHash(r.text);
    if (textHashes.has(hash)) throw Error('benchmark_duplicate_text');
    textHashes.add(hash);
    if (!r.source || !r.license || !r.permissions || typeof r.permissions.train !== 'boolean' || typeof r.permissions.evaluate !== 'boolean' || typeof r.permissions.derive !== 'boolean') throw Error('benchmark_missing_permissions');
    // Project intake policy, not an inference about what every license permits.
    if (/\bNC\b/iu.test(r.license) && (r.permissions.train || r.permissions.evaluate || r.permissions.derive)) throw Error('benchmark_commercial_permission_unreviewed');
    if (/\bND\b/iu.test(r.license) && (r.permissions.train || r.permissions.derive)) throw Error('benchmark_derivative_permission_unreviewed');
    if (r.authorship === 'human_reference' && !['source_backed', 'verified_process'].includes(r.labelQuality)) throw Error('benchmark_invalid_human_label');
    if (r.authorship === 'ai' && (!r.generator || !/^[a-f0-9]{64}$/u.test(r.promptHash || ''))) throw Error('benchmark_missing_generation_provenance');
    if (r.authorship === 'humanized' && (!r.parentId || !r.engineVersion || !r.mode)) throw Error('benchmark_missing_transform_provenance');
    // Both document and topic links are connected transitively, including derivatives.
    find(r.id);
    for (const key of ['group', 'topicGroup']) if (r[key]) {
      const token = key + ':' + r[key];
      if (linked.has(token)) join(r.id, linked.get(token)); else linked.set(token, r.id);
    }
  }
  for (const r of rows) if (r.parentId) {
    if (!ids.has(r.parentId)) throw Error('benchmark_parent_missing');
    if (r.parentId === r.id) throw Error('benchmark_parent_cycle');
    join(r.id, r.parentId);
  }
  const byId = new Map(rows.map(r => [r.id, r]));
  for (const row of rows) {
    if (row.parentId && !byId.get(row.parentId).permissions.derive) throw Error('benchmark_parent_derivation_not_permitted');
    const seen = new Set(); let r = row;
    while (r?.parentId) { if (seen.has(r.id)) throw Error('benchmark_parent_cycle'); seen.add(r.id); r = byId.get(r.parentId); }
  }
  const components = new Map();
  for (const r of rows) { const g = find(r.id); if (!components.has(g)) components.set(g, []); components.get(g).push(r); }
  const records = [];
  for (const members of components.values()) {
    const group = sha(members.map(r => r.id).sort().join('\0'));
    const exposed = members.some(r => r.priorExposure === true);
    const split = exposed || parseInt(sha(seed + '\0' + group).slice(0, 8), 16) / 0x100000000 < developmentFraction ? 'development' : 'holdout';
    for (const r of members) records.push({ id: r.id, group, sourceGroup: r.group, topicGroup: r.topicGroup || null,
      parentId: r.parentId || null, split, priorExposure: exposed, authorship: r.authorship, labelQuality: r.labelQuality || 'generated',
      genre: r.genre, language: r.language || 'ko', chars: r.text.length, lengthBucket: lengthBucket(r.text.length),
      sha256: sha(r.text), normalizedSha256: normalizedHash(r.text), source: r.source, license: r.license,
      permissions: { train: r.permissions.train, evaluate: r.permissions.evaluate, derive: r.permissions.derive },
      generator: r.generator || null, promptHash: r.promptHash || null, promptHashKind: r.promptHashKind || 'request_digest', engineVersion: r.engineVersion || null, mode: r.mode || null });
  }
  records.sort((a, b) => a.id.localeCompare(b.id));
  const deficits = [];
  for (const [label, genres] of Object.entries(TARGETS)) for (const [genre, target] of Object.entries(genres)) {
    const n = records.filter(r => r.authorship === label && (genre === 'all' || r.genre === genre)).length;
    if (n < target) deficits.push({ authorship: label, genre, target, actual: n, missing: target - n });
  }
  const generators = [...new Set(records.filter(r => r.authorship === 'ai').map(r => r.generator))];
  if (generators.length < 3) deficits.push({ type: 'generator_diversity', target: 3, actual: generators.length });
  return { version: VERSION, seed, developmentFraction, n: records.length, groups: components.size, records,
    digest: sha(JSON.stringify(records)), coverage: { targets: TARGETS, deficits, complete: !deficits.length, generators },
    note: 'Source-backed humans are proxy controls. A split is not an untouched holdout if it has already been inspected.' };
}

function assertManifest(manifest, rows) {
  if (manifest?.version !== VERSION || sha(JSON.stringify(manifest.records)) !== manifest.digest) throw Error('benchmark_manifest_changed');
  const byId = new Map(rows.map(r => [r.id, r]));
  if (byId.size !== rows.length || byId.size !== manifest.records.length) throw Error('benchmark_rows_changed');
  for (const r of manifest.records) if (!byId.has(r.id) || sha(byId.get(r.id).text) !== r.sha256) throw Error('benchmark_text_changed');
  return true;
}

function assertTrainingRows(records) {
  if (!records.length || records.some(r => r.split !== 'development' || !r.permissions?.train || !['human_reference', 'ai'].includes(r.authorship))) throw Error('benchmark_training_not_permitted');
  if (records.some(r => /\b(?:NC|ND)\b/iu.test(r.license || ''))) throw Error('benchmark_training_not_permitted');
}

function consumeHoldout(file, { manifest, candidateHash }) {
  if (!/^[a-f0-9]{64}$/u.test(candidateHash || '') || manifest?.version !== VERSION || !manifest.records.some(r => r.split === 'holdout')
    || sha(JSON.stringify(manifest.records)) !== manifest.digest) throw Error('benchmark_invalid_freeze');
  // One ledger per manifest, not per candidate: changing a candidate cannot reopen a holdout.
  const receipt = { version: VERSION, manifestDigest: manifest.digest, candidateHash, consumedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2), { flag: 'wx' });
  return receipt;
}

module.exports = { VERSION, TARGETS, sha, normalizedHash, lengthBucket, buildManifest, assertManifest, assertTrainingRows, consumeHoldout };
