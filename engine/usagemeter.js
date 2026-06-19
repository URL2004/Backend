// [engine/usagemeter.js] 경량 LLM usage·비용 계측 (2026-06-19 API 비용 감사 §5.1 관측성 공백 메움)
// ────────────────────────────────────────────────────────────────
// 목적: 지금까지 버려지던 judge·evidence·micro-call의 usage를 포착해 task/model별 USD로 한 포맷으로 로깅 →
//   *우리* 트래픽의 진짜 hotspot(어디에 돈이 쓰이나)을 측정. ★무거운 Gateway/OTel/ALS 없이 가산적 로깅만
//   (job 실행 흐름 무관·무위험). 집계는 로그의 `llm.usage` 이벤트 estimatedUsd를 task/model로 offline 합산.
const { logger } = require('../lib/logger');

// 공식 단가 [A1] 2026-06-19 (USD per MTok). 5분 write=1.25×·1시간 write=2×·cache read=0.1× of base input.
// ★ 가격은 변동 가능 — 배포 시 공식 docs 재확인(versioned config).
const PRICING = {
  sonnet: { in: 3.00, w5: 3.75, w1: 6.00, read: 0.30, out: 15.00 },
  haiku:  { in: 1.00, w5: 1.25, w1: 2.00, read: 0.10, out: 5.00 },
};
const WEB_SEARCH_USD = 0.01;   // 검색 1회 = $0.01 (1,000회당 $10)

function _price(model) { return /haiku/i.test(String(model || '')) ? PRICING.haiku : PRICING.sonnet; }

// Anthropic usage 객체 → 추정 USD. 필드 누락에 안전(0 처리).
function estimateUsd(model, usage) {
  if (!usage) return 0;
  const p = _price(model);
  const inTok = usage.input_tokens || 0;
  const cc = usage.cache_creation_input_tokens || 0;
  const cr = usage.cache_read_input_tokens || 0;
  const out = usage.output_tokens || 0;
  // 5m/1h 분리 정보가 있으면 반영, 없으면 cache_creation 전체를 5분 write로 본다(보수적 추정).
  const ccd = usage.cache_creation || {};
  const w5 = ccd.ephemeral_5m_input_tokens != null ? ccd.ephemeral_5m_input_tokens : cc;
  const w1 = ccd.ephemeral_1h_input_tokens || 0;
  const ws = (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
  return (inTok * p.in + w5 * p.w5 + w1 * p.w1 + cr * p.read + out * p.out) / 1e6 + ws * WEB_SEARCH_USD;
}

// 한 LLM 호출 usage 기록 — 구조화 로그(llm.usage, evt:meter). callClaude는 자체 llm.usage 로그에 estimatedUsd만 추가.
function recordUsage({ model, usage, task = 'unspecified', phase, attempt, elapsedMs } = {}) {
  const usd = estimateUsd(model, usage);
  try {
    logger.info('llm.usage', {
      evt: 'meter', task, phase, model,
      inputTokens: usage?.input_tokens || 0,
      cacheReadTokens: usage?.cache_read_input_tokens || 0,
      cacheCreateTokens: usage?.cache_creation_input_tokens || 0,
      outputTokens: usage?.output_tokens || 0,
      webSearchRequests: (usage?.server_tool_use?.web_search_requests) || 0,
      attempt, elapsedMs,
      estimatedUsd: Number(usd.toFixed(6)),
    });
  } catch {}
  return usd;
}

module.exports = { estimateUsd, recordUsage, PRICING, WEB_SEARCH_USD };
