# 기존 감지·휴머나이징 이력의 검색 인덱스 보완

신규 이력은 검색 hash를 저장하지만 과거 기록은 최근50/200건 탐색 범위 밖에 있을 수 있다. 이 도구는 운영자가 소유 관계를 별도로 확인한 **명시적 UID 한 개**의 이력만 페이지 단위로 검사한다. 계정 목록을 열거하지 않는다. 실행 전 `firestore.indexes.json`의 `history.detectInputHash + createdAt`, `history.calibrationTextHash + createdAt` 두 복합 인덱스가 READY인지 운영 담당자가 확인한다.

필수 환경: 해당 프로젝트의 Admin SDK 인증(`FIREBASE_SERVICE_ACCOUNT` 또는 Application Default Credentials)과 기존 이력을 서명한 `OPENAI_SAFETY_SALT`. 키가 없으면 누락을 정상 결과로 오인하지 않도록 중단한다. `.env`를 자동 로드하지 않는다. 서비스 계정 JSON·서명 키를 명령 인자나 로그에 쓰지 않는다.

```powershell
# 기본은 읽기 전용 dry-run. $targetUid는 별도 소유 검증을 마친 값이다.
node scripts/backfill-detect-history-index.js --uid $targetUid --page-size 100

# dry-run 집계 검토와 인덱스 READY 확인 후에만 필드 반영
node scripts/backfill-detect-history-index.js --uid $targetUid --page-size 100 --apply
```

`--uid`는 필수이고 `--page-size`는1–500, 기본100이다. `--apply`가 없으면 쓰지 않는다. 콘솔은 모드·페이지·건수·허용된 실패 코드만 출력하며 UID·본문·이력 ID·hash·SDK 오류 전문을 출력하지 않는다. 셸 명령 기록/프로세스 인자는 별개이므로 신뢰할 수 있는 운영 환경에서 실행한다.

색인 자격은 다음과 같다.

- 감지: `type=detect`, `savedBy=server`, `probSource=llm/cached_llm`, 유효한0–100 점수 필드와 비어 있지 않은 문자열 입력이 있어야 `detectInputHash`를 만든다. 보정된 감지 이력도 조회 순서를 정확히 보존하기 위해 색인하며, 실제 원점수 상한으로 사용할 수 있는지는 기존 runtime 검증이 계속 거절/허용한다. 서버 전용 기록이라는 기존 저장 권한을 신뢰하며 원점수에 새 서명을 발급하지 않는다.
- 휴머나이징: `savedBy=server`이고 해당 UID·출력·전달 적격성에 대한 기존 HMAC 검증을 통과해야 `calibrationTextHash`를 만든다. 허용된 구형v2 서명은 기존 검증 규칙대로만 인정한다. unsigned·변조·다른 계정의 서명·클라이언트 백업은 색인하지 않는다.

apply는 각 기록을 transaction 안에서 다시 읽고 사용자 존재와 계정 삭제 차단 상태를 재확인한다. 스캔 후 수정/삭제된 기록은 건너뛴다. SDK가 동시 수정 때문에 transaction을 재시도해도 같은 버전 검증을 반복한다. 두 hash 필드 중 확인된 변경분만 update하며 본문·점수·서명·createdAt 등 다른 필드는 변경하지 않는다. 삭제 중이거나 사용자가 없으면 작업 전체를 중단한다. 진행 중 일부 적용 뒤 실패했으면 집계를 확인하고 재실행할 수 있다. 이미 일치한 hash는 그대로 둔다.

dry-run은 해당 시점 자격과 변경 예정 건수를 보여준다. 실제 apply 사이의 데이터 변화로 최종 건수가 달라질 수 있다. 새로 생기는 이력은 일반 저장 경로가 색인한다. 과거 unsigned 이력을 이 도구로 신뢰 기록으로 승격하지 않는다.

검증: `node --test test/detect-history-index.test.js`는 합성 기록과 메모리 Firestore 모형만 사용한다. 실제 운영 데이터 변경은 구현 검증에 포함되지 않는다.
