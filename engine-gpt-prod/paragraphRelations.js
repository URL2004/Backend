'use strict';

const layout = require('./layoutStructure');
const { splitSentenceSpans } = require('../engine/koreanText');
const { syntaxSpans } = require('../engine/textSyntax');
const bare = s => s.replace(/\s/gu, '');

// Last-mile boundary edits, not rewriting. A dependent explanation stays with
// its claim; only the dependent sentence moves across the *blank*, never words
// across another sentence. Shared syntax offsets protect quotes, code and notes.
function refineParagraphRelations(value, { protectedBlocks = [], documentProfile = null } = {}) {
  const text = String(value || '');
  const records = layout.buildLineRecords(text);
  const literals = syntaxSpans(text);
  const lockedSpans = [];
  for (const block of protectedBlocks) {
    if (!block) continue;
    let at = text.indexOf(block);
    while (at >= 0) {
      lockedSpans.push({start: at, end: at + block.length});
      at = text.indexOf(block, at + block.length);
    }
  }
  const edits = [];
  const reasons = {};
  const protectedAt = (a, b) => literals.some(s => s.start < b && s.end > a);
  const locked = (a, b) => protectedBlocks.some(block => {
    const content = bare(String(block || ''));
    return content && bare(text.slice(a, b)).includes(content);
  });
  const safeGap = (a, b) => a < b && /^\s+$/u.test(text.slice(a, b))
    && !protectedAt(a, b) && !lockedSpans.some(s => s.start < b && s.end > a);
  const add = (a, b, replacement, reason) => {
    if (!safeGap(a, b) || text.slice(a, b) === replacement) return;
    if (edits.some(e => a < e.end && b > e.start)) return;
    edits.push({ start: a, end: b, value: replacement });
    reasons[reason] = (reasons[reason] || 0) + 1;
  };
  const plain = r => r && !r.blank && r.role === 'prose'
    && !/\t|\S {2,}\S/u.test(r.raw) && !locked(r.start, r.end);
  const contentStart = r => r.start + r.raw.indexOf(r.text);
  const atoms = s => new Set((s.match(/[가-힣]{2,}/gu) || [])
    .map(w => w.replace(/(?:에서는|으로는|에는|에서|으로|에게|은|는|이|가|을|를|도|만)$/u, ''))
    .filter(w => w.length >= 2));
  const overlaps = (a, b) => {
    const words = atoms(a);
    return [...atoms(b)].some(w => words.has(w));
  };

  // Label groups are an alternative/step list, not the end of a preceding
  // evaluation paragraph. Do not add gaps between short form fields.
  for (let i = 1; i < records.length - 1; i++) {
    const r = records[i], prev = records[i - 1], next = records[i + 1];
    if (r.role !== 'label_inline' || next.role !== 'label_inline' || !plain(prev)) continue;
    const body = layout.labelParts(r.text)?.rest || '';
    const nextBody = layout.labelParts(next.text)?.rest || '';
    if (body.length < 30 || nextBody.length < 30
        || !layout.isSentenceComplete(body) || !layout.isSentenceComplete(nextBody)) continue;
    add(prev.end, r.start, '\n\n', 'label_group');
  }

  for (let i = 0; i < records.length; i++) {
    const left = records[i];
    if (left.blank) continue;
    let j = i + 1;
    while (records[j]?.blank) j++;
    const right = records[j];
    if (!right || j === i + 1 || !safeGap(left.end, right.start)) continue;
    const numberedClaim = ['list', 'heading'].includes(left.role) && /^\d+[.)]\s/u.test(left.text)
      && layout.isSentenceComplete(left.text);
    // A complete reason explains its numbered claim; keep the number as a
    // separate line so list ownership remains unchanged.
    if (numberedClaim && plain(right) && /때문(?:이다|입니다)[.!?]$/u.test(right.text)
        && right.text.length <= 300 && !protectedAt(left.end, right.start)) {
      add(left.end, right.start, '\n', 'claim_reason');
      continue;
    }
    if (plain(left) && /^(?:좋습니다|알겠습니다|네)[.!]$/u.test(left.text)
        && ['prose', 'list'].includes(right.role)
        && /(?:제안|설명|안내|정리)하겠습니다[.!]/u.test(right.text.slice(0, 120))) {
      add(left.end, right.start, '\n', 'intro_acknowledgement');
      continue;
    }
    if (!plain(left) || !plain(right)) continue;
    const rightSentences = splitSentenceSpans(right.text);
    if (rightSentences.length < 2) continue;
    const first = rightSentences[0], second = rightSentences[1];
    const previousSentences = splitSentenceSpans(left.text);
    const previous = previousSentences.at(-1)?.text || '';
    if (documentProfile?.signals?.definitionSummaryFrame && previousSentences.length >= 4) {
      const subject = require('./paragraphDependency').definitionSubject;
      const subjects = previousSentences.map(s=>subject(s.text));
      let cut = -1;
      for (let n=2;n<subjects.length;n++) {
        const a=subjects[n-2],b=subjects[n-1],c=subjects[n];
        if(a&&b&&c&&(a.endsWith(b)||b.endsWith(a))&&!c.endsWith(b)&&!b.endsWith(c)) {cut=n;break;}
      }
      if(cut>=2 && previousSentences.length-cut+rightSentences.length<=6
          && left.text.slice(previousSentences[cut].start).length+right.text.length<800) {
        const a=contentStart(left)+previousSentences[cut-1].end,b=contentStart(left)+previousSentences[cut].start;
        if(safeGap(a,b)) {
          add(a,b,'\n\n','definition_topic_group');
          add(left.end,right.start,' ','definition_topic_group');
          continue;
        }
      }
    }
    // Move the preceding claim together with its dependent continuation,
    // instead of merging both paragraphs into another overlong block.
    const dependency = require('./paragraphDependency').dependentBoundary(previous, first.text);
    if (dependency && previousSentences.length >= 3 && rightSentences.length <= 5
        && previous.length + right.text.length < 750) {
      const penultimate = previousSentences.at(-2), last = previousSentences.at(-1);
      const a = contentStart(left) + penultimate.end, b = contentStart(left) + last.start;
      if (safeGap(a,b) && !protectedAt(a,b) && layout.isSentenceComplete(penultimate.text)) {
        add(a,b,'\n\n',dependency);
        add(left.end,right.start,' ',dependency);
        continue;
      }
    }
    const joined = left.text + ' ' + first.text;
    // No new overlong wall of text. Moving an existing boundary must leave
    // both a complete explanation and a developed following paragraph.
    if (joined.length > 850 || previousSentences.length > 7
        || !layout.isSentenceComplete(first.text)) continue;
    let reason = '';
    if (/이유/u.test(previous) && /설명할\s*수는?\s*없/u.test(previous)
        && /때문에/u.test(first.text)
        && /(?:등장|도입|확산|변화)(?:으로|로|에 따라)/u.test(second.text)
        && /(?:달라|변하|바뀌)/u.test(second.text)) reason = 'claim_explanation';
    else if (/^그렇다고\s/u.test(first.text) && /(?:세요|십시오)[.!]$/u.test(previous)
        && overlaps(previous, first.text))
      reason = 'recommendation_exception';
    else if (/^(?:실제로|만약|이때)\s/u.test(first.text)
        && /(?:면|경우)/u.test(first.text)
        && /(?:재\s*볼|측정|확인|살펴)/u.test(left.text)
        && overlaps(left.text, first.text)
        && /(?:께도|에게도|분께|여러분|담당자).*(?:부탁|알려|설명)/u.test(second.text))
      reason = 'condition_response';
    else if (/(?:\d+|한|두|세|네|다섯|여섯)\s*가지로\s*정리/u.test(left.text)
        && /(?:세요|십시오)[.!]$/u.test(first.text)
        && /(?:면|때는)/u.test(first.text)
        && !/^(?:대부분|너무\s*걱정|궁금한)/u.test(first.text)
        && /^(?:대부분|너무\s*걱정|궁금한)/u.test(second.text))
      reason = 'summary_continuation';
    if (!reason) continue;
    const cutA = contentStart(right) + first.end, cutB = contentStart(right) + second.start;
    if (!safeGap(cutA, cutB) || protectedAt(left.end, right.start)) continue;
    add(left.end, right.start, ' ', reason);
    add(cutA, cutB, '\n\n', reason);
  }

  // A trailing author-year citation belongs to the preceding claim. A new
  // geographical scope with an explicit change-of-context predicate can
  // begin after it, never between that claim and its citation.
  for (const r of records) {
    if (!plain(r)) continue;
    const spans = splitSentenceSpans(r.text);
    if (spans.length < 6) continue;
    for (let i = 2; i < spans.length - 1; i++) {
      const s = spans[i];
      const citation = s.text.match(/^\([^()\n]{1,100},\s*(?:19|20)\d{2}[a-z]?\)\s+/u);
      if (!citation) continue;
      const body = s.text.slice(citation[0].length);
      if (!/(?:국내|국외|해외|지역)\s/u.test(body)
          || !/(?:전환점|새로운\s*국면|변화의\s*시기)/u.test(body)
          || /^(?:이러한|따라서|예컨대|특히|또한|이처럼)/u.test(body)) continue;
      const b = contentStart(r) + s.start + citation[0].length;
      let a = b;
      while (a > 0 && /\s/u.test(text[a - 1])) a--;
      add(a, b, '\n\n', 'cited_context_transition');
    }
  }

  let result = text;
  for (const e of edits.sort((a, b) => b.start - a.start))
    result = result.slice(0, e.start) + e.value + result.slice(e.end);
  return { text: result, repairCount: edits.length, reasons, contentPreserved: bare(result) === bare(text) };
}

module.exports = { refineParagraphRelations };
