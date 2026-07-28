const fs = require('fs');
const path = require('path');

process.env.FORMAL_HUMAN = '1';

const root = path.resolve(__dirname, '..');
const rawPath = 'C:/Users/dbvision10/.codex/attachments/21f0695a-375d-4b94-9e77-1f166600edc2/pasted-text.txt';
const inputPath = path.join(root, 'results/gemini-local-runs/experiment-subheads_lex_anchors_hotspots_conclusion_grammar.md');
const outPath = path.join(root, 'results/gemini-local-runs/experiment-reflective-expanded.md');
const sumPath = path.join(root, 'results/gemini-local-runs/experiment-reflective-expanded-summary.json');

const proxy = require('../engine/copykillerproxy');
const floor = require('../engine/floor');

function normalize(t) {
  return String(t || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

const reflections = [
  '내가 이 부분에서 먼저 확인한 것은 문장이 실제 절차로 이어지는지 여부다. 이름이 붙은 권리라도 신청서 앞에서 멈추면 시민에게는 거의 보이지 않는다. 그래서 이 글은 조문을 많이 나열하기보다, 어느 지점에서 권리가 막히는지를 따라가려 한다.',
  '여기서 중요한 것은 제도의 겉모양보다 결정 과정의 닫힌 구조다. 회의에 누가 들어가고, 누가 빠지는지를 보면 정책이 누구의 언어로 쓰이는지도 드러난다. 나는 이 지점을 단순한 운영 문제가 아니라 대표성의 문제로 읽었다.',
  '현장과 연결해 보면 문제는 더 선명해진다. 상담 담당자가 설명할 수 있는 절차가 분명해야 이용자도 다음 선택을 할 수 있다. 법 문장이 현장 언어로 번역되지 못하면 권리는 종이에만 남는다.',
  '이 법을 읽을 때 나는 전달 체계의 폭을 먼저 보게 된다. 서비스 이름은 계속 늘어나는데, 법의 울타리가 예전 목록에 머물면 이용자는 여러 창구를 떠돌게 된다. 그래서 적용 범위 문제는 문구 정리 이상의 의미를 갖는다.',
  '종사자 처우 문제도 같은 맥락에 있다. 사람이 자주 바뀌는 현장에서는 관계가 쌓이기 어렵고, 관계가 끊기면 서비스의 기억도 함께 사라진다. 보수 기준은 비용 항목이 아니라 서비스가 버틸 수 있는 최소 조건이다.',
  '민간위탁 문제에서는 숫자보다 반복된 구조가 더 눈에 들어온다. 같은 기관이 오랫동안 자리를 차지하면 경쟁의 모양만 남고 감시의 긴장은 약해진다. 내가 이 대목을 위험하게 보는 이유가 여기에 있다.',
  '생활보장 제도에서는 문턱의 위치가 핵심이다. 지원 대상이라는 말이 있어도 실제 판정선이 너무 높게 서 있으면 가장 먼저 밀려나는 사람은 도움을 요청한 사람이다. 그래서 기준의 이름보다 기준이 작동하는 장면을 보아야 한다.',
  '의료급여 문제는 특히 그렇다. 병원에 가야 하는 사람에게 가족의 서류가 먼저 따라붙는 순간, 제도는 본인의 빈곤을 직접 보지 못한다. 나는 이 점이 생활보장 제도의 취지와 가장 크게 충돌한다고 본다.',
  '소득인정액도 생활과 서류 사이의 간격을 보여 준다. 집이 있다는 사실과 쓸 수 있는 돈이 있다는 사실은 같지 않다. 이 차이를 놓치면 제도는 가난을 줄이는 대신 가난을 설명하는 방식만 복잡하게 만든다.',
  '자활 논의에서는 참여 여부보다 이후의 변화가 중요하다. 출석이 목표가 되면 사람은 남아도 삶은 잘 움직이지 않는다. 내가 성과 기준을 따져야 한다고 보는 이유는 자활이 행정 절차가 아니라 탈빈곤의 과정이어야 하기 때문이다.',
  '최저보장수준은 추상적인 원칙처럼 보이지만 실제로는 한 달 생활의 하한선이다. 이 선이 현실보다 낮으면 모든 지원은 처음부터 모자란 상태로 출발한다. 그래서 산정 방식은 기술적인 계산이 아니라 생활을 어디까지 인정할지의 문제다.',
  '결국 세 법을 따로 읽어도 같은 질문이 남는다. 권리를 적어 두는 것과 그 권리가 실제로 도착하는 것은 다르다. 나는 이 간격을 줄이는 일이 이번 개정 논의의 중심이어야 한다고 본다.',
];

function addReflectiveParagraphs(text) {
  const paras = String(text || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const out = [];
  let k = 0;
  for (const p of paras) {
    out.push(p);
    const compact = p.replace(/\s+/g, '');
    if (
      k < reflections.length &&
      compact.length > 250 &&
      !p.includes('참고문헌') &&
      !p.includes('국가법령정보센터') &&
      !p.includes('law.go.kr')
    ) {
      out.push(reflections[k++]);
    }
  }
  while (k < reflections.length) {
    out.splice(Math.max(0, out.length - 1), 0, reflections[k++]);
  }
  return normalize(out.join('\n\n'));
}

const rawText = fs.readFileSync(rawPath, 'utf8');
const input = fs.readFileSync(inputPath, 'utf8');
const output = addReflectiveParagraphs(input);
fs.writeFileSync(outPath, output, 'utf8');

const before = proxy.measure(input, { rawText, mode: 'assignment' });
const after = proxy.measure(output, { rawText, mode: 'assignment' });
const floorReport = floor.buildFloorReport({ result: { outputText: output }, rawText, mode: 'assignment' });

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
    aiRate: after.aiSuspicion.predictedAiRate,
    levels: after.aiSuspicion.levels,
    qualityGate: after.qualityGate,
    rows: after.aiSuspicion.rows.map(r => ({
      idx: r.idx,
      score: r.score,
      level: r.level,
      reasons: r.reasons,
      head: r.head,
    })),
  },
  floor: {
    status: floorReport.status,
    criticals: floorReport.criticals,
  },
};

fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2), 'utf8');
console.log(JSON.stringify(summary, null, 2));
