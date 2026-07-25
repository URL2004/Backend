// [tools/_cost-summary.js] GPT usage 로그(JSONL)를 task/model별 USD로 합산.
//   사용: Render 로그를 파일로 받아  node tools/_cost-summary.js logs.jsonl   (또는 stdin 파이프)
//   목적: *우리* 트래픽에서 어디에 돈이 쓰이는지(main generation vs judge vs microcall vs evidence) 보고 다음 최적화 결정.
const fs = require('fs');

function* lines(src) {
  for (const ln of src.split(/\r?\n/)) { const s = ln.trim(); if (s) yield s; }
}
function add(map, key, usd, tok) { const m = map[key] || (map[key] = { calls: 0, usd: 0, out: 0 }); m.calls++; m.usd += usd; m.out += tok; }

const file = process.argv[2];
const raw = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
const byTask = {}, byModel = {}, byMode = {};
let total = 0, n = 0, ws = 0;
for (const ln of lines(raw)) {
  let o; try { o = JSON.parse(ln); } catch { continue; }
  if (!['gpt_prod.usage', 'llm.usage'].includes(o.event)) continue;
  const usd = Number(o.estimatedUsd) || 0;
  const tok = Number(o.outputTokens) || 0;
  total += usd; n++; ws += Number(o.webSearchRequests) || 0;
  add(byTask, o.task || 'unspecified', usd, tok);
  add(byModel, o.selectedModel || o.model || 'unknown', usd, tok);
  if (o.mode) add(byMode, o.mode, usd, tok);
}
function table(title, map) {
  console.log(`\n── ${title} ──`);
  const rows = Object.entries(map).sort((a, b) => b[1].usd - a[1].usd);
  for (const [k, m] of rows) {
    const pct = total ? (m.usd / total * 100).toFixed(1) : '0.0';
    console.log(`  ${k.padEnd(16)} $${m.usd.toFixed(4).padStart(9)}  (${pct.padStart(5)}%)  calls=${m.calls}  out_tok=${m.out}`);
  }
}
console.log(`=== 비용 집계: GPT usage ${n}건, 추정 합계 $${total.toFixed(4)}, web_search ${ws}회 ===`);
table('task별(=hotspot)', byTask);
table('model별', byModel);
if (Object.keys(byMode).length) table('mode별', byMode);
console.log('\n※ task·phase·selectedModel 기준으로 생성·판정·수리·근거검색 비용을 분리한다.');
