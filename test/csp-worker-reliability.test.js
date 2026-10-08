const test=require('node:test');
const assert=require('node:assert/strict');
const csp=require('../lib/cspReport');
test('actual worker blocks alert once per window and remain separate from report-only observations',()=>{
 csp.resetForTest();const events=[];const logger={warn:(name,data)=>events.push({name,data})};
 const make=disposition=>csp.summarizeReport({'csp-report':{'effective-directive':'worker-src','blocked-uri':'blob',disposition}});
 assert.equal(make('enforce').blockedOrigin,'blob:');
 csp.recordReport(make('report'),{logger,now:1});assert.equal(events.length,0);
 csp.recordReport(make('enforce'),{logger,now:2});csp.recordReport(make('enforce'),{logger,now:3});
 assert.equal(events.length,1);assert.equal(events[0].name,'security.worker_blocked');
 const summary=csp.flush({now:4});assert.equal(summary.distinct,2);assert.equal(summary.top.find(x=>x.disposition==='enforce').count,2);
 csp.recordReport(make('enforce'),{logger,now:5});assert.equal(events.length,2);csp.resetForTest();
});
