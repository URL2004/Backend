// llm/router.js - local Gemini super-conservative model router with Claude fallback.

const anthropic = require('./providers/anthropic');
const gemini = require('./providers/gemini');
const localRuns = require('./localRuns');

const CLAUDE_SONNET = 'claude-sonnet-4-6';
const CLAUDE_HAIKU = 'claude-haiku-4-5';

function backend() {
  return (process.env.LLM_BACKEND || 'api').toLowerCase();
}

function fallbackEnabled() {
  return process.env.LLM_CLAUDE_FALLBACK !== '0';
}

function shadowEnabled() {
  if (process.env.LLM_SHADOW_MODE !== '1') return false;
  const rate = Number(process.env.LLM_SHADOW_RATE);
  if (!Number.isFinite(rate)) return true;
  return Math.random() < Math.max(0, Math.min(1, rate));
}

function textLengthOf(s) {
  return (s || '').replace(/\s+/g, '').length;
}

function inferTask({ task, tool, model }) {
  if (task) return task;
  if (tool?.name === 'return_detection_result') return 'detect';
  if (tool?.name === 'return_humanized_result') return 'rewrite';
  if (model === CLAUDE_HAIKU) return 'repair';
  if (model === CLAUDE_SONNET) return 'rewrite';
  return 'text';
}

function chooseGeminiModel({ task, mode, riskLevel, textLength, model, tool }) {
  const t = inferTask({ task, tool, model });
  const len = Number(textLength) || 0;
  if (t === 'classify' || t === 'route' || t === 'schema' || t === 'detect') return gemini.MODELS.LITE;
  if (t === 'ledger' || t === 'judge' || t === 'evidence') return gemini.MODELS.PRO;
  if (riskLevel === 'high' || mode === 'formal' || mode === 'thesis' || len > 8000) return gemini.MODELS.PRO;
  if (model === CLAUDE_SONNET && t !== 'rewrite') return gemini.MODELS.PRO;
  return gemini.MODELS.FLASH;
}

function parseJSON(s) {
  if (!s) return null;
  let t = String(s).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const iObj = t.indexOf('{'), jObj = t.lastIndexOf('}');
  const iArr = t.indexOf('['), jArr = t.lastIndexOf(']');
  if (iObj >= 0 && jObj > iObj && (iArr < 0 || iObj < iArr)) t = t.slice(iObj, jObj + 1);
  else if (iArr >= 0 && jArr > iArr) t = t.slice(iArr, jArr + 1);
  try { return JSON.parse(t); } catch { return null; }
}

function usageLogBase(meta, provider, model, startedAt, status, usage, err) {
  return {
    provider,
    model,
    task: meta.task || inferTask(meta),
    mode: meta.mode || null,
    riskLevel: meta.riskLevel || null,
    inputTokens: usage?.input_tokens || 0,
    outputTokens: usage?.output_tokens || 0,
    thinkingTokens: usage?.thinking_tokens || 0,
    cacheCreateTokens: usage?.cache_creation_input_tokens || 0,
    cacheReadTokens: usage?.cache_read_input_tokens || 0,
    latencyMs: Date.now() - startedAt,
    retryCount: meta.retryCount || 0,
    status,
    error: err ? err.message || String(err) : undefined
  };
}

async function callClaudeCodeText({ system, user, model, signal }) {
  const { runClaudeCode } = require('../engine/claudecode');
  return runClaudeCode(`${system || ''}\n\n${user || ''}`, { model, signal });
}

async function llmText({ system, user, signal, maxTokens = 4096, model = CLAUDE_SONNET, temperature, task, mode, riskLevel, textLength, retryCount } = {}) {
  const meta = { system, user, model, task, mode, riskLevel, textLength: textLength || textLengthOf(user), retryCount };
  if (backend() === 'claudecode') return callClaudeCodeText({ system, user, model, signal });

  if (backend() === 'gemini') {
    const gm = chooseGeminiModel(meta);
    const startedAt = Date.now();
    try {
      const out = await gemini.generate({ system, user, model: gm, maxTokens, temperature, signal });
      localRuns.write(usageLogBase(meta, 'gemini', gm, startedAt, 'ok', out.usage));
      if (shadowEnabled() && process.env.ANTHROPIC_API_KEY) {
        anthropic.text({ system, user, model, maxTokens, temperature, signal })
          .then(() => localRuns.write({ ...usageLogBase(meta, 'anthropic-shadow', model, Date.now(), 'ok', {}), shadowOf: gm }))
          .catch(e => localRuns.write({ ...usageLogBase(meta, 'anthropic-shadow', model, Date.now(), 'error', {}, e), shadowOf: gm }));
      }
      return out.text;
    } catch (e) {
      localRuns.write(usageLogBase(meta, 'gemini', gm, startedAt, 'error', {}, e));
      if (!fallbackEnabled()) throw e;
      const fbStarted = Date.now();
      const text = await anthropic.text({ system, user, model, maxTokens, temperature, signal });
      localRuns.write(usageLogBase(meta, 'anthropic-fallback', model, fbStarted, 'ok', {}));
      return text;
    }
  }

  return anthropic.text({ system, user, model, maxTokens, temperature, signal });
}

async function llmJSON(opts = {}) {
  const prompt = `${opts.user || ''}\n\n반드시 유효한 JSON 객체 하나만 출력하세요. 코드펜스·설명·머리말 금지.`;
  let lastRaw = '';
  for (let i = 0; i < 3; i++) {
    lastRaw = await llmText({ ...opts, user: prompt, task: opts.task || 'json', retryCount: i });
    const parsed = parseJSON(lastRaw);
    if (parsed) return parsed;
  }
  return null;
}

async function llmStructured({ system, user, schema, maxTokens, temperature, signal, task = 'schema', mode, riskLevel, textLength } = {}) {
  if (backend() === 'gemini') {
    const meta = { task, mode, riskLevel, textLength: textLength || textLengthOf(user), tool: { name: 'structured' } };
    const gm = chooseGeminiModel(meta);
    const startedAt = Date.now();
    try {
      const out = await gemini.generate({
        system,
        user: `${user || ''}\n\n반드시 유효한 JSON 객체 하나만 출력하세요. 코드펜스·설명 금지.`,
        model: gm,
        maxTokens: maxTokens || 4096,
        temperature,
        responseSchema: schema,
        jsonMode: true,
        signal
      });
      const parsed = parseJSON(out.text);
      if (!parsed) throw new Error('Gemini structured output parse failed');
      localRuns.write(usageLogBase(meta, 'gemini', gm, startedAt, 'ok', out.usage));
      return parsed;
    } catch (e) {
      localRuns.write(usageLogBase(meta, 'gemini', gm, startedAt, 'error', {}, e));
      if (!fallbackEnabled()) throw e;
    }
  }
  return llmJSON({ system, user, maxTokens, temperature, signal, task, mode, riskLevel, textLength });
}

async function callClaudeCompat({ userText, systemText, tool, temperature, maxOutputTokens, signal, task, mode, riskLevel, textLength } = {}) {
  if (backend() === 'claudecode') {
    const { callViaClaudeCode } = require('../engine/claudecode');
    return callViaClaudeCode({ userText, systemText, tool, model: CLAUDE_SONNET, signal });
  }
  if (backend() !== 'gemini') {
    return anthropic.message({ system: systemText, user: userText, model: CLAUDE_SONNET, maxTokens: maxOutputTokens || 8192, temperature, tool, signal });
  }

  const meta = {
    task: inferTask({ task, tool, model: CLAUDE_SONNET }),
    mode,
    riskLevel,
    textLength: textLength || textLengthOf(userText),
    tool
  };
  const gm = chooseGeminiModel(meta);
  const schema = tool?.input_schema;
  const jsonInstruction = tool
    ? `${userText}\n\n반드시 ${tool.name} 도구의 input_schema와 호환되는 JSON 객체 하나만 출력하세요. 코드펜스·설명 금지.`
    : userText;
  const startedAt = Date.now();
  try {
    let out;
    try {
      out = await gemini.generate({
        system: systemText,
        user: jsonInstruction,
        model: gm,
        maxTokens: maxOutputTokens || 8192,
        temperature,
        responseSchema: schema,
        jsonMode: !!tool,
        signal
      });
    } catch (schemaErr) {
      if (!tool) throw schemaErr;
      localRuns.write({ ...usageLogBase(meta, 'gemini', gm, startedAt, 'schema_retry', {}, schemaErr), retryReason: 'schema_rejected' });
      out = await gemini.generate({
        system: systemText,
        user: jsonInstruction,
        model: gm,
        maxTokens: maxOutputTokens || 8192,
        temperature,
        jsonMode: true,
        signal
      });
    }
    let parsed = tool ? parseJSON(out.text) : null;
    if (tool && !parsed) {
      const retry = await gemini.generate({
        system: systemText,
        user: jsonInstruction,
        model: gm,
        maxTokens: maxOutputTokens || 8192,
        temperature,
        jsonMode: false,
        signal
      });
      parsed = parseJSON(retry.text);
      out.usage = retry.usage;
      out.stop_reason = retry.stop_reason;
    }
    if (tool && !parsed) throw new Error(`Gemini structured output parse failed for ${tool.name}`);
    localRuns.write(usageLogBase(meta, 'gemini', gm, startedAt, 'ok', out.usage));
    if (shadowEnabled() && process.env.ANTHROPIC_API_KEY) {
      anthropic.message({ system: systemText, user: userText, model: CLAUDE_SONNET, maxTokens: maxOutputTokens || 8192, temperature, tool, signal })
        .then(() => localRuns.write({ ...usageLogBase(meta, 'anthropic-shadow', CLAUDE_SONNET, Date.now(), 'ok', {}), shadowOf: gm }))
        .catch(e => localRuns.write({ ...usageLogBase(meta, 'anthropic-shadow', CLAUDE_SONNET, Date.now(), 'error', {}, e), shadowOf: gm }));
    }
    return {
      type: 'message',
      content: tool
        ? [{ type: 'tool_use', id: 'gemini', name: tool.name, input: parsed }]
        : [{ type: 'text', text: out.text }],
      usage: out.usage,
      stop_reason: out.stop_reason
    };
  } catch (e) {
    localRuns.write(usageLogBase(meta, 'gemini', gm, startedAt, 'error', {}, e));
    if (!fallbackEnabled()) throw e;
    const fbStarted = Date.now();
    const data = await anthropic.message({ system: systemText, user: userText, model: CLAUDE_SONNET, maxTokens: maxOutputTokens || 8192, temperature, tool, signal });
    localRuns.write(usageLogBase(meta, 'anthropic-fallback', CLAUDE_SONNET, fbStarted, 'ok', data.usage));
    return data;
  }
}

module.exports = {
  CLAUDE_SONNET,
  CLAUDE_HAIKU,
  chooseGeminiModel,
  callClaudeCompat,
  llmText,
  llmJSON,
  llmStructured
};
