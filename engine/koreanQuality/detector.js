'use strict';

const {
  SEVERITY_WEIGHTS,
  TRANSLATIONESE_PATTERNS,
  GPT_STYLE_PATTERNS,
  GRAMMAR_PATTERNS
} = require('./patterns');
const { analyzeStyle, splitSentences } = require('./styleConsistency');
const { findAdjacentDuplicates, findUnfinishedFinalSentence } = require('./grammarPrecheck');

function analyzeText(text, opts = {}) {
  const source = String(text || '');
  const chars = source.replace(/\s+/g, '').length;
  const sentences = splitSentences(source);
  const translationMatches = scanPatterns(source, TRANSLATIONESE_PATTERNS);
  const gptStyleMatches = [
    ...scanPatterns(source, GPT_STYLE_PATTERNS),
    ...measureRhythmPatterns(source, sentences)
  ];
  const grammarMatches = [
    ...scanPatterns(source, GRAMMAR_PATTERNS),
    ...findAdjacentDuplicates(source).map(item => ({
      id: item.id,
      category: 'grammar',
      severity: 'S1',
      hard: true,
      label: item.label,
      count: 1,
      samples: [item.sentence],
      advice: '중복 문장을 삭제하거나 원문에 있던 누락 문장으로 복원한다.'
    })),
    ...findUnfinishedFinalSentence(source).map(item => ({
      id: item.id,
      category: 'grammar',
      severity: 'S1',
      hard: true,
      label: item.label,
      count: 1,
      samples: [item.sentence],
      advice: '마지막 문장을 완결된 서술로 복원한다.'
    }))
  ];
  const style = analyzeStyle(source);
  const translationeseRisk = categoryRisk(translationMatches, chars, 13);
  const gptStyleRisk = categoryRisk(gptStyleMatches, chars, 12);
  const grammarRisk = Math.min(1, categoryRisk(grammarMatches, chars, 9) + hardGrammarCount(grammarMatches) * 0.18);
  const styleConsistencyRisk = Number(Math.min(1,
    (style.registerMixRisk || 0) * 0.45 +
    (style.paragraphFragmentRisk || 0) * 0.25 +
    (style.rhythm?.uniformRisk || 0) * 1.2
  ).toFixed(3));
  const koreanSkillRisk = Number(Math.min(1,
    translationeseRisk * 0.30 +
    gptStyleRisk * 0.30 +
    grammarRisk * 0.25 +
    styleConsistencyRisk * 0.15
  ).toFixed(3));
  const topPatterns = rankPatterns([
    ...translationMatches,
    ...gptStyleMatches,
    ...grammarMatches,
    ...styleToPatterns(style)
  ]);
  return {
    charLen: chars,
    sentenceCount: sentences.length,
    koreanSkillRisk,
    translationeseRisk,
    gptStyleRisk,
    grammarRisk,
    styleConsistencyRisk,
    grade: gradeFor(koreanSkillRisk),
    hardGrammarCount: hardGrammarCount(grammarMatches),
    style,
    patterns: {
      translationese: translationMatches,
      gptStyle: gptStyleMatches,
      grammar: grammarMatches
    },
    topPatterns: topPatterns.slice(0, opts.maxPatterns || 12)
  };
}

function scanPatterns(text, patterns) {
  const out = [];
  for (const pattern of patterns) {
    const re = cloneRegex(pattern.re);
    const samples = [];
    let count = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      count += 1;
      if (samples.length < 3) samples.push(String(match[0] || '').trim());
      if (match[0] === '') re.lastIndex += 1;
    }
    if (!count) continue;
    out.push({
      id: pattern.id,
      category: pattern.category,
      severity: pattern.severity,
      hard: pattern.hard === true,
      label: pattern.label,
      count,
      samples,
      advice: pattern.advice,
      score: patternScore(pattern, count)
    });
  }
  return out;
}

function measureRhythmPatterns(text, sentences) {
  const out = [];
  const commaHeavy = sentences.filter(s => (s.match(/,/g) || []).length >= 3).length;
  if (commaHeavy) {
    out.push({
      id: 'comma_chain',
      category: 'gpt_style',
      severity: 'S2',
      hard: false,
      label: '쉼표로 길게 이어진 문장',
      count: commaHeavy,
      samples: sentences.filter(s => (s.match(/,/g) || []).length >= 3).slice(0, 2).map(s => s.slice(0, 120)),
      advice: '쉼표 연결을 줄이고 문장을 완결 단위로 정리한다.',
      score: patternScore({ severity: 'S2' }, commaHeavy)
    });
  }
  const paragraphs = String(text || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  let consecutiveOneSentence = 0;
  let maxConsecutive = 0;
  for (const p of paragraphs) {
    if (splitSentences(p).length <= 1 && p.length >= 20) {
      consecutiveOneSentence += 1;
      maxConsecutive = Math.max(maxConsecutive, consecutiveOneSentence);
    } else {
      consecutiveOneSentence = 0;
    }
  }
  if (maxConsecutive >= 3) {
    out.push({
      id: 'one_sentence_paragraph_run',
      category: 'gpt_style',
      severity: 'S2',
      hard: false,
      label: '한 문장 문단 연속',
      count: maxConsecutive,
      samples: [],
      advice: '관련 문장은 2~4문장 단위 문단으로 묶어 글 흐름을 유지한다.',
      score: patternScore({ severity: 'S2' }, maxConsecutive)
    });
  }
  return out;
}

function styleToPatterns(style) {
  const out = [];
  if ((style.registerMixRisk || 0) >= 0.2) {
    out.push({
      id: 'register_mix',
      category: 'style',
      severity: 'S1',
      hard: false,
      label: '종결체 혼용',
      count: Math.ceil((style.registerMixRisk || 0) * 10),
      samples: [],
      advice: '원문에서 우세한 종결체를 유지하고 합니다/했다/해요를 섞지 않는다.',
      score: patternScore({ severity: 'S1' }, Math.ceil((style.registerMixRisk || 0) * 10))
    });
  }
  if ((style.rhythm?.uniformRisk || 0) > 0) {
    out.push({
      id: 'uniform_sentence_rhythm',
      category: 'style',
      severity: 'S3',
      hard: false,
      label: '문장 길이 리듬 단조로움',
      count: Math.ceil((style.rhythm.uniformRisk || 0) * 10),
      samples: [],
      advice: '의미를 보존하면서 긴 문장과 짧은 문장의 호흡을 자연스럽게 섞는다.',
      score: patternScore({ severity: 'S3' }, Math.ceil((style.rhythm.uniformRisk || 0) * 10))
    });
  }
  if ((style.paragraphFragmentRisk || 0) >= 0.5) {
    out.push({
      id: 'fragmented_paragraph_flow',
      category: 'style',
      severity: 'S2',
      hard: false,
      label: '문단 흐름 파편화',
      count: style.oneSentenceParagraphs || 1,
      samples: [],
      advice: '모든 문장을 따로 떼지 말고 연관 문장을 문단으로 이어 둔다.',
      score: patternScore({ severity: 'S2' }, style.oneSentenceParagraphs || 1)
    });
  }
  return out;
}

function patternScore(pattern, count) {
  const weight = SEVERITY_WEIGHTS[pattern.severity] || 1;
  return Number((weight * Math.log1p(Math.max(0, count))).toFixed(3));
}

function categoryRisk(matches, chars, denominator) {
  if (!matches.length || chars <= 0) return 0;
  const densityFactor = Math.min(1.35, Math.max(0.75, 900 / Math.max(450, chars)));
  const sum = matches.reduce((acc, m) => acc + (m.score || patternScore(m, m.count || 0)), 0);
  return Number(Math.min(1, (sum * densityFactor) / denominator).toFixed(3));
}

function hardGrammarCount(matches) {
  return matches.filter(m => m.hard).reduce((n, m) => n + (m.count || 0), 0);
}

function rankPatterns(matches) {
  return [...matches]
    .filter(m => (m.count || 0) > 0)
    .sort((a, b) => (b.score || 0) - (a.score || 0) || (b.count || 0) - (a.count || 0));
}

function gradeFor(risk) {
  if (risk < 0.16) return 'A';
  if (risk < 0.33) return 'B';
  if (risk < 0.55) return 'C';
  return 'D';
}

function cloneRegex(re) {
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  return new RegExp(re.source, flags);
}

module.exports = {
  analyzeText,
  splitSentences
};
