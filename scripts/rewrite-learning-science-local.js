const fs = require('fs');
const path = require('path');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const root = path.resolve(__dirname, '..');
loadEnv(path.resolve(root, '.env.local.gemini'));
loadEnv(path.resolve(root, '..', 'Backend', '.env.local.gemini'));

process.env.LLM_BACKEND = 'gemini';
process.env.LLM_CLAUDE_FALLBACK = '0';
process.env.GEMINI_EXPLICIT_CACHE = '1';
process.env.GEMINI_CACHE_TTL = process.env.GEMINI_CACHE_TTL || '3600s';
process.env.GEMINI_EXPLICIT_CACHE_MIN_CHARS =
  !process.env.GEMINI_EXPLICIT_CACHE_MIN_CHARS || process.env.GEMINI_EXPLICIT_CACHE_MIN_CHARS === '6000'
    ? '2500'
    : process.env.GEMINI_EXPLICIT_CACHE_MIN_CHARS;
process.env.GEMINI_CACHE_PERSIST = process.env.GEMINI_CACHE_PERSIST || '1';
process.env.GEMINI_EVADE_STRENGTH = process.env.GEMINI_EVADE_STRENGTH || '1';
process.env.GEMINI_ASSIGNMENT_PROFILE = process.env.GEMINI_ASSIGNMENT_PROFILE || 'source_bound';
process.env.GEMINI_CREATIVE_PASSES = process.env.GEMINI_CREATIVE_PASSES || '0';
process.env.GEMINI_COPYKILLER_BLOCK = process.env.GEMINI_COPYKILLER_BLOCK || '0';
process.env.GEMINI_THINKING_REPAIR = process.env.GEMINI_THINKING_REPAIR || 'minimal';
process.env.REGISTER = process.env.REGISTER || '0';
process.env.FORMAL_HUMAN = process.env.FORMAL_HUMAN || '0';
process.env.COPYKILLER_PROXY = '1';
process.env.GEMINI_SEARCH_GROUNDING = '0';
process.env.LLM_SHADOW_MODE = '0';
process.env.GEMINI_ALLOW_CLAUDE_SHADOW = '0';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED || '0';

const analyze = require('../routes/analyze');
const proxy = require('../engine/copykillerproxy');

const rawPath = 'C:/Users/dbvision10/.codex/attachments/2214558c-4d3a-401c-b1a4-f61d0de8d3be/pasted-text.txt';
const outPath = path.join(root, 'results/gemini-local-runs/latest-learning-science-engine-output.md');
const sumPath = path.join(root, 'results/gemini-local-runs/latest-learning-science-engine-summary.json');
const srcPath = path.join(root, 'results/gemini-local-runs/latest-learning-science-engine-source.md');

async function main() {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const rawText = fs.readFileSync(rawPath, 'utf8').trim();
  fs.writeFileSync(srcPath, rawText, 'utf8');

  const run = await analyze.runHumanize({
    text: rawText,
    mode: 'assignment',
    lang: 'ko',
    floorV2: true,
    judge: true,
    grounding: false,
    antiDetect: false
  });

  const outputText = String(run?.result?.outputText || '').trim();
  fs.writeFileSync(outPath, outputText, 'utf8');

  const before = proxy.measure(rawText, { rawText, mode: 'assignment' });
  const after = proxy.measure(outputText, { rawText, mode: 'assignment' });
  const summary = {
    source: srcPath,
    output: outPath,
    mode: 'assignment',
    status: run.status,
    refineReason: run.refineReason,
    floorReport: run.floorReport,
    copykillerProxy: run.copykillerProxy || run.result?.copykillerProxy || null,
    surface: run.surface || null,
    inputRisk: run.inputRisk || null,
    before: {
      score: before.score,
      aiSuspicion: before.aiSuspicion
    },
    after: {
      score: after.score,
      qualityGate: after.qualityGate,
      aiSuspicion: after.aiSuspicion
    }
  };
  fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2), 'utf8');

  console.log(JSON.stringify({
    source: path.relative(root, srcPath),
    output: path.relative(root, outPath),
    summary: path.relative(root, sumPath),
    status: run.status,
    refineReason: run.refineReason,
    afterAiRate: after.aiSuspicion.predictedAiRate,
    levels: after.aiSuspicion.levels,
    blocked: after.qualityGate.blocked,
    floorCriticials: run.floorReport?.criticals || []
  }, null, 2));
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
