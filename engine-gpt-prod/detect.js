'use strict';

const engine = require('./index');

async function runDetect(text, lang = 'ko', opts = {}) {
  return await engine.detect({ text, lang, allowLocalFallback: false, ...opts });
}

async function detect(opts = {}) {
  return await engine.detect(opts);
}

module.exports = {
  runDetect,
  detect
};
