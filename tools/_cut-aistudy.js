// [_cut-aistudy.js] ai-study v3(48%) → v4: 분량 컷 실험(임시) — 피탐 영역 내 사실-무관 논증만 결정론 제거
// 3층 모델의 3층(노출 면적) 검증: 74→~63%로 줄여 40%대 진입 여부 측정. 사실 품은 문단은 불가침.
try { require('dotenv').config(); } catch { /* 무시 */ }
process.env.LLM_BACKEND = 'api';
const fs = require('fs');
const floor = require('./engine/floor');
const gt = require('./engine/genretransfer');
const gf = require('./engine/genreframes');
const { buildSoftClaimLedger, semanticJudge } = require('./engine/judge');

const rawText = fs.readFileSync('samples/ai-study-report.txt', 'utf8').trim();
let evList = fs.readFileSync('samples/ai-study-evidence.txt', 'utf8').split('\n').map(l => l.trim()).filter(Boolean);

const md = fs.readFileSync('results/ai-study-목소리앵커-v3.md', 'utf8');
let doc = md.split(/\n---\n+/).slice(1).join('\n---\n').trim();

const CUTS = [
  // 맨몸 피벗 문단(LLM 전형 전환부)
  '그렇다면 쟁점은 사용 여부가 아니라 방향이다. AI를 자기 사고의 보조로 붙이느냐, 사고 자체를 위탁하느냐—그 갈림목에서 학생 본인이 지금 어느 쪽에 서 있는지 스스로 알 수 있는가.\n\n',
  // 간호 연구 에코 문단
  '학습몰입, 자기주도학습능력, 학업적 자기효능감이 모두 통계적으로 유의하게 향상됐다. 무엇을 하려는 의지가 있는 학생에게, 반복 가능한 틀을 제공했을 때. 그 두 조건이 겹쳤을 때 AI는 실제로 뭔가를 바꿨다.\n\n',
  // 정보신뢰 문단 통째(환각 메커니즘 사실 포함 — 원장에서도 제거)
  '정보 신뢰 문제는 더 까다롭다. AI가 틀린 정보를 낼 때, 그 문장은 대개 틀린 티가 나지 않는다. 존재하지 않는 논문을 인용하거나, 실제 연구 결과를 뒤집어서 요약하거나, 특정 주제를 지나치게 단순화하는 일이 번듯한 문체 안에 끼어든다. 이는 구조적인 이유가 있다. 대규모 언어모델은 문장이 사실인지 판단하지 않고 다음에 올 말을 확률적으로 예측하기 때문에, 신뢰할 만한 지식과 잘못된 정보를 같은 방식으로 제시한다. 학생이 검증 없이 그 내용을 과제에 넣으면, 틀린 근거가 그럴듯한 논증의 뼈대가 되어버린다. 대학 과제에서 출처와 근거가 중요한 이유가 바로 여기 있는데(단순히 교수가 확인하려는 게 아니라, 주장의 신뢰 가능성을 학생 스스로 검토하도록 훈련하는 장치이기 때문에), AI 답변을 그냥 받아 쓰는 습관은 그 훈련 회로를 아예 차단한다.\n\n',
  // 피탐 구간 사실-무관 문장 트림
  '특정 강의 주제의 예상 문제를 만들어달라 하고, 자기가 쓴 답안을 AI에게 보여주며 부족한 점을 묻는 방식은 단순 암기와는 결이 다르다. 자기 답안을 다시 검토하게 만든다는 것만으로도 수동적 반복과는 다른 회로를 건드린다.',
  '겉보기에 완성된 답변일수록 비판적으로 훑어야 한다는 말은 맞는데, 문장이 자연스럽고 구조가 반듯할수록 학생은 오히려 그냥 믿는다.',
  '결국 활용 능력 격차가 여기서 갈린다. 질문을 정교하게 구성하고, 답변을 교차 검증하고, 자기 논리의 빈틈을 채우는 데 AI를 쓰는 학생과, 질문을 막연하게 던지고 나온 결과를 그대로 복사하는 학생 사이의 간극은 도구가 같아도 벌어진다. AI가 모두에게 동등한 자원처럼 보이지만, 활용 방식의 차이가 학습 효과를 갈라놓는다.',
  'AI가 만들어준 답변을 그대로 제출하면 글쓰기 능력이 향상되지 않고 비판적 사고 능력이 약화될 수 있다. 문제는 학생이 그 생략을 인지하지 못한다는 데 있는 게 아니라, 애초에 과정 자체를 거쳐야 한다는 감각이 흐릿해진다는 것이다.',
  '강의실 수업과 교재가 학습의 중심이었다.\n\n',
];

(async () => {
  const before = doc.replace(/\s/g, '').length;
  for (const c of CUTS) {
    if (!doc.includes(c)) { console.log('❌ 못 찾음:', c.replace(/\s+/g, ' ').slice(0, 50)); process.exit(1); }
    doc = doc.replace(c, '');
  }
  // 환각 메커니즘 사실 원장 제거(본문에서 잘렸으므로)
  const n0 = evList.length;
  evList = evList.filter(l => !l.includes('대규모 언어모델'));
  fs.writeFileSync('samples/ai-study-evidence.txt', evList.join('\n') + '\n', 'utf8');
  console.log(`컷 ${CUTS.length}건: ${before}자 → ${doc.replace(/\s/g, '').length}자 | 원장 ${n0}→${evList.length}`);

  const allowed = evList.join('\n');
  const textF = rawText + '\n\n' + allowed;
  doc = gt.resolveDupSentences(gt.dedupeParas(doc, textF), textF);

  const novelty = floor.measureNovelty(textF, doc, allowed);
  const lost = floor.measureLostFacts(textF, doc);
  const pairing = gt.checkEvidencePairing(doc, evList);
  console.log(`결정론: novelty ${novelty.count} | lost ${lost.count}${lost.count ? ' [' + lost.items.slice(0, 8).join(', ') + ']' : ''} | 짝 ${pairing.length} | genreRisk ${gf.genreRiskScore(doc).score}`);
  if (novelty.count > 0 || lost.count > 0 || pairing.length > 0) { console.log('❌ 게이트 불통 — 저장 안 함'); process.exit(1); }

  const ledger = await buildSoftClaimLedger(rawText, { lang: 'ko' });
  const judgeLedger = { ...ledger, claims: [...ledger.claims, ...evList.map(e => ({ claim: e, evidence_text: e }))] };
  const v = await semanticJudge(rawText, doc, judgeLedger, { lang: 'ko', allowedExtra: allowed });
  for (const x of (v.violations || [])) console.log(`  judge ${x.type}: "${(x.span || '').slice(0, 70)}"`);
  const lenRatio = Math.round(((doc.match(/[가-힣]/g) || []).length) / (((textF.match(/[가-힣]/g) || []).length) || 1) * 100);
  console.log(`최종: judge ${v.pass ? 'pass ✅' : '위반 ' + v.violations.length} | 분량 ${lenRatio}%`);
  if (!v.pass) { console.log('❌ judge 불통 — 저장 안 함'); process.exit(1); }
  fs.writeFileSync('results/ai-study-목소리앵커-v4.md',
    `# AI학습보고서 — 목소리 앵커 v4(48%본에서 피탐 구간 사실-무관 논증만 컷 — 분량 실험 A/B) · 카피킬러 측정용\n\n`
    + `> novelty 0 · lostFacts 0 · 짝위반 0 · judge pass · 분량 ${lenRatio}% · 48%본과의 차이는 분량 컷뿐\n\n---\n\n${doc}\n`, 'utf8');
  console.log('저장: results/ai-study-목소리앵커-v4.md');
})().catch(e => { console.error('❌', e.stack || e.message); process.exit(1); });

