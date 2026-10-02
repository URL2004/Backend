'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const layout = require('../engine-gpt-prod/layoutStructure');
const pre = require('../engine-gpt-prod/sourcePreflight');
const st = require('../engine-gpt-prod/structureChunk');
const {detectDocumentProfile} = require('../engine-gpt-prod/documentProfile');
const {buildVoiceProfile} = require('../engine-gpt-prod/voiceProfile');
const bare = s => s.replace(/\s/gu, '');

test('parenthesized nominal titles with a final period separate from their complete bodies', () => {
  for (const title of ['(2) 운영 목표의 이동: 배포에서 관측으로.', '(3) 이동형 작업과 현장 교육의 일상화.', '(4) 영상 기반 실습.']) {
    const body = '현장의 의견을 살펴보면 짧은 설명을 제공하는 것뿐 아니라 직접 확인하고 연습하는 과정도 필요하다.';
    const source = `${title} ${body}`;
    const prepared = pre.auditAndSanitizeSource(source).text;
    assert.equal(prepared,`${title}\n${body}`);
    assert.equal(pre.auditAndSanitizeSource(prepared).text,prepared);
    assert.equal(layout.buildLineRecords(prepared)[0].role,'heading');
    const chunks=st.splitChunksForGpt(prepared).chunks;
    const out=st.restoreFinalDocumentLayout({source:prepared,outputText:source,chunks,mode:'formal',documentProfile:{profile:'report_assignment',confidence:.95},normalizeVisualGaps:true});
    assert.equal(out.structuralPass,true);
    assert.ok(out.text.split('\n').includes(title));
    assert.equal(bare(out.text),bare(source));
  }
  for (const source of ['(1) 참여자는 자료를 검토했다. 이어서 필요한 조치를 협의하고 각 담당자에게 결과를 전달했다.', '(2) 우리는 출발했다. 목적지까지 이동하면서 주변의 환경을 관찰하고 내용을 자세히 기록했다.']) {
    assert.equal(pre.repairInlineHeadingBoundaries(source).text,source);
  }
});

test('nominal section after a web citation counter is not consumed as a physical wrap', () => {
  const title = '이야기가 보여 주는 변화와 의의';
  const body = '이 이야기는 눈앞의 성과만 평가하기보다 주변 사람의 상황을 이해하고 함께 문제를 풀어 가는 과정의 중요성을 보여 준다.';
  const source = ['주인공은 어려움을 겪으며 자신의 행동을 돌아보고 친구와 대화를 이어 갔다.', '자료집', '+2', title, body].join('\n');
  const prepared = pre.auditAndSanitizeSource(source).text;
  assert.ok(prepared.split('\n').includes(title));
  assert.ok(['heading','title'].includes(layout.buildLineRecords(source).find(r => r.text === title).role));
  assert.equal(bare(prepared), bare(source));
  assert.equal(pre.auditAndSanitizeSource(prepared).text, prepared);
  const wrap = '함께 생각해야 할 여러 문제에 대해\n자료를 살펴보고 다양한 의견을 비교하며 판단했다.';
  assert.ok(!pre.auditAndSanitizeSource(wrap).text.includes('대해\n'));
});

test('witnessed colon sections get label boundaries without guessing subtitle endings', () => {
  const {repairEmbeddedLabelBoundaries:repair}=require('../engine-gpt-prod/inlineLabelParagraphs');
  const body='자료를 먼저 살펴보고 어떤 점이 필요한지 충분히 생각했다. 이를 바탕으로 친구들과 의견을 나누면서 계획을 정리하고 직접 실행하는 방법을 검토했다.';
  const source=`학습 과정\n초기 모습: 준비만 하며 시작을 미룬 시간\n${body} 전환 경험: 작은 시도를 통해 얻은 깨달음 ${body}현재 모습: 배움을 실행으로 옮기는 태도 ${body}`;
  const out=pre.auditAndSanitizeSource(source).text;
  assert.ok(out.includes('\n\n전환 경험:'));
  assert.ok(out.includes('\n\n현재 모습:'));
  assert.equal(bare(out),bare(source));
  assert.equal(pre.auditAndSanitizeSource(out).text,out);
  for(const protectedInput of [`“${source}”`,`\x60\x60\x60\n${source}\n\x60\x60\x60`,source.replace('초기 모습: 준비만 하며 시작을 미룬 시간\n',''),source.replace('현재 모습:','현재 모습은')]){
    assert.equal(repair(protectedInput).text,protectedInput);
  }
  const reflection=source.replaceAll(body,'저는 주변의 이야기를 듣고 생각을 정리했다. 처음에는 자료를 읽는 일이 어려웠지만 직접 실천하는 일이 중요하다는 것을 깨달았다. 나는 다양한 시도를 하면서 관점을 바꾸게 되었다.');
  assert.equal(detectDocumentProfile(pre.auditAndSanitizeSource(reflection).text).profile,detectDocumentProfile(reflection).profile);
});

test('font-private bullets retain separate label ownership and keep bodies editable', () => {
  for (const mark of ['\uE123','\u{F02FC}','\u{100123}']) {
    const lines = [
      `${mark} 조사 방법: 지역 이용자에게 같은 문항을 제시하고 응답 내용을 항목별로 비교하였다.`,
      `${mark} 참여 대상: 안내를 읽고 자발적으로 참여한 성인 주민을 대상으로 하였다.`,
      `${mark} 분석 내용: 이용 빈도와 개선 요구를 나누어 정리하고 조사 범위의 한계도 기록하였다.`
    ];
    const source = lines.join('\n');
    assert.deepEqual(layout.buildLineRecords(source).map(r => r.role), ['list','list','list']);
    assert.equal(pre.auditAndSanitizeSource(source).text, source);
    const chunks = st.splitChunksForGpt(source).chunks;
    assert.ok(chunks.some(c => !c.locked));
    const out = st.restoreFinalDocumentLayout({source,outputText:lines.join(' '),chunks,mode:'formal',documentProfile:{profile:'report_assignment',confidence:.95},normalizeVisualGaps:true});
    assert.equal(bare(out.text), bare(source));
    assert.equal(out.structuralPass, true);
    assert.equal(out.text.split('\n').filter(l => l.trim().startsWith(mark)).length, 3);
  }
  for (const value of ['\uE123 이것은 표식을 설명하는 일반 문장이다.', '수식 안의 \uE123 기호: 변수에 해당한다.', '\uE123이름: 내용', '\uE123 \uE124 이름: 내용']) {
    assert.equal(layout.listPrefixParts(value), null, value);
  }
  const fenced = '```\n\uE123 이름: 코드의 일부\n```';
  assert.ok(layout.buildLineRecords(fenced).every(r => r.role === 'code'));
});

const policy = [
  'Ⅳ. 학교에서의 공동 지원 1. 교사와 상담사의 협력 교사는 학생의 학습목표를 확인하고 상담사는 학생이 자료에 접근하도록 전문적으로 지원할 수 있다.',
  '학생은 수업에 참여하는 과정에서 필요한 도움을 받을 수 있다. 교사는 활동 전에 자료를 검토하고 필요한 지원을 논의해야 한다.',
  '학교는 필요한 인력과 자료를 마련해야 한다. 수업 후에는 학생의 참여 여부를 확인하고 다음 활동에 반영한다.',
  '2. 상담사에게 모든 책임을 맡기지 않기 상담사가 모든 교육 활동을 담당한다고 생각하면 학생은 수업에서 배제될 수 있다.',
  '교사는 자신의 수업에서 학생의 참여를 보장해야 한다. 공동 지원은 특정 담당자 한 명의 책임이 아니라 학교 전체가 함께 수행하는 일이다.',
  'Ⅶ. 결론 학교의 공동 지원은 모든 학생에게 같은 활동에 참여할 기회를 제공한다는 점에서 의미가 있다.'
].join('\n');

test('educational policy subjects do not trigger observation-record line locking', () => {
  for (const source of [policy, pre.auditAndSanitizeSource(policy).text]) {
    const profile = detectDocumentProfile(source);
    assert.equal(profile.signals.educationPolicyFrame, true);
    assert.equal(profile.profile, 'report_assignment');
    assert.ok(!profile.safetyProfiles.includes('student_record_teacher'));
    assert.notEqual(buildVoiceProfile(source,{documentProfile:profile,mode:'assignment'}).lineBoundaryPolicy, 'all');
  }
  const source = pre.auditAndSanitizeSource(policy).text;
  const documentProfile = detectDocumentProfile(source);
  const voice = buildVoiceProfile(source,{documentProfile,mode:'assignment'});
  const chunks = st.splitChunksForGpt(source,{preserveLineBoundaries:voice.lineBoundaryPolicy}).chunks;
  const out = st.restoreFinalDocumentLayout({source,outputText:policy,chunks,mode:'assignment',documentProfile,normalizeVisualGaps:true});
  assert.equal(out.structuralPass,true);
  assert.ok(out.text.split('\n').includes('Ⅶ. 결론'));
  assert.equal(bare(out.text),bare(policy));
});

test('individual observation records and their original lines remain protected', () => {
  const source = [
    '1. 관찰 기록',
    '학생은 수업 중 친구의 의견을 끝까지 듣고 자신의 의견을 차분하게 설명했다.',
    '학생은 탐구 활동에서 자료를 비교하여 근거를 정리하고 모둠 발표에 적극적으로 참여했다.',
    '학생은 공동 과제에서 맡은 역할을 성실하게 수행하며 협력하는 태도를 보였다.',
    '학생은 관찰한 결과 책임감과 소통 역량이 돋보이며 스스로 학습 과정을 점검했다.'
  ].join('\n');
  const profile = detectDocumentProfile(source);
  assert.equal(profile.signals.educationPolicyFrame,false);
  assert.equal(profile.profile,'student_record_teacher');
  assert.equal(buildVoiceProfile(source,{documentProfile:profile,mode:'assignment'}).lineBoundaryPolicy,'all');
  const mixed = source + '\n학교는 수업 자료를 준비해야 한다. 학생의 학습 참여를 지원해야 한다.';
  assert.equal(detectDocumentProfile(mixed).signals.educationPolicyFrame,false);
});
