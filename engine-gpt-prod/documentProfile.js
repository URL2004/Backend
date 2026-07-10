'use strict';

const { splitSentences } = require('../engine/koreanText');

const DOCUMENT_PROFILES = Object.freeze([
  'academic_paper',
  'report_assignment',
  'student_record',
  'resume_application',
  'general_essay',
  'long_explainer',
  'blog_review',
  'marketing_ad',
  'social_caption',
  'mail_notice',
  'short_phrase',
  'creative',
  'unknown'
]);

const PROFILE_GROUPS = Object.freeze({
  academic_paper: 'academic_report_explainer',
  report_assignment: 'academic_report_explainer',
  long_explainer: 'academic_report_explainer',
  student_record: 'student_record',
  resume_application: 'essay_application',
  general_essay: 'essay_application',
  blog_review: 'blog_social',
  social_caption: 'blog_social',
  marketing_ad: 'functional_copy',
  mail_notice: 'functional_copy',
  short_phrase: 'functional_copy',
  creative: 'creative',
  unknown: 'unknown'
});

function detectDocumentProfile(source, { basicStyle = '' } = {}) {
  const text = String(source || '').trim();
  const compactLength = text.replace(/\s+/gu, '').length;
  const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const sentences = splitSentences(text, { preserveLines: false });
  const scores = Object.fromEntries(DOCUMENT_PROFILES.map(profile => [profile, 0]));

  add(scores, 'academic_paper', count(text, /(?:초록|Abstract|연구\s*(?:목적|방법|결과|가설)|선행\s*연구|방법론|유의확률|참고\s*문헌|doi\s*:|KCI|RISS)/giu), 1.3);
  add(scores, 'academic_paper', count(text, /\([가-힣A-Za-z·,&\s]+,?\s*(?:19|20)\d{2}[a-z]?\)/gu), 0.9);
  add(scores, 'academic_paper', count(text, /(?:p|t|F|β|R²)\s*[<=>]\s*-?\d+(?:\.\d+)?/gu), 1.2);

  add(scores, 'report_assignment', count(text, /(?:서론|본론|결론|과제|보고서|목차|조사\s*결과|문제점|개선\s*방안|시사점)/gu), 0.85);
  add(scores, 'report_assignment', headingCount(lines), 0.38);

  add(scores, 'student_record', count(text, /(?:세부\s*능력\s*및\s*특기\s*사항|세특|생활\s*기록부|교과\s*활동|수업\s*중|발표함|탐구함|기여함|보여\s*줌|학생은)/gu), 1.35);
  add(scores, 'student_record', count(text, /(?:함|됨|임|음)\s*[.!?]?\s*(?=$|\n)/gmu), 0.25);

  add(scores, 'resume_application', count(text, /(?:지원\s*동기|입사\s*후\s*포부|성장\s*과정|직무\s*역량|자기\s*소개서|자소서|저의\s*(?:강점|경험)|귀사|지원하게\s*되었습니다)/gu), 1.35);
  add(scores, 'resume_application', count(text, /(?:저는|제가|저의|저에게)/gu), 0.28);

  add(scores, 'blog_review', count(text, /(?:후기|리뷰|다녀왔|방문했|써봤|사용해\s*보|추천|맛집|내돈내산|오늘은|사진|솔직히)/gu), 0.8);
  add(scores, 'blog_review', count(text, /(?:해요|했어요|였어요|더라고요|거든요|네요|죠)[.!?~]?\s*(?=$|\n)/gmu), 0.24);

  add(scores, 'marketing_ad', count(text, /(?:지금\s*(?:바로|신청)|무료\s*(?:상담|체험)|한정|특가|할인|구매|예약|혜택|문의\s*주세요|클릭|놓치지\s*마세요)/gu), 0.95);
  add(scores, 'marketing_ad', count(text, /(?:\d{1,3}%|원\s*할인|₩|무료)/gu), 0.2);

  add(scores, 'social_caption', count(text, /#[가-힣A-Za-z0-9_]+/gu), 0.7);
  add(scores, 'social_caption', count(text, /[😀-🙏🌀-🫿❤♥✨🔥✅📌]/gu), 0.42);
  if (compactLength <= 450 && lines.length >= 3 && median(lines.map(line => line.length)) <= 35) scores.social_caption += 1.2;

  add(scores, 'mail_notice', count(text, /(?:안녕하세요[,.]?|수신\s*:|발신\s*:|제목\s*:|귀하|드립니다|안내드립니다|회신|문의\s*사항|감사합니다|올림|드림)/gu), 0.72);
  if (/(?:안녕하세요|수신\s*:)/u.test(text) && /(?:감사합니다|드림|올림)\s*$/u.test(text)) scores.mail_notice += 2.2;

  const quoteLines = lines.filter(line => /^(?:[>“"'‘]|[-*]\s)/u.test(line)).length;
  const poemLikeLines = lines.filter(line => line.length <= 34 && !/[.!?。！？]$/u.test(line)).length;
  add(scores, 'creative', count(text, /(?:시\s*$|시집|운문|소설|등장인물|장면\s*\d+|그날의|바람이|달빛|별빛)/gmu), 0.55);
  if (lines.length >= 4 && poemLikeLines / lines.length >= 0.65 && median(lines.map(line => line.length)) <= 32) scores.creative += 3.4;
  if (quoteLines >= 3 && /[“”"']/u.test(text)) scores.creative += 1.1;

  if (compactLength >= 1500) {
    scores.long_explainer += 1.35;
    if (sentences.length >= 12) scores.long_explainer += 0.65;
    add(scores, 'long_explainer', count(text, /(?:먼저|다음으로|구체적으로|예를\s*들어|즉|정리하면)/gu), 0.18);
  }

  if (compactLength <= 100 && lines.length <= 2) scores.short_phrase += 2.8;
  if (compactLength > 100 && compactLength < 1500 && sentences.length >= 3) scores.general_essay += 1.35;
  add(scores, 'general_essay', count(text, /(?:생각한다|느꼈다|깨달았다|경험을\s*통해|돌이켜\s*보면)/gu), 0.42);

  const ranked = DOCUMENT_PROFILES
    .filter(profile => profile !== 'unknown')
    .map(profile => ({ profile, score: scores[profile] }))
    .sort((a, b) => b.score - a.score || a.profile.localeCompare(b.profile));
  const top = ranked[0] || { profile: 'unknown', score: 0 };
  const second = ranked[1] || { profile: 'unknown', score: 0 };
  let confidence = calibrateConfidence(top.score, second.score, compactLength);
  let profile = top.profile;
  let decisionSource = 'content';

  if (confidence >= 0.55 && confidence < 0.75) {
    const hinted = breakTieWithBasicStyle(ranked, basicStyle);
    if (hinted && hinted.profile !== profile) {
      profile = hinted.profile;
      decisionSource = 'content_with_basic_style_tiebreak';
    }
  }
  if (confidence < 0.55) {
    profile = 'unknown';
    decisionSource = 'low_confidence_preserve';
  }
  if (profile === 'short_phrase' && compactLength > 100) {
    profile = 'unknown';
    confidence = Math.min(confidence, 0.54);
  }

  return {
    profile,
    confidence: round(confidence, 4),
    group: PROFILE_GROUPS[profile] || 'unknown',
    source: decisionSource,
    basicStyle: normalizeBasicStyle(basicStyle),
    candidates: ranked.slice(0, 4).map(item => ({ profile: item.profile, score: round(item.score, 3) })),
    signals: { compactLength, lineCount: lines.length, sentenceCount: sentences.length, headingCount: headingCount(lines) }
  };
}

function breakTieWithBasicStyle(ranked, basicStyle) {
  const style = normalizeBasicStyle(basicStyle);
  const topScore = ranked[0]?.score || 0;
  const eligible = ranked.filter(item => topScore - item.score <= Math.max(0.65, topScore * 0.22));
  if (style === 'blog') return eligible.find(item => ['blog_review', 'social_caption', 'marketing_ad', 'general_essay'].includes(item.profile));
  if (style === 'report') return eligible.find(item => ['academic_paper', 'report_assignment', 'student_record', 'long_explainer'].includes(item.profile));
  return null;
}

function normalizeBasicStyle(value) {
  const style = String(value || '').trim().toLowerCase();
  return style === 'blog' || style === 'report' ? style : '';
}

function calibrateConfidence(top, second, compactLength) {
  if (top <= 0) return 0.3;
  const strength = Math.min(1, top / 4.2);
  const margin = Math.min(1, Math.max(0, (top - second) / Math.max(top, 1)));
  // 다른 신호가 없다는 이유만으로 짧은 일반문을 고신뢰 장르로 올리지 않는다.
  // 절대 신호 강도를 우선하고, 후보 간 격차는 보조 신뢰도로만 쓴다.
  let value = 0.35 + strength * 0.48 + margin * 0.16;
  if (compactLength < 60 && top < 2.5) value -= 0.12;
  return Math.max(0.3, Math.min(0.99, value));
}

function headingCount(lines) {
  return lines.filter(line => /^(?:제\s*\d+\s*(?:장|절|항)|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)]?|\d+(?:\.\d+){0,3}[.)]?\s+|서론$|본론$|결론$|목차$|참고\s*문헌$)/u.test(line)).length;
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

module.exports = { DOCUMENT_PROFILES, PROFILE_GROUPS, detectDocumentProfile };
