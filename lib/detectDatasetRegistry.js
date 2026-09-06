'use strict';
const { sha, normalizedHash, buildManifest } = require('./detectBenchmark');
const PROCESSES = new Set(['unknown', 'human_original', 'human_ai_light_edit', 'ai_draft', 'ai_human_substantial_edit', 'mixed', 'humanized_ai']);
const nullable = v => typeof v === 'string' && v.trim() ? v.trim() : null;
function processMetadata(row) {
  const writingProcess = row.writingProcess || (row.authorship === 'ai' ? 'ai_draft' : 'unknown');
  if (!PROCESSES.has(writingProcess)) throw Error('dataset_invalid_writing_process');
  const processEvidence = nullable(row.processEvidence);
  if (writingProcess === 'human_original' && (!processEvidence || row.authorship !== 'human_reference')) throw Error('dataset_human_process_unverified');
  if (row.authorship === 'human_reference' && !['unknown', 'human_original'].includes(writingProcess)) throw Error('dataset_assisted_is_not_human_control');
  if (['human_ai_light_edit', 'ai_human_substantial_edit', 'mixed'].includes(writingProcess) && row.authorship !== 'mixed') throw Error('dataset_process_label_mismatch');
  if (writingProcess === 'humanized_ai' && row.authorship !== 'humanized') throw Error('dataset_process_label_mismatch');
  if (row.labelQuality === 'verified_process' && (!processEvidence || writingProcess !== 'human_original')) throw Error('dataset_verified_process_missing_evidence');
  for (const key of ['publicationDate', 'collectedAt', 'sourceSnapshotDate']) if (row[key] && !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/u.test(row[key])) throw Error('dataset_invalid_date');
  return { writingProcess, processEvidence, processEvidenceLevel: nullable(row.processEvidenceLevel),
    publicationDate: nullable(row.publicationDate), collectedAt: nullable(row.collectedAt), sourceSnapshotDate: nullable(row.sourceSnapshotDate),
    sourceRecordId: nullable(row.sourceRecordId), sourceRevision: nullable(row.sourceRevision),
    authorGroup: row.authorGroup ? sha('author\0' + row.source + '\0' + row.authorGroup) : null,
    siteGroup: row.siteGroup ? sha('site\0' + row.siteGroup) : null,
    templateGroup: row.templateGroup ? sha('template\0' + row.source + '\0' + row.templateGroup) : null };
}
function familyKeys(row) {
  const keys = ['text:' + normalizedHash(row.text)];
  for (const value of [row.familyId, ...(row.relatedFamilyIds || [])]) if (value) keys.push('family:' + sha(value));
  if (row.group) keys.push('source-group:' + sha(row.source + '\0' + row.group));
  if (row.sourceRecordId) keys.push('source-record:' + sha(row.source + '\0' + row.sourceRecordId));
  return [...new Set(keys)].sort();
}
function buildRegistry(manifests) {
  const entries = new Map();
  for (const manifest of manifests) {
    if (sha(JSON.stringify(manifest.records)) !== manifest.digest) throw Error('dataset_registry_manifest_changed');
    for (const r of manifest.records) {
      const keys = r.lineageKeys || ['text:' + r.normalizedSha256, 'source-group:' + sha(r.source + '\0' + r.sourceGroup)];
      for (const key of keys) entries.set(key, { key, exposed: true });
    }
  }
  const records = [...entries.values()].sort((a, b) => a.key.localeCompare(b.key));
  return { version: 'detect-dataset-registry-v1', records, digest: sha(JSON.stringify(records)) };
}
function nearDuplicateLinks(rows, { minChars = 100, similarity = .85 } = {}) {
  // Lexical screening only. A semantic review may supply explicit relatedFamilyIds.
  const sets = rows.map(r => {
    const s = r.text.normalize('NFC').replace(/\s+/gu, ' ').trim();
    return s.length < minChars ? null : new Set(Array.from({ length: s.length - 4 }, (_, i) => s.slice(i, i + 5)));
  });
  const inverted = new Map(), candidates = new Set(), links = [];
  sets.forEach((set, i) => {
    if (!set) return;
    // Bottom-32 hashes give bounded candidate generation without a quadratic text scan.
    const anchors = [...set].map(s => sha(s).slice(0, 16)).sort().slice(0, 32);
    for (const anchor of anchors) {
      for (const prior of inverted.get(anchor) || []) candidates.add(prior + ':' + i);
      if (!inverted.has(anchor)) inverted.set(anchor, []); inverted.get(anchor).push(i);
    }
  });
  for (const pair of candidates) {
    const [i, j] = pair.split(':').map(Number), a = sets[i], b = sets[j];
    let overlap = 0; for (const token of a) if (b.has(token)) overlap++;
    const containment = overlap / Math.min(a.size, b.size), jaccard = overlap / (a.size + b.size - overlap);
    if (jaccard >= similarity || containment >= .95) links.push({ left: rows[i].id, right: rows[j].id, jaccard, containment });
  }
  return { method: 'character_5gram_lexical_screen', candidatePairs: candidates.size, links,
    limitation: 'Not exhaustive semantic deduplication. Missed candidate pairs and paraphrases remain possible.' };
}
function buildResearchManifest(rows, { seed, registry, priorManifests = [], developmentFraction = .6, holdoutBy = [], screenNearDuplicates = true } = {}) {
  if (registry && sha(JSON.stringify(registry.records)) !== registry.digest) throw Error('dataset_registry_changed');
  if (holdoutBy.some(k => !['authorGroup', 'siteGroup', 'templateGroup'].includes(k))) throw Error('dataset_invalid_holdout_dimension');
  const exposed = new Set((registry || buildRegistry(priorManifests)).records.map(r => r.key));
  const metadata = new Map(rows.map(r => [r.id, { ...processMetadata(r), lineageKeys: familyKeys(r) }]));
  const nearDuplicates = screenNearDuplicates ? nearDuplicateLinks(rows) : { method: 'not_run', links: [] };
  const parent = new Map(rows.map(r => [r.id, r.id]));
  const find = id => { if (!parent.has(id)) throw Error('dataset_missing_related_document'); if (parent.get(id) !== id) parent.set(id, find(parent.get(id))); return parent.get(id); };
  const join = (a, b) => parent.set(find(b), find(a));
  const seen = new Map();
  for (const r of rows) {
    const m = metadata.get(r.id);
    for (const key of [...m.lineageKeys, ...holdoutBy.flatMap(k => m[k] ? [k + ':' + m[k]] : [])]) {
      if (seen.has(key)) join(r.id, seen.get(key)); else seen.set(key, r.id);
    }
    if (r.parentId) join(r.id, r.parentId);
  }
  for (const link of nearDuplicates.links) join(link.left, link.right);
  const components = new Map();
  for (const r of rows) { const g = find(r.id); if (!components.has(g)) components.set(g, []); components.get(g).push(r); }
  const enriched = [];
  for (const members of components.values()) {
    const keys = [...new Set(members.flatMap(r => metadata.get(r.id).lineageKeys))].sort();
    const isExposed = members.some(r => r.priorExposure || metadata.get(r.id).lineageKeys.some(k => exposed.has(k)));
    const group = sha(keys.join('\0'));
    for (const r of members) enriched.push({ ...r, group, topicGroup: group, priorExposure: isExposed });
  }
  const manifest = buildManifest(enriched, { seed, developmentFraction });
  // Store stable aliases, not merely a hash of this manifest's member IDs.
  for (const r of manifest.records) Object.assign(r, metadata.get(r.id), { familyId: nullable(rows.find(s => s.id === r.id).familyId) });
  manifest.digest = sha(JSON.stringify(manifest.records));
  manifest.researchVersion = 'detect-intake-v2'; manifest.holdoutBy = holdoutBy;
  manifest.nearDuplicates = nearDuplicates;
  manifest.processCoverage = Object.fromEntries([...new Set(manifest.records.map(r => r.genre))].map(genre => [genre, {
    humanOriginal: manifest.records.filter(r => r.genre === genre && r.writingProcess === 'human_original').length,
    unknownHuman: manifest.records.filter(r => r.genre === genre && r.authorship === 'human_reference' && r.writingProcess === 'unknown').length
  }]));
  return manifest;
}
function assertNoTrainingLeakage(candidate, records) {
  const keys = new Set(candidate.trainingLineageKeys || []), hashes = new Set(candidate.trainingTextHashes || []);
  for (const r of records) if (hashes.has(r.normalizedSha256) || (r.lineageKeys || []).some(k => keys.has(k)) || (candidate.trainingGroups || []).includes(r.group)) throw Error('evaluation_training_leakage');
}
module.exports = { PROCESSES, processMetadata, familyKeys, buildRegistry, nearDuplicateLinks, buildResearchManifest, assertNoTrainingLeakage };
