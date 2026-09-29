'use strict';
// 2026-09-29 실사고: 문단 끝 마침표를 빠뜨린 학생 글(…제시된다 / …검토할 수 있다 / …느꼈다)을 PDF 줄바꿈으로
// 오인해 다음 문단과 이어 붙였다. 26문단이 20문단이 됐고, 결론의 "셋째…검토할 수 있다 넷째, …"가 한 문단으로 나갔다.
// 서술 종결어미로 끝난 긴 행은 문장이 끝난 것으로 보고, 다음 행이 인용 조사·연결 어미 조각일 때만 잇는다.
const test = require('node:test');
const assert = require('node:assert/strict');
const { repairForcedProseWraps } = require('../engine-gpt-prod/sourcePreflight');

// 첫 행은 문맥상 제목으로 분류되므로, 본문 안의 줄 경계를 시험하려면 앞에 제목과 본문 한 줄을 둔다.
const PREAMBLE = ['1. 전달체계의 개념', '이 글은 공공과 민간 전달체계의 개념과 역할을 사례를 통해 차례로 정리한 것이다.'];
const p1 = '공공 전달체계는 중앙정부와 지방자치단체 등 공공부문의 조직을 통해 정책을 실제 서비스로 전달하도록 지원하는 체계이다. 기관도 공공부문의 주체로 제시된다';
const p2 = '민간 전달체계는 사회복지법인과 민간 단체 등 민간조직을 통해 서비스가 전달되는 체계이다. 넓은 의미의 민간부문에는 비영리기관뿐 아니라 영리기관도 포함된다';
const p3 = '셋째, 담당 인력과 제공 가능한 자원의 상태를 주기적으로 점검하는 방안이다. 다른 기관의 운영방법을 그대로 적용하기보다 이용자의 실제 접근 조건을 살펴보는 접근을 검토할 수 있다';
const p4 = '넷째, 의뢰 건수뿐 아니라 서비스가 실제로 시작되었는지, 이용자가 필요한 도움을 받았는지 확인하는 방안이다. 나는 이러한 개념을 구체적인 질문으로 바꾸어 보는 과정이 중요하다고 느꼈다';
const p5 = '결국 이 과제에서 내가 주목한 것은 어느 쪽이 더 낫다는 판단이 아니라, 서로 다른 역할이 이용자의 생활에서 어떻게 연결되는가이다. 이러한 관점이 상황을 이해하는 데 도움이 될 것이라고 생각한다.';

function lines(text) { return text.split('\n').filter(line => line.trim()); }
function repair(body) { return repairForcedProseWraps([...PREAMBLE, ...body].join('\n')); }
function joins(result) { return result.changes.filter(c => c.code === 'source_forced_linewrap_repaired').length; }

test('마침표 없이 종결어미로 끝난 문단은 다음 문단과 이어 붙이지 않는다', () => {
  const repaired = repair([p1, p2, p3, p4, p5]);
  assert.equal(lines(repaired.text).length, PREAMBLE.length + 5, '문단 수가 보존돼야 한다');
  assert.equal(joins(repaired), 0);
  assert.equal(repaired.text.includes('검토할 수 있다 넷째'), false);
  assert.equal(repaired.text.includes('느꼈다 결국'), false);
  assert.equal(repaired.text.includes('제시된다 민간'), false);
});

test('종결어미 행 다음이 새 문장 시작이면 첫 어절이 무엇이든 잇지 않는다', () => {
  for (const opener of [
    '고객은 상담 과정에서 자신의 상황을 반복해서 설명해야 했다.',
    '면접에서 확인한 내용을 기록으로 남긴다.',
    '하지만 모든 기관이 같은 자원을 가진 것은 아니다.',
    '하는 일이 많아질수록 담당자의 시간은 줄어든다.',
    '이러한 우려는 자기결정권 원칙에 비추어 검토할 수 있다.'
  ]) {
    const repaired = repair([p1, opener]);
    assert.equal(lines(repaired.text).length, PREAMBLE.length + 2, `${opener.slice(0, 6)}: 새 문단으로 남아야 한다`);
    assert.equal(joins(repaired), 0, `${opener.slice(0, 6)}: 이어 붙이면 안 된다`);
  }
  // 해요체 종결도 같다.
  const polite = repair(['담당자는 이용자가 실제로 도움을 받았는지 확인하는 과정이 무엇보다 중요하다고 생각해요', '넷째로 살펴볼 것은 기록 방식입니다.']);
  assert.equal(joins(polite), 0);
});

test('진짜 줄바꿈은 여전히 잇는다: 인용 조사·조사·관형형·명사 끝', () => {
  const cases = [
    // 종결어미 뒤에 인용 조사 "고"가 다음 행으로 밀린 경우
    ['이 연구는 지역 자원을 연결하는 과정이 이용자의 생활 안정에 실질적으로 기여한다', '고 본다.', '기여한다'],
    // 조사로 끝난 행(기존 규칙)
    ['담당자는 이용자의 생활 상황을 파악하고 필요한 지원이 빠짐없이 이어지도록 하기 위해', '노력했다.', '위해 노력했다'],
    // 관형형으로 끝난 긴 행(일반 규칙)
    ['이러한 상황에서는 기관 간 협력이 또 하나의 절차가 되지 않도록 조정 방식을 다시 살펴보는', '것이 무엇보다 필요하다고 본다.', '살펴보는 것이'],
    // 명사로 끝난 긴 행은 종결어미가 아니다(일반 규칙 유지)
    ['지역마다 인력과 교통 여건이 다르기 때문에 퇴원한 노인이 이용할 수 있는 돌봄 서비스에 대한 수요', '증가로 인해 지원이 늦어지는 일이 생긴다.', '수요 증가로'],
    // "마다"는 '다'로 끝나지만 조사다
    ['담당자가 바뀔 때마다 지원 경과와 남은 과제를 다시 설명해야 하는 상황이 반복되는데, 그때마다', '이용자는 처음부터 다시 기다려야 한다.', '그때마다 이용자는']
  ];
  for (const [left, right, expected] of cases) {
    const repaired = repair([left, right]);
    assert.equal(lines(repaired.text).length, PREAMBLE.length + 1, `${expected}: 한 행으로 이어져야 한다`);
    assert.ok(repaired.text.includes(expected), `${expected}: 이어진 결과에 어절이 있어야 한다`);
  }
});
