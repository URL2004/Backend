'use strict';

const { completeJson, modelFor } = require('./llm');
const { OUTPUT_SCHEMA } = require('./schema');
const { buildGptSystemPrompt } = require('./prompt');
const { buildContract } = require('../engine/contract');
const { splitChunks, mergeChunks } = require('../engine/chunk');
const floor = require('../engine/floor');
const surfaceguard = require('../engine/surfaceguard');

const VERSION = 'gpt-openai-humanize-engine-v1';
const PROFILE = 'gpt_engine';

function normalizeMode(mode) {
  const v = String(mode || '').trim().toLowerCase();
  if (v === 'blog') return 'blog';
  if (v === 'polish') return 'polish';
  return 'assignment';
}

async function run({ text, mode = 'assignment', lang = 'ko', userNotes = '', evidence = '', signal, model } = {}) {
  const source = String(text || '').trim();
  if (!source) throw new Error('gpt_engine: empty text');
  if (!process.env.OPENAI_API_KEY) throw new Error('gpt_engine: OPENAI_API_KEY is not configured');
  const engineMode = normalizeMode(mode);
  const contract = buildContract(source, { mode: engineMode, lang, optIn: !!String(userNotes || '').trim() });
  const chunks = splitChunks(source);
  const records = [];

  for (let i = 0; i < chunks.length; i++) {
    const record = await processChunk({
      chunk: chunks[i],
      chunks,
      index: i,
      source,
      contract,
      mode: engineMode,
      lang,
      userNotes,
      evidence,
      signal,
      model
    });
    records.push(record);
  }

  let outputText = mergeChunks(chunks);
  outputText = finalPostprocess(outputText, source, engineMode, contract);
  const fallbackCount = records.filter(r => r.fallback).length;
  const effectiveChunks = records.filter(r => !r.skipped).length;
  if (effectiveChunks > 0 && fallbackCount >= effectiveChunks) {
    throw new Error('gpt_engine: all GPT chunks failed');
  }

  const result = buildResult({ source, outputText, contract, mode: engineMode, records });
  if (normalizeBare(source) === normalizeBare(outputText)) {
    result.floorReport = result.floorReport || { status: 'blocked', criticals: [], warnings: [] };
    result.floorReport.status = 'blocked';
    result.floorReport.criticals = result.floorReport.criticals || [];
    result.floorReport.criticals.push({ gate: 'noop_unchanged', detail: 'GPT engine returned text equivalent to the source.' });
  }
  result.humanizeMeta = {
    ...(result.humanizeMeta || {}),
    provider: 'openai',
    model: model || modelFor('main'),
    engine: VERSION,
    profile: PROFILE,
    chunkCount: records.length,
    fallbackCount,
    usage: sumUsage(records)
  };

  return {
    result,
    surface: result.surface,
    inputRisk: result.inputRisk,
    mode: engineMode,
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

async function processChunk({ chunk, chunks, index, source, contract, mode, lang, userNotes, evidence, signal, model }) {
  const original = chunk.text;
  if (shouldPassThrough(original)) {
    chunk.outputText = original;
    return chunkRecord({ chunk, outputText: original, skipped: true });
  }

  const prompt = buildGptSystemPrompt(mode, lang, {
    speakerType: contract.speakerType,
    register: contract.register,
    lengthPolicy: contract.lengthPolicy,
    styleProfile: PROFILE,
    userNotes,
    evidence
  });
  const system = [prompt.stable, prompt.volatile].filter(Boolean).join('\n\n');
  const user = buildUserPrompt({ chunk, chunks, index, lang });

  try {
    const response = await completeJson({
      system,
      user,
      schema: OUTPUT_SCHEMA,
      schemaName: 'gpt_humanize_result',
      model,
      modelKind: modelKindFor({ mode, text: original }),
      maxOutputTokens: maxOutputTokensFor(original),
      reasoningEffort: process.env.OPENAI_REASONING_HUMANIZE || process.env.OPENAI_REASONING_MAIN || 'low',
      signal,
      meta: {
        task: 'admin_gpt_humanize',
        phase: 'chunk:main',
        mode,
        profile: PROFILE,
        chunkIndex: index
      }
    });
    let outputText = sanitizeOutput(response.json.outputText);
    if (!outputText || looksLikeMeta(outputText)) throw new Error('empty_or_meta_output');
    outputText = chunkPostprocess(outputText, original, mode, contract);

    const violations = collectChunkViolations(outputText, original, contract, mode);
    const blocking = violations.filter(isBlockingViolation);
    if (blocking.length) {
      chunk.outputText = original;
      return chunkRecord({
        chunk,
        outputText: original,
        fallback: true,
        error: 'floor_violation:' + blocking.map(v => v.type || v.gate).join(','),
        warnings: response.json.warnings,
        floorViolations: violations,
        usage: response.usage,
        elapsedMs: response.elapsedMs
      });
    }

    chunk.outputText = outputText;
    return chunkRecord({
      chunk,
      outputText,
      warnings: response.json.warnings,
      floorViolations: violations,
      usage: response.usage,
      elapsedMs: response.elapsedMs,
      editIntensity: response.json.editIntensity,
      protectedTerms: response.json.protectedTerms
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    chunk.outputText = original;
    return chunkRecord({
      chunk,
      outputText: original,
      fallback: true,
      error: err && err.message || String(err),
      warnings: ['gpt_call_failed']
    });
  }
}

function buildUserPrompt({ chunk, chunks, index }) {
  const prev = index > 0 ? chunks[index - 1].text : '';
  const next = index < chunks.length - 1 ? chunks[index + 1].text : '';
  const boundary = [
    prev ? `[앞 문맥 - 참고만 하고 다시 쓰지 말 것]\n...${tail(prev, 160)}` : '',
    next ? `[뒤 문맥 - 참고만 하고 손대지 말 것]\n${head(next, 120)}...` : ''
  ].filter(Boolean).join('\n\n');
  const pos = chunk.position === 'conclusion'
    ? '이 청크는 결론부다. 앞 내용을 반복 요약하지 말고, 원문 결론 방향만 유지한다.'
    : chunk.position === 'intro'
      ? '이 청크는 도입부다. 원문의 시작 방식과 화자를 유지한다.'
      : '이 청크는 본문이다. 이 부분만 다듬는다.';
  return [boundary, `[작업 위치]\n${pos}`, `[재작성할 텍스트 - 이 청크만]\n${chunk.text}`].filter(Boolean).join('\n\n');
}

function maxOutputTokensFor(text) {
  const chars = String(text || '').length;
  return Math.max(1200, Math.min(8192, Math.ceil(chars * 1.8)));
}

function modelKindFor({ mode, text }) {
  if (process.env.OPENAI_FORCE_FAST_HUMANIZE === '1') return 'fast';
  if (mode === 'polish') return 'fast';
  const fastMax = Number(process.env.OPENAI_FAST_MAX_CHARS) || 0;
  if (fastMax > 0 && String(text || '').length <= fastMax) return 'fast';
  return 'main';
}

function shouldPassThrough(text) {
  const bare = String(text || '').replace(/\s+/g, '');
  return bare.length < 60 && !/[.!?…다요죠함임음까]$/.test(bare);
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
  let out = text;
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

function finalPostprocess(text, source, mode, contract) {
  let out = text;
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

function collectChunkViolations(outputText, rawText, contract, mode) {
  try {
    return floor.collectFloorViolations({
      result: { outputText },
      rawText,
      povSeed: contract.povSeed,
      optIn: false,
      mode,
      chunkLevel: true,
      allowedExtra: ''
    }) || [];
  } catch (err) {
    return [{ type: 'floor_check_error', detail: err && err.message || String(err) }];
  }
}

function isBlockingViolation(v) {
  const t = String(v?.type || v?.gate || '');
  return /novelty|lostFacts|pov|fabrication|evidence_pairing|floor_check_error/i.test(t);
}

function buildResult({ source, outputText, contract, mode, records }) {
  const result = {
    outputText,
    styleProfile: PROFILE,
    operation: 'humanize_only',
    contract,
    povSeed: contract.povSeed,
    records
  };
  try { result.povDrift = floor.measurePovDrift(source, outputText, contract.povSeed); } catch {}
  try { result.floorNovelty = floor.measureNovelty(source, outputText, ''); } catch {}
  try { result.floorLength = floor.measureLength(source, outputText, mode); } catch {}
  try { result.repetition = floor.measureRepetition(outputText); } catch {}
  try { result.lostFacts = floor.measureLostFacts(source, outputText); } catch {}
  try { result.softDrift = require('../engine/softguard').measureSoftDrift(source, outputText); } catch {}
  try { result.conclusionDrift = require('../engine/softguard').measureConclusionDrift(source, outputText); } catch {}
  try { result.surface = surfaceguard.buildSurfaceReport(outputText); } catch {}
  try { result.inputRisk = surfaceguard.classifyInputRisk(source); } catch {}
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
  return result;
}

function chunkRecord({ chunk, outputText, fallback = false, skipped = false, error = null, warnings = [], floorViolations = [], usage = null, elapsedMs = 0, editIntensity = null, protectedTerms = [] }) {
  return {
    index: chunk.index,
    position: chunk.position,
    inLen: chunk.text.length,
    outLen: String(outputText || '').length,
    fallback,
    skipped,
    error,
    warnings: Array.isArray(warnings) ? warnings : [],
    floorViolations,
    usage,
    elapsedMs,
    editIntensity,
    protectedTerms
  };
}

function sumUsage(records) {
  return records.reduce((acc, r) => {
    const u = r.usage || {};
    acc.inputTokens += u.inputTokens || 0;
    acc.cachedInputTokens += u.cachedInputTokens || 0;
    acc.outputTokens += u.outputTokens || 0;
    acc.reasoningTokens += u.reasoningTokens || 0;
    acc.totalTokens += u.totalTokens || 0;
    return acc;
  }, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 });
}

function looksLikeMeta(text) {
  return /^(죄송|I'?m sorry|As an AI|정책상|요청하신)/i.test(String(text || '').trim()) ||
    /(재작성할\s*텍스트|작업\s*위치|본문이다\.\s*이\s*부분만\s*다듬는다|앞\s*문맥\s*-\s*참고만|뒤\s*문맥\s*-\s*참고만)/.test(String(text || ''));
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
    if (i === 0 && /\n\s*—/.test(b)) return t.split('\n').map(l => l.trim()).filter(Boolean).join('\n');
    return structJoinLocal(t);
  }).filter(Boolean).join('\n\n');
}

function normalizeBare(text) {
  return String(text || '').replace(/\s+/g, '').trim();
}

const tail = (s, n) => String(s || '').slice(-n);
const head = (s, n) => String(s || '').slice(0, n);

module.exports = { run, VERSION, PROFILE };
