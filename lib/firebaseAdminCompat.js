'use strict';

// firebase-admin 14.x는 루트 패키지의 admin.firestore()/admin.auth() 네임스페이스를 제거했다.
// 운영 코드의 기존 호출 계약은 유지하되 실제 구현은 14.x modular API로만 연결한다.
const appApi = require('firebase-admin/app');
const firestoreApi = require('firebase-admin/firestore');
const authApi = require('firebase-admin/auth');
const appCheckApi = require('firebase-admin/app-check');
const storageApi = require('firebase-admin/storage');

function firestore(app) {
  return firestoreApi.getFirestore(app);
}
firestore.FieldValue = firestoreApi.FieldValue;
firestore.FieldPath = firestoreApi.FieldPath;
firestore.Timestamp = firestoreApi.Timestamp;
firestore.GeoPoint = firestoreApi.GeoPoint;

function auth(app) {
  return authApi.getAuth(app);
}

function appCheck(app) {
  return appCheckApi.getAppCheck(app);
}

function storage(app) {
  return storageApi.getStorage(app);
}

module.exports = {
  ...appApi,
  credential: {
    applicationDefault: appApi.applicationDefault,
    cert: appApi.cert,
    refreshToken: appApi.refreshToken
  },
  firestore,
  auth,
  appCheck,
  storage
};
