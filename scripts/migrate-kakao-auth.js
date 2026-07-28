// 기존 카카오 계정의 예측 가능한 Firebase password 자격증명을 폐기하는 일회성 스크립트.
//
// 기본 실행은 읽기 전용 드라이런:
//   node scripts/migrate-kakao-auth.js
//
// 실제 적용은 새 백엔드·프런트 배포가 끝난 뒤에만:
//   $env:CONFIRM_KAKAO_AUTH_MIGRATION='I_HAVE_DEPLOYED_KAKAO_CUSTOM_AUTH'
//   node scripts/migrate-kakao-auth.js --apply
//
// 출력에는 UID, 이메일, 카카오 ID, 교체 비밀번호를 남기지 않는다.

require('dotenv').config();

const { admin, db } = require('../config');
const {
  KAKAO_AUTH_VERSION,
  hasPasswordProvider,
  legacyKakaoIdFromEmail,
  secureLegacyPassword
} = require('../lib/kakaoAuth');

const APPLY = process.argv.includes('--apply');
const REQUIRED_CONFIRMATION = 'I_HAVE_DEPLOYED_KAKAO_CUSTOM_AUTH';

function hasAppliedVersion(userRecord) {
  return Number(userRecord?.customClaims?.kakaoCustomAuthVersion) >= KAKAO_AUTH_VERSION;
}

async function main() {
  if (!admin || !db) throw new Error('FIREBASE_SERVICE_ACCOUNT가 설정되어야 합니다.');
  if (APPLY && process.env.CONFIRM_KAKAO_AUTH_MIGRATION !== REQUIRED_CONFIRMATION) {
    throw new Error(`실제 적용에는 CONFIRM_KAKAO_AUTH_MIGRATION=${REQUIRED_CONFIRMATION} 확인값이 필요합니다.`);
  }

  const auth = admin.auth();
  const candidates = new Map();
  const firestoreUsers = await db.collection('users').select('kakaoId').get();
  for (const doc of firestoreUsers.docs) {
    const kakaoId = String(doc.data()?.kakaoId || '').trim();
    if (/^\d{1,32}$/.test(kakaoId)) candidates.set(doc.id, { kakaoId, hasUserDoc: true });
  }

  const authUsers = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    authUsers.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);

  for (const userRecord of authUsers) {
    if (!hasPasswordProvider(userRecord)) continue;
    const syntheticKakaoId = legacyKakaoIdFromEmail(userRecord.email);
    if (syntheticKakaoId && !candidates.has(userRecord.uid)) {
      candidates.set(userRecord.uid, { kakaoId: syntheticKakaoId, hasUserDoc: false });
    }
  }

  const authByUid = new Map(authUsers.map(user => [user.uid, user]));
  const stats = {
    mode: APPLY ? 'apply' : 'dry-run',
    firestoreUsersScanned: firestoreUsers.size,
    authUsersScanned: authUsers.length,
    candidates: candidates.size,
    passwordCandidates: 0,
    alreadyMigrated: 0,
    rotated: 0,
    missingAuthUser: 0,
    nonPasswordCandidate: 0,
    unresolvedPasswordUsers: 0,
    errors: 0
  };

  const candidateUids = new Set(candidates.keys());
  stats.unresolvedPasswordUsers = authUsers.filter(user =>
    hasPasswordProvider(user) && !candidateUids.has(user.uid) && !hasAppliedVersion(user)
  ).length;

  for (const [uid, candidate] of candidates) {
    const userRecord = authByUid.get(uid);
    if (!userRecord) {
      stats.missingAuthUser++;
      continue;
    }
    if (!hasPasswordProvider(userRecord)) {
      stats.nonPasswordCandidate++;
      continue;
    }
    stats.passwordCandidates++;
    if (hasAppliedVersion(userRecord)) {
      stats.alreadyMigrated++;
      continue;
    }
    if (!APPLY) continue;

    try {
      const secured = await secureLegacyPassword(auth, userRecord);
      if (secured.passwordRotated) stats.rotated++;

      const userRef = db.collection('users').doc(uid);
      const userSnap = await userRef.get();
      if (userSnap.exists) {
        await userRef.set({
          kakaoId: candidate.kakaoId,
          authProvider: 'kakao',
          kakaoAuthVersion: KAKAO_AUTH_VERSION,
          kakaoAuthMigratedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }
    } catch {
      stats.errors++;
    }
  }

  process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
  if (stats.errors) process.exitCode = 1;
}

main().catch(err => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
  process.exitCode = 1;
});
