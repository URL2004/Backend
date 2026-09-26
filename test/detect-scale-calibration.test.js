'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const scale = require('../lib/detectScaleCalibration');

const model = scale.loadModel();
const shortRule = model.rules.find(r => r.id === 'short_review_scale');

test('default is off: no env flag means the displayed score is the engine score', () => {
  const previous = [process.env.DETECT_SCALE_CALIBRATION_ENABLED, process.env.DETECT_SCALE_CALIBRATION_RULES];
  delete process.env.DETECT_SCALE_CALIBRATION_ENABLED; delete process.env.DETECT_SCALE_CALIBRATION_RULES;
  try {
    const out = scale.applyScaleCalibration({ probability: 18, chars: 120, profile: 'general' });
    assert.deepEqual(out, { probability: 18, applied: false, meta: null });
    assert.equal(scale.enabled(), false);
    assert.deepEqual(scale.enabledRules(), []);
  } finally {
    if (previous[0] !== undefined) process.env.DETECT_SCALE_CALIBRATION_ENABLED = previous[0];
    if (previous[1] !== undefined) process.env.DETECT_SCALE_CALIBRATION_RULES = previous[1];
  }
});

test('flag on without a listed rule id applies nothing', () => {
  const out = scale.applyScaleCalibration({ probability: 18, chars: 120, profile: 'general' }, { active: true, rules: [] });
  assert.equal(out.applied, false); assert.equal(out.probability, 18); assert.equal(out.meta, null);
});

test('short_review_scale maps the validated anchors and stays inside its scope', () => {
  const opts = { active: true, rules: ['short_review_scale'] };
  for (const [before, after] of [[0, 0], [9, 25], [18, 50], [27, 62], [36, 74], [68, 87], [100, 100]]) {
    const out = scale.applyScaleCalibration({ probability: before, chars: 120, profile: 'general' }, opts);
    assert.equal(out.probability, after, `${before} -> ${after}`);
    assert.equal(out.applied, before !== after);
    if (out.applied) assert.deepEqual(out.meta, { version: scale.VERSION, applied: true, rule: 'short_review_scale', before, after, chars: 120, profile: 'general' });
  }
  assert.equal(scale.applyScaleCalibration({ probability: 18, chars: 120, profile: 'unknown' }, opts).probability, 50);
  assert.equal(scale.applyScaleCalibration({ probability: 18, chars: 120, profile: 'review_blog' }, opts).probability, 50);
  // out of scope: length, profile, non-LLM source
  assert.equal(scale.applyScaleCalibration({ probability: 18, chars: 300, profile: 'general' }, opts).applied, false);
  assert.equal(scale.applyScaleCalibration({ probability: 18, chars: 120, profile: 'resume_application' }, opts).applied, false);
  assert.equal(scale.applyScaleCalibration({ probability: 18, chars: 120, profile: 'report_assignment' }, opts).applied, false);
  assert.equal(scale.applyScaleCalibration({ probability: 18, chars: 120, profile: 'general', probSource: 'engine' }, opts).applied, false);
});

test('mapping is monotone, integer and bounded for every input score', () => {
  let previous = -1;
  for (let s = 0; s <= 100; s++) {
    const v = scale.mapScore(s, shortRule.points);
    assert.ok(Number.isSafeInteger(v) && v >= 0 && v <= 100 && v >= previous, `score ${s} -> ${v}`);
    previous = v;
  }
  assert.equal(scale.mapScore(-5, shortRule.points), 0);
  assert.equal(scale.mapScore(140, shortRule.points), 100);
});

test('rejected development rules never apply even when listed', () => {
  const out = scale.applyScaleCalibration({ probability: 40, chars: 1200, profile: 'general' }, { active: true, rules: ['long_prose_boundary_40'] });
  assert.equal(out.applied, false); assert.equal(out.probability, 40);
  assert.equal(model.rules.find(r => r.id === 'long_prose_boundary_40').status, 'rejected_development');
});

test('model validation rejects non-monotone, unbounded or duplicate rules', () => {
  assert.equal(scale.validateModel(model), true);
  const bad = points => scale.validateModel({ version: scale.VERSION, rules: [{ id: 'x_rule', scope: { maxChars: 10 }, points }] });
  assert.equal(bad([[0, 0], [50, 40], [40, 60], [100, 100]]), false, 'x must increase');
  assert.equal(bad([[0, 0], [50, 60], [60, 40], [100, 100]]), false, 'y must not decrease');
  assert.equal(bad([[0, 5], [100, 100]]), false, 'must start at 0,0');
  assert.equal(bad([[0, 0], [100, 90]]), false, 'must end at 100,100');
  assert.equal(scale.validateModel({ version: scale.VERSION, rules: [shortRule, shortRule] }), false, 'duplicate ids');
  assert.equal(scale.validateModel({ version: 'other', rules: [shortRule] }), false);
  const invalid = scale.applyScaleCalibration({ probability: 18, chars: 120, profile: 'general' }, { active: true, rules: ['short_review_scale'], model: { version: scale.VERSION, rules: [] } });
  assert.equal(invalid.applied, false, 'an invalid model never changes a score');
});

test('stored meta is closed and tamper-resistant', () => {
  const meta = scale.applyScaleCalibration({ probability: 18, chars: 120, profile: 'general' }, { active: true, rules: ['short_review_scale'] }).meta;
  assert.deepEqual(scale.sanitizeScaleMeta({ ...meta, extra: 'x' }), meta);
  assert.equal(scale.sanitizeScaleMeta({ ...meta, before: 50 }), null, 'applied flag must agree with before/after');
  assert.equal(scale.sanitizeScaleMeta({ ...meta, after: 101 }), null, 'scores stay within 0..100');
  assert.equal(scale.sanitizeScaleMeta({ ...meta, applied: false }), null);
  assert.equal(scale.sanitizeScaleMeta({ ...meta, rule: 'DROP TABLE' }), null);
  assert.equal(scale.sanitizeScaleMeta(null), null);
});

test('invalid probabilities pass through untouched', () => {
  for (const p of [null, undefined, 'x', -1, 101, NaN]) {
    const out = scale.applyScaleCalibration({ probability: p, chars: 120, profile: 'general' }, { active: true, rules: ['short_review_scale'] });
    assert.equal(out.applied, false); assert.equal(out.meta, null);
  }
});
