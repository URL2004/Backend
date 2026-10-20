'use strict';
const { apiError } = require('./clientWriteService');
function safeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/u.test(value))
    throw apiError(400, 'INVALID_INPUT', '문의 ID가 올바르지 않아요.');
  return value;
}
function iso(value) {
  if (value == null) return null;
  const date = value?.toDate ? value.toDate() : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function present(id, data, full = false) {
  return { id, title: data.title || '', authorId: data.authorId || '', authorName: data.authorName || '',
    isAnon: data.isAnon === true, status: 'deleted', previousStatus: data.previousStatus || 'pending',
    createdAt: iso(data.createdAt), deletedAt: iso(data.deletedAt || data.deletedAtMs),
    deletedBy: data.deletedBy || '', deletedByRole: data.deletedByRole || '',
    originalContentComplete: data.originalContentComplete === true,
    ...(full ? { body: data.body || '', answer: data.answer ? { ...data.answer, answeredAt: iso(data.answer.answeredAt) } : null } : {}) };
}
async function listDeletedQuestions(db, { cursor, limit = 100 } = {}) {
  const size = Math.max(1, Math.min(100, Number.isSafeInteger(limit) ? limit : 100));
  let query = db.collection('qnaDeleted').orderBy('__name__');
  if (cursor) query = query.startAfter(safeId(cursor));
  const snap = await query.limit(size + 1).get();
  const docs = snap.docs.slice(0, size);
  return { items: docs.map(doc => present(doc.id, doc.data())),
    nextCursor: snap.docs.length > size ? docs.at(-1).id : null };
}
async function getDeletedQuestion(db, id) {
  const key = safeId(id), snap = await db.collection('qnaDeleted').doc(key).get();
  if (!snap.exists) throw apiError(404, 'QNA_NOT_FOUND', '보관된 문의를 찾을 수 없어요.');
  return { question: present(key, snap.data(), true) };
}
module.exports = { listDeletedQuestions, getDeletedQuestion };
