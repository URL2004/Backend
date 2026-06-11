// [_weave-aistudy.js v2] ai-study v2(63%본) 맨몸 문단 분산 위빙 + 사실 완성 패스(임시)
// 1차 실행 교훈: 다수치 사실을 모델이 일부만 녹임(726명 사실에서 74.1% 생략 등) → 원장 등재 시 lostFacts 17.
// v2 = 사실↔문단 매핑 기록 → 완성 패스(빠진 수치 보충) → 미완성 사실은 문단 원복+원장 제외 폴백.
try { require('dotenv').config(); } catch { /* 무시 */ }
process.env.LLM_BACKEND = 'api';
const fs = require('fs');
const floor = require('./engine/floor');
const gt = require('./engine/genretransfer');
const gf = require('./engine/genreframes');
const { buildSoftClaimLedger, semanticJudge, llmText, MODEL } = require('./engine/judge');

const rawText = fs.readFileSync('samples/ai-study-report.txt', 'utf8').trim();
const oldEv = fs.readFileSync('samples/ai-learning-evidence.txt', 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
const newEv = fs.readFileSync('samples/ai-study-evidence-add.txt', 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
const allEv = [...oldEv, ...newEv];
const allowedAll = allEv.join('\n');
const textFAll = rawText + '\n\n' + allowedAll;

const META_NOTE_RE = /(메모\s*:|밝힙니다|지시에\s*따라|삽입하지\s*않|본문만\s*출력|위\s*지침|요청하신)/;
const WINK_RE = /(표현|단어|문장|어투)[^.”"]{0,12}(쓰지\s*말|말라고\s*했|금지)/;
const ORG = /(오픈서베이|네이처|앤트로픽|성균관대|서울대|연세대|고려대|중앙대|부산대|KERIS|KCI|교육부|스위스|텍사스|고등교육정책연구소|한국직업능력연구원|간호대학생|대교협|한국대학교육협의회|아주대|OECD|와이즈앱|Scopus|UCL)/;

// 사실 시그니처: 변별 수치(연도 제외) + 기관·고유 키워드
const ORG_WORDS = ['아주대', '대교협', '한국대학교육협의회', '한국직업능력연구원', '앤트로픽', '고려대', '연세대', '성균관대', 'OECD', '와이즈앱', 'Scopus', '교육부', 'KCI', 'Learning'];
function sigOf(f) {
  const nums = [...new Set((f.match(/\d[\d,.]*%?/g) || []).filter(t => t.replace(/\D/g, '').length >= 2 && !/^(19|20)\d{2}$/.test(t.replace(/%$/, ''))))];
  const orgs = ORG_WORDS.filter(w => f.includes(w));
  const keys = nums.length + orgs.length ? [] : (f.match(/[가-힣A-Za-z]{4,}/g) || []).slice(0, 3);
  return { nums, orgs, keys, probe: [...nums, ...orgs, ...keys] };
}

const md = fs.readFileSync('results/ai-study-목소리앵커-v2.md', 'utf8');
const docBase = md.split(/\n---\n+/).slice(1).join('\n---\n').trim();

(async () => {
  const paras = docBase.split(/\n{2,}/);
  const origParas = paras.slice();
  let pool = newEv.map((f, idx) => ({ f, idx }));
  const usedMap = [];                                  // {f, paraIdx}
  for (let i = 0; i < paras.length && pool.length; i++) {
    const p = paras[i];
    if ((p.match(/[가-힣]/g) || []).length < 120) continue;
    if (/\d{2,}/.test(p) || ORG.test(p)) continue;
    const cands = pool.map((e, k) => `${k + 1}. ${e.f}`).join('\n');
    let out = '';
    try {
      out = (await llmText({
        system: `너는 한국 시사 칼럼의 문단 수리공이다. 아래 [문단]의 논지에 정확히 부합하는 사실이 [승인 사실 후보]에 있으면 딱 1개만 골라, 그 사실의 수치·기관을 통째로(일부만 발췌 금지) 인용 표지와 함께 자연스럽게 녹여 문단을 다시 써라. 문단의 결(괄호 사족·호흡 낙차)과 논지는 유지, 길이는 원래의 0.9~1.5배. 부합하는 사실이 없으면 원래 문단을 그대로 출력. 사실 변형·결합 금지. 문단만 출력.`,
        user: `[승인 사실 후보]\n${cands}\n\n[문단]\n${p}`,
        maxTokens: 1300, model: MODEL
      }) || '').trim();
    } catch { continue; }
    if (!out || out.replace(/\s+/g, '') === p.replace(/\s+/g, '')) continue;
    if (META_NOTE_RE.test(out) || WINK_RE.test(out)) continue;
    if (floor.measureNovelty(textFAll, out, allowedAll).count > 0) continue;
    const trial = paras.slice(); trial[i] = out;
    if (gt.checkEvidencePairing(trial.join('\n\n'), allEv).length > gt.checkEvidencePairing(paras.join('\n\n'), allEv).length) continue;
    paras[i] = out;
    const usedHere = pool.filter(e => { const s = sigOf(e.f); return s.probe.some(t => out.includes(t)); });
    usedHere.forEach(e => usedMap.push({ f: e.f, paraIdx: i }));
    pool = pool.filter(e => !usedHere.includes(e));
    console.log(`  문단 ${i}: 위빙 ✅ (사용 ${usedHere.length}건, 풀 ${pool.length})`);
  }
  console.log(`1차 위빙: ${usedMap.length}건 사실 / 문단 ${new Set(usedMap.map(u => u.paraIdx)).size}개`);

  // ── 사실 완성 패스: 부분 인용된 사실의 빠진 토큰을 같은 문단에 보충(3라운드) ──
  const evOf = () => [...oldEv, ...usedMap.map(u => u.f)];
  for (let r = 0; r < 3; r++) {
    const textF = rawText + '\n\n' + evOf().join('\n');
    const lost = floor.measureLostFacts(textF, paras.join('\n\n'));
    if (lost.count === 0) break;
    console.log(`완성 라운드 ${r + 1}: lost ${lost.count} [${lost.items.slice(0, 10).join(', ')}]`);
    const owners = new Map();
    for (const tok of lost.items) {
      const u = usedMap.find(x => x.f.includes(tok));
      if (!u) continue;
      if (!owners.has(u)) owners.set(u, []);
      owners.get(u).push(tok);
    }
    for (const [u, toks] of owners) {
      try {
        const cand = (await llmText({
          system: `아래 문단에는 다음 승인 사실이 일부만 인용돼 있다. 빠진 요소를 사실 그대로 보태 문단을 자연스럽게 완성하라. 사실 변형·다른 결합 금지, 결 유지, 문단만 출력.\n승인 사실: ${u.f}\n빠진 요소: ${toks.join(', ')}`,
          user: paras[u.paraIdx], maxTokens: 1300, model: MODEL
        }) || '').trim();
        if (!cand || META_NOTE_RE.test(cand) || WINK_RE.test(cand)) continue;
        if (floor.measureNovelty(textFAll, cand, allowedAll).count > 0) continue;
        const trial = paras.slice(); trial[u.paraIdx] = cand;
        if (gt.checkEvidencePairing(trial.join('\n\n'), allEv).length > gt.checkEvidencePairing(paras.join('\n\n'), allEv).length) continue;
        paras[u.paraIdx] = cand;
        console.log(`  완성: 문단 ${u.paraIdx} ← [${toks.join(', ')}]`);
      } catch { /* 유지 */ }
    }
  }

  // ── 폴백: 여전히 미완성인 사실은 문단 원복 + 원장 제외 ──
  {
    const textF = rawText + '\n\n' + evOf().join('\n');
    const lost = floor.measureLostFacts(textF, paras.join('\n\n'));
    if (lost.count > 0) {
      const bad = new Set();
      for (const tok of lost.items) { const u = usedMap.find(x => x.f.includes(tok)); if (u) bad.add(u); }
      for (const u of bad) {
        console.log(`  폴백: 문단 ${u.paraIdx} 원복, 사실 제외 — "${u.f.slice(0, 40)}…"`);
        paras[u.paraIdx] = origParas[u.paraIdx];
        usedMap.splice(usedMap.indexOf(u), 1);
        // 같은 문단에 묶인 다른 사실도 함께 제외
        for (let k = usedMap.length - 1; k >= 0; k--) if (usedMap[k].paraIdx === u.paraIdx) usedMap.splice(k, 1);
      }
    }
  }

  let doc = paras.join('\n\n');
  const finalEv = evOf();
  fs.writeFileSync('samples/ai-study-evidence.txt', finalEv.join('\n') + '\n', 'utf8');
  const allowedF = finalEv.join('\n');
  const textF = rawText + '\n\n' + allowedF;
  doc = gt.resolveDupSentences(gt.dedupeParas(doc, textF), textF);
  doc = gt.dedupeFactRecitations(doc, finalEv, textF);

  const ps = doc.split(/\n{2,}/).filter(p => p.replace(/\s/g, '').length > 60);
  const bare = ps.filter(p => !/\d{2,}/.test(p) && !ORG.test(p)).length;
  console.log(`최종 원장: 기존 ${oldEv.length} + 신규 ${finalEv.length - oldEv.length} | 맨몸: ${bare}/${ps.length} (${Math.round(bare / ps.length * 100)}%)`);

  const novelty = floor.measureNovelty(textF, doc, allowedF);
  const lost = floor.measureLostFacts(textF, doc);
  const pairing = gt.checkEvidencePairing(doc, finalEv);
  console.log(`결정론: novelty ${novelty.count}${novelty.count ? ' [' + novelty.items.join(',') + ']' : ''} | lost ${lost.count}${lost.count ? ' [' + lost.items.slice(0, 8).join(', ') + ']' : ''} | 짝 ${pairing.length} | genreRisk ${gf.genreRiskScore(doc).score}`);
  if (novelty.count > 0 || lost.count > 0 || pairing.length > 0) { console.log('❌ 게이트 불통 — 저장 안 함'); process.exit(1); }

  const ledger = await buildSoftClaimLedger(rawText, { lang: 'ko' });
  const judgeLedger = { ...ledger, claims: [...ledger.claims, ...finalEv.map(e => ({ claim: e, evidence_text: e }))] };
  const v = await semanticJudge(rawText, doc, judgeLedger, { lang: 'ko', allowedExtra: allowedF });
  for (const x of (v.violations || [])) console.log(`  judge ${x.type}: "${(x.span || '').slice(0, 70)}" — ${(x.detail || '').slice(0, 90)}`);
  const lenRatio = Math.round(((doc.match(/[가-힣]/g) || []).length) / (((textF.match(/[가-힣]/g) || []).length) || 1) * 100);
  console.log(`최종: judge ${v.pass ? 'pass ✅' : '위반 ' + v.violations.length} | 분량 ${lenRatio}%`);
  if (!v.pass) { console.log('❌ judge 불통 — 저장 안 함'); process.exit(1); }
  fs.writeFileSync('results/ai-study-목소리앵커-v3.md',
    `# AI학습보고서 — 목소리 앵커 v3(맨몸 문단 분산 위빙: 승인 사실 ${finalEv.length - oldEv.length}건 추가) · 카피킬러 측정용\n\n`
    + `> novelty 0 · lostFacts 0 · 짝위반 0 · judge pass · 맨몸 ${Math.round(bare / ps.length * 100)}% · 63%본과의 차이는 사실 위빙뿐\n\n---\n\n${doc}\n`, 'utf8');
  console.log('저장: results/ai-study-목소리앵커-v3.md');
})().catch(e => { console.error('❌', e.stack || e.message); process.exit(1); });
