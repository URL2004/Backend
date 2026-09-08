# Contextual paragraph follow-ups

The previous selector recommended the first two abstract paragraphs. This could ask for personal experiences in a report's purpose or theory section. `lib/refineCoaching.js` now recommends at most one paragraph containing an existing experience, observation, decision, or personal reflection. Troubleshooting has priority over a routine observation.

Selection is deterministic and adds no model call. It preserves the existing paragraph splitter and billing calculation. Purpose, theory, methods, and references are excluded by section; generic explanatory prose does not qualify just because it lacks numbers. Numbered subsections inherit protected parent sections. Already refined indexes remain excluded from recommendations. Unknown cases may receive no recommendation.

Each target retains `index`, `snippet`, and `credit`, and adds `coaching` with `version: 1`, `title`, `question`, `placeholder`, and `section`. The snippet quotes an existing sentence from the result. Prompts are selected from bounded contextual templates; they do not assert a new outcome or provide a fabricated anecdote. Refinement preserves the report's register and does not infer missing numbers, causes, or successful resolutions.

The frontend displays one labelled optional question. Skipping makes no API call, preserves output text and the draft during the current page session, and can be undone. Empty or legacy targets without coaching metadata are hidden. Existing owner checks, credit rules, free-use accounting, failure/no-op handling, and the independent refinement validation remain in place. Saved jobs are re-evaluated before accepting a refinement request.

## Validation and release

- `node --test test/refine-coaching.test.js test/audit-hardening.test.js`
- `node scripts/check-production-imports.js`
- Companion frontend: `npm run build` (includes the full Node test suite), plus browser checks for desktop/mobile, skip/undo, no-op, success, and exact copied text.
- Ship together with frontend branch `feat/contextual-experience-20260908`. A new frontend safely hides old target payloads during rollout. `PARAGRAPH_REFINE` remains the existing feature flag; this change does not enable it or alter pricing.

Limit: section recognition and question choice use Korean text patterns, not a semantic model. The checks use synthetic fixtures and mocked browser API responses; no production generation or user billing is part of verification.
