'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {listDeletedQuestions,getDeletedQuestion}=require('../lib/inquiryArchive');
const {createRouter}=require('../routes/clientData');
function fixture(){
 const body='합성 원문을 줄이지 않고 보관합니다.\n'.repeat(300);
 const rows=Array.from({length:103},(_,i)=>({id:'q_'+String(i).padStart(3,'0'),data:()=>({title:'문의',body,answer:{body:'원래 답변'},status:'deleted',deletedAtMs:1000,authorId:'owner',deletedBy:'owner',originalContentComplete:true})}));
 let reads=0;
 const query=(cursor='',size=Infinity)=>({orderBy:()=>query(cursor,size),startAfter:c=>query(c,size),limit:n=>query(cursor,n),get:async()=>{reads++;return {docs:rows.filter(x=>x.id>cursor).slice(0,size)};},doc:id=>({get:async()=>{reads++;const d=rows.find(x=>x.id===id);return {exists:!!d,data:()=>d?.data()};}})});
 return {db:{collection:()=>query()},body,get reads(){return reads;}};
}
test('archive pagination does not truncate the population and full read preserves body and answer',async()=>{
 const f=fixture(),one=await listDeletedQuestions(f.db),two=await listDeletedQuestions(f.db,{cursor:one.nextCursor});
 assert.equal(one.items.length,100);assert.equal(two.items.length,3);assert.equal(two.nextCursor,null);
 assert.equal(new Set([...one.items,...two.items].map(x=>x.id)).size,103);
 assert.equal(one.items[0].body,undefined);assert.equal(one.items[0].createdAt,null);
 const {question}=await getDeletedQuestion(f.db,'q_000');assert.equal(question.body,f.body);assert.equal(question.answer.body,'원래 답변');assert.equal(question.status,'deleted');
 await assert.rejects(getDeletedQuestion(f.db,'../q_000'),e=>e.status===400);
 await assert.rejects(getDeletedQuestion(f.db,'q_missing'),e=>e.status===404);
});
test('deleted inquiry APIs reject owner/anonymous reads and only return full text to an authenticated admin',async t=>{
 const f=fixture(),app=express();app.use(express.json());app.use(createRouter({db:f.db,service:{},historyReadLimiter:(_q,_s,next)=>next(),verifyAdminToken:async token=>token==='admin'?'operator':false}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const send=(route,token)=>fetch('http://127.0.0.1:'+server.address().port+route,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({id:'q_000'})});
 for(const route of ['/admin/qna/deleted-list','/admin/qna/deleted-get']){
  assert.equal((await send(route)).status,401);assert.equal((await send(route,'owner')).status,403);
 }
 assert.equal(f.reads,0);
 const res=await send('/admin/qna/deleted-get','admin');assert.equal(res.status,200);assert.match(res.headers.get('cache-control'),/no-store/);assert.equal((await res.json()).question.body,f.body);
});
