'use strict';

// Synthetic OpenAI Responses API stub for writing-lab tests. Requests are
// dispatched by the structured-output schema name, so the real default
// writer / judge / repair code paths run end to end without network access.
// Non-OpenAI URLs (a local test server) go to the original fetch.

function fillRequired(schema) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.type === 'array') return [];
  if (schema.type === 'string') return '';
  if (schema.type === 'boolean') return false;
  if (schema.type === 'number' || schema.type === 'integer') return 0;
  if (schema.type === 'object') {
    return Object.fromEntries((schema.required || []).map(key => [key, fillRequired(schema.properties?.[key])]));
  }
  return null;
}

function completed(json, usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120 }) {
  return new Response(JSON.stringify({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(json) }] }],
    usage
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function failure(status, message = 'synthetic outage', extra = {}) {
  return new Response(JSON.stringify({ error: { message, ...extra } }), {
    status, headers: { 'content-type': 'application/json', 'retry-after': '0' }
  });
}

/**
 * handlers: { [schemaName]: (request) => Response | object | Promise<...> }
 * A plain object return is wrapped as a completed response; a missing handler
 * returns an empty schema-valid object (e.g. no judge violations).
 */
function installOpenAIStub(t, handlers = {}) {
  const originalFetch = global.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  const calls = [];
  global.fetch = async (url, init = {}) => {
    if (!String(url).startsWith('https://api.openai.com/')) return originalFetch(url, init);
    const body = JSON.parse(String(init.body || '{}'));
    const schemaName = body.text?.format?.name || '';
    const userContent = Array.isArray(body.input)
      ? String(body.input.filter(item => item?.role === 'user').map(item => item.content).at(-1) || '')
      : String(body.input || '');
    const request = { schemaName, body, userText: userContent, index: calls.length, signal: init.signal };
    calls.push(request);
    const handler = handlers[schemaName];
    const value = handler ? await handler(request) : fillRequired(body.text?.format?.schema);
    return value instanceof Response || (value && typeof value.json === 'function' && 'ok' in value) ? value : completed(value);
  };
  t.after(() => {
    global.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });
  return { calls, bySchema: name => calls.filter(call => call.schemaName === name) };
}

function writerResult(text, factRefs = ['F01', 'F02']) {
  return { paragraphs: [{ sentences: [{ text, kind: 'fact', factRefs }] }], omittedFactIds: [], followupQuestions: [] };
}

// First balanced JSON object after a section label in a prompt.
function jsonAfter(text, label) {
  const value = String(text || '');
  const start = value.indexOf('{', value.indexOf(label) + label.length);
  if (value.indexOf(label) < 0 || start < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < value.length; i += 1) {
    const ch = value[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return JSON.parse(value.slice(start, i + 1));
  }
  return null;
}

module.exports = { installOpenAIStub, completed, failure, fillRequired, writerResult, jsonAfter };
