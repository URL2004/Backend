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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
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
process.env.LLM_SHADOW_MODE = '0';
process.env.GEMINI_ALLOW_CLAUDE_SHADOW = '0';
process.env.ASSIGNMENT_B7 = '1';
process.env.FORMAL_HUMAN = '0';
process.env.COPYKILLER_PROXY = '1';
process.env.GEMINI_SEARCH_GROUNDING = '0';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED || '0';

const { llmText } = require('../engine/judge');
const proxy = require('../engine/copykillerproxy');
const floor = require('../engine/floor');
const reg = require('../engine/registerscore');
const { b7PolishPass } = require('../engine/b7polish');

const rawPath = 'C:/Users/dbvision10/.codex/attachments/21f0695a-375d-4b94-9e77-1f166600edc2/pasted-text.txt';
const inputPath = path.join(root, 'results/gemini-local-runs/experiment-subheads_lex_anchors_hotspots_conclusion_grammar.md');
const outPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-b7-output.md');
const sumPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-b7-summary.json');

async function main() {
  const rawText = fs.readFileSync(rawPath, 'utf8');
  const current = fs.readFileSync(inputPath, 'utf8');
  const before = proxy.measure(current, { rawText, mode: 'assignment' });

  const system = [
    '너는 한국어 학부생 보고서 편집자다.',
    '현재 글은 카피킬러에서 법률 해설문처럼 너무 균일하고 비인칭적이라는 신호가 강하게 나왔다.',
    '목표는 내용을 보존하면서 글 전체를 자연스러운 학부생 존댓말 보고서로 바꾸는 것이다.',
    '',
    '[절대 보존]',
    '법률명, 연도, 조문 번호, 수치, 기관명, 연구자명, 참고문헌, 핵심 주장, 개정 방향은 보존한다.',
    '새 사례, 새 통계, 새 판례, 새 연구자, 새 기관, 개인 경험은 만들지 않는다.',
    '',
    '[문체]',
    '1. 모든 문장을 ~합니다/~입니다/~했습니다 중심의 존댓말 보고서체로 쓴다.',
    '2. "저는/제 생각에는/제가 보기에는"은 전체 3~5회만 사용한다.',
    '3. 같은 표현을 반복하지 말고, "~인 것 같습니다/~로 보입니다/~지도 모릅니다/~지 않을까요" 같은 완곡 표현을 소량 섞는다.',
    '4. 법률 용어가 몰리는 문단은 두 문단으로 나누고, 한 문장에 법률 용어를 여러 개 밀어 넣지 않는다.',
    '5. 하위 소제목 "가/나/다/라/마"와 조문안 표제는 없애고 자연 문단으로 흡수한다.',
    '6. 본문과 참고문헌은 반드시 분리한다.',
    '7. 따옴표 키워드 장식은 쓰지 않는다.',
    '',
    '출력은 수정된 본문 전체만. 설명, 표, 코드펜스 금지.',
  ].join('\n');

  const user = [
    '[원문 - 사실 보존 기준]',
    rawText,
    '',
    '[현재 글 - 존댓말 보고서체로 재작성]',
    current,
  ].join('\n');

  const draft = String(await llmText({
    system,
    user,
    maxTokens: 20000,
    task: 'rewrite',
    mode: 'assignment',
    riskLevel: 'high',
    textLength: current.replace(/\s+/g, '').length,
  }) || '').trim();

  const polished = await b7PolishPass(draft, rawText, { floor });
  const outputText = polished.text || draft;
  fs.writeFileSync(outPath, outputText, 'utf8');

  const after = proxy.measure(outputText, { rawText, mode: 'assignment' });
  const floorReport = floor.buildFloorReport({ result: { outputText }, rawText, mode: 'assignment' });
  const b7 = reg.measureB7Formal(outputText);
  const summary = {
    input: path.relative(root, inputPath),
    output: path.relative(root, outPath),
    before: {
      score: before.score,
      aiRate: before.aiSuspicion.predictedAiRate,
      levels: before.aiSuspicion.levels,
    },
    after: {
      score: after.score,
      qualityGate: after.qualityGate,
      aiRate: after.aiSuspicion.predictedAiRate,
      levels: after.aiSuspicion.levels,
      b7,
      polish: { repaired: polished.repaired, attempted: polished.attempted },
    },
    floor: { status: floorReport.status, criticals: floorReport.criticals },
  };
  fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
