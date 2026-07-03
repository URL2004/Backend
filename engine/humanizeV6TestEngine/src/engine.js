'use strict';
const { mergePolicy } = require('./policy');
const { minimalCleanup } = require('./postprocess/minimalCleanup');
const { postprocessText } = require('./postprocess/rhetoricStripper');
const { repairHeadingSpacing } = require('./postprocess/formatRepair');
const { scoreText } = require('./analysis/riskScorer');
const { extractProtectedTerms } = require('./analysis/protectedTerms');
const { analyzeSpeaker } = require('./analysis/speakerProfile');
const { detectProfile } = require('./analysis/profileDetector');
const { blockize, renderBlocks, selectPatchTargets, modeForText } = require('./length/blockizer');
const { buildPrompt } = require('./prompt/promptBuilder');
const { parseModelOutput } = require('./prompt/parseModelOutput');
const { runGates } = require('./gates/gateRunner');

function createCopykillerSafeHumanizer({ llm, policy: policyOverrides = {} } = {}) {
  if (!llm || typeof llm.complete !== 'function') {
    throw new Error('createCopykillerSafeHumanizer requires llm.complete({system,user,temperature,maxOutputTokens})');
  }
  const policy = mergePolicy(policyOverrides);

  async function transform({ text, metadata = {} } = {}) {
    const sourceText = minimalCleanup(text || '');
    if (!sourceText) {
      return { status: 'empty_input', operation: policy.operation, outputText: '', diagnostics: {} };
    }

    const sourceRisk = scoreText(sourceText, policy);
    const profile = detectProfile(sourceText);
    const speaker = analyzeSpeaker(sourceText);
    const protectedTerms = extractProtectedTerms(sourceText);
    const blocks = blockize(sourceText);
    const lengthMode = modeForText(sourceText, blocks, policy);

    if (sourceRisk.risk <= policy.minimalPreserveThreshold) {
      return {
        status: 'minimal_preserve',
        operation: policy.operation,
        ignoredUserInstructions: true,
        lengthMode: 'minimal_preserve',
        outputText: sourceText,
        diagnostics: { sourceRisk, profile, speaker, protectedTerms: protectedTerms.slice(0, 40) }
      };
    }

    const targets = lengthMode === 'patch_single_call' ? selectPatchTargets(blocks, policy) : [];
    if (lengthMode === 'patch_single_call' && targets.length === 0) {
      return {
        status: 'minimal_preserve',
        operation: policy.operation,
        ignoredUserInstructions: true,
        lengthMode,
        outputText: sourceText,
        diagnostics: { sourceRisk, profile, speaker, protectedTerms: protectedTerms.slice(0, 40), reason: 'no_patch_targets' }
      };
    }

    const { system, user } = buildPrompt({
      text: sourceText,
      blocks,
      targets,
      mode: lengthMode,
      policy,
      profile,
      risk: sourceRisk,
      protectedTerms,
      speaker
    });

    let raw;
    try {
      raw = await llm.complete({
        system,
        user,
        temperature: policy.temperature,
        maxOutputTokens: Math.ceil(Math.max(1024, sourceText.length * policy.maxOutputTokensMultiplier))
      });
    } catch (e) {
      return {
        status: 'llm_error',
        operation: policy.operation,
        ignoredUserInstructions: true,
        lengthMode,
        outputText: sourceText,
        diagnostics: { error: e.message, sourceRisk, profile }
      };
    }

    const parsed = parseModelOutput(raw);
    if (!parsed.ok) {
      return {
        status: 'model_output_parse_failed',
        operation: policy.operation,
        ignoredUserInstructions: true,
        lengthMode,
        outputText: sourceText,
        diagnostics: { parse: parsed, sourceRisk, profile }
      };
    }

    const resultObject = parsed.value;
    let candidate;
    if (lengthMode === 'block_locked_single_call') {
      candidate = Array.isArray(resultObject.blocks) ? renderBlocks(resultObject.blocks) : '';
    } else if (lengthMode === 'patch_single_call') {
      candidate = applyPatches(blocks, resultObject.patches || []);
    } else {
      candidate = String(resultObject.outputText || '');
    }

    candidate = repairHeadingSpacing(postprocessText(candidate));
    if (!candidate) candidate = sourceText;

    const gateResult = runGates({
      sourceText,
      outputText: candidate,
      policy,
      protectedTerms,
      mode: lengthMode,
      sourceRisk,
      blocks,
      resultObject
    });

    let outputText = candidate;
    let status = gateResult.status;

    if (gateResult.hardFails.length) {
      // Do not ship a transformed result predicted to raise Copykiller-like risk or damage meaning.
      outputText = sourceText;
      status = 'reverted_to_policy_safe';
    }

    return {
      status,
      operation: policy.operation,
      ignoredUserInstructions: true,
      lengthMode,
      outputText,
      diagnostics: {
        sourceRisk,
        afterRisk: gateResult.afterRisk,
        profile,
        speaker,
        protectedTerms: protectedTerms.slice(0, 60),
        patchTargets: targets.map(t => ({ id: t.id, risk: t.score, priority: t.priority })),
        gates: gateResult.gates,
        hardFails: gateResult.hardFails.map(g => g.name),
        softFails: gateResult.softFails.map(g => g.name),
        modelNotes: resultObject.notes || []
      }
    };
  }

  return { transform, policy };
}

function applyPatches(blocks, patches) {
  const map = new Map();
  for (const p of patches || []) {
    if (p && p.id && typeof p.text === 'string') map.set(p.id, p.text.trim());
  }
  return blocks.map(b => map.has(b.id) ? map.get(b.id) : b.text).join('\n\n');
}

module.exports = { createCopykillerSafeHumanizer };
