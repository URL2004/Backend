// [_inspect-aistudy.js] ai-study v1 위반 실체 확인(임시)
const fs = require('fs');
const floor = require('./engine/floor');
const gt = require('./engine/genretransfer');

const raw = fs.readFileSync('samples/ai-study-report.txt', 'utf8').trim();
const evidence = fs.readFileSync('samples/ai-learning-evidence.txt', 'utf8');
const textF = raw + '\n\n' + evidence;
const md = fs.readFileSync('results/ai-study-목소리앵커-v1.md', 'utf8');
const doc = md.split(/\n---\n+/).slice(1).join('\n---\n').trim();

const nov = floor.measureNovelty(textF, doc, evidence);
console.log('novelty:', nov.count, JSON.stringify(nov.items));
for (const it of nov.items || []) {
  const i = doc.indexOf(String(it).replace(/^.*?:/, ''));
  const j = doc.indexOf(it);
  const k = j >= 0 ? j : i;
  if (k >= 0) console.log(`  맥락: …${doc.slice(Math.max(0, k - 80), k + 100).replace(/\s+/g, ' ')}…`);
}
const i45 = doc.indexOf('45.9');
console.log('--- 45.9 구간 ---');
console.log(doc.slice(Math.max(0, i45 - 300), i45 + 250).replace(/\s+/g, ' '));
console.log('--- 직능연 등장 ---', (doc.match(/한국직업능력연구원/g) || []).length, '회 | 오픈서베이:', (doc.match(/오픈서베이/g) || []).length, '회');
