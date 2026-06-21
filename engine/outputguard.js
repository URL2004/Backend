// [engine/outputguard.js] 출고 품질 gate — 결정론(무LLM·무과금). 2026-06-16 품질리포트 P0.
// ────────────────────────────────────────────────────────────────
// 측정기(formalbudget·surfaceguard)는 있는데 출고 강제력이 없어, 격식·자소서 문서에 블로그식 punch가
// 끼거나("현실은 단순하지 않다"·"그게 핵심이다"), 영어에 편집 마커([which])가 남고, 일부는 거의 no-op.
// 여기서 출고 직전에 결정론으로 ① punch 단정 제거 ② 영어 artifact 제거 ③ register 이탈 측정 ④ no-op 측정.
//   - 제거는 '본문 내용 훼손 0'이 되도록 독립형(문장 전체가 사실상 punch)만 지운다.
//   - register/no-op은 '측정·표시'용(차단 아님) — 강도 추천·보존형 표시에 쓴다.

// ── ① punch 단정(독립형) ─────────────────────────────────────────
// 칼럼식 단정 punch — 격식/자소서/요청문에 끼면 톤이 깨진다. 문장 '전체'가 punch인 독립형만 제거(본문 보존).
const STANDALONE_PUNCH_RE = [
  /(그것이|그게|이것이|이게|이는|바로\s*그것이)\s*(핵심|문제|관건|요점)이다/,
  /바로\s*(이|그)\s*(지점|곳)이다|바로\s*여기다/,
  /(전혀|정말|근본적으로|결국)\s*다르다/,
  /(현실|문제|상황|세상|답|구조|이야기|해결책|세계)[은는이가]?\s*(결코\s*)?단순하지\s*않(다|았다)/,   // "현실은 단순하지 않다"(실측 #2)
  /(정책|판|구조|질서|세계|모든\s*것|관계|일상|판도)[이가]?\s*(뒤흔들렸|흔들렸|무너졌|뒤집혔|송두리째\s*바뀌)/,  // "정책이 뒤흔들렸다"(실측 #16)
  /(그것이|그게|이것이|이게|바로\s*그것이)\s*시작이다|(여기서|그래서)\s*모든\s*것이\s*달라진다/,
];
function isStandalonePunch(sent) {
  const s = (sent || '').trim();
  const hangul = (s.match(/[가-힣]/g) || []).length;
  if (!hangul || hangul > 24) return false;   // 짧은 단정만 — 긴 문장에 박힌 건 내용일 수 있어 건드리지 않음
  return STANDALONE_PUNCH_RE.some(re => re.test(s));
}

// 독립형 punch 문장을 예산 초과분만 제거(원문에 이미 있던 건 보존). strict=true(격식·자소서)면 예산 0, 아니면 1.
//   문단 구조(\n\n)는 유지. splitSentences는 surfaceguard 사용(엔진 공용 분해기).
function stripPunchTemplates(text, rawText = '', opts = {}) {
  const sg = require('./surfaceguard');
  const budget = opts.strict ? 0 : 1;
  const rawHas = (s) => { const n = (rawText || '').replace(/\s+/g, ''); return n.includes((s || '').replace(/\s+/g, '').slice(0, 18)); };
  let kept = 0;
  const removed = [];
  const paras = String(text || '').split(/\n{2,}/).map(p => {
    const sents = sg.splitSentences(p);
    const out = sents.filter(sent => {
      if (!isStandalonePunch(sent)) return true;
      if (rawHas(sent)) return true;          // 원문에 있던 표현은 보존
      if (kept < budget) { kept++; return true; }   // 예산 내 허용
      removed.push(sent.trim());
      return false;
    });
    return out.join(' ').trim();
  }).filter(Boolean);
  return { text: paras.join('\n\n'), removed };
}

// ── ② 영어 편집 마커 artifact ([which]·[entering]·[Reflecting] 등) ──
//   엔진 중간 마크업이 새어 영어 결과에 박힘(실측 #11). 대괄호+영단어만 제거([1] 인용번호는 숫자라 보존).
function stripEnglishArtifacts(text) {
  return String(text || '')
    .replace(/\[\s*[A-Za-z][A-Za-z'’\- ]{0,24}\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .trim();
}

// ── ③ register(말투) 감지 — 문장별 종결로 합니다체/해요체/한다체 분류. hap→haeyo→handa 순서로 검사 ──
function endRegister(sent) {
  let s = (sent || '').trim().replace(/["'”’)\]]+$/, '').replace(/[.!?…~]+$/, '').trim();
  if (!s) return 'other';
  if (/(니다|세요|십시오|십시요)$/.test(s)) return 'hap';   // 합니다/습니다/입니다/됩니다/갑니다 = 모두 '니다' 종결(자모 ㅂ니다는 합성음절 미매칭이라 '니다'로)
  if (/(어요|아요|에요|예요|이에요|거든요|더라고요|네요|군요|을게요|ㄹ게요|죠|지요|잖아요|는데요|는걸요|나요|까요|구요)$/.test(s)) return 'haeyo';
  if (/(다|냐|까|자|라|마|군|네|걸)$/.test(s)) return 'handa';   // 평어(한다체) — hap/haeyo가 먼저 걸러진 뒤의 '~다' 종결
  return 'other';
}
function detectRegister(text) {
  const sg = require('./surfaceguard');
  const counts = { hap: 0, haeyo: 0, handa: 0, other: 0 };
  for (const s of sg.splitSentences(String(text || ''))) counts[endRegister(s)]++;
  const total = counts.hap + counts.haeyo + counts.handa;
  let dominant = 'other';
  if (total) dominant = ['hap', 'haeyo', 'handa'].reduce((a, b) => counts[a] >= counts[b] ? a : b);
  return { ...counts, total, dominant };
}
// 입력 register를 기준으로, 출력에서 그 기준을 깨는 문장 수(소수 register). 차단 아님 — 측정·표시·수리 후보용.
function registerLeakCount(text, rawText) {
  const target = detectRegister(rawText).dominant;
  if (target === 'other') return 0;
  const sg = require('./surfaceguard');
  let leak = 0;
  for (const s of sg.splitSentences(String(text || ''))) {
    const r = endRegister(s);
    if (r !== 'other' && r !== target) leak++;
  }
  return leak;
}

// ── ④ no-op(약한 변환) — 입력↔출력 글자 bigram 자카드. 1에 가까우면 거의 그대로 ──
function _bigrams(s) { const t = String(s || '').replace(/\s+/g, ''); const set = new Set(); for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2)); return set; }
function noOpScore(input, output) {
  const A = _bigrams(input), B = _bigrams(output);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  const uni = A.size + B.size - inter;
  return uni ? Math.round((inter / uni) * 100) / 100 : 0;
}

// ── ⑤ register 이탈 교정 — 입력이 '합니다체'로 분명할 때, 출력의 소수 평어(한다체) '이탈' 문장만 합니다체로 ──
//   #13 실측: 합니다체 요청문에 "…다져야 한다" 한 문장이 평어로 튀어 톤 붕괴. 끝 종결만 안전 변환(못 바꾸면 그대로).
//   전체가 평어면 의도된 한다체일 수 있어 건드리지 않는다(오변환 방지) — '소수 이탈'만 손본다.
function _handaToHap(sent) {
  const m = String(sent || '').match(/^([\s\S]*?)([가-힣]+다)([.!?…"”’)\]]*)$/);
  if (!m) return null;
  const head = m[1], end = m[2], punct = m[3];
  if (end.endsWith('한다')) return head + end.slice(0, -2) + '합니다' + punct;
  if (end.endsWith('된다')) return head + end.slice(0, -2) + '됩니다' + punct;
  if (end.endsWith('아니다')) return head + end.slice(0, -3) + '아닙니다' + punct;
  if (end.endsWith('이다')) return head + end.slice(0, -2) + '입니다' + punct;
  if (end.endsWith('있다')) return head + end.slice(0, -2) + '있습니다' + punct;
  if (end.endsWith('없다')) return head + end.slice(0, -2) + '없습니다' + punct;
  if (/(았|었|였)다$/.test(end)) return head + end.slice(0, -1) + '습니다' + punct;
  return null;   // 안전 변환 불가 → 그대로(형용사·불규칙 오변환 방지)
}
function normalizeRegisterLeaks(text, rawText) {
  const reg = detectRegister(rawText);
  if (reg.dominant !== 'hap' || reg.hap < 3) return { text, fixed: 0 };   // 입력이 합니다체로 충분히 분명할 때만
  const sg = require('./surfaceguard');
  const rawNorm = (rawText || '').replace(/\s+/g, '');
  let fixed = 0;
  const out = String(text || '').split(/\n{2,}/).map(p => {
    return sg.splitSentences(p).map(s => {
      if (endRegister(s) !== 'handa') return s;
      if (rawNorm.includes(s.replace(/\s+/g, '').slice(0, 16))) return s;   // 원문에 있던 평어 문장은 보존
      const conv = _handaToHap(s);
      if (conv) { fixed++; return conv; }
      return s;
    }).join(' ').trim();
  }).filter(Boolean).join('\n\n');
  return { text: out, fixed };
}

// ★ 편집자/조수 메타 헤딩 제거(2026-06-20 #62: blog가 휴머나이징 대신 "### [수정 간호계획안]" 같은
//   편집자 프레이밍 헤딩을 주입 = "고쳐주는 조수" 모드). 입력에 없던 '[수정/정리/개선/보완/교정/재구성/최종...]'
//   류 대괄호 편집 라벨로만 이뤄진 라인을 제거(원문에 있으면 보존, [참고문헌]·[참고자료]는 대상 아님).
//   결정론·무API. 헤딩 라인만 — 프로즈 속 표현은 오삭제 방지 위해 건드리지 않는다.
const EDIT_LABEL = /\[\s*(?:수정|정리|개선|보완|교정|재구성|최종)\s*(?:된|한)?\s*[^\]]{0,20}\]/;
function stripEditorialMeta(text, rawText = '') {
  const raw = String(rawText || '');
  let removed = 0;
  const lines = String(text || '').split('\n');
  const kept = lines.filter(line => {
    const bare = line.replace(/^[#>*\-\s]+/, '').trim();   // 마크다운 헤딩/리스트 마커 제거 후 검사
    const m = bare.match(EDIT_LABEL);
    // 라인이 '편집 라벨'만으로 구성(헤딩성)되고 그 라벨이 입력엔 없으면 = 모델 주입 → 제거
    if (m && bare.replace(EDIT_LABEL, '').trim().length === 0 && !raw.includes(m[0]) && !raw.includes(bare)) {
      removed++; return false;
    }
    return true;
  });
  const out = kept.join('\n').replace(/\n{3,}/g, '\n\n');
  return { text: out, removed };
}

module.exports = { stripPunchTemplates, stripEnglishArtifacts, detectRegister, registerLeakCount, normalizeRegisterLeaks, noOpScore, isStandalonePunch, stripEditorialMeta };
