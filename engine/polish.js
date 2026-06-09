// [engine/polish.js] Phase 0 통합 폴리시 패스 (검출 + 국소 LLM repair)
// ────────────────────────────────────────────────────────────────
// 카피킬러 잔여 약한 플래그(기계적 균일성·압축·구어체 템플릿·register 혼합)를
// segment 단위로 "검출 → 국소 repair"한다. 전체 재작성 아님. FLOOR(novelty) 재검으로 날조 차단.
//   1) phrase 과다 반복(구어체 템플릿)  [phrasebudget]
//   2) register 혼합(한 문단에 해요체+한다체)  [conservative]
//   3) 압축 서술(한 문장에 정보 과밀 = 요약문)
// segment당 issue가 1개라도 있으면 1회만 repair(결합 제약). 없으면 LLM 호출 0.

const sg = require('./surfaceguard');
const { llmText, HAIKU } = require('./judge');
const { measurePhraseUsage, countOcc, PHRASE_DENSITY } = require('./phrasebudget');

// ── register 분류 (surfaceguard 단일 정의 재사용) ──
const sentRegister = sg.sentRegister;

// 문단별 register 혼합 검출(보수적): 해요체와 한다체가 둘 다 "복수" 섞인 문단만.
function paragraphMixed(segText) {
  const regs = sg.splitSentences(segText).map(sentRegister);
  const haeyo = regs.filter(r => r === 'haeyo').length;
  const handa = regs.filter(r => r === 'handa').length;
  const hap = regs.filter(r => r === 'hap').length;
  // 해요체 본문에 한다체 2개+ 섞임, 또는 해요체/합니다체 둘 다 2개+ → 혼합
  if (haeyo >= 1 && handa >= 2) return { mixed: true, target: haeyo >= handa ? 'haeyo' : 'handa' };
  if (haeyo >= 2 && hap >= 2) return { mixed: true, target: 'haeyo' };
  return { mixed: false };
}

// ── 압축(요약문) 검출 — surfaceguard의 측정 재사용(중복 정의 방지) ──
const isCompressed = sg.isCompressedSentence;
function compressionCount(segText) {
  return sg.splitSentences(segText).filter(isCompressed).length;
}

function buildRepairPrompt(segText, issues, lang) {
  const rules = [];
  if (issues.banPhrases.length) rules.push(`· 과다 반복된 표현 "${issues.banPhrases.join(', ')}"을 쓰지 말고 다양한 다른 표현·종결로 바꿔라.`);
  if (issues.register) rules.push(`· 문단의 말투를 ${issues.register === 'haeyo' ? '해요체(~예요/~거든요/~죠)' : '한다체(~다/~이다)'} 하나로 통일하라 — 한 문단에 말투를 섞지 마라.`);
  if (issues.compression) rules.push('· 한 문장에 주장·근거·결론을 몰아넣은 "요약문"이 있으면 관찰→설명→판단 순서로 2~3문장으로 풀어라(원문 정보 안에서만, 새 정보 금지).');
  const system = `너는 한국어 글 편집자다. 아래 문단을 다음 규칙대로만 다듬어라:
${rules.join('\n')}
· 사실·수치·고유명사·의미·분량은 그대로 두고, 원문에 없는 새 정보는 절대 만들지 마라.
· 본문만 출력(설명·머리말·따옴표 금지).`;
  return { system, user: `[문단]\n${segText}` };
}

// 통합 폴리시 패스
async function polishPass(text, { lang = 'ko', signal, floor, rawText = '', allowedExtra = '', targetChars = 350, densityMap = PHRASE_DENSITY } = {}) {
  const overUsage = measurePhraseUsage(text, densityMap).over;
  const overPhrases = overUsage.map(o => o.phrase);
  const segs = sg.buildSegments(text, targetChars);

  // 표현별 예산 초과분이 든 segment 식별(앞쪽 budget개는 보존)
  const phraseRepairIdx = new Set();
  for (const { phrase, budget: b } of overUsage) {
    let seen = 0;
    segs.forEach((s, i) => {
      const c = countOcc(s, phrase); if (!c) return;
      if (seen >= b || seen + c > b) phraseRepairIdx.add(i);
      seen += c;
    });
  }

  const out = segs.slice();
  let repaired = 0;
  const stats = { phrase: 0, register: 0, compression: 0 };

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const banPhrases = phraseRepairIdx.has(i) ? overPhrases.filter(p => countOcc(seg, p)) : [];
    const mix = paragraphMixed(seg);
    const comp = compressionCount(seg);
    const issues = { banPhrases, register: mix.mixed ? mix.target : null, compression: comp > 0 };
    if (!banPhrases.length && !issues.register && !issues.compression) continue;

    const { system, user } = buildRepairPrompt(seg, issues, lang);
    let cand = '';
    try { cand = (await llmText({ system, user, signal, maxTokens: 1300, model: HAIKU }) || '').trim(); } catch { continue; }
    if (!cand || cand.length < seg.length * 0.55) continue;
    if (cand.replace(/\s+/g, '').length > seg.replace(/\s+/g, '').length * 1.10) continue;   // 길이중립(폴리시도 추가 아닌 교체)
    if (floor?.looksLikeRefusal?.(cand)) continue;
    if (floor?.measureNovelty) {
      const nov = floor.measureNovelty(rawText || seg, cand, allowedExtra || '');
      if (nov.count >= 1) continue;                 // 새 사실 → 폐기(무해)
    }
    if (sg.measurePersonalExperienceNovelty) {       // 경험 날조도 per-segment 차단(all-or-nothing 게이트 전체거부 방지)
      const ex = sg.measurePersonalExperienceNovelty(rawText || seg, cand, allowedExtra || '');
      if (ex.count >= 1) continue;
    }
    // 개선 확인: 금지어 감소 또는 압축/혼합 해소가 실제로 있어야 채택
    const phraseOk = !banPhrases.length || banPhrases.some(p => countOcc(cand, p) < countOcc(seg, p));
    const compOk = !issues.compression || compressionCount(cand) < comp;
    const regOk = !issues.register || !paragraphMixed(cand).mixed;
    if (!(phraseOk || compOk || regOk)) continue;
    out[i] = cand; repaired++;
    if (banPhrases.length && phraseOk) stats.phrase++;
    if (issues.register && regOk) stats.register++;
    if (issues.compression && compOk) stats.compression++;
  }

  return { text: out.join('\n\n'), repaired, stats, overPhrases };
}

module.exports = { polishPass, sentRegister, paragraphMixed, isCompressed, compressionCount };
