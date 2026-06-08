// [engine/polish.js] Phase 0 통합 폴리시 패스 (검출 + 국소 LLM repair)
// ────────────────────────────────────────────────────────────────
// 카피킬러 잔여 약한 플래그(기계적 균일성·압축·구어체 템플릿·register 혼합)를
// segment 단위로 "검출 → 국소 repair"한다. 전체 재작성 아님. FLOOR(novelty) 재검으로 날조 차단.
//   1) phrase 과다 반복(구어체 템플릿)  [phrasebudget]
//   2) register 혼합(한 문단에 해요체+한다체)  [conservative]
//   3) 압축 서술(한 문장에 정보 과밀 = 요약문)
// segment당 issue가 1개라도 있으면 1회만 repair(결합 제약). 없으면 LLM 호출 0.

const sg = require('./surfaceguard');
const { llmText } = require('./judge');
const { measurePhraseUsage, countOcc, PHRASE_BUDGET } = require('./phrasebudget');

// ── register 분류 ──
function sentRegister(s) {
  const t = (s || '').trim().replace(/["'”’)\]]+$/, '');
  if (/[?？]$/.test(t)) return 'q';
  if (/(습니다|ㅂ니다|입니다|입니까|습니까)\.?$/.test(t)) return 'hap';      // 합니다체
  if (/(요|죠|쥬|군요|걸요|는데요|ㄹ게요|ㄹ까요|에요|예요|아요|어요|네요|데요)\.?$/.test(t)) return 'haeyo';
  if (/(이?다|한다|된다|않다|없다|있다|었다|였다|는다|ㄴ다|린다|진다|온다|난다|간다|싶다|보다)\.?$/.test(t)) return 'handa';
  return 'other';   // 체언 종결·감탄 등 — register 중립(버스티니스용, 건드리지 않음)
}

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

// ── 압축(요약문) 검출: 한 문장에 정보 과밀 ──
const CAUSAL_RE = /(그래서|때문|따라서|결국|그러므로|덕분|탓에|로\s*인해|결과적으로)/;
const LIST_RE = /[,·]/g;
function isCompressed(s) {
  const t = (s || '').trim();
  const len = t.replace(/\s+/g, '').length;
  const commas = (t.match(LIST_RE) || []).length;
  const abstractN = (t.match(/(중요성|필요성|가능성|영향|역할|방식|구조|균형|의미|가치|측면|태도|관점|경향|특성|본질|요소|차원|결과|과정|능력|문제|관리|습관|방향|기준|책임)/g) || []).length;
  const causal = CAUSAL_RE.test(t) ? 1 : 0;
  // 정보 과밀(요약문): 나열·추상명사 밀도 위주(길이는 보조). 단순 나열(추상명사 적음)은 제외.
  if (commas >= 3 && abstractN >= 3) return true;                  // 추상 항목 나열형
  if (len >= 60 && abstractN >= 3 && causal) return true;          // 긴 인과+추상 cram
  if (len >= 55 && commas >= 2 && abstractN >= 4) return true;     // 추상 초과밀
  return false;
}
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
async function polishPass(text, { lang = 'ko', signal, floor, rawText = '', allowedExtra = '', targetChars = 350, budget = PHRASE_BUDGET } = {}) {
  const overUsage = measurePhraseUsage(text, budget).over;
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
    try { cand = (await llmText({ system, user, signal, maxTokens: 1300 }) || '').trim(); } catch { continue; }
    if (!cand || cand.length < seg.length * 0.55) continue;
    if (floor?.looksLikeRefusal?.(cand)) continue;
    if (floor?.measureNovelty) {
      const nov = floor.measureNovelty(rawText || seg, cand, allowedExtra || '');
      if (nov.count >= 1) continue;                 // 새 사실 → 폐기(무해)
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
