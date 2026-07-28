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

const rawText = `학교밖청소년지원센터에서 근무하며 학교 밖 청소년의 특성과 욕구를 깊이 이해하고, 상담·프로그램 운영·자립지원 등 다양한 사업을 수행해 왔습니다. 이러한 경험은 새로운 환경에서도 빠르게 업무를 파악하고 현장에 적응할 수 있는 기반이 되었습니다. 또한, 현재 청소년지도사 1급 자격 취득을 준비하며 전문성 향상을 위해 꾸준히 노력하고 있습니다. 앞으로도 변화하는 청소년 정책과 현장의 요구를 적극적으로 학습하며 전문성을 갖춘 청소년지도사로 성장하고자 합니다. 입사 후에는 축적된 현장 경험을 바탕으로 다양한 학교밖청소년지원사업을 기획·운영하고, 신규 공모사업 발굴 및 유치를 통해 기관의 사업 영역을 확장하는 데 기여하겠습니다. 청소년의 성장과 기관의 발전을 함께 이끌 수 있는 실무형 청소년지도사가 되겠습니다.`;

const outPath = path.join(root, 'results/gemini-local-runs/latest-youth-center-resume-output.md');
const sumPath = path.join(root, 'results/gemini-local-runs/latest-youth-center-resume-summary.json');
const srcPath = path.join(root, 'results/gemini-local-runs/latest-youth-center-resume-source.md');

async function main() {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(srcPath, rawText, 'utf8');

  const run = await analyze.runHumanize({
    text: rawText,
    mode: 'resume',
    lang: 'ko',
    floorV2: true,
    judge: true,
    grounding: false,
    antiDetect: false
  });

  const outputText = String(run?.result?.outputText || '').trim();
  fs.writeFileSync(outPath, outputText, 'utf8');

  const before = proxy.measure(rawText, { rawText, mode: 'resume' });
  const after = proxy.measure(outputText, { rawText, mode: 'resume' });
  const summary = {
    source: srcPath,
    output: outPath,
    mode: 'resume',
    status: run.status,
    refineReason: run.refineReason,
    floorReport: run.floorReport,
    copykillerProxy: run.copykillerProxy || run.result?.copykillerProxy || null,
    surface: run.surface || null,
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
