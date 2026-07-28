'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../config');
const { logger } = require('../lib/logger');
const gptRuntimeConfig = require('../lib/gptRuntimeConfig');
const engine = require('../engine-gpt-prod/copykillerTestEngine');

const MAX_CHARS = Number(process.env.COPYKILLER_TEST_MAX_CHARS || 30000);

router.use('/local', localOnly);

router.get('/local/copykiller-humanize/health', async (req, res) => {
  const cfg = await gptRuntimeConfig.getRuntimeConfig({ db, logger });
  res.json({
    ok: true,
    version: engine.VERSION,
    activeProvider: cfg.activeProvider,
    model: cfg.models?.humanizePrimary,
    runtimeConfigSource: cfg.source,
    maxChars: MAX_CHARS
  });
});

router.post('/local/copykiller-humanize', async (req, res) => {
  const text = String(req.body && req.body.text || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'text is required' });
  if (text.length > MAX_CHARS) {
    return res.status(400).json({
      ok: false,
      error: `text is too long for local copykiller test route (${text.length}/${MAX_CHARS})`
    });
  }

  const cfg = await gptRuntimeConfig.getRuntimeConfig({ db, logger });
  if (!gptRuntimeConfig.isGptActive(cfg)) {
    return res.status(503).json({
      ok: false,
      error: 'GPT runtime is not active',
      activeProvider: cfg.activeProvider
    });
  }

  const startedAt = Date.now();
  try {
    const out = await engine.run({
      text,
      mode: req.body.mode || 'assignment',
      lang: req.body.lang || 'ko',
      model: cleanModel(req.body.model),
      variants: req.body.variants,
      rounds: req.body.rounds,
      strength: req.body.strength || 'ck-safe',
      config: cfg
    });
    logger.info('local_copykiller_humanize.done', {
      textLength: text.length,
      outputLength: out.outputText.length,
      elapsedMs: Date.now() - startedAt,
      model: out.meta?.selectedModel,
      copykillerRisk: out.copykillerProxy?.copykillerRisk,
      semanticScore: out.copykillerProxy?.semanticScore,
      chunkCount: out.meta?.chunkCount
    });
    res.json({
      ok: true,
      elapsedMs: Date.now() - startedAt,
      outputText: out.outputText,
      copykillerProxy: out.copykillerProxy,
      meta: out.meta,
      chunks: out.chunks,
      warnings: out.warnings
    });
  } catch (err) {
    logger.error('local_copykiller_humanize.failed', {
      err,
      textLength: text.length,
      elapsedMs: Date.now() - startedAt
    });
    res.status(500).json({
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: err && err.message || String(err)
    });
  }
});

router.post('/local/copykiller-score', (req, res) => {
  const source = String(req.body && (req.body.source || req.body.text) || '');
  const outputText = String(req.body && (req.body.outputText || req.body.output || req.body.result) || '');
  const mode = req.body && req.body.mode || 'assignment';
  if (!source || !outputText) {
    return res.status(400).json({ ok: false, error: 'source and outputText are required' });
  }
  const sourceBaselineProxy = engine.scorePair(source, source, { mode });
  res.json({
    ok: true,
    version: engine.VERSION,
    sourceBaselineProxy,
    copykillerProxy: engine.scorePair(source, outputText, { sourceBaselineRisk: sourceBaselineProxy.copykillerRisk, mode }),
    protectedTerms: engine.extractProtectedTerms(source).slice(0, 80)
  });
});

function cleanModel(value) {
  const v = String(value || '').trim();
  if (!v) return undefined;
  return v.replace(/[^\w.:/-]/g, '').slice(0, 80) || undefined;
}

function localOnly(req, res, next) {
  if (!isProductionRuntime() && isLocalRequest(req)) return next();
  return res.status(404).json({ ok: false, error: 'not found' });
}

function isLocalRequest(req) {
  const values = [
    req.socket && req.socket.remoteAddress,
    req.connection && req.connection.remoteAddress
  ].filter(Boolean).map(v => String(v).toLowerCase());
  return values.some(v =>
    v === 'localhost' ||
    v === '127.0.0.1' ||
    v === '::1' ||
    v === '::ffff:127.0.0.1' ||
    v.endsWith(':127.0.0.1')
  );
}

function isProductionRuntime() {
  return process.env.NODE_ENV === 'production'
    || process.env.RENDER === 'true'
    || Boolean(process.env.RENDER_SERVICE_ID);
}

module.exports = router;
