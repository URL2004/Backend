'use strict';

const { splitSentences } = require('../engine/koreanText');
const { computePovSeed } = require('../engine/pov');
const layoutStructure = require('./layoutStructure');
const commercialSignalPolicy = require('./commercialSignals');

const CONTENT_GENRES = Object.freeze([
  'academic_paper',
  'report_assignment',
  'long_explainer',
  'clinical_record',
  'legal_contract',
  'student_record_teacher',
  'student_self_assessment',
  'resume_application',
  'personal_essay',
  'review_blog',
  'marketing',
  'social',
  'mail_notice',
  'creative',
  'general',
  'unknown'
]);

// 기존 import 이름은 유지하되 길이와 형식을 장르 목록에 섞지 않는다.
const DOCUMENT_PROFILES = CONTENT_GENRES;

const PROFILE_GROUPS = Object.freeze({
  academic_paper: 'academic_report_explainer',
  report_assignment: 'academic_report_explainer',
  long_explainer: 'academic_report_explainer',
  clinical_record: 'clinical_record',
  legal_contract: 'legal_contract',
  student_record_teacher: 'student_record_teacher',
  student_self_assessment: 'student_self_assessment',
  resume_application: 'essay_application',
  personal_essay: 'essay_application',
  review_blog: 'blog_social',
  social: 'blog_social',
  marketing: 'functional_copy',
  mail_notice: 'functional_copy',
  creative: 'creative',
  general: 'general',
  unknown: 'unknown'
});

const SENSITIVE_PROFILES = new Set([
  'academic_paper',
  'report_assignment',
  'clinical_record',
  'legal_contract',
  'student_record_teacher',
  'student_self_assessment',
  'resume_application',
  'creative'
]);

function detectDocumentProfile(source, { basicStyle = '' } = {}) {
  const text = String(source || '').trim();
  const compactLength = text.replace(/\s+/gu, '').length;
  const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const sentences = splitSentences(text, { preserveLines: false });
  const questionnaire = detectQuestionnaire(lines);
  const assessment = detectAssessmentItem(lines);
  const formatProfile = detectFormatProfile(text, lines, sentences, questionnaire, assessment);
  const scores = Object.fromEntries(CONTENT_GENRES.map(profile => [profile, 0]));
  const firstPersonSignals = computePovSeed(text).fp_singular;
  // `사진`, `오늘은`, `추천`처럼 주제 설명문에도 흔한 낱말 하나만으로 후기 장르를
  // 만들지 않는다. 후기 판정에는 실제 방문·구매·사용 경험 또는 명시적 후기 표지가
  // 필요하고, 사진 언급은 그 문맥이 확인된 뒤에만 약한 보조 신호로 쓴다.
  const reviewExperienceSignals = count(text, /(?:다녀왔|방문(?:했|해\s*보|하고)|써\s*봤|사용해\s*보|먹어\s*봤|구매(?:했|해\s*보)|예약(?:했|하고)|직접\s*(?:가\s*보|먹어\s*보|사용해\s*보))/gu);
  const explicitReviewSignals = count(text, /(?:후기|리뷰|맛집|내돈내산|솔직\s*후기)/gu);
  const reviewOpinionSignals = count(text, /(?:추천(?:해요|합니다|드려요)|솔직히|만족했|아쉬웠|재방문|또\s*가고\s*싶)/gu);
  const reviewPhotoSignals = count(text, /(?:사진|촬영|카메라)/gu);
  const reviewContentSignals = reviewExperienceSignals + explicitReviewSignals + reviewOpinionSignals;
  const reviewEndingSignals = count(text, /(?:해요|했어요|였어요|더라고요|거든요|네요|죠)[.!?~]?\s*(?=$|\n)/gmu);

  const legalArticleSignals = lines.filter(line => /^제\s*\d{1,3}\s*조(?:의\s*\d{1,3})?(?:\s|$|[（(])/u.test(line)).length;
  const legalPartySignals = count(text, /(?:^|[^가-힣A-Za-z0-9_])(?:갑|을|병|당사자|계약자|이용자|회사)(?:은|는|이|가|에게|의|와|과)(?=$|[^가-힣A-Za-z0-9_])/gmu);
  const legalDutySignals = count(text, /(?:계약|약관|해지|해제|권리|의무|손해\s*배상|위약|면책|관할|준거법|효력|유효\s*기간|통지|동의|귀책|채무|이행)/gu);
  const legalOperatorSignals = count(text, /(?:하여야\s*(?:한다|합니다|하며|하고)|해서는\s*(?:아니\s*)?(?:안\s*)?되(?:지|며|어|는|었|겠습니다|다)|할\s*수\s*(?:있다|있습니다|있는|없다|없습니다|없는)|아니한다|부담한다|귀속된다|효력을\s*(?:갖|발생)|해지할\s*수)/gu);
  if ((legalArticleSignals >= 2 && legalDutySignals >= 3 && legalOperatorSignals >= 1)
      || (legalArticleSignals >= 1 && legalPartySignals >= 2 && legalDutySignals >= 3 && legalOperatorSignals >= 2)) {
    scores.legal_contract += 6.2
      + Math.min(legalArticleSignals - 1, 5) * 0.42
      + Math.min(legalDutySignals - 3, 5) * 0.18;
  }

  const soapHeadingSignals = lines.filter(line => /^(?:#{1,6}\s*)?(?:SOAP(?:\s*Note)?|[SOAP])(?:\s*[:.-]|\s*$)/iu.test(line)).length;
  const clinicalLabelSignals = lines.filter(line => /^(?:\*{0,2})?(?:대상자|환자|아동|생년월일|평가일|검사일|평가도구|검사도구|주호소|진단명|치료사|보호자)(?:\*{0,2})?\s*:/u.test(line)).length;
  const clinicalAssessmentSignals = count(text, /(?:Denver\s*II|Sensory\s*Profile|BOT-?2|PDMS-?2|COPM|WeeFIM|M-ABC|VMI|PEDI|MMSE|K-MMSE|MoCA|BBS|FIM)/giu);
  const psychologicalAssessmentSignals = count(
    text,
    /(?:MMPI(?:-?2)?|SCT|TCI|MBTI|K-WAIS|K-WISC|로르샤흐|문장\s*완성\s*검사|수검자|내담자|검사\s*척도|임상\s*척도|타당도\s*척도|결정적\s*문항|평가\s*불안|상담\s*주제|상담\s*전략|심리\s*검사|심리\s*평가)/giu
  );
  const psychologicalInterpretationSignals = count(
    text,
    /(?:척도[^.!?\n]{0,36}(?:상승|하강|높|낮)|(?:상승|하강)한\s*척도|반응과\s*연결|검사에서\s*공통|방어적|억압|과잉\s*통제|정서성|자아\s*강도|대인\s*(?:불안|민감|의심)|성격\s*구조|시사(?:하|된)|해석(?:하|된)|중재|개입)/gu
  );
  const clinicalDomainSignals = count(text, /(?:감각\s*(?:프로파일|처리|조절|추구|회피)|고유\s*수용성|전정\s*감각|촉각\s*(?:방어|과민)|시지각|운동\s*계획|미세\s*운동|소근육|대근육|양측\s*협응|자세\s*조절|기능적\s*수행|독립\s*수행|일상생활동작|보호자\s*보고|임상\s*관찰)/giu);
  const clinicalObservationEndingSignals = sentences.filter(sentence => /(?:관찰됨|측정됨|확인됨|나타남|보임|어려움|저하됨|양호함|도움\s*필요|중재\s*필요|고려해야\s*함)[.!?。！？]?$/u.test(String(sentence || '').trim())).length;
  const clinicalTermSignals = count(text, /(?:감각\s*프로파일|Denver\s*II|작업\s*치료|물리\s*치료|언어\s*치료|임상\s*관찰|주호소|평가\s*도구|중재\s*계획|치료\s*목표|기능적\s*수행|보호자\s*보고|관찰됨|측정됨)/giu)
    + clinicalAssessmentSignals
    + clinicalDomainSignals;
  if ((soapHeadingSignals >= 4 && clinicalLabelSignals >= 2)
      || (/SOAP(?:\s*Note)?/iu.test(text) && soapHeadingSignals >= 3 && clinicalTermSignals >= 2)) {
    scores.clinical_record += 6.4
      + Math.min(soapHeadingSignals - 3, 3) * 0.35
      + Math.min(clinicalLabelSignals, 5) * 0.22
      + Math.min(clinicalTermSignals, 6) * 0.16;
  }
  // 제목이 잘린 임상 관찰 단편도 검사명·임상 영역·관찰형 종결이 함께
  // 남는다. 단일 의학 낱말만으로 일반 설명문을 임상 기록으로 올리지 않는다.
  if ((clinicalAssessmentSignals >= 1 && clinicalDomainSignals >= 2 && clinicalObservationEndingSignals >= 2)
      || (clinicalDomainSignals >= 4 && clinicalObservationEndingSignals >= 3)) {
    scores.clinical_record += 5.4
      + Math.min(clinicalAssessmentSignals, 3) * 0.28
      + Math.min(clinicalDomainSignals - 2, 5) * 0.2
      + Math.min(clinicalObservationEndingSignals - 2, 4) * 0.18;
  }
  // 심리검사 해석과 상담 사례는 SOAP 형식이나 작업치료 검사명이 없어도
  // 임상 기록의 보존 규칙이 필요하다. 검사명·수검자 문맥과 해석 행위가
  // 함께 반복될 때만 임상 프로필로 올려 일반 심리학 설명문과 구분한다.
  if ((psychologicalAssessmentSignals >= 3 && psychologicalInterpretationSignals >= 2)
      || (psychologicalAssessmentSignals >= 2 && psychologicalInterpretationSignals >= 4)) {
    scores.clinical_record += 5.7
      + Math.min(psychologicalAssessmentSignals - 2, 5) * 0.22
      + Math.min(psychologicalInterpretationSignals - 2, 5) * 0.16;
  }

  add(scores, 'academic_paper', count(text, /(?:초록|Abstract|연구\s*(?:목적|방법|결과|가설)|선행\s*연구|방법론|유의확률|참고\s*문헌|doi\s*:|KCI|RISS)/giu), 1.3);
  const inlineAcademicCitationSignals = count(text, /\([가-힣A-Za-z·,&\s]+,?\s*(?:19|20)\d{2}[a-z]?\)/gu);
  add(scores, 'academic_paper', inlineAcademicCitationSignals, 0.9);
  add(scores, 'academic_paper', count(text, /(?:p|t|F|β|R²)\s*[<=>]\s*-?\d+(?:\.\d+)?/gu), 1.2);
  const academicFramingSignals = count(text, /(?:본\s*연구(?:는|에서는|의)|이론적\s*배경|연구\s*(?:가설|문제|과제|한계)|향후\s*연구|실증적으로\s*분석|모형화|방법론)/gu);
  const academicSectionSignals = lines.filter(line => /^(?:\d+(?:\.\d+)*[.)]?\s*)?(?:서론|이론적\s*배경|연구\s*(?:방법|결과|모형)|결론(?:\s*및\s*향후\s*연구)?|참고\s*문헌)/u.test(line)).length;
  if ((formatProfile.referenceLineCount || 0) >= 3 && academicFramingSignals >= 2 && academicSectionSignals >= 3) {
    scores.academic_paper += 6.5
      + Math.min(academicFramingSignals - 2, 4) * 0.22
      + Math.min(academicSectionSignals - 3, 4) * 0.18;
  }
  const academicMethodEvidenceSignals = count(
    text,
    /(?:분석(?:하였|했|한다|대상|방법)|검토(?:하였|했|한다)|고찰(?:하였|했|한다)|연구\s*대상|연구\s*참여자|자료를\s*(?:수집|분석)|결과(?:는|가|를)|논의(?:하였|했|한다)|시사(?:하|점)|가설을\s*검증)/gu
  );
  const academicFormalEndingSignals = sentences.filter(sentence => (
    /(?:하였다|되었다|이다|있다|없다|나타났다|확인되었다|시사한다|제시한다|논의한다)[.!?。！？]?$/u.test(String(sentence || '').trim())
  )).length;
  const academicFormalEndingRatio = academicFormalEndingSignals / Math.max(1, sentences.length);
  const academicAbstractFrame = /(?:^|\n)\s*(?:초록|Abstract)\s*[:：]?/iu.test(text)
    && /(?:주제어|핵심어|Keywords?)\s*[:：]/iu.test(text)
    && academicMethodEvidenceSignals >= 2;
  const academicExcerptFrame = compactLength >= 450
    && firstPersonSignals === 0
    && academicFramingSignals >= 2
    && inlineAcademicCitationSignals >= 2
    && academicMethodEvidenceSignals >= 3
    && academicFormalEndingRatio >= 0.45;
  if (academicAbstractFrame || academicExcerptFrame) {
    scores.academic_paper += 6.25
      + Math.min(academicFramingSignals, 5) * 0.2
      + Math.min(inlineAcademicCitationSignals, 6) * 0.12;
  }

  add(scores, 'report_assignment', count(text, /(?:서론|본론|결론|과제|보고서|목차|조사\s*결과|문제점|개선\s*방안|시사점)/gu), 0.85);
  add(scores, 'report_assignment', formatProfile.headingCount, 0.38);
  const reportInquirySignals = count(text, /(?:본\s*(?:탐구|조사|과제)|이번\s*탐구|탐구\s*(?:동기|목적|주제|과정|방법|결과|결론)|조사\s*(?:목적|대상|방법|과정|결과)|비교\s*분석|사례\s*분석|이론적\s*(?:분석|검토)|문헌\s*(?:조사|검토)|설문\s*(?:조사|분석)|자료를\s*(?:수집|분석|비교)|주제(?:를|로)?\s*선정)/gu);
  const reportMethodSignals = count(text, /(?:연구|탐구|조사|분석)의?\s*(?:목적|대상|범위|방법|절차|과정|결과|한계)|(?:가설|변수|사례|자료|문헌|설문)[^.!?\n]{0,45}(?:분석|비교|검토|수집)/gu);
  const analyticalFrameworkSignals = count(text, /(?:(?:이론|관점|개념|모형)[^.!?\n]{0,55}(?:분석|적용|해석|비교)|(?:분석|적용|해석|비교)[^.!?\n]{0,55}(?:이론|관점|개념|모형))/gu);
  const reportHeadingSignals = lines.filter(line => /^(?:#{1,6}\s*)?(?:\d+(?:\.\d+)*[.)]?\s*)?(?:탐구\s*(?:동기|목적|주제|방법|과정|결과)|조사\s*(?:목적|방법|결과)|이론적\s*(?:배경|분석)|사례\s*분석|비교\s*분석|문제점|개선\s*방안|결론|느낀\s*점)\s*$/u.test(line)).length;
  const assignmentProblemHeadingSignals = lines.filter(line => (
    /^(?:문제|문항)\s*\d{1,3}\s*[.)：:]?\s*\S.{1,119}$/u.test(line)
  )).length;
  const structuredCareerPlanSignals = count(
    text,
    /(?:진로\s*설계|학교\s*생활|학업\s*계획|졸업\s*후|학부\s*연구생|현장\s*실습|1\s*~\s*2학년|[1-4]학년에는|연구실\s*활동|캡스톤\s*디자인)/gu
  );
  const orderedArgumentSignals = count(
    text,
    /(?:^|[\n.!?]\s*)(?:첫째|둘째|셋째|넷째|먼저|다음으로|마지막으로)(?=$|[\s,])/gmu
  );
  const explicitAssignmentWritingFrame = count(
    text,
    /(?:이|본)\s*글에서는[^.!?\n]{0,90}(?:서술|설명|정리|살펴보|제시)하고자\s*한다/gu
  );
  add(scores, 'report_assignment', reportInquirySignals, 0.58);
  add(scores, 'report_assignment', reportMethodSignals, 0.48);
  const learningLogSignals = count(text, /(?:이번\s*\d{1,2}\s*회차|학습(?:한|한\s*내용|했다|하였다)|배웠다|이해했다|소감란|학습\s*소감)/gu);
  if (learningLogSignals >= 3) {
    scores.report_assignment += 2.25 + Math.min(learningLogSignals - 3, 4) * 0.16;
  }
  const topicSelectionSignals = count(text, /(?:이번\s*탐구|주제(?:를|로)?\s*선정|문제에\s*관심을\s*(?:갖|가지)|원인을\s*알아보|해결\s*방안을\s*찾아보)/gu);
  if (topicSelectionSignals >= 2 && reportInquirySignals >= 1) {
    scores.report_assignment += 1.85 + Math.min(topicSelectionSignals - 2, 3) * 0.18;
  }
  if (reportHeadingSignals >= 2 && reportInquirySignals + reportMethodSignals >= 2) {
    scores.report_assignment += 2.1
      + Math.min(reportHeadingSignals - 2, 4) * 0.2
      + Math.min(reportInquirySignals + reportMethodSignals - 2, 5) * 0.12;
  } else if (reportInquirySignals >= 2 && (formatProfile.headingCount >= 1 || reportMethodSignals >= 1)) {
    scores.report_assignment += 1.35;
  }
  if (reportInquirySignals >= 1 && analyticalFrameworkSignals >= 2) {
    scores.report_assignment += 1.55 + Math.min(analyticalFrameworkSignals - 2, 4) * 0.16;
  }
  if (formatProfile.headingCount >= 2
      && compactLength >= 500
      && reviewContentSignals === 0
      && (reportInquirySignals + reportMethodSignals + analyticalFrameworkSignals >= 1)) {
    scores.report_assignment += 1.15 + Math.min(formatProfile.headingCount - 2, 4) * 0.12;
  }
  if ((formatProfile.labelLineCount || 0) >= 2 || (formatProfile.tableLineCount || 0) >= 2) {
    scores.report_assignment += 1.25;
  }
  // `문제 1. 진로 설계와 학교생활` 아래에서 첫째·둘째·셋째로
  // 학업·현장 계획을 논증하는 과제는 1인칭 때문에 에세이로 보이기 쉽다.
  // 요청 mode나 basicStyle이 아니라 원문 안의 과제 표제·작성 프레임·
  // 단계형 계획이 함께 있을 때만 보고서/과제 프로필을 확정한다.
  if (assignmentProblemHeadingSignals >= 1
      && structuredCareerPlanSignals >= 3
      && (orderedArgumentSignals >= 2 || explicitAssignmentWritingFrame >= 1)) {
    scores.report_assignment += 4.2
      + Math.min(structuredCareerPlanSignals - 3, 5) * 0.18
      + Math.min(orderedArgumentSignals, 4) * 0.16;
  }

  const researchDesignSignals = count(text, /(?:연구\s*질문|질문지법|문헌\s*연구법|공식\s*통계|법령|판결문|자료의?\s*범위|표집|상관\s*관계|인과\s*관계|분석\s*틀|최종\s*답)/gu);
  add(scores, 'report_assignment', researchDesignSignals, 0.62);

  const formalNormativeConceptSignals = count(text, /(?:생명\s*윤리|인간\s*(?:생명|존엄성)|미래\s*세대|사회적\s*(?:정의|합의)|국제\s*사회|윤리적\s*기준|과학적\s*검증|공공성|기본권|권리\s*보호|규제|제도)/gu);
  const formalNormativeOperatorSignals = count(text, /(?:해서는\s*안\s*된다|하여서는\s*안\s*된다|해야\s*(?:한다|할\s*것이다)|유지해야|보호해야|우선해야|마련해야|필요하다)/gu);
  const shortFormalEndingSignals = sentences.filter(sentence => /(?:한다|이다|된다|있다|없다|해야\s*한다|해야\s*할\s*것이다)[.!?。！？]?$/u.test(String(sentence || '').trim())).length;
  const shortFormalArgumentSignals = formalNormativeConceptSignals + formalNormativeOperatorSignals;
  if (compactLength >= 90
      && compactLength <= 1200
      && sentences.length >= 2
      && sentences.length <= 8
      && firstPersonSignals === 0
      && formalNormativeConceptSignals >= 3
      && formalNormativeOperatorSignals >= 2
      && shortFormalEndingSignals / Math.max(1, sentences.length) >= 0.66
      && legalArticleSignals === 0
      && legalPartySignals < 2) {
    scores.report_assignment += 3.7
      + Math.min(formalNormativeConceptSignals - 3, 4) * 0.18
      + Math.min(formalNormativeOperatorSignals - 2, 3) * 0.16;
  }

  const explicitStudentRecordAnchorSignals = count(text, /(?:세부\s*능력\s*및\s*특기\s*사항|세특|생활\s*기록부|교과\s*활동|수업\s*중|학생은)/gu);
  add(scores, 'student_record_teacher', explicitStudentRecordAnchorSignals, 1.35);
  add(scores, 'student_record_teacher', count(text, /(?:발표함|탐구함|기여함|보여\s*줌)/gu), 1.35);
  add(scores, 'student_record_teacher', count(text, /(?:함|됨|임|음)\s*[.!?]?\s*(?=$|\n)/gmu), 0.25);
  const nominalObservationEndings = sentences.filter(hasStudentRecordEnding).length;
  const observationSignals = count(text, /(?:수업|활동|탐구|발표|참여|태도|역량|모습|성장|협력|책임감|돋보|뛰어남|보여\s*줌|기여)/gu);
  const nominalEndingRatio = nominalObservationEndings / Math.max(1, sentences.length);
  const bulletLineCount = lines.filter(line => /^(?:[-*•]|\d+(?:[-.]\d+)*[:.)])\s*/u.test(line)).length;
  const instructionalPlanSignals = count(text, /(?:예정임|계획임|수업을\s*(?:할|진행할)\s*예정|학습\s*목표|차시|교수\s*학습)/gu);
  const likelyInstructionPlan = bulletLineCount >= 2 && instructionalPlanSignals >= 2;
  const technicalCatalogLabelSignals = lines.filter(line => /^(?:개요\s*및\s*배경|핵심\s*기술(?:\s*및\s*시스템\s*구성)?|운영\s*효과|시스템\s*구성|적용\s*기술|분석\s*결과|기대\s*효과)\s*[:：]/u.test(line)).length;
  if (nominalObservationEndings >= 2 && nominalEndingRatio >= 0.4 && observationSignals >= 2 && !likelyInstructionPlan) {
    scores.student_record_teacher += 1.1
      + Math.min(nominalObservationEndings, 6) * 0.45
      + Math.min(observationSignals, 5) * 0.18;
  }
  if (likelyInstructionPlan) scores.report_assignment += 1.4;
  // 기술 사례 카탈로그·서비스 분석표도 `구축함·적용함·기여함` 같은
  // 명사형 종결을 반복한다. 학생 관찰 주체가 전혀 없고 기술 라벨이
  // 반복되는 문서를 세특으로 분류하면 본문을 관찰 기록처럼 지나치게
  // 보존하므로, 이 조합에서는 보고서 증거를 우선한다.
  if (technicalCatalogLabelSignals >= 3
      && explicitStudentRecordAnchorSignals === 0
      && observationSignals <= 2) {
    scores.student_record_teacher = Math.min(scores.student_record_teacher, 1.2);
    scores.report_assignment += 1.8
      + Math.min(technicalCatalogLabelSignals - 3, 5) * 0.16;
  }

  const reflectionSignals = count(text, /(?:자기\s*평가|스스로\s*평가|배운\s*점|느낀\s*점|새롭게\s*(?:알게|배우게|깨닫게)\s*된\s*점|어려웠던\s*점|힘들었던\s*점|부족했던\s*점|노력한\s*점|맡은\s*역할|기여한\s*점|향후\s*계획|앞으로의?\s*계획|개선할\s*점)/gu);
  const educationSignals = count(text, /(?:수업|학습|교과|과제|활동|탐구|발표|수행|모둠|진로|역량|협업|학교)/gu);
  const selfAssessmentActionSignals = count(text, /(?:활동|수업|과제|탐구|발표)[^.!?\n]{0,70}(?:어려|힘들|해결|배우|느끼|알게|깨닫|보완|개선|계획)|(?:어려움|문제)[^.!?\n]{0,55}(?:해결|극복|보완)|(?:앞으로|다음에는|향후)[^.!?\n]{0,55}(?:하겠|해\s*볼|보완|개선|계획)/gu);
  const selfReflectivePredicateSignals = count(text, /(?:알게\s*되|이해하게\s*되|이해할\s*수\s*있었|배우게\s*되|배울\s*수\s*있었|깨달|인상\s*깊|생각하게\s*되|어려웠|힘들었|태도(?:가|를)[^.!?\n]{0,24}(?:생기|기르|갖)|습관을\s*기르|키워\s*나가고자)/gu);
  const reflectiveActivitySignals = count(text, /(?:이번|해당)?\s*(?:탐구|수업|활동|과제|발표|프로젝트)(?:를|을|에서|에서는|하면서|하며|\s*과정)/gu);
  add(scores, 'student_self_assessment', count(text, /(?:학생\s*자기\s*평가|자기\s*성찰|활동\s*소감|수업\s*소감|학습\s*성찰)/gu), 1.4);
  add(scores, 'student_self_assessment', reflectionSignals, 0.58);
  if (questionnaire.isQuestionnaire && questionnaire.educationQuestionCount >= 2) {
    scores.student_self_assessment += 2.35
      + Math.min(questionnaire.questionCount, 10) * 0.18
      + Math.min(reflectionSignals, 5) * 0.28;
  } else if (educationSignals >= 3 && reflectionSignals >= 2) {
    scores.student_self_assessment += 1.35;
  }
  if (educationSignals >= 2 && reflectionSignals >= 1 && selfAssessmentActionSignals >= 2) {
    scores.student_self_assessment += 1.85
      + Math.min(selfAssessmentActionSignals - 2, 3) * 0.2;
  }
  if (reflectiveActivitySignals >= 1 && educationSignals >= 2 && selfReflectivePredicateSignals >= 3) {
    scores.student_self_assessment += 2.45
      + Math.min(selfReflectivePredicateSignals - 3, 4) * 0.2;
  }

  const selfAssessmentSectionSignals = lines.filter(line => /^(?:느낀\s*점|배운\s*점|본인이\s*잘했던\s*것|잘했던\s*점|어려웠던\s*점|관심이\s*갔던\s*내용|향후\s*계획|기타)\s*[:：]?$/u.test(line)).length;
  const explicitReflectionDocumentSignals = lines.filter(line => (
    /(?:^|\s)(?:개인\s*)?성찰\s*(?:일지|문|보고서)\s*$/u.test(line)
    || /^(?:학습|수업|프로젝트)\s*성찰\s*$/u.test(line)
  )).length;
  if (selfAssessmentSectionSignals >= 2 && selfReflectivePredicateSignals >= 1) {
    scores.student_self_assessment += 3.35
      + Math.min(selfAssessmentSectionSignals - 2, 4) * 0.24
      + Math.min(selfReflectivePredicateSignals - 1, 3) * 0.16;
  }

  const explicitApplicationSignals = count(text, /(?:지원\s*동기|입사\s*후\s*포부|직무\s*역량|직업\s*윤리(?:관)?|자기\s*소개서|자소서|저의\s*(?:(?:가장\s*(?:큰|뛰어난)\s*)?(?:강점|경쟁력|핵심\s*역량)|성장\s*과정)|귀사|지원(?:하게\s*)?(?:되었습니다|하였습니다|했습니다)|(?:연구원|전문가|인재|구성원)(?:이|가)?\s*되겠습니다)/gu);
  const applicationIntentSignals = count(text, /(?:신청\s*(?:동기|이유)|신청(?:하게\s*)?(?:되었습니다|하였습니다|했습니다|하고자|하려고|하고\s*싶)|지원(?:하게\s*)?(?:되었습니다|하였습니다|했습니다|하고자|하려고|하고\s*싶)|참여하게\s*된다면|선발된다면)/gu);
  const programApplicationSignals = count(text, /(?:(?:캠프|프로그램|교육\s*과정|체험\s*활동|학과\s*탐방|멘토링)[^.!?\n]{0,90}(?:신청|지원|참여|선발|체험)|(?:신청|지원|참여|선발)[^.!?\n]{0,90}(?:캠프|프로그램|교육\s*과정|체험\s*활동|학과\s*탐방|멘토링))/gu);
  const careerActionSignals = count(text, /(?:수집|정리|분석|비교|조사|기획|설계|운영|관리|지원|발표|협업|조율|응대|개선|제작|시각화|학습|연습|근무|실험|조정|최적화|도출|검증|측정|해석|문서화|작성|유지)/gu);
  const achievementSignals = count(text, /(?:합격|취득|등급|자격증|성과|역량|능력|강점|경쟁력|목표를\s*(?:달성|이뤄)|키웠|길렀|향상|보완|다졌|갖췄|갖추었|확보|구현|재현성|신뢰성)/gu);
  const roleFitSignals = count(text, /(?:직무|실무|업무|입사|채용|지원서|지원\s*분야|회사|조직|고객|수강생|교육\s*운영|운영\s*지원|연구\s*개발|연구원|소재\s*개발|업무에\s*(?:활용|적용)|도움이\s*될|기여(?:할|하는|하고자))/gu);
  const experienceNarrativeSignals = count(text, /(?:당시|그\s*과정에서|이\s*과정에서|이\s*경험(?:은|을|으로|을\s*통해)|경험을\s*바탕으로|준비\s*기간|아르바이트|프로젝트)/gu);
  const applicationValuePropositionSignals = count(text, /(?:^|\n|[.!?]\s*)(?:저의\s*(?:가장\s*(?:큰|뛰어난)\s*)?(?:강점|경쟁력|핵심\s*역량)|제가\s*(?:갖춘|보유한)\s*(?:강점|경쟁력|역량)|저는\s+[^.!?\n]{0,70}(?:강점|경쟁력|역량)(?:을|를|이|가|은|는))/gmu);
  const careerAspirationSignals = count(text, /(?:입사\s*후|귀사|지원(?:하게\s*)?(?:되었습니다|하였습니다|하고자|했습니다)|(?:연구원|전문가|인재|구성원)(?:이|가)?\s*되겠습니다|[가-힣]{2,20}(?:관리사|간호사|공무원|제작자|실무자|전문가|연구원|담당자)(?:이|가|로)?\s*(?:되(?:겠습니다|는\s*것|고\s*싶)|성장(?:하겠습니다|하고\s*싶))|(?:직무|업무|연구\s*개발|소재\s*개발|기관|조직|병원)[^.!?\n]{0,55}기여(?:하겠습니다|하고자\s*합니다|하는))/gu);
  const researchCareerContextSignals = count(text, /(?:연구실|연구\s*개발|실험\s*(?:설계|조건|데이터|결과)|공정\s*(?:조건|변수|최적화)|분석\s*장비|시편|재현성|연구\s*과제|투고\s*논문)/gu);
  const applicationSectionSignals = lines.filter(line => /^(?:#{1,6}\s*)?(?:\d+(?:\.\d+)*[.)]?\s*)?(?:성장\s*과정|성격의?\s*(?:장단점|강점|약점)|강점과\s*약점|보유\s*역량|핵심\s*역량|직무\s*경험|경력\s*사항|자격(?:증|\s*및\s*교육)|협업\s*및\s*문제\s*해결\s*경험|지원\s*동기|입사\s*후\s*포부)\s*$/u.test(line)).length;
  const strengthWeaknessSignals = count(text, /(?:저의|제|제가\s*가진)?\s*(?:강점|장점|약점|단점)|(?:약점|단점|부족한\s*점)[^.!?\n]{0,65}(?:보완|개선|극복)|(?:강점|장점)[^.!?\n]{0,65}(?:활용|발휘)/gu);
  const qualificationSignals = count(text, /(?:자격증|자격을\s*취득|근무\s*경험|업무\s*경험|직무\s*경험|현장\s*경험|교육을\s*이수|과정을\s*수료)/gu);
  const researchPlacementSignals = count(text, /(?:현장\s*실습|인턴(?:십)?|연구\s*인턴|연구실|연구\s*기관|연구소|산학\s*협력|실험실)/gu);
  const applicationEvidenceSignals = count(text, /(?:그\s*결과|상위\s*\d+(?:\.\d+)?%|성적(?:을|이)?\s*(?:높|향상)|성과(?:를|가)?\s*(?:달성|창출)|문제(?:를|가)?\s*(?:해결|개선)|재현성(?:을|이)?\s*(?:확보|검증))/gu);
  const futureContributionSignals = count(text, /(?:기여하겠습니다|기여하고자\s*합니다|활용하겠습니다|적용하겠습니다|수행하겠습니다|익히겠습니다|배우겠습니다|갖추겠습니다)/gu);
  // 1인칭과 `저의 경험`은 과제 성찰문·학습 에세이에도 흔하다. 실제
  // 신청·채용·직무 적합성 문맥이 하나라도 있을 때만 1인칭을 지원서
  // 보조 신호로 사용한다.
  const directApplicationContextSignals = explicitApplicationSignals
    + applicationIntentSignals
    + programApplicationSignals
    + applicationValuePropositionSignals
    + careerAspirationSignals
    + applicationSectionSignals;
  const educationalReflectionQuestionnaire = questionnaire.isQuestionnaire
    && questionnaire.educationQuestionCount >= 2
    && applicationIntentSignals === 0
    && programApplicationSignals === 0;
  if (explicitReflectionDocumentSignals >= 1
      && educationalReflectionQuestionnaire
      && questionnaire.answerBlockCount >= 2) {
    scores.student_self_assessment += 2.8
      + Math.min(questionnaire.answerBlockCount - 2, 4) * 0.18;
  }
  add(scores, 'resume_application', explicitApplicationSignals, 1.35);
  add(scores, 'resume_application', applicationIntentSignals, 1.35);
  add(scores, 'resume_application', programApplicationSignals, 0.85);
  if (directApplicationContextSignals >= 1) {
    add(scores, 'resume_application', Math.min(firstPersonSignals, 3), 0.22);
  }

  // 주차별 `수업 내용 요약 / 내 시합·일상 적용 / 활용 방안` 형식은
  // 명사형 종결을 많이 쓰지만 교사가 학생을 관찰한 세특이 아니라 학생의
  // 적용 일지다. 종결형만 보면 student_record_teacher가 압도하므로,
  // 개인 적용 라벨·주차 구조·1인칭 경험이 함께 있을 때 자기평가를 우선한다.
  const appliedLearningJournalLabelSignals = lines.filter(line => (
    /^(?:수업\s*내용\s*요약|내\s*(?:시합|경기|훈련|일상)(?:\s*\/\s*(?:시합|경기|훈련|일상))?\s*적용|나의\s*(?:시합|경기|훈련|일상)\s*적용|활용\s*방안)\s*[:：]/u.test(line)
  )).length;
  const appliedLearningJournalWeekSignals = lines.filter(line => (
    /^제\s*\d{1,2}\s*주\s*[:：]/u.test(line)
  )).length;
  const firstPersonAppliedLearningSignals = count(
    text,
    /(?:내|나의|저의|제)\s*(?:시합|경기|훈련|일상|생활|경험|성향|감정|집중력|마음|루틴|기록|적용)/gu
  );
  const appliedLearningJournalFrame = appliedLearningJournalLabelSignals >= 4
    && appliedLearningJournalWeekSignals >= 2
    && firstPersonAppliedLearningSignals >= 1;
  if (appliedLearningJournalFrame) {
    scores.student_self_assessment += 6.2
      + Math.min(appliedLearningJournalLabelSignals - 4, 8) * 0.16
      + Math.min(appliedLearningJournalWeekSignals - 2, 4) * 0.18;
    if (explicitStudentRecordAnchorSignals === 0) {
      scores.student_record_teacher = Math.min(scores.student_record_teacher, 1.3);
    }
  }
  if (compactLength <= 1600
      && firstPersonSignals >= 1
      && researchPlacementSignals >= 1
      && futureContributionSignals >= 1
      && careerActionSignals >= 4
      && (achievementSignals >= 1 || applicationEvidenceSignals >= 1)) {
    scores.resume_application += 3.2
      + Math.min(researchPlacementSignals - 1, 2) * 0.18
      + Math.min(applicationEvidenceSignals, 3) * 0.2;
  }
  const professionalPastEndingSignals = sentences.filter(sentence => /(?:했습니다|하였습니다|맡았습니다|기여했습니다|해결했습니다|구현했습니다|개선했습니다)[.!?。！？]?$/u.test(sentence.trim())).length;
  const technicalCareerDeliverableSignals = count(
    text,
    /(?:요구\s*사항|설계\s*검토|기능\s*시험|시험\s*절차|시험\s*문서|회로|PCB|펌웨어|F\/W|레지스터|FPGA|PLL|RF|PIC|MCU|Gerber|BOM|인수인계|양산|시제품|모듈|디버깅|검증값)/giu
  );
  const professionalResponsibilitySignals = count(
    text,
    /(?:담당(?:하|했)|수행(?:하|했)|작성(?:하|했)|설계(?:하|했)|검토(?:하|했)|시험(?:하|했)|구현(?:하|했)|인수인계(?:하|했)|관리(?:하|했))/gu
  );
  const technicalCareerFrame = compactLength >= 180
    && compactLength <= 2400
    && professionalPastEndingSignals >= 3
    && careerActionSignals >= 5
    && technicalCareerDeliverableSignals >= 4
    && professionalResponsibilitySignals >= 3
    && academicFramingSignals <= 1
    && applicationIntentSignals === 0;
  if (technicalCareerFrame) {
    scores.resume_application += 5.35
      + Math.min(professionalPastEndingSignals - 3, 5) * 0.16
      + Math.min(technicalCareerDeliverableSignals - 4, 6) * 0.12;
  }
  const fundingPlanSignals = count(text, /(?:지원금|장학금|보조금)[^.!?\n]{0,90}(?:활용|사용|저축|계획)|(?:활용|사용)\s*계획[^.!?\n]{0,60}(?:지원금|장학금|보조금)/gu);
  if (fundingPlanSignals >= 1 && firstPersonSignals >= 1) {
    scores.resume_application += 2.35 + Math.min(fundingPlanSignals - 1, 2) * 0.22;
  }
  if (!educationalReflectionQuestionnaire
      && professionalPastEndingSignals >= 3
      && careerActionSignals >= 5
      && achievementSignals >= 1
      && (experienceNarrativeSignals >= 1 || formatProfile.headingCount >= 1)) {
    scores.resume_application += 2.55
      + Math.min(professionalPastEndingSignals - 3, 4) * 0.15;
  }
  if (careerAspirationSignals >= 1
      && professionalPastEndingSignals >= 2
      && careerActionSignals >= 3) {
    scores.resume_application += 3
      + Math.min(professionalPastEndingSignals - 2, 3) * 0.14;
  }
  // 취업 지원서뿐 아니라 대학·기관의 캠프/교육 프로그램 신청서도 지원서다.
  // 단순한 행사 후기를 오인하지 않도록 1인칭, 명시적 신청 의도, 프로그램
  // 참여 문맥이 함께 있을 때만 강한 장르 증거로 사용한다.
  if (firstPersonSignals >= 2 && applicationIntentSignals >= 1 && programApplicationSignals >= 1) {
    scores.resume_application += 2.2
      + Math.min(applicationIntentSignals - 1, 2) * 0.25
      + Math.min(programApplicationSignals - 1, 3) * 0.18;
  }
  if (careerActionSignals >= 3 && achievementSignals >= 2 && roleFitSignals >= 2
      && (explicitApplicationSignals >= 1 || experienceNarrativeSignals >= 1 || careerAspirationSignals >= 1)) {
    scores.resume_application += 2.15
      + Math.min(careerActionSignals - 3, 5) * 0.13
      + Math.min(achievementSignals - 2, 4) * 0.16
      + Math.min(roleFitSignals - 2, 3) * 0.18;
  } else if (explicitApplicationSignals >= 1 && careerActionSignals >= 2 && achievementSignals >= 1) {
    scores.resume_application += 1.15;
  }
  // 연구개발 지원서는 논문 어휘가 많아 `연구 결과` 같은 단어만으로 학술문으로
  // 기울기 쉽다. 자기 강점으로 시작해 실제 수행을 제시하고 특정 직업·기여로
  // 닫는 지원서 프레임이 함께 있을 때만 강한 장르 증거로 사용한다. 연구·실험
  // 어휘 하나만으로는 이 가산점이 생기지 않아 실제 논문을 자소서로 오인하지 않는다.
  if (applicationValuePropositionSignals >= 1
      && careerAspirationSignals >= 1
      && firstPersonSignals >= 1
      && careerActionSignals >= 3
      && achievementSignals >= 2) {
    scores.resume_application += 3.35
      + Math.min(researchCareerContextSignals, 5) * 0.14;
  } else if (applicationValuePropositionSignals >= 1
      && firstPersonSignals >= 1
      && careerActionSignals >= 3
      && achievementSignals >= 2) {
    scores.resume_application += 1.65;
  } else if (careerAspirationSignals >= 1
      && firstPersonSignals >= 1
      && careerActionSignals >= 3) {
    scores.resume_application += 3;
  }
  // 제목이 없는 경력 소개나 문항형 자기소개서도 강점·보완 행동·업무 근거가
  // 함께 있으면 지원서로 본다. 한 가지 자기성찰 표현만으로 개인 에세이를
  // 오인하지 않도록 직무/자격 문맥과 1인칭을 동시에 요구한다.
  if (firstPersonSignals >= 1
      && (applicationSectionSignals >= 2 || strengthWeaknessSignals >= 2)
      && (roleFitSignals >= 1 || qualificationSignals >= 1)
      && careerActionSignals >= 2) {
    scores.resume_application += 2.45
      + Math.min(applicationSectionSignals, 4) * 0.18
      + Math.min(qualificationSignals, 3) * 0.16;
  }
  if (applicationSectionSignals >= 1
      && careerAspirationSignals >= 1
      && careerActionSignals >= 3) {
    scores.resume_application += 2.65
      + Math.min(applicationSectionSignals - 1, 3) * 0.2;
  }

  add(scores, 'review_blog', reviewContentSignals, 0.8);
  add(scores, 'review_blog', reviewEndingSignals, 0.24);
  if ((reviewExperienceSignals >= 1 || explicitReviewSignals >= 1)
      && (reviewEndingSignals >= 1 || firstPersonSignals >= 1 || reviewOpinionSignals >= 1)) {
    scores.review_blog += 1.35 + Math.min(reviewPhotoSignals, 3) * 0.12;
  }

  const researchDiscussionContext = (formatProfile.flags.includes('reference_heavy') || formatProfile.flags.includes('sectioned'))
    && academicFramingSignals >= 2;
  const commercialSignals = commercialSignalPolicy.measureCommercialSignals(text, {
    reviewSignalCount: reviewContentSignals,
    researchDiscussionContext
  });
  const marketingActionSignals = commercialSignals.directActionCount;
  const promotionSignals = commercialSignals.offerCount + commercialSignals.priceCount;
  const commercialNounSignals = count(text, /(?:구매|가격|결제|상품|서비스|혜택|무료|₩|원)/gu);
  add(scores, 'marketing', marketingActionSignals, 1.15);
  add(scores, 'marketing', promotionSignals, 0.85);
  if ((marketingActionSignals >= 1 || promotionSignals >= 1) && commercialNounSignals >= 1) {
    scores.marketing += 1.05;
  }
  if (commercialSignals.commercialReview) {
    scores.review_blog += 1.05;
    scores.marketing += Math.min(1.25, commercialSignals.commercialIntentCount * 0.12);
  }
  if (researchDiscussionContext && marketingActionSignals === 0) {
    scores.marketing = Math.min(scores.marketing, 0.9);
  }

  add(scores, 'social', count(text, /#[가-힣A-Za-z0-9_]+/gu), 0.7);
  add(scores, 'social', count(text, /[😀-🙏🌀-🫿❤♥✨🔥✅📌]/gu), 0.42);
  if (compactLength <= 450 && lines.length >= 3 && median(lines.map(line => line.length)) <= 35) scores.social += 1.2;

  const mailLexicalSignals = count(text, /(?:안녕하세요[,.]?|안녕하십니까[,.]?|학우\s*여러분|수신\s*:|발신\s*:|제목\s*:|귀하|인사드립니다|드립니다|안내드립니다|회신|문의\s*사항|감사합니다|올림|드림)/gu);
  const mailApologyRequestSignals = count(text, /(?:죄송합니다|송구합니다|양해(?:를)?\s*(?:부탁|구|바라)|부탁드립니다|확인\s*부탁|회신\s*부탁|가능하실까요|괜찮으실까요|문의드립니다|여쭙습니다|답변\s*부탁)/gu);
  const mailRecipientSignals = count(text, /(?:교수님|선생님|담당자님|조교님|팀장님|원장님|위원장님|안녕하세요)[,.!]?/gu);
  const officialRoleSignals = count(text, /(?:위원장|회장|대표|담당자|총학생회|운영위원회|비상대책위원회|학생회|사무국)/gu);
  const signatureDateLines = lines.filter(line => /^(?:(?:19|20)\d{2}[.년]\s*\d{1,2}[.월]\s*\d{1,2}(?:일)?|\d{1,2}월\s*\d{1,2}일)$/u.test(line)).length;
  const signatureInstitutionLines = lines.filter(line => /(?:대학교|대학|학과|전공|위원회|학생회|협회|기관|재단|회사).*(?:위원장|회장|대표|담당자|드림|올림)?$/u.test(line)).length;
  add(scores, 'mail_notice', mailLexicalSignals, 0.72);
  add(scores, 'mail_notice', mailApologyRequestSignals, 1.05);
  if (mailRecipientSignals >= 1 && mailApologyRequestSignals >= 1) {
    scores.mail_notice += 2.45
      + Math.min(mailApologyRequestSignals - 1, 3) * 0.22;
    // 짧은 사과·요청 메일의 줄바꿈을 SNS 신호로 중복 계산하지 않는다.
    scores.social = Math.max(0, scores.social - 1.2);
  }
  if (/(?:안녕하세요|안녕하십니까|학우\s*여러분|수신\s*:)/u.test(text)
      && /(?:감사합니다|드림|올림|위원장|회장|대표)\s*[.!]?\s*$/u.test(text)) scores.mail_notice += 2.2;
  if (mailLexicalSignals >= 2 && officialRoleSignals >= 1
      && (signatureDateLines >= 1 || signatureInstitutionLines >= 1)) {
    scores.mail_notice += 3.1
      + Math.min(officialRoleSignals - 1, 3) * 0.2
      + Math.min(signatureInstitutionLines, 3) * 0.18;
  }
  const applicationLetterFrame = applicationIntentSignals >= 1
    && firstPersonSignals >= 2
    && (roleFitSignals >= 1 || careerActionSignals >= 3 || careerAspirationSignals >= 1);
  if (applicationLetterFrame && mailApologyRequestSignals === 0) {
    scores.resume_application += 2.7
      + Math.min(applicationIntentSignals - 1, 3) * 0.2;
    // 지원서의 인사말·감사말은 기능 메일의 송수신 행위가 아니다.
    // 회신·양해 요청이 없는 경우 메일 점수가 지원 의도를 덮지 못하게 한다.
    scores.mail_notice = Math.min(scores.mail_notice, 1.65);
  }

  const quoteLines = lines.filter(line => /^(?:[>“"'‘]|[-*]\s)/u.test(line)).length;
  const poemLikeLines = lines.filter(line => line.length <= 34 && !/[.!?。！？]$/u.test(line)).length;
  const structuredFunctionalFormat = ['table_heavy', 'list_heavy', 'label_heavy', 'sectioned', 'questionnaire']
    .some(flag => formatProfile.flags.includes(flag));
  const explainerConceptSignals = count(text, /(?:개념|원리|이론|역사적\s*배경|특징|구조|기능|영향|관계|차이|의미|과정|사례|쟁점|메커니즘|제도)/gu);
  const formalExpositionEndings = sentences.filter(sentence => /(?:한다|했다|하였다|이다|였다|이었다|된다|되었다|있다|없다|보인다|나타난다|나타났다|드러난다|드러났다|의미한다)[.!?。！？]?$/u.test(sentence.trim())).length;
  const formalExpositionRatio = formalExpositionEndings / Math.max(1, sentences.length);
  // 작품을 분석하는 독후감·비평문도 "소설", "등장인물"을 반복한다.
  // 이 두 일반 명사를 창작 저작 신호로 직접 가산하면 작품 감상문이
  // creative로 과대 분류되고, 뒤의 보존형 창작 강도 정책까지 잘못 탄다.
  // 창작 형식 자체를 나타내는 표지와 실제 서사 장면 조합만 강한 신호로 쓴다.
  const strongCreativeSignals = count(text, /(?:시\s*$|시집|운문|장면\s*\d+|단편\s*소설|화자\s*:)/gmu);
  const weakCreativeSignals = count(text, /(?:그날의|바람이|달빛|별빛|노을|그림자|고요(?:가|는|를)|계절의)/gu);
  const proseNarrativeSignals = count(text, /(?:그는|그녀는|소년은|소녀는|노인은|남자는|여자는|아이는|아이의|문을\s*열(?:었|고)|걸어갔|돌아섰|바라보았|중얼거렸|속삭였|말했|물었|대답했|웃었|울었)/gu);
  const proseDialogueSignals = count(
    text,
    /[“"][^”"\n]{2,120}[”"]\s*(?:(?:라고|하고|라며|라면서|하고\s*말|라고\s*말)|(?:[가-힣]{2,8})(?:이|가|은|는)\s*(?:묻|말하|대답하|속삭이|중얼거리|외치))/gu
  );
  const proseSceneSignals = count(text, /(?:골목|창문|방\s*안|문틈|발자국|숨소리|빗소리|햇빛|달빛|어둠|냄새|바람|비가|눈이|밤(?:은|이|의)|새벽)/gu);
  add(scores, 'creative', strongCreativeSignals, 1.05);
  if (!structuredFunctionalFormat
      && lines.length >= 4
      && poemLikeLines / lines.length >= 0.65
      && median(lines.map(line => line.length)) <= 32) scores.creative += 3.4;
  if (quoteLines >= 3 && /[“”"']/u.test(text)) scores.creative += 1.1;
  if ((formatProfile.flags.includes('line_sensitive') || quoteLines >= 3 || strongCreativeSignals >= 1)
      && weakCreativeSignals >= 1) {
    scores.creative += Math.min(weakCreativeSignals, 4) * 0.18;
  }
  if (!structuredFunctionalFormat
      && ((proseDialogueSignals >= 2 && proseNarrativeSignals >= 2)
        || (proseDialogueSignals >= 1 && proseNarrativeSignals >= 2 && proseSceneSignals >= 2)
        || (proseNarrativeSignals >= 4 && proseSceneSignals >= 2))) {
    scores.creative += 4
      + Math.min(proseDialogueSignals, 4) * 0.22
      + Math.min(proseSceneSignals, 5) * 0.12;
  }
  const literaryAnalysisSignals = count(
    text,
    /(?:이\s*작품|작품에서|작품은|소설에서|소설은|작가가|작가는|주인공|등장인물|인물의|서사|문학적|상징(?:하|은|을|적)|텍스트|구절|작품\s*속)/gu
  );
  const literaryInterpretationSignals = count(
    text,
    /(?:의미(?:하|를\s*가진)|보여\s*준다|드러낸다|나타낸다|상징한다|해석할\s*수|해석된다|분석하면|대조(?:된|한다)|시사한다|점이다|역할을\s*한다)/gu
  );
  const personalReflectionSignals = count(text, /(?:생각한다|느꼈다|깨달았다|경험을\s*통해|돌이켜\s*보면|기억에\s*남|배우게\s*되었다)/gu);
  const literaryAnalysisFrame = compactLength >= 240
    && literaryAnalysisSignals >= 4
    && (literaryInterpretationSignals >= 2
      || (literaryAnalysisSignals >= 6 && explainerConceptSignals >= 3)
      || (literaryAnalysisSignals >= 4
        && literaryInterpretationSignals >= 1
        && (firstPersonSignals >= 1 || personalReflectionSignals >= 1)))
    && (formalExpositionRatio >= 0.32
      || firstPersonSignals >= 1
      || personalReflectionSignals >= 1);
  if (literaryAnalysisFrame) {
    // 작품 속 인물의 행동을 요약한 비평·독후 분석은 서사 동사와 장면
    // 어휘가 많아도 창작문이 아니다. 메타 분석 표지와 평서형 설명이 함께
    // 반복될 때 보고서/설명문으로 라우팅해 구어적 창작 프롬프트를 막는다.
    scores.report_assignment += 3.25
      + Math.min(literaryAnalysisSignals - 4, 6) * 0.12;
    scores.long_explainer += 2.9
      + Math.min(literaryInterpretationSignals - 2, 5) * 0.14;
    if (!formatProfile.flags.includes('line_sensitive')) {
      scores.creative = Math.max(0, scores.creative - 4.3);
    }
  }

  add(scores, 'personal_essay', personalReflectionSignals, 0.55);
  add(scores, 'personal_essay', firstPersonSignals, 0.22);
  if (firstPersonSignals >= 2 && personalReflectionSignals >= 1) scores.personal_essay += 0.8;
  const bookReflectionSignals = count(
    text,
    /(?:독후감|독서\s*(?:감상|기록)|이\s*(?:책|소설|작품)(?:은|을|에서|의)|(?:책|소설|작품)을\s*(?:읽|선택)|읽(?:고|으면서|은)\s*(?:뒤|후|작품|소설)|저자(?:는|가)|작가(?:는|가)|지은이|지음|부제|인상\s*깊었던\s*(?:내용|구절|장면)|(?:책|작품)을\s*선택한\s*이유)/gu
  );
  const literaryReflectionFrame = compactLength >= 240
    && literaryAnalysisSignals >= 3
    && (literaryInterpretationSignals >= 1 || bookReflectionSignals >= 2)
    && (firstPersonSignals >= 1 || personalReflectionSignals >= 1)
    && !formatProfile.flags.includes('line_sensitive');
  if (literaryReflectionFrame) {
    // 1인칭으로 작품의 질문·인물·의미를 해석하는 글은 창작물이 아니라
    // 독후감/문학 성찰이다. 개인 화자가 있으면 personal_essay를 우선하고,
    // 형식적인 분석문 후보도 안전망으로 남긴다.
    scores.personal_essay += 4.15
      + Math.min(Math.max(0, literaryAnalysisSignals - 3), 6) * 0.14;
    scores.report_assignment += 1.45;
    scores.creative = Math.min(scores.creative, 0.95);
  }

  const structuredProposalHeadingSignals = lines.filter(line => (
    /^(?:#{1,6}\s*)?(?:\d+(?:\.\d+)*[.)]?\s*)?(?:사업\s*(?:배경(?:\s*및\s*목적)?|목적|목표|개요)|문제\s*해결(?:을\s*위한\s*사업\s*목표)?|고객(?:\s*\([^)]{1,40}\))?|가치\s*제안(?:\s*\([^)]{1,40}\))?|가치\s*사슬(?:\s*\([^)]{1,40}\))?|시장\s*(?:현황|상황|분석)[^:：]{0,40}|(?:현재\s*)?마케팅\s*(?:현황|전략|방안)[^:：]{0,40}|제안서\s*(?:목적|개요)|기획의?\s*기대\s*효과|창업\s*(?:배경|과정)[^:：]{0,40}|산업의?\s*(?:특성|역량)|위기\s*극복\s*전략|핵심\s*전략|추진\s*(?:전략|계획|체계)|실행\s*(?:전략|방안|계획)|운영\s*(?:전략|계획)|수익\s*모델|예산\s*계획|기대\s*효과)(?:\s*[:：].*)?$/u.test(line)
  )).length;
  const structuredProposalBodySignals = count(
    text,
    /(?:사업\s*(?:배경|목적|목표)|문제\s*해결을\s*위한|가치\s*제안|가치\s*사슬|비즈니스\s*모델|BMC|SWOT|STP|4P|시장\s*(?:분석|세분화)|마케팅\s*(?:현황|전략|방안)|제안서|기대\s*효과|추진\s*(?:전략|계획)|실행\s*(?:전략|방안)|운영\s*(?:전략|계획)|수익\s*모델|고용\s*창출|판로\s*확대|창업\s*(?:배경|과정|기회)|위기\s*극복\s*전략|고객\s*세그먼트|채널\s*\(|핵심\s*(?:활동|자원|파트너))/giu
  );
  const structuredProposalFrame = structuredProposalHeadingSignals >= 2
    || (structuredProposalHeadingSignals >= 1
      && structuredProposalBodySignals >= 3
      && (formatProfile.headingCount >= 2 || bulletLineCount >= 3))
    || (structuredProposalHeadingSignals >= 1
      && nominalObservationEndings >= 4
      && explicitStudentRecordAnchorSignals === 0)
    || (structuredProposalBodySignals >= 5 && bulletLineCount >= 5);
  const teacherObservationSubjectSignals = count(
    text,
    /(?:학생(?:은|이|의|에게)|학습자(?:는|가|의)|수업\s*중[^.!?\n]{0,40}(?:모습|태도|참여)|교사가\s*관찰|관찰한\s*결과)/gu
  );
  if (structuredProposalFrame) {
    scores.report_assignment += 4.1
      + Math.min(structuredProposalHeadingSignals, 6) * 0.22
      + Math.min(Math.max(0, structuredProposalBodySignals - 3), 6) * 0.12;
    if (explicitStudentRecordAnchorSignals === 0 && teacherObservationSubjectSignals === 0) {
      scores.student_record_teacher = Math.min(scores.student_record_teacher, 1.25);
    }
    if (!formatProfile.flags.includes('line_sensitive')
        && proseDialogueSignals === 0
        && proseNarrativeSignals < 2) {
      scores.creative = Math.min(scores.creative, 1.2);
    }
    // 전략 보고서 안의 사례 방문·상품 리뷰는 분석 근거이지 문서 전체의
    // 후기 장르가 아니다. 구조와 공식 서술이 우세할 때 보고서를 우선한다.
    if (formatProfile.headingCount >= 2 && formalExpositionRatio >= 0.4) {
      scores.review_blog = Math.min(scores.review_blog, 3.2);
    }
  }

  const formalAnalyticalArgumentFrame = compactLength >= 280
    && formalExpositionRatio >= 0.45
    && firstPersonSignals === 0
    && marketingActionSignals === 0
    && promotionSignals <= 1
    && bookReflectionSignals < 3
    && (legalDutySignals + formalNormativeConceptSignals + explainerConceptSignals) >= 4;
  if (formalAnalyticalArgumentFrame) {
    scores.report_assignment += 3.35;
    scores.long_explainer += 2.25;
    scores.marketing = Math.min(scores.marketing, 0.9);
  }

  const adaptationAnalysisSignals = count(
    text,
    /(?:OSMU|원작(?:이|은|을|의)?|영상화|매체로\s*확장|매체\s*전환|각색|서사(?:가|를|의)?\s*(?:재구성|변형|축소|확장)|웹소설|웹툰[^.!?\n]{0,35}(?:영화|드라마|영상)|같은\s*원작[^.!?\n]{0,45}(?:비교|영상))/giu
  );
  if (adaptationAnalysisSignals >= 3
      && literaryAnalysisSignals >= 4
      && (reportInquirySignals >= 1 || /(?:탐구|분석|비교)/u.test(text))) {
    scores.report_assignment += 4.25
      + Math.min(adaptationAnalysisSignals - 3, 5) * 0.16;
    scores.long_explainer += 2.5;
    if (!formatProfile.flags.includes('line_sensitive')) scores.creative = Math.min(scores.creative, 1.1);
  }

  const learningPortfolioSignals = count(
    text,
    /(?:진로와\s*관련된\s*(?:영어|학습)\s*공부\s*방향|교과서\s*(?:발표|지문|분석)|지문을\s*선택한\s*이유|지문\s*분석\s*내용|발표\s*후\s*(?:변화|발전)|교과서\s*외에|수행\s*평가\s*소개|참고할\s*만한\s*멘트|공통\s*영어|수업\s*시간에는[^.!?\n]{0,60}(?:참여|학습))/gu
  );
  if (learningPortfolioSignals >= 3 && applicationIntentSignals === 0 && applicationSectionSignals === 0) {
    scores.student_self_assessment += 4.2
      + Math.min(learningPortfolioSignals - 3, 6) * 0.18;
    scores.report_assignment += 2.2;
    scores.resume_application = Math.min(scores.resume_application, 1.4);
  }

  if (bookReflectionSignals >= 3
      && (firstPersonSignals >= 1 || bookReflectionSignals >= 5)
      && academicFramingSignals <= 1
      && (formatProfile.referenceLineCount || 0) < 3) {
    scores.personal_essay += 3.9
      + Math.min(bookReflectionSignals - 3, 5) * 0.2;
    scores.academic_paper = Math.min(scores.academic_paper, 1.1);
  }

  if (compactLength >= 800
      && sentences.length >= 7
      && firstPersonSignals <= 2
      && personalReflectionSignals <= 1
      && reviewContentSignals === 0
      && reviewEndingSignals === 0
      && explainerConceptSignals >= 4
      && formalExpositionRatio >= 0.45) {
    scores.long_explainer += 2.45
      + Math.min(explainerConceptSignals - 4, 6) * 0.16
      + (compactLength >= 2000 ? 0.45 : 0);
  }
  if (compactLength >= 1600
      && sentences.length >= 15
      && reviewContentSignals === 0
      && reviewEndingSignals === 0
      && explainerConceptSignals >= 7
      && formalExpositionRatio >= 0.5) {
    scores.long_explainer += 3.15
      + Math.min(explainerConceptSignals - 7, 6) * 0.12;
  }
  if (compactLength > 100 && sentences.length >= 3) scores.general += 1.35;
  if (compactLength >= 1500 && sentences.length >= 10) scores.general += 0.38;
  if (compactLength <= 100 && lines.length <= 2) scores.general += 0.55;

  const ranked = CONTENT_GENRES
    .filter(profile => profile !== 'unknown')
    .map(profile => ({ profile, score: scores[profile] }))
    .sort((a, b) => b.score - a.score || a.profile.localeCompare(b.profile));
  const rankedGroups = rankProfileGroups(ranked);
  const topGroup = rankedGroups[0] || { group: 'unknown', score: 0, profiles: [] };
  const secondGroup = rankedGroups[1] || { group: 'unknown', score: 0, profiles: [] };
  const top = topGroup.profiles[0] || ranked[0] || { profile: 'unknown', score: 0 };
  const second = ranked.find(item => item.profile !== top.profile) || { profile: 'unknown', score: 0 };
  const groupConfidence = calibrateConfidence(topGroup.score, secondGroup.score, compactLength);
  const fineConfidence = calibrateConfidence(top.score, second.score, compactLength);
  const confidence = topGroup.group === 'academic_report_explainer'
    ? groupConfidence
    : Math.min(groupConfidence, fineConfidence);
  const profile = confidence < 0.55 ? 'unknown' : top.profile;
  const profileDecisionSource = confidence < 0.55 ? 'low_confidence_preserve' : 'content_only';
  const safetyProfiles = buildSafetyProfiles({
    profile,
    ranked,
    questionnaire,
    nominalObservationEndings,
    observationSignals,
    reflectionSignals,
    formatProfile,
    strongCreativeSignals
  });
  const riskFlags = detectRiskFlags(text, {
    profile,
    safetyProfiles,
    questionnaire,
    formatProfile,
    firstPersonSignals,
    commercialSignals
  });
  const candidateProfiles = ranked.slice(0, 5).map(item => ({
    profile: item.profile,
    score: round(item.score, 3),
    sensitive: SENSITIVE_PROFILES.has(item.profile)
  }));

  return {
    profile,
    contentGenre: profile,
    confidence: round(confidence, 4),
    group: PROFILE_GROUPS[profile] || 'unknown',
    source: profileDecisionSource,
    profileDecisionSource,
    basicStyle: normalizeBasicStyle(basicStyle),
    ...resolveRegisterPolicy({ profile, basicStyle, requestStrength: 'basic' }),
    candidateProfiles,
    candidateGroups: rankedGroups.slice(0, 5).map(item => ({
      group: item.group,
      score: round(item.score, 3),
      profiles: item.profiles.slice(0, 3).map(profileItem => profileItem.profile)
    })),
    // v1 소비자와 로컬 분석 스크립트의 호환 필드다.
    candidates: candidateProfiles,
    safetyProfiles,
    profileMargin: round(Math.max(0, top.score - second.score), 3),
    profileGroupMargin: round(Math.max(0, topGroup.score - secondGroup.score), 3),
    formatProfile,
    riskFlags,
    signals: {
      compactLength,
      lineCount: lines.length,
      sentenceCount: sentences.length,
      headingCount: formatProfile.headingCount,
      nominalObservationEndings,
      observationSignals,
      explicitStudentRecordAnchorSignals,
      technicalCatalogLabelSignals,
      reflectionSignals,
      selfAssessmentActionSignals,
      selfReflectivePredicateSignals,
      reflectiveActivitySignals,
      educationSignals,
      learningLogSignals,
      topicSelectionSignals,
      selfAssessmentSectionSignals,
      explicitReflectionDocumentSignals,
      appliedLearningJournalLabelSignals,
      appliedLearningJournalWeekSignals,
      firstPersonAppliedLearningSignals,
      appliedLearningJournalFrame,
      reportInquirySignals,
      reportMethodSignals,
      inlineAcademicCitationSignals,
      academicMethodEvidenceSignals,
      academicFormalEndingRatio: round(academicFormalEndingRatio, 4),
      academicAbstractFrame,
      academicExcerptFrame,
      reportHeadingSignals,
      assignmentProblemHeadingSignals,
      structuredCareerPlanSignals,
      orderedArgumentSignals,
      explicitAssignmentWritingFrame,
      analyticalFrameworkSignals,
      applicationIntentSignals,
      directApplicationContextSignals,
      programApplicationSignals,
      instructionalPlanSignals,
      bulletLineCount,
      questionCount: questionnaire.questionCount,
      numberedQuestionCount: questionnaire.numberedQuestionCount,
      answerBlockCount: questionnaire.answerBlockCount,
      educationQuestionCount: questionnaire.educationQuestionCount,
      assessmentItem: assessment.isAssessmentItem,
      assessmentProtectedLineCount: assessment.protectedLineCount,
      assessmentExplanationLineCount: assessment.explanationLineCount,
      applicationValuePropositionSignals,
      careerAspirationSignals,
      researchCareerContextSignals,
      applicationSectionSignals,
      professionalPastEndingSignals,
      technicalCareerDeliverableSignals,
      professionalResponsibilitySignals,
      technicalCareerFrame,
      fundingPlanSignals,
      strengthWeaknessSignals,
      qualificationSignals,
      researchPlacementSignals,
      applicationEvidenceSignals,
      futureContributionSignals,
      formalNormativeConceptSignals,
      formalNormativeOperatorSignals,
      shortFormalArgumentSignals,
      legalArticleSignals,
      legalPartySignals,
      legalDutySignals,
      legalOperatorSignals,
      commercialSignals,
      soapHeadingSignals,
      clinicalLabelSignals,
      clinicalTermSignals,
      clinicalAssessmentSignals,
      psychologicalAssessmentSignals,
      psychologicalInterpretationSignals,
      clinicalDomainSignals,
      clinicalObservationEndingSignals,
      researchDesignSignals,
      reviewExperienceSignals,
      explicitReviewSignals,
      reviewOpinionSignals,
      reviewPhotoSignals,
      mailLexicalSignals,
      applicationLetterFrame,
      officialRoleSignals,
      signatureDateLines,
      signatureInstitutionLines,
      literaryAnalysisSignals,
      literaryInterpretationSignals,
      literaryAnalysisFrame,
      literaryReflectionFrame,
      structuredProposalHeadingSignals,
      structuredProposalBodySignals,
      structuredProposalFrame,
      teacherObservationSubjectSignals,
      formalAnalyticalArgumentFrame,
      adaptationAnalysisSignals,
      learningPortfolioSignals,
      bookReflectionSignals,
      explainerConceptSignals,
      formalExpositionRatio: round(formalExpositionRatio, 4)
    }
  };
}

function rankProfileGroups(rankedProfiles) {
  const grouped = new Map();
  for (const item of rankedProfiles) {
    const group = PROFILE_GROUPS[item.profile] || item.profile;
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group).push(item);
  }
  return [...grouped.entries()].map(([group, profiles]) => {
    const ordered = [...profiles].sort((a, b) => b.score - a.score || a.profile.localeCompare(b.profile));
    const [primary, ...supporting] = ordered;
    // 같은 목적의 부분 단서가 academic/report/long-explainer처럼 서로 다른
    // 세부 프로필에 나뉘어도 일반문 기본점수에 지지 않도록 장르군에서 합친다.
    const supportingEvidence = supporting.reduce((sum, item) => sum + Math.min(3, Math.max(0, item.score)), 0);
    // 학술군의 약한 낱말 점수 세 개를 합쳐 개별 장르 1위를 뒤집지 않는다.
    // 적어도 한 세부 프로필이 독립적인 장르 증거(1.7점)를 가진 경우에만
    // 기존 집계 가중치를 적용하고, 그 미만은 애매한 보조 증거로 축소한다.
    const supportWeight = group === 'academic_report_explainer'
      ? ((primary?.score || 0) >= 1.7 ? 0.65 : 0.35)
      : 0;
    return {
      group,
      score: (primary?.score || 0) + supportingEvidence * supportWeight,
      profiles: ordered
    };
  }).sort((a, b) => b.score - a.score || a.group.localeCompare(b.group));
}

// 명시적 장르 선택은 분류기를 대체하는 정답지가 아니라, 애매한 문서의 동률 해소 신호다.
// 고신뢰 원문 판정은 그대로 두고, 어떤 경우에도 원래 감지된 민감 장르의 보존 규칙은 버리지 않는다.
function applyDocumentProfileOverride(detected, requestedProfile) {
  const base = detected && typeof detected === 'object' ? detected : {};
  const requested = String(requestedProfile || '').trim().toLowerCase();
  const detectedProfile = CONTENT_GENRES.includes(base.profile) ? base.profile : 'unknown';
  const detectedConfidence = Number.isFinite(Number(base.confidence)) ? Number(base.confidence) : 0;
  const common = {
    ...base,
    detectedProfile,
    detectedProfileConfidence: round(detectedConfidence, 4),
    requestedDocumentProfile: CONTENT_GENRES.includes(requested) ? requested : '',
    profileOverrideApplied: false
  };
  if (!requested || !CONTENT_GENRES.includes(requested) || requested === 'unknown') return common;
  if (detectedConfidence >= 0.75) {
    const detectedGroup = PROFILE_GROUPS[detectedProfile] || detectedProfile;
    const requestedGroup = PROFILE_GROUPS[requested] || requested;
    if (detectedGroup === requestedGroup) {
      const safetyProfiles = [...new Set([
        ...(Array.isArray(base.safetyProfiles) ? base.safetyProfiles : []),
        ...(SENSITIVE_PROFILES.has(detectedProfile) ? [detectedProfile] : []),
        ...(SENSITIVE_PROFILES.has(requested) ? [requested] : [])
      ])].filter(profile => CONTENT_GENRES.includes(profile));
      return {
        ...common,
        profile: requested,
        contentGenre: requested,
        group: requestedGroup,
        source: 'user_same_group_override',
        profileDecisionSource: 'user_same_group_override',
        safetyProfiles,
        profileOverrideApplied: requested !== detectedProfile,
        profileOverrideIgnoredReason: ''
      };
    }
    return {
      ...common,
      profileDecisionSource: base.profileDecisionSource || base.source || 'content_only',
      profileOverrideIgnoredReason: 'high_confidence_content'
    };
  }
  const safetyProfiles = [...new Set([
    ...(Array.isArray(base.safetyProfiles) ? base.safetyProfiles : []),
    ...(SENSITIVE_PROFILES.has(detectedProfile) ? [detectedProfile] : []),
    ...(SENSITIVE_PROFILES.has(requested) ? [requested] : [])
  ])].filter(profile => CONTENT_GENRES.includes(profile));
  return {
    ...common,
    profile: requested,
    contentGenre: requested,
    group: PROFILE_GROUPS[requested] || 'unknown',
    source: 'user_override',
    profileDecisionSource: 'user_override',
    safetyProfiles,
    profileOverrideApplied: true,
    profileOverrideIgnoredReason: ''
  };
}

function applyTargetRegister(documentProfile, { requestStrength = 'basic', basicStyle = '' } = {}) {
  const profile = documentProfile && typeof documentProfile === 'object' ? documentProfile : {};
  return {
    ...profile,
    ...resolveRegisterPolicy({
      profile: profile.profile || 'unknown',
      basicStyle: basicStyle || profile.basicStyle || '',
      requestStrength
    })
  };
}

function detectQuestionnaire(lines) {
  const questionIndexes = [];
  let numberedQuestionCount = 0;
  let educationQuestionCount = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index] || '').trim();
    if (!isQuestionLike(line)) continue;
    questionIndexes.push(index);
    if (isNumberedLine(line)) numberedQuestionCount += 1;
    if (/(?:수업|학습|교과|과제|활동|탐구|발표|수행|모둠|진로|역량|협업|학교|배운\s*점|느낀\s*점|역할|노력)/u.test(line)) {
      educationQuestionCount += 1;
    }
  }
  const questionCount = questionIndexes.length;
  const isQuestionnaire = questionCount >= 3
    && (numberedQuestionCount >= 3 || questionCount / Math.max(1, lines.length) >= 0.3);
  let answerBlockCount = 0;
  if (isQuestionnaire) {
    for (let position = 0; position < questionIndexes.length; position += 1) {
      const start = questionIndexes[position] + 1;
      const end = questionIndexes[position + 1] ?? lines.length;
      if (lines.slice(start, end).some(Boolean)) answerBlockCount += 1;
    }
  }
  return {
    isQuestionnaire,
    questionCount,
    numberedQuestionCount,
    educationQuestionCount,
    answerBlockCount
  };
}

function detectAssessmentItem(lines) {
  const source = Array.isArray(lines) ? lines.map(line => String(line || '').trim()).filter(Boolean) : [];
  const headerCount = source.filter(line => /^(?:[\[【]\s*)?(?:듣기|읽기|말하기|쓰기|어휘|문법|수능|모의|평가|시험)?\s*(?:평가\s*)?(?:문항|문제|지문)(?:\s*[\]】])?$/u.test(line)).length;
  const answerHeaderCount = source.filter(line => /^(?:(?:[\[【]\s*)?(?:정답|답|해설|풀이)(?:\s*[\]】])?)(?:\s*[:：]\s*|\s+|$)/u.test(line)).length;
  const choiceLineCount = source.filter(line => /^(?:[①-⑳]|[㉠-㉿]|\(?[1-5]\)?[.)])\s*\S/u.test(line)).length;
  const dialogueLineCount = source.filter(line => /^(?:남자?|여자?|학생|교사|선생님|A|B|M|W)\s*[:：]\s*\S/iu.test(line)).length;
  const promptLineCount = source.filter(line => /^(?:다음|위|아래)(?:의|\s)[^.!?。！？]{0,80}(?:고르|찾으|답하|쓰시|서술|설명|알맞|옳|적절|일치|틀린)/u.test(line)).length;
  const isAssessmentItem = (headerCount + answerHeaderCount >= 1)
    && (choiceLineCount >= 2 || dialogueLineCount >= 2 || promptLineCount >= 1);
  let inExplanation = false;
  let afterAnswerHeader = false;
  let answerKeySeen = false;
  let protectedLineCount = 0;
  let explanationLineCount = 0;
  if (isAssessmentItem) {
    for (const line of source) {
      if (assessmentAnswerHeaderLine(line)) {
        afterAnswerHeader = true;
        answerKeySeen = false;
        inExplanation = false;
        protectedLineCount += 1;
        continue;
      }
      const explanation = assessmentExplanationLineParts(line);
      if (explanation) {
        inExplanation = true;
        afterAnswerHeader = false;
        protectedLineCount += 1;
        if (explanation.body) explanationLineCount += 1;
        continue;
      }
      if (afterAnswerHeader && assessmentAnswerKeyLine(line)) {
        answerKeySeen = true;
        protectedLineCount += 1;
        continue;
      }
      if (afterAnswerHeader && answerKeySeen && assessmentInferredExplanationParts(line)) {
        inExplanation = true;
        afterAnswerHeader = false;
        protectedLineCount += 1;
        if (assessmentInferredExplanationParts(line).body) explanationLineCount += 1;
        continue;
      }
      if (afterAnswerHeader && answerKeySeen && isAssessmentExplanationProse(line)) {
        inExplanation = true;
        afterAnswerHeader = false;
      }
      if (inExplanation) explanationLineCount += 1;
      else protectedLineCount += 1;
    }
  }
  return {
    isAssessmentItem,
    headerCount,
    answerHeaderCount,
    choiceLineCount,
    dialogueLineCount,
    promptLineCount,
    protectedLineCount,
    explanationLineCount
  };
}

function assessmentExplanationLineParts(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(?:(?:[\[【]\s*)?(?:해설|풀이)(?:\s*[\]】])?)(?:\s*[:：]\s*|\s+|$)(.*)$/u);
  if (!match) return null;
  return { body: String(match[1] || '').trim() };
}

function assessmentAnswerHeaderLine(value) {
  return /^(?:(?:[\[【]\s*)?(?:정답|답)(?:\s*[\]】])?)(?:\s*[:：]\s*|\s+|$)/u.test(String(value || '').trim());
}

function assessmentAnswerKeyLine(value) {
  const text = String(value || '').trim();
  return /^(?:\d{1,3}[.)]\s*(?:[①-⑳]|[A-E]|[가-마])\s*)+$/u.test(text)
    || /^(?:정답\s*)?(?:[①-⑳]|[A-E]|[가-마])(?:\s*[,/]\s*(?:[①-⑳]|[A-E]|[가-마]))*$/u.test(text);
}

function assessmentInferredExplanationParts(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{1,3}[.)])(?:\s+([\s\S]+))?$/u);
  if (!match) return null;
  return { prefix: match[1], body: String(match[2] || '').trim() };
}

function isAssessmentExplanationProse(value) {
  const text = String(value || '').trim();
  return text.length >= 24 && /[.!?。！？]$/u.test(text);
}

function detectFormatProfile(text, lines, sentences, questionnaire, assessment = null) {
  const compactLength = String(text || '').replace(/\s+/gu, '').length;
  const length = compactLength <= 100 ? 'short' : (compactLength >= 1500 ? 'long' : 'standard');
  const layout = layoutStructure.analyzeLineStructure(text);
  const headingCountValue = lines.filter(line => !(questionnaire.isQuestionnaire && isQuestionLike(line))
    && layoutStructure.isKnownHeadingLine(line)).length;
  const listItemCount = Math.max(lines.filter(isListLine).length, layout.listLineCount || 0);
  const tableLineCount = layout.tableLineCount || 0;
  const labelLineCount = layout.labelLineCount || 0;
  const referenceLineCount = lines.filter(line => /(?:doi\s*:|https?:\/\/|\((?:19|20)\d{2}(?:[a-z]|\s*\.\s*\d{1,2}(?:\s*\.\s*\d{1,2})?\s*\.?)?\)|참고\s*문헌|References|Bibliography)/iu.test(line)).length;
  const quoteLineCount = lines.filter(line => /^(?:>|[“"'‘「『《〈])/u.test(line) || /(?:[“"][^”"\n]{2,}[”"]|「[^」\n]{2,}」|『[^』\n]{2,}』|《[^》\n]{2,}》|〈[^〉\n]{2,}〉)/u.test(line)).length;
  const markdownQuoteLines = lines.filter(line => /^>\s*\S/u.test(line));
  const blockquoteOutsideLines = lines.filter(line => !/^>\s*\S/u.test(line));
  const blockquoteBody = markdownQuoteLines.map(line => line.replace(/^>\s*/u, '')).join('\n');
  // ChatGPT·게시판·문서 편집기에서 편지나 자기 서술 전체가 Markdown
  // blockquote로 감싸져 들어오는 경우다. 문서 바깥 행은 제목뿐이고,
  // 본문에 실제 작성자 발화 신호가 있을 때만 인용이 아닌 표시 래퍼로
  // 판단한다. 일반 인용문과 논문 인용 블록은 계속 원문 그대로 잠긴다.
  const editableBlockquoteWrapper = markdownQuoteLines.length >= 2
    && compactLength >= 120
    && blockquoteOutsideLines.every(line => layoutStructure.isKnownHeadingLine(line))
    && /(?:안녕하세요|드립니다|부탁드|감사합니다|저는|제가|저희|생각합니다|바랍니다|약속드립니다|선생님)/u.test(blockquoteBody);
  const appendixPresent = lines.some(line => /^(?:부록|Appendix)(?:\s|$)/iu.test(line));
  const poemLikeLines = lines.filter(line => line.length <= 40 && !/[.!?。！？]$/u.test(line)).length;
  const assessmentItem = assessment?.isAssessmentItem === true;
  const lineSensitive = questionnaire.isQuestionnaire
    || assessmentItem
    || editableBlockquoteWrapper
    || (tableLineCount < 2
      && listItemCount < 3
      && labelLineCount < 2
      && headingCountValue < 2
      && lines.length >= 4
      && poemLikeLines / lines.length >= 0.6
      && median(lines.map(line => line.length)) <= 36);
  const flags = [];
  if (headingCountValue >= 2) flags.push('sectioned');
  if (questionnaire.isQuestionnaire) flags.push('questionnaire');
  if (assessmentItem) flags.push('assessment_item');
  if (listItemCount >= 3 && listItemCount / Math.max(1, lines.length) >= 0.3) flags.push('list_heavy');
  if (tableLineCount >= 2) flags.push('table_heavy');
  if (labelLineCount >= 2) flags.push('label_heavy');
  if (referenceLineCount >= 3) flags.push('reference_heavy');
  if (lineSensitive) flags.push('line_sensitive');
  if (quoteLineCount >= 2) flags.push('quote_sensitive');
  if (editableBlockquoteWrapper) flags.push('editable_blockquote_wrapper');
  if (appendixPresent) flags.push('appendix_present');
  const primary = ['assessment_item', 'questionnaire', 'table_heavy', 'reference_heavy', 'list_heavy', 'label_heavy', 'sectioned', 'line_sensitive']
    .find(flag => flags.includes(flag)) || 'plain';
  return {
    length,
    primary,
    flags,
    compactLength,
    lineCount: lines.length,
    sentenceCount: sentences.length,
    headingCount: headingCountValue,
    listItemCount,
    tableLineCount,
    labelLineCount,
    structuralBoundaryCount: layout.preservedBoundaryCount || 0,
    referenceLineCount,
    quoteLineCount,
    editableBlockquoteWrapper,
    signatureLineCount: layout.signatureLineCount || 0,
    assessmentProtectedLineCount: Number(assessment?.protectedLineCount || 0),
    assessmentExplanationLineCount: Number(assessment?.explanationLineCount || 0),
    appendixPresent
  };
}

function detectRiskFlags(text, {
  profile,
  safetyProfiles,
  questionnaire,
  formatProfile,
  firstPersonSignals,
  commercialSignals = null
}) {
  const flags = [];
  // 목록·질문 번호는 사실 수치가 아니므로 위험 밀도에서 제외한다.
  const factualText = String(text || '').split(/\r?\n/u)
    .map(line => line.replace(/^\s*(?:\d{1,3}[.)]|\d{1,3}(?:\.\d+)+[.)]?|[①②③④⑤⑥⑦⑧⑨⑩]|[-*•▪◦])\s+/u, ''))
    .join('\n');
  const numberCount = count(factualText, /(?:^|[^A-Za-z0-9_])[-+]?\d+(?:[.,]\d+)*(?:%|％|명|개|건|원|년|월|일|점|배|시간|분)?(?=$|[^A-Za-z0-9_])/gu);
  const institutionCount = count(text, /[가-힣A-Za-z0-9·&()]{2,30}(?:대학교|대학|학교|연구원|연구소|기관|협회|공사|재단|위원회|병원|기업|회사)/gu);
  const citationCount = count(text, /(?:\([가-힣A-Za-z·,&\s]+,?\s*(?:19|20)\d{2}[a-z]?\)|\((?:19|20)\d{2}(?:\s*\.\s*\d{1,2}(?:\s*\.\s*\d{1,2})?\s*\.?)?\)|doi\s*:|https?:\/\/|참고\s*문헌|References)/giu);
  const experienceActionCount = count(text, /(?:참여|방문|사용해\s*보|다녀왔|맡은\s*역할|느꼈|배웠|깨달|근무|프로젝트|직접\s*(?:조사|분석|제작|작성|수행))/gu);
  const contextualExperienceCount = splitSentences(text, { preserveLines: false }).filter(sentence => {
    const value = String(sentence || '');
    const pov = computePovSeed(value);
    const hasContext = pov.fp_singular > 0
      || /(?:당시|직접|경험을\s*통해|아르바이트)/u.test(value);
    return hasContext
      && /(?:참여|방문|사용|수행|조사|분석|제작|발표|근무|느꼈|배웠|깨달|맡)/u.test(value);
  }).length;
  const evaluationCount = count(text, /(?:평가|성취|역량|우수|뛰어|돋보|부족|개선|성장|기여|책임감)/gu);
  const deadlineActionCount = count(text, /(?:마감|기한|까지\s*(?:제출|신청|회신)|신청|제출|회신|문의|참석|입금)/gu);
  const factCount = numberCount + institutionCount + citationCount + (formatProfile.quoteLineCount || 0);
  if (factCount >= 8) flags.push('fact_dense');
  if (numberCount >= 4) flags.push('number_dense');
  if (institutionCount >= 2) flags.push('institution_dense');
  if (citationCount >= 3 || formatProfile.flags.includes('reference_heavy')) flags.push('citation_dense');
  if (firstPersonSignals > 0
      || ['student_record_teacher', 'student_self_assessment', 'resume_application', 'clinical_record', 'creative'].includes(profile)
      || safetyProfiles.some(item => ['student_record_teacher', 'student_self_assessment', 'resume_application', 'clinical_record', 'creative'].includes(item))) {
    flags.push('pov_sensitive');
  }
  if (contextualExperienceCount >= 1
      || (firstPersonSignals > 0 && experienceActionCount >= 2)
      || safetyProfiles.includes('student_self_assessment')
      || profile === 'resume_application') flags.push('experience_claim');
  if (evaluationCount >= 2 || safetyProfiles.includes('student_record_teacher') || safetyProfiles.includes('student_self_assessment')) flags.push('evaluation_claim');
  for (const flag of commercialSignalPolicy.riskFlagsFromSignals(commercialSignals, { profile })) {
    if (!flags.includes(flag)) flags.push(flag);
  }
  if (deadlineActionCount >= 2 || profile === 'mail_notice') flags.push('deadline_action_sensitive');
  if (profile === 'legal_contract' || safetyProfiles.includes('legal_contract')) flags.push('legal_operator_sensitive');
  if (profile === 'clinical_record' || safetyProfiles.includes('clinical_record')) flags.push('clinical_fact_sensitive');
  if (questionnaire.isQuestionnaire) flags.push('questionnaire_answer_boundary');
  return flags;
}

function buildSafetyProfiles({ profile, ranked, questionnaire, nominalObservationEndings, observationSignals, reflectionSignals, formatProfile, strongCreativeSignals = 0 }) {
  const topScore = ranked[0]?.score || 0;
  const threshold = Math.max(0.9, topScore * 0.28);
  const safety = new Set();
  const minimumScore = {
    academic_paper: 1.3,
    report_assignment: 1.7,
    clinical_record: 4.8,
    legal_contract: 4.8,
    student_record_teacher: 1.35,
    student_self_assessment: 1.4,
    resume_application: 1.35,
    creative: 2.2
  };
  for (const item of ranked) {
    if (!SENSITIVE_PROFILES.has(item.profile) || item.score <= 0) continue;
    const required = minimumScore[item.profile] || 0;
    const creativeFormatEvidence = item.profile === 'creative'
      && (formatProfile.flags.includes('line_sensitive') || strongCreativeSignals >= 2);
    if (item.score < required && !creativeFormatEvidence) continue;
    if (item.profile === profile || topScore - item.score <= threshold) safety.add(item.profile);
  }
  if (nominalObservationEndings >= 2 && observationSignals >= 2) safety.add('student_record_teacher');
  if (questionnaire.isQuestionnaire && (questionnaire.educationQuestionCount >= 2 || reflectionSignals >= 2)) {
    safety.add('student_self_assessment');
  }
  if (formatProfile.flags.includes('line_sensitive') && profile === 'creative') safety.add('creative');
  if (profile === 'legal_contract') safety.add('legal_contract');
  if (profile === 'clinical_record') safety.add('clinical_record');
  return [...safety];
}

function hasStudentRecordEnding(sentence) {
  const value = String(sentence || '').replace(/[.!?…。！？"'”’」』】)\]]+$/gu, '').trim();
  return /(?:함|됨|임|음|보임|지님|돋보임|뛰어남|기름|나감|시킴|갖춤|보여\s*줌)$/u.test(value);
}

function normalizeBasicStyle(value) {
  const style = String(value || '').trim().toLowerCase();
  return style === 'blog' || style === 'report' ? style : '';
}

function resolveRegisterPolicy({ profile = 'unknown', basicStyle = '', requestStrength = 'basic' } = {}) {
  const genre = String(profile || 'unknown');
  const style = normalizeBasicStyle(basicStyle);
  const strength = String(requestStrength || 'basic');
  let targetRegister = 'source_preserve';
  let targetRegisterSource = 'source';

  if (['academic_paper', 'report_assignment', 'long_explainer'].includes(genre)) {
    targetRegister = 'academic_formal';
    targetRegisterSource = 'document_profile';
  } else if (genre === 'clinical_record') {
    targetRegister = 'clinical_formal';
    targetRegisterSource = 'document_profile';
  } else if (genre === 'legal_contract') {
    targetRegister = 'legal_formal';
    targetRegisterSource = 'document_profile';
  } else if (genre === 'student_record_teacher') {
    targetRegister = 'record_formal';
    targetRegisterSource = 'document_profile';
  } else if (genre === 'student_self_assessment') {
    targetRegister = 'student_formal';
    targetRegisterSource = 'document_profile';
  } else if (genre === 'resume_application') {
    targetRegister = 'professional';
    targetRegisterSource = 'document_profile';
  } else if (genre === 'mail_notice') {
    targetRegister = 'functional_formal';
    targetRegisterSource = 'document_profile';
  } else if (genre === 'creative') {
    targetRegister = 'creative_preserve';
    targetRegisterSource = 'document_profile';
  } else if (['review_blog', 'social'].includes(genre)) {
    targetRegister = 'conversational';
    targetRegisterSource = 'document_profile';
  } else if (genre === 'personal_essay' && style === 'blog') {
    targetRegister = 'conversational';
    targetRegisterSource = 'basic_style';
  } else if (['general', 'unknown', 'marketing', 'personal_essay'].includes(genre) && style) {
    targetRegister = style === 'report' ? 'formal' : 'conversational';
    targetRegisterSource = 'basic_style';
  }

  const formalTargets = new Set([
    'academic_formal', 'clinical_formal', 'legal_formal', 'record_formal', 'student_formal', 'professional', 'functional_formal', 'formal'
  ]);
  return {
    targetRegister,
    targetRegisterSource,
    targetRegisterStrength: strength === 'advanced' ? 'advanced' : (strength === 'polish' ? 'polish' : 'basic'),
    // tonePolicy는 기존 소비자 호환 필드다. 장르 하한이 있는 문서는 더 이상
    // basicStyle=blog 때문에 conversational로 내려가지 않는다.
    tonePolicy: targetRegister === 'conversational'
      ? 'conversational'
      : (formalTargets.has(targetRegister) ? 'formal' : 'source_preserve')
  };
}

function calibrateConfidence(top, second, compactLength) {
  if (top <= 0) return 0.3;
  const strength = Math.min(1, top / 4.2);
  const margin = Math.min(1, Math.max(0, (top - second) / Math.max(top, 1)));
  let value = 0.35 + strength * 0.48 + margin * 0.16;
  if (compactLength < 60 && top < 2.5) value -= 0.12;
  return Math.max(0.3, Math.min(0.99, value));
}

function isQuestionLike(line) {
  const value = String(line || '').trim();
  return /[?？]\s*$/u.test(value)
    || /(?:무엇|어떻게|어떠했|왜|어떤|얼마나|서술(?:하시오|하세요)?|작성(?:하시오|하세요)?|설명(?:하시오|하세요)?|적어\s*(?:보세요|주세요)|말해\s*(?:보세요|주세요)|기술(?:하시오|하세요)?)(?:[?.？]|\s*$)/u.test(value);
}

function isNumberedLine(line) {
  return /^(?:\d{1,2}[.)]|[①②③④⑤⑥⑦⑧⑨⑩])\s*/u.test(String(line || '').trim());
}

function isListLine(line) {
  return /^(?:[-*+•▪◦·●○■□◆◇▶▷※]|\d+(?:[-.]\d+)*[.)]|[가-힣][.)]|[①-⑳])\s+/u.test(String(line || '').trim());
}

function count(text, regex) {
  return (String(text || '').match(regex) || []).length;
}

function add(scores, profile, occurrences, weight) {
  scores[profile] += Math.min(occurrences, 8) * weight;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value, digits) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

module.exports = {
  CONTENT_GENRES,
  DOCUMENT_PROFILES,
  PROFILE_GROUPS,
  detectDocumentProfile,
  applyDocumentProfileOverride,
  applyTargetRegister,
  resolveRegisterPolicy,
  detectQuestionnaire,
  detectAssessmentItem,
  assessmentExplanationLineParts,
  assessmentAnswerHeaderLine,
  assessmentAnswerKeyLine,
  assessmentInferredExplanationParts,
  detectFormatProfile
};
