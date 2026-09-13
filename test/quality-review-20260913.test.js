'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const korean = require('../engine-gpt-prod/koreanRefinement');
const sg = require('../engine/surfaceguard');
const { prepareRefinementCandidate } = require('../lib/refinementValidation');
const { resolveContentEvidence } = require('../lib/detectReportView');
const { buildDetectInterpretation } = require('../lib/detectInterpretation');
const profile = { profile: 'report_assignment' };

test('repeated script cues and stage directions protect headings and spoken line rhythm', () => {
  const script = '산책 오디오 대본\n소리\n- 바람 소리를 깝니다.\n나레이션\n잠시 멈추고\n위를 보세요.\n(바람 소리)\n영상\n- 천천히 전환합니다.\n내레이션 — 뒤\n이제\n걸어갑니다.\n(발소리)';
  const { detectDocumentProfile } = require('../engine-gpt-prod/documentProfile');
  const { buildLineRecords } = require('../engine-gpt-prod/layoutStructure');
  const result = detectDocumentProfile(script);
  const preflight = require('../engine-gpt-prod/sourcePreflight').auditAndSanitizeSource(script);
  assert.equal(preflight.text, script, 'source normalization must not join spoken lines before genre routing');
  assert.equal(result.profile, 'creative');
  assert.ok(result.formatProfile.flags.includes('line_sensitive'));
  assert.ok(result.formatProfile.flags.includes('script_cues'));
  assert.equal(buildLineRecords(script).filter(r => ['소리','나레이션','영상','내레이션 — 뒤'].includes(r.text)).every(r=>r.role==='heading'), true);
  const compare = require('../engine-gpt-prod/structureChunk').compareStructuralRoleSignatures;
  assert.equal(compare(script, script).pass, true);
  assert.equal(compare(script, script.replace('나레이션\n잠시', '나레이션잠시')).pass, false);
  assert.equal(compare(script, script.replace('소리\n', '영상\n').replace('영상\n- 천천히', '소리\n- 천천히')).pass, false);
  for (const prose of ['나레이션의 기능을 연구하였다. 소리와 영상의 관계를 분석한다.',
    '```\n'+script+'\n```', '소리\n음향의 물리적 성질을 설명한다.']) {
    assert.equal(require('../engine-gpt-prod/scriptStructure').detectScriptStructure(prose).isScript, false);
  }
});

test('compound particles after quotes stay attached and converge', () => {
  for (const suffix of ['만으로', '만의', '로서', '로써', '으로서는', '부터는', '까지도', '과의']) {
    const text = `이 판단은 ‘기준’${suffix} 설명된다.`;
    assert.equal(korean.applySafeFormattingRepairs({ source: text, outputText: text, documentProfile: profile }).text, text);
    assert.equal(korean.detectTextIssues(text).some(x => x.code === 'closed_quote_spacing'), false, suffix);
    const spaced = text.replace(`’${suffix}`, `’ ${suffix}`);
    const repaired = korean.applySafeFormattingRepairs({ source: text, outputText: spaced, documentProfile: profile }).text;
    assert.equal(repaired, text);
    assert.equal(korean.applySafeFormattingRepairs({ source: text, outputText: repaired, documentProfile: profile }).text, text);
  }
});

test('quote masking never invents punctuation gaps; real prose gaps still count', () => {
  const text = '설명은 "확인한다", "기록한다", "정리한다"라는 세 표현으로 이어진다.';
  assert.equal(korean.detectTextIssues(text).some(x => x.code === 'sentence_punctuation_spacing'), false);
  assert.equal(korean.detectTextIssues('결과를 확인한다 , 그리고 기록한다.').some(x => x.code === 'sentence_punctuation_spacing'), true);
});

test('final quote particle formatting preserves quote contents and non-space characters', () => {
  const source = '예컨대 ‘왜?’라는 표현은 맥락에 따라 달라진다.';
  const outputText = '예컨대 ‘왜?’ 이라는 표현은 맥락에 따라 다르게 해석된다.';
  const result = korean.applySafeFormattingRepairs({ source, outputText, documentProfile: profile });
  assert.match(result.text, /‘왜\?’이라는/);
  assert.equal(result.text.replace(/\s/g, ''), outputText.replace(/\s/g, ''));
  assert.equal(korean.applySafeFormattingRepairs({ source, outputText: result.text, documentProfile: profile }).applied, false);
});

test('refine preparation removes newly duplicated tail before meaning validation', () => {
  const tail = '앞으로 확인 절차를 정리하고 누락을 줄여 팀의 정확한 업무 처리에 기여하겠습니다.';
  const source = `업무를 검토했습니다. ${tail}`;
  const candidate = `체크 목록을 작성하며 업무를 검토했습니다. ${tail} ${tail}`;
  const prepared = prepareRefinementCandidate({ source, candidate, documentProfile: profile });
  assert.equal(prepared.split(tail).length - 1, 1);
  assert.match(prepared, /체크 목록/);
  assert.equal(prepareRefinementCandidate({ source: candidate, candidate, documentProfile: profile }), candidate,
    'source-authored repetition is not newly generated duplication');
});

test('percentage quantities count as content evidence without implying authorship', () => {
  for (const quantity of ['18%', '18％', '18.5%', '18퍼센트', '2.5퍼센트포인트']) {
    const text = `재검토 후 오류가 ${quantity} 감소했다.`;
    assert.equal(sg.analyzeParagraphs(text).detail[0].specific, 1, quantity);
    assert.equal(sg.classifyParagraphKind(text), 'concrete');
    assert.ok(sg.buildSourceAnchorPool(text).specifics.some(s => s.includes('18') || s.includes('2.5')));
  }
  assert.equal(sg.analyzeParagraphs('오류를 줄이는 것이 중요하다.').detail[0].specific, 0);
});

test('experience with a number is one grounded sentence, not two', () => {
  const text = '저는 지난주 4건의 기록을 검토했습니다. 이 과정은 중요하다. 다양한 방법이 필요하다. 꾸준한 노력이 요구된다.';
  const measured = sg.analyzeParagraphs(text);
  assert.equal(measured.detail[0].lived, 1);
  assert.equal(measured.detail[0].specific, 1);
  assert.equal(measured.detail[0].grounded, 1);
  const result = resolveContentEvidence(measured);
  assert.equal(result.groundedRatio, 0.25);
  assert.equal(result.status, 'mixed');
  const old = resolveContentEvidence({ detail: [{ lived: 1, specific: 1, sents: 4 }] });
  assert.equal(old.groundedRatio, 0.5, 'legacy aggregate remains readable');
});

test('specific verified cause outranks broad weak other-style fallback without rescoring', () => {
  const item = (category, strength, count) => ({ category, strength, locationStatus: 'source_range_verified',
    locations: Array.from({ length: count }, (_, i) => ({ sentenceIndex: i, start: i * 40, end: i * 40 + 30 })) });
  const data = { probability: 42, probSource: 'llm', textLength: 1000, sentenceTotal: 10,
    confidence: 'high', causeCoverageStatus: 'aligned', signalEvidence: [
      item('other_observed_style', 'weak', 10), item('ending_repetition', 'moderate', 4)] };
  const result = buildDetectInterpretation(data);
  assert.equal(result.pattern.category, 'ending_repetition');
  assert.equal(result.score, 42);
  assert.equal(buildDetectInterpretation({ ...data, signalEvidence: [data.signalEvidence[0]] }).pattern.category, 'other_observed_style');
});

test('delivery formatting is after all final restores and before final audit', () => {
  const fs = require('node:fs');
  const code = fs.readFileSync(require.resolve('../engine-gpt-prod'), 'utf8');
  assert.ok(code.indexOf('const deliveredFormatting') > code.indexOf("'final_structure_safe_candidate_restore'"));
  assert.ok(code.indexOf('const deliveredFormatting') < code.indexOf('finalGeneratedDuplicateAudit = dedupe.'));
  const route = fs.readFileSync(require.resolve('../routes/transform'), 'utf8');
  assert.ok(route.indexOf('prepareRefinementCandidate') < route.indexOf('const novelty = refined'));
});
