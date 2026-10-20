'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('retired inquiry relay never reads or resends historical inquiry bodies',async()=>{
 let handler,row,exists=true;const notices=[];
 const stubs={express:{Router:()=>({post:(_path,fn)=>{handler=fn;}})},
  '../config':{db:{collection:()=>{throw new Error('retired relay must not read inquiries');}},verifyFirebaseIdToken:async()=>({uid:'owner'})},
  '../lib/logger':{logger:{warn(){},info(){}},setLogContext(){}},'../lib/discord':{inquiry:x=>notices.push(x)},
  '../lib/clientip':{},'../lib/cronAuth':{},'../lib/metaConversions':{},'../lib/reqtoken':{bearerToken:()=> 'token'},
  '../lib/paymentFailureTaxonomy':{},'../lib/authDiagnostics':{createDiagnosticLimiter:()=>()=>false}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../routes/events'),'utf8'),{require:n=>{assert.ok(n in stubs,n);return stubs[n];},module:{exports:{}},Date,Map,Set});
 const send=async()=>{const res={status(n){this.code=n;return this;},json(x){this.body=x;return this;}};await handler({body:{type:'inquiry',id:'q_test'}},res);return res;};
 row={authorId:'owner',writeSource:'server_api',body:'stored text'};
 assert.equal((await send()).body.skipped,'inquiry_relay_retired');await send();assert.equal(notices.length,0);
 row={authorId:'other',body:'private'};await send();assert.equal(notices.length,0);
 exists=false;await send();assert.equal(notices.length,0);
 exists=true;row={authorId:'owner',body:'legacy inquiry',title:'legacy'};await send();assert.equal(notices.length,0);
});
