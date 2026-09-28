'use strict';
// Synthetic fixtures only. The names below are invented; nothing here asserts
// a real person, a real document or a verified historical fact.
const test = require('node:test');
const assert = require('node:assert/strict');
const { auditParentheticalAliasOwners, collectBindings, CODE } = require('../engine-gpt-prod/entityParentheticalIntegrity');
const { auditRelationCandidates } = require('../engine-gpt-prod/relationAudit');

const source = '초기 설계는 마틴 로웰(Martin Lowell)이 맡아 구조를 잡았다. 이후 검증 절차는 사라 로웰(Sarah Lowell)이 이어받아 정리했다.';
const rows = (a, b) => auditParentheticalAliasOwners(a, b).candidates;

test('shared surname: swapped multi-token owners are nominated with exact unique spans', () => {
  const output = '초기 설계는 사라 로웰(Martin Lowell)이 맡아 구조를 잡았다. 이후 검증 절차는 마틴 로웰(Sarah Lowell)이 이어받아 정리했다.';
  const found = rows(source, output);
  assert.equal(found.length, 2);
  for (const row of found) {
    assert.equal(row.code, CODE);
    assert.equal(row.kind, 'owner_swap');
    assert.equal(source.indexOf(row.sourceSpan), source.lastIndexOf(row.sourceSpan));
    assert.ok(source.includes(row.sourceSpan) && output.includes(row.outputSpan));
    assert.deepEqual(Object.keys(row).sort(),
      ['code', 'kind', 'outputOrdinal', 'outputSpan', 'sourceOrdinal', 'sourceSpan']);
  }
  assert.deepEqual(found.map(row => [row.sourceOrdinal, row.outputOrdinal]), [[1, 1], [2, 2]]);
});

test('owner keeps every name token, not only the last one', () => {
  assert.deepEqual(collectBindings(source).map(row => [row.owner, row.alias]),
    [['마틴 로웰', 'martin lowell'], ['사라 로웰', 'sarah lowell']]);
});

test('shortened owner is nominated only when it no longer separates two source owners', () => {
  const output = '초기 설계는 로웰(Martin Lowell)이 맡아 구조를 잡았다. 이후 검증 절차는 사라 로웰(Sarah Lowell)이 이어받아 정리했다.';
  assert.deepEqual(rows(source, output).map(row => row.kind), ['owner_truncated']);
  const single = '초기 설계는 마틴 로웰(Martin Lowell)이 맡아 구조를 잡았다. 이후 검증 절차는 다른 팀이 이어받아 정리했다.';
  assert.deepEqual(rows(single, single.replace('마틴 로웰(', '로웰(')), []);
});

for (const [name, output] of [
  ['identical text', source],
  ['reordered same pairs', '검증 절차는 이후 사라 로웰(Sarah Lowell)이 이어받아 정리했다. 초기 설계는 마틴 로웰(Martin Lowell)이 맡아 구조를 잡았다.'],
  ['title and context before the alias', '초기 설계는 책임자 마틴 로웰 교수(Martin Lowell)가 맡아 구조를 잡았다. 이후 검증 절차는 동료 사라 로웰(Sarah Lowell)이 이어받아 정리했다.'],
  ['spacing inside the owner', '초기 설계는 마틴로웰(Martin Lowell)이 맡아 구조를 잡았다. 이후 검증 절차는 사라 로웰(Sarah Lowell)이 이어받아 정리했다.'],
  ['alias removed', '초기 설계는 마틴 로웰이 맡아 구조를 잡았다. 이후 검증 절차는 사라 로웰이 이어받아 정리했다.'],
  ['unrelated new owner is not a swap', '초기 설계는 담당 연구자(Martin Lowell)가 맡아 구조를 잡았다. 이후 검증 절차는 사라 로웰(Sarah Lowell)이 이어받아 정리했다.']
]) test('no nomination: ' + name, () => assert.deepEqual(rows(source, output), []));

test('source alias with two different owners is ambiguous and skipped', () => {
  const ambiguous = '초기 설계는 마틴 로웰(Alex Roe)이 맡아 구조를 잡았다. 이후 검증 절차는 사라 로웰(Alex Roe)이 이어받아 정리했다.';
  const output = '초기 설계는 사라 로웰(Alex Roe)이 맡아 구조를 잡았다. 이후 검증 절차는 마틴 로웰(Alex Roe)이 이어받아 정리했다.';
  assert.deepEqual(rows(ambiguous, output), []);
});

test('one space before the parenthesis still binds; a wider gap is a conservative miss', () => {
  const spaced = source.replaceAll('(', ' (');
  assert.deepEqual(collectBindings(spaced).map(row => row.owner), ['마틴 로웰', '사라 로웰']);
  // Adding or removing that space is harmless spacing, not an owner change.
  assert.deepEqual(rows(source, spaced), []);
  assert.deepEqual(rows(spaced, source.replace('구조를 잡았다', '구조를 세웠다')), []);
  const swapped = spaced.replace('마틴 로웰 (Martin', '사라 로웰 (Martin');
  assert.deepEqual(rows(spaced, swapped).map(row => row.kind), ['owner_swap']);
  assert.deepEqual(rows(source, swapped).map(row => row.kind), ['owner_swap']);
  assert.deepEqual(collectBindings(source.replaceAll('(', '  (')), []);
});

test('non-unique evidence sentence is not emitted', () => {
  const repeated = '설계는 마틴 로웰(Martin Lowell)이 맡았다. 검증은 사라 로웰(Sarah Lowell)이 맡았다. 설계는 마틴 로웰(Martin Lowell)이 맡았다.';
  const output = '설계는 사라 로웰(Martin Lowell)이 맡았다. 검증은 사라 로웰(Sarah Lowell)이 맡았다. 설계는 사라 로웰(Martin Lowell)이 맡았다.';
  assert.deepEqual(rows(repeated, output), []);
});

for (const [name, text] of [
  ['date', '회의는 가을 학기(2024년 9월)에 열렸고 후속 회의는 겨울 학기(2025년 1월)에 열렸다.'],
  ['citation', '이 결과는 선행 연구(Roe et al.)와 후속 연구(Lowell, 2020)에서 다시 확인되었다.'],
  ['math', '첫째 조건(x = y + 1)과 둘째 조건(a < b)을 함께 만족해야 한다.'],
  ['quantity', '시료 무게(kg)와 이동 거리(km)를 각각 기록했다.'],
  ['acronym', '인공지능(AI)과 사물인터넷(IoT)을 함께 다루었다.'],
  ['term definition', '기계 학습(Machine Learning)과 심층 학습(Deep Learning)을 구분했다.'],
  ['lower-case gloss', '되먹임(feedback)과 앞먹임(feedforward)을 비교했다.'],
  ['same-script description', '마틴 로웰(설계 책임자)과 사라 로웰(검증 책임자)이 참여했다.'],
  ['two-character gloss', '학문(學問)과 기술(技術)을 함께 다루었다.']
]) test('never binds: ' + name, () => assert.deepEqual(collectBindings(text), []));

test('reverse direction and Hanja aliases bind; swaps are nominated', () => {
  const latin = '설계 초안은 Martin Lowell(마틴 로웰)이 작성했다고 적혀 있다. 검증 기록은 Sarah Lowell(사라 로웰)이 남겼다고 적혀 있다.';
  const swapped = '설계 초안은 Sarah Lowell(마틴 로웰)이 작성했다고 적혀 있다. 검증 기록은 Martin Lowell(사라 로웰)이 남겼다고 적혀 있다.';
  assert.deepEqual(rows(latin, swapped).map(row => row.kind), ['owner_swap', 'owner_swap']);
  const hanja = '설계 초안은 김가람(金佳嵐)이 작성했다고 적혀 있다. 검증 기록은 김나래(金娜來)가 남겼다고 적혀 있다.';
  const hanjaSwapped = '설계 초안은 김나래(金佳嵐)가 작성했다고 적혀 있다. 검증 기록은 김가람(金娜來)이 남겼다고 적혀 있다.';
  assert.deepEqual(rows(hanja, hanjaSwapped).map(row => row.kind), ['owner_swap', 'owner_swap']);
  assert.deepEqual(rows(hanja, hanja.replace('작성했다고', '썼다고')), []);
});

test('relationAudit carries the nomination without displacing or dropping other candidates', () => {
  const output = '초기 설계는 사라 로웰(Martin Lowell)이 맡아 구조를 잡았다. 이후 검증 절차는 마틴 로웰(Sarah Lowell)이 이어받아 정리했다.';
  const audit = auditRelationCandidates(source, output);
  assert.equal(audit.candidateOnly, true);
  assert.equal(audit.semanticRequired, true);
  assert.ok(audit.codes.includes(CODE));
  assert.equal(audit.candidates.filter(row => row.code === CODE).length, 2);
  assert.ok(!auditRelationCandidates(source, source).codes.includes(CODE));

  // 14 hedge removals exceed the 12-row cap; the alias row must be additive.
  const many = Array.from({ length: 14 }, (_, i) => `${i + 1}번째 구간의 측정값은 기준보다 높을 가능성이 있다고 기록했다.`);
  const plain = many.map(line => line.replace('높을 가능성이 있다고', '높다고'));
  const base = auditRelationCandidates(many.join(' '), plain.join(' '));
  const withAlias = auditRelationCandidates(`${many.join(' ')} ${source}`, `${plain.join(' ')} ${output}`);
  const others = audit => audit.candidates.filter(row => row.code !== CODE).map(row => row.code);
  assert.deepEqual(others(withAlias).slice(0, base.candidates.length), others(base));
  assert.equal(withAlias.candidates.filter(row => row.code === CODE).length, 2);
  const all = auditRelationCandidates(`${many.join(' ')} ${source}`, `${plain.join(' ')} ${output}`, { includeAllCandidates: true });
  assert.ok(all.candidates.length >= withAlias.candidates.length);
  assert.equal(all.candidates.filter(row => row.code === CODE).length, 2);
});

test('nomination never edits text and stays bounded', () => {
  const pairs = Array.from({ length: 10 }, (_, i) => [`가${'나다라마바사아자차카'[i]}람 로웰`, `Name${'abcdefghij'[i]} Lowell`]);
  const text = pairs.map(([ko, en], i) => `${i + 1}번째 항목의 담당자는 ${ko}(${en.replace(/^Name(.)/u, (_, c) => 'Na' + c)})으로 기록되어 있다.`).join(' ');
  const rotated = pairs.map(([, en], i) => `${i + 1}번째 항목의 담당자는 ${pairs[(i + 1) % 10][0]}(${en.replace(/^Name(.)/u, (_, c) => 'Na' + c)})으로 기록되어 있다.`).join(' ');
  const result = auditParentheticalAliasOwners(text, rotated);
  assert.equal(result.candidateOnly, true);
  assert.ok(result.candidates.length > 0 && result.candidates.length <= 6);
  assert.deepEqual(Object.keys(result).sort(), ['candidateOnly', 'candidates', 'version']);
});

// The alias can have more tokens than the name it glosses (middle name,
// generational suffix). The owner window then reaches into the modifier in
// front of the name. A changed particle on that modifier is not an owner change.
const longAlias = '기록에 따르면 부유한 상단 운영자인 하론 벨크(Haron Dest Velk Sr.)와 미라 센 벨크(Mira Sen Velk)는 같은 해에 항구 도시로 이주했다.';

test('unchanged name with a longer alias: a changed modifier before the name is not nominated', () => {
  const output = '기록에 따르면 부유한 상단 운영자 하론 벨크(Haron Dest Velk Sr.)와 미라 센 벨크(Mira Sen Velk)는 같은 해 항구 도시로 옮겨 갔다.';
  assert.deepEqual(rows(longAlias, output), []);
  const replaced = output.replace('부유한 상단 운영자 하론', '이름난 무역상 하론');
  assert.deepEqual(rows(longAlias, replaced), []);
});

test('longer alias: a real swap or a shortened shared surname is still nominated', () => {
  const swapped = '기록에 따르면 부유한 상단 운영자인 미라 센 벨크(Haron Dest Velk Sr.)와 하론 벨크(Mira Sen Velk)는 같은 해에 항구 도시로 이주했다.';
  assert.ok(rows(longAlias, swapped).length >= 1);
  const shortened = '기록에 따르면 부유한 상단 운영자 벨크(Haron Dest Velk Sr.)와 미라 센 벨크(Mira Sen Velk)는 같은 해에 항구 도시로 이주했다.';
  assert.deepEqual(rows(longAlias, shortened).map(row => row.kind), ['owner_truncated']);
});

test('two shared trailing tokens do not hide a swap between siblings that share them', () => {
  const siblings = '첫 계약서는 미라 센 벨크(Mira Sen Velk)가 서명한 것으로 남아 있다. 둘째 계약서는 도나 센 벨크(Dona Sen Velk)가 서명한 것으로 남아 있다.';
  const swapped = '첫 계약서는 도나 센 벨크(Mira Sen Velk)가 서명한 것으로 남아 있다. 둘째 계약서는 미라 센 벨크(Dona Sen Velk)가 서명한 것으로 남아 있다.';
  assert.deepEqual(rows(siblings, swapped).map(row => row.kind), ['owner_swap', 'owner_swap']);
  const dropped = '첫 계약서는 센 벨크(Mira Sen Velk)가 서명한 것으로 남아 있다. 둘째 계약서는 도나 센 벨크(Dona Sen Velk)가 서명한 것으로 남아 있다.';
  assert.deepEqual(rows(siblings, dropped).map(row => row.kind), ['owner_truncated']);
});

test('same name with senior and junior aliases: a changed modifier is not a truncation', () => {
  const family = `${longAlias} 기록의 뒷부분에는 주인공의 맏형인 하론 벨크(Haron Dest Velk Jr.)가 가업을 이어받았다고 적혀 있다.`;
  const output = family.replace('상단 운영자인 하론', '상단 운영자 하론').replace('같은 해에', '같은 해');
  assert.notEqual(output, family);
  assert.deepEqual(rows(family, output), []);
  assert.deepEqual(rows(family, family.replace('부유한 상단 운영자인 하론', '이름난 무역상 하론')), []);
  assert.deepEqual(rows(family, family.replace('주인공의 맏형인 하론', '주인공의 맏형 하론')), []);
  // A real swap in the same document is still nominated.
  const swapped = family.replace('운영자인 하론 벨크(Haron Dest Velk Sr.)', '운영자인 미라 센 벨크(Haron Dest Velk Sr.)');
  assert.ok(rows(family, swapped).some(row => row.kind === 'owner_swap'));
});
