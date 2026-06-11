// [_fix-aistudy3.js] ai-study v1 최종 수술(임시): 전부 결정론 편집 — 제목·출처 교정 + lost 7 손위빙(원문 맥락 충실 문장)
// LLM 위빙이 수사·구조 토큰(서수 나열·가상 예시)을 자연스럽게 못 박아 3라운드 실패 → 손으로 박고 게이트+judge로 검증.
try { require('dotenv').config(); } catch { /* 무시 */ }
process.env.LLM_BACKEND = 'api';
const fs = require('fs');
const floor = require('./engine/floor');
const gt = require('./engine/genretransfer');
const { buildSoftClaimLedger, semanticJudge } = require('./engine/judge');

const FILE = 'results/ai-study-목소리앵커-v1.md';
const rawText = fs.readFileSync('samples/ai-study-report.txt', 'utf8').trim();
const evidence = fs.readFileSync('samples/ai-learning-evidence.txt', 'utf8');
const evidenceList = evidence.split('\n').map(l => l.trim()).filter(Boolean);
const allowed = evidence;
const textF = rawText + '\n\n' + evidence;

const md = fs.readFileSync(FILE, 'utf8');
let doc = md.split(/\n---\n+/).slice(1).join('\n---\n').trim();

const EDITS = [
  // ① 제목: 반올림 novelty + "교수자 불신" 왜곡 제거
  ['대학생 92%가 쓰는 도구, 교수자 54%가 불신한다',
    '대학생 92.4%가 쓰는 도구'],
  // ② 출처 스왑 교정(45.9%→오픈서베이) + 직능연 사실 충실 복원
  ['사고력 저하를 우려한다고 답한 학생이 45.9%라는 수치(한국직업능력연구원 2024년 조사다)를 보면, 학생들은 이미 뭔가 갉아먹히고 있다는 걸 어렴풋이 알고 있다.',
    '사고력 저하를 우려한다고 답한 학생이 45.9%라는 수치(오픈서베이 같은 조사에서 나온 응답이다)를 보면, 학생들은 이미 뭔가 갉아먹히고 있다는 걸 어렴풋이 알고 있다. 한국직업능력연구원의 2024년 조사에서도 학생들은 AI가 학업 효율에 도움이 된다고 평가하면서, 동시에 과도한 의존과 표절, 역량 저하를 걱정했다.'],
  // ③ 서수 나열(두~다섯 번째, 원문의 활용 방식 순번 그대로) + 두 시간 예시
  ['시험 준비도 마찬가지다.',
    '시험 준비도 마찬가지다. 보고서식으로 줄을 세우면 개념 이해가 두 번째, 글쓰기 보조가 세 번째, 시험 준비와 복습이 네 번째, 외국어 학습이 다섯 번째쯤 되는 활용 방식들인데, 순번보다 중요한 건 전부 학습 과정의 한복판을 지난다는 사실이다. 시험까지 일주일 남은 학생이 하루 두 시간씩 낼 수 있는 시간을 어떻게 나눌지 묻는 것도 그 연장선이다.'],
  // ④ ESG 예시(원문 "기후변화와 기업 경영" 가상 과제 그대로)
  ['주제를 잡기 전에 AI한테 관련 개념을 물어보고, 개요 초안을 뽑아 달라고 요청하고, 본문을 쓴 뒤에는 문장을 다듬어 달라고 붙여 넣는다.',
    "주제를 잡기 전에 AI한테 관련 개념을 물어보고, 개요 초안을 뽑아 달라고 요청하고, 본문을 쓴 뒤에는 문장을 다듬어 달라고 붙여 넣는다. '기후변화와 기업 경영' 같은 과제라면 비용 증가, 공급망 위험, ESG 경영 같은 쟁점부터 추려 달라는 식이다."],
  // ⑤ 1차 피드백(원문 "1차적인 피드백" 맥락 그대로)
  ['AI가 개요를 제안하거나 논리 흐름을 점검해주는 방식으로 끼어든다면, 글쓰기의 진입 장벽이 낮아진다.',
    'AI가 개요를 제안하거나 논리 흐름을 점검해주는 방식으로 끼어든다면, 글쓰기의 진입 장벽이 낮아진다. 작성한 결과물이 적절한지 스스로 판단하기 어려울 때 1차적인 피드백을 받는 용도까지는 분명히 도구가 잘하는 일이다.'],
];

(async () => {
  for (const [oldS, newS] of EDITS) {
    if (!doc.includes(oldS)) { console.log('❌ 못 찾음:', oldS.slice(0, 40)); process.exit(1); }
    doc = doc.replace(oldS, newS);
  }
  console.log('결정론 편집 5건 ✅');
  doc = gt.resolveDupSentences(gt.dedupeParas(doc, textF), textF);

  const novelty = floor.measureNovelty(textF, doc, allowed);
  const lost = floor.measureLostFacts(textF, doc);
  const pairing = gt.checkEvidencePairing(doc, evidenceList);
  console.log(`결정론 검증: novelty ${novelty.count}${novelty.count ? ' [' + novelty.items.join(',') + ']' : ''} | lost ${lost.count}${lost.count ? ' [' + lost.items.join(', ') + ']' : ''} | 짝위반 ${pairing.length}`);
  if (novelty.count > 0 || lost.count > 0 || pairing.length > 0) { console.log('❌ 결정론 게이트 불통 — 파일 미변경'); process.exit(1); }

  const ledger = await buildSoftClaimLedger(rawText, { lang: 'ko' });
  const judgeLedger = { ...ledger, claims: [...ledger.claims, ...evidenceList.map(e => ({ claim: e, evidence_text: e }))] };
  const v = await semanticJudge(rawText, doc, judgeLedger, { lang: 'ko', allowedExtra: allowed });
  for (const x of (v.violations || [])) console.log(`  judge ${x.type}: "${(x.span || '').slice(0, 70)}" — ${(x.detail || '').slice(0, 90)}`);
  const lenRatio = Math.round(((doc.match(/[가-힣]/g) || []).length) / (((textF.match(/[가-힣]/g) || []).length) || 1) * 100);
  console.log(`최종: judge ${v.pass ? 'pass ✅' : '위반 ' + v.violations.length} | 분량 ${lenRatio}%`);
  if (!v.pass) { console.log('❌ judge 불통 — 파일 미변경'); process.exit(1); }
  fs.writeFileSync(FILE,
    `# AI학습보고서(서론본론결론 골격) — 목소리 앵커 v1b(제목·출처 수술 + 손위빙) · 카피킬러 측정용\n\n`
    + `> novelty 0 · lostFacts 0 · 짝위반 0(기관 규칙 포함) · judge pass · 분량 ${lenRatio}%\n\n---\n\n${doc}\n`, 'utf8');
  console.log('저장:', FILE);
})().catch(e => { console.error('❌', e.stack || e.message); process.exit(1); });
