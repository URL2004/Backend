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
  const reviewContentSignals = count(text, /(?:후기|리뷰|다녀왔|방문했|써봤|사용해\s*보|추천|맛집|내돈내산|오늘은|사진|솔직히)/gu);
  const reviewEndingSignals = count(text, /(?:해요|했어요|였어요|더라고요|거든요|네요|죠)[.!?~]?\s*(?=$|\n)/gmu);

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
  const reportInquirySignals = count(text, /(?:본\s*(?:탐구|조사|과제)|탐구\s*(?:동기|목적|주제|과정|방법|결과|결론)|조사\s*(?:목적|대상|방법|과정|결과)|비교\s*분석|사례\s*분석|이론적\s*(?:분석|검토)|문헌\s*(?:조사|검토)|설문\s*(?:조사|분석)|자료를\s*(?:수집|분석|비교))/gu);
  const reportMethodSignals = count(text, /(?:연구|탐구|조사|분석)의?\s*(?:목적|대상|범위|방법|절차|과정|결과|한계)|(?:가설|변수|사례|자료|문헌|설문)[^.!?\n]{0,45}(?:분석|비교|검토|수집)/gu);
  const analyticalFrameworkSignals = count(text, /(?:(?:이론|관점|개념|모형)[^.!?\n]{0,55}(?:분석|적용|해석|비교)|(?:분석|적용|해석|비교)[^.!?\n]{0,55}(?:이론|관점|개념|모형))/gu);
  const reportHeadingSignals = lines.filter(line => /^(?:#{1,6}\s*)?(?:\d+(?:\.\d+)*[.)]?\s*)?(?:탐구\s*(?:동기|목적|주제|방법|과정|결과)|조사\s*(?:목적|방법|결과)|이론적\s*(?:배경|분석)|사례\s*분석|비교\s*분석|문제점|개선\s*방안|결론|느낀\s*점)\s*$/u.test(line)).length;
  add(scores, 'report_assignment', reportInquirySignals, 0.58);
  add(scores, 'report_assignment', reportMethodSignals, 0.48);
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

  const explicitApplicationSignals = count(text, /(?:지원\s*동기|입사\s*후\s*포부|성장\s*과정|직무\s*역량|자기\s*소개서|자소서|저의\s*(?:(?:가장\s*(?:큰|뛰어난)\s*)?(?:강점|경쟁력|핵심\s*역량)|경험)|귀사|지원하게\s*되었습니다|(?:연구원|전문가|인재|구성원)(?:이|가)?\s*되겠습니다)/gu);
  const applicationIntentSignals = count(text, /(?:신청\s*(?:동기|이유)|신청(?:하게\s*되었습니다|했습니다|하고자|하려고|하고\s*싶)|지원(?:하게\s*되었습니다|했습니다|하고자|하려고|하고\s*싶)|참여하게\s*된다면|선발된다면)/gu);
  const programApplicationSignals = count(text, /(?:(?:캠프|프로그램|교육\s*과정|체험\s*활동|학과\s*탐방|멘토링)[^.!?\n]{0,90}(?:신청|지원|참여|선발|체험)|(?:신청|지원|참여|선발)[^.!?\n]{0,90}(?:캠프|프로그램|교육\s*과정|체험\s*활동|학과\s*탐방|멘토링))/gu);
  const careerActionSignals = count(text, /(?:수집|정리|분석|비교|조사|기획|설계|운영|관리|지원|발표|협업|조율|응대|개선|제작|시각화|학습|연습|근무|실험|조정|최적화|도출|검증|측정|해석|문서화|작성|유지)/gu);
  const achievementSignals = count(text, /(?:합격|취득|등급|자격증|성과|역량|능력|강점|경쟁력|목표를\s*(?:달성|이뤄)|키웠|길렀|향상|보완|다졌|갖췄|갖추었|확보|구현|재현성|신뢰성)/gu);
  const roleFitSignals = count(text, /(?:직무|실무|업무|입사|채용|지원서|지원\s*분야|회사|조직|고객|수강생|교육\s*운영|운영\s*지원|연구\s*개발|연구원|소재\s*개발|업무에\s*(?:활용|적용)|도움이\s*될|기여(?:할|하는|하고자))/gu);
  const experienceNarrativeSignals = count(text, /(?:당시|그\s*과정에서|이\s*과정에서|이\s*경험(?:은|을|으로|을\s*통해)|경험을\s*바탕으로|준비\s*기간|아르바이트|프로젝트)/gu);
  const applicationValuePropositionSignals = count(text, /(?:^|\n|[.!?]\s*)(?:저의\s*(?:가장\s*(?:큰|뛰어난)\s*)?(?:강점|경쟁력|핵심\s*역량)|제가\s*(?:갖춘|보유한)\s*(?:강점|경쟁력|역량)|저는\s+[^.!?\n]{0,70}(?:강점|경쟁력|역량)(?:을|를|이|가|은|는))/gmu);
  const careerAspirationSignals = count(text, /(?:입사\s*후|귀사|지원(?:하게\s*되었습니다|하고자|했습니다)|(?:연구원|전문가|인재|구성원)(?:이|가)?\s*되겠습니다|(?:직무|업무|연구\s*개발|소재\s*개발)[^.!?\n]{0,45}기여(?:하겠습니다|하고자\s*합니다|하는))/gu);
  const researchCareerContextSignals = count(text, /(?:연구실|연구\s*개발|실험\s*(?:설계|조건|데이터|결과)|공정\s*(?:조건|변수|최적화)|분석\s*장비|시편|재현성|연구\s*과제|투고\s*논문)/gu);
  const applicationSectionSignals = lines.filter(line => /^(?:#{1,6}\s*)?(?:\d+(?:\.\d+)*[.)]?\s*)?(?:성격의?\s*(?:장단점|강점|약점)|강점과\s*약점|보유\s*역량|핵심\s*역량|직무\s*경험|경력\s*사항|자격(?:증|\s*및\s*교육)|지원\s*동기|입사\s*후\s*포부)\s*$/u.test(line)).length;
  const strengthWeaknessSignals = count(text, /(?:저의|제|제가\s*가진)?\s*(?:강점|장점|약점|단점)|(?:약점|단점|부족한\s*점)[^.!?\n]{0,65}(?:보완|개선|극복)|(?:강점|장점)[^.!?\n]{0,65}(?:활용|발휘)/gu);
  const qualificationSignals = count(text, /(?:자격증|자격을\s*취득|근무\s*경험|업무\s*경험|직무\s*경험|현장\s*경험|교육을\s*이수|과정을\s*수료)/gu);
  add(scores, 'resume_application', explicitApplicationSignals, 1.35);
  add(scores, 'resume_application', applicationIntentSignals, 1.35);
  add(scores, 'resume_application', programApplicationSignals, 0.85);
  add(scores, 'resume_application', firstPersonSignals, 0.22);
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
    scores.resume_application += 1.45;
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

  add(scores, 'review_blog', reviewContentSignals, 0.8);
  add(scores, 'review_blog', reviewEndingSignals, 0.24);

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
    ...resolveRegisterPolicy({ profile, basicStyle, requestStrength: 'basic' }),
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
      selfAssessmentActionSignals,
      selfReflectivePredicateSignals,
      reflectiveActivitySignals,
      educationSignals,
      reportInquirySignals,
      reportMethodSignals,
      reportHeadingSignals,
      analyticalFrameworkSignals,
      applicationIntentSignals,
      programApplicationSignals,
      instructionalPlanSignals,
      bulletLineCount,
      questionCount: questionnaire.questionCount,
      numberedQuestionCount: questionnaire.numberedQuestionCount,
      answerBlockCount: questionnaire.answerBlockCount,
      educationQuestionCount: questionnaire.educationQuestionCount,
      applicationValuePropositionSignals,
      careerAspirationSignals,
      researchCareerContextSignals,
      applicationSectionSignals,
      strengthWeaknessSignals,
      qualificationSignals
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

function resolveRegisterPolicy({ profile = 'unknown', basicStyle = '', requestStrength = 'basic' } = {}) {
  const genre = String(profile || 'unknown');
  const style = normalizeBasicStyle(basicStyle);
  const strength = String(requestStrength || 'basic');
  let targetRegister = 'source_preserve';
  let targetRegisterSource = 'source';

  if (['academic_paper', 'report_assignment'].includes(genre)) {
    targetRegister = 'academic_formal';
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
    'academic_formal', 'record_formal', 'student_formal', 'professional', 'functional_formal', 'formal'
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

function headingCount(lines) {
  return lines.filter(line => /^(?:#{1,6}\s+|제\s*\d+\s*(?:장|절|항)|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)]?|\d+(?:\.\d+){0,3}[.)]?\s+|서론$|본론$|결론$|목차$|참고\s*문헌$)/u.test(line)).length;
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
  applyTargetRegister,
  resolveRegisterPolicy,
  detectQuestionnaire,
  detectFormatProfile
};
