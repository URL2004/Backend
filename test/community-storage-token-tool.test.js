'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const tool = require('../lib/communityStorageTokenTool');
const cli = require('../scripts/community-storage-tokens');

function mockFile(name, metadata, options = {}) {
  const calls = [];
  let getCount = 0;
  return {
    name,
    calls,
    async getMetadata() {
      getCount += 1;
      if (options.failGet && getCount <= options.failGet) throw Object.assign(new Error('temporary'), { code: 503 });
      return [{ ...metadata, metadata: { ...(metadata.metadata || {}) } }];
    },
    async setMetadata(patch) {
      if (options.failSet) throw Object.assign(new Error('denied'), { code: 403 });
      calls.push(patch);
      return [patch];
    }
  };
}

function mockBucket(pages, filesByName) {
  const queries = [];
  return {
    queries,
    async getFiles(query) {
      queries.push(query);
      const key = query.pageToken || 'first';
      return pages[key];
    },
    file(name, options) {
      const file = filesByName[name];
      file.lastOptions = options;
      return file;
    }
  };
}

test('community token scan paginates under the fixed prefix and retries metadata reads', async () => {
  const a = mockFile('community_photos/a.jpg', { generation: '1', metageneration: '2', contentType: 'image/jpeg', metadata: { firebaseStorageDownloadTokens: 'token-a', owner: 'keep' } }, { failGet: 1 });
  const b = mockFile('community_photos/b.jpg', { metadata: { owner: 'no-token' } });
  const outside = mockFile('other/c.jpg', { metadata: { firebaseStorageDownloadTokens: 'token-c' } });
  const bucket = mockBucket({
    first: [[a, outside], { pageToken: 'next' }],
    next: [[b], null]
  }, { [a.name]: a, [b.name]: b, [outside.name]: outside });
  const scan = await tool.scanTokenFiles(bucket, { salt: Buffer.alloc(32, 1), retry: { baseDelayMs: 0, sleep: async () => {} } });
  assert.equal(scan.scanned, 2);
  assert.equal(scan.entries.length, 1);
  assert.equal(scan.entries[0].token, 'token-a');
  assert.deepEqual(bucket.queries.map(query => query.pageToken || null), [null, 'next']);
});

test('apply patches only firebaseStorageDownloadTokens and preserves all other metadata fields', async () => {
  const file = mockFile('community_photos/a.jpg', { metadata: { firebaseStorageDownloadTokens: 'token-a', owner: 'keep' } });
  const bucket = mockBucket({}, { [file.name]: file });
  const result = await tool.revokeTokens(bucket, [{ name: file.name, token: 'token-a', generation: '7', metageneration: '9' }], { salt: Buffer.alloc(32, 2) });
  assert.equal(result.changed, 1);
  assert.deepEqual(file.calls, [{ metadata: { firebaseStorageDownloadTokens: null } }]);
  assert.deepEqual(file.lastOptions, { generation: '7', preconditionOpts: { ifMetagenerationMatch: 9 } });
});

test('rollback restores the exact token without replacing unrelated current metadata', async () => {
  const file = mockFile('community_photos/a.jpg', { generation: '8', metageneration: '10', contentType: 'image/webp', cacheControl: 'public,max-age=60', metadata: { owner: 'still-here' } });
  const bucket = mockBucket({}, { [file.name]: file });
  const result = await tool.restoreTokens(bucket, [{ name: file.name, token: 'token-a' }], { salt: Buffer.alloc(32, 3) });
  assert.equal(result.restored, 1);
  assert.deepEqual(file.calls, [{ metadata: { firebaseStorageDownloadTokens: 'token-a' } }]);
  assert.deepEqual(file.lastOptions, { generation: '8', preconditionOpts: { ifMetagenerationMatch: 10 } });
});

test('partial failures use non-reversible identifiers and produce a non-success result', async () => {
  const name = 'community_photos/private-user-name.jpg';
  const file = mockFile(name, { metadata: {} }, { failSet: true });
  const bucket = mockBucket({}, { [name]: file });
  const result = await tool.revokeTokens(bucket, [{ name, token: 'secret' }], { salt: Buffer.alloc(32, 4), retry: { attempts: 1 } });
  assert.equal(result.changed, 0);
  assert.equal(result.failures.length, 1);
  assert.notEqual(result.failures[0].id, name);
  assert.doesNotMatch(JSON.stringify(result), /private-user-name/u);
});

test('manifest is integrity checked and rollback paths cannot escape the gitignored directory', () => {
  const payload = tool.manifestPayload({ bucket: 'example.firebasestorage.app', entries: [], salt: crypto.randomBytes(32), createdAt: '2026-08-30T00:00:00.000Z' });
  const manifest = tool.sealManifest(payload);
  assert.equal(tool.verifyManifest(manifest), true);
  assert.equal(tool.verifyManifest({ ...manifest, bucket: 'changed.example' }), false);
  assert.throws(() => cli.safeManifestPath('../outside.json'), /invalid_manifest_path/u);
  assert.equal(cli.parseArgs([]).apply, false);
  assert.equal(cli.parseArgs(['--apply']).apply, true);
  assert.throws(() => cli.parseArgs(['--apply', '--rollback=x.json']), /conflicting_modes/u);
});
