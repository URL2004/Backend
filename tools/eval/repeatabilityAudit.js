'use strict';

// Offline evaluation helper. This must not be imported by the production graph.
const { compareNumberMultiset } = require('../../engine-gpt-prod/factAudit');
const { buildVoiceProfile, auditVoice } = require('../../engine-gpt-prod/voiceProfile');

const VERSION = 1;
const INVARIANT_VOICE_CODES = new Set([
  'speaker_injected',
  'speaker_removed',
  'quote_count_changed',
  'quote_content_changed',
  'list_structure_changed',
  'heading_structure_changed',
  'questionnaire_structure_changed',
  'title_line_merged',
  'structural_line_loss',
  'creative_line_structure',
  'line_structure_changed'
]);

function auditRepeatability({ source, outputs, documentProfile = 'unknown', mode = 'assignment' } = {}) {
  const sourceText = String(source || '');
  const candidates = Array.isArray(outputs) ? outputs.map(value => String(value || '')) : [];
  const sourceProfile = buildVoiceProfile(sourceText, { documentProfile, mode });
  const runs = candidates.map((output, index) => auditRun({
    index,
    source: sourceText,
    sourceProfile,
    output,
    documentProfile,
    mode
  }));
  const failureCodes = [...new Set(runs.flatMap(run => run.issueCodes))];
  return {
    version: VERSION,
    runCount: runs.length,
    passedRunCount: runs.filter(run => run.pass).length,
    failedRunCount: runs.filter(run => !run.pass).length,
    pass: runs.length > 0 && runs.every(run => run.pass),
    failureCodes,
    runs
  };
}

function auditRun({ index, source, sourceProfile, output, documentProfile, mode }) {
  if (!output.trim()) {
    return {
      runOrdinal: index + 1,
      pass: false,
      issueCodes: ['empty_output'],
      numberChanged: false,
      quoteCountChanged: false,
      quoteContentChanged: false
    };
  }
  const numberAudit = compareNumberMultiset(source, output);
  const voiceAudit = auditVoice(sourceProfile, output, { documentProfile, mode, sourceText: source });
  const issueCodes = [
    ...(numberAudit.changed ? ['number_multiset_changed'] : []),
    ...(voiceAudit.warnings || [])
      .map(item => String(item?.code || ''))
      .filter(code => INVARIANT_VOICE_CODES.has(code))
  ];
  const uniqueIssueCodes = [...new Set(issueCodes)];
  return {
    runOrdinal: index + 1,
    pass: uniqueIssueCodes.length === 0,
    issueCodes: uniqueIssueCodes,
    numberChanged: numberAudit.changed === true,
    numberRemovedCount: Number(numberAudit.removedCount || 0),
    numberAddedCount: Number(numberAudit.addedCount || 0),
    quoteCountChanged: voiceAudit.directQuoteIntegrity?.countChanged === true,
    quoteContentChanged: voiceAudit.directQuoteIntegrity?.contentChanged === true
  };
}

module.exports = { VERSION, INVARIANT_VOICE_CODES, auditRepeatability };
