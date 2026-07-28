// llm/providers/anthropic.js - thin Anthropic Messages wrapper for local adapter/fallback use.

const API = 'https://api.anthropic.com/v1/messages';

function apiKey() {
  return (process.env.ANTHROPIC_API_KEY || '').trim();
}

function usageFrom(data, model) {
  const u = data?.usage || {};
  return {
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
    cache_read_input_tokens: u.cache_read_input_tokens || 0,
    _provider: 'anthropic',
    _model: model
  };
}

async function message({ system, user, model, maxTokens = 4096, temperature, tool, signal }) {
  const key = apiKey();
  if (!key) throw new Error('ANTHROPIC_API_KEY is not configured');
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: user }]
  };
  if (typeof temperature === 'number') body.temperature = temperature;
  if (system) body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  if (tool) {
    body.tools = [tool];
    body.tool_choice = { type: 'tool', name: tool.name };
  }

  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { const e = await res.json(); msg = e?.error?.message || msg; } catch {}
    throw new Error(`Anthropic API ${res.status}: ${msg}`);
  }
  const data = await res.json();
  return { ...data, usage: usageFrom(data, model) };
}

async function text(opts) {
  const data = await message(opts);
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

module.exports = { message, text };
