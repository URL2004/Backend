# Engine repair/deadline candidate — NOT DEPLOYED

Candidate versions: humanizer v2.5.85 / detector v1.50. Production baseline remains f1b5b85. This continues the previous archived candidate; it is not a production release note.

## Changes

- Reduce repeated semantic-review quotations through explicit immutable-ID references. Missing fields, wrong/duplicate IDs, unresolved findings and ungrounded present-candidate quotes remain failures. Preserve all distinct earlier questions.
- Retain verified local repair progress only with exact source/candidate digests, explicit resolution of changed findings, and exactly unchanged grounded remaining findings. This does not grant a document pass.
- Preserve conservative uniquely attested current Korean word spacing when an aligned source sentence is restored. Do not cross lines, tabs, quotes/code or ambiguous lexical boundaries. Existing safety and semantic audits still apply.
- Route short-text review by two distinct recurring patterns and their joint input coverage rather than requiring identical exhaustive evidence lists. No score boost, floor or max-of-models selection.
- Large humanize/repair envelopes use one bounded transport attempt even at medium reasoning. The existing caller deadline and cancellation win; unknown usage remains reserved. A 60-second abort followed by a duplicate request previously consumed a 100-second window twice without completing either response.

## Verification

- Final automatic suite: 2,476 passed, zero failed/skipped.
- Production import graph: passed, 267 files / 811 edges / zero violations.
- Private saved-text position replay: 456 humanizer records and 274 detector records; zero invalid source offsets. This is not a manual semantic audit of all records.
- Detector: six synthetic style controls, three uncached runs each. Strong/weak pairs separated in all three genres, but one application example varied 53/52/28. Remaining variation is not masked by arbitrary score increases. Development controls are not authorship labels or a blind benchmark.
- Complete paid regeneration of two private documents, with direct full source/result reading: the shorter run had verified pass/clean; the longer run improved previously documented relation errors but only one of three final sections completed. Two final sections were denied before transport by the independent KRW2,000 test budget.
- Captured-response replay confirmed local progress may be retained while the remaining-error verdict stays fail; no network was used.
- The final large-rewrite timeout policy was added after those paid runs. Virtual-clock tests cover continuing past 60 seconds, stopping at 100 seconds, honoring a 30-second caller deadline, one HTTP attempt, and retained unknown cost. No full paid regeneration of this last transport revision.

## Not qualified for deployment

The independent test ledger closed at a conservative KRW1,831.46902, including KRW52.251 in unknown-failure reservations. No user credits or production data were modified. The remaining KRW168.53098 cannot admit the required confirming call. No older budget was reused.

Outstanding: two final long-document sections, full execution with the last transport policy, short-input repeat stability, and residual source-origin spelling/layout issues. A successful model verdict is not proof of flawless spelling. Keep the user's combined humanizer/detector deployment gate. Do not mark this candidate complete or deploy it based only on automatic tests.

Raw text, customer identifiers, API records, configuration snapshots and private runners are outside this repository.
