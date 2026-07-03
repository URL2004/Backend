'use strict';

const { completeJson, webSearchTool } = require('./openaiClient');
const { HUMANIZE_SCHEMA, DETECT_SCHEMA, REWRITE_SCHEMA, EVIDENCE_SCHEMA } = require('./schemas');
const prompts = require('./prompts');
const { addUsage, emptyUsage } = require('./usageCost');
const { buildContract } = require('../engine/contract');
const { splitChunks, mergeChunks } = require('../engine/chunk');
const floor = require('../engine/floor');
const surfaceguard = require('../engine/surfaceguard');
const gptRuntimeConfig = require('../lib/gptRuntimeConfig');
const { logger } = require('../lib/logger');

const VERSION = 'gpt-prod-operating-engine-v1';
const PROFILE = 'engine-gpt-prod';
const NO_DELIVERY_GATES = new Set([
  'gpt_all_chunks_fallback',
  'gpt_noop_unchanged',
  'noop_unchanged'
]);

function normalizeMode(mode) {
  const v = String(mode || '').trim().toLowerCase();
  if (v === 'blog' || v === 'basic') return 'blog';
  if (v === 'polish' || v === 'preserve') return 'polish';
  return 'assignment';
}

async function loadConfig(config) {
  return config ? gptRuntimeConfig.publicConfig(config, config.source || 'inline') : gptRuntimeConfig.getRuntimeConfig({ force: false });
}

async function run({ text, mode = 'assignment', lang = 'ko', userNotes = '', evidence = '', signal, config, styleProfile = '' } = {}) {
  const source = String(text || '').trim();
  if (!source) throw new Error('engine-gpt-prod: empty text');
  const cfg = await loadConfig(config);
  const selectedMode = normalizeMode(mode);
  const contract = buildContract(source, { mode: selectedMode, lang, optIn: !!String(userNotes || '').trim() });
  const inputRisk = safeInputRisk(source);
  const sourceSurface = safeSurface(source);
  const chunks = splitChunks(source);
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
      signal
    });
    records.push(record);
  }

  let outputText = mergeChunks(chunks);
  outputText = finalPostprocess(outputText, source, selectedMode, contract);
  const result = buildResult({ source, outputText, contract, mode: selectedMode, records, inputRisk });
  const fallbackCount = records.filter(r => r.fallback).length;
  const effectiveChunks = records.filter(r => !r.skipped).length;
  const allFallback = effectiveChunks > 0 && fallbackCount >= effectiveChunks;
  if (allFallback || normalizeBare(source) === normalizeBare(outputText)) {
    result.floorReport = result.floorReport || { status: 'blocked', criticals: [], warnings: [] };
    result.floorReport.status = 'blocked';
    result.floorReport.criticals = result.floorReport.criticals || [];
    result.floorReport.criticals.push({
      gate: allFallback ? 'gpt_all_chunks_fallback' : 'gpt_noop_unchanged',
      detail: allFallback ? 'All GPT chunks failed hard gates and fell back to source.' : 'GPT output is equivalent to source.'
    });
  }
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

async function processChunk({ chunk, chunks, index, source, contract, inputRisk, sourceSurface, mode, lang, userNotes, evidence, cfg, styleProfile, signal }) {
  const original = chunk.text;
  if (shouldPassThrough(original)) {
    chunk.outputText = original;
    return chunkRecord({ chunk, outputText: original, skipped: true });
  }
  const protectedTerms = extractProtectedTerms(original);
  const patchTargets = buildPatchTargets(original, mode);
  const highRisk = isHighRiskChunk(original, protectedTerms, patchTargets, cfg, inputRisk);
  const primaryReasoning = highRisk ? cfg.reasoning.factDense : cfg.reasoning.humanize;

  const first = await callHumanize({
    original,
    chunk,
    chunks,
    index,
    source,
    contract,
    inputRisk,
    sourceSurface,
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
    sourceSurface,
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
    cfg, model, reasoningEffort, phase, protectedTerms, patchTargets, styleProfile, runSemanticJudge, signal
  } = args;
  try {
    const hp = prompts.buildHumanizePrompt(mode, lang, {
      speakerType: contract.speakerType,
      register: contract.register,
      lengthPolicy: contract.lengthPolicy,
      styleProfile: styleProfile || PROFILE,
      userNotes,
      evidence,
      riskProfile: compactRisk(inputRisk)
    });
    const retryInstruction = phase === 'escalation' ? buildEscalationInstruction() : '';
    const response = await completeJson({
      system: [hp.stable, retryInstruction, hp.dynamic].filter(Boolean).join('\n\n'),
      user: prompts.buildHumanizeUser({ chunk, chunks, index, protectedTerms, patchTargets }),
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
        judgeViolations = (judgeReport.violations || []).map(v => ({
          gate: 'semanticJudge',
          type: v.type,
          span: v.span,
          detail: v.detail
        }));
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
    return {
      outputText,
      hardFail: gate.hardFail,
      record: chunkRecord({
        chunk,
        outputText: gate.hardFail ? original : outputText,
        fallback: gate.hardFail,
        error: gate.hardFail ? gate.reason : null,
        hardFailReason: gate.reason,
        warnings: [...(response.json.warnings || []), ...(judgeViolations.length ? ['gpt_semantic_judge_warning'] : []), ...gate.warnings],
        floorViolations: [...judgeViolations, ...gate.violations],
        usage: response.usage,
        elapsedMs: response.elapsedMs,
        editIntensity: response.json.editIntensity,
        protectedTerms: response.json.protectedTerms || protectedTerms,
        judgeReport,
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
    const res = await completeJson({
      system: prompts.buildDetectPrompt(lang),
      user,
      schema: DETECT_SCHEMA,
      schemaName: 'gpt_prod_detect_result',
      model: cfg.models.detect,
      reasoningEffort: cfg.reasoning.detect,
      verbosity: 'low',
      maxOutputTokens: 2200,
      config: cfg,
      signal,
      meta: { task: route, phase: 'detect:primary', mode: 'detect', profile: PROFILE }
    });
    const out = normalizeDetectResult(res.json);
    out.gptMeta = metaFromResponse(res, cfg, { task: route, escalated: false });
    return out;
  } catch (firstErr) {
    try {
      const res = await completeJson({
        system: prompts.buildDetectPrompt(lang),
        user,
        schema: DETECT_SCHEMA,
        schemaName: 'gpt_prod_detect_result',
        model: cfg.models.detectEscalation,
        reasoningEffort: cfg.reasoning.escalation,
        verbosity: 'low',
        maxOutputTokens: 2200,
        config: cfg,
        signal,
        meta: { task: route, phase: 'detect:escalation', mode: 'detect', profile: PROFILE, escalated: true }
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
    config: cfg,
    signal,
    meta: { task: 'evidence_search', phase, mode: 'evidence', profile: PROFILE, escalated: phase.includes('escalation') }
  });
  const verifiedUrls = collectWebSearchUrls(res.raw);
  const warnings = [...(res.json.warnings || [])];
  let candidates = (res.json.candidates || [])
    .map(c => ({ ...c, url: String(c.url || '').trim() }))
    .filter(c => /^https?:\/\//i.test(c.url))
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
      return { hardFail: true, reason: 'section_anchor_loss', warnings, violations };
    }
  }
  const lengthGate = measureLengthCollapse(original, outputText, sourceAnchors.length);
  if (lengthGate.hardFail) {
    violations.push(lengthGate.violation);
    warnings.push('length_collapse');
    return { hardFail: true, reason: 'length_collapse', warnings, violations };
  }
  const lostTerms = protectedTerms.filter(t => t.length >= 2 && !outputText.includes(t));
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
    if (hard) warnings.push(`floor_${hard.gate || hard.type || 'violation'}`);
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

function isBlockingViolation(v) {
  const t = String(v?.type || v?.gate || '').toLowerCase();
  return /novelty|lostfacts|pov|fabrication|evidence_pairing|fake_ref|coined_term|meta_leak|floor_check_error/.test(t);
}

function buildEscalationInstruction() {
  return [
    '[재시도 지시]',
    '1차 결과가 품질 게이트에 걸렸다. 원문 전체 구조와 모든 제목/번호 항목을 누락 없이 유지해서 다시 작성한다.',
    'Ⅰ/Ⅱ/Ⅲ, 1./2./3. 같은 제목 줄은 모두 출력에 포함한다. 제목을 삭제하거나 본문에 흡수하지 않는다.',
    '문단이나 항목을 요약해 합치지 않는다. 각 항목의 핵심 설명량을 원문과 비슷하게 유지한다.'
  ].join('\n');
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
    /[가-힣]{2,}\(\d{4}\)/g
  ];
  for (const re of patterns) {
    for (const m of s.matchAll(re)) {
      const v = String(m[0] || '').trim();
      if (v.length >= 2 && v.length <= 80) out.add(v);
    }
  }
  return [...out].slice(0, 120);
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
  try { out = require('../engine/spacing').fixSpacing(out).text; } catch {}
  try { out = require('../engine/spacing').restoreUrls(out, original).text; } catch {}
  try { out = require('../engine/spacing').stripAiUrlParams(out).text; } catch {}
  try {
    const target = mode === 'blog'
      ? (contract.register === 'polite' ? 'hap' : contract.register === 'haeyo' ? 'haeyo' : null)
      : (contract.register === 'polite' ? 'hap' : contract.register === 'plain' ? 'handa' : contract.register === 'haeyo' ? 'haeyo' : null);
    if (target) out = require('../engine/registernormalize').normalizeRegister(out, target).text;
  } catch {}
  return out.trim();
}

const STRUCT_LINE_RE = /^\s*(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]\s*[.、)]|\d{1,2}(?!\d)\s*[.)]\s|\d{1,2}\.\d{1,2}|[가-하]\s*[.)]\s|[①②③④⑤⑥⑦⑧⑨⑩]|[-•*▪◦·]\s|\|.*\||제\s?\d{1,3}\s?(?:조|장|절|항))/;

function structJoinLocal(text) {
  const ls = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (!ls.length) return '';
  let acc = ls[0];
  for (let k = 1; k < ls.length; k += 1) {
    const keepNl = STRUCT_LINE_RE.test(ls[k]) || STRUCT_LINE_RE.test(ls[k - 1]);
    acc += (keepNl ? '\n' : ' ') + ls[k];
  }
  return acc;
}

function tidyParagraphsLocal(doc) {
  const blocks = String(doc || '').split(/\n{2,}/);
  return blocks.map((b, i) => {
    const t = b.trim();
    if (!t) return '';
    if (i === 0 && /\n\s*—/.test(b)) {
      return t.split('\n').map(l => l.trim()).filter(Boolean).join('\n');
    }
    return structJoinLocal(t);
  }).filter(Boolean).join('\n\n');
}

function finalPostprocess(text, source, mode, contract) {
  let out = String(text || '').trim();
  try { out = tidyParagraphsLocal(out); } catch {}
  try { out = require('../engine/dedupe').dedupeSentences(out).text; } catch {}
  try {
    if (mode === 'blog') {
      const target = contract.register === 'polite' ? 'hap' : 'haeyo';
      out = require('../engine/basicblogtone').cleanupBasicBlogTone(out, { register: target }).text;
    }
  } catch {}
  try { out = require('../engine/flowcohesion').flowCohesion(out).text || out; } catch {}
  try { out = require('../engine/spacing').restoreUrls(out, source).text; } catch {}
  return out.trim();
}

function buildResult({ source, outputText, contract, mode, records, inputRisk }) {
  const result = {
    outputText,
    styleProfile: PROFILE,
    operation: 'humanize_only',
    contract,
    povSeed: contract.povSeed,
    records,
    inputRisk
  };
  try { result.povDrift = floor.measurePovDrift(source, outputText, contract.povSeed); } catch {}
  try { result.floorNovelty = floor.measureNovelty(source, outputText, ''); } catch {}
  try { result.floorLength = floor.measureLength(source, outputText, mode); } catch {}
  try { result.repetition = floor.measureRepetition(outputText); } catch {}
  try { result.lostFacts = floor.measureLostFacts(source, outputText); } catch {}
  try { result.softDrift = require('../engine/softguard').measureSoftDrift(source, outputText); } catch {}
  try { result.conclusionDrift = require('../engine/softguard').measureConclusionDrift(source, outputText); } catch {}
  try { result.surface = surfaceguard.buildSurfaceReport(outputText); } catch {}
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
  softenFloorReport(result.floorReport);
  return result;
}

function softenFloorReport(report) {
  if (!report || process.env.STRICT_QUALITY_GATE === '1') return report;
  if (report.status !== 'blocked') return report;
  const criticals = Array.isArray(report.criticals) ? report.criticals : [];
  if (hasNoDeliveryCritical(criticals)) return report;
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  report.status = 'needs_review';
  report.warnings = [
    ...warnings,
    ...criticals.map(c => ({ ...c, softenedFromCritical: true }))
  ];
  report.criticals = [];
  return report;
}

function hasNoDeliveryCritical(criticals) {
  return (criticals || []).some(c => NO_DELIVERY_GATES.has(String(c?.gate || c?.type || '').trim()));
}

function chunkRecord({
  chunk,
  outputText,
  fallback = false,
  skipped = false,
  escalated = false,
  error = null,
  hardFailReason = '',
  warnings = [],
  floorViolations = [],
  usage = null,
  elapsedMs = 0,
  editIntensity = null,
  protectedTerms = [],
  selectedModel = '',
  judgeReport = null
}) {
  return {
    index: chunk.index,
    position: chunk.position,
    inLen: chunk.text.length,
    outLen: String(outputText || '').length,
    fallback,
    skipped,
    escalated,
    error,
    hardFailReason,
    warnings: Array.isArray(warnings) ? warnings : [],
    floorViolations,
    usage,
    elapsedMs,
    editIntensity,
    protectedTerms,
    judgeReport,
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
        urls.add(normalizeEvidenceUrl(value));
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

function evidenceHost(url) {
  try { return new URL(String(url || '')).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
}

function hasVerifiedUrl(url, verifiedUrls) {
  const norm = normalizeEvidenceUrl(url);
  if (!norm) return false;
  if (verifiedUrls.has(norm)) return true;
  const host = evidenceHost(norm);
  for (const verified of verifiedUrls) {
    if (norm.startsWith(verified + '/') || verified.startsWith(norm + '/')) return true;
    const vh = evidenceHost(verified);
    if (host && vh && host === vh) return true;
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.GPT_EVIDENCE_URL_VERIFY_TIMEOUT_MS) || 6000);
  const onAbort = () => controller.abort();
  try {
    if (parentSignal) parentSignal.addEventListener('abort', onAbort, { once: true });
    let resp = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    if (resp.status === 405 || resp.status === 403) {
      resp = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { Range: 'bytes=0-2048' }
      });
    }
    return resp.status >= 200 && resp.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener('abort', onAbort);
  }
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

function compactRisk(inputRisk) {
  if (!inputRisk) return '';
  return JSON.stringify({
    risk: inputRisk.risk || 'ok',
    grade: inputRisk.grade || '',
    abstractRiskRatio: inputRisk.abstractRiskRatio,
    needsUserAnchor: inputRisk.needsUserAnchor === true
  });
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
