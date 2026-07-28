# Gemini Engine Files Snapshot

Created: 2026-06-16 15:16:15 +09:00
Updated: 2026-06-16 21:54:18 +09:00
Source: C:\Users\dbvision10\Documents\당근대학생\Backend-gemini-test
Branch: test/gemini-super-conservative-local

Secrets/env files were intentionally excluded.

## Notes
- Gemini-only local test branch snapshot.
- Claude fallback/shadow execution is not included for this test path.
- Gemini REST provider was updated against the official Gemini API docs:
  structured JSON uses `generationConfig.responseFormat.text`, Gemini 3 thinking uses `thinkingConfig.thinkingLevel`, Google Search tools use `google_search`, and safety/grounding metadata is logged when returned.
- Gemini explicit cache is enabled for local tests. Only fixed system/policy prompts are cached; user raw text, PDFs, user notes, and verified evidence material are not cached.
- Cache metadata is stored locally as `results/gemini-local-runs/gemini-cache-index.json`, but this snapshot intentionally excludes runtime cache indexes and env files.
- Copykiller proxy calibration includes diffuse abstract-report coverage: when most regions are weakly flagged, internal predicted rate is raised to match Copykiller's document-level behavior.
- Gemini source-bound mode is now stricter for generic abstract formal inputs: it lowers generation temperature, disables creative/register passes, forbids over-polished column-style rewrites, and preserves source structure.
- Source-bound acceptance now compares Gemini output against a source/minimal-clean candidate. If Gemini worsens internal suspicion or surface quality, the engine selects the safer source-bound candidate instead of forcing the model rewrite.
- Copykiller proxy calibration now treats diffuse technical-abstract reports as high-risk even when they contain many domain terms. The 2026-06-16 disaster/new-material sample is calibrated to internal `predictedAiRate=99`, matching the external Copykiller result.
- Claude fallback/shadow remains disabled in this snapshot; all model calls in the local test path are Gemini-only.
- Source-bound stance candidate now targets the “주관성의 지나친 배제” failure specifically. It adds natural formal authorial stance to existing claims only, avoids neutral text like `문제 삼는 부분은`, and keeps Claude fallback disabled. On the disaster/new-material local sample, the selected `source_stance` output removed all `주관성의 지나친 배제` rows, lowered internal prediction from 99 to 44, and cleared the local quality block.
- Optional Gemini Google Search grounding is now enabled for local formal tests. The engine asks for official/public facts only, filters wiki/blog/community-style sources, stores the grounding URL ledger in local summaries, and never treats auto web facts as mandatory source facts for `lostFacts`.
- A conservative web-evidence weave pass may insert at most one grounded fact into an already-related paragraph. It strips source labels/URLs from the body, normalizes memo-style endings, rejects malformed citations, and applies the change only when FLOOR stays clean and the Copykiller proxy does not worsen.
- On the disaster/new-material local sample, Gemini retrieved three `korea.kr` facts and safely inserted the March 2020 Food and Drug Safety Ministry mask-5-day fact. The local proxy moved from `predictedAiRate=46 / blocked=true` to `predictedAiRate=45 / blocked=false`; FLOOR remained `clean`.
- Loose rewrite mode now lowers preservation more aggressively for Gemini formal samples: generation prompt targets `0.70~1.05x` source length and allows sentence/internal paragraph reordering while keeping source facts and conclusion direction.
- Final Gemini cleanup now accepts larger reductions in loose mode, because removing duplicated conclusions and generic scaffold can legitimately shorten the output without losing facts.
- Copykiller proxy cleanup now removes Gemini-specific short punch/scaffold fragments such as `핵심은 둘째다`, `셋째는 우발성이다`, `초기에는 달랐다`, `상황은 급변했다`, and repeated conclusion tails.
- Formal stance repair now targets the `주관성의 지나친 배제` rows without adding personal anecdotes. It inserts only source-bound interpretive judgment sentences and deduplicates repeated stance sentences.
- Plain-register normalization now fixes Gemini `합니다/습니다` leakage inside `~다` reports.
- Direct deterministic web-evidence weave is disabled by default in the disaster local script (`GEMINI_WEB_EVIDENCE_WEAVE=0`), but Gemini Search Grounding still fetches and logs source-backed facts for the run.
- Loose Gemini cleanup acceptance now allows external-style cleanup candidates in local loose/rewrite mode even when the internal score rises slightly, as long as FLOOR stays clean, mid-risk rows are cleared, and quality gates remain unblocked.
- Disaster/new-material cleanup now lowers source preservation in a controlled way by adding source/body-bound concrete anchors near the introduction, removing Gemini-specific formal/punch fragments, de-jargonizing stiff academic phrases, and normalizing headings after stance insertion.
- Latest disaster/new-material local run plus deterministic final cleanup: `status=clean`, internal `predictedAiRate=35`, `mid=0`, `low=4`, `clean=1`, quality block `false`, FLOOR criticals `0`, web evidence facts `3`, output at `results/gemini-local-runs/latest-disaster-newmaterial-engine-output.md`.

## Files
- llm/providers/gemini.js
- llm/providers/anthropic.js
- llm/router.js
- llm/profile.js
- llm/localRuns.js
- routes/analyze.js
- routes/transform.js
- routes/detectreport.js
- engine/prompt.js
- engine/floor.js
- engine/copykillerproxy.js
- engine/surfaceguard.js
- engine/registerscore.js
- engine/judge.js
- engine/evidence.js
- engine/grounding.js
- engine/polish.js
- engine/optimizer.js
- engine/phrasebudget.js
- engine/formalbudget.js
- engine/dedupe.js
- engine/chunk.js
- engine/spacing.js
- engine/genreframes.js
- engine/genretransfer.js
- engine/evidenceguard.js
- engine/antidetect.js
- engine/b7polish.js
- engine/registerrepair.js
- scripts/rewrite-bloodstain-analysis-local.js
- scripts/rewrite-learning-science-local.js
- scripts/rewrite-ml-gradient-local.js
- scripts/rewrite-youth-center-resume-local.js
- scripts/rewrite-disaster-newmaterial-local.js
- scripts/rewrite-social-welfare-local.js
- scripts/rewrite-social-welfare-calibrated.js
- scripts/rewrite-social-welfare-b7.js
- scripts/smoke-gemini-cache-local.js
- scripts/run-local-gemini.ps1
- prompts.js

