# v2.5.93: keep paragraphs that end without a period

Cause: forced-wrap repair treated any long line without terminal punctuation as
a PDF line wrap. Student essays often drop the final period of a paragraph
("…제시된다", "…검토할 수 있다", "…느꼈다"). Those paragraphs were joined to the
next one, later stages re-split the oversized paragraph at a different
sentence, and the delivered text contained glued boundaries such as
"…검토할 수 있다 넷째, …" and "…느꼈다 결국 …".

Changes:
- A line of 40+ characters that ends with a declarative or polite sentence
  ending (…다, …해요, …죠, …습니까) is a finished sentence. It is joined to the
  next line only when that line starts with a bound quotative or connective
  fragment that cannot open a sentence (고, 라는, 라고, 며, 면, 는데, 지만 …).
- The same finished-sentence test stops the word-continuation rule from
  treating a new sentence that starts with "하지만", "하는", "되는" as a word
  fragment of the previous line.
- Particles that merely end in 다 (마다, 보다) are not sentence endings.
- Nominal line ends (필요, 수요, …함, …임) keep the previous behaviour because
  they are common at genuine PDF wrap positions.

Verification:
- Reported source replay: 26 non-empty lines stay 26 (was 20); none of the six
  joins (lines 3, 7, 8, 12, 27, 28) happen; no glued boundary remains.
- Synthetic regression tests cover unpunctuated paragraph ends, new sentences
  that start with connective-looking words, polite endings, and the wraps that
  must still be repaired (quotative 고, particle tail, adnominal tail, nominal
  tail, 마다).
- Existing forced-wrap, vertical-table and layout suites unchanged.

Limits: a missing period is not inserted by this change; the sentence is only
kept in its own paragraph. A wrap that falls exactly after a declarative ending
and continues with an ordinary word (rare) is left as two lines. Existing stored
results and billing policies are unchanged.
