'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const src=fs.readFileSync(path.join(__dirname,'../routes/transform.js'),'utf8');
function setup(){let billed=0,saved;const context={completionState:require('../lib/transformCompletionState'),logger:{info(){}},commitJobBilling:async j=>{billed++;j.deducted=true;},persistJob:async()=>({ok:true}),saveJobHistory:async j=>{saved=structuredClone(j)}};
 vm.createContext(context);vm.runInContext(src.slice(src.indexOf('function classifyBillingDisposition('),src.indexOf('router.resolveBillingDisposition ='))+src.slice(src.indexOf('async function stageCompletion('),src.indexOf('// refine 전용 과금 커밋')),context);return{context,get billed(){return billed},get saved(){return saved}};}
const badCases=[{humanizationNoBenefitDelivered:true,substantiveEditRatio:0.0241},{humanizationDepthApplicable:true,humanizationDepthPass:false},{humanizationDepthApplicable:true,humanizationMinimumEffectPass:false},{finalSemanticState:'verified_fail'},{candidateLedgerSelectionReason:'no_safe_transformed_candidate',candidateLedgerEligibleCount:0}];
badCases.push(...['incomplete','uncertain','stale','unconfirmed','confirmation_pending'].map(finalSemanticState=>({finalSemanticState})));
badCases.push({ candidateLedgerSelectionReason: 'semantic_verification_not_required', candidateLedgerEligibleCount: 0, finalSemanticState: 'not_run' });
for(const billingMode of ['credit','coupon'])for(const [i,meta]of badCases.entries())test(`quality shortfall ${i} never spends ${billingMode}, including resumed completion`,async()=>{const h=setup(),job={id:'test',uid:'u',text:'원문 문장',needed:42,mode:'blog',plan:'free',billingMode,status:'running',deducted:false};const result={outputText:'일부 수정한 문장',engineMeta:meta,creditBreakdown:{total:42}};
 await h.context.stageCompletion(job,result);assert.equal(h.billed,0);assert.equal(job.status,'done');assert.equal(job.result.creditBreakdown.charged,0);assert.equal(job.result.billingDisposition,'waived_quality_shortfall');assert.equal(h.saved.result.engineMeta.billingDisposition,'waived_quality_shortfall');
 const resumed={...job,status:'running',pendingCompletion:{result,mode:'blog',creditAmount:42}};await h.context.recoverCompletion(resumed);assert.equal(h.billed,0);assert.equal(resumed.result.billingDisposition,'waived_quality_shortfall');});
test('whitespace-only output is free even without quality metadata',async()=>{const h=setup(),job={id:'same',text:'문장 하나',mode:'polish',needed:8,status:'running'};await h.context.stageCompletion(job,{outputText:'문장  하나\n'});assert.equal(h.billed,0);assert.equal(job.billingDisposition,'waived_quality_shortfall');});
test('valid output with ordinary warnings remains billable; settled debit cannot be relabeled free',async()=>{const h=setup(),job={id:'ok',text:'원문',mode:'blog',needed:42,status:'running',deducted:false};await h.context.stageCompletion(job,{outputText:'변경 결과',qualityStatus:'needs_review',engineMeta:{humanizationDepthApplicable:true,humanizationDepthPass:true,humanizationMinimumEffectPass:true},creditBreakdown:{total:42}});assert.equal(h.billed,1);assert.equal(job.result.creditBreakdown.charged,42);assert.equal(h.context.classifyBillingDisposition({alreadyDeducted:true,result:{engineMeta:badCases[0]}}),'charged');});

test('waived completions persist zero used credits and the explicit disposition in history', async () => {
  let saved;
  const context = { db: {}, historyService: { saveAnalyzeHistory: async data => { saved = data; } }, finalQualityWarningCodes: () => [], logger: { warn() {} } };
  vm.createContext(context);
  const start = src.indexOf('function saveJobHistory(');
  vm.runInContext(src.slice(start, src.indexOf('// ── 결과 유실', start)), context);
  await context.saveJobHistory({ id: 'waived', uid: 'u', mode: 'blog', needed: 42, result: { billingDisposition: 'waived_quality_shortfall' } }, '원문', '결과');
  assert.equal(saved.needed, 0);
  assert.equal(saved.billingDisposition, 'waived_quality_shortfall');
  const service = require('../lib/historyService');
  assert.equal(service.CURRENT_BILLING_DISPOSITIONS.has(saved.billingDisposition), true);
});
