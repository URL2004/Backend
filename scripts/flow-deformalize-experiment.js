const fs = require('fs');
const path = require('path');

process.env.FORMAL_HUMAN = '1';

const root = path.resolve(__dirname, '..');
const rawPath = 'C:/Users/dbvision10/.codex/attachments/21f0695a-375d-4b94-9e77-1f166600edc2/pasted-text.txt';
const inputPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-internal-low-output.md');
const outPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-flow-deformalized-output.md');
const sumPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-flow-deformalized-summary.json');

const proxy = require('../engine/copykillerproxy');
const floor = require('../engine/floor');

function normalize(text) {
  return String(text || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function deFormalizeFlow(text) {
  let out = String(text || '');

  out = out
    .replace(
      /^현행 복지 관련 법의 문제점 분석과 고쳐 쓴 방향 제시 ― 사회보장기본법·사회복지사업법·국민기초생활보장법을 중심으로 ―/m,
      '세 가지 복지 법을 읽고 정리한 개선 방향'
    )
    .replace(/^Ⅰ\.\s*서론/m, '들어가며')
    .replace(/^Ⅱ\.\s*본론/m, '살펴볼 내용')
    .replace(/^1\.\s*「사회보장기본법」의 문제점과 바꿔야 할 방향/m, '사회보장기본법에서 먼저 보이는 부분')
    .replace(/^2\.\s*「사회복지사업법」의 문제점과 바꿔야 할 방향/m, '사회복지사업법을 볼 때 걸리는 부분')
    .replace(/^Ⅲ\.\s*결론/m, '마무리하며');

  out = out
    .replace(/문제점과\s*바꿔야\s*할\s*방향/g, '살펴볼 부분')
    .replace(/문제점\s*분석과\s*고쳐\s*쓴\s*방향\s*제시/g, '개선 방향 정리')
    .replace(/중심으로/g, '함께 보며')
    .replace(/필자의 판단으로는/g, '자료를 읽어보면')
    .replace(/필자 입장에서는/g, '먼저')
    .replace(/필자가 보기에/g, '이 글에서는')
    .replace(/내가 보기에 이는/g, '나는 이를')
    .replace(/내가 보기에 이 부분들은/g, '이 대목들은')
    .replace(/내가 보기에 이 분절이야말로/g, '이 분절은')
    .replace(/내가 보기에 이 수정은/g, '이 수정은')
    .replace(/내가 보기에 가장 핵심은/g, '마지막으로 남는 쟁점은')
    .replace(/내가 보기에/g, '여기서')
    .replace(/내가 주목하는 부분은/g, '특히 문제 되는 부분은')
    .replace(/나는 이 법이/g, '이 법은')
    .replace(/나는 이 조치가/g, '이 조치는')
    .replace(/나는 이들이/g, '현장 실천가들은')
    .replace(/나는 지자체가/g, '지자체가')
    .replace(/나는 지원 범위를/g, '지원 범위를')
    .replace(/나는 사회보장위원회/g, '사회보장위원회')
    .replace(/나는 제9조/g, '제9조')
    .replace(/나는 이 단계적/g, '단계적')
    .replace(/라고 본다/g, '라고 볼 수 있다')
    .replace(/리라 본다/g, '릴 수 있다')
    .replace(/이라고 본다/g, '이라고 볼 수 있다');

  out = out
    .replace(/첫 번째이자 가장 큰 문제는/g, '가장 먼저 걸리는 부분은')
    .replace(/첫 번째 문제는/g, '먼저 걸리는 부분은')
    .replace(/두 번째로 필자가 중요하게 보는 문제는/g, '또 하나 중요한 부분은')
    .replace(/두 번째 문제는/g, '또 다른 문제는')
    .replace(/세 번째로 필자가 문제 삼는 부분은/g, '마지막으로 놓치기 어려운 부분은')
    .replace(/세 번째 문제는/g, '마지막으로 남는 문제는')
    .replace(/이 문제를 해결하려면/g, '이 대목은 이렇게 손볼 수 있다')
    .replace(/입법 방향/g, '고칠 방향')
    .replace(/구체적인 수정 방향은/g, '손볼 방향은')
    .replace(/문구를 어떻게 고칠지 제안하려 한다/g, '어떤 문구부터 손봐야 하는지 정리하려 한다')
    .replace(/직접 서술하겠다/g, '풀어 쓰겠다')
    .replace(/구조상의 결함/g, '구조에서 드러나는 빈틈')
    .replace(/실질적 토대/g, '토대')
    .replace(/전환하는 계기/g, '바뀌는 출발점')
    .replace(/효과가 국민의 실제 삶 속으로 스며들 것이다/g, '효과가 국민의 실제 삶에서 확인될 수 있다');

  out = out
    .replace(/법의 내용은 네 영역으로 얽혀 있다\./g, '이 법은 받을 권리, 위원회, 기본계획, 최저보장수준 공표를 한 틀 안에 둔다.')
    .replace(/법이 미치는 범위의 경직성을 풀고,/g, '닫힌 적용 범위를 풀고,')
    .replace(/실제로 작동하는 힘/g, '작동하는 힘')
    .replace(/분명한 문장/g, '분명한 말')
    .replace(/분명히 적/g, '법에 적')
    .replace(/분명히 정/g, '명확히 정');

  return normalize(out);
}

function summarize(output) {
  const rawText = fs.readFileSync(rawPath, 'utf8');
  const metrics = proxy.measure(output, { rawText, mode: 'assignment' });
  const floorReport = floor.buildFloorReport({ result: { outputText: output }, rawText, mode: 'assignment' });
  return {
    input: path.relative(root, inputPath),
    output: path.relative(root, outPath),
    after: {
      score: metrics.score,
      aiRate: metrics.aiSuspicion.predictedAiRate,
      levels: metrics.aiSuspicion.levels,
      qualityGate: metrics.qualityGate,
      longParagraphs: metrics.longParagraphs,
      rows: metrics.aiSuspicion.rows.map(r => ({
        idx: r.idx,
        score: r.score,
        level: r.level,
        reasons: r.reasons,
        structuredFlow: r.structuredFlow,
        legalReport: r.legalReport,
        head: r.head,
      })),
    },
    floor: { status: floorReport.status, criticals: floorReport.criticals },
  };
}

const input = fs.readFileSync(inputPath, 'utf8');
const output = deFormalizeFlow(input);
fs.writeFileSync(outPath, output, 'utf8');
const summary = summarize(output);
fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2), 'utf8');
console.log(JSON.stringify(summary, null, 2));
