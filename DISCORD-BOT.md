# 디스코드 매출 봇 설정 가이드

`/매출` 슬래시 커맨드로 기간별 매출을 조회하고, 매일 자동으로 매출 요약을 받는 기능입니다.

- **건별 결제 알림**(결제 1건마다): 이미 작동 중 (`lib/discord.js` → `sales` 채널)
- **집계 매출**(이번에 추가):
  - `/매출 [오늘|어제|이번주|이번달|오픈이후]` 슬래시 커맨드 — 본인에게만 표시(ephemeral)
  - 매일 자동 리포트 — `어제 매출 + 이번 달 누적`을 `sales` 채널에 게시
  - 관리자 온디맨드 HTTP — `GET /admin/revenue?token=...&period=today`
  - 오픈 이후 누적 HTTP — `GET /admin/revenue?token=...&period=all`

매출 데이터 출처: Firestore `orders`(크레딧 충전) + `subscriptionOrders`(구독). 시간대 KST.

---

## A. 자동 일일 리포트 (가장 먼저, 봇 없이 바로 됨)

이미 쓰는 cron 패턴(구독 자동결제)과 동일합니다. 봇 토큰 불필요.

1. `.env` 에 매출 채널 웹훅과 cron 시크릿이 있는지 확인:
   ```
   DISCORD_WEBHOOK_SALES=https://discord.com/api/webhooks/...   # 또는 DISCORD_WEBHOOK_URL
   CRON_SECRET=<이미 쓰는 값>
   ```
   (웹훅이 없으면: 디스코드 채널 → 편집 → 연동 → 웹훅 만들기 → URL 복사)
2. 외부 cron(Render Cron Job 또는 cron-job.org 등)에서 **하루 1번** 호출 등록:
   ```
   POST https://ai-backend-3xtk.onrender.com/cron/daily-revenue
   Header: x-cron-secret: <CRON_SECRET>
   ```
   예) 매일 KST 09:00 → cron 식 `0 0 * * *` (UTC 0시 = KST 9시)
3. 호출되면 `sales` 채널에 "📊 일일 매출 리포트 — 어제 / 이번 달" 임베드가 올라옵니다.

> 즉시 테스트: `curl -X POST -H "x-cron-secret: <값>" https://.../cron/daily-revenue`

---

## B. `/매출` 슬래시 커맨드 봇

### 1) 디스코드 앱 생성 (브라우저, 1회)
1. https://discord.com/developers/applications → **New Application** (이름: 교수님피하기 매출봇)
2. **General Information** 탭에서 복사 → `.env`:
   - `Application ID` → `DISCORD_APP_ID`
   - `Public Key` → `DISCORD_PUBLIC_KEY`
3. **Bot** 탭 → **Reset Token** → 토큰 복사 → `.env` `DISCORD_BOT_TOKEN`
4. (권장) 테스트할 디스코드 서버 ID → `.env` `DISCORD_GUILD_ID`
   - 서버 아이콘 우클릭 → "서버 ID 복사" (개발자 모드 켜야 보임: 설정 → 고급 → 개발자 모드)
5. **OAuth2 → URL Generator**: scopes에 `applications.commands` 체크 → 생성된 URL로 봇을 서버에 초대

### 2) 명령 등록 (터미널, 1회)
```bash
cd Backend
node scripts/register-discord-commands.mjs
```
- `DISCORD_GUILD_ID` 설정 시: 해당 서버에 **즉시** 등록
- 미설정 시: 글로벌 등록(전파 최대 1시간)

### 3) Interactions Endpoint URL 등록 (브라우저, 1회)
1. 백엔드를 먼저 배포(아래 env 반영된 상태)
2. Developer Portal → **General Information** → **Interactions Endpoint URL** 에 입력:
   ```
   https://ai-backend-3xtk.onrender.com/discord/interactions
   ```
3. **Save** 누르면 디스코드가 검증 PING을 보냄 → 서버가 서명검증 후 PONG → 저장 성공
   - 실패하면: `DISCORD_PUBLIC_KEY` 오타 / 배포 미반영 / 경로 오타 확인

### 4) 사용
디스코드에서 `/매출` 입력 → `기간` 선택(오늘/어제/이번주/이번달/오픈이후, 기본 오늘) → 본인에게만 결과 표시.

---

## 보안 메모
- 매출 응답은 `flags: 64`(ephemeral)라 명령 부른 사람에게만 보입니다.
- `/admin/revenue` 는 `ADMIN_TOKEN` 으로 보호. 토큰은 길고 무작위하게.
- `/cron/daily-revenue` 는 `CRON_SECRET` 으로 보호.
- 서명검증(`DISCORD_PUBLIC_KEY`)이 없으면 Interactions는 전부 401 — 봇 비활성과 동일(안전).

## 추가하면 좋은 것 (선택)
- `/매출` 에 `이번 분기`/`지난 달` 기간 추가 → `lib/revenue.js` `periodRange` 와 등록 스크립트 choices에 한 줄씩.
- 환불 순매출 별도 표기, 일별 추이 그래프(차트 이미지) 등.
