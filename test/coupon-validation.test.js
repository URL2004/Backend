'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness() {
  const routes = {}, rows = new Map(), logged = []; let sequence = 0;
  const ref = p => ({ path: p, id: p.split('/').pop(), collection: n => collection(p + '/' + n) });
  const collection = p => ({ doc: id => ref(p + '/' + (id || 'test' + ++sequence)) });
  const snapshot = r => ({ exists: rows.has(r.path), data: () => rows.get(r.path) });
  const commit = ops => { for (const [kind, r, value] of ops) {
    const next = kind === 'update' ? { ...rows.get(r.path) } : {};
    for (const [k,v] of Object.entries(value)) next[k] = v && v.increment !== undefined ? (next[k] || 0) + v.increment : v;
    rows.set(r.path, next);
  }};
  const db = { collection, getAll: async (...refs) => refs.map(snapshot),
    batch: () => { const ops = []; return { set: (r,v) => ops.push(['set',r,v]), commit: async () => commit(ops) }; },
    runTransaction: async fn => { const ops = []; const result = await fn({ get: async r => snapshot(r), update: (r,v) => ops.push(['update',r,v]), set: (r,v) => ops.push(['set',r,v]) }); commit(ops); return result; }
  };
  const noop = () => {};
  const dependencies = {
    express: { Router: () => ({ post: (p,h) => routes[p] = h }) }, crypto: require('node:crypto'),
    '../config': { db, verifyAdminToken: async () => 'admin', verifyToken: async () => 'user', admin: { firestore: {
      Timestamp: { fromDate: d => ({ toMillis: () => +d }) }, FieldValue: { serverTimestamp: () => 0, increment: increment => ({ increment }) }
    }} },
    '../lib/logger': { logger: { info: noop, warn: (event, fields) => logged.push({ event, fields }), error: noop }, setLogContext: noop },
    '../lib/reqtoken': { bearerToken: () => 'mock' }, '../lib/discord': { couponUsed: noop }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../routes/coupon.js'),'utf8'), { require: n => dependencies[n], module: { exports: {} } });
  return { rows, logged, call: async (route,body) => { let status = 200, result;
    const response = { status: n => { status = n; return response; }, json: value => { result = value; } };
    await routes[route]({ body },response); return { status, result };
  }};
}

test('coupon creation rejects partial, fractional and non-scalar integers before any write', async () => {
  for (const value of ['1.9','2abc','1e2','0x10','', ' ', null, true, [], {}, 1.9, Infinity, Number.MAX_SAFE_INTEGER + 1, 0, -1]) {
    for (const field of ['credits','count']) {
      const h = harness(); const response = await h.call('/admin/create-coupons',{ credits: 20, count: 2, [field]: value });
      assert.equal(response.status,400,`${field}: ${String(value)}`); assert.equal(h.rows.size,0);
    }
  }
  for (const body of [{credits:10001,count:1},{credits:1,count:401}]) {
    const h = harness(); assert.equal((await h.call('/admin/create-coupons',body)).status,400); assert.equal(h.rows.size,0);
  }
});

test('coupon integer boundaries and full decimal strings preserve exact values', async () => {
  for (const body of [{credits:1,count:1},{credits:10000,count:400},{credits:' 20 ',count:'2'}]) {
    const h=harness(); const r=await h.call('/admin/create-coupons',body);
    assert.equal(r.status,200); assert.equal(r.result.credits,Number(body.credits)); assert.equal(r.result.codes.length,Number(body.count));
    assert.equal(h.rows.size,Number(body.count)+1);
  }
});

test('coupon redemption updates balance, ledger and batch once and rejects expired or voided codes', async () => {
  const h=harness(); const c=(await h.call('/admin/create-coupons',{credits:20,count:2})).result;
  h.rows.set('users/user',{credits:7});
  const r=await h.call('/redeem-coupon',{code:c.codes[0].display.toLowerCase()});
  assert.equal(r.result.newBalance,27); assert.equal(h.rows.get('couponBatches/'+c.batchId).redeemedCount,1);
  assert.equal([...h.rows.keys()].filter(k=>k.includes('/creditHistory/')).length,1);
  assert.equal((await h.call('/redeem-coupon',{code:c.codes[0].raw})).status,409);
  assert.equal(h.rows.get('users/user').credits,27);
  const second=h.rows.get('couponCodes/'+c.codes[1].raw); second.expiresAt={toMillis:()=>1};
  assert.equal((await h.call('/redeem-coupon',{code:c.codes[1].raw})).status,410);
  second.status='voided'; assert.equal((await h.call('/redeem-coupon',{code:c.codes[1].raw})).status,410);
});

// 2026-09-29 실사고: 슬래시가 섞인 12자 입력이 길이 검사를 통과해 Firestore 경로 예외(try 밖) → 응답 없이 요청 중단.
test('coupon redemption rejects 12-char codes with characters outside CHARSET before touching Firestore', async () => {
  for (const code of ['ABCD//EFGHJK', 'abcd/efg/hjk', 'ABC0-O1IL-EFGH', 'ABCDEFGHJKL!', '가나다라마바사아자차카타']) {
    const h = harness();
    h.rows.set('users/user', { credits: 7 });
    let response;
    await assert.doesNotReject(async () => { response = await h.call('/redeem-coupon', { code }); }, `${code}: 예외 없이 응답해야 한다`);
    assert.equal(response.status, 400, `${code}: 형식 오류는 400`);
    assert.equal(h.rows.get('users/user').credits, 7, `${code}: 잔액 불변`);
    const log = h.logged.find(l => l.event === 'coupon.invalid_code_format');
    assert.ok(log, `${code}: 관리자 로그용 이벤트가 남아야 한다`);
    assert.equal(log.fields.uid, 'user');
    assert.ok(log.fields.invalidCharCount >= 1 || log.fields.length !== 12, `${code}: 사유 필드`);
    assert.equal(JSON.stringify(log.fields).includes(code.toUpperCase().replace(/[-\s]/g, '')), false, `${code}: 코드 원문은 로그에 싣지 않는다`);
  }
  // 관리자 무효화 경로도 같은 검사를 거친다.
  const h = harness();
  const voided = await h.call('/admin/void-coupons', { code: 'ABCD//EFGHJK' });
  assert.equal(voided.status, 400);
  assert.equal(h.logged.filter(l => l.event === 'coupon.invalid_code_format').length, 1);
});
