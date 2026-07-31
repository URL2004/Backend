'use strict';

const { splitSentences, splitSentenceSpans, koreanStart, normalizeCompact } = require('../engine/koreanText');
const layoutStructure = require('./layoutStructure');
const { restoreSourceSentenceOrdinals } = require('./sourceSentenceRestore');
const {
  alignedOutputCandidates,
  contentTokens: contentTokensLocal,
  normalizeSentence: normalizeSentenceLocal
} = require('./sentenceAlignment');

const VERSION = 18;
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
  lactation_mode_spelling: {
    weight: 4,
    repairable: true,
    deterministicSafe: true,
    message: '기술 용어 “착유 모드” 사이에 잘못 들어간 쉼표를 제거해야 해요.'
  },
  internal_report_spacing: {
    weight: 2,
    repairable: true,
    deterministicSafe: true,
    message: '“내부 성적서”의 띄어쓰기를 확인해 주세요.'
  },
  percentage_formula_parentheses: {
    weight: 5,
    repairable: true,
    deterministicSafe: true,
    message: '감소율 계산식의 결과와 연산 순서가 맞도록 분자 괄호가 필요해요.'
  },
  role_definition_inversion: {
    weight: 4,
    repairable: true,
    deterministicSafe: false,
    message: '기관·직무와 역할의 주어·보어 관계가 뒤집혀 문장이 어색해요.'
  },
  technical_term_consistency_review: {
    weight: 1,
    repairable: false,
    deterministicSafe: false,
    message: '같은 펌프 사양을 “유속”과 “유량”으로 혼용했는지 실제 사내 용어를 확인해 주세요.'
  },
  technical_notation_consistency_review: {
    weight: 1,
    repairable: false,
    deterministicSafe: false,
    message: '트레이드오프 영문·한글 표기가 문서 안에서 혼용됐는지 확인해 주세요.'
  },
  technical_scope_ambiguity_review: {
    weight: 1,
    repairable: false,
    deterministicSafe: false,
    message: '시험 펌웨어나 신고 연동의 실제 구현 범위가 문장만으로 불분명한 부분이 있어요.'
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
  misplaced_clause_connector: {
    weight: 4,
    repairable: true,
    deterministicSafe: false,
    message: '대조 접속어가 주제·장소 성분 뒤에 끼어 문장 흐름이 어색해요.'
  },
  abstract_mass_quantifier: {
    weight: 4,
    repairable: true,
    deterministicSafe: false,
    message: '셀 수 없는 추상 개념에 “다수의”가 붙어 수량 표현이 어색해요.'
  },
  weak_function_predicate: {
    weight: 5,
    repairable: true,
    deterministicSafe: false,
    message: '기능·역할을 “취약한 수준으로 수행하다”처럼 서술해 목적어와 상태 표현이 맞지 않아요.'
  },
  condition_commitment_mismatch: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '성장 조건을 여는 “~하려면”과 막연한 미래 다짐이 느슨하게 연결돼요.'
  },
  fear_object_collocation: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '경험·배움 자체를 두려워한다고 표현해 목적어와 감정 서술의 결합이 어색해요.'
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
  borrowed_standard_case_frame: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '평가 기준을 “가져와” 자신을 평가한다고 표현해 기준과 평가의 연결이 어색해요.'
  },
  goal_direction_reference_mismatch: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '앞에서 정한 목표를 뒤에서 “그 방향”으로 받아 지시 대상이 어긋났어요.'
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
  introduced_residual_clause_duplication: {
    weight: 5,
    repairable: true,
    deterministicSafe: true,
    message: '수정된 문장 뒤에 원래 문장의 조사·서술 꼬리가 다시 붙어 있어요.'
  },
  source_token_repetition_review: {
    weight: 1,
    repairable: false,
    deterministicSafe: false,
    message: '원문에 같은 한글 조각이 겹쳐 입력된 것으로 보이는 단어가 있어요.'
  },
  reduplicative_root_loss: {
    weight: 5,
    repairable: true,
    deterministicSafe: false,
    message: '“단단하다·꼼꼼하다”처럼 반복되는 한국어 어근이 한 음절로 잘못 줄었어요.'
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
  academic_purpose_chain_overloaded: {
    weight: 2,
    repairable: true,
    deterministicSafe: false,
    message: '한 연구 목적문에 목적·핵심 단서·작동 과정·검증 조건이 겹쳐 호흡과 논리 단계가 흐려져요.'
  },
  affective_anchor_omission: {
    weight: 4,
    repairable: true,
    deterministicSafe: false,
    message: '성찰문에 있던 구체적인 감정·내적 질문·인정 욕구가 일반적인 교훈으로 축약됐을 수 있어요.'
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
const QUOTE_COPULA_SUFFIX = '(?:라(?:고|는|며|면)|인(?:가|데|지|바|셈|것|경우|만큼|듯|채|줄)?|이(?:라(?:고|는|며|면)?|란|지(?:만)?|다|고|며|어서|므로|었(?:습니다|다|던|고|지만|으면|다면|다는|을|는데|으며)?|었던)|였(?:습니다|다|던|고|지만|으면|다면|다는|을|는데|으며)?|입니다|일(?:수|지|까|뿐|때|경우)?|임(?:을|이|은|도)?)';
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

  const labelBoundary = repairIntroducedLabelBodyLineBreaks(before, source, context);
  const particleBoundary = repairIntroducedParticleLineBreaks(labelBoundary.text, source, context);
  // `line_sensitive`는 설문·항목 행을 함부로 재배치하지 말라는 뜻이지,
  // 창작문처럼 모든 안전 형식 보정을 끄라는 뜻은 아니다. 원문 대조가
  // 가능한 조사 줄바꿈은 먼저 복원하고, 일반 산문 경계 추론만 생략한다.
  const boundary = context.lineSensitive
    ? { text: particleBoundary.text, changeCounts: {} }
    : repairBrokenProseBoundaries(particleBoundary.text, context);
  const siblingLabels = repairSiblingLabelSpacing(boundary.text, source);
  const spacing = repairContextualSpacing(siblingLabels.text, source, context);
  const changeCounts = mergeChangeCounts(
    labelBoundary.changeCounts,
    particleBoundary.changeCounts,
    boundary.changeCounts,
    siblingLabels.changeCounts,
    spacing.changeCounts
  );
  const changeCodes = Object.keys(changeCounts).filter(code => changeCounts[code] > 0);
  return {
    version: 1,
    text: spacing.text,
    applied: spacing.text !== before,
    changeCount: Object.values(changeCounts).reduce((sum, count) => sum + count, 0),
    changeCodes,
    changeCounts,
    brokenLineBreakRepairCount: Number(changeCounts.broken_prose_linebreak || 0)
      + Number(changeCounts.particle_linebreak_join || 0)
      + Number(changeCounts.label_body_linebreak_join || 0),
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

/**
 * 원문에서 `라벨: 본문`이 한 행이었는데 결과에서 라벨과 본문이 갈라진
 * 경우 원래 역할만 복원한다. 라벨 접두부가 원문과 정확히 같고 원문 같은
 * 행에 실제 본문이 있었을 때만 실행한다.
 */
function repairIntroducedLabelBodyLineBreaks(value, source, context) {
  const before = String(value || '').replace(/\r\n?/gu, '\n');
  if (!before || context?.creative) return { text: before, changeCounts: {} };
  const sourceLines = String(source || '').replace(/\r\n?/gu, '\n').split('\n');
  const lines = before.split('\n');
  const guards = buildLineGuards(lines);
  const counts = {};
  let index = 0;
  while (index < lines.length - 1) {
    const left = String(lines[index] || '').trim();
    const nextIndex = nextNonEmptyLineIndex(lines, index + 1);
    if (!left || nextIndex < 0
        || !/[:：]\s*$/u.test(left)
        || guards[index]?.code
        || guards[nextIndex]?.code
        || guards[index]?.reference
        || guards[nextIndex]?.reference
        || guards[index]?.table
        || guards[nextIndex]?.table) {
      index += 1;
      continue;
    }
    const right = String(lines[nextIndex] || '').trim();
    const rightRole = layoutStructure.classifyLine(right);
    if (!right || ['heading', 'label', 'label_inline', 'list', 'table'].includes(rightRole)) {
      index += 1;
      continue;
    }
    const labelKey = normalizeForTitle(left);
    const sourceInline = sourceLines.some(sourceLine => {
      const trimmed = String(sourceLine || '').trim();
      const normalized = normalizeForTitle(trimmed);
      return normalized.startsWith(labelKey) && normalized.length > labelKey.length;
    });
    if (!sourceInline) {
      index += 1;
      continue;
    }
    lines[index] = `${String(lines[index] || '').trimEnd()} ${String(lines[nextIndex] || '').trimStart()}`;
    lines.splice(index + 1, nextIndex - index);
    guards.splice(index + 1, nextIndex - index);
    addCount(counts, 'label_body_linebreak_join');
  }
  return { text: lines.join('\n'), changeCounts: counts };
}

function nextNonEmptyLineIndex(lines, start) {
  for (let index = Math.max(0, Number(start) || 0); index < lines.length; index += 1) {
    if (String(lines[index] || '').trim()) return index;
  }
  return -1;
}

/**
 * 인용·명사구 뒤의 조사가 다음 행으로 밀린 경우를 원문 대조로만 복원한다.
 * 일반 인용 행은 구조 보호 대상이지만 `'수행 목표'\n의 '숙달 목표'`처럼
 * 원문에 붙어 있던 동일 경계가 결과에서만 갈라진 경우에는 조사까지 같은
 * 문장에 있어야 한다. 내용은 바꾸지 않고 줄바꿈 한 문자만 제거한다.
 */
function repairIntroducedParticleLineBreaks(value, source, context) {
  const before = String(value || '').replace(/\r\n?/gu, '\n');
  if (!before || context?.creative) return { text: before, changeCounts: {} };
  const sourceCompact = normalizeCompact(source);
  if (!sourceCompact) return { text: before, changeCounts: {} };
  const lines = before.split('\n');
  const guards = buildLineGuards(lines);
  const counts = {};
  let index = 0;
  while (index < lines.length - 1) {
    const left = String(lines[index] || '').trim();
    const right = String(lines[index + 1] || '').trim();
    if (!left || !right || guards[index]?.code || guards[index + 1]?.code
        || guards[index]?.reference || guards[index + 1]?.reference
        || guards[index]?.table || guards[index + 1]?.table) {
      index += 1;
      continue;
    }
    // 조사가 다음 행으로 밀린 실제 경계만 합친다. 예전 정규식은 조사
    // 다음에 임의의 한글을 허용해 `이번`, `가장`, `은퇴` 같은 일반 단어의
    // 첫 음절을 조사로 오인했고, 제목 행과 본문을 `점이번`처럼 붙였다.
    const particle = right.match(/^(의|은|는|이|가|을|를|와|과|에|에서|에게|으로|로|도|만|부터|까지|처럼|보다)(?=\s|[‘“"'「『《〈(（\[【])/u);
    const eligibleLeft = !/[.!?。！？…,:;：；]\s*[”’」』》〉"')\]]*$/u.test(left)
      && /[가-힣A-Za-z0-9”’」』》〉"')\]]$/u.test(left);
    if (!particle || !eligibleLeft || isStandaloneStructureLine(right)) {
      index += 1;
      continue;
    }
    const joined = `${left}${right}`;
    if (!sourceSupportsParticleJoin(source, sourceCompact, left, right, joined)) {
      index += 1;
      continue;
    }
    lines[index] = `${String(lines[index] || '').trimEnd()}${String(lines[index + 1] || '').trimStart()}`;
    lines.splice(index + 1, 1);
    guards.splice(index + 1, 1);
    addCount(counts, 'particle_linebreak_join');
  }
  return { text: lines.join('\n'), changeCounts: counts };
}

function sourceSupportsParticleJoin(source, sourceCompact, left, right, joined) {
  const leftCompact = normalizeCompact(left);
  const rightCompact = normalizeCompact(right);
  const sourceLines = String(source || '').replace(/\r\n?/gu, '\n').split('\n');
  for (let index = 0; index < sourceLines.length - 1; index += 1) {
    const sourceLeft = normalizeCompact(sourceLines[index]);
    const sourceRight = normalizeCompact(sourceLines[index + 1]);
    if (!sourceLeft || !sourceRight) continue;
    if (sourceLeft.endsWith(leftCompact.slice(-Math.min(18, leftCompact.length)))
        && sourceRight.startsWith(rightCompact.slice(0, Math.min(18, rightCompact.length)))) {
      return false;
    }
  }
  const compactJoined = normalizeCompact(joined);
  if (compactJoined.length <= 72 && sourceCompact.includes(compactJoined)) return true;
  for (const leftSize of [24, 16, 10, 6]) {
    for (const rightSize of [32, 24, 16, 10]) {
      const evidence = `${leftCompact.slice(-leftSize)}${rightCompact.slice(0, rightSize)}`;
      if (evidence.length >= 12 && sourceCompact.includes(evidence)) return true;
    }
  }
  return false;
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
    if (protectWholeTitle) {
      // 첫 제목은 어휘·순서·인용을 그대로 잠그되, 뜻을 추측하지 않고
      // 공백 하나만 추가하는 고신뢰 표기만 허용한다.
      return repairHighConfidenceLockedSpacing(workingLine, counts);
    }
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
      out = repairHighConfidenceLockedSpacing(out, counts);
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

function repairHighConfidenceLockedSpacing(value, counts) {
  let out = String(value || '');
  out = replaceTracked(
    out,
    /해낼수(?=\s*(?:있|없|있는|없는|있었|없었))/gu,
    () => '해낼 수',
    'dependent_noun_su_spacing',
    counts
  );
  out = replaceTracked(
    out,
    /(^|[^가-힣A-Za-z0-9_])외(\d{1,3})명(?=$|[^가-힣A-Za-z0-9_])/gu,
    (_match, prefix, count) => `${prefix}외 ${count}명`,
    'other_people_count_spacing',
    counts
  );
  out = replaceTracked(
    out,
    /국제적인정(?=(?:은|는|이|가|을|를|의|에|으로|과|와|도|만)?(?:$|[^가-힣A-Za-z0-9_]))/gu,
    () => '국제적 인정',
    'international_recognition_spacing',
    counts
  );
  out = replaceTracked(
    out,
    /한국무용수(?=(?:은|는|이|가|을|를|의|에|로|와|과|도|만)?(?:$|[^가-힣A-Za-z0-9_]))/gu,
    () => '한국 무용수',
    'korean_dancer_spacing',
    counts
  );
  return out;
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
        || ((!brokenTitleFragment) && ['title', 'heading', 'label', 'label_inline', 'list', 'table', 'flow', 'quote'].includes(role))
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
  if (['title', 'heading', 'label', 'label_inline', 'list', 'table', 'flow', 'quote'].includes(role)) return true;
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
    creative: profile === 'creative' || flags.has('creative_lines'),
    lineSensitive: flags.has('line_sensitive')
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
  const residualClauseDuplication = detectIntroducedResidualClauseDuplication(source, outputText);
  if (residualClauseDuplication) outputIssues.push(residualClauseDuplication);
  const professional = detectProfessionalDowngrade(source, outputText, profile);
  if (professional) outputIssues.push(professional);
  const persistentTense = detectIntroducedPersistentStateTenseRegression(source, outputText);
  if (persistentTense) outputIssues.push(persistentTense);
  const reduplicativeRootLoss = detectReduplicativeRootLoss(source, outputText);
  if (reduplicativeRootLoss) outputIssues.push(reduplicativeRootLoss);
  const affectiveAnchorOmission = detectAffectiveAnchorOmission(source, outputText, profile);
  if (affectiveAnchorOmission) outputIssues.push(affectiveAnchorOmission);
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
  pushPatternIssue(issues, text, 'lactation_mode_spelling', /착\s*[,，]\s*유(?=\s*모드)/gu);
  pushPatternIssue(issues, text, 'internal_report_spacing', /내부성적서/gu);
  pushPercentageFormulaParenthesesIssue(issues, text);
  pushSentenceIssue(issues, text, 'role_definition_inversion', hasRoleDefinitionInversion);
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
  pushSentenceIssue(
    issues,
    text,
    'misplaced_clause_connector',
    sentence => /^[^.!?。！？\n]{1,60}(?:에서는|에는|에서도|은|는)\s+(?:그러나|하지만|다만|반면)(?=\s)/u
      .test(stripProtectedQuotedText(sentence).trim())
  );
  pushSentenceIssue(
    issues,
    text,
    'abstract_mass_quantifier',
    sentence => /다수의\s+(?:신용|신뢰|존중|협력|전문성|성실함|꼼꼼함|유연성|안전성|책임감)(?:을|를|이|가|은|는|에|으로|과|와)?(?=$|[\s,.;:!?。！？])/u
      .test(stripProtectedQuotedText(sentence))
  );
  pushSentenceIssue(
    issues,
    text,
    'weak_function_predicate',
    sentence => /(?:기능|역할|효과|성능|역량)(?:을|를)\s+(?:(?:매우|상당히)\s+)?(?:취약|부족|미흡|불충분)한\s+수준으로\s+(?:수행|발휘|작동|실행)(?:하|되|했|합|하고|하며)/u
      .test(stripProtectedQuotedText(sentence))
  );
  pushSentenceIssue(
    issues,
    text,
    'condition_commitment_mismatch',
    sentence => /(?:성장|발전|개선|향상)하려면[^.!?。！？\n]{0,90}(?:도전|노력|보완|학습|배우|키우|참여)[^.!?。！？\n]{0,30}(?:하겠습니다|겠습니다)/u
      .test(stripProtectedQuotedText(sentence))
  );
  pushSentenceIssue(
    issues,
    text,
    'fear_object_collocation',
    sentence => /(?:경험|배움|학습|기회)(?:과|와|이나|나)\s*(?:경험|배움|학습|기회)(?:을|를)\s+두려워하지/u
      .test(stripProtectedQuotedText(sentence))
  );
  pushSentenceIssue(issues, text, 'meta_nominalization_injection', hasMetaNominalizationInjection);
  pushSentenceIssue(issues, text, 'role_predicate_redundancy', hasRolePredicateRedundancy);
  pushSentenceIssue(issues, text, 'analytic_object_recast', hasAnalyticObjectRecast);
  pushSentenceIssue(issues, text, 'borrowed_standard_case_frame', hasBorrowedStandardCaseFrame);
  pushSentenceIssue(issues, text, 'goal_direction_reference_mismatch', hasGoalDirectionReferenceMismatch);
  pushEnumerationParallelismIssue(issues, text);
  if (profile === 'mail_notice') pushFunctionalGreetingDuplication(issues, text);
  if (isFormalRegisterTarget(targetRegister, profile)) {
    pushFormalRegisterResidual(issues, text, { profile, targetRegister });
  }
  pushSelfEvaluationRepetition(issues, text);
  if (/(?:연구|실험|공정|시편|분석\s*장비)/u.test(text)) {
    pushSentenceIssue(issues, text, 'overloaded_research_action_chain', isOverloadedResearchActionChain);
  }
  if (['academic_paper', 'report_assignment', 'long_explainer'].includes(profile)) {
    pushSentenceIssue(issues, text, 'academic_purpose_chain_overloaded', isOverloadedAcademicPurposeChain);
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
    if (PROFESSIONAL_PROFILES.has(profile)) {
      pushTechnicalTerminologyReview(issues, text);
      pushTechnicalScopeAmbiguityReview(issues, text);
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
  const residualClauseRepair = repairIntroducedResidualClauseDuplications(source, text);
  text = residualClauseRepair.text;
  for (let index = 0; index < residualClauseRepair.repairCount; index += 1) {
    changes.push('introduced_residual_clause_duplication');
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
  text = replaceOutsideProtectedQuotes(
    text,
    /착\s*[,，]\s*유(?=\s*모드)/gu,
    '착유',
    'lactation_mode_spelling',
    changes
  );
  text = replaceOutsideProtectedQuotes(
    text,
    /내부성적서/gu,
    '내부 성적서',
    'internal_report_spacing',
    changes
  );
  const formulaRepair = repairPercentageFormulaParentheses(text);
  text = formulaRepair.text;
  for (let index = 0; index < formulaRepair.repairCount; index += 1) {
    changes.push('percentage_formula_parentheses');
  }
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
  'misplaced_clause_connector',
  'abstract_mass_quantifier',
  'weak_function_predicate',
  'condition_commitment_mismatch',
  'fear_object_collocation',
  'meta_nominalization_injection',
  'role_predicate_redundancy',
  'analytic_object_recast',
  'borrowed_standard_case_frame',
  'goal_direction_reference_mismatch',
  'affective_anchor_omission',
  'academic_purpose_chain_overloaded',
  'repeated_clause_anchor',
  'professional_register_downgrade',
  'formal_register_residual',
  'role_definition_inversion',
  'passive_causative_stack',
  'double_object_time_expenditure',
  'persistent_state_tense_regression',
  'reduplicative_root_loss',
  'orphan_structural_particle'
]);

function restoreIntroducedIntegritySentences({ source = '', outputText = '', audit = null } = {}) {
  const ordinals = [];
  const affectiveSourceOrdinals = [];
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
    if (issue.code === 'affective_anchor_omission') {
      for (const omission of issue.details?.omissions || []) {
        if (Number(omission.sourceOrdinal) > 0) {
          affectiveSourceOrdinals.push(Number(omission.sourceOrdinal));
        }
      }
      continue;
    }
    ordinals.push(...(issue.sentenceOrdinals || []));
  }
  const regularRestore = restoreSourceSentenceOrdinals(source, outputText, ordinals, {
    maxRestoreCount: 8,
    minSimilarity: 0.24,
    ordinalSpace: 'output'
  });
  const affectiveRestore = restoreSourceSentenceOrdinals(
    source,
    regularRestore.text,
    affectiveSourceOrdinals,
    {
      maxRestoreCount: 4,
      minSimilarity: 0.24,
      ordinalSpace: 'source',
      allowStablePositionalFallback: true
    }
  );
  const restoredSentenceOrdinals = [
    ...(regularRestore.restoredSentenceOrdinals || []),
    ...(affectiveRestore.restoredSentenceOrdinals || [])
  ];
  return {
    ...affectiveRestore,
    applied: regularRestore.applied === true || affectiveRestore.applied === true,
    restoredSentenceCount: restoredSentenceOrdinals.length,
    restoredSentenceOrdinals,
    reason: regularRestore.applied === true || affectiveRestore.applied === true
      ? 'restored'
      : (affectiveRestore.reason || regularRestore.reason),
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
    if (left.length < 18 || right.length < 8) continue;
    if (/^(?:#{1,6}|[-*+•▪◦●○■□◆◇▶▷※]|제\s*\d+\s*조)/u.test(left)
        || /^(?:#{1,6}|[-*+•▪◦●○■□◆◇▶▷※]|제\s*\d+\s*조)/u.test(right)) continue;
    const leftTokens = new Set(contentTokensLocal(left));
    const rightTokens = new Set(contentTokensLocal(right));
    const shortCognitiveEcho = isShortCognitiveEcho(left, right);
    if ((leftTokens.size < 4 || rightTokens.size < 4) && !shortCognitiveEcho) continue;
    const intersection = [...leftTokens].filter(token => rightTokens.has(token)).length;
    const containment = intersection / Math.max(1, Math.min(leftTokens.size, rightTokens.size));
    const lengthRatio = Math.min(left.length, right.length) / Math.max(left.length, right.length);
    if ((containment >= 0.8 && lengthRatio >= 0.68) || shortCognitiveEcho) ordinals.push(index + 2);
  }
  return ordinals;
}

const COGNITIVE_ECHO_PATTERNS = Object.freeze([
  /(?:질문|의문|궁금|떠올리|생각이\s*들|생각하게\s*되)/u,
  /(?:알게\s*되|깨닫|이해하게\s*되|파악하게\s*되)/u,
  /(?:배우게\s*되|배웠|교훈을\s*얻|익히게\s*되)/u,
  /(?:느끼게\s*되|느꼈|체감하게\s*되|실감하게\s*되)/u,
  /(?:확인하게\s*되|확인했|분명해졌|알아볼\s*수\s*있었)/u
]);

function isShortCognitiveEcho(leftValue, rightValue) {
  const left = String(leftValue || '').trim();
  const right = String(rightValue || '').trim();
  if (right.length > 48 || right.length > left.length * 0.72) return false;
  const family = COGNITIVE_ECHO_PATTERNS.findIndex(pattern => pattern.test(left));
  if (family < 0 || !COGNITIVE_ECHO_PATTERNS[family].test(right)) return false;
  const roots = value => new Set(contentTokensLocal(value).map(token => (
    token.replace(/(?:으로부터|에게서|에서는|으로는|이라는|이라고|은|는|이|가|을|를|의|와|과|도|만|에|로)$/u, '')
  )).filter(token => token.length >= 2));
  const leftRoots = roots(left);
  return [...roots(right)].some(token => leftRoots.has(token));
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
    concept: 'formal_validation_result',
    professionalOnly: true,
    source: /(?:시험|검증|평가)(?:하|한|해\s*본)\s*결과/u,
    acceptable: /(?:시험|검증|평가)(?:하|한|해\s*본)\s*결과|(?:시험|검증|평가)을\s*통해/u,
    preferred: ['시험한 결과', '검증한 결과']
  },
  {
    concept: 'comparative_review',
    professionalOnly: true,
    source: /(?:비교[^.!?。！？\n]{0,45}검토|검토[^.!?。！？\n]{0,45}비교)/u,
    acceptable: /(?:비교[^.!?。！？\n]{0,45}검토|검토[^.!?。！？\n]{0,45}비교)/u,
    preferred: ['비교 검토하다', '두 방식을 검토하여 비교하다']
  },
  {
    concept: 'competency_development',
    professionalOnly: true,
    source: /(?:역량|능력)(?:을|를)\s*(?:길렀|기르|강화|높였|키웠|갖췄|갖추)/u,
    acceptable: /(?:역량|능력)(?:(?:을|를)\s*|(?:은|는)[^.!?。！？\n]{0,60})(?:길렀|기르|강화|높였|키웠|갖췄|갖추)/u,
    preferred: ['역량을 길렀습니다', '능력을 강화했습니다']
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

function detectIntroducedResidualClauseDuplication(source, outputText) {
  const introduced = introducedResidualClauseDuplications(source, outputText);
  if (!introduced.length) return null;
  return makeIssue(
    'introduced_residual_clause_duplication',
    introduced.length,
    introduced.map(item => item.sentenceOrdinal),
    {
      duplicates: introduced.slice(0, 12).map(item => ({
        kind: item.kind,
        sentence: item.rightText.slice(0, 160)
      }))
    }
  );
}

function repairIntroducedResidualClauseDuplications(source, outputText) {
  const before = String(outputText || '');
  const introduced = introducedResidualClauseDuplications(source, before);
  if (!introduced.length) return { text: before, repairCount: 0 };
  let text = before;
  let repairCount = 0;
  for (const item of [...introduced].sort((left, right) => right.start - left.start)) {
    if (text.slice(item.start, item.end) !== item.rawText) continue;
    text = `${text.slice(0, item.start)}${text.slice(item.end)}`;
    repairCount += 1;
  }
  text = text
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n[ \t]+/gu, '\n');
  return { text, repairCount };
}

function introducedResidualClauseDuplications(source, outputText) {
  const sourceRows = findResidualClauseDuplications(source);
  const outputRows = findResidualClauseDuplications(outputText);
  if (!outputRows.length) return [];
  const carried = new Map();
  for (const item of sourceRows) {
    carried.set(item.signature, Number(carried.get(item.signature) || 0) + 1);
  }
  return outputRows.filter(item => {
    const remaining = Number(carried.get(item.signature) || 0);
    if (remaining <= 0) return true;
    carried.set(item.signature, remaining - 1);
    return false;
  });
}

function findResidualClauseDuplications(value) {
  const text = String(value || '');
  const spans = splitSentenceSpans(text);
  const rows = [];
  for (let index = 0; index < spans.length - 1; index += 1) {
    const left = String(spans[index].text || '').trim();
    const right = String(spans[index + 1].text || '').trim();
    if (!left || !right || right.length > 90) continue;
    if (/^(?:#{1,6}|[-*+•▪◦●○■□◆◇▶▷※]|\d{1,3}[.)]|제\s*\d+\s*조)/u.test(right)) continue;
    const leftCompact = residualCompact(left);
    const rightCompact = residualCompact(right);
    const exactTail = rightCompact.length >= 8 && leftCompact.endsWith(rightCompact);
    const attribution = isResidualQuoteAttribution(left, right);
    if (!exactTail && !attribution) continue;
    const kind = exactTail ? 'exact_tail' : 'quote_attribution_tail';
    rows.push({
      kind,
      signature: `${kind}:${residualSignature(right)}`,
      sentenceOrdinal: index + 2,
      start: spans[index + 1].start,
      end: spans[index + 1].end,
      rawText: text.slice(spans[index + 1].start, spans[index + 1].end),
      rightText: right
    });
  }
  return rows;
}

function isResidualQuoteAttribution(leftValue, rightValue) {
  const left = String(leftValue || '').trim();
  const right = String(rightValue || '').trim();
  if (!/^(?:라고|라며|라는)\s*(?:질문|묻|물|말|답|설명)/u.test(right)) return false;
  if (!/[”’」』》〉"'][^.!?。！？\n]{0,80}(?:라고|라며|라는)\s*(?:질문|묻|물|말|답|설명)/u.test(left)) {
    return false;
  }
  const rightTail = right.replace(/^(?:라고|라며|라는)\s*(?:질문|묻|물|말|답|설명)[가-힣]*/u, '');
  if (residualCompact(rightTail).length <= 6) return true;
  const leftRoots = residualRootSet(left);
  const rightRoots = residualRootSet(rightTail);
  let shared = 0;
  for (const token of rightRoots) if (leftRoots.has(token)) shared += 1;
  return shared >= 1 && shared / Math.max(1, rightRoots.size) >= 0.5;
}

function residualRootSet(value) {
  const roots = new Set();
  for (const token of contentTokensLocal(String(value || ''))) {
    let root = String(token || '').replace(/[^가-힣A-Za-z0-9]/gu, '');
    if (/^(?:질문|묻|물었|물어|말하|답하|설명하)/u.test(root)) root = '질문';
    root = root.replace(/(?:에서는|으로는|이라는|이라고|하며|하고|해서|한다|했다|됩니다|습니다|이다|였다|은|는|이|가|을|를|의|와|과|도|만|에|로)$/u, '');
    if (root.length >= 2) roots.add(root);
  }
  return roots;
}

function residualCompact(value) {
  return normalizeCompact(value).replace(/[.!?。！？…,:;：；"'”’「」『』《》〈〉()[\]{}]/gu, '');
}

function residualSignature(value) {
  return residualCompact(value)
    .replace(/^(?:라고|라며|라는)(?:질문|묻|물었|물어|말하|답하|설명하)[가-힣]*/u, 'attribution')
    .slice(0, 80);
}

/**
 * 모델이 `단단해서→단해`, `단단하게→단히`처럼 같은 음절이 반복되는
 * 한국어 어근의 한 음절을 지우며 비표준 활용을 만드는 경우를 찾는다.
 * 원문 토큰과 정렬된 결과 문장 안의 축약 토큰이 함께 확인될 때만 잡아
 * 정상적인 의역이나 `간단히` 같은 다른 단어를 오탐하지 않는다.
 */
function detectReduplicativeRootLoss(source, outputText) {
  const sourceSentences = splitSentences(String(source || '')).map(value => String(value || '').trim()).filter(Boolean);
  const outputSentences = splitSentences(String(outputText || '')).map(value => String(value || '').trim()).filter(Boolean);
  if (!sourceSentences.length || !outputSentences.length) return null;
  const losses = [];
  sourceSentences.forEach((sentence, sourceIndex) => {
    const sourceTokens = extractReduplicativeRootTokens(sentence);
    if (!sourceTokens.length) return;
    const best = alignedOutputCandidates(sentence, sourceIndex, sourceSentences.length, outputSentences)[0];
    if (!best || Number(best.score || 0) < 0.2) return;
    const outputWords = countWordOccurrences(String(best.sentence || '').match(/[가-힣]+/gu) || []);
    for (const token of sourceTokens) {
      if (Number(outputWords.get(token.token) || 0) > 0) continue;
      const corrupted = reduplicativeCorruptionCandidates(token)
        .find(candidate => Number(outputWords.get(candidate) || 0) > 0);
      if (!corrupted) continue;
      outputWords.set(corrupted, Number(outputWords.get(corrupted) || 0) - 1);
      losses.push({
        sourceOrdinal: sourceIndex + 1,
        outputOrdinal: best.index + 1,
        sourceToken: token.token,
        outputToken: corrupted,
        sourceSentence: sentence.slice(0, 220),
        outputSentence: String(best.sentence || '').slice(0, 220)
      });
    }
  });
  if (!losses.length) return null;
  return makeIssue(
    'reduplicative_root_loss',
    losses.length,
    losses.map(item => item.outputOrdinal),
    { alignedLosses: losses }
  );
}

function extractReduplicativeRootTokens(value) {
  const pattern = /(?<![가-힣])([가-힣])\1((?:하(?:게|여|고|며|면|도록|지만|지|다|기|니|자|세요|십시오|였(?:다|고|으며|지만|던)?)|해(?:서|도|야|지|진|졌다|졌고|졌으며|졌지만|졌던)?|히|한|할|함|했던|합니다|했다))(?=$|[^가-힣])/gu;
  return [...String(value || '').matchAll(pattern)].map(match => ({
    token: match[0],
    root: match[1],
    suffix: match[2]
  }));
}

function reduplicativeCorruptionCandidates(token) {
  const root = String(token?.root || '');
  const suffix = String(token?.suffix || '');
  const values = [`${root}${suffix}`];
  if (/^해/u.test(suffix)) {
    values.push(`${root}해`, `${root}히`);
  }
  if (/^하/u.test(suffix)) {
    values.push(`${root}히`, `${root}해`);
  }
  if (/^(?:히|한|할|함)/u.test(suffix)) values.push(`${root}${suffix[0]}`);
  return [...new Set(values)].filter(value => value !== String(token?.token || ''));
}

function countWordOccurrences(values) {
  const counts = new Map();
  for (const value of values || []) counts.set(value, Number(counts.get(value) || 0) + 1);
  return counts;
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
  const rest = value.replace(new RegExp(`^${firstPersonTopic}\\s+`, 'u'), '');
  if (rest === value) return false;
  const secondTopic = rest.match(
    /^(?:(?:이|그|해당|이번)\s+)?([가-힣A-Za-z0-9·_-]+(?:\s+[가-힣A-Za-z0-9·_-]+){0,2})(은|는)\s/u
  );
  if (!secondTopic) return false;
  const finalWord = `${String(secondTopic[1] || '').trim().split(/\s+/u).at(-1) || ''}${secondTopic[2]}`;
  // `저는 이 구절에서 특히 깊은 인상을 받았습니다`의 `깊은`은
  // 두 번째 주제 조사(깊+은)가 아니라 뒤 명사를 꾸미는 관형형이다.
  // 단순 음절 정규식으로 이를 주제로 세면 정상 성찰문을 비문으로
  // 복원하므로 자주 쓰이는 관형형은 제외한다.
  if (/^(?:깊은|같은|다른|많은|적은|작은|큰|좋은|나쁜|새로운|높은|낮은|넓은|좁은|빠른|느린|중요한|필요한|가능한|어려운|쉬운|이러한|그러한|어떠한)$/u.test(finalWord)) {
    return false;
  }
  return /^(?:이|그|해당|이번|예술|연구|활동|작품|문제)(?:(?:의)?\s|$)/u.test(rest);
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

function hasRoleDefinitionInversion(sentence) {
  const value = stripProtectedQuotedText(sentence);
  return /(?:역할|직무)(?:은|는|이|가)\s+[^.!?。！？\n]{0,45}(?:관리단|지원단|사업단|위원회|기관|부서|본부|센터|공단|공사|재단|협회|연구원|회사)(?:이)?라고\s*(?:생각|판단|보았|봤)/u
    .test(value);
}

function hasAnalyticObjectRecast(sentence) {
  return /(?:요구\s*사항|의견|자료|정보|요청)(?:은|는)[^.!?。！？\n]{0,70}(?:접수|수집|전달|공유|제공)된\s+(?:내용|자료|사항)(?:을|를)?\s*(?:바탕으로|기반으로)\s*(?:분석|검토)/u
    .test(stripProtectedQuotedText(sentence));
}

function hasBorrowedStandardCaseFrame(sentence) {
  return /(?:타인|남|다른\s*사람|주변|외부)(?:의)?\s*(?:평가\s*)?기준(?:을|를)\s*(?:가져와|가져와서|끌어와|끌어와서|들여와|들여와서)[^.!?。！？\n]{0,48}(?:나|자신|스스로|상대|대상|성과|결과)(?:을|를)\s*(?:평가|판단|재단)/u
    .test(stripProtectedQuotedText(sentence));
}

function hasGoalDirectionReferenceMismatch(sentence) {
  return /목표(?:를|을)\s*(?:정하|세우|설정)[^.!?。！？\n]{0,64}그\s*방향(?:을|으로)\s*(?:향해|따라|좇아|나아가)/u
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
    family: 'colloquial_competition',
    test: (value, _fullText, context) => isFormalRegisterTarget(context?.targetRegister, context?.profile)
      && /(?:맞붙(?:다|는다|어|게|었|을)|한판\s*(?:붙|겨루))/u.test(value)
  },
  {
    family: 'colloquial_direction_shift',
    test: (value, _fullText, context) => isFormalRegisterTarget(context?.targetRegister, context?.profile)
      && /(?:논의|관심|초점|시선|교재|자료|방향)\s*쪽으로\s*(?:옮겨|옮기|돌려|돌리|가게\s*되)/u.test(value)
  },
  {
    family: 'colloquial_payment_definition',
    test: (value, _fullText, context) => isFormalRegisterTarget(context?.targetRegister, context?.profile)
      && /(?:살|구매할)\s*때\s*(?:직접\s*)?(?:내는|내야\s*하는)\s*(?:돈|금액)/u.test(value)
  },
  {
    family: 'resume_ornamental_closing',
    test: (value, _fullText, context) => String(context?.profile || '') === 'resume_application'
      && /(?:곁을\s*지키는\s*디딤돌|든든한\s*동행자|따뜻한\s*조력자|성장의\s*시간|소중한\s*기회)/u.test(value)
  },
  {
    family: 'colloquial_validation_result',
    test: (value, _fullText, context) => isFormalRegisterTarget(context?.targetRegister, context?.profile)
      && /(?:시험|검증|평가|테스트)해\s*보니/u.test(value)
  },
  {
    family: 'colloquial_side_by_side_comparison',
    test: (value, _fullText, context) => isFormalRegisterTarget(context?.targetRegister, context?.profile)
      && /함께\s*놓고\s*(?:비교|검토)/u.test(value)
  },
  {
    family: 'academic_hyperbolic_response',
    test: (value, _fullText, context) => isAcademicRegisterProfile(context?.profile)
      && /(?:폭발적(?:인|으로)?|엄청난)\s*(?:수준의\s*)?(?:긍정적|부정적)?\s*(?:반응|효과|영향|관심|수요|증가|감소|확산|성장)/u.test(value)
  },
  {
    family: 'academic_colloquial_unexpected_combination',
    test: (value, _fullText, context) => isAcademicRegisterProfile(context?.profile)
      && /뜬금없(?:는|게|도록)\s*(?:결합|조합|협업|연결|등장|배치|선택|반응)/u.test(value)
  },
  {
    family: 'casual_self_question',
    test: (value, _fullText, context) => isFormalRegisterTarget(context?.targetRegister, context?.profile)
      && /(?:해서|라서)\s*그런가\s*(?:했|생각했|싶었)/u.test(value)
  }
]);

function isAcademicRegisterProfile(profile) {
  return ['academic_paper', 'report_assignment', 'long_explainer']
    .includes(String(profile || ''));
}

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
  const familyCounts = {};
  const familyOrdinals = {};
  sentences.forEach((sentence, index) => {
    const value = stripProtectedQuotedText(sentence);
    for (const rule of FORMAL_REGISTER_RULES) {
      if (typeof rule.test !== 'function' || !rule.test(value, text, context)) continue;
      ordinals.push(index + 1);
      families.push(rule.family);
      familyCounts[rule.family] = (familyCounts[rule.family] || 0) + 1;
      if (!familyOrdinals[rule.family]) familyOrdinals[rule.family] = [];
      familyOrdinals[rule.family].push(index + 1);
    }
  });
  if (families.length) {
    issues.push(makeIssue('formal_register_residual', families.length, ordinals, {
      families: [...new Set(families)].slice(0, 12),
      familyCounts,
      familyOrdinals
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
      // 한 음절 반복이 토큰 끝에 놓이면 명사 말음+조사(전문가가·강도도)뿐
      // 아니라 용언 활용(이어지지·가지지)일 가능성이 크다. 결정론적 수리는
      // 오탐 한 건이 실제 문법 훼손으로 이어지므로 이 모양은 모델 문맥
      // 감사에 맡기고, 어두·어중 중복이나 2음절 이상 반복만 자동 복원한다.
      if (unitLength === 1 && index + unitLength * 2 === token.length) continue;
      // 전문가가·국가가처럼 명사 자체가 '가'로 끝난 뒤 주격 조사가 붙은
      // 형태와 강도도·온도도처럼 명사 끝 '도' 뒤 보조사 '도'가 붙은
      // 정상 형태를 중복 오타로 줄이지 않는다. '의의'도 같은 방식의
      // 정상 어휘/조사 결합일 수 있어 한 글자 접미 반복에서는 보호한다.
      if (unitLength === 1
          && index + unitLength * 2 === token.length
          && ['가', '의', '도'].includes(unit)) continue;
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

function isOverloadedAcademicPurposeChain(sentence) {
  const raw = String(sentence || '');
  if (normalizeSentenceLocal(raw).length < 105) return false;
  const value = stripProtectedQuotedText(raw);
  if (!/(?:본\s*(?:연구|논문|고)|연구\s*(?:목적|목표)|규명(?:하|되)|실증(?:하|되)|검증(?:하|되)|제시(?:하|되))/u.test(value)) {
    return false;
  }
  const actions = [
    /(?:목적|목표)(?:은|는|이|가)?[^.!?。！？\n]{0,28}(?:규명|검증|분석|고찰|제시)/u,
    /(?:메커니즘|기제|원리|관계|효과|영향)(?:을|를|이|가)?\s*(?:규명|검증|분석|설명|파악)/u,
    /(?:단서|요인|변수|모형|가설|기준)(?:을|를)?[^.!?。！？\n]{0,100}(?:제시|도출|설정|검증)/u,
    /(?:불일치|부조화|갈등|문제|과정)(?:이|가|을|를)?[^.!?。！？\n]{0,34}(?:해소|조절|매개|설명|해석)/u,
    /(?:실증|검증|분석|비교|고찰|규명)(?:하고자|하려|한다|합니다|하였다|했다|하며)/u
  ];
  const actionCount = actions.filter(pattern => patternMatchesLocal(pattern, value)).length;
  const transitionCount = (value.match(/[,;，；]|(?:특히|나아가|이에|따라|통해|위해|제시하며|해소되는|나타나는지)/gu) || []).length;
  return actionCount >= 3 && transitionCount >= 2;
}

const AFFECTIVE_PROFILES = new Set([
  'personal_essay',
  'general_essay',
  'student_self_assessment'
]);

const AFFECTIVE_ANCHOR_FAMILIES = Object.freeze([
  {
    family: 'recognition_desire',
    patterns: [
      /인정(?:을\s*)?받(?:고\s*싶|기를\s*(?:바라|원)|고자|으려)/u,
      /알아주(?:기|길|기를)?\s*(?:바라|원|었으면)/u,
      /(?:노력|성과|가치)[^.!?。！？\n]{0,28}(?:인정|알아주)[^.!?。！？\n]{0,20}(?:싶|바라|원)/u
    ]
  },
  {
    family: 'recognition_lack',
    patterns: [
      /인정(?:을\s*)?받지\s*못/u,
      /인정(?:을\s*)?받을\s*수\s*없/u,
      /알아주지\s*않/u
    ]
  },
  {
    family: 'self_doubt',
    patterns: [
      /스스로(?:를)?\s*(?:의심|부정|탓|책망)/u,
      /자신(?:을|의\s*가치)?\s*(?:의심|부정|탓)/u
    ]
  },
  {
    family: 'inferiority',
    patterns: [
      /열등감/u,
      /(?:뒤처|뒤떨어)졌다고\s*(?:느끼|생각)/u,
      /부족하다고\s*(?:느끼|생각)/u
    ]
  },
  {
    family: 'hurt_frustration',
    patterns: [/(?:속상|서운|좌절|실망|상처받|답답|억울)/u]
  },
  {
    family: 'anxiety_fear',
    patterns: [/(?:불안|두렵|무섭|걱정|긴장)/u]
  },
  {
    family: 'shame_guilt',
    patterns: [/(?:부끄럽|창피|수치심|죄책감|미안)/u]
  },
  {
    family: 'joy_pride',
    patterns: [/(?:기쁘|행복|뿌듯|자랑스럽)/u]
  },
  {
    family: 'regret',
    patterns: [/(?:후회|아쉬웠|아쉬움)/u]
  },
  {
    family: 'isolation',
    patterns: [/(?:외롭|소외|고립)/u]
  },
  {
    family: 'anger_jealousy',
    patterns: [/(?:화가\s*났|분노|질투)/u]
  }
]);

function detectAffectiveAnchorOmission(source, outputText, profile) {
  if (!AFFECTIVE_PROFILES.has(String(profile || ''))) return null;
  const sourceSentences = splitSentences(String(source || ''))
    .map(item => String(item || '').trim())
    .filter(Boolean);
  const outputSentences = splitSentences(String(outputText || ''))
    .map(item => String(item || '').trim())
    .filter(Boolean);
  const anchors = sourceSentences
    .map((sentence, index) => ({
      sentence,
      index,
      families: affectiveFamilyNames(sentence)
    }))
    .filter(item => item.families.length > 0 && isOwnedAffectiveSentence(item.sentence));
  if (!anchors.length) return null;

  const omissions = anchors.map(anchor => compareAffectiveAnchor(
    anchor,
    sourceSentences.length,
    outputSentences
  )).filter(item => item.covered !== true);
  if (!omissions.length) return null;
  return makeIssue(
    'affective_anchor_omission',
    omissions.length,
    omissions.map(item => item.outputOrdinal).filter(value => Number(value) > 0),
    {
      anchorCount: anchors.length,
      omissions: omissions.slice(0, 8).map(item => ({
        sourceOrdinal: item.sourceOrdinal,
        outputOrdinal: item.outputOrdinal,
        families: item.families,
        familyRecall: item.familyRecall,
        semanticSimilarity: item.semanticSimilarity,
        contentRecall: item.contentRecall,
        sourceSentence: item.sourceSentence.slice(0, 420),
        matchedOutput: item.matchedOutput.slice(0, 420)
      }))
    }
  );
}

function compareAffectiveAnchor(anchor, sourceCount, outputSentences) {
  const candidates = alignedOutputCandidates(
    anchor.sentence,
    anchor.index,
    sourceCount,
    outputSentences,
    { window: 4, maxOutputGroup: 3 }
  );
  const sourceTokens = new Set(contentTokensLocal(anchor.sentence));
  let best = null;
  for (const candidate of candidates) {
    const outputFamilies = new Set(affectiveFamilyNames(candidate.text));
    const retainedFamilies = anchor.families.filter(family => outputFamilies.has(family));
    const familyRecall = retainedFamilies.length / Math.max(1, anchor.families.length);
    const outputTokens = new Set(contentTokensLocal(candidate.text));
    const contentRecall = [...sourceTokens].filter(token => outputTokens.has(token)).length
      / Math.max(1, sourceTokens.size);
    const semanticSimilarity = Number(candidate.rawScore ?? candidate.score ?? 0);
    const score = (familyRecall * 0.62) + (semanticSimilarity * 0.28) + (contentRecall * 0.10);
    if (!best || score > best.score) {
      best = { candidate, familyRecall, contentRecall, semanticSimilarity, score };
    }
  }
  const covered = Boolean(best
    && best.familyRecall >= 0.999
    && (best.semanticSimilarity >= 0.24 || best.contentRecall >= 0.24));
  return {
    sourceOrdinal: anchor.index + 1,
    outputOrdinal: best ? best.candidate.start + 1 : 0,
    families: anchor.families,
    familyRecall: round4(best?.familyRecall || 0),
    semanticSimilarity: round4(best?.semanticSimilarity || 0),
    contentRecall: round4(best?.contentRecall || 0),
    sourceSentence: anchor.sentence,
    matchedOutput: best?.candidate?.text || '',
    covered
  };
}

function affectiveFamilyNames(value) {
  const text = String(value || '');
  return AFFECTIVE_ANCHOR_FAMILIES
    .filter(item => item.patterns.some(pattern => pattern.test(text)))
    .map(item => item.family);
}

function isOwnedAffectiveSentence(value) {
  const text = String(value || '');
  const firstPerson = koreanStart(
    '(?:나는|나를|나에게|나의|나도|나만|내가|내게|저는|저를|저에게|저의|저도|저만|제가|제게|스스로(?:를)?)',
    'u'
  );
  return firstPerson.test(text)
    || koreanStart('나(?=\\s+(?:역시|또한|또|만큼))', 'u').test(text)
    || /(?:느낀|느꼈|느껴진)\s*(?:감정|기분|마음)/u.test(text)
    || /(?:감정|기분|마음)(?:은|는|이|가|을|를)[^.!?。！？\n]{0,28}(?:들|생기|느끼|느꼈|비롯)/u.test(text);
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

function percentageFormulaCandidates(value) {
  const text = String(value || '');
  const pattern = /(?<![\d.(])(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*\*\s*100\s*=\s*(\d+(?:\.\d+)?)\s*(퍼센트|%|％)/gu;
  const candidates = [];
  let lineOffset = 0;
  for (const line of text.split('\n')) {
    const protectedRanges = inlineProtectedRanges(line);
    for (const match of line.matchAll(pattern)) {
      const matchEnd = match.index + match[0].length;
      if (protectedRanges.some(range => match.index < range.end && matchEnd > range.start)) continue;
      const startValue = Number(match[1]);
      const endValue = Number(match[2]);
      const denominator = Number(match[3]);
      const stated = Number(match[4]);
      if (![startValue, endValue, denominator, stated].every(Number.isFinite)
          || denominator === 0
          || Math.abs(startValue - denominator) > Math.max(0.001, Math.abs(startValue) * 0.000001)) continue;
      const intended = ((startValue - endValue) / denominator) * 100;
      const tolerance = Math.max(0.11, Math.abs(intended) * 0.005);
      if (Math.abs(stated - intended) > tolerance) continue;
      const precedenceValue = startValue - ((endValue / denominator) * 100);
      if (Math.abs(stated - precedenceValue) <= tolerance) continue;
      candidates.push({
        match: match[0],
        index: lineOffset + match.index,
        replacement: `(${match[1]}-${match[2]})/${match[3]}*100=${match[4]}${match[5]}`
      });
    }
    lineOffset += line.length + 1;
  }
  return candidates;
}

function pushPercentageFormulaParenthesesIssue(issues, text) {
  const matches = percentageFormulaCandidates(text);
  if (!matches.length) return;
  issues.push(makeIssue(
    'percentage_formula_parentheses',
    matches.length,
    matches.map(match => sentenceOrdinalAt(text, match.index))
  ));
}

function repairPercentageFormulaParentheses(value) {
  let text = String(value || '');
  const matches = percentageFormulaCandidates(text);
  let repairCount = 0;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const candidate = matches[index];
    text = `${text.slice(0, candidate.index)}${candidate.replacement}${text.slice(candidate.index + candidate.match.length)}`;
    repairCount += 1;
  }
  return { text, repairCount };
}

function pushTechnicalTerminologyReview(issues, text) {
  const value = String(text || '');
  if (/(?:펌프|흡입|토출|배관|유체)/u.test(value)
      && /유속/u.test(value)
      && /유량/u.test(value)) {
    issues.push(makeIssue('technical_term_consistency_review', 1, []));
  }
  const variants = [
    /Trade-off/u.test(value) ? 'Trade-off' : '',
    /trade-off/u.test(value) ? 'trade-off' : '',
    /트레이드오프/u.test(value) ? '트레이드오프' : ''
  ].filter(Boolean);
  if (variants.length > 1) {
    issues.push(makeIssue('technical_notation_consistency_review', 1, [], { variants }));
  }
}

function pushTechnicalScopeAmbiguityReview(issues, text) {
  const sentences = splitSentences(String(text || ''));
  const ordinals = [];
  sentences.forEach((sentence, index) => {
    const value = stripProtectedQuotedText(sentence);
    const agingScope = /부품(?:의)?\s*(?:노화|열화)(?:가|를)?\s*가능하도록[^.!?。！？\n]{0,80}(?:시험용\s*)?(?:F\/W|펌웨어)/iu.test(value);
    const reportScope = /(?:119|긴급\s*신고)[^.!?。！？\n]{0,80}(?:문자|전화)[^.!?。！？\n]{0,80}신고(?:가)?\s*이루어지도록\s*연동/u.test(value);
    if (agingScope || reportScope) ordinals.push(index + 1);
  });
  if (ordinals.length) {
    issues.push(makeIssue('technical_scope_ambiguity_review', ordinals.length, ordinals));
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
    const familyComparison = code === 'formal_register_residual'
      ? compareIssueFamilies(sourceItem, outputItem)
      : null;
    return {
      code,
      beforeCount,
      afterCount,
      introducedCount: familyComparison?.introducedCount ?? Math.max(0, afterCount - beforeCount),
      resolvedCount: familyComparison?.resolvedCount ?? Math.max(0, beforeCount - afterCount),
      weight: definition.weight || 1,
      repairable: definition.repairable === true,
      deterministicSafe: definition.deterministicSafe === true,
      message: definition.message || '한국어 표현을 확인해 주세요.',
      sentenceOrdinals: familyComparison?.introducedSentenceOrdinals?.length
        ? familyComparison.introducedSentenceOrdinals
        : (outputItem?.sentenceOrdinals || []),
      details: familyComparison
        ? { ...(outputItem?.details || {}), comparison: familyComparison }
        : (outputItem?.details || null)
    };
  });
}

function compareIssueFamilies(sourceItem, outputItem) {
  const before = sourceItem?.details?.familyCounts || {};
  const after = outputItem?.details?.familyCounts || {};
  const families = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const introducedFamilies = {};
  const resolvedFamilies = {};
  const introducedSentenceOrdinals = [];
  let introducedCount = 0;
  let resolvedCount = 0;
  for (const family of families) {
    const delta = Number(after[family] || 0) - Number(before[family] || 0);
    if (delta > 0) {
      introducedFamilies[family] = delta;
      introducedCount += delta;
      introducedSentenceOrdinals.push(
        ...((outputItem?.details?.familyOrdinals?.[family] || []).slice(0, delta))
      );
    } else if (delta < 0) {
      resolvedFamilies[family] = Math.abs(delta);
      resolvedCount += Math.abs(delta);
    }
  }
  return {
    introducedCount,
    resolvedCount,
    introducedFamilies,
    resolvedFamilies,
    introducedSentenceOrdinals: [...new Set(introducedSentenceOrdinals)].sort((a, b) => a - b)
  };
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
const DEMONSTRATIVE_I_NOUN_RE = /^(?:(?:두|세|여러|같은|모든|각)\s+)?(?:목표|측면|과정|경험|결과|내용|문제|이유|점|방법|상황|사실|관점|역할|부분|선택|생각|주장|기준|계획|단계|변화|작업|활동|프로젝트|사례|전략|방식|기회|때|곳|글|문서|연구|수업|조사|분석)(?:[은는이가을를의에도에서와과만]|\s|$)/u;
const DEMONSTRATIVE_I_INFLECTED_NOUN_RE = /^[가-힣A-Za-z0-9·_-]{1,40}(?:에서는|에게는|으로는|에는|은|는|이|가|을|를|의|에|에서|에게|으로|로|와|과|도|만)(?=$|[\s,.;:!?。！？])/u;

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
      const bodyText = line.slice(match[0].length).trim();
      // 행 첫머리의 `이 목표·이 과정·이 경험`은 앞 문단을 가리키는 정상
      // 지시 관형어다. 번호가 붙은 앞 문단을 목록으로 분류했다는 이유만으로
      // 주격 조사로 오인해 `이`를 삭제하면 문장 의미가 훼손된다.
      if (match[2] === '이' && (
        DEMONSTRATIVE_I_NOUN_RE.test(bodyText)
        || DEMONSTRATIVE_I_INFLECTED_NOUN_RE.test(bodyText)
      )) {
        offset += line.length + 1;
        continue;
      }
      const previousIndex = previousNonEmptyLineIndex(lines, index);
      const previous = previousIndex >= 0 ? String(lines[previousIndex] || '').trim() : '';
      const role = previous ? layoutStructure.classifyLine(previous) : '';
      const conciseListAnchor = previous.length <= 160
        && splitSentences(previous).length <= 1
        && (role === 'list'
          || /^(?:\d{1,3}(?:[-.]\d+)*[.)]|[가-힣][.)]|[①-⑳]|[●○■□◆◇▶▷※])\s*\S/u.test(previous));
      const structuralPrevious = ['title', 'heading', 'label', 'label_inline'].includes(role)
        || conciseListAnchor;
      if (structuralPrevious) {
        occurrences.push({
          lineIndex: index,
          lineNumber: index + 1,
          particle: match[2],
          prefixLength: match[0].length,
          previousLine: previous,
          bodyText,
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

function round4(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 10000) / 10000 : 0;
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
