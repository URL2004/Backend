// [eval/scorer-validation.js] Phase 1-2 채점기 검증 (문서 단위)
// ────────────────────────────────────────────────────────────────
// 목적: 내부 segmentGuard(suspectRatio·riskScore)가 카피킬러 실측 %를 따라가는지 검증.
//   multi-candidate(Phase 1.5)는 이 검증을 통과해야 의미가 있다(채점기 안 맞으면 비싼 랜덤).
// 방법: 실측 % 아는 결과물의 본문을 segment 분할 → 예측 지표 계산 → 실측과 순위상관.

const fs = require('fs');
const path = require('path');
const sg = require('../engine/surfaceguard');

// (결과 MD 파일, 카피킬러 실측 AI%, [전체영역, 의심영역])
const LABELED = [
  { file: '개인정보-v3-API.md', actual: 41, areas: [21, 8] },
  { file: '건강관리-API.md', actual: 45, areas: [34, 15] },
  { file: '대학시간관리-API.md', actual: 49, areas: null },
  { file: 'IT-API.md', actual: 54, areas: [4, 2] },
  { file: '건강관리-v2-메모.md', actual: 59, areas: [37, 21] },
];

// MD에서 본문만 추출(헤더/--- 이후)
function extractBody(md) {
  const i = md.indexOf('\n---\n');
  let body = i >= 0 ? md.slice(i + 5) : md;
  return body.replace(/^#.*$/gm, '').trim();
}

function spearman(xs, ys) {
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(arr.length);
    idx.forEach(([, i], k) => { r[i] = k + 1; });
    return r;
  };
  const rx = rank(xs), ry = rank(ys), n = xs.length;
  let d2 = 0; for (let i = 0; i < n; i++) d2 += (rx[i] - ry[i]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}

const TARGET = Number(process.env.SEG_CHARS) || 500;   // 카피킬러 영역 크기 근사
const rows = [];
for (const L of LABELED) {
  const p = path.join(__dirname, '..', 'results', L.file);
  if (!fs.existsSync(p)) { console.log('  (없음)', L.file); continue; }
  const body = extractBody(fs.readFileSync(p, 'utf8'));
  const rep = sg.buildSegmentReport(body, body, TARGET);
  const risks = rep.rows.map(r => r.riskScore);
  const meanRisk = risks.reduce((a, b) => a + b, 0) / (risks.length || 1);
  const predByRisk = risks.filter(r => r >= 0.5).length / (risks.length || 1);   // riskScore 임계 0.5
  rows.push({
    file: L.file, actual: L.actual,
    segs: rep.segments,
    suspectRatioBinary: rep.suspectRatio,        // 레거시 concrete===0
    meanRisk: Number(meanRisk.toFixed(3)),
    predByRisk: Number(predByRisk.toFixed(3)),
  });
}

console.log('\n=== 문서 단위 채점기 검증 (targetChars=' + TARGET + ') ===');
console.log('file'.padEnd(26), '실측%', 'seg', 'binary%', 'meanRisk', 'risk>0.5%');
for (const r of rows) {
  console.log(
    r.file.padEnd(26),
    String(r.actual).padStart(4),
    String(r.segs).padStart(4),
    String(Math.round(r.suspectRatioBinary * 100)).padStart(6) + '%',
    String(r.meanRisk).padStart(7),
    String(Math.round(r.predByRisk * 100)).padStart(7) + '%'
  );
}
const act = rows.map(r => r.actual);
console.log('\nSpearman 순위상관 (실측% vs 예측):');
console.log('  binary suspectRatio :', spearman(act, rows.map(r => r.suspectRatioBinary)).toFixed(3));
console.log('  meanRiskScore       :', spearman(act, rows.map(r => r.meanRisk)).toFixed(3));
console.log('  risk>0.5 ratio      :', spearman(act, rows.map(r => r.predByRisk)).toFixed(3));
console.log('\n(상관 1.0=완벽, 0=무관. 0.7+ 면 채점기가 카피킬러 순위를 따라감 = multi-candidate 투입 가능)');
