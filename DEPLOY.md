# 배포 가이드

2026-07-25 기준 운영 배포 절차. 실제 운영 브랜치는 백엔드/프론트 모두 `release/prod-maintenance-test`다.

## 배포 대상

| 구분 | 위치 | 브랜치 | 서비스 |
|---|---|---|---|
| Backend | `C:\Users\dbvision10\Documents\당근대학생\Backend` | `release/prod-maintenance-test` | Render `srv-d6pl9qlm5p6s73fmh280` |
| Frontend | `C:\Users\dbvision10\Documents\당근대학생\Frontend` | `release/prod-maintenance-test` | Vercel scope `toavoidtheprofessor` |
| 운영 URL |  |  | `https://gpkorea.ai.kr` |
| Backend URL |  |  | `https://ai-backend-3xtk.onrender.com` |

## 절대 제외

아래 파일은 로컬 테스트/원문/제미나이 실험용이라 배포 커밋에 넣지 않는다.

- `.env.local.gemini`
- `results/gemini-local-runs/`
- `Backend-gemini-test/`
- `results/*.txt` 중 실측 원문/결과 파일
- `samples/*.txt` 중 사용자 원문 샘플
- `tools/_run-*.js` 중 API 실측 실행용 로컬 스크립트
- `제미나이-*`, `*gemini*` 문서/브랜치/산출물

커밋 전 확인:

```powershell
npm run git:check
git status --short --branch
git diff --cached --name-only
rg -n "gemini|Gemini|제미나이|providers/gemini|localRuns|smoke:gemini|start:gemini" -S $(git diff --cached --name-only)
```

`rg`가 exit 1/no output이면 제미나이 문자열 없음이다.

## Git 상태 하네스

Backend 저장소에 버전 관리되는 Git 하네스가 있으며 같은 작업공간의 Backend와
Frontend 저장소 공통 hooks 경로에 설치할 수 있다.

```powershell
# release/prod-maintenance-test가 반영된 최신 Backend worktree에서 실행
npm run git:install-hooks
npm run git:check
npm run git:check:all
```

- `pre-commit`: staged 파일 외에 unstaged·untracked 파일이 남은 부분 커밋을 차단한다.
- `post-commit`: 커밋 직후 남은 변경 파일을 즉시 알린다.
- `pre-push`: staged·unstaged·untracked 파일이 하나라도 있으면 푸시를 차단한다.
- `predeploy:v2`: 같은 하네스를 다시 실행하므로 훅을 우회해도 dirty 배포가 진행되지 않는다.
- `.env`, 서비스 계정, 개인키, 실제 토큰, 로컬 원문·평가 결과, 실험 파일은 커밋을 차단한다.

하네스는 임의 변경을 자동 커밋하지 않는다. 사용자가 만든 파일을 잘못 묶는 대신
남은 파일명을 보여 주고 커밋 범위를 직접 확인하게 한다.

## Backend 배포

1. 상태 확인

```powershell
cd C:\Users\dbvision10\Documents\당근대학생\Backend
git status --short --branch
git fetch origin release/prod-maintenance-test
git log --oneline --decorate -8
```

2. 원격이 앞서 있으면 먼저 반영

```powershell
git merge --ff-only origin/release/prod-maintenance-test
```

로컬 변경이 있어 fast-forward가 막히면 운영 대상 파일만 stash 후 merge하고 다시 적용한다.

```powershell
git stash push -u -m deploy-work -- <배포할 파일들>
git merge --ff-only origin/release/prod-maintenance-test
git stash pop
```

3. 검증

변경 파일에 맞게 `node --check`를 돌린다.

```powershell
node --check routes\transform.js
node --check routes\analyze.js
node --check engine\inputrouting.js
node --check engine-gpt-prod\index.js
node --check engine-gpt-prod\judge.js
node --check engine-gpt-prod\prompts\index.js
npm run check:production-imports
npm test
npm run eval
git diff --check
```

운영 전 통합 검사:

```powershell
npm run predeploy:v2 -- --skip-env=1
node tools\transform-limits-test.js
node tools\detectreport-test.js
npm audit --omit=dev
```

삭제된 구형 엔진의 개별 실행 스크립트는 사용하지 않는다.

4. 운영 헬스체크

```powershell
Invoke-RestMethod 'https://ai-backend-3xtk.onrender.com/healthz' | ConvertTo-Json -Depth 6
# 상세 상태(activeJobs·엔진·provider)는 비공개 경로에서만 확인한다.
Invoke-RestMethod 'https://ai-backend-3xtk.onrender.com/internal/health' -Headers @{ 'x-health-secret'=$env:HEALTH_CHECK_SECRET } | ConvertTo-Json -Depth 6
```

정상 기준:

- `ok: true`
- `llm: "api"`
- `firebase: true`
- `maintenance: false`
- `maxActive`가 운영 의도와 일치

5. 커밋/푸시

```powershell
git add <배포할 파일들>
git diff --cached --check
git commit -m "<type(scope): message>"
git push origin release/prod-maintenance-test
```

6. Render 배포 추적

```powershell
$commit = '<새 커밋 short hash>'
for ($i=0; $i -lt 54; $i++) {
  $json = render deploys list srv-d6pl9qlm5p6s73fmh280 --output json | ConvertFrom-Json
  $d = $json | Where-Object { $_.commit.id -like "$commit*" } | Select-Object -First 1
  if ($d) {
    Write-Output ((Get-Date -Format o) + ' ' + $d.id + ' ' + $d.status)
    if ($d.status -eq 'live' -or $d.status -eq 'failed' -or $d.status -eq 'canceled') { break }
  } else {
    Write-Output ((Get-Date -Format o) + ' waiting-for-deploy')
  }
  Start-Sleep -Seconds 10
}
```

7. 배포 후 확인

```powershell
Invoke-RestMethod 'https://ai-backend-3xtk.onrender.com/healthz' | ConvertTo-Json -Depth 6
Invoke-RestMethod 'https://ai-backend-3xtk.onrender.com/internal/health' -Headers @{ 'x-health-secret'=$env:HEALTH_CHECK_SECRET } | ConvertTo-Json -Depth 6
render deploys list srv-d6pl9qlm5p6s73fmh280 --output json | ConvertFrom-Json | Select-Object -First 1 | ConvertTo-Json -Depth 6
git fetch origin release/prod-maintenance-test
git status --short --branch
```

## Frontend 배포

프론트 변경이 있을 때만 배포한다. 프론트는 Vercel 프로젝트 `frontend`, scope `toavoidtheprofessor`, 운영 alias `https://gpkorea.ai.kr` 기준이다.

중요:

- 전역 `vercel` CLI가 없어도 `npx -y vercel ...`로 배포한다.
- `.vercel/project.json`이 있는 `Frontend` 디렉터리에서 실행해야 한다.
- 배포 후 `https://gpkorea.ai.kr/main`에서 실제 운영 alias 반영까지 확인한다.
- `firestore.rules` 배포는 Firebase CLI/권한이 별도라 백엔드/프론트 Vercel 배포와 분리한다.

1. 상태 확인

```powershell
cd C:\Users\dbvision10\Documents\당근대학생\Frontend
git status --short --branch
git fetch origin release/prod-maintenance-test
git log --oneline --decorate -8
```

2. 검증

프로젝트 스크립트가 있으면 우선 사용한다.

```powershell
npm run build
```

정적 파일 변경만 있고 별도 빌드가 없는 구조라면 변경 파일과 캐시 버전만 확인한다.

3. 커밋/푸시

```powershell
git add <배포할 파일들>
git diff --cached --check
git commit -m "<type(scope): message>"
git push origin release/prod-maintenance-test
```

4. Vercel 배포 확인

Git push로 자동 배포되는 구성이면 Vercel 배포 목록에서 최신 커밋을 확인한다.

```powershell
npx -y vercel ls --scope toavoidtheprofessor
```

수동 프로덕션 배포가 필요하면 아래 명령을 사용한다. 전역 CLI 설치 여부와 무관하게 동작한다.

```powershell
npx -y vercel deploy --prod --scope toavoidtheprofessor --yes
```

정상 출력 기준:

- `readyState: READY`
- `target: production`
- `Aliased https://gpkorea.ai.kr`

5. 운영 화면 확인

```powershell
$r = Invoke-WebRequest -Uri 'https://gpkorea.ai.kr/main' -UseBasicParsing -TimeoutSec 30
[int]$r.StatusCode
```

정상 기준:

- HTTP `200`
- 변경한 HTML/JS 문자열이 운영 alias 응답에 포함됨

예:

```powershell
$r.Content -match 'lavAutoCoach'
```

모바일/PC 관련 변경이면 실제 화면 또는 브라우저 테스트로 캐시 버전과 UI 반영 여부를 추가 확인한다.

## 환경변수

| 변수 | 운영 값/주의 |
|---|---|
| `OPENAI_API_KEY` | GPT 운영 엔진 키. 관리자 `adminSettings/gptRuntimeConfig` 값이 있으면 모델/추론/캐시 설정은 Firestore가 우선 |
| `HUMANIZE_SECTION_RECOVERY_ENABLED` | v2.4.8 장문 섹션 회복. 미설정 시 활성화되며 비용·시간 초과 시 `0`으로 개별 복귀 |
| `HUMANIZE_FINGERPRINT_AUDIT_ENABLED` | v2.4.8 신규 상투구·논리 방향 감사. 미설정 시 활성화되며 `0`으로 개별 복귀 가능 |
| `HUMANIZE_EFFECT_CONFIRMATION_ENABLED` | 변화가 제한적인 입력의 작업 전 확인 강제. v2.4.8 프런트 배포 후 활성화하며 `0`으로 해제 가능 |
| `HUMANIZE_CHUNK_CONCURRENCY` | 일반 편집 청크 동시성. 허용 범위 `1~3`; 배포 직후 `1`, 검증 후 `2` 권장 |
| `OPENAI_SAFETY_SALT` | UID를 `safety_identifier`용 HMAC-SHA256으로 변환하는 비밀값. 운영 필수 |
| `DISCORD_REVENUE_ALLOWED_USER_IDS` | Discord `/매출` 명령 허용 사용자 ID 목록(쉼표 구분). guild Administrator 외 운영자를 허용할 때만 설정 |
| `DISCORD_REVENUE_ALLOWED_ROLE_IDS` | Discord `/매출` 명령 허용 role ID 목록(쉼표 구분, 선택) |
| `DISCORD_GUILD_ID` / `DISCORD_REVENUE_ALLOWED_GUILD_IDS` | `/매출`에서 Administrator·role 권한을 신뢰할 운영 guild. 미설정 시 명시 사용자 allowlist 외에는 fail-closed |
| `OPENAI_MODEL_FAST` | 기본 변환 모델. 기본 `gpt-5.6-luna` |
| `OPENAI_MODEL_MAIN` / `OPENAI_MODEL_ESCALATION` | 승격 모델. 기본 `gpt-5.6-terra` |
| `OPENAI_MODEL_JUDGE` / `OPENAI_MODEL_JUDGE_ESCALATION` / `OPENAI_MODEL_REPAIR` / `OPENAI_MODEL_DETECT` / `OPENAI_MODEL_EVIDENCE` | 계층별 GPT 모델 fallback |
| `OPENAI_REASONING_HUMANIZE` / `OPENAI_REASONING_FACT_DENSE` / `OPENAI_REASONING_ESCALATION` | 변환·고위험·승격 reasoning fallback. 기본 `medium` / `high` / `high` |
| `OPENAI_REASONING_JUDGE` / `OPENAI_REASONING_REPAIR` / `OPENAI_REASONING_DETECT` / `OPENAI_REASONING_EVIDENCE` | 판정·수리·감지·근거검색 reasoning fallback. 판정/수리 기본 `medium` |
| `OPENAI_PROMPT_CACHE_ENABLED` / `OPENAI_PROMPT_CACHE_KEY_PREFIX` | GPT prompt caching 설정. 기본 prefix `gp-v9-cksafe-ko-p20260704` |
| `OPENAI_PROMPT_CACHE_KEY_INCLUDE_MODE` / `OPENAI_PROMPT_CACHE_KEY_INCLUDE_PHASE` | 기본 `0`. 같은 고정 프롬프트 코어의 캐시 재사용을 위해 mode/phase를 키에서 제외한다. 특정 키가 약 15 RPM을 넘거나 프롬프트 계열을 강제로 격리해야 할 때만 `1` |
| `OPENAI_WEB_SEARCH_TOOL_TYPE` | 기본 `web_search` |
| `GPT_NIKL_LOCAL_RESOURCE_ENABLED` | 기본 `1`. 국립국어원 공개 데이터의 쉬운 말 후보를 일반 독자용 프로필의 비차단 힌트로만 사용한다. 학술·법률·자소서·창작에는 적용하지 않는다. |
| `GPT_NIKL_EXTERNAL_API_ENABLED` | 기본 `1`. 키가 등록된 제공자에 한해 문서당 개인정보가 아닌 용어 후보 최대 2개만 우리말샘·표준국어대사전·온용어에서 조회한다. 결과는 표기 보존 힌트로만 쓰며 자동 치환·차단에는 사용하지 않는다. |
| `GPT_NIKL_API_PROVIDERS` / `GPT_NIKL_API_LOOKUP_MAX` / `NIKL_API_TIMEOUT_MS` | 기본 `opendict,stdict,term` / `2` / `1200`. 후보 상한은 2, timeout 상한은 1.2초로 코드에서도 제한한다. |
| `NIKL_OPENDICT_API_KEY` / `NIKL_STDICT_API_KEY` / `NIKL_TERM_API_KEY` | 국립국어원 API별 인증키. 외부 API가 OFF면 로드하거나 호출하지 않는다. |
| `DETECT_HISTORY_CALIBRATION_*` | 같은 사용자의 최근 휴머나이징 결과를 다시 감지할 때만 점수를 보정한다. 장문 유사 일치는 기본 5-gram `0.88` 이상, 길이 차이 `3%` 이내, 최소 `500자`이며 원점수와 매칭 메타를 관리자 기록에 남긴다. |
| `GPT_ESCALATION_*` | Luna-first → Terra 승격 기준 fallback. 기본 긴 글 `9000`, 보호표현 `35`, 패치 대상 `24`. 관리자 페이지에서 조정 가능 |
| `FIREBASE_SERVICE_ACCOUNT` | 서비스 계정 JSON 전체 |
| `WRITING_LAB_CONTEXT_SECRET` | 글쓰기 랩 평가·최종 검수 토큰 HMAC 키. 운영 필수, 무작위 32바이트 이상 |
| `WRITING_LAB_V2_ENABLED` / `WRITING_LAB_V2_ROLLOUT_PERCENT` | 전체 비상 롤백 `0/1`, UID 고정 단계 노출 `0~100` |
| `WRITING_LAB_V2_DISABLED_GENRES` | 장르 단위 롤백 목록. `resume,review_blog,marketing,general` 중 쉼표 구분 |
| `WRITING_LAB_DAILY_CAP` / `WRITING_LAB_CHECK_HOURLY_CAP` / `WRITING_LAB_EXTRACT_HOURLY_CAP` | 공개 성공 생성·최종 검사·메모 후보 추출 한도 |
| `WRITING_LAB_REQUIRE_ALL_POLICY_APPROVAL` | `1`이면 의료·법률·금융·광고 정책 팩의 실제 담당자 승인 전 `predeploy:v2` 실패. 비규제 베타에서는 `0`으로 두고 규제 입력을 `MANUAL_REVIEW`로 차단 |
| `WRITING_LAB_V1_PUBLIC` | 기본 `0`. 알려진 품질 문제가 있는 v1을 일반 사용자에게 다시 열지 말 것 |
| `TOSS_SECRET_KEY` | `live_` 키 |
| `CRON_SECRET` | cron 인증 |
| `TOSS_WEBHOOK_SECRET` | Toss webhook 인증 |
| `CORS_ORIGINS` | 추가 도메인 필요 시만 |
| `CORS_ORIGIN_SUFFIXES` | 운영에서는 비움 |
| `RESTRUCTURE_MAX_ACTIVE` | 전역 동시 작업 수. 현재 운영 헬스체크 기준 `8` |
| `RESTRUCTURE_DAILY_CAP` | 사용자당 일일 재구성 시작 제한 |
| `DEV_NO_AUTH` | 운영 설정 금지 |

Render의 `subscription-process-due` Cron Job은 셸 변수 확장에 의존하지 않는다. 운영 Docker Command 정본과
시크릿 회전·재배포·실행 검증 절차는 [`LOGGING.md`](LOGGING.md#render-구독-cron-정본)를 따른다.

GPT 캐시 운영 집계:

```powershell
npm run cache:gpt -- -Limit 1000
npm run cache:gpt -- -Limit 1000 -Json
```

`promptCacheHitRatio` 외에도 1,024토큰 이상인데 캐시 읽기가 없었던
`promptCacheSizedMiss`를 task/phase/model/cache key별로 확인한다. mode/phase를
키에 다시 포함해야 하는 경우에는 먼저 cache key별 `peakRpm`이 15를 넘는지 확인한다.

## 운영 주의

- `/transform`은 장시간 백그라운드 job이다. 배포 중 진행 중 job은 중단될 수 있으니 가능하면 `activeJobs: 0`일 때 배포한다.
- 차감은 완료 시점에 한다. `blocked`, `error`, `cancelled`는 원칙적으로 차감되지 않는다.
- Firestore 저장 실패나 undefined 필드 오류가 보이면 `transform.persist_failed` 로그를 우선 확인한다.
- 반복 차단/환불 문의가 늘면 `blocked`, `length_collapse`, `added_claim`, `lostFacts`, `evidence_pairing` 로그를 본다.
- 배포 후에는 항상 Render `live` 상태와 `/healthz`를 같이 확인한다.
- `writingLabV2Jobs.expiresAt` 필드는 2시간 복구용이므로 Firestore TTL 정책을 설정한다. 완료·실패 원문을 장기 보관하지 않는다.
- 글쓰기 랩은 관리자 → 5% → 25% → 50% → 100% 순으로 `WRITING_LAB_V2_ROLLOUT_PERCENT`를 올리고, 장르별 장애는 `WRITING_LAB_V2_DISABLED_GENRES`로 분리 롤백한다.
- 정책 팩 스키마는 `npm run writing-policy:validate`로 항상 검사한다. 규제 분야 자동 출시 전에는 법무·정책 담당자가 공식 출처와 문구를 확인한 뒤 `npm run writing-policy:approve -- <medical|legal|finance|advertising> --owner=<담당자> --approved-at=YYYY-MM-DD`로 승인 파일을 만들고 코드 리뷰를 거친다. 네 팩 모두 승인된 배포는 `WRITING_LAB_REQUIRE_ALL_POLICY_APPROVAL=1`로 predeploy를 강제한다.
- 휴머나이징 결과는 `/writing-lab/v2/finalize`에서 서명된 사실 원장으로 재검사한다. 제한 수리도 통과하지 못하면 서명 토큰에 포함된 검증 초안으로 서버가 복구하며, 클라이언트는 `delivery.source`가 `humanized`, `humanized_repaired`, `verified_generation_fallback` 중 무엇인지 사용자에게 표시한다.

### v2.4.8 활성화 순서

1. 위 세 플래그를 모두 `0`으로 둔 백엔드를 먼저 배포하고 `/healthz`에서 전부 `false`인지 확인한다.
2. 관리자 실호출로 기존 v2.4.7 경로의 완료·차감·이용 기록을 확인한다.
3. 프런트의 효과 제한 확인 UI와 `billingDisposition` 표시를 운영 배포한다.
4. 섹션 회복·상투구 감사를 `1`로 켠 뒤 마지막으로 효과 확인 강제를 `1`로 켠다.
5. `/healthz`의 세 값이 모두 `true`이고 `activeJobs: 0`인 시점부터 1시간·6시간·24시간·72시간 관측을 시작한다.

v2.4.8 활성화 커밋 이후 세 플래그는 미설정 시 `1`로 간주한다. Render 환경변수에 명시적으로 `0`을 넣으면 각 기능을 독립적으로 즉시 해제할 수 있다.

의미·구조 사고가 있으면 Render의 직전 정상 `live` 배포로 전체 복귀한다. 런타임 구형 엔진 전환은 지원하지 않는다. 비용·시간만 기준을 넘으면 `HUMANIZE_SECTION_RECOVERY_ENABLED=0`으로 섹션 회복만 끄고 상투구 감사는 유지한다.

### v2.4.9 저효과 전달 정책

- 기본·고급에서 모든 안전 재시도 뒤에도 원문과 같거나 최소 변화량에 못 미치면 `blocked` 대신 `done + needs_review`로 전달한다.
- 이 경우에도 결과가 `done`으로 전달됐으므로 일반 완료 작업과 동일하게 과금한다. `qualityStatus`, 변화량, 동일 문서 반복 여부는 과금 면제 사유로 사용하지 않는다.
- polish 무변환과 빈 출력·refusal·프롬프트 유출·인코딩 손상·문장 절단은 결과를 만들지 못한 상태이므로 계속 안전 중단한다.
- 사용자 화면에는 품질 경고를 실패나 미통과로 표시하지 않고 `완료 · 확인 권장`으로 안내한다. 관리자 품질 통계의 원인 코드는 유지한다.
- 과거 기록의 `waived_quality_shortfall`, `waived_repeat_low_benefit` 값은 통계 호환을 위해 읽기만 유지하며 신규 작업에는 생성하지 않는다.

### v2.4.10 완료 결과 과금 정책

- `done` 결과는 `clean`, `needs_review`, 변화량 부족, 원문에 가까운 안전 복귀, 동일 문서 반복 여부와 관계없이 정상 과금한다.
- 품질 측정값은 결과 경고와 운영 관측에만 사용하고 과금 면제 조건으로 사용하지 않는다.
- `blocked`, `error`, `cancelled`처럼 결과가 전달되지 않은 작업만 무차감한다. 관리자 무과금과 무제한 플랜은 기존 정책을 유지한다.
- `HUMANIZE_BILLING_PROTECTION_ENABLED`는 더 이상 읽지 않으며 원문 재결제 보호 지문도 새로 생성하거나 저장하지 않는다.
- 사용자 완료 화면과 이용 기록에는 `qualityStatus`, `qualityWarnings`, 원문 검토 경고를 표시하지 않는다. 값은 API 호환과 관리자 품질 관측에만 유지한다.

## 최근 정상 배포 예시

- Backend `b6d01a8` → Render `dep-d8ohbhm7r5hc73c30stg` → `live`
- Frontend `6b1aa9f` → 운영 반영 완료
- Frontend `2876359` → Vercel `dpl_4LQuHdLJDWPRr6hHswgKC59X6sTM` → `https://gpkorea.ai.kr` alias 반영 완료
