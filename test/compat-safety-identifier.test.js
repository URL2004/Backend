'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('compat callGpt는 safety_identifier를 Responses API 계층까지 전달한다', async t => {
  const clientPath = require.resolve('../engine-gpt-prod/openaiClient');
  const compatPath = require.resolve('../engine-gpt-prod/compat');
  const client = require(clientPath);
  const original = client.completeJson;
  let captured = null;
  client.completeJson = async options => {
    captured = options;
    return {
      model: options.model,
      json: { outputText: 'ok' },
      usage: {},
      raw: {},
      incompleteReason: ''
    };
  };
  delete require.cache[compatPath];
  t.after(() => {
    client.completeJson = original;
    delete require.cache[compatPath];
  });

  const compat = require(compatPath);
  await compat.callGpt({
    userText: 'data',
    systemText: 'system',
    task: 'coach',
    safetyIdentifier: 'a'.repeat(64),
    config: {},
    tool: {
      name: 'return_test',
      input_schema: {
        type: 'object',
        properties: { outputText: { type: 'string' } },
        required: ['outputText']
      }
    }
  });

  assert.equal(captured.safetyIdentifier, 'a'.repeat(64));
  assert.equal(captured.meta.task, 'coach');
});
