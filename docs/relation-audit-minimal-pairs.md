# Relation audit minimal pairs

`engine-gpt-prod/relationAudit.js` and `engine-gpt-prod/experienceAudit.js`
emit candidate signals that route a humanized document to the semantic judge.
They are pattern heuristics, never findings of error and never block gates. Until
now their recall and precision had not been measured. This note describes the
synthetic evaluation set and how to run it.

## Fixture

`test/fixtures/relation-minimal-pairs.json` holds synthetic Korean sentence
pairs written for this purpose. No user, corpus or live-experiment text is
included. Each pair records `id`, `type`, `polarity`, `genre`, `source`,
`candidate` and a `note`; `obvious: true` marks preserved pairs that are pure
reorders, particle swaps (은/는 ↔ 이/가) or synonym substitutions.

Seven change types are covered, each with at least eight `changed` pairs (the
candidate alters the relation) and eight `preserved` pairs (a legitimate
paraphrase that keeps it, including reorders, splits, merges and passives):

| type | changed relation |
|---|---|
| `certainty_scope` | a hedge (가능성·것으로 보인다·수 있다·추정·생각한다) is dropped, added, or narrowed to one clause |
| `temporal_sequence` | -고/-며 coordination gains an explicit order (한 뒤·고 나서·먼저…다음), or the reverse |
| `temporal_to_causal` | 뒤/후/이후/나서 becomes 때문에·덕분에·따라서·로 인해 |
| `numeric_attribution` | a number moves to another entity, period or attribute |
| `subject_object_swap` | subject and object trade places |
| `claim_strength` | 일부/대부분/항상, 수 있다/이다, 증가/급증, 조금/심하다 |
| `omitted_speaker_experience` | a new first-person experience (직접 써 보니, 방문한 뒤) with no speaker in the source |

Genres are explainer prose, self-introduction letters, assignments and short
reviews. Two `changed` pairs are deliberately hard and expected to be missed by
the current patterns (`tc-c02` -어서, `ex-c07` 읽어 보니); they document known
gaps rather than tuning targets.

## Running

```
node scripts/measure-relation-audit.js
node scripts/measure-relation-audit.js --out /outside/backend/relation-report.json
node scripts/measure-relation-audit.js --fixture other.json --quiet
```

Without `--out` the JSON report prints to stdout; with `--out` the file is
written and a per-type table prints instead. The report gives, per type and
overall, recall on `changed` pairs (any candidate code, and the code the type is
expected to raise), the false-positive rate on `preserved` pairs, the missed and
falsely flagged ids, and the flag count on the obvious-paraphrase subset.

`test/relation-audit-minimal-pairs.test.js` checks fixture balance, that the
script runs and reports every type, and that the obvious-paraphrase subset is
never flagged. It does not assert recall numbers, so tuning does not break it.

## Reading the numbers

The numbers are synthetic-set numbers. They measure whether a pattern fires on
sentences written to exercise it and whether it stays silent on paraphrases
written to look legitimate. They are not production error rates, not recall on
user documents, and not a measure of how often the semantic judge is right after
being triggered. A candidate that fires only leads to a model review; the final
meaning decision still belongs to the judge and the existing preservation gates.

Known limits of the heuristics: `수 있다` is read as a hedge even when it means
ability; `-아서/-어서` is not treated as causal because it is often sequential;
implicit experience frames only cover a fixed verb list; number ownership uses
the nearest 은/는 topic (or nearest subject) within 90 characters and one
preceding modifier word, so longer noun phrases are compared only partially.
