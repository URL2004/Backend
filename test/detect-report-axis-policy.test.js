'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  AXIS_MIN_SENTENCES,
  AXIS_POLICY_BY_PROFILE,
  RADAR_AXIS_POLICY_VERSION,
  resolveRadarAxisPolicy,
  buildDetectReportView
} = require('../lib/detectReportView');

const AXES = ['uniform', 'ending', 'generic', 'anchor', 'stance'];

test('보고서·논문은 화자 입장 축을 끄고 앵커 축만 종류별 기준으로 본다', () => {
  const report = resolveRadarAxisPolicy({ profile: 'report_assignment', confidence: 0.96, sentenceTotal: 40 });
  assert.equal(report.version, RADAR_AXIS_POLICY_VERSION);
  assert.equal(report.mode, 'axes');
  assert.equal(report.profileLabel, '보고서·과제');
  assert.equal(report.axes.stance.status, 'off');
  assert.match(report.axes.stance.reason, /화자 입장/u);
  assert.deepEqual(report.axes.anchor, { status: 'on', metric: 'anchor', target: 0.10, reason: null });
  for (const axis of ['uniform', 'ending', 'generic']) assert.equal(report.axes[axis].status, 'on');

  const paper = resolveRadarAxisPolicy({ profile: 'academic_paper', confidence: 0.9, sentenceTotal: 90 });
  assert.equal(paper.axes.stance.status, 'off');
  assert.equal(paper.axes.anchor.target, 0.12);
});

test('자소서·에세이는 화자 입장을 보고, 앵커 대신 실제 경험 문장 비율을 쓴다', () => {
  const resume = resolveRadarAxisPolicy({ profile: 'resume_application', confidence: 0.84, sentenceTotal: 12 });
  assert.deepEqual(resume.axes.stance, { status: 'on', metric: 'stance', target: 0.30, reason: null });
  assert.deepEqual(resume.axes.anchor, { status: 'on', metric: 'lived', target: 0.30, reason: null });
  const essay = resolveRadarAxisPolicy({ profile: 'personal_essay', confidence: 0.86, sentenceTotal: 20 });
  assert.equal(essay.axes.stance.target, 0.25);
  assert.equal(essay.axes.anchor.metric, 'lived');
});

test('글 종류가 불확실하면 두 축을 참고(soft)로 낮추고 높음 판정을 내지 않게 표시한다', () => {
  const unknown = resolveRadarAxisPolicy({ profile: 'unknown', confidence: 0.4, sentenceTotal: 15 });
  assert.equal(unknown.lowConfidence, true);
  assert.equal(unknown.axes.anchor.status, 'soft');
  assert.equal(unknown.axes.stance.status, 'soft');
  assert.match(unknown.axes.stance.reason, /참고로만/u);
  // 프로필은 알지만 신뢰도가 낮아도 같은 취급
  const shaky = resolveRadarAxisPolicy({ profile: 'resume_application', confidence: 0.3, sentenceTotal: 15 });
  assert.equal(shaky.axes.stance.status, 'soft');
  // 모르는 프로필 이름은 unknown으로 흡수
  assert.equal(resolveRadarAxisPolicy({ profile: 'weird_profile', confidence: 0.99, sentenceTotal: 15 }).profile, 'unknown');
  // off는 신뢰도와 무관하게 off
  const paperShaky = resolveRadarAxisPolicy({ profile: 'academic_paper', confidence: 0.2, sentenceTotal: 15 });
  assert.equal(paperShaky.axes.stance.status, 'off');
});

test('문장이 적으면 축별 최소 문장 수 아래의 축은 sparse가 되고, 전부 sparse면 안내 한 줄로 바뀐다', () => {
  assert.deepEqual(AXIS_MIN_SENTENCES, { uniform: 4, ending: 4, generic: 3, anchor: 6, stance: 6 });
  const five = resolveRadarAxisPolicy({ profile: 'resume_application', confidence: 0.9, sentenceTotal: 5 });
  assert.equal(five.mode, 'axes');
  assert.equal(five.axes.anchor.status, 'sparse');
  assert.equal(five.axes.stance.status, 'sparse');
  assert.equal(five.axes.anchor.minSentences, 6);
  assert.match(five.axes.anchor.reason, /문장이 적어/u);
  assert.equal(five.axes.uniform.status, 'on');
  assert.equal(five.axes.generic.status, 'on');

  const three = resolveRadarAxisPolicy({ profile: 'report_assignment', confidence: 0.9, sentenceTotal: 3 });
  assert.equal(three.axes.uniform.status, 'sparse');
  assert.equal(three.axes.ending.status, 'sparse');
  assert.equal(three.axes.generic.status, 'on');
  assert.equal(three.mode, 'axes');

  const two = resolveRadarAxisPolicy({ profile: 'report_assignment', confidence: 0.9, sentenceTotal: 2 });
  assert.equal(two.mode, 'sparse_all');
  assert.ok(AXES.every((axis) => two.axes[axis].status === 'sparse'));
  assert.match(two.note, /600자쯤/u);
  // sparse는 off보다 우선한다(보고서라도 문장이 없으면 '해당 없음'이 아니라 '재지 않음')
  assert.equal(two.axes.stance.status, 'sparse');
});

test('정책표는 모든 프로필에 anchor·stance를 갖고 target은 0~1 범위다', () => {
  for (const [profile, spec] of Object.entries(AXIS_POLICY_BY_PROFILE)) {
    for (const axis of ['anchor', 'stance']) {
      const entry = spec[axis];
      assert.ok(entry && ['on', 'soft', 'off'].includes(entry.status), `${profile}.${axis} status`);
      if (entry.status !== 'off') assert.ok(entry.target > 0 && entry.target <= 1, `${profile}.${axis} target`);
      if (entry.status === 'off') assert.ok(entry.reason && /해요$|않아요$/u.test(entry.reason), `${profile}.${axis} off reason 해요체`);
    }
  }
});

test('보고서 뷰는 글 종류를 받아 measuredEvidence.axisPolicy로 내려보내고, 없으면 unknown 정책을 쓴다', () => {
  const measurements = {
    uniformity: { avgLength: 50, lengthCV: 0.2, maxEndingRun: 2, paragraphCountCV: 0.1 },
    genericness: { ratio: 0.2, count: 2, total: 10 },
    realAnchorDensity: { ratio: 0.05, count: 1, total: 10 },
    stance: { ratio: 0, count: 0, total: 10 },
    detail: [{ sents: 10, lived: 1, specific: 0 }]
  };
  const withProfile = buildDetectReportView({
    probability: 70, probSource: 'llm', riskLevel: 'high', measurements,
    documentProfile: { profile: 'report_assignment', confidence: 0.95 }
  });
  assert.equal(withProfile.measuredEvidence.axisPolicy.profile, 'report_assignment');
  assert.equal(withProfile.measuredEvidence.axisPolicy.sentenceTotal, 10);
  assert.equal(withProfile.measuredEvidence.axisPolicy.axes.stance.status, 'off');
  assert.equal(withProfile.measuredEvidence.stanceRatio, 0, '원값은 그대로 남긴다(사실 표기용)');

  const without = buildDetectReportView({ probability: 70, probSource: 'llm', riskLevel: 'high', measurements });
  assert.equal(without.measuredEvidence.axisPolicy.profile, 'unknown');
  assert.equal(without.measuredEvidence.axisPolicy.axes.anchor.status, 'soft');
});

test('감지 보고서 라우트는 이미 계산한 문서 프로필을 뷰에 넘긴다', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'detectreport.js'), 'utf8');
  assert.match(source, /documentProfile: \{ profile: advancedRouting\.profile, confidence: advancedRouting\.confidence \}/u);
});
