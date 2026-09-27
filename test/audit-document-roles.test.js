'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLineRecords } = require('../engine-gpt-prod/layoutStructure');
const { buildDetectInputDocument } = require('../lib/detectInputDocument');

const prose = '이 사례에서는 주변 상황을 관찰하고 서로 다른 반응을 살펴보았다. 여러 사람의 의견을 들으면서 처음의 판단을 다시 점검하게 되었다. 결과를 하나의 이유로 단정하지 않고 당시의 조건과 맥락을 함께 고려할 필요가 있다.';
const spoken = '오늘은 지역의 자원순환 활동을 소개하겠습니다. 먼저 사람들이 참여하게 된 계기를 살펴보겠습니다. 참여자들은 작은 실천을 이어 가면서 주변의 변화를 확인했습니다. 다음으로 조사 방법과 결과를 말씀드리겠습니다.';

test('paired numbered fields recover missing boundaries without modifying any content', () => {
  const repair=require('../engine-gpt-prod/sourcePreflight').repairSourceLayoutArtifacts;
  const input='장면 1) 문 앞에서 친구를 기다리는 장면이유 1) 기다리는 마음을 조명으로 보여 주기 때문입니다.장면 2) 두 사람이 함께 걸어가는 장면이유 2) 서로에게 다가서는 모습을 보여 주기 때문입니다.';
  for(const value of [input,input.replaceAll('이유','이유').replace('장면 2','\r\n장면 2')]){
    const out=repair(value);
    assert.equal(out.text.replace(/\s+/gu,''),value.replace(/\s+/gu,''));
    assert.deepEqual(buildLineRecords(out.text).filter(r=>!r.blank).map(r=>r.role),['heading','label_inline','heading','label_inline']);
    assert.equal(repair(out.text).text,out.text);
  }
  for(const value of ['"'+input+'"','```text\n'+input+'\n```',input.replace('이유 2)','이유 3)'), '문항 표지의 예는 다음과 같다. '+input]){
    assert.equal(require('../engine-gpt-prod/pairedLabelLayout').repairPairedLabelLayout(value).changes.length,0);
  }
});

test('repeated named prompts remain headings despite length and internal quotes', () => {
  const titles = ['장면1. 두 사람의 첫 만남', '장면2. 두 사람이 긴 여행을 마치고 돌아온 자리에서 "다른 사람의 이야기도 끝까지 들어 보자"라는 말을 떠올리는 모습', '장면3. 다시 시작하는 연습'];
  for (const separator of ['\n', '\n\n', '\r\n', '\r\n\r\n']) {
    const source = titles.map(title => `${title}${separator}이유: ${prose}`).join(separator);
    const rows = buildLineRecords(source);
    for (const title of titles) assert.equal(rows.find(r => r.text === title).role, 'heading', title);
    assert.ok(rows.filter(r => r.text.startsWith('이유:')).every(r => r.role === 'label_inline'));
  }
});

test('parallel nominal headings can include one short infinitive heading', () => {
  const titles = ['함께 시작한 첫 걸음', '작은 변화의 가능성을 발견하다.', '더 많은 사람들에게'];
  const source = titles.map(title => `${title}\n${prose}`).join('\n');
  const rows = buildLineRecords(source);
  for (const title of titles) assert.ok(['title', 'heading'].includes(rows.find(r => r.text === title).role), title);
});

test('numbered complete prose and unrelated single prompts are not frozen by the family rule', () => {
  const source = `관찰1. 사람들은 주변 환경이 달라지면 행동을 바꾸기도 한다.\n이유: ${prose}\n관찰2. 상황을 충분히 살핀 다음 다시 판단하는 태도가 필요하다.\n이유: ${prose}`;
  assert.ok(buildLineRecords(source).filter(r => /^관찰\d/u.test(r.text)).every(r => r.role === 'prose'));
});

test('authored slide speech is prose, with exact CRLF offsets and real sample units', () => {
  const source = `[이전 발표자(파트 1) 연결]\r\n"${spoken}"\r\n\r\n[슬라이드 2: 결과]\r\n“${spoken}”`;
  const doc = buildDetectInputDocument(source);
  assert.equal(doc.eligibleSentenceCount, 8);
  assert.equal(doc.eligibleText.includes('슬라이드'), false);
  assert.equal(doc.eligibleText.includes('이전 발표자'), false);
  assert.equal(doc.sentences.filter(s => s.eligibleForDetection).length, 8);
  for (const sentence of doc.sentences) assert.equal(source.slice(sentence.start, sentence.end), sentence.text);
});

test('nested external quotation remains protected inside authored speech', () => {
  const inner = '‘여러 조건을 함께 살펴야 한다. 하나의 관점으로 단정해서는 안 된다.’';
  const source = `[슬라이드 1]\n"${spoken} 연구자는 ${inner}라고 적었습니다."\n\n[슬라이드 2]\n"${spoken}"`;
  const doc = buildDetectInputDocument(source);
  assert.ok(doc.protectedSpans.some(s => s.spanType === 'quote' && source.slice(s.start, s.end) === inner));
  assert.equal(doc.eligibleText.includes('단정해서는'), false);
  assert.ok(doc.eligibleText.includes('소개하겠습니다'));
});

test('one quote, cited anthology, external speech and code do not become authored prose', () => {
  for (const source of [
    `[슬라이드 1]\n"${spoken}"`,
    `출처: 외부 연설문\n[슬라이드 1]\n"${spoken}"\n[슬라이드 2]\n"${spoken}"`,
    `[슬라이드 1 인용]\n"${spoken}"\n[슬라이드 2 인용]\n"${spoken}"`,
    `\`\`\`text\n[슬라이드 1]\n"${spoken}"\n[슬라이드 2]\n"${spoken}"\n\`\`\``
  ]) {
    assert.equal(buildDetectInputDocument(source).eligibleText.includes('소개하겠습니다'), false);
  }
});
