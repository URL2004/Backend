'use strict';

// Offline replay over a caller-supplied, private Markdown export directory.
// Never print or persist source/candidate text, user identifiers or excerpts.
// No provider clients or environment files are loaded.
const fs = require('node:fs');
const path = require('node:path');
const layout = require('../engine-gpt-prod/layoutStructure');
const relations = require('../engine-gpt-prod/layoutRelations');
const provenance = require('../engine-gpt-prod/semanticProvenance');
const structure = require('../engine-gpt-prod/structureChunk');
const folder = process.argv[2];
if (!folder) throw new Error('Provide a local Markdown export directory.');
const first = Number(process.argv[3] || 60), last = Number(process.argv[4] || 177);
const fence = String.fromCharCode(96).repeat(3);
function section(text, heading) {
  const start = text.indexOf(heading);
  if (start < 0) throw new Error('Missing section.');
  const open = text.indexOf(fence, start) + fence.length;
  const end = text.indexOf(fence, open);
  if (open < fence.length || end < open) throw new Error('Missing section fence.');
  return text.slice(open, end).replace(/^\r?\n/u, '').replace(/\r?\n$/u, '');
}
const summary = { first, last, records: 0, errors: [], roundtripFailures: [],
  contentChangeFailures: [], idempotenceFailures: [], repaired: [],
  flattenedReuseRejected: 0, originalExactReusePass: 0 };
for (let i = first; i <= last; i++) {
  const id = 'H' + String(i).padStart(4, '0');
  try {
    const markdown = fs.readFileSync(path.join(folder, id + '.md'), 'utf8');
    const source = section(markdown, '## 원문');
    const candidate = section(markdown, '## 휴머나이징 결과');
    const plan = structure.splitChunksForGpt(source, { coalesceEditable: true });
    if (structure.mergeChunks(plan.chunks) !== source) summary.roundtripFailures.push(id);
    const fixed = relations.restoreAttestedProseGaps(source, candidate);
    if (fixed.text.replace(/\s/gu, '') !== candidate.replace(/\s/gu, '')) summary.contentChangeFailures.push(id);
    if (relations.restoreAttestedProseGaps(source, fixed.text).text !== fixed.text) summary.idempotenceFailures.push(id);
    if (fixed.repairedCount) summary.repaired.push({ id, count: fixed.repairedCount });
    const report = provenance.bindSemanticValidation({ ran: true, pass: true }, source, source);
    if (provenance.verifySemanticValidation(report, { source, candidate: source, requireDigest: true }).status === 'pass') summary.originalExactReusePass++;
    if (provenance.verifySemanticValidation(report, { source, candidate: source.replace(/\s+/gu, ' ').trim(), requireDigest: true }).status === 'stale') summary.flattenedReuseRejected++;
    layout.buildLineRecords(candidate); // Exercise recorded-output role analysis too.
    summary.records++;
  } catch (error) {
    summary.errors.push({ id, type: error.name });
  }
}
console.log(JSON.stringify(summary, null, 2));
if (summary.errors.length || summary.roundtripFailures.length || summary.contentChangeFailures.length
    || summary.idempotenceFailures.length) process.exitCode = 1;
