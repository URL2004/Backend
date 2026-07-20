'use strict';

const inputRouting = require('../engine/inputrouting');
const { detectDocumentProfile } = require('./documentProfile');

const ADVANCED_DOCUMENT_PROFILES = new Set([
  'academic_paper',
  'report_assignment'
]);

const PERSONAL_SAFETY_PROFILES = new Set([
  'student_record_teacher',
  'student_self_assessment',
  'resume_application',
  'personal_essay',
  'creative'
]);

const COMPLEX_FORMAT_FLAGS = new Set([
  'sectioned',
  'table_heavy',
  'reference_heavy',
  'quote_sensitive',
  'appendix_present'
]);

/**
 * 구형 진단기의 재구성 부적합 판정과 v2 장르 판정을 조정한다.
 *
 * 구형 looksLikeResume는 "탐구 주제/과정" 같은 표현을 안전하게 막기 위해
 * 넓게 잡는다. 논문·구조화 보고서에도 같은 어휘가 자주 등장하므로, v2에서
 * 고신뢰 학술/보고서 판정과 격식 구조가 함께 확인되면 그 오탐만 해제한다.
 * 실제 자소서·학생 기록·개인 서사는 safetyProfiles로 의미·화자·경험을
 * 보호하되, 사용자가 고급을 선택하는 것 자체는 막지 않는다. v2 고급은
 * 장르별 안전 감사와 변환 강도를 분리해 처리한다.
 */
function resolveAdvancedRouting(text, inputRisk = {}, { v2Enabled = false } = {}) {
  const source = String(text || '');
  const legacyUnfit = inputRouting.restructureUnfit(source, inputRisk);
  const documentProfile = v2Enabled
    ? detectDocumentProfile(source, { basicStyle: 'report' })
    : null;
  const profile = String(documentProfile?.profile || 'unknown');
  const confidence = Number(documentProfile?.confidence) || 0;
  const formatFlags = Array.isArray(documentProfile?.formatProfile?.flags)
    ? documentProfile.formatProfile.flags.map(value => String(value || ''))
    : [];
  const safetyProfiles = new Set([
    profile,
    ...(Array.isArray(documentProfile?.safetyProfiles) ? documentProfile.safetyProfiles : [])
  ].map(value => String(value || '')));

  const highConfidenceAcademic = v2Enabled
    && confidence >= 0.75
    && ADVANCED_DOCUMENT_PROFILES.has(profile);
  const personalSafety = [...safetyProfiles].some(value => PERSONAL_SAFETY_PROFILES.has(value));
  const complexFormat = documentProfile?.formatProfile?.length === 'long'
    || formatFlags.some(flag => COMPLEX_FORMAT_FLAGS.has(flag));
  const formalStructure = inputRouting.isFormalDocument(source)
    || inputRouting.isLongStructuredThesis(source)
    || inputRouting.isAcademicCited(source)
    || inputRouting.isFootnoteCited(source)
    || inputRouting.isStructuredReport(source)
    || inputRouting.isSectionedAssignmentReport(source);
  const academicOverride = legacyUnfit.unfit === true
    && legacyUnfit.kind === 'resume'
    && highConfidenceAcademic
    && formalStructure
    && !personalSafety;

  // v2 한국어 엔진은 민감 장르도 장르별 안전 감사 안에서 고급 변환할 수 있다.
  // 구형 unfit은 추천 강도를 정하는 관측값으로만 남기며, 영어처럼 엔진이
  // 지원하지 않는 입력만 고급 선택을 막는다.
  const v2ProfileSafeAdvancedOverride = v2Enabled
    && legacyUnfit.unfit === true
    && legacyUnfit.kind !== 'english';

  const effectiveUnfit = academicOverride || v2ProfileSafeAdvancedOverride
    ? { unfit: false, kind: null, reason: '' }
    : legacyUnfit;
  const recommendAdvanced = effectiveUnfit.unfit !== true
    && highConfidenceAcademic
    && (complexFormat || formalStructure);

  return {
    legacyUnfit,
    effectiveUnfit,
    advancedEligible: effectiveUnfit.unfit !== true,
    recommendedMode: recommendAdvanced ? 'formal' : 'blog',
    recommendationCode: recommendAdvanced ? 'complex_academic_document' : '',
    recommendationReason: recommendAdvanced
      ? '긴 논문·구조화 보고서로 판정됐어요. 고급 휴머나이징은 더 넓은 문장 범위와 전체 문서의 의미·사실·구조 검증을 적용하므로 이 글에 더 적합해요. 실행 전 예상 시간과 크레딧을 확인해 주세요.'
      : '',
    routingOverride: academicOverride
      ? 'legacy_inquiry_false_positive'
      : (v2ProfileSafeAdvancedOverride ? 'v2_profile_safe_advanced' : ''),
    documentProfile,
    profile,
    confidence,
    formatFlags,
    highConfidenceAcademic,
    complexFormat,
    formalStructure,
    personalSafety
  };
}

module.exports = {
  resolveAdvancedRouting,
  ADVANCED_DOCUMENT_PROFILES,
  PERSONAL_SAFETY_PROFILES,
  COMPLEX_FORMAT_FLAGS
};
