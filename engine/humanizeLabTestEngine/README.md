# humanizeLabTestEngine

Admin humanizing lab test engine only.

This folder is intentionally separated from the production humanizing engine. It uses its own lab-only prompt modules, and request-intent routing is disabled for this test version. The prompt is assembled from:

- `common/*`
- `genres/*`
- `risks/*`
- `guards/protectedTerms`

The production engine is `engine-gpt-prod/`. This lab does not import, wrap, or mutate that engine. `routes/transform.js` lazy-loads this folder only for the authenticated admin lab profile `fundamental_engine`.
