'use strict';

const fs = require('node:fs');
const path = require('node:path');

const structureChunk = require('../engine-gpt-prod/structureChunk');
const layoutStructure = require('../engine-gpt-prod/layoutStructure');

function parseArgs(argv) {
  const options = { input: '', engineVersion: '', details: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || '');
    if (value === '--input') options.input = String(argv[++index] || '');
    else if (value === '--engine-version') options.engineVersion = String(argv[++index] || '');
    else if (value === '--details') options.details = true;
  }
  if (!options.input) throw new Error('--input <local-json-path> is required');
  return options;
}

function compact(value) {
  return String(value || '').replace(/\s+/gu, '');
}

function profileFor(row) {
  const meta = row?.engineMeta || {};
  return {
    profile: String(meta.documentProfile || 'unknown'),
    confidence: Number(meta.profileConfidence) || 0,
    formatProfile: meta.formatProfile || { primary: 'plain', flags: [] }
  };
}

function summarize(rows) {
  const changed = rows.filter(row => row.changed);
  const contentMismatch = rows.filter(row => !row.contentPreserved);
  const beforeOverlong = rows.filter(row => row.beforeOverlongCount > 0);
  const afterOverlong = rows.filter(row => row.afterOverlongCount > 0);
  return {
    rowCount: rows.length,
    changedCount: changed.length,
    changedRatio: ratio(changed.length, rows.length),
    contentMismatchCount: contentMismatch.length,
    beforeOverlongDocumentCount: beforeOverlong.length,
    afterOverlongDocumentCount: afterOverlong.length,
    overlongResolvedCount: rows.filter(row => row.beforeOverlongCount > 0 && row.afterOverlongCount === 0).length,
    visualGapRepairDocumentCount: rows.filter(row => row.visualGapRepairCount > 0).length,
    proseSplitDocumentCount: rows.filter(row => row.proseSplitCount > 0).length,
    explicitParagraphIncreaseDocumentCount: rows.filter(row => row.explicitAfter > row.explicitBefore).length,
    paragraphFailureCount: rows.filter(row => !row.paragraphPass).length,
    preExistingHeadingMismatchCount: rows.filter(row => row.headingMissingCount > 0).length,
    maxSentencesBefore: rows.length ? Math.max(...rows.map(row => row.maxSentencesBefore)) : 0,
    maxSentencesAfter: rows.length ? Math.max(...rows.map(row => row.maxSentencesAfter)) : 0,
    policies: countBy(rows, row => row.policy),
    profilesChanged: countBy(changed, row => row.profile)
  };
}

function ratio(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 1000 : 0;
}

function countBy(rows, keyOf) {
  const counts = {};
  for (const row of rows) {
    const key = String(keyOf(row) || 'unknown');
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(options.input);
  const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const sourceRows = Array.isArray(payload) ? payload : (Array.isArray(payload.rows) ? payload.rows : []);
  const selected = sourceRows.filter(row => {
    if (!String(row?.inputText || '').trim() || !String(row?.outputText || '').trim()) return false;
    if (!options.engineVersion) return true;
    return String(row?.engineMeta?.engineVersion || '') === options.engineVersion;
  });
  const rows = selected.map(row => {
    const profile = profileFor(row);
    const mode = String(row?.engineMeta?.effectiveMode || row?.mode || '');
    const requestStrength = String(row?.engineMeta?.requestStrength || '');
    const readabilityOptions = { mode, requestStrength, documentProfile: profile };
    const before = layoutStructure.measureParagraphReadability(row.outputText, readabilityOptions);
    const chunks = structureChunk.splitChunksForGpt(row.inputText, {
      coalesceEditable: true,
      preserveLineBoundaries: 'structural',
      formatProfile: profile.formatProfile
    }).chunks;
    const restored = structureChunk.restorePostSemanticLayout({
      source: row.inputText,
      outputText: row.outputText,
      chunks,
      mode,
      requestStrength,
      documentProfile: profile,
      profileConfidence: profile.confidence
    });
    const after = layoutStructure.measureParagraphReadability(restored.text, readabilityOptions);
    return {
      id: String(row.docId || ''),
      profile: profile.profile,
      mode,
      requestStrength,
      changed: restored.text !== String(row.outputText || '').replace(/\r\n?/gu, '\n').trim(),
      contentPreserved: compact(restored.text) === compact(row.outputText),
      policy: String(restored.paragraphs?.policy || 'none'),
      beforeOverlongCount: before.overlongCount,
      afterOverlongCount: after.overlongCount,
      maxSentencesBefore: before.maxSentences,
      maxSentencesAfter: after.maxSentences,
      explicitBefore: Number(restored.paragraphs?.explicitParagraphCountBefore) || 0,
      explicitAfter: Number(restored.paragraphs?.explicitParagraphCountAfter) || 0,
      visualGapRepairCount: Number(restored.paragraphs?.visualGapRepairCount) || 0,
      proseSplitCount: Number(restored.paragraphs?.proseSplitCount) || 0,
      paragraphPass: restored.paragraphs?.pass !== false,
      layoutPass: restored.pass === true,
      headingMissingCount: Number(restored.heading?.missingCount) || 0
    };
  });
  const output = {
    inputFile: path.basename(inputPath),
    engineVersionFilter: options.engineVersion || null,
    summary: summarize(rows),
    failures: rows.filter(row => !row.contentPreserved || !row.paragraphPass),
    preExistingStructureMismatches: rows.filter(row => row.headingMissingCount > 0),
    details: options.details ? rows : undefined
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main();
