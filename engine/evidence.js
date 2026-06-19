// [engine/evidence.js] RAG 근거보강 Phase 1 — 추상 segment에 실재 공개사실 후보를 웹검색으로 수집
// ────────────────────────────────────────────────────────────────
// 설계: 설계-evidence-grounding.md. 목표: 격식 C등급(L3 0.02, 카피킬러 73~94%) 글에
//   실재 검증가능 구체(통계·연도·기관·법령·사례)를 학생 승인 하에 인용 → L3↑ → 50%대.
// ★ 무날조 유지: 엔진이 사실을 생성하면 날조. 여기선 web_search가 *실제 반환한* 결과만 쓰고,
//   모델이 인용한 sourceUrl이 검색결과 URL 집합에 없으면 폐기(환각 차단). 최종 채택은 학생 승인.
// ★ 백엔드 제약: web_search는 Anthropic 서버툴 → API 키 필수. claudecode CLI 경로 불가.

const sg = require('./surfaceguard');

const MODEL = process.env.EVIDENCE_MODEL || 'claude-sonnet-4-6';  // 엔진 기존 티어. 비용 캡.
const API = 'https://api.anthropic.com/v1/messages';
const WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search' };

// ── 응답 블록에서 web_search가 *실제* 반환한 URL 집합 추출(환각 게이트 기준) ──
//   web_search_tool_result 블록의 content[].url 이 ground truth. 모델 본문이 인용한 출처가
//   이 집합에 없으면 = 검색이 안 가져온 것 = 모델 환각 → 폐기.
function collectResultUrls(content) {
  const urls = new Set();
  for (const block of content || []) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) {
        if (r && typeof r.url === 'string') urls.add(normalizeUrl(r.url));
      }
    }
  }
  return urls;
}
function normalizeUrl(u) {
  return String(u || '').trim().replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase();
}
// 본문 텍스트 블록만 이어붙임(모델의 최종 JSON 답).
function joinText(content) {
  return (content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}
function parseJSON(s) {
  if (!s) return null;
  let t = String(s).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = t.indexOf('['), j = t.lastIndexOf(']');
  if (i >= 0 && j > i) t = t.slice(i, j + 1);
  try { return JSON.parse(t); } catch { return null; }
}

// ── web_search 서버툴 1콜 (pause_turn resume 루프) ──
async function llmWebSearch({ system, user, signal, maxTokens = 4096, maxUses = 5 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('evidence: ANTHROPIC_API_KEY 필요 — web_search 서버툴은 API 백엔드 전용(claudecode 불가)');
  let messages = [{ role: 'user', content: user }];
  const tools = [{ ...WEB_SEARCH_TOOL, max_uses: maxUses }];
  // 서버툴 내부 루프가 10회 한도에 걸리면 stop_reason=pause_turn → assistant 에코 후 재요청해 resume.
  for (let turn = 0; turn < 4; turn++) {
    const resp = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, tools, messages }),
      signal
    });
    if (!resp.ok) {
      let msg = resp.statusText;
      try { const e = await resp.json(); msg = e?.error?.message || msg; } catch {}
      throw new Error(`evidence web_search ${resp.status}: ${msg}`);
    }
    const data = await resp.json();
    try { require('./usagemeter').recordUsage({ model: MODEL, usage: data.usage, task: 'evidence' }); } catch {}   // 검색비+토큰 hotspot(감사 §5)
    if (data.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: data.content });
      continue;  // resume: trailing server_tool_use를 API가 감지해 이어감
    }
    return data;
  }
  throw new Error('evidence: pause_turn 4회 초과');
}

// ── 한 추상 segment에 대한 근거 후보 수집 + 환각 게이트 + 구조화 파싱 ──
async function suggestEvidenceForSegment(segText, { lang = 'ko', signal, maxUses = 5 } = {}) {
  const topic = (segText.match(/[가-힣]{2,}|[A-Za-z]{3,}/g) || []).slice(0, 30).join(' ');
  const system = lang === 'en'
    ? `You are a research assistant. The student wrote an abstract, general paragraph with no concrete evidence. Use web_search to find REAL, verifiable public facts (statistics, years, named institutions, laws, real cases) that could support the paragraph's claims. Only report facts you actually found via search, each with its source URL. Do NOT invent facts or sources. Output a JSON array.`
    : `너는 리서치 보조자다. 학생이 구체 근거가 없는 추상적·일반론적 문단을 썼다. web_search로 그 문단의 주장을 뒷받침할 수 있는 **실재하는 검증가능한 공개 사실**(통계·연도·기관명·법령·실제 사례)을 찾아라.
★ 규칙:
· 반드시 web_search로 *실제 검색해서 찾은* 사실만 보고하라. 검색하지 않은 사실, 기억에 의존한 추정, 지어낸 수치·출처는 절대 금지.
· 각 사실에 반드시 출처 URL(검색 결과에 실제로 등장한 것)을 붙여라.
· 문단의 *주장 방향을 바꾸지 말고* 뒷받침만 하라.
· 한국 맥락(정부·언론·학술 출처 우선)에 맞는 사실을 찾아라.
· 3~6개. 문단과 직접 관련된 것만.
★ 마지막에 JSON 배열만 출력하라(설명·머리말 금지):
[{"fact":"한 문장으로 요약한 사실(수치·연도·기관 포함)","sourceUrl":"출처 URL","sourceTitle":"출처 제목","relevance":"이 문단의 어느 주장을 뒷받침하는지"}]`;
  const user = lang === 'en'
    ? `[Abstract paragraph]\n${segText}\n\n[Topic keywords]\n${topic}\n\nFind real supporting facts via web_search, then output the JSON array.`
    : `[추상 문단]\n${segText}\n\n[주제어]\n${topic}\n\nweb_search로 실재 근거를 찾고, JSON 배열을 출력하라.`;

  const data = await llmWebSearch({ system, user, signal, maxUses });
  const resultUrls = collectResultUrls(data.content);
  const parsed = parseJSON(joinText(data.content)) || [];

  // 환각 게이트: 모델이 인용한 출처가 *실제 검색결과* URL 집합에 있어야 채택.
  const out = [];
  for (const c of parsed) {
    if (!c || typeof c.fact !== 'string' || typeof c.sourceUrl !== 'string') continue;
    const url = normalizeUrl(c.sourceUrl);
    // 정확 일치 또는 도메인/경로 prefix 일치(검색결과가 더 긴 URL일 수 있음).
    const grounded = resultUrls.has(url) || [...resultUrls].some(r => r.startsWith(url) || url.startsWith(r));
    if (!grounded) continue;                                   // 출처 환각 → 폐기
    out.push({
      fact: c.fact.trim(),
      sourceUrl: c.sourceUrl.trim(),
      sourceTitle: (c.sourceTitle || '').trim(),
      relevance: (c.relevance || '').trim(),
      grounded: true
    });
  }
  return { candidates: out, searchedUrlCount: resultUrls.size, rawCount: parsed.length };
}

// ── 전체: 추상 segment 상위 N개에 대해 후보 수집 ──
async function suggestEvidence(rawText, { lang = 'ko', signal, maxSegments, targetChars = 350 } = {}) {
  const anchorPool = sg.buildSourceAnchorPool(rawText);
  const segs = sg.buildSegments(rawText, targetChars);
  // 가장 추상적인(generic) segment부터 — L3가 비어 카피킬러에 찍히는 곳.
  const ranked = segs
    .map((s, i) => ({ i, text: s, gen: sg.measureSegmentRisk(s, anchorPool).genericRatio }))
    .filter(x => sg.measureSegmentRisk(x.text, anchorPool).suspect)   // 구체 0인 의심 segment만
    .sort((a, b) => b.gen - a.gen);
  const MAX = Number(maxSegments) || Number(process.env.EVIDENCE_MAX_SEGMENTS) || 12;
  const pick = ranked.slice(0, MAX);

  const concurrency = process.env.LLM_BACKEND === 'claudecode' ? 1 : 4;  // 검색은 비싸므로 보수적
  const results = new Array(pick.length);
  let next = 0;
  const worker = async () => {
    while (next < pick.length) {
      const k = next++;
      try {
        const r = await suggestEvidenceForSegment(pick[k].text, { lang, signal });
        results[k] = { segmentIndex: pick[k].i, segmentHead: pick[k].text.replace(/\s+/g, ' ').slice(0, 60), ...r };
      } catch (e) {
        if (signal?.aborted) throw e;
        results[k] = { segmentIndex: pick[k].i, error: e.message, candidates: [] };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pick.length) }, worker));

  const candidates = results.filter(Boolean).flatMap(r =>
    (r.candidates || []).map(c => ({ ...c, segmentIndex: r.segmentIndex, segmentHead: r.segmentHead })));
  return {
    candidates,                                    // 학생 승인 UI로 그대로 전달
    segmentsSearched: pick.length,
    totalAbstractSegments: ranked.length,
    perSegment: results.filter(Boolean)
  };
}

module.exports = { suggestEvidence, suggestEvidenceForSegment, llmWebSearch, collectResultUrls, normalizeUrl };
