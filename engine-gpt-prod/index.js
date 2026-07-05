'use strict';

const net = require('net');
const dns = require('dns').promises;
const { completeJson, webSearchTool } = require('./openaiClient');
const { HUMANIZE_SCHEMA, DETECT_SCHEMA, REWRITE_SCHEMA, EVIDENCE_SCHEMA } = require('./schemas');
const prompts = require('./prompts');
const { addUsage, emptyUsage } = require('./usageCost');
const local = require('./local');
const { buildContract } = local.contract;
const structureChunk = require('./structureChunk');
const floor = local.floor;
const surfaceguard = local.surfaceguard;
const koreanQuality = local.koreanQuality;
const gptRuntimeConfig = require('../lib/gptRuntimeConfig');
const { logger } = require('../lib/logger');
const layoutNormalizer = require('../engine/layout');

const VERSION = 'gpt-prod-operating-engine-v1';
const PROFILE = 'engine-gpt-prod';
const NO_DELIVERY_GATES = new Set([
  'gpt_all_chunks_fallback',
  'gpt_noop_unchanged',
  'noop_unchanged'
]);
const STRICT_DELIVERY_GATES = new Set([
  ...NO_DELIVERY_GATES,
  'empty_or_meta_output',
  'prompt_instruction_leak',
  'encoding_corruption',
  'sentence_truncated'
]);
const REVIEW_WARNING_GATES = new Set([
  'section_anchor_loss',
  'length_collapse',
  'protected_term_loss',
  'structure_lock_loss',
  'unsafe_chunk_boundary',
  'grammar_hard_error',
  'speaker_drift',
  'register_shift',
  'paragraph_collapse'
]);

function normalizeMode(mode, { allowPolish = false } = {}) {
  const v = String(mode || '').trim().toLowerCase();
  if (v === 'blog' || v === 'basic') return 'blog';
  if ((v === 'polish' || v === 'preserve') && allowPolish) return 'polish';
  return 'assignment';
}

async function loadConfig(config) {
  return config ? gptRuntimeConfig.publicConfig(config, config.source || 'inline') : gptRuntimeConfig.getRuntimeConfig({ force: false });
}

function allowPolishMode({ styleProfile = '', config } = {}) {
  if (config && (config.allowPolishMode === true || config.allowPolish === true)) return true;
  const profile = String(styleProfile || '').toLowerCase();
  return profile.includes('admin') || profile.includes('lab');
}

function isAdminNiklProfile(styleProfile = '') {
  const profile = String(styleProfile || '').toLowerCase();
  return profile.includes('admin') || profile.includes('lab') || profile.includes('test');
}

function isNiklQualityEnabled(value, styleProfile = '') {
  if (process.env.GPT_NIKL_QUALITY_ENABLED === '0') return false;
  if (isAdminNiklProfile(styleProfile)) return value === true;
  return true;
}

function isQualityPatternLabEnabled(value, styleProfile = '') {
  if (process.env.GPT_QUALITY_PATTERN_ENABLED === '0' || process.env.GPT_QUALITY_PATTERN_LAB_ENABLED === '0') return false;
  if (value === true) return true;
  if (value === false) return false;
  return !isAdminNiklProfile(styleProfile);
}

function isLayoutNlpEnabled(value) {
  if (process.env.GPT_LAYOUT_NLP_ENABLED === '0' || process.env.LAYOUT_NLP_PRODUCTION_ENABLED === '0') return false;
  if (value === true) return true;
  if (value === false) return false;
  return true;
}

async function run({ text, mode = 'assignment', lang = 'ko', userNotes = '', evidence = '', signal, config, styleProfile = '', niklQualityTest = false, qualityPatternLab, layoutNlp = null } = {}) {
  const rawSource = String(text || '').trim();
  if (!rawSource) throw new Error('engine-gpt-prod: empty text');
  const cfg = await loadConfig(config);
  const selectedMode = normalizeMode(mode, { allowPolish: allowPolishMode({ styleProfile, config }) });
  const layoutNlpEnabled = isLayoutNlpEnabled(layoutNlp);
  const preLayout = layoutNlpEnabled
    ? await safeFormatLayout(rawSource, { mode: selectedMode, phase: 'pre' })
    : null;
  const source = preLayout?.text || rawSource;
  const qualityPatternLabEnabled = isQualityPatternLabEnabled(qualityPatternLab, styleProfile);
  const niklQualityEnabled = qualityPatternLabEnabled || isNiklQualityEnabled(niklQualityTest, styleProfile);
  const contract = buildContract(source, { mode: selectedMode, lang, optIn: !!String(userNotes || '').trim() });
  const inputRisk = safeInputRisk(source);
  const sourceSurface = safeSurface(source);
  const chunkPlan = structureChunk.splitChunksForGpt(source);
  const chunks = chunkPlan.chunks;
  const records = [];

  for (let i = 0; i < chunks.length; i++) {
    const record = await processChunk({
      chunk: chunks[i],
      chunks,
      index: i,
      source,
      contract,
      inputRisk,
      sourceSurface,
      mode: selectedMode,
      lang,
      userNotes,
      evidence,
      cfg,
      styleProfile,
      niklQualityTest: niklQualityEnabled,
      qualityPatternLab: qualityPatternLabEnabled,
      signal
    });
    records.push(record);
  }

  const boundaryRepair = structureChunk.repairUnsafeChunkBoundaries(chunks);
  let outputText = structureChunk.mergeChunks(chunks);
  outputText = finalPostprocess(outputText, source, selectedMode, contract);
  const postLayout = layoutNlpEnabled
    ? await safeFormatLayout(outputText, { mode: selectedMode, phase: 'post' })
    : null;
  if (postLayout?.text) outputText = postLayout.text;
  const structureAudit = structureChunk.buildStructureAudit({
    source,
    outputText,
    chunks,
    plan: chunkPlan,
    boundaryRepair
  });
  const result = buildResult({ source, outputText, contract, mode: selectedMode, records, inputRisk, niklQualityTest: niklQualityEnabled, qualityPatternLab: qualityPatternLabEnabled, structureAudit });
  if (layoutNlpEnabled) {
    result.layoutFormat = buildLayoutFormatMeta(preLayout, postLayout, rawSource, outputText);
  }
  if (structureAudit && (!structureAudit.pass || structureAudit.boundaryRepair?.applied)) {
    addStructureWarnings(result.floorReport, structureAudit);
  }
  const finalGate = evaluateWholeDocumentGate({
    outputText,
    source,
    contract,
    mode: selectedMode,
    sourceSurface
  });
  if (finalGate.hardFail) {
    addFloorCriticals(result.floorReport, finalGate.violations, finalGate.reason);
  } else if (finalGate.violations.length || finalGate.warnings.length) {
    addFloorWarnings(result.floorReport, finalGate.violations, finalGate.warnings);
  }
  const fallbackCount = records.filter(r => r.fallback).length;
  const effectiveChunks = records.filter(r => !r.skipped).length;
  const allFallback = effectiveChunks > 0 && fallbackCount >= effectiveChunks;
  if (allFallback || normalizeBare(source) === normalizeBare(outputText)) {
    result.floorReport = result.floorReport || { status: 'blocked', criticals: [], warnings: [] };
    if (qualityPatternLabEnabled && !allFallback) {
      result.floorReport.status = result.floorReport.status === 'clean' ? 'needs_review' : result.floorReport.status;
      result.floorReport.warnings = [
        ...(result.floorReport.warnings || []),
        {
          gate: 'quality_pattern_low_effect',
          detail: 'quality pattern lab output is equivalent to source; delivered for audit comparison'
        }
      ];
    } else {
      result.floorReport.status = 'blocked';
      result.floorReport.criticals = result.floorReport.criticals || [];
      result.floorReport.criticals.push({
        gate: allFallback ? 'gpt_all_chunks_fallback' : 'gpt_noop_unchanged',
        detail: allFallback ? 'All GPT chunks failed hard gates and fell back to source.' : 'GPT output is equivalent to source.'
      });
    }
  }
  if (qualityPatternLabEnabled) softenQualityPatternLabFloorReport(result.floorReport);
  softenFloorReport(result.floorReport);

  const usage = records.reduce((acc, r) => addUsage(acc, r.usage), emptyUsage());
  const escalatedCount = records.filter(r => r.escalated).length;
  result.humanizeMeta = {
    provider: 'openai',
    engine: VERSION,
    profile: PROFILE,
    selectedModel: cfg.models.humanizePrimary,
    escalationModel: cfg.models.humanizeEscalation,
    escalated: escalatedCount > 0,
    escalationCount: escalatedCount,
    chunkCount: records.length,
    fallbackCount,
    cachedInputTokens: usage.cachedInputTokens,
    reasoningTokens: usage.reasoningTokens,
    estimatedUsd: usage.estimatedUsd,
    usage,
    structureLock: result.structureLock || null,
    koreanQuality: result.koreanQuality || null,
    niklQuality: niklQualityEnabled ? (result.niklQualityTest || { enabled: true }) : null,
    niklQualityTest: niklQualityEnabled ? (result.niklQualityTest || { enabled: true }) : null,
    qualityPatternLab: qualityPatternLabEnabled ? (result.qualityPatternLab || { enabled: true }) : null,
    layoutFormat: layoutNlpEnabled ? (result.layoutFormat || { enabled: true }) : null,
    runtimeConfigSource: cfg.source,
    styleProfile: styleProfile || PROFILE
  };

  return {
    result,
    surface: result.surface,
    inputRisk,
    mode: selectedMode,
    lang,
    chunked: true,
    chunkCount: chunks.length,
    status: result.floorReport.status,
    floorReport: result.floorReport,
    chunks: records,
    fallbackCount,
    gptEngine: result.humanizeMeta
  };
}

async function processChunk({ chunk, chunks, index, source, contract, inputRisk, sourceSurface, mode, lang, userNotes, evidence, cfg, styleProfile, niklQualityTest = false, qualityPatternLab = false, signal }) {
  const original = chunk.text;
  if (chunk.locked) {
    chunk.outputText = original;
    return chunkRecord({
      chunk,
      outputText: original,
      skipped: true,
      locked: true,
      lockType: chunk.lockType || 'structure',
      warnings: [chunk.skipReason || 'structure_locked']
    });
  }
  if (shouldPassThrough(original)) {
    chunk.outputText = original;
    return chunkRecord({ chunk, outputText: original, skipped: true });
  }
  const protectedTerms = extractProtectedTerms(original);
  const patchTargets = buildPatchTargets(original, mode);
  const highRisk = isHighRiskChunk(original, protectedTerms, patchTargets, cfg, inputRisk);
  const primaryReasoning = highRisk ? cfg.reasoning.factDense : cfg.reasoning.humanize;
  const chunkSurface = safeSurface(original) || sourceSurface;

  const first = await callHumanize({
    original,
    chunk,
    chunks,
    index,
    source,
    contract,
    inputRisk,
    sourceSurface: chunkSurface,
    mode,
    lang,
    userNotes,
    evidence,
    cfg,
    model: cfg.models.humanizePrimary,
    reasoningEffort: primaryReasoning,
    phase: 'primary',
    protectedTerms,
    patchTargets,
    styleProfile,
    niklQualityTest,
    qualityPatternLab,
    runSemanticJudge: highRisk,
    signal
  });
  if (!first.hardFail || cfg.escalation.enabled === false) {
    chunk.outputText = first.hardFail ? original : first.outputText;
    return first.record;
  }

  const second = await callHumanize({
    original,
    chunk,
    chunks,
    index,
    source,
    contract,
    inputRisk,
    sourceSurface: chunkSurface,
    mode,
    lang,
    userNotes,
    evidence,
    cfg,
    model: cfg.models.humanizeEscalation,
    reasoningEffort: cfg.reasoning.escalation,
    phase: 'escalation',
    protectedTerms,
    patchTargets,
    styleProfile,
    niklQualityTest,
    qualityPatternLab,
    runSemanticJudge: highRisk,
    signal
  });
  if (!second.hardFail) {
    chunk.outputText = second.outputText;
    second.record.escalated = true;
    second.record.primaryError = first.record.error || first.record.hardFailReason;
    second.record.primaryUsage = first.record.usage || null;
    second.record.usage = addUsage(second.record.usage || emptyUsage(), first.record.usage);
    return second.record;
  }

  chunk.outputText = original;
  return chunkRecord({
    chunk,
    outputText: original,
    fallback: true,
    escalated: true,
    error: second.record.error || second.record.hardFailReason || first.record.error || 'gpt_hard_gate_failed',
    warnings: ['gpt_primary_and_escalation_failed'],
    floorViolations: [...(first.record.floorViolations || []), ...(second.record.floorViolations || [])],
    usage: addUsage(first.record.usage || emptyUsage(), second.record.usage),
    elapsedMs: (first.record.elapsedMs || 0) + (second.record.elapsedMs || 0)
  });
}

async function callHumanize(args) {
  const {
    original, chunk, chunks, index, source, contract, inputRisk, sourceSurface, mode, lang, userNotes, evidence,
    cfg, model, reasoningEffort, phase, protectedTerms, patchTargets, styleProfile, niklQualityTest = false, qualityPatternLab = false, runSemanticJudge, signal
  } = args;
  try {
    const koreanSourceQuality = safeKoreanQualityAnalysis(original, {
      mode,
      register: contract.register
    });
    const koreanQualityHints = safeKoreanQualityHints(koreanSourceQuality);
    const niklSourceQuality = niklQualityTest ? safeNiklQualityAnalysis(original, {
      mode,
      register: contract.register
    }) : null;
    const niklQualityHints = niklQualityTest ? safeNiklQualityHints(niklSourceQuality) : '';
    const niklExternalApiHints = niklQualityTest ? await safeNiklExternalApiHints(original, protectedTerms) : '';
    const qualityPatternProfile = qualityPatternLab ? safeQualityPatternProfile(original, {
      mode,
      register: contract.register
    }) : null;
    const qualityPatternHints = qualityPatternLab ? safeQualityPatternHints(qualityPatternProfile) : '';
    const riskProfile = composeRiskProfile(inputRisk, koreanQualityHints, [niklQualityHints, niklExternalApiHints, qualityPatternHints].filter(Boolean).join('\n\n'));
    const hp = prompts.buildHumanizePrompt(mode, lang, {
      speakerType: contract.speakerType,
      register: contract.register,
      lengthPolicy: contract.lengthPolicy,
      styleProfile: styleProfile || PROFILE,
      userNotes,
      evidence,
      riskProfile
    });
    const retryInstruction = phase === 'escalation' ? prompts.buildEscalationInstruction() : '';
    const response = await completeJson({
      system: [hp.stable, retryInstruction].filter(Boolean).join('\n\n'),
      user: prompts.buildHumanizeUser({ chunk, chunks, index, protectedTerms, patchTargets, dynamicContext: hp.dynamic }),
      schema: HUMANIZE_SCHEMA,
      schemaName: 'gpt_prod_humanize_result',
      model,
      reasoningEffort,
      verbosity: 'medium',
      maxOutputTokens: maxOutputTokensFor(original),
      config: cfg,
      signal,
      meta: {
        task: 'humanize',
        phase,
        mode,
        profile: PROFILE,
        chunkIndex: index,
        escalated: phase === 'escalation'
      }
    });
    let outputText = sanitizeOutput(response.json.outputText);
    outputText = chunkPostprocess(outputText, original, mode, contract);
    let judgeReport = null;
    let judgeViolations = [];
    let judgeHardFail = false;
    let judgeHardFailReason = '';
    if (runSemanticJudge) {
      judgeReport = await require('./judge').judgeAndRepair(original, outputText, {
        lang,
        signal,
        config: cfg,
        maxRounds: 1,
        allowedExtra: evidence || userNotes || '',
        mode
      });
      outputText = judgeReport.outputText || outputText;
      if (judgeReport.pass === false) {
        judgeHardFail = true;
        judgeHardFailReason = 'semantic_judge_failed';
        judgeViolations = (judgeReport.violations || []).map(v => ({
          gate: 'semantic_judge_failed',
          type: v.type,
          span: v.span,
          detail: v.detail
        }));
      } else if (judgeReport.skipped) {
        judgeHardFail = true;
        judgeHardFailReason = 'semantic_judge_skipped';
        judgeViolations = [{
          gate: 'semantic_judge_skipped',
          reason: judgeReport.reason || 'judge_skipped',
          detail: 'semantic judge did not have enough verified source claims'
        }];
      }
    }
    const gate = evaluateChunkGate({
      outputText,
      original,
      source,
      contract,
      mode,
      protectedTerms,
      sourceSurface
    });
    const qualityGate = safeKoreanQualityGate(original, outputText, {
      mode,
      register: contract.register,
      beforeAnalysis: koreanSourceQuality
    });
    const niklQualityGate = niklQualityTest ? safeNiklQualityGate(original, outputText, {
      mode,
      register: contract.register,
      beforeAnalysis: niklSourceQuality
    }) : null;
    const qualityPatternAudit = qualityPatternLab ? safeQualityPatternAudit(original, outputText, {
      mode,
      register: contract.register,
      beforeProfile: qualityPatternProfile,
      protectedTerms,
      externalApiHintsUsed: Boolean(niklExternalApiHints)
    }) : null;
    if (qualityGate) {
      if (Array.isArray(qualityGate.warnings) && qualityGate.warnings.length) {
        gate.warnings.push(...qualityGate.warnings);
      }
      if (Array.isArray(qualityGate.violations) && qualityGate.violations.length) {
        gate.violations.push(...qualityGate.violations);
      }
      if (qualityGate.blocking && process.env.STRICT_QUALITY_GATE === '1') {
        gate.hardFail = true;
        gate.reason = qualityGate.reason || 'korean_quality_regression';
      }
    }
    if (niklQualityGate) {
      if (Array.isArray(niklQualityGate.warnings) && niklQualityGate.warnings.length) {
        gate.warnings.push(...niklQualityGate.warnings);
      }
      if (Array.isArray(niklQualityGate.violations) && niklQualityGate.violations.length) {
        gate.violations.push(...niklQualityGate.violations.map(v => ({ ...v, niklQuality: true })));
      }
    }
    if (judgeHardFail && process.env.STRICT_QUALITY_GATE === '1') {
      gate.hardFail = true;
      gate.reason = judgeHardFailReason;
      gate.warnings.push(judgeHardFailReason);
      gate.violations.push(...judgeViolations);
    } else if (judgeHardFail) {
      gate.warnings.push(judgeHardFailReason);
      gate.violations.push(...judgeViolations);
    }
    if (qualityPatternLab && gate.hardFail && gate.reason === 'noop_unchanged') {
      gate.hardFail = false;
      gate.reason = '';
      gate.warnings.push('quality_pattern_low_effect');
      gate.violations.push({ gate: 'quality_pattern_low_effect', detail: 'output equivalent to source; delivered for lab audit' });
    }
    if (qualityPatternAudit?.auditTrail?.warnings?.length) {
      gate.warnings.push(...qualityPatternAudit.auditTrail.warnings.map(w => `quality_pattern:${w}`));
      gate.violations.push(...qualityPatternAudit.auditTrail.warnings.map(w => ({ gate: w, qualityPatternLab: true })));
    }
    return {
      outputText,
      hardFail: gate.hardFail,
      record: chunkRecord({
        chunk,
        outputText: gate.hardFail ? original : outputText,
        fallback: gate.hardFail,
        error: gate.hardFail ? gate.reason : null,
        hardFailReason: gate.reason,
        warnings: [
          ...(response.json.warnings || []),
          ...(response.json.riskFlags || []).map(v => `risk:${v}`),
          ...(response.json.factualRiskNotes || []).map(v => `fact_note:${v}`),
          ...(judgeViolations.length ? [judgeHardFailReason || 'gpt_semantic_judge_warning'] : []),
          ...gate.warnings
        ],
        floorViolations: gate.violations,
        usage: response.usage,
        elapsedMs: response.elapsedMs,
        editIntensity: response.json.editIntensity,
        protectedTerms: response.json.protectedTerms || protectedTerms,
        changedSentenceRatio: response.json.changedSentenceRatio,
        judgeReport,
        koreanQuality: compactKoreanQualityGate(qualityGate),
        niklQuality: compactNiklQualityGate(niklQualityGate),
        qualityPatternLab: compactQualityPatternAudit(qualityPatternAudit),
        selectedModel: response.model,
        escalated: phase === 'escalation'
      })
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    try {
      logger.warn('gpt_prod.call_failed', {
        task: 'humanize',
        phase,
        mode,
        model,
        chunkIndex: index,
        err: err && err.message || String(err)
      });
    } catch {}
    return {
      outputText: original,
      hardFail: true,
      record: chunkRecord({
        chunk,
        outputText: original,
        fallback: true,
        error: err && err.message || String(err),
        hardFailReason: 'gpt_call_failed',
        warnings: ['gpt_call_failed'],
        selectedModel: model,
        escalated: phase === 'escalation'
      })
    };
  }
}

async function detect({ text, lang = 'ko', signal, config, route = 'detect', allowLocalFallback = true } = {}) {
  const source = String(text || '').trim();
  const cfg = await loadConfig(config);
  const user = lang === 'en' ? `[TEXT TO ANALYZE]\n${source}` : `[분석할 글]\n${source}`;
  try {
    const res = await callDetectModel({
      prompt: prompts.buildDetectPrompt(lang),
      user,
      cfg,
      signal,
      route,
      phase: 'detect:primary',
      model: cfg.models.detect,
      reasoningEffort: cfg.reasoning.detect,
      escalated: false
    });
    let out = normalizeDetectResult(res.json);
    out.gptMeta = metaFromResponse(res, cfg, { task: route, escalated: false });
    if (shouldEscalateDetect(out, source, cfg)) {
      const esc = await callDetectModel({
        prompt: prompts.buildDetectPrompt(lang),
        user,
        cfg,
        signal,
        route,
        phase: 'detect:confidence_escalation',
        model: cfg.models.detectEscalation,
        reasoningEffort: cfg.reasoning.escalation,
        escalated: true
      });
      out = normalizeDetectResult(esc.json);
      out.gptMeta = metaFromResponse(esc, cfg, { task: route, escalated: true, primaryConfidence: res.json.confidence || '' });
    }
    return out;
  } catch (firstErr) {
    try {
      const res = await callDetectModel({
        prompt: prompts.buildDetectPrompt(lang),
        user,
        cfg,
        signal,
        route,
        phase: 'detect:escalation',
        model: cfg.models.detectEscalation,
        reasoningEffort: cfg.reasoning.escalation,
        escalated: true
      });
      const out = normalizeDetectResult(res.json);
      out.gptMeta = metaFromResponse(res, cfg, { task: route, escalated: true, primaryError: firstErr.message });
      return out;
    } catch (err) {
      if (signal?.aborted) throw err;
      if (!allowLocalFallback) throw err;
      return deterministicDetectFallback(source, firstErr || err);
    }
  }
}

async function callDetectModel({ prompt, user, cfg, signal, route, phase, model, reasoningEffort, escalated }) {
  return await completeJson({
      system: prompt,
      user,
      schema: DETECT_SCHEMA,
      schemaName: 'gpt_prod_detect_result',
      model,
      reasoningEffort,
      verbosity: 'low',
      maxOutputTokens: 2200,
      config: cfg,
      signal,
      meta: { task: route, phase, mode: 'detect', profile: PROFILE, escalated }
    });
}

async function rewriteSentence({ text, lang = 'ko', signal, config } = {}) {
  const cfg = await loadConfig(config);
  const source = String(text || '').trim();
  const res = await completeJson({
    system: prompts.buildRewritePrompt(lang),
    user: `[원문]\n${source}`,
    schema: REWRITE_SCHEMA,
    schemaName: 'gpt_prod_rewrite_sentence',
    model: cfg.models.repair,
    reasoningEffort: cfg.reasoning.repair,
    verbosity: 'low',
    maxOutputTokens: 600,
    config: cfg,
    signal,
    meta: { task: 'rewrite_sentence', phase: 'repair', mode: 'preview', profile: PROFILE }
  });
  const rewritten = sanitizeOutput(res.json.rewritten);
  return { rewritten: rewritten || source, gptMeta: metaFromResponse(res, cfg, { task: 'rewrite_sentence' }) };
}

async function suggestEvidence({ query, signal, config } = {}) {
  const cfg = await loadConfig(config);
  const text = String(query || '').trim();
  if (!text) return { candidates: [], warnings: ['empty_query'] };
  try {
    const out = await callEvidenceSearch({ text, cfg, signal, phase: 'search:primary', model: cfg.models.evidenceSearch, reasoningEffort: cfg.reasoning.evidenceSearch });
    if ((out.warnings || []).includes('source_url_verification_filtered_all')) {
      throw new Error('source_url_verification_filtered_all');
    }
    return out;
  } catch (firstErr) {
    if (signal?.aborted) throw firstErr;
    const out = await callEvidenceSearch({ text, cfg, signal, phase: 'search:escalation', model: cfg.models.evidenceEscalation, reasoningEffort: cfg.reasoning.escalation });
    out.warnings = [...(out.warnings || []), `primary_failed:${firstErr.message || String(firstErr)}`];
    out.gptMeta = { ...(out.gptMeta || {}), escalated: true, primaryError: firstErr.message || String(firstErr) };
    return out;
  }
}

async function callEvidenceSearch({ text, cfg, signal, phase, model, reasoningEffort }) {
  const res = await completeJson({
    system: prompts.buildEvidencePrompt(),
    user: `[검증할 주장 또는 주제]\n${text}`,
    schema: EVIDENCE_SCHEMA,
    schemaName: 'gpt_prod_evidence_candidates',
    model,
    reasoningEffort,
    verbosity: 'low',
    maxOutputTokens: 2500,
    tools: [webSearchTool()],
    toolChoice: 'required',
    include: ['web_search_call.action.sources'],
    config: cfg,
    signal,
    meta: { task: 'evidence_search', phase, mode: 'evidence', profile: PROFILE, escalated: phase.includes('escalation') }
  });
  const verifiedUrls = collectWebSearchUrls(res.raw);
  const warnings = [...(res.json.warnings || [])];
  let candidates = (res.json.candidates || [])
    .map(c => ({ ...c, url: String(c.url || '').trim() }))
    .filter(c => /^https?:\/\//i.test(c.url))
    .filter(c => {
      const unsafe = isUnsafeEvidenceUrl(c.url);
      if (unsafe) warnings.push('unsafe_source_url_filtered');
      return !unsafe;
    })
    .map(c => ({ ...c, sourceVerified: verifiedUrls.size ? hasVerifiedUrl(c.url, verifiedUrls) : false }));
  if (verifiedUrls.size) {
    candidates = candidates.filter(c => c.sourceVerified);
  } else {
    candidates = await verifyEvidenceCandidates(candidates, signal);
    warnings.push('source_url_verified_by_fetch');
  }
  candidates = candidates.slice(0, 8);
  if (verifiedUrls.size && !candidates.length) warnings.push('source_url_verification_filtered_all');
  return {
    candidates,
    warnings,
    gptMeta: metaFromResponse(res, cfg, { task: 'evidence_search', escalated: phase.includes('escalation'), verifiedSourceUrlCount: verifiedUrls.size })
  };
}

function evaluateChunkGate({ outputText, original, source, contract, mode, protectedTerms, sourceSurface }) {
  const warnings = [];
  const violations = [];
  const sourceAnchors = collectStructureAnchors(original);
  if (!outputText || looksLikeMeta(outputText)) {
    return { hardFail: true, reason: 'empty_or_meta_output', warnings, violations };
  }
  if (looksLikePromptLeak(outputText)) {
    return { hardFail: true, reason: 'prompt_instruction_leak', warnings, violations };
  }
  if (looksEncodingCorrupted(original, outputText)) {
    return { hardFail: true, reason: 'encoding_corruption', warnings, violations };
  }
  if (looksTruncated(outputText)) {
    return { hardFail: true, reason: 'sentence_truncated', warnings, violations };
  }
  if (sourceAnchors.length >= 2) {
    const missingAnchors = sourceAnchors.filter(a => !structureAnchorPresent(a, outputText));
    if (missingAnchors.length) {
      violations.push({
        gate: 'section_anchor_loss',
        missing: missingAnchors.slice(0, 8).map(a => a.raw)
      });
      warnings.push('section_anchor_loss');
    }
  }
  const lengthGate = measureLengthCollapse(original, outputText, sourceAnchors.length);
  if (lengthGate.hardFail) {
    violations.push(lengthGate.violation);
    warnings.push('length_collapse');
  }
  const lostTerms = protectedTerms.filter(t => protectedTermMissing(t, outputText));
  if (lostTerms.length) {
    violations.push({ gate: 'protected_term_loss', terms: lostTerms.slice(0, 12) });
    warnings.push('protected_term_loss');
  }
  try {
    const floorViolations = floor.collectFloorViolations({
      result: { outputText },
      rawText: original,
      povSeed: contract.povSeed,
      optIn: false,
      mode,
      chunkLevel: true,
      allowedExtra: ''
    }) || [];
    violations.push(...floorViolations);
    const hard = floorViolations.find(isBlockingViolation);
    if (hard) {
      warnings.push(`floor_${hard.gate || hard.type || 'violation'}`);
      return { hardFail: true, reason: String(hard.gate || hard.type || 'floor_violation'), warnings, violations };
    }
  } catch (err) {
    violations.push({ gate: 'floor_check_error', detail: err && err.message || String(err) });
    warnings.push('floor_check_error');
  }
  if (normalizeBare(original).length > 120 && normalizeBare(original) === normalizeBare(outputText)) {
    warnings.push('noop_unchanged');
    violations.push({ gate: 'noop_unchanged', detail: 'output equivalent to source' });
    return { hardFail: true, reason: 'noop_unchanged', warnings, violations };
  }
  try {
    const outSurface = surfaceguard.buildSurfaceReport(outputText);
    const srcRatio = sourceSurface?.paragraphs?.abstractRiskRatio || 0;
    const outRatio = outSurface?.paragraphs?.abstractRiskRatio || 0;
    if (outRatio > srcRatio + 0.22 && outRatio >= 0.55) {
      warnings.push('surface_risk_regression');
      violations.push({ gate: 'surface_risk_regression', sourceRatio: srcRatio, outputRatio: outRatio });
    }
  } catch {}
  return { hardFail: false, reason: '', warnings, violations };
}

function evaluateWholeDocumentGate({ outputText, source, contract, mode, sourceSurface }) {
  const warnings = [];
  const violations = [];
  if (!outputText || looksLikeMeta(outputText)) {
    return { hardFail: true, reason: 'empty_or_meta_output', warnings, violations };
  }
  if (looksLikePromptLeak(outputText)) {
    return { hardFail: true, reason: 'prompt_instruction_leak', warnings, violations };
  }
  if (looksEncodingCorrupted(source, outputText)) {
    return { hardFail: true, reason: 'encoding_corruption', warnings, violations };
  }
  if (looksTruncated(outputText)) {
    return { hardFail: true, reason: 'sentence_truncated', warnings, violations };
  }
  const sourceAnchors = collectStructureAnchors(source);
  if (sourceAnchors.length >= 2) {
    const missingAnchors = sourceAnchors.filter(a => !structureAnchorPresent(a, outputText));
    if (missingAnchors.length) {
      violations.push({ gate: 'section_anchor_loss', missing: missingAnchors.slice(0, 12).map(a => a.raw) });
      warnings.push('section_anchor_loss');
    }
  }
  const lengthGate = measureLengthCollapse(source, outputText, sourceAnchors.length);
  if (lengthGate.hardFail) {
    violations.push(lengthGate.violation);
    warnings.push('length_collapse');
  }
  const protectedTerms = extractProtectedTerms(source);
  const lostTerms = protectedTerms.filter(t => protectedTermMissing(t, outputText));
  if (lostTerms.length) {
    violations.push({ gate: 'protected_term_loss', terms: lostTerms.slice(0, 16) });
    warnings.push('protected_term_loss');
  }
  if (normalizeBare(source).length > 120 && normalizeBare(source) === normalizeBare(outputText)) {
    warnings.push('noop_unchanged');
    violations.push({ gate: 'noop_unchanged', detail: 'final output equivalent to source' });
    return { hardFail: true, reason: 'noop_unchanged', warnings, violations };
  }
  try {
    const outSurface = surfaceguard.buildSurfaceReport(outputText);
    const srcRatio = sourceSurface?.paragraphs?.abstractRiskRatio || 0;
    const outRatio = outSurface?.paragraphs?.abstractRiskRatio || 0;
    if (outRatio > srcRatio + 0.22 && outRatio >= 0.55) {
      warnings.push('surface_risk_regression');
      violations.push({ gate: 'surface_risk_regression', sourceRatio: srcRatio, outputRatio: outRatio });
    }
  } catch {}
  return { hardFail: false, reason: '', warnings, violations };
}

function addFloorCriticals(report, violations, fallbackGate = 'gpt_final_gate_failed') {
  if (!report) return;
  const criticals = Array.isArray(report.criticals) ? report.criticals : [];
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  const additions = (violations || []).length
    ? violations.map(v => ({ ...v, gate: v.gate || v.type || fallbackGate, finalDocumentGate: true }))
    : [{ gate: fallbackGate, finalDocumentGate: true }];
  report.status = 'blocked';
  report.criticals = [...criticals, ...additions];
  report.warnings = [...warnings, ...additions.map(v => v.gate || v.type || fallbackGate)];
}

function addFloorWarnings(report, violations, warningGates = []) {
  if (!report) return;
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  const additions = (violations || []).map(v => ({ ...v, softenedFinalGate: true }));
  report.warnings = [
    ...warnings,
    ...warningGates,
    ...additions
  ];
  if (report.status === 'clean' && shouldPromoteWarningsToNeedsReview([...warningGates, ...additions])) {
    report.status = 'needs_review';
  }
}

function shouldPromoteWarningsToNeedsReview(items = []) {
  return (items || []).some(item => {
    const gate = typeof item === 'string'
      ? item
      : String(item?.gate || item?.type || item?.action || '').trim();
    return REVIEW_WARNING_GATES.has(gate);
  });
}

function isBlockingViolation(v) {
  const t = String(v?.type || v?.gate || '').toLowerCase();
  return /empty|meta_output|prompt_instruction_leak|encoding_corruption|sentence_truncated/.test(t);
}

function collectStructureAnchors(text) {
  const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const anchors = [];
  for (const line of lines) {
    if (line.length < 2 || line.length > 140) continue;
    let m = line.match(/^([ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]{1,4})\s*[.)．]?\s*(.{0,90})$/);
    if (m) {
      anchors.push(anchorOf(line, 'roman', m[1], m[2]));
      continue;
    }
    m = line.match(/^(\d{1,2})\s*[.)．]\s+(.{2,110})$/);
    if (m) {
      anchors.push(anchorOf(line, 'number', m[1], m[2]));
      continue;
    }
    m = line.match(/^(제\s?\d{1,3}\s?(?:장|절|항))\s+(.{2,100})$/);
    if (m) anchors.push(anchorOf(line, 'legal', m[1], m[2]));
  }
  return anchors.slice(0, 30);
}

function anchorOf(raw, type, marker, title) {
  const markerKey = normalizeBare(marker).replace(/[.)．]/g, '');
  const titleKey = normalizeBare(title).slice(0, 24);
  return { raw, type, marker: markerKey, titleKey };
}

function structureAnchorPresent(anchor, outputText) {
  const out = normalizeBare(outputText);
  if (anchor.titleKey && anchor.titleKey.length >= 6) return out.includes(anchor.titleKey);
  return out.includes(normalizeBare(anchor.raw));
}

function measureLengthCollapse(original, outputText, anchorCount = 0) {
  const sourceLen = normalizeBare(original).length;
  const outLen = normalizeBare(outputText).length;
  if (sourceLen < 700 || outLen <= 0) return { hardFail: false };
  const ratio = outLen / sourceLen;
  const minRatio = anchorCount >= 3 ? 0.78 : 0.65;
  if (ratio >= minRatio) return { hardFail: false };
  return {
    hardFail: true,
    violation: {
      gate: 'length_collapse',
      sourceLen,
      outLen,
      ratio: Number(ratio.toFixed(3)),
      minRatio
    }
  };
}

function isHighRiskChunk(text, protectedTerms, patchTargets, cfg, inputRisk) {
  const len = String(text || '').length;
  if (len >= (cfg.escalation.longTextChars || 10000)) return true;
  if ((protectedTerms || []).length >= (cfg.escalation.protectedTermThreshold || 40)) return true;
  if ((patchTargets || []).length >= (cfg.escalation.patchTargetThreshold || 12)) return true;
  if (inputRisk && inputRisk.grade === 'C' && len > 2000) return true;
  return false;
}

function extractProtectedTerms(text) {
  const s = String(text || '');
  const out = new Set();
  const patterns = [
    /\bhttps?:\/\/[^\s)]+/g,
    /\b\d{2,4}[.-]\d{1,2}[.-]\d{1,2}\b/g,
    /\b\d+(?:\.\d+)?\s?(?:%|원|만원|억원|조원|평|명|개|건|회|년|개월|일|시간|분|km|kg|g|cm|m)\b/g,
    /[A-Z][A-Za-z0-9&.-]{1,}(?:\s+[A-Z][A-Za-z0-9&.-]{1,}){0,3}/g,
    /[가-힣A-Za-z0-9]+(?:대학교|대학원|연구소|학회|기관|공사|공단|주식회사|택배|병원|유치원|어린이집|교육부|보건복지부|AWS|API)/g,
    /[가-힣A-Za-z0-9]{2,}(?:·[가-힣A-Za-z0-9]{2,}){1,}/g,
    /[가-힣A-Za-z0-9][가-힣A-Za-z0-9·\s-]{1,40}\([A-Za-z가-힣0-9][^)）]{1,40}\)/g,
    /[가-힣A-Za-z0-9·-]{2,}(?:시스템|기술|설비|기능|인프라|포털|터미널|플랫폼|데이터|API|AI|AWS)/g,
    /[가-힣]{2,}\(\d{4}\)/g
  ];
  for (const re of patterns) {
    for (const m of s.matchAll(re)) {
      addProtectedTerm(out, m[0]);
    }
  }
  return [...out].slice(0, 120);
}

function addProtectedTerm(out, raw) {
  for (const term of normalizeProtectedTermCandidate(raw)) {
    if (term.length >= 2 && term.length <= 80) out.add(term);
  }
}

function normalizeProtectedTermCandidate(raw) {
  const v = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!v || /[\r\n]/.test(String(raw || ''))) return [];
  const paren = v.match(/^(.+?)\(([^)）]{1,60})\)$/);
  if (paren) {
    const before = trimParenTermPrefix(paren[1]);
    const inside = String(paren[2] || '').trim();
    const out = [];
    if (isProtectedTermLike(inside)) out.push(inside);
    const combined = before ? `${before}(${inside})` : '';
    if (isProtectedTermLike(combined)) out.push(combined);
    return out;
  }
  return isProtectedTermLike(v) ? [v] : [];
}

function trimParenTermPrefix(value) {
  const words = String(value || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return '';
  let picked = words.slice(-4);
  while (picked.length > 1 && /(?:은|는|이|가|을|를|에서|으로|로|와|과|의|에)$/.test(picked[0])) {
    picked = picked.slice(1);
  }
  return picked.join(' ');
}

function isProtectedTermLike(value) {
  const v = String(value || '').replace(/\s+/g, ' ').trim();
  if (v.length < 2 || v.length > 80) return false;
  if (/[.!?。！？]/.test(v)) return false;
  const words = v.split(' ').filter(Boolean);
  if (words.length > 6) return false;
  if (v.length > 42 && /(?:은|는|이|가|을|를|에서|으로|로|와|과|의|에)\b/.test(v)) return false;
  if (v.length > 55 && !/[A-Z0-9%]/.test(v)) return false;
  return true;
}

function protectedTermMissing(term, outputText) {
  const t = String(term || '').replace(/\s+/g, ' ').trim();
  if (!isProtectedTermLike(t)) return false;
  const out = String(outputText || '');
  if (out.includes(t)) return false;
  const compactOut = normalizeBare(out);
  const compactTerm = normalizeBare(t);
  if (compactTerm.length >= 3 && compactOut.includes(compactTerm)) return false;
  const paren = t.match(/\(([^)）]{2,60})\)$/);
  if (paren) {
    const inner = String(paren[1] || '').trim();
    if (inner && (out.includes(inner) || normalizeBare(inner).length >= 3 && compactOut.includes(normalizeBare(inner)))) return false;
  }
  return true;
}

function buildPatchTargets(text, mode) {
  const s = String(text || '');
  const targets = [];
  const bad = mode === 'blog'
    ? ['조용히 쌓', '오래 버티', '흐려지고 맙니다', '집중적으로 잡', '언저리', '눌어붙어 있던 먼지']
    : ['비로소', '한층', '핵심 인프라', '자리한다', '무너지는 것은', '떠받치는'];
  for (const token of bad) {
    if (s.includes(token)) targets.push(`과한 표현 완화: ${token}`);
  }
  if ((s.match(/\n{3,}/g) || []).length) targets.push('과도한 빈 줄 정리');
  return targets;
}

function maxOutputTokensFor(text) {
  const chars = String(text || '').length;
  return Math.max(1200, Math.min(12000, Math.ceil(chars * 1.9)));
}

function shouldPassThrough(text) {
  const bare = String(text || '').replace(/\s+/g, '');
  return bare.length < 50 && !/[.!?…다요죠함임음까]$/.test(bare);
}

function sanitizeOutput(value) {
  return String(value || '')
    .trim()
    .replace(/^```(?:json|text|markdown)?\s*/i, '')
    .replace(/```$/i, '')
    .replace(/^(?:결과|출력|재작성\s*결과|변환\s*결과)\s*[:：]\s*/i, '')
    .trim();
}

function chunkPostprocess(text, original, mode, contract) {
  let out = String(text || '').trim();
  try { out = local.spacing.fixSpacing(out).text; } catch {}
  try { out = local.spacing.restoreUrls(out, original).text; } catch {}
  try { out = local.spacing.stripAiUrlParams(out).text; } catch {}
  try {
    const target = mode === 'blog'
      ? (contract.register === 'polite' ? 'hap' : contract.register === 'haeyo' ? 'haeyo' : null)
      : (contract.register === 'polite' ? 'hap' : contract.register === 'plain' ? 'handa' : contract.register === 'haeyo' ? 'haeyo' : null);
    if (target) out = local.registernormalize.normalizeRegister(out, target).text;
  } catch {}
  return out.trim();
}

const STRUCT_LINE_RE = /^\s*(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]\s*[.、)]|\d{1,2}(?!\d)\s*[.)]\s|\d{1,2}\.\d{1,2}|[가-하]\s*[.)]\s|[①②③④⑤⑥⑦⑧⑨⑩]|[-•*▪◦·]\s|\|.*\||제\s?\d{1,3}\s?(?:조|장|절|항))/;

function structJoinLocal(text) {
  const ls = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (!ls.length) return '';
  let acc = ls[0];
  for (let k = 1; k < ls.length; k += 1) {
    acc += '\n' + ls[k];
  }
  return acc;
}

function tidyParagraphsLocal(doc, source = '') {
  const blocks = String(doc || '').split(/\n{2,}/);
  const sourceParaCount = paragraphCount(source);
  const outputParaCount = blocks.map(b => b.trim()).filter(Boolean).length;
  return blocks.map((b, i) => {
    const t = b.trim();
    if (!t) return '';
    if (i === 0 && /\n\s*—/.test(b)) {
      return t.split('\n').map(l => l.trim()).filter(Boolean).join('\n');
    }
    if (sourceParaCount <= 1 && outputParaCount <= 1) return structJoinLocal(t);
    return t.split('\n').map(l => l.trim()).filter(Boolean).join('\n');
  }).filter(Boolean).join('\n\n');
}

function finalPostprocess(text, source, mode, contract) {
  let out = String(text || '').trim();
  try { out = tidyParagraphsLocal(out, source); } catch {}
  try { out = local.dedupe.dedupeSentences(out).text; } catch {}
  try {
    if (mode === 'blog') {
      const target = contract.register === 'polite' ? 'hap' : 'haeyo';
      out = local.basicblogtone.cleanupBasicBlogTone(out, { register: target }).text;
    }
  } catch {}
  try {
    const fc = local.flowcohesion.flowCohesion(out, { preserveParagraphs: true });
    out = fc.text || out;
  } catch {}
  try { out = local.spacing.restoreUrls(out, source).text; } catch {}
  return out.trim();
}

function paragraphCount(text) {
  return String(text || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean).length;
}

function buildResult({ source, outputText, contract, mode, records, inputRisk, niklQualityTest = false, qualityPatternLab = false, structureAudit = null }) {
  const result = {
    outputText,
    styleProfile: PROFILE,
    operation: 'humanize_only',
    contract,
    povSeed: contract.povSeed,
    records,
    inputRisk,
    structureLock: structureAudit || null
  };
  try { result.povDrift = floor.measurePovDrift(source, outputText, contract.povSeed); } catch {}
  try { result.floorNovelty = floor.measureNovelty(source, outputText, ''); } catch {}
  try { result.floorLength = floor.measureLength(source, outputText, mode); } catch {}
  try { result.repetition = floor.measureRepetition(outputText); } catch {}
  try { result.lostFacts = floor.measureLostFacts(source, outputText); } catch {}
  try { result.softDrift = local.softguard.measureSoftDrift(source, outputText); } catch {}
  try { result.conclusionDrift = local.softguard.measureConclusionDrift(source, outputText); } catch {}
  try { result.surface = surfaceguard.buildSurfaceReport(outputText); } catch {}
  try {
    result.noOpScore = local.outputguard.noOpScore(source, outputText);
    result.weakTransform = mode === 'polish' ? result.noOpScore >= 0.97 : result.noOpScore >= 0.88;
  } catch {}
  try { result.koreanQuality = compactKoreanQualityGate(koreanQuality.evaluateKoreanQuality(source, outputText, { mode, register: contract.register })); } catch {}
  try {
    result.floorReport = floor.buildFloorReport({
      result,
      rawText: source,
      mode,
      povSeed: contract.povSeed,
      optIn: false,
      allowedExtra: ''
    });
  } catch (err) {
    result.floorReport = {
      status: 'error',
      criticals: [{ gate: 'floor_report_error', detail: err && err.message || String(err) }],
      warnings: []
    };
  }
  attachKoreanQualityWarnings(result.floorReport, result.koreanQuality);
  if (niklQualityTest) {
    try {
      result.niklQualityTest = compactNiklQualityGate(safeNiklQualityGate(source, outputText, {
        mode,
        register: contract.register
      }));
    } catch {}
    result.niklQuality = result.niklQualityTest || null;
    attachNiklQualityWarnings(result.floorReport, result.niklQualityTest);
  }
  if (qualityPatternLab) {
    try {
      const protectedTerms = collectRecordProtectedTerms(records);
      const externalApiHintsUsed = records.some(r => r?.qualityPatternLab?.auditTrail?.externalApiHintsUsed === true);
      const audit = safeQualityPatternAudit(source, outputText, {
        mode,
        register: contract.register,
        protectedTerms,
        externalApiHintsUsed
      });
      const compact = compactQualityPatternAudit(audit);
      result.qualityPatternLab = {
        enabled: true,
        version: compact?.version || 'ko-quality-pattern-lab-v1',
        action: compact?.auditTrail?.action || 'pass',
        externalApiHintsUsed
      };
      result.qualityProfileBefore = compact?.qualityProfileBefore || null;
      result.qualityProfileAfter = compact?.qualityProfileAfter || null;
      result.patternDelta = compact?.patternDelta || null;
      result.auditTrail = compact?.auditTrail || null;
      result.protectedTermReport = compact?.protectedTermReport || null;
      result.claimStrengthDrift = compact?.claimStrengthDrift || null;
      result.rhetoricalInsertion = compact?.rhetoricalInsertion || null;
      result.grammarHardError = compact?.grammarHardError || null;
      result.externalApiHintsUsed = externalApiHintsUsed;
      attachQualityPatternWarnings(result.floorReport, compact);
    } catch {}
  }
  attachWeakTransformWarning(result.floorReport, result);
  if (qualityPatternLab) softenQualityPatternLabFloorReport(result.floorReport);
  softenFloorReport(result.floorReport);
  return result;
}

function attachKoreanQualityWarnings(report, quality) {
  if (!report || !quality || quality.action === 'pass') return;
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  report.warnings = [
    ...warnings,
    {
      gate: 'korean_quality_final',
      action: quality.action,
      reason: quality.reason || '',
      riskDelta: quality.riskDelta
    }
  ];
}

function attachNiklQualityWarnings(report, quality) {
  if (!report || !quality || quality.action === 'pass') return;
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  report.warnings = [
    ...warnings,
    {
      gate: 'nikl_quality',
      niklQuality: true,
      action: quality.action,
      reason: quality.reason,
      niklRiskDelta: quality.niklRiskDelta,
      beforeRisk: quality.beforeRisk,
      afterRisk: quality.afterRisk,
      missingTerms: quality.missingTerms || []
    }
  ];
}

function attachQualityPatternWarnings(report, audit) {
  if (!report || !audit || !audit.auditTrail) return;
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  const action = audit.auditTrail.action || 'pass';
  if (action === 'pass') return;
  const warningList = audit.auditTrail.warnings || [];
  report.warnings = [
    ...warnings,
    {
      gate: 'quality_pattern_lab',
      action,
      warnings: warningList,
      blockers: audit.auditTrail.blockers || [],
      riskDelta: audit.patternDelta?.riskDelta,
      protectedTermLossCount: audit.protectedTermReport?.lossCount || 0,
      grammarHardError: audit.grammarHardError?.introduced === true
    }
  ];
  if (report.status === 'clean') {
    report.status = action === 'blocked'
      ? 'blocked'
      : shouldPromoteWarningsToNeedsReview(warningList)
        ? 'needs_review'
        : report.status;
  }
}

function addStructureWarnings(report, audit) {
  if (!report || !audit) return;
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  const additions = [];
  if (audit.lostLockedCount > 0) {
    additions.push({
      gate: 'structure_lock_loss',
      action: 'needs_review',
      lostLockedCount: audit.lostLockedCount,
      lostLocked: audit.lostLocked || []
    });
  }
  if (audit.boundaryRepair?.applied) {
    additions.push({
      gate: 'chunk_boundary_repaired',
      action: 'pass',
      count: audit.boundaryRepair.count,
      repairs: audit.boundaryRepair.repairs || []
    });
  }
  if (audit.unsafeBoundaryCount > 0) {
    additions.push({
      gate: 'unsafe_chunk_boundary',
      action: 'needs_review',
      count: audit.unsafeBoundaryCount,
      samples: audit.unsafeBoundaries || []
    });
  }
  if (!additions.length) return;
  report.warnings = [...warnings, ...additions];
  if (report.status === 'clean' && additions.some(v => v.action === 'needs_review')) {
    report.status = 'needs_review';
  }
}

function attachWeakTransformWarning(report, result) {
  if (!report || !result || !result.weakTransform) return;
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  report.warnings = [
    ...warnings,
    {
      gate: 'weak_transform',
      noOpScore: Number(Number(result.noOpScore || 0).toFixed(3)),
      detail: 'output is close to source; delivered but should be monitored'
    }
  ];
}

function softenFloorReport(report) {
  if (!report || process.env.STRICT_QUALITY_GATE === '1') return report;
  if (report.status !== 'blocked') return report;
  const criticals = Array.isArray(report.criticals) ? report.criticals : [];
  if (process.env.GPT_SOFTEN_FLOOR_REPORT === '0') return report;
  if (hasStrictDeliveryCritical(criticals)) return report;
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  report.status = 'needs_review';
  report.warnings = [
    ...warnings,
    ...criticals.map(c => ({ ...c, softenedFromCritical: true }))
  ];
  report.criticals = [];
  return report;
}

function hasStrictDeliveryCritical(criticals) {
  return (criticals || []).some(c => {
    const gate = String(c?.gate || c?.type || '').trim();
    return STRICT_DELIVERY_GATES.has(gate) || isBlockingViolation(c);
  });
}

function chunkRecord({
  chunk,
  outputText,
  fallback = false,
  skipped = false,
  locked = false,
  lockType = '',
  escalated = false,
  error = null,
  hardFailReason = '',
  warnings = [],
  floorViolations = [],
  usage = null,
  elapsedMs = 0,
  editIntensity = null,
  changedSentenceRatio = null,
  protectedTerms = [],
  selectedModel = '',
  judgeReport = null,
  koreanQuality = null,
  niklQuality = null,
  qualityPatternLab = null
}) {
  return {
    index: chunk.index,
    position: chunk.position,
    inLen: chunk.text.length,
    outLen: String(outputText || '').length,
    fallback,
    skipped,
    locked,
    lockType,
    sectionPath: chunk.sectionPath || '',
    escalated,
    error,
    hardFailReason,
    warnings: Array.isArray(warnings) ? warnings : [],
    floorViolations,
    usage,
    elapsedMs,
    editIntensity,
    changedSentenceRatio,
    protectedTerms,
    judgeReport,
    koreanQuality,
    niklQuality,
    qualityPatternLab,
    selectedModel
  };
}

function deterministicDetectFallback(text, err) {
  const ir = safeInputRisk(text);
  const ratio = Number(ir?.abstractRiskRatio) || 0;
  const probability = Math.round(Math.min(92, Math.max(15, 22 + 70 * ratio)));
  return {
    probability,
    summary: 'LLM 판정이 실패해 로컬 표면 지표 기준으로 임시 추정했습니다.',
    detail: '문단의 추상성, 균일한 문장 구조, 구체 정보 밀도를 기준으로 계산한 내부 fallback 값입니다.',
    signals: ['local_surface_fallback'],
    confidence: 'low',
    gptMeta: {
      provider: 'openai',
      engine: VERSION,
      fallback: true,
      error: err && err.message || String(err)
    }
  };
}

function normalizeDetectResult(json) {
  const probability = Math.max(0, Math.min(100, Math.round(Number(json.probability) || 0)));
  return {
    probability,
    summary: String(json.summary || '').trim() || '분석 결과를 생성했습니다.',
    detail: String(json.detail || '').trim(),
    signals: Array.isArray(json.signals) ? json.signals.slice(0, 12) : [],
    confidence: ['low', 'medium', 'high'].includes(json.confidence) ? json.confidence : 'medium'
  };
}

function shouldEscalateDetect(out, source, cfg) {
  if (!cfg?.models?.detectEscalation || cfg.models.detectEscalation === cfg.models.detect) return false;
  const probability = Number(out?.probability);
  const signals = Array.isArray(out?.signals) ? out.signals.length : 0;
  if (out?.confidence === 'low') return true;
  if (Number.isFinite(probability) && probability >= 45 && probability <= 65 && signals < 3) return true;
  if (String(source || '').length >= 6000 && out?.confidence !== 'high') return true;
  return false;
}

function collectWebSearchUrls(raw) {
  const urls = new Set();
  const walk = (node, path = '') => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}.${i}`));
      return;
    }
    const type = String(node.type || node.kind || '').toLowerCase();
    const looksLikeSearchSource = /web|search|citation|annotation|source|result|reference/.test(path) ||
      /web|search|citation|annotation|source|result|reference/.test(type);
    for (const [key, value] of Object.entries(node)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (typeof value === 'string' && /url$/i.test(key) && /^https?:\/\//i.test(value) && looksLikeSearchSource) {
        const norm = normalizeEvidenceUrl(value);
        if (norm && !isUnsafeEvidenceUrl(norm)) urls.add(norm);
      } else {
        walk(value, nextPath);
      }
    }
  };
  walk(raw, '');
  urls.delete('');
  return urls;
}

function normalizeEvidenceUrl(url) {
  try {
    const u = new URL(String(url || '').trim());
    u.hash = '';
    u.search = '';
    return u.toString().replace(/\/+$/, '').toLowerCase();
  } catch {
    return '';
  }
}

function hasVerifiedUrl(url, verifiedUrls) {
  const norm = normalizeEvidenceUrl(url);
  if (!norm) return false;
  if (verifiedUrls.has(norm)) return true;
  for (const verified of verifiedUrls) {
    if (norm.startsWith(verified + '/') || verified.startsWith(norm + '/')) return true;
  }
  return false;
}

async function verifyEvidenceCandidates(candidates, parentSignal) {
  const out = [];
  for (const candidate of candidates.slice(0, 8)) {
    if (parentSignal?.aborted) throw new Error('aborted');
    const ok = await verifyEvidenceUrl(candidate.url, parentSignal);
    if (ok) out.push({ ...candidate, sourceVerified: true });
  }
  return out;
}

async function verifyEvidenceUrl(url, parentSignal) {
  if (await isUnsafeEvidenceFetchTarget(url)) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.GPT_EVIDENCE_URL_VERIFY_TIMEOUT_MS) || 6000);
  const onAbort = () => controller.abort();
  try {
    if (parentSignal) parentSignal.addEventListener('abort', onAbort, { once: true });
    let resp = await fetchEvidenceWithRedirects(url, 'HEAD', controller.signal);
    if (resp.status === 405 || resp.status === 403) {
      resp = await fetchEvidenceWithRedirects(url, 'GET', controller.signal);
    }
    return resp.status >= 200 && resp.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener('abort', onAbort);
  }
}

async function fetchEvidenceWithRedirects(url, method, signal) {
  let current = String(url || '').trim();
  for (let i = 0; i < 4; i += 1) {
    if (await isUnsafeEvidenceFetchTarget(current)) throw new Error('unsafe_evidence_url');
    const resp = await fetch(current, {
      method,
      redirect: 'manual',
      signal,
      headers: method === 'GET' ? { Range: 'bytes=0-2048' } : undefined
    });
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      if (!location) return resp;
      current = new URL(location, current).toString();
      continue;
    }
    return resp;
  }
  throw new Error('too_many_evidence_redirects');
}

function isUnsafeEvidenceUrl(url) {
  try {
    const u = new URL(String(url || '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
    const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (!host) return true;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
    if (host === 'metadata.google.internal') return true;
    const ipType = net.isIP(host);
    if (!ipType) return false;
    return isPrivateIp(host, ipType);
  } catch {
    return true;
  }
}

async function isUnsafeEvidenceFetchTarget(url) {
  if (isUnsafeEvidenceUrl(url)) return true;
  try {
    const u = new URL(String(url || '').trim());
    const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (net.isIP(host)) return false;
    const records = await dns.lookup(host, { all: true, verbatim: true });
    if (!records.length) return true;
    return records.some(r => {
      const ipType = net.isIP(r.address);
      return !ipType || isPrivateIp(r.address, ipType);
    });
  } catch {
    return true;
  }
}

function isPrivateIp(host, ipType) {
  if (ipType === 4) {
    const parts = host.split('.').map(n => Number(n));
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }
  const v = host.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
  if (v.startsWith('::ffff:')) return true;
  const mapped = v.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIp(mapped[1], 4);
  return false;
}

function metaFromResponse(res, cfg, extra = {}) {
  return {
    provider: 'openai',
    engine: VERSION,
    selectedModel: res.model,
    runtimeConfigSource: cfg.source,
    cachedInputTokens: res.usage?.cachedInputTokens || 0,
    reasoningTokens: res.usage?.reasoningTokens || 0,
    estimatedUsd: res.usage?.estimatedUsd || 0,
    usage: res.usage,
    ...extra
  };
}

function safeSurface(text) {
  try { return surfaceguard.buildSurfaceReport(text); } catch { return null; }
}

function safeInputRisk(text) {
  try { return surfaceguard.classifyInputRisk(text); } catch { return null; }
}

function safeKoreanQualityAnalysis(text, opts = {}) {
  try { return koreanQuality.analyzeText(text, opts); } catch { return null; }
}

function safeKoreanQualityHints(analysis) {
  try { return analysis ? koreanQuality.buildPromptHints(analysis, { max: 8 }) : ''; } catch { return ''; }
}

function safeKoreanQualityGate(source, output, opts = {}) {
  try { return koreanQuality.evaluateKoreanQuality(source, output, opts); } catch { return null; }
}

function safeNiklQualityAnalysis(text, opts = {}) {
  try { return koreanQuality.niklTest.analyzeNiklQuality(text, opts); } catch { return null; }
}

function safeNiklQualityHints(analysis) {
  try { return analysis ? koreanQuality.niklTest.buildNiklPromptHints(analysis, { max: 6 }) : ''; } catch { return ''; }
}

async function safeNiklExternalApiHints(text, protectedTerms = []) {
  try {
    if (process.env.GPT_NIKL_EXTERNAL_API_ENABLED === '0') return '';
    const api = koreanQuality.officialApi;
    const status = api.getApiStatus();
    const providers = selectedNiklApiProviders(status);
    if (!providers.length) return '';
    const max = Math.max(0, Math.min(6, Number(process.env.GPT_NIKL_API_LOOKUP_MAX || 4) || 4));
    if (!max) return '';
    const candidates = selectNiklApiCandidates(text, protectedTerms).slice(0, max);
    if (!candidates.length) return '';
    const timeoutMs = Math.max(500, Math.min(2500, Number(process.env.NIKL_API_TIMEOUT_MS || 1200) || 1200));
    const settled = await Promise.allSettled(candidates.map(query =>
      api.lookupCandidate(query, { providers, timeoutMs })
    ));
    const lookups = settled
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value)
      .filter(hasNiklLookupHit)
      .slice(0, max);
    if (!lookups.length) return '';
    const lines = [
      '[국립국어원 외부 API 조회 힌트]',
      '표준국어대사전/우리말샘/온용어 조회 결과다. 정의문을 복사하지 말고, 용어 표기 보존과 어색한 치환 방지에만 사용한다.',
      '조회된 용어는 원문 핵심 표기로 보아 임의로 쉬운 말이나 다른 용어로 바꾸지 않는다.'
    ];
    for (const item of lookups) lines.push(formatNiklLookupHint(item));
    return lines.join('\n');
  } catch {
    return '';
  }
}

function safeNiklQualityGate(source, output, opts = {}) {
  try { return koreanQuality.niklTest.evaluateNiklQuality(source, output, opts); } catch { return null; }
}

function safeQualityPatternProfile(text, opts = {}) {
  try { return koreanQuality.qualityPatternLab.buildQualityProfile(text, opts); } catch { return null; }
}

function safeQualityPatternHints(profile) {
  try { return profile ? koreanQuality.qualityPatternLab.buildPromptHints(profile, { max: 8 }) : ''; } catch { return ''; }
}

function safeQualityPatternAudit(source, output, opts = {}) {
  try { return koreanQuality.qualityPatternLab.buildAudit(source, output, opts); } catch { return null; }
}

function compactQualityPatternAudit(audit) {
  try { return koreanQuality.qualityPatternLab.compactAudit(audit); } catch { return null; }
}

function compactKoreanQualityGate(gate) {
  if (!gate) return null;
  return {
    action: gate.action,
    reason: gate.reason || '',
    koreanRiskDelta: gate.riskDelta,
    grammarHardDelta: gate.grammarHardDelta || 0,
    koreanSkillRisk: gate.output?.koreanSkillRisk,
    translationeseRisk: gate.output?.translationeseRisk,
    grammarRisk: gate.output?.grammarRisk,
    styleConsistencyRisk: gate.output?.styleConsistencyRisk,
    grade: gate.output?.grade,
    topKoreanPatterns: (gate.output?.topPatterns || []).slice(0, 8)
  };
}

function compactNiklQualityGate(gate) {
  try { return koreanQuality.niklTest.compactNiklReport(gate); } catch { return null; }
}

function collectRecordProtectedTerms(records = []) {
  const out = [];
  const seen = new Set();
  for (const record of records || []) {
    for (const term of record?.protectedTerms || []) {
      const value = String(term || '').trim();
      const key = value.toLowerCase();
      if (!value || seen.has(key)) continue;
      seen.add(key);
      out.push(value);
      if (out.length >= 160) return out;
    }
  }
  return out;
}

function softenQualityPatternLabFloorReport(report) {
  if (!report || report.status !== 'blocked') return report;
  const criticals = Array.isArray(report.criticals) ? report.criticals : [];
  if (!criticals.length) return report;
  const strict = criticals.filter(isQualityPatternStrictCritical);
  const soft = criticals.filter(c => !isQualityPatternStrictCritical(c));
  if (strict.length) {
    report.criticals = strict;
    if (soft.length) {
      report.warnings = [
        ...(Array.isArray(report.warnings) ? report.warnings : []),
        ...soft.map(c => ({ ...c, softenedFromCritical: true, qualityPatternLab: true }))
      ];
    }
    return report;
  }
  report.status = 'needs_review';
  report.warnings = [
    ...(Array.isArray(report.warnings) ? report.warnings : []),
    ...soft.map(c => ({ ...c, softenedFromCritical: true, qualityPatternLab: true }))
  ];
  report.criticals = [];
  return report;
}

function isQualityPatternStrictCritical(c) {
  const gate = String(c?.gate || c?.type || '').trim();
  return /empty|meta_output|prompt_instruction_leak|encoding_corruption|sentence_truncated/i.test(gate);
}

function compactRisk(inputRisk) {
  if (!inputRisk) return '';
  return JSON.stringify({
    risk: inputRisk.risk || 'ok',
    grade: inputRisk.grade || '',
    abstractRiskRatio: inputRisk.abstractRiskRatio,
    needsUserAnchor: inputRisk.needsUserAnchor === true
  });
}

function composeRiskProfile(inputRisk, koreanQualityHints, niklQualityHints = '') {
  const parts = [];
  const base = compactRisk(inputRisk);
  if (base) parts.push(base);
  if (koreanQualityHints) parts.push(koreanQualityHints);
  if (niklQualityHints) parts.push(niklQualityHints);
  return parts.join('\n\n');
}

function selectedNiklApiProviders(status) {
  const keys = status?.keys || {};
  const requested = String(process.env.GPT_NIKL_API_PROVIDERS || 'opendict,stdict,term')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);
  return requested.filter(p => ['opendict', 'stdict', 'term'].includes(p) && keys[p]);
}

function selectNiklApiCandidates(text, protectedTerms = []) {
  const out = new Set();
  const push = value => {
    const v = String(value || '')
      .replace(/\([^)]*\)/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[^가-힣A-Za-z0-9·\s-]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!v || v.length < 2 || v.length > 28) return;
    if (/^\d/.test(v) || /^[A-Za-z0-9 .-]+$/.test(v)) return;
    if (!/[가-힣]/.test(v)) return;
    out.add(v);
  };
  for (const term of protectedTerms || []) push(term);
  const source = String(text || '');
  const technical = source.match(/[가-힣A-Za-z0-9·-]{2,}(?:시스템|기술|설비|기능|인프라|플랫폼|데이터|과정|정책|이론|분석|서비스|교육|연구|관리|운영)/g) || [];
  for (const term of technical) push(term);
  const quoted = source.match(/[“"']([^“"']{2,24})[”"']/g) || [];
  for (const term of quoted) push(term.replace(/[“”"']/g, ''));
  return [...out].slice(0, 12);
}

function hasNiklLookupHit(item) {
  const providers = item?.providers || {};
  return Object.entries(providers).some(([name, p]) => {
    const hasItems = Array.isArray(p?.items) && p.items.length > 0;
    if (name === 'term') return hasItems;
    return hasItems || Number(p?.total || 0) > 0;
  });
}

function formatNiklLookupHint(item) {
  const providers = item?.providers || {};
  const sourceNames = [];
  const words = new Set();
  if (providers.opendict) {
    sourceNames.push('우리말샘');
    for (const v of providers.opendict.items || []) if (v.word) words.add(v.word);
  }
  if (providers.stdict) {
    sourceNames.push('표준국어대사전');
    for (const v of providers.stdict.items || []) if (v.word) words.add(v.word);
  }
  if (providers.term && Array.isArray(providers.term.items) && providers.term.items.length) {
    sourceNames.push('온용어');
    for (const v of providers.term.items || []) if (v.word) words.add(v.word);
  }
  const wordList = [...words].slice(0, 4).join(', ');
  return `- "${item.query}": ${sourceNames.join('/')} 조회됨${wordList ? `, 표기 후보 ${wordList}` : ''}`;
}

async function safeFormatLayout(text, opts = {}) {
  try {
    const source = String(text || '').trim();
    if (!source) return null;
    return await layoutNormalizer.formatDocument(source, {
      mode: opts.mode || 'assignment',
      phase: opts.phase || 'post',
      enableNlp: true,
      timeoutMs: Number(process.env.LAYOUT_NLP_TIMEOUT_MS || 5000) || 5000,
      maxChars: Number(process.env.LAYOUT_NLP_MAX_CHARS || 12000) || 12000
    });
  } catch (err) {
    logger.warn('gpt.layout_format_failed', {
      phase: opts.phase || 'post',
      err: err && err.message || String(err)
    });
    return null;
  }
}

function buildLayoutFormatMeta(preLayout, postLayout, rawSource, outputText) {
  const pre = preLayout?.report || null;
  const post = postLayout?.report || null;
  return {
    enabled: true,
    version: layoutNormalizer.VERSION,
    inputChanged: pre?.applied === true,
    outputChanged: post?.applied === true,
    sourceChanged: pre?.applied === true,
    finalOutputChanged: post?.applied === true,
    pre: compactLayoutReport(pre),
    post: compactLayoutReport(post),
    engines: mergeLayoutEngines(pre, post),
    beforeChars: String(rawSource || '').length,
    afterChars: String(outputText || '').length
  };
}

function compactLayoutReport(report) {
  if (!report) return null;
  return {
    phase: report.phase || '',
    profile: report.profile || '',
    applied: report.applied === true,
    need: report.need || null,
    before: report.before || null,
    after: report.after || null,
    gates: report.gates || null,
    spacingGate: report.spacingGate || null,
    nlp: report.nlp || null
  };
}

function mergeLayoutEngines(pre, post) {
  const names = ['kss', 'kiwipiepy', 'pykospacing'];
  const out = {};
  for (const name of names) {
    const p = pre?.nlp?.engines?.[name] || {};
    const q = post?.nlp?.engines?.[name] || {};
    out[name] = {
      ok: p.ok === true || q.ok === true,
      version: p.version || q.version || '',
      preOk: p.ok === true,
      postOk: q.ok === true,
      error: p.ok === true || q.ok === true ? '' : String(q.error || p.error || '').slice(0, 180)
    };
  }
  return out;
}

function looksLikeMeta(text) {
  return /^(죄송|I'?m sorry|As an AI|정책상|요청하신|변환 결과|재작성 결과)/i.test(String(text || '').trim());
}

function looksLikePromptLeak(text) {
  return /(재작성할\s*텍스트|작업\s*위치|본문이다\.\s*이\s*청크만\s*다듬는다|앞\s*문맥\s*-\s*참고만|뒤\s*문맥\s*-\s*참고만)/.test(String(text || ''));
}

function looksEncodingCorrupted(original, outputText) {
  const src = String(original || '');
  const out = String(outputText || '');
  if (!/[가-힣]/.test(src)) return false;
  const q = (out.match(/\?/g) || []).length;
  if (q >= 8 && q / Math.max(1, out.length) >= 0.08) return true;
  return /\?{2,}.*\?{2,}.*\?{2,}/.test(out);
}

function looksTruncated(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  if (/[,:;，、]$/.test(s)) return true;
  return /(?:그리고|그러나|하지만|또한|따라서|때문에|위해|통해|하며|하고)$/.test(s);
}

function normalizeBare(text) {
  return String(text || '').replace(/\s+/g, '').trim();
}

module.exports = {
  VERSION,
  PROFILE,
  run,
  detect,
  rewriteSentence,
  suggestEvidence,
  normalizeMode
};
