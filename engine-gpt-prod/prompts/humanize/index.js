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
    gateSummaryBlock(),
    '',
    preservationBlock(lengthPolicy),
    '',
    '[장르 원칙]',
    genreBlock(mode, register, styleProfile, documentProfile, requestStrength),
    discoursePromptBlock(discourseProfile),
    speakerBlock(speakerType),
    registerBlock(register, documentProfile),
    voicePromptBlock(voiceProfile),
    '',
    gptBiasGuardBlock(),
    '',
    transformStrengthBlock(mode, documentProfile?.profile, requestStrength),
    buildHumanizationPromptBlock(humanizationPlan),
    '',
    structuredOutputBlock()
  ].join('\n');

  const dynamic = dynamicContextBlock({ riskProfile, userNotes, evidence, styleProfile, requestStrength, documentProfile });
  return { stable, dynamic };
}

function validateHumanizePrompt(value) {
  const prompt = String(value || '');
  const errors = [];
  const requiredInOrder = [
    '[GPT-PROD-HUMANIZE]',
    '[작업 우선순위]',
    '[불변 계약]',
    '[장르 원칙]',
    '[GPT 성향 보정]',
    '[요청 강도:',
    '[출력 형식]'
  ];
  let cursor = -1;
  for (const marker of requiredInOrder) {
    const index = prompt.indexOf(marker);
    if (index < 0) errors.push(`missing_section:${marker}`);
    else if (index <= cursor) errors.push(`section_order:${marker}`);
    cursor = Math.max(cursor, index);
  }
  const headings = [...prompt.matchAll(/^\[([^\]\n]{2,80})\]$/gmu)].map(match => match[1]);
  const duplicates = [...new Set(headings.filter((heading, index) => headings.indexOf(heading) !== index))];
  if (duplicates.length) errors.push(...duplicates.map(heading => `duplicate_section:${heading}`));
  const strengthHeadings = prompt.match(/^\[요청 강도:\s*(?:다듬기|기본|고급)\]$/gmu) || [];
  const genreHeadings = prompt.match(/^\[원문 장르:[^\]\n]+\]$/gmu) || [];
  if (strengthHeadings.length !== 1) errors.push(`request_strength_count:${strengthHeadings.length}`);
  if (genreHeadings.length !== 1) errors.push(`document_genre_count:${genreHeadings.length}`);
  if (/원문의\s*격식[^.\n]{0,80}유지/u.test(prompt)
      && /전문\s*표현으로\s*높이면서/u.test(prompt)) {
    errors.push('register_strength_conflict');
  }
  if (/^\[원문 장르:\s*계약서·약관\]$/mu.test(prompt)
      && !/“할 수 있다”를 “한다”로[^.\n]*바꾸지 않는다/u.test(prompt)) {
    errors.push('legal_modality_guard_missing');
  }
  if (/^\[원문 장르:\s*시·창작문\]$/mu.test(prompt)
      && !/각 행을 합치거나 설명문으로 풀지 않고/u.test(prompt)) {
    errors.push('creative_line_guard_missing');
  }
  return { pass: errors.length === 0, errors };
}

module.exports = {
  buildHumanizePrompt,
  buildHumanizeUser,
  buildEscalationInstruction,
  validateHumanizePrompt
};
