'use strict';

const { DEFAULT_THRESHOLDS } = require('./patterns');

function buildPromptHints(analysis, opts = {}) {
  const max = Math.max(1, Math.min(12, Number(opts.max || DEFAULT_THRESHOLDS.promptHintsMax) || DEFAULT_THRESHOLDS.promptHintsMax));
  const patterns = Array.isArray(analysis?.topPatterns) ? analysis.topPatterns.slice(0, max) : [];
  if (!patterns.length) return '';
  const lines = [
    '[한국어 품질 힌트]',
    '아래 항목은 원문에서 감지된 표현 습관이다. 새 규칙으로 확장하지 말고, 해당 문제만 자연스럽게 완화한다.',
    `전체 위험도 ${formatRisk(analysis.koreanSkillRisk)} / 등급 ${analysis.grade || 'A'}`
  ];
  for (const pattern of patterns) {
    const sample = Array.isArray(pattern.samples) && pattern.samples.length
      ? ` 예: ${pattern.samples.slice(0, 2).join(', ')}`
      : '';
    lines.push(`- ${pattern.label}(${pattern.severity}, ${pattern.count}회): ${pattern.advice}${sample}`);
  }
  return lines.join('\n');
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
