// [_fix-aistudy4.js] ai-study 63%본 → v2(임시): 사실 재인용 제거(수치 기반) + 비수치 반복 문단·고아 stub 결정론 제거
// 63% PDF 진단: 같은 통계 2~4회 재인용 + 같은 논지 문단 반복 = '기계적 정확성·균일성' 4영역의 직접 원인.
try { require('dotenv').config(); } catch { /* 무시 */ }
process.env.LLM_BACKEND = 'api';
const fs = require('fs');
const floor = require('./engine/floor');
const gt = require('./engine/genretransfer');
const gf = require('./engine/genreframes');
const { buildSoftClaimLedger, semanticJudge } = require('./engine/judge');

const rawText = fs.readFileSync('samples/ai-study-report.txt', 'utf8').trim();
const evidence = fs.readFileSync('samples/ai-learning-evidence.txt', 'utf8');
const evidenceList = evidence.split('\n').map(l => l.trim()).filter(Boolean);
const allowed = evidence;
const textF = rawText + '\n\n' + evidence;

const md = fs.readFileSync('results/ai-study-목소리앵커-v1.md', 'utf8');
let doc = md.split(/\n---\n+/).slice(1).join('\n---\n').trim();

(async () => {
  // ① 수치 기반 사실 재인용 제거(13주×4·558명×2 등 → 각 1회)
  const before = doc.replace(/\s/g, '').length;
  doc = gt.dedupeFactRecitations(doc, evidenceList, textF);
  console.log(`① 재인용 제거: ${before}자 → ${doc.replace(/\s/g, '').length}자`);

  // ② 비수치 반복·고아 stub 결정론 제거
  const CUTS = [
    // 글쓰기 외주 논지 통째 중복 문단(앞 영역에서 이미 전개됨)
    '글쓰기가 특히 그렇다. AI가 생성한 문장을 조금 손봐서 제출하는 순간, 학생은 자기 생각을 근거로 세우고 논리를 조립하는 과정 전체를 건너뛴다. 문장 배열 기술이 아니라 그 안에서 사고가 단련되는 건데, AI가 뽑아준 반듯한 단락은 그 훈련을 통째로 우회한다. 게다가 AI는 존재하지 않는 논문을 있는 것처럼 인용하고, 사실과 다른 내용을 그럴듯한 문체로 포장해 넘긴다. 출처 검증 없이 과제에 얹으면 틀린 정보가 최종 제출물에 그대로 박힌다. AI는 오류를 생성할 수 있다.\n\n',
    // 재인용 제거가 남긴 고아 stub
    ' 2023년에 가이드라인이 도입되었다.',
    // 연세대 가이드라인 재진술 문단(첫 진술이 위에 있음) + 고아 stub
    '공정성·투명성·책임성을 핵심 요소로 삼겠다고 밝힌 대학들이 연세대, 고려대, 중앙대, 부산대 포함 이미 2023년부터 줄을 섰다. 그런데 그 원칙들이 실제 수업에서 학생에게 전달되는 경로가 어디인지는 여전히 모호하다. 그 자리가 지금 어디에 있는지는 분명하지 않다.\n\n',
    // 서울대 가이드라인 ×2 중 앞쪽(부가가치 없는 "같은 층위" 언급 — 뒤쪽이 판단 책임→리터러시로 연결돼 더 유용)
    ' 서울대가 교육·연구·행정 전 영역에 걸쳐 \'AI 가이드라인\'을 제정하고 비판적 활용과 사회적 책임을 명시한 것도 같은 층위의 이야기다.',
    // 위 연세대 문단 제거로 고아가 되는 연결 문장
    '결국 자리를 만드는 것도 사람이고, 그 자리에 뭘 채울지 결정하는 것도 사람이다. ',
  ];
  for (const c of CUTS) {
    if (!doc.includes(c)) { console.log('❌ 못 찾음:', c.replace(/\s+/g, ' ').slice(0, 50)); process.exit(1); }
    doc = doc.replace(c, '');
  }
  console.log(`② 반복 문단·stub 제거 5건 ✅ → ${doc.replace(/\s/g, '').length}자`);
  doc = gt.resolveDupSentences(gt.dedupeParas(doc, textF), textF);

  // ③ 최종 게이트 + judge
  const novelty = floor.measureNovelty(textF, doc, allowed);
  const lost = floor.measureLostFacts(textF, doc);
  const pairing = gt.checkEvidencePairing(doc, evidenceList);
  const risk = gf.genreRiskScore(doc).score;
  console.log(`결정론 검증: novelty ${novelty.count} | lost ${lost.count}${lost.count ? ' [' + lost.items.join(', ') + ']' : ''} | 짝 ${pairing.length} | genreRisk ${risk}`);
  if (novelty.count > 0 || lost.count > 0 || pairing.length > 0) { console.log('❌ 게이트 불통 — 저장 안 함'); process.exit(1); }
  const ledger = await buildSoftClaimLedger(rawText, { lang: 'ko' });
  const judgeLedger = { ...ledger, claims: [...ledger.claims, ...evidenceList.map(e => ({ claim: e, evidence_text: e }))] };
  const v = await semanticJudge(rawText, doc, judgeLedger, { lang: 'ko', allowedExtra: allowed });
  for (const x of (v.violations || [])) console.log(`  judge ${x.type}: "${(x.span || '').slice(0, 70)}" — ${(x.detail || '').slice(0, 90)}`);
  const lenRatio = Math.round(((doc.match(/[가-힣]/g) || []).length) / (((textF.match(/[가-힣]/g) || []).length) || 1) * 100);
  console.log(`최종: judge ${v.pass ? 'pass ✅' : '위반 ' + v.violations.length} | 분량 ${lenRatio}%`);
  if (!v.pass) { console.log('❌ judge 불통 — 저장 안 함'); process.exit(1); }
  fs.writeFileSync('results/ai-study-목소리앵커-v2.md',
    `# AI학습보고서 — 목소리 앵커 v2(63%본에서 사실 재인용·반복 문단만 제거 — A/B) · 카피킬러 측정용\n\n`
    + `> novelty 0 · lostFacts 0 · 짝위반 0 · judge pass · 분량 ${lenRatio}% · 63%본과의 차이는 중복 제거뿐\n\n---\n\n${doc}\n`, 'utf8');
  console.log('저장: results/ai-study-목소리앵커-v2.md');
})().catch(e => { console.error('❌', e.stack || e.message); process.exit(1); });
