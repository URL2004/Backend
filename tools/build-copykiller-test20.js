'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE_DIR = process.env.BASE_DOC_DIR;
const OUT_DIR = process.env.OUT_DIR;
const API_URL = process.env.COPYKILLER_LOCAL_API || 'http://localhost:5055/local/copykiller-humanize';
const SCORE_URL = process.env.COPYKILLER_LOCAL_SCORE_API || 'http://localhost:5055/local/copykiller-score';

const DEFAULT_SELECTED = [
  '0002', '0003', '0004', '0005', '0006',
  '0007', '0008', '0009', '0010', '0011',
  '0014', '0015', '0016', '0019', '0020',
  '0021', '0024', '0025', '0026', '0029'
];
const SELECTED = (process.env.SELECTED_INDICES || DEFAULT_SELECTED.join(','))
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);

const ORIGINAL_DOC = String.fromCharCode(50896, 47928) + '.doc';
const AFTER_DOC = String.fromCharCode(46028, 47536, 54980) + '.doc';

if (!SOURCE_DIR || !fs.existsSync(SOURCE_DIR)) {
  throw new Error('BASE_DOC_DIR is required and must exist');
}
if (!OUT_DIR) {
  throw new Error('OUT_DIR is required');
}

function originalDocPath(dir) {
  const files = fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith('.doc'));
  const byName = files.find(n => n.charCodeAt(0) === 50896);
  if (!byName) throw new Error(`original doc not found in ${dir}`);
  return path.join(dir, byName);
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

function modeForIndex(idx) {
  return Number(idx) % 2 ? 'blog' : 'assignment';
}

function safeJson(value) {
  return JSON.stringify(value == null ? '' : value);
}

function csvEscape(value) {
  const s = String(value == null ? '' : value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { ok: false, raw: text }; }
  if (!response.ok || json.ok === false) {
    throw new Error(`${url} failed: ${response.status} ${JSON.stringify(json).slice(0, 1200)}`);
  }
  return json;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dirs = fs.readdirSync(SOURCE_DIR).filter(n => /^\d{4}_/.test(n)).sort();
  const byIndex = new Map(dirs.map(d => [d.slice(0, 4), d]));
  const summary = [];

  for (let i = 0; i < SELECTED.length; i += 1) {
    const idx = SELECTED[i];
    const dirName = byIndex.get(idx);
    if (!dirName) throw new Error(`source dir not found for ${idx}`);
    const sourceSubdir = path.join(SOURCE_DIR, dirName);
    const originalPath = originalDocPath(sourceSubdir);
    const originalRtf = fs.readFileSync(originalPath, 'utf8');
    const sourceText = rtfToText(originalRtf);
    const mode = modeForIndex(idx);
    const outSubdir = path.join(OUT_DIR, `${idx}_${mode}_${sourceText.length}chars`);
    fs.mkdirSync(outSubdir, { recursive: true });

    fs.copyFileSync(originalPath, path.join(outSubdir, ORIGINAL_DOC));

    console.log(`[${i + 1}/${SELECTED.length}] ${idx} ${mode} ${sourceText.length} chars`);
    const result = await postJson(API_URL, {
      text: sourceText,
      mode,
      variants: sourceText.length > 2500 ? 1 : 2,
      rounds: sourceText.length > 2500 ? 1 : 2,
      strength: 'ck-average-drop'
    });

    const score = await postJson(SCORE_URL, {
      source: sourceText,
      outputText: result.outputText,
      mode
    });

    const finalOutputText = result.outputText;
    const finalScore = score;
    fs.writeFileSync(path.join(outSubdir, AFTER_DOC), makeRtf(result.outputText), 'utf8');

    fs.writeFileSync(path.join(outSubdir, 'meta.json'), JSON.stringify({
      index: idx,
      sourceDir: dirName,
      mode,
      sourceChars: sourceText.length,
      outputChars: finalOutputText.length,
      copykillerProxy: finalScore.copykillerProxy,
      generatedCopykillerProxy: result.copykillerProxy,
      meta: result.meta,
      chunks: result.chunks,
      warnings: result.warnings || []
    }, null, 2), 'utf8');

    summary.push({
      index: idx,
      mode,
      sourceDir: dirName,
      sourceChars: sourceText.length,
      outputChars: finalOutputText.length,
      baselineRisk: finalScore.sourceBaselineProxy.copykillerRisk,
      outputRisk: finalScore.copykillerProxy.copykillerRisk,
      deltaVsSource: finalScore.copykillerProxy.deltaVsSource,
      improvedVsSource: finalScore.copykillerProxy.improvedVsSource,
      semanticScore: finalScore.copykillerProxy.semanticScore,
      aiTagRisk: finalScore.copykillerProxy.aiTagRisk,
      retainedNgramRatio: finalScore.copykillerProxy.retainedNgramRatio,
      boilerplateRisk: finalScore.copykillerProxy.boilerplateRisk,
      warnings: (finalScore.copykillerProxy.warnings || []).join('|')
    });
  }

  const csvHeader = [
    'index', 'mode', 'sourceDir', 'sourceChars', 'outputChars',
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
