'use strict';

function evaluateHumanizeRuntime({ humanizeEngineV2 = false, activeProvider = 'gpt' } = {}) {
  const provider = String(activeProvider || '').trim().toLowerCase() || 'unknown';
  const providerCompatible = !humanizeEngineV2 || provider === 'gpt';
  return {
    ok: providerCompatible,
    providerCompatible,
    activeProvider: provider,
    ...(providerCompatible ? {} : {
      code: 'HUMANIZE_V2_PROVIDER_MISMATCH',
      message: 'Humanize v2 requires the GPT provider.'
    })
  };
}

module.exports = { evaluateHumanizeRuntime };
