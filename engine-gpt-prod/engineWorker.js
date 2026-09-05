'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { runWithLogContext } = require('../lib/logger');
const engine = require('./index');
const controller = new AbortController();
parentPort.on('message', message => { if (message === 'abort') controller.abort(); });
runWithLogContext(workerData.context, async () => {
  try {
    const result = await engine.run({ ...workerData.options, signal: controller.signal });
    parentPort.postMessage({ result });
  } catch (error) {
    parentPort.postMessage({ error: { message: error.message, code: error.code, noCharge: error.noCharge } });
  } finally { parentPort.close(); }
});
