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
  buildDetectPrompt: detect.buildDetectPrompt,
  buildRewritePrompt: repair.buildRewritePrompt,
  buildEvidencePrompt: evidence.buildEvidencePrompt
};
