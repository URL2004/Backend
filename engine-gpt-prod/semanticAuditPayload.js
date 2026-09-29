'use strict';

// Lossless rendering of the semantic judge's evidence sections.
//
// Nothing here selects, truncates or drops evidence. Every obligation id,
// every distinct question and every ledger sentence is still sent. Only a
// value that is byte-identical to another value in the SAME record is written
// once. The compact form must expand back to exactly the original payload;
// otherwise the ORIGINAL payload is sent unchanged. Model, reasoning effort,
// output envelope, deadline, schema and response validation are not touched.
const VERSION = 'semantic-audit-payload-v1';

// question field -> the row's primary field that owns the same quotation.
const QUESTION_FIELDS = Object.freeze({
  previousCandidateSpan: 'previousCandidateSpan',
  previousProblemSpan: 'previousProblemSpan',
  detail: 'previousDetail'
});

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

// The payload exactly as JSON.stringify would have delivered it to the model.
function wireForm(value) {
  const text = JSON.stringify(value);
  return text === undefined ? undefined : JSON.parse(text);
}

function compactQuestion(row, question) {
  if (!isRecord(question)) return { value: question, omitted: 0 };
  const out = {};
  let omitted = 0;
  for (const [key, value] of Object.entries(question)) {
    const primary = QUESTION_FIELDS[key];
    if (primary && typeof value === 'string' && value.length > 0
        && own(row, primary) && row[primary] === value) { omitted += 1; continue; }
    out[key] = value;
  }
  // A question identical to the primary claim in every field is not rewritten
  // into an empty object; it stays in its original, self-explanatory form.
  if (!Object.keys(out).length) return { value: question, omitted: 0 };
  return { value: out, omitted };
}

function compactRows(rows) {
  let omitted = 0;
  const out = rows.map(row => {
    if (!isRecord(row) || !Array.isArray(row.previousQuestions)) return row;
    const previousQuestions = row.previousQuestions.map(question => {
      const compact = compactQuestion(row, question);
      omitted += compact.omitted;
      return compact.value;
    });
    return { ...row, previousQuestions };
  });
  return { rows: out, omitted };
}

// Inverse of compactRows under the announced convention: inside
// previousQuestions an ABSENT field equals the same row's primary field.
function expandObligationRows(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(row => {
    if (!isRecord(row) || !Array.isArray(row.previousQuestions)) return row;
    return { ...row, previousQuestions: row.previousQuestions.map(question => {
      if (!isRecord(question)) return question;
      const out = { ...question };
      for (const [key, primary] of Object.entries(QUESTION_FIELDS)) {
        if (!own(out, key) && typeof row[primary] === 'string') out[key] = row[primary];
      }
      return out;
    }) };
  });
}

const OBLIGATION_INSTRUCTION = [
  'PRIOR_FINDING_OBLIGATIONS 표기 규칙: previousQuestions의 각 항목에서 생략된 previousCandidateSpan·previousProblemSpan·detail은 같은 id의 previousCandidateSpan·previousProblemSpan·previousDetail과 글자 하나까지 같은 값이다.',
  '생략은 같은 인용의 중복 표기만 줄인 것이며 질문을 줄인 것이 아니다. 각 항목은 별개의 이전 지적이므로 기본 지적과 함께 하나도 빠짐없이 판정한다.',
  'In previousQuestions an omitted previousCandidateSpan, previousProblemSpan or detail is byte-identical to the same id\'s previousCandidateSpan, previousProblemSpan or previousDetail. Omission removes a repeated quotation only; every entry remains a separate earlier claim that must be adjudicated.'
].join(' ');

// Returns the rows to serialise. `compacted` is true only when the compact
// form is proven to expand to the original wire payload and is smaller.
function compactObligationPayload(rows) {
  const original = Array.isArray(rows) ? rows : [];
  // An unserialisable payload is returned untouched; the caller's own
  // serialisation then behaves exactly as it did before this module existed.
  let fullChars = 0;
  try {
    const full = JSON.stringify(original);
    fullChars = typeof full === 'string' ? full.length : 0;
  } catch {
    return { rows: original, compacted: false, reason: 'compaction_error', instruction: '',
      omittedFields: 0, fullChars: 0, compactChars: 0, version: VERSION };
  }
  const keep = reason => ({ rows: original, compacted: false, reason, instruction: '',
    omittedFields: 0, fullChars, compactChars: fullChars, version: VERSION });
  if (!original.length) return keep('empty');
  let wire, compact, text;
  try {
    wire = wireForm(original);
    compact = compactRows(wire);
    text = JSON.stringify(compact.rows);
    if (!compact.omitted) return keep('no_repeated_quotation');
    if (compact.rows.length !== wire.length
        || compact.rows.some((row, index) => isRecord(row) !== isRecord(wire[index])
          || (isRecord(row) && row.id !== wire[index].id)
          || (isRecord(row) && Array.isArray(row.previousQuestions)
            && row.previousQuestions.length !== wire[index].previousQuestions.length))) {
      return keep('shape_changed');
    }
    // Absence must mean identity for EVERY row of this payload, including rows
    // that were not shortened. One exception keeps the whole original payload.
    if (stableJson(expandObligationRows(wireForm(compact.rows))) !== stableJson(wire)) return keep('roundtrip_mismatch');
  } catch {
    return keep('compaction_error');
  }
  if (text.length >= fullChars) return keep('not_smaller');
  return { rows: compact.rows, compacted: true, reason: 'repeated_quotation', instruction: OBLIGATION_INSTRUCTION,
    omittedFields: compact.omitted, fullChars, compactChars: text.length, version: VERSION };
}

const evidenceOf = claim => String(claim?.evidence_text || '').trim();

// Existing two-line ledger rendering (unchanged; still used when the claim is
// not the verbatim evidence).
function pairedLedgerLine(claim, index) {
  return `${index + 1}. ${claim?.claim}\n   근거(원문): "${evidenceOf(claim)}"`;
}

function ledgerEntries(ledger) {
  return (ledger?.claims || []).map((claim, index) => {
    const evidence = evidenceOf(claim);
    const verbatim = typeof claim?.claim === 'string' && evidence.length > 0
      && claim.claim === evidence && !/[\r\n]/u.test(evidence);
    return { ordinal: index + 1, form: verbatim ? 'verbatim' : 'paired',
      claim: claim?.claim, evidence,
      text: verbatim ? `${index + 1}. 근거(원문): "${evidence}"` : pairedLedgerLine(claim, index) };
  });
}

function legacyLedgerText(ledger) {
  const claims = ledger?.claims || [];
  if (!claims.length) return '(none)';
  return claims.map(pairedLedgerLine).join('\n');
}

// A deterministic ledger stores the same verbatim SOURCE sentence as claim and
// as evidence. It is written once; the sentence, order and count are kept.
function ledgerText(ledger) {
  const entries = ledgerEntries(ledger);
  if (!entries.length) return '(none)';
  return entries.map(entry => entry.text).join('\n');
}

// Sizes only (never text): lets a caller record what a request was made of.
function requestShape({ system = '', user = '' } = {}) {
  const sections = Object.create(null);
  const text = String(user || '');
  const open = /<<<GPT_PROD_DATA:([A-Z][A-Z0-9_]{0,63}):([a-f0-9]{16,64})>>>\n/gu;
  let match = open.exec(text);
  while (match) {
    const start = match.index + match[0].length;
    const end = text.indexOf(`\n<<<END_GPT_PROD_DATA:${match[1]}:${match[2]}>>>`, start);
    if (end < 0) break;
    sections[match[1]] = (sections[match[1]] || 0) + (end - start);
    open.lastIndex = end;
    match = open.exec(text);
  }
  return { version: VERSION, systemChars: String(system || '').length, userChars: text.length, sections };
}

module.exports = {
  VERSION,
  OBLIGATION_INSTRUCTION,
  compactObligationPayload,
  expandObligationRows,
  ledgerEntries,
  ledgerText,
  legacyLedgerText,
  requestShape
};
