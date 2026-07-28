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
const inputPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-internal-low-output.md');
const outPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-calibrated-rewrite-output.md');
const sumPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-calibrated-rewrite-summary.json');

async function main() {
  const rawText = fs.readFileSync(rawPath, 'utf8');
  const current = fs.readFileSync(inputPath, 'utf8');
  const before = proxy.measure(current, { rawText, mode: 'assignment' });

  const system = [
    '너는 한국어 대학 과제 편집자다. 목표는 카피킬러가 잡은 "간접 화법, 비인칭 서술 / 기계적 정확성 및 균일성 / 지나친 요약 및 압축 서술 / 구체적 근거 부족 / 추상적 일반론" 신호를 줄이는 것이다.',
    '하지만 점수만 낮추려고 사실을 만들면 실패다. 원문과 현재 글에 있는 법률명, 연도, 조문 번호, 수치, 기관, 선행연구자, 개정 방향은 보존한다.',
    '출력은 수정된 본문 전체만. 설명, 표, 코드펜스, 변경요약 금지.',
    '',
    '[강한 편집 원칙]',
    '1. 법률 해설서처럼 "법은 A를 규정한다, B를 명시한다, C를 보장한다"가 연속되는 구조를 피한다.',
    '2. 각 법률 파트는 "내가 이 자료를 읽으며 어디서 막힘을 봤는지"가 보이게 쓴다. 개인 경험은 만들지 말고, 근거 해석만 1인칭 판단으로 쓴다.',
    '3. 반복 제목과 보고서 템플릿을 없앤다. 대제목은 제목, Ⅰ. 서론, Ⅱ. 본론, 세 법률명, Ⅲ. 결론, 참고문헌 정도만 둔다.',
    '4. 짧은 핵심 문장과 긴 설명 문장을 섞는다. 모든 문장을 같은 길이의 "~다" 해설문으로 끝내지 않는다.',
    '5. 한 문단에 법률 용어가 몰리면 안 된다. 조문 설명 뒤에는 "그래서 실제 신청/심의/상담/예산 편성에서 무엇이 막히는지"를 원문 범위 안에서 풀어 쓴다.',
    '6. 목록식 "첫째/둘째/셋째/제1단계"는 되도록 없애고, 필요한 단계 설명은 자연 문단으로 연결한다.',
    '7. 따옴표로 키워드를 장식하지 마라. 따옴표는 원문 인용이나 법 문구에만 쓴다.',
    '8. 참고문헌은 별도 줄로 정리한다. 본문 마지막 문장과 붙이지 않는다.',
    '',
    '[금지]',
    '- 새 사례, 새 통계, 새 판례, 새 연구자, 새 기관명 추가 금지',
    '- 블로그체, 존댓말, 감탄문, 독자 호명 금지',
    '- 원문보다 훨씬 짧게 요약 금지',
    '- "필자가 보기에" 반복 금지',
  ].join('\n');

  const user = [
    '[원문: 사실 보존 기준]',
    rawText,
    '',
    '[현재 외부 카피킬러 94% 계열 후보: 이 글을 다시 편집]',
    current,
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
          stanceRatio: r.stanceRatio,
          concreteRatio: r.concreteRatio,
          abstractRiskRatio: r.abstractRiskRatio,
          compression: r.compression,
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
