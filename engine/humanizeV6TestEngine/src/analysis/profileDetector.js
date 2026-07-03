const { splitLines, getBasicStats } = require('./textStats');

const PROFILES = Object.freeze({
  STRUCTURED: 'structured_expository',
  WEB: 'web_article',
  RESEARCH: 'research_text',
  APPLICATION: 'application_text',
  NARRATIVE: 'narrative_reflection',
  GENERAL: 'general_text'
});

function detectProfile(text, policy = {}) {
  if (policy.profileMode && policy.profileMode !== 'auto') {
    return { profile: policy.profileMode, confidence: 1, reasons: ['admin_fixed_profile'] };
  }
  const t = String(text || '');
  const stats = getBasicStats(t);
  const lines = splitLines(t).map(x => x.trim()).filter(Boolean);
  const reasons = [];

  const hasRomanSections = /[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\.\s*(서론|본론|결론|개요|논의|결과)/.test(t);
  const numberedHeadings = lines.filter(l => /^\d+\.\s+/.test(l)).length;
  const hasResearchSignals = /(초록|Abstract|연구방법|선행연구|방법론|가설|표본|분석 결과|참고문헌|References)/i.test(t);
  const hasApplicationSignals = /(지원동기|입사 후 포부|성장과정|자기소개|역량|직무 경험|지원한 이유)/.test(t);
  const hasWebSignals = /(안녕하세요|현장|작업 전|작업 후|문의|감사합니다|소요 시간|사용 장비|관리 주기|후기|방문|예약)/.test(t) && stats.paragraphCount >= 6;
  const hasNarrativeSignals = /(느꼈|생각했|경험했|깨달았|인상 깊|기억에 남|나에게|저는|나는)/.test(t);

  if (hasResearchSignals) { reasons.push('research_signals'); return { profile: PROFILES.RESEARCH, confidence: 0.82, reasons }; }
  if (hasApplicationSignals) { reasons.push('application_signals'); return { profile: PROFILES.APPLICATION, confidence: 0.80, reasons }; }
  if (hasWebSignals) { reasons.push('web_article_structure'); return { profile: PROFILES.WEB, confidence: 0.78, reasons }; }
  if (hasRomanSections || numberedHeadings >= 2) { reasons.push('structured_sections'); return { profile: PROFILES.STRUCTURED, confidence: 0.76, reasons }; }
  if (hasNarrativeSignals) { reasons.push('narrative_reflection_signals'); return { profile: PROFILES.NARRATIVE, confidence: 0.62, reasons }; }
  return { profile: PROFILES.GENERAL, confidence: 0.50, reasons: ['fallback_general'] };
}

module.exports = { detectProfile, PROFILES };
