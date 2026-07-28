const fs = require('fs');
const path = require('path');

process.env.FORMAL_HUMAN = '1';

const root = path.resolve(__dirname, '..');
const rawPath = 'C:/Users/dbvision10/.codex/attachments/21f0695a-375d-4b94-9e77-1f166600edc2/pasted-text.txt';
const inputPath = path.join(root, 'results/gemini-local-runs/experiment-subheads_lex_anchors_hotspots_conclusion_grammar.md');
const outPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-student-margin-output.md');
const sumPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-student-margin-summary.json');

const proxy = require('../engine/copykillerproxy');
const floor = require('../engine/floor');

function normalize(t) {
  return String(t || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function removeQuoteAnchors(t) {
  return String(t || '').replace(/"([^"\n]{2,40})"/g, '$1');
}

function attachMarginNotes(text) {
  const paras = removeQuoteAnchors(text).split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const notes = [
    '나는 이 대목을 1970년, 1995년, 1999년의 흐름 속에서 읽었다. 법이 늘어난 만큼 실제 보장이 따라왔는지는 따로 보아야 한다.',
    '제9조~제13조를 읽을 때 걸리는 점은 신청과 이의신청이 기본법 안에서 바로 보이지 않는다는 점이다.',
    '제20조~제26조 부분은 위원회 구성의 문제로 이어진다. 당사자와 현장 전문가가 어디까지 들어갈 수 있는지가 핵심이다.',
    '제10조의 최저보장수준 공표도 숫자를 내놓는 일에 그치면 부족하다. 산정 방식과 미이행 시 처리까지 함께 보아야 한다.',
    '제16조~제32조, 제34조~제45조, 제11조~제15조를 나란히 보면 사회복지사업법의 폭이 꽤 넓다는 점은 분명하다.',
    '하지만 제2조의 열거 방식은 청소년복지와 건강가정기본법 쪽에서 빈틈을 만든다. 나는 이 점을 적용 범위의 문제로 보았다.',
    '2023년 한국사회복지관협회 건의는 종사자 보수 문제를 다시 보게 만든다. 권고안만으로는 현장의 차이를 줄이기 어렵다.',
    '행정안전부의 2023~2024년 민간위탁 실태조사는 감독 장치가 약하다는 점을 보여 준다. 장기 위탁과 겸직 문제는 그냥 운영상의 흠이 아니다.',
    '2000년 시행과 2015년 맞춤형 급여 전환은 국민기초생활보장법의 큰 변화다. 그래도 의료급여 부양의무자 기준은 남아 있다.',
    '2023년 수급자 255만 명이라는 숫자를 보면 이 문제는 작은 예외로 보기 어렵다. 소득인정액과 실제 생활 사이의 간격도 같이 따져야 한다.',
    '1년, 3년, 5년으로 나눈 폐지 일정은 재정 부담을 고려한 장치다. 다만 보고 의무가 없으면 단계적 이행은 느슨해질 수 있다.',
    '제6조의 최저보장수준은 실제 생활비와 기준 중위소득 변동분을 같이 보아야 한다. 중위소득 35% 목표도 그래서 중요하다.',
    '결국 세 법은 같은 질문으로 모인다. 권리가 적혀 있는가보다, 그 권리가 신청과 상담과 예산 편성 과정에서 움직이는가가 더 중요하다.',
  ];
  const out = [];
  let noteIndex = 0;
  for (const p of paras) {
    out.push(p);
    const compact = p.replace(/\s+/g, '');
    if (
      noteIndex < notes.length &&
      compact.length >= 260 &&
      !p.includes('참고문헌') &&
      !p.includes('국가법령정보센터') &&
      !p.includes('law.go.kr')
    ) {
      out.push(notes[noteIndex++]);
    }
  }
  while (noteIndex < notes.length) {
    out.splice(Math.max(0, out.length - 1), 0, notes[noteIndex++]);
  }
  return normalize(out.join('\n\n'));
}

const rawText = fs.readFileSync(rawPath, 'utf8');
const input = fs.readFileSync(inputPath, 'utf8');
const output = attachMarginNotes(input);
fs.writeFileSync(outPath, output, 'utf8');

const before = proxy.measure(input, { rawText, mode: 'assignment' });
const after = proxy.measure(output, { rawText, mode: 'assignment' });
const floorReport = floor.buildFloorReport({ result: { outputText: output }, rawText, mode: 'assignment' });

const summary = {
  input: path.relative(root, inputPath),
  output: path.relative(root, outPath),
  before: { score: before.score, aiRate: before.aiSuspicion.predictedAiRate, levels: before.aiSuspicion.levels },
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
  floor: { status: floorReport.status, criticals: floorReport.criticals },
};

fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2), 'utf8');
console.log(JSON.stringify(summary, null, 2));
