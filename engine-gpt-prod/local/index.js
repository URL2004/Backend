'use strict';

// GPT production engine boundary for deterministic local utilities.
// These modules do not call any LLM provider; they are shared text-processing
// and safety utilities wrapped here so engine-gpt-prod does not import the
// legacy engine tree directly.

module.exports = {
  contract: require('../../engine/contract'),
  chunk: require('../../engine/chunk'),
  floor: require('../../engine/floor'),
  surfaceguard: require('../../engine/surfaceguard'),
  spacing: require('../../engine/spacing'),
  registernormalize: require('../../engine/registernormalize'),
  dedupe: require('../../engine/dedupe'),
  basicblogtone: require('../../engine/basicblogtone'),
  flowcohesion: require('../../engine/flowcohesion'),
  softguard: require('../../engine/softguard')
};
