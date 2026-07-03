# V7 Design Notes

## Problem fixed from V6

V6 emphasized safety:

```text
보호 표현 유지
구조 유지
확장/요약 금지
긴 글 patch 처리
```

This prevented many bad outputs, but it could under-transform:

```text
원문과 거의 같음
카피킬러 AI작성률 변화 없음
done_limited_effect 반복
```

V7 adds a mandatory **effective-change layer**.

## Principle

Humanizing should not mean “make a new text,” but it also cannot mean “change two words.” V7 therefore applies a bounded transformation window:

```text
Too little change  → soft fail: done_low_effect
Enough change      → pass if other gates pass
Too much change    → hard fail: reverted_to_policy_safe
```

## Effective-change metrics

`src/analysis/effectiveChange.js` computes:

```text
charShingleSimilarity
charChange = 1 - charShingleSimilarity
sentenceChangedRatio
paragraphChangedRatio
exactSentenceCarryoverRatio
lengthRatio
```

This catches outputs that are safe but cosmetically edited.

## Prompt upgrade

The V7 prompt now explicitly rejects weak conversions:

```text
동의어 몇 개만 교체 금지
어미만 바꾸기 금지
원문과 거의 같은 문장 반환 금지
```

It also requires real changes:

```text
문장 구조
연결 방식
종결 패턴
반복 표현
비인칭/수동 패턴
정형 결론어
```

The engine remains policy-locked:

```text
확장 금지
요약 금지
장르 변경 금지
새 정보 추가 금지
사용자 요청 무시
```

## Long documents

V7 keeps V6 long-document safety but increases patch coverage for high-risk texts.

```text
patchTargetRatio: 0.55
patchMaxTargets: 60
minPatchCoverageForHighRisk: 0.42
```

This avoids the issue where only a few paragraphs were patched and the whole-document score stayed nearly unchanged.

## Gate severity

`effective_change` is soft when output is too similar. It does not revert to the original because that would keep the external score unchanged. It returns the result with status `done_low_effect`, allowing the application to show that the result should not be treated as a strong humanization.

It becomes hard only when the change is too large and drift is likely.

## Recommended operating policy

For production, collect pairs:

```text
source text
V7 output
V7 diagnostics
real Copykiller score before/after
```

Then tune:

```text
targetRiskDrop
patchModeTargetRiskDrop
minCharShingleChange
minChangedSentenceRatio
minChangedParagraphRatio
weights in riskScorer
```

The best target is not “always rewrite strongly,” but:

```text
average detector score down
protected facts retained
structure retained
speaker retained
low-effect outputs flagged
```
