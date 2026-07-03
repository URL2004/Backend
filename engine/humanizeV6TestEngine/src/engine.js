const { mergePolicy } = require('./policy');
const { detectProfile } = require('./analysis/profileDetector');
const { analyzeRisk } = require('./analysis/riskScorer');
const { extractProtectedTerms } = require('./analysis/protectedTerms');
const { analyzeSpeakerProfile } = require('./analysis/speakerProfile');
const { buildPrompt } = require('./prompt/promptBuilder');
const { buildBlockLockedPrompt, buildPatchPrompt } = require('./prompt/longPromptBuilder');
const { parseModelOutput, parseBlockOutput, parsePatchOutput } = require('./prompt/parseModelOutput');
const { formatRepair } = require('./postprocess/formatRepair');
const { minimalCleanup } = require('./postprocess/minimalCleanup');
const { runGates } = require('./gates/gateRunner');
const { blockize, applyPatches, blockCoverage, mergeReturnedBlocks, selectPatchTargets } = require('./length/blockizer');
const { chooseLengthMode } = require('./length/modeSelector');

function createPolicyLockedHumanizer({ llm, policy: policyOverrides = {}, logger = null, semanticScorer = null } = {}) {
  if (!llm || typeof llm.complete !== 'function') {
    throw new Error('createPolicyLockedHumanizer requires llm.complete({system,user,temperature,maxOutputTokens})');
  }
  const policy = mergePolicy(policyOverrides);

  async function transform({ text, metadata = {} } = {}) {
    const sourceText = String(text || '').trim();
    if (!sourceText) {
      return { status: 'empty_input', outputText: '', policy: policy.version, diagnostics: {} };
    }

    const profile = detectProfile(sourceText, policy);
    const sourceRisk = analyzeRisk(sourceText, policy);
    const protectedTerms = extractProtectedTerms(sourceText, { max: 140 });
    const speakerProfile = analyzeSpeakerProfile(sourceText);
    const blocks = blockize(sourceText);
    const lengthMode = chooseLengthMode({ text: sourceText, blocks, sourceRisk, policy });

    if (sourceRisk.score <= policy.lowRiskThreshold && policy.strength !== 'assertive') {
      const cleaned = minimalCleanup(sourceText);
      const afterRisk = analyzeRisk(cleaned, policy);
      return {
        status: 'minimal_preserve',
        outputText: cleaned,
        policy: policy.version,
        operation: 'humanize_only',
        ignoredUserInstructions: true,
        lengthMode: 'minimal_preserve',
        profile,
        diagnostics: { sourceRisk, afterRisk, speakerProfile, blocks: blockSummary(blocks), reason: 'low_risk_source_protected' }
      };
    }

    if (logger) logger({ event: 'route_selected', policy: policy.version, profile, sourceRisk: sourceRisk.score, lengthMode, blockCount: blocks.length });

    if (lengthMode === 'patch_single_call') {
      return await transformPatchMode({ sourceText, profile, sourceRisk, protectedTerms, speakerProfile, blocks, metadata });
    }

    if (lengthMode === 'block_locked_single_call') {
      return await transformBlockLockedMode({ sourceText, profile, sourceRisk, protectedTerms, speakerProfile, blocks, metadata });
    }

    return await transformFullMode({ sourceText, profile, sourceRisk, protectedTerms, speakerProfile, metadata });
  }

  async function transformFullMode(ctx) {
    const { sourceText, profile, sourceRisk, protectedTerms, speakerProfile, metadata } = ctx;
    const prompt = buildPrompt({ text: sourceText, policy, profile, risk: sourceRisk, protectedTerms });
    if (logger) logger({ event: 'prompt_built', mode: 'full_single_call', protectedTermsCount: protectedTerms.length });

    let raw;
    try { raw = await llm.complete(prompt); }
    catch (err) { return failSafe('llm_error', sourceText, { error: String(err && err.message || err), sourceRisk, profile, lengthMode: 'full_single_call' }); }

    const parsed = parseModelOutput(raw);
    if (!parsed.ok) return failSafe('model_output_parse_failed', sourceText, { parseError: parsed.error, raw: parsed.raw, sourceRisk, profile, lengthMode: 'full_single_call' });

    const repaired = formatRepair(parsed.data.outputText, sourceText);
    return await finalize({ sourceText, outputText: repaired, sourceRisk, protectedTerms, profile, model: parsed.data, semanticInput: null, metadata, lengthMode: 'full_single_call', blockIssues: [] });
  }

  async function transformBlockLockedMode(ctx) {
    const { sourceText, profile, sourceRisk, protectedTerms, speakerProfile, blocks, metadata } = ctx;
    const prompt = buildBlockLockedPrompt({ blocks, policy, profile, risk: sourceRisk, protectedTerms, speakerProfile });
    if (logger) logger({ event: 'prompt_built', mode: 'block_locked_single_call', blockCount: blocks.length, protectedTermsCount: protectedTerms.length });

    let raw;
    try { raw = await llm.complete(prompt); }
    catch (err) { return failSafe('llm_error', sourceText, { error: String(err && err.message || err), sourceRisk, profile, lengthMode: 'block_locked_single_call' }); }

    const parsed = parseBlockOutput(raw);
    if (!parsed.ok) return failSafe('model_output_parse_failed', sourceText, { parseError: parsed.error, raw: parsed.raw, sourceRisk, profile, lengthMode: 'block_locked_single_call' });

    const coverage = blockCoverage(blocks, parsed.data.blocks);
    const blockIssues = [];
    if (!coverage.sameCount) blockIssues.push(`block_count_changed:${blocks.length}->${parsed.data.blocks.length}`);
    if (!coverage.sameOrder) blockIssues.push('block_order_or_id_changed');
    if (coverage.missing.length) blockIssues.push(`missing_blocks:${coverage.missing.slice(0, 8).join(',')}`);
    if (coverage.extra.length) blockIssues.push(`extra_blocks:${coverage.extra.slice(0, 8).join(',')}`);

    const merged = mergeReturnedBlocks(blocks, parsed.data.blocks);
    const repaired = formatRepair(merged, sourceText);
    return await finalize({ sourceText, outputText: repaired, sourceRisk, protectedTerms, profile, model: parsed.data, metadata, lengthMode: 'block_locked_single_call', blockIssues });
  }

  async function transformPatchMode(ctx) {
    const { sourceText, profile, sourceRisk, protectedTerms, speakerProfile, blocks, metadata } = ctx;
    const patchTargets = selectPatchTargets({ blocks, policy, sourceRisk });
    if (!patchTargets.length) {
      const cleaned = minimalCleanup(sourceText);
      const afterRisk = analyzeRisk(cleaned, policy);
      return {
        status: 'minimal_preserve',
        outputText: cleaned,
        policy: policy.version,
        operation: 'humanize_only',
        ignoredUserInstructions: true,
        lengthMode: 'patch_no_targets',
        profile,
        diagnostics: { sourceRisk, afterRisk, speakerProfile, blocks: blockSummary(blocks), reason: 'long_document_no_patch_targets' }
      };
    }

    const prompt = buildPatchPrompt({ patchTargets, policy, profile, risk: sourceRisk, protectedTerms, speakerProfile });
    if (logger) logger({ event: 'prompt_built', mode: 'patch_single_call', blockCount: blocks.length, patchTargetCount: patchTargets.length, protectedTermsCount: protectedTerms.length });

    let raw;
    try { raw = await llm.complete(prompt); }
    catch (err) { return failSafe('llm_error', sourceText, { error: String(err && err.message || err), sourceRisk, profile, lengthMode: 'patch_single_call', patchTargetCount: patchTargets.length }); }

    const parsed = parsePatchOutput(raw);
    if (!parsed.ok) return failSafe('model_output_parse_failed', sourceText, { parseError: parsed.error, raw: parsed.raw, sourceRisk, profile, lengthMode: 'patch_single_call' });

    const allowed = new Set(patchTargets.map(t => t.id));
    const invalid = (parsed.data.patches || []).filter(p => !allowed.has(p.id)).map(p => p.id);
    const duplicates = findDuplicates((parsed.data.patches || []).map(p => p.id));
    const blockIssues = [];
    if (invalid.length) blockIssues.push(`invalid_patch_ids:${invalid.slice(0, 10).join(',')}`);
    if (duplicates.length) blockIssues.push(`duplicate_patch_ids:${duplicates.slice(0, 10).join(',')}`);

    const merged = applyPatches(blocks, (parsed.data.patches || []).filter(p => allowed.has(p.id)));
    const repaired = formatRepair(merged, sourceText);
    return await finalize({
      sourceText,
      outputText: repaired,
      sourceRisk,
      protectedTerms,
      profile,
      model: { ...parsed.data, patchTargetCount: patchTargets.length, returnedPatchCount: (parsed.data.patches || []).length },
      metadata,
      lengthMode: 'patch_single_call',
      blockIssues,
      patchTargets: patchTargets.map(t => ({ id: t.id, risk: t.risk, priority: t.priority }))
    });
  }

  async function finalize({ sourceText, outputText, sourceRisk, protectedTerms, profile, model, metadata, lengthMode, blockIssues, patchTargets = null }) {
    const gateResult = runGates({ sourceText, outputText, sourceRisk, protectedTerms, policy, mode: lengthMode, blockIssues });
    let semantic = null;
    if (semanticScorer && typeof semanticScorer.score === 'function') {
      try { semantic = await semanticScorer.score({ sourceText, outputText, protectedTerms }); }
      catch (err) { semantic = { error: String(err && err.message || err) }; }
    }

    if (gateResult.hardFailed && policy.allowFallbackToOriginal) {
      const fallbackText = minimalCleanup(sourceText);
      const fallbackRisk = analyzeRisk(fallbackText, policy);
      return {
        status: 'reverted_to_policy_safe',
        outputText: fallbackText,
        policy: policy.version,
        operation: 'humanize_only',
        ignoredUserInstructions: true,
        lengthMode,
        profile,
        model,
        diagnostics: { sourceRisk, afterRisk: gateResult.afterRisk, fallbackRisk, gates: gateResult.gates, semantic, patchTargets, reason: 'hard_gate_failed' }
      };
    }

    return {
      status: gateResult.passed ? 'done' : 'done_limited_effect',
      outputText,
      policy: policy.version,
      operation: 'humanize_only',
      ignoredUserInstructions: true,
      lengthMode,
      profile,
      model,
      diagnostics: { sourceRisk, afterRisk: gateResult.afterRisk, gates: gateResult.gates, semantic, patchTargets, metadata: sanitizeMetadata(metadata) }
    };
  }

  function preview({ text } = {}) {
    const sourceText = String(text || '').trim();
    const profile = detectProfile(sourceText, policy);
    const sourceRisk = analyzeRisk(sourceText, policy);
    const protectedTerms = extractProtectedTerms(sourceText, { max: 140 });
    const speakerProfile = analyzeSpeakerProfile(sourceText);
    const blocks = blockize(sourceText);
    const lengthMode = chooseLengthMode({ text: sourceText, blocks, sourceRisk, policy });
    const patchTargets = lengthMode === 'patch_single_call' ? selectPatchTargets({ blocks, policy, sourceRisk }) : [];
    const prompt = lengthMode === 'block_locked_single_call'
      ? buildBlockLockedPrompt({ blocks, policy, profile, risk: sourceRisk, protectedTerms, speakerProfile })
      : lengthMode === 'patch_single_call'
        ? buildPatchPrompt({ patchTargets, policy, profile, risk: sourceRisk, protectedTerms, speakerProfile })
        : buildPrompt({ text: sourceText, policy, profile, risk: sourceRisk, protectedTerms });
    return { policy, profile, sourceRisk, protectedTerms, speakerProfile, lengthMode, blocks: blockSummary(blocks), patchTargets, prompt };
  }

  function failSafe(status, sourceText, diagnostics) {
    return { status, outputText: minimalCleanup(sourceText), policy: policy.version, operation: 'humanize_only', ignoredUserInstructions: true, diagnostics };
  }

  return { transform, preview, policy };
}

function sanitizeMetadata(metadata) {
  const m = { ...metadata };
  if ('userInstruction' in m) m.userInstruction = '[ignored_by_policy]';
  if ('prompt' in m) m.prompt = '[ignored_by_policy]';
  return m;
}

function blockSummary(blocks) {
  return { count: blocks.length, headings: blocks.filter(b => b.type === 'heading').length, paragraphs: blocks.filter(b => b.type === 'paragraph').length, lists: blocks.filter(b => b.type === 'list').length };
}

function findDuplicates(arr) {
  const seen = new Set();
  const dup = new Set();
  for (const x of arr) { if (seen.has(x)) dup.add(x); else seen.add(x); }
  return [...dup];
}

module.exports = { createPolicyLockedHumanizer };
