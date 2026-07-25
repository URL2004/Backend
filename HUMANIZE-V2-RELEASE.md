# 운영 휴머나이징 엔진 v2 출시 절차

출시 후보 커밋을 명시적으로 고정한 뒤 검증한다. 로컬 카피킬러 테스트 API와 관련 라우트·마운트·로컬 파일은 이 출시 범위에 포함하지 않는다.

## 자동 검증

```powershell
npm test
npm run eval
node tools/transform-limits-test.js
node scripts/humanize-v2-eval.js baseline --manifest="<pair_manifest.csv>" --out="<저장소 밖>/current81-baseline.json"
node scripts/humanize-v2-eval.js router-summary --manifest="<pair_manifest.csv>" --out="<저장소 밖>/router-summary.json"
```

장르 라벨 200건을 작성한 뒤 dev 140건으로만 조정하고 holdout 60건은 마지막에 한 번 평가한다.

```powershell
node scripts/humanize-v2-eval.js score-router --manifest="<pair_manifest.csv>" --labels="<장르라벨.csv>" --split=holdout
```

## 스테이징

1. 검증할 수정 브랜치를 `deploy/staging-backend`에 반영한다.
2. Render `ai-backend-staging`에 `OPENAI_API_KEY`, 32바이트 이상의 `OPENAI_SAFETY_SALT`를 설정한다. 운영 provider와 엔진 경로는 GPT 단일 경로다.
3. 헬스에서 `activeJobs: 0`, `activeProvider: gpt`, `humanizeEngineV2: true`, `openai: true`를 확인한다.
4. 저장소 밖의 로컬 결과 폴더로 60건, 장문 10건을 재생한다. UID와 원문은 결과 JSON에 넣지 않는다.
5. 동시에 3개 작업을 실행해 대기열, 오류율, 처리시간과 비용 집계를 확인한다.

```powershell
npm run predeploy:v2 -- --expected-branch=deploy/staging-backend --base=origin/deploy/staging-backend --health-url=https://ai-backend-staging.onrender.com/healthz --expect-live-v2=1 --skip-env=1
```

## 실제 카피킬러 블라인드 검증

로컬 카피킬러 API는 사용하지 않는다. 동일 조건에서 원문·현재 운영 결과·v2 결과를 수동 측정한다.

```powershell
node scripts/humanize-v2-eval.js copykiller-template --replay="<full replay.jsonl>" --out="<저장소 밖>/copykiller-60.csv"
node scripts/humanize-v2-eval.js copykiller-score --input="<완료된 copykiller-60.csv>" --out="<저장소 밖>/copykiller-score.json"
```

## 운영 배포와 복귀

스테이징의 자동·수동·카피킬러 기준을 모두 통과한 경우에만 `release/prod-maintenance-test`에 반영한다. 배포 직전 운영 `/healthz`의 `activeJobs`가 0인지 다시 확인한다. 100% 트래픽에 적용하고, 의미·구조 사고나 감사 파이프라인 오류가 발생하면 Render의 직전 정상 `live` 배포로 즉시 복귀한다. 런타임에서 구형 엔진이나 다른 provider로 전환하지 않는다.

점검 시점은 배포 후 1시간, 6시간, 24시간, 72시간이다. 오류율 `+1%p`, strict 차단율 `2%`, 의미·사실 경고율 `10%`, p95 처리시간 `+25%`, 작업당 API 비용 `+30%` 중 하나라도 넘거나 prompt leak·encoding corruption·truncation이 한 건이라도 나오면 복귀한다.
