'use strict';

// Administrator-only experimental boundary. This module is lazy-loaded only
// after the transform route has verified an administrator UID.
function run(profile, options) {
  const engine = profile === 'v6_engine'
    ? require('../engine/humanizeV6TestEngine')
    : require('../engine/humanizeLabTestEngine');
  return engine.run(options);
}

function attachQualityPatternAudit(out, source, options) {
  return require('./qualityPatternAudit').attachQualityPatternAudit(out, source, options);
}

module.exports = { run, attachQualityPatternAudit };
