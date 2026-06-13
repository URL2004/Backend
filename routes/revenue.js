// routes/revenue.js — 매출 조회 엔드포인트
//  - GET  /admin/revenue?period=today&post=1   : 관리자 온디맨드 조회(JSON, ?post=1이면 Discord에도 게시)
//  - POST /cron/daily-revenue                  : 일일 자동 리포트(cron) → Discord sales 채널
// 인증: 온디맨드는 ADMIN_TOKEN, cron은 CRON_SECRET(구독 cron과 동일 패턴).

const express = require('express');
const router = express.Router();
const { getRevenue, revenueEmbed, revenueField } = require('../lib/revenue');
const discord = require('../lib/discord');
const { logger } = require('../lib/logger');

function checkAdmin(req, res) {
  const token = (process.env.ADMIN_TOKEN || '').trim();
  if (!token) { res.status(503).json({ error: 'ADMIN_TOKEN이 설정되지 않았습니다.' }); return false; }
  const given = (req.get('x-admin-token') || req.query.token || '').toString().trim();
  if (given !== token) { res.status(401).json({ error: '권한이 없습니다.' }); return false; }
  return true;
}

function checkCron(req, res) {
  const secret = (process.env.CRON_SECRET || '').trim();
  if (!secret) { res.status(503).json({ error: 'CRON_SECRET이 설정되지 않았습니다.' }); return false; }
  const given = (req.get('x-cron-secret') || req.query.key || (req.body && req.body.internalKey) || '').toString().trim();
  if (given !== secret) { res.status(401).json({ error: '권한이 없습니다.' }); return false; }
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
