'use strict';

function evaluateHumanizeRuntime({ activeProvider = 'gpt' } = {}) {
  const provider = String(activeProvider || '').trim().toLowerCase() || 'unknown';
  const providerCompatible = provider === 'gpt';
  return {
    ok: providerCompatible,
    providerCompatible,
    activeProvider: provider,
    ...(providerCompatible ? {} : {
      code: 'HUMANIZE_PROVIDER_MISMATCH',
      message: 'The production humanizer requires the GPT provider.'
    })
  };
}

module.exports = { evaluateHumanizeRuntime };
