function parseJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: 'empty_model_output', data: null };
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return { ok: true, data: JSON.parse(stripped), raw: stripped };
  } catch (err) {
    return { ok: false, error: 'json_parse_failed', raw: text };
  }
}

function parseModelOutput(raw) {
  const parsed = parseJson(raw);
  if (!parsed.ok) return parsed;
  const data = parsed.data;
  if (!data || typeof data.outputText !== 'string') {
    return { ok: false, error: 'missing_outputText', data };
  }
  return {
    ok: true,
    data: normalizeMeta({
      outputText: data.outputText,
      editIntensity: data.editIntensity,
      changedRiskPatterns: data.changedRiskPatterns,
      warnings: data.warnings,
      protectedTermPolicy: data.protectedTermPolicy
    })
  };
}

function parseBlockOutput(raw) {
  const parsed = parseJson(raw);
  if (!parsed.ok) return parsed;
  const data = parsed.data;
  if (!data || !Array.isArray(data.blocks)) {
    return { ok: false, error: 'missing_blocks_array', data };
  }
  const blocks = data.blocks
    .filter(b => b && typeof b.id === 'string' && typeof b.text === 'string')
    .map(b => ({ id: b.id, text: b.text }));
  if (!blocks.length) return { ok: false, error: 'empty_blocks_array', data };
  return { ok: true, data: normalizeMeta({ ...data, blocks }) };
}

function parsePatchOutput(raw) {
  const parsed = parseJson(raw);
  if (!parsed.ok) return parsed;
  const data = parsed.data;
  if (!data || !Array.isArray(data.patches)) {
    return { ok: false, error: 'missing_patches_array', data };
  }
  const patches = data.patches
    .filter(p => p && typeof p.id === 'string' && typeof p.text === 'string')
    .map(p => ({ id: p.id, text: p.text }));
  return { ok: true, data: normalizeMeta({ ...data, patches }) };
}

function normalizeMeta(data) {
  return {
    ...data,
    editIntensity: data.editIntensity || 'light',
    changedRiskPatterns: Array.isArray(data.changedRiskPatterns) ? data.changedRiskPatterns : [],
    warnings: Array.isArray(data.warnings) ? data.warnings : [],
    protectedTermPolicy: data.protectedTermPolicy || 'unknown'
  };
}

module.exports = { parseModelOutput, parseBlockOutput, parsePatchOutput };
