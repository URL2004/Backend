// [_fix-routine2.js] routine v1b의 무날조 위반 2건 결정론 수정(임시 스크립트)
// ① '정-반 효과' — 원문에 없는 용어를 심리학에 귀속(용어 날조) → 용어 제거, 현상 서술(원문 실재)만 유지
// ② '경험적으로 검증된 사실' — 원문의 권고를 검증된 사실로 격상(인식적 과장) → 경험 화법으로 강등
const fs = require('fs');
const floor = require('./engine/floor');
const gf = require('./engine/genreframes');

const FILE = 'results/routine-목소리앵커-v1.md';
const raw = fs.readFileSync('samples/routine.txt', 'utf8').trim();
const md = fs.readFileSync(FILE, 'utf8');
const head = md.split(/\n---\n+/)[0];
let doc = md.split(/\n---\n+/).slice(1).join('\n---\n').trim();

const FIXES = [
  ["(이걸 심리학 쪽에서는 '정-반 효과'라고 부르기도 한다 — 하나 어기면 이왕 망친 거 다 어기게 되는 그 심리).",
    "(하나 어기면 이왕 망친 거 다 어기게 되는, 그 심리다)."],
  ["— 이건 심리학 이론이 아니라 그냥 경험적으로 검증된 사실이다.",
    "— 거창한 이론이 아니라, 해본 사람은 아는 종류의 일이다."],
];
for (const [oldS, newS] of FIXES) {
  if (!doc.includes(oldS)) { console.log('❌ 못 찾음:', oldS.slice(0, 40)); process.exit(1); }
  doc = doc.replace(oldS, newS);
}
console.log('교체 2건 ✅');
const nov = floor.measureNovelty(raw, doc, '').count;
const lost = floor.measureLostFacts(raw, doc).count;
console.log('novelty', nov, '| lost', lost, '| genreRisk', gf.genreRiskScore(doc).score, "| 정-반 잔존:", doc.includes('정-반'), '| 검증된 사실 잔존:', doc.includes('검증된 사실'));
if (nov > 0 || lost > 0 || doc.includes('정-반')) { console.log('❌ 게이트 불통 — 저장 안 함'); process.exit(1); }
fs.writeFileSync(FILE, head.replace('v1b(36% 스택+윙크제거', 'v1c(+용어날조·과장 2건 수정') + '\n---\n\n' + doc + '\n', 'utf8');
console.log('저장:', FILE);
