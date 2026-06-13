import fs from 'node:fs';
import process from 'node:process';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} from '@firebase/rules-unit-testing';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} from 'firebase/firestore';

const PROJECT_ID = 'demo-gp-local';
const ADMIN_UID = 'nC90IyjgaIZ8Z0JTABMTiyQHF9g1';

function user(uid) {
  return { email: `${uid}@example.test` };
}

async function run(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err?.stack || err);
    process.exitCode = 1;
  }
}

const testEnv = await initializeTestEnvironment({
  projectId: PROJECT_ID,
  firestore: {
    host: '127.0.0.1',
    port: 8080,
    rules: fs.readFileSync('firestore.rules', 'utf8')
  }
});

try {
  await testEnv.clearFirestore();

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', 'alice'), {
      email: 'alice@example.test',
      name: 'Alice',
      credits: 10,
      plan: 'free',
      refCode: 'alice001',
      createdAt: '2026-06-13T00:00:00.000Z'
    });
    await setDoc(doc(db, 'qna', 'alice-q1'), {
      title: '비공개 문의',
      body: '환불과 크레딧 관련 본문',
      authorId: 'alice',
      authorName: 'Alice',
      isAnon: false,
      status: 'pending',
      answer: null,
      createdAt: serverTimestamp(),
      views: 0
    });
    await setDoc(doc(db, 'transformJobs', 'job-alice'), {
      uid: 'alice',
      status: 'done',
      result: '민감한 결과'
    });
    await setDoc(doc(db, 'orders', 'order-alice'), {
      uid: 'alice',
      amount: 2900,
      status: 'approved'
    });
  });

  const aliceDb = testEnv.authenticatedContext('alice', user('alice')).firestore();
  const bobDb = testEnv.authenticatedContext('bob', user('bob')).firestore();
  const adminDb = testEnv.authenticatedContext(ADMIN_UID, user(ADMIN_UID)).firestore();
  const anonDb = testEnv.unauthenticatedContext().firestore();

  await run('users: self create with initial free credits allowed', async () => {
    await assertSucceeds(setDoc(doc(bobDb, 'users', 'bob'), {
      email: 'bob@example.test',
      name: 'Bob',
      credits: 10,
      plan: 'free',
      refCode: 'bob00001',
      createdAt: '2026-06-13T00:00:00.000Z'
    }));
  });

  await run('users: client cannot change own credits', async () => {
    await assertFails(updateDoc(doc(aliceDb, 'users', 'alice'), { credits: 9999 }));
  });

  await run('users: client cannot change own plan', async () => {
    await assertFails(updateDoc(doc(aliceDb, 'users', 'alice'), { plan: 'unlimited' }));
  });

  await run('users: allowed profile fields still update', async () => {
    await assertSucceeds(updateDoc(doc(aliceDb, 'users', 'alice'), { name: 'Alice Updated' }));
  });

  await run('users: credit history client write denied', async () => {
    await assertFails(setDoc(doc(aliceDb, 'users', 'alice', 'creditHistory', 'manual'), {
      type: 'use',
      used: 1
    }));
  });

  await run('qna: author can create question', async () => {
    await assertSucceeds(addDoc(collection(aliceDb, 'qna'), {
      title: '새 문의',
      body: '문의 본문',
      authorId: 'alice',
      authorName: 'Alice',
      isAnon: false,
      status: 'pending',
      answer: null,
      createdAt: serverTimestamp(),
      views: 0
    }));
  });

  await run('qna: non-owner cannot get private body', async () => {
    await assertFails(getDoc(doc(bobDb, 'qna', 'alice-q1')));
  });

  await run('qna: owner can get own question', async () => {
    await assertSucceeds(getDoc(doc(aliceDb, 'qna', 'alice-q1')));
  });

  await run('qna: admin can list questions', async () => {
    await assertSucceeds(getDocs(collection(adminDb, 'qna')));
  });

  await run('qna: non-admin full-collection list is denied', async () => {
    await assertFails(getDocs(collection(aliceDb, 'qna')));
  });

  await run('qna: non-admin can list own via authorId query', async () => {
    await assertSucceeds(getDocs(query(collection(aliceDb, 'qna'), where('authorId', '==', 'alice'))));
  });

  await run('qna: non-admin cannot list others via authorId query', async () => {
    await assertFails(getDocs(query(collection(aliceDb, 'qna'), where('authorId', '==', 'bob'))));
  });

  await run('qna: admin can answer', async () => {
    await assertSucceeds(updateDoc(doc(adminDb, 'qna', 'alice-q1'), {
      status: 'answered',
      answer: { body: '답변', answeredBy: '운영팀', answeredAt: serverTimestamp() }
    }));
  });

  await run('posts: regular user can create post with current frontend shape', async () => {
    await assertSucceeds(addDoc(collection(aliceDb, 'posts'), {
      title: '커뮤니티 글',
      body: '본문',
      authorId: 'alice',
      authorName: 'Alice',
      isAnon: false,
      category: '자유',
      isFeatured: false,
      commentCount: 0,
      views: 0,
      createdAt: serverTimestamp(),
      photos: []
    }));
  });

  await run('posts: regular user cannot mark featured on create', async () => {
    await assertFails(addDoc(collection(aliceDb, 'posts'), {
      title: '추천 글 시도',
      body: '본문',
      authorId: 'alice',
      authorName: 'Alice',
      isAnon: false,
      category: '자유',
      isFeatured: true,
      commentCount: 0,
      views: 0,
      createdAt: serverTimestamp(),
      photos: []
    }));
  });

  await run('transformJobs: owner can read own job', async () => {
    await assertSucceeds(getDoc(doc(aliceDb, 'transformJobs', 'job-alice')));
  });

  await run('transformJobs: other user cannot read job', async () => {
    await assertFails(getDoc(doc(bobDb, 'transformJobs', 'job-alice')));
  });

  await run('orders: owner can read own order, other user cannot', async () => {
    await assertSucceeds(getDoc(doc(aliceDb, 'orders', 'order-alice')));
    await assertFails(getDoc(doc(bobDb, 'orders', 'order-alice')));
  });

  await run('anonymous: cannot read user document', async () => {
    await assertFails(getDoc(doc(anonDb, 'users', 'alice')));
  });

  await run('notifications/history: expected client paths still work', async () => {
    await assertSucceeds(addDoc(collection(aliceDb, 'users', 'alice', 'history'), {
      text: '결과',
      createdAt: serverTimestamp()
    }));
    const notifRef = await addDoc(collection(bobDb, 'users', 'alice', 'notifications'), {
      type: 'comment',
      postId: 'post-1',
      message: '댓글이 달렸습니다.',
      createdAt: serverTimestamp(),
      read: false
    });
    await assertSucceeds(updateDoc(doc(aliceDb, 'users', 'alice', 'notifications', notifRef.id), { read: true }));
    await assertSucceeds(deleteDoc(doc(aliceDb, 'users', 'alice', 'notifications', notifRef.id)));
  });
} finally {
  await testEnv.cleanup();
}

if (process.exitCode) process.exit(process.exitCode);
