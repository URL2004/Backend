'use strict';

const { runLayoutNlp } = require('./pythonBridge');

const VERSION = 'layout-normalizer-v1';
const ROMAN = 'ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ';

async function formatDocument(text, opts = {}) {
  const source = String(text || '');
  const mode = normalizeMode(opts.mode);
  const phase = opts.phase || 'post';
  const profile = detectLayoutProfile(source, mode);
  const need = formatNeedScore(source);
  const protectedSource = protectSpans(normalizeRawWhitespace(source));
  const needsSpacing = needsSpacingRepair(protectedSource.text);
  let working = protectedSource.text;
  let nlp = null;

  if (opts.enableNlp === true) {
    nlp = await runLayoutNlp(working, {
      needsSpacingRepair: needsSpacing,
      timeoutMs: opts.timeoutMs,
      maxChars: opts.maxChars
    });
    const spaced = String(nlp?.spacedText || '').trim();
    if (spaced && contentPreservationGate(working, spaced).pass) {
      working = spaced;
    }
  }

  working = restoreSpans(working, protectedSource.spans);
  working = repairHeadingBreaks(working);
  working = repairKeyValueRuns(working, profile);
  const sentenceHints = restoreSentenceHints(nlp?.sentences || [], protectedSource.spans);
  const rendered = renderByProfile(working, {
    profile,
    mode,
    sentenceHints,
    force: need.score >= 0.25 || opts.force === true
  });
  const normalized = normalizeBlankLines(rendered);
  const gate = buildFormatGate(source, normalized, protectedSource.spans, profile);
  const applied = gate.contentPreservation.pass && normalized !== source;
  const finalText = gate.contentPreservation.pass ? normalized : normalizeRawWhitespace(source);
  return {
    text: finalText,
    report: compactReport({
      version: VERSION,
      phase,
      mode,
      profile,
      applied,
      need,
      nlp: compactNlp(nlp),
      gates: gate,
      before: measureLayout(source),
      after: measureLayout(finalText)
    })
  };
}

function normalizeMode(mode) {
  const v = String(mode || '').toLowerCase();
  if (v === 'blog') return 'blog';
  if (v === 'polish') return 'polish';
  return 'assignment';
}

function normalizeRawWhitespace(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function protectSpans(text) {
  const spans = [];
  let out = String(text || '');
  const patterns = [
    /https?:\/\/[^\s<>()]+/g,
    /[A-Z]{2,}(?:[-_.][A-Z0-9]+)*(?:\s+[A-Z]{2,}(?:[-_.][A-Z0-9]+)*){0,2}/g,
    /\d+(?:\.\d+)?\s*(?:년|월|일|시간|분|개|명|층|동|%|원|만원|억원|조원|kg|g|km|m²|㎡|평)/g,
    /(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ])\.\s*(?:서론|본론|결론|초록|참고문헌|이론적\s*배경|연구\s*방법|연구\s*결과)/g,
    /\[[0-9]+\]/g
  ];
  for (const rx of patterns) {
    out = out.replace(rx, match => {
      const id = `ZXQSPAN${String(spans.length).padStart(4, '0')}QXZ`;
      spans.push({ id, value: match });
      return id;
    });
  }
  return { text: out, spans };
}

function restoreSpans(text, spans = []) {
  let out = String(text || '');
  for (const span of spans) {
    const loose = new RegExp(span.id.split('').map(ch => escapeRe(ch)).join('\\s*'), 'g');
    out = out.replace(loose, span.value);
  }
  return out;
}

function restoreSentenceHints(sentences = [], spans = []) {
  return (sentences || []).map(s => restoreSpans(s, spans)).filter(Boolean);
}

function needsSpacingRepair(text) {
  const source = String(text || '');
  const spaceCount = (source.match(/\s/g) || []).length;
  const hangulRuns = source.match(/[가-힣]{30,}/g) || [];
  const spaceRatio = spaceCount / Math.max(1, source.length);
  return source.length > 80 && spaceRatio < 0.035 && hangulRuns.some(x => x.length >= 50);
}

function repairHeadingBreaks(text) {
  let out = `\n${String(text || '').trim()}\n`;
  const romanSet = `[${ROMAN}]`;
  out = out
    .replace(new RegExp(`\\s*(${romanSet})\\.\\s*(서론|본론|결론|초록|참고문헌|이론적\\s*배경|연구\\s*방법|연구\\s*결과)\\s*`, 'g'), '\n\n$1. $2\n\n')
    .replace(/(^|\n)\s*(참고문헌|References)\s*/gi, '\n\n$2\n\n')
    .replace(/([.!?。！？])\s*([ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ])\.\s*/g, '$1\n\n$2. ')
    .replace(/\s+([ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ])\.\s+(서론|본론|결론|초록|참고문헌)/g, '\n\n$1. $2\n\n')
    .replace(/(^|\n|\s)(\d{1,2})\.\s+([^\n.]{2,80}?(?:기술|이점|문제|배경|목적|방법|결과|개념|사례|분석|관리|작업|과정|범위|특징|장점|단점))\s+(?=[가-힣A-Za-z])/g, (m, lead, n, title) => {
      return `${lead && lead.includes('\n') ? lead : '\n'}${n}. ${title.trim()}\n\n`;
    });
  return normalizeBlankLines(out);
}

function repairKeyValueRuns(text, profile) {
  let out = String(text || '');
  if (profile !== 'web_article') return out;
  out = out.replace(/(관리\s*규모|작업\s*인원|소요\s*시간|작업\s*범위|위치|대상|인원|시간)\s*:\s*/g, '\n$1: ');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

function detectLayoutProfile(text, mode = '') {
  const source = String(text || '');
  const hasRomanSections = /[ⅠⅡⅢⅣⅤ]\.\s*(서론|본론|결론|초록|참고문헌)/.test(source);
  const hasAcademicWords = /(서론|본론|결론|연구|분석|조사|고찰|참고문헌)/.test(source);
  const hasBlogSignals = /(안녕하세요|이번\s*현장|작업\s*전|작업\s*후|감사합니다|문의|후기|청소)/.test(source);
  const hasResumeSignals = /(지원동기|성장과정|입사\s*후\s*포부|직무\s*경험|저는|제가)/.test(source);
  const hasReferences = /(참고문헌|References|\[\d+\]|doi|학술지)/i.test(source);
  if (hasReferences || /(초록|키워드|연구\s*방법|연구\s*결과)/.test(source)) return 'research_paper';
  if (hasRomanSections || hasAcademicWords || mode === 'assignment') return 'academic_report';
  if (hasBlogSignals || mode === 'blog') return 'web_article';
  if (hasResumeSignals) return 'application_text';
  return 'general_exposition';
}

function formatNeedScore(text) {
  const source = String(text || '');
  const lines = source.split('\n').filter(x => x.trim());
  const avgLineLen = lines.length ? source.length / lines.length : source.length;
  const longLineScore = Math.min(1, avgLineLen / 600);
  const lineBreakDensity = (source.match(/\n/g) || []).length / Math.max(1, source.length);
  const noBreakScore = lineBreakDensity < 0.002 ? 1 : 0;
  const spaceRatio = ((source.match(/\s/g) || []).length) / Math.max(1, source.length);
  const noSpaceScore = spaceRatio < 0.035 ? 1 : 0;
  const headingMergeScore = /[ⅠⅡⅢ]\.\s*(서론|본론|결론)\s+[가-힣]/.test(source) ? 1 : 0;
  const listRunScore = /\d+\.\s+[^\n]{40,}\s+\d+\.\s+/.test(source) ? 1 : 0;
  const score = 0.30 * longLineScore + 0.25 * noBreakScore + 0.20 * noSpaceScore + 0.15 * headingMergeScore + 0.10 * listRunScore;
  return {
    score: round3(score),
    longLineScore: round3(longLineScore),
    noBreakScore,
    noSpaceScore,
    headingMergeScore,
    listRunScore
  };
}

function renderByProfile(text, opts = {}) {
  const source = normalizeBlankLines(text);
  if (!opts.force) return source;
  const profile = opts.profile || detectLayoutProfile(source, opts.mode);
  const policy = renderPolicy(profile);
  const blocks = source.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const rendered = [];
  for (const block of blocks) {
    if (isHeading(block) || isListBlock(block) || isReferenceBlock(block) || isKeyValueBlock(block)) {
      rendered.push(block);
      continue;
    }
    rendered.push(...groupParagraph(block, policy, opts.sentenceHints));
  }
  return normalizeBlankLines(rendered.join('\n\n'));
}

function renderPolicy(profile) {
  if (profile === 'web_article') return { minSentences: 1, maxSentences: 3, minChars: 80, maxChars: 280, hardMax: 380 };
  if (profile === 'research_paper') return { minSentences: 3, maxSentences: 6, minChars: 250, maxChars: 700, hardMax: 900 };
  if (profile === 'application_text') return { minSentences: 3, maxSentences: 5, minChars: 180, maxChars: 520, hardMax: 760 };
  return { minSentences: 2, maxSentences: 4, minChars: 180, maxChars: 520, hardMax: 800 };
}

function groupParagraph(block, policy, hints = []) {
  const source = String(block || '').trim();
  if (!source) return [];
  if (source.length <= policy.hardMax && splitSentencesLocal(source).length <= policy.maxSentences + 1) return [source];
  const sentences = chooseSentenceSplit(source, hints);
  if (sentences.length <= 1) return [source];
  const out = [];
  let current = [];
  let currentLen = 0;
  for (const sentence of sentences) {
    const len = sentence.length;
    const shouldFlush = current.length >= policy.minSentences &&
      (current.length >= policy.maxSentences || currentLen + len >= policy.maxChars);
    if (shouldFlush) {
      out.push(current.join(' ').trim());
      current = [];
      currentLen = 0;
    }
    current.push(sentence);
    currentLen += len;
  }
  if (current.length) out.push(current.join(' ').trim());
  return out.length ? out : [source];
}

function chooseSentenceSplit(block, hints = []) {
  const compactBlock = bare(block);
  const matchingHints = (hints || []).filter(s => compactBlock.includes(bare(s)));
  if (matchingHints.length >= 2 && bare(matchingHints.join('')).length >= compactBlock.length * 0.65) return matchingHints;
  return splitSentencesLocal(block);
}

function splitSentencesLocal(text) {
  const source = String(text || '').replace(/\r/g, '');
  const parts = source
    .split(/(?<=[.!?。！？])\s+|(?<=[다요죠까음함임])\s+(?=[가-힣A-Za-z0-9"'])|\n+/)
    .map(s => s.trim())
    .filter(Boolean);
  return parts.length ? parts : (source.trim() ? [source.trim()] : []);
}

function buildFormatGate(before, after, spans, profile) {
  return {
    contentPreservation: contentPreservationGate(before, after),
    protectedSpans: protectedSpanGate(before, after, spans),
    headingMerge: headingMergeGate(after),
    paragraphLength: paragraphLengthGate(after, profile)
  };
}

function protectedSpanGate(original, formatted, spans = []) {
  const lost = (spans || [])
    .map(s => s.value)
    .filter(value => String(original || '').includes(value) && !String(formatted || '').includes(value));
  return { pass: lost.length === 0, lost: lost.slice(0, 20), lostCount: lost.length };
}

function contentPreservationGate(before, after) {
  const b = bare(before);
  const a = bare(after);
  return {
    pass: b === a,
    beforeLen: b.length,
    afterLen: a.length
  };
}

function headingMergeGate(text) {
  const bad = [
    /[ⅠⅡⅢⅣⅤ]\.\s*(서론|본론|결론)\s+[가-힣A-Za-z]/,
    /\n\d+\.\s+[^\n]{2,60}\s+[가-힣A-Za-z]{5,}/
  ].filter(rx => rx.test(String(text || '')));
  return { pass: bad.length === 0, count: bad.length };
}

function paragraphLengthGate(text, profile) {
  const paras = String(text || '').split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);
  const maxLen = profile === 'web_article' ? 380 : profile === 'research_paper' ? 950 : 850;
  const tooLong = paras.filter(p => p.length > maxLen);
  return { pass: tooLong.length === 0, tooLongCount: tooLong.length, maxLen };
}

function measureLayout(text) {
  const source = String(text || '');
  const lines = source.split('\n').filter(x => x.trim());
  const paras = source.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  return {
    chars: source.length,
    lines: lines.length,
    paragraphs: paras.length,
    avgLineLen: round1(lines.length ? source.length / lines.length : source.length),
    maxParagraphLen: paras.reduce((m, p) => Math.max(m, p.length), 0)
  };
}

function compactNlp(nlp) {
  if (!nlp) return { enabled: false };
  const engines = nlp.engines || {};
  return {
    enabled: true,
    ok: nlp.ok === true,
    sentenceEngine: nlp.sentenceEngine || '',
    spacingEngine: nlp.spacingEngine || '',
    sentenceCount: Array.isArray(nlp.sentences) ? nlp.sentences.length : 0,
    engines: {
      kss: compactEngine(engines.kss),
      kiwipiepy: compactEngine(engines.kiwipiepy),
      pykospacing: compactEngine(engines.pykospacing)
    },
    attempts: (nlp.attempts || []).slice(0, 4)
  };
}

function compactEngine(engine) {
  if (!engine) return { ok: false };
  return {
    ok: engine.ok === true,
    engine: engine.engine || '',
    version: engine.version || '',
    error: engine.ok === true ? '' : String(engine.error || '').slice(0, 180)
  };
}

function compactReport(report) {
  return report;
}

function isHeading(text) {
  const s = String(text || '').trim();
  return new RegExp(`^[${ROMAN}]\\.\\s*\\S.{0,80}$`).test(s) ||
    /^\d{1,2}\.\s+\S.{0,80}$/.test(s) ||
    /^(참고문헌|References)$/i.test(s);
}

function isListBlock(text) {
  return /^[-*]\s+/.test(String(text || '').trim()) || /^\d{1,2}[.)]\s+/.test(String(text || '').trim());
}

function isReferenceBlock(text) {
  return /(doi|https?:\/\/|학술지|출판|교육부|보건복지부)/i.test(String(text || '')) && String(text || '').length < 420;
}

function isKeyValueBlock(text) {
  const s = String(text || '').trim();
  return /^[가-힣A-Za-z\s]{1,18}:\s*\S/.test(s) && s.length <= 120;
}

function normalizeBlankLines(text) {
  return String(text || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function bare(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

function escapeRe(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function round3(v) {
  return Number(Number(v || 0).toFixed(3));
}

function round1(v) {
  return Number(Number(v || 0).toFixed(1));
}

module.exports = {
  VERSION,
  formatDocument,
  normalizeRawWhitespace,
  protectSpans,
  restoreSpans,
  needsSpacingRepair,
  repairHeadingBreaks,
  detectLayoutProfile,
  formatNeedScore,
  contentPreservationGate
};
