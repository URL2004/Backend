// [_inspect-pairing.js] routine v2 짝위반 2건 실체 확인(임시)
const fs = require('fs');
const gt = require('./engine/genretransfer');

const evidence = fs.readFileSync('samples/routine-evidence.txt', 'utf8');
const evidenceList = evidence.split('\n').map(l => l.trim()).filter(Boolean);
const md = fs.readFileSync('results/routine-목소리앵커-v2.md', 'utf8');
const doc = md.split(/\n---\n+/).slice(1).join('\n---\n').trim();

for (const b of gt.checkEvidencePairing(doc, evidenceList)) {
  console.log(`수치 ${b.num}`);
  console.log(`  문장: ${b.sent}`);
  console.log(`  소유 근거: ${b.owner}`);
  console.log('---');
}
