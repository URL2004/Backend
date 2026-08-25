'use strict';

// 실제 OpenAI + Writing Lab v2 + 기존 휴머나이징 엔진의 출시 전 통합 점검.
// 인증·API 키는 이미 실행 중인 로컬 서버가 담당하며 이 스크립트는 토큰을 결과 파일에 남기지 않는다.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const baseUrl = String(process.env.WRITING_LAB_TEST_BASE_URL || 'http://127.0.0.1:3101').replace(/\/$/u, '');
const humanizeBaseUrl = String(process.env.WRITING_LAB_HUMANIZE_BASE_URL || baseUrl).replace(/\/$/u, '');
const finalizeBaseUrl = String(process.env.WRITING_LAB_FINALIZE_BASE_URL || baseUrl).replace(/\/$/u, '');
const outputPath = process.argv[2] ? path.resolve(process.argv[2]) : null;

const denseCases = [
  {
    id: 'resume_dense',
    input: {
      genre: 'resume', subtype: 'collaboration', targetChars: 400, charLimitMode: 'with_space', tone: 'formal',
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
    }
  },
  {
    id: 'review_dense',
    input: {
      genre: 'review_blog', subtype: 'place_visit', targetChars: 370, charLimitMode: 'with_space', tone: 'friendly',
      answers: {
        subject: '원종동 카페 모모를 방문했어요.', timing: '2026년 8월 23일 오후 2시', companions: '친구 1명과 방문',
        items: '아메리카노 2잔과 치즈케이크 1개를 주문했어요.', spending: '총 30,000원을 결제했어요.',
        observations: '입구 오른쪽에 주문대가 있었고 창가에 2인 좌석 네 개가 있었어요. 주문 후 음료가 나오기까지 8분 걸렸어요.',
        sequence: '주문한 뒤 창가 좌석에 앉았고 음료와 케이크를 함께 받았어요.',
        impressions: '커피는 산미가 강했고 케이크는 부드러웠어요. 오후 3시부터 대화 소리가 커진 점은 아쉬웠어요.',
        recommendation: '산미 있는 커피를 좋아하는 사람에게 맞고, 조용히 공부하려면 이른 시간이 낫겠다고 느꼈어요.',
        sponsorship: 'self_paid'
      }
    }
  },
  {
    id: 'marketing_dense',
    input: {
      genre: 'marketing', subtype: 'service', targetChars: 440, charLimitMode: 'with_space', tone: 'friendly',
      answers: {
        product: '클래스체크는 소규모 학원이 학생 출결을 기록하는 웹 서비스예요.',
        audience: '종이 출석부를 사용하는 1인 학원 운영자가 수업 시작 전 사용해요.',
        problem: '수업별 출결 기록이 종이에 나뉘어 있어 지난 기록을 찾는 데 시간이 걸려요.',
        features: '학생 등록, 날짜별 출석·지각·결석 표시, 월별 기록 조회 기능을 제공해요.',
        process: '운영자가 로그인한 뒤 반을 만들고 학생을 등록하면 날짜별 상태를 선택할 수 있어요.',
        evidence: '2026년 8월 25일 기준 제공 기능은 세 가지이며 내부 기능 목록에서 확인했어요.',
        pricing: '베타 기간에는 관리자 승인을 받은 계정만 무료로 사용할 수 있어요.',
        limitations: '학부모 문자 발송과 결제 기능은 제공하지 않아요.', cta: '베타 사용 문의', industry: '교육'
      }
    }
  },
  {
    id: 'general_dense',
    input: {
      genre: 'general', subtype: 'notice', targetChars: 230, charLimitMode: 'with_space', tone: 'formal',
      answers: {
        purpose: '동아리 신입 부원에게 첫 모임 일정을 안내하려고 해요.', audience: '가입을 완료한 신입 부원',
        keyMessage: '첫 모임은 9월 3일 오후 6시 30분에 학생회관 201호에서 열려요.',
        mustInclude: '참석 여부를 회신해야 하고 개인 노트북을 준비해야 해요.', dateTime: '2026년 9월 3일 오후 6시 30분',
        place: '학생회관 201호', participants: '가입을 완료한 신입 부원',
        readerAction: '9월 1일까지 단체 채팅방 설문에 참석 여부를 표시하고 개인 노트북을 가져와 주세요.',
        deadline: '2026년 9월 1일', closing: '문의는 동아리 회장에게 남겨 주세요.'
      }
    }
  }
];

const sparseInput = {
  genre: 'review_blog', subtype: 'place_visit', targetChars: 800, charLimitMode: 'with_space', tone: 'friendly',
  answers: { subject: '원종동의 카페를 방문했어요.', spending: '총 30,000원을 결제했어요.' }
};

async function requestAt(origin, pathname, options = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: response.status, data };
}

async function request(pathname, options = {}) {
  return requestAt(baseUrl, pathname, options);
}

async function prepare(input) {
  return request('/writing-lab/v2/prepare', { method: 'POST', body: JSON.stringify(input) });
}

async function generate(input, assessmentToken, { shortMode = false, requestId = crypto.randomUUID() } = {}) {
  return request('/writing-lab/v2/generate', {
    method: 'POST',
    body: JSON.stringify({ ...input, assessmentToken, requestId, shortMode })
  });
}

async function generateWithRecovery(input, assessmentToken, options = {}) {
  const requestId = options.requestId || crypto.randomUUID();
  const apiAttempts = [];
  let response = null;
  for (let index = 0; index < 2; index += 1) {
    response = await generate(input, assessmentToken, { ...options, requestId });
    apiAttempts.push({ httpStatus: response.status, code: response.data?.code || '', releasePass: response.data?.release?.pass === true });
    if (response.status === 200 || ![422, 502, 503, 504].includes(response.status)) break;
  }
  return { ...response, requestId, apiAttempts };
}

function publicGeneration(data) {
  return {
    ok: data.ok,
    status: data.status,
    code: data.code,
    error: data.error,
    details: data.details,
    requestId: data.requestId,
    genre: data.genre,
    subtype: data.subtype,
    draft: data.draft,
    draftLength: Array.from(data.draft || '').length,
    release: data.release,
    checks: data.checks,
    semantic: data.semantic,
    attempts: data.attempts,
    assessment: data.assessment,
    policy: data.policy,
    usedFacts: data.usedFacts,
    followupQuestions: data.followupQuestions,
    humanize: data.humanize,
    billing: data.billing,
    usage: data.usage
  };
}

async function pollTransform(jobId) {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const response = await requestAt(humanizeBaseUrl, `/transform/${encodeURIComponent(jobId)}`, { method: 'GET' });
    const status = response.data?.status;
    if (status === 'done') return response;
    if (['blocked', 'error', 'cancelled'].includes(status) || response.status >= 400) return response;
  }
  return { status: 408, data: { status: 'timeout', error: '30 minute transform timeout' } };
}

async function humanizeAndCheck(generation) {
  const startedAt = Date.now();
  const transformMode = ['resume', 'general'].includes(generation.genre) ? 'polish' : 'blog';
  const finalize = text => requestAt(finalizeBaseUrl, '/writing-lab/v2/finalize', {
    method: 'POST',
    body: JSON.stringify({ text, verificationToken: generation.verificationToken })
  });
  const safeFallback = async (transformState, error, status = 0) => {
    const checked = await finalize(generation.draft);
    const deliveredText = checked.data?.text || '';
    return {
      startStatus: status,
      state: checked.data?.release?.pass === true ? 'done' : transformState,
      transformState,
      transformMode,
      error,
      finalCheckStatus: checked.status,
      finalRelease: checked.data?.release || null,
      finalChecks: checked.data?.checks || null,
      deliveredText,
      deliveredLength: Array.from(deliveredText).length,
      delivery: checked.data?.release?.pass === true
        ? { ...(checked.data?.delivery || {}), source: 'verified_generation_fallback', fallbackUsed: true }
        : checked.data?.delivery || null,
      finalizationAttempts: checked.data?.attempts || [],
      elapsedMs: Date.now() - startedAt
    };
  };
  const start = await requestAt(humanizeBaseUrl, '/transform', {
    method: 'POST',
    body: JSON.stringify({
      text: generation.draft,
      mode: transformMode,
      basicStyle: generation.humanize?.basicStyle || 'report',
      memo: [
        '아래 사실 원장의 범위만 사용하세요. 새 사실·행동·순서·수치·평가를 만들지 말고 원래 분량을 유지하세요.',
        String(generation.factsheet || '')
      ].join('\n').slice(0, 2000),
      documentProfile: generation.humanize?.documentProfile || '',
      lang: 'ko', evidence: false, length: 'keep', effectNoticeAccepted: true,
      adminHumanizeLab: true, adminLabProfile: 'gpt_engine', humanizeExperiment: true
    })
  });
  if (start.status !== 200 || !start.data?.jobId) {
    return safeFallback('start_failed', start.data?.error || start.data?.code, start.status);
  }
  const completed = await pollTransform(start.data.jobId);
  const outputText = completed.data?.result?.outputText || '';
  if (completed.data?.status !== 'done' || !outputText) {
    const fallback = await safeFallback(completed.data?.status || 'failed', completed.data?.error || completed.data?.reason, start.status);
    return { ...fallback, pollStatus: completed.status };
  }
  const finalCheck = await finalize(outputText);
  const deliveredText = finalCheck.data?.text || '';
  return {
    startStatus: start.status,
    pollStatus: completed.status,
    state: completed.data.status,
    transformMode,
    outputText,
    outputLength: Array.from(outputText).length,
    engineVersion: completed.data?.result?.engineVersion || completed.data?.engineVersion || '',
    qualityWarning: completed.data?.result?.qualityWarning || null,
    finalCheckStatus: finalCheck.status,
    humanizedRelease: finalCheck.data?.attempts?.[0] || null,
    finalRelease: finalCheck.data?.release || null,
    finalChecks: finalCheck.data?.checks || null,
    deliveredText,
    deliveredLength: Array.from(deliveredText).length,
    delivery: finalCheck.data?.delivery || null,
    finalizationAttempts: finalCheck.data?.attempts || [],
    elapsedMs: Date.now() - startedAt
  };
}

async function run() {
  const report = {
    version: 'writing-lab-live-smoke-v1',
    startedAt: new Date().toISOString(),
    baseUrl,
    humanizeBaseUrl,
    finalizeBaseUrl,
    environment: 'local-dev-no-auth-with-real-openai',
    assertions: [],
    negativeCases: [],
    generations: [],
    humanizing: []
  };

  const config = await request('/writing-lab/v2/config');
  report.config = {
    status: config.status,
    engineVersion: config.data?.version,
    genres: Object.keys(config.data?.genres || {}),
    rollout: config.data?.rollout,
    lengthContract: config.data?.lengthContract
  };
  report.assertions.push({ name: 'config_available', pass: config.status === 200 && report.config.genres.length === 4 });

  const sparsePrepared = await prepare(sparseInput);
  report.negativeCases.push({
    id: 'sparse_preflight', httpStatus: sparsePrepared.status,
    assessment: sparsePrepared.data?.assessment, policy: sparsePrepared.data?.policy
  });
  report.assertions.push({ name: 'sparse_is_limited', pass: sparsePrepared.data?.assessment?.status === 'LIMITED' });

  const sparseFull = await generate(sparseInput, sparsePrepared.data?.assessmentToken, { shortMode: false });
  report.negativeCases.push({ id: 'sparse_without_consent', httpStatus: sparseFull.status, code: sparseFull.data?.code, error: sparseFull.data?.error });
  report.assertions.push({ name: 'sparse_requires_short_choice', pass: sparseFull.status === 409 && sparseFull.data?.code === 'SHORT_MODE_CONFIRMATION_REQUIRED' });

  const sparseRequestId = crypto.randomUUID();
  const sparseGenerated = await generateWithRecovery(sparseInput, sparsePrepared.data?.assessmentToken, { shortMode: true, requestId: sparseRequestId });
  report.generations.push({ id: 'review_sparse_short', input: sparseInput, httpStatus: sparseGenerated.status, apiAttempts: sparseGenerated.apiAttempts, ...publicGeneration(sparseGenerated.data || {}) });
  report.assertions.push({ name: 'sparse_short_released', pass: sparseGenerated.status === 200 && sparseGenerated.data?.release?.pass === true });

  const replay = await generate(sparseInput, sparsePrepared.data?.assessmentToken, { shortMode: true, requestId: sparseRequestId });
  report.negativeCases.push({
    id: 'idempotent_replay', httpStatus: replay.status,
    sameDraft: replay.data?.draft === sparseGenerated.data?.draft,
    sameRequestId: replay.data?.requestId === sparseGenerated.data?.requestId
  });
  report.assertions.push({ name: 'idempotent_replay_same_result', pass: replay.status === 200 && replay.data?.draft === sparseGenerated.data?.draft });

  for (const scenario of denseCases) {
    const prepared = await prepare(scenario.input);
    report.assertions.push({ name: `${scenario.id}_ready`, pass: prepared.status === 200 && prepared.data?.assessment?.status === 'READY' });
    const generated = await generateWithRecovery(scenario.input, prepared.data?.assessmentToken);
    const record = { id: scenario.id, input: scenario.input, prepareStatus: prepared.status, httpStatus: generated.status, apiAttempts: generated.apiAttempts, ...publicGeneration(generated.data || {}) };
    report.generations.push(record);
    report.assertions.push({ name: `${scenario.id}_released`, pass: generated.status === 200 && generated.data?.release?.pass === true });
    if (generated.status === 200 && generated.data?.verificationToken) {
      const final = await request('/writing-lab/v2/check', {
        method: 'POST', body: JSON.stringify({ text: generated.data.draft, verificationToken: generated.data.verificationToken })
      });
      record.directFinalCheck = { httpStatus: final.status, release: final.data?.release, checks: final.data?.checks, semantic: final.data?.semantic };
      report.assertions.push({ name: `${scenario.id}_direct_final_check`, pass: final.status === 200 && final.data?.release?.pass === true });
    }
    record._verificationToken = generated.data?.verificationToken || '';
    record._factsheet = generated.data?.factsheet || '';
  }

  const reviewRecord = report.generations.find(item => item.id === 'review_dense');
  if (reviewRecord?._verificationToken) {
    const tamperedText = String(reviewRecord.draft || '').replace(/(?:30,000\s*원|3만\s*원)/u, '3억원');
    const numberTamper = await request('/writing-lab/v2/check', {
      method: 'POST', body: JSON.stringify({ text: tamperedText, verificationToken: reviewRecord._verificationToken })
    });
    report.negativeCases.push({
      id: 'number_unit_tamper', httpStatus: numberTamper.status,
      release: numberTamper.data?.release, addedTokens: numberTamper.data?.checks?.numbers?.addedTokens
    });
    report.assertions.push({
      name: 'person_or_money_unit_tamper_blocked',
      pass: numberTamper.status === 200 && numberTamper.data?.release?.pass === false && numberTamper.data?.checks?.numbers?.addedTokens?.includes('3억원')
    });
  }

  const medical = await prepare({
    genre: 'review_blog', subtype: 'service_use', targetChars: 120,
    answers: { subject: '피부과 시술 후기', observations: '직접 방문해 접수했어요.', impressions: '개인적인 이용 경험만 적었어요.' }
  });
  report.negativeCases.push({ id: 'medical_policy_owner_gate', httpStatus: medical.status, assessment: medical.data?.assessment, policy: medical.data?.policy });
  report.assertions.push({ name: 'medical_requires_policy_review', pass: medical.data?.assessment?.status === 'POLICY_REVIEW' });

  const sponsored = await prepare({
    genre: 'review_blog', subtype: 'product_use', targetChars: 120,
    answers: { subject: '텀블러 사용 후기', observations: '뚜껑을 열고 닫아 직접 사용했어요.', impressions: '손잡이를 잡기 편했어요.', sponsorship: 'provided' }
  });
  report.negativeCases.push({ id: 'advertising_policy_owner_gate', httpStatus: sponsored.status, assessment: sponsored.data?.assessment, policy: sponsored.data?.policy });
  report.assertions.push({ name: 'advertising_requires_policy_review', pass: sponsored.data?.assessment?.status === 'POLICY_REVIEW' });

  const conflict = await prepare({
    genre: 'review_blog', subtype: 'place_visit', targetChars: 120,
    answers: {
      subject: '원종동 카페를 방문했어요.', items: '메뉴별 합계는 28,000원이었어요.', spending: '총 30,000원을 결제했어요.',
      observations: '영수증을 직접 확인했어요.', impressions: '직접 이용한 범위만 기록했어요.'
    }
  });
  report.negativeCases.push({ id: 'conflicting_total', httpStatus: conflict.status, assessment: conflict.data?.assessment });
  report.assertions.push({ name: 'conflict_requires_correction', pass: conflict.data?.assessment?.status === 'NEEDS_FACTS' });

  const readyForTamper = await prepare(denseCases[3].input);
  const token = String(readyForTamper.data?.assessmentToken || '');
  const tamperedToken = token ? `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}` : '';
  const rejectedToken = await generate(denseCases[3].input, tamperedToken);
  report.negativeCases.push({ id: 'tampered_assessment_token', httpStatus: rejectedToken.status, code: rejectedToken.data?.code });
  report.assertions.push({ name: 'tampered_assessment_rejected', pass: rejectedToken.status === 400 });

  // 대표적인 두 문체를 실제 기존 휴머나이징 엔진에 연결하고 같은 원장으로 다시 검사한다.
  for (const id of ['resume_dense', 'review_dense']) {
    const stored = report.generations.find(item => item.id === id);
    if (!stored?._verificationToken || !stored?.draft) continue;
    const generation = {
      genre: stored.genre,
      draft: stored.draft,
      factsheet: stored._factsheet,
      humanize: stored.humanize,
      verificationToken: stored._verificationToken,
      release: stored.release
    };
    const humanized = await humanizeAndCheck(generation);
    report.humanizing.push({ id, ...humanized });
    report.assertions.push({ name: `${id}_humanize_chain_delivered`, pass: humanized.state === 'done' && humanized.delivery?.releasePass === true });
  }

  for (const generation of report.generations) {
    delete generation._verificationToken;
    delete generation._factsheet;
  }
  report.finishedAt = new Date().toISOString();
  report.summary = {
    assertionCount: report.assertions.length,
    passed: report.assertions.filter(item => item.pass).length,
    failed: report.assertions.filter(item => !item.pass).map(item => item.name),
    releasedGenerations: report.generations.filter(item => item.release?.pass).length,
    generationCount: report.generations.length,
    humanizedDirectlyPassed: report.humanizing.filter(item => item.humanizedRelease?.pass).length,
    humanizedRepaired: report.humanizing.filter(item => item.delivery?.source === 'humanized_repaired').length,
    humanizeFallbacks: report.humanizing.filter(item => item.delivery?.source === 'verified_generation_fallback').length,
    humanizeChainsDelivered: report.humanizing.filter(item => item.delivery?.releasePass).length,
    humanizeChainCount: report.humanizing.length
  };

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, json, 'utf8');
  }
  process.stdout.write(JSON.stringify(report.summary));
  if (report.summary.failed.length) process.exitCode = 1;
}

run().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
