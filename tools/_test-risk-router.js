'use strict';
// [tools/_test-risk-router.js] 저위험 보호 라우터 테스트. 실행: node tools/_test-risk-router.js
const { decideMode } = require('../engine/copykiller/risk-router');

let pass = true;
function chk(name, cond, got) {
  console.log((cond ? '✅' : '❌') + ' ' + name + (got ? '  → ' + got : ''));
  if (!cond) pass = false;
}

// 1) 문학비평형(실측 11%) → 보존
let r = decideMode({ measuredScore: 11 });
chk('실측 11% → minimal_cleanup', r.mode === 'minimal_cleanup', r.mode);

// 2) 경계(30%) → 보존
chk('실측 30% → minimal_cleanup', decideMode({ measuredScore: 30 }).mode === 'minimal_cleanup');

// 3) 고위험(88%) → full
r = decideMode({ measuredScore: 88 });
chk('실측 88% → full', r.mode === 'full', r.mode);

// 4) 실측 없고 프록시 저위험(0.28) → 보존
chk('프록시 0.28 → minimal_cleanup', decideMode({ proxyRisk: 0.28 }).mode === 'minimal_cleanup');

// 5) 실측 없고 프록시 고위험(0.54) → full
chk('프록시 0.54 → full', decideMode({ proxyRisk: 0.54 }).mode === 'full');

// 6) 실측 우선(실측 90%면 프록시 낮아도 full)
chk('실측 우선(90% + 프록시 0.1) → full', decideMode({ measuredScore: 90, proxyRisk: 0.1 }).mode === 'full');

// 7) 정보 없음 → full(기본 처리)
chk('정보 없음 → full', decideMode({}).mode === 'full');

console.log(pass ? '\n전체 통과 ✅' : '\n실패 ❌');
process.exitCode = pass ? 0 : 1;
