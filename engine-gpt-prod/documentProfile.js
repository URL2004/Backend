'use strict';

const { splitSentences } = require('../engine/koreanText');
const layoutStructure = require('./layoutStructure');

const CONTENT_GENRES = Object.freeze([
  'academic_paper',
  'report_assignment',
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
  const formatProfile = detectFormatProfile(text, lines, sentences, questionnaire);
  const scores = Object.fromEntries(CONTENT_GENRES.map(profile => [profile, 0]));
  const firstPersonSignals = count(text, /(?:^|[^가-힣A-Za-z0-9_])(?:나는|내가|나의|저는|제가|저의|저에게)(?=$|[^가-힣A-Za-z0-9_])/gu);

  add(scores, 'academic_paper', count(text, /(?:초록|Abstract|연구\s*(?:목적|방법|결과|가설)|선행\s*연구|방법론|유의확률|참고\s*문헌|doi\s*:|KCI|RISS)/giu), 1.3);
  add(scores, 'academic_paper', count(text, /\([가-힣A-Za-z·,&\s]+,?\s*(?:19|20)\d{2}[a-z]?\)/gu), 0.9);
  add(scores, 'academic_paper', count(text, /(?:p|t|F|β|R²)\s*[<=>]\s*-?\d+(?:\.\d+)?/gu), 1.2);
  const academicFramingSignals = count(text, /(?:본\s*연구(?:는|에서는|의)|이론적\s*배경|연구\s*(?:가설|문제|과제|한계)|향후\s*연구|실증적으로\s*분석|모형화|방법론)/gu);
  const academicSectionSignals = lines.filter(line => /^(?:\d+(?:\.\d+)*[.)]?\s*)?(?:서론|이론적\s*배경|연구\s*(?:방법|결과|모형)|결론(?:\s*및\s*향후\s*연구)?|참고\s*문헌)/u.test(line)).length;
  if ((formatProfile.referenceLineCount || 0) >= 3 && academicFramingSignals >= 2 && academicSectionSignals >= 3) {
    scores.academic_paper += 6.5
      + Math.min(academicFramingSignals - 2, 4) * 0.22
      + Math.min(academicSectionSignals - 3, 4) * 0.18;
  }

  add(scores, 'report_assignment', count(text, /(?:서론|본론|결론|과제|보고서|목차|조사\s*결과|문제점|개선\s*방안|시사점)/gu), 0.85);
  add(scores, 'report_assignment', formatProfile.headingCount, 0.38);
  if ((formatProfile.labelLineCount || 0) >= 2 || (formatProfile.tableLineCount || 0) >= 2) {
    scores.report_assignment += 1.25;
  }

  add(scores, 'student_record_teacher', count(text, /(?:세부\s*능력\s*및\s*특기\s*사항|세특|생활\s*기록부|교과\s*활동|수업\s*중|발표함|탐구함|기여함|보여\s*줌|학생은)/gu), 1.35);
  add(scores, 'student_record_teacher', count(text, /(?:함|됨|임|음)\s*[.!?]?\s*(?=$|\n)/gmu), 0.25);
  const nominalObservationEndings = sentences.filter(hasStudentRecordEnding).length;
  const observationSignals = count(text, /(?:수업|활동|탐구|발표|참여|태도|역량|모습|성장|협력|책임감|돋보|뛰어남|보여\s*줌|기여)/gu);
  const nominalEndingRatio = nominalObservationEndings / Math.max(1, sentences.length);
  const bulletLineCount = lines.filter(line => /^(?:[-*•]|\d+(?:[-.]\d+)*[:.)])\s*/u.test(line)).length;
  const instructionalPlanSignals = count(text, /(?:예정임|계획임|수업을\s*(?:할|진행할)\s*예정|학습\s*목표|차시|교수\s*학습)/gu);
  const likelyInstructionPlan = bulletLineCount >= 2 && instructionalPlanSignals >= 2;
  if (nominalObservationEndings >= 2 && nominalEndingRatio >= 0.4 && observationSignals >= 2 && !likelyInstructionPlan) {
    scores.student_record_teacher += 1.1
      + Math.min(nominalObservationEndings, 6) * 0.45
      + Math.min(observationSignals, 5) * 0.18;
  }
  if (likelyInstructionPlan) scores.report_assignment += 1.4;

  const reflectionSignals = count(text, /(?:자기\s*평가|스스로\s*평가|배운\s*점|느낀\s*점|어려웠던\s*점|부족했던\s*점|노력한\s*점|맡은\s*역할|기여한\s*점|향후\s*계획|개선할\s*점)/gu);
  const educationSignals = count(text, /(?:수업|학습|교과|과제|활동|탐구|발표|수행|모둠|진로|역량|협업|학교)/gu);
  add(scores, 'student_self_assessment', count(text, /(?:학생\s*자기\s*평가|자기\s*성찰|활동\s*소감|수업\s*소감|학습\s*성찰)/gu), 1.4);
  add(scores, 'student_self_assessment', reflectionSignals, 0.58);
  if (questionnaire.isQuestionnaire && questionnaire.educationQuestionCount >= 2) {
    scores.student_self_assessment += 2.35
      + Math.min(questionnaire.questionCount, 10) * 0.18
      + Math.min(reflectionSignals, 5) * 0.28;
  } else if (educationSignals >= 3 && reflectionSignals >= 2) {
    scores.student_self_assessment += 1.35;
  }

  const explicitApplicationSignals = count(text, /(?:지원\s*동기|입사\s*후\s*포부|성장\s*과정|직무\s*역량|자기\s*소개서|자소서|저의\s*(?:강점|경험)|귀사|지원하게\s*되었습니다)/gu);
  const careerActionSignals = count(text, /(?:수집|정리|분석|비교|조사|기획|설계|운영|관리|지원|발표|협업|조율|응대|개선|제작|시각화|학습|연습|근무)/gu);
  const achievementSignals = count(text, /(?:합격|취득|등급|자격증|성과|역량|능력|강점|목표를\s*(?:달성|이뤄)|키웠|길렀|향상|보완|다졌|갖췄)/gu);
  const roleFitSignals = count(text, /(?:직무|실무|업무|입사|채용|지원서|지원\s*분야|회사|조직|고객|수강생|교육\s*운영|운영\s*지원|업무에\s*(?:활용|적용)|도움이\s*될|기여할)/gu);
  const experienceNarrativeSignals = count(text, /(?:당시|그\s*과정에서|이\s*과정에서|이\s*경험(?:은|을|으로|을\s*통해)|경험을\s*바탕으로|준비\s*기간|아르바이트|프로젝트)/gu);
  add(scores, 'resume_application', explicitApplicationSignals, 1.35);
  add(scores, 'resume_application', firstPersonSignals, 0.22);
  if (careerActionSignals >= 3 && achievementSignals >= 2 && roleFitSignals >= 2
      && (firstPersonSignals >= 1 || experienceNarrativeSignals >= 1)) {
    scores.resume_application += 2.15
      + Math.min(careerActionSignals - 3, 5) * 0.13
      + Math.min(achievementSignals - 2, 4) * 0.16
      + Math.min(roleFitSignals - 2, 3) * 0.18;
  } else if (explicitApplicationSignals >= 1 && careerActionSignals >= 2 && achievementSignals >= 1) {
    scores.resume_application += 1.15;
  }

  add(scores, 'review_blog', count(text, /(?:후기|리뷰|다녀왔|방문했|써봤|사용해\s*보|추천|맛집|내돈내산|오늘은|사진|솔직히)/gu), 0.8);
  add(scores, 'review_blog', count(text, /(?:해요|했어요|였어요|더라고요|거든요|네요|죠)[.!?~]?\s*(?=$|\n)/gmu), 0.24);

  const marketingActionSignals = count(text, /(?:지금\s*(?:바로|신청)|(?:신청|구매|예약|문의)\s*(?:하세요|해\s*주세요|바랍니다)|클릭(?:하세요|해\s*주세요)|놓치지\s*마세요)/gu);
  const promotionSignals = count(text, /(?:무료\s*(?:상담|체험)|한정\s*(?:수량|기간|판매)|특가|할인\s*(?:혜택|행사|쿠폰)|선착순|오늘만|마감\s*임박|\d{1,3}%\s*할인|원\s*할인)/gu);
  const commercialNounSignals = count(text, /(?:구매|가격|결제|상품|서비스|혜택|무료|₩|원)/gu);
  add(scores, 'marketing', marketingActionSignals, 1.15);
  add(scores, 'marketing', promotionSignals, 0.85);
  if ((marketingActionSignals >= 1 || promotionSignals >= 1) && commercialNounSignals >= 1) {
    scores.marketing += 1.05;
  }
  const researchDiscussionContext = (formatProfile.flags.includes('reference_heavy') || formatProfile.flags.includes('sectioned'))
    && academicFramingSignals >= 2;
  if (researchDiscussionContext && marketingActionSignals === 0) {
    scores.marketing = Math.min(scores.marketing, 0.9);
  }

  add(scores, 'social', count(text, /#[가-힣A-Za-z0-9_]+/gu), 0.7);
  add(scores, 'social', count(text, /[😀-🙏🌀-🫿❤♥✨🔥✅📌]/gu), 0.42);
  if (compactLength <= 450 && lines.length >= 3 && median(lines.map(line => line.length)) <= 35) scores.social += 1.2;

  add(scores, 'mail_notice', count(text, /(?:안녕하세요[,.]?|수신\s*:|발신\s*:|제목\s*:|귀하|드립니다|안내드립니다|회신|문의\s*사항|감사합니다|올림|드림)/gu), 0.72);
  if (/(?:안녕하세요|수신\s*:)/u.test(text) && /(?:감사합니다|드림|올림)\s*$/u.test(text)) scores.mail_notice += 2.2;

  const quoteLines = lines.filter(line => /^(?:[>“"'‘]|[-*]\s)/u.test(line)).length;
  const poemLikeLines = lines.filter(line => line.length <= 34 && !/[.!?。！？]$/u.test(line)).length;
  const structuredFunctionalFormat = ['table_heavy', 'list_heavy', 'label_heavy', 'sectioned', 'questionnaire']
    .some(flag => formatProfile.flags.includes(flag));
  const strongCreativeSignals = count(text, /(?:시\s*$|시집|운문|소설|등장인물|장면\s*\d+|단편\s*소설|화자\s*:)/gmu);
  const weakCreativeSignals = count(text, /(?:그날의|바람이|달빛|별빛|노을|그림자|고요(?:가|는|를)|계절의)/gu);
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

  const personalReflectionSignals = count(text, /(?:생각한다|느꼈다|깨달았다|경험을\s*통해|돌이켜\s*보면|기억에\s*남|배우게\s*되었다)/gu);
  add(scores, 'personal_essay', personalReflectionSignals, 0.55);
  add(scores, 'personal_essay', firstPersonSignals, 0.22);
  if (firstPersonSignals >= 2 && personalReflectionSignals >= 1) scores.personal_essay += 0.8;
  if (compactLength > 100 && sentences.length >= 3) scores.general += 1.35;
  if (compactLength >= 1500 && sentences.length >= 10) scores.general += 0.38;
  if (compactLength <= 100 && lines.length <= 2) scores.general += 0.55;

  const ranked = CONTENT_GENRES
    .filter(profile => profile !== 'unknown')
    .map(profile => ({ profile, score: scores[profile] }))
    .sort((a, b) => b.score - a.score || a.profile.localeCompare(b.profile));
  const top = ranked[0] || { profile: 'unknown', score: 0 };
  const second = ranked[1] || { profile: 'unknown', score: 0 };
  const confidence = calibrateConfidence(top.score, second.score, compactLength);
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
    firstPersonSignals
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
    tonePolicy: tonePolicyForBasicStyle(basicStyle),
    candidateProfiles,
    // v1 소비자와 로컬 분석 스크립트의 호환 필드다.
    candidates: candidateProfiles,
    safetyProfiles,
    profileMargin: round(Math.max(0, top.score - second.score), 3),
    formatProfile,
    riskFlags,
    signals: {
      compactLength,
      lineCount: lines.length,
      sentenceCount: sentences.length,
      headingCount: formatProfile.headingCount,
      nominalObservationEndings,
      observationSignals,
      reflectionSignals,
      educationSignals,
      instructionalPlanSignals,
      bulletLineCount,
      questionCount: questionnaire.questionCount,
      numberedQuestionCount: questionnaire.numberedQuestionCount,
      answerBlockCount: questionnaire.answerBlockCount,
      educationQuestionCount: questionnaire.educationQuestionCount
    }
  };
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

function detectFormatProfile(text, lines, sentences, questionnaire) {
  const compactLength = String(text || '').replace(/\s+/gu, '').length;
  const length = compactLength <= 100 ? 'short' : (compactLength >= 1500 ? 'long' : 'standard');
  const headingCountValue = headingCount(lines.filter(line => !(questionnaire.isQuestionnaire && isQuestionLike(line))));
  const layout = layoutStructure.analyzeLineStructure(text);
  const listItemCount = Math.max(lines.filter(isListLine).length, layout.listLineCount || 0);
  const tableLineCount = Math.max(lines.filter(isTableLikeLine).length, layout.tableLineCount || 0);
  const labelLineCount = layout.labelLineCount || 0;
  const referenceLineCount = lines.filter(line => /(?:doi\s*:|https?:\/\/|\((?:19|20)\d{2}(?:[a-z]|\s*\.\s*\d{1,2}(?:\s*\.\s*\d{1,2})?\s*\.?)?\)|참고\s*문헌|References|Bibliography)/iu.test(line)).length;
  const quoteLineCount = lines.filter(line => /^(?:>|[“"'‘])/u.test(line) || /[“"][^”"\n]{2,}[”"]/u.test(line)).length;
  const appendixPresent = lines.some(line => /^(?:부록|Appendix)(?:\s|$)/iu.test(line));
  const poemLikeLines = lines.filter(line => line.length <= 40 && !/[.!?。！？]$/u.test(line)).length;
  const lineSensitive = questionnaire.isQuestionnaire
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
  if (listItemCount >= 3 && listItemCount / Math.max(1, lines.length) >= 0.3) flags.push('list_heavy');
  if (tableLineCount >= 2) flags.push('table_heavy');
  if (labelLineCount >= 2) flags.push('label_heavy');
  if (referenceLineCount >= 3) flags.push('reference_heavy');
  if (lineSensitive) flags.push('line_sensitive');
  if (quoteLineCount >= 2) flags.push('quote_sensitive');
  if (appendixPresent) flags.push('appendix_present');
  const primary = ['questionnaire', 'table_heavy', 'reference_heavy', 'list_heavy', 'label_heavy', 'sectioned', 'line_sensitive']
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
    appendixPresent
  };
}

function detectRiskFlags(text, { profile, safetyProfiles, questionnaire, formatProfile, firstPersonSignals }) {
  const flags = [];
  // 목록·질문 번호는 사실 수치가 아니므로 위험 밀도에서 제외한다.
  const factualText = String(text || '').split(/\r?\n/u)
    .map(line => line.replace(/^\s*(?:\d{1,3}[.)]|\d{1,3}(?:\.\d+)+[.)]?|[①②③④⑤⑥⑦⑧⑨⑩]|[-*•▪◦])\s+/u, ''))
    .join('\n');
  const numberCount = count(factualText, /(?:^|[^A-Za-z0-9_])[-+]?\d+(?:[.,]\d+)*(?:%|％|명|개|건|원|년|월|일|점|배|시간|분)?(?=$|[^A-Za-z0-9_])/gu);
  const institutionCount = count(text, /[가-힣A-Za-z0-9·&()]{2,30}(?:대학교|대학|학교|연구원|연구소|기관|협회|공사|재단|위원회|병원|기업|회사)/gu);
  const citationCount = count(text, /(?:\([가-힣A-Za-z·,&\s]+,?\s*(?:19|20)\d{2}[a-z]?\)|\((?:19|20)\d{2}(?:\s*\.\s*\d{1,2}(?:\s*\.\s*\d{1,2})?\s*\.?)?\)|doi\s*:|https?:\/\/|참고\s*문헌|References)/giu);
  const experienceActionCount = count(text, /(?:참여|방문|사용해\s*보|다녀왔|맡은\s*역할|느꼈|배웠|깨달|근무|프로젝트|직접\s*(?:조사|분석|제작|작성|수행))/gu);
  const contextualExperienceCount = count(text, /(?:나는|내가|저는|제가|당시|직접|경험을\s*통해|아르바이트)[^.!?\n]{0,90}(?:참여|방문|사용|수행|조사|분석|제작|발표|근무|느꼈|배웠|깨달|맡)/gu);
  const evaluationCount = count(text, /(?:평가|성취|역량|우수|뛰어|돋보|부족|개선|성장|기여|책임감)/gu);
  const directCommercialActionCount = count(text, /(?:지금\s*(?:바로|신청)|(?:신청|구매|예약|문의)\s*(?:하세요|해\s*주세요|바랍니다)|클릭(?:하세요|해\s*주세요)|놓치지\s*마세요)/gu);
  const promotionalOfferCount = count(text, /(?:무료\s*(?:상담|체험)|한정\s*(?:수량|기간|판매)|특가|할인\s*(?:혜택|행사|쿠폰)|선착순|오늘만|마감\s*임박)/gu);
  const researchDiscussionContext = ['academic_paper', 'report_assignment'].includes(profile)
    && (formatProfile.flags.includes('reference_heavy') || formatProfile.flags.includes('sectioned'));
  const commercialIntentCount = directCommercialActionCount
    + (researchDiscussionContext && directCommercialActionCount === 0 ? 0 : promotionalOfferCount);
  const deadlineActionCount = count(text, /(?:마감|기한|까지\s*(?:제출|신청|회신)|신청|제출|회신|문의|참석|입금)/gu);
  const factCount = numberCount + institutionCount + citationCount + (formatProfile.quoteLineCount || 0);
  if (factCount >= 8) flags.push('fact_dense');
  if (numberCount >= 4) flags.push('number_dense');
  if (institutionCount >= 2) flags.push('institution_dense');
  if (citationCount >= 3 || formatProfile.flags.includes('reference_heavy')) flags.push('citation_dense');
  if (firstPersonSignals > 0
      || ['student_record_teacher', 'student_self_assessment', 'resume_application', 'creative'].includes(profile)
      || safetyProfiles.some(item => ['student_record_teacher', 'student_self_assessment', 'resume_application', 'creative'].includes(item))) {
    flags.push('pov_sensitive');
  }
  if (contextualExperienceCount >= 1
      || (firstPersonSignals > 0 && experienceActionCount >= 2)
      || safetyProfiles.includes('student_self_assessment')
      || profile === 'resume_application') flags.push('experience_claim');
  if (evaluationCount >= 2 || safetyProfiles.includes('student_record_teacher') || safetyProfiles.includes('student_self_assessment')) flags.push('evaluation_claim');
  if (commercialIntentCount >= 1 || profile === 'marketing') flags.push('commercial_claim');
  if (deadlineActionCount >= 2 || profile === 'mail_notice') flags.push('deadline_action_sensitive');
  if (questionnaire.isQuestionnaire) flags.push('questionnaire_answer_boundary');
  return flags;
}

function buildSafetyProfiles({ profile, ranked, questionnaire, nominalObservationEndings, observationSignals, reflectionSignals, formatProfile, strongCreativeSignals = 0 }) {
  const topScore = ranked[0]?.score || 0;
  const threshold = Math.max(0.9, topScore * 0.28);
  const safety = new Set();
  const minimumScore = {
    academic_paper: 1.3,
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

function tonePolicyForBasicStyle(value) {
  const style = normalizeBasicStyle(value);
  if (style === 'blog') return 'conversational';
  if (style === 'report') return 'formal';
  return 'source_preserve';
}

function calibrateConfidence(top, second, compactLength) {
  if (top <= 0) return 0.3;
  const strength = Math.min(1, top / 4.2);
  const margin = Math.min(1, Math.max(0, (top - second) / Math.max(top, 1)));
  let value = 0.35 + strength * 0.48 + margin * 0.16;
  if (compactLength < 60 && top < 2.5) value -= 0.12;
  return Math.max(0.3, Math.min(0.99, value));
}

function headingCount(lines) {
  return lines.filter(line => /^(?:제\s*\d+\s*(?:장|절|항)|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)]?|\d+(?:\.\d+){0,3}[.)]?\s+|서론$|본론$|결론$|목차$|참고\s*문헌$)/u.test(line)).length;
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

function isTableLikeLine(line) {
  const value = String(line || '').trim();
  if (/\t|^\|.+\|$/u.test(value)) return true;
  if (/^(?:표|그림)\s*[0-9A-Za-z가-힣.-]+/u.test(value)) return true;
  return /\S\s{2,}\S\s{2,}\S/u.test(value) && value.length <= 260;
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
  detectQuestionnaire,
  detectFormatProfile
};
