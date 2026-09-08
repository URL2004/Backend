'use strict';

// Offline intake only. This module imports no provider, database or production route.
const fs = require('node:fs');
const path = require('node:path');
const { sha, normalizedHash, lengthBucket } = require('./detectBenchmark');
const { buildRegistry, assertNoTrainingLeakage } = require('./detectDatasetRegistry');
const { makeBlindPair, verifyQuality, DIMENSIONS, FIDELITY, numberAudit } = require('./humanizeQualityEvaluation');
const VERSION = 'engine-corpus-v1';
const SCHEMAS = new Set(['inputText->outputText', 'originalText->humanizedText', 'original->humanized',
  'input->output', 'sourceText->resultText', 'sourceText->outputText', 'sourceText->previousOutputText',
  'inputText->gptText', '원문->휴머나이징된글', '원문->휴머나이징결과', '원문->휴머나이징',
  'originalText->outputText', 'text->humanizedText']);
// Python's Unicode whitespace excludes U+FEFF; JavaScript \s/trim would silently
// remove embedded BOMs and disagree with the already audited corpus hashes.
const normalize = text => text.normalize('NFKC').replace(/[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu, ' ').replace(/^ +| +$/gu, '');
const corpusHash = text => sha(normalize(text));
const hashPattern = /^[a-f0-9]{64}$/u;
const canonical = x => JSON.stringify(x);
const seal = body => ({ ...body, digest: sha(canonical(body)) });
function verifySeal(value) {
  const { digest, ...body } = value || {};
  if (digest !== sha(canonical(body))) throw Error('corpus_manifest_changed');
  return true;
}
function inside(root, child) { const rel = path.relative(root, child); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); }
function realDestination(file) {
  let cursor = path.resolve(file), tail = [];
  while (!fs.existsSync(cursor)) { tail.unshift(path.basename(cursor)); const next = path.dirname(cursor); if (next === cursor) throw Error('corpus_invalid_path'); cursor = next; }
  return path.join(fs.realpathSync(cursor), ...tail);
}
function assertExternalOutput(output, repositoryRoots) {
  const target = realDestination(output);
  if (repositoryRoots.some(root => inside(realDestination(root), target))) throw Error('corpus_output_inside_repository');
  return target;
}
function sourcePath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw Error('corpus_source_path_invalid');
  const base = fs.realpathSync(root), full = fs.realpathSync(path.resolve(base, relative));
  if (!inside(base, full)) throw Error('corpus_source_path_escape');
  return full;
}
function fileSignature(buffer, name = '') {
  if (path.basename(name).startsWith('~$')) return { format: 'office_lock', exclude: 'office_temporary_lock_file' };
  if (buffer.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) return { format: 'ole' };
  const start = buffer.subarray(0, 256).toString('utf8').replace(/^\uFEFF/u, '').trimStart();
  if (start.startsWith('{\\rtf')) return { format: 'rtf' };
  if (/^(?:<!doctype\s+html|<html)/iu.test(start)) return { format: 'html' };
  if (start.startsWith('%PDF-')) return { format: 'pdf' };
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return { format: 'zip_container' };
  return { format: 'text_or_unknown' };
}
function decode(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return Buffer.from(buffer.subarray(2)).swap16().toString('utf16le');
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/u, '');
}
function parseDelimited(text, delimiter = ',') {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && (quoted || cell === '')) {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && (c === delimiter || c === '\r' || c === '\n')) {
      row.push(cell); cell = '';
      if (c !== delimiter) { rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
    } else cell += c;
  }
  if (quoted) throw Error('corpus_unterminated_csv_quote');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const header = rows.shift();
  if (!header?.length || new Set(header).size !== header.length || header.some(k => !k)) throw Error('corpus_invalid_csv_header');
  return rows.filter(r => r.length > 1 || r[0]).map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}
function readStructured(file) {
  const buffer = fs.readFileSync(file), sig = fileSignature(buffer, file);
  if (sig.exclude) throw Error('corpus_office_lock_excluded');
  const text = decode(buffer), ext = path.extname(file).toLowerCase();
  if (ext === '.json') { try { return JSON.parse(text); } catch { throw Error('corpus_json_parse_failed'); } }
  if (ext === '.csv' || ext === '.tsv') return parseDelimited(text, ext === '.tsv' ? '\t' : ',');
  throw Error('corpus_unsupported_structured_format');
}
function atLocator(value, locator) {
  if (typeof locator !== 'string' || !/^\$(?:(?:\.[^.[\]]+)|(?:\[\d+\]))*$/u.test(locator)) throw Error('corpus_invalid_locator');
  for (const match of locator.slice(1).matchAll(/\.([^.[\]]+)|\[(\d+)\]/gu)) {
    const key = match[1] ?? Number(match[2]);
    if (!value || !Object.hasOwn(value, key)) throw Error('corpus_missing_locator');
    value = value[key];
  }
  return value;
}
function scalar(value) {
  if (typeof value === 'string') return value;
  for (const key of ['text', 'outputText', 'finalText', 'humanizedText']) if (typeof value?.[key] === 'string') return value[key];
  throw Error('corpus_missing_pair_text');
}
function readOccurrence(row, cache, root) {
  if (!SCHEMAS.has(row.schema)) throw Error('corpus_unknown_pair_schema');
  if (!cache.has(row.file)) cache.set(row.file, readStructured(sourcePath(root, row.file)));
  const object = atLocator(cache.get(row.file), row.locator), [a, b] = row.schema.split('->');
  const original = scalar(object[a]), transformed = scalar(object[b]);
  if (!original.trim() || !transformed.trim() || corpusHash(original) !== row.original_hash || corpusHash(transformed) !== row.humanized_hash) throw Error('corpus_source_hash_mismatch');
  return { original, transformed };
}
function buildCorpus(occurrences, { root, seed = 'engine-corpus-v1', externalLinks = [], operationalRows = [], priorManifests = [], reviewSampleSize = 120 } = {}) {
  if (!Array.isArray(occurrences) || !occurrences.length || typeof seed !== 'string' || !seed.trim() || !Number.isInteger(reviewSampleSize) || reviewSampleSize < 0 || reviewSampleSize > 1000) throw Error('corpus_invalid_input');
  const cache = new Map(), docs = new Map(), pairs = new Map(), parent = new Map();
  const find = x => { if (!parent.has(x)) parent.set(x, x); if (parent.get(x) !== x) parent.set(x, find(parent.get(x))); return parent.get(x); };
  const join = (a, b) => { const aa = find(a), bb = find(b); if (aa !== bb) parent.set(bb, aa); };
  for (const row of occurrences) {
    const text = readOccurrence(row, cache, root), a = row.original_hash, b = row.humanized_hash;
    for (const [h, role, body] of [[a, 'original', text.original], [b, 'humanized', text.transformed]]) {
      if (!hashPattern.test(h)) throw Error('corpus_invalid_hash');
      if (!docs.has(h)) docs.set(h, { id: 'text-' + h, corpusNormalizedSha256: h, text: body, roles: new Set(), rawHashes: new Set(), nfcHashes: new Set() });
      const d = docs.get(h); d.roles.add(role); d.rawHashes.add(sha(body)); d.nfcHashes.add(normalizedHash(body));
    }
    join(a, b); const id = 'pair-' + sha(a + '\0' + b);
    if (!pairs.has(id)) pairs.set(id, { id, originalId: 'text-' + a, transformedId: 'text-' + b, occurrences: [], externalEvidence: [] });
    pairs.get(id).occurrences.push({ sourceFile: row.file, locator: row.locator, schema: row.schema,
      mode: typeof row.mode === 'string' ? row.mode : null, genre: typeof row.genre === 'string' ? row.genre : null,
      engineVersion: typeof row.engine === 'string' ? row.engine : null });
  }
  const components = new Map();
  for (const hash of docs.keys()) { const key = find(hash); if (!components.has(key)) components.set(key, []); components.get(key).push(hash); }
  const groupIds = new Map([...components].map(([key, hashes]) => [key, 'family-' + sha(hashes.sort().join('\0'))]));
  const documents = [...docs.values()].map(d => ({ id: d.id, group: groupIds.get(find(d.corpusNormalizedSha256)),
    corpusNormalizedSha256: d.corpusNormalizedSha256, normalizedSha256: normalizedHash(d.text), rawSha256: sha(d.text),
    rawVariants: [...d.rawHashes].sort(), nfcVariants: [...d.nfcHashes].sort(), roles: [...d.roles].sort(),
    writingProcess: d.roles.has('humanized') ? 'humanized_origin_unknown' : 'unknown',
    authorship: 'unknown', labelQuality: 'unverified_origin', authorshipGoldEligible: false,
      transformationObserved: d.roles.has('humanized'), chars: Array.from(normalize(d.text)).length, lengthBucket: lengthBucket(Array.from(normalize(d.text)).length),
    split: 'development', priorExposure: true, exposureReason: 'previous_local_audit_and_engine_development',
    permissions: { localReview: true, train: false, evaluate: false, derive: false, externalTransmit: false },
    permissionBasis: 'authorized_local_audit_only_not_new_model_training_or_provider_evaluation',
    lineageKeys: [...new Set([d.corpusNormalizedSha256, ...d.nfcHashes].map(h => 'text:' + h))].sort() })).sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(documents.map(d => [d.id, d]));
  const external = [];
  for (const link of externalLinks) {
    const match = /^(\d{4})_(\d{8}-\d{2})$/u.exec(link.pair_key || '');
    if (!match || !Number.isFinite(link.orig) || !Number.isFinite(link.human) || [link.orig, link.human].some(s => s < 0 || s > 100)) throw Error('corpus_external_link_invalid');
    const source = operationalRows[Number(match[1]) - 1];
    if (!source || !Number.isFinite(source.createdAtMs)) throw Error('corpus_external_source_missing');
    const iso = new Date(source.createdAtMs + 9 * 3600000).toISOString();
    const stamp = iso.slice(5, 10).replace('-', '') + iso.slice(11, 16).replace(':', '') + '-' + iso.slice(17, 19);
    if (stamp !== match[2]) throw Error('corpus_external_time_mismatch');
    const id = 'pair-' + sha(corpusHash(source.inputText) + '\0' + corpusHash(source.outputText));
    if (!pairs.has(id)) throw Error('corpus_external_pair_not_in_manifest');
    for (const file of [link.original_pdf, link.humanized_pdf]) {
      const resolved = sourcePath(root, file);
      if (fileSignature(fs.readFileSync(resolved).subarray(0, 256), resolved).format !== 'pdf') throw Error('corpus_external_pdf_signature_invalid');
    }
    for (const file of [...(link.original_source_files || []), ...(link.humanized_source_files || [])]) sourcePath(root, file);
    if (!link.original_source_files?.length || !link.humanized_source_files?.length) throw Error('corpus_external_source_file_missing');
    const evidence = { id: 'ck-' + link.pair_key, pairId: id, detector: 'copykiller', metric: 'AI작성률',
      originalAIWritingRate: link.orig, transformedAIWritingRate: link.human, plagiarismRate: null,
      detectorVersion: null, checkedAt: null, sourcePDFs: [link.original_pdf, link.humanized_pdf],
      linkEvidence: 'pdf_first_page_role_sequence_timestamp_and_source_file_existence', bodyExactMatchVerified: false,
      authorshipGoldEligible: false };
    if (external.some(e => e.id === evidence.id)) throw Error('corpus_duplicate_external_evidence');
    external.push(evidence); pairs.get(id).externalEvidence.push(evidence.id);
  }
  const pairRecords = [...pairs.values()].map(p => ({ ...p, group: byId.get(p.originalId).group,
    split: 'development', priorExposure: true, detectorScores: { beforeEngineScore: null, afterEngineScore: null, beforeDisplayScore: null, afterDisplayScore: null },
    qualityGoldStatus: 'pending_human_review' })).sort((a, b) => a.id.localeCompare(b.id));
  const manifest = seal({ version: VERSION, normalization: 'NFKC_python_compatible_whitespace', charCountUnit: 'unicode_code_points', seed, documents, pairs: pairRecords,
    externalEvidence: external, authorshipGoldCount: 0, freshHoldoutCount: 0,
    limitation: 'Exact text linkage only; no exhaustive semantic/author/template deduplication and no authenticated original authorship.' });
  // Existing registry readers use digest(records), not our whole-manifest digest.
  const exposureRecords = documents.map(d => ({ id: d.id, normalizedSha256: d.normalizedSha256, group: d.group,
    source: 'local-engine-corpus', sourceGroup: d.group, lineageKeys: d.lineageKeys, split: 'development', priorExposure: true }));
  const exposureManifest = { version: 'engine-corpus-exposure-v1', records: exposureRecords, digest: sha(canonical(exposureRecords)) };
  const registry = buildRegistry([...priorManifests, exposureManifest]);
  const texts = Object.fromEntries([...docs.values()].map(d => [d.id, d.text]));
  const review = makeReviewForms(manifest, texts, { sampleSize: reviewSampleSize, seed });
  return { manifest, texts, exposureManifest, registry, ...review };
}
function makeReviewForms(manifest, texts, { sampleSize = 120, seed = 'engine-corpus-v1' } = {}) {
  // A deterministic family-level sample, without looking at any detector score.
  const seen = new Set(), selected = [];
  for (const p of [...manifest.pairs].sort((a, b) => sha(seed + a.id).localeCompare(sha(seed + b.id)))) {
    if (selected.length >= sampleSize) break;
    if (seen.has(p.group)) continue; seen.add(p.group); selected.push(p);
  }
  const reviewForms = [], reviewKeys = [], evidenceForms = [];
  for (const p of selected) {
    const item = { id: p.id, original: texts[p.originalId], transformed: texts[p.transformedId], genre: 'unknown' };
    const blind = makeBlindPair(item, seed);
    reviewForms.push({ reviewId: 'review-' + sha(seed + p.id), manifestDigest: manifest.digest, A: blind.request.A, B: blind.request.B,
      task: 'Judge writing quality only; authorship is not visible or a target.',
      reviewers: [1, 2].map(slot => ({ slot, reviewerId: null, status: 'pending', dimensions: DIMENSIONS.map(dimension => ({ dimension, winner: null, quoteA: '', quoteB: '', reason: '' })) })) });
    reviewKeys.push({ reviewId: reviewForms.at(-1).reviewId, manifestDigest: manifest.digest, pairId: p.id, ...blind.key });
    evidenceForms.push({ pairId: p.id, manifestDigest: manifest.digest, originalId: p.originalId, transformedId: p.transformedId, status: 'pending',
      requiredReviewers: 2, reviewers: [null, null], lexicalNumberAudit: numberAudit(item.original, item.transformed),
      dimensions: [...FIDELITY, 'agent_patient_relation', 'negation', 'modality', 'quantity_range', 'causality'].map(dimension => ({ dimension, verdict: null, originalSpan: null, transformedSpan: null,
        reviewerVerdicts: [1, 2].map(() => ({ reviewerId: null, verdict: null })) })),
      spanContract: 'UTF-16 start/end offsets plus exact quote; a missing span is null, not invented evidence. A lexical check is not a gold verdict.' });
  }
  return { reviewForms, reviewKeys, evidenceForms };
}
function validateSpan(text, span) {
  if (span === null) return;
  if (!span || !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > text.length || typeof span.quote !== 'string' || text.slice(span.start, span.end) !== span.quote) throw Error('corpus_ungrounded_span');
}
function evaluateCorpus(manifest, { scoreRows = [], evidenceReviews = [], qualityReviews = [], texts = {}, candidate = null } = {}) {
  verifySeal(manifest);
  if (manifest.version !== VERSION || manifest.authorshipGoldCount !== 0 || manifest.freshHoldoutCount !== 0
    || manifest.documents.some(d => d.split !== 'development' || d.priorExposure !== true || d.authorship !== 'unknown' || d.authorshipGoldEligible
      || d.permissions.train || d.permissions.evaluate || d.permissions.derive || d.permissions.externalTransmit
      || !d.permissions.localReview || !Array.isArray(d.roles) || d.roles.some(role => !['original', 'humanized'].includes(role))
      || d.writingProcess !== (d.roles.includes('humanized') ? 'humanized_origin_unknown' : 'unknown'))) throw Error('corpus_invalid_legacy_label_or_permission');
  const pairMap = new Map(manifest.pairs.map(p => [p.id, p])), docMap = new Map(manifest.documents.map(d => [d.id, d]));
  if (pairMap.size !== manifest.pairs.length || docMap.size !== manifest.documents.length) throw Error('corpus_duplicate_manifest_id');
  for (const p of manifest.pairs) {
    const a = docMap.get(p.originalId), b = docMap.get(p.transformedId);
    if (!a || !b || p.id !== 'pair-' + sha(a.corpusNormalizedSha256 + '\0' + b.corpusNormalizedSha256)
      || p.group !== a.group || p.group !== b.group || p.split !== 'development' || p.priorExposure !== true) throw Error('corpus_pair_lineage_changed');
  }
  for (const e of manifest.externalEvidence) if (!pairMap.has(e.pairId) || e.metric !== 'AI작성률' || e.authorshipGoldEligible !== false || e.bodyExactMatchVerified !== false
    || e.plagiarismRate !== null || [e.originalAIWritingRate, e.transformedAIWritingRate].some(s => !Number.isFinite(s) || s < 0 || s > 100)) throw Error('corpus_external_metric_changed');
  const scoreKeys = ['beforeEngineScore', 'afterEngineScore', 'beforeDisplayScore', 'afterDisplayScore'];
  const scored = new Set(), sums = Object.fromEntries(scoreKeys.map(k => [k, 0]));
  for (const r of scoreRows) {
    if (!pairMap.has(r.pairId) || scored.has(r.pairId)) throw Error('corpus_duplicate_or_unknown_score');
    if (r.manifestDigest !== manifest.digest || !r.detectorVersion || typeof r.historyCalibrationApplied !== 'boolean') throw Error('corpus_score_provenance_missing');
    for (const key of scoreKeys) {
      if (!(r[key] === null || Number.isFinite(r[key]) && r[key] >= 0 && r[key] <= 100)) throw Error('corpus_invalid_score');
    }
    if (scoreKeys.some(k => r[k] === null)) throw Error('corpus_incomplete_score_pair');
    scored.add(r.pairId); for (const k of scoreKeys) sums[k] += r[k];
  }
  let acceptedGold = 0, evidenceDisagreement = 0; const reviewed = new Set();
  for (const r of evidenceReviews) {
    const p = pairMap.get(r.pairId);
    if (!p || reviewed.has(r.pairId) || r.manifestDigest !== manifest.digest) throw Error('corpus_invalid_evidence_review');
    reviewed.add(r.pairId);
    if (!Array.isArray(r.reviewers) || new Set(r.reviewers.filter(v => typeof v === 'string' && v.trim())).size < 2) throw Error('corpus_independent_reviewers_required');
    const dimensions = [...FIDELITY, 'agent_patient_relation', 'negation', 'modality', 'quantity_range', 'causality'];
    if (!Array.isArray(r.dimensions) || r.dimensions.length !== dimensions.length || new Set(r.dimensions.map(d => d.dimension)).size !== dimensions.length) throw Error('corpus_invalid_review_dimensions');
    for (const d of r.dimensions) {
      if (!dimensions.includes(d.dimension) || !['preserved', 'changed', 'uncertain'].includes(d.verdict)) throw Error('corpus_invalid_gold_verdict');
      if (!Array.isArray(d.reviewerVerdicts) || d.reviewerVerdicts.length !== r.reviewers.length
        || new Set(d.reviewerVerdicts.map(v => v.reviewerId)).size !== r.reviewers.length
        || d.reviewerVerdicts.some(v => !r.reviewers.includes(v.reviewerId) || !['preserved', 'changed', 'uncertain'].includes(v.verdict))) throw Error('corpus_review_decisions_missing');
      const agreement = d.reviewerVerdicts.every(v => v.verdict === d.reviewerVerdicts[0].verdict);
      if (d.verdict !== (agreement ? d.reviewerVerdicts[0].verdict : 'uncertain')) throw Error('corpus_review_disagreement_hidden');
      for (const [id, span] of [[p.originalId, d.originalSpan], [p.transformedId, d.transformedSpan]]) {
        if (typeof texts[id] !== 'string' || corpusHash(texts[id]) !== docMap.get(id).corpusNormalizedSha256) throw Error('corpus_review_text_changed');
        validateSpan(texts[id], span);
      }
      if (d.verdict !== 'preserved' && d.originalSpan === null && d.transformedSpan === null) throw Error('corpus_changed_review_missing_evidence');
    }
    if (r.dimensions.every(d => d.verdict !== 'uncertain')) acceptedGold++; else evidenceDisagreement++;
  }
  const qualitySeen = new Set(), qualityTotals = Object.fromEntries(DIMENSIONS.map(k => [k, { improved: 0, worsened: 0, tie: 0, reviewerDisagreement: 0 }]));
  for (const r of qualityReviews) {
    const p = pairMap.get(r.pairId);
    if (!p || qualitySeen.has(r.pairId) || r.manifestDigest !== manifest.digest) throw Error('corpus_invalid_quality_review');
    qualitySeen.add(r.pairId);
    if (!Array.isArray(r.reviewers) || r.reviewers.length !== 2 || r.reviewers.some(v => typeof v.reviewerId !== 'string' || !v.reviewerId.trim()) || new Set(r.reviewers.map(v => v.reviewerId)).size !== 2) throw Error('corpus_independent_reviewers_required');
    for (const id of [p.originalId, p.transformedId]) if (typeof texts[id] !== 'string' || corpusHash(texts[id]) !== docMap.get(id).corpusNormalizedSha256) throw Error('corpus_review_text_changed');
    const pair = makeBlindPair({ id: p.id, original: texts[p.originalId], transformed: texts[p.transformedId], genre: 'unknown' }, manifest.seed);
    const judgments = r.reviewers.map(v => verifyQuality({ dimensions: v.dimensions }, pair));
    for (const dimension of DIMENSIONS) {
      const a = judgments[0].dimensions[dimension], b = judgments[1].dimensions[dimension];
      qualityTotals[dimension][a === b ? a : 'reviewerDisagreement']++;
    }
  }
  let leakage = { checked: false, reason: 'candidate_not_supplied' };
  if (candidate) {
    if (![candidate.trainingTextHashes, candidate.trainingLineageKeys, candidate.trainingGroups].some(v => Array.isArray(v) && v.length)) throw Error('corpus_candidate_lineage_missing');
    try { assertNoTrainingLeakage(candidate, manifest.documents); leakage = { checked: true, overlaps: false }; }
    catch (error) { if (error.message !== 'evaluation_training_leakage') throw error; leakage = { checked: true, overlaps: true, reason: error.message }; }
  }
  const count = key => Object.fromEntries([...new Set(manifest.documents.map(d => d[key]))].map(v => [v, manifest.documents.filter(d => d[key] === v).length]));
  return { version: 'engine-corpus-dashboard-v1', manifestDigest: manifest.digest, pairs: manifest.pairs.length,
    documents: manifest.documents.length, families: new Set(manifest.documents.map(d => d.group)).size,
    externalEvidence: manifest.externalEvidence.length, externalMetrics: { AIWritingRate: manifest.externalEvidence.length, plagiarismRate: manifest.externalEvidence.filter(e => e.plagiarismRate !== null).length },
    byProcess: count('writingProcess'), byLength: count('lengthBucket'), authorshipGold: 0, freshHoldout: 0,
    evidenceGold: { reviewed: evidenceReviews.length, adjudicated: acceptedGold, uncertainOrDisagreement: evidenceDisagreement, remainingPairs: manifest.pairs.length - acceptedGold },
    qualityReview: { pairs: qualityReviews.length, dimensions: qualityTotals, reviewerType: 'independent_humans_declared_not_identity_authenticated' },
    scores: { pairs: scored.size, means: Object.fromEntries(scoreKeys.map(k => [k, scored.size ? sums[k] / scored.size : null])),
      engineDelta: scored.size ? (sums.afterEngineScore - sums.beforeEngineScore) / scored.size : null,
      displayDelta: scored.size ? (sums.afterDisplayScore - sums.beforeDisplayScore) / scored.size : null },
    leakage, releaseEligible: false,
    blockers: ['historical_exposed_corpus_development_only', 'original_authorship_unverified', 'independent_core_genre_holdout_required'],
    note: 'Gold evidence concerns content relationships, not authorship. External AI rates and calibrated display changes are separate from detector accuracy.' };
}
module.exports = { VERSION, SCHEMAS, normalize, corpusHash, seal, verifySeal, fileSignature, decode, parseDelimited,
  sourcePath, readStructured, atLocator, assertExternalOutput, buildCorpus, makeReviewForms, validateSpan, evaluateCorpus };
