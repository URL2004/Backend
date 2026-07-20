'use strict';

const { preservationBlock } = require('../common/preservation');
const { gptBiasGuardBlock } = require('../common/gptBiasGuard');
const { structuredOutputBlock } = require('../common/output');
const { gateSummaryBlock } = require('../common/conflictPolicy');
const { humanizeStableCore, transformStrengthBlock } = require('./stableCore');
const { genreBlock } = require('./genreBlocks');
const { speakerBlock } = require('./speakerBlocks');
const { registerBlock } = require('./registerBlocks');
const { dynamicContextBlock } = require('./riskBlocks');
const { buildHumanizeUser } = require('./userBlock');
const { buildEscalationInstruction } = require('./escalation');
const { voicePromptBlock } = require('../../voiceProfile');
const { buildHumanizationPromptBlock } = require('../../humanizationDepth');
const { discoursePromptBlock } = require('../../discourseAudit');

function buildHumanizePrompt(mode = 'assignment', lang = 'ko', {
  speakerType = 'individual',
  register = 'mixed',
  lengthPolicy,
  styleProfile = 'gpt_prod',
  userNotes = '',
  evidence = '',
  requestStrength = '',
  riskProfile = '',
  documentProfile = null,
  voiceProfile = null,
  humanizationPlan = null,
  discourseProfile = null
} = {}) {
  const stable = [
    humanizeStableCore(),
    '',
    gptBiasGuardBlock(),
    '',
    transformStrengthBlock(mode, documentProfile?.profile, requestStrength),
    buildHumanizationPromptBlock(humanizationPlan),
    '',
    gateSummaryBlock(),
    '',
    structuredOutputBlock(),
    '',
    preservationBlock(lengthPolicy),
    '',
    '[장르 원칙]',
    genreBlock(mode, register, styleProfile, documentProfile, requestStrength),
    discoursePromptBlock(discourseProfile),
    speakerBlock(speakerType),
    registerBlock(register, documentProfile),
    voicePromptBlock(voiceProfile)
  ].join('\n');

  const dynamic = dynamicContextBlock({ riskProfile, userNotes, evidence, styleProfile, requestStrength, documentProfile });
  return { stable, dynamic };
}

module.exports = {
  buildHumanizePrompt,
  buildHumanizeUser,
  buildEscalationInstruction
};
