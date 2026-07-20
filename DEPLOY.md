# 배포 가이드

2026-06-16 기준 운영 배포 절차. 실제 운영 브랜치는 백엔드/프론트 모두 `release/prod-maintenance-test`다.

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
git status --short --branch
git diff --cached --name-only
rg -n "gemini|Gemini|제미나이|providers/gemini|localRuns|smoke:gemini|start:gemini" -S $(git diff --cached --name-only)
```

`rg`가 exit 1/no output이면 제미나이 문자열 없음이다.

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
node --check engine\judge.js
node --check engine\prompt.js
git diff --check
```

자주 쓰는 스모크 테스트:

```powershell
node tools\_port-sanity.js
node tools\_test-dup-input.js
node tools\_test-restructure-unfit.js
node tools\_test-long-thesis.js
node tools\_test-register-normalize.js
```

존재하지 않는 테스트 파일은 건너뛴다.

4. 운영 헬스체크

```powershell
Invoke-RestMethod 'https://ai-backend-3xtk.onrender.com/healthz' | ConvertTo-Json -Depth 6
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
| `ANTHROPIC_API_KEY` | 운영 키 |
| `OPENAI_API_KEY` | GPT 운영 엔진 키. 관리자 `adminSettings/gptRuntimeConfig` 값이 있으면 모델/추론/캐시 설정은 Firestore가 우선 |
| `LLM_ACTIVE_PROVIDER` | 단일 운영 provider 설정. v2 운영값 `gpt` |
| `HUMANIZE_ENGINE_V2_ENABLED` | `1`이면 v2, `0`이면 한 릴리스 동안 보존한 기존 경로로 즉시 복귀 |
| `HUMANIZE_SECTION_RECOVERY_ENABLED` | v2.4.8 장문 섹션 회복. 미설정 시 활성화되며 비용·시간 초과 시 `0`으로 개별 복귀 |
| `HUMANIZE_FINGERPRINT_AUDIT_ENABLED` | v2.4.8 신규 상투구·논리 방향 감사. 미설정 시 활성화되며 `0`으로 개별 복귀 가능 |
| `HUMANIZE_EFFECT_CONFIRMATION_ENABLED` | 변화가 제한적인 입력의 작업 전 확인 강제. v2.4.8 프런트 배포 후 활성화하며 `0`으로 해제 가능 |
| `OPENAI_SAFETY_SALT` | UID를 `safety_identifier`용 HMAC-SHA256으로 변환하는 비밀값. 운영 필수 |
| `OPENAI_MODEL_FAST` | 기본 변환 모델. 예: `gpt-5.4-mini` |
| `OPENAI_MODEL_MAIN` / `OPENAI_MODEL_ESCALATION` | 승격 모델. 예: `gpt-5.4` |
| `OPENAI_MODEL_JUDGE` / `OPENAI_MODEL_REPAIR` / `OPENAI_MODEL_DETECT` / `OPENAI_MODEL_EVIDENCE` | 계층별 GPT 모델 fallback |
| `OPENAI_REASONING_HUMANIZE` / `OPENAI_REASONING_FACT_DENSE` / `OPENAI_REASONING_ESCALATION` | 변환·고위험·승격 reasoning fallback |
| `OPENAI_REASONING_JUDGE` / `OPENAI_REASONING_REPAIR` / `OPENAI_REASONING_DETECT` / `OPENAI_REASONING_EVIDENCE` | 판정·수리·감지·근거검색 reasoning fallback. 판정/수리 기본 `medium` |
| `OPENAI_PROMPT_CACHE_ENABLED` / `OPENAI_PROMPT_CACHE_KEY_PREFIX` | GPT prompt caching 설정. 기본 prefix `gp-v9-cksafe-ko-p20260704` |
| `OPENAI_WEB_SEARCH_TOOL_TYPE` | 기본 `web_search` |
| `GPT_ESCALATION_*` | mini-first 승격 기준 fallback. 기본 긴 글 `9000`, 보호표현 `35`, 패치 대상 `24`. 관리자 페이지에서 조정 가능 |
| `FIREBASE_SERVICE_ACCOUNT` | 서비스 계정 JSON 전체 |
| `TOSS_SECRET_KEY` | `live_` 키 |
| `CRON_SECRET` | cron 인증 |
| `TOSS_WEBHOOK_SECRET` | Toss webhook 인증 |
| `CORS_ORIGINS` | 추가 도메인 필요 시만 |
| `CORS_ORIGIN_SUFFIXES` | 운영에서는 비움 |
| `RESTRUCTURE_MAX_ACTIVE` | 전역 동시 작업 수. 현재 운영 헬스체크 기준 `8` |
| `RESTRUCTURE_DAILY_CAP` | 사용자당 일일 재구성 시작 제한 |
| `DEV_NO_AUTH` | 운영 설정 금지 |

## 운영 주의

- `/transform`은 장시간 백그라운드 job이다. 배포 중 진행 중 job은 중단될 수 있으니 가능하면 `activeJobs: 0`일 때 배포한다.
- 차감은 완료 시점에 한다. `blocked`, `error`, `cancelled`는 원칙적으로 차감되지 않는다.
- Firestore 저장 실패나 undefined 필드 오류가 보이면 `transform.persist_failed` 로그를 우선 확인한다.
- 반복 차단/환불 문의가 늘면 `blocked`, `length_collapse`, `added_claim`, `lostFacts`, `evidence_pairing` 로그를 본다.
- 배포 후에는 항상 Render `live` 상태와 `/healthz`를 같이 확인한다.

### v2.4.8 활성화 순서

1. 위 세 플래그를 모두 `0`으로 둔 백엔드를 먼저 배포하고 `/healthz`에서 전부 `false`인지 확인한다.
2. 관리자 실호출로 기존 v2.4.7 경로의 완료·차감·이용 기록을 확인한다.
3. 프런트의 효과 제한 확인 UI와 `billingDisposition` 표시를 운영 배포한다.
4. 섹션 회복·상투구 감사를 `1`로 켠 뒤 마지막으로 효과 확인 강제를 `1`로 켠다.
5. `/healthz`의 세 값이 모두 `true`이고 `activeJobs: 0`인 시점부터 1시간·6시간·24시간·72시간 관측을 시작한다.

v2.4.8 활성화 커밋 이후 세 플래그는 미설정 시 `1`로 간주한다. Render 환경변수에 명시적으로 `0`을 넣으면 각 기능을 독립적으로 즉시 해제할 수 있다.

의미·구조 사고가 있으면 `HUMANIZE_ENGINE_V2_ENABLED=0`으로 전체 복귀한다. 비용·시간만 기준을 넘으면 `HUMANIZE_SECTION_RECOVERY_ENABLED=0`으로 섹션 회복만 끄고 상투구 감사는 유지한다.

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

## 최근 정상 배포 예시

- Backend `b6d01a8` → Render `dep-d8ohbhm7r5hc73c30stg` → `live`
- Frontend `6b1aa9f` → 운영 반영 완료
- Frontend `2876359` → Vercel `dpl_4LQuHdLJDWPRr6hHswgKC59X6sTM` → `https://gpkorea.ai.kr` alias 반영 완료
