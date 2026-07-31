'use strict';

function buildEscalationInstruction(reason = '') {
  const normalized = String(reason || '').trim().toLowerCase();
  const header = [
    '[재시도 지시]',
    `1차 결과가 ${normalized || '품질 게이트'} 사유로 통과하지 못했다. 이미 통과한 불변 계약은 그대로 지키고, 아래 실패 원인만 우선해서 다시 작성한다.`
  ];
  if (normalized === 'noop_unchanged' || normalized.includes('depth') || normalized.includes('surface')) {
    return [
      ...header,
      '원문을 보존적으로 다시 복사하지 않는다. 새 사실·평가·결론을 넣지 않은 채 같은 주장 안의 절 배치, 주어 위치, 내용어 순서와 문장 호흡을 분명히 재구성한다.',
      '띄어쓰기·쉼표·조사·동의어 한두 곳만 고친 결과는 다시 실패한다. 이 청크의 실질 휴머나이징 계약에 표시된 문장 수와 우선 대상을 이행한다.'
    ].join('\n');
  }
  if (normalized.includes('structure') || normalized.includes('boundary')
      || normalized.includes('section') || normalized.includes('anchor')
      || normalized.includes('list')) {
    return [
      ...header,
      '현재 입력 청크에 실제로 포함된 구조와 제목·번호 항목을 누락 없이 유지해서 다시 작성한다.',
      '현재 입력에 Ⅰ/Ⅱ/Ⅲ, 1./2./3. 같은 제목 줄이 있으면 그대로 포함한다. 입력에 없는 문서의 다른 제목을 새로 만들지 않는다.',
      '문단이나 항목을 요약해 합치지 않는다. 각 항목의 핵심 설명량을 원문과 비슷하게 유지한다.'
    ].join('\n');
  }
  if (normalized.includes('number') || normalized.includes('fact')
      || normalized.includes('novel') || normalized.includes('protected')
      || normalized.includes('quote')) {
    return [
      ...header,
      '원문의 수치·단위·고유명사·직접 인용·부정과 가능성 관계를 정확히 복원한다.',
      '누락된 사실을 되살리되 원문에 없는 설명이나 사례를 보충하지 않는다. 그 범위 안에서 문장 구조는 선택한 강도만큼 다시 구성한다.'
    ].join('\n');
  }
  if (normalized.includes('voice') || normalized.includes('pov')
      || normalized.includes('speaker') || normalized.includes('register')) {
    return [
      ...header,
      '원문의 화자·인칭·종결체·격식을 복원한다. 인용문 안의 화자는 바꾸지 않는다.',
      '화자와 문체를 지킨다는 이유로 원문 문장을 그대로 복사하지 말고, 같은 의미 안의 절 배치와 호흡은 실질적으로 다시 구성한다.'
    ].join('\n');
  }
  if (normalized.includes('length_collapse') || normalized.includes('truncat')
      || normalized.includes('empty')) {
    return [
      ...header,
      '원문의 누락된 문장과 끝부분을 모두 복원해 완결된 전체 청크를 출력한다. 축약본·요약본이나 중간에서 끊긴 문장을 내지 않는다.',
      '복원한 사실·수치·인용의 범위 안에서 일반 문장의 절 배치와 호흡을 선택 강도만큼 다시 구성하되 새 내용을 만들지 않는다.'
    ].join('\n');
  }
  if (normalized.includes('length_overrun') || normalized.includes('expanded')) {
    return [
      ...header,
      '모델이 새로 덧붙인 반복 설명·완충 문장·중복 결론만 제거해 원문과 비슷한 분량으로 되돌린다.',
      '원문에 있던 사실·근거·예시·인용은 삭제하거나 요약하지 않고, 선택 강도의 문장 재구성은 유지한다.'
    ].join('\n');
  }
  if (normalized.includes('refusal') || normalized.includes('prompt')
      || normalized.includes('encoding') || normalized.includes('meta')) {
    return [
      ...header,
      '거절문·작업 설명·프롬프트 문구·깨진 문자를 출력하지 말고, 원문의 완결된 본문만 정상 한국어로 다시 작성한다.',
      '원문의 모든 사실과 구조를 유지하고 메타 설명 없이 최종 본문만 출력한다.'
    ].join('\n');
  }
  return [
    ...header,
    '현재 입력의 사실·화자·구조를 지키면서 실패 구간만 고친다. 통과한 문장을 보존형으로 되돌리거나 새 내용을 덧붙이지 않는다.'
  ].join('\n');
}

module.exports = { buildEscalationInstruction };
