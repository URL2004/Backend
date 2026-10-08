'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { runWithLogContext } = require('../lib/logger');
const engine = require('./index');
const controller = new AbortController();
parentPort.on('message', message => { if (message === 'abort') controller.abort(); });
runWithLogContext(workerData.context, async () => {
  try {
    const result = await require('./callLedger').observe(
      () => engine.run({ ...workerData.options, signal: controller.signal }), null,
      ledger => parentPort.postMessage({ callLedger: ledger }));
    parentPort.postMessage({ result });
  } catch (error) {
    parentPort.postMessage({ error: { message: error.message, code: error.code, noCharge: error.noCharge } });
  } finally { parentPort.close(); }
});
