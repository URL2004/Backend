'use strict';

const { DEFAULT_THRESHOLDS } = require('./patterns');

function buildPromptHints(analysis, opts = {}) {
  const max = Math.max(1, Math.min(12, Number(opts.max || DEFAULT_THRESHOLDS.promptHintsMax) || DEFAULT_THRESHOLDS.promptHintsMax));
  const profile = String(opts.documentProfile?.profile || opts.documentProfile || 'unknown');
  const patterns = (Array.isArray(analysis?.topPatterns) ? analysis.topPatterns : [])
    .filter(pattern => isPatternAllowedForProfile(pattern, profile))
    .slice(0, max);
  if (!patterns.length) return '';
  const lines = [
    '[한국어 품질 힌트]',
    '아래 항목은 원문에서 감지된 표현 습관이다. 새 규칙으로 확장하지 말되, 피하기 결과가 보존형 교정처럼 약해지지 않도록 일반 문장도 자연스럽게 재서술한다.',
    `전체 위험도 ${formatRisk(analysis.koreanSkillRisk)} / 등급 ${analysis.grade || 'A'}`
  ];
  for (const pattern of patterns) {
    const sample = Array.isArray(pattern.samples) && pattern.samples.length
      ? ` 예: ${pattern.samples.slice(0, 2).join(', ')}`
      : '';
    lines.push(`- ${pattern.label}(${pattern.severity}, ${pattern.count}회): ${profileAdvice(pattern, profile)}${sample}`);
  }
  return lines.join('\n');
}

function isPatternAllowedForProfile(pattern, profile) {
  if (profile === 'legal_contract' && ['can_formula', 'three_part_list', 'abstract_modifier'].includes(pattern?.id)) return false;
  if (['academic_paper', 'report_assignment'].includes(profile)
      && ['three_part_list'].includes(pattern?.id)) return false;
  return true;
}

function profileAdvice(pattern, profile) {
  if (pattern?.id === 'abstract_modifier' && ['academic_paper', 'report_assignment'].includes(profile)) {
    return '체계적 문헌고찰 등 정착된 전문 용어는 보존하고, 실제 기능 없이 반복되는 평가 수식어만 줄인다.';
  }
  if (pattern?.id === 'can_formula' && profile === 'legal_contract') {
    return '권리·허용·가능성을 나타내는 표현이므로 원문 그대로 보존한다.';
  }
  return pattern?.advice || '';
}

function compactForLog(analysis, max = 8) {
  if (!analysis) return null;
  return {
    koreanSkillRisk: round3(analysis.koreanSkillRisk),
    translationeseRisk: round3(analysis.translationeseRisk),
    gptStyleRisk: round3(analysis.gptStyleRisk),
    grammarRisk: round3(analysis.grammarRisk),
    styleConsistencyRisk: round3(analysis.styleConsistencyRisk),
    grade: analysis.grade,
    hardGrammarCount: analysis.hardGrammarCount || 0,
    topPatterns: (analysis.topPatterns || []).slice(0, max).map(p => ({
      id: p.id,
      label: p.label,
      category: p.category,
      severity: p.severity,
      count: p.count
    }))
  };
}

function formatRisk(v) {
  return Number.isFinite(Number(v)) ? Number(v).toFixed(3) : '0.000';
}

function round3(v) {
  return Number(Number(v || 0).toFixed(3));
}

module.exports = {
  buildPromptHints,
  compactForLog
};
