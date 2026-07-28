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

const rawText = `혈흔 분석은 실제 법의학 및 과학수사 현장에서 사건 당시의 상황을 재구성하는 데 활용된다. 혈액이 남긴 흔적은 단순한 얼룩이 아니라, 혈액 방울이 어느 방향에서 이동했는지, 어떤 각도로 표면에 충돌했는지, 충돌 당시 속도와 힘의 크기가 어느 정도였는지를 추정할 수 있는 물리적 증거가 된다. 예를 들어 혈액이 바닥이나 벽면에 수직으로 가까이 떨어진 경우에는 비교적 원형의 혈흔이 만들어지고, 비스듬히 날아와 충돌한 경우에는 진행 방향으로 길게 늘어난 타원형 혈흔이 형성된다. 따라서 혈흔의 길이와 너비를 측정하면 혈액 방울이 표면과 이루며 충돌한 각도를 계산할 수 있고, 여러 혈흔의 방향을 종합하면 혈액이 발생한 위치나 피해자와 가해자의 상대적 위치를 추정하는 데 도움을 줄 수 있다.

특히 강한 외력이 작용한 사건에서는 혈액이 한 지점에만 떨어지는 것이 아니라 여러 방향으로 튀어 다양한 크기와 모양의 혈흔을 남긴다. 이때 혈흔의 분포를 분석하면 단순히 “피가 묻었다”는 사실을 넘어서, 혈액이 튄 방향, 충격이 가해진 위치, 반복적인 충격 여부 등을 추정할 수 있다. 예를 들어 벽면에 길게 늘어난 혈흔들이 일정한 방향성을 보이면 혈액이 날아온 방향을 알 수 있고, 여러 혈흔의 장축을 연장하여 만나는 지점을 찾으면 혈액이 시작된 대략적인 위치를 추정할 수 있다. 이러한 분석은 사건 현장 진술이 실제 물리적 증거와 일치하는지 확인하는 데 사용될 수 있다.

또한 혈흔 분석은 부검 결과와 함께 활용될 때 더 큰 의미를 가진다. 법의학자는 시신의 상처 위치, 손상 방향, 사망 원인 등을 의학적으로 판단하고, 현장에 남은 혈흔 패턴은 그 판단을 보완하는 물리적 근거가 된다. 예를 들어 시신의 손상 방향과 현장의 혈흔 방향이 서로 일치한다면 사건 재구성의 신뢰도가 높아질 수 있다. 반대로 진술과 혈흔의 방향, 분포, 충돌각이 맞지 않는다면 사건이 다르게 진행되었을 가능성을 검토할 수 있다. 이처럼 혈흔 분석은 법의학자가 사망 원인을 밝히고 사건의 진실에 접근하는 과정에서 중요한 보조 자료가 된다.

그러나 혈흔 분석은 단독으로 사건을 단정하는 도구가 아니라, 다른 증거와 함께 종합적으로 해석해야 한다. 실제 혈액은 물보다 점성이 크고, 표면장력도 작용하며, 바닥이나 벽의 재질, 표면의 거칠기, 흡수성, 혈액 방울의 크기 등에 따라 혈흔의 모양이 달라질 수 있다. 같은 각도로 떨어진 혈액이라도 유리, 종이, 천, 콘크리트와 같은 표면에서는 서로 다른 흔적을 남길 수 있다. 따라서 혈흔 분석을 정확히 활용하려면 물리학의 운동, 에너지, 힘, 유체의 성질을 이해하는 것뿐만 아니라 실험 조건과 한계까지 고려하는 태도가 필요하다. 이 점에서 혈흔 분석은 법의학이 생명과학, 의학뿐만 아니라 물리학적 사고와도 밀접하게 연결되어 있음을 보여주는 사례라고 할 수 있다.`;

const outPath = path.join(root, 'results/gemini-local-runs/latest-bloodstain-analysis-output.md');
const sumPath = path.join(root, 'results/gemini-local-runs/latest-bloodstain-analysis-summary.json');
const srcPath = path.join(root, 'results/gemini-local-runs/latest-bloodstain-analysis-source.md');

async function main() {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(srcPath, rawText, 'utf8');

  const run = await analyze.runHumanizeChunked({
    text: rawText,
    mode: 'assignment',
    lang: 'ko',
    floorV2: true,
    judge: true,
    grounding: false,
    antiDetect: false,
    tonePolish: false
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
    geminiFormalAcceptance: run.result?.geminiFormalAcceptance || null,
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
