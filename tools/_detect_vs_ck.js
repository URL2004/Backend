// [tools/_detect_vs_ck.js] 제품 detect(LLM) vs 실제 카피킬러 AI% 상관 검증.
//   목적: detect가 TF-IDF 프록시(r=0.30)보다 카피킬러와 잘 맞으면 입력 게이트 신호로 우선.
//   비용 방어: 기본 stratified 샘플 N개만 호출(전수는 --all). .env의 ANTHROPIC_API_KEY 사용.
//   usage: node tools/_detect_vs_ck.js [N]   (기본 40)  |  node tools/_detect_vs_ck.js --all
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const analyze = require('../routes/analyze');

const ROOT = path.join(__dirname, '../..');
const ck = JSON.parse(fs.readFileSync(path.join(ROOT, 'copykiller_results.json'), 'utf8'));
const tx = JSON.parse(fs.readFileSync(path.join(ROOT, '오늘-원문-휴머나이징-2026-06-19.json'), 'utf8'));
const bynum = {}; tx.forEach(r => bynum[+r['번호']] = r);

// 264 docs = (pair, side, text, ck%)
const docs = [];
for (const r of ck) {
  const t = bynum[r.pair]; if (!t) continue;
  if (r.orig != null) docs.push({ pair: r.pair, side: 'orig', text: t['원문'] || '', ck: r.orig });
  if (r.human != null) docs.push({ pair: r.pair, side: 'hum', text: t['휴머나이징된글'] || '', ck: r.human });
}

const arg = process.argv[2];
const ALL = arg === '--all';
const N = ALL ? docs.length : (parseInt(arg, 10) || 40);

// stratified sample by ck bucket so 0/100 양극단이 고루 포함
function sample(arr, n) {
  if (n >= arr.length) return arr;
  const buckets = {}; arr.forEach(d => { const b = Math.min(4, Math.floor(d.ck / 25)); (buckets[b] = buckets[b] || []).push(d); });
  const out = []; const per = Math.ceil(n / Object.keys(buckets).length);
  for (const b of Object.keys(buckets)) {
    const arrB = buckets[b];
    for (let i = 0; i < arrB.length && out.length < n; i += Math.max(1, Math.floor(arrB.length / per))) out.push(arrB[i]);
  }
  return out.slice(0, n);
}
const chosen = sample(docs, N);

function pearson(xs, ys) { const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n; let nu = 0, dx = 0, dy = 0; for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; nu += a * b; dx += a * a; dy += b * b; } return dx && dy ? nu / Math.sqrt(dx * dy) : 0; }

(async () => {
  console.log(`detect 호출 ${chosen.length}개 (전체 ${docs.length})...`);
  const proxy = require('../engine/copykiller-proxy');
  const out = [];
  let i = 0;
  for (const d of chosen) {
    i++;
    try {
      const r = await analyze.runDetect(d.text.slice(0, 12000), 'ko');
      const det = typeof r.probability === 'number' ? r.probability : null;
      const px = proxy.airateAvailable() ? proxy.predictAiRate(d.text) * 100 : null;
      out.push({ ...d, detect: det, proxy: px });
      if (i % 10 === 0) console.log(`  ${i}/${chosen.length}`);
    } catch (e) { console.error('  detect fail', d.pair, d.side, e.message); }
  }
  const valid = out.filter(o => o.detect != null);
  console.log(`\n성공 ${valid.length}개`);
  console.log('corr(detect, 카피킬러)  r =', pearson(valid.map(o => o.detect), valid.map(o => o.ck)).toFixed(3), ' (프록시 ai% r 비교용:', proxy.airateAvailable() ? pearson(valid.map(o => o.proxy), valid.map(o => o.ck)).toFixed(3) : 'n/a', ')');
  // 0~100 구간 정확도 느낌
  const hi = valid.filter(o => o.ck >= 50), lo = valid.filter(o => o.ck < 50);
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  console.log('카피킬러 AI(≥50) 군 detect 평균:', avg(hi.map(o => o.detect)).toFixed(1), '| 사람(<50) 군 detect 평균:', avg(lo.map(o => o.detect)).toFixed(1));
  fs.writeFileSync(path.join(ROOT, 'detect_vs_ck_sample.json'), JSON.stringify(out, null, 1));
  console.log('saved detect_vs_ck_sample.json');
})();
