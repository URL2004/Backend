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
const commercialSignals = require('../../commercialSignals');

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
  // 청크마다 달라지는 담화 진단과 문장 번호 계약은 system prompt에 넣지 않는다.
  // system prefix를 문서 안에서 고정해야 Responses API의 prompt cache가 같은
  // 문서의 다음 청크에서도 재사용되고, 재시도 시에도 안전 규칙의 위치가 흔들리지
  // 않는다. 두 블록은 아래 taskContract로 사용자 메시지 앞부분에 붙인다.
  const taskContract = [
    discoursePromptBlock(discourseProfile),
    buildHumanizationPromptBlock(humanizationPlan)
  ].filter(Boolean).join('\n\n');
  const stable = [
    humanizeStableCore(documentProfile),
    '',
    gateSummaryBlock(),
    '',
    preservationBlock(lengthPolicy),
    '',
    '[장르 원칙]',
    genreBlock(mode, register, styleProfile, documentProfile, requestStrength),
    commercialSignals.promptSafetyBlock(documentProfile),
    speakerBlock(speakerType),
    registerBlock(register, documentProfile, { mode, requestStrength }),
    voicePromptBlock(voiceProfile, { requestStrength, mode }),
    '',
    gptBiasGuardBlock(),
    '',
    transformStrengthBlock(mode, documentProfile?.profile, requestStrength),
    '',
    structuredOutputBlock()
  ].join('\n');

  const dynamic = dynamicContextBlock({ riskProfile, userNotes, evidence, styleProfile, requestStrength, documentProfile });
  return { stable, dynamic, taskContract };
}

function validateHumanizePrompt(value, {
  taskContract = '',
  requireHumanizationContract = false
} = {}) {
  const prompt = String(value || '');
  const contract = String(taskContract || '');
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
  const professionalRegister = /어휘\s*격식:[^.\n]{0,140}(?:학술|계약|임상|직무|공식)[^.\n]{0,80}(?:유지|보존|지킨|낮추지)/u.test(prompt);
  if (professionalRegister
      && /말투\s*정책:[^.\n]{0,140}(?:조금\s*더\s*친근|구어체로\s*바꾼다|격식을\s*낮춘다)/u.test(prompt)) {
    errors.push('register_strength_conflict');
  }
  if (!/^\[좋은 변환의 기준\]$/mu.test(prompt)
      || !/실질 재구성 예:/u.test(prompt)
      || !/안전 경계 예:/u.test(prompt)) {
    errors.push('positive_rewrite_examples_missing');
  }
  if (/^\[원문 장르:\s*계약서·약관\]$/mu.test(prompt)
      && !/“할 수 있다”를 “한다”로[^.\n]*바꾸지 않는다/u.test(prompt)) {
    errors.push('legal_modality_guard_missing');
  }
  if (/^\[원문 장르:\s*시·창작문\]$/mu.test(prompt)
      && !/각 행을 합치거나 설명문으로 풀지 않고/u.test(prompt)) {
    errors.push('creative_line_guard_missing');
  }
  if (/^\[혼합 의도 안전:\s*후기·광고·혜택 주장\]$/mu.test(prompt)) {
    const genreIndex = prompt.indexOf('[장르 원칙]');
    const commercialIndex = prompt.indexOf('[혼합 의도 안전: 후기·광고·혜택 주장]');
    const biasIndex = prompt.indexOf('[GPT 성향 보정]');
    if (commercialIndex <= genreIndex || commercialIndex >= biasIndex) {
      errors.push('commercial_safety_section_order');
    }
    if ((prompt.match(/^\[혼합 의도 안전:\s*후기·광고·혜택 주장\]$/gmu) || []).length !== 1) {
      errors.push('commercial_safety_section_count');
    }
    if (!/협찬·제휴·광고 여부가 원문이나 사용자 메모에 없으면[^.\n]*만들어 내지 않는다/u.test(prompt)) {
      errors.push('commercial_disclosure_invention_guard_missing');
    }
    if (/협찬[^.\n]{0,80}(?:반드시|추가|삽입|표시해야)/u.test(prompt)) {
      errors.push('commercial_disclosure_instruction_conflict');
    }
  }
  if (/^\[실질 휴머나이징 계약\]$/mu.test(prompt)) {
    errors.push('chunk_contract_in_stable_prompt');
  }
  const contractCount = (contract.match(/^\[실질 휴머나이징 계약\]$/gmu) || []).length;
  if (requireHumanizationContract && contractCount !== 1) {
    errors.push(`humanization_contract_count:${contractCount}`);
  }
  if (contractCount > 0) {
    if (contractCount !== 1) errors.push(`humanization_contract_count:${contractCount}`);
    if (!/변화 분포 목표:[^\n]*최소\s+\d+개/u.test(contract)) {
      errors.push('humanization_coverage_contract_missing');
    }
  }
  return { pass: errors.length === 0, errors };
}

module.exports = {
  buildHumanizePrompt,
  buildHumanizeUser,
  buildEscalationInstruction,
  validateHumanizePrompt
};
