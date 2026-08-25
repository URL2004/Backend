'use strict';

// 로컬 출시 진단 전용: 공개 API가 의도적으로 숨기는 미통과 후보를 한 건만
// 직접 검사한다. 원문·후보는 stdout에만 표시하고 파일이나 원격 로그에 저장하지 않는다.

const engine = require('../engine-writing-v1');
const { buildClaimPlan } = require('../engine-writing-v1/prompt');
const { assembleDraft, deterministicChecks } = require('../engine-writing-v1/checks');

const input = {
  genre: 'resume', subtype: 'collaboration', targetChars: 600, charLimitMode: 'with_space', tone: 'formal',
  answers: {
    prompt: '공동의 목표를 위해 협업하며 갈등을 조정한 경험을 600자 이내로 작성해 주세요.',
    company: '테스트 회사', role: '서비스 기획',
    situation: '4명이 참여한 수업 프로젝트에서 제출 일정을 관리했어요. 중간 점검 때 일정이 이틀 밀린 사실을 확인했어요.',
    goal: '정해진 마감일까지 결과물을 제출해야 했어요.',
    personalActions: '제가 남은 작업을 다시 목록으로 만들고 담당자별 완료 시간을 확인해 일정표를 수정했어요. 매일 저녁 진행 상황을 표에 반영했어요.',
    teamActions: '팀원들은 수정된 일정에 맞춰 각자 맡은 작업을 완료했어요.',
    result: '마감일 오후에 결과물을 제출했어요.',
    learning: '일정을 공유할 때 담당자와 확인 시점을 함께 적어야 실행 여부를 확인할 수 있다는 점을 배웠어요.'
  }
};

async function run() {
  const prepared = engine.prepare(input);
  const claimPlan = buildClaimPlan(prepared.input, prepared.ledger);
  const structured = await engine.defaultCallWriter({
    input: prepared.input,
    ledger: prepared.ledger,
    claimPlan,
    targetChars: 600,
    repairContext: null,
    attemptIndex: 0,
    escalate: false
  });
  const text = assembleDraft(structured);
  const checks = deterministicChecks({
    text,
    structured,
    ledger: prepared.ledger,
    targetChars: 600,
    charLimitMode: prepared.input.charLimitMode,
    policy: prepared.policy
  });
  const semantic = checks.hardPass
    ? await engine.defaultSemanticVerify({
      input: prepared.input,
      ledger: prepared.ledger,
      factIds: checks.structure.referencedFactIds,
      text,
      phase: 'diagnose'
    })
    : { pass: false, skipped: 'hard_checks_failed', violations: [] };
  let repair = null;
  if (!semantic.pass && semantic.violations?.length) {
    const repairedText = await engine.defaultSemanticRepair({
      input: prepared.input,
      ledger: prepared.ledger,
      factIds: checks.structure.referencedFactIds,
      text,
      violations: semantic.violations,
      attemptIndex: 0
    });
    const repairedStructured = engine.structuredFromText(repairedText, checks.structure.referencedFactIds, prepared.ledger);
    const repairedChecks = deterministicChecks({
      text: repairedText,
      structured: repairedStructured,
      ledger: prepared.ledger,
      targetChars: 600,
      charLimitMode: prepared.input.charLimitMode,
      policy: prepared.policy
    });
    const repairedSemantic = repairedChecks.hardPass
      ? await engine.defaultSemanticVerify({
        input: prepared.input,
        ledger: prepared.ledger,
        factIds: repairedChecks.structure.referencedFactIds,
        text: repairedText,
        phase: 'diagnose_repair'
      })
      : { pass: false, skipped: 'hard_checks_failed', violations: [] };
    repair = { text: repairedText, checks: repairedChecks, semantic: repairedSemantic };
  }
  process.stdout.write(`${JSON.stringify({ text, structured, checks, semantic, repair }, null, 2)}\n`);
}

run().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
