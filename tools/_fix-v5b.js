// [_fix-v5b.js] v5 마지막 손질(임시): 위빙이 지어낸 가상 설문 방법론 문장을 원문 맥락 문장으로 결정론 교체 → 전 게이트 재검증
try { require('dotenv').config(); } catch { /* 무시 */ }
process.env.LLM_BACKEND = 'api';
const fs = require('fs');
const floor = require('./engine/floor');
const gt = require('./engine/genretransfer');
const { buildSoftClaimLedger, semanticJudge } = require('./engine/judge');

const FILE = 'results/ai-learning-목소리앵커-v5.md';
const rawText = fs.readFileSync('samples/ai-learning.txt', 'utf8').trim();
const evidence = fs.readFileSync('samples/ai-learning-evidence.txt', 'utf8');
const evidenceList = evidence.split('\n').map(l => l.trim()).filter(Boolean);
const allowed = evidence;
const textF = rawText + '\n\n' + evidence;
const splitSents = (t) => t.split(/(?<=[.!?다요죠])\s+|\n+/).map(s => s.trim()).filter(Boolean);
const rawNumLines = splitSents(rawText).filter(s => /\d[\d,.]*\d/.test(s));
const pairLines = [...evidenceList, ...rawNumLines];

const md = fs.readFileSync(FILE, 'utf8');
let doc = md.split(/\n---\n+/).slice(1).join('\n---\n').trim();

const BAD = '이 가상의 설문에서 학생들에게 특정 개념에 대한 이해 수준을 AI 답변 수령 전후로 각각 자기 평가하게 하고, 이후 실제 시험 결과와 대조해보는 방식을 상정한다면, AI는 이러한 부분에 대해 1차 피드백을 제공할 수 있다.';
const GOOD = '이 가상의 설문 구조에서도 학생이 과제를 수행하면서 자신의 결과물이 적절한지 판단하기 어려운 순간은 그대로 남는데, AI는 이러한 부분에 대해 1차 피드백을 제공할 수 있다.';

(async () => {
  if (!doc.includes(BAD)) { console.log('❌ 대상 문장을 찾지 못함 — 파일 미변경'); process.exit(1); }
  doc = doc.replace(BAD, GOOD);
  console.log('교체 ✅');
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
  if (!v.pass || lost.count > 0 || novelty.count > 0 || pairing.length > 0 || pairingExt.length > 0) { console.log('❌ 게이트 불통 — 파일 미변경'); process.exit(1); }
  fs.writeFileSync(FILE,
    `# AI학습 — 목소리 앵커 v5(짝게이트 감점화 + judge 문장수리 + 맥락 인용 재위빙) · 카피킬러 측정용\n\n`
    + `> novelty 0 · lostFacts 0 · 짝위반 0(원문 수치 확장검증 포함) · judge pass · 분량 ${lenRatio}%\n\n---\n\n${doc}\n`, 'utf8');
  console.log('저장:', FILE);
})().catch(e => { console.error('❌', e.stack || e.message); process.exit(1); });
