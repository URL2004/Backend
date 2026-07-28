// [engine/formalbudget.js] 격식 표현예산 — 판단프레임·punch·정형마무리 반복의 결정론 검출 + 국소 다양화
// ────────────────────────────────────────────────────────────────
// 동기(2026-06-10 격식 출력 정량): 격식 출력에 같은 수사 구조가 반복 등장 —
//   ① grounding 누출 계열: "~을 가르는 것은 A가 아니라 B"(원문 0회→출력 7~8회), 아니라/아니다 밀도 원문 대비 +47%
//   ② punch 템플릿 재사용: "그것이 핵심이다"·"바로 이 지점에서 개입한다"가 한 글에 5~6회
//   ③ 문단 정형 마무리: 같은 종결("~것이다/~셈이다")로 닫는 문단 연속
// 카피킬러 %는 못 움직인다(격식 밴드 73~95 확정) — 목적은 "동일 표현 반복"이라는 품질 결함 제거
//   (사람 독자·교수가 바로 알아채는 AI 티 + 카피킬러 '반복/전형성' 사유 텍스트).
// 메커니즘 = phrasebudget과 동일: 맹목 치환 금지, 결정론 검출 → 초과 occurrence가 든 segment만 국소 LLM 다양화
//   → FLOOR(novelty/경험날조) 재검 → 실제로 줄었을 때만 채택(악화 시 원본 유지 = 무해).

const sg = require('./surfaceguard');
const { llmText, HAIKU } = require('./judge');

// ── 템플릿 패밀리(정규식) + 문서당 절대 예산 ──
//   원문에 이미 있던 사용량은 예산에 더해준다(원문 표현 보존이 위반이 되지 않게).
const TEMPLATE_FAMILIES = [
  { key: '핵심이다-punch', re: /(그것이|그게|이것이|이게|이는|바로\s*그것이)\s*(핵심|문제|관건|요점)이다/g, budget: 1, desc: '「그것이/이것이 핵심이다」식 단정 punch' },
  { key: '바로-이-지점', re: /바로\s*(이|그)\s*(지점|곳)(이다|이에요|에서)?|바로\s*여기(다|에요|서)/g, budget: 1, desc: '「바로 여기다/바로 이 지점이다」' },
  { key: '지점에서-개입', re: /(이|그)\s*지점에서\s*(개입|작동|역할|끼어|손을|붙는)/g, budget: 1, desc: '「이 지점에서 개입한다/작동한다」' },
  // ※ "엇갈린다"(별개 단어) 오탐 방지 — 부정 lookbehind. "행동은 갈린다" 단발은 예산 1 안에서 허용.
  { key: '가르는것은', re: /가르는\s*것은|(?<!엇)갈랐다|(?<!엇)갈린다/g, budget: 1, desc: '「~을 가르는 것은 …」/「~가 갈랐다」 구문' },
  { key: '판단프레임-아니라', re: /(문제|핵심|위험|본질|관건)[은는]\s*[^.!?]{0,30}(아니라|아니다)/g, budget: 2, desc: '「문제는/핵심은 ~가 아니라 …」 판단 프레임' },
  { key: '습관이-굳어진다', re: /습관[이을]\s*(굳어|들이게)/g, budget: 1, desc: '「습관이 굳어진다/습관을 들이게 된다」' },
  { key: '다르다-punch', re: /(전혀|정말|근본적으로|결국)\s*다르다\s*\./g, budget: 1, desc: '「전혀/정말 다르다.」 단문 punch' },
  // ── LLM 간접화법 지문(문형 센서스 2026-06-10: 우리 출력 13·12·4/100문장 vs 사람 0~2 — prompt.LLM_TIC_RULE와 쌍) ──
  { key: '다는것-명사화', re: /(다|라)는\s*(것이다|점이다|사실이다|것인데|점인데)/g, budget: 3, desc: '「~다는 것이다/점이다」 명사화 꼬리표' },
  { key: '기도하다-헷지', re: /이?기도\s*하[다고며]/g, budget: 3, desc: '「~기도 하다/~이기도 하다」 양다리 헷지' },
  { key: '는데있다', re: /는\s*데(\s*에)?\s*있다/g, budget: 1, desc: '「문제는 ~하는 데 있다」' },
  { key: '로읽힌다', re: /(로|고)\s*(읽힌다|해석된다|이해된다)/g, budget: 1, desc: '「~로 읽힌다/해석된다」 해석동사' },
  { key: '지시어-추상주어', re: /(^|[.!?]\s+)(이|그)\s*(간극|차이|구조|과정|지점|흐름|경로|감각|착시|긴장|균열|역설|전환|미끄러짐)[이가은는]/g, budget: 2, desc: '「이 간극이/그 미끄러짐이」 지시어+추상명사 주어' },
  { key: '메타담화', re: /달리\s*말하면|그렇게\s*보면|바꿔\s*말하면|요컨대/g, budget: 1, desc: '「달리 말하면/그렇게 보면」 메타담화' },
  { key: '에달려있다', re: /에\s*달려\s*있/g, budget: 1, desc: '「~에 달려 있다」' },
];

// 대조부정(아니라/아니다) 전역 밀도 — 사람 격식글 실측 2.9~3.6/1000자, 누출 출력 4.3~4.6.
//   예산 = max(원문 사용량, 한글 1000자당 3.5). 초과분만 수리.
const CONTRAST_RE = /아니라|아니다/g;
const CONTRAST_DENSITY = 3.5;

function countRe(text, re) {
  const m = (text || '').match(re);
  return m ? m.length : 0;
}
function hangulLen(text) { return ((text || '').match(/[가-힣]/g) || []).length; }
function normShort(s) { return (s || '').replace(/\s+/g, '').replace(/[.!?。,'"“”‘’()[\]]/g, ''); }

// ── 짧은 punch 문장(정규화 4~14자) 재사용: 같은 조각 2회+ = 재사용(첫 등장만 허용) ──
function findReusedPunches(text) {
  const sents = sg.splitSentences(text);
  const seen = new Map();
  for (const s of sents) {
    const k = normShort(s);
    if (k.length < 4 || k.length > 14) continue;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  return [...seen.entries()].filter(([, c]) => c >= 2).map(([k, c]) => ({ fragment: k, count: c }));
}

// ── 문단 정형 마무리: 같은 종결 3글자로 닫는 문단이 예산(max(4, 문단의 30%)) 초과 ──
function findCloserOveruse(text) {
  const paras = (text || '').split(/\n{2,}/).map(p => p.trim()).filter(p => p.replace(/\s+/g, '').length > 60);
  const closers = paras.map(p => {
    const s = sg.splitSentences(p);
    if (!s.length) return '';
    return s[s.length - 1].replace(/[^가-힣]/g, '').slice(-3);
  });
  const cnt = new Map();
  closers.forEach(c => { if (c) cnt.set(c, (cnt.get(c) || 0) + 1); });
  const budget = Math.max(4, Math.ceil(paras.length * 0.3));
  return [...cnt.entries()].filter(([, c]) => c > budget).map(([closer, c]) => ({ closer, count: c, budget }));
}

// ── 종합 census: 초과 항목 목록(repair 대상 판단의 단일 진실) ──
function measureFormalTemplates(text, rawText = '') {
  const over = [];
  for (const f of TEMPLATE_FAMILIES) {
    const c = countRe(text, f.re);
    const rawC = rawText ? countRe(rawText, f.re) : 0;
    const budget = f.budget + rawC;             // 원문에 이미 있던 건 예산에 가산
    if (c > budget) over.push({ type: 'template', key: f.key, re: f.re, count: c, budget });
  }
  const contrastC = countRe(text, CONTRAST_RE);
  const contrastBudget = Math.max(rawText ? countRe(rawText, CONTRAST_RE) : 0, Math.ceil(hangulLen(text) / 1000 * CONTRAST_DENSITY));
  if (contrastC > contrastBudget) over.push({ type: 'contrast', key: '아니라/아니다', re: CONTRAST_RE, count: contrastC, budget: contrastBudget });
  for (const p of findReusedPunches(text)) over.push({ type: 'punch', key: p.fragment, count: p.count, budget: 1 });
  for (const c of findCloserOveruse(text)) over.push({ type: 'closer', key: c.closer, count: c.count, budget: c.budget });
  return { over };
}

// segment 안에서 이 항목이 몇 번 쓰였나(예산 소진 순서 추적용)
function occInSeg(seg, item) {
  if (item.type === 'template' || item.type === 'contrast') return countRe(seg, item.re);
  if (item.type === 'punch') return sg.splitSentences(seg).filter(s => normShort(s) === item.key).length;
  if (item.type === 'closer') {
    // segment 내 문단들 중 해당 종결로 닫는 문단 수
    return seg.split(/\n{2,}/).filter(p => {
      const s = sg.splitSentences(p.trim());
      return s.length && s[s.length - 1].replace(/[^가-힣]/g, '').slice(-3) === item.key;
    }).length;
  }
  return 0;
}

function describeBan(item) {
  if (item.type === 'template') return item.desc || `'${item.key}' 류의 수사 구조`;
  if (item.type === 'contrast') return `"~가 아니라 ~ / ~가 아니다" 대조 구문`;
  if (item.type === 'punch') return `"${item.key}" 같은 짧은 문장 재사용`;
  if (item.type === 'closer') return `"…${item.key}."로 끝나는 문단 마무리`;
  return item.key;
}

// segment에서 위반 구문이 실제로 등장한 문구를 인용(모델이 정확히 뭘 고칠지 알도록 — 추상 지시는 Haiku가 자주 놓침)
function matchesInSeg(seg, item) {
  if (item.type === 'template' || item.type === 'contrast') {
    return [...new Set((seg.match(item.re) || []).map(m => m.trim()))].slice(0, 4);
  }
  if (item.type === 'punch') return sg.splitSentences(seg).filter(s => normShort(s) === item.key).slice(0, 2);
  if (item.type === 'closer') {
    return seg.split(/\n{2,}/).map(p => { const s = sg.splitSentences(p.trim()); return s.length ? s[s.length - 1] : ''; })
      .filter(last => last.replace(/[^가-힣]/g, '').slice(-3) === item.key).slice(0, 2);
  }
  return [];
}

function buildRepairPrompt(segText, items, lang) {
  const banLines = items.map(it => {
    const found = matchesInSeg(segText, it);
    return `· ${describeBan(it)}${found.length ? ` — 이 문단의 실제 등장: ${found.map(f => `「${f}」`).join(', ')}` : ''}`;
  }).join('\n');
  const system = lang === 'en'
    ? `The same rhetorical patterns repeat too often across this document. Rewrite the paragraph keeping ALL facts, meaning, register, and length, but restructure each listed occurrence into a DIFFERENT sentence structure — the banned wording must not survive in any variant. Add no new information or opinions. Output only the rewritten paragraph.`
    : `다음 문단에는 글 전체에서 과다하게 반복된 수사 구조가 들어 있다:
${banLines}
위에 인용된 문구가 든 문장을 찾아 **그 구문 없이** 다시 써라 — 같은 구조의 변형("~가 가른다", "~이 핵심이다" 등)으로도 남기지 마라. 대조는 한정·조건·우선순위·단정 등 다른 형태로 풀어라. 규칙:
· 사실·수치·고유명사·의미·말투(한다체/해요체)·분량은 그대로.
· 새 정보·견해·예시는 절대 넣지 마라.
· 반복 구조를 없애는 것 외의 문장은 손대지 마라.
· 본문만 출력(설명·머리말·따옴표 금지).`;
  return { system, user: `[문단]\n${segText}` };
}

// ── 메인 패스: 최대 2라운드(한 segment에 위반 여럿이면 1라운드가 일부만 고칠 수 있음 — reduced 체크가 OR) ──
async function formalBudgetPass(text, opts = {}) {
  const r1 = await formalBudgetRound(text, opts);
  if (!r1.after.length || !r1.repaired) return r1;
  const r2 = await formalBudgetRound(r1.text, opts);
  return { text: r2.text, repaired: r1.repaired + r2.repaired, attempted: r1.attempted + r2.attempted, before: r1.before, after: r2.after };
}

async function formalBudgetRound(text, { lang = 'ko', signal, floor, rawText = '', allowedExtra = '', targetChars = 350 } = {}) {
  const before = measureFormalTemplates(text, rawText);
  if (!before.over.length) return { text, repaired: 0, attempted: 0, before: before.over, after: before.over };

  const segs = sg.buildSegments(text, targetChars);
  // 항목별로 "예산 초과 occurrence가 든 segment"만 수리 대상(앞쪽 budget개는 보존 — phrasebudget과 동일).
  const repairItems = new Map();   // segIdx -> items[]
  for (const item of before.over) {
    let seen = 0;
    segs.forEach((s, i) => {
      const c = occInSeg(s, item);
      if (!c) return;
      if (seen >= item.budget || seen + c > item.budget) {
        if (!repairItems.has(i)) repairItems.set(i, []);
        repairItems.get(i).push(item);
      }
      seen += c;
    });
  }
  if (!repairItems.size) return { text, repaired: 0, attempted: 0, before: before.over, after: before.over };

  const out = segs.slice();
  let repaired = 0, attempted = 0;
  for (const [i, items] of repairItems) {
    attempted++;
    const { system, user } = buildRepairPrompt(segs[i], items, lang);
    let cand = '';
    try { cand = (await llmText({ system, user, signal, maxTokens: 1400, model: HAIKU }) || '').trim(); } catch { continue; }
    if (!cand || cand.length < segs[i].length * 0.6) continue;
    const lc = cand.replace(/\s+/g, '').length, lo = segs[i].replace(/\s+/g, '').length;
    if (lc > lo * 1.15) continue;                                          // 길이중립
    if (floor && floor.looksLikeRefusal && floor.looksLikeRefusal(cand)) continue;
    if (floor && floor.measureNovelty) {
      const nov = floor.measureNovelty(rawText || segs[i], cand, allowedExtra || '');
      if (nov.count >= 1) continue;                                        // 새 사실 → 폐기(무해)
    }
    if (sg.measurePersonalExperienceNovelty) {
      const ex = sg.measurePersonalExperienceNovelty(rawText || segs[i], cand, allowedExtra || '');
      if (ex.count >= 1) continue;                                         // 경험 날조 → 폐기
    }
    // 실제로 해당 구조가 줄었는지(안 줄면 무의미 → 폐기)
    const reduced = items.some(it => occInSeg(cand, it) < occInSeg(segs[i], it));
    if (!reduced) continue;
    out[i] = cand; repaired++;
  }
  const result = out.join('\n\n');
  return { text: result, repaired, attempted, before: before.over, after: measureFormalTemplates(result, rawText).over };
}

module.exports = { measureFormalTemplates, formalBudgetPass, findReusedPunches, findCloserOveruse, TEMPLATE_FAMILIES };
