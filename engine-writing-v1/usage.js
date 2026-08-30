'use strict';

const { db, admin } = require('../config');
const { logger } = require('../lib/logger');
const { accountDeletionBlocksWrites } = require('../lib/accountActivityClaims');

const memory = new Map();
const committed = new Set();

function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function memoryKey(uid, day = dayKey()) { return `${day}:${uid}`; }

async function successfulCount(uid) {
  const day = dayKey();
  if (!db) return memory.get(memoryKey(uid, day)) || 0;
  try {
    const snap = await db.collection('writingLabDailyUsage').doc(`${day}_${uid}`).get();
    return Number(snap.exists ? snap.data()?.successfulGenerations : 0) || 0;
  } catch (error) {
    logger.error('writinglab.usage_read_failed', { uid, day, err: error });
    const unavailable = new Error('WRITING_USAGE_UNAVAILABLE');
    unavailable.code = 'WRITING_USAGE_UNAVAILABLE';
    unavailable.status = 503;
    throw unavailable;
  }
}

async function commitSuccessful(uid, requestId, cap) {
  const day = dayKey();
  if (!db || !admin) return commitMemory(uid, requestId, cap, day);
  try {
    const usageRef = db.collection('writingLabDailyUsage').doc(`${day}_${uid}`);
    const requestRef = db.collection('writingLabGenerationCommits').doc(requestId);
    const deletionRef = db.collection('accountDeletionJobs').doc(uid);
    return await db.runTransaction(async transaction => {
      const [usageSnap, requestSnap, deletionSnap] = await Promise.all([
        transaction.get(usageRef),
        transaction.get(requestRef),
        transaction.get(deletionRef),
      ]);
      if (deletionSnap.exists
        && accountDeletionBlocksWrites(deletionSnap.data() || {})) {
        return { committed: false, unavailable: true, accountDeletion: true, count: null };
      }
      if (requestSnap.exists) {
        return { committed: false, duplicate: true, count: Number(usageSnap.data()?.successfulGenerations || 0) };
      }
      const count = Number(usageSnap.exists ? usageSnap.data()?.successfulGenerations : 0) || 0;
      if (count >= cap) return { committed: false, capReached: true, count };
      const next = count + 1;
      transaction.set(usageRef, {
        uid,
        day,
        successfulGenerations: next,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      transaction.create(requestRef, {
        uid,
        day,
        operation: 'writing_lab_v2_generate',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return { committed: true, count: next };
    });
  } catch (error) {
    logger.error('writinglab.usage_commit_failed', { uid, day, requestId, err: error });
    return { committed: false, unavailable: true, count: null };
  }
}

function commitMemory(uid, requestId, cap, day = dayKey()) {
  if (committed.has(requestId)) return { committed: false, duplicate: true, count: memory.get(memoryKey(uid, day)) || 0 };
  const key = memoryKey(uid, day);
  const count = memory.get(key) || 0;
  if (count >= cap) return { committed: false, capReached: true, count };
  committed.add(requestId);
  memory.set(key, count + 1);
  return { committed: true, count: count + 1 };
}

function resetMemoryForTests() {
  memory.clear();
  committed.clear();
}

module.exports = { dayKey, successfulCount, commitSuccessful, resetMemoryForTests };
