const MAX_ADMIN_NOTIFICATION_CHARS = 50000;

function validateAdminNotificationMessage(value) {
  if (typeof value !== 'string' || value.trim().length < 2) {
    return { error: '메시지를 2자 이상 입력해주세요.' };
  }
  if (value.length > MAX_ADMIN_NOTIFICATION_CHARS) {
    return { error: '알림 본문은 최대 50,000자까지 보낼 수 있습니다. 내용을 줄여주세요.' };
  }
  return { message: value };
}

module.exports = { MAX_ADMIN_NOTIFICATION_CHARS, validateAdminNotificationMessage };
