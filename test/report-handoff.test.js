'use strict';

// 보고서 → 휴머나이징 핸드오프 계약(2026-09-02)
//   ① 재검사 보정: 짧은 글 근사 일치 문턱(300자 또는 5문장) · 원점수 상한
//   ② 결과의 "유지할 근거 보존" 검사가 보고서와 같은 자로 센다
//   ③ 1~2문장 글은 근거 판정을 보류하고 5문장 미만은 표본 적음을 표시한다

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_SAFETY_SALT = 'report-handoff-test-secret-at-least-32-bytes';
process.env.DETECT_HISTORY_CALIBRATION = '1';

const calibration = require('../lib/detectCalibration');
const integrity = require('../lib/historyLinkIntegrity');
const sourceScores = require('../lib/detectSourceScore');
const sg = require('../engine/surfaceguard');
const {
  buildDetectReportView,
  resolveContentEvidence,
  CONTENT_MIN_SENTENCES,
  SAMPLE_SMALL_SENTENCES
} = require('../lib/detectReportView');

const logger = { info() {}, warn() {} };

function humanizeRecord(uid, outputText, extra = {}, verifiedScore = false) {
  const base = {
    type: 'humanize', savedBy: 'server', mode: 'blog', qualityStatus: 'clean',
    billingDisposition: 'charged', outputText, createdAt: 1,
    engineMeta: {
      deliveryDecision: 'deliver_clean', effectStatus: 'normal', approvedModelChunkCount: 2,
      modelFailureChunkCount: 0, substantiveEditRatio: 0.2, structureSignaturePass: true
    },
    ...extra
  };
  if (verifiedScore) base.historySourceScoreIntegrity = sourceScores.signSourceScore(uid, outputText, base.sourceProbability);
  return { ...base, historyLinkIntegrity: integrity.sign(uid, outputText, base) };
}

function stubDb(records) {
  const docs = records.map((data, i) => ({ id: 'job_h' + i, data: () => data }));
  const historyQuery = { select: () => historyQuery, get: async () => ({ docs }) };
  return {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: false, data: () => ({}) }),
        collection: () => ({ orderBy: () => ({ limit: () => historyQuery }) })
      })
    })
  };
}

const SHORT = [
  '기업 연계형 프로젝트에서 보고서 양식이 갑작스럽게 변경된 상황에서 AI를 활용해 제한된 시간 안에 보고서를 재구성했습니다.',
  '기존 보고서의 내용과 실험자료를 버리고 새로 작성하기보다, 유지해야 할 내용과 새 양식에서 추가된 항목을 먼저 구분했습니다.',
  '이후 프로젝트를 진행하며 축적한 실험 결과와 소재별 특성, 제품의 장점 등을 AI에게 제공하고 기존 내용과 새 요구사항을 연결하도록 요청했습니다.',
  '저는 AI가 만든 결과를 그대로 사용하지 않고 실제 수행 내용과 일치하는지, 기술적으로 부정확한 부분은 없는지 직접 검토하고 수정했습니다.',
  '또한 처음 접하는 용어나 소재 특성이 등장하면 AI를 활용해 관련 내용을 확인한 뒤 필요한 정보만 선별해 반영했습니다.',
  '그 결과 기존 프로젝트의 핵심 내용을 유지하면서 변경된 양식에 맞는 보고서를 완성할 수 있었습니다.'
].join(' ');   // 공백 제외 약 330자 · 6문장 — 자소서 한 문항의 전형

test('자소서 한 문항 길이(공백 제외 300자대)의 결과를 한 단어 고쳐도 근사 일치로 보정한다', async () => {
  const uid = 'u1';
  const edited = SHORT.replace('보고서 양식이', '리포트 양식이');
  const r = await calibration.applyHistoryCalibration({
    db: stubDb([humanizeRecord(uid, SHORT)]), uid, text: edited, probability: 72, logger, route: 't'
  });
  assert.equal(r.applied, true);
  assert.equal(r.meta.match, 'near_normalized');
  assert.equal(r.probability, 61);
});

test('문장 수 기준은 절대 하한(200자)을 지켜 짧은 반복문에는 열리지 않는다', () => {
  const cfg = calibration.sanitizeConfig({});
  const tiny = '관찰기록을확인하고다음활동을준비했습니다.'.repeat(6);   // 6문장 · 약 120자
  assert.equal(calibration.countSentenceMarks(tiny), 6);
  assert.equal(calibration.approximateEligible(tiny, cfg), false);
  const sixSentences = '이번 학기 프로젝트에서 제가 맡은 역할은 실험 데이터를 정리하는 일이었습니다.'.replace(/\s/g, '').repeat(6);
  assert.ok(sixSentences.length >= 200 && sixSentences.length < 300, `len=${sixSentences.length}`);
  assert.equal(calibration.approximateEligible(sixSentences, cfg), true, '200자 이상 5문장 이상은 근사 일치 대상');
});

test('서버 확인과 서명이 있는 원점수만 재검사 상한으로 사용한다', async () => {
  const uid = 'u1';
  // 원글 55점 → 휴머나이징 → 재검사 원점수 72: 비율 보정(61)보다 원점수(55)가 낮으므로 55로 자른다.
  const r = await calibration.applyHistoryCalibration({
    db: stubDb([humanizeRecord(uid, SHORT, { sourceProbability: 55 }, true)]), uid, text: SHORT, probability: 72, logger, route: 't'
  });
  assert.equal(r.probability, 55);
  assert.equal(r.meta.sourceCapApplied, true);
  assert.equal(r.meta.sourceProbability, 55);

  // 원점수가 더 높으면(80) 비율 보정 결과(61)를 그대로 둔다 — 상한은 올리는 장치가 아니다.
  const r2 = await calibration.applyHistoryCalibration({
    db: stubDb([humanizeRecord(uid, SHORT, { sourceProbability: 80 }, true)]), uid, text: SHORT, probability: 72, logger, route: 't'
  });
  assert.equal(r2.probability, 61);
  assert.equal(r2.meta.sourceCapApplied, false);
});

test('원점수 상한은 설정으로 끌 수 있고 이력에 값이 없으면 작동하지 않는다', async () => {
  const uid = 'u1';
  const none = await calibration.applyHistoryCalibration({
    db: stubDb([humanizeRecord(uid, SHORT)]), uid, text: SHORT, probability: 72, logger, route: 't'
  });
  assert.equal(none.meta.sourceProbability, null);
  assert.equal(none.probability, 61);
  const cfg = calibration.sanitizeConfig({ sourceCapEnabled: false });
  assert.equal(cfg.sourceCapEnabled, false);
  assert.equal(calibration.sourceProbabilityOf({ sourceProbability: '48.6' }), 49);
  assert.equal(calibration.sourceProbabilityOf({}), null);
  for (const value of [null, undefined, '', ' ', false, true, [], {}, NaN]) {
    assert.equal(calibration.sourceProbabilityOf({ sourceProbability: value }), null);
  }
});

test('구형 이력의 0점이나 미확인 점수는 HMAC 휴머나이징 이력이어도 상한으로 쓰지 않는다', async () => {
  for (const sourceProbability of [null, 0, 12, 55]) {
    calibration.clearRuntimeConfigCache();
    const result = await calibration.applyHistoryCalibration({
      db: stubDb([humanizeRecord('u1', SHORT, { sourceProbability })]),
      uid: 'u1', text: SHORT, probability: 72, logger, route: 't'
    });
    assert.equal(result.probability, 61);
    assert.equal(result.meta.sourceCapApplied, false);
    assert.equal(result.meta.sourceProbability, null);
  }
});

test('실제로 확인·서명된 0점은 결측치와 구분하여 보존한다', async () => {
  calibration.clearRuntimeConfigCache();
  const result = await calibration.applyHistoryCalibration({
    db: stubDb([humanizeRecord('u1', SHORT, { sourceProbability: 0 }, true)]),
    uid: 'u1', text: SHORT, probability: 72, logger, route: 't'
  });
  assert.equal(result.probability, 0);
  assert.equal(result.meta.sourceCapApplied, true);
});

test('결과의 유지할 근거 보존 검사는 보고서와 같은 계측으로 같은 수를 낸다', () => {
  // routes/transform.js measurePreservation과 detectReportView.resolveContentEvidence가 같은 자(analyzeParagraphs)를 쓴다.
  const detail = sg.analyzeParagraphs(SHORT).detail;
  const sum = key => detail.reduce((acc, item) => acc + Math.max(0, Number(item?.[key]) || 0), 0);
  const fromReport = resolveContentEvidence({ detail, genericness: sg.measureGenericness(SHORT) });
  assert.equal(fromReport.lived, sum('lived'));
  assert.equal(fromReport.specific, sum('specific'));
  assert.equal(fromReport.total, sum('sents'));
  assert.ok(fromReport.total >= 5);
});

test('1~2문장 글은 근거 판정을 보류하고 전환을 권하지 않는다', () => {
  assert.equal(CONTENT_MIN_SENTENCES, 3);
  const two = SHORT.split(' 기존 ')[0];   // 첫 문장만
  const paras = sg.splitParagraphsForReport(two);
  const joined = paras.join('\n\n');
  const view = buildDetectReportView({
    probability: 72, probSource: 'llm', riskLevel: 'high',
    measurements: {
      uniformity: sg.measureUniformity(joined), genericness: sg.measureGenericness(joined),
      realAnchorDensity: sg.measureRealAnchorDensity(joined), stance: sg.measureStance(joined),
      detail: sg.analyzeParagraphs(joined).detail
    }
  });
  assert.equal(view.contentEvidence.status, 'limited');
  assert.equal(view.status, 'limited');
  assert.equal(view.conversion.eligible, false);
  assert.equal(view.measuredEvidence.sampleSize, 'small');
  assert.ok(view.measuredEvidence.sentenceTotal < CONTENT_MIN_SENTENCES);
});

test('5문장 미만은 표본 적음을 표시하고 5문장 이상은 정상이다', () => {
  assert.equal(SAMPLE_SMALL_SENTENCES, 5);
  const paras = sg.splitParagraphsForReport(SHORT);
  const joined = paras.join('\n\n');
  const view = buildDetectReportView({
    probability: 72, probSource: 'llm', riskLevel: 'high',
    measurements: {
      uniformity: sg.measureUniformity(joined), genericness: sg.measureGenericness(joined),
      realAnchorDensity: sg.measureRealAnchorDensity(joined), stance: sg.measureStance(joined),
      detail: sg.analyzeParagraphs(joined).detail
    }
  });
  assert.equal(view.measuredEvidence.sampleSize, 'ok');
  assert.equal(view.measuredEvidence.sentenceTotal, 6);
  assert.equal(view.contentEvidence.status !== 'limited', true);
});
