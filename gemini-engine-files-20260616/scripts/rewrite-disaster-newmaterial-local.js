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
process.env.GEMINI_EVADE_STRENGTH = process.env.GEMINI_EVADE_STRENGTH || '2';
process.env.GEMINI_ASSIGNMENT_PROFILE = process.env.GEMINI_ASSIGNMENT_PROFILE || 'rewrite_loose';
process.env.GEMINI_PRESERVATION_RATE = process.env.GEMINI_PRESERVATION_RATE || 'loose';
process.env.GEMINI_ABSTRACT_SOURCE_BOUND = process.env.GEMINI_ABSTRACT_SOURCE_BOUND || '0';
process.env.GEMINI_CREATIVE_PASSES = process.env.GEMINI_CREATIVE_PASSES || '1';
process.env.GEMINI_COPYKILLER_BLOCK = process.env.GEMINI_COPYKILLER_BLOCK || '0';
process.env.GEMINI_THINKING_REPAIR = process.env.GEMINI_THINKING_REPAIR || 'minimal';
process.env.REGISTER = process.env.REGISTER || '0';
process.env.FORMAL_HUMAN = process.env.FORMAL_HUMAN || '0';
process.env.COPYKILLER_PROXY = '1';
process.env.GEMINI_SEARCH_GROUNDING = process.env.GEMINI_SEARCH_GROUNDING || '1';
process.env.GEMINI_WEB_EVIDENCE = process.env.GEMINI_WEB_EVIDENCE || '1';
process.env.GEMINI_WEB_EVIDENCE_MAX = process.env.GEMINI_WEB_EVIDENCE_MAX || '3';
process.env.GEMINI_WEB_EVIDENCE_WEAVE = process.env.GEMINI_WEB_EVIDENCE_WEAVE || '0';
process.env.LLM_SHADOW_MODE = '0';
process.env.GEMINI_ALLOW_CLAUDE_SHADOW = '0';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED || '0';

const analyze = require('../routes/analyze');
const proxy = require('../engine/copykillerproxy');

const rawText = `Ⅰ. 서론
현대 사회의 재난은 더 이상 자연재해나 단순한 사고에 한정되지 않는다. 감염병, 기후위기, 환경문제와 같은 현대적 재난은 인간의 활동, 기술, 물질, 사회구조가 복합적으로 얽히며 발생한다. 특히 코로나19 팬데믹은 전 세계적으로 심각한 인명 피해와 사회적 혼란을 초래하면서, 재난관리행정이 단순한 통제나 대응을 넘어 다양한 관계를 조정하는 과정임을 보여주었다.

기존의 재난관리행정은 대체로 정부와 공공기관을 중심으로 재난을 예측하고 통제하는 방식에 초점을 두어 왔다. 이러한 관점에서 인간은 관리의 주체가 되며, 자연·물질·기술은 관리의 대상 또는 수단으로 이해되었다. 그러나 신유물론은 이러한 인간 중심적 사고를 비판하며, 인간뿐 아니라 바이러스, 물질, 기술과 같은 비인간 요소들도 사회와 정책의 형성에 영향을 미치는 존재라고 본다. 다시 말해, 재난은 인간의 의지와 제도만으로 설명되는 것이 아니라, 다양한 인간적·비인간적 요소들의 상호작용 속에서 형성된다.

신유물론은 이러한 특징을 능동성, 횡단성, 우발성이라는 개념을 통해 설명한다. 코로나19 팬데믹은 이러한 관점에서 재난관리행정을 새롭게 해석할 수 있는 대표적 사례이다. 이 글은 코로나19 재난관리행정을 능동성, 횡단성, 우발성의 측면에서 분석하고, 이를 통해 현대 재난관리행정의 성격을 살펴보고자 한다.

Ⅱ. 본론
1. 능동성: 코로나19 재난관리행정에서 비인간 요소의 작용
신유물론의 첫 번째 핵심 개념은 능동성이다. 전통적인 관점에서는 물질이나 비인간 존재를 인간이 통제하는 수동적 대상으로 이해하였다. 반면 신유물론은 물질 역시 현실 형성에 영향을 미치는 능동적 요소라고 본다. 즉, 사회는 인간의 의도와 계획만으로 구성되는 것이 아니라 인간과 비인간 요소가 함께 작용하는 과정 속에서 형성된다.

코로나19 팬데믹에서 바이러스는 단순한 질병의 원인을 넘어 사회 전반의 변화를 이끄는 행위자로 작용하였다. 바이러스의 높은 전염성과 변이 가능성은 사람들의 이동 방식과 접촉 양식을 변화시켰으며, 정부로 하여금 사회적 거리두기, 집합 제한, 마스크 착용 의무화와 같은 다양한 방역정책을 시행하도록 만들었다. 특히 델타 변이와 오미크론 변이의 등장은 정책 결정의 방향 자체를 조정하게 만들었다. 이는 재난관리행정이 인간의 일방적 통제만으로 이루어지는 것이 아니라, 바이러스라는 비인간 요소의 작용에 의해 지속적으로 영향을 받는다는 점을 보여준다.

또한 마스크, 백신, 진단키트와 같은 물질적 요소들도 재난관리행정의 중요한 행위자로 기능하였다. 팬데믹 초기 마스크 공급 부족은 사회적 불안을 심화시켰고, 정부는 공적 마스크 제도를 통해 물자 관리에 직접 개입하였다. 이후 진단키트의 개발은 조기 진단과 확진자 선별을 가능하게 하였으며, 백신의 보급은 방역정책의 중심을 감염 억제에서 일상 회복으로 이동시키는 계기가 되었다. 이러한 사례는 코로나19 대응이 정부의 의지만으로 이루어진 것이 아니라, 바이러스와 의료물자, 기술적 조건이 함께 작용한 결과였음을 보여준다.

2. 횡단성: 인간과 비인간의 네트워크 속에서 이루어진 재난관리행정
신유물론의 두 번째 핵심 개념은 횡단성이다. 횡단성은 인간과 비인간, 자연과 사회, 기술과 제도의 경계가 고정되어 있지 않으며, 서로 연결되고 관통된다는 점을 강조한다. 따라서 하나의 사회 현상은 독립된 단일 주체에 의해 발생하는 것이 아니라, 다양한 존재와 체계가 맺는 관계망 속에서 형성된다.

코로나19 대응 과정은 이러한 횡단성이 뚜렷하게 드러난 사례이다. 재난관리행정은 정부와 공무원의 일방적 조치만으로 작동하지 않았다. 의료진, 시민, 데이터 시스템, 스마트폰 애플리케이션 등 다양한 요소가 복합적으로 연결되면서 대응 체계가 형성되었다. 예를 들어 전자출입명부와 QR코드 시스템은 행정기관의 정책 결정만으로 운영될 수 없었다. 이 시스템은 스마트폰 기술, 통신망, 플랫폼 서비스, 사업장의 협조, 시민의 참여가 결합될 때 비로소 작동할 수 있었다. 이는 재난관리행정이 인간의 독립적인 영역이 아니라 기술, 물질, 제도, 시민 실천이 횡단적으로 결합된 네트워크라는 사실을 보여준다.

더 나아가 코로나19는 보건 영역에만 머물지 않고 경제, 복지, 교육 등 여러 영역으로 영향을 확산시켰다. 예를 들어 긴급재난지원금 정책은 방역 문제가 동시에 경제정책이자 복지정책의 문제로 확장될 수 있음을 보여주었다. 따라서 코로나19 재난관리행정은 단일한 행정 영역에 국한되지 않으며, 사회의 여러 영역을 가로지르는 횡단적 성격을 가진다고 볼 수 있다.

3. 우발성: 예측 불가능성과 유연한 대응의 필요성
신유물론의 세 번째 핵심 개념은 우발성이다. 우발성은 사회 현상이 사전에 정해진 방식대로 전개되지 않으며, 예상하지 못한 방향으로 변화할 수 있음을 의미한다. 이는 세계가 인간의 합리적 계획만으로 운영되지 않으며, 불확실성과 비예측성이 사회를 구성하는 중요한 특징임을 보여준다.

코로나19 팬데믹은 이러한 우발성을 분명하게 드러낸 재난이었다. 감염병 발생 초기에는 많은 국가가 상황이 비교적 짧은 기간 안에 종료될 수 있다고 예상하였다. 그러나 실제로는 델타 변이와 오미크론 변이의 등장으로 상황이 예상과 다른 방향으로 전개되었다. 감염 확산 속도와 중증화율의 변화는 기존 정책의 수정과 재조정을 반복적으로 요구하였다.

이러한 우발성은 재난관리행정의 운영 방식에도 직접적인 영향을 미쳤다. 사회적 거리두기 정책은 감염 상황에 따라 강화되거나 완화되었고, 자가격리 제도와 검사 체계 역시 지속적으로 조정되었다. 백신 접종 정책 또한 일괄적인 계획에 따라 진행된 것이 아니라, 백신 수급 상황, 부작용 우려, 연령별 위험도, 변이의 특성 등을 반영하여 유동적으로 변경되었다. 이는 재난관리행정이 사전에 마련된 계획을 단순히 집행하는 행정이 아니라, 예측하기 어려운 상황에 적응하고 새로운 조건에 따라 계속 변화하는 행정임을 보여준다. 신유물론은 이러한 우발성을 예외적 상황으로 보지 않고, 오히려 사회를 구성하는 중요한 조건으로 이해한다. 따라서 코로나19는 재난관리행정이 얼마나 유연하고 적응적으로 운영되어야 하는지를 보여주는 대표적 사례라고 할 수 있다.

Ⅲ. 결론
코로나19 팬데믹은 현대 사회의 재난이 인간의 통제와 계획만으로 설명될 수 없는 복합적 현상임을 분명하게 보여주었다. 신유물론의 관점에서 볼 때, 코로나19 재난관리행정은 바이러스, 백신, 마스크, 진단기술, 데이터 시스템, 시민의 참여, 정부 정책이 서로 얽혀 형성된 과정으로 이해할 수 있다.

앞서 살펴본 바와 같이, 능동성·횡단성·우발성이라는 세 가지 개념은 코로나19 재난관리행정의 특징을 설명하는 데 유효하다. 첫째, 바이러스와 백신, 의료물자 등 비인간 요소들은 정책 형성에 능동적으로 작용하였다. 둘째, 재난관리행정은 정부 단독의 영역이 아니라 기술, 물질, 제도, 시민이 횡단적으로 연결된 네트워크 속에서 작동하였다. 셋째, 변이 바이러스의 등장과 같은 예측 불가능한 상황은 정책이 지속적으로 변화하고 적응해야 함을 보여주었다.

이러한 분석을 바탕으로 볼 때, 향후 재난관리행정은 몇 가지 방향으로 나아갈 필요가 있다. 첫째, 정책 설계 과정에서 비인간 행위자의 영향력을 보다 적극적으로 고려해야 한다. 둘째, 횡단적 거버넌스 체계를 구축할 필요가 있다. 즉, 부처 간 경계를 넘어 보건, 경제, 복지, 기술 영역이 통합적으로 협력하는 체계가 요구된다. 셋째, 적응적 관리 체계를 마련해야 한다. 사전에 고정된 매뉴얼을 일방적으로 적용하기보다, 실시간으로 상황을 학습하고 대응 방식을 조정할 수 있는 유연한 시스템이 필요하다.

결국 코로나19는 재난관리행정이 더 이상 정부의 일방적 통제만으로 이루어질 수 없으며, 인간과 비인간, 제도와 기술, 계획과 우발성이 함께 작용하는 복합적 과정임을 보여주었다. 이러한 점에서 신유물론은 현대적 재난의 특성을 이해하고, 미래의 재난 대응 전략을 모색하는 데 유의미한 이론적 틀을 제공한다고 평가할 수 있다.`;

const outPath = path.join(root, 'results/gemini-local-runs/latest-disaster-newmaterial-engine-output.md');
const sumPath = path.join(root, 'results/gemini-local-runs/latest-disaster-newmaterial-engine-summary.json');
const srcPath = path.join(root, 'results/gemini-local-runs/latest-disaster-newmaterial-engine-source.md');

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
    tonePolish: false,
    webEvidence: true
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
    geminiSourceBound: run.geminiSourceBound || run.result?.geminiSourceBound || null,
    sourceBoundStructure: run.sourceBoundStructure || run.result?.sourceBoundStructureFinal || run.result?.sourceBoundStructure || null,
    webEvidence: run.webEvidence || run.result?.webEvidence || null,
    webEvidenceWeave: run.result?.webEvidenceWeave || null,
    interpretiveWeave: run.result?.interpretiveWeave || null,
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
    webEvidenceCount: (run.webEvidence?.lines || run.result?.webEvidence?.lines || []).length,
    webEvidenceWeave: run.result?.webEvidenceWeave || null,
    interpretiveWeave: run.result?.interpretiveWeave || null,
    floorCriticials: run.floorReport?.criticals || []
  }, null, 2));
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
