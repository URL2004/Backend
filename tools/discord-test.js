// tools/discord-test.js — Discord 알림 모듈 + 로거 연동 검증.
// 실제 전송 없이 https.request를 가로채 페이로드만 확인한다. 실행: node tools/discord-test.js
process.env.DISCORD_WEBHOOK_CS = 'https://discord.test/cs';
process.env.DISCORD_WEBHOOK_SALES = 'https://discord.test/sales';
process.env.DISCORD_WEBHOOK_ALERT = 'https://discord.test/alert';
process.env.DISCORD_WEBHOOK_GROWTH = 'https://discord.test/growth';
process.env.LOG_STACKS = '1';

const https = require('https');
const sent = [];
https.request = function (opts, cb) {
  let body = '';
  const res = { on: (ev, fn) => { if (ev === 'end') fn(); return res; } };
  const req = {
    write(d) { body += d.toString(); },
    end() { try { sent.push({ path: opts.path, json: JSON.parse(body) }); } catch (_) { sent.push({ path: opts.path, json: null }); } if (cb) cb(res); },
    on() { return req; }, destroy() {}
  };
  return req;
};

const discord = require('../lib/discord');
const { logger } = require('../lib/logger');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (extra ? ' — ' + JSON.stringify(extra) : '')); }
}
const last = () => sent[sent.length - 1];
const titleOf = (e) => e && e.json && e.json.embeds && e.json.embeds[0] && e.json.embeds[0].title || '';

(async () => {
  check('enabled() true when webhook set', discord.enabled() === true);

  sent.length = 0;
  discord.inquiry({ id: 'q1', title: '환불 문의', body: '내용', author: '홍길동', uid: 'u1' });
  check('inquiry → cs 채널', last() && last().path === '/cs', last());
  check('inquiry 제목', titleOf(last()).includes('새 문의'), titleOf(last()));

  discord.paymentDone({ uid: 'u1', amount: 14500, credits: 600, kind: '크레딧 충전' });
  check('paymentDone → sales 채널', last().path === '/sales');
  check('paymentDone 제목', titleOf(last()).includes('결제 완료'));

  discord.refundRequest({ uid: 'u1', amount: 14500, reason: '단순 변심' });
  check('refundRequest → cs 채널', last().path === '/cs');

  discord.paymentFailed({ uid: 'u1', tier: '5000', reason: '한도 초과' });
  check('paymentFailed → cs 채널', last().path === '/cs');

  discord.subscription({ uid: 'u1', tier: '5000', action: '해지' });
  check('subscription → sales 채널', last().path === '/sales');

  discord.couponUsed({ uid: 'u1', code: 'ABCD-1234', credits: 100 });
  check('couponUsed → growth 채널', last().path === '/growth');

  discord.signup({ uid: 'u1', via: 'google' });
  check('signup → growth 채널', last().path === '/growth');

  // 로거 연동: error → alert 채널
  sent.length = 0;
  logger.error('test.boom', { err: new Error('something broke') });
  check('logger.error → alert 채널', last() && last().path === '/alert', last());
  check('alert 제목에 ERROR·이벤트', titleOf(last()).includes('ERROR') && titleOf(last()).includes('test.boom'), titleOf(last()));

  // 중복 억제(같은 에러 30초)
  const before = sent.length;
  logger.error('test.boom', { err: new Error('something broke') });
  check('같은 에러 30초 내 중복 억제(전송 0건)', sent.length === before, { before, after: sent.length });

  // info 로그는 alert로 안 감
  const b2 = sent.length;
  logger.info('test.fine', { ok: true });
  check('info 로그는 alert 미전송', sent.length === b2);

  // noAlert 표시된 기록(접근 로그 등)은 error여도 alert 미전송 — 503 백프레셔·중복 알림 노이즈 차단
  const b3 = sent.length;
  logger.error('http.request', { statusCode: 500, noAlert: true });
  check('noAlert error 로그는 alert 미전송', sent.length === b3, { b3, after: sent.length });

  console.log('\n결과: ' + pass + '통과 / ' + fail + '실패');
  process.exit(fail ? 1 : 0);
})();
