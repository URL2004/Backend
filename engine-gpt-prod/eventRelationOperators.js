'use strict';

// Review nominations, never automatic findings or text replacements. Compare
// the same anchored predicate rather than document-wide particle counts.
function eventRelationOperators(source, output, isUnprotected) {
  const codes = new Set();
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const unique = (text, re) => {
    const found = [...text.matchAll(re)];
    return found.length === 1 ? found[0] : null;
  };
  const nominate = (code, left, right) => {
    if (left && right && isUnprotected('source', left.index, left.index + left[0].length)
      && isUnprotected('output', right.index, right.index + right[0].length)) codes.add(code);
  };
  for (const m of output.matchAll(/(?<![가-힣])([가-힣]{2,24})만\s+(?:하|했|해)/gu)) {
    const stem = escape(m[1]);
    const left = unique(source, new RegExp(`(?<![가-힣])${stem}(?:을|를)?\\s*(?:하|했|해)`, 'gu'));
    const right = unique(output, new RegExp(`(?<![가-힣])${stem}만\\s+(?:하|했|해)`, 'gu'));
    nominate('action_exclusivity_candidate', left, right);
  }
  for (const m of source.matchAll(/(?<![가-힣])([가-힣]{1,24})다\s*보니/gu)) {
    const stem = escape(m[1]);
    nominate('experienced_conditional_candidate',
      unique(source, new RegExp(`(?<![가-힣])${stem}다\\s*보니`, 'gu')),
      unique(output, new RegExp(`(?<![가-힣])${stem}다\\s*보면`, 'gu')));
  }
  for (const m of source.matchAll(/(?<![가-힣])([가-힣]{1,24})기\s*위(?:해|하여|해서)/gu)) {
    const stem = escape(m[1]);
    nominate('purpose_simultaneity_candidate',
      unique(source, new RegExp(`(?<![가-힣])${stem}기\\s*위(?:해서|하여|해)`, 'gu')),
      unique(output, new RegExp(`(?<![가-힣])${stem}(?:으며|면서|며)(?=\\s|,)`, 'gu')));
  }
  // Same nominal owner, not document-wide counts of the syllable 만. These
  // remain contextual questions: an equivalent 오직 elsewhere may preserve it.
  for (const [exclusive, plain, reverse] of [[source, output, false], [output, source, true]]) {
    for (const m of exclusive.matchAll(/(?<![가-힣])([가-힣]{2,24})만이(?=\s)/gu)) {
      const stem = escape(m[1]);
      const left = unique(exclusive, new RegExp(`(?<![가-힣])${stem}만이(?=\\s)`, 'gu'));
      const right = unique(plain, new RegExp(`(?<![가-힣])${stem}(?:은|는|이|가)(?=\\s)`, 'gu'));
      nominate('subject_exclusivity_candidate', reverse ? right : left, reverse ? left : right);
    }
  }
  // A coordinate member becomes a modifier of the other member. Retain the
  // nominal owner and 필요 anchor; do not infer the actual legal/causal facts.
  for (const m of source.matchAll(/(?<![가-힣])([가-힣]{2,24})(?:과|와)\s+필요한\s+경우(?=\s)/gu)) {
    const stem = escape(m[1]);
    nominate('parallel_dependency_candidate', m,
      unique(output, new RegExp(`(?<![가-힣])${stem}에\\s+필요한(?=\\s)`, 'gu')));
  }
  // Regular consonant-stem connective alternation (좋으며→좋아, 적으며→적어)
  // can add a reason/result reading. A judge must distinguish it from a fluent
  // enumeration; this does not automatically declare causality or edit text.
  for (const m of source.matchAll(/(?<![가-힣])([가-힣]{1,24})으며(?=\s|,)/gu)) {
    const stem = escape(m[1]);
    nominate('coordination_causal_candidate',
      unique(source, new RegExp(`(?<![가-힣])${stem}으며(?=\\s|,)`, 'gu')),
      unique(output, new RegExp(`(?<![가-힣])${stem}(?:아|어)(?=\\s|,)`, 'gu')));
  }
  // Same predicate, necessary condition versus ordinary conditional. The
  // surrounding context can still preserve necessity elsewhere; nominate only.
  for (const [necessary, conditional, reverse] of [[source, output, false], [output, source, true]]) {
    for (const m of necessary.matchAll(/(?<![가-힣])([가-힣]{1,24}?)(해야|되어야|돼야|어야|아야)(?=\s|,)/gu)) {
      const endings = { 해야: '하면', 되어야: '되면', 돼야: '되면', 어야: '으면', 아야: '으면' };
      const right = unique(conditional, new RegExp(`(?<![가-힣])${escape(m[1])}${endings[m[2]]}(?=\\s|,)`, 'gu'));
      const left = unique(necessary, new RegExp(escape(m[0]), 'gu'));
      nominate('necessity_condition_candidate', reverse ? right : left, reverse ? left : right);
    }
  }
  // A named time frame does not by itself establish the actor of its event.
  // Do not substitute entities or infer historical responsibility here.
  for (const m of source.matchAll(/(?<![가-힣])([가-힣]{2,24})\s+(?:시기|시대|기간|당시)(?:에|에는)?(?=\s|,)/gu)) {
    nominate('temporal_actor_candidate', m,
      unique(output, new RegExp(`(?<![가-힣])${escape(m[1])}(?:이|가|은|는)(?=\\s)`, 'gu')));
  }
  return [...codes];
}
const instruction = 'action_exclusivity_candidate: 같은 행동에 새로 붙은 만이 다른 행동을 배제하는지 대조한다. 단지·오직 등 앞뒤의 동등한 한정이 있으면 정상일 수 있다. experienced_conditional_candidate: 실제로 경험하며 발견한 사건이 가정·반복 조건으로 바뀌었는지 시제와 뒤의 서술까지 확인한다. 일반 원리의 동의 표현이면 허용한다. purpose_simultaneity_candidate: 행동의 목적이 이미 진행 중인 동시 행동으로 바뀌었는지 목적 대상과 주체를 연결해 확인한다. 다른 문장에 같은 목적이 보존되면 누락으로 확정하지 않는다. 이 세 후보도 질문일 뿐이며 문맥상 의미가 유지되면 preserved, 실제 신규 오류만 근거 위치를 갖춘 violation으로 반환한다.';
const preservation = '배타 한정(만·오직)을 새로 붙이거나 과거 경험을 반복 조건으로, 목적을 동시 행동으로 바꾸지 않는다. 관계가 같은 의역·문장 분리는 허용한다.';
const coordinationInstruction = 'subject_exclusivity_candidate는 같은 주체의 만이와 일반 주격·주제격 사이 변화가 배타 범위를 바꾸는지 확인한다. 오직 등 동등 한정의 문맥 보존은 허용한다. parallel_dependency_candidate는 병렬 수단이 다른 수단에 필요한 종속 수단으로 바뀌었는지 주체·조건과 앞뒤 항목을 읽는다. coordination_causal_candidate는 -으며의 병렬이 -아/-어 연결로 바뀌어 이유·결과를 새로 부여했는지 확인한다. -아/-어가 단순 나열인 문맥도 있으므로 형태만으로 오류를 확정하지 않는다. 세 후보 모두 근거 있는 실제 의미 변화만 violation이며 의미 유지이면 preserved이다.';
const conditionActorInstruction = 'necessity_condition_candidate는 같은 술어의 -어야/-해야와 -면 사이에서 필요조건이 일반 조건으로 바뀌거나 그 반대가 되었는지 확인한다. 뒤 문장에 필요조건이 명시되면 정상일 수 있다. temporal_actor_candidate는 시기·시대·기간의 배경 명칭이 결과에서 행위 주체로 확정되었는지 실제 원문의 주체와 앞뒤 문맥을 대조한다. 원문에서 같은 주체가 이미 명시되면 preserved이며, 외부 상식으로 생략된 주체를 추정하지 않는다. 모두 검토 질문일 뿐이고 실제 관계 변화만 정확한 양쪽 근거와 함께 violation으로 반환한다.';
module.exports = { eventRelationOperators, instruction: instruction + '\n' + coordinationInstruction + '\n' + conditionActorInstruction, preservation };
