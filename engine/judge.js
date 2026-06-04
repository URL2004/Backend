// [engine/judge.js] Soft Claim Ledger + semanticJudge (보고서 §7.3·§7.2) — LLM
// ────────────────────────────────────────────────────────────────
// cheap risk detector(softguard)가 "의심" 청크를 선별하면, 여기서 LLM이 "판정"한다.
//   1) buildSoftClaimLedger: SOURCE에서 닫힌세계 claim 원장 추출. 각 claim의 evidence_text는
//      rawText에 (근사)매칭돼야 채택, 미매칭은 폐기(§7.3 무결성). 상한 적용.
//   2) semanticJudge: 원장(허용된 유일 주장)과 REWRITE를 대조해, 왜곡/모순 또는
//      원장에 없는 새 주장·감정·미래전망·평가 추가를 잡는다. span은 REWRITE에 실재해야 채택(환각 방지).

const MODEL = 'claude-sonnet-4-6';
const API = 'https://api.anthropic.com/v1/messages';

function parseJSON(s) {
  if (!s) return null;
  let t = String(s).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i >= 0 && j > i) t = t.slice(i, j + 1);
  try { return JSON.parse(t); } catch { return null; }
}

// LLM에서 텍스트 받기 — claudecode(구독) 또는 api(키). "Execution error"·빈응답에 4회 재시도+백오프.
async function llmText({ system, user, signal, maxTokens = 4096 }) {
  const isBad = (s) => !s || /^execution error/i.test(String(s).trim()) || String(s).replace(/\s+/g, '').length < 5;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  async function once() {
    if (process.env.LLM_BACKEND === 'claudecode') {
      const { runClaudeCode } = require('./claudecode');
      return runClaudeCode(`${system}\n\n${user}`, { model: MODEL, signal });
    }
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('judge: ANTHROPIC_API_KEY 없음 (api 모드)');
    const resp = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
      signal
    });
    const data = await resp.json();
    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(1500);
    let raw = '';
    try { raw = await once(); } catch (e) { if (signal?.aborted) throw e; }
    if (!isBad(raw)) return String(raw).trim();
  }
  return '';
}

// JSON은 llmText + 파싱(파싱 실패 시 추가 재시도).
async function llmJSON({ system, user, signal, maxTokens = 2048 }) {
  const u = `${user}\n\n반드시 유효한 JSON 객체 하나만 출력하세요. 코드펜스·설명·머리말 금지.`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await llmText({ system, user: u, signal, maxTokens });
    const parsed = parseJSON(raw);
    if (parsed) return parsed;
  }
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
  const system = lang === 'en'
    ? 'Extract a closed-world claim ledger from SOURCE for fact-checking a rewrite. Each claim MUST be directly supported by SOURCE; evidence_text MUST be a verbatim substring of SOURCE. 3-7 core claims (more for long text, cap ~15). Do not infer beyond the text.'
    : 'SOURCE에서 재작성 검증용 "닫힌세계 claim 원장"을 추출한다. 각 claim은 SOURCE에 직접 근거해야 하며, evidence_text는 SOURCE의 그대로(verbatim) 부분 문자열이어야 한다. 핵심 claim 3~7개(긴 글이면 더, 상한 ~15). 본문을 넘어 추론하지 마라.';
  const user = `JSON: {"claims":[{"claim":"핵심 주장 한 줄","evidence_text":"SOURCE 그대로 인용"}]}\n\n[SOURCE]\n${rawText}`;
  const out = await llmJSON({ system, user, signal });
  const claims = Array.isArray(out?.claims) ? out.claims : [];
  const kept = claims.filter(c => evidenceMatches(rawText, c?.evidence_text));
  const capped = kept.slice(0, 15);
  return { claims: capped, total: claims.length, dropped: claims.length - kept.length };
}

async function semanticJudge(rawText, outputText, ledger, { lang = 'ko', signal } = {}) {
  const claimsText = (ledger?.claims || []).map((c, i) => `${i + 1}. ${c.claim}`).join('\n') || '(none)';
  const system = lang === 'en'
    ? 'You are a strict fact-checker. The CLAIM LEDGER is the ONLY allowed set of claims (closed world). Flag where the REWRITE (a) contradicts/distorts a ledger claim, or (b) adds a NEW claim, emotion, future projection, or evaluation NOT supported by the ledger. Do NOT flag faithful paraphrase. Each span must be a verbatim substring of REWRITE.'
    : '엄격한 사실검증자. CLAIM LEDGER가 허용된 유일한 주장 집합(닫힌세계)이다. REWRITE가 (a)원장 claim을 왜곡/모순하거나 (b)원장에 없는 새 주장·감정·미래전망·평가를 추가한 지점을 잡아라. 충실한 paraphrase는 절대 잡지 마라. 각 span은 REWRITE의 그대로 부분 문자열이어야 한다.';
  const user = `JSON: {"violations":[{"type":"distortion|added_claim","span":"REWRITE 그대로 인용","detail":"왜 위반인지"}]}\n\n[CLAIM LEDGER — 허용된 유일 주장]\n${claimsText}\n\n[REWRITE]\n${outputText}`;
  const out = await llmJSON({ system, user, signal });
  const violations = Array.isArray(out?.violations) ? out.violations : [];
  // 환각 방지: span이 실제 REWRITE에 존재하는 위반만 채택.
  const verified = violations.filter(v => v?.span && normWS(outputText).includes(normWS(v.span).slice(0, Math.min(24, normWS(v.span).length))));
  return { violations: verified, rawCount: violations.length, pass: verified.length === 0 };
}

// 위반 span만 외과적으로 교정(삭제/수정). 새 정보 추가 금지. 텍스트 반환.
async function repairViolations(rawText, outputText, ledger, violations, { lang = 'ko', signal } = {}) {
  if (!violations || !violations.length) return outputText;
  const claimsText = (ledger?.claims || []).map((c, i) => `${i + 1}. ${c.claim}`).join('\n') || '(none)';
  const vText = violations.map((v, i) => `${i + 1}. [${v.type}] "${v.span}" — ${v.detail}`).join('\n');
  const system = lang === 'en'
    ? 'You are an editor. Fix ONLY the listed violations in the REWRITE: remove or correct each flagged span so it no longer contradicts the ledger or adds unsupported claims/emotion/future projections. Keep all other text intact. Add NO new information. Output only the corrected text.'
    : '편집자. REWRITE에서 "지정된 위반"만 고쳐라: 각 위반 span을 원장과 모순되지 않고 근거 없는 주장·감정·미래전망을 추가하지 않도록 삭제하거나 수정한다. 나머지 텍스트는 그대로 둔다. 새 정보 추가 금지.';
  const user = `[CLAIM LEDGER — 허용된 유일 주장]\n${claimsText}\n\n[위반 — 이것만 수정]\n${vText}\n\n[REWRITE]\n${outputText}\n\n수정된 본문만 출력(설명·따옴표·코드펜스 금지).`;
  const out = await llmText({ system, user, signal, maxTokens: 8192 });
  // repair는 날조를 삭제하므로 짧아지는 게 정상 — 비었을(LLM 실패) 때만 원본 유지.
  return out && out.replace(/\s+/g, '').length >= 5 ? out : outputText;
}

// 원장 1회 추출 → judge → 위반 시 repair → 재judge, 최대 maxRounds. P2-c 닫힌 루프(§7.2).
async function judgeAndRepair(rawText, outputText, { lang = 'ko', signal, maxRounds = 2 } = {}) {
  const ledger = await buildSoftClaimLedger(rawText, { lang, signal });
  let text = outputText;
  let verdict = await semanticJudge(rawText, text, ledger, { lang, signal });
  let rounds = 0;
  while (!verdict.pass && rounds < maxRounds) {
    rounds++;
    const repaired = await repairViolations(rawText, text, ledger, verdict.violations, { lang, signal });
    if (repaired === text) break; // 변화 없으면 중단
    text = repaired;
    verdict = await semanticJudge(rawText, text, ledger, { lang, signal });
  }
  return { ledger, outputText: text, verdict, rounds };
}

module.exports = { buildSoftClaimLedger, semanticJudge, repairViolations, judgeAndRepair, llmJSON, llmText, evidenceMatches };
