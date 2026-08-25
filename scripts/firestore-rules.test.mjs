import fs from 'node:fs';
import process from 'node:process';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} from '@firebase/rules-unit-testing';
import {
  addDoc,
  arrayUnion,
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
    await setDoc(doc(db, 'paymentSecrets', 'order-alice'), {
      uid: 'alice',
      paymentKey: 'server-only-payment-key'
    });
    await setDoc(doc(db, 'paymentIntents', 'order-alice'), {
      uid: 'alice',
      amount: 2900,
      status: 'confirming'
    });
    await setDoc(doc(db, 'systemCreditReconciliations', 'order-alice'), {
      orderId: 'order-alice',
      uid: 'alice',
      unrecoveredCredits: 0
    });
    await setDoc(doc(db, 'posts', 'post-alice'), {
      title: '앨리스 글',
      body: '본문',
      authorId: 'alice',
      authorName: 'Alice',
      isAnon: false,
      category: '자유',
      isFeatured: false,
      commentCount: 0,
      views: 0,
      likes: [],
      createdAt: serverTimestamp()
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
      refCode: 'bob',
      createdAt: '2026-06-13T00:00:00.000Z'
    }));
  });

  await run('users: self create with bounded signup attribution allowed', async () => {
    const daveDb = testEnv.authenticatedContext('dave', user('dave')).firestore();
    const touch = {
      version: 1,
      captured_at: '2026-08-24T10:00:00.000Z',
      source: 'meta',
      medium: 'paid_social',
      campaign: 'meta_sales_signup_20260824',
      content: 'carousel_a',
      term: 'broad_18_59',
      napm: '',
      gclid: '',
      fbclid: 'test-click',
      landing_path: '/',
      landing_url: 'https://gpkorea.ai.kr/',
      referrer_host: 'instagram.com'
    };
    await assertSucceeds(setDoc(doc(daveDb, 'users', 'dave'), {
      email: 'dave@example.test',
      name: 'Dave',
      credits: 10,
      plan: 'free',
      refCode: 'dave',
      createdAt: '2026-08-24T10:00:00.000Z',
      signupAttribution: { first_touch: touch, last_touch: touch }
    }));
  });

  await run('users: oversized signup attribution rejected', async () => {
    const erinDb = testEnv.authenticatedContext('erin', user('erin')).firestore();
    const touch = {
      version: 1,
      captured_at: '2026-08-24T10:00:00.000Z',
      source: 'meta',
      medium: 'paid_social',
      campaign: 'x'.repeat(251),
      content: '', term: '', napm: '', gclid: '', fbclid: '',
      landing_path: '/', landing_url: 'https://gpkorea.ai.kr/', referrer_host: ''
    };
    await assertFails(setDoc(doc(erinDb, 'users', 'erin'), {
      email: 'erin@example.test', name: 'Erin', credits: 10, plan: 'free', refCode: 'erin',
      createdAt: '2026-08-24T10:00:00.000Z',
      signupAttribution: { first_touch: touch, last_touch: touch }
    }));
  });

  await run('users: cannot self-create with attacker-chosen refCode (C-08)', async () => {
    await assertFails(setDoc(doc(testEnv.authenticatedContext('carol', user('carol')).firestore(), 'users', 'carol'), {
      email: 'carol@example.test',
      name: 'Carol',
      credits: 10,
      plan: 'free',
      refCode: 'PROMO999',
      createdAt: '2026-06-13T00:00:00.000Z'
    }));
  });

  await run('users: cannot change refCode to arbitrary value (C-08)', async () => {
    await assertFails(updateDoc(doc(aliceDb, 'users', 'alice'), { refCode: 'hacked12' }));
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

  await run('payment reconciliation: owner and admin cannot access server-only documents', async () => {
    for (const collectionName of ['paymentSecrets', 'paymentIntents', 'systemCreditReconciliations']) {
      await assertFails(getDoc(doc(aliceDb, collectionName, 'order-alice')));
      await assertFails(getDoc(doc(adminDb, collectionName, 'order-alice')));
      await assertFails(setDoc(doc(aliceDb, collectionName, 'forged-order'), { uid: 'alice' }));
    }
  });

  await run('anonymous: cannot read user document', async () => {
    await assertFails(getDoc(doc(anonDb, 'users', 'alice')));
  });

  await run('history: owner can write own history', async () => {
    await assertSucceeds(addDoc(collection(aliceDb, 'users', 'alice', 'history'), {
      text: '결과',
      createdAt: serverTimestamp()
    }));
  });

  await run('notifications: commenter can notify the actual post author (H-01 legit)', async () => {
    const notifRef = await addDoc(collection(bobDb, 'users', 'alice', 'notifications'), {
      type: 'comment',
      title: '새 댓글',
      message: 'Bob님이 댓글을 달았어요',
      action: { type: 'post', postId: 'post-alice' },
      postId: 'post-alice',
      read: false,
      createdAt: serverTimestamp(),
      createdAtMs: 123
    });
    await assertSucceeds(updateDoc(doc(aliceDb, 'users', 'alice', 'notifications', notifRef.id), { read: true }));
    await assertSucceeds(deleteDoc(doc(aliceDb, 'users', 'alice', 'notifications', notifRef.id)));
  });

  await run('notifications: cannot notify a user who is not the post author (H-01)', async () => {
    await assertFails(addDoc(collection(aliceDb, 'users', 'bob', 'notifications'), {
      type: 'comment', message: '피싱 시도', postId: 'post-alice',
      read: false, createdAt: serverTimestamp()
    }));
  });

  await run('notifications: cannot notify referencing a non-existent post (H-01)', async () => {
    await assertFails(addDoc(collection(bobDb, 'users', 'alice', 'notifications'), {
      type: 'comment', message: '없는 글 참조', postId: 'no-such-post',
      read: false, createdAt: serverTimestamp()
    }));
  });

  await run('notifications: non-admin cannot send arbitrary cross-user notice (H-01)', async () => {
    await assertFails(addDoc(collection(bobDb, 'users', 'alice', 'notifications'), {
      type: 'system', message: '가짜 시스템 공지',
      read: false, createdAt: serverTimestamp()
    }));
  });

  await run('notifications: user can create own self-notification', async () => {
    await assertSucceeds(addDoc(collection(aliceDb, 'users', 'alice', 'notifications'), {
      type: 'notice', message: '내 알림', read: false, createdAt: serverTimestamp()
    }));
  });

  await run('notifications: admin can send notification to a user', async () => {
    await assertSucceeds(addDoc(collection(adminDb, 'users', 'alice', 'notifications'), {
      type: 'qna', message: '문의 답변이 등록됐어요', read: false, createdAt: serverTimestamp()
    }));
  });

  await run('posts: viewer can increment views by exactly 1 (H-03 legit)', async () => {
    await assertSucceeds(updateDoc(doc(bobDb, 'posts', 'post-alice'), { views: increment(1) }));
  });

  await run('posts: cannot set views to an arbitrary value (H-03)', async () => {
    await assertFails(updateDoc(doc(bobDb, 'posts', 'post-alice'), { views: 99999 }));
  });

  await run('posts: cannot bump commentCount by more than 1 (H-03)', async () => {
    await assertFails(updateDoc(doc(bobDb, 'posts', 'post-alice'), { commentCount: increment(50) }));
  });

  await run('posts: user can toggle own like (H-03 legit)', async () => {
    await assertSucceeds(updateDoc(doc(bobDb, 'posts', 'post-alice'), { likes: arrayUnion('bob') }));
  });

  await run('posts: cannot add another user to likes (H-03)', async () => {
    await assertFails(updateDoc(doc(bobDb, 'posts', 'post-alice'), { likes: arrayUnion('carol') }));
  });

  await run('posts: cannot overwrite likes with arbitrary array (H-03)', async () => {
    await assertFails(updateDoc(doc(bobDb, 'posts', 'post-alice'), { likes: ['bob', 'x1', 'x2', 'x3'] }));
  });
} finally {
  await testEnv.cleanup();
}

if (process.exitCode) process.exit(process.exitCode);
