'use strict';

// Detect-only API. Humanizing is intentionally available only through
// /transform, which owns queueing, delivery policy, and billing semantics.
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { db } = require('../config');
const { logger, setLogContext } = require('../lib/logger');
const { bearerToken } = require('../lib/reqtoken');
const detectCalibration = require('../lib/detectCalibration');
const { applyDetectNarrativePolicy } = require('../lib/detectNarrativePolicy');
const gptRuntimeConfig = require('../lib/gptRuntimeConfig');
const gptAnalyze = require('./analyze-gpt');
const billing = require('../lib/usageBilling');
const history = require('../lib/historyService');

const recentSubmits = new Map();
const SUBMIT_DEDUP_WINDOW_MS = process.env.DEDUP_WINDOW_MS != null
  ? Math.max(0, Number(process.env.DEDUP_WINDOW_MS) || 0)
  : 20000;

const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - Math.max(SUBMIT_DEDUP_WINDOW_MS, 60000);
  for (const [key, timestamp] of recentSubmits) {
    if (timestamp < cutoff) recentSubmits.delete(key);
  }
}, 60000);
if (cleanupTimer.unref) cleanupTimer.unref();

async function activeGptConfig() {
  const config = await gptRuntimeConfig.getRuntimeConfig({ db, logger });
  if (!gptRuntimeConfig.isGptActive(config)) {
    const error = new Error('GPT_PROVIDER_UNAVAILABLE');
    error.code = 'GPT_PROVIDER_UNAVAILABLE';
    throw error;
  }
  return config;
}

function requestIdOf(body = {}) {
  return typeof body.requestId === 'string' && body.requestId.trim()
    ? body.requestId.trim().slice(0, 80).replace(/[^A-Za-z0-9:_-]/g, '')
    : null;
}

function normalizeDetectInput(rawText) {
  let text = String(rawText || '');
  if (process.env.INPUT_REJOIN !== '0') {
    try {
      const joined = require('../engine/inputrouting').rejoinSplitChars(text);
      if (joined.changed) text = joined.text;
    } catch (error) {
      logger.warn('analyze.input_rejoin_failed', { err: error?.message });
    }
  }
  if (process.env.STRIP_AI_URL !== '0') {
    try {
      text = require('../engine/spacing').stripAiUrlParams(text).text;
    } catch (error) {
      logger.warn('analyze.input_ai_url_strip_failed', { err: error?.message });
    }
  }
  return text;
}

function duplicateKey(uid, text) {
  return `${uid}:detect:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

function rejectLegacyHumanize(req, res) {
  logger.warn('analyze.legacy_humanize_rejected', {
    mode: req.body?.mode == null ? null : String(req.body.mode).slice(0, 40)
  });
  return res.status(410).json({
    error: '휴머나이징 요청 경로가 변경되었습니다. 새 변환 화면에서 다시 시작해 주세요.',
    code: 'HUMANIZE_MOVED',
    route: '/transform',
    allowedModes: ['blog', 'polish', 'formal']
  });
}

router.post('/analyze', async (req, res) => {
  if (req.body?.mode !== 'detect') return rejectLegacyHumanize(req, res);

  const billingMode = req.body?.billingMode === 'coupon' ? 'coupon' : 'credit';
  const lang = req.body?.lang === 'en' ? 'en' : 'ko';
  const requestId = requestIdOf(req.body);
  const previousContext = typeof req.body?.prevContext === 'string'
    ? req.body.prevContext.trim().slice(-300)
    : '';
  const text = normalizeDetectInput(req.body?.text);
  if (text.length < 5) return res.status(400).json({ error: '텍스트가 너무 짧습니다.' });
  const hardMax = billingMode === 'coupon' ? 50000 : 30000;
  if (text.length > hardMax) {
    return res.status(400).json({ error: `텍스트가 너무 깁니다. (최대 ${hardMax.toLocaleString()}자)` });
  }

  const abortController = new AbortController();
  res.once('close', () => {
    if (!res.writableEnded) abortController.abort();
  });
  const devNoAuth = !process.env.FIREBASE_SERVICE_ACCOUNT && process.env.DEV_NO_AUTH === '1';
  const needed = billingMode === 'coupon' ? 1 : Math.ceil(text.length / 100);
  const idToken = bearerToken(req);
  let precheck;
  try {
    precheck = devNoAuth
      ? { uid: 'dev-local', plan: 'unlimited' }
      : billingMode === 'coupon'
        ? await billing.precheckCoupon(idToken, text.length)
        : await billing.precheckCredits(idToken, needed);
  } catch (error) {
    return res.status(error.status || 500).json({
      error: billing.authErrorMessage(error.message),
      ...(error.charLimit !== undefined ? { charLimit: error.charLimit } : {})
    });
  }
  setLogContext({ uid: precheck.uid });

  const dedupKey = duplicateKey(precheck.uid, text);
  if (!devNoAuth && SUBMIT_DEDUP_WINDOW_MS > 0) {
    const last = recentSubmits.get(dedupKey);
    if (last && Date.now() - last < SUBMIT_DEDUP_WINDOW_MS) {
      return res.status(429).json({
        error: '같은 내용을 방금 처리 중이거나 처리했어요. 잠시 후 다시 시도해 주세요. (중복 차감 방지)',
        duplicate: true
      });
    }
    recentSubmits.set(dedupKey, Date.now());
  }
  const clearDedup = () => recentSubmits.delete(dedupKey);

  let result;
  try {
    const config = await activeGptConfig();
    const detectInput = previousContext
      ? `[앞 청크의 마지막 일부 — 문맥 참고용, 점수에서 제외]\n${previousContext}\n\n[분석할 글]\n${text}`
      : text;
    result = await gptAnalyze.runDetect(detectInput, lang, {
      text: detectInput,
      lang,
      signal: abortController.signal,
      config,
      route: 'analyze',
      uid: precheck.uid,
      allowLocalFallback: false
    });
    if (typeof result?.probability !== 'number' || !result.summary || !result.detail) {
      throw Object.assign(new Error('detect_incomplete'), { code: 'DETECT_INCOMPLETE' });
    }
    const calibration = await detectCalibration.applyHistoryCalibration({
      db,
      uid: precheck.uid,
      text,
      probability: result.probability,
      logger,
      route: 'analyze'
    });
    if (calibration.applied) {
      result.rawProbability = calibration.rawProbability;
      result.probabilityCalibration = calibration.meta;
    }
    result = applyDetectNarrativePolicy(result, calibration.probability);
  } catch (error) {
    clearDedup();
    if (abortController.signal.aborted) return;
    logger.error('analyze.detect_failed', { uid: precheck.uid, requestId, err: error });
    return res.status(500).json({
      error: '처리 중 오류가 발생했습니다. 크레딧은 차감되지 않았습니다.',
      code: error?.code || 'DETECT_TECHNICAL_ERROR'
    });
  }

  if (abortController.signal.aborted) {
    clearDedup();
    return;
  }

  let deducted = false;
  try {
    if (!devNoAuth && billingMode === 'coupon') {
      await billing.retryAsync(() => billing.commitCouponUsage(
        precheck.uid, precheck.tier, 'detect', text.length, requestId
      ));
      deducted = true;
    } else if (!devNoAuth && precheck.plan !== 'unlimited') {
      await billing.retryAsync(() => billing.commitCreditDeduct(
        precheck.uid, needed, 'detect', requestId, { mode: 'detect', textLength: text.length }
      ));
      deducted = true;
    }
  } catch (error) {
    clearDedup();
    logger.error('analyze.billing_failed', { uid: precheck.uid, requestId, err: error });
    return res.status(500).json({ error: '결제 처리 중 일시적인 오류가 발생했어요. 잠시 뒤 다시 시도해주세요.' });
  }

  if (abortController.signal.aborted) {
    if (deducted) {
      try {
        await billing.retryAsync(() => billingMode === 'coupon'
          ? billing.commitCouponRestore(precheck.uid, precheck.tier, 'detect', text.length, requestId)
          : billing.commitCreditRestore(precheck.uid, needed, 'detect', requestId));
      } catch (error) {
        logger.error('analyze.restore_failed_manual_action', { uid: precheck.uid, requestId, err: error });
      }
    }
    return;
  }

  let historySaved = false;
  if (!devNoAuth) {
    try {
      await history.saveAnalyzeHistory({
        uid: precheck.uid,
        requestId,
        opType: 'detect',
        text,
        needed,
        result,
        mode: 'detect'
      });
      historySaved = true;
    } catch (error) {
      logger.warn('analyze.history_persist_failed', { uid: precheck.uid, requestId, err: error });
    }
  }

  logger.info('analyze.completed', {
    uid: precheck.uid,
    requestId,
    billingMode,
    deducted,
    historySaved
  });
  return res.json({
    ok: true,
    result,
    usage: result.gptMeta?.usage || null,
    historySaved
  });
});

router.post('/analyze-pdf', (_req, res) => res.status(410).json({
  error: 'PDF 직접 분석 API는 종료되었습니다. 브라우저에서 텍스트를 추출한 뒤 /analyze를 사용해주세요.'
}));

router.runDetect = async function runDetect(text, lang = 'ko') {
  const config = await activeGptConfig();
  return gptAnalyze.runDetect(text, lang, {
    text,
    lang,
    config,
    route: 'analyze_validate',
    allowLocalFallback: false
  });
};
router.gpt = gptAnalyze;

module.exports = router;
