'use strict';

/**
 * 모델 호출 실패를 모든 회복 경로에서 같은 코드로 기록한다. OpenAI
 * 클라이언트가 오류 유형별 재시도를 이미 마친 뒤 던진 오류는 품질 문제가
 * 아니므로, 더 큰 모델로 바꿔 다시 호출하는 근거로 사용하지 않는다.
 */
function classifyModelFailure(error) {
  const rawCode = String(error?.code || '').trim().toUpperCase();
  const message = String(error?.message || error || '').toLowerCase();
  const status = Number(error?.status);

  if (rawCode === 'ABORT_ERR' || error?.name === 'AbortError' || /\babort(?:ed|error)?\b/u.test(message)) {
    return 'request_aborted';
  }
  if (rawCode === 'OPENAI_REFUSAL' || error?.refusal === true || /refusal|content.?filter|safety.?refusal/u.test(message)) {
    return 'openai_refusal';
  }
  if (status === 429 || /\b429\b|rate.?limit|too many requests/u.test(message)) {
    return 'openai_rate_limited';
  }
  if (Number.isFinite(status) && status >= 500) return 'openai_server_error';
  if (rawCode === 'ETIMEDOUT'
      || rawCode === 'OPENAI_CHUNK_TIMEOUT'
      || /timeout|timed out|deadline/u.test(message)) {
    return 'openai_timeout';
  }
  if (rawCode.startsWith('OPENAI_SCHEMA')
      || /schema|invalid json|malformed json|json parse/u.test(message)) {
    return 'openai_schema_error';
  }
  if (rawCode === 'OPENAI_TRUNCATED_OUTPUT') return 'openai_truncated_output';
  if (rawCode === 'OPENAI_INCOMPLETE_OUTPUT') return 'openai_incomplete_output';
  if (rawCode === 'OPENAI_EMPTY_OUTPUT') return 'openai_empty_output';
  if (/network|fetch failed|econnreset|enotfound|socket hang up/u.test(message)) {
    return 'openai_network_error';
  }
  if (rawCode.startsWith('OPENAI_')) {
    return rawCode.toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 80);
  }
  return 'gpt_call_failed';
}

function isTransportFailureCode(value) {
  return /^(?:request_aborted|openai_(?:rate_limited|server_error|timeout|network_error))$/u
    .test(String(value || ''));
}

function isNonEscalatableModelFailureCode(value) {
  const code = String(value || '');
  return code === 'gpt_call_failed'
    || code === 'request_aborted'
    || /^openai_(?:rate_limited|server_error|timeout|network_error|schema_error|refusal|truncated_output|incomplete_output|empty_output)/u.test(code);
}

module.exports = {
  classifyModelFailure,
  isTransportFailureCode,
  isNonEscalatableModelFailureCode
};
