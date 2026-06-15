// [engine/judge.js] Soft Claim Ledger + semanticJudge (보고서 §7.3·§7.2) — LLM
// ────────────────────────────────────────────────────────────────
// cheap risk detector(softguard)가 "의심" 청크를 선별하면, 여기서 LLM이 "판정"한다.
//   1) buildSoftClaimLedger: SOURCE에서 닫힌세계 claim 원장 추출. 각 claim의 evidence_text는
//      rawText에 (근사)매칭돼야 채택, 미매칭은 폐기(§7.3 무결성). 상한 적용.
//   2) semanticJudge: 원장(허용된 유일 주장)과 REWRITE를 대조해, 왜곡/모순 또는
//      원장에 없는 새 주장·감정·미래전망·평가 추가를 잡는다. span은 REWRITE에 실재해야 채택(환각 방지).

const MODEL = 'claude-sonnet-4-6';
const HAIKU = 'claude-haiku-4-5';   // 판정·단순편집용 저가 티어(~3x 저렴). 생성(humanize/stance)은 Sonnet 유지.
const API = 'https://api.anthropic.com/v1/messages';

// ★ LLM JSON의 상습 독: 문자열 값 안의 이스케이프 안 된 큰따옴표(한국어 인용 — "알아서 잘 써라" 류).
//   인용부호 많은 글에서 judge·slot plan JSON이 통째로 깨지던 실사고(2026-06-12) — judge는 조용히
//   pass(거짓음성), slot plan은 작업 사망으로 이어졌다. 상태머신으로 "문자열 내부" 여부를 추적해,
//   닫는 따옴표로 해석 불가능한 위치(뒤가 , } ] : 가 아닌)의 따옴표만 \"로 복구한다.
function sanitizeJsonQuotes(t) {
  let out = '';
  let inStr = false;
  for (let k = 0; k < t.length; k++) {
    const ch = t[k];
    if (!inStr) {
      if (ch === '"') inStr = true;
      out += ch;
      continue;
    }
    if (ch === '\\') { out += ch + (t[k + 1] || ''); k++; continue; }
    if (ch === '"') {
      const rest = t.slice(k + 1).match(/^\s*([\s\S])/);
      const next = rest ? rest[1] : '';
      if (next === ',' || next === '}' || next === ']' || next === ':') { inStr = false; out += ch; }
      else if (next === '') { inStr = false; out += ch; }
      else out += '\\"';                       // 문자열 내부 인용부호 → 이스케이프 복구
      continue;
    }
    out += ch;
  }
  return out;
}
function parseJSON(s) {
  if (!s) return null;
  let t = String(s).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i >= 0 && j > i) t = t.slice(i, j + 1);
  try { return JSON.parse(t); } catch { /* 복구 시도 */ }
  try { return JSON.parse(sanitizeJsonQuotes(t)); } catch { return null; }
}

// LLM에서 텍스트 받기 — claudecode(구독) 또는 api(키). "Execution error"·빈응답에 4회 재시도+백오프.
async function llmText({ system, user, signal, maxTokens = 4096, model = MODEL }) {
  const isBad = (s) => !s || /^execution error/i.test(String(s).trim()) || String(s).replace(/\s+/g, '').length < 5;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  async function once() {
    if (process.env.LLM_BACKEND === 'claudecode') {
      const { runClaudeCode } = require('./claudecode');
      return runClaudeCode(`${system}\n\n${user}`, { model, signal });
    }
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('judge: ANTHROPIC_API_KEY 없음 (api 모드)');
    const resp = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      // ★ prompt caching(2026-06-12 비용 최적화): system을 ephemeral 캐시로 — 같은 system이 5분 내 반복되면
      //   (judge 2라운드·위빙 반복 등) 입력 토큰을 캐시읽기로 재사용. 1024토큰 미만이면 API가 자동 무시(무해).
      //   genretransfer 전 호출이 이 llmText를 타므로 한 곳 수정으로 재구성 경로 전체에 적용.
      body: JSON.stringify({ model, max_tokens: maxTokens, system: system ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined, messages: [{ role: 'user', content: user }] }),
      signal
    });
    if (!resp.ok) {                                  // ★ API 에러를 조용히 삼키지 않는다(크레딧·rate limit 등).
      let msg = resp.statusText;
      try { const e = await resp.json(); msg = e?.error?.message || msg; } catch {}
      throw new Error(`Anthropic API ${resp.status}: ${msg}`);
    }
    const data = await resp.json();
    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(1500);
    let raw = '';
    try { raw = await once(); } catch (e) { if (signal?.aborted) throw e; lastErr = e; }
    if (!isBad(raw)) return String(raw).trim();
  }
  // 4회 모두 실패 → 빈 문자열은 호출부에서 "claim 0 → judge 통과"로 오인되므로, 마지막 에러를 표면화.
  if (lastErr) throw new Error(`llmText 실패(${4}회): ${lastErr.message}`);
  return '';
}

// JSON은 llmText + 파싱(파싱 실패 시 추가 재시도).
async function llmJSON({ system, user, signal, maxTokens = 2048, model = MODEL }) {
  const u = `${user}\n\n반드시 유효한 JSON 객체 하나만 출력하세요. 코드펜스·설명·머리말 금지.`;
  let lastRaw = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await llmText({ system, user: u, signal, maxTokens, model });
    lastRaw = raw;
    const parsed = parseJSON(raw);
    if (parsed) return parsed;
  }
  // 3회 전부 파싱 실패 — 무엇이 나왔는지 안 남기면 진단 불가('slot plan 실패' 실사고에서 확인).
  console.warn('⚠️ llmJSON 파싱 3회 실패 — raw 헤드:', String(lastRaw).replace(/\s+/g, ' ').slice(0, 220));
  return null;
}

const normWS = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
function evidenceMatches(rawText, ev) {
  const R = normWS(rawText), E = normWS(ev);
  if (E.length < 4) return false;
  if (R.includes(E)) return true;
  return R.includes(E.slice(0, Math.min(24, E.length))); // near-exact 근사
}

async function buildSoftClaimLedger(rawText, { lang = 'ko', signal } = {}) {
  // ★ 원장 크기를 글 길이에 비례 — 긴 글에서 claim이 과소하면 보존된 원문이 judge에 "추가됨"으로 오판된다.
  const rawLen = (rawText || '').replace(/\s+/g, '').length;
  const cap = Math.min(40, Math.max(12, Math.round(rawLen / 300))); // 8900자 → ~30
  const system = lang === 'en'
    ? `Extract a closed-world claim ledger from SOURCE for fact-checking a rewrite. Each claim MUST be directly supported by SOURCE; evidence_text MUST be a verbatim substring of SOURCE. Cover the WHOLE source — roughly one claim per paragraph/idea so nothing real is later mistaken for "added" (aim for up to ${cap} claims for this length). Do not infer beyond the text.`
    : `SOURCE에서 재작성 검증용 "닫힌세계 claim 원장"을 추출한다. 각 claim은 SOURCE에 직접 근거해야 하며, evidence_text는 SOURCE의 그대로(verbatim) 부분 문자열이어야 한다. SOURCE 전체를 빠짐없이 커버하라 — 문단·논점마다 1개 이상 뽑아, 나중에 보존된 원문이 "추가된 주장"으로 오인되지 않게 하라(이 길이면 최대 ${cap}개 정도). 본문을 넘어 추론하지 마라.`;
  const user = `JSON: {"claims":[{"claim":"핵심 주장 한 줄","evidence_text":"SOURCE의 짧은 verbatim 구절(8~20자)"}]}\n\n[SOURCE]\n${rawText}`;
  // ★ 대용량 글: ${cap}(최대 40)개 claim+evidence가 4096토큰을 넘겨 응답이 truncate→파싱실패→0개가 되면
  //   judge가 무의미 통과하고 grounding 게이트도 오작동한다. 토큰을 claim 수에 맞춰 넉넉히.
  const out = await llmJSON({ system, user, signal, maxTokens: Math.min(8192, 2048 + cap * 200) });  // ★ ledger는 FLOOR 토대 — Sonnet 유지(불완전 원장→semanticJudge 거짓양성 BLOCK). 문서당 1회라 비용 미미.
  const claims = Array.isArray(out?.claims) ? out.claims : [];
  const kept = claims.filter(c => evidenceMatches(rawText, c?.evidence_text));
  const capped = kept.slice(0, cap);
  return { claims: capped, total: claims.length, dropped: claims.length - kept.length };
}

// added_claim 오탐 방지: 플래그된 span의 내용어 대부분이 SOURCE에 실재하면 "추가"가 아니라 보존된 원문이다.
//   (원장은 SOURCE의 *표본*이라 닫힌세계가 불완전 → "원장에 없음"을 "추가됨"으로 단정하면 긴 글에서 오탐.)
const SPAN_STOP = new Set(['그', '이', '저', '것', '수', '등', '및', '더', '좀', '꽤', '또', '그리고', '하지만', '그러나', '그런데', '때문', '위해', '통해', '대한', '하는', '있는', '되는', '같은', '경우', '정도', '가장', '훨씬', '이런', '저런', '그런']);
function spanInSource(span, rawText) {
  const toks = (span || '').match(/[가-힣]{2,}|[A-Za-z]{2,}|\d+%?/g) || [];
  const content = [...new Set(toks)].filter(t => !SPAN_STOP.has(t));
  if (content.length < 3) return false;
  const R = rawText || '';
  const hit = content.filter(t => R.includes(t)).length;
  return hit / content.length >= 0.7; // 내용어 70%+ 가 원문에 있으면 보존된 내용
}

// 원장 건전성 게이트(§리뷰#6): 닫힌세계 판정의 신뢰도 사전점검.
//   - 0건: 닫힌세계가 비어 semanticJudge의 "pass"가 무의미(보통 LLM 일시 실패).
//   - 과다 폐기(채택<절반): evidence_text 환각이 많아 원장 신뢰 불가.
//   - 장문 과소표집: 본문은 긴데 claim이 3건 미만 → 커버리지 부족.
function validateLedgerHealth(ledger, rawText) {
  const claims = ledger?.claims?.length || 0;
  const total = ledger?.total || 0;
  const dropped = ledger?.dropped || 0;
  const rawLen = (rawText || '').replace(/\s+/g, '').length;
  if (claims === 0) return { healthy: false, reason: 'no_claims' };
  if (total >= 3 && dropped / total > 0.5) return { healthy: false, reason: 'high_drop' };
  if (rawLen >= 1500 && claims < 3) return { healthy: false, reason: 'undercovered' };
  return { healthy: true, reason: 'ok' };
}

// 원장을 judge/repair 입력용 텍스트로 — claim + 근거(원문 그대로)를 함께 노출(§리뷰#11).
//   근거 원문장을 주면 judge가 요약 손실 없이 "원문 사실"과 직접 대조해 왜곡·역전을 더 정확히 판정.
function ledgerToText(ledger) {
  const claims = ledger?.claims || [];
  if (!claims.length) return '(none)';
  return claims.map((c, i) => {
    const ev = c?.evidence_text ? `\n   근거(원문): "${String(c.evidence_text).trim()}"` : '';
    return `${i + 1}. ${c.claim}${ev}`;
  }).join('\n');
}

async function semanticJudge(rawText, outputText, ledger, { lang = 'ko', signal, allowedExtra = '', mode = '' } = {}) {
  const claimsText = ledgerToText(ledger);
  // ★ 격식 모드(assignment/thesis) register 교정용 FLOOR 완화(사장님 승인 재적용): 기존 원장 내용에 붙이는 해석·평가·관점
  //   ("필자가 보기에/핵심은/문제는 A가 아니라 B")은 새 사실이 아니라 논지의 명시화 → (3)의 '평가'를 위반에서 제외.
  //   ★단 (1)새 사실·수치·고유명사·인과 날조와 (2)왜곡·정서역전은 그대로 엄격 차단(deterministic novelty/experience도 strict 유지).
  const formal = (mode === 'assignment' || mode === 'thesis');
  const formalKo = formal ? ' ★[격식 학술 모드] 위 (3)에서 "평가"는 제외 — 글쓴이가 *기존 원장 내용*에 붙이는 해석·평가·관점·강조("필자가 보기에/핵심은/문제는 A가 아니라 B/더 주목할 부분은")는 위반이 아니다(논지 명시화). 새 사실·사건·수치·고유명사·인과를 사실처럼 도입할 때만 위반.' : '';
  const formalEn = formal ? ' ★[FORMAL ACADEMIC MODE] In (3), evaluation/interpretation the author adds ABOUT EXISTING ledger content is NOT a violation; only flag introducing NEW facts/figures/proper-nouns/causal-claims.' : '';
  const system = lang === 'en'
    ? 'You are a strict but fair fact-checker against the CLAIM LEDGER (closed world). Each ledger entry has a verbatim source quote labeled 근거(원문) — that quote is the ground truth; judge the REWRITE against it, not against your own knowledge. Flag ONLY: (1) fabricated external facts/statistics/years/proper nouns, or newly specifying a vague reference into a concrete platform/product name. (2) Reversing or distorting a ledger claim\'s meaning, INTENT, or sentiment — e.g., flipping a positive intent ("want to keep going") into uncertainty/negativity ("not sure I can keep going / might quit"), or turning possibility ("can ~") into a flat assertion. (3) Introducing a NEW outlook/emotion/future projection/evaluation not in the ledger — even if phrased as a hedge, bringing in a new stance or prospect is a violation. ★ NOT violations: synonym swaps, reordering, minor qualifiers, and hedges that keep an existing claim\'s meaning intact. Each span must be a verbatim substring of REWRITE.' + formalEn
    : '엄격하되 공정한 사실검증자. CLAIM LEDGER(닫힌세계)에 대조해 판정한다. 각 항목엔 원문 그대로의 근거(원문) 인용이 붙어 있다 — 그 인용이 사실 기준(ground truth)이며, 네 지식이 아니라 그 근거에 비추어 REWRITE를 판정하라. 다음만 위반으로 잡아라: (1) 외부 사실·통계·연도·고유명사 날조, 또는 모호한 표현을 특정 플랫폼/제품 고유명사로 신규 구체화. (2) 원장 claim의 의미·의도·정서를 뒤집거나 왜곡 — 예: 긍정 의지("계속하고 싶다")를 불확실·부정("계속할 수 있을지 모르겠다 / 그만둘지도")으로 역전, 또는 가능성("~할 수 있다")을 단정("~한다")으로 강화. (3) 원장에 없는 새 전망·감정·미래예측·평가를 *새로운 입장으로* 들여오기 — hedge(완화) 형식이어도 새 전망·정서를 도입하면 위반. ★ 위반 아님: 동의어 교체·어순 변경·사소한 수식어, 그리고 기존 claim의 뜻을 유지한 채 붙인 단순 hedge. 각 span은 REWRITE의 그대로 부분 문자열이어야 한다.' + formalKo;
  const user = `JSON: {"violations":[{"type":"distortion|added_claim","span":"REWRITE 그대로 인용","detail":"왜 위반인지"}]}\n\n[CLAIM LEDGER — 허용된 유일 주장 (각 항목 근거=원문 인용)]\n${claimsText}\n\n[REWRITE]\n${outputText}`;
  const out = await llmJSON({ system, user, signal });  // ★ semanticJudge는 FLOOR 게이트 — Sonnet 유지(거짓양성=BLOCK, 거짓음성=날조통과). 문서당 1~2회라 비용 미미.
  const violations = Array.isArray(out?.violations) ? out.violations : [];
  // 환각 방지: span이 실제 REWRITE에 존재하는 위반만 채택.
  let verified = violations.filter(v => v?.span && normWS(outputText).includes(normWS(v.span).slice(0, Math.min(24, normWS(v.span).length))));
  // ★ added_claim 오탐 방지: span 내용이 SOURCE(또는 사용자 메모=allowedExtra)에 실재하면 허용된 내용이므로 폐기.
  const allowedWorld = allowedExtra ? (rawText + '\n' + allowedExtra) : rawText;
  verified = verified.filter(v => !((v.type === 'added_claim' || /added|추가|전망|미래/i.test(v.type || '')) && spanInSource(v.span, allowedWorld)));
  return { violations: verified, rawCount: violations.length, pass: verified.length === 0 };
}

// 위반 span만 외과적으로 교정(삭제/수정). 새 정보 추가 금지. 텍스트 반환.
async function repairViolations(rawText, outputText, ledger, violations, { lang = 'ko', signal } = {}) {
  if (!violations || !violations.length) return outputText;
  const claimsText = ledgerToText(ledger);  // claim + 근거(원문) — 교정 시 원문 사실로 되돌리는 기준(§리뷰#11)
  const vText = violations.map((v, i) => `${i + 1}. [${v.type}] "${v.span}" — ${v.detail}`).join('\n');
  const system = lang === 'en'
    ? 'You are an editor. Fix ONLY the listed violations in the REWRITE: remove or correct each flagged span so it no longer contradicts the ledger or adds unsupported claims/emotion/future projections. Keep all other text intact. Add NO new information. Output only the corrected text.'
    : '편집자. REWRITE에서 "지정된 위반"만 고쳐라: 각 위반 span을 원장과 모순되지 않고 근거 없는 주장·감정·미래전망을 추가하지 않도록 삭제하거나 수정한다. 나머지 텍스트는 그대로 둔다. 새 정보 추가 금지.';
  const user = `[CLAIM LEDGER — 허용된 유일 주장 (각 항목 근거=원문 인용)]\n${claimsText}\n\n[위반 — 이것만 수정]\n${vText}\n\n[REWRITE]\n${outputText}\n\n수정된 본문만 출력(설명·따옴표·코드펜스 금지).`;
  const out = await llmText({ system, user, signal, maxTokens: 8192, model: HAIKU });
  // repair는 날조를 삭제하므로 짧아지는 게 정상 — 비었을(LLM 실패) 때만 원본 유지.
  // ★ 수리 LLM이 "교정 본문" 대신 판정 스캐폴딩(# 판정/## 수정 문장/added_claim…)을 통째로 반환하는
  //   누출(2026-06-15 실측)을 차단 — 그런 후보는 폐기하고 직전 본문 유지(다음 라운드 judge가 재시도).
  const JUDGE_SCAFFOLD = /(added_claim|distortion|claim\s*ledger|\bREWRITE\b|수정\s*문장\s*[:：]|#{1,6}\s*판정|#{1,6}\s*근거)/i;
  if (!out || out.replace(/\s+/g, '').length < 5 || JUDGE_SCAFFOLD.test(out)) return outputText;
  return out;
}

// 원장 1회 추출 → judge → 위반 시 repair → 재judge, 최대 maxRounds. P2-c 닫힌 루프(§7.2).
// ★ approvedFacts(웹검증+학생승인 사실, genretransfer 이식): 닫힌세계 원장에 verbatim claim으로 포함.
//   효과 ①승인 사실 인용이 added_claim으로 오탐되지 않음 ②judge가 사실의 원문을 ground truth로 들고 있어
//   "재조합 왜곡"(두 조사 융합·부호 탈락)을 정당하게 위반으로 잡음(45% 실측본 날조 2건이 이 계열).
async function judgeAndRepair(rawText, outputText, { lang = 'ko', signal, maxRounds = 2, allowedExtra = '', approvedFacts = '' } = {}) {
  let ledger = await buildSoftClaimLedger(rawText, { lang, signal });
  let health = validateLedgerHealth(ledger, rawText);
  // 0건/과다폐기는 claudecode 일시실패가 잦아 1회 재구축 시도.
  if (!health.healthy && (health.reason === 'no_claims' || health.reason === 'high_drop')) {
    const retry = await buildSoftClaimLedger(rawText, { lang, signal });
    const retryHealth = validateLedgerHealth(retry, rawText);
    if ((retry.claims.length || 0) > (ledger.claims.length || 0) || retryHealth.healthy) { ledger = retry; health = retryHealth; }
  }
  const evLines = (approvedFacts || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (evLines.length) {
    ledger = { ...ledger, claims: [...ledger.claims, ...evLines.map(l => ({ claim: l, evidence_text: l }))], augmented: evLines.length };
  }
  let text = outputText;
  // ★ 과제 자연체(FORMAL_HUMAN): semanticJudge에 mode=assignment 전달 → 필자 1인칭 판단을 added_claim으로 깎지 않음(사실 날조는 계속 차단).
  const _mode = (process.env.FORMAL_HUMAN === '1' || process.env.ASSIGNMENT_B7 === '1') ? 'assignment' : '';
  let verdict = await semanticJudge(rawText, text, ledger, { lang, signal, allowedExtra, mode: _mode });
  let rounds = 0;
  while (!verdict.pass && rounds < maxRounds) {
    rounds++;
    const repaired = await repairViolations(rawText, text, ledger, verdict.violations, { lang, signal });
    if (repaired === text) break; // 변화 없으면 중단
    text = repaired;
    verdict = await semanticJudge(rawText, text, ledger, { lang, signal, allowedExtra, mode: _mode });
  }
  return { ledger, outputText: text, verdict, rounds, ledgerHealth: health };
}

module.exports = { buildSoftClaimLedger, semanticJudge, repairViolations, judgeAndRepair, validateLedgerHealth, spanInSource, llmJSON, llmText, evidenceMatches, MODEL, HAIKU };
