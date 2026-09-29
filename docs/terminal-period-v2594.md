# v2.5.94: restore the missing final period of a paragraph

Cause: v2.5.93 stopped paragraphs that end without a period from being glued to
the next paragraph, but the delivered text still carried the source omission.
In the reported document seven paragraphs had no final period; the model filled
three on its own and left four, so the result looked inconsistent.

Decision (owner, 2026-09-29): fill the missing period automatically.

Changes:
- New preflight stage `restoreParagraphTerminalPunctuation`, run after the
  whitespace-only layout repairs. It appends one period to a paragraph when all
  of the following hold:
  - the line is prose, 40+ characters, and ends with a declarative or polite
    sentence ending (…다, …해요, …습니까);
  - it does not end with a closing quote, bracket, comma, colon or dash;
  - the writer demonstrably punctuates sentences: the same paragraph contains a
    punctuated sentence, or at least half of the long prose lines (3 or more)
    in the document end with terminal punctuation;
  - the next content line is not a fragment of this sentence.
- Titles, headings, lists, tables, quotes, code fences, reference sections,
  scripts and verse are never touched. Short single-line inputs keep the
  previous notice-only behaviour.
- The integrity baseline (`integrityText`) stays the submitted text. Only the
  model input (`text`) receives the period.
- The repair is reported as `source_terminal_punctuation_restored` (action
  `repaired`). When the last paragraph was repaired, the
  `source_missing_terminal_punctuation` notice is not raised again.

Verification:
- Reported source replay: 26 lines stay 26; exactly the seven unpunctuated
  paragraphs receive a period; seven non-whitespace characters added in total.
- Synthetic tests cover positive cases, document-level evidence, idempotence,
  and negatives (headings, short lines, lists, closing quotes, citation
  brackets, web addresses, code fences, references, sentence fragments, verse).
- Full local engine run on the reported source: see release report.

Limits: a period missing in the middle of a paragraph with no following space
("…있다민간의") is not detected here; word-internal 다 is too common to split
safely without morphological analysis. Sentences ending in nominal forms
(…함, …임) are not given a period. Existing stored results and billing policies
are unchanged.
