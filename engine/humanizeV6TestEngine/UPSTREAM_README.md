# Humanizing Engine V9 — Copykiller-Safe Policy Locked

V9 is a fresh, policy-locked Korean humanizing engine. It is designed for one fixed operation only:

```text
humanize_only
```

It does not interpret user requests such as “더 길게”, “요약해줘”, “칼럼체로 바꿔줘”, or “맞춤법만 봐줘”. Those strings are treated as source text, not instructions.

## Why V9 exists

Earlier high-intensity versions could change the text enough to reduce literal similarity, but they also introduced patterns that can raise Copykiller-like AI scores:

- overly polished column-style rhetoric
- stronger claims than the source
- abstract conclusion phrases
- smooth generic transitions
- new noun phrases not grounded in the source
- role drift, where unrelated functions are tied to the wrong effect
- grammar breakage such as `만들어낸다. 있으며, 반대로...`

V9 focuses on **Copykiller regression prevention**. It may still return `done_low_effect` if the model output is safe but too close to the source. It may return `reverted_to_policy_safe` if the transformed result is predicted to increase risk or damage meaning.

## Architecture

```text
input text
  ↓
local analysis
  - document profile
  - speaker profile
  - protected terms
  - surrogate Copykiller-risk score
  - blockization
  ↓
length mode selection
  - full_single_call
  - block_locked_single_call
  - patch_single_call
  ↓
policy-locked prompt
  ↓
LLM 1 call
  ↓
postprocess
  - rhetoric stripping
  - orphan connective repair
  - heading spacing repair
  ↓
gates
  - protected term loss
  - grammar quality
  - speaker lock
  - structure preservation
  - surrogate risk regression
  - effective change
  - fact role drift
  - new noun phrase budget
  - block/patch protocol
  ↓
status + output
```

## Length modes

| Mode | Trigger | Behavior |
|---|---|---|
| `full_single_call` | short text | transform whole text once |
| `block_locked_single_call` | medium text | preserve block IDs/count/order |
| `patch_single_call` | long text | transform only high-risk blocks and merge patches locally |

Long documents are not globally rewritten. This reduces omission, speaker drift, and fact drift.

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

## Usage

```js
const { createCopykillerSafeHumanizer } = require('./src');

const engine = createCopykillerSafeHumanizer({
  llm: {
    async complete({ system, user, temperature, maxOutputTokens }) {
      return await callYourModel({ system, user, temperature, maxOutputTokens });
    }
  }
});

const result = await engine.transform({
  text: sourceText,
  metadata: {
    userInstruction: '더 길게 써줘' // ignored by policy
  }
});

console.log(result.status);
console.log(result.outputText);
console.log(result.diagnostics.gates);
```

## Calibration

V9 includes a calibration helper for actual Copykiller score logs.

```bash
node tools/calibrate-weights.js copykiller_scores.csv
```

CSV format:

```csv
text,score
"본문...",0.73
"본문...",0.21
```

The script prints suggested local risk weights. Real Copykiller behavior must be calibrated with real score data; V9 cannot guarantee an external vendor score.

## Test

```bash
npm test
```

Expected:

```text
all tests passed
```
