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

const { llmText } = require('../engine/judge');
const proxy = require('../engine/copykillerproxy');
const floor = require('../engine/floor');

const rawText = `머신러닝은 단순히 데이터를 입력해 결과를 얻는 기술이 아니라, 오차를 줄이기 위해 수학적 원리를 활
용하는 분야라고 생각했다. 그과정에서 미적분이 실제로 어떻게 쓰이는지 궁금해졌고, 특히 미분이 모
델의 학습과 성능 평가에 중요한 역할을 한다는 점이 흥미로워 이 주제를 선택했다.
머신러닝 모델은 입력 데이터에 대해 예측값을 출력하는데 이 예측값과 실제 정답 사이에는 오차가 존재한
다. 이오차를 수치화한 함수를 손실함수라고 부르며 모델의 학습 목표는 이 손실함수의 값을 최소로 만드
는 매개변수를 찾는 것이다.
손실함수는 매개변수에 대한 함수로 나타낼 수 있으며 가장 단순한 형태로는 이차함수 형태를 갖는다. 
이차 함수 f(x)=ax)^2+bx+c (a>0)의 최솟값은 도함수 f′
(x)=2ax+bf'(x) = 2ax + b f′ (x)=2ax+b가 0이 되는 지점 즉 , x=− b/2a 에서 나타난다. 이는 손실함수의 그래프에서 가장 오목한 부분(
극소점) 을찾는 문제와 본질적으로 동일한 구조임을 확인하였다.
탐구
내용
그러나 실제 머신러닝 모델의 손실함수는 매개변수가 매우 많은 다변수 함수이기 때문에, f (x)=0 ′ 을 직접 대
수적으로 풀어 최솟값을 구하는 것이 현실적으로 불가능하다. 이를 해결하기 위해 사용되는 방법이 경사하
강법이다. 경사하강법은 현재 위치에서의 기울기 도함수 (값 를 )구하고, 기울기가 양수이면 함수값이 감소하
는 방향(왼쪽), 기울기가 음수이면 오른쪽으로 매개변수를 조금씩 이동시키는 과정을 반복한다. 즉, 
매개변수 의 갱신은 다음과 같은 식으로 이루어진다.
xn+1=xn−α ′f (xn) 여기서 α 는 학습률로, 한번에 이동하는 정도를 조절하는 값이다. 이과정을 반복하면 기
울기의 절댓값이 점점 작아지고 결국 기울기가 0에 가까워지는 극소점 근처로 수렴하게 된다.
이차함수를 예로 들어 직접 확인해보았다 손실함수를 . f(x)= (x-3)^2이라 하면 f (x)=2(x 3)f'(x) = 2(x-3) ′−
f (x)=2(x 3)′− 이다 초기값 . x0=0 에서 시작하면 f (0)= 6 ′− 으로 기울기가 음수이므로 갱신식에 , 의해
xx x값은 오른쪽 양의 (방향 으로 ) 이동한다 학습률 . α=0.1일 때 x1=0 0.1×( 6)=0.6 −− 이 되어 실제로 최솟값 지점
인 x=3 쪽으로 가까워지는 것을 계산을 통해 확인할 수 있었다 이를 . 반복하면 x 값이 점차 3에 가까워지면
서 기울기의 크기도 함께 작아지는데, 이는 극소점에 가까워질수록 함수의 변화율 즉, 기울기가 0 에 가까워
진다는 미분의 성질과 정확히 일치하는 결과였다.
이 탐구를 통해, 수업에서 배운 ' 도함수가 0인 지점에서 극값을 갖는다는' 단순한 정리가 실제로는 인공지능
모델이 데이터를 학습하는 핵심 원리로 사용되고 있음을 알게 되었다. 모델의 성능을 평가하고 개선하는 과
정 자체가 결국 손실함수라는 함수의 극소점을 찾아가는 미분의 응용 과정이라는 점에서, 미분이 단순한 수
학적 도구를 넘어 실제 기술 구현의 핵심 원리로 작동한다는 것을 깊이 이해하게 되었다.
이번 탐구를 통해 수업에서 배운 미분의 극값 판정 원리가 머신러닝 모델 학습의 핵심 알고리즘인 경사하강
법의 수학적 토대가 된다는 것을 알게 되었다. 특히 이차함수를 예로 들어 직접 도함수를 계산하고 매개변
수가 갱신되는 과정을 따라가 보면서 극소점에 가까워질수록 기울기가 0에 수렴한다는 원리가 단순한 이론
이 아니라 실제로 작동하는 원리임을 체감할 수 있었다. 이를 통해 미분이라는 수학적 개념이 컴퓨터가 데
이터를 학습하는 방식 자체를 설명하는 데 사용된다는 것이 인상적이었고 앞으로는 매개변수가 여러 개인
다변수 함수에서의 미분(편미분) 이 실제로 어떻게 적용되는지에 대해 더 깊이 탐구해보고 싶다는 생각이 들
었다.
미분 단원에서 도함수가 0이 되는 지점에서 극값을 갖는다는 것을 배운 후 이 단순한 원리가 실제
기술에서는 어떻게 쓰이는지 궁금했다. 평소 인공지능 분야에 관심이 많았기에 머신러닝이 '학습' 하는
과정에도 분명 어떤 값을 최소화하는 단계가 있을 것이라 생각했고 그것이 미분과 연결될 수 있을지 직접
확인해보고 싶었다손실함수가 매개변수가 여러 개인 다변수 함수라는 점에서, 처음에는 도함수를 어떻게 구해야 할지
막막했다. 또한 경사하강법의 갱신 공식(xn+1=xn−α ′ f (xn))) 이 왜 그런 형태를 가지는지, 부호와 방향이
어떻게 연결되는지 직관적으로 이해하기 어려웠다.복잡한 다변수 함수 대신 수업에서 익숙한 이차함수 f(x)=(x-3)^2을 직접 예로 들어 계산해보았다. 
기울기의 부호에 따라 x값이 어느 방향으로 이동하는지 손으로 직접 계산하며 따라가 보니, 
기울기가 음수이면 양의 방향으로, 양수이면 음의 방향으로 이동한다는 것을 자연스럽게 이해할 수 있었고, 
이를 통해 갱신 공식의 의미도 파악할 수 있었다.
교과서의 극값 개념을 추상적인 이론으로만 두지 않고, 실제 수치를 대입해 계산 과정을 따라가며
머신러닝의 핵심 알고리즘과 연결한 점이 스스로 만족스러웠다. 단순한 개념 정리에서 끝나지 않고
구체적인 예시로 검증해본 것이 탐구의 깊이를 더했다고 생각한다.
미분이 수능 문제를 풀기 위한 도구가 아니라, 실제로 컴퓨터가 학습하는 원리를 설명하는 언어라는 것을
깨달았다. 수학 개념과 진로 분야(인공지능, 반도체) 가 추상적으로만 연결된다고 생각했는데, 이번 탐구를
통해 그 연결이 매우 구체적이고 직접적이라는 것을 느꼈다이번 탐구는 매개변수가 1개인 단변수 함수를 기준으로 진행했는데 실제 머신러닝 모델은 매개변수가
수백~ 수천 개인 다변수 함수를 다룬다. 이를 보완하기 위해 로널드 크노이젤(Ronald T. Kneusel)
의 『딥러닝을 위한 수학 중 』 미분 단원을 찾아 읽으며 편미분과 기울기 그래디언트의 개념을 학습하였다 . 
한7단계
후속
활동
변수만 변화시키고 나머지 변수는 고정한 채 변화율을 구하는 것이 편미분이며 이러한 편미분값들을 모아
벡터로 나타낸 것이 기울기 벡터라는 것을 알게 되었다. 이를 통해 이번 탐구에서 다룬 단변수
경사하강법의 갱신식 xn+1=xn−α ′ f (xn) 이 다변수 함수에서는 xn+1=xn−α∇ f(xn) 형태로 일반화된다는 것을
확인할 수 있었다 여기서 +가 아닌 - 인 이유는 함수 f(x)의 최솟값 골짜기 을 () 찾으려면 가장 가파르게
내려가는 방향으로 가야 하는데 ∇f(xn)가 '올라가는 방향 을 ' 가리키기 때문에 그 반대 방향인 부호(-)
를붙여서 아래로 내려가도록 방향을 잡아주는 것이다. 단변수에서의 직관이 다변수로 그대로 확장된다는
점이 흥미로웠고 향후에는 실제 두 변수 이상의 손실함수에 대해 직접 기울기 벡터를 계산해보며
경사하강법이 적용되는 과정을 더 구체적으로 탐구해보고 싶다.`;

function compactBrokenLines(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/([가-힣])\n([가-힣])/g, '$1$2')
    .replace(/탐구\s*\n\s*내용/g, '탐구 내용')
    .replace(/한7단계\s*\n\s*후속\s*\n\s*활동/g, '7단계 후속 활동')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripCodeFence(text) {
  return String(text || '')
    .replace(/^```(?:markdown|md|text)?/i, '')
    .replace(/```$/g, '')
    .trim();
}

function restoreStudentStance(text) {
  return String(text || '')
    .replace(
      /손실함수가 다변수 함수라는 점 때문에 처음에는 도함수를 어떻게 구해야 할지 막막했고,/,
      '나는 손실함수가 다변수 함수라는 점 때문에 처음에는 도함수를 어떻게 구해야 할지 막막했고,'
    )
    .replace(
      /이번 탐구를 통해 교과서에서 배운/,
      '나는 이번 탐구를 통해 교과서에서 배운'
    )
    .replace(
      /이번 탐구는 매개변수가 1개인 단변수 함수만을 다루었지만,/,
      '이번 탐구에서 나는 매개변수가 1개인 단변수 함수만을 다루었지만,'
    );
}

const sourceText = compactBrokenLines(rawText);
const formulaNotes = [
  '수식 OCR 정정 기준:',
  'f(x)=ax^2+bx+c (a>0), f\'(x)=2ax+b, x=-b/(2a).',
  '경사하강법 갱신식은 x_{n+1}=x_n-alpha f\'(x_n).',
  '예시 함수는 f(x)=(x-3)^2, f\'(x)=2(x-3), x_0=0, f\'(0)=-6, alpha=0.1, x_1=0-0.1*(-6)=0.6.',
  '다변수 일반화는 x_{n+1}=x_n-alpha grad f(x_n).'
].join('\n');

const outPath = path.join(root, 'results/gemini-local-runs/latest-ml-gradient-engine-output.md');
const sumPath = path.join(root, 'results/gemini-local-runs/latest-ml-gradient-engine-summary.json');
const srcPath = path.join(root, 'results/gemini-local-runs/latest-ml-gradient-engine-source.md');

async function main() {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(srcPath, `${formulaNotes}\n\n${sourceText}`, 'utf8');

  const system = [
    '너는 한국어 고등학생 수학 탐구보고서 편집자다.',
    '목표는 OCR/붙여넣기 때문에 깨진 문장과 수식을 복원하고, 중복된 성찰 문단을 하나로 정리해 제출 가능한 탐구 보고서 형태로 만드는 것이다.',
    '반드시 원문 안에 있는 사실, 관심사, 계산 예시, 후속 탐구 방향만 사용한다.',
    '새로운 책, 인물, 실험, 진로 경험, 외부 통계, 감정 일화는 만들지 않는다.',
    '수식은 아래 정정 기준에 맞춰 정확히 표기한다.',
    '문체는 고등학생 탐구보고서의 평서문으로 유지하되, 백과사전식 해설문처럼 매끄럽게만 만들지 않는다.',
    '원문에 이미 있는 1인칭 사고 흐름을 살린다. 내가 무엇을 궁금해했는지, 어느 부분에서 막혔는지, 어떤 계산을 해 보며 이해했는지가 문단 안에 보여야 한다.',
    '수식 설명 뒤에는 반드시 직접 계산한 값(x_0=0, f\'(0)=-6, alpha=0.1, x_1=0.6)과 그때 이해한 이동 방향을 붙인다.',
    '모든 문장을 같은 길이와 같은 종결로 맞추지 않는다. 짧은 확인 문장과 긴 설명 문장을 섞는다.',
    '중복된 결론은 합치되, 최종 분량이 너무 짧아지지 않도록 원문의 탐구 동기, 어려웠던 점, 해결 과정, 후속 활동을 모두 남긴다.',
    '블로그식 강조, 감탄문, 독자 호명, 과장된 표현은 쓰지 않는다.',
    '문단 구조는 제목, 주제 선정 이유, 탐구 내용, 직접 계산으로 확인한 점, 느낀 점, 후속 활동 순서로 정리한다.',
    '출력은 수정된 본문 전체만. 설명, 변경요약, 코드펜스 금지.'
  ].join('\n');

  const user = [
    '[수식 정정 기준]',
    formulaNotes,
    '',
    '[정리할 원문]',
    sourceText
  ].join('\n');

  let outputText = stripCodeFence(await llmText({
    system,
    user,
    maxTokens: 12000,
    task: 'rewrite',
    mode: 'assignment',
    riskLevel: 'medium',
    textLength: sourceText.replace(/\s+/g, '').length,
    temperature: 0.45
  }));
  outputText = restoreStudentStance(outputText);

  fs.writeFileSync(outPath, outputText, 'utf8');

  const before = proxy.measure(sourceText, { rawText: sourceText, mode: 'assignment' });
  const after = proxy.measure(outputText, { rawText: `${formulaNotes}\n\n${sourceText}`, mode: 'assignment' });
  const floorReport = floor.buildFloorReport({
    result: { outputText },
    rawText: `${formulaNotes}\n\n${sourceText}`,
    mode: 'assignment',
    allowedExtra: formulaNotes
  });

  const summary = {
    source: srcPath,
    output: outPath,
    before: {
      score: before.score,
      aiSuspicion: {
        predictedAiRate: before.aiSuspicion.predictedAiRate,
        levels: before.aiSuspicion.levels,
        internalPass: before.aiSuspicion.internalPass
      }
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
          head: r.head
        }))
      }
    },
    floorReport
  };
  fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2), 'utf8');

  console.log(JSON.stringify({
    source: path.relative(root, srcPath),
    output: path.relative(root, outPath),
    summary: path.relative(root, sumPath),
    beforeAiRate: summary.before.aiSuspicion.predictedAiRate,
    afterAiRate: summary.after.aiSuspicion.predictedAiRate,
    levels: summary.after.aiSuspicion.levels,
    internalPass: summary.after.aiSuspicion.internalPass,
    blocked: summary.after.qualityGate.blocked,
    floorStatus: summary.floorReport.status,
    criticals: summary.floorReport.criticals
  }, null, 2));
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
