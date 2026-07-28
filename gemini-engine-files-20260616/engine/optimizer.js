// [engine/optimizer.js] Phase 1.5 multi-candidate segment 최적화
// ────────────────────────────────────────────────────────────────
// 채점기(riskScore, 카피킬러와 0.7~0.8 검증) 기반: 고위험 segment마다 후보 N개를 서로 다른
// 전략으로 생성 → FLOOR(novelty/refusal) 통과 후보 중 riskScore 최저를 선택 → 교체.
//   전체 재작성 금지(국소). 원본보다 risk가 낮을 때만 채택(아니면 원본 유지=무해).
//   전략: rhythm(균일성 파괴)·decompress(압축 완화)·stance(판단문)·anchor(원문 구체).

const sg = require('./surfaceguard');
const floor = require('./floor');
const { llmText, buildSoftClaimLedger, semanticJudge } = require('./judge');
const dd = require('./dedupe');

// segment의 주 말투(해요체/한다체/합니다체) 판정
function dominantRegister(seg) {
  const regs = sg.splitSentences(seg).map(sg.sentRegister);
  const c = { haeyo: 0, handa: 0, hap: 0 };
  for (const r of regs) if (c[r] !== undefined) c[r]++;
  if (c.haeyo >= c.handa && c.haeyo >= c.hap) return 'haeyo';
  if (c.handa >= c.hap) return 'handa';
  return 'hap';
}
const REG_LABEL = { haeyo: '해요체(~예요/~거든요/~죠/~어요)', handa: '한다체(~다/~이다/~한다)', hap: '합니다체(~습니다/~ㅂ니다)' };
// 후보가 목표 말투를 지켰는지(다른 말투 문장이 1개 이하면 통과)
function registerOk(cand, target) {
  const regs = sg.splitSentences(cand).map(sg.sentRegister);
  const off = regs.filter(r => r !== 'q' && r !== 'other' && r !== target).length;
  return off <= 1;
}

// 전략별 시스템 프롬프트(공통 제약: 사실·말투·분량 보존, 새 정보 금지)
function strategyPrompt(seg, strat, anchors, lang, register = 'haeyo') {
  const COMMON = `문단의 기본 말투(${REG_LABEL[register]})를 큰 틀에서 유지하되 종결 표현은 단조롭지 않게 다양화하라. 사실·수치·고유명사·의미·분량은 그대로 두고, 원문에 없는 새 정보·사례·수치는 절대 만들지 마라. 본문만 출력(설명·따옴표 금지).`;
  const map = {
    rhythm: `너는 한국어 글 편집자다. 아래 문단의 "문장 리듬"만 사람처럼 불규칙하게 바꿔라(기계적 균일성 제거):
· 문장 길이를 극단적으로 들쭉날쭉하게 — 아주 짧은 문장(5~12자)과 긴 문장(45자+)을 섞어라. 같은 길이대 2연속 금지.
· 종결어미를 매 문장 바꿔라 — 같은 종결 2연속 금지. 가끔 의문문·체언 종결도.
· ${COMMON}`,
    decompress: `너는 한국어 글 편집자다. 아래 문단에서 한 문장에 정보를 몰아넣은 "요약문"을 풀어라:
· 주장·근거·결론이 한 문장에 압축돼 있으면 관찰→설명→판단 순서로 2~3문장으로 나눠라.
· 단 원문에 있는 정보 안에서만 풀고, ${COMMON}`,
    stance: `너는 한국어 글 편집자다. 아래 문단의 막연한 일반론을 선명한 판단문으로 바꿔라:
· "문제는 A가 아니라 B", "핵심은 A보다 B", "위험은 A에서 온다" 구조로. 단 A·B는 문단에 이미 있는 내용만.
· 비인칭·수동("~된다/여겨진다")을 주체 명시 능동으로. ${COMMON}`,
    anchor: `너는 한국어 글 편집자다. 아래 문단의 추상 문장을 원문에 이미 있는 구체로 받쳐라:
${anchors && anchors.length ? `· 이 구체를 끌어와 써라: ${anchors.join(', ')}` : '· 문단 안에 이미 있는 구체 용어·상황을 더 또렷이 드러내라.'}
· ${COMMON}`,
  };
  return { system: map[strat] || map.rhythm, user: `[문단]\n${seg}` };
}

// 적용할 전략 결정(서브스코어 기반) — 약점에 맞는 후보를 만든다.
function pickStrategies(risk) {
  const strats = ['rhythm'];                              // 균일성은 거의 항상 후보
  if (risk.compressionRatio >= 0.12 || (risk.paragraphCompression || 0) >= 0.3) strats.push('decompress');  // 문장·문단 압축
  if (risk.impersonalRatio >= 0.2 || risk.stanced === 0) strats.push('stance');
  if (risk.concrete === 0) strats.push('anchor');
  if (strats.length < 2) strats.push('decompress');       // 최소 2후보
  return [...new Set(strats)];
}

async function optimizeSegment(seg, anchorPool, rawText, { lang, signal, ledger, threshold, neighbors = [] } = {}) {
  const baseRisk = sg.measureSegmentRisk(seg, anchorPool);
  if (baseRisk.riskScore < threshold) return { text: seg, changed: false, reason: 'low-risk' };

  const anchors = anchorPool ? [...(anchorPool.specifics || []), ...(anchorPool.acronyms || []), ...(anchorPool.terms || [])]
    .filter(t => t.length >= 2 && seg.includes(t)).slice(0, 6) : [];
  const strats = pickStrategies(baseRisk);
  const register = dominantRegister(seg);   // 후보가 지켜야 할 목표 말투

  // 후보 병렬 생성
  const cands = await Promise.all(strats.map(async (strat) => {
    const { system, user } = strategyPrompt(seg, strat, anchors, lang, register);
    let cand = '';
    try { cand = (await llmText({ system, user, signal, maxTokens: 1300 }) || '').trim(); } catch { return null; }
    if (!cand || cand.length < seg.length * 0.55) return null;
    if (cand.replace(/\s+/g, '').length > seg.replace(/\s+/g, '').length * 1.10) return null;  // 길이중립(교체이지 추가 아님) — 긴 글에서 패스가 게이트 분량초과로 안 죽게
    if (floor.looksLikeRefusal(cand)) return null;
    if (dd.boundaryLeak(cand, seg, neighbors)) return null;   // ★인접 segment 내용 재진술(중복 유발) → 탈락
    // FLOOR: 새 사실 0
    if (floor.measureNovelty(rawText || seg, cand, '').count >= 1) return null;
    // 닫힌세계 judge(선택)
    if (ledger) { try { const v = await semanticJudge(rawText, cand, ledger, { lang, signal }); if (!v.pass) return null; } catch { /* best-effort */ } }
    const r = sg.measureSegmentRisk(cand, anchorPool);
    return { strat, text: cand, risk: r.riskScore };
  }));

  // FLOOR 통과 후보 중 riskScore 최저, 단 원본보다 유의미하게 낮을 때만 채택
  const valid = cands.filter(Boolean).sort((a, b) => a.risk - b.risk);
  if (valid.length && valid[0].risk < baseRisk.riskScore - 0.03) {
    return { text: valid[0].text, changed: true, strat: valid[0].strat, from: baseRisk.riskScore, to: valid[0].risk };
  }
  return { text: seg, changed: false, reason: 'no-better-candidate', baseRisk: baseRisk.riskScore };
}

// 전체 패스: 고위험 segment 상위 N개만 최적화(예산 상한).
async function optimizePass(text, rawText, { lang = 'ko', signal, targetChars = 350, threshold = 0.22, maxTargets } = {}) {
  const anchorPool = sg.buildSourceAnchorPool(rawText || text);
  const segs = sg.buildSegments(text, targetChars);
  const scored = segs.map((s, i) => ({ i, risk: sg.measureSegmentRisk(s, anchorPool).riskScore })).filter(x => x.risk >= threshold).sort((a, b) => b.risk - a.risk);
  const MAX = Number(maxTargets) || Number(process.env.OPTIMIZE_MAX) || 12;
  const pick = scored.slice(0, MAX).map(x => x.i);
  if (!pick.length) return { text, changed: 0, targets: 0 };

  let ledger = null;
  try { ledger = await buildSoftClaimLedger(rawText, { lang, signal }); } catch { /* best-effort */ }

  const out = segs.slice();
  const concurrency = Number(process.env.CHUNK_CONCURRENCY) || (process.env.LLM_BACKEND === 'claudecode' ? 1 : 5);
  let next = 0, changed = 0; const log = [];
  const worker = async () => {
    while (next < pick.length) {
      const i = pick[next++];
      const neighbors = [segs[i - 1], segs[i + 1]].filter(Boolean);
      const r = await optimizeSegment(segs[i], anchorPool, rawText, { lang, signal, ledger, threshold, neighbors });
      if (r.changed) { out[i] = r.text; changed++; log.push({ i, strat: r.strat, from: r.from, to: r.to }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pick.length) }, worker));
  return { text: out.join('\n\n'), changed, targets: pick.length, log };
}

module.exports = { optimizePass, optimizeSegment, pickStrategies };
