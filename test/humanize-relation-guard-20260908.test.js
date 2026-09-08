'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const prompts = require('../engine-gpt-prod/prompts');
const profiles = require('../engine-gpt-prod/documentProfile');
const depth = require('../engine-gpt-prod/humanizationDepth');
const { buildVoiceProfile } = require('../engine-gpt-prod/voiceProfile');
const { buildContract } = require('../engine/contract');
const { buildHumanizeContract, relationGuardLines, resolveRelationGuard, RELATION_GUARD_VERSION } = require('../engine-gpt-prod/humanizeContract');
const { buildDiscourseProfile } = require('../engine-gpt-prod/discourseAudit');
const { humanizeAblationMatrix } = require('../lib/humanizeQualityEvaluation');

const RULE_HEAD = new RegExp(`^관계 유지 규칙=${RELATION_GUARD_VERSION}\\.`, 'gmu');
const STRENGTHS = ['polish', 'basic', 'advanced'];
const LENGTHS = [300, 1000];

function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key), previous = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { return fn(); } finally { if (had) process.env[key] = previous; else delete process.env[key]; }
}

function syntheticSource(sourceChars) {
  const unit = '자료를 읽은 뒤 서로 다른 항목을 비교했다. 표시가 빠진 부분은 원래 기록과 대조했다. 표의 수치는 바꾸지 않았다. 검토에 참여한 사람은 각자 맡은 항목을 설명했다. 다음 일정은 논의 중이다. ';
  return unit.repeat(Math.ceil(sourceChars / unit.length)).slice(0, sourceChars - 1) + '.';
}

// Mirrors reports/.../humanize-ablation-prompt-measure.cjs: one full trusted
// assembly (system + task contract + user block) per arm/profile/strength/length.
function assemble(arm, profile, requestStrength, sourceChars) {
  const source = syntheticSource(sourceChars);
  const mode = requestStrength === 'polish' ? 'polish' : requestStrength === 'basic' ? 'blog' : 'assignment';
  const documentProfile = profiles.applyTargetRegister({ profile, group: profiles.PROFILE_GROUPS[profile], confidence: 1,
    source: 'synthetic_audit_override', profileDecisionSource: 'synthetic_audit_override',
    formatProfile: { primary: 'plain', length: 'standard', flags: [] }, safetyProfiles: [], riskFlags: [] }, { requestStrength });
  const contract = buildContract(source, { mode, documentProfile });
  const humanizeContract = buildHumanizeContract({ mode, requestStrength, documentProfile });
  const humanizationPlan = depth.buildHumanizationPlan(source, { requestStrength, documentProfile, editObjective: arm.environment.HUMANIZE_EDIT_OBJECTIVE });
  const hp = prompts.buildHumanizePrompt(mode, 'ko', {
    requestStrength, documentProfile, humanizeContract, humanizationPlan,
    voiceProfile: buildVoiceProfile(source, { documentProfile, mode }), speakerType: contract.speakerType,
    register: contract.register, lengthPolicy: contract.lengthPolicy, styleProfile: 'production_transform_humanize',
    discourseProfile: buildDiscourseProfile(source), promptVariant: arm.environment.HUMANIZE_PROMPT_VARIANT,
    relationGuard: arm.environment.HUMANIZE_RELATION_GUARD
  });
  const user = prompts.buildHumanizeUser({ chunk: { text: source, index: 0, position: 'body' }, chunks: [{ text: source, index: 0 }], index: 0,
    dynamicContext: hp.dynamic, taskContract: hp.taskContract, mode, humanizeContract });
  const validation = prompts.validateHumanizePrompt(hp.stable, { taskContract: hp.taskContract, humanizeContract,
    requireHumanizationContract: humanizationPlan.applicable });
  return { hp, user, validation };
}

test('relation guard resolves only the explicit candidate value', () => {
  assert.equal(resolveRelationGuard(undefined), 'off');
  assert.equal(resolveRelationGuard(''), 'off');
  assert.equal(resolveRelationGuard('off'), 'off');
  assert.equal(resolveRelationGuard('1'), 'off');
  assert.equal(resolveRelationGuard('clear_relations_v2'), 'off');
  assert.equal(resolveRelationGuard('clear_relations_v1'), 'clear_relations_v1');
  assert.deepEqual(relationGuardLines('off'), []);
  assert.deepEqual(relationGuardLines(), []);
  const lines = relationGuardLines('clear_relations_v1');
  assert.ok(lines.length >= 3 && lines.length <= 5, 'rule block stays short');
  assert.match(lines[0], RULE_HEAD);
  assert.ok(lines.every(line => !/^\[/u.test(line)), 'no new section heading');
});

test('flag off leaves full and compact prompts byte-identical, from env and from option', () => {
  for (const promptVariant of ['full', 'compact_v1']) for (const requestStrength of STRENGTHS) {
    const mode = requestStrength === 'polish' ? 'polish' : 'assignment';
    const plan = depth.buildHumanizationPlan(syntheticSource(300), { requestStrength });
    const base = { requestStrength, humanizationPlan: plan, promptVariant };
    const reference = withEnv('HUMANIZE_RELATION_GUARD', undefined, () => prompts.buildHumanizePrompt(mode, 'ko', base));
    assert.equal(reference.relationGuard, 'off');
    assert.equal((reference.stable.match(RULE_HEAD) || []).length, 0);
    for (const value of ['off', '', 'unknown', '0']) {
      assert.equal(prompts.buildHumanizePrompt(mode, 'ko', { ...base, relationGuard: value }).stable, reference.stable, `option ${value}`);
      assert.equal(withEnv('HUMANIZE_RELATION_GUARD', value, () => prompts.buildHumanizePrompt(mode, 'ko', base)).stable, reference.stable, `env ${value}`);
    }
    // The only legacy arms are those whose environment lacks the flag entirely.
    for (const arm of humanizeAblationMatrix().filter(row => !('HUMANIZE_RELATION_GUARD' in row.environment))) {
      if (arm.environment.HUMANIZE_PROMPT_VARIANT !== promptVariant) continue;
      const armPlan = depth.buildHumanizationPlan(syntheticSource(300), { requestStrength, editObjective: arm.environment.HUMANIZE_EDIT_OBJECTIVE });
      const viaArm = prompts.buildHumanizePrompt(mode, 'ko', { ...base, humanizationPlan: armPlan, relationGuard: arm.environment.HUMANIZE_RELATION_GUARD });
      const viaEnvOnly = withEnv('HUMANIZE_RELATION_GUARD', undefined, () => prompts.buildHumanizePrompt(mode, 'ko', { ...base, humanizationPlan: armPlan }));
      assert.equal(viaArm.stable, viaEnvOnly.stable);
    }
  }
});

test('flag on adds exactly the rule block once, directly after the meaning-preservation lines, and nothing else', () => {
  const block = relationGuardLines('clear_relations_v1').join('\n');
  for (const promptVariant of ['full', 'compact_v1']) for (const requestStrength of STRENGTHS) {
    const mode = requestStrength === 'polish' ? 'polish' : 'assignment';
    const plan = depth.buildHumanizationPlan(syntheticSource(300), { requestStrength });
    const base = { requestStrength, humanizationPlan: plan, promptVariant };
    const off = prompts.buildHumanizePrompt(mode, 'ko', { ...base, relationGuard: 'off' });
    const on = prompts.buildHumanizePrompt(mode, 'ko', { ...base, relationGuard: 'clear_relations_v1' });
    const viaEnv = withEnv('HUMANIZE_RELATION_GUARD', 'clear_relations_v1', () => prompts.buildHumanizePrompt(mode, 'ko', base));
    assert.equal(on.relationGuard, 'clear_relations_v1');
    assert.equal(viaEnv.stable, on.stable);
    assert.equal((on.stable.match(RULE_HEAD) || []).length, 1);
    assert.equal(on.stable.split(block).length, 2, 'block appears exactly once as a contiguous unit');
    assert.equal(on.stable.replace('\n' + block, ''), off.stable, 'removing the block restores the flag-off prompt');
    assert.ok(on.stable.includes('원문의 근거가 있을 때만 쓴다.\n' + block), 'block follows meaningPreservationLines');
    assert.equal(on.taskContract, off.taskContract);
    assert.equal(on.dynamic, off.dynamic);
    // The rule must not re-authorize paragraph edits or re-open the register policy.
    for (const bad of [/문단/u, /말투\s*정책/u, /어휘\s*격식/u]) assert.doesNotMatch(block, bad);
    const validation = prompts.validateHumanizePrompt(on.stable, { taskContract: on.taskContract, requireHumanizationContract: plan.applicable });
    assert.equal(validation.pass, true, validation.errors.join(','));
  }
});

test('validator rejects a duplicated or displaced relation guard block', () => {
  const on = prompts.buildHumanizePrompt('assignment', 'ko', { requestStrength: 'advanced', relationGuard: 'clear_relations_v1' });
  const block = relationGuardLines('clear_relations_v1').join('\n');
  const duplicated = on.stable.replace('[좋은 변환의 기준]', block + '\n[좋은 변환의 기준]');
  assert.ok(prompts.validateHumanizePrompt(duplicated).errors.includes('relation_guard_rule_count:2'));
  const displaced = on.stable.replace('\n' + block, '').replace('[좋은 변환의 기준]', block + '\n[좋은 변환의 기준]');
  assert.ok(prompts.validateHumanizePrompt(displaced).errors.includes('relation_guard_rule_position'));
});

test('all 5 arms x 16 profiles x 3 strengths x 2 lengths assemble and pass the trusted contract validator', () => {
  const matrix = humanizeAblationMatrix();
  assert.equal(matrix.length, 5);
  let count = 0;
  for (const arm of matrix) for (const sourceChars of LENGTHS) for (const profile of profiles.CONTENT_GENRES) for (const requestStrength of STRENGTHS) {
    const { hp, user, validation } = assemble(arm, profile, requestStrength, sourceChars);
    const label = `${arm.id}/${profile}/${requestStrength}/${sourceChars}`;
    assert.equal(validation.pass, true, `${label}: ${validation.errors.join(',')}`);
    const expected = arm.environment.HUMANIZE_RELATION_GUARD === 'clear_relations_v1' ? 1 : 0;
    assert.equal((hp.stable.match(RULE_HEAD) || []).length, expected, label);
    assert.equal((hp.taskContract.match(RULE_HEAD) || []).length, 0, label);
    assert.equal((user.match(RULE_HEAD) || []).length, 0, label);
    assert.equal(hp.relationGuard, expected ? 'clear_relations_v1' : 'off', label);
    assert.equal(hp.promptVariant, arm.environment.HUMANIZE_PROMPT_VARIANT, label);
    count++;
  }
  assert.equal(count, 5 * 16 * 3 * 2);
});

test('relation_guard arm equals compact_only plus exactly the rule block for every profile, strength and length', () => {
  const matrix = humanizeAblationMatrix();
  const compact = matrix.find(arm => arm.id === 'compact_only'), guarded = matrix.find(arm => arm.id === 'relation_guard');
  const block = relationGuardLines('clear_relations_v1').join('\n');
  for (const sourceChars of LENGTHS) for (const profile of profiles.CONTENT_GENRES) for (const requestStrength of STRENGTHS) {
    const a = assemble(compact, profile, requestStrength, sourceChars), b = assemble(guarded, profile, requestStrength, sourceChars);
    assert.equal(b.hp.stable.replace('\n' + block, ''), a.hp.stable, `${profile}/${requestStrength}/${sourceChars}`);
    assert.equal(b.hp.taskContract, a.hp.taskContract);
    // The user block carries a fresh envelope nonce per call; everything else is identical.
    const stripNonce = text => text.replace(/:[0-9a-f]{16,64}>>>/gu, ':NONCE>>>');
    assert.equal(stripNonce(b.user), stripNonce(a.user));
  }
});
