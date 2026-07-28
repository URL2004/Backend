# 로컬 카피킬러 proxy 휴머나이징 테스트

운영 `Backend`의 OpenAI 런타임 설정(`OPENAI_API_KEY`, `gptRuntimeConfig`)을 그대로 사용하되, localhost에서만 접근 가능한 테스트 API입니다.

## 실행

```powershell
cd Backend
$env:PORT=5055
npm start
```

## 헬스체크

```powershell
Invoke-RestMethod http://localhost:5055/local/copykiller-humanize/health
```

## 휴머나이징

```powershell
$body = @{
  text = "테스트할 원문"
  mode = "assignment"   # assignment 또는 blog
  variants = 2          # 긴 글은 자동으로 1개 후보만 생성
  rounds = 2            # 후보가 원문 proxy보다 낮지 않으면 재시도
  strength = "ck-safe"
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post `
  -Uri http://localhost:5055/local/copykiller-humanize `
  -ContentType "application/json; charset=utf-8" `
  -Body $body
```

응답의 `outputText`가 선택된 결과이고, `copykillerProxy`는 내부 비교용 위험 점수입니다. 실제 카피킬러 점수가 아니라 로컬 proxy입니다.

- `meta.sourceBaselineProxy.copykillerRisk`: 원문 기준 proxy
- `copykillerProxy.copykillerRisk`: 결과문 proxy
- `copykillerProxy.deltaVsSource`: 결과문 proxy - 원문 proxy. 음수면 목표 방향입니다.
- `meta.improvedVsSource`: proxy상 원문보다 낮아졌는지 여부

## 기존 결과 점수만 보기

```powershell
$body = @{
  source = "원문"
  outputText = "비교할 결과문"
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post `
  -Uri http://localhost:5055/local/copykiller-score `
  -ContentType "application/json; charset=utf-8" `
  -Body $body
```
