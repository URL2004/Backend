'use strict';

const { preservationBlock } = require('../common/preservation');
const { gptBiasGuardBlock } = require('../common/gptBiasGuard');
const { structuredOutputBlock } = require('../common/output');
const { gateSummaryBlock } = require('../common/conflictPolicy');
const { humanizeStableCore, transformStrengthBlock, naturalnessLabStableBlock } = require('./stableCore');
const { genreBlock } = require('./genreBlocks');
const { speakerBlock } = require('./speakerBlocks');
const { registerBlock } = require('./registerBlocks');
const { dynamicContextBlock } = require('./riskBlocks');
const { buildHumanizeUser } = require('./userBlock');
const { buildEscalationInstruction } = require('./escalation');

function buildHumanizePrompt(mode = 'assignment', lang = 'ko', {
  speakerType = 'individual',
  register = 'mixed',
  lengthPolicy,
  styleProfile = 'gpt_prod',
  userNotes = '',
  evidence = '',
  riskProfile = ''
} = {}) {
  const naturalnessBlock = naturalnessLabStableBlock(styleProfile);
  const stable = [
    humanizeStableCore(),
    '',
    gptBiasGuardBlock(),
    '',
    transformStrengthBlock(),
    naturalnessBlock,
    '',
    gateSummaryBlock(),
    '',
    structuredOutputBlock(),
    '',
    preservationBlock(lengthPolicy),
    '',
    '[장르 원칙]',
    genreBlock(mode, register, styleProfile),
    speakerBlock(speakerType),
    registerBlock(register)
  ].join('\n');

  const dynamic = dynamicContextBlock({ riskProfile, userNotes, evidence, styleProfile });
  return { stable, dynamic };
}

module.exports = {
  buildHumanizePrompt,
  buildHumanizeUser,
  buildEscalationInstruction
};
