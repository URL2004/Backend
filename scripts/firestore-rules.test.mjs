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
  },
  storage: {
    host: '127.0.0.1',
    port: 9199,
    rules: fs.readFileSync('storage.rules', 'utf8')
  }
});

try {
  await testEnv.clearFirestore();
  await testEnv.clearStorage();

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
    await setDoc(doc(db, 'subscriptionOrders', 'subscription-alice'), {
      uid: 'alice',
      amount: 14900,
      status: 'paid'
    });
    await setDoc(doc(db, 'authIdentities', 'kakao_12345'), {
      provider: 'kakao',
      providerUserId: '12345',
      uid: 'alice'
    });
    await setDoc(doc(db, 'users', 'alice', 'history', 'history-alice'), {
      type: 'humanize',
      inputText: '원문',
      outputText: '결과',
      createdAt: serverTimestamp()
    });
    await setDoc(doc(db, 'users', 'alice', 'notifications', 'notice-alice'), {
      type: 'notice',
      message: '본인 알림',
      read: false,
      createdAt: serverTimestamp(),
      legacyCommunityField: '과거 필드'
    });
    await setDoc(doc(db, 'notices', 'public-notice'), {
      title: '운영 공지',
      body: '공지 본문',
      createdAt: serverTimestamp()
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
    await setDoc(doc(db, 'posts', 'post-alice', 'comments', 'comment-bob'), {
      body: '과거 댓글',
      authorId: 'bob',
      authorName: 'Bob',
      isAnon: false,
      createdAt: serverTimestamp()
    });
  });

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.storage('gs://demo-gp-local.appspot.com')
      .ref('community/alice/legacy-image.png')
      .putString('legacy object');
  });

  const aliceDb = testEnv.authenticatedContext('alice', user('alice')).firestore();
  const bobDb = testEnv.authenticatedContext('bob', user('bob')).firestore();
  const adminDb = testEnv.authenticatedContext(ADMIN_UID, user(ADMIN_UID)).firestore();
  const anonDb = testEnv.unauthenticatedContext().firestore();

  await run('users: initial free-credit documents are server-only', async () => {
    await assertFails(setDoc(doc(bobDb, 'users', 'bob'), {
      email: 'bob@example.test',
      name: 'Bob',
      credits: 10,
      plan: 'free',
      refCode: 'bob',
      createdAt: '2026-06-13T00:00:00.000Z'
    }));
  });

  await run('users: even well-formed attribution cannot bypass server initialization', async () => {
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
    await assertFails(setDoc(doc(daveDb, 'users', 'dave'), {
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
    await assertFails(updateDoc(doc(aliceDb, 'users', 'alice'), { name: 'x'.repeat(81) }));
  });

  await run('users: authentication binding kakaoId is server-only', async () => {
    await assertFails(updateDoc(doc(aliceDb, 'users', 'alice'), { kakaoId: '123456789' }));
  });

  await run('users: closed-community bookmarks are no longer client-writable', async () => {
    await assertFails(updateDoc(doc(aliceDb, 'users', 'alice'), { bookmarks: ['post-alice'] }));
  });

  await run('users: owner and admin can read while other users cannot', async () => {
    await assertSucceeds(getDoc(doc(aliceDb, 'users', 'alice')));
    await assertSucceeds(getDoc(doc(adminDb, 'users', 'alice')));
    await assertSucceeds(getDocs(collection(adminDb, 'users')));
    await assertFails(getDoc(doc(bobDb, 'users', 'alice')));
    await assertFails(getDocs(collection(bobDb, 'users')));
  });

  await run('users: credit history client write denied', async () => {
    await assertFails(setDoc(doc(aliceDb, 'users', 'alice', 'creditHistory', 'manual'), {
      type: 'use',
      used: 1
    }));
  });

  await run('qna: client question creation is server-only', async () => {
    await assertFails(addDoc(collection(aliceDb, 'qna'), {
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

  await run('qna: oversized or malformed questions are rejected', async () => {
    await assertFails(addDoc(collection(aliceDb, 'qna'), {
      title: 'x'.repeat(161), body: '본문', authorId: 'alice', authorName: 'Alice',
      isAnon: false, status: 'pending', answer: null, createdAt: serverTimestamp(), views: 0
    }));
    await assertFails(addDoc(collection(aliceDb, 'qna'), {
      title: '정상 제목', body: '본문', authorId: 'alice', authorName: 'Alice',
      isAnon: false, status: 'pending', answer: null, createdAt: serverTimestamp(), views: 1
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

  await run('qna: even admin clients must answer through the authenticated API', async () => {
    await assertFails(updateDoc(doc(adminDb, 'qna', 'alice-q1'), {
      status: 'answered',
      answer: { body: '답변', answeredBy: '운영팀', answeredAt: serverTimestamp() }
    }));
  });

  await run('qna: client update and delete paths are fully closed', async () => {
    await assertFails(updateDoc(doc(aliceDb, 'qna', 'alice-q1'), { views: 1 }));
    await assertFails(updateDoc(doc(aliceDb, 'qna', 'alice-q1'), { moderationOverride: true }));
    await assertFails(updateDoc(doc(aliceDb, 'qna', 'alice-q1'), { status: 'pending' }));
    await assertFails(deleteDoc(doc(aliceDb, 'qna', 'alice-q1')));
    await assertFails(deleteDoc(doc(adminDb, 'qna', 'alice-q1')));
  });

  await run('community closed: anonymous, user, and admin cannot read posts', async () => {
    for (const db of [anonDb, aliceDb, adminDb]) {
      await assertFails(getDoc(doc(db, 'posts', 'post-alice')));
      await assertFails(getDocs(collection(db, 'posts')));
    }
  });

  await run('community closed: user and admin cannot create, update, or delete posts', async () => {
    const forgedPost = {
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
    };
    await assertFails(addDoc(collection(aliceDb, 'posts'), forgedPost));
    await assertFails(updateDoc(doc(aliceDb, 'posts', 'post-alice'), { title: '수정 시도' }));
    await assertFails(deleteDoc(doc(aliceDb, 'posts', 'post-alice')));
    await assertFails(updateDoc(doc(adminDb, 'posts', 'post-alice'), { hidden: true }));
    await assertFails(deleteDoc(doc(adminDb, 'posts', 'post-alice')));
  });

  await run('community closed: nested comments are denied to every client role', async () => {
    for (const db of [anonDb, aliceDb, bobDb, adminDb]) {
      await assertFails(getDoc(doc(db, 'posts', 'post-alice', 'comments', 'comment-bob')));
      await assertFails(getDocs(collection(db, 'posts', 'post-alice', 'comments')));
    }
    await assertFails(addDoc(collection(bobDb, 'posts', 'post-alice', 'comments'), {
      body: '새 댓글', authorId: 'bob', createdAt: serverTimestamp()
    }));
    await assertFails(updateDoc(doc(bobDb, 'posts', 'post-alice', 'comments', 'comment-bob'), { body: '수정' }));
    await assertFails(deleteDoc(doc(adminDb, 'posts', 'post-alice', 'comments', 'comment-bob')));
  });

  await run('transformJobs: owner can read own job', async () => {
    await assertSucceeds(getDoc(doc(aliceDb, 'transformJobs', 'job-alice')));
  });

  await run('transformJobs: other user cannot read job', async () => {
    await assertFails(getDoc(doc(bobDb, 'transformJobs', 'job-alice')));
  });

  await run('orders: owner and admin can read; other users and all client writes are denied', async () => {
    await assertSucceeds(getDoc(doc(aliceDb, 'orders', 'order-alice')));
    await assertSucceeds(getDoc(doc(adminDb, 'orders', 'order-alice')));
    await assertSucceeds(getDocs(query(collection(aliceDb, 'orders'), where('uid', '==', 'alice'))));
    await assertFails(getDocs(collection(aliceDb, 'orders')));
    await assertFails(getDoc(doc(bobDb, 'orders', 'order-alice')));
    await assertFails(updateDoc(doc(aliceDb, 'orders', 'order-alice'), { amount: 1 }));
    await assertFails(deleteDoc(doc(adminDb, 'orders', 'order-alice')));
  });

  await run('subscriptionOrders: owner and admin can read; other users and writes are denied', async () => {
    await assertSucceeds(getDoc(doc(aliceDb, 'subscriptionOrders', 'subscription-alice')));
    await assertSucceeds(getDoc(doc(adminDb, 'subscriptionOrders', 'subscription-alice')));
    await assertSucceeds(getDocs(query(collection(aliceDb, 'subscriptionOrders'), where('uid', '==', 'alice'))));
    await assertFails(getDocs(collection(aliceDb, 'subscriptionOrders')));
    await assertFails(getDoc(doc(bobDb, 'subscriptionOrders', 'subscription-alice')));
    await assertFails(updateDoc(doc(aliceDb, 'subscriptionOrders', 'subscription-alice'), { status: 'refunded' }));
  });

  await run('authIdentities: provider bindings are opaque and server-only', async () => {
    for (const db of [anonDb, aliceDb, adminDb]) {
      await assertFails(getDoc(doc(db, 'authIdentities', 'kakao_12345')));
      await assertFails(getDocs(collection(db, 'authIdentities')));
    }
    await assertFails(setDoc(doc(aliceDb, 'authIdentities', 'kakao_99999'), {
      provider: 'kakao', providerUserId: '99999', uid: 'alice'
    }));
    await assertFails(updateDoc(doc(adminDb, 'authIdentities', 'kakao_12345'), { uid: 'bob' }));
    await assertFails(deleteDoc(doc(adminDb, 'authIdentities', 'kakao_12345')));
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

  await run('history: owner can read but all client writes use the backup API', async () => {
    await assertSucceeds(getDoc(doc(aliceDb, 'users', 'alice', 'history', 'history-alice')));
    await assertFails(addDoc(collection(aliceDb, 'users', 'alice', 'history'), {
      type: 'humanize', inputText: '원문', outputText: '결과', credits: 1,
      createdAt: serverTimestamp()
    }));
    await assertFails(deleteDoc(doc(aliceDb, 'users', 'alice', 'history', 'history-alice')));
  });

  await run('payment and subscription race claims are opaque to owner and admin clients', async () => {
    for (const collectionName of [
      'paymentAccountClaims', 'subscriptionOperationClaims', 'subscriptionRefundClaims',
      'accountActivityClaims'
    ]) {
      for (const db of [aliceDb, adminDb]) {
        await assertFails(getDoc(doc(db, collectionName, 'alice')));
        await assertFails(setDoc(doc(db, collectionName, 'alice'), { status: 'forged' }));
        await assertFails(deleteDoc(doc(db, collectionName, 'alice')));
      }
    }
  });

  await run('account signup security fingerprints are opaque to owner and admin clients', async () => {
    for (const db of [aliceDb, adminDb]) {
      await assertFails(getDoc(doc(db, 'accountSecurity', 'alice')));
      await assertFails(setDoc(doc(db, 'accountSecurity', 'alice'), {
        signupClientPrincipal: 'forged', createdAtMs: Date.now()
      }));
      await assertFails(deleteDoc(doc(db, 'accountSecurity', 'alice')));
    }
  });

  await run('history: arbitrary fields and oversized text are rejected', async () => {
    await assertFails(addDoc(collection(aliceDb, 'users', 'alice', 'history'), {
      type: 'humanize', inputText: '원문', outputText: '결과', credits: 1,
      createdAt: serverTimestamp(), serverTrusted: true
    }));
    await assertFails(addDoc(collection(aliceDb, 'users', 'alice', 'history'), {
      type: 'humanize', inputText: 'x'.repeat(60001), credits: 1,
      createdAt: serverTimestamp()
    }));
  });

  await run('history: cross-user reads and writes plus owner updates are denied', async () => {
    await assertFails(getDoc(doc(bobDb, 'users', 'alice', 'history', 'history-alice')));
    await assertFails(getDocs(collection(bobDb, 'users', 'alice', 'history')));
    await assertFails(addDoc(collection(bobDb, 'users', 'alice', 'history'), { text: '위조' }));
    await assertFails(updateDoc(doc(aliceDb, 'users', 'alice', 'history', 'history-alice'), { outputText: '변조' }));
  });

  await run('notifications: owner can read, mark, and delete own notifications', async () => {
    await assertSucceeds(getDoc(doc(aliceDb, 'users', 'alice', 'notifications', 'notice-alice')));
    await assertSucceeds(getDocs(collection(aliceDb, 'users', 'alice', 'notifications')));
    await assertSucceeds(updateDoc(doc(aliceDb, 'users', 'alice', 'notifications', 'notice-alice'), { read: true }));
    await assertFails(updateDoc(doc(aliceDb, 'users', 'alice', 'notifications', 'notice-alice'), { read: false }));
    await assertFails(updateDoc(doc(aliceDb, 'users', 'alice', 'notifications', 'notice-alice'), { message: '알림 변조' }));
    await assertSucceeds(deleteDoc(doc(aliceDb, 'users', 'alice', 'notifications', 'notice-alice')));
    await assertFails(getDocs(collection(adminDb, 'users', 'alice', 'notifications')));
  });

  await run('notifications: closed community cannot send cross-user comment notifications', async () => {
    await assertFails(addDoc(collection(bobDb, 'users', 'alice', 'notifications'), {
      type: 'comment', message: '댓글 알림 위조', postId: 'post-alice',
      read: false, createdAt: serverTimestamp()
    }));
  });

  await run('notifications: non-admin cannot send arbitrary cross-user notice (H-01)', async () => {
    await assertFails(addDoc(collection(bobDb, 'users', 'alice', 'notifications'), {
      type: 'system', message: '가짜 시스템 공지',
      read: false, createdAt: serverTimestamp()
    }));
  });

  await run('notifications: user cannot create own self-notification', async () => {
    await assertFails(addDoc(collection(aliceDb, 'users', 'alice', 'notifications'), {
      type: 'notice', message: '내 알림', read: false, createdAt: serverTimestamp()
    }));
  });

  await run('notifications: oversized and unknown fields are rejected', async () => {
    await assertFails(addDoc(collection(aliceDb, 'users', 'alice', 'notifications'), {
      type: 'notice', message: 'x'.repeat(2001), read: false, createdAt: serverTimestamp()
    }));
    await assertFails(addDoc(collection(aliceDb, 'users', 'alice', 'notifications'), {
      type: 'notice', message: '내 알림', read: false, createdAt: serverTimestamp(), admin: true
    }));
  });

  await run('notifications: admin browser writes also use the server API', async () => {
    await assertFails(addDoc(collection(adminDb, 'users', 'alice', 'notifications'), {
      type: 'qna', message: '문의 답변이 등록됐어요', read: false, createdAt: serverTimestamp()
    }));
  });

  await run('client write quota counters are unreadable and unwritable by every client role', async () => {
    for (const db of [anonDb, aliceDb, adminDb]) {
      await assertFails(getDoc(doc(db, 'clientWriteQuotas', 'quota-row')));
      await assertFails(setDoc(doc(db, 'clientWriteQuotas', 'quota-row'), { hourCount: 0 }));
    }
  });

  await run('security rate-limit counters are opaque and server-only', async () => {
    for (const db of [anonDb, aliceDb, adminDb]) {
      await assertFails(getDoc(doc(db, 'securityRateLimits', 'hashed-principal')));
      await assertFails(setDoc(doc(db, 'securityRateLimits', 'hashed-principal'), {
        scope: 'payment', hourCount: 0, dayCount: 0
      }));
    }
  });

  await run('notices: public reads remain available while only admins can mutate', async () => {
    await assertSucceeds(getDoc(doc(anonDb, 'notices', 'public-notice')));
    await assertSucceeds(getDocs(collection(anonDb, 'notices')));
    await assertFails(addDoc(collection(aliceDb, 'notices'), { title: '위조 공지', body: '본문' }));
    await assertSucceeds(updateDoc(doc(adminDb, 'notices', 'public-notice'), { title: '수정 공지' }));
  });

  await run('storage: anonymous, user, and admin clients cannot read legacy community objects', async () => {
    for (const ctx of [
      testEnv.unauthenticatedContext(),
      testEnv.authenticatedContext('alice', user('alice')),
      testEnv.authenticatedContext(ADMIN_UID, user(ADMIN_UID))
    ]) {
      await assertFails(ctx.storage('gs://demo-gp-local.appspot.com')
        .ref('community/alice/legacy-image.png')
        .getMetadata());
    }
  });

  await run('storage: every client write path is denied by default', async () => {
    const aliceStorage = testEnv.authenticatedContext('alice', user('alice'))
      .storage('gs://demo-gp-local.appspot.com');
    const adminStorage = testEnv.authenticatedContext(ADMIN_UID, user(ADMIN_UID))
      .storage('gs://demo-gp-local.appspot.com');
    await assertFails(aliceStorage.ref('community/alice/new-image.png').putString('forged'));
    await assertFails(aliceStorage.ref('users/alice/profile.png').putString('forged'));
    await assertFails(adminStorage.ref('admin/export.json').putString('forged'));
    await assertFails(aliceStorage.ref('community/alice/legacy-image.png').delete());
  });
} finally {
  await testEnv.cleanup();
}

if (process.exitCode) process.exit(process.exitCode);
