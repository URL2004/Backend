# Humanizing Engine V6 — Policy-Locked Long Document Humanizer

V6는 V5의 관리자 정책 잠금 구조를 유지하면서, **1만 자 이상 긴 글에서 생기는 누락·환각·화자 변경·문체 흔들림**을 줄이기 위해 길이별 처리 모드를 추가한 신규 엔진입니다.

이 엔진은 사용자 요청을 해석하지 않습니다. `더 길게`, `요약`, `칼럼체`, `맞춤법만` 같은 입력이 들어와도 엔진은 관리자 정책 `humanize_only`만 수행합니다.

## 핵심 목표

- LLM 호출 수 절감
- 긴 글 전체 재작성 금지
- 긴 글에서 중간 누락, 화자 변경, 문체 drift 방지
- 위험 문단만 수정하는 patch mode 제공
- 카피킬러 점수 상승 가능성이 큰 결과 차단
- 기존 prompt.js / 기존 엔진 모듈 비사용

## 설치 및 테스트

```bash
cd humanizing_engine_v6_longdoc_locked
npm test
```

외부 의존성은 없습니다.

## 사용 예시

```js
const { createPolicyLockedHumanizer } = require('./src');

const engine = createPolicyLockedHumanizer({
  llm: {
    async complete({ system, user, temperature, maxOutputTokens }) {
      return await callYourModel({ system, user, temperature, maxOutputTokens });
    }
  }
});

const result = await engine.transform({
  text: sourceText,
  metadata: {
    userInstruction: '더 길게 써줘' // 무시됨
  }
});

console.log(result.status);
console.log(result.lengthMode);
console.log(result.outputText);
```

## 길이별 처리 정책

```text
4,200자 이하
→ full_single_call
→ 전체 본문을 1회 LLM으로 처리

4,200자 초과 ~ 10,000자 이하
→ block_locked_single_call
→ 원문을 block id로 잠그고 모든 블록을 반환하게 함
→ 제목/소제목/문단 수/순서 손실 방지

10,000자 초과
→ patch_single_call
→ 전체를 다시 쓰지 않음
→ 로컬 위험 점수가 높은 문단만 LLM에 보냄
→ LLM은 patch JSON만 반환
→ 엔진이 원문 블록에 병합
```

기본값은 `src/policy.js`에서 조정할 수 있습니다.

```js
longDocument: {
  enabled: true,
  fullMaxChars: 4200,
  blockLockedMaxChars: 10000,
  blockLockedMaxBlocks: 90,
  patchMaxTargets: 28,
  patchTargetRatio: 0.34,
  patchMinBlockChars: 70,
  patchMinBlockRisk: 0.43
}
```

## 처리 파이프라인

```text
source text
↓
profile detector
↓
risk scorer
↓
speaker profile analyzer
↓
protected term extractor
↓
blockizer
↓
length mode selector
↓
LLM 1회 호출
  - full prompt
  - block locked prompt
  - patch prompt
↓
format repair
↓
local gates
↓
pass / limited / fallback
```

## 결과 status

```text
done
minimal_preserve
done_limited_effect
reverted_to_policy_safe
model_output_parse_failed
llm_error
empty_input
```

## lengthMode

```text
full_single_call
block_locked_single_call
patch_single_call
minimal_preserve
patch_no_targets
```

## 긴 글 안전장치

### 1. Block locked mode

중간 길이 문서는 다음 형태로 모델에 전달됩니다.

```json
[
  { "id": "B0001", "type": "heading", "text": "Ⅰ. 서론" },
  { "id": "B0002", "type": "paragraph", "text": "..." }
]
```

모델은 모든 블록을 같은 id와 순서로 반환해야 합니다. 블록 수가 달라지거나 id가 바뀌면 hard gate에서 실패합니다.

### 2. Patch mode

긴 문서는 위험 문단만 보냅니다.

```json
{
  "patches": [
    { "id": "B0012", "text": "수정된 문단" }
  ]
}
```

나머지 블록은 원문 그대로 유지됩니다. 따라서 긴 글 전체 재작성에서 생기는 누락, 요약화, 화자 변경 위험이 줄어듭니다.

### 3. Speaker lock

원문 화자를 분석해 다음 변화가 생기면 gate에서 차단합니다.

- 중립 문서에 `저는/제가/나는` 삽입
- 1인칭 경험문에서 1인칭 제거
- 평어체 문서를 존댓말로 변경
- 존댓말 문서를 평어체로 변경

### 4. Protected terms

숫자, 영문 약어, 괄호 용어, 중점 목록, 제목/소제목, 고유명사성 표현을 자동 추출합니다. 중요한 보호 표현이 결과에서 사라지면 fallback됩니다.

## 비용 관점

V6는 기존 청크별 호출 구조보다 비용을 줄이는 방향입니다.

```text
기존 방식:
청크 N회 호출 + 후처리 LLM + judge/repair 가능

V6:
로컬 분석 + LLM 1회 + 로컬 gate
```

긴 글의 경우에도 전체 출력물을 다시 생성하지 않고 patch만 생성하므로 출력 토큰 비용을 줄일 수 있습니다.

## 주의

- 카피킬러 점수 하락을 보장하지는 않습니다.
- 대신 평균적으로 점수를 올릴 가능성이 큰 결과를 통과시키지 않는 구조입니다.
- 실제 운영에서는 shadow mode로 기존 엔진 결과와 V6 결과, 실제 카피킬러 결과를 함께 쌓아 `tools/calibrate-weights.js`로 surrogate score를 보정하는 것을 권장합니다.
