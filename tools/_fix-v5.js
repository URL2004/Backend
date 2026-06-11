// [_fix-v5.js] v5 결과물 무결성 마무리(임시 스크립트) — v3
// v5 저장본의 융합 1건("성균관대 … 1차 조사 200명을 포함한") 결정론 제거 → 맥락 인용 재위빙 → 확장 짝검증+judge로 저장.
// 교훈: 재위빙에 맨 토큰만 주면 LLM이 자리를 추측해 남의 조사에 꽂는다(200명=가상 설문 가정, 1차=AI 1차 피드백).
try { require('dotenv').config(); } catch { /* 무시 */ }
process.env.LLM_BACKEND = 'api';
const fs = require('fs');
const floor = require('./engine/floor');
const gt = require('./engine/genretransfer');
const { buildSoftClaimLedger, semanticJudge, llmText, MODEL } = require('./engine/judge');

const FILE = 'results/ai-learning-목소리앵커-v5.md';
const rawText = fs.readFileSync('samples/ai-learning.txt', 'utf8').trim();
const evidence = fs.readFileSync('samples/ai-learning-evidence.txt', 'utf8');
const evidenceList = evidence.split('\n').map(l => l.trim()).filter(Boolean);
const allowed = evidence;
const textF = rawText + '\n\n' + evidence;
const splitSents = (t) => t.split(/(?<=[.!?다요죠])\s+|\n+/).map(s => s.trim()).filter(Boolean);

// 확장 짝검증: evidence뿐 아니라 "원문의 수치 문장"도 소유자 줄로 — 원문 수치(200명 등)가 남의 조사에 붙는 융합 검출
const rawNumLines = splitSents(rawText).filter(s => /\d[\d,.]*\d/.test(s));
const pairLines = [...evidenceList, ...rawNumLines];
const META_NOTE_RE = /(메모\s*:|밝힙니다|지시에\s*따라|삽입하지\s*않|본문만\s*출력|위\s*지침|요청하신)/;

const md = fs.readFileSync(FILE, 'utf8');
let doc = md.split(/\n---\n+/).slice(1).join('\n---\n').trim();

(async () => {
  // ① 융합 구절 결정론 제거
  const FUSED = '1차 조사 200명을 포함한 학생 558명';
  if (doc.includes(FUSED)) { doc = doc.replace(FUSED, '학생 558명'); console.log('① 융합 구절 제거 ✅'); }
  else console.log('① 융합 구절 없음(이미 제거됨?)');

  // ② 맥락 인용 재위빙
  const srcSentsAll = splitSents(textF);
  const lostCtx = (it) => {
    const s = srcSentsAll.find(x => x.includes(it));
    return s ? `${it} (원문 맥락: "${s.replace(/\s+/g, ' ').slice(0, 110)}" — 이 맥락 그대로만, 다른 조사·기관·수치와 결합 금지)` : it;
  };
  let curLost = floor.measureLostFacts(textF, doc);
  console.log(`② 재위빙 대상: ${curLost.count}건 [${curLost.items.join(', ')}]`);
  for (let r = 0; r < 3 && curLost.count > 0; r++) {
    const cand = ((await llmText({
      system: `아래 칼럼에 빠진 사실들을 가장 자연스러운 자리에 끼워 넣어 전체를 다시 출력하라. 빠진 사실:\n${curLost.items.map(lostCtx).map(x => '· ' + x).join('\n')}\n★각 사실은 원문 맥락의 의미 그대로 — 가정·가상이면 가정임이 드러나게. 구조·문체 유지, 새 사실·새 결합 금지, 본문만 출력.`,
      user: doc, maxTokens: 8000, model: MODEL
    }) || '').trim());
    if (!cand || META_NOTE_RE.test(cand.split(/\n{2,}/).pop()) || floor.measureNovelty(textF, cand, allowed).count > 0) continue;
    if (gt.checkEvidencePairing(cand, pairLines).length > gt.checkEvidencePairing(doc, pairLines).length) { console.log(`  라운드 ${r + 1}: 확장 짝위반 증가 → 폐기`); continue; }
    const l2 = floor.measureLostFacts(textF, cand);
    if (l2.count < curLost.count) { doc = cand; curLost = l2; console.log(`  라운드 ${r + 1}: lost ${curLost.count}건 남음`); }
  }

  // ③ 최종 게이트 + judge
  const novelty = floor.measureNovelty(textF, doc, allowed);
  const lost = floor.measureLostFacts(textF, doc);
  const pairing = gt.checkEvidencePairing(doc, evidenceList);
  const pairingExt = gt.checkEvidencePairing(doc, pairLines);
  for (const b of pairingExt) console.log(`  확장 짝위반: ${b.num} — "${b.sent.slice(0, 70)}"`);
  const ledger = await buildSoftClaimLedger(rawText, { lang: 'ko' });
  const judgeLedger = { ...ledger, claims: [...ledger.claims, ...evidenceList.map(e => ({ claim: e, evidence_text: e }))] };
  const v = await semanticJudge(rawText, doc, judgeLedger, { lang: 'ko', allowedExtra: allowed });
  for (const x of (v.violations || [])) console.log(`  judge ${x.type}: "${(x.span || '').slice(0, 70)}" — ${(x.detail || '').slice(0, 90)}`);
  const lenRatio = Math.round(((doc.match(/[가-힣]/g) || []).length) / (((textF.match(/[가-힣]/g) || []).length) || 1) * 100);
  console.log(`최종: novelty ${novelty.count} | lost ${lost.count}${lost.count ? ' [' + lost.items.join(', ') + ']' : ''} | 짝위반 ${pairing.length}(확장 ${pairingExt.length}) | judge ${v.pass ? 'pass ✅' : '위반 ' + v.violations.length} | 분량 ${lenRatio}%`);
  if (!v.pass || lost.count > 0 || novelty.count > 0 || pairing.length > 0 || pairingExt.length > 0) { console.log('❌ 미수렴 — 파일 미변경'); process.exit(1); }
  fs.writeFileSync(FILE,
    `# AI학습 — 목소리 앵커 v5(짝게이트 감점화 + judge 문장수리 + 맥락 인용 재위빙) · 카피킬러 측정용\n\n`
    + `> novelty 0 · lostFacts 0 · 짝위반 0(원문 수치 확장검증 포함) · judge pass · 분량 ${lenRatio}%\n\n---\n\n${doc}\n`, 'utf8');
  console.log('저장:', FILE);
})().catch(e => { console.error('❌', e.stack || e.message); process.exit(1); });
