'use strict';

const VERSION = 'humanize-contract-v1';
const { textDigest } = require('./semanticProvenance');

const PROFILE_ALIASES = Object.freeze({
  general: 'general_essay',
  review_blog: 'blog_review'
});

const NARRATIVE_PROFILES = new Set([
  'personal_essay',
  'general_essay',
  'blog_review'
]);

const STRUCTURE_LOCK_FLAGS = new Set([
  'assessment_item',
  'questionnaire',
  'list_heavy',
  'table',
  'table_heavy',
  'compressed_multicolumn',
  'sectioned',
  'reference_heavy',
  'creative_lines'
]);

function buildHumanizeContract({
  mode = 'assignment',
  requestStrength = '',
  documentProfile = null,
  approvedStructure = false
} = {}) {
  const strength = normalizeStrength(mode, requestStrength);
  const profile = canonicalProfileName(documentProfile);
  const formatFlags = new Set(documentProfile?.formatProfile?.flags || []);
  const advancedNarrativeLayout = !approvedStructure && strength === 'advanced'
    && NARRATIVE_PROFILES.has(profile)
    && ![...formatFlags].some(flag => STRUCTURE_LOCK_FLAGS.has(flag));

  return deepFreeze({
    version: VERSION,
    strength,
    profile,
    priorities: [
      {
        rank: 1,
        key: 'integrity',
        label: '사실·의미·보호 구조·화자'
      },
      {
        rank: 2,
        key: 'genre_voice',
        label: '원문 장르·격식·화자 리듬'
      },
      {
        rank: 3,
        key: 'transformation',
        label: '요청 강도에 맞는 실질 재구성'
      }
    ],
    paragraph: {
      version: 'paragraph-authority-v1',
      // 생성·국소 수리는 문장 내용만 바꾼다. 문단 경계 변경은 검증 가능한
      // 결정론 레이아웃 단계 한 곳에서만 수행해 프롬프트와 게이트의 충돌을 없앤다.
      modelBoundary: 'source_locked',
      localizedRepairBoundary: 'source_locked',
      layoutAuthority: advancedNarrativeLayout ? 'semantic_role' : 'source_role',
      advancedNarrativeLayout,
      approvedStructure: approvedStructure === true,
      // Source anchors constrain model ownership, not the delivered prose
      // layout. Structural slots remain fixed independently of this policy.
      prosePolicy: approvedStructure ? 'approved_plan'
        : strength === 'polish' || ['creative', 'legal_contract', 'clinical_record'].includes(profile)
          ? 'preserve' : strength === 'basic' ? 'basic_readability' : 'advanced_roles'
    }
  });
}

function resolveHumanizeContract({
  humanizeContract = null,
  mode = 'assignment',
  requestStrength = '',
  documentProfile = null
} = {}) {
  if (humanizeContract?.version === VERSION
      && humanizeContract?.paragraph?.version === 'paragraph-authority-v1') {
    return humanizeContract;
  }
  return buildHumanizeContract({ mode, requestStrength, documentProfile });
}

function priorityPromptLines(contract) {
  const resolved = resolveHumanizeContract({ humanizeContract: contract });
  return [
    `계약 버전=${resolved.version}. 충돌 시 1순위→2순위→3순위로 판단한다.`,
    '1순위 사실·의미·보호 구조·화자를 보존한다.',
    '2순위 1순위를 해치지 않는 범위에서 원문 장르·격식·화자 리듬을 보존한다.',
    '3순위 1·2순위를 지키면서 요청 강도에 맞게 잠기지 않은 일반 문장을 실질 재구성한다.',
    '충돌이 의심되면 해당 표현만 보존하고, 충돌하지 않는 주변 일반 문장까지 원문대로 복사하지 않는다.'
  ];
}

function paragraphPromptLine(contract) {
  const resolved = resolveHumanizeContract({ humanizeContract: contract });
  const delivery = resolved.paragraph.approvedStructure
    ? '사용자가 승인한 구조가 현재 SOURCE에 적용돼 있다. 이전 원문 구조로 되돌리지 않는다.'
    : resolved.strength === 'polish' ? ''
      : `최종 문단 수 보존 목표가 아니다. 최종 레이아웃이 항목 안의 ${resolved.strength === 'basic' ? '내용 전환과 가독성' : '동기·실행·검증·결과·성찰 전환'}을 정리한다.`;
  return '모델 편집 단계에서는 원문 문단 경계를 그대로 유지한다. '
    + (resolved.strength === 'polish' ? '문장 분리·결합도 하지 않는다. '
      : '문장 분리·결합·절 배치는 허용하나 문단·내용 소속은 고정한다. ') + delivery;
}

function paragraphMarkerPromptLine(contract) {
  const resolved = resolveHumanizeContract({ humanizeContract: contract });
  return `[[[V2_BOUNDARY_###]]]는 ${resolved.paragraph.version}이 잠근 원문 문단 경계다. 토큰의 철자·개수·순서를 유지하고 양쪽 문단을 합치거나 내용을 옮기지 않는다.`;
}

function meaningPreservationLines() {
  return [
    '주체·행위·대상·수치의 귀속·시점·조건·부정·가능성·의무·주장 강도를 같은 관계로 보존한다. 숫자와 명칭이 남아 있어도 그 귀속을 서로 바꾸면 안 된다.',
    '정의문의 정의 대상과 설명을 뒤집지 않는다. “이후” 같은 시간 관계를 “그 결과” 같은 인과로 바꾸지 않고, “할 수 없다”를 “어렵다”로 약화하지 않는다.',
    '동등 비교(만큼), 우선 비교(보다), 추가(뿐 아니라), 선택(또는), 결합(그리고)을 서로 바꾸지 않는다. 화자의 깨달음·생각을 일반 사실로 바꾸거나, 행위 주체를 생략해 누가 했는지 불명확하게 만들지 않는다. 알게 되었다·이해했다는 인식 결과를 다뤘다·짚어 보았다·살폈다는 활동으로 바꾸지 않는다. 반복되는 깨달음 표현도 그 경험 자체를 지우지 말고 문장 호흡만 조절한다.',
    '모호한 나열에 “각각”을 덧붙여 대응을 확정하지 않는다. 지시어가 가리키는 앞 문맥과 조건·실험군별 설명 묶음을 유지한다. 원문 내부의 명확한 수식·정의로 확인되지 않는 사실은 추측해 고치지 않는다.',
    '긴 문장을 나눌 때 바깥 주제어(은·는)와 안쪽 절의 주어(이·가)를 구별한다. “책임자는 직원이 자료를 공개한 경위를 확인했다”에서 공개한 사람은 직원, 확인한 사람은 책임자다. “직원이 공개한 뒤 경위를 확인했다”처럼 둘을 한 사람의 행동으로 연결하지 않는다. 원문에서 주체가 확정되지 않으면 새 주체를 추측하지 않는다.',
    '이미 자연스러운 문장을 변경량만 늘리려고 명사화하거나 도치하지 않는다. 문체·연어·종결을 자연스럽게 유지하고, 국소 오류를 고치면서 정상적인 주변 개선까지 되돌리지 않는다.',
    '주어가 생략된 문장에도 원문에 없는 관람·방문·사용 경험을 만들지 않는다. “보고 나서야·써 보니”처럼 실제 경험과 시점을 전제하는 표현은 원문의 근거가 있을 때만 쓴다.'
  ];
}

// Opt-in ablation candidate (HUMANIZE_RELATION_GUARD=clear_relations_v1). It is
// not a default. The 2026-09-08 live ablation traced the consistent naturalness
// regressions to local rewrites that re-linked particles, clause connectors and
// modifier scope in sentences whose relations were already clear. These lines
// extend meaningPreservationLines(): they do not restate which relations must be
// preserved, only that already-clear relation wiring is not a naturalness lever.
// Any other value (absent, 'off', unknown) leaves every prompt byte-identical.
const RELATION_GUARD_VERSION = 'clear-relations-v1';

function resolveRelationGuard(value) {
  return String(value ?? '').trim() === 'clear_relations_v1' ? 'clear_relations_v1' : 'off';
}

function relationGuardLines(relationGuard = 'off') {
  if (resolveRelationGuard(relationGuard) !== 'clear_relations_v1') return [];
  return [
    `관계 유지 규칙=${RELATION_GUARD_VERSION}. 위 보존 규칙에 더해, 주어–서술어·원인–결과·병렬·수식 관계가 이미 분명한 문장은 조사, 연결어미(-고/-며/-아서/-니까/-지만/-한 뒤 등), 수식 범위를 그대로 둔다.`,
    '그런 문장의 자연스러움은 어휘 선택, 문장 길이·호흡, 종결 방식으로 바꾸고, 관계를 다시 잇는 방식(다른 조사·연결어미로 관계 유형을 바꾸거나 수식 범위를 옮기는 것)으로는 바꾸지 않는다.',
    '연결어미와 조사는 원문 관계 자체가 불분명하거나 틀린 경우에만 고치며, 원문이 말하지 않은 순서(-한 뒤/-고 나서)·인과·확실성을 더하지 않는다.'
  ];
}

// Only server-owned control blocks belong here. SOURCE, memo, quoted examples
// from user data and complete user messages must never be supplied as controls.
function validateTrustedPromptContract({ system = '', taskContract = '', retryInstruction = '', humanizeContract = null } = {}) {
  const resolved = resolveHumanizeContract({ humanizeContract });
  const controls = [system, taskContract, retryInstruction].map(value => String(value || ''));
  const errors = [];
  if (resolved.paragraph.modelBoundary === 'source_locked') {
    for (const [index, block] of controls.entries()) {
      if (/문단(?:을|은|도)\s+[^.\n]{0,60}(?:나눈다|나눌 수 있다|합친다|합칠 수 있다|새로 만든다)/u.test(block)
          || /\b(?:split|merge|reorder) paragraphs\b(?![^.\n]{0,20}(?:not allowed|forbidden))/iu.test(block)) {
        errors.push(`paragraph_authority_conflict:${['system', 'task', 'retry'][index]}`);
      }
    }
  }
  return { pass: errors.length === 0, errors, version: 'trusted-prompt-contract-v1',
    promptDigest: textDigest(JSON.stringify(controls)), contractVersion: resolved.version };
}

function localizedRepairPromptLines(contract, { allowInsertion = false } = {}) {
  const resolved = resolveHumanizeContract({ humanizeContract: contract });
  return [
    '수리 계약=localized-repair-v1. CURRENT가 편집 기준이며 SOURCE는 사실·의미 대조용이다.',
    '표시된 문제 문장과 문법상 필요한 바로 이웃 문장만 고치고, 그 밖의 CURRENT 문장은 이미 승인된 편집을 포함해 그대로 둔다.',
    '사실·수치·고유명사·전문 개념·인용·화자·시점·평가 강도·제목·목록 순서를 바꾸지 않는다.',
    ...meaningPreservationLines(),
    paragraphPromptLine(resolved),
    '원문의 종결체와 격식, 짧고 긴 문장의 대비를 유지한다. 국소 오류를 고치면서 다른 문장을 같은 길이·어조로 평탄화하지 않는다.',
    allowInsertion
      ? '누락 복원은 제공된 원문 주장만 원래 위치에 넣을 수 있다. 새 요약·결론·경험·성과를 만들지 않는다.'
      : '문장·주장을 새로 추가하거나 삭제하지 않는다.'
  ];
}

function validateRepairPrompt(value, { family = '', localized = false, allowInsertion = false } = {}) {
  const prompt = String(value || '');
  const key = String(family || '').trim().toLowerCase();
  const errors = [];
  const requireText = (needle, code) => {
    if (!prompt.includes(needle)) errors.push(code);
  };
  if (!prompt.trim()) errors.push('empty_prompt');
  if (/같은 문단 역할 안에서[^.\n]{0,100}(?:나누|이어 붙|합치)/u.test(prompt)
      || /문단을 (?:합치거나|나누거나|새로 나누)[^.\n]{0,80}(?:허용|할 수 있다)/u.test(prompt)) {
    errors.push('paragraph_authority_conflict');
  }
  if (localized) {
    const localizedContractCount = (prompt.match(/수리 계약=localized-repair-v1\./gu) || []).length;
    if (localizedContractCount !== 1) {
      errors.push(`localized_contract_count:${localizedContractCount}`);
    }
    requireText('CURRENT가 편집 기준', 'current_baseline_missing');
    requireText('모델 편집 단계에서는 원문 문단 경계', 'paragraph_authority_missing');
    requireText('짧고 긴 문장의 대비', 'voice_rhythm_contract_missing');
    if (allowInsertion) requireText('누락 복원은 제공된 원문 주장만', 'insertion_boundary_missing');
  }
  const familyRequirements = {
    polish: ['보존형 윤문 수리기', '문단 수와 순서', '새 문장이나 새 문단'],
    general_surface: ['실질 휴머나이징 국소 수리기', '수정 대상 문장 번호=', '새 사실·평가·감정·경험'],
    conservative_sentence: ['안전한 단일 문장 재구성기', 'CURRENT SENTENCE 한 문장만', '문장 수는 한 개로 유지'],
    collapsed_spacing: ['한국어 무띄어쓰기 복원기', '공백만 삽입', '기존 공백·줄바꿈·문단 경계'],
    korean_refinement: ['한국어 문장 국소 수리기', '[수리 대상]'],
    fingerprint: ['엔진 상투구와 논리 방향만 국소 수리', '[수리 대상]'],
    ending_style: ['한국어 종결체 혼용만 국소 수리', '[수리 대상]'],
    resume_coverage: ['자기소개서 핵심 주장 누락만 복원', '[복원 대상]']
  };
  for (const required of familyRequirements[key] || []) {
    requireText(required, `family_rule_missing:${key}:${required}`);
  }
  return { pass: errors.length === 0, errors };
}

function assertRepairPrompt(value, options = {}) {
  const validation = validateRepairPrompt(value, options);
  if (validation.pass) return validation;
  const error = new Error(`repair_prompt_integrity_failed:${validation.errors.join(',')}`);
  error.code = 'REPAIR_PROMPT_INTEGRITY_FAILED';
  throw error;
}

function allowsLayoutRecomposition(contract) {
  return resolveHumanizeContract({ humanizeContract: contract }).paragraph.layoutAuthority === 'semantic_role';
}

function allowsLocalizedParagraphChange(contract) {
  return resolveHumanizeContract({ humanizeContract: contract }).paragraph.localizedRepairBoundary !== 'source_locked';
}

function canonicalProfileName(documentProfile) {
  const raw = typeof documentProfile === 'object'
    ? String(documentProfile?.profile || documentProfile?.contentGenre || 'unknown')
    : String(documentProfile || 'unknown');
  return PROFILE_ALIASES[raw] || raw;
}

function canonicalProfileGroup(documentProfile) {
  const explicit = typeof documentProfile === 'object' ? String(documentProfile?.group || '') : '';
  if (explicit) return explicit;
  const profile = canonicalProfileName(documentProfile);
  if (profile === 'clinical_record') return 'clinical_record';
  if (profile === 'legal_contract') return 'legal_contract';
  if (['academic_paper', 'report_assignment', 'long_explainer'].includes(profile)) return 'academic_report_explainer';
  if (profile === 'student_record_teacher') return 'student_record_teacher';
  if (profile === 'student_self_assessment') return 'student_self_assessment';
  if (['personal_essay', 'general_essay', 'resume_application'].includes(profile)) return 'essay_application';
  if (['blog_review', 'social', 'social_caption'].includes(profile)) return 'blog_social';
  if (['mail_notice', 'marketing_ad', 'functional_copy'].includes(profile)) return 'functional_copy';
  if (profile === 'creative') return 'creative';
  if (profile === 'general') return 'general';
  return 'unknown';
}

function normalizeStrength(mode, requestStrength) {
  const explicit = String(requestStrength || '').trim().toLowerCase();
  if (['polish', 'basic', 'advanced'].includes(explicit)) return explicit;
  if (String(mode || '').toLowerCase() === 'polish') return 'polish';
  if (String(mode || '').toLowerCase() === 'blog') return 'basic';
  return 'advanced';
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

module.exports = {
  VERSION,
  RELATION_GUARD_VERSION,
  buildHumanizeContract,
  resolveHumanizeContract,
  priorityPromptLines,
  paragraphPromptLine,
  meaningPreservationLines,
  resolveRelationGuard,
  relationGuardLines,
  paragraphMarkerPromptLine,
  validateTrustedPromptContract,
  localizedRepairPromptLines,
  validateRepairPrompt,
  assertRepairPrompt,
  allowsLayoutRecomposition,
  allowsLocalizedParagraphChange,
  canonicalProfileName,
  canonicalProfileGroup
};
