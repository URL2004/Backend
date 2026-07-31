'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const runtime = require('../lib/gptRuntimeConfig');

function firestoreConfig(data) {
  return {
    collection() {
      return {
        doc() {
          return {
            async get() {
              return {
                exists: true,
                data: () => data
              };
            }
          };
        }
      };
    }
  };
}

test('GPT-5.6 운영 기본값은 Luna 우선, Terra 승격으로 고정한다', () => {
  assert.equal(runtime.VERSION, 'gpt-runtime-config-v2');
  assert.deepEqual(runtime.DEFAULT_CONFIG.models, {
    humanizePrimary: 'gpt-5.6-luna',
    humanizeEscalation: 'gpt-5.6-terra',
    judge: 'gpt-5.6-luna',
    judgeEscalation: 'gpt-5.6-terra',
    repair: 'gpt-5.6-luna',
    classify: 'gpt-5.6-luna',
    detect: 'gpt-5.6-luna',
    detectEscalation: 'gpt-5.6-terra',
    evidenceSearch: 'gpt-5.6-luna',
    evidenceEscalation: 'gpt-5.6-terra'
  });
  assert.deepEqual(runtime.DEFAULT_CONFIG.reasoning, {
    humanize: 'medium',
    factDense: 'high',
    escalation: 'high',
    judge: 'medium',
    repair: 'medium',
    classify: 'low',
    detect: 'low',
    evidenceSearch: 'medium'
  });
});

test('구형 GPT-5.4 모델 ID와 max reasoning을 안전하게 정규화한다', () => {
  const config = runtime.sanitizeConfig({
    models: {
      humanizePrimary: 'gpt-5.4-mini',
      humanizeEscalation: 'gpt-5.4',
      judge: 'gpt-5.4-nano'
    },
    reasoning: {
      humanize: 'max'
    }
  });
  assert.equal(config.models.humanizePrimary, 'gpt-5.6-luna');
  assert.equal(config.models.humanizeEscalation, 'gpt-5.6-terra');
  assert.equal(config.models.judge, 'gpt-5.6-luna');
  assert.equal(config.reasoning.humanize, 'max');
});

test('Firestore v1 기본 프로필은 배포 후 v2 모델과 추론 강도로 자동 승격한다', { concurrency: false }, async () => {
  runtime.clearRuntimeConfigCache();
  const config = await runtime.getRuntimeConfig({
    db: firestoreConfig({
      version: 'gpt-runtime-config-v1',
      models: {
        humanizePrimary: 'gpt-5.4-mini',
        humanizeEscalation: 'gpt-5.4',
        judge: 'gpt-5.4-mini',
        judgeEscalation: 'gpt-5.4',
        repair: 'gpt-5.4-mini',
        classify: 'gpt-5.4-nano',
        detect: 'gpt-5.4-mini',
        detectEscalation: 'gpt-5.4',
        evidenceSearch: 'gpt-5.4-mini',
        evidenceEscalation: 'gpt-5.4'
      },
      reasoning: {
        humanize: 'low',
        factDense: 'medium',
        escalation: 'medium',
        judge: 'medium',
        repair: 'medium',
        classify: 'low',
        detect: 'low',
        evidenceSearch: 'medium'
      }
    }),
    force: true
  });

  assert.equal(config.version, 'gpt-runtime-config-v2');
  assert.deepEqual(config.models, runtime.DEFAULT_CONFIG.models);
  assert.deepEqual(config.reasoning, runtime.DEFAULT_CONFIG.reasoning);
});

test('현재 v2에서 관리자가 명시한 reasoning 값은 그대로 보존한다', { concurrency: false }, async () => {
  runtime.clearRuntimeConfigCache();
  const storedReasoning = {
    ...runtime.DEFAULT_CONFIG.reasoning,
    humanize: 'low',
    escalation: 'xhigh'
  };
  const config = await runtime.getRuntimeConfig({
    db: firestoreConfig({
      version: runtime.VERSION,
      models: runtime.DEFAULT_CONFIG.models,
      reasoning: storedReasoning
    }),
    force: true
  });

  assert.equal(config.reasoning.humanize, 'low');
  assert.equal(config.reasoning.escalation, 'xhigh');
});
