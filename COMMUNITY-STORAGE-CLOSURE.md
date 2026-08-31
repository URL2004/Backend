# 커뮤니티 Storage 다운로드 토큰 폐쇄

Firestore·Storage Rules를 닫아도 과거에 발급된 Firebase 다운로드 토큰 URL은 계속 열릴 수 있습니다. 아래 도구는 객체를 삭제하지 않고 `community_photos/` 아래 객체의 `firebaseStorageDownloadTokens` custom metadata만 제거합니다. `contentType`, `cacheControl`과 다른 custom metadata는 건드리지 않습니다.

## 안전 원칙

- 기본 실행은 dry-run이며 변경하지 않습니다.
- `--apply`를 명시해야만 토큰을 제거합니다.
- apply 전에 `.security-manifests/`에 토큰 복구 매니페스트를 원자적으로 기록합니다. 이 폴더는 Git에서 제외됩니다.
- 콘솔에는 객체명·UID·토큰을 출력하지 않고 건수와 HMAC 식별자만 출력합니다.
- 페이지 단위 조회와 일시 오류 재시도를 적용합니다. 일부 객체가 실패하면 종료 코드 `2`, 조회·설정 자체가 불가능하면 `1`입니다.

## 자격증명과 실행

Storage bucket 이름을 정확히 확인하고 Firebase Admin 서비스 계정을 환경변수로 제공합니다. 현재 로컬 gcloud 계정처럼 bucket list 권한이 없는 계정으로는 실행하지 않습니다.

```powershell
$env:FIREBASE_SERVICE_ACCOUNT='<Firebase Admin 서비스 계정 JSON>'
$env:FIREBASE_STORAGE_BUCKET='<정확한 bucket 이름>'

# 1. 조회만
npm run security:community-storage-tokens

# 2. dry-run 건수를 확인한 뒤 명시적으로 적용
npm run security:community-storage-tokens -- --apply
```

결과의 `manifest` 파일명은 별도 보안 기록에 남깁니다. 내용에는 복구에 필요한 객체명과 토큰이 있으므로 공유하거나 저장소에 추가하지 않습니다.

## 롤백

```powershell
npm run security:community-storage-tokens -- --rollback=community-storage-token-backup-<시각>-<식별자>.json
```

롤백은 매니페스트 무결성, 고정 prefix, bucket 일치를 확인합니다. 다른 토큰이 이미 새로 발급된 객체는 덮어쓰지 않고 부분 실패로 남깁니다.
