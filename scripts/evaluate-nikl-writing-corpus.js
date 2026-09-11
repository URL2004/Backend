'use strict';
// Local diagnostics only. Does not import the live detector, provider or database.
const fs = require('node:fs');
const path = require('node:path');
const { sha } = require('../lib/detectBenchmark');
const { analyzeText } = require('../engine/koreanQuality/detector');
const { marginFor } = require('../lib/detectStatisticalAssist');
const { assertExternalOutput } = require('../lib/engineCorpusRegistry');
const { repositoryRoots } = require('./build-engine-corpus');

function distribution(values) {
  const xs = values.filter(Number.isFinite).sort((a,b)=>a-b);
  if (!xs.length) return { n:0, mean:null, p10:null, median:null, p90:null };
  const q = p => xs[Math.floor((xs.length-1)*p)];
  return { n:xs.length, mean:xs.reduce((a,b)=>a+b,0)/xs.length, p10:q(.1), median:q(.5), p90:q(.9) };
}
function ranks(values) {
  const ordered = values.map((v,i)=>({v,i})).sort((a,b)=>a.v-b.v), out=[];
  for (let i=0;i<ordered.length;) {
    let j=i+1; while(j<ordered.length && ordered[j].v===ordered[i].v) j++;
    for(let k=i;k<j;k++) out[ordered[k].i]=(i+j-1)/2;
    i=j;
  }
  return out;
}
function spearman(pairs) {
  if(pairs.length<3) return null;
  const x=ranks(pairs.map(p=>p[0])),y=ranks(pairs.map(p=>p[1])),m=(pairs.length-1)/2;
  let dot=0,a=0,b=0;
  for(let i=0;i<x.length;i++){ dot+=(x[i]-m)*(y[i]-m);a+=(x[i]-m)**2;b+=(y[i]-m)**2; }
  return a&&b ? dot/Math.sqrt(a*b) : null;
}
function evaluate(manifest,texts) {
  if(manifest?.version!=='nikl-writing-intake-v1' || !Array.isArray(manifest.records)) throw Error('nikl_invalid_manifest');
  const ids=new Set();
  for(const r of manifest.records) {
    if(ids.has(r.id)) throw Error('nikl_duplicate_record'); ids.add(r.id);
    if(typeof texts[r.id]!=='string' || sha(texts[r.id])!==r.sha256) throw Error('nikl_text_changed');
    if(!['normalizedSha256','corpusNormalizedSha256'].every(k=>/^[a-f0-9]{64}$/u.test(r[k]||''))) throw Error('nikl_hash_alias_missing');
    if(r.authorshipGoldEligible!==false || r.permissions?.localEvaluate!==true) throw Error('nikl_permissions_or_authorship_changed');
  }
  const measured=[],groups={},patterns={};let excluded=0;
  for(const r of manifest.records) {
    if(r.split!=='development' || r.lineageReviewRequired){ excluded++;continue; }
    const text=texts[r.id],quality=analyzeText(text),stats=marginFor(text);
    const row={id:r.id,kind:r.kind,familyId:r.familyId,chars:r.chars,
      feedbackType:r.feedbackType||null,textType:r.textType||'document',
      qualityRisk:quality.koreanSkillRisk,grammarRisk:quality.grammarRisk,
      hardGrammarCount:quality.hardGrammarCount,sentenceCount:quality.sentenceCount,
      statisticalMargin:stats.margin,matchedStatisticalFeatures:stats.features};
    const scores=r.evaluation?.evaluation_data;
    row.twoRaterMean=Number.isFinite(scores?.evaluator1_total_score)&&Number.isFinite(scores?.evaluator2_total_score)
      ? (scores.evaluator1_total_score+scores.evaluator2_total_score)/2 : null;
    row.twoRaterMeanDefinition='Descriptive mean of first two named totals only; not final adjudication or authorship gold.';
    measured.push(row);
    for(const key of [r.kind,...(r.feedbackType ? ['instruction:'+r.feedbackType+':'+r.textType] : [])]) {
      (groups[key] ||= []).push(row);
    }
    for(const p of quality.topPatterns) patterns[p.id]=(patterns[p.id]||0)+1;
  }
  const byGroup=Object.fromEntries(Object.entries(groups).map(([key,rows])=>{
    const graded=rows.filter(r=>Number.isFinite(r.twoRaterMean));
    return [key,{n:rows.length,families:new Set(rows.map(r=>r.familyId)).size,
      qualityRisk:distribution(rows.map(r=>r.qualityRisk)),grammarRisk:distribution(rows.map(r=>r.grammarRisk)),
      statisticalMargin:distribution(rows.map(r=>r.statisticalMargin)),
      hardGrammarFlagged:rows.filter(r=>r.hardGrammarCount>0).length,
      firstTwoRaterCorrelation:{n:graded.length,spearman: spearman(graded.map(r=>[r.qualityRisk,r.twoRaterMean]))}}];
  }));
  const measuredFamilies=new Set(measured.map(r=>r.familyId));
  const exposureRecords=manifest.records.filter(r=>measuredFamilies.has(r.familyId)).map(r=>({
    id:r.id,source:'nikl-writing',sourceGroup:r.familyId,group:r.familyId,normalizedSha256:r.normalizedSha256,
    lineageKeys:[...new Set(['text:'+r.normalizedSha256,'text:'+r.corpusNormalizedSha256,'nikl-family:'+r.familyId])].sort()
  }));
  const exposureManifest={version:'nikl-measured-exposure-v1',records:exposureRecords,digest:sha(JSON.stringify(exposureRecords))};
  return {version:'nikl-local-diagnostics-v1',measured:measured.length,excluded,exposureManifest,
    byGroup,topPatternDocumentCounts:patterns,rows:measured,providersCalled:0,
    liveDetectorCalled:false,liveHumanizerCalled:false,authorshipAccuracy:null,
    completedHumanQualityReviews:0,holdoutScored:false,releaseEligible:false,
    limitations:['Local quality heuristics and statistical support margin are not the live AI score or a calibrated authorship probability.',
      'Development split only; lineage-review families excluded. No candidate improvement or human review is implied.',
      'Expert comments and task answers are preserved as annotations, never guessed to be a gold rewritten text.',
      'Correlations describe the first two raters, not correctness or an adjudicated final score.']};
}
function main(manifestPath,outputPath,expectedHash) {
  if(!manifestPath||!outputPath||!/^[a-f0-9]{64}$/u.test(expectedHash||'')) throw Error('Usage: node scripts/evaluate-nikl-writing-corpus.js manifest.local.json new-output.local.json manifest-sha256');
  const source=fs.readFileSync(manifestPath);
  if(sha(source)!==expectedHash) throw Error('nikl_manifest_changed');
  const manifest=JSON.parse(source),base=path.dirname(path.resolve(manifestPath));
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  if(manifest.approval?.localEvaluationAuthorized!==true || today<manifest.approval.validFrom || today>manifest.approval.validThrough) throw Error('nikl_agreement_outside_valid_period');
  for(const [name,hash] of Object.entries(manifest.files||{})) {
    if(path.basename(name)!==name || sha(fs.readFileSync(path.join(base,name)))!==hash) throw Error('nikl_artifact_changed');
  }
  if(!manifest.files?.['texts.local.json']) throw Error('nikl_text_file_unsealed');
  const output=assertExternalOutput(outputPath,repositoryRoots());
  for(let p=path.dirname(output);;p=path.dirname(p)) {
    if(fs.existsSync(path.join(p,'.git'))) throw Error('nikl_output_inside_git');
    if(path.dirname(p)===p) break;
  }
  if(fs.existsSync(output)) throw Error('nikl_output_exists');
  const result=evaluate(manifest,JSON.parse(fs.readFileSync(path.join(base,'texts.local.json'),'utf8')));
  result.manifestSha256=expectedHash;
  result.engineFiles=Object.fromEntries(['engine/koreanQuality/detector.js','engine/koreanQuality/patterns.js',
    'engine/koreanQuality/styleConsistency.js','engine/koreanQuality/grammarPrecheck.js',
    'lib/detectStatisticalAssist.js','engine-gpt-prod/models/korean-style-statistics-v1.json']
    .map(name=>[name,sha(fs.readFileSync(path.join(__dirname,'..',name)))]));
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2),{flag:'wx'});
  const {rows,exposureManifest,...summary}=result;console.log(JSON.stringify(summary,null,2));return result;
}
if(require.main===module){try{main(...process.argv.slice(2));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={distribution,spearman,evaluate,main};
