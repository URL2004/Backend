'use strict';

const humanize = require('./humanize');
const detect = require('./detect');
const repair = require('./repair');
const evidence = require('./evidence');

module.exports = {
  buildHumanizePrompt: humanize.buildHumanizePrompt,
  validateHumanizePrompt: humanize.validateHumanizePrompt,
  buildHumanizeUser: humanize.buildHumanizeUser,
  buildEscalationInstruction: humanize.buildEscalationInstruction,
  DETECT_PROMPT_VERSION: detect.DETECT_PROMPT_VERSION,
  buildDetectPrompt: detect.buildDetectPrompt,
  buildRewritePrompt: repair.buildRewritePrompt,
  buildEvidencePrompt: evidence.buildEvidencePrompt
};
