'use strict';
// [tools/_demo-lattice.js] 생성 0콜 변형 래티스 데모/검증.
//   실행: node tools/_demo-lattice.js [파일경로]   (기본 samples/housing-future-essay.txt)
const fs = require('fs');
const { rerank, buildVariants, TARGET_TAGS } = require('../engine/copykiller/mutation-lattice');
const proxy = require('../engine/copykiller-proxy');

const SHORT = { '무견해, 판단 회피적 성향': '판단회피', '주관성의 지나친 배제': '주관배제', '간접 화법, 비인칭 서술': '간접비인칭' };

if (!proxy.available()) { console.error('프록시 모델 없음'); process.exit(1); }

const file = process.argv[2] || 'samples/housing-future-essay.txt';
const text = fs.readFileSync(file, 'utf8').trim();

// --- 최소 검증 ---
let pass = true;
const vs = buildVariants(text);
if (!(vs.length >= 2)) { console.log('❌ 후보 2개 이상 생성 실패'); pass = false; }
if (vs.some(v => v.text !== text) === false) { console.log('❌ 변형이 원문과 동일(아무 변화 없음)'); pass = false; }

const r = rerank(text);
console.log('═══ 생성 0콜 변형 래티스 — ' + file + ' ═══');
console.log('원문 위험 ' + r.origRisk.toFixed(3) + ' | 타깃태그 ' +
  TARGET_TAGS.map(t => SHORT[t] + ' ' + r.origTags[t].toFixed(2)).join(' / '));
console.log('');
for (const s of r.scored) {
  const dl = TARGET_TAGS.map(t => SHORT[t] + (s.tagDeltas[t] >= 0 ? '↓' : '↑') + Math.abs(s.tagDeltas[t]).toFixed(2)).join(' ');
  console.log(`  [${s.label}] 위험 ${s.risk.toFixed(3)} (Δ${s.compositeDelta >= 0 ? '-' : '+'}${Math.abs(s.compositeDelta).toFixed(3)}) ` +
    `len×${s.lengthRatio.toFixed(2)} ${s.ok ? '✓gate' : '✗gate'} | ${dl}`);
}
console.log('');
if (r.winner) console.log(`승자: [${r.winner.label}] 위험 ${r.winner.risk.toFixed(3)} (원문 ${r.origRisk.toFixed(3)} → ${((1 - r.winner.risk / r.origRisk) * 100).toFixed(0)}%↓)`);
else console.log('승자 없음 → 원문 보존(개선 미미 또는 게이트 전멸)');

console.log(pass ? '\n검증 통과 ✅' : '\n검증 실패 ❌');
process.exitCode = pass ? 0 : 1;
