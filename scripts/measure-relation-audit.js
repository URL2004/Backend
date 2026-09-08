'use strict';
// Measures relationAudit + experienceAudit on the synthetic minimal-pair fixture.
// Numbers are synthetic-set numbers for tuning heuristics; they are not
// production error rates and must not be read as recall on user documents.
const fs = require('node:fs');
const path = require('node:path');
const { auditRelationCandidates } = require('../engine-gpt-prod/relationAudit');
const { detectExperienceCandidate } = require('../engine-gpt-prod/experienceAudit');

const VERSION = 'measure-relation-audit-v1';
const DEFAULT_FIXTURE = path.join(__dirname, '../test/fixtures/relation-minimal-pairs.json');
// The code each type is expected to raise. "any" recall counts every candidate
// code because any code routes the document to the semantic judge.
const EXPECTED_CODES = {
  certainty_scope: ['certainty_scope_candidate'],
  temporal_sequence: ['temporal_sequence_candidate'],
  temporal_to_causal: ['causal_relation_candidate'],
  numeric_attribution: ['number_ownership_candidate'],
  subject_object_swap: ['argument_ownership_candidate'],
  claim_strength: ['claim_strength_candidate'],
  omitted_speaker_experience: ['experience_candidate']
};

function auditPair(pair) {
  const relation = auditRelationCandidates(pair.source, pair.candidate);
  const experience = detectExperienceCandidate(pair.source, pair.candidate, pair.allowedExtra || '');
  const codes = [...relation.codes];
  if (experience.candidate) codes.push('experience_candidate');
  return { id: pair.id, type: pair.type, polarity: pair.polarity, obvious: pair.obvious === true,
    flagged: codes.length > 0, codes, experienceReasons: experience.reasons };
}

function measure(fixture) {
  const pairs = Array.isArray(fixture?.pairs) ? fixture.pairs : [];
  const rows = pairs.map(auditPair);
  const types = {};
  for (const type of fixture.types || [...new Set(pairs.map(pair => pair.type))]) {
    const subset = rows.filter(row => row.type === type);
    const changed = subset.filter(row => row.polarity === 'changed');
    const preserved = subset.filter(row => row.polarity === 'preserved');
    const expected = EXPECTED_CODES[type] || [];
    const byExpected = changed.filter(row => row.codes.some(code => expected.includes(code)));
    const codeCounts = {};
    for (const row of subset) for (const code of row.codes) codeCounts[code] = (codeCounts[code] || 0) + 1;
    types[type] = {
      changed: changed.length,
      changedFlagged: changed.filter(row => row.flagged).length,
      recall: ratio(changed.filter(row => row.flagged).length, changed.length),
      changedFlaggedByExpectedCode: byExpected.length,
      recallByExpectedCode: ratio(byExpected.length, changed.length),
      expectedCodes: expected,
      preserved: preserved.length,
      preservedFlagged: preserved.filter(row => row.flagged).length,
      falsePositiveRate: ratio(preserved.filter(row => row.flagged).length, preserved.length),
      missedIds: changed.filter(row => !row.flagged).map(row => row.id),
      falsePositiveIds: preserved.filter(row => row.flagged).map(row => row.id),
      codeCounts
    };
  }
  const changed = rows.filter(row => row.polarity === 'changed');
  const preserved = rows.filter(row => row.polarity === 'preserved');
  const obvious = preserved.filter(row => row.obvious);
  return {
    version: VERSION,
    fixtureVersion: fixture.version || null,
    synthetic: true,
    pairCount: rows.length,
    overall: {
      changed: changed.length,
      changedFlagged: changed.filter(row => row.flagged).length,
      recall: ratio(changed.filter(row => row.flagged).length, changed.length),
      preserved: preserved.length,
      preservedFlagged: preserved.filter(row => row.flagged).length,
      falsePositiveRate: ratio(preserved.filter(row => row.flagged).length, preserved.length)
    },
    obviousParaphraseSubset: {
      count: obvious.length,
      flagged: obvious.filter(row => row.flagged).length,
      flaggedIds: obvious.filter(row => row.flagged).map(row => row.id)
    },
    types,
    rows
  };
}

function ratio(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 1000) / 1000 : null;
}

function renderTable(report) {
  const lines = ['type | changed | recall(any) | recall(expected) | preserved | FP rate | FP ids | missed ids'];
  for (const [type, row] of Object.entries(report.types)) {
    lines.push([type, row.changed, `${row.changedFlagged}/${row.changed} (${pct(row.recall)})`,
      `${row.changedFlaggedByExpectedCode}/${row.changed} (${pct(row.recallByExpectedCode)})`, row.preserved,
      `${row.preservedFlagged}/${row.preserved} (${pct(row.falsePositiveRate)})`,
      row.falsePositiveIds.join(',') || '-', row.missedIds.join(',') || '-'].join(' | '));
  }
  const overall = report.overall;
  lines.push(`overall | ${overall.changed} | ${overall.changedFlagged}/${overall.changed} (${pct(overall.recall)}) | - | ${overall.preserved} | ${overall.preservedFlagged}/${overall.preserved} (${pct(overall.falsePositiveRate)}) | - | -`);
  lines.push(`obvious paraphrase subset: ${report.obviousParaphraseSubset.flagged}/${report.obviousParaphraseSubset.count} flagged`);
  return lines.join('\n');
}

function pct(value) {
  return value === null ? 'n/a' : `${Math.round(value * 100)}%`;
}

function parseArgs(argv) {
  const options = { fixture: DEFAULT_FIXTURE, out: '', quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') options.out = argv[++index] || '';
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length);
    else if (arg === '--fixture') options.fixture = argv[++index] || DEFAULT_FIXTURE;
    else if (arg.startsWith('--fixture=')) options.fixture = arg.slice('--fixture='.length);
    else if (arg === '--quiet') options.quiet = true;
    else throw new Error(`unknown_argument:${arg}`);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const fixture = JSON.parse(fs.readFileSync(path.resolve(options.fixture), 'utf8'));
  const report = measure(fixture);
  report.fixturePath = path.resolve(options.fixture);
  const json = JSON.stringify(report, null, 2);
  if (options.out) {
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    fs.writeFileSync(path.resolve(options.out), json + '\n');
    if (!options.quiet) console.log(renderTable(report));
  } else if (!options.quiet) {
    console.log(json);
  }
  return report;
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { VERSION, EXPECTED_CODES, DEFAULT_FIXTURE, auditPair, measure, renderTable, main };
