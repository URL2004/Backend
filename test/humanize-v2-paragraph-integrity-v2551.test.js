'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const layout = require('../engine-gpt-prod/layoutStructure');
const preflight = require('../engine-gpt-prod/sourcePreflight');
const structure = require('../engine-gpt-prod/structureChunk');
const omission = require('../engine-gpt-prod/omissionRestore');

test('a demonstrative after a heading is not a detached subject particle', () => {
  for (const heading of ['연구 목적', '조사 범위', '활동 계획']) {
    const source = `${heading}\n\n이 연구는 참여 과정과 자료의 해석 방법을 살펴본다. 자료를 비교하여 차이를 확인한다.`;
    assert.equal(preflight.auditAndSanitizeSource(source).text, source);
  }
  const ocr = '초기 기록에서 이 시기의 사운드\n\n는 단일 스피커로 재생되었다. 이후 기술이 발전했다.';
  assert.match(preflight.auditAndSanitizeSource(ocr).text, /사운드는 단일/u);
});

test('non-finite prose is editable instead of locked as a title', () => {
  for (const line of ['그동안 지역 활동과 여러 사업에 참여하며', '현장 담당자를 안내 영상을 통해 처음 접하게 되었고', '부상으로 달리기를 그만둔 전직 육상 선수,']) {
    const source = `${line}\n행사에서 여러 사람과 이야기를 나누며 다음 활동을 준비하였다.`;
    assert.equal(layout.buildLineRecords(source)[0].role, 'prose');
    assert.equal(structure.splitChunksForGpt(source).chunks.some(c => c.locked && c.text.includes(line)), false);
  }
  assert.equal(layout.buildLineRecords('연구 목적\n이 연구는 여러 자료를 대조하여 결과의 차이를 확인하고 그 원인을 분석한다.')[0].role, 'title');
});

test('new paragraph breaks inside source-connected clauses are joined, unrelated text is not', () => {
  const left = '그동안 지역 활동과 여러 사업에 참여하며';
  const right = '다양한 경험을 쌓고 협력 방법을 배웠습니다.';
  const source = `${left}\n${right}`;
  assert.equal(structure.repairIntroducedMidSentenceParagraphBreaks(source, `${left}\n\n${right}`).text, `${left} ${right}`);
  assert.equal(structure.repairIntroducedMidSentenceParagraphBreaks(source, `${left}\n\n다음은 지원 동기입니다.`).applied, false);
});

test('confirmed omission restores the finite tail of an exact dangling prefix without inventing content', () => {
  const prefix = '현장 담당자를 안내 영상을 통해 처음 접하게 되었고';
  const tail = '행사 부스에서 연락처를 받게 되어 조심스럽게 연락드립니다.';
  const source = `${prefix}\n${tail}\n\n평소 프로그램의 진행 방식에 관심이 있었습니다.`;
  const outputText = `${prefix}\n\n평소 프로그램의 진행 방식에 관심이 있었습니다.`;
  const semanticReport = { violations: [{ type: 'omission', detail: '연락하게 된 계기 일부가 누락되었다.' }] };
  const result = omission.restoreConfirmedSemanticOmissions({source, outputText, semanticReport});
  assert.match(result.text, /되었고 행사 부스에서/u);
  assert.equal(result.text.split(tail).length, 2);
  assert.equal(result.remainingViolations.length, 1);
  assert.equal(omission.restoreConfirmedSemanticOmissions({source, outputText}).applied, false);
  assert.equal(omission.restoreConfirmedSemanticOmissions({source, outputText: source, semanticReport}).applied, false);
  assert.equal(omission.restoreConfirmedSemanticOmissions({source: `${prefix} ${tail}`, outputText: prefix, semanticReport}).text, `${prefix} ${tail}`);
});

test('titled resume keeps complete experience lines as independent readable units', () => {
  const lines = ['# 꾸준히 쌓은 경험',
    '첫 활동에서는 지역 행사를 준비하고 참여자의 의견을 기록했습니다. 안내 자료를 수정하여 현장에서 활용했습니다.',
    '다른 활동에서는 자료를 분류하고 검토 항목을 정리했습니다. 누락된 항목은 원자료를 확인하여 보완했습니다.',
    '이후 활동에서는 일정 관리를 담당했습니다. 담당자와 진행 상황을 공유하고 다음 일정을 조정했습니다.'];
  const source = lines.join('\n');
  const result = structure.restoreFinalDocumentLayout({source, outputText: source,
    chunks: structure.splitChunksForGpt(source).chunks, mode: 'assignment', requestStrength: 'basic',
    documentProfile: {profile: 'resume_application'}, normalizeVisualGaps: true});
  assert.equal(result.contentPreserved, true);
  for (const line of lines.slice(1)) assert.ok(result.text.includes(line));
  assert.ok(result.text.includes(`${lines[1]}\n\n${lines[2]}`));
  assert.equal(result.converged, true);
});

test('delivered metrics measure residual boundaries rather than repair attempts', () => {
  const source = '현장 담당자를 안내 영상을 통해 처음 접하게 되었고 연락처를 받아 연락했습니다.';
  const bad = source.replace('되었고 ', '되었고\n\n');
  assert.equal(structure.measureDeliveredParagraphBoundaries(source, bad).newIncompleteParagraphCount, 1);
  assert.equal(structure.measureDeliveredParagraphBoundaries(source, source).newIncompleteParagraphCount, 0);
});

test('career lecture reflection is not a resume even when it discusses job requirements', () => {
  const text = '이번 진로 특강에서는 현장의 여러 직무를 살펴보았다. 강연에서는 취업 준비와 지원 자격을 소개했다. 강의를 통해 일하는 방식의 차이를 알 수 있었다. 강연의 사례에서는 다양한 경력과 역량이 필요하다는 점을 배웠다. 강연을 들으며 진로 선택에 필요한 기준을 생각하게 되었다. 나의 강점과 약점을 돌아보며 앞으로의 준비 방향을 정리했다.';
  const result = require('../engine-gpt-prod/documentProfile').detectDocumentProfile(text);
  assert.equal(result.profile, 'report_assignment');
  assert.equal(result.signals.attendedLectureReflection, true);
});

test('a rewritten continuation with the same source boundary anchor can be joined', () => {
  const left = '그동안 여러 기관이 주관하는 교육 사업에 참여하며';
  const source = `${left} ‘우수교육프로그램 공모전’ 수상, 지역 표창을 받았습니다.`;
  const output = `${left}\n\n‘우수교육프로그램 공모전’에서 수상하고 지역 표창도 받았습니다.`;
  assert.equal(structure.repairIntroducedMidSentenceParagraphBreaks(source, output).repairCount, 1);
});

test('a secondary self-assessment safety profile cannot override resume layout authority', () => {
  const source = '# 경험을 바탕으로 한 성장\n' + Array.from({length:4}, (_,i) => `활동 ${i+1}에서는 담당한 업무를 정리했습니다. 자료를 점검하고 부족한 내용을 보완했습니다. 다음 활동에서는 협력 방법을 개선했습니다.`).join('\n');
  const voice = require('../engine-gpt-prod/voiceProfile');
  const profile = {profile:'resume_application', safetyProfiles:['resume_application','student_self_assessment'], formatProfile:{flags:[]}};
  assert.equal(voice.buildVoiceProfile(source,{documentProfile:profile,mode:'assignment'}).lineBoundaryPolicy, 'structural');
  assert.equal(voice.buildVoiceProfile(source,{documentProfile:{...profile,profile:'student_self_assessment'},mode:'assignment'}).lineBoundaryPolicy, 'all');
  const plan = structure.splitChunksForGpt(source,{preserveLineBoundaries:'structural'});
  const result = structure.restoreFinalDocumentLayout({source, outputText:source, chunks:plan.chunks, mode:'assignment',requestStrength:'basic',documentProfile:profile,normalizeVisualGaps:true});
  assert.equal(structure.buildStructureAudit({source, outputText:result.text,chunks:plan.chunks,plan}).pass,true);
});
