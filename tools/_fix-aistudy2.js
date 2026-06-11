// [_fix-aistudy2.js] ai-study v1 수술(임시): 제목 novelty·출처 스왑 결정론 수정 → lost 7 맥락 위빙 → 전 게이트+judge
try { require('dotenv').config(); } catch { /* 무시 */ }
process.env.LLM_BACKEND = 'api';
const fs = require('fs');
const floor = require('./engine/floor');
const gt = require('./engine/genretransfer');
const { buildSoftClaimLedger, semanticJudge, llmText, MODEL } = require('./engine/judge');

const FILE = 'results/ai-study-목소리앵커-v1.md';
const rawText = fs.readFileSync('samples/ai-study-report.txt', 'utf8').trim();
const evidence = fs.readFileSync('samples/ai-learning-evidence.txt', 'utf8');
const evidenceList = evidence.split('\n').map(l => l.trim()).filter(Boolean);
const allowed = evidence;
const textF = rawText + '\n\n' + evidence;
const META_NOTE_RE = /(메모\s*:|밝힙니다|지시에\s*따라|삽입하지\s*않|본문만\s*출력|위\s*지침|요청하신)/;

const md = fs.readFileSync(FILE, 'utf8');
const head = md.split(/\n---\n+/)[0];
let doc = md.split(/\n---\n+/).slice(1).join('\n---\n').trim();

(async () => {
  // ① 제목: 반올림 novelty(92%·54%) + "교수자 불신" 왜곡 제거
  const T_OLD = '대학생 92%가 쓰는 도구, 교수자 54%가 불신한다';
  const T_NEW = '대학생 92.4%가 쓰는 도구';
  if (!doc.includes(T_OLD)) { console.log('❌ 제목 못 찾음'); process.exit(1); }
  doc = doc.replace(T_OLD, T_NEW);
  console.log('① 제목 교체 ✅');

  // ② 출처 스왑 교정: 45.9% → 오픈서베이, 직능연 사실은 충실 문장으로 복원
  const S_OLD = '사고력 저하를 우려한다고 답한 학생이 45.9%라는 수치(한국직업능력연구원 2024년 조사다)를 보면, 학생들은 이미 뭔가 갉아먹히고 있다는 걸 어렴풋이 알고 있다.';
  const S_NEW = '사고력 저하를 우려한다고 답한 학생이 45.9%라는 수치(오픈서베이 같은 조사에서 나온 응답이다)를 보면, 학생들은 이미 뭔가 갉아먹히고 있다는 걸 어렴풋이 알고 있다. 한국직업능력연구원의 2024년 조사에서도 학생들은 AI가 학업 효율에 도움이 된다고 평가하면서, 동시에 과도한 의존과 표절, 역량 저하를 걱정했다.';
  if (!doc.includes(S_OLD)) { console.log('❌ 스왑 문장 못 찾음'); process.exit(1); }
  doc = doc.replace(S_OLD, S_NEW);
  console.log('② 출처 교정 ✅ | 짝위반:', gt.checkEvidencePairing(doc, evidenceList).length, '| novelty:', floor.measureNovelty(textF, doc, allowed).count);

  // ③ lost 위빙(맥락 인용, 3라운드)
  const splitSents = (t) => t.split(/(?<=[.!?다요죠])\s+|\n+/).map(x => x.trim()).filter(Boolean);
  const srcSentsAll = splitSents(textF);
  const lostCtx = (it) => {
    const s = srcSentsAll.find(x => x.includes(it));
    return s ? `${it} (원문 맥락: "${s.replace(/\s+/g, ' ').slice(0, 110)}" — 이 맥락의 의미 그대로만, 다른 조사·기관·수치와 결합 금지)` : it;
  };
  let curLost = floor.measureLostFacts(textF, doc);
  console.log(`③ 위빙 대상 ${curLost.count}건: [${curLost.items.join(', ')}]`);
  for (let r = 0; r < 3 && curLost.count > 0; r++) {
    const cand = ((await llmText({
      system: `아래 칼럼에 빠진 표현들을 가장 자연스러운 자리에 끼워 넣어 전체를 다시 출력하라. 빠진 표현:\n${curLost.items.map(lostCtx).map(x => '· ' + x).join('\n')}\n★각 표현은 원문 맥락의 의미 그대로 — 원문에서 활용 방식의 순번(두 번째~다섯 번째)이면 그 활용 방식 이야기에서 순번으로, 예시면 예시로. 기존 문단 복제 금지, 보고서 어투 금지, 구조·문체 유지, 새 사실·새 결합 금지, 본문만 출력.`,
      user: doc, maxTokens: 8000, model: MODEL
    }) || '').trim());
    if (!cand || META_NOTE_RE.test(cand.split(/\n{2,}/).pop()) || floor.measureNovelty(textF, cand, allowed).count > 0) { console.log(`  라운드 ${r + 1}: 게이트 불통`); continue; }
    if (gt.checkEvidencePairing(cand, evidenceList).length > gt.checkEvidencePairing(doc, evidenceList).length) { console.log(`  라운드 ${r + 1}: 짝 증가 → 폐기`); continue; }
    const clean = gt.resolveDupSentences(gt.dedupeParas(cand, textF), textF);
    const l2 = floor.measureLostFacts(textF, clean);
    if (l2.count < curLost.count) { doc = clean; curLost = l2; console.log(`  라운드 ${r + 1}: lost ${curLost.count} 남음`); }
    else console.log(`  라운드 ${r + 1}: 개선 없음`);
  }

  // ④ 최종 게이트 + judge
  const novelty = floor.measureNovelty(textF, doc, allowed);
  const lost = floor.measureLostFacts(textF, doc);
  const pairing = gt.checkEvidencePairing(doc, evidenceList);
  const ledger = await buildSoftClaimLedger(rawText, { lang: 'ko' });
  const judgeLedger = { ...ledger, claims: [...ledger.claims, ...evidenceList.map(e => ({ claim: e, evidence_text: e }))] };
  const v = await semanticJudge(rawText, doc, judgeLedger, { lang: 'ko', allowedExtra: allowed });
  for (const x of (v.violations || [])) console.log(`  judge ${x.type}: "${(x.span || '').slice(0, 70)}" — ${(x.detail || '').slice(0, 90)}`);
  const lenRatio = Math.round(((doc.match(/[가-힣]/g) || []).length) / (((textF.match(/[가-힣]/g) || []).length) || 1) * 100);
  console.log(`최종: novelty ${novelty.count} | lost ${lost.count}${lost.count ? ' [' + lost.items.join(', ') + ']' : ''} | 짝위반 ${pairing.length} | judge ${v.pass ? 'pass ✅' : '위반 ' + v.violations.length} | 분량 ${lenRatio}%`);
  if (!v.pass || lost.count > 0 || novelty.count > 0 || pairing.length > 0) { console.log('❌ 미수렴 — 파일 미변경'); process.exit(1); }
  fs.writeFileSync(FILE,
    `# AI학습보고서(서론본론결론 골격) — 목소리 앵커 v1b(제목·출처 수술 + 위빙) · 카피킬러 측정용\n\n`
    + `> novelty 0 · lostFacts 0 · 짝위반 0(기관 규칙 포함) · judge pass · 분량 ${lenRatio}%\n\n---\n\n${doc}\n`, 'utf8');
  console.log('저장:', FILE);
})().catch(e => { console.error('❌', e.stack || e.message); process.exit(1); });
