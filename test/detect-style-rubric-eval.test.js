'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { STYLE_RUBRIC_APPENDIX, SYNTHETIC_PAIRS, buildStyleRubricCandidate } = require('../eval/detectStyleRubric');

test('evaluation pairs cover six length-matched topics with honest style-only provenance', () => {
  assert.equal(SYNTHETIC_PAIRS.length, 6);
  assert.equal(new Set(SYNTHETIC_PAIRS.map(pair => pair.id)).size, 6);
  for (const genre of ['short_text', 'report', 'personal_essay']) assert.equal(SYNTHETIC_PAIRS.filter(pair => pair.genre === genre).length, 2);
  for (const pair of SYNTHETIC_PAIRS) {
    assert(pair.lengthRatio >= 0.85, pair.id + ' length mismatch: ' + pair.lengthRatio);
    assert.equal(pair.provenance, 'synthetic_by_codex_for_style_evaluation');
    assert.equal(pair.labelType, 'relative_target_style_signal_not_author_identity');
    assert(pair.targetSignals.length && pair.controls.length);
    assert(!('expectedProbability' in pair));
  }
});

test('Korean eval candidate replaces conflicting hard gates without editing the production prompt', () => {
  const { buildDetectPrompt } = require('../engine-gpt-prod/prompts/detect');
  const base = buildDetectPrompt('ko');
  const candidate = buildStyleRubricCandidate(base);
  assert(candidate.endsWith(STYLE_RUBRIC_APPENDIX));
  assert(!candidate.includes('점수 기준:'));
  assert(!candidate.includes('최소 3개'));
  assert(!candidate.includes('8문장 이상이면 high'));
  assert.equal(buildDetectPrompt('ko'), base);
  assert.throws(() => buildStyleRubricCandidate(buildDetectPrompt('en')), /Unsupported Korean base prompt/u);
  assert.throws(() => buildStyleRubricCandidate(''), TypeError);
  assert.match(STYLE_RUBRIC_APPENDIX, /실제 작성 주체는 알 수 없다/u);
  assert.match(STYLE_RUBRIC_APPENDIX, /짧다는 이유로 점수를 자동 감점하거나 길다는 이유로 가산하지 않는다/u);
});
