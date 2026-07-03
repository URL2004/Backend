# Design Notes — V9 Copykiller-Safe Humanizing Engine

## Core diagnosis

If Copykiller scores keep rising, the usual cause is not only “too little change.” High-intensity rewriting can also increase AI-like traits:

1. It turns plain explanation into polished column prose.
2. It adds rhetorical punchlines.
3. It increases abstract conclusion phrases.
4. It ties unrelated source facts together.
5. It introduces strong claims or evaluation words.
6. It makes sentence rhythm too smooth.

V9 therefore does not simply increase rewrite strength. It creates structural change while blocking style regressions.

## Key policy shift

```text
More change ❌
Safer effective change ✅
```

V9 asks the model to change sentence structure, clause order, connection style, and repeated endings. It explicitly forbids using rhetorical language or new interpretation to create change.

## Surrogate risk components

V9 computes a local score using:

- abstractness
- formulaic density
- rhetorical density
- claim strength
- impersonal/passive density
- transition overuse
- compression markers
- over-formalization
- over-colloquialization
- n-gram repetition
- sentence uniformity
- lexical flatness
- anchor deficit
- sentence length risk

The final score is a sigmoid-weighted sum. It is a surrogate, not Copykiller itself.

## Why outputs may revert

If an output is predicted to raise Copykiller-like risk, V9 returns the source-safe version instead of shipping a worse result.

This is intentional. A system that sometimes returns the original is better than one that consistently raises actual Copykiller scores.

## Important gates

### 1. Fact role drift

Detects cases like:

```text
API 개방과 예지보전 기능은 설비 고장으로 인한 운영 중단 시간을 줄인다.
```

If `API 개방` and `예지보전 기능` were separate in the source and are newly tied to the same causal effect in the output, the gate fails.

### 2. Grammar quality

Blocks orphan connectives:

```text
만들어낸다. 있으며, 반대로...
```

### 3. Rhetorical regression

Blocks new column-style language that often raises AI-like polish:

```text
진짜 목적
무심코 남긴 글 한 줄
인간의 눈이
경계를 밀어붙인다
핵심 축
위력이 두드러진다
```

### 4. Effective change

If the output is too similar, V9 does not call it a full success.

### 5. Protected terms

Keeps numbers, acronyms, enumerations, quoted terms, technical names, and key noun phrases.

## Operating recommendation

Track actual Copykiller score with these fields:

```text
source_text
output_text
source_score
output_score
engine_status
surrogate_before
surrogate_after
gate_names
```

Then calibrate local weights. Without actual score feedback, no local proxy can perfectly predict Copykiller.
