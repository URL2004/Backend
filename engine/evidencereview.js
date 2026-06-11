// [engine/evidencereview.js] 회피모드 P4 — 근거 후보 결정론 검수(출처 신뢰 등급 + 수치 충돌 검출)
// ────────────────────────────────────────────────────────────────
// ai-study 2차 RAG에서 수동으로 했던 검수의 자동화(§gp-c-grade-neutral-stack):
//   "같은 HEPI 조사 88 vs 기존 90 수치 불일치, 간호 187 vs 182" — 검색 후보끼리의 수치 충돌 검수가
//   필수 단계임을 실측으로 확인. 사람이 한 일을 휴리스틱으로: 충돌은 차단이 아니라 ⚠️ 표시 + 기본 체크 해제
//   (판정자는 학생 — 승인 UI 원칙). 등급도 동일: A·B 기본 체크 / C 기본 해제.

const { _numToks, evidenceAnchorMap } = require('./evidenceguard');

// ── 출처 신뢰 등급(도메인 휴리스틱) ──
//   A = 공식(정부·대학·공공기관·학회·국제기구) + 주요 언론 / B = 실재 일반 매체·기업·단체 / C = 개인 블로그·위키·SNS·UGC(보류)
const GRADE_A_RE = /\.(go\.kr|ac\.kr|or\.kr|re\.kr|edu|gov|int)$|(^|\.)(yna|yonhapnews|chosun|joongang|donga|hani|khan|hankyung|hankookilbo|mk|kbs|mbc|sbs|ytn|news1|newsis|edaily|seoul|kyunghyang|nature|science|oecd|un|who|worldbank)\.(co\.kr|com|org|kr)$/;
const GRADE_C_RE = /(^|\.)(blog|tistory|brunch|cafe|post|velog|medium|youtube|youtu|wiki[a-z]*|namu|reddit|facebook|instagram|x|twitter|threads|dcinside|fmkorea|clien|ppomppu)\./;

function hostOf(url) {
  try { return new URL(/^https?:\/\//.test(url) ? url : 'https://' + url).hostname.toLowerCase(); }
  catch { return String(url || '').toLowerCase().replace(/^https?:\/\//, '').split('/')[0]; }
}
function gradeSource(url) {
  const host = hostOf(url);
  if (!host) return 'C';
  if (GRADE_C_RE.test(host)) return 'C';
  if (GRADE_A_RE.test(host) || /(^|\.)(news|ilbo)\./.test(host)) return 'A';
  return 'B';
}

// ── 수치 충돌 검출(후보 pairwise) ──
//   관련 판정: 기관 앵커 1개+ 공유 또는 내용 앵커 3개+ 공유(같은 조사·같은 주제를 말하는 두 줄).
//   충돌 판정: 같은 단위 계열의 서로 다른 수치가 상대차 30% 이내로 "비슷하지만 다름"(88 vs 90 류 —
//   완전 다른 수치는 다른 사실일 공산이 크고, 비슷한데 다른 게 같은 사실의 불일치 시그니처).
function _parseTok(t) {
  const [digits, unit] = String(t).split('|');
  const v = parseFloat(digits.replace(/,/g, ''));
  if (!isFinite(v)) return null;
  if (/^(19|20)\d{2}$/.test(digits)) return null;            // 연도 제외
  return { v, unit: unit || (String(t).includes('.') ? '' : '') };
}
function findConflicts(facts) {
  const map = evidenceAnchorMap(facts);
  const conflicts = [];                                       // [{a, b, detail}]
  for (let i = 0; i < map.length; i++) {
    for (let j = i + 1; j < map.length; j++) {
      const A = map[i], B = map[j];
      const sharedOrg = A.orgAnchors.some(o => B.orgAnchors.includes(o));
      const sharedAnchors = A.anchors.filter(a => B.anchors.includes(a)).length;
      if (!sharedOrg && sharedAnchors < 3) continue;          // 무관한 두 사실
      for (const ta of A.nums) {
        const pa = _parseTok(ta); if (!pa) continue;
        for (const tb of B.nums) {
          const pb = _parseTok(tb); if (!pb) continue;
          if (pa.unit !== pb.unit) continue;
          if (pa.v === pb.v) continue;
          const rel = Math.abs(pa.v - pb.v) / Math.max(Math.abs(pa.v), Math.abs(pb.v));
          if (rel <= 0.3) conflicts.push({ a: i, b: j, detail: `${ta.split('|')[0]} vs ${tb.split('|')[0]}` });
        }
      }
    }
  }
  return conflicts;
}

// ── 종합 검수: 후보 배열 → {grade, conflict, conflictDetail} 부여 ──
function reviewCandidates(candidates) {
  const facts = candidates.map(c => c.fact || '');
  const conflicts = findConflicts(facts);
  const conflictIdx = new Map();                              // idx → detail
  for (const c of conflicts) {
    if (!conflictIdx.has(c.a)) conflictIdx.set(c.a, c.detail);
    if (!conflictIdx.has(c.b)) conflictIdx.set(c.b, c.detail);
  }
  return candidates.map((c, i) => ({
    ...c,
    grade: gradeSource(c.sourceUrl),
    conflict: conflictIdx.has(i),
    conflictDetail: conflictIdx.get(i) || null
  }));
}

module.exports = { gradeSource, findConflicts, reviewCandidates, hostOf };
