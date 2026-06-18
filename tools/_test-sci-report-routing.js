// [tools/_test-sci-report-routing.js] 과학·기술 연구 보고서 자소서 오판 회귀(2026-06-18 실측 ysko1002 EGFR
//   분자도킹 보고서 4회 연속 차단): "비소세포폐암을 관심 질병으로 선정하였다"의 '선정하였다'가 looksLikeResume에
//   걸리고 인용이 (GeneCards)·(PubChem) DB명이라 인용 예외도 못 타 kind=resume로 오차단됐다.
//   기대: looksLikeResume=false, restructureUnfit.unfit=false, isStructuredReport=true(→ 구조보존 청크 우회).
//   ★ 진짜 자소서·탐구문은 그대로 잡혀야 한다(회귀 방지).
const ir = require('../engine/inputrouting');

let fail = 0;
const ok = (cond, m) => { if (!cond) { fail++; console.log('  ❌ ' + m); } else console.log('  ✅ ' + m); };

// ── EGFR 분자도킹 탐구 보고서(ysko1002, 실제 차단 글 축약: 번호섹션 1~4 + SMILES·PDB·CID·돌연변이 + "선정하였다")
const egfr = `1. 관심 질병 선정

선정 질병명: 비소세포폐암 (Non-Small Cell Lung Cancer, NSCLC)
폐암은 전 세계적으로 사망률이 높은 악성 종양이며, 전체 폐암 환자의 약 80~85%가 비소세포폐암(NSCLC)에 해당한다. 아시아계 환자의 약 40~50%에서 특정 표적 유전자의 돌연변이가 관찰된다. 본 연구에서는 약물 저항성 극복을 위한 분자 도킹(Molecular Docking) 시뮬레이션을 수행하고자 비소세포폐암을 관심 질병으로 선정하였다.

2. 질병의 대표적인 생체마커인 단백질 선정

선정 단백질명: 상피세포 성장인자 수용체 (Epidermal Growth Factor Receptor, EGFR)
EGFR은 세포막에 위치한 수용체 타이로신 키나아제(Receptor Tyrosine Kinase, RTK)다. 비소세포폐암 환자군에서 EGFR 유전자의 특정 돌연변이(Exon 19 결실, L858R 치환)나 과발현이 빈번하게 관찰된다. 본 연구는 EGFR을 타깃 단백질로 선정하였다.

3. 바이오마커에 대한 정보 정리

공식 명칭 및 유전자 정보 (GeneCards): EGFR은 7번 염색체(7p11.2)에 위치한 EGFR 유전자가 암호화하는 단백질로, ErbB1 또는 HER1으로도 불린다.
분자 메커니즘 및 최신 연구 동향 (PubMed & NCBI): EGFR은 외부 리간드와 결합 시 이량체를 형성하고 키나아제 도메인에서 자가인산화가 일어난다.
3차원 구조 정보 분석 및 PDB ID 선정 (RCSB PDB): 선정된 PDB ID는 1M17로, 에를로티닙이 결합된 복합체 구조이며 2.60 Å 해상도로 규명되었다.

4. 바이오마커의 발현 억제제와 유도제 탐색

PubChem에서 세대별 표적 저해제를 탐색하였다.
화합물명: 게피티닙 (Gefitinib) PubChem CID: 123631 SMILES Code: COC1=C(C=C2C(=C1)N=CN=C2NC3=CC(=C(C=C3)F)Cl)OCCCN4CCOCC4
게피티닙은 1세대 가역적 EGFR 표적 치료제로 대조군으로 선정하였다.
화합물명: 오시머티닙 (Osimertinib) PubChem CID: 71496458 SMILES Code: CN(C)CC=CC(=O)NC1=CC(=C(C=C1)NC2=NC=CC(=N2)N(C)C3=CC=CC=C3)OC
오시머티닙은 3세대 비가역적 치료제로 최종 실험군으로 선정하였다.`;

console.log('=== EGFR 과학 보고서 → 자소서 아님 + 구조보존 라우팅 ===');
console.log('   sciReportMarkers=' + ir.sciReportMarkers(egfr) + ' / topSec 기반');
ok(ir.looksLikeResume(egfr) === false, 'looksLikeResume=false (자소서 오판 해제)');
ok(ir.restructureUnfit(egfr, {}).unfit === false, 'restructureUnfit.unfit=false (사전차단 해제)');
ok(ir.isStructuredReport(egfr) === true, 'isStructuredReport=true (→ 구조보존 청크 우회 라우팅)');

console.log('\n=== 진짜 자소서·탐구문 → 그대로 잡힘(회귀 방지) ===');
ok(ir.looksLikeResume('저는 이 주제를 선정하게 된 계기가 있습니다. 지원 동기는 명확합니다. 입사 후 성장하고 싶습니다. 제 강점은 성실함입니다.') === true, '자소서(주제선정+지원동기)');
ok(ir.looksLikeResume('생활기록부 진로활동: 평소 관심 분야를 탐구 주제로 정하고 탐구해 보고 싶었다. 이번 탐구를 통해 느낀 점이 많다. 후속 활동으로 더 깊이 탐구하고 싶다.') === true, '생기부 탐구활동(탐구 마커 다수)');
ok(ir.looksLikeResume('나는 이 책을 읽고 환경 문제에 관심을 갖게 되어 관련 주제를 선택했다. 동아리 활동에서도 이를 발표했다.') === true, '주제 선택 + 동아리(강신호)');

console.log('\n=== 과학 보고서가 아닌데 sciMarker 우연 1~2개 → 영향 없음 ===');
ok(ir.looksLikeResume('저는 단백질 보충제에 관심이 많아 이 주제를 선정했습니다. 지원 동기이자 제 강점입니다. 입사하면 기여하겠습니다.') === true, '자소서에 "단백질" 1회 — 여전히 자소서');

console.log('\n' + (fail === 0 ? '── 전체 통과 ──' : `── ${fail}건 실패 ──`));
process.exit(fail === 0 ? 0 : 1);
