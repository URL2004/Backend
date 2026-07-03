'use strict';

function parseModelOutput(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, error: 'empty_model_output' };
  const cleaned = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch (e) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return { ok: true, value: JSON.parse(cleaned.slice(start, end + 1)) }; } catch (_) {}
    }
    return { ok: false, error: `json_parse_failed: ${e.message}`, raw: s.slice(0, 500) };
  }
}

module.exports = { parseModelOutput };
