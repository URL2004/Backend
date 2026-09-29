# v2.5.91 — inline quotation physical line repair

The physical prose repair previously excluded every quotation span. This kept
extraction-induced broken words even when surrounding prose was repaired.

The repair now accepts only verified word seams inside an inline quotation,
after the existing repeated-width / unfinished-row / word-seam document gate.
Document-attested words and detached grammatical particles use the existing
rules. A small explicit lexical fallback handles known words; unknown seams
remain untouched. No non-whitespace characters are changed.

Standalone quotations, verse, code, references, tables, complete sentences and
uncertain boundaries remain protected. Canonicalization happens before quote
freezing and integrity baseline creation, so later restoration uses the same
repaired quotation rather than reintroducing the broken source layout.

Validation: 2,780 backend tests pass; production import scan passes. The reported
source was replayed locally: both broken quoted words repaired, non-whitespace
content identical, integrity baseline consistent, repeated application unchanged.
Synthetic regressions cover preserved standalone quotes, verse, code and unknown
seams. No paid model regeneration was performed for this deterministic change.

No model, pricing, billing, delivery policy or stored historical result changes.
This is a bounded repair, not general reconstruction of arbitrary PDF layout.
