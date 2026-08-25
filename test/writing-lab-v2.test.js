'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../engine-writing-v1');
const { extractQuantities, compareQuantities } = require('../engine-writing-v1/numberAst');
const { charCounts, limitCheck, metaCheck } = require('../engine-writing-v1/checks');
const { signContext, verifyContext } = require('../engine-writing-v1/contextToken');
const usage = require('../engine-writing-v1/usage');
const { extractCandidates } = require('../engine-writing-v1/extractor');
const jobs = require('../engine-writing-v1/jobStore');
const { registrySnapshot, validatePack } = require('../engine-writing-v1/policy/registry');
const { postGenerationPolicyCheck } = require('../engine-writing-v1/policy');
const telemetry = require('../engine-writing-v1/telemetry');

process.env.WRITING_LAB_CONTEXT_SECRET ||= 'writing-lab-test-secret-with-enough-entropy';

function reviewInput(overrides = {}) {
  return {
    genre: 'review_blog',
    subtype: 'place_visit',
    answers: {
      subject: '원종동의 카페를 방문했어요.',
      spending: '총 30,000원을 결제했어요.',
      ...(overrides.answers || {})
    },
    targetChars: overrides.targetChars ?? 800,
    charLimitMode: overrides.charLimitMode || 'with_space',
    tone: overrides.tone || 'friendly'
  };
}

function structuredSentence(text, factRefs = ['F01', 'F02'], kind = 'fact') {
  return { paragraphs: [{ sentences: [{ text, kind, factRefs }] }], omittedFactIds: [], followupQuestions: [] };
}

test('v2 config exposes all four launch genres and guided fields', () => {
  const cfg = engine.config();
  assert.deepEqual(Object.keys(cfg.genres), ['resume', 'review_blog', 'marketing', 'general']);
  for (const genre of Object.values(cfg.genres)) {
    assert.ok(genre.subtypes.length >= 5);
    assert.ok(genre.fields.length >= 9);
    assert.ok(genre.fields.every(field => field.label && field.section && field.categories.length));
  }
});

test('sparse Wonjong-dong cafe input is LIMITED before any model call', () => {
  const prepared = engine.prepare(reviewInput());
  assert.equal(prepared.assessment.status, 'LIMITED');
  assert.equal(prepared.assessment.targetFeasible, false);
  assert.ok(prepared.assessment.feasibleRange.max < 800);
  assert.deepEqual(prepared.assessment.options, ['add_facts', 'write_short', 'cancel']);
  assert.match(prepared.assessment.summary, /짧은 최대 약/u);
  assert.deepEqual(prepared.assessment.missing.map(item => item.categories[0]), ['experience', 'evaluation']);
});

test('dense fact sets reach READY in every genre', () => {
  const cases = [
    {
      genre: 'resume', subtype: 'collaboration', targetChars: 400, answers: {
        prompt: '공동의 목표를 위해 협업하며 갈등을 조정한 경험을 600자 이내로 작성해 주세요.',
        company: '테스트 회사', role: '서비스 기획',
        situation: '4명이 참여한 수업 프로젝트에서 제출 일정을 관리했어요. 중간 점검 때 일정이 이틀 밀린 사실을 확인했어요.',
        goal: '정해진 마감일까지 결과물을 제출해야 했어요.',
        personalActions: '제가 남은 작업을 다시 목록으로 만들고 담당자별 완료 시간을 확인해 일정표를 수정했어요. 매일 저녁 진행 상황을 표에 반영했어요.',
        teamActions: '팀원들은 수정된 일정에 맞춰 각자 맡은 작업을 완료했어요.',
        result: '마감일 오후에 결과물을 제출했어요.',
        learning: '일정을 공유할 때 담당자와 확인 시점을 함께 적어야 실행 여부를 확인할 수 있다는 점을 배웠어요.'
      }
    },
    {
      genre: 'review_blog', subtype: 'place_visit', targetChars: 370, answers: {
        subject: '원종동 카페 모모를 방문했어요.', timing: '2026년 8월 23일 오후 2시', companions: '친구 1명과 방문',
        items: '아메리카노 2잔과 치즈케이크 1개를 주문했어요.', spending: '총 30,000원을 결제했어요.',
        observations: '입구 오른쪽에 주문대가 있었고 창가에 2인 좌석 네 개가 있었어요. 주문 후 음료가 나오기까지 8분 걸렸어요.',
        sequence: '주문한 뒤 창가 좌석에 앉았고 음료와 케이크를 함께 받았어요.',
        impressions: '커피는 산미가 강했고 케이크는 부드러웠어요. 오후 3시부터 대화 소리가 커진 점은 아쉬웠어요.',
        recommendation: '산미 있는 커피를 좋아하는 사람에게 맞고, 조용히 공부하려면 이른 시간이 낫겠다고 느꼈어요.', sponsorship: 'self_paid'
      }
    },
    {
      genre: 'marketing', subtype: 'service', targetChars: 440, answers: {
        product: '클래스체크는 소규모 학원이 학생 출결을 기록하는 웹 서비스예요.',
        audience: '종이 출석부를 사용하는 1인 학원 운영자가 수업 시작 전 사용해요.',
        problem: '수업별 출결 기록이 종이에 나뉘어 있어 지난 기록을 찾는 데 시간이 걸려요.',
        features: '학생 등록, 날짜별 출석·지각·결석 표시, 월별 기록 조회 기능을 제공해요.',
        process: '운영자가 로그인한 뒤 반을 만들고 학생을 등록하면 날짜별 상태를 선택할 수 있어요.',
        evidence: '2026년 8월 25일 기준 제공 기능은 세 가지이며 내부 기능 목록에서 확인했어요.',
        pricing: '베타 기간에는 관리자 승인을 받은 계정만 무료로 사용할 수 있어요.',
        limitations: '학부모 문자 발송과 결제 기능은 제공하지 않아요.', cta: '베타 사용 문의'
      }
    },
    {
      genre: 'general', subtype: 'notice', targetChars: 230, answers: {
        purpose: '동아리 신입 부원에게 첫 모임 일정을 안내하려고 해요.', audience: '가입을 완료한 신입 부원',
        keyMessage: '첫 모임은 9월 3일 오후 6시 30분에 학생회관 201호에서 열려요.',
        mustInclude: '참석 여부를 회신해야 하고 개인 노트북을 준비해야 해요.', dateTime: '2026년 9월 3일 오후 6시 30분',
        place: '학생회관 201호', participants: '가입을 완료한 신입 부원',
        readerAction: '9월 1일까지 단체 채팅방 설문에 참석 여부를 표시하고 개인 노트북을 가져와 주세요.',
        deadline: '2026년 9월 1일', closing: '문의는 동아리 회장에게 남겨 주세요.'
      }
    }
  ];
  for (const item of cases) {
    const prepared = engine.prepare(item);
    assert.equal(prepared.assessment.status, 'READY', `${item.genre}: ${prepared.assessment.summary}`);
    assert.equal(prepared.assessment.targetFeasible, true, item.genre);
  }
});

test('numeric AST preserves units and normalizes Korean money and dates', () => {
  const report = compareQuantities(
    '참여자는 3명이고 총 30,000원을 결제했다. 방문일은 2026-08-25다.',
    '참여자는 3억원 규모였고 총 3만원을 결제했다. 방문일은 2026년 8월 25일이다.'
  );
  assert.deepEqual(report.addedTokens, ['3억원']);
  assert.ok(extractQuantities('30,000원').some(item => item.canonical === 'money:30000:KRW'));
  assert.ok(extractQuantities('3만원').some(item => item.canonical === 'money:30000:KRW'));
  assert.ok(extractQuantities('1만8천원').some(item => item.canonical === 'money:18000:KRW'));
  assert.equal(compareQuantities('가격은 1만8천원', '가격은 18,000원').addedTokens.length, 0);
  assert.ok(extractQuantities('2026년 8월 25일').some(item => item.canonical === 'date:2026-08-25:date'));
  assert.equal(compareQuantities('2026. 8. 25. 오후 2시, 3명, 1kg, 1시간', '2026년 8월 25일 14시, 3인, 1000g, 60분').addedTokens.length, 0);
  assert.equal(compareQuantities('방문일은 2026년 8월 25일', '방문일은 8월 25일').addedTokens.length, 0);
  assert.deepEqual(compareQuantities('방문일은 8월 25일', '방문일은 2026년 8월 25일').addedTokens, ['2026년 8월 25일']);
  assert.equal(compareQuantities('총 3만원', '1인당 비용은 별도다. 총 3만원이다.').addedTokens.length, 0);
  assert.equal(compareQuantities('음료가 나오기까지 8분 걸렸어요.', '음료는 8분쯤 지나 나왔어요.').addedTokens.length, 0);
  assert.equal(compareQuantities('치킨 3인분을 주문했어요.', '주문 수량은 3인분이에요.').addedTokens.length, 0);
});

test('prepare blocks explicit conflicting totals and event dates before generation', () => {
  const review = engine.prepare(reviewInput({
    targetChars: 120,
    answers: {
      items: '메뉴 합계는 2만8천원이에요.',
      observations: '주문 내역을 직접 확인했어요.',
      impressions: '직접 이용한 내용만 적었어요.'
    }
  }));
  assert.equal(review.assessment.status, 'NEEDS_FACTS');
  assert.equal(review.assessment.conflicts[0].code, 'REVIEW_TOTAL_MISMATCH');

  const notice = engine.prepare({
    genre: 'general', subtype: 'notice', targetChars: 120,
    answers: {
      purpose: '첫 모임을 안내하려고 해요.',
      keyMessage: '첫 모임은 2026년 9월 3일에 열려요.',
      dateTime: '2026년 9월 4일 오후 6시',
      readerAction: '참석 여부를 알려 주세요.'
    }
  });
  assert.equal(notice.assessment.status, 'NEEDS_FACTS');
  assert.equal(notice.assessment.conflicts[0].code, 'GENERAL_EVENT_DATE_MISMATCH');
});

test('length contract distinguishes under, pass, and over', () => {
  assert.equal(limitCheck(charCounts('가'.repeat(87)), 100, 'with_space').status, 'under');
  assert.equal(limitCheck(charCounts('가'.repeat(88)), 100, 'with_space').status, 'pass');
  assert.equal(limitCheck(charCounts('가'.repeat(100)), 100, 'with_space').status, 'pass');
  assert.equal(limitCheck(charCounts('가'.repeat(101)), 100, 'with_space').status, 'over');
});

test('meta filler checker blocks information-absence essays', () => {
  const report = metaCheck('현재 기록에는 메뉴 정보가 없고 추가로 확인해야 합니다. 다음에는 기록해 두면 좋겠습니다.');
  assert.equal(report.pass, false);
  assert.ok(report.found.length >= 2);
});

test('policy packs detect medical boundary terms without the prior false positives', () => {
  const regulated = [
    '피부과 시술 후기', '치과 스케일링 후기', '정신과 진료 후기', '안과 진료 후기',
    '탈모약 복용 후기', '물리치료 후기', '마운자로 주사 후기', '도수치료 후기', '한의원 방문 후기', '라식 후기'
  ];
  const safe = ['웨이트리프팅 체육관 후기', '취업 클리닉 후기', '미용실 염색 시술 후기'];
  for (const subject of regulated) {
    const prepared = engine.prepare(reviewInput({ targetChars: 120, answers: { subject, observations: '직접 방문했어요.', impressions: '개인적인 이용 경험만 적었어요.' } }));
    assert.ok(prepared.policy.domains.includes('medical'), subject);
    assert.ok(['POLICY_REVIEW', 'POLICY_BLOCKED'].includes(prepared.assessment.status), subject);
  }
  for (const subject of safe) {
    const prepared = engine.prepare(reviewInput({ targetChars: 120, answers: { subject, observations: '직접 방문했어요.', impressions: '시설을 확인했어요.' } }));
    assert.equal(prepared.policy.domains.includes('medical'), false, subject);
  }
});

test('sponsorship is a typed fact and its disclosure is a hard final policy gate', () => {
  const prepared = engine.prepare(reviewInput({
    targetChars: 120,
    answers: {
      observations: '주문한 음료를 직접 받았어요.',
      impressions: '직접 마신 범위에서 맛을 기록했어요.',
      sponsorship: 'provided'
    }
  }));
  const sponsorship = prepared.ledger.facts.find(fact => fact.field === 'sponsorship');
  assert.equal(sponsorship.enumValue, 'provided');
  assert.equal(sponsorship.value, '상품·서비스를 제공받았어요');
  assert.equal(prepared.policy.status, 'MANUAL_REVIEW');
  assert.ok(prepared.policy.issues.some(issue => issue.code === 'ADVERTISING_POLICY_REVIEW_REQUIRED'));
  assert.equal(postGenerationPolicyCheck('원종동 카페를 방문했어요.', prepared.policy).pass, false);
  assert.equal(postGenerationPolicyCheck('원종동 카페를 방문했어요. 상품을 제공받아 작성했습니다.', prepared.policy).pass, true);

  const tampered = engine.prepare(reviewInput({ answers: { sponsorship: 'secret_paid_mode' } }));
  assert.equal(tampered.input.answers.sponsorship, '');
});

test('short mode produces a verified sparse review without meta filler', async () => {
  const sentence = '원종동의 카페를 방문했어요. 이번 방문에서 결제한 금액은 총 30,000원이었어요.';
  const result = await engine.generate(reviewInput(), {
    shortMode: true,
    callWriter: async () => structuredSentence(sentence),
    semanticVerify: async () => ({ pass: true, violations: [] })
  });
  assert.equal(result.release.pass, true);
  assert.equal(result.assessment.shortMode, true);
  assert.equal(result.checks.meta.pass, true);
  assert.equal(result.checks.numbers.pass, true);
  assert.ok(result.assessment.effectiveTarget <= result.assessment.feasibleRange.max);
});

test('generation repairs an unsupported number before release', async () => {
  let calls = 0;
  const unsafe = '원종동의 카페를 방문했어요. 이번 방문에서 결제한 전체 금액은 모두 3억원이었어요.';
  const safe = '원종동의 카페를 방문했어요. 이번 방문에서 결제한 금액은 총 30,000원이었어요.';
  const result = await engine.generate(reviewInput(), {
    shortMode: true,
    callWriter: async () => structuredSentence(++calls === 1 ? unsafe : safe),
    semanticVerify: async () => ({ pass: true, violations: [] })
  });
  assert.equal(calls, 2);
  assert.equal(result.release.pass, true);
  assert.equal(result.attempts[0].pass, false);
  assert.deepEqual(result.attempts[0].unsupportedNumbers, ['3억원']);
});

test('generation fails closed when semantic grounding fails twice', async () => {
  const sentence = '원종동의 카페를 방문했어요. 이번 방문에서 결제한 금액은 총 30,000원이었어요.';
  await assert.rejects(
    engine.generate(reviewInput(), {
      shortMode: true,
      callWriter: async () => structuredSentence(sentence),
      semanticVerify: async () => ({ pass: false, violations: [{ type: 'added_claim', span: '카페를 이용' }] }),
      deterministicProjection: false
    }),
    error => error.code === 'DRAFT_VERIFICATION_FAILED' && error.status === 422
  );
});

test('generation falls back to a deterministic verbatim projection when semantic judging fluctuates', async () => {
  const sentence = '원종동의 카페를 방문했어요. 이번 방문에서 결제한 금액은 총 30,000원이었어요.';
  const result = await engine.generate(reviewInput(), {
    shortMode: true,
    callWriter: async () => structuredSentence(sentence),
    semanticVerify: async () => ({ pass: false, violations: [{ type: 'distortion', span: '이번 방문에서' }] })
  });
  assert.equal(result.release.pass, true);
  assert.equal(result.semantic.deterministicProjection, true);
  assert.equal(result.semantic.proof, 'verbatim_fact_projection_v1');
  assert.equal(result.checks.length.pass, true);
  assert.equal(result.checks.numbers.pass, true);
  assert.equal(result.checks.meta.pass, true);
  assert.equal(result.attempts.at(-1).stage, 'deterministic_projection');
  assert.match(result.draft, /원종동의 카페를 방문했어요/);
  assert.match(result.draft, /30,000원/);
});

test('writer outage returns the deterministic projection instead of consuming a failed attempt', async () => {
  const result = await engine.generate(reviewInput(), {
    shortMode: true,
    callWriter: async () => { throw Object.assign(new Error('provider unavailable'), { code: 'PROVIDER_DOWN' }); },
    semanticVerify: async () => { throw new Error('projection must not call the semantic model'); }
  });
  assert.equal(result.release.pass, true);
  assert.equal(result.semantic.deterministicProjection, true);
  assert.equal(result.attempts[0].stage, 'writer_unavailable');
  assert.equal(result.attempts[0].errorCode, 'PROVIDER_DOWN');
  assert.equal(result.attempts.at(-1).stage, 'deterministic_projection');

  await assert.rejects(
    engine.generate(reviewInput(), {
      shortMode: true,
      deterministicProjection: false,
      callWriter: async () => { throw Object.assign(new Error('provider unavailable'), { code: 'PROVIDER_DOWN' }); }
    }),
    error => error.code === 'WRITER_UNAVAILABLE' && error.status === 502
  );
});

test('short-mode feasibility and deterministic recovery use the selected length unit', async () => {
  const cases = [
    ['with_space', 50, 60],
    ['no_space', 40, 48],
    ['byte2', 80, 96]
  ];
  for (const [mode, effectiveTarget, feasibleMaximum] of cases) {
    const input = reviewInput({ charLimitMode: mode });
    const prepared = engine.prepare(input);
    assert.equal(prepared.assessment.feasibleRange.max, feasibleMaximum);
    const result = await engine.generate(input, {
      shortMode: true,
      callWriter: async () => { throw Object.assign(new Error('provider unavailable'), { code: 'PROVIDER_DOWN' }); }
    });
    assert.equal(result.assessment.effectiveTarget, effectiveTarget);
    assert.equal(result.checks.length.mode, mode);
    assert.equal(result.checks.length.pass, true);
    assert.equal(result.semantic.deterministicProjection, true);
  }
});

test('generation can use a second repair and keeps strict release checks', async () => {
  let calls = 0;
  const short = '원종동 카페를 방문했고 총 3만원을 결제했어요.';
  const safe = '원종동의 카페를 방문했어요. 이번 방문에서 결제한 금액은 총 30,000원이었어요.';
  const result = await engine.generate(reviewInput(), {
    shortMode: true,
    maximumAttempts: 3,
    callWriter: async () => structuredSentence(++calls < 3 ? short : safe),
    semanticVerify: async () => ({ pass: true, violations: [] })
  });
  assert.equal(calls, 3);
  assert.equal(result.release.pass, true);
  assert.equal(result.attempts.length, 3);
});

test('generation uses the existing semantic repair engine before rewriting the whole draft', async () => {
  let writerCalls = 0;
  let repairCalls = 0;
  let judgeCalls = 0;
  const unsafe = '원종동의 카페를 방문했어요. 카페 이용 후 결제한 전체 금액은 총 3만원이었어요.';
  const safe = '원종동의 카페를 방문했어요. 해당 방문에서 결제한 전체 금액은 총 3만원이었어요.';
  const result = await engine.generate(reviewInput(), {
    shortMode: true,
    callWriter: async () => { writerCalls += 1; return structuredSentence(unsafe); },
    semanticVerify: async ({ text }) => {
      judgeCalls += 1;
      return text.includes('이용 후')
        ? { pass: false, violations: [{ type: 'added_claim', span: '이용 후', detail: '순서가 추가됐어요.', spanVerified: true }] }
        : { pass: true, violations: [] };
    },
    semanticRepair: async () => { repairCalls += 1; return safe; }
  });
  assert.equal(writerCalls, 1);
  assert.equal(repairCalls, 1);
  assert.equal(judgeCalls, 3);
  assert.equal(result.release.pass, true);
  assert.equal(result.attempts.at(-1).stage, 'semantic_repair_1_1');
});

test('generation requires a second semantic pass and repairs a confirmation-only violation', async () => {
  const candidate = '원종동의 카페를 방문했어요. 해당 방문에서 결제한 전체 금액은 총 3만원이었어요.';
  let judgeCalls = 0;
  let repairCalls = 0;
  const result = await engine.generate(reviewInput(), {
    shortMode: true,
    callWriter: async () => structuredSentence(candidate),
    semanticVerify: async () => {
      judgeCalls += 1;
      if (judgeCalls === 2) return { pass: false, violations: [{ type: 'distortion', span: '해당 방문에서', detail: '확인 판정 변동', spanVerified: true }] };
      return { pass: true, violations: [] };
    },
    semanticRepair: async () => { repairCalls += 1; return candidate.replace('해당 방문에서', '이번 방문에서'); }
  });
  assert.equal(repairCalls, 1);
  assert.equal(judgeCalls, 4);
  assert.equal(result.release.pass, true);
  assert.equal(result.semantic.confirmations, 2);
});

test('finalization repairs a humanized draft inside the signed fact context', async () => {
  const prepared = engine.prepare(reviewInput({ targetChars: 60 }));
  const safe = '원종동의 한 카페를 방문해 카페를 이용했으며, 해당 방문에서 결제한 전체 금액은 모두 합해 3만원이었어요.';
  const unsafe = '원종동의 한 카페를 방문해 카페를 이용했으며, 이용 후 결제한 전체 금액은 모두 합해 3만원이었어요.';
  const context = {
    input: prepared.input, ledger: prepared.ledger, policy: prepared.policy,
    usedFactIds: prepared.ledger.facts.map(fact => fact.id), targetChars: 60, safeDraft: safe
  };
  const result = await engine.finalizeExisting(unsafe, context, {
    semanticVerify: async ({ text }) => text.includes('이용 후')
      ? { pass: false, violations: [{ type: 'experience_novelty', span: '이용 후', detail: '순서가 추가됐어요.', spanVerified: true }] }
      : { pass: true, violations: [] },
    semanticRepair: async ({ violations }) => {
      assert.equal(violations[0].span, '이용 후');
      return safe;
    }
  });
  assert.equal(result.release.pass, true);
  assert.equal(result.text, safe);
  assert.equal(result.delivery.source, 'humanized_repaired');
  assert.equal(result.delivery.repairRounds, 1);
});

test('finalization repairs length drift and falls back to the verified generation when repair cannot pass', async () => {
  const prepared = engine.prepare(reviewInput({ targetChars: 60 }));
  const safe = '원종동의 한 카페를 방문해 카페를 이용했으며, 해당 방문에서 결제한 전체 금액은 모두 합해 3만원이었어요.';
  const tooShort = '원종동 카페를 방문했고 총 3만원을 결제했어요.';
  const context = {
    input: prepared.input, ledger: prepared.ledger, policy: prepared.policy,
    usedFactIds: prepared.ledger.facts.map(fact => fact.id), targetChars: 60, safeDraft: safe
  };
  let sawLengthViolation = false;
  const repaired = await engine.finalizeExisting(tooShort, context, {
    semanticVerify: async () => ({ pass: true, violations: [] }),
    semanticRepair: async ({ violations }) => {
      sawLengthViolation = violations.some(item => item.type === 'length_under');
      return safe;
    }
  });
  assert.equal(sawLengthViolation, true);
  assert.equal(repaired.delivery.source, 'humanized_repaired');

  const fallback = await engine.finalizeExisting(tooShort, context, {
    semanticVerify: async () => ({ pass: true, violations: [] }),
    semanticRepair: async () => tooShort
  });
  assert.equal(fallback.release.pass, true);
  assert.equal(fallback.text, safe);
  assert.equal(fallback.delivery.source, 'verified_generation_fallback');
  assert.equal(fallback.rejectedReport.release.pass, false);
});

test('finalization falls back to the signed safe draft when the repair provider is unavailable', async () => {
  const prepared = engine.prepare(reviewInput({ targetChars: 60 }));
  const safe = '원종동의 한 카페를 방문해 카페를 이용했으며, 해당 방문에서 결제한 전체 금액은 모두 합해 3만원이었어요.';
  const context = {
    input: prepared.input, ledger: prepared.ledger, policy: prepared.policy,
    usedFactIds: prepared.ledger.facts.map(fact => fact.id), targetChars: 60,
    safeDraft: safe, safeDraftRelease: 'deterministic_projection_v1'
  };
  const result = await engine.finalizeExisting('원종동 카페를 방문했고 총 3만원을 결제했어요.', context, {
    semanticVerify: async () => ({ pass: false, error: 'provider unavailable', violations: [] }),
    semanticRepair: async () => { throw Object.assign(new Error('provider unavailable'), { code: 'PROVIDER_DOWN' }); }
  });
  assert.equal(result.release.pass, true);
  assert.equal(result.text, safe);
  assert.equal(result.delivery.source, 'verified_generation_fallback');
  assert.equal(result.attempts.some(item => item.stage === 'repair_1_unavailable'), true);
});

test('an unchanged signed safe draft is stable without rerunning a nondeterministic semantic judge', async () => {
  const prepared = engine.prepare(reviewInput({ targetChars: 60 }));
  const safe = '원종동의 한 카페를 방문해 카페를 이용했으며, 해당 방문에서 결제한 전체 금액은 모두 합해 3만원이었어요.';
  let judgeCalls = 0;
  const report = await engine.verifyExisting(safe, {
    input: prepared.input, ledger: prepared.ledger, policy: prepared.policy,
    usedFactIds: prepared.ledger.facts.map(fact => fact.id), targetChars: 60,
    safeDraft: safe, safeDraftRelease: 'semantic_consensus_v1'
  }, { semanticVerify: async () => { judgeCalls += 1; return { pass: false, violations: [] }; } });
  assert.equal(judgeCalls, 0);
  assert.equal(report.release.pass, true);
  assert.equal(report.semantic.signedSafeDraft, true);
});

test('signed verification context detects tampering and expiry', () => {
  const token = signContext({ uid: 'user-1', value: '원종동' }, { ttlMs: 1000 });
  assert.equal(verifyContext(token).ok, true);
  assert.equal(verifyContext(token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a')).ok, false);
  const expired = signContext({ uid: 'user-1' }, { ttlMs: -1 });
  assert.equal(verifyContext(expired).code, 'CONTEXT_TOKEN_EXPIRED');
});

test('successful usage counts only committed unique READY requests', async () => {
  usage.resetMemoryForTests();
  assert.equal(await usage.successfulCount('usage-user'), 0);
  assert.deepEqual(await usage.commitSuccessful('usage-user', 'ready-1', 2), { committed: true, count: 1 });
  assert.equal((await usage.commitSuccessful('usage-user', 'ready-1', 2)).duplicate, true);
  assert.deepEqual(await usage.commitSuccessful('usage-user', 'ready-2', 2), { committed: true, count: 2 });
  assert.equal((await usage.commitSuccessful('usage-user', 'ready-3', 2)).capReached, true);
  assert.equal(await usage.successfulCount('usage-user'), 2);
});

test('note extractor keeps only exact-evidence candidates and leaves confirmation to the user', async () => {
  const source = '원종동 모모카페에서 아메리카노를 마셨고 총 3만원을 직접 결제했어요.';
  const result = await extractCandidates({ genre: 'review_blog', notes: source }, {
    callExtractor: async () => ({ candidates: [
      { fieldKey: 'subject', value: '원종동 모모카페 방문', evidence: '원종동 모모카페' },
      { fieldKey: 'spending', value: '총 3만원을 직접 결제했어요.', evidence: '총 3만원을 직접 결제했어요.' },
      { fieldKey: 'observations', value: '조용한 매장이었어요.', evidence: '조용한 매장' },
      { fieldKey: 'unknownField', value: '무시', evidence: '아메리카노' },
      { fieldKey: 'sponsorship', value: 'self_paid', evidence: '직접 결제했어요' }
    ] })
  });
  assert.deepEqual(result.candidates.map(item => item.fieldKey), ['subject', 'spending', 'sponsorship']);
  assert.equal(result.candidates.every(item => item.confirmed === false), true);
  assert.equal(result.candidates[2].valueLabel, '직접 결제했어요');
});

test('idempotent writing jobs return one READY result and reject request-id reuse with other input', async () => {
  jobs.resetMemoryForTests();
  const id = 'wlv2_1234567890abcdef';
  assert.equal((await jobs.begin('job-user', id, 'hash-a')).state, 'NEW');
  assert.equal((await jobs.begin('job-user', id, 'hash-a')).state, 'PROCESSING');
  await jobs.complete('job-user', id, 'hash-a', { ok: true, status: 'READY', draft: '검증된 글' });
  const ready = await jobs.get('job-user', id);
  assert.equal(ready.state, 'READY');
  assert.equal(ready.result.draft, '검증된 글');
  assert.equal((await jobs.begin('job-user', id, 'hash-a')).state, 'READY');
  assert.equal((await jobs.begin('job-user', id, 'hash-b')).state, 'MISMATCH');
});

test('failed idempotent job can retry with the same key without becoming READY', async () => {
  jobs.resetMemoryForTests();
  const id = 'wlv2_retry_1234567890';
  assert.equal((await jobs.begin('retry-user', id, 'hash-a')).state, 'NEW');
  await jobs.fail('retry-user', id, 'hash-a', Object.assign(new Error('temporary'), { code: 'TEMP', status: 503 }));
  const failed = await jobs.get('retry-user', id);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.error.retryable, true);
  assert.equal((await jobs.begin('retry-user', id, 'hash-a')).state, 'NEW');
});

test('policy registry exposes versioned approval state and valid pack contracts', () => {
  const registry = registrySnapshot();
  assert.equal(registry.version, 'writing-policy-registry-v1');
  assert.deepEqual(registry.packs.map(pack => pack.domain), ['medical', 'legal', 'finance', 'advertising']);
  assert.equal(registry.packs.every(pack => pack.validation.valid), true);
  assert.ok(registry.pendingDomains.includes('medical'));
  assert.equal(validatePack({}).valid, false);
});

test('telemetry records only bounded counters and latency buckets without user text', async () => {
  telemetry.resetMemoryForTests();
  assert.equal((await telemetry.record('GENERATE_READY', { genre: 'review_blog', policyStatus: 'ALLOW', elapsedMs: 32000, text: '저장하면 안 되는 원문' })).recorded, true);
  assert.equal((await telemetry.record('GENERATE_FALLBACK_READY', { genre: 'review_blog', policyStatus: 'ALLOW', elapsedMs: 90 })).recorded, true);
  assert.equal((await telemetry.record('UNKNOWN_EVENT', { genre: 'review_blog' })).recorded, false);
  const rows = await telemetry.snapshot(14);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].events.GENERATE_READY, 1);
  assert.equal(rows[0].events.GENERATE_FALLBACK_READY, 1);
  assert.equal(rows[0].latencyBuckets.lte45s, 1);
  assert.equal(JSON.stringify(rows).includes('저장하면 안 되는 원문'), false);
});
