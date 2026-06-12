# 배포 가이드 + 프로덕션 전환 체크리스트

2026-06-12 기준. 재구성(/transform)이 **최대 90분짜리 백그라운드 job**이라 배포 방식에 제약이 있다 — 이 문서의 전제.

## 인프라 요건 (왜 serverless가 안 되는가)

- 재구성 job은 서버 프로세스 안에서 5~90분 돈다 → **상시 실행 인스턴스 필수**. Cloud Functions·Vercel·Lambda류(요청 단위 타임아웃) 불가.
- Render 기준: **유료 인스턴스 필수.** 무료 티어는 15분 무요청 시 스핀다운 — 진행 중 job이 전부 죽는다. (GET 폴링이 요청을 만들긴 하지만 보장 수단이 아님.)
- 헬스체크 경로: `GET /healthz` (응답에 activeJobs·draining 포함 — 운영 확인용으로도 사용).
- 배포 시 동작(내장): SIGTERM 수신 → 새 작업 거부 → 진행 중 LLM 호출 abort(비용 차단) → job 상태 Firestore 영속화 → 종료. 재시작 후 done/blocked/승인대기 job은 그대로 복원되고, running이던 job은 "서버 재시작으로 중단(차감 없음)"으로 정정된다.
  - **즉, 배포하면 진행 중이던 재구성은 중단된다(돈은 안 나감).** 트래픽 적은 시간대에 배포할 것.

## 환경변수 (프로덕션)

| 변수 | 값 | 비고 |
|---|---|---|
| `LLM_BACKEND` | 비우거나 `api` | ⚠️ `claudecode` 금지 — UI 전부 타임아웃 |
| `ANTHROPIC_API_KEY` | 운영 키 | |
| `FIREBASE_SERVICE_ACCOUNT` | 서비스 계정 JSON 통째 | 이게 있어야 인증·과금·job 영속화 동작 |
| `TOSS_SECRET_KEY` | `live_` 키 | 테스트 키로 배포하면 결제 전부 실패 |
| `CRON_SECRET` | 무작위 시크릿 | 정기결제 갱신 cron 인증 |
| `CORS_ORIGINS` | (선택) 추가 도메인 | 기본 gpkorea.ai.kr는 코드에 내장 |
| `RESTRUCTURE_MAX_ACTIVE` | (선택, 기본 3) | 전역 동시 재구성 수 — API rate limit·비용 감당치에 맞춤 |
| `RESTRUCTURE_DAILY_CAP` | (선택, 기본 8) | 사용자당 일일 재구성 시작 횟수 |
| `DEV_NO_AUTH` | **설정 금지** | 로컬 전용 인증 우회 |

## 배포 전 체크리스트

- [ ] `DEV_NO_AUTH` 없음 (시작 로그가 `인증=Firebase`인지 확인 — `DEV 우회`면 중단)
- [ ] `LLM_BACKEND`가 `api` 또는 미설정 (시작 로그 `LLM=api`)
- [ ] `GET /healthz` 200 + `firebase: true` 확인
- [ ] 결제: Toss `live_` 키, 환불 경로 1회 점검
- [ ] CORS: 운영 도메인에서 호출 1회 확인 (허용 외 origin은 차단됨)
- [ ] Firestore 보안 규칙: `users`·`transformJobs`는 서버(Admin SDK)만 쓰기 — 클라이언트 직접 쓰기 차단 확인
- [ ] 진행 중 job 없는 시간대인지 확인 (`/healthz`의 `activeJobs: 0`)

## 비용 방어 구조 (운영자가 알아야 할 것)

- 차감은 **완료 시점**: 차단(blocked)·에러·취소 job의 LLM 원가(최대 ~$7/건)는 회사 부담.
- 그래서 한도가 있다: 사용자당 동시 1개 / 전역 동시 `RESTRUCTURE_MAX_ACTIVE` / 사용자당 하루 `RESTRUCTURE_DAILY_CAP`회 시작.
- 최악 일일 비용 ≈ `DAILY_CAP × 활성 악성 사용자 수 × $7`. 캡 조정은 env로.
- 재구성 단가(2026-06-12): ~1만자 200 / ~2만자 400 / ~3만자 600크레딧, 근거 +100 — 원가 ~1.5배 마진.

## 운영 모니터링 포인트 (로그 grep 키워드)

- `완료 차감 실패(수동 보정 필요)` — 결과는 나갔는데 크레딧 차감 실패. **수동 보정 필요, 즉시 대응.**
- `BLOCKED` — 게이트 차단(원가 손실). 비율이 높아지면 엔진 점검.
- `영속화 실패` / `복원 실패` — Firestore 쓰기 문제.
- `[shutdown]` — 배포·재시작 이력.

## 로컬 개발 서버 (참고)

```
DEV_NO_AUTH=1 LLM_BACKEND=api PORT=3100 node server.js
```
Firebase 미설정이면 영속화·과금은 무동작(메모리 job만)으로 자동 격하된다.
