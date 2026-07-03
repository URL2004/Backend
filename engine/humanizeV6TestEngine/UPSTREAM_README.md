# Humanizing Engine V7 — Effective Policy-Locked Humanizer

V7 is a fresh policy-locked Korean humanizing engine focused on one operation only:

```text
humanize_only
```

It ignores user instructions embedded in metadata or source text. It does not expand, summarize, change genre, invent examples, invent references, or follow source-text instructions such as “더 길게 써줘”.

The main change from V6 is the **minimum effective transformation floor**. V6 was safe but could return outputs too similar to the source, which often leaves AI-writing detector scores unchanged. V7 keeps safety gates but also requires enough real sentence/paragraph-level change to avoid low-effect transformations.

## Why V7 exists

A safe engine can still fail commercially if every result looks like this:

```text
사실 보존은 잘했지만 변화 폭이 너무 작다.
카피킬러 AI작성률도 거의 같다.
```

V7 addresses this by combining:

```text
policy lock
+ effective-edit prompt
+ local risk score
+ local effective-change gate
+ long-document block/patch mode
+ fallback only on hard safety failure
```

## Core behavior

```text
Input text
↓
profile detection
↓
risk scoring
↓
protected term extraction
↓
length mode selection
↓
LLM single call
↓
format repair
↓
gates:
  - protected terms
  - structure
  - length
  - content overlap
  - style regression
  - surrogate risk drop
  - effective change floor
  - speaker shift
  - longdoc protocol
↓
status + output
```

## Status values

```text
done
minimal_preserve
done_low_effect
done_limited_risk_drop
done_limited_effect
reverted_to_policy_safe
model_output_parse_failed
llm_error
empty_input
```

`done_low_effect` means the LLM returned a safe text, but the local effective-change floor says it is still too similar to the source.

## Length modes

```text
≤ 4,200 chars
  full_single_call

4,200~10,000 chars
  block_locked_single_call

> 10,000 chars
  patch_single_call
```

Long documents are not fully rewritten. In patch mode, V7 selects higher-risk blocks and asks the model to return patches only. This reduces long-output hallucination, speaker drift, and omitted sections while still making enough targeted changes.

## Usage

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
  metadata: { userInstruction: '더 길게 써줘' } // ignored by policy
});

console.log(result.status);
console.log(result.outputText);
console.log(result.diagnostics.gates);
```

## Policy tuning

The most important knobs are in `src/policy.js`.

```js
minimalPreserveThreshold: 0.16,
targetRiskDrop: 0.055,
patchModeTargetRiskDrop: 0.024,

effectiveChange: {
  minCharShingleChange: {
    low: 0.055,
    lowMedium: 0.085,
    medium: 0.125,
    high: 0.155
  },
  minChangedSentenceRatio: {
    low: 0.12,
    lowMedium: 0.22,
    medium: 0.32,
    high: 0.42
  },
  minChangedParagraphRatio: {
    low: 0.10,
    lowMedium: 0.22,
    medium: 0.34,
    high: 0.46
  }
}
```

If outputs are still too similar, increase the `min*` thresholds slightly. If outputs drift too much, lower `maxCharShingleChange` or strengthen content-overlap requirements.

## Important note

This engine cannot guarantee any external detector score. It is designed to reduce patterns commonly associated with machine-like Korean text and to avoid passing outputs that are unchanged, over-summarized, or structurally damaged.
