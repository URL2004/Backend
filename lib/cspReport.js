'use strict';
// lib/cspReport.js — 브라우저 CSP 위반 보고 요약 + 1시간 집계.
//
// 개별 보고는 stdout(info)에만 남긴다. 하루 수천 건이라 관리자 로그(Firestore)에 건별로 넣으면 비용·노이즈가 크다.
// 대신 (directive, blockedOrigin)별 건수를 메모리에 모아 1시간마다 security.csp_violation_summary 한 줄로 남긴다
// → 카탈로그(SEV3, discord:false)에 등록돼 관리자 장애 로그에서 "무엇이 막히고 있는지"를 볼 수 있다.
// 타이머를 쓰지 않고 다음 보고가 들어올 때 창이 지났으면 흘려보낸다(프로세스 종료 시 마지막 창은 버려질 수 있다).

const SUMMARY_WINDOW_MS = 60 * 60 * 1000;
const TOP_LIMIT = 8;

function summarizeReport(body) {
  const report = body?.['csp-report'] || {};
  // chrome-extension:// 같은 비표준 스킴은 URL.origin이 'null'이라 집계에 쓸모가 없다 → 스킴+호스트로 대신한다.
  const origin = value => {
    try {
      const url = new URL(value);
      const resolved = url.origin && url.origin !== 'null' ? url.origin : `${url.protocol}//${url.host}`;
      return resolved.slice(0, 180);
    } catch { return ['inline', 'eval'].includes(value) ? value : 'unknown'; }
  };
  return {
    directive: String(report['effective-directive'] || '').replace(/[^a-z-]/g, '').slice(0, 60),
    blockedOrigin: origin(report['blocked-uri']), documentOrigin: origin(report['document-uri']),
    disposition: report.disposition === 'enforce' ? 'enforce' : 'report', noAlert: true
  };
}

const state = { windowStartMs: 0, total: 0, counts: new Map() };

function buildSummary(nowMs) {
  const top = [...state.counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_LIMIT)
    .map(([key, count]) => {
      const [directive, blockedOrigin] = key.split('|');
      return { directive, blockedOrigin, count };
    });
  return {
    windowStartAt: new Date(state.windowStartMs).toISOString(),
    windowMinutes: Math.max(1, Math.round((nowMs - state.windowStartMs) / 60000)),
    total: state.total,
    distinct: state.counts.size,
    top,
    message: `지난 ${Math.max(1, Math.round((nowMs - state.windowStartMs) / 60000))}분간 CSP 위반 보고 ${state.total}건(종류 ${state.counts.size})`,
    noAlert: true
  };
}

function flush({ logger, now = Date.now() } = {}) {
  const nowMs = typeof now === 'function' ? now() : now;
  if (!state.total) { state.windowStartMs = nowMs; return null; }
  const summary = buildSummary(nowMs);
  if (logger && typeof logger.warn === 'function') logger.warn('security.csp_violation_summary', summary);
  state.counts.clear();
  state.total = 0;
  state.windowStartMs = nowMs;
  return summary;
}

function recordReport(summary, { logger, now = Date.now() } = {}) {
  const nowMs = typeof now === 'function' ? now() : now;
  if (state.windowStartMs && nowMs - state.windowStartMs >= SUMMARY_WINDOW_MS) flush({ logger, now: nowMs });
  if (!state.windowStartMs) state.windowStartMs = nowMs;
  const key = `${summary?.directive || ''}|${summary?.blockedOrigin || 'unknown'}`;
  state.counts.set(key, (state.counts.get(key) || 0) + 1);
  state.total += 1;
  return state.total;
}

function resetForTest() { state.windowStartMs = 0; state.total = 0; state.counts.clear(); }

module.exports = { summarizeReport, recordReport, flush, resetForTest, SUMMARY_WINDOW_MS };
