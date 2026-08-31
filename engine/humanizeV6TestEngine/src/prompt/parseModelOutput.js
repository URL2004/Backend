'use strict';

function parseModelOutput(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, error: 'empty_model_output' };
  try {
    const value = JSON.parse(s);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'json_object_required' };
    }
    return { ok: true, value };
  } catch (_) {
    // Do not echo raw output or accept JSON hidden inside prose/code fences. Both
    // behaviours can turn prompt/meta leakage into an apparently valid result.
    return { ok: false, error: 'json_parse_failed' };
  }
}

module.exports = { parseModelOutput };
