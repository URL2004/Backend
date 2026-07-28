'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE_DIR = process.env.SOURCE_DOC_DIR || process.env.BASE_DOC_DIR;
const OUT_DIR = process.env.OUT_DIR;
const API_URL = process.env.COPYKILLER_LOCAL_API || 'http://localhost:5055/local/copykiller-humanize';
const SCORE_URL = process.env.COPYKILLER_LOCAL_SCORE_API || 'http://localhost:5055/local/copykiller-score';
const COUNT = Math.max(1, Math.round(Number(process.env.COUNT || 50)));
const START_INDEX = Math.max(0, Math.round(Number(process.env.START_INDEX || 31)));
const STRENGTH = process.env.COPYKILLER_TEST_STRENGTH || 'ck-average-drop-v6.7-rise-guard';
const FORCE_VARIANTS = Math.round(Number(process.env.COPYKILLER_TEST_VARIANTS || 0));
const FORCE_ROUNDS = Math.round(Number(process.env.COPYKILLER_TEST_ROUNDS || 0));
const SELECTED_INDICES = String(process.env.SELECTED_INDICES || '')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);

const ORIGINAL_SUFFIX = String.fromCharCode(50896, 47928);
const AFTER_SUFFIX = String.fromCharCode(46028, 47536, 54980);
const ORIGINAL_DOC = `${ORIGINAL_SUFFIX}.doc`;
const AFTER_DOC = `${AFTER_SUFFIX}.doc`;

if (!SOURCE_DIR || !fs.existsSync(SOURCE_DIR)) {
  throw new Error('SOURCE_DOC_DIR or BASE_DOC_DIR is required and must exist');
}
if (!OUT_DIR) {
  throw new Error('OUT_DIR is required');
}

function walkDocs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDocs(full, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.doc')) {
      out.push(full);
    }
  }
  return out;
}

function sourceIndex(file) {
  const name = path.basename(file);
  const m = name.match(/^(\d{4})[_-]/) || path.basename(path.dirname(file)).match(/^(\d{4})[_-]/);
  return m ? m[1] : '';
}

function isOriginalDoc(file) {
  const name = path.basename(file);
  return name === ORIGINAL_DOC || name.includes(`_${ORIGINAL_SUFFIX}.doc`);
}

function rtfToText(rtf) {
  let s = String(rtf || '');
  s = s.replace(/\{\\fonttbl(?:[^{}]|\{[^{}]*\})*\}/g, '');
  s = s.replace(/\{\\colortbl(?:[^{}]|\{[^{}]*\})*\}/g, '');
  s = s.replace(/\\u(-?\d+)\??/g, (_, n) => {
    const code = Number(n);
    return String.fromCharCode(code < 0 ? code + 65536 : code);
  });
  s = s.replace(/\\(?:par|line)\b[^\S\r\n]*/g, '\n');
  s = s.replace(/\\'[0-9a-fA-F]{2}/g, '');
  s = s.replace(/\\[a-zA-Z]+-?\d* ?/g, '');
  s = s.replace(/\\([{}\\])/g, '$1');
  s = s.replace(/[{}]/g, '');
  return s
    .replace(/\r/g, '')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function rtfEscape(text) {
  let out = '';
  for (const ch of String(text || '')) {
    if (ch === '\r') continue;
    if (ch === '\n') {
      out += '\\par\n';
      continue;
    }
    const code = ch.charCodeAt(0);
    if (ch === '\\' || ch === '{' || ch === '}') {
      out += '\\' + ch;
    } else if (code >= 0x20 && code <= 0x7e) {
      out += ch;
    } else {
      const signed = code > 32767 ? code - 65536 : code;
      out += `\\u${signed}?`;
    }
  }
  return out;
}

function makeRtf(text) {
  return [
    '{\\rtf1\\ansi\\ansicpg949\\uc1\\deff0',
    '{\\fonttbl{\\f0 Malgun Gothic;}}',
    '\\paperw11906\\paperh16838\\margl1440\\margr1440\\margt1440\\margb1440',
    '\\f0\\fs21',
    rtfEscape(text),
    '}'
  ].join('\n');
}

function compactTextForBuild(value) {
  return String(value || '').replace(/\s+/g, '');
}

function inferMode(text, index) {
  const s = String(text || '');
  if (/(지원|입사|자기소개|본 연구|논문|보고서|제\s*\d+\s*장|수업|과제|학급|학교|직업기초능력)/.test(s)) {
    return 'assignment';
  }
  if (/(나는|저는).{0,80}(느꼈|생각|읽고|방문|궁금|좋았다|싫었다)/.test(s)) {
    return 'blog';
  }
  return Number(index) % 2 ? 'blog' : 'assignment';
}

function csvEscape(value) {
  const s = String(value == null ? '' : value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function postJson(url, body) {
  const attempts = Math.max(1, Math.min(5, Math.round(Number(process.env.COPYKILLER_TEST_API_RETRIES || 3))));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body)
      });
      const text = await response.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { ok: false, raw: text }; }
      if (!response.ok || json.ok === false) {
        const err = new Error(`${url} failed: ${response.status} ${JSON.stringify(json).slice(0, 1200)}`);
        err.retryable = response.status >= 500;
        throw err;
      }
      return json;
    } catch (err) {
      lastError = err;
      const retryable = err?.retryable === true || /fetch failed|timeout|ECONNRESET|ETIMEDOUT/i.test(err?.message || '');
      if (!retryable || attempt >= attempts) break;
      await new Promise(resolve => setTimeout(resolve, 700 * attempt));
    }
  }
  throw lastError;
}

function selectSourceFiles() {
  const all = walkDocs(SOURCE_DIR)
    .filter(isOriginalDoc)
    .map(file => ({ file, index: sourceIndex(file) }))
    .filter(row => row.index);
  const byIndex = new Map();
  for (const row of all.sort((a, b) => a.index.localeCompare(b.index) || a.file.localeCompare(b.file))) {
    if (!byIndex.has(row.index)) byIndex.set(row.index, row.file);
  }
  const indices = SELECTED_INDICES.length
    ? SELECTED_INDICES
    : [...byIndex.keys()].filter(index => Number(index) >= START_INDEX).slice(0, COUNT);
  return indices.map(index => {
    const file = byIndex.get(index);
    if (!file) throw new Error(`source original doc not found for index ${index}`);
    return { index, file };
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const selected = selectSourceFiles();
  if (selected.length < COUNT && !SELECTED_INDICES.length) {
    throw new Error(`not enough source files: ${selected.length}/${COUNT}`);
  }
  const summary = [];

  for (let i = 0; i < selected.length; i += 1) {
    const { index, file } = selected[i];
    const sourceText = rtfToText(fs.readFileSync(file, 'utf8'));
    const mode = inferMode(sourceText, index);
    const prefix = `${index}_${mode}`;
    console.log(`[${i + 1}/${selected.length}] ${prefix} ${sourceText.length} chars`);

    fs.copyFileSync(file, path.join(OUT_DIR, `${prefix}_${ORIGINAL_SUFFIX}.doc`));
    const result = await postJson(API_URL, {
      text: sourceText,
      mode,
      variants: FORCE_VARIANTS > 0 ? FORCE_VARIANTS : 2,
      rounds: FORCE_ROUNDS > 0 ? FORCE_ROUNDS : 1,
      strength: STRENGTH
    });

    const afterPath = path.join(OUT_DIR, `${prefix}_${AFTER_SUFFIX}.doc`);
    const lowScoreGuard = result?.meta?.lowScoreGuard === true || compactTextForBuild(result.outputText) === compactTextForBuild(sourceText);
    if (lowScoreGuard) {
      fs.copyFileSync(file, afterPath);
    } else {
      fs.writeFileSync(afterPath, makeRtf(result.outputText), 'utf8');
    }
    const score = await postJson(SCORE_URL, {
      source: sourceText,
      outputText: result.outputText,
      mode
    });

    summary.push({
      index,
      mode,
      sourceFile: file,
      sourceChars: sourceText.length,
      outputChars: result.outputText.length,
      baselineRisk: score.sourceBaselineProxy.copykillerRisk,
      outputRisk: score.copykillerProxy.copykillerRisk,
      deltaVsSource: score.copykillerProxy.deltaVsSource,
      improvedVsSource: score.copykillerProxy.improvedVsSource,
      semanticScore: score.copykillerProxy.semanticScore,
      aiTagRisk: score.copykillerProxy.aiTagRisk,
      retainedNgramRatio: score.copykillerProxy.retainedNgramRatio,
      boilerplateRisk: score.copykillerProxy.boilerplateRisk,
      warnings: (score.copykillerProxy.warnings || []).join('|')
    });
  }

  const csvHeader = [
    'index', 'mode', 'sourceFile', 'sourceChars', 'outputChars',
    'baselineRisk', 'outputRisk', 'deltaVsSource', 'improvedVsSource',
    'semanticScore', 'aiTagRisk', 'retainedNgramRatio', 'boilerplateRisk', 'warnings'
  ];
  const csv = [
    csvHeader.join(','),
    ...summary.map(row => csvHeader.map(k => csvEscape(row[k])).join(','))
  ].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'summary.csv'), csv, 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  const improved = summary.filter(r => r.improvedVsSource).length;
  const avgDelta = summary.reduce((sum, r) => sum + Number(r.deltaVsSource || 0), 0) / Math.max(1, summary.length);
  console.log(`DONE improved=${improved}/${summary.length} avgDelta=${avgDelta.toFixed(2)}`);
}

main().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
