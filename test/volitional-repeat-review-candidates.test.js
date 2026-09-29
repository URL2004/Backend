'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { auditRelationCandidates: audit } = require('../engine-gpt-prod/relationAudit');
const review = require('../engine-gpt-prod/semanticOperatorReview');
const volition = 'volitional_modality_candidate', repeat = 'repetition_condition_candidate';
const codes = (a,b) => audit(a,b,{includeAllCandidates:true}).codes;
const a = '담당자는 새로운 장비의 작동 원리를 알아가고 싶다.';
const b = '담당자는 새로운 장비의 작동 원리를 알아가려 한다.';
const c = '실험이 즐겁고 다음 주에도 해보고 싶은 활동이 생긴다면 참여할 생각이다.';
const d = c.replace('해보고', '다시 해보고');

test('same-action wish and intention shifts are review candidates in both directions', () => {
  assert.ok(codes(a,b).includes(volition));
  assert.ok(codes(b,a).includes(volition));
  assert.ok(codes('담당자는 새로운 질문을 외면하지 않으려 한다.',
    '담당자는 새로운 질문을 외면하고 싶지 않다.').includes(volition));
  const first='담당자는 검사 기록을 정리하려 한다.', second='담당자는 검사 기록을 정리하고 싶다.';
  assert.equal(review.targets(first+' '+a,second+' '+b).filter(t=>t.codes.includes(volition)).length,2,
    'equal document-wide wish/intention counts do not hide swapped action ownership');
});

test('introduced repetition inside the same conditional action nominates only a scope question', () => {
  assert.ok(codes(c,d).includes(repeat));
  assert.ok(codes(c,d.replace('다시','재차')).includes(repeat));
});

test('a unique same-action wish prefix nominates a paraphrased conditional ending', () => {
  for (const [source,output] of [
    [c,d.replace('활동이 생긴다면','마음이 든다면')],
    ['다음 학기에도 배우고 싶은 과목이 생긴다면 수업을 신청할 생각이다.',
      '다음 학기에도 재차 배우고 싶은 마음이 든다면 수업을 신청할 생각이다.']
  ]) assert.ok(codes(source,output).includes(repeat));
});

test('paraphrased conditional ownership abstains on unrelated, protected, repeated or multiple actions', () => {
  const paraphrase=d.replace('활동이 생긴다면','마음이 든다면');
  for (const [source,output] of [
    [c,paraphrase.replace('해보고','배우고')],
    [c.replace('해보고 싶은','같은 장비를 사용하고 싶은'),
      paraphrase.replace('해보고 싶은','같은 장비를 고치고 싶은')],
    [c.replace('활동이 생긴다면','활동이나 해보고 싶은 과목이 생긴다면'),paraphrase],
    [c.replace('활동이 생긴다면','활동을 찾고 배우고 싶은 과목이 생긴다면'),paraphrase],
    [c.replace('실험이 즐겁고','실험이 즐겁다면'),paraphrase],
    [c,paraphrase.replace('마음이 든다면','마음이 들고 배우고 싶은 과목이 생긴다면')],
    [d,paraphrase], [c.replace('해보고','또 해보고'),paraphrase],
    ['“'+c+'”','“'+paraphrase+'”'], ['`'+c+'`','`'+paraphrase+'`']
  ]) assert.equal(codes(source,output).includes(repeat),false);
});

test('paraphrased conditional repetition remains a contextual question with preserved allowed', () => {
  const output=d.replace('활동이 생긴다면','마음이 든다면');
  const t=review.targets(c,output).find(t=>t.codes.includes(repeat));
  assert.ok(t);
  assert.equal(review.assess([t],[],[],c,output).pending[0].repairable,false);
  assert.equal(review.assess([t],[{...t,status:'preserved',
    detail:'The next-week context already implies repeating the same activity.'}],[],c,output).pending.length,0);
});

test('new candidates enter explicit review; missing or unsupported changed answers cannot pass', () => {
  for (const [source,output,code] of [[a,b,volition],[c,d,repeat]]) {
    const targets = review.targets(source,output);
    const t = targets.find(t => t.codes.includes(code));
    assert.ok(t);
    assert.equal(review.assess([t],[],[],source,output).pending.length,1);
    assert.equal(review.assess([t],[{...t,status:'changed',detail:'A changed operator requires a separate grounded finding.'}],[],source,output).pending.length,1);
    assert.equal(review.assess([t],[{...t,status:'preserved',detail:'The same action is already repeated in its surrounding context.'}],[],source,output).pending.length,0);
    assert.equal(review.assess([t],[],[],source,output).pending[0].repairable,false);
  }
});

test('unchanged polarity, unrelated predicates and already attested repetition do not create new questions', () => {
  for (const [source,output] of [
    [a,a], [b,b.replace('알아가려 한다','알아가려고 한다')],
    [a,a.replace('싶다','싶지 않다')],
    [a,a.replace('알아가고 싶다','정리하려 한다')],
    [d,d], [d,d.replace('다시','재차')],
    [d.replace('다시','또'),d],
    ['담당자는 다시마의 색깔을 확인하면 기록하려 한다.', '담당자는 다시마 색깔을 확인하면 기록하려 한다.'],
    ['담당자는 자료를 확인했다.', '담당자는 자료를 다시 확인했다.']
  ]) {
    const found = codes(source,output);
    assert.equal(found.includes(volition)||found.includes(repeat),false);
  }
});

test('quoted or code operators cannot nominate narrator modality or conditional repetition', () => {
  for (const [source,output] of [[a,b],[c,d]]) {
    for (const wrap of [s=>'“'+s+'”',s=>'‘'+s+'’',s=>'`'+s+'`']) {
      const found=codes('기록에는 '+wrap(source)+'라는 예문이 있었다.', '기록에는 '+wrap(output)+'라는 예문이 있었다.');
      assert.equal(found.includes(volition)||found.includes(repeat),false);
    }
  }
});

test('ordinary sentence merging keeps each action modality and does not nominate a swap', () => {
  const source='담당자는 장비의 작동 원리를 알아가고 싶다. 담당자는 실험 기록을 정리하려 한다.';
  const output='담당자는 장비의 작동 원리를 알아가고 싶다며 실험 기록을 정리하려 한다.';
  assert.equal(codes(source,output).includes(volition),false);
  assert.equal(codes(c+' '+a,c+' 또한 '+a).includes(repeat),false);
});

test('operator syntax is parsed lazily once per input per audit and never cached across audits', () => {
  const syntax = require('../engine/textSyntax'), original = syntax.syntaxSpans;
  const source = [a,c,'연구자는 통계 자료의 해석 방법을 배워가고 싶다.'].join(' ');
  const output = [b,d,'연구자는 통계 자료의 해석 방법을 배워가려 한다.'].join(' ');
  const calls = new Map();
  syntax.syntaxSpans = (text,...args) => {
    if (text===source||text===output) calls.set(text,(calls.get(text)||0)+1);
    return original(text,...args);
  };
  try {
    const first=audit(source,output,{includeAllCandidates:true});
    assert.ok(first.codes.includes(volition)&&first.codes.includes(repeat));
    assert.equal(calls.get(source),1);
    assert.equal(calls.get(output),1);
    assert.deepEqual(audit(source,output,{includeAllCandidates:true}),first);
    assert.equal(calls.get(source),2);
    assert.equal(calls.get(output),2);
  } finally { syntax.syntaxSpans=original; }
});
