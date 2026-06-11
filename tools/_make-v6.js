// [_make-v6.js] v6 = 측정된 43%본(v5)에서 이음새 2곳만 최소 변경(임시 스크립트)
// ① 문단 횡단 사실 인지형 dup 해소(resolveDupSentences — 진입장벽 문단 2본→1본, 두 번~다섯 번 보존)
// ② 위빙 패치 보고서 어투("…200명을 설문 대상으로 가정하였다") → 칼럼 결의 가정 문장으로 결정론 교체
// 그 외 전부 동일 → 카피킬러 A/B가 이음새 효과만 측정.
try { require('dotenv').config(); } catch { /* 무시 */ }
process.env.LLM_BACKEND = 'api';
const fs = require('fs');
const floor = require('./engine/floor');
const gt = require('./engine/genretransfer');
const { buildSoftClaimLedger, semanticJudge } = require('./engine/judge');

const rawText = fs.readFileSync('samples/ai-learning.txt', 'utf8').trim();
const evidence = fs.readFileSync('samples/ai-learning-evidence.txt', 'utf8');
const evidenceList = evidence.split('\n').map(l => l.trim()).filter(Boolean);
const allowed = evidence;
const textF = rawText + '\n\n' + evidence;
const splitSents = (t) => t.split(/(?<=[.!?다요죠])\s+|\n+/).map(s => s.trim()).filter(Boolean);
const rawNumLines = splitSents(rawText).filter(s => /\d[\d,.]*\d/.test(s));
const pairLines = [...evidenceList, ...rawNumLines];

const md = fs.readFileSync('results/ai-learning-목소리앵커-v5.md', 'utf8');
let doc = md.split(/\n---\n+/).slice(1).join('\n---\n').trim();

const SEAM = '이러한 설계의 필요성을 실감하기 위해, 4년제 대학에 재학 중인 학생 200명을 설문 대상으로 가정하였다.';
const SEAM_NEW = '그 기준이 현장에서 어떻게 작동할지 가늠해 보려면, 4년제 대학에 재학 중인 학생 200명에게 설문을 돌린다고 가정해 보는 것도 방법이다.';

(async () => {
  doc = gt.resolveDupSentences(gt.dedupeParas(doc, textF), textF);
  console.log('① dup 해소: 진입장벽', (doc.match(/진입장벽을 낮춰준다는/g) || []).length, '회 | 두 번~다섯 번 보존:', /두 번, 세 번, 네 번, 다섯 번/.test(doc));
  if (!doc.includes(SEAM)) { console.log('❌ 이음매 문장 못 찾음'); process.exit(1); }
  doc = doc.replace(SEAM, SEAM_NEW);
  console.log('② 이음매 교체 ✅');

  const novelty = floor.measureNovelty(textF, doc, allowed);
  const lost = floor.measureLostFacts(textF, doc);
  const pairing = gt.checkEvidencePairing(doc, evidenceList);
  const pairingExt = gt.checkEvidencePairing(doc, pairLines);
  const ledger = await buildSoftClaimLedger(rawText, { lang: 'ko' });
  const judgeLedger = { ...ledger, claims: [...ledger.claims, ...evidenceList.map(e => ({ claim: e, evidence_text: e }))] };
  const v = await semanticJudge(rawText, doc, judgeLedger, { lang: 'ko', allowedExtra: allowed });
  for (const x of (v.violations || [])) console.log(`  judge ${x.type}: "${(x.span || '').slice(0, 70)}" — ${(x.detail || '').slice(0, 90)}`);
  const lenRatio = Math.round(((doc.match(/[가-힣]/g) || []).length) / (((textF.match(/[가-힣]/g) || []).length) || 1) * 100);
  console.log(`최종: novelty ${novelty.count} | lost ${lost.count}${lost.count ? ' [' + lost.items.join(', ') + ']' : ''} | 짝위반 ${pairing.length}(확장 ${pairingExt.length}) | judge ${v.pass ? 'pass ✅' : '위반 ' + v.violations.length} | 분량 ${lenRatio}%`);
  if (!v.pass || lost.count > 0 || novelty.count > 0 || pairing.length > 0 || pairingExt.length > 0) { console.log('❌ 게이트 불통 — 저장 안 함'); process.exit(1); }
  fs.writeFileSync('results/ai-learning-목소리앵커-v6.md',
    `# AI학습 — 목소리 앵커 v6(43% 측정본에서 이음새 2곳만 수정: 문단 중복 해소 + 위빙 패치 어투) · 카피킬러 측정용\n\n`
    + `> novelty 0 · lostFacts 0 · 짝위반 0(확장 포함) · judge pass · 분량 ${lenRatio}% · 43%본과의 차이는 이음새 2곳뿐(A/B)\n\n---\n\n${doc}\n`, 'utf8');
  console.log('저장: results/ai-learning-목소리앵커-v6.md');
})().catch(e => { console.error('❌', e.stack || e.message); process.exit(1); });
