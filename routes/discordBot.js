// routes/discordBot.js — Discord 슬래시 커맨드(Interactions) 처리.
//  /매출 [기간:오늘|어제|이번주|이번달|오픈이후]  → 해당 기간 매출을 본인에게만(ephemeral) 응답.
//
// 동작 방식:
//   Discord는 등록된 Interactions Endpoint URL 로 모든 명령을 HTTPS POST 한다.
//   - 본문 서명을 Ed25519 로 검증해야 함(검증 실패 시 401 — Discord 등록 검증도 이걸로 함).
//   - 서명 대상 = (x-signature-timestamp 헤더) + (raw body). 그래서 이 라우트는
//     express.json 보다 먼저 express.raw 로 마운트한다(server.js 참고).
//   - PING(type 1)에는 PONG(type 1)으로 즉시 응답해야 엔드포인트 등록이 완료된다.
//
// 서명검증은 Node 내장 crypto(ed25519)만 사용 — 외부 의존성 추가 없음.

const crypto = require('crypto');
const { getRevenue, revenueEmbed } = require('../lib/revenue');
const { logger } = require('../lib/logger');

// 32바이트 raw ed25519 공개키(hex) → SPKI DER 로 감싸 KeyObject 생성
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
function publicKeyFromHex(hex) {
  const der = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hex, 'hex')]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

function verifySignature(rawBody, signatureHex, timestamp, publicKeyHex) {
  try {
    const key = publicKeyFromHex(publicKeyHex);
    const msg = Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]);
    const sig = Buffer.from(signatureHex, 'hex');
    return crypto.verify(null, msg, key, sig);
  } catch (_) {
    return false;
  }
}

const PERIOD_VALUES = new Set(['today', 'yesterday', 'week', 'month', 'all']);

async function handleInteractions(req, res) {
  const publicKey = (process.env.DISCORD_PUBLIC_KEY || '').trim();
  const signature = req.get('x-signature-ed25519');
  const timestamp = req.get('x-signature-timestamp');
  const raw = req.body; // express.raw → Buffer

  if (!publicKey || !signature || !timestamp || !Buffer.isBuffer(raw)) {
    return res.status(401).send('invalid request signature');
  }
  if (!verifySignature(raw, signature, timestamp, publicKey)) {
    return res.status(401).send('invalid request signature');
  }

  let body;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch (_) { return res.status(400).send('bad request'); }

  // 1 = PING
  if (body.type === 1) return res.json({ type: 1 });

  // 2 = APPLICATION_COMMAND
  if (body.type === 2) {
    const name = body.data && body.data.name;
    if (name === '매출') {
      const opt = ((body.data.options || []).find((o) => o.name === '기간'));
      let period = opt && opt.value ? String(opt.value) : 'today';
      if (!PERIOD_VALUES.has(period)) period = 'today';
      try {
        const r = await getRevenue(period);
        // flags 64 = EPHEMERAL (명령을 부른 본인에게만 보임 → 매출 노출 방지)
        return res.json({ type: 4, data: { flags: 64, embeds: [revenueEmbed(r)] } });
      } catch (e) {
        logger.error('discordBot.revenue_failed', { err: e });
        return res.json({ type: 4, data: { flags: 64, content: '매출 조회에 실패했어요: ' + (e.message || '오류') } });
      }
    }
    return res.json({ type: 4, data: { flags: 64, content: '알 수 없는 명령입니다.' } });
  }

  // 그 외 상호작용 타입은 무시(빈 ACK)
  return res.json({ type: 4, data: { flags: 64, content: '지원하지 않는 요청입니다.' } });
}

module.exports = { handleInteractions, verifySignature };
