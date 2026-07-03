# humanizeLabTestEngine

Admin humanizing lab test engine only.

This folder is intentionally separated from the production humanizing engine. It uses the `prompt_v2` module structure as the base idea, but request-intent routing is disabled for this test version. The prompt is assembled from:

- `common/*`
- `genres/*`
- `risks/*`
- `guards/protectedTerms`

The production `engine/prompt.js` and `runHumanizeChunked()` prompt path are not modified for this test engine. `routes/transform.js` only routes the admin lab profile `fundamental_engine` into this folder.
