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
| `LLM_BACKEND` | 비우거나 `api`. `claudecode` 금지 |
| `ANTHROPIC_API_KEY` | 운영 키 |
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

## 최근 정상 배포 예시

- Backend `b6d01a8` → Render `dep-d8ohbhm7r5hc73c30stg` → `live`
- Frontend `6b1aa9f` → 운영 반영 완료
- Frontend `2876359` → Vercel `dpl_4LQuHdLJDWPRr6hHswgKC59X6sTM` → `https://gpkorea.ai.kr` alias 반영 완료
