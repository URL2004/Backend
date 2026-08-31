// routes/revenue.js — 매출 조회 엔드포인트
//  - GET  /admin/revenue?period=today&post=1   : 관리자 온디맨드 조회(JSON, ?post=1이면 Discord에도 게시)
//  - POST /cron/daily-revenue                  : 일일 자동 리포트(cron) → Discord sales 채널
// 인증: 온디맨드는 ADMIN_TOKEN, cron은 CRON_SECRET(구독 cron과 동일 패턴).

const express = require('express');
const router = express.Router();
const { getRevenue, revenueEmbed, revenueField } = require('../lib/revenue');
const discord = require('../lib/discord');
const { logger } = require('../lib/logger');
const { authLogFields, legacyQueryCredentialEnabled, timingSafeEqualText, verifyCronRequest } = require('../lib/cronAuth');

// 인증 실패를 조용히 넘기지 않는다 — 예전에는 매출 cron이 401로 죽어도 로그가 한 줄도 없어서
// "리포트가 왜 안 오지"를 추적할 방법이 없었다.
function checkAdmin(req, res) {
  const token = (process.env.ADMIN_TOKEN || '').trim();
  if (!token) {
    logger.error('revenue.admin_token_missing', { message: 'ADMIN_TOKEN 미설정 — 관리자 매출 조회 불가' });
    res.status(503).json({ error: 'ADMIN_TOKEN이 설정되지 않았습니다.' });
    return false;
  }
  const headerToken = (req.get('x-admin-token') || '').toString().trim();
  const queryEnabled = String(process.env.ADMIN_ALLOW_QUERY_TOKEN ?? '1').trim() !== '0';
  const queryToken = queryEnabled ? (req.query.token || '').toString().trim() : '';
  const given = headerToken || queryToken;
  if (!timingSafeEqualText(given, token)) {
    logger.warn('revenue.admin_auth_rejected', { hasToken: !!given });
    res.status(401).json({ error: '권한이 없습니다.' });
    return false;
  }
  if (!headerToken && queryToken) {
    logger.warn('revenue.admin_query_token_deprecated', {
      message: 'query 관리자 토큰은 폐기 예정입니다. x-admin-token 헤더로 전환하세요.'
    });
  }
  return true;
}

function checkCron(req, res) {
  const auth = verifyCronRequest(req, { allowBearer: true, allowBody: true, allowQuery: legacyQueryCredentialEnabled() });
  if (auth.reason === 'secret_missing') {
    logger.error('revenue.cron_secret_missing', { message: 'CRON_SECRET 미설정 — 일일 매출 리포트 중단' });
    res.status(503).json({ error: 'CRON_SECRET이 설정되지 않았습니다.' });
    return false;
  }
  if (!auth.ok) {
    logger.warn('revenue.cron_auth_rejected', {
      ...authLogFields(auth),
      message: '매출 cron 인증 거부 — 실제 중단 여부는 heartbeat로 판정'
    });
    res.status(401).json({ error: '권한이 없습니다.' });
    return false;
  }
  if (auth.authSource.includes('query')) {
    logger.warn('revenue.cron_query_secret_deprecated', {
      message: 'query cron secret은 폐기 예정입니다. x-cron-secret 헤더로 전환하세요.'
    });
  }
  return true;
}

// 관리자 온디맨드 조회
router.get('/admin/revenue', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const period = (req.query.period || 'today').toString();
    const r = await getRevenue(period);
    if (req.query.post === '1') discord.revenueReport({ title: revenueEmbed(r).title, fields: revenueEmbed(r).fields });
    res.json(r);
  } catch (e) {
    logger.error('revenue.admin_failed', { err: e });
    res.status(500).json({ error: e.message || '매출 조회 실패' });
  }
});

// 일일 자동 리포트(cron) — 어제 + 이번 달 누적을 Discord에 게시
router.post('/cron/daily-revenue', async (req, res) => {
  if (!checkCron(req, res)) return;
  try {
    const [yesterday, month] = await Promise.all([getRevenue('yesterday'), getRevenue('month')]);
    discord.revenueReport({
      title: '📊 일일 매출 리포트',
      fields: [revenueField(yesterday), revenueField(month)]
    });
    // 리포트가 실제로 나갔다는 도장 — 이게 끊기면 워치독이 SEV1로 알린다.
    try { require('../lib/opsHeartbeat').beat('revenue.daily_report', { total: yesterday.totalPaid }); } catch (_) {}
    logger.info('revenue.daily_report_sent', {
      yesterday: yesterday.totalPaid, yesterdayCount: yesterday.totalCount,
      monthToDate: month.totalPaid, monthCount: month.totalCount
    });
    res.json({ ok: true, yesterday, month });
  } catch (e) {
    logger.error('revenue.cron_failed', { err: e });
    res.status(500).json({ error: e.message || '일일 리포트 실패' });
  }
});

module.exports = router;
