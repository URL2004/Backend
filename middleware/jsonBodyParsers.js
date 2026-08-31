'use strict';

const contentLengthLimit = require('./contentLengthLimit');

const LARGE_JSON_PATHS = ['/transform', '/writing-lab', '/admin'];
const SMALL_JSON_PATHS = [
  '/checkout-context', '/confirm-payment', '/request-refund', '/approve-refund',
  '/reject-refund', '/apply-referral', '/redeem-coupon', '/delete-account',
  '/kakao-login', '/subscription', '/events'
];

// 경로별 body-parser 자체 limit를 둬 Content-Length가 없는 chunked 전송도 스트리밍
// 도중 차단한다. 경로 파서가 완료된 요청은 뒤의 전역 파서가 다시 읽지 않는다.
function installJsonBodyParsers(app, express) {
  app.use(LARGE_JSON_PATHS, contentLengthLimit(2 * 1024 * 1024), express.json({ limit: '2mb' }));
  app.use(SMALL_JSON_PATHS, contentLengthLimit(256 * 1024), express.json({ limit: '256kb' }));
  app.use(express.json({ limit: '2mb' }));
}

module.exports = { installJsonBodyParsers, LARGE_JSON_PATHS, SMALL_JSON_PATHS };
