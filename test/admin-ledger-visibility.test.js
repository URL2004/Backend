'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hiddenFromAdminLedger, collectVisibleAdminLedger, collectIndexedAdminLedger, createAdminLedgerLoader } = require('../lib/adminLedgerVisibility');
const grant = { type: 'admin_adjust', amount: 100, campaignId: 'humanize-incident-20261002-100' };
function fixture(rows) {
  const docs = rows.map((data, index) => ({ index, id: data.id || `entry${index}`, data: () => data }));
  const reads = [];
  const query = (start = 0, size = 0) => ({
    startAfter: doc => query(doc.index + 1, size),
    limit: n => query(start, n),
    get: async () => { reads.push({ start, size }); return { docs: docs.slice(start, start + size) }; }
  });
  return { query: query(), reads };
}
test('only the specified compensation is hidden; ordinary adjustments and other grants remain', () => {
  assert.equal(hiddenFromAdminLedger(grant), true);
  assert.equal(hiddenFromAdminLedger({ type: 'admin_adjust', id: 'admin_compensation_20261002_100' }), true);
  for (const row of [{ type: 'admin_adjust', amount: 100 }, { ...grant, campaignId: 'another' }, { type: 'charge' }, { type: 'humanize', used: 100 }, {}]) {
    assert.equal(hiddenFromAdminLedger(row), false);
  }
});
test('38,247 grants cannot crowd the newest 1,000 visible records; interleaved usage survives', async () => {
  const rows = Array.from({ length: 38247 }, () => grant);
  rows.splice(900, 0, { type: 'humanize', used: 20 });
  rows.splice(6000, 0, { type: 'detect', used: 3 });
  rows.unshift({ type: 'charge', amount: 2900 });
  rows.push(...Array.from({ length: 1100 }, () => ({ type: 'admin_adjust', amount: 10 })));
  const f = fixture(rows);
  const result = await collectVisibleAdminLedger(f.query, 1000);
  assert.equal(result.docs.length, 1000);
  assert.equal(result.hidden, 38247);
  assert.deepEqual(result.docs.slice(0, 3).map(d => d.data().type), ['charge', 'humanize', 'detect']);
  assert.equal(new Set(result.docs.map(d => d.index)).size, 1000);
  assert.ok(result.docs.every((d, i, all) => !i || d.index > all[i - 1].index));
  assert.ok(f.reads.length <= 10);
});
test('empty, all hidden, exact page and normal ledger terminate without missing rows', async () => {
  for (const rows of [[], [grant], [grant, grant], [{type:'detect'}, grant, {type:'charge'}]]) {
    const f = fixture(rows);
    const result = await collectVisibleAdminLedger(f.query, 2, { batchSize: 2 });
    assert.equal(result.docs.length, rows.filter(r => !hiddenFromAdminLedger(r)).length);
  }
});
test('scan cap and read errors do not return an apparently complete empty ledger', async () => {
  await assert.rejects(collectVisibleAdminLedger(fixture([grant,grant,grant]).query, 2, {maxScanned:2}), {code:'ADMIN_LEDGER_SCAN_LIMIT'});
  const query = { limit: () => ({ get: async () => { throw Error('offline'); } }) };
  await assert.rejects(collectVisibleAdminLedger(query, 2), /offline/);
});
test('concurrent loads share reads; cache expires and rejected reads can retry', async () => {
  let clock = 0, calls = 0;
  const load = createAdminLedgerLoader(async n => { calls++; return {n}; }, {ttlMs:30,now:()=>clock});
  const [a,b] = await Promise.all([load(1000),load(1000)]);
  assert.equal(a,b); assert.equal(calls,1);
  await load(1000); assert.equal(calls,1);
  clock=31; await load(1000); assert.equal(calls,2);
  await load(2000); assert.equal(calls,3);
  let attempts=0;
  const retry=createAdminLedgerLoader(async()=>{ if(!attempts++) throw Error('retry'); return 'ok'; });
  await assert.rejects(retry(1)); assert.equal(await retry(1),'ok');
});
test('filter is not applied to the user audit/balance bundle', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/payment.js'), 'utf8');
  const bundle = source.slice(source.indexOf('async function loadAdminUserBundle('), source.indexOf('\nasync function ', source.indexOf('async function loadAdminUserBundle(')+1));
  assert.doesNotMatch(bundle, /hiddenFromAdminLedger|collectVisibleAdminLedger/);
});

function indexedFixture(rows, fail = false) {
  const reads = [];
  const docs = rows.map((data, i) => ({id: data.id || `r${i}`, ref: {path: `users/u${i}/creditHistory/${data.id || 'entry'}`}, data: () => data}));
  return { reads, query: { where(field, op, value) {
    const selected = docs.filter(d => op === '!=' ? d.data()[field] != null && d.data()[field] !== value : d.data()[field] === value);
    return {orderBy(field, direction) {
      assert.equal(field, 'createdAt'); assert.equal(direction, 'desc');
      return {limit(n) { return {async get() {
        if (fail) throw Error('index unavailable');
        const result = selected.sort((a,b) => (b.data().createdAt?.seconds || 0) - (a.data().createdAt?.seconds || 0)).slice(0,n);
        reads.push(result.length); return {docs: result};
      }}; }};
    }};
  }}};
}
test('indexed reader ignores 38k grants at query time and retains ordinary adjustments and legacy rows', async () => {
  const rows = Array.from({length:38247}, () => ({...grant,createdAt:{seconds:2000,nanoseconds:0}}));
  rows.push(...Array.from({length:1200}, (_,i) => ({type:'detect',createdAt:{seconds:1200-i,nanoseconds:0}})));
  rows.push({type:'admin_adjust',adminLedgerVisible:true,createdAt:{seconds:3000,nanoseconds:0}});
  rows.push({adminLedgerVisible:true,createdAt:{seconds:2500,nanoseconds:0}});
  const f=indexedFixture(rows),result=await collectIndexedAdminLedger(f.query,1000);
  assert.equal(result.docs.length,1000); assert.equal(result.scanned,1002);
  assert.equal(result.docs[0].data().type,'admin_adjust');
  assert.equal(result.docs[1].data().type,undefined);
  assert.equal(result.docs[2].data().type,'detect');
  assert.deepEqual(f.reads,[1000,2]);
});
test('indexed reader deduplicates paths, keeps nanos ordering and defensively hides a marked grant',async()=>{
  const f=indexedFixture([
    {type:'detect',adminLedgerVisible:true,createdAt:{seconds:10,nanoseconds:1}},
    {type:'future_type',createdAt:{seconds:10,nanoseconds:2}},
    {...grant,adminLedgerVisible:true,createdAt:{seconds:20,nanoseconds:0}},
    {type:'admin_adjust',adminLedgerVisible:true,createdAt:null}
  ]);
  const result=await collectIndexedAdminLedger(f.query,10);
  assert.equal(result.docs.length,3);assert.equal(result.docs[0].data().type,'future_type');
  assert.equal(new Set(result.docs.map(d=>d.ref.path)).size,3);
});
test('indexed errors propagate rather than starting a global per-user scan',async()=>{
  await assert.rejects(collectIndexedAdminLedger(indexedFixture([],true).query,1000),/index unavailable/);
  const source=fs.readFileSync(path.join(__dirname,'../routes/payment.js'),'utf8');
  assert.doesNotMatch(source,/loadCreditHistoryViaUsers|usersFallback|collectVisibleAdminLedger/);
  assert.match(source,/type: 'admin_adjust',\s+adminLedgerVisible: true/);
  const billing=fs.readFileSync(path.join(__dirname,'../lib/usageBilling.js'),'utf8');
  assert.match(billing,/opType === 'admin_adjust' \? \{ adminLedgerVisible: true \}/);
});
