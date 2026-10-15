'use strict';

const crypto = require('node:crypto');
const billing = require('./usageBilling');
const requests = require('./detectRequestStore');
const history = require('./historyService');
const { logger } = require('./logger');
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{7,79}$/u;
const validResponse = response => response?.ok === true && Number.isFinite(response?.result?.probability);
const validArtifact = artifact => artifact?.kind === 'analyze-v1' && validResponse(artifact.publicResponse);
const failure = (code, status = 503, message = '감지 요청을 안전하게 확인하지 못했어요. 같은 작업 번호로 다시 시도해 주세요.') =>
  Object.assign(new Error(message), { code, status, retryable: status === 503 });

async function open({ idToken, requestId, text, submittedText, lang, referenceContext, billingMode, needed, devNoAuth }) {
  if (devNoAuth) return { uid: 'dev-local', plan: 'unlimited', devNoAuth, billed: false };
  const authenticated = await billing.authenticate(idToken);
  const account = await billing.getCreditAccountState(authenticated.uid);
  // Old unlimited callers never debit anything. Give those calls a fresh server
  // identity; paid callers must supply a stable ID they can reuse after a timeout.
  if (!requestId && billingMode === 'credit' && account.plan === 'unlimited') requestId = crypto.randomUUID();
  if (!REQUEST_ID.test(requestId || '')) throw failure(requestId ? 'INVALID_REQUEST_ID' : 'REQUEST_ID_REQUIRED', 400,
    '안전한 결제와 결과 복구를 위해 작업 번호가 필요해요. 페이지를 새로고침해 주세요.');
  const fingerprint = billing.creditRequestPayloadFingerprint({ opType: 'detect', needed,
    text: JSON.stringify({ contract: 'analyze-v1', billingMode, text, submittedText, lang, referenceContext }) });
  const session = { uid: account.uid, plan: account.plan, account, idToken, authenticated, requestId,
    billingMode, needed, textLength: text.length, fingerprint,
    chargeRequired: billingMode === 'coupon' || account.plan !== 'unlimited',
    binding: { uid: account.uid, requestId, payloadFingerprint: fingerprint, cost: needed } };
  session.lookupDebit = () => billingMode === 'coupon'
    ? billing.precheckCouponUsageIdempotency(session.uid, text.length, 'detect', requestId, fingerprint)
    : billing.precheckCreditDeductIdempotency(session.uid, needed, 'detect', requestId, fingerprint);
  const debit = await session.lookupDebit();
  session.billed = debit.state === 'DUPLICATE';
  const saved = await history.getDetectHistoryIdempotency({ uid: session.uid, requestId, needed, requestPayloadFingerprint: fingerprint });
  if (saved.state === 'MISMATCH') throw failure('IDEMPOTENCY_KEY_REUSED', 409);
  if (saved.state === 'UNAVAILABLE') throw failure('IDEMPOTENCY_CHECK_UNAVAILABLE');
  if ((session.billed || !session.chargeRequired) && saved.state === 'READY' && validResponse(saved.response)) {
    session.replay = { ...saved.response, charged: 0, idempotentReplay: true };
    return session;
  }
  const claim = session.billed ? await requests.lookup(session.binding) : await requests.begin(session.binding);
  if (claim.state === 'MISMATCH') throw failure('IDEMPOTENCY_KEY_REUSED', 409);
  if (claim.state === 'ACCOUNT_DELETION') throw failure('ACCOUNT_DELETION_IN_PROGRESS', 409);
  if (['INVALID', 'UNAVAILABLE'].includes(claim.state)) throw failure('IDEMPOTENCY_CHECK_UNAVAILABLE');
  if (claim.state === 'PROCESSING') throw Object.assign(failure('DETECT_REQUEST_PROCESSING', 202,
    '같은 감지 작업을 처리하고 있어요. 같은 작업 번호로 다시 확인해 주세요.'), { retryable: true, retryAfterSeconds: Math.max(1, Math.ceil((claim.retryAfterMs || 5000) / 1000)) });
  if (['RESULT_READY', 'COMPLETE'].includes(claim.state) && validArtifact(claim.response)) session.artifact = claim.response;
  if (session.billed && !session.artifact) throw Object.assign(failure('DETECT_RESULT_NO_LONGER_AVAILABLE', 410,
    '이미 결제된 감지 결과를 더 이상 읽을 수 없어요. 같은 작업 번호로 추가 차감하지 않습니다.'), { billingCommitted: true });
  if (claim.state === 'CORRUPT' || ['RESULT_READY', 'COMPLETE'].includes(claim.state) && !session.artifact)
    throw failure('DETECT_REQUEST_UNRECOVERABLE', 409);
  if (claim.state === 'COMPLETE' && !session.billed && session.chargeRequired) throw failure('IDEMPOTENCY_KEY_REUSED', 409);
  if (claim.state === 'COMPLETE') { session.replay = { ...session.artifact.publicResponse, charged: 0, idempotentReplay: true }; return session; }
  session.claimed = claim.state === 'NEW';
  try {
    if (!session.billed && session.chargeRequired) {
      const precheck = billingMode === 'coupon'
        ? await billing.precheckCoupon(idToken, text.length, authenticated)
        : await billing.precheckCredits(idToken, needed, authenticated);
      session.tier = precheck.tier;
      if (billingMode === 'credit' && precheck.plan === 'unlimited') session.chargeRequired = false;
    }
  } catch (error) { await release(session); throw error; }
  return session;
}

async function release(session) {
  if (session?.claimed && !session.artifact) return requests.releaseAfterModelFailure(session.binding);
  return true;
}

async function stage(session, response) {
  if (session.devNoAuth) return { kind: 'analyze-v1', publicResponse: response };
  let staged;
  try { staged = await requests.stageResult(session.binding, { kind: 'analyze-v1', publicResponse: response }); }
  catch {
    await release(session);
    throw failure('IDEMPOTENCY_CACHE_UNAVAILABLE');
  }
  if (!['RESULT_READY', 'COMPLETE'].includes(staged.state) || !validArtifact(staged.response)) {
    await release(session);
    if (staged.state === 'TOO_LARGE') throw failure('DETECT_RESULT_TOO_LARGE', 422,
      '감지 결과가 저장 한도를 넘었어요. 글을 나누어 다시 분석해 주세요. 크레딧은 차감되지 않았어요.');
    throw failure(staged.state === 'MISMATCH' ? 'IDEMPOTENCY_KEY_REUSED' : 'IDEMPOTENCY_CACHE_UNAVAILABLE', staged.state === 'MISMATCH' ? 409 : 503);
  }
  session.artifact = staged.response;
  return session.artifact;
}

async function commit(session) {
  if (session.devNoAuth || !session.chargeRequired || session.billed) return { charged: 0 };
  try {
    const result = await billing.retryAsync(() => session.billingMode === 'coupon'
      ? billing.commitCouponUsage(session.uid, session.tier, 'detect', session.textLength, session.requestId, { requestPayloadFingerprint: session.fingerprint })
      : billing.commitCreditDeduct(session.uid, session.needed, 'detect', session.requestId,
        { mode: 'detect', textLength: session.textLength, requestPayloadFingerprint: session.fingerprint }), 2);
    const confirmed = result?.duplicate === true || (session.billingMode === 'coupon' ? result?.duplicate === false
      : Number.isFinite(result?.current) && result.current - result.next === session.needed);
    if (!confirmed) throw failure('DETECT_BILLING_UNCONFIRMED');
    session.billed = true;
    return { charged: result.duplicate ? 0 : session.needed };
  } catch (error) {
    let ledger;
    try { ledger = await session.lookupDebit(); } catch (checkError) {
      if (checkError?.code === 'IDEMPOTENCY_KEY_REUSED') throw checkError;
    }
    if (ledger?.state === 'DUPLICATE') { session.billed = true; return { charged: 0 }; }
    await requests.recordBillingFailure(session.binding, error);
    throw error;
  }
}

async function finish(session, response, text) {
  if (session.devNoAuth) return response;
  let historySaved = false;
  try {
    const saved = await history.saveAnalyzeHistory({ uid: session.uid, requestId: session.requestId, opType: 'detect',
      text, needed: session.needed, result: response.result, mode: 'detect', requestPayloadFingerprint: session.fingerprint,
      detectResponseCache: { ...response, historySaved: true } });
    historySaved = saved?.saved === true;
  } catch (error) { logger.warn('analyze.history_persist_failed', { uid: session.uid, requestId: session.requestId, err: error }); }
  const final = { ...response, historySaved };
  await requests.complete(session.binding, { kind: 'analyze-v1', publicResponse: final });
  return final;
}

module.exports = { open, stage, commit, finish, release };
