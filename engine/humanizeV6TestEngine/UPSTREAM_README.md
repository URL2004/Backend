# Humanizing Engine V8.1 — High-Effective Semantic Locked

관리자 정책 고정형 한국어 휴머나이징 엔진입니다. 사용자의 개별 요청을 해석하지 않고 `humanize_only`만 수행합니다.

V7/V8 계열에서 확인된 두 문제를 동시에 다룹니다.

1. **변환 강도가 낮아 카피킬러 AI 작성률이 거의 변하지 않는 문제**
2. 강도를 올렸을 때 생기는 **사실 관계 결합 오류**와 **문장 접합 오류**

외부 카피킬러 점수는 보장할 수 없지만, 이 버전은 “안전하지만 거의 그대로인 결과”를 성공으로 보지 않고, 문장·문단 단위의 유효 변화량을 더 강하게 요구합니다.

## 핵심 변경

- `strength: high_effective`
- 최소 위험 감소 목표 상향: `targetRiskDrop: 0.085`
- minimal preserve 기준 축소: `minimalPreserveThreshold: 0.10`
- 고위험 문장 변화율 기준 상향: `0.58`
- 고위험 문단 변화율 기준 상향: `0.62`
- 긴 글 patch coverage 확대: `patchTargetRatio: 0.68`, `patchMaxTargets: 80`
- 문법 파손 자동 수리 및 게이트 추가
- 사실 역할 결합 오류 gate 추가

## 막는 오류 예시

### 1. 사실 역할 결합 오류

원문에서 별개 역할을 하던 기술을 하나의 원인-결과 술어에 묶으면 실패 처리합니다.

```text
API 개방 구조와 더불어 예지보전 기능은 운영 중단 시간을 최소화한다.
```

API 개방은 외부 연동, 예지보전은 설비 고장 예방입니다. 원문에서 이 관계가 분리되어 있으면, 변환문에서도 기능 관계를 섞지 않습니다.

### 2. 문장 접합 오류

다음과 같은 문장 파손을 자동 감지합니다.

```text
만들어낸다. 있으며, 반대로...
```

`repairOrphanConnectives()`로 1차 수리하고, 남으면 `grammar_quality` gate에서 hard fail 처리합니다.

## 사용

```js
const { createPolicyLockedHumanizer } = require('./src');

const engine = createPolicyLockedHumanizer({
  llm: {
    async complete({ system, user, temperature, maxOutputTokens }) {
      return await callYourModel({ system, user, temperature, maxOutputTokens });
    }
  }
});

const result = await engine.transform({ text: sourceText });
```

사용자 요청은 metadata로 들어와도 무시됩니다.

```js
await engine.transform({
  text: sourceText,
  metadata: { userInstruction: '더 길게 써줘' }
});
```

## 결과 상태

- `done`: 안전 게이트와 유효 변화량 기준 통과
- `done_low_effect`: 안전하지만 변화량이 부족함
- `done_limited_risk_drop`: 변화는 있으나 surrogate risk 감소가 부족함
- `done_limited_effect`: soft gate 일부 실패
- `reverted_to_policy_safe`: hard gate 실패로 안전본 복귀
- `minimal_preserve`: 정말 낮은 위험 원문을 최소 정리만 수행

## 테스트

```bash
npm test
```

현재 테스트 항목:

- 사용자 요청 무시
- 보호 표현 보존
- 보호 표현 손실 hard fail
- risk score 방향성
- block locked mode
- patch mode
- speaker shift gate
- grammar quality gate
- fact role drift gate
- high-effective policy 값

## 운영 메모

이 엔진은 카피킬러 점수 자체를 직접 예측하지 않습니다. 대신 다음 실패 패턴을 통과시키지 않도록 설계했습니다.

- 원문과 거의 같은 문장 구조
- 단순 동의어 치환
- AI식 정형 표현 증가
- 문장 길이 균일성 증가
- 보호 표현 손실
- 화자 변경
- 제목/문단 구조 손실
- 사실 관계 결합 오류
- `있으며,` 같은 접합 파손

따라서 실제 운영에서는 `done`과 `done_limited_*`를 구분해 저장하고, 카피킬러 실제 결과가 쌓이면 `tools/calibrate-weights.js`로 weight를 보정하는 방식이 적합합니다.
