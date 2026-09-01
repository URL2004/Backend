// /detect-report current GPT-only contract smoke test.
// No external model call, Firebase authentication, history write, or credit deduction.
// Run: node tools/detectreport-test.js
'use strict';

process.env.DEV_NO_AUTH = '1';
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const path = require('path');
const base = path.join(__dirname, '..');
const detectAttempts = new Map();

function stub(relativePath, exports) {
  const full = require.resolve(path.join(base, relativePath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
}

stub('lib/gptRuntimeConfig.js', {
  getRuntimeConfig: async () => ({
    activeProvider: 'gpt',
    models: { detect: 'gpt-test', humanizePrimary: 'gpt-test' },
    reasoning: { detect: 'low' }
  }),
  isGptActive: config => config?.activeProvider === 'gpt'
});

stub('routes/analyze-gpt.js', {
  runDetect: async text => {
    detectAttempts.set(String(text), (detectAttempts.get(String(text)) || 0) + 1);
    if (String(text).includes('FAILLLM')) throw new Error('stub: GPT unavailable');
    return {
      probability: 88,
      summary: 'AI 패턴이 강하게 보입니다.',
      detail: '균일한 문장 종결과 일반론 위주 구성이 관찰됩니다.',
      signals: ['uniform_structure'],
      confidence: 'high'
    };
  },
  rewriteSentence: async () => ({
    rewritten: '처음에는 저도 반신반의했지만, 직접 확인한 뒤 생각이 달라졌습니다.'
  })
});

// Keep retry behavior deterministic and fast while preserving production semantics:
// attempts is the total call count, not an additional retry count.
const billing = require(path.join(base, 'lib', 'usageBilling.js'));
billing.retryAsync = async (fn, attempts = 3) => {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
};

const express = require('express');
const report = require(path.join(base, 'routes', 'detectreport.js'));
const app = express();
app.use(express.json());
app.use('/', report);

const RISKY = '인공지능 기술의 발전은 현대 사회에 많은 영향을 미치고 있다. 이러한 변화는 다양한 분야에서 나타나고 있으며, 우리는 이에 대한 적절한 대응 방안을 모색해야 한다. 기술의 발전과 함께 윤리적 고려 또한 중요해지고 있다.';
const SAFE = '저는 지난 학기에 교내 해커톤에 참가해 사흘 동안 챗봇을 만들었다. 팀원 4명과 새벽 3시까지 디버깅을 했고, 결국 2위로 입상해 상금 50만 원을 받았다.';
const TEXT = `${RISKY}\n\n${SAFE}`;

let passed = 0;
let failed = 0;
function check(name, condition, extra) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
    return;
  }
  failed += 1;
  console.error(`  ✗ ${name}${extra ? ` — ${JSON.stringify(extra).slice(0, 300)}` : ''}`);
}

const server = app.listen(0, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(`${url}/detect-report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }).then(async response => ({ status: response.status, body: await response.json() }));

  try {
    const short = await post({ text: '너무 짧은 글' });
    check('100자 미만은 400', short.status === 400, short);

    const result = await post({ text: TEXT });
    check('개발 무인증 보고서는 200', result.status === 200 && result.body.ok, result);
    check('무료 상품으로 오인시키지 않음', result.body.free === false, result.body.free);
    check('개발 호출은 차감 0', result.body.charged === 0, result.body.charged);
    check('GPT 판정 88% 수신', result.body.probability === 88 && result.body.probSource === 'llm', {
      probability: result.body.probability,
      probSource: result.body.probSource
    });
    check('점수와 설명의 위험 방향이 일치', result.body.riskLevel !== 'low' && !/낮|사람이 쓴 가능성이 높/u.test(result.body.summary), {
      riskLevel: result.body.riskLevel,
      summary: result.body.summary
    });
    check('문단 지도에 위험·구체 문단이 모두 존재', result.body.paragraphs.length === 2
      && result.body.paragraphs[0].kind !== 'concrete'
      && result.body.paragraphs[1].kind === 'concrete', result.body.paragraphs);
    check('미리보기는 위험 문장에서 생성', Boolean(result.body.example)
      && RISKY.includes(result.body.example.before.slice(0, 20))
      && result.body.example.after.length > 0, result.body.example);

    const expectedShortCost = Math.max(10, Math.ceil(TEXT.length / 100) * 2);
    const solutions = result.body.solutions;
    check('휴머나이징 비용 계약 일치', solutions.polish.credits === expectedShortCost
      && solutions.blog.credits === expectedShortCost
      && solutions.restructure.credits === 100
      && solutions.restructure.creditsEvidence === 150, solutions);
    check('모든 해결 경로에 밴드가 있음', Boolean(
      solutions.polish.band && solutions.blog.band && solutions.restructure.band
    ), solutions);
    check('폐기된 무료 잔여 횟수를 응답하지 않음', !Object.prototype.hasOwnProperty.call(result.body, 'remainingToday'), result.body.remainingToday);

    const failedText = `FAILLLM ${TEXT}`;
    const unavailable = await post({ text: failedText });
    check('GPT 감지 실패 시 503 무차감으로 닫힘', unavailable.status === 503
      && unavailable.body.code === 'DETECT_MODEL_UNAVAILABLE'
      && unavailable.body.retryable === true
      && unavailable.body.charged === 0, {
      status: unavailable.status,
      body: unavailable.body
    });
    check('실패 응답에 엔진 추정 숫자를 노출하지 않음',
      !Object.prototype.hasOwnProperty.call(unavailable.body, 'probability')
      && !Object.prototype.hasOwnProperty.call(unavailable.body, 'probSource'), unavailable.body);
    check('운영과 같은 총 2회 모델 시도', detectAttempts.get(failedText) === 2, {
      attempts: detectAttempts.get(failedText)
    });
  } catch (error) {
    failed += 1;
    console.error('  ✗ 테스트 실행 오류:', error);
  }

  console.log(`\n결과: ${passed}통과 / ${failed}실패`);
  process.exitCode = failed ? 1 : 0;
  server.close();
});
