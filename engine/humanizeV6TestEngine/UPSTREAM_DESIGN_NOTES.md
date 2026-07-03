# Design Notes — V8.1 High-Effective Semantic Locked

## 문제 정의

보존형 엔진은 환각과 정보 손실을 줄였지만, 변환 강도가 낮으면 외부 AI 작성률 지표가 거의 움직이지 않는다. 반대로 강도만 올리면 다음 문제가 생긴다.

- 원문에 없던 관계 결합
- 기술·원인·효과의 역할 혼동
- 연결형 문장 분리 중 문법 파손
- 과도한 재작성에 따른 정보 손실

V8.1은 이 둘을 동시에 해결하기 위해 **고강도 유효 변화량**과 **사실 역할 잠금**을 결합한다.

## 설계 원칙

1. 사용자 요청은 무시하고 `humanize_only`만 수행한다.
2. 분량 확장, 요약, 장르 변경, 새 정보 추가는 금지한다.
3. 원문 정보 범위 안에서 문장 구조·연결 방식·종결 패턴을 실제로 바꾼다.
4. 원문에서 분리된 기술·원인·효과를 새롭게 하나의 효과로 묶지 않는다.
5. 변환 결과가 안전하지만 너무 비슷하면 `done_low_effect`로 분류한다.
6. hard gate 실패 시 결과를 통과시키지 않고 원문 안전본으로 복귀한다.

## 주요 모듈

```text
src/analysis/effectiveChange.js   # 문자/문장/문단 유효 변화량
src/analysis/factRole.js          # 보호 표현 간 관계 결합 오류 탐지
src/analysis/grammarQuality.js    # 접합 파손 탐지 및 수리
src/gates/gateRunner.js           # 전체 게이트 실행
src/prompt/promptBuilder.js       # full mode 프롬프트
src/prompt/longPromptBuilder.js   # block/patch mode 프롬프트
```

## 유효 변화량 기준

V8.1은 V7보다 변환 기준을 높였다.

```js
effectiveChange: {
  minCharShingleChange: { medium: 0.18, high: 0.23 },
  minChangedSentenceRatio: { medium: 0.45, high: 0.58 },
  minChangedParagraphRatio: { medium: 0.48, high: 0.62 }
}
```

## 사실 역할 잠금

`factRoleDriftGate`는 원문에서 서로 다른 문장/절에 있던 보호 표현들이 변환문에서 `와 더불어`, `함께`, `및`, `동시에` 등으로 묶이면서 하나의 술어에 걸리는 경우를 탐지한다.

예시:

```text
원문:
예지보전 기능은 설비 고장으로 인한 운영 중단 시간을 최소화한다.
API 개방은 외부 판매자 시스템과 배송조회 데이터를 연동한다.

실패 변환:
API 개방 구조와 더불어 예지보전 기능은 운영 중단 시간을 최소화한다.
```

이 경우 API 개방의 역할이 예지보전의 효과에 섞였으므로 hard fail이다.

## 문장 접합 오류 방지

`grammarQuality`는 다음 오류를 잡는다.

```text
만들어낸다. 있으며, 반대로...
한다. 하고, ...
```

`repairOrphanConnectives()`로 먼저 수리하고, 그래도 남으면 `grammar_quality` hard gate에서 실패 처리한다.

## 긴 글 처리

- 짧은 글: full single call
- 중간 글: block locked single call
- 긴 글: patch single call

긴 글은 전체 재작성하지 않고 위험 블록을 더 넓게 패치한다.

```js
patchTargetRatio: 0.68
patchMaxTargets: 80
minPatchCoverageForHighRisk: 0.55
```

## 한계

이 엔진은 외부 카피킬러 점수를 직접 보장하지 않는다. 다만 점수가 그대로 남을 가능성이 큰 저강도 변환을 `done` 처리하지 않고, 고강도 변환에서 생길 수 있는 사실 관계 오류와 문법 오류를 hard gate로 막는다.
