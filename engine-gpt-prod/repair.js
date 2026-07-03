'use strict';

const engine = require('./index');
const judge = require('./judge');

async function rewriteSentence(opts = {}) {
  return await engine.rewriteSentence(opts);
}

async function repairViolations(...args) {
  return await judge.repairViolations(...args);
}

module.exports = {
  rewriteSentence,
  repairViolations
};
