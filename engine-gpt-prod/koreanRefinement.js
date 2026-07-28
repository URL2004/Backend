'use strict';

const { splitSentences, koreanStart } = require('../engine/koreanText');
const layoutStructure = require('./layoutStructure');
const { restoreSourceSentenceOrdinals } = require('./sourceSentenceRestore');
const {
  alignedOutputCandidates,
  contentTokens: contentTokensLocal,
  normalizeSentence: normalizeSentenceLocal
} = require('./sentenceAlignment');

const VERSION = 11;
const PROFESSIONAL_PROFILES = new Set([
  'resume_application',
  'academic_paper',
  'report_assignment',
  'long_explainer',
  'clinical_record',
  'legal_contract',
  'student_record_teacher',
  'student_self_assessment'
]);

const ISSUE_DEFINITIONS = Object.freeze({
  missing_sentence_space: {
    weight: 3,
    repairable: true,
    deterministicSafe: true,
    message: '문장부호 뒤 띄어쓰기가 빠진 곳이 있어요.'
  },
  closed_quote_spacing: {
    weight: 2,
    repairable: true,
    deterministicSafe: true,
    message: '닫는 따옴표 뒤에 이어지는 본문과 띄어쓰기가 빠졌어요.'
  },
  closed_quote_particle_spacing: {
    weight: 3,
    repairable: true,
    deterministicSafe: true,
    message: '닫는 따옴표 뒤의 조사·서술격이 불필요하게 떨어져 있어요.'
  },
  message_spelling: {
    weight: 2,
    repairable: true,
    deterministicSafe: true,
    message: '“메시지”의 표기를 바로잡아야 해요.'
  },
  numeric_parenthesis_join: {
    weight: 3,
    repairable: true,
    deterministicSafe: true,
    message: '수량 표기 뒤의 단어가 붙어 있어요.'
  },
  deep_understanding_collocation: {
    weight: 2,
    repairable: true,
    deterministicSafe: true,
    message: '“깊게 이해”보다 “깊이 이해”가 자연스러운 문맥이 있어요.'
  },
  practice_class_spacing: {
    weight: 2,
    repairable: true,
    deterministicSafe: true,
    message: '“실습 수업”의 띄어쓰기를 확인해 주세요.'
  },
  frequency_quantifier_conflict: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '“그때마다”와 “자주”처럼 빈도 표현이 서로 충돌해요.'
  },
  awkward_focus_attachment: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '“어떻게 …지도 중심에 두고”의 초점 연결이 어색해요.'
  },
  quote_attribution_particle_mismatch: {
    weight: 4,
    repairable: true,
    deterministicSafe: false,
    message: '직접 인용 뒤의 조사와 입장·주장 표현이 자연스럽게 연결되지 않아요.'
  },
  double_topic_chain: {
    weight: 4,
    repairable: true,
    deterministicSafe: false,
    message: '한 절에 “나는 …은/는”처럼 주제가 겹쳐 주어와 서술어 관계가 어색해요.'
  },
  malformed_question_ending: {
    weight: 4,
    repairable: true,
    deterministicSafe: false,
    message: '의문·간접의문 어미가 잘못 결합된 것으로 보이는 표현이 있어요.'
  },
  value_participation_collocation: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '가치·취지에 “함께하다”가 직접 연결돼 연어가 어색해요.'
  },
  scope_expansion_collocation: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '소비·수요·이용 범위를 “넓어지다”로 표현해 결합이 어색해요.'
  },
  professional_register_downgrade: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '장르에 필요한 전문 어휘가 지나치게 일상적인 말로 낮아졌어요.'
  },
  directional_growth_collocation: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '태도·역량이 특정 “쪽으로 성장했다”는 연결이 어색해요.'
  },
  causal_predicate_stack: {
    weight: 5,
    repairable: true,
    deterministicSafe: false,
    message: '결과와 원인을 한 서술어에 겹쳐 연결해 주어·서술어 관계가 어색해요.'
  },
  nominal_predicate_collocation: {
    weight: 5,
    repairable: true,
    deterministicSafe: false,
    message: '분석·입지 같은 명사와 서술어의 결합이 문맥에 맞지 않아요.'
  },
  case_frame_corruption: {
    weight: 5,
    repairable: true,
    deterministicSafe: false,
    message: '조사와 서술어가 요구하는 논항 구조가 어긋났어요.'
  },
  meta_nominalization_injection: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '직접적인 문장을 “~한 것은 ~하는 점” 구조로 불필요하게 늘였어요.'
  },
  role_predicate_redundancy: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '맡다·담당하다처럼 같은 역할 서술어가 한 문장에 겹쳐요.'
  },
  analytic_object_recast: {
    weight: 4,
    repairable: true,
    deterministicSafe: false,
    message: '분석 대상을 비슷한 “내용·자료”로 다시 받아 목적어 관계가 흐려졌어요.'
  },
  enumeration_parallelism: {
    weight: 2,
    repairable: true,
    deterministicSafe: false,
    message: '첫째·둘째 항목의 문법 역할과 서술 형식이 서로 맞지 않아요.'
  },
  student_record_fragment: {
    weight: 4,
    repairable: true,
    deterministicSafe: false,
    message: '세특 문장이 짧은 명사형 조각으로 분리돼 맥락이 끊겼어요.'
  },
  functional_greeting_duplication: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '공식문 첫머리에 같은 역할의 인사가 연달아 들어갔어요.'
  },
  adjacent_semantic_repetition: {
    weight: 2,
    repairable: true,
    deterministicSafe: false,
    message: '서로 이웃한 문장이 같은 내용을 표현만 바꿔 반복해요.'
  },
  source_token_repetition_review: {
    weight: 1,
    repairable: false,
    deterministicSafe: false,
    message: '원문에 같은 한글 조각이 겹쳐 입력된 것으로 보이는 단어가 있어요.'
  },
  data_document_collocation: {
    weight: 4,
    repairable: true,
    deterministicSafe: false,
    message: '데이터가 보고서·논문을 작성하는 것처럼 연결된 문장의 주어·목적어 관계가 어색해요.'
  },
  feedback_exchange_collocation: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '피드백 자체를 반복했다기보다 주고받은 과정이 드러나도록 연결해야 해요.'
  },
  self_evaluation_repetition: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '자기평가형 결론과 “노력했습니다”가 반복돼 실제 행동이나 근거가 약해 보여요.'
  },
  overloaded_research_action_chain: {
    weight: 2,
    repairable: true,
    deterministicSafe: false,
    message: '한 문장에 연구 행동이 너무 많이 연결돼 주어·서술어 관계와 호흡이 무거워요.'
  },
  formal_register_residual: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '공식 문서의 핵심 서술에 구어적 별칭이나 과장된 게임·군사 은유가 남아 있어요.'
  },
  purpose_modifier_collocation: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '목적을 나타내는 관형 표현이 빠져 정책·제도의 수식 관계가 어색해요.'
  },
  metacognitive_predicate_stack: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '“고민하게 된다고 생각했다”처럼 인지 서술어가 겹쳐 문장이 부자연스러워요.'
  },
  dialogue_give_collocation: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '대화를 일방적으로 건넨다고 표현해 상호행위의 연어가 어색해요.'
  },
  sampling_subject_mismatch: {
    weight: 4,
    repairable: true,
    deterministicSafe: false,
    message: '표집 대상이 스스로 표집한 것처럼 주어와 서술어가 연결됐어요.'
  },
  tool_personification: {
    weight: 2,
    repairable: true,
    deterministicSafe: false,
    message: '도구·플랫폼의 기능을 사람에게 호의를 베푸는 것처럼 표현했어요.'
  },
  passive_causative_stack: {
    weight: 4,
    repairable: true,
    deterministicSafe: false,
    message: '“재의미화되게 하다”처럼 피동·사동 표현이 겹쳐 학술 문장이 부자연스러워요.'
  },
  double_object_time_expenditure: {
    weight: 4,
    repairable: true,
    deterministicSafe: false,
    message: '매체·콘텐츠와 시간을 동시에 목적어로 둬 서술어의 논항 관계가 어색해요.'
  },
  persistent_state_tense_regression: {
    weight: 4,
    repairable: true,
    deterministicSafe: false,
    message: '현재까지 이어지는 상태가 변환 과정에서 과거에 끝난 상태처럼 바뀌었어요.'
  },
  orphan_structural_particle: {
    weight: 5,
    repairable: true,
    deterministicSafe: true,
    message: '제목·항목명과 본문 사이에서 조사가 홀로 떨어져 문장이 깨졌어요.'
  },
  introduced_token_duplication: {
    weight: 5,
    repairable: true,
    deterministicSafe: true,
    message: '변환 과정에서 같은 한글 조각이 연달아 붙은 오타가 생겼어요.'
  },
  reciprocal_expression_redundancy: {
    weight: 4,
    repairable: true,
    deterministicSafe: true,
    message: '“서로 상호작용”처럼 같은 상호 의미가 겹쳐 있어요.'
  },
  benefit_help_predicate_redundancy: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '“도움을 받을 수 있게 돕다”처럼 도움 의미가 한 문장에 겹쳐 있어요.'
  },
  contrast_clause_attachment: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '“~하며 ~하기보다”의 비교 대상과 앞 절이 어색하게 연결됐어요.'
  },
  missing_subject_particle: {
    weight: 4,
    repairable: true,
    deterministicSafe: true,
    message: '핵심 명사 뒤의 주격 조사가 빠져 주어와 서술어 연결이 어색해요.'
  },
  repeated_clause_anchor: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '같은 시간·과정 절이 한 문장 안에서 불필요하게 되풀이돼요.'
  },
  purpose_case_frame: {
    weight: 4,
    repairable: true,
    deterministicSafe: true,
    message: '“목적에 두다”의 조사 틀이 어색해 목적 관계가 분명하지 않아요.'
  },
  quote_terminal_punctuation_review: {
    weight: 1,
    repairable: false,
    deterministicSafe: false,
    message: '독립된 인용문 끝의 문장부호가 빠졌는지 확인해 주세요.'
  },
  future_role_tense_review: {
    weight: 1,
    repairable: false,
    deterministicSafe: false,
    message: '지원 이후의 역할을 설명하는 문장에서 과거 시제가 쓰였는지 확인해 주세요.'
  },
  resume_weakness_mitigation_review: {
    weight: 1,
    repairable: false,
    deterministicSafe: false,
    message: '약점 보완책이 단순히 마감 시간을 더 확보하는 방식인지 확인해 주세요.'
  },
  public_service_employment_term_review: {
    weight: 1,
    repairable: false,
    deterministicSafe: false,
    message: '지원기관 유형에 따라 “입사 후”와 “임용 후·입직 후” 중 맞는 용어인지 확인해 주세요.'
  },
  repeated_vague_demonstrative: {
    weight: 1,
    repairable: false,
    deterministicSafe: false,
    message: '가리키는 대상이 불분명한 지시 표현이 반복돼요.'
  },
  list_marker_spacing: {
    weight: 2,
    repairable: false,
    deterministicSafe: false,
    message: '목록 기호 뒤 띄어쓰기를 확인해 주세요.'
  }
});

const PARTICLE_AFTER_PAREN = /^(?:은|는|이|가|을|를|의|에|에서|에게|으로|로|와|과|도|만|부터|까지|처럼|보다|라고|라는|라며|하고)(?=$|[가-힣])/u;
const QUOTE_COPULA_SUFFIX = '(?:라(?:고|는|며|면)|인(?:가|데|지|바|셈|것|경우|만큼|듯|채|줄)?|이(?:라(?:고|는|며|면)?|란|지(?:만)?|다|고|며|어서|므로|었(?:다|던|고|지만|으면|다면|다는|을|는데|으며)?|었던)|였(?:다|던|고|지만|으면|다면|다는|을|는데|으며)?|일(?:수|지|까|뿐|때|경우)?|임(?:을|이|은|도)?)';
const QUOTE_PARTICLE_SUFFIX = '(?:에서|에게|으로|처럼|보다|부터|까지|하고|하며|은|는|이|가|을|를|의|에|와|과|도|만|로|고)';
const QUOTE_NON_ATTRIBUTION_PARTICLE_SUFFIX = '(?:에서|에게|으로|처럼|보다|부터|까지|은|는|이|가|을|를|의|에|와|과|도|만|로|고)';
const QUOTE_ATTACHED_SUFFIX = `(?:${QUOTE_COPULA_SUFFIX}|${QUOTE_PARTICLE_SUFFIX})`;
const QUOTE_TIGHT_SUFFIX = QUOTE_ATTACHED_SUFFIX;
const QUOTE_NON_ATTRIBUTION_TIGHT_SUFFIX = `(?:${QUOTE_COPULA_SUFFIX}|${QUOTE_NON_ATTRIBUTION_PARTICLE_SUFFIX})`;
const CLOSE_QUOTE_CLASS = '[”’」』》〉]';
const QUOTE_SUFFIX_BOUNDARY = '(?=$|[\\s,.;:!?。！？])';
const CLOSED_QUOTE_SPACING_RE = new RegExp(`([”’」』》〉])(?!${QUOTE_ATTACHED_SUFFIX}(?=$|[\\s,.;:!?。！？]))(?=[가-힣A-Za-z0-9])`, 'gu');
// 완결된 직접 발화 뒤의 “... .” 하고/하며는 인용 뒤 독립 용언이므로
// 띄어쓰기를 유지한다. 명사 인용의 ‘학생’하고와 서술격 ‘전환점’이었다는
// 계속 붙여 쓰도록 두 문법을 분리한다.
const CLOSED_QUOTE_PARTICLE_GAP_RE = new RegExp(
  `(?:(${CLOSE_QUOTE_CLASS})[ \\t]+(?=${QUOTE_NON_ATTRIBUTION_TIGHT_SUFFIX}${QUOTE_SUFFIX_BOUNDARY})`
  + `|(${CLOSE_QUOTE_CLASS})(?<![.!?。！？…]${CLOSE_QUOTE_CLASS})[ \\t]+(?=(?:하고|하며)${QUOTE_SUFFIX_BOUNDARY}))`,
  'gu'
);
const QUOTE_TERMINAL_REVIEW_RE = new RegExp(`[‘“][^’”\\n]{2,120}(?<![.!?。！？…])[’”](?!${QUOTE_ATTACHED_SUFFIX}(?=$|[\\s,.;:!?。！？]))(?=[가-힣A-Za-z0-9])`, 'gu');
const REFERENCE_HEADING_RE = /^(?:참고\s*문헌|참고\s*자료|인용\s*문헌|출처|References|Bibliography|Works\s+Cited)$/iu;
const APPENDIX_HEADING_RE = /^(?:부록|Appendix)(?:\s+[A-Za-z0-9가-힣.-]+)?$/iu;
const NEW_UNIT_START_RE = /^(?:그리고|그러나|하지만|또한|따라서|한편|반면|이러한|이번|다음|첫째|둘째|셋째|마지막으로)(?=$|\s)/u;
const HADA_NOUNS = [
  '구성', '재구성', '분석', '탐구', '조사', '연구', '설명', '정리', '확인', '검토',
  '수행', '제시', '진행', '활용', '비교', '평가', '측정', '고려', '이해', '해석', '관찰',
  '파악', '적용', '제안', '계획', '실천', '선택', '작성', '참여', '기록', '발표', '발견',
  '추론', '복원', '판단'
];
const DURING_NOUNS = [
  '수업', '회의', '작업', '사용', '진행', '탐구', '학습', '근무', '운전', '공사', '시험', '준비', '치료', '상담', '통화', '출장', '여행'
];

/**
 * 의미 심사 후에도 안전하게 실행할 수 있는 형식 보정이다.
 * 문자의 순서나 내용은 바꾸지 않고 공백만 추가·삭제한다.
 * 논문명·인용·참고문헌·표·코드와 창작문 행갈이는 보호한다.
 */
function applySafeFormattingRepairs({ source = '', outputText = '', documentProfile = null } = {}) {
  const before = String(outputText || '');
  const context = formattingContext(documentProfile);
  if (!before || context.creative) {
    return emptyFormattingResult(before, context.creative ? 'creative_line_structure' : 'empty');
  }

  const boundary = repairBrokenProseBoundaries(before, context);
  const siblingLabels = repairSiblingLabelSpacing(boundary.text, source);
  const spacing = repairContextualSpacing(siblingLabels.text, source, context);
  const changeCounts = mergeChangeCounts(boundary.changeCounts, siblingLabels.changeCounts, spacing.changeCounts);
  const changeCodes = Object.keys(changeCounts).filter(code => changeCounts[code] > 0);
  return {
    version: 1,
    text: spacing.text,
    applied: spacing.text !== before,
    changeCount: Object.values(changeCounts).reduce((sum, count) => sum + count, 0),
    changeCodes,
    changeCounts,
    brokenLineBreakRepairCount: Number(changeCounts.broken_prose_linebreak || 0),
    brokenParagraphBreakRepairCount: Number(changeCounts.broken_prose_paragraph_break || 0),
    excessiveBlankLineRepairCount: Number(changeCounts.excess_blank_lines || 0),
    contextualSpacingRepairCount: changeCodes
      .filter(code => !['broken_prose_linebreak', 'broken_prose_paragraph_break', 'excess_blank_lines'].includes(code))
      .reduce((sum, code) => sum + Number(changeCounts[code] || 0), 0),
    skipped: false,
    reason: '',
    profile: context.profile
  };
}

function repairBrokenProseBoundaries(value, context) {
  const lines = String(value || '').replace(/\r\n?/gu, '\n').split('\n');
  const guards = buildLineGuards(lines);
  const counts = {};
  let output = '';
  let index = 0;
  while (index < lines.length) {
    const current = lines[index];
    let next = index + 1;
    while (next < lines.length && !lines[next].trim()) next += 1;
    if (next >= lines.length) {
      output += current;
      if (index < lines.length - 1) output += '\n'.repeat(lines.length - index - 1);
      break;
    }

    const boundarySize = next - index;
    const join = !guards[index]?.protected
      && !guards[next]?.protected
      && isBrokenProseBoundary(current, lines[next]);
    if (join) {
      output += `${current.trimEnd()} `;
      lines[next] = lines[next].trimStart();
      addCount(counts, boundarySize >= 2 ? 'broken_prose_paragraph_break' : 'broken_prose_linebreak');
    } else {
      output += current;
      const capped = Math.min(boundarySize, 2);
      output += '\n'.repeat(capped);
      if (boundarySize > 2 && !guards[index]?.code && !guards[next]?.code) {
        addCount(counts, 'excess_blank_lines', boundarySize - capped);
      }
    }
    index = next;
  }
  return { text: output, changeCounts: counts };
}

function isBrokenProseBoundary(leftValue, rightValue) {
  const left = String(leftValue || '').trim();
  const right = String(rightValue || '').trim();
  if (!left || !right) return false;
  if (isStandaloneStructureLine(left) || isStandaloneStructureLine(right)) return false;
  if (/[.!?。！？…,:;：；]\s*[”’》』〉》"')\]]*$/u.test(left)) return false;
  if (!/^[A-Za-z가-힣("'“‘]/u.test(right) || NEW_UNIT_START_RE.test(right)) return false;
  const token = (left.replace(/[”’》』〉》"')\]]+$/u, '').match(/[가-힣]+$/u) || [''])[0];
  if (!token) return false;
  if (token.length >= 2 && /(?:을|를)$/u.test(token)) return true;
  if (token.length >= 3 && /(?:은|는|이|가)$/u.test(token)) return true;
  if (/(?:하는|되는|된|할|했던|위한|대한|관한|필요한|가능한)$/u.test(token)) return true;
  return /^(?:수|및|그리고|그러나|하지만|또한|때문에|위해|통해)$/u.test(token);
}

function repairContextualSpacing(value, source, context) {
  const lines = String(value || '').split('\n');
  const guards = buildLineGuards(lines);
  const sourceTitle = firstDocumentTitle(source);
  const counts = {};
  const repaired = lines.map((line, index) => {
    const guard = guards[index] || {};
    if (guard.code || guard.reference || guard.table) return line;
    let workingLine = line;
    if (guard.role === 'prose') {
      const trimmed = workingLine.replace(/^[ \t]+|[ \t]+$/gu, '');
      if (trimmed !== workingLine) addCount(counts, 'prose_edge_whitespace');
      workingLine = trimmed;
    }
    const protectWholeTitle = guard.title && sourceTitle && normalizeForTitle(workingLine) === normalizeForTitle(sourceTitle);
    if (protectWholeTitle) return line;
    workingLine = replaceTracked(
      workingLine,
      CLOSED_QUOTE_SPACING_RE,
      (_match, closing) => `${closing} `,
      'closed_quote_spacing',
      counts
    );
    workingLine = replaceTracked(
      workingLine,
      CLOSED_QUOTE_PARTICLE_GAP_RE,
      (_match, closing) => closing,
      'closed_quote_particle_spacing',
      counts
    );
    return replaceOutsideProtectedRanges(workingLine, segment => {
      let out = segment;
      out = replaceTracked(out, /([.!?。！？])(?=[가-힣])/gu, (_match, mark) => `${mark} `, 'missing_sentence_space', counts);
      out = replaceTracked(out, /(\d+(?:[.,]\d+)?(?:가지|개|명|건|번|년|월|일|%|％|점|배|시간|분)[)）])([가-힣]{1,20})/gu, (match, left, right) => {
        return PARTICLE_AFTER_PAREN.test(right) ? match : `${left} ${right}`;
      }, 'numeric_parenthesis_join', counts);
      out = replaceTracked(
        out,
        /보여(?=(?:주(?=$|[가-힣])|(?:준|줄|줬|줘|줍|줌)(?=$|[^A-Za-z0-9_])))/gu,
        () => '보여 ',
        'show_auxiliary_spacing',
        counts
      );
      out = replaceTracked(out, /(^|[^가-힣A-Za-z0-9_])한걸음(?=(?:에서|으로|부터|까지|은|는|이|가|을|를|의|에|로|와|과|도|만)?(?:$|[^가-힣A-Za-z0-9_]))/gu, (_match, prefix) => `${prefix}한 걸음`, 'one_step_spacing', counts);
      out = replaceTracked(out, /실습[ \t]*수업/gu, () => '실습 수업', 'practice_class_spacing', counts);
      out = replaceTracked(out, /지속[ \t]*이용[ \t]*의도/gu, () => '지속 이용 의도', 'continued_use_intent_spacing', counts);
      out = replaceTracked(out, /(^|[^가-힣A-Za-z0-9_])가치소비(?=(?:에서|으로|부터|까지|은|는|이|가|을|를|의|에|로|와|과|도|만)?(?:$|[^가-힣A-Za-z0-9_]))/gu, (_match, prefix) => `${prefix}가치 소비`, 'value_consumption_spacing', counts);
      const during = new RegExp(`(^|[^가-힣A-Za-z0-9_])(${DURING_NOUNS.join('|')})중(?=(?:은|는|이|가|을|를|에|에서|에도|에는|의|으로|로|부터|까지|인|이었|이다|$|[^가-힣]))`, 'gu');
      out = replaceTracked(out, during, (_match, prefix, noun) => `${prefix}${noun} 중`, 'dependent_noun_jung_spacing', counts);
      const hada = new RegExp(`(^|[^가-힣A-Za-z0-9_])(${HADA_NOUNS.join('|')})[ \\t]+하(?=(?:였|고|며|는|여|도록|기|자|다|려고|려|면|게|지))`, 'gu');
      out = replaceTracked(out, hada, (_match, prefix, noun) => `${prefix}${noun}하`, 'noun_hada_spacing', counts);
      return out;
    });
  });
  return { text: repaired.join('\n'), changeCounts: counts };
}

function buildLineGuards(lines) {
  const guards = [];
  const plainTableLines = detectPlainTextTableLines(lines);
  let code = false;
  let reference = false;
  const firstContent = lines.findIndex(line => String(line || '').trim());
  const nextContentAfter = index => {
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (String(lines[cursor] || '').trim()) return { text: String(lines[cursor]).trim() };
    }
    return null;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const text = String(lines[index] || '').trim();
    const fence = /^(?:```|~~~)/u.test(text);
    if (fence) code = !code;
    if (APPENDIX_HEADING_RE.test(text)) reference = false;
    if (REFERENCE_HEADING_RE.test(text)) reference = true;
    const role = text ? layoutStructure.classifyLine(text, {
      firstContent: index === firstContent,
      next: nextContentAfter(index),
      blankBefore: index === 0 || !String(lines[index - 1] || '').trim()
    }) : 'blank';
    const nextContent = nextContentAfter(index)?.text || '';
    const brokenTitleFragment = role === 'title' && isBrokenProseBoundary(text, nextContent);
    guards.push({
      code,
      reference,
      role,
      title: role === 'title',
      table: role === 'table' || plainTableLines.has(index),
      protected: code || reference || plainTableLines.has(index)
        || ((!brokenTitleFragment) && ['title', 'heading', 'label', 'label_inline', 'list', 'table', 'quote'].includes(role))
    });
  }
  return guards;
}

/**
 * 워드·PDF에서 복사한 표는 파이프나 탭 없이 `표 N. 제목` 다음에 셀마다
 * 한 줄씩 놓이는 경우가 많다. 개별 셀을 산문으로 오인해 합치지 않도록,
 * 표 캡션 다음의 선택적 빈 줄과 표 본문을 첫 문단 경계까지 보호한다.
 */
function detectPlainTextTableLines(lines) {
  const protectedLines = new Set();
  let inTable = false;
  let seenBody = false;
  let pendingBlank = [];
  for (let index = 0; index < lines.length; index += 1) {
    const text = String(lines[index] || '').trim();
    if (!inTable && /^표\s*[0-9A-Za-z가-힣.-]+(?:\s|$)/u.test(text)) {
      inTable = true;
      seenBody = false;
      pendingBlank = [];
      protectedLines.add(index);
      continue;
    }
    if (!inTable) continue;
    if (!text) {
      if (seenBody) {
        inTable = false;
        seenBody = false;
        pendingBlank = [];
        continue;
      }
      pendingBlank.push(index);
      if (pendingBlank.length >= 2) {
        inTable = false;
        seenBody = false;
        pendingBlank = [];
      }
      continue;
    }
    for (const blankIndex of pendingBlank) protectedLines.add(blankIndex);
    pendingBlank = [];
    protectedLines.add(index);
    seenBody = true;
  }
  return protectedLines;
}

function isStandaloneStructureLine(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  const role = layoutStructure.classifyLine(text);
  if (['heading', 'label', 'label_inline', 'list', 'table', 'quote'].includes(role)) return true;
  return /^(?:\(?\d{1,3}\)?[.)]\s+|[IVXLCDM]+ ?[.)]\s+|[①-⑳]\s*)/iu.test(text);
}

function replaceOutsideProtectedRanges(line, transform) {
  const ranges = inlineProtectedRanges(line);
  if (!ranges.length) return transform(line);
  let output = '';
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) output += transform(line.slice(cursor, range.start));
    output += line.slice(range.start, range.end);
    cursor = range.end;
  }
  if (cursor < line.length) output += transform(line.slice(cursor));
  return output;
}

function inlineProtectedRanges(line) {
  const patterns = [
    /https?:\/\/[^\s<>()]+/giu,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    /`[^`\n]+`/gu,
    /\[[^\]\n]+\]\([^\n)]+\)/gu,
    /[「『〈《“‘][^」』〉》”’\n]{1,240}[」』〉》”’]/gu,
    /"[^"\n]{1,240}"/gu,
    /'[^'\n]{1,240}'/gu
  ];
  const ranges = [];
  for (const pattern of patterns) {
    for (const match of String(line || '').matchAll(pattern)) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (!last || range.start > last.end) merged.push({ ...range });
    else last.end = Math.max(last.end, range.end);
  }
  return merged;
}

function firstDocumentTitle(value) {
  const lines = String(value || '').replace(/\r\n?/gu, '\n').split('\n');
  const firstIndex = lines.findIndex(line => String(line || '').trim());
  if (firstIndex < 0) return '';
  const text = lines[firstIndex].trim();
  const next = lines.slice(firstIndex + 1).map(line => String(line || '').trim()).find(Boolean);
  const role = layoutStructure.classifyLine(text, {
    firstContent: true,
    next: next ? { text: next } : null,
    blankBefore: true
  });
  return role === 'title' ? text : '';
}

function formattingContext(documentProfile) {
  const profile = profileName(documentProfile);
  const flags = new Set(documentProfile?.formatProfile?.flags || []);
  return {
    profile,
    creative: profile === 'creative' || flags.has('creative_lines') || flags.has('line_sensitive')
  };
}

function replaceTracked(text, pattern, replacement, code, counts) {
  return String(text || '').replace(pattern, (...args) => {
    const before = args[0];
    const after = replacement(...args);
    if (after !== before) addCount(counts, code);
    return after;
  });
}

function addCount(counts, code, amount = 1) {
  counts[code] = (counts[code] || 0) + Number(amount || 0);
}

function mergeChangeCounts(...items) {
  const merged = {};
  for (const item of items) {
    for (const [code, count] of Object.entries(item || {})) addCount(merged, code, count);
  }
  return merged;
}

function normalizeForTitle(value) {
  return String(value || '').replace(/\s+/gu, '');
}

function emptyFormattingResult(text, reason) {
  return {
    version: 1,
    text: String(text || ''),
    applied: false,
    changeCount: 0,
    changeCodes: [],
    changeCounts: {},
    brokenLineBreakRepairCount: 0,
    brokenParagraphBreakRepairCount: 0,
    excessiveBlankLineRepairCount: 0,
    contextualSpacingRepairCount: 0,
    skipped: true,
    reason,
    profile: ''
  };
}

function analyzeKoreanRefinement({ source = '', outputText = '', documentProfile = null, mode = '' } = {}) {
  const profile = profileName(documentProfile);
  const targetRegister = String(documentProfile?.targetRegister || documentProfile?.tonePolicy || '');
  const sourceIssues = detectTextIssues(source, { profile, targetRegister, includeSourceNotation: true });
  const outputIssues = detectTextIssues(outputText, { profile, targetRegister, includeSourceNotation: false });
  const duplicated = detectIntroducedTokenDuplications(source, outputText);
  if (duplicated) outputIssues.push(duplicated);
  const fragment = detectIntroducedStudentRecordFragments(source, outputText, profile);
  if (fragment) outputIssues.push(fragment);
  const adjacentRepetition = detectIntroducedAdjacentSemanticRepetition(source, outputText);
  if (adjacentRepetition) outputIssues.push(adjacentRepetition);
  const professional = detectProfessionalDowngrade(source, outputText, profile);
  if (professional) outputIssues.push(professional);
  const persistentTense = detectIntroducedPersistentStateTenseRegression(source, outputText);
  if (persistentTense) outputIssues.push(persistentTense);
  const rows = mergeIssueComparison(sourceIssues, outputIssues);
  const repairableIssues = rows.filter(item => item.afterCount > 0 && item.repairable);
  const residualWarnings = rows
    // 원문부터 있던 표현은 sourceReviewWarnings에서 안내한다. 변환이 새로
    // 만들거나 개수를 늘린 오류만 결과 품질 경고로 올려 source-origin
    // double topic·연어 문제를 엔진 사고로 중복 표시하지 않는다.
    .filter(item => item.introducedCount > 0)
    .map(item => qualityWarning(item));
  return {
    version: VERSION,
    profile,
    targetRegister,
    mode: String(mode || ''),
    pass: repairableIssues.length === 0,
    issueCount: rows.reduce((sum, item) => sum + item.afterCount, 0),
    repairableIssueCount: repairableIssues.reduce((sum, item) => sum + item.afterCount, 0),
    introducedIssueCount: rows.reduce((sum, item) => sum + item.introducedCount, 0),
    weightedRisk: rows.reduce((sum, item) => sum + item.afterCount * item.weight, 0),
    issueCodes: rows.filter(item => item.afterCount > 0).map(item => item.code),
    repairableCodes: repairableIssues.map(item => item.code),
    issues: rows,
    repairableIssues,
    residualWarnings,
    sourceReviewWarnings: buildSourceReviewWarnings(sourceIssues)
  };
}

function detectTextIssues(value, { profile = 'unknown', targetRegister = '', includeSourceNotation = false } = {}) {
  const text = String(value || '').replace(/\r\n?/gu, '\n');
  const issues = [];
  pushOrphanStructuralParticleIssue(issues, text);
  pushPatternIssue(issues, text, 'missing_sentence_space', /[.!?。！？](?=[가-힣])/gu);
  pushPatternIssue(issues, text, 'closed_quote_spacing', CLOSED_QUOTE_SPACING_RE);
  pushPatternIssue(issues, text, 'closed_quote_particle_spacing', CLOSED_QUOTE_PARTICLE_GAP_RE);
  pushPatternIssue(issues, text, 'message_spelling', /메세지/gu);
  pushNumericParenthesisIssue(issues, text);
  pushPatternIssue(issues, text, 'deep_understanding_collocation', /깊게\s+이해(?:하|했|되|할|하려|하고|하며|해서|해)/gu);
  pushPatternIssue(issues, text, 'practice_class_spacing', /실습수업/gu);
  pushSentenceIssue(issues, text, 'frequency_quantifier_conflict', sentence => /(?:그때마다|매번)[^.!?。！？\n]{0,90}(?:자주|종종|가끔)/u.test(sentence));
  pushSentenceIssue(issues, text, 'awkward_focus_attachment', sentence => /어떻게[^.!?。！？\n]{0,70}(?:지도|지를)\s*중심에\s*두고/u.test(sentence));
  pushSentenceIssue(issues, text, 'quote_attribution_particle_mismatch', hasQuoteAttributionParticleMismatch);
  pushSentenceIssue(issues, text, 'double_topic_chain', hasDoubleTopicChain);
  pushPatternIssue(issues, text, 'malformed_question_ending', /저는지/gu);
  pushSentenceIssue(issues, text, 'value_participation_collocation', hasValueParticipationCollocation);
  pushSentenceIssue(issues, text, 'scope_expansion_collocation', hasScopeExpansionCollocation);
  pushSentenceIssue(issues, text, 'data_document_collocation', hasDataDocumentCollocation);
  pushSentenceIssue(issues, text, 'feedback_exchange_collocation', sentence => /피드백(?:을|를)?\s*(?:여러\s*차례\s*)?반복(?:하|했|해|하며|해서|하고)/u.test(sentence));
  pushSentenceIssue(issues, text, 'purpose_modifier_collocation', hasPurposeModifierCollocation);
  pushSentenceIssue(issues, text, 'metacognitive_predicate_stack', sentence => /고민(?:을|해|하)?[^.!?。！？\n]{0,24}하게\s*된다고\s*생각(?:하|했|해|합)/u.test(sentence));
  pushSentenceIssue(issues, text, 'dialogue_give_collocation', sentence => /대화(?:를)?\s*(?:건네|건넸|건넨|건넬)/u.test(sentence));
  pushSentenceIssue(issues, text, 'sampling_subject_mismatch', sentence => /(?:시|자료|문헌|표본|사례)(?:은|는)\s*(?:기준[^.!?。！？\n]{0,70})?목적\s*표집(?:하|했|해)/u.test(sentence));
  pushSentenceIssue(issues, text, 'tool_personification', sentence => /(?:플랫폼|시스템|도구|프로그램|모형)(?:이|가)[^.!?。！？\n]{0,70}(?:연결|제공|분석|정리|보여|알려)해\s*주/u.test(sentence));
  pushSentenceIssue(
    issues,
    text,
    'passive_causative_stack',
    sentence => /(?:재의미화|의미화|구조화|체계화|시각화|구체화|명료화|일반화|정당화|객관화|재구성)되게\s*(?:하|한|해|했|합|하고|하며|하도록|만들)/u.test(sentence)
  );
  pushSentenceIssue(
    issues,
    text,
    'double_object_time_expenditure',
    sentence => /(?:매체|미디어|콘텐츠|플랫폼|서비스)(?:을|를)\s+[^.!?。！？\n]{0,36}시간(?:을|를)\s+(?:들이|들여|들이며|보내며)[^.!?。！？\n]{0,36}(?:접하|이용하|사용하|살아가)/u
      .test(stripProtectedQuotedText(sentence))
  );
  pushSentenceIssue(issues, text, 'reciprocal_expression_redundancy', sentence => /서로\s+상호(?=(?:작용|교류|소통|협력|의존|영향))/u.test(stripProtectedQuotedText(sentence)));
  pushSentenceIssue(issues, text, 'benefit_help_predicate_redundancy', hasBenefitHelpPredicateRedundancy);
  pushSentenceIssue(issues, text, 'contrast_clause_attachment', hasContrastClauseAttachment);
  if (!['clinical_record', 'student_record_teacher', 'creative', 'legal_contract'].includes(profile)) {
    pushSentenceIssue(issues, text, 'missing_subject_particle', hasMissingSubjectParticle);
  }
  pushSentenceIssue(issues, text, 'repeated_clause_anchor', hasRepeatedClauseAnchor);
  pushSentenceIssue(issues, text, 'purpose_case_frame', hasPurposeCaseFrame);
  pushSentenceIssue(issues, text, 'directional_growth_collocation', sentence => /(?:연구\s*)?(?:태도|역량|관점|시각)(?:은|는|이|가)?[^.!?。！？\n]{0,38}(?:쪽|방향)으로\s*성장(?:하|했|해|합)/u.test(sentence));
  pushSentenceIssue(issues, text, 'causal_predicate_stack', hasCausalPredicateStack);
  pushSentenceIssue(issues, text, 'nominal_predicate_collocation', hasNominalPredicateCollocation);
  pushSentenceIssue(issues, text, 'case_frame_corruption', hasCaseFrameCorruption);
  pushSentenceIssue(issues, text, 'meta_nominalization_injection', hasMetaNominalizationInjection);
  pushSentenceIssue(issues, text, 'role_predicate_redundancy', hasRolePredicateRedundancy);
  pushSentenceIssue(issues, text, 'analytic_object_recast', hasAnalyticObjectRecast);
  pushEnumerationParallelismIssue(issues, text);
  if (profile === 'mail_notice') pushFunctionalGreetingDuplication(issues, text);
  if (isFormalRegisterTarget(targetRegister, profile)) {
    pushFormalRegisterResidual(issues, text, { profile, targetRegister });
  }
  pushSelfEvaluationRepetition(issues, text);
  if (/(?:연구|실험|공정|시편|분석\s*장비)/u.test(text)) {
    pushSentenceIssue(issues, text, 'overloaded_research_action_chain', isOverloadedResearchActionChain);
  }
  pushRepeatedVagueDemonstrative(issues, text);
  if (includeSourceNotation) {
    pushPatternIssue(issues, text, 'list_marker_spacing', /^(?:[-*•▪◦]|\d+[.)])(?=\S)/gmu);
    pushPatternIssue(issues, text, 'quote_terminal_punctuation_review', QUOTE_TERMINAL_REVIEW_RE);
    pushSourceTokenRepetitionReview(issues, text);
    pushSentenceIssue(issues, text, 'future_role_tense_review', hasFutureRoleTenseReview);
    if (profile === 'resume_application') {
      pushPatternIssue(issues, text, 'resume_weakness_mitigation_review', /마감\s*기한(?:을|은)?\s*여유\s*있게\s*잡/gu);
      if (/(?:공직|공무원|공공\s*부문)/u.test(text)) {
        pushPatternIssue(issues, text, 'public_service_employment_term_review', /입사\s*후/gu);
      }
    }
  }
  return mergeSameCode(issues).map(item => ({ ...item, profile }));
}

function applySafeDeterministicRepairs({ source = '', outputText = '', documentProfile = null } = {}) {
  const before = String(outputText || '');
  let text = before;
  const changes = [];
  const orphanParticleRepair = repairIntroducedOrphanStructuralParticles(source, text);
  text = orphanParticleRepair.text;
  for (let index = 0; index < orphanParticleRepair.repairCount; index += 1) {
    changes.push('orphan_structural_particle');
  }
  const duplicationRepair = repairIntroducedTokenDuplications(source, text);
  text = duplicationRepair.text;
  for (let index = 0; index < duplicationRepair.repairCount; index += 1) {
    changes.push('introduced_token_duplication');
  }
  const reciprocalRepair = repairReciprocalExpressionRedundancy(text);
  text = reciprocalRepair.text;
  for (let index = 0; index < reciprocalRepair.repairCount; index += 1) {
    changes.push('reciprocal_expression_redundancy');
  }
  text = replaceAndCount(text, /([.!?。！？])(?=[가-힣])/gu, '$1 ', 'missing_sentence_space', changes);
  text = replaceAndCount(text, CLOSED_QUOTE_SPACING_RE, '$1 ', 'closed_quote_spacing', changes);
  text = replaceAndCount(
    text,
    CLOSED_QUOTE_PARTICLE_GAP_RE,
    (_match, closing, attributionClosing) => closing || attributionClosing,
    'closed_quote_particle_spacing',
    changes
  );
  text = replaceAndCount(text, /메세지/gu, '메시지', 'message_spelling', changes);
  text = replaceAndCount(text, /실습수업/gu, '실습 수업', 'practice_class_spacing', changes);
  text = text.replace(/(\d+(?:[.,]\d+)?(?:가지|개|명|건|번|년|월|일|%|％|점|배|시간|분)[)）])([가-힣]{1,20})/gu, (match, left, right) => {
    if (PARTICLE_AFTER_PAREN.test(right)) return match;
    changes.push('numeric_parenthesis_join');
    return `${left} ${right}`;
  });
  const sourceHasDeepCollocation = /깊게\s+이해(?:하|했|되|할|하려|하고|하며|해서|해)/u.test(String(source || ''));
  if (!sourceHasDeepCollocation) {
    text = replaceAndCount(
      text,
      /깊게(?=\s+이해(?:하|했|되|할|하려|하고|하며|해서|해))/gu,
      '깊이',
      'deep_understanding_collocation',
      changes
    );
  }
  text = replaceOutsideProtectedQuotes(
    text,
    /(^|[^가-힣A-Za-z0-9_])(태도|자세|역할|기준|과정|방법|판단|책임|원칙)\s+(?=(?:매우\s+)?(?:중요|필요)하(?:다|다고|며|므로|지만|게|지|였|했|합|면))/gu,
    (_match, prefix, noun) => `${prefix}${noun}${subjectParticleFor(noun)} `,
    'missing_subject_particle',
    changes
  );
  text = replaceOutsideProtectedQuotes(
    text,
    /목적에(?=\s*두(?:다|고|며|어|었|는|기|지만|는데|도록|려|려고|었다|었습니다|었다고|었다는))/gu,
    () => '목적으로',
    'purpose_case_frame',
    changes
  );
  return {
    version: VERSION,
    text,
    applied: text !== before,
    changeCount: changes.length,
    changeCodes: [...new Set(changes)],
    profile: profileName(documentProfile)
  };
}

function isImprovedAudit(before, after) {
  if (!before || !after) return false;
  if (after.weightedRisk < before.weightedRisk) return true;
  if (after.repairableIssueCount < before.repairableIssueCount && after.introducedIssueCount <= before.introducedIssueCount) return true;
  return false;
}

function repairSiblingLabelSpacing(value, source) {
  const counts = {};
  const sourceStyles = String(source || '').split(/\r?\n/u)
    .map(parseParentheticalLabelLine)
    .filter(Boolean);
  if (sourceStyles.length < 3) return { text: String(value || ''), changeCounts: counts };
  const spacedCount = sourceStyles.filter(item => item.spaceBeforeParenthesis).length;
  const useSpaceBeforeParenthesis = spacedCount * 2 >= sourceStyles.length;
  const lines = String(value || '').split('\n').map(line => {
    const parsed = parseParentheticalLabelLine(line);
    if (!parsed) return line;
    const rebuilt = `${parsed.prefix}${parsed.label}${useSpaceBeforeParenthesis ? ' ' : ''}(${parsed.parenthetical})${parsed.colon}${parsed.body ? ` ${parsed.body}` : ''}`;
    if (rebuilt !== line) addCount(counts, 'sibling_label_spacing');
    return rebuilt;
  });
  return { text: lines.join('\n'), changeCounts: counts };
}

function parseParentheticalLabelLine(value) {
  const line = String(value || '');
  const match = line.match(/^(\s*(?:(?:[-*+•▪◦·●○■□◆◇▶▷※]|\d{1,3}[.)]|[①-⑳])\s*)?)([^:\n()]{1,80}?)(\s*)\(([^()\n]{1,80})\)\s*([:：])\s*(.*)$/u);
  if (!match) return null;
  const label = match[2].trimEnd();
  if (!label || !match[4].trim()) return null;
  return {
    prefix: match[1],
    label,
    spaceBeforeParenthesis: match[3].length > 0,
    parenthetical: match[4].trim(),
    colon: match[5],
    body: match[6].trimStart()
  };
}

const SOURCE_RESTORABLE_ISSUES = new Set([
  'causal_predicate_stack',
  'nominal_predicate_collocation',
  'case_frame_corruption',
  'meta_nominalization_injection',
  'role_predicate_redundancy',
  'analytic_object_recast',
  'repeated_clause_anchor',
  'professional_register_downgrade',
  'passive_causative_stack',
  'double_object_time_expenditure',
  'persistent_state_tense_regression',
  'orphan_structural_particle'
]);

function restoreIntroducedIntegritySentences({ source = '', outputText = '', audit = null } = {}) {
  const ordinals = [];
  const restoredCodes = [];
  for (const issue of audit?.issues || []) {
    if (!SOURCE_RESTORABLE_ISSUES.has(issue.code) || Number(issue.introducedCount || 0) <= 0) continue;
    restoredCodes.push(issue.code);
    if (issue.code === 'professional_register_downgrade') {
      for (const loss of issue.details?.alignedLosses || []) {
        if (Number(loss.outputOrdinal) > 0) ordinals.push(Number(loss.outputOrdinal));
      }
      continue;
    }
    ordinals.push(...(issue.sentenceOrdinals || []));
  }
  const restored = restoreSourceSentenceOrdinals(source, outputText, ordinals, {
    maxRestoreCount: 8,
    minSimilarity: 0.24,
    ordinalSpace: 'output'
  });
  return {
    ...restored,
    restoredCodes: [...new Set(restoredCodes)]
  };
}

function buildSourceReviewWarnings(sourceOrIssues, documentProfile = null) {
  const issues = Array.isArray(sourceOrIssues)
    ? sourceOrIssues
    : detectTextIssues(sourceOrIssues, {
        profile: profileName(documentProfile),
        targetRegister: String(documentProfile?.targetRegister || documentProfile?.tonePolicy || ''),
        includeSourceNotation: true
      });
  return issues.map(item => ({
    code: item.code,
    severity: 'notice',
    message: sourceReviewMessage(item.code),
    count: item.count,
    sentenceOrdinals: item.sentenceOrdinals || []
  }));
}

function buildSourcePromptHints(source, { documentProfile = null, mode = '' } = {}) {
  const issues = detectTextIssues(source, {
    profile: profileName(documentProfile),
    targetRegister: String(documentProfile?.targetRegister || documentProfile?.tonePolicy || ''),
    includeSourceNotation: true
  }).filter(item => item.repairable === true);
  if (!issues.length) return '';
  const rows = issues.slice(0, 8).map(item => {
    const ordinals = (item.sentenceOrdinals || []).slice(0, 6);
    return `- ${item.code}${ordinals.length ? ` (문장 ${ordinals.join(', ')})` : ''}: ${item.message}`;
  });
  return [
    '[원문 한국어 교정 대상 — 의미·장르 규칙보다 우선하지 않음]',
    `요청 모드=${String(mode || 'assignment')}. 아래 결함만 의미·화자·격식·구조를 유지하며 고친다.`,
    ...rows,
    '목록에 없는 표현을 억지로 바꾸거나 새 주장·예시·평가를 추가하지 않는다.'
  ].join('\n');
}

function detectProfessionalDowngrade(source, outputText, profile) {
  const before = String(source || '');
  const after = String(outputText || '');
  const mappings = [
    { formal: /(?:설계|구성)/gu, casual: /(?:흐름|순서|구성안)[^.!?\n]{0,18}(?:짰|짜고|짜며)/gu },
    { formal: /(?:역량|능력)/gu, casual: /(?:전달|정리|달성|해낼)\s*(?:하는|할)?\s*힘(?:을|이|도)?/gu },
    { formal: /피드백/gu, casual: /(?:AI|인공지능|도구)(?:가|에서)?\s*(?:준|준다는|준다고)/gu },
    { formal: /교류/gu, casual: /(?:학생|사람|동료)들과?\s*(?:어울|놀)/gu },
    { formal: /근무/gu, casual: /(?:다시\s*)?일한\s+[^.!?\n]{0,16}(?:아르바이트|매장|회사)/gu },
    { formal: /(?:분석|조사|검토)/gu, casual: /(?:기사|뉴스|자료|데이터)를?\s*(?:함께\s*)?(?:봤|보며|봐서)/gu }
  ];
  let count = 0;
  const concepts = [];
  const sentenceOrdinals = [];
  const alignedLosses = detectAlignedProfessionalLosses(before, after, profile);
  for (const loss of alignedLosses) {
    count += Math.max(1, Number(loss.missingCount || 0));
    concepts.push(loss.concept);
    sentenceOrdinals.push(loss.sourceOrdinal);
  }
  if (PROFESSIONAL_PROFILES.has(profile)) {
    for (const mapping of mappings) {
      const sourceFormal = countMatches(before, mapping.formal);
      const outputFormal = countMatches(after, mapping.formal);
      const sourceCasual = countMatches(before, mapping.casual);
      const outputCasual = countMatches(after, mapping.casual);
      if (sourceFormal > 0 && outputFormal === 0 && outputCasual > sourceCasual) {
        count += outputCasual - sourceCasual;
        concepts.push(mapping.formal.source);
      }
    }
  }
  if (!count) return null;
  return makeIssue('professional_register_downgrade', count, sentenceOrdinals, {
    concepts: [...new Set(concepts)].slice(0, 12),
    alignedLosses: alignedLosses.slice(0, 12)
  });
}

function detectIntroducedStudentRecordFragments(source, outputText, profile) {
  if (String(profile || '') !== 'student_record_teacher') return null;
  const sourceSentences = splitSentences(String(source || '')).map(value => String(value || '').trim()).filter(Boolean);
  const outputSentences = splitSentences(String(outputText || '')).map(value => String(value || '').trim()).filter(Boolean);
  const ordinals = [];
  const fragments = [];
  outputSentences.forEach((sentence, index) => {
    const visible = sentence.replace(/[.!?。！？]+$/gu, '').trim();
    const words = visible.split(/\s+/u).filter(Boolean);
    if (visible.length > 28 || words.length < 1 || words.length > 3) return;
    if (!/(?:조사|분석|확인|정리|검토|탐구|파악|제시|관찰)함$/u.test(visible)) return;
    if (sourceSentences.some(item => normalizeSentenceLocal(item) === normalizeSentenceLocal(sentence))) return;
    const tokens = contentTokensLocal(visible).filter(token => !/(?:조사|분석|확인|정리|검토|탐구|파악|제시|관찰|함)$/u.test(token));
    const sourceContext = sourceSentences.find(item => item.length >= visible.length + 16
      && (!tokens.length || tokens.some(token => item.includes(token))));
    if (!sourceContext) return;
    ordinals.push(index + 1);
    fragments.push({ sentence: visible, sourceContext: sourceContext.slice(0, 180) });
  });
  return fragments.length
    ? makeIssue('student_record_fragment', fragments.length, ordinals, { fragments: fragments.slice(0, 10) })
    : null;
}

function pushFunctionalGreetingDuplication(issues, text) {
  const first = splitSentences(String(text || '')).slice(0, 3);
  const ordinals = [];
  first.forEach((sentence, index) => {
    if (/(?:안녕하세요|안녕하십니까|인사드립니다|반갑습니다)/u.test(sentence)) ordinals.push(index + 1);
  });
  if (ordinals.length >= 2) {
    issues.push(makeIssue('functional_greeting_duplication', ordinals.length - 1, ordinals));
  }
}

function findAdjacentSemanticRepetitions(text) {
  const sentences = splitSentences(String(text || '')).map(value => String(value || '').trim()).filter(Boolean);
  const ordinals = [];
  for (let index = 0; index < sentences.length - 1; index += 1) {
    const left = stripProtectedQuotedText(sentences[index]);
    const right = stripProtectedQuotedText(sentences[index + 1]);
    if (left.length < 22 || right.length < 22) continue;
    if (/^(?:#{1,6}|[-*+•▪◦●○■□◆◇▶▷※]|제\s*\d+\s*조)/u.test(left)
        || /^(?:#{1,6}|[-*+•▪◦●○■□◆◇▶▷※]|제\s*\d+\s*조)/u.test(right)) continue;
    const leftTokens = new Set(contentTokensLocal(left));
    const rightTokens = new Set(contentTokensLocal(right));
    if (leftTokens.size < 4 || rightTokens.size < 4) continue;
    const intersection = [...leftTokens].filter(token => rightTokens.has(token)).length;
    const containment = intersection / Math.max(1, Math.min(leftTokens.size, rightTokens.size));
    const lengthRatio = Math.min(left.length, right.length) / Math.max(left.length, right.length);
    if (containment >= 0.8 && lengthRatio >= 0.68) ordinals.push(index + 2);
  }
  return ordinals;
}

function detectIntroducedAdjacentSemanticRepetition(source, outputText) {
  const before = findAdjacentSemanticRepetitions(source);
  const after = findAdjacentSemanticRepetitions(outputText);
  const introducedCount = Math.max(0, after.length - before.length);
  return introducedCount
    ? makeIssue('adjacent_semantic_repetition', introducedCount, after.slice(0, introducedCount))
    : null;
}

function pushSourceTokenRepetitionReview(issues, text) {
  const exceptions = new Set(['의의', '하하', '호호', '꼼꼼', '쓸쓸', '똑똑', '든든', '곳곳', '틈틈']);
  const sourceTokens = [...String(text || '').matchAll(/[가-힣]{2,10}/gu)].map(match => match[0]);
  const sourceTokenSet = new Set(sourceTokens);
  const matches = [];
  for (const match of String(text || '').matchAll(/[가-힣]{2,10}/gu)) {
    const token = match[0];
    if (exceptions.has(token)) continue;
    const repeated = token.match(/^([가-힣]{1,2})\1/u);
    if (!repeated) continue;
    // 긴 정상 어휘까지 넓게 경고하지 않고, 앞부분이 우발적으로 한 번 더
    // 입력된 짧은 토큰만 원문 확인 알림으로 보낸다.
    if (token.length > repeated[1].length * 2 + 3) continue;
    // 사사로운·간간이·꼼꼼하게 같은 정상 반복음절을 추측으로 오타 처리하지
    // 않는다. 중복 접두부를 한 번 덜어낸 형태가 같은 원문에 실제 어절로
    // 존재할 때만 사용자가 대조할 수 있는 보수적 알림을 만든다.
    const candidate = token.slice(repeated[1].length);
    if (candidate.length < 2 || !sourceTokenSet.has(candidate)) continue;
    matches.push({ token, ordinal: sentenceOrdinalAt(text, match.index) });
  }
  if (matches.length) {
    issues.push(makeIssue(
      'source_token_repetition_review',
      matches.length,
      matches.map(item => item.ordinal),
      { tokens: [...new Set(matches.map(item => item.token))].slice(0, 12) }
    ));
  }
}

const PROFESSIONAL_CONCEPT_RULES = Object.freeze([
  {
    concept: 'improvement_requirement',
    source: /(?:개선|보완)(?:이|가)?\s*(?:필요(?:하|한|했|했던)|해야\s*할)/u,
    acceptable: /(?:개선|보완)(?:이|가)?\s*(?:필요(?:하|한|했|했던)|해야\s*할)|(?:개선|보완)할\s*(?:부분|사항|지점)/u,
    preferred: ['개선이 필요한 부분', '보완할 사항']
  },
  {
    concept: 'assigned_task_performance',
    source: /(?:주어진|담당한|요구된)[^.!?。！？\n]{0,24}(?:작업|업무|과제)(?:만)?(?:을|를)?\s*(?:수행|이행|완수)/u,
    acceptable: /(?:주어진|담당한|요구된)[^.!?。！？\n]{0,24}(?:작업|업무|과제)(?:만)?(?:을|를)?\s*(?:수행|이행|완수|처리)/u,
    preferred: ['주어진 작업을 수행', '담당 업무를 이행']
  },
  {
    concept: 'standards_familiarity',
    source: /(?:검사|평가|업무|안전|품질)[^.!?。！？\n]{0,12}기준(?:을|를)?\s*(?:숙지|준수|파악|정확히\s*이해)/u,
    acceptable: /(?:검사|평가|업무|안전|품질)[^.!?。！？\n]{0,12}기준(?:을|를)?\s*(?:숙지|준수|파악|정확히\s*이해)/u,
    preferred: ['검사 기준을 숙지', '품질 기준을 정확히 이해']
  },
  {
    concept: 'objective_stance',
    source: /객관적(?:으로|인\s*(?:관점|시선|태도|분석))/u,
    acceptable: /객관적(?:으로|인\s*(?:관점|시선|태도|분석))/u,
    preferred: ['객관적으로', '객관적인 관점에서']
  },
  {
    concept: 'process_optimization',
    source: /(?:공정\s*조건(?:을|를)?\s*최적화|공정\s*최적화|최적\s*조건(?:을|를)?\s*도출)/u,
    acceptable: /(?:공정[^.!?]{0,24}최적화|최적\s*(?:공정|조건)[^.!?]{0,20}(?:도출|찾|선정))/u,
    preferred: ['공정 조건을 최적화', '최적 조건을 도출']
  },
  {
    concept: 'structure_performance_correlation',
    source: /(?:구조[^.!?]{0,24}성능[^.!?]{0,16}(?:상관관계|상관성)|(?:상관관계|상관성)[^.!?]{0,24}구조[^.!?]{0,24}성능)/u,
    acceptable: /(?:구조[^.!?]{0,24}성능[^.!?]{0,16}(?:상관관계|상관성)|(?:상관관계|상관성)[^.!?]{0,24}구조[^.!?]{0,24}성능)/u,
    preferred: ['구조와 성능 간 상관관계', '구조·성능의 상관성']
  },
  {
    concept: 'cause_analysis',
    source: /원인(?:을|를)?\s*(?:분석|규명|파악)/u,
    acceptable: /원인(?:을|를)?\s*(?:(?:먼저|구체적으로|면밀히|정확히|체계적으로)\s*)?(?:분석|규명|파악)/u,
    preferred: ['원인을 분석', '원인을 규명']
  },
  {
    concept: 'reproducibility_verification',
    source: /재현성(?:을|를)?\s*(?:검증|평가|확보)/u,
    acceptable: /재현성(?:을|를)?\s*(?:검증|평가|확보)/u,
    preferred: ['재현성을 검증', '재현성을 확보']
  },
  {
    concept: 'quantitative_analysis',
    source: /(?:수치화|정량화|정량\s*분석)/u,
    acceptable: /(?:수치화|정량화|정량\s*분석)/u,
    preferred: ['수치화', '정량화']
  },
  {
    concept: 'data_interpretation',
    source: /데이터\s*해석/u,
    acceptable: /(?:데이터|측정\s*결과|분석\s*결과)[^.!?]{0,18}해석|해석[^.!?]{0,18}(?:데이터|측정\s*결과|분석\s*결과)/u,
    preferred: ['데이터 해석', '측정 결과를 해석']
  },
  {
    concept: 'role_performance',
    source: /(?:역할|업무)(?:을|를)?\s*(?:수행|이행|담당)/u,
    acceptable: /(?:역할|업무)(?:을|를)?\s*(?:수행|이행|담당|완수)/u,
    preferred: ['역할을 수행', '업무를 담당']
  },
  {
    concept: 'conclusion_derivation',
    source: /(?:결론|결과|시사점)(?:을|를)?\s*도출/u,
    acceptable: /(?:결론|결과|시사점)(?:을|를)?\s*(?:도출|제시)/u,
    preferred: ['결론을 도출', '시사점을 제시']
  },
  {
    concept: 'methodological_verification',
    source: /(?:가설|결과|타당성|효과|성능)(?:을|를)?\s*(?:검증|검정)/u,
    acceptable: /(?:가설|결과|타당성|효과|성능)(?:을|를)?\s*(?:검증|검정|평가)/u,
    preferred: ['가설을 검증', '타당성을 평가']
  },
  {
    concept: 'resource_allocation',
    source: /(?:자원|예산|인력|시간)(?:을|를)?\s*(?:효율적(?:으로)?\s*)?(?:배분|할당)/u,
    acceptable: /(?:자원|예산|인력|시간)(?:을|를)?\s*(?:효율적(?:으로)?\s*)?(?:배분|할당)/u,
    preferred: ['자원을 효율적으로 배분', '인력을 할당']
  },
  {
    concept: 'formal_market_scope',
    professionalOnly: true,
    source: /시장\s*내(?:에서|의|에)?/u,
    acceptable: /시장\s*내(?:에서|의|에)?/u,
    preferred: ['시장 내에서', '시장 내의']
  },
  {
    concept: 'formal_analysis_action',
    professionalOnly: true,
    source: /(?:활동|관계|영향|효과|요인|과정)(?:을|를)?[^.!?。！？\n]{0,24}(?:분석|규명)(?:하|해|했|하여|하고|하며|한다|했다)/u,
    acceptable: /(?:활동|관계|영향|효과|요인|과정)(?:을|를)?[^.!?。！？\n]{0,24}(?:분석|규명)(?:하|해|했|하여|하고|하며|한다|했다)/u,
    preferred: ['활동을 분석하다', '영향을 규명하다']
  },
  {
    concept: 'normative_integrity',
    professionalOnly: true,
    source: /(?:권리|존엄성|정의|공정성|안전)(?:을|를|가|이)?[^.!?。！？\n]{0,28}(?:침해|훼손|보호)(?:하|해|했|되|한다|해서)/u,
    acceptable: /(?:권리|존엄성|정의|공정성|안전)(?:을|를|가|이)?[^.!?。！？\n]{0,28}(?:침해|훼손|보호)(?:하|해|했|되|한다|해서)/u,
    preferred: ['권리를 보호하다', '존엄성을 침해하지 않다']
  },
  {
    concept: 'policy_maintenance',
    professionalOnly: true,
    source: /(?:규제|기준|원칙|제도)(?:을|를)?[^.!?。！？\n]{0,20}(?:유지|준수)(?:하|해|했|해야|한다|하며)/u,
    acceptable: /(?:규제|기준|원칙|제도)(?:을|를)?[^.!?。！？\n]{0,20}(?:유지|준수)(?:하|해|했|해야|한다|하며)/u,
    preferred: ['규제를 유지하다', '기준을 준수하다']
  },
  {
    concept: 'value_creation',
    professionalOnly: true,
    source: /(?:가치|부가가치)(?:가|를|를\s*)?[^.!?。！？\n]{0,20}창출(?:되|하|해|했|되는|한다)/u,
    acceptable: /(?:가치|부가가치)(?:가|를|를\s*)?[^.!?。！？\n]{0,20}창출(?:되|하|해|했|되는|한다)/u,
    preferred: ['가치를 창출하다', '부가가치가 창출되다']
  },
  {
    concept: 'technical_signal_transfer',
    source: /(?:신호|데이터|패킷|정보)(?:를|가)?[^.!?。！？\n]{0,20}(?:전송|송신|수신)(?:하|되|해|했|한다|되면)/u,
    acceptable: /(?:신호|데이터|패킷|정보)(?:를|가)?[^.!?。！？\n]{0,20}(?:전송|송신|수신)(?:하|되|해|했|한다|되면)/u,
    preferred: ['신호를 전송하다', '데이터를 송수신하다']
  },
  {
    concept: 'configured_output_state',
    source: /(?:지정|설정)된\s+(?:음성|안내|값|시간|조건|신호|출력|동작)/u,
    acceptable: /(?:지정|설정)된\s+(?:음성|안내|값|시간|조건|신호|출력|동작)/u,
    preferred: ['지정된 음성 안내', '설정된 조건']
  }
]);

function detectAlignedProfessionalLosses(source, outputText, profile = 'unknown') {
  const sourceSentences = splitSentences(String(source || '')).map(value => String(value || '').trim()).filter(Boolean);
  const outputSentences = splitSentences(String(outputText || '')).map(value => String(value || '').trim()).filter(Boolean);
  if (!sourceSentences.length || !outputSentences.length) return [];
  const losses = [];
  sourceSentences.forEach((sentence, sourceIndex) => {
    for (const rule of PROFESSIONAL_CONCEPT_RULES) {
      if (rule.professionalOnly === true && !PROFESSIONAL_PROFILES.has(String(profile || ''))) continue;
      const sourceMatchCount = countPatternMatchesLocal(rule.source, sentence);
      if (!sourceMatchCount) continue;
      const aligned = alignedOutputCandidates(sentence, sourceIndex, sourceSentences.length, outputSentences);
      const bestScore = Number(aligned[0]?.score || 0);
      const eligible = aligned.filter((item, index) => index === 0
        || (item.score >= 0.35 && item.score >= bestScore - 0.04));
      const retainedCount = eligible.reduce(
        (sum, item) => sum + countPatternMatchesLocal(rule.acceptable, item.sentence),
        0
      );
      if (retainedCount >= sourceMatchCount) continue;
      const best = aligned[0] || { index: -1, sentence: '', score: 0 };
      losses.push({
        concept: rule.concept,
        sourceMatchCount,
        retainedCount,
        missingCount: sourceMatchCount - retainedCount,
        sourceOrdinal: sourceIndex + 1,
        outputOrdinal: best.index >= 0 ? best.index + 1 : 0,
        preferred: rule.preferred,
        sourceSentence: sentence.slice(0, 220),
        outputSentence: best.sentence.slice(0, 220)
      });
    }
  });
  return losses;
}

function detectIntroducedPersistentStateTenseRegression(source, outputText) {
  const sourceSentences = splitSentences(String(source || '')).map(value => String(value || '').trim()).filter(Boolean);
  const outputSentences = splitSentences(String(outputText || '')).map(value => String(value || '').trim()).filter(Boolean);
  if (!sourceSentences.length || !outputSentences.length) return null;
  const presentState = /(?:아직도|여전히|지금도|현재도)[^.!?。！？\n]{0,90}(?:(?:남아|이어져|지속되어|유효하게|기억되어)\s*있(?:다|습니다|어요|죠)|(?:남는다|이어진다|지속된다|유효하다))/u;
  const pastState = /(?:아직도|여전히|지금도|현재도)[^.!?。！？\n]{0,90}(?:(?:남아|이어져|지속되어|유효하게|기억되어)\s*있었(?:다|습니다|어요)|(?:남아\s*있던|이어졌|지속됐|유효했))/u;
  const losses = [];
  sourceSentences.forEach((sentence, sourceIndex) => {
    if (!presentState.test(stripProtectedQuotedText(sentence))) return;
    const best = alignedOutputCandidates(sentence, sourceIndex, sourceSentences.length, outputSentences)[0];
    if (!best || Number(best.score || 0) < 0.30) return;
    if (!pastState.test(stripProtectedQuotedText(best.sentence))) return;
    losses.push({
      sourceOrdinal: sourceIndex + 1,
      outputOrdinal: best.index + 1,
      sourceSentence: sentence.slice(0, 220),
      outputSentence: best.sentence.slice(0, 220)
    });
  });
  if (!losses.length) return null;
  return makeIssue(
    'persistent_state_tense_regression',
    losses.length,
    losses.map(item => item.outputOrdinal),
    { alignedLosses: losses }
  );
}

function patternMatchesLocal(pattern, value) {
  pattern.lastIndex = 0;
  return pattern.test(String(value || ''));
}

function countPatternMatchesLocal(pattern, value) {
  if (!(pattern instanceof RegExp)) return 0;
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return (String(value || '').match(new RegExp(pattern.source, flags)) || []).length;
}

function hasDataDocumentCollocation(sentence) {
  const value = String(sentence || '');
  if (/(?:보고서|논문)(?:의\s*)?(?:원고|본문|초안)(?:을|를)?[^.!?。！？\n]{0,18}작성/u.test(value)) return false;
  return /(?:데이터|측정값|실험값|분석\s*결과)(?:은|는|을|를)?[^.!?。！？\n]{0,75}(?:보고서|논문)에\s*(?:직접\s*)?작성/u.test(value);
}

function hasQuoteAttributionParticleMismatch(sentence) {
  return /[”"](?:은|는)\s+(?:입장|견해|의견|결론)(?:을|를)?\s+(?:주장|강조)(?:하|했|해|합|했습|했다)/u
    .test(String(sentence || ''));
}

function hasDoubleTopicChain(sentence) {
  const value = String(sentence || '');
  const firstPersonTopic = '(?:나는|저는|우리는|저희는)';
  const boundedFirstPerson = koreanStart(firstPersonTopic, 'u').source;
  if (new RegExp(`(?:하면서|하며|통해|후|계기로|과정에서)[^.!?。！？\\n]{0,20}${boundedFirstPerson}\\s+[^.!?。！？\\n]{1,28}(?:은|는)\\s`, 'u').test(value)) return true;
  return new RegExp(`^${firstPersonTopic}\\s+(?:이|그|해당|이번|예술|연구|활동|작품|문제)[^.!?。！？\\n]{0,18}(?:은|는)\\s`, 'u').test(value);
}

function hasValueParticipationCollocation(sentence) {
  return /(?:가치|취지|뜻)에\s*(?:함께\s*하|함께하)/u.test(String(sentence || ''));
}

function hasScopeExpansionCollocation(sentence) {
  return /(?:소비|수요|이용|사용)(?:가|는|이)\s*(?:더\s*)?(?:넓어지|넓어질|넓어진)/u.test(String(sentence || ''));
}

function hasPurposeModifierCollocation(sentence) {
  return /(?:공정한|안전한|건강한|지속\s*가능한|더\s*나은)?\s*(?:사회|환경|공동체|문화|질서)(?:를|을)\s*만들\s+(?:정책|제도|방안|기준)/u
    .test(String(sentence || ''));
}

function hasBenefitHelpPredicateRedundancy(sentence) {
  return /(?:도움|지원)(?:을|를)\s+(?:받을|얻을)\s+수\s+(?:있도록|있게)[^.!?。！？\n]{0,24}(?:돕|지원하)/u
    .test(stripProtectedQuotedText(sentence));
}

function hasContrastClauseAttachment(sentence) {
  return /(?:하며|기며|하면서)[^.!?。！？\n]{1,70}(?:서두르기보다|앞세우기보다)/u
    .test(stripProtectedQuotedText(sentence));
}

function hasMissingSubjectParticle(sentence) {
  return /(^|[^가-힣A-Za-z0-9_])(?:태도|자세|역할|기준|과정|방법|판단|책임|원칙)\s+(?:매우\s+)?(?:중요|필요)하(?:다|다고|며|므로|지만|게|지|였|했|합|면)/u
    .test(stripProtectedQuotedText(sentence));
}

function hasRepeatedClauseAnchor(sentence) {
  const value = stripProtectedQuotedText(sentence);
  return /(?:그때부터|그\s*과정에서|이\s*과정에서|그\s*이후|그때마다)[^.!?。！？\n]{3,120}(?:그때부터|그\s*과정에서|이\s*과정에서|그\s*이후|그때마다)/u
    .test(value);
}

function hasPurposeCaseFrame(sentence) {
  return /(?:생식|성장|수익|안전|교육|연구|보호|예방|달성)(?:을|를)?\s*(?:주된\s*)?목적에\s*두/u
    .test(stripProtectedQuotedText(sentence));
}

function hasFutureRoleTenseReview(sentence) {
  return /(?:이런|이러한|앞선)\s+경험(?:들)?(?:은|이)[^.!?。！？\n]{0,45}(?:공직|직무|입사\s*후|임용\s*후)에서\s+마주한[^.!?。！？\n]{0,90}(?:밑거름|기반|도움)(?:이|으로)?\s*될/u
    .test(stripProtectedQuotedText(sentence));
}

function hasCausalPredicateStack(sentence) {
  const value = stripProtectedQuotedText(sentence);
  return /(?:은|는|이|가)\s+[^.!?。！？\n]{4,120}(?:에서|데서|때문에|으로부터)\s*비롯된\s+(?:가장\s*(?:큰|주된)\s*)?원인(?:이었|이었다|입니다|이다|으로)/u.test(value)
    || /원인(?:은|이|으로)?[^.!?。！？\n]{0,70}(?:데서|때문에)\s*비롯된[^.!?。！？\n]{0,28}원인/u.test(value);
}

function hasNominalPredicateCollocation(sentence) {
  const value = stripProtectedQuotedText(sentence);
  // “이 연구를 살펴보면”은 연구 문헌 자체를 검토한다는 정상 표현이다.
  // 분석·검토·조사처럼 이미 행위성을 가진 명사를 다시 “살펴보다”의
  // 목적으로 둔 중첩만 잡아 정상 학술 문장을 엔진 오류로 오인하지 않는다.
  if (/(?:^|[^가-힣A-Za-z0-9_])(?:분석|검토|조사)(?:을|를)?\s+(?:살펴보|살펴봤|살펴본|살펴보면)/u.test(value)) return true;
  return /(?:독보적|선도적|우월한|확고한|시장\s*(?:내|안)의?)[^.!?。！？\n]{0,28}(?:위치|입지)(?:를|을)?[^.!?。！？\n]{0,20}(?:더욱\s*)?(?:분명히|명확히)\s*(?:하|할)/u.test(value);
}

function hasCaseFrameCorruption(sentence) {
  return /(?:^|[^가-힣A-Za-z0-9_])[^.!?。！？\n]{0,24}에서[^.!?。！？\n]{1,80}이르기까지를\s*(?:포괄|아우르|포함)/u
    .test(stripProtectedQuotedText(sentence));
}

function hasMetaNominalizationInjection(sentence) {
  return /(?:느낀|깨달은|알게\s*된|확인한)\s+것(?:은|이)[^.!?。！？\n]{6,120}(?:하|되|이|있)(?:는|다는)\s+점(?:이었|이었다|이다|입니다)/u
    .test(stripProtectedQuotedText(sentence));
}

function hasRolePredicateRedundancy(sentence) {
  const value = stripProtectedQuotedText(sentence);
  return /맡(?:고|아|으며|아서|은|았습니다|고\s*있)[^.!?。！？\n]{0,120}담당(?:하|하고|했|합|하고\s*있)/u.test(value)
    || /담당(?:하|하고|했|합|하고\s*있)[^.!?。！？\n]{0,120}맡(?:고|아|으며|아서|은|았습니다)/u.test(value);
}

function hasAnalyticObjectRecast(sentence) {
  return /(?:요구\s*사항|의견|자료|정보|요청)(?:은|는)[^.!?。！？\n]{0,70}(?:접수|수집|전달|공유|제공)된\s+(?:내용|자료|사항)(?:을|를)?\s*(?:바탕으로|기반으로)\s*(?:분석|검토)/u
    .test(stripProtectedQuotedText(sentence));
}

function pushEnumerationParallelismIssue(issues, text) {
  const sentences = splitSentences(String(text || '')).map(value => String(value || '').trim()).filter(Boolean);
  const groups = [];
  let current = [];
  sentences.forEach((sentence, index) => {
    const marker = enumerationMarker(sentence);
    if (!marker) {
      if (current.length >= 2) groups.push(current);
      current = [];
      return;
    }
    if (current.length && marker.order !== current.at(-1).order + 1) {
      if (current.length >= 2) groups.push(current);
      current = [];
    }
    current.push({ index, order: marker.order, shape: enumerationPredicateShape(sentence) });
  });
  if (current.length >= 2) groups.push(current);
  const ordinals = [];
  for (const group of groups) {
    const shapes = new Set(group.map(item => item.shape).filter(Boolean));
    if (shapes.size <= 1) continue;
    ordinals.push(...group.map(item => item.index + 1));
  }
  if (ordinals.length) issues.push(makeIssue('enumeration_parallelism', 1, ordinals));
}

function enumerationMarker(sentence) {
  const match = String(sentence || '').match(/^\s*(첫째|둘째|셋째|넷째|다섯째|첫\s*번째|두\s*번째|세\s*번째|네\s*번째|다섯\s*번째)(?:는|로|,|\s)/u);
  if (!match) return null;
  const normalized = match[1].replace(/\s+/gu, '');
  const order = ['첫째', '첫번째'].includes(normalized) ? 1
    : (['둘째', '두번째'].includes(normalized) ? 2
      : (['셋째', '세번째'].includes(normalized) ? 3
        : (['넷째', '네번째'].includes(normalized) ? 4 : 5)));
  return { order };
}

function enumerationPredicateShape(sentence) {
  const value = String(sentence || '').replace(/[.!?…。！？"'”’」』】)\]]+$/gu, '').trim();
  if (/(?:것|점|방법|방식|과정)(?:이었|이었다|이다|입니다|임)$/u.test(value)) return 'nominalized';
  if (/(?:한다|된다|이다|있다|없다|하였다|했다|준다|줄인다|높인다|낮춘다|합니다|됩니다|입니다|있습니다|없습니다)$/u.test(value)) return 'finite';
  if (/(?:함|됨|임|음)$/u.test(value)) return 'record_nominal';
  return '';
}

function repairReciprocalExpressionRedundancy(value) {
  let repairCount = 0;
  const text = String(value || '').split('\n').map(line => replaceOutsideProtectedRanges(line, segment => (
    segment.replace(/서로\s+상호(?=(?:작용|교류|소통|협력|의존|영향))/gu, () => {
      repairCount += 1;
      return '상호';
    })
  ))).join('\n');
  return { text, repairCount };
}

const FORMAL_REGISTER_RULES = Object.freeze([
  {
    family: 'operational_slang',
    test: value => /(?:원복|무\s*휴식\s*(?:모드|운영|상태)|역\s*타기)/u.test(value)
  },
  {
    family: 'projectile_process_metaphor',
    test: (value, fullText) => /(?:탄환|사격|(?:한|두|세|\d+)\s*발\s*(?:쏘|발사))/u.test(value)
      && (hasTechnicalProcessContext(value)
        || (hasFormalMetaphorCluster(fullText) && hasTechnicalProcessContext(fullText)))
  },
  {
    family: 'medical_process_metaphor',
    test: (value, fullText) => /(?:부검|해부|수술|처치)/u.test(value)
      && !hasMedicalDomainContext(fullText)
      && ((/(?:부검|해부)/u.test(value)
          && /(?:수술|처치)/u.test(value)
          && /(?:사이클|주기|오류|원인|대상|시스템|절차)/u.test(value))
        || (hasFormalMetaphorCluster(fullText) && hasTechnicalProcessContext(fullText)))
  },
  {
    family: 'landscape_metric_metaphor',
    test: (value, fullText) => /(?:큰|거대한)\s*(?:골짜기|절벽)/u.test(value)
      && (/(?:성능|지연|값|분포|오차|구간|격차|변화|그래프)/u.test(value)
        || (hasFormalMetaphorCluster(fullText) && hasTechnicalProcessContext(fullText)))
  },
  {
    family: 'stock_blade_metaphor',
    test: value => /양날의\s*(?:검|칼)/u.test(value)
  },
  {
    family: 'casual_emphasis',
    test: value => /(?:^|[\s,.;:!?。！？])진짜(?:로|가|는|도|만)?(?=$|[\s,.;:!?。！？])/u.test(value)
  },
  {
    family: 'casual_sentence_connector',
    test: (value, _fullText, context) => ['academic_paper', 'report_assignment', 'long_explainer', 'clinical_record', 'legal_contract', 'student_record_teacher']
      .includes(String(context?.profile || ''))
      && /^\s*그래서(?:는|도)?(?:\s|,)/u.test(value)
  },
  {
    family: 'resume_ornamental_closing',
    test: (value, _fullText, context) => String(context?.profile || '') === 'resume_application'
      && /(?:곁을\s*지키는\s*디딤돌|든든한\s*동행자|따뜻한\s*조력자|성장의\s*시간|소중한\s*기회)/u.test(value)
  }
]);

function isFormalRegisterTarget(targetRegister, profile) {
  if (['academic_formal', 'clinical_formal', 'legal_formal', 'record_formal', 'student_formal', 'professional', 'functional_formal', 'formal']
    .includes(String(targetRegister || ''))) return true;
  return ['academic_paper', 'report_assignment', 'long_explainer', 'clinical_record', 'legal_contract', 'student_record_teacher', 'resume_application', 'mail_notice']
    .includes(String(profile || ''));
}

function pushFormalRegisterResidual(issues, text, context = {}) {
  const sentences = splitSentences(String(text || ''));
  const ordinals = [];
  const families = [];
  sentences.forEach((sentence, index) => {
    const value = stripProtectedQuotedText(sentence);
    for (const rule of FORMAL_REGISTER_RULES) {
      if (typeof rule.test !== 'function' || !rule.test(value, text, context)) continue;
      ordinals.push(index + 1);
      families.push(rule.family);
    }
  });
  if (families.length) {
    issues.push(makeIssue('formal_register_residual', families.length, ordinals, {
      families: [...new Set(families)].slice(0, 12)
    }));
  }
}

function detectIntroducedTokenDuplications(source, outputText) {
  const mappings = findIntroducedTokenDuplicationMappings(source, outputText);
  if (!mappings.length) return null;
  return makeIssue(
    'introduced_token_duplication',
    mappings.length,
    mappings.map(item => item.sentenceOrdinal),
    { mappings: mappings.slice(0, 20) }
  );
}

function repairIntroducedTokenDuplications(source, outputText) {
  const mappings = findIntroducedTokenDuplicationMappings(source, outputText);
  if (!mappings.length) return { text: String(outputText || ''), repairCount: 0 };
  const replacements = new Map(mappings.map(item => [item.outputToken, item.repairedToken]));
  let repairCount = 0;
  const lines = String(outputText || '').replace(/\r\n?/gu, '\n').split('\n');
  const text = lines.map(line => replaceOutsideProtectedRanges(line, segment => (
    segment.replace(/[가-힣]{2,}/gu, token => {
      const repaired = replacements.get(token);
      if (!repaired || repaired === token) return token;
      repairCount += 1;
      return repaired;
    })
  ))).join('\n');
  return { text, repairCount };
}

function findIntroducedTokenDuplicationMappings(source, outputText) {
  const sourceText = String(source || '').normalize('NFKC');
  const output = String(outputText || '').normalize('NFKC');
  if (!sourceText || !output) return [];
  const sourceTokens = new Set(sourceText.match(/[가-힣]{2,}/gu) || []);
  const mappings = [];
  for (const match of output.matchAll(/[가-힣]{2,}/gu)) {
    const token = match[0];
    if (sourceTokens.has(token)) continue;
    const repairedToken = removeOneIntroducedRepeatedUnit(token, sourceText, sourceTokens);
    if (!repairedToken) continue;
    mappings.push({
      outputToken: token,
      repairedToken,
      sentenceOrdinal: sentenceOrdinalAt(output, match.index)
    });
  }
  return mappings;
}

function removeOneIntroducedRepeatedUnit(token, sourceText, sourceTokens) {
  const maxUnit = Math.min(3, Math.floor(token.length / 2));
  for (let unitLength = 1; unitLength <= maxUnit; unitLength += 1) {
    for (let index = 0; index + unitLength * 2 <= token.length; index += 1) {
      const unit = token.slice(index, index + unitLength);
      if (unit !== token.slice(index + unitLength, index + unitLength * 2)) continue;
      // 전문가가·국가가처럼 명사 자체가 '가'로 끝난 뒤 주격 조사가 붙은
      // 정상 형태를 가가 중복 오타로 줄이지 않는다. '의의'도 같은 방식의
      // 정상 어휘/조사 결합일 수 있어 한 글자 접미 반복에서는 보호한다.
      if (unitLength === 1
          && index + unitLength * 2 === token.length
          && ['가', '의'].includes(unit)) continue;
      const candidate = token.slice(0, index) + token.slice(index + unitLength);
      if (candidate.length < 2) continue;
      if (sourceTokens.has(candidate) || sourceText.includes(candidate)) return candidate;
    }
  }
  return '';
}

function hasFormalMetaphorCluster(value) {
  const text = String(value || '');
  const categories = [
    /(?:원복|무\s*휴식\s*(?:모드|운영|상태)|역\s*타기)/u,
    /(?:탄환|사격|(?:한|두|세|\d+)\s*발\s*(?:쏘|발사))/u,
    /(?:부검|해부|수술|처치)/u,
    /(?:(?:큰|거대한)\s*(?:골짜기|절벽)|양날의\s*(?:검|칼))/u
  ];
  return categories.filter(pattern => pattern.test(text)).length >= 2;
}

function hasTechnicalProcessContext(value) {
  return /(?:서버|데이터|요청|처리|오류|복구|원복|성능|모형|변수|실험|작업|시스템|알고리즘)/u
    .test(String(value || ''));
}

function hasMedicalDomainContext(value) {
  return /(?:환자|질환|병원|임상|의료|종양|병변|수술실|진단|치료|해부학)/u.test(String(value || ''));
}

function stripProtectedQuotedText(value) {
  return String(value || '')
    .replace(/[“「『《〈][^”」』》〉\n]{1,240}[”」』》〉]/gu, ' ')
    .replace(/"[^"\n]{1,240}"/gu, ' ')
    .replace(/'[^'\n]{1,240}'/gu, ' ');
}

function pushSelfEvaluationRepetition(issues, text) {
  const sentences = splitSentences(String(text || ''));
  const ordinals = [];
  const pattern = /(?:(?:역량|능력|사고력|전문성|정확도)(?:을|를|도)?[^.!?。！？\n]{0,28}(?:길렀|키웠|갖추었|향상시켰|높였|발전시켰)|(?:기\s*위해|고자)\s*노력했)/u;
  sentences.forEach((sentence, index) => {
    if (pattern.test(String(sentence || ''))) ordinals.push(index + 1);
  });
  if (ordinals.length >= 3) {
    issues.push(makeIssue('self_evaluation_repetition', ordinals.length - 2, ordinals, {
      totalSelfEvaluationSentenceCount: ordinals.length
    }));
  }
}

function isOverloadedResearchActionChain(sentence) {
  const value = String(sentence || '');
  if (normalizeSentenceLocal(value).length < 65) return false;
  const actions = [
    /원인(?:을|를)?\s*(?:분석|규명|파악|짚)/u,
    /(?:실험|공정)\s*조건(?:을|를)?\s*(?:조정|변경|바꾸)/u,
    /반복\s*실험/u,
    /재현성(?:을|를)?\s*(?:검증|확인|평가|확보)/u,
    /(?:비교·분석|비교하고\s*분석|비교\s*분석)/u,
    /(?:실험|연구|분석)[^.!?]{0,16}(?:수행|진행)/u
  ];
  return actions.filter(pattern => patternMatchesLocal(pattern, value)).length >= 4;
}

function pushPatternIssue(issues, text, code, pattern) {
  const matches = [...String(text || '').matchAll(cloneGlobal(pattern))];
  if (!matches.length) return;
  issues.push(makeIssue(code, matches.length, matches.map(match => sentenceOrdinalAt(text, match.index))));
}

function pushNumericParenthesisIssue(issues, text) {
  const pattern = /(\d+(?:[.,]\d+)?(?:가지|개|명|건|번|년|월|일|%|％|점|배|시간|분)[)）])([가-힣]{1,20})/gu;
  const matches = [];
  for (const match of String(text || '').matchAll(pattern)) {
    if (PARTICLE_AFTER_PAREN.test(match[2])) continue;
    matches.push(match);
  }
  if (matches.length) {
    issues.push(makeIssue('numeric_parenthesis_join', matches.length, matches.map(match => sentenceOrdinalAt(text, match.index))));
  }
}

function pushSentenceIssue(issues, text, code, predicate) {
  const sentences = splitSentences(text);
  const ordinals = [];
  sentences.forEach((sentence, index) => {
    if (predicate(String(sentence || ''))) ordinals.push(index + 1);
  });
  if (ordinals.length) issues.push(makeIssue(code, ordinals.length, ordinals));
}

function pushRepeatedVagueDemonstrative(issues, text) {
  const paragraphs = String(text || '').split(/\n[ \t]*\n+/u).map(item => item.trim()).filter(Boolean);
  const ordinals = [];
  paragraphs.forEach((paragraph, index) => {
    if (/^(?:이러한|이런|그러한)\s*(?:변화|과정|경험|결과|점|부분)(?:은|는|이|가)/u.test(paragraph)) ordinals.push(index + 1);
  });
  if (ordinals.length >= 2) issues.push(makeIssue('repeated_vague_demonstrative', ordinals.length, ordinals));
}

function mergeIssueComparison(sourceIssues, outputIssues) {
  const before = new Map(sourceIssues.map(item => [item.code, item]));
  const after = new Map(outputIssues.map(item => [item.code, item]));
  const codes = [...new Set([...before.keys(), ...after.keys()])];
  return codes.map(code => {
    const definition = ISSUE_DEFINITIONS[code] || {};
    const sourceItem = before.get(code);
    const outputItem = after.get(code);
    const beforeCount = sourceItem?.count || 0;
    const afterCount = outputItem?.count || 0;
    return {
      code,
      beforeCount,
      afterCount,
      introducedCount: Math.max(0, afterCount - beforeCount),
      resolvedCount: Math.max(0, beforeCount - afterCount),
      weight: definition.weight || 1,
      repairable: definition.repairable === true,
      deterministicSafe: definition.deterministicSafe === true,
      message: definition.message || '한국어 표현을 확인해 주세요.',
      sentenceOrdinals: outputItem?.sentenceOrdinals || [],
      details: outputItem?.details || null
    };
  });
}

function mergeSameCode(items) {
  const merged = new Map();
  for (const item of items || []) {
    if (!merged.has(item.code)) {
      merged.set(item.code, { ...item, sentenceOrdinals: [...(item.sentenceOrdinals || [])] });
      continue;
    }
    const current = merged.get(item.code);
    current.count += item.count || 0;
    current.sentenceOrdinals = [...new Set([...current.sentenceOrdinals, ...(item.sentenceOrdinals || [])])];
  }
  return [...merged.values()];
}

function makeIssue(code, count, sentenceOrdinals = [], details = null) {
  const definition = ISSUE_DEFINITIONS[code] || {};
  return {
    code,
    count: Number(count) || 0,
    sentenceOrdinals: [...new Set((sentenceOrdinals || []).filter(Number.isFinite))],
    repairable: definition.repairable === true,
    deterministicSafe: definition.deterministicSafe === true,
    weight: definition.weight || 1,
    message: definition.message || '한국어 표현을 확인해 주세요.',
    details
  };
}

function qualityWarning(item) {
  return {
    code: `korean_${item.code}`,
    severity: 'warning',
    message: item.message,
    count: item.introducedCount,
    introducedCount: item.introducedCount,
    sentenceOrdinals: item.sentenceOrdinals || []
  };
}

const ORPHAN_STRUCTURAL_PARTICLE_RE = /^(\s*)(에서는|에게는|으로는|로는|부터는|까지는|에는|에서|에게|으로|부터|까지|은|는|이|가|을|를|의|에|로|와|과|도|만)\s+(?=\S)/u;

function pushOrphanStructuralParticleIssue(issues, text) {
  const occurrences = orphanStructuralParticleOccurrences(text);
  if (!occurrences.length) return;
  issues.push(makeIssue(
    'orphan_structural_particle',
    occurrences.length,
    occurrences.map(item => item.sentenceOrdinal),
    {
      lineNumbers: occurrences.map(item => item.lineNumber),
      particles: occurrences.map(item => item.particle)
    }
  ));
}

function orphanStructuralParticleOccurrences(value) {
  const text = String(value || '').replace(/\r\n?/gu, '\n');
  const lines = text.split('\n');
  const occurrences = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index] || '');
    const match = line.match(ORPHAN_STRUCTURAL_PARTICLE_RE);
    if (match) {
      const previousIndex = previousNonEmptyLineIndex(lines, index);
      const previous = previousIndex >= 0 ? String(lines[previousIndex] || '').trim() : '';
      const role = previous ? layoutStructure.classifyLine(previous) : '';
      const structuralPrevious = ['title', 'heading', 'label', 'label_inline', 'list'].includes(role)
        || /^(?:\d{1,3}(?:[-.]\d+)*[.)]|[가-힣][.)]|[①-⑳]|[●○■□◆◇▶▷※])\s*\S/u.test(previous);
      if (structuralPrevious) {
        occurrences.push({
          lineIndex: index,
          lineNumber: index + 1,
          particle: match[2],
          prefixLength: match[0].length,
          previousLine: previous,
          bodyText: line.slice(match[0].length).trim(),
          sentenceOrdinal: sentenceOrdinalAt(text, offset + match[1].length)
        });
      }
    }
    offset += line.length + 1;
  }
  return occurrences;
}

function repairIntroducedOrphanStructuralParticles(source, outputText) {
  const sourceOccurrences = orphanStructuralParticleOccurrences(source);
  const outputOccurrences = orphanStructuralParticleOccurrences(outputText);
  let remainingIntroduced = Math.max(0, outputOccurrences.length - sourceOccurrences.length);
  if (remainingIntroduced === 0) {
    return { text: String(outputText || ''), repairCount: 0 };
  }
  const carriedOutputIndexes = matchCarriedOrphanOccurrences(sourceOccurrences, outputOccurrences);
  const targetLines = new Set(
    outputOccurrences
      .filter((_item, index) => !carriedOutputIndexes.has(index))
      .slice(0, remainingIntroduced)
      .map(item => item.lineIndex)
  );
  let repairCount = 0;
  const lines = String(outputText || '').replace(/\r\n?/gu, '\n').split('\n').map((line, index) => {
    if (!targetLines.has(index) || remainingIntroduced <= 0) return line;
    const repaired = String(line || '').replace(
      ORPHAN_STRUCTURAL_PARTICLE_RE,
      (_match, indentation) => indentation
    );
    if (repaired !== line) {
      repairCount += 1;
      remainingIntroduced -= 1;
    }
    return repaired;
  });
  return { text: lines.join('\n'), repairCount };
}

function matchCarriedOrphanOccurrences(sourceOccurrences, outputOccurrences) {
  const usedOutputIndexes = new Set();
  for (const sourceItem of sourceOccurrences || []) {
    const candidates = (outputOccurrences || [])
      .map((outputItem, index) => ({
        index,
        score: orphanOccurrenceSimilarity(sourceItem, outputItem)
      }))
      .filter(item => !usedOutputIndexes.has(item.index) && item.score >= 0)
      .sort((left, right) => right.score - left.score || left.index - right.index);
    if (candidates.length) usedOutputIndexes.add(candidates[0].index);
  }
  return usedOutputIndexes;
}

function orphanOccurrenceSimilarity(sourceItem, outputItem) {
  if (String(sourceItem?.particle || '') !== String(outputItem?.particle || '')) return -1;
  const sourceHeading = new Set(contentTokensLocal(sourceItem?.previousLine || ''));
  const outputHeading = new Set(contentTokensLocal(outputItem?.previousLine || ''));
  const sourceBody = new Set(contentTokensLocal(sourceItem?.bodyText || '').slice(0, 8));
  const outputBody = new Set(contentTokensLocal(outputItem?.bodyText || '').slice(0, 8));
  return (setOverlap(sourceHeading, outputHeading) * 0.7)
    + (setOverlap(sourceBody, outputBody) * 0.3);
}

function setOverlap(left, right) {
  if (!left.size && !right.size) return 1;
  const denominator = Math.max(left.size, right.size, 1);
  let shared = 0;
  for (const value of left) {
    if (right.has(value)) shared += 1;
  }
  return shared / denominator;
}

function previousNonEmptyLineIndex(lines, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (String(lines[cursor] || '').trim()) return cursor;
  }
  return -1;
}

function sourceReviewMessage(code) {
  const definition = ISSUE_DEFINITIONS[code];
  const base = definition?.message || '원문의 한국어 표현을 확인해 주세요.';
  return `원문 확인: ${base}`;
}

function replaceAndCount(text, pattern, replacement, code, changes) {
  return String(text || '').replace(pattern, (...args) => {
    changes.push(code);
    if (typeof replacement === 'function') return replacement(...args);
    return replacement.replace(/\$(\d+)/gu, (_match, index) => args[Number(index) - 1] || '');
  });
}

const PROTECTED_QUOTED_SPAN_RE = /([“][^”\n]{0,600}[”]|[‘][^’\n]{0,600}[’]|「[^」\n]{0,600}」|『[^』\n]{0,600}』|《[^》\n]{0,600}》|〈[^〉\n]{0,600}〉|"[^"\n]{0,600}"|'[^'\n]{0,600}')/gu;

function replaceOutsideProtectedQuotes(text, pattern, replacement, code, changes) {
  return String(text || '').split(PROTECTED_QUOTED_SPAN_RE).map((part, index) => {
    if (index % 2 === 1) return part;
    return replaceAndCount(part, pattern, replacement, code, changes);
  }).join('');
}

function subjectParticleFor(noun) {
  const value = String(noun || '');
  const last = value.codePointAt(value.length - 1);
  if (!Number.isFinite(last) || last < 0xAC00 || last > 0xD7A3) return '이';
  return (last - 0xAC00) % 28 === 0 ? '가' : '이';
}

function sentenceOrdinalAt(text, offset) {
  const before = String(text || '').slice(0, Math.max(0, Number(offset) || 0));
  return Math.max(1, splitSentences(before).length || 1);
}

function countMatches(value, pattern) {
  return (String(value || '').match(cloneGlobal(pattern)) || []).length;
}

function cloneGlobal(pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

function profileName(documentProfile) {
  return String(documentProfile?.profile || documentProfile?.contentGenre || documentProfile || 'unknown');
}

module.exports = {
  VERSION,
  ISSUE_DEFINITIONS,
  analyzeKoreanRefinement,
  applySafeDeterministicRepairs,
  applySafeFormattingRepairs,
  buildSourcePromptHints,
  buildSourceReviewWarnings,
  detectTextIssues,
  detectProfessionalDowngrade,
  restoreIntroducedIntegritySentences,
  isImprovedAudit
};
