'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fingerprint = require('../engine-gpt-prod/fingerprintAudit');
const STYLE_FLAG = 'GPT_FINGERPRINT_EXPANDED_LIMITATIVE_STYLE';
let previousStyleFlag;
test.beforeEach(() => {
  previousStyleFlag = process.env[STYLE_FLAG];
  delete process.env[STYLE_FLAG];
});
test.afterEach(() => {
  if (previousStyleFlag === undefined) delete process.env[STYLE_FLAG];
  else process.env[STYLE_FLAG] = previousStyleFlag;
});

// 2026-10-09 점검(F-04): 상투구 감시가 엔진의 실제 출력 형태("~는 데 그치지 않고",
// "~에 그치지 않는다", "머물지 않고", "한정되지 않는다")를 잡지 못했고,
// "A가 아니라 B"→"A에 그치지 않고 B" 반전 검출도 같은 좁은 정규식을 썼다.

function family(report) {
  return report.families.find(item => item.code === 'limitative_additive');
}

test('스위치를 켜면 그치지·머물지·한정되지 실제 출력 형태를 모두 감사한다', () => {
  process.env[STYLE_FLAG] = '1';
  const output = [
    '감염 자체에 그치지 않고 가족의 생활까지 흔든다.',
    '기능을 구현하는 데 그치지 않고 운영까지 맡았다.',
    '신고체계는 행정절차에 한정되지 않는다.',
    '이 책의 쓰임은 교양서에 머물지 않고 실무서로도 읽힌다.',
    '관리자의 책임은 성과에만 한정되지 않습니다.',
    '평가는 수치를 보는 데서 끝나지 않고 면담으로 이어진다.'
  ].join(' ');
  const report = fingerprint.auditFingerprint('', output, 'general');
  assert.equal(family(report).outputCount, 6, JSON.stringify(family(report)));

  // 조사·의존명사 없이 문자 그대로 쓰인 머물다·끝나다는 세지 않는다.
  const literal = '우리는 그곳에 오래 머물지 않았다. 전쟁이 끝나지 않고 이어졌다.';
  assert.equal(family(fingerprint.auditFingerprint('', literal, 'general')).outputCount, 0);
});

test('스위치를 켜면 X1의 일반·전문 문서 상투구 허용량을 적용한다', () => {
  process.env[STYLE_FLAG] = '1';
  const source = '감염은 가족의 생활까지 흔든다. 기능 구현뿐 아니라 운영도 맡았다.';
  const output = '감염 자체에 그치지 않고 가족의 생활까지 흔든다. 기능을 구현하는 데 그치지 않고 운영까지 맡았다.';
  const general = fingerprint.auditFingerprint(source, output, 'general');
  assert.equal(family(general).introducedCount, 2);
  assert.equal(family(general).excessIntroducedCount, 1);
  assert.ok(general.issueCodes.includes('engine_phrase_fingerprint'));

  const single = fingerprint.auditFingerprint(source, '감염 자체에 그치지 않고 가족의 생활까지 흔든다. 기능 구현뿐 아니라 운영도 맡았다.', 'general');
  assert.equal(single.pass, true, JSON.stringify(single.violations));

  const report = fingerprint.auditFingerprint(source, '감염 자체에 그치지 않고 가족의 생활까지 흔든다. 기능 구현뿐 아니라 운영도 맡았다.', 'report_assignment');
  assert.equal(family(report).allowedIntroducedCount, 0);
  assert.ok(report.issueCodes.includes('engine_phrase_fingerprint'));

  // 원문에 이미 같은 계열이 있으면 조사 교체·동등 의역 1회는 허용한다.
  const carried = fingerprint.auditFingerprint(
    '이 문제는 특정 부서에 국한되지 않는다. 결과는 보고서 작성에만 그치지 않는다.',
    '이 문제는 특정 부서에 한정되지 않는다. 결과는 보고서 작성에 그치지 않고 개선으로 이어진다. 대응은 개인 처분에 그치지 않고 구조를 본다.',
    'report_assignment'
  );
  assert.equal(family(carried).sourceCount, 2);
  assert.equal(family(carried).outputCount, 3);
  assert.equal(family(carried).excessIntroducedCount, 0);
});

test('A가 아니라 B를 A에 그치지 않고 B로 바꾼 반전을 실제 출력 형태로 잡는다', () => {
  const source = '핵심은 자료를 많이 확보하는 것이 아니라 필요한 자료를 고르는 일이다.';
  const output = '핵심은 자료를 많이 확보하는 데 그치지 않고 필요한 자료를 고르는 일이다.';
  const report = fingerprint.auditFingerprint(source, output, 'report_assignment');
  assert.ok(report.issueCodes.includes('contrast_relation_shift'), JSON.stringify(report.violations));
  assert.deepEqual(report.relationShift.sentenceOrdinals, [1]);

  const nominal = fingerprint.auditFingerprint(
    '이 책은 단순한 자기계발서가 아니라 인간 인식을 다루는 교양서다.',
    '이 책은 단순한 자기계발서에 그치지 않고 인간 인식을 다루는 교양서다.',
    'general'
  );
  assert.ok(nominal.issueCodes.includes('contrast_relation_shift'), JSON.stringify(nominal.violations));
});

test('뿐 아니라·만이 아니라·만으로 끝낼 것이 아니라는 이미 가산 관계라 반전이 아니다', () => {
  const cases = [
    ['감염성 심내막염은 감염 자체뿐 아니라 판막 기능 저하 같은 합병증을 일으킨다.', '감염성 심내막염은 감염 자체에 그치지 않고 판막 기능 저하 같은 합병증을 일으킨다.'],
    ['미술은 결과물을 완성하는 기술만이 아니라 감각과 경험이 드러나는 과정이다.', '미술은 결과물을 완성하는 기술에 그치지 않고 감각과 경험이 드러나는 과정이다.'],
    ['문제가 반복되면 개인 처분만으로 끝낼 것이 아니라 조직구조도 재검토해야 한다.', '문제가 반복되면 개인 처분에 그치지 않고 조직구조도 재검토해야 한다.'],
    ['환대는 개인의 윤리적 선의에 그치는 것이 아니라 사회적 성원권을 보장하는 행위다.', '환대는 개인의 윤리적 선의에 그치지 않으며 사회적 성원권을 보장하는 행위다.']
  ];
  for (const [source, output] of cases) {
    const report = fingerprint.auditFingerprint(source, output, 'general');
    assert.equal(report.issueCodes.includes('contrast_relation_shift'), false, `${source} => ${JSON.stringify(report.violations)}`);
    assert.equal(report.shadow.find(item => item.code === 'limitative_additive_expanded').introducedCount, 1, source);
  }

  // 1:2 묶음에서 이웃 문장의 계열 표현은 이 문장의 반전이 아니다.
  const grouped = fingerprint.auditFingerprint(
    '자유는 내적 상태뿐 아니라 사회적 환경에도 영향을 받는다. 따라서 자유는 고정된 개념이 아니라 계속 변화하는 개념이다.',
    '자유는 개인의 내면에만 머무르지 않고 사회적 환경에도 영향을 받는다. 그래서 자유는 고정된 개념이라기보다 계속 변화하는 개념이다.',
    'general'
  );
  // X1: 이웃 가산 표현은 여전히 제외하지만, 둘째 문장의 실제 비교 약화는 잡는다.
  assert.deepEqual(grouped.relationShift.sentenceOrdinals, [2], JSON.stringify(grouped.violations));
});

test('기본 모드에서 뜻이 같은 넓은 상투구는 관측만 하고 복원하지 않는다', () => {
  const source = '조명은 무대를 비추는 기능뿐 아니라 배우의 동선도 알린다.';
  const output = '조명은 무대를 비추는 기능에 그치지 않고 배우의 동선도 알린다.';
  for (const value of [undefined, '0', 'false', 'true', '']) {
    if (value === undefined) delete process.env[STYLE_FLAG];
    else process.env[STYLE_FLAG] = value;
    const audit = fingerprint.auditFingerprint(source, output, 'report_assignment');
    assert.equal(audit.expandedLimitativeStyleEnabled, false);
    assert.equal(audit.pass, true, JSON.stringify(audit.violations));
    assert.equal(family(audit).introducedCount, 0);
    assert.deepEqual(audit.shadow.find(item => item.code === 'limitative_additive_expanded'), {
      code: 'limitative_additive_expanded', sourceCount: 0, outputCount: 1, delta: 1, introducedCount: 1
    });
    assert.equal(fingerprint.restoreUnsafeRelationSentences(source, output, audit).text, output);
    assert.equal(fingerprint.isImproved(audit, fingerprint.auditFingerprint(source, source, 'report_assignment')), false);
  }
  process.env[STYLE_FLAG] = '1';
  const enabled = fingerprint.auditFingerprint(source, output, 'report_assignment');
  assert.equal(enabled.expandedLimitativeStyleEnabled, true);
  assert.deepEqual(enabled.issueCodes, ['engine_phrase_fingerprint']);
  assert.equal(fingerprint.restoreUnsafeRelationSentences(source, output, enabled).text, source);
});

test('기본 모드도 운영의 좁은 상투구 정책을 유지한다', () => {
  const audit = fingerprint.auditFingerprint('자료를 모으고 분류했다.',
    '자료를 모으는 데서 그치지 않고 분류했다.', 'report_assignment');
  assert.equal(family(audit).outputCount, 1);
  assert.ok(audit.issueCodes.includes('engine_phrase_fingerprint'));
});

test('배제 약화는 두 모드에서 동일하게 잡고 넓은 관측값의 음수 순증은 0으로 센다', () => {
  const source = '핵심은 자료를 많이 확보하는 것이 아니라 필요한 자료를 고르는 일이다.';
  const output = '핵심은 자료를 많이 확보하는 데 그치지 않고 필요한 자료를 고르는 일이다.';
  const off = fingerprint.auditFingerprint(source, output, 'report_assignment');
  assert.deepEqual(off.issueCodes, ['contrast_relation_shift']);
  process.env[STYLE_FLAG] = '1';
  const on = fingerprint.auditFingerprint(source, output, 'report_assignment');
  assert.deepEqual(on.relationShift, off.relationShift);
  assert.deepEqual(on.shadow, off.shadow);
  const removed = fingerprint.auditFingerprint(output, source, 'report_assignment');
  assert.deepEqual(removed.shadow.find(item => item.code === 'limitative_additive_expanded'), {
    code: 'limitative_additive_expanded', sourceCount: 1, outputCount: 0, delta: -1, introducedCount: 0
  });
});

test('부사 예외는 단순히·단지·그저가 부정되는 대상 바로 앞에 붙을 때만 적용한다', () => {
  const scoped = fingerprint.auditFingerprint(
    '학습은 단순히 지식을 외우는 것이 아니라 스스로 질문을 만드는 과정이다.',
    '학습은 지식을 외우는 데 머무르지 않고 스스로 질문을 만드는 과정이다.',
    'general'
  );
  assert.equal(scoped.issueCodes.includes('contrast_relation_shift'), false, JSON.stringify(scoped.violations));

  const distant = fingerprint.auditFingerprint(
    '원인을 두고 단순히 인사이동으로 대응할 경우 조직은 문제를 해결하는 것이 아니라 다른 부서로 옮기는 결과를 낳는다.',
    '원인을 두고 인사이동으로 대응할 경우 조직은 문제를 해결하는 데 그치지 않고 다른 부서로 옮기는 결과를 낳는다.',
    'general'
  );
  assert.ok(distant.issueCodes.includes('contrast_relation_shift'), JSON.stringify(distant.violations));
});

test('기본 모드의 실제 엔진 결과에 넓은 상투구 관측값이 남고 상투구 재시도는 없다', async t => {
  const names = ['GPT_LAYOUT_NLP_ENABLED', 'GPT_NIKL_QUALITY_ENABLED',
    'GPT_NIKL_EXTERNAL_API_ENABLED', 'HUMANIZATION_DEPTH_GATE_ENABLED'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
  for (const name of names) process.env[name] = '0';
  t.mock.method(global, 'fetch', async () => { throw new Error('OFFLINE_TEST'); });
  const source = '조명은 무대를 비추는 기능뿐 아니라 배우의 동선도 알린다. 관객은 밝기의 차이로 장면의 전환을 알아본다.';
  const output = '조명은 무대를 비추는 기능에 그치지 않고 배우의 동선도 알린다. 관객은 밝기의 차이로 장면의 전환을 알아본다.';
  const client = require('../engine-gpt-prod/openaiClient');
  t.mock.method(client, 'completeJson', async options => {
    if (options.schemaName !== 'gpt_prod_humanize_result') {
      throw new Error('Unexpected synthetic request: ' + options.schemaName);
    }
    return { json: { outputText: output }, model: options.model, usage: {} };
  });
  const quality = require('../engine-gpt-prod/finalQualityV2');
  const { bindSemanticValidation } = require('../engine-gpt-prod/semanticProvenance');
  t.mock.method(quality, 'runSemanticDocumentAudit', async options => bindSemanticValidation({
    ran: true, pass: true, verificationCompleted: true, outputText: options.outputText,
    repairCount: 0, reports: [], violations: [], sourceIssues: [], usage: {},
    progress: { expectedSections: 1, completedSections: 1, unfinishedSections: [] }
  }, options.source, options.outputText));
  const runtime = require('../lib/gptRuntimeConfig');
  const out = await require('../engine-gpt-prod').run({ text: source, mode: 'formal',
    documentProfileOverride: 'report_assignment', config: runtime.publicConfig(runtime.DEFAULT_CONFIG, 'test') });
  assert.equal(out.result.outputText, output);
  assert.equal(out.engineMeta.fingerprintPass, true);
  assert.equal(out.engineMeta.fingerprintRetryAttemptCount, 0);
  assert.equal(out.engineMeta.fingerprintSourceRestoreCount, 0);
  assert.deepEqual(out.engineMeta.fingerprintShadow.find(item => item.code === 'limitative_additive_expanded'), {
    code: 'limitative_additive_expanded', sourceCount: 0, outputCount: 1, delta: 1, introducedCount: 1
  });
});
