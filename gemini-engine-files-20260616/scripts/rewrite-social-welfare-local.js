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

const { llmText } = require('../engine/judge');
const proxy = require('../engine/copykillerproxy');
const floor = require('../engine/floor');

const rawPath = 'C:/Users/dbvision10/.codex/attachments/21f0695a-375d-4b94-9e77-1f166600edc2/pasted-text.txt';
const inputPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-retemplate-blocked-output.md');
const outPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-delegalized-output.md');
const sumPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-delegalized-summary.json');

async function main() {
  const rawText = fs.readFileSync(rawPath, 'utf8');
  const current = fs.readFileSync(inputPath, 'utf8');
  const before = proxy.measure(current, { rawText, mode: 'assignment' });

  const system = [
    '너는 한국어 대학 과제 편집자다. 목표는 법률 보고서 템플릿처럼 보이는 글을, 학생이 자료를 읽고 판단한 분석문으로 바꾸는 것이다.',
    '가장 중요한 보존 규칙: 원문과 현재 본문에 있는 법률명, 연도, 조문 번호, 수치, 출처, 핵심 주장, 개정 방향을 유지한다. 새 법률, 새 수치, 새 사례, 새 연구자는 만들지 않는다.',
    '절대 하지 말 것: 개인 경험을 지어내기, 구어체 블로그 말투, 존댓말, 감탄문, 농담, 독자 호명, 과장된 감정.',
    '반드시 할 것:',
    '1. 반복 소제목 템플릿을 제거한다. "가. 법률의 목적과 주요 내용 / 나. 현행 조문의 문제점 / 다. 개정 필요성 및 구체적 개정 조문안 / 라. 기대효과와 한계 / 마. 사회복지 실천 현장에 미치는 영향"은 모두 없애고 자연 문단으로 흡수한다.',
    '2. 대제목은 최소화한다. 제목, Ⅰ. 서론, Ⅱ. 본론, 각 법률명 대제목 3개, Ⅲ. 결론, 참고문헌 정도만 남긴다.',
    '3. 조문 해설체를 줄인다. "규정한다/명시한다/신설한다/보장한다/설정한다/적용한다/폐지한다/반영한다"가 이어지는 문장은 풀어서 쓴다. 예: "법률에 명시한다" → "법 안에 분명히 적어 두어야 한다".',
    '4. 목록식 "첫째/둘째/셋째"와 "제1단계/제2단계/제3단계"를 최소화한다. 꼭 필요한 단계 설명은 한 문단 안에서 자연스럽게 이어 쓴다.',
    '5. "필자가 보기에"를 반복하지 않는다. 대신 판단이 필요한 곳에서만 "내가 이 대목을 문제로 보는 이유는...", "여기서 걸리는 점은...", "이 부분은 그냥 선언으로 두면 안 된다"처럼 논리적 판단을 드러낸다.',
    '6. 한 문단 안에 추상명사와 법률 용어만 나열하지 말고, 왜 현장에서 막히는지 한 문장씩 붙인다. 단, 원문에 없는 구체 사례는 만들지 않는다.',
    '7. 참고문헌은 유지하되 본문과 붙이지 말고 별도 줄로 정리한다.',
    '출력은 수정된 본문 전체만. 설명, 표, 코드펜스 금지.'
  ].join('\n');

  const user = [
    '[원문 - 사실 보존 기준]',
    rawText,
    '',
    '[현재 차단 후보 - 이것을 다시 편집]',
    current
  ].join('\n');

  const outputText = await llmText({
    system,
    user,
    maxTokens: 20000,
    task: 'rewrite',
    mode: 'assignment',
    riskLevel: 'high',
    textLength: current.replace(/\s+/g, '').length,
  });

  const cleaned = String(outputText || '').trim();
  fs.writeFileSync(outPath, cleaned, 'utf8');
  const after = proxy.measure(cleaned, { rawText, mode: 'assignment' });
  const floorReport = floor.buildFloorReport({ result: { outputText: cleaned }, rawText, mode: 'assignment' });
  const summary = {
    input: inputPath,
    output: outPath,
    before: {
      score: before.score,
      aiSuspicion: {
        predictedAiRate: before.aiSuspicion.predictedAiRate,
        levels: before.aiSuspicion.levels,
        internalPass: before.aiSuspicion.internalPass,
      },
    },
    after: {
      score: after.score,
      qualityGate: after.qualityGate,
      aiSuspicion: {
        predictedAiRate: after.aiSuspicion.predictedAiRate,
        levels: after.aiSuspicion.levels,
        internalPass: after.aiSuspicion.internalPass,
        rows: after.aiSuspicion.rows.map(r => ({
          idx: r.idx,
          score: r.score,
          level: r.level,
          reasons: r.reasons,
          legalReport: r.legalReport,
          head: r.head,
        })),
      },
    },
    floorReport,
  };
  fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify({
    output: path.relative(root, outPath),
    summary: path.relative(root, sumPath),
    beforeAiRate: summary.before.aiSuspicion.predictedAiRate,
    afterAiRate: summary.after.aiSuspicion.predictedAiRate,
    levels: summary.after.aiSuspicion.levels,
    internalPass: summary.after.aiSuspicion.internalPass,
    blocked: summary.after.qualityGate.blocked,
    floorStatus: summary.floorReport.status,
    criticals: summary.floorReport.criticals,
  }, null, 2));
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
