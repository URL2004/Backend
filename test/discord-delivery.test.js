'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

test('Discord only counts 2xx as delivered and exposes failed inquiry delivery', async () => {
  for (const statusCode of [204, 400, 401, 429, 500]) {
    const context = { module: { exports: {} }, Buffer, URL, process: { env: { DISCORD_WEBHOOK_CS: 'https://discord.com/api/webhooks/test/test' } }, require(name) {
      if (name === './outboundPolicy') return { assertOutboundUrl: url => new URL(url) };
      if (name === 'https') return { request(options, callback) {
        const req = new EventEmitter();
        req.write = () => {};
        req.end = () => { const res = new EventEmitter(); res.statusCode = statusCode; callback(res); res.emit('end'); };
        return req;
      } };
      throw Error(name);
    } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../lib/discord'), 'utf8'), context);
    const discord = context.module.exports;
    assert.equal(await discord.inquiry({ id: 'synthetic-question' }), statusCode === 204);
    assert.equal(discord.webhookStats().sent, statusCode === 204 ? 1 : 0);
    assert.equal(discord.webhookStats().failed, statusCode === 204 ? 0 : 1);
  }
});
