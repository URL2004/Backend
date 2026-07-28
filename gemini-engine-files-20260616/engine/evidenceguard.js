// [engine/evidenceguard.js] 승인 사실(evidence) 무결성 결정론 가드 — genretransfer에서 이식(2026-06-11)
// ────────────────────────────────────────────────────────────────
// ★ 범용 교훈(§메모리): 외부 evidence를 쓰는 모든 경로에는 "수치-출처 짝" 독립 가드가 필수다.
//   novelty는 토큰만 보므로 "666명 중 45.9%"(두 조사 융합)·"-0.68 → 향상폭 0.68"(부호 탈락) 같은
//   *의미 재조합 날조*를 통과시키고, semanticJudge는 확률적이라 가끔 놓친다(각 1회 실측).
//   여기 가드들은 전부 결정론·무비용 — 메인 엔진(analyze.js)과 genretransfer가 공용.

const sg = require('./surfaceguard');
const floor = require('./floor');

const PAIR_STOP = new Set(['조사에서', '연구에서', '대상으로', '분석한', '결과', '대학생', '학생', '사용', '활용', '이상', '기준', '응답했다', '답했다', '나타났다']);

// 수치 토큰 추출(단위 인지, routine v2 오탐 2건으로 정밀화): 2자리 맨정수는 단위까지 키에 포함해
// "30분"(원문 수사)과 "30%"(evidence 수치)의 숫자-만 충돌을 차단. 3자리+·소수·콤마 수치는 그 자체로
// 변별력이 있어 숫자만으로 매칭(단위 조사(로/을) 변형에 따른 recall 손실 방지).
function _numToks(str) {
  return [...new Set((str.match(/-?\d[\d,.]*(?:%|[가-힣])?/g) || []).map(t => {
    const m = t.match(/^(-?[\d,.]+)(%|[가-힣])?$/);
    if (!m) return null;
    const digits = m[1].replace(/[.,]+$/, '');
    if (digits.replace(/[^0-9]/g, '').length < 2) return null;
    const short = digits.replace(/[^0-9]/g, '').length === 2 && !/[.,]/.test(digits);
    return digits + (short ? '|' + (m[2] || '') : '');
  }).filter(Boolean))];
}

// 기관 앵커 분류(ai-study 출처 스왑 실측): "45.9%(한국직업능력연구원 조사다)" — 소유 줄은 오픈서베이.
// 내용 단어 앵커("사고력")가 창에 있어 통과 → 기관이 있는 사실은 기관 앵커 일치를 요구해야 출처 스왑을 막는다.
const ORG_RE = /^([가-힣]+(연구원|연구소|연구팀|학회|센터|협의회|신문|일보|대학교?|교육부|보)|[A-Z][A-Za-z]{2,}|[A-Z]{2,}[a-z]*|.*서베이.*|네이처|앤트로픽)$/;
const ORG_STOP = new Set(['GPT', 'SNS', 'ESG', 'PDF', 'URL', 'HTML', 'IRA']);   // 기관 아닌 약어(경쟁 기관 오인 방지)

function evidenceAnchorMap(evidenceList) {
  return evidenceList.map(line => {
    const nums = _numToks(line);
    const anchors = [...new Set((line.match(/[가-힣]{3,}|[A-Za-z]{3,}/g) || []))].filter(w => !PAIR_STOP.has(w)).slice(0, 10);
    const orgAnchors = anchors.filter(a => ORG_RE.test(a));
    return { line, nums, anchors, orgAnchors };
  });
}

// ★ 수치-출처 짝 검증: evidence 수치가 등장하는 문장(±직전 2문장, 헤드라인은 전방 2문장도)에 그 수치가
//   속한 evidence 줄의 핵심 표지(기관·키워드)가 하나는 있어야 한다. 없으면 = 수치가 출처에서 분리돼
//   떠돈 것 = 재조합 위험. "창에 경쟁 기관명이 있는데 소유 기관이 없는" 스왑 시그니처도 위반.
function checkEvidencePairing(text, evidenceList) {
  const map = evidenceAnchorMap(evidenceList);
  const sents = sg.splitSentences(text);
  const bad = [];
  const isBareYear = (t) => /^(19|20)\d{2}$/.test(t.split('|')[0]);   // 연도는 일반 시점 표현으로 합법 사용 多 → 짝 검증 제외(오탐원)
  sents.forEach((s, i) => {
    // 창 ±직전 2문장(routine v2 오탐: 인용 직후의 정당한 후속 코멘트 "254일이면 거의 일 년"이 1문장 창 밖).
    // 제목·부제(첫 2문장)는 앞으로 2문장도 본다 — 수치 헤드라인은 출처를 리드에서 밝히는 게 정상 패턴(ai-study 실측 오탐).
    const fwd = i < 2 ? ' ' + sents.slice(i + 1, i + 3).join(' ') : '';
    const window = sents.slice(Math.max(0, i - 2), i).join(' ') + ' ' + s + fwd;
    const nums = _numToks(s).filter(t => !isBareYear(t));
    // 창에 등장하는 기관 토큰(경쟁 귀속 후보) — GPT 등 기관 아닌 약어는 제외
    const winOrgs = [...new Set((window.match(/[가-힣]{3,}|[A-Za-z]{3,}/g) || []))]
      .filter(w => ORG_RE.test(w) && !PAIR_STOP.has(w) && !ORG_STOP.has(w));
    for (const n of nums) {
      const owners = map.filter(m => m.nums.includes(n) || m.nums.includes('-' + n));
      if (!owners.length) continue;                                   // evidence 소속 수치만 검사
      // 일반 앵커 일치가 기본. 단 "창에 경쟁 기관명이 있는데 소유 기관이 없는" 스왑 시그니처는 위반
      // (일반화 패러프레이즈 "KCI 등재 연구→국내 연구"는 경쟁 기관이 없으므로 통과 — v6 오탐 실측 반영).
      const ok = owners.some(o => {
        if (!o.anchors.some(a => window.includes(a))) return false;
        if (!o.orgAnchors.length) return true;
        const ownerOrgPresent = o.orgAnchors.some(a => window.includes(a));
        const competing = winOrgs.some(w => !o.orgAnchors.some(a => a.includes(w) || w.includes(a)));
        return ownerOrgPresent || !competing;
      });
      if (!ok) bad.push({ num: n.split('|')[0], sent: s.replace(/\s+/g, ' ').slice(0, 90), owner: owners[0].line.slice(0, 60) });
    }
  });
  return bad;
}

// 사실 재인용 제거(ai-study 63% PDF 실측): 같은 evidence 수치가 문서에서 2~4회 재인용(13주×4·12대원칙×3…).
// '기계적 정확성·균일성' 피탐의 직접 원인이자 품질 결함(같은 연구를 두 번 처음처럼 인용).
// 규칙: 각 evidence 수치의 첫 인용 문장만 유지, 이후 문장은 그 문장의 모든 evidence 수치가 재인용일 때만 제거.
// lostFacts 비악화 가드 내장(악화 시 원문 유지) = FLOOR-safe.
function dedupeFactRecitations(doc, evidenceList, textF) {
  const evNums = new Set();
  for (const line of evidenceList) for (const t of _numToks(line)) evNums.add(t);
  const isBareYear = (t) => /^(19|20)\d{2}$/.test(t.split('|')[0]);
  const paras = doc.split(/\n{2,}/).map(p => p.split(/(?<=[.!?”"])\s+/));
  const seen = new Set();
  const out = [];
  for (const sents of paras) {
    const kept = [];
    for (const s of sents) {
      const nums = _numToks(s).filter(t => evNums.has(t) && !isBareYear(t));
      if (nums.length && nums.every(n => seen.has(n))) continue;     // 전부 재인용 → 문장 제거
      nums.forEach(n => seen.add(n));
      kept.push(s);
    }
    if (kept.join('').replace(/\s+/g, '').length > 0) out.push(kept.join(' '));
  }
  const cand = out.join('\n\n');
  return floor.measureLostFacts(textF, cand).count <= floor.measureLostFacts(textF, doc).count ? cand : doc;
}

// ★ 짝 위반 결정론 최후 수단(2026-06-12 실사고: 잔여 위반 1건이 30분 재구성 전체 차단):
//   LLM 교정이 못 박은 위반 문장의 수치 바로 뒤에 소속 출처 표지를 괄호로 삽입 — 승인 사실의 출처를
//   명시하는 것이므로 무날조이고, 짝 정의(±2문장 내 소유 앵커)상 위반이 결정론적으로 해소된다.
function _escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function injectOwnerMarkers(doc, violations, evidenceList) {
  const map = evidenceAnchorMap(evidenceList);
  const normKey = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 24);
  let out = doc;
  for (const bad of violations) {
    const owner = map.find(m => m.nums.some(n => n.split('|')[0] === bad.num || n.split('|')[0] === '-' + bad.num));
    const tag = owner && (owner.orgAnchors[0] || owner.anchors[0]);
    if (!tag) continue;
    const paras = out.split(/\n{2,}/);
    let done = false;
    for (let pi = 0; pi < paras.length && !done; pi++) {
      const sents = paras[pi].split(/(?<=[.!?”"])\s+/);
      for (let si = 0; si < sents.length; si++) {
        if (!normKey(sents[si]).includes(normKey(bad.sent))) continue;
        if (sents[si].includes(`(${tag}`)) { done = true; break; }   // 이미 삽입됨
        const re = new RegExp(_escRe(bad.num) + '(?:[%가-힣])?');     // 수치(+단위 1글자)
        const m = sents[si].match(re);
        if (!m) break;
        sents[si] = sents[si].replace(re, m[0] + `(${tag} 기준)`);
        paras[pi] = sents.join(' ');
        out = paras.join('\n\n');
        done = true;
        break;
      }
    }
  }
  return out;
}

module.exports = { _numToks, PAIR_STOP, ORG_RE, ORG_STOP, evidenceAnchorMap, checkEvidencePairing, dedupeFactRecitations, injectOwnerMarkers };
