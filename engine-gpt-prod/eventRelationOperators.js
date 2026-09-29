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
  return [...codes];
}
const instruction = 'action_exclusivity_candidate: 같은 행동에 새로 붙은 만이 다른 행동을 배제하는지 대조한다. 단지·오직 등 앞뒤의 동등한 한정이 있으면 정상일 수 있다. experienced_conditional_candidate: 실제로 경험하며 발견한 사건이 가정·반복 조건으로 바뀌었는지 시제와 뒤의 서술까지 확인한다. 일반 원리의 동의 표현이면 허용한다. purpose_simultaneity_candidate: 행동의 목적이 이미 진행 중인 동시 행동으로 바뀌었는지 목적 대상과 주체를 연결해 확인한다. 다른 문장에 같은 목적이 보존되면 누락으로 확정하지 않는다. 이 세 후보도 질문일 뿐이며 문맥상 의미가 유지되면 preserved, 실제 신규 오류만 근거 위치를 갖춘 violation으로 반환한다.';
const preservation = '배타 한정(만·오직)을 새로 붙이거나 과거 경험을 반복 조건으로, 목적을 동시 행동으로 바꾸지 않는다. 관계가 같은 의역·문장 분리는 허용한다.';
module.exports = { eventRelationOperators, instruction, preservation };
