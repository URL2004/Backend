# Source-Internal Grounding — FLOOR 경계 설계 (메모 없이 카피킬러 영역 줄이기)

> **역사 설계 문서(운영 계약 아님, 2026-07-25).** 아래의 Claude Code 테스트
> 백엔드 관련 내용은 폐기됐다. 현재 운영·검증 경로는 OpenAI Responses API와
> `engine-gpt-prod` 단일 엔진을 사용한다.

> 목표: 사용자 메모 없이, **원문 안에 이미 있는 구체 재료를 카피킬러 영역마다 재배치**해 의심 영역 수를 줄인다.
> 절대 원칙: 새 사실·경험·관계를 **지어내지 않는다**(FLOOR). 그래서 "경계"를 먼저 못 박는다.

## 1. 경계 정의

| | 내용 | 예 |
|---|---|---|
| **허용** | 원문이 *이미 말한 것*을, 원문 요소만으로 **재구성·선명화** | "복합적 판단을 요구받는다" → "변수가 따로 놀지 않는다. AI·자동화·플랫폼·ESG·인구변화가 겹치면서 제품 하나 문제로 끝나지 않는다" |
| **금지** | 원문에 없는 **새 구체(회사·연도·수치)** 또는 **새 인과/관계 주장** | "인공지능 도입은 인력 운영을 바꾸고, 플랫폼 경제는 유통을 흔든다" (원문은 *나열*만 함) |
| **금지** | 새 **1인칭 의견·단정** | "나는 효율 중심 경영이 실패한 모델이라고 본다" |

핵심: **재구성/선명화 = OK, 새 주장 = FLOOR 위반.** "문제는 A가 아니라 B다" 같은 stance 강화는 그 대조가 *원문에 있으면* 허용, *새로 만들면* 금지.

## 2. 2단 방어 (검증 완료 2026-06-08)

```
repaired segment
  → ① 결정론 hard-novelty (measureNovelty)   : 새 연도·기관·%·수치 → 즉시 차단 (LLM 없음, 0-FP)
  → ② semanticJudge (닫힌세계, source=allowed world) : 새 엔티티·관계 주장 → added_claim 차단
  → 통과해야 출고. 위반 시 repairViolations 또는 grounding 재시도.
```

**golden 케이스(eval/grounding-cases.js)로 경계 고정 + 검증:**

| 케이스 | 유형 | allowed | forbidden | 잡은 층 |
|---|---|---|---|---|
| C1 관계 과장 | AI→인력 인과 날조 | ✅ pass | ✅ 차단 | **judge** (hard-novelty 0) |
| C2 회사·수치 날조 | 토요타·넷플릭스·30% | ✅ pass | ✅ 차단 | novelty |
| C3 사례·연도 날조 | "2023년 손실" | ✅ pass | ✅ 차단 | novelty |
| C4 새 1인칭 의견 | "나는 …실패라 본다" | ✅ pass | (judge/pov) | judge |

- 결정론층: allowed 4건 전부 novelty 0 (**FP 없음**), C2·C3 forbidden 적중. (`node -e` 즉시검증 통과)
- judge층: C1 — allowed `pass=true`, forbidden `pass=false`로 "인공지능 도입은 인력 운영을 바꾸고"·"플랫폼 경제는 유통 방식을 흔든다" 둘 다 added_claim 적중. judge 사유가 경계를 정확히 인지("원문은 나열할 뿐, 구체 결과는 원장에 없음"). (`node eval/grounding-judge.js` — LLM 필요)

**결론: 결정론 토큰겹침은 게이트로 부적합**(정당한 연결문장 "변수는 따로 놀지 않는다"도 0.0 겹침으로 과탐). 경계 enforcement = **hard-novelty(싼 1차) + semanticJudge(진짜 게이트)**. 이미 있는 FLOOR가 경계를 지킨다 → repair를 그 위에 안전하게 올릴 수 있다.

## 3. repair 프롬프트 제약 (경계에서 유도)

추상-위험 segment를 고칠 때 모델에 줄 규칙:

```
[이 문단을 덜 추상적으로 — 단, 새 사실 금지]
· 원문에 이미 있는 구체 요소(나열된 개념·사례·대조·한계)만 사용해 추상 문장 2~4개를 교체하라.
· ★원문에 없는 회사·연도·수치·통계·고유명사를 새로 만들지 마라.
· ★원문이 "나열"만 한 것에 구체적 인과/결과("A가 B를 바꾼다")를 새로 붙이지 마라.
· 무견해는 줄이되 1인칭 의견("나는 ~라고 본다")을 새로 만들지 마라.
  대신 원문에 있는 대조·한계를 판단문으로: "문제는 A가 아니라 B다", "핵심은 A보다 B다".
· 길이를 늘리지 마라(추가 아닌 교체). 분량 ≤ 원문 110%.
```

## 4. repair 루프 (다음 단계 — 빌드 예정)

```
buildSegments(output) → 의심 segment 선별(measureSegmentRisk, 강한구체만 면제 — 약한 신호는 우선순위↓)
 → segment마다 assignAnchorsToParagraphs로 원문 anchor 1~2개 배정
 → grounding 프롬프트로 추상 문장 교체(§3)
 → ① measureNovelty ② semanticJudge 통과 검사 (§2) — 실패 시 재시도/롤백
 → surfaceguard 재측정으로 의심 segment 수 감소 확인
```

## 5. 한계 (정직)

- 이 소스는 anchor-빈곤(연도·회사·수치 0, specifics=인용 1개) → grounding으로 **떠다니는 추상 문단 → 중간**까지(현실 바닥 ~50%대). 18% 수준은 실제 구체(메모/evidence pack) 필요.
- carpikiller의 영역 escape엔 perplexity·구조 등 비결정 신호가 남아 segmentGuard는 **랭킹 도구**(MAE≈0.14)이지 정확한 % 예측기는 아니다.
- claudecode 테스트 백엔드는 청크 호출이 종종 실패(raw 폴백→한다체 누수). repair 반복 검증은 API 백엔드 권장.
