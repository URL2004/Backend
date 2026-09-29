const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAdminNotificationMessage, MAX_ADMIN_NOTIFICATION_CHARS } = require('../lib/adminNotification');

test('관리자 장문 알림은 줄바꿈·공백·마지막 문장을 자르지 않는다', () => {
  const message = 'Ⅱ. 시험 문서\r\n\r\n' + '합성 본문과 인용 (2026).\n'.repeat(1200) + '\n마지막 문장.';
  assert.ok(message.length > 21000);
  assert.deepEqual(validateAdminNotificationMessage(message), { message });
});
test('알림 길이 상한은 저장 전 오류이며 조용히 절단하지 않는다', () => {
  const exact = '가'.repeat(MAX_ADMIN_NOTIFICATION_CHARS);
  assert.equal(validateAdminNotificationMessage(exact).message, exact);
  assert.ok(validateAdminNotificationMessage(exact + '나').error);
  for (const value of [null, {}, '', ' \n ', '가']) assert.ok(validateAdminNotificationMessage(value).error);
});
