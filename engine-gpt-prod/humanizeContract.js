'use strict';

const VERSION = 'humanize-contract-v1';

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
  documentProfile = null
} = {}) {
  const strength = normalizeStrength(mode, requestStrength);
  const profile = canonicalProfileName(documentProfile);
  const formatFlags = new Set(documentProfile?.formatProfile?.flags || []);
  const advancedNarrativeLayout = strength === 'advanced'
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
      advancedNarrativeLayout
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
  if (resolved.paragraph.advancedNarrativeLayout) {
    return '모델 편집 단계에서는 원문 문단 경계를 그대로 유지한다. 고급 서사·감상형 글의 같은 담화 역할 문단 정리는 검증 가능한 최종 레이아웃 단계가 담당하므로, 문단을 합치거나 새로 나누거나 내용을 다른 문단으로 옮기지 않는다.';
  }
  return '모델 편집 단계에서는 원문 문단 경계와 각 문단의 역할·순서를 유지한다. 같은 문단 안의 일반 산문에서는 문장 분리·결합과 절 배치를 바꿀 수 있지만, 문단을 합치거나 새로 나누거나 내용을 다른 문단으로 옮기지 않는다.';
}

function paragraphMarkerPromptLine(contract) {
  const resolved = resolveHumanizeContract({ humanizeContract: contract });
  return `[[[V2_BOUNDARY_###]]]는 ${resolved.paragraph.version}이 잠근 원문 문단 경계다. 토큰의 철자·개수·순서를 유지하고 양쪽 문단을 합치거나 내용을 옮기지 않는다.`;
}

function localizedRepairPromptLines(contract, { allowInsertion = false } = {}) {
  const resolved = resolveHumanizeContract({ humanizeContract: contract });
  return [
    '수리 계약=localized-repair-v1. CURRENT가 편집 기준이며 SOURCE는 사실·의미 대조용이다.',
    '표시된 문제 문장과 문법상 필요한 바로 이웃 문장만 고치고, 그 밖의 CURRENT 문장은 이미 승인된 편집을 포함해 그대로 둔다.',
    '사실·수치·고유명사·전문 개념·인용·화자·시점·평가 강도·제목·목록 순서를 바꾸지 않는다.',
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
  buildHumanizeContract,
  resolveHumanizeContract,
  priorityPromptLines,
  paragraphPromptLine,
  paragraphMarkerPromptLine,
  localizedRepairPromptLines,
  validateRepairPrompt,
  assertRepairPrompt,
  allowsLayoutRecomposition,
  allowsLocalizedParagraphChange,
  canonicalProfileName,
  canonicalProfileGroup
};
