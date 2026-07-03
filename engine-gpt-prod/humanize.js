'use strict';

const engine = require('./index');

async function runHumanize(opts = {}) {
  return await engine.run(opts);
}

async function runHumanizeChunked(opts = {}) {
  return await engine.run(opts);
}

module.exports = {
  runHumanize,
  runHumanizeChunked,
  run: runHumanize
};
