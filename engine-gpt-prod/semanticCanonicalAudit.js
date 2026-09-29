'use strict';

// Canonical semantic-audit representation.
//
// The editing pipeline works on a FROZEN text: locked structure blocks
// (headings, bullet prefixes, quotes, tables...) are ZXQLOCKnnnnQXZ tokens and
// inline code / math are ZXQCODE / ZXQMATH tokens. The final semantic audit
// judges the raw text. Earlier audits used to judge the frozen text, so their
// judge never saw heading/prefix context, and their findings, obligations and
// receipts lived in a different representation from the final audit.
//
// This module lets an earlier audit judge the EXACT deterministic
// materialization of the frozen pair. The remaining pipeline then gets back a
// frozen view through a verified, reversible map. Nothing here calls a model
// or decides a verdict. Every inexact case returns ok:false, so the caller
// runs the existing frozen audit unchanged. A judged repair that cannot be
// refrozen exactly fails closed and never becomes a pass.

const semanticProvenance = require('./semanticProvenance');

const VERSION = 'semantic-canonical-audit-v1';
const TOKEN_RE = /ZXQ(?:LOCK|MATH|CODE)\d{4}QXZ/gu;
const TOKEN_EXACT_RE = /^ZXQ(?:LOCK|MATH|CODE)\d{4}QXZ$/u;
// Any fragment of the token alphabet makes the text ambiguous with tokens.
const TOKENISH_RE = /ZXQ|QXZ/u;
const MAX_DEPTH = 3;

const fail = reason => ({ ok: false, reason });
const tokensOf = text => String(text || '').match(TOKEN_RE) || [];
const sameList = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);

function countOccurrences(text, needle) {
  if (!needle) return Infinity;
  let count = 0;
  for (let index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + 1)) count += 1;
  return count;
}

function buildMap({ lockedBlocks, mathBlocks, codeBlocks }) {
  const map = new Map();
  for (const block of [...(lockedBlocks || []), ...(mathBlocks || []), ...(codeBlocks || [])]) {
    if (!block || typeof block.token !== 'string' || typeof block.value !== 'string') return null;
    if (!TOKEN_EXACT_RE.test(block.token) || !block.value) return null;
    if (map.has(block.token) && map.get(block.token) !== block.value) return null;
    map.set(block.token, block.value);
  }
  return map;
}

// Strict expansion: split/join (never String.replace patterns), every token
// at most once across the whole recursive expansion, no unknown token, no
// token-alphabet residue.
function expandWith(map, text) {
  const used = new Set();
  const expand = (value, depth) => {
    if (depth > MAX_DEPTH) throw new Error('canonical_depth_exceeded');
    const parts = String(value).split(TOKEN_RE);
    const tokens = tokensOf(value);
    let out = parts[0];
    tokens.forEach((token, index) => {
      if (!map.has(token)) throw new Error('canonical_unknown_token');
      if (used.has(token)) throw new Error('canonical_duplicate_token');
      used.add(token);
      out += expand(map.get(token), depth + 1) + parts[index + 1];
    });
    return out;
  };
  try {
    const text2 = expand(String(text || ''), 0);
    if (TOKENISH_RE.test(text2)) return fail('canonical_token_residue');
    return { ok: true, text: text2 };
  } catch (error) {
    return fail(error.message.startsWith('canonical_') ? error.message : 'canonical_materialize_failed');
  }
}

const atLineStart = (text, index) => index === 0 || text[index - 1] === '\n';
const atLineEnd = (text, index) => index === text.length || text[index] === '\n' || text[index] === '\r';

function refreezeWith(map, canonicalText, frozenTemplate, { scan = false } = {}) {
  const text = String(canonicalText ?? '');
  const template = String(frozenTemplate ?? '');
  const templateTokens = tokensOf(template);
  if (new Set(templateTokens).size !== templateTokens.length) return fail('canonical_template_duplicate_token');
  const materializedTemplate = expandWith(map, template);
  if (!materializedTemplate.ok) return materializedTemplate;
  // Unchanged judged text: the template itself is the exact frozen form
  // (its positional exactness was proven by a scan when it was prepared).
  if (!scan && text === materializedTemplate.text) return { ok: true, text: template };
  if (TOKENISH_RE.test(text)) return fail('canonical_token_like_text');
  // Expected literal slots in template order, with their line anchoring.
  const slots = [];
  {
    const parts = template.split(TOKEN_RE);
    let cursor = parts[0].length;
    templateTokens.forEach((token, index) => {
      const value = expandWith(map, token);
      if (!value.ok) throw new Error(value.reason);
      slots.push({
        token,
        value: value.text,
        lineStart: atLineStart(template, cursor),
        lineEnd: atLineEnd(template, cursor + token.length)
      });
      cursor += token.length + parts[index + 1].length;
    });
  }
  // Strict uniqueness: every top-level literal value is distinct and occurs
  // exactly once in the text (occurrences inside other text count too), so
  // an added, removed, repeated or embedded copy makes the map inexact.
  // Identical literals (e.g. the same inline code twice) are never assigned
  // by guesswork; the caller keeps the existing frozen audit.
  if (new Set(slots.map(slot => slot.value)).size !== slots.length) return fail('canonical_literal_not_unique');
  const occurrences = [];
  for (const { value } of slots) {
    if (countOccurrences(text, value) !== 1) return fail('canonical_literal_count_changed');
    const start = text.indexOf(value);
    occurrences.push({ start, end: start + value.length, value });
  }
  occurrences.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < occurrences.length; index += 1) {
    if (occurrences[index].start < occurrences[index - 1].end) return fail('canonical_literal_overlap');
  }
  if (!sameList(occurrences.map(item => item.value), slots.map(slot => slot.value))) {
    return fail('canonical_literal_order_changed');
  }
  let out = '';
  let cursor = 0;
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    const hit = occurrences[index];
    if (slot.lineStart !== atLineStart(text, hit.start) || slot.lineEnd !== atLineEnd(text, hit.end)) {
      return fail('canonical_literal_anchor_changed');
    }
    out += text.slice(cursor, hit.start) + slot.token;
    cursor = hit.end;
  }
  out += text.slice(cursor);
  const back = expandWith(map, out);
  if (!back.ok || back.text !== text) return fail('canonical_roundtrip_mismatch');
  if (!sameList(tokensOf(out), templateTokens)) return fail('canonical_token_sequence_changed');
  return { ok: true, text: out };
}

function createCanonicalAudit({ rawSource, frozenSource, lockedBlocks = [], mathBlocks = [], codeBlocks = [] } = {}) {
  const raw = String(rawSource ?? '');
  const frozen = String(frozenSource ?? '');
  const map = buildMap({ lockedBlocks, mathBlocks, codeBlocks });
  const unavailable = reason => ({
    ok: false,
    reason,
    canonicalSource: '',
    materialize: () => fail(reason),
    refreeze: () => fail(reason)
  });
  if (!map) return unavailable('canonical_map_invalid');
  if (!tokensOf(frozen).length) return unavailable('canonical_no_frozen_literals');
  if (TOKENISH_RE.test(raw)) return unavailable('canonical_raw_token_like_text');
  const materialize = text => expandWith(map, text);
  const refreeze = (canonicalText, frozenTemplate, options) => {
    try {
      return refreezeWith(map, canonicalText, frozenTemplate, options);
    } catch (error) {
      return fail(String(error?.message || '').startsWith('canonical_') ? error.message : 'canonical_refreeze_failed');
    }
  };
  const source = materialize(frozen);
  if (!source.ok) return unavailable(source.reason);
  if (source.text !== raw) return unavailable('canonical_source_mismatch');
  // Prove the positional assignment reproduces the pipeline's own freeze
  // (a prefix/heading value that also occurs in prose fails here).
  const back = refreeze(raw, frozen, { scan: true });
  if (!back.ok) return unavailable(back.reason || 'canonical_source_refreeze_mismatch');
  if (back.text !== frozen) return unavailable('canonical_source_refreeze_mismatch');
  return { ok: true, reason: '', canonicalSource: raw, frozenSource: frozen, materialize, refreeze };
}

// Prepare one audit input pair. The candidate must carry exactly the
// source's top-level token sequence, and its materialization must refreeze
// back to the identical frozen candidate by the positional rules.
function prepareCandidate(canonical, frozenSource, frozenCandidate) {
  if (!canonical?.ok) return fail(canonical?.reason || 'canonical_unavailable');
  if (String(frozenSource ?? '') !== canonical.frozenSource) return fail('canonical_source_not_bound');
  const candidate = String(frozenCandidate ?? '');
  if (!sameList(tokensOf(candidate), tokensOf(canonical.frozenSource))) return fail('canonical_candidate_token_sequence');
  const materialized = canonical.materialize(candidate);
  if (!materialized.ok) return materialized;
  const probe = canonical.refreeze(materialized.text, candidate, { scan: true });
  if (!probe.ok || probe.text !== candidate) return fail(probe.reason || 'canonical_candidate_refreeze_mismatch');
  return { ok: true, frozenCandidate: candidate, canonicalCandidate: materialized.text };
}

function exactBinding(report, source, candidate) {
  const validation = report?.validation;
  return validation?.version === semanticProvenance.VERSION
    && validation.sourceDigest === semanticProvenance.textDigest(source)
    && validation.candidateDigest === semanticProvenance.textDigest(candidate);
}

// A judged verdict that cannot be mapped back exactly is never a pass. Keep
// every confirmed finding (initial AND residual), uncertainty, usage and
// section reports; drop only the validation that no longer binds this text.
function failClosedView(report, frozenCandidate, meta, reason) {
  const { validation: _dropped, ...rest } = report && typeof report === 'object' ? report : {};
  const seen = new Set();
  const violations = [...(rest.initialViolations || []), ...(rest.violations || [])].filter(item => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    ...rest,
    outputText: frozenCandidate,
    pass: false,
    repairRejected: true,
    repairRejectReasons: [...new Set([...(rest.repairRejectReasons || []), reason])],
    violations,
    reason,
    canonicalAudit: { ...meta, applied: true, frozenViewExact: false, reason }
  };
}

// Map a report judged on the canonical pair back to the frozen pipeline.
// Validation of the view is a deterministic re-binding of the SAME verdict to
// the proven-equivalent frozen pair; it records the judged raw digests as its
// parents. Findings and section offsets stay in the judged raw coordinates.
function frozenView(report, { canonical, frozenCandidate, canonicalCandidate } = {}) {
  const meta = {
    version: VERSION,
    coordinateSpace: 'canonical_raw',
    judgedSourceDigest: semanticProvenance.textDigest(canonical?.canonicalSource),
    judgedCandidateDigest: '',
    frozenCandidateDigest: ''
  };
  if (!report || typeof report !== 'object') return report;
  const judged = typeof report.outputText === 'string' ? report.outputText : canonicalCandidate;
  meta.judgedCandidateDigest = semanticProvenance.textDigest(judged);
  if (!exactBinding(report, canonical.canonicalSource, judged)) {
    return failClosedView(report, frozenCandidate, meta, 'canonical_provenance_mismatch');
  }
  const mapped = judged === canonicalCandidate
    ? { ok: true, text: frozenCandidate }
    : canonical.refreeze(judged, frozenCandidate);
  if (!mapped.ok) return failClosedView(report, frozenCandidate, meta, 'canonical_refreeze_failed');
  const back = canonical.materialize(mapped.text);
  if (!back.ok || back.text !== judged) return failClosedView(report, frozenCandidate, meta, 'canonical_refreeze_failed');
  const { validation, ...rest } = report;
  const checkedAt = Date.parse(validation.checkedAt);
  const bound = semanticProvenance.bindSemanticValidation({ ...rest, outputText: mapped.text },
    canonical.frozenSource, mapped.text, {
      model: validation.model,
      phase: 'canonical_refreeze',
      now: () => (Number.isFinite(checkedAt) ? checkedAt : Date.now())
    });
  if (bound.validation.status !== validation.status) {
    return failClosedView(report, frozenCandidate, meta, 'canonical_provenance_mismatch');
  }
  bound.validation.parentSourceDigest = validation.sourceDigest;
  bound.validation.parentCandidateDigest = validation.candidateDigest;
  bound.validation.parentPhase = String(validation.phase || '').slice(0, 80);
  bound.canonicalAudit = {
    ...meta,
    applied: true,
    frozenViewExact: true,
    reason: '',
    frozenCandidateDigest: semanticProvenance.textDigest(mapped.text)
  };
  return bound;
}

// Judge the exact canonical pair when available; otherwise run the existing
// frozen audit unchanged. Errors from runAudit propagate exactly as before.
async function runCanonicalSemanticAudit({ runAudit, options = {}, canonical, onPreparedCandidate } = {}) {
  let prepared = prepareCandidate(canonical, options.source, options.outputText);
  if (!prepared.ok) {
    const report = await runAudit(options);
    if (!report || typeof report !== 'object') return report;
    return { ...report, canonicalAudit: { version: VERSION, applied: false, reason: prepared.reason } };
  }
  let prepareCandidateText = typeof options.prepareCandidateText === 'function'
    ? options.prepareCandidateText : null;
  const formatted = prepareCandidateText
    ? await prepareCandidateText(canonical.canonicalSource, prepared.canonicalCandidate)
    : prepared.canonicalCandidate;
  const mapped = canonical.refreeze(formatted, prepared.frozenCandidate, { scan: true });
  if (mapped.ok) prepared = { ...prepared, frozenCandidate: mapped.text, canonicalCandidate: formatted };
  else prepareCandidateText = null;
  // Candidate adoption must compare against the SAME settled layout the judge
  // received. Otherwise added visual gaps look like new structure/style risk
  // and can discard verified local repairs. This callback grants no verdict.
  // Only whitespace-only, role-preserving preparation can replace the baseline.
  const originalMaterialized = canonical.materialize(String(options.outputText ?? ''));
  const forwardPreparedCandidate = text => {
    if (typeof onPreparedCandidate !== 'function' || !originalMaterialized.ok
        || typeof text !== 'string'
        || text.replace(/\s/gu, '') !== originalMaterialized.text.replace(/\s/gu, '')
        || require('./layoutRelations').preparationRelationDigest(text)
          !== require('./layoutRelations').preparationRelationDigest(originalMaterialized.text)) return;
    const frozen = canonical.refreeze(text, prepared.frozenCandidate);
    if (frozen.ok) onPreparedCandidate(frozen.text);
  };
  forwardPreparedCandidate(prepared.canonicalCandidate);
  const report = await runAudit({ ...options, source: canonical.canonicalSource,
    outputText: prepared.canonicalCandidate, prepareCandidateText,
    ...(typeof onPreparedCandidate === 'function' ? { onPreparedCandidate: forwardPreparedCandidate } : {}) });
  return frozenView(report, { canonical, ...prepared });
}

module.exports = {
  VERSION,
  createCanonicalAudit,
  prepareCandidate,
  frozenView,
  runCanonicalSemanticAudit
};
