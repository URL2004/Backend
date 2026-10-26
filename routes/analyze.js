'use strict';

// Detect-only API. Humanizing is intentionally available only through
// /transform, which owns queueing, delivery policy, and billing semantics.
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { db, ADMIN_UIDS } = require('../config');
const { logger, setLogContext } = require('../lib/logger');
const { bearerToken } = require('../lib/reqtoken');
const detectCalibration = require('../lib/detectCalibration');
const detectStability = require('../lib/detectResultStability');
const { applyDetectNarrativePolicy } = require('../lib/detectNarrativePolicy');
const { signHistoryComparison } = require('../lib/detectHistoryComparison');
const gptRuntimeConfig = require('../lib/gptRuntimeConfig');
const gptAnalyze = require('./analyze-gpt');
const billing = require('../lib/usageBilling');
const inputrouting = require('../engine/inputrouting');
const publicMetrics = require('../lib/publicMetrics');
const { resolveAdvancedRouting } = require('../engine-gpt-prod/advancedRouting');
const detectLifecycle = require('../lib/detectAnalyzeLifecycle');
const { assertDetectInputAdmissible, locateNormalizedEvidence } = require('../lib/detectInputDocument');

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
    ? body.requestId.trim()
    : null;
}

function normalizeDetectInput(rawText) {
  let text = String(rawText || '');
  if (process.env.INPUT_REJOIN !== '0') {
    try {
      const joined = inputrouting.rejoinSplitChars(text);
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
  const submittedText = typeof req.body?.text === 'string' ? req.body.text : '';
  const text = normalizeDetectInput(submittedText);
  if (text.length < 5) return res.status(400).json({ error: '텍스트가 너무 짧습니다.' });
  const hardMax = 30000;
  if (text.length > hardMax) {
    return res.status(400).json({ code: 'INPUT_TOO_LONG', limit: hardMax, actual: text.length, charged: 0, error: `텍스트가 너무 깁니다. (최대 ${hardMax.toLocaleString()}자)` });
  }
  const readability = inputrouting.assessInputReadability(text);
  if (!readability.readable) {
    logger.warn('analyze.unreadable_input_blocked', { reason: readability.reason, textLength: text.length });
    return res.status(422).json({ code: 'UNREADABLE_INPUT', reason: readability.reason, error: inputrouting.UNREADABLE_INPUT_MESSAGE });
  }

  const abortController = new AbortController();
  res.once('close', () => {
    if (!res.writableEnded) abortController.abort();
  });
  const devNoAuth = !process.env.FIREBASE_SERVICE_ACCOUNT && process.env.DEV_NO_AUTH === '1';
  const needed = billingMode === 'coupon' ? 1 : Math.ceil(text.length / 100);
  const idToken = bearerToken(req);
  let session;
  try {
    session = await detectLifecycle.open({ idToken, requestId, text, submittedText, lang,
      referenceContext: previousContext, billingMode, needed, devNoAuth });
  } catch (error) {
    return res.status(error.status || 503).json({ ok: false, code: error.code || error.message,
      error: error.code ? error.message : billing.authErrorMessage(error.message), charged: 0,
      retryable: error.retryable === true,
      ...(error.billingCommitted ? { billingCommitted: true } : {}),
      ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      ...(error.charLimit !== undefined ? { charLimit: error.charLimit } : {})
    });
  }
  const precheck = session;
  setLogContext({ uid: precheck.uid });
  if (session.replay) return res.json(session.replay);
  const usedStaged = !!session.artifact;
  let responseBody = session.artifact?.publicResponse;

  let result;
  if (!responseBody) {
  try { assertDetectInputAdmissible(text, { referenceContext: previousContext }); }
  catch (error) {
    await detectLifecycle.release(session);
    return res.status(error.status || 422).json({ ok: false, code: error.code, error: error.message, charged: 0, retryable: false });
  }
  try {
    const config = await activeGptConfig();
    const routing = resolveAdvancedRouting(text);
    const detectInput = text;
    const cacheVariant = detectStability.variantForConfig(config, {
      detectorVersion: gptAnalyze.DETECT_VERSION,
      promptVersion: gptAnalyze.DETECT_PROMPT_VERSION,
      documentProfile: `${routing.profile}:${Number(routing.confidence).toFixed(2)}:${routing.profileMargin ?? 'na'}`
    });
    const payloadFingerprint = detectStability.payloadFingerprint({ text: detectInput, lang, referenceContext: previousContext });
    let liveResult = null;
    const stable = await detectStability.getOrCompute({ uid: precheck.uid, payloadFingerprint, cacheVariant }, async sharedSignal => {
      liveResult = await gptAnalyze.runDetect(detectInput, lang, {
        text: detectInput,
        referenceContext: previousContext,
        lang,
        signal: sharedSignal,
        config,
        route: 'analyze',
        uid: precheck.uid,
        allowLocalFallback: false,
        documentProfile: {
          profile: routing.profile,
          confidence: routing.confidence,
          profileMargin: routing.profileMargin
        }
      });
      return liveResult;
    }, { signal: abortController.signal });
    // The cache contains only the detector stage. History-dependent adjustment
    // runs on every request and is never fed back into this cache.
    result = stable.result;
    result.gptMeta = { ...result.gptMeta, detectCacheHit: stable.cacheHit, detectCacheSource: stable.source,
      ...(liveResult?.gptMeta?.usage ? { usage: liveResult.gptMeta.usage } : {}) };
    if (typeof result?.probability !== 'number' || !result.summary || !result.detail) {
      throw Object.assign(new Error('detect_incomplete'), { code: 'DETECT_INCOMPLETE' });
    }
    let calibration;
    try {
      calibration = await detectCalibration.applyHistoryCalibration({
        db, uid: precheck.uid, text, probability: result.probability, logger, route: 'analyze'
      });
    } catch (error) {
      throw Object.assign(new Error('감지 결과를 안전하게 확정하지 못했어요.'), {
        code: 'DETECT_CALIBRATION_UNAVAILABLE', status: 503, cause: error
      });
    }
    if (calibration.applied) {
      result.rawProbability = calibration.rawProbability;
    }
    if (calibration.meta) result.probabilityCalibration = calibration.meta;
    // 표시 척도(개발 후보, 기본 OFF): 감지 보고서 라우트와 같은 규칙·같은 순서(이력 보정 뒤)로 적용한다.
    const scale = require('../lib/detectScaleCalibration').applyScaleCalibration({
      probability: calibration.probability, chars: text.length, profile: routing.profile, probSource: 'llm'
    });
    result = applyDetectNarrativePolicy(result, scale.probability);
    Object.assign(result, require('../lib/detectScorePresentation').scorePresentation(calibration));
    if (scale.meta) { result.scaleCalibration = scale.meta; if (scale.applied) result.rawProbability = calibration.rawProbability; }
    if (calibration.comparison && !scale.applied) {
      result.historyComparison = calibration.comparison;
      // Backup resubmits the browser's exact request source, before this legacy
      // route's deterministic input normalization.
      const backupText = typeof req.body?.text === 'string' ? req.body.text : text;
      result.historyComparisonProof = signHistoryComparison(precheck.uid, backupText, result.probability, calibration.comparison);
    }
    result.documentProfile = routing.profile;
    result.profileConfidence = routing.confidence;
    result.profileMargin = routing.profileMargin;
    result.profileAmbiguous = Number.isFinite(Number(routing.profileMargin)) && Number(routing.profileMargin) < 0.5;
    result.signalEvidence = locateNormalizedEvidence(result.signalEvidence, submittedText, text);
  } catch (error) {
    await detectLifecycle.release(session);
    if (abortController.signal.aborted) return;
    logger.error('analyze.detect_failed', { uid: precheck.uid, requestId, err: error });
    const availability = require('../lib/providerAvailability');
    if (availability.isUnavailable(error)) {
      const failure = availability.publicFailure(error);
      return res.set('Retry-After', String(failure.retryAfterSeconds)).status(503).json(failure);
    }
    return res.status(error?.status === 503 ? 503 : 500).json({
      error: '처리 중 오류가 발생했습니다. 크레딧은 차감되지 않았습니다.',
      code: error?.code || 'DETECT_TECHNICAL_ERROR',
      ...(error?.status === 503 ? { retryable: true, charged: 0 } : {})
    });
  }

  if (abortController.signal.aborted) {
    await detectLifecycle.release(session);
    return;
  }
  responseBody = { ok: true, result, usage: result.gptMeta?.usage || null, historySaved: false };
  try {
    responseBody = (await detectLifecycle.stage(session, responseBody)).publicResponse;
  } catch (error) {
    return res.status(error.status || 503).json({ ok: false, code: error.code, error: error.message, charged: 0, retryable: error.retryable === true });
  }
  }
  if (abortController.signal.aborted) return;
  let receipt;
  try { receipt = await detectLifecycle.commit(session); }
  catch (error) {
    logger.error('analyze.billing_failed', { uid: precheck.uid, requestId, err: error });
    return res.status(error.status || 503).json({ ok: false, code: error.code || error.message,
      error: '결제 상태를 확인하지 못했어요. 같은 작업 번호로 다시 확인해 주세요.', retryable: true });
  }
  // Staging grants durable delivery, never refund ownership over a previous
  // debit. A disconnect after commit can recover this exact result by ID.
  responseBody = { ...responseBody, ...receipt, ...(usedStaged ? { idempotentReplay: true } : {}) };
  try { responseBody = await detectLifecycle.finish(session, responseBody, submittedText); }
  catch (error) { logger.warn('analyze.completion_persist_failed', { uid: precheck.uid, requestId, err: error }); }
  if (abortController.signal.aborted) return;

  logger.info('analyze.completed', {
    uid: precheck.uid,
    requestId,
    billingMode,
    deducted: receipt.charged > 0,
    historySaved: responseBody.historySaved
  });
  publicMetrics.trackDeliveredMetric(res, {
    operation: 'detect',
    eventId: requestId || String(res.getHeader('x-request-id') || crypto.randomUUID()),
    uid: precheck.uid,
    processedCharacters: text.length,
    isAdmin: ADMIN_UIDS.includes(precheck.uid),
    isTest: devNoAuth
  }, { db, logger });
  return res.json(responseBody);
});

router.post('/analyze-pdf', (_req, res) => res.status(410).json({
  error: 'PDF 직접 분석 API는 종료되었습니다. 브라우저에서 텍스트를 추출한 뒤 /analyze를 사용해주세요.'
}));

router.runDetect = async function runDetect(text, lang = 'ko') {
  const config = await activeGptConfig();
  const routing = resolveAdvancedRouting(text);
  return gptAnalyze.runDetect(text, lang, {
    text,
    lang,
    config,
    route: 'analyze_validate',
    allowLocalFallback: false,
    documentProfile: {
      profile: routing.profile,
      confidence: routing.confidence,
      profileMargin: routing.profileMargin
    }
  });
};
router.gpt = gptAnalyze;

module.exports = router;
