// [engine/registerscore.js] 격식 모드 register 위험 점수(결정론·무료) — 카피킬러 화자거리감 신호 surrogate
// ────────────────────────────────────────────────────────────────
// 동기(2026-06): EV 격식 4회 단발 실측(73/83/92/94%)이 모두 별개 humanize 생성이라 생성 노이즈가 큼 →
//   카피킬러 단발에 이론 쌓기 위험. 4개 PDF 전반 일관 신호=화자 거리감(비인칭·간접화법·주관성배제·구조전형성).
// 목적: 카피킬러 없이 "이 글이 얼마나 비인칭·정형적인가"를 결정론으로 측정 → register 교정이 의도대로(더 인칭적·덜 정형)
//   움직이는지 무료로 수십 번 검증. 절대값이 카피킬러 %와 일치할 필요는 없고, register 방향에 단조이면 된다.
// 가중치(사장님 제안): 0.30 비인칭 + 0.25 정형흐름 + 0.20 균일성 + 0.15 주관성배제 + 0.10 추상 + 소액 페널티(punch/번호/띄어쓰기).

const sg = require('./surfaceguard');
const cc = require('./columncleanup');

const clamp01 = x => Math.max(0, Math.min(1, x));

// 주관성/화자 현존 마커 — measureStance(좁음)가 놓치는 1인칭·구어·격식판단을 모두 포착.
//   ① 1인칭 ② 격식 판단(필자 보기에/문제는 A아니라 B/핵심은) ③ 구어 주관(거든/잖아/더라).
const SUBJ_FIRST = /(나는|내가|나도|나의|우리는|우리가|저는|제가|저도|필자)/;
const SUBJ_JUDGMENT = /(라고\s*본다|라고\s*생각|보기에|주목할|주목한다|핵심은|중요한\s*(건|것은|점은)|문제는|더\s*중요한|놓치(지|면)\s*안|간과(해선|하면)|의심해야|싶다|싶었|분명하다|틀림없)/;
const SUBJ_CASUAL = /(거든요?|잖아요?|더라(고|구)?(?=$|[^가-힣A-Za-z0-9_])|네요|던데|싶더|는데\s*말)/;
function measureSubjectivity(text) {
  const s = sg.splitSentences(text);
  if (!s.length) return 0;
  let n = 0;
  for (const x of s) { const t = x.trim(); if (SUBJ_FIRST.test(t) || SUBJ_JUDGMENT.test(t) || SUBJ_CASUAL.test(t)) n++; }
  return n / s.length;
}

// 문단 마지막 문장의 종결(마지막 한글 3자) 반복도 — "~신호다/~것이다/~다" 정형 마무리 반복
function closerRepetition(text) {
  const paras = (text || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const closers = paras.map(p => {
    const s = sg.splitSentences(p); if (!s.length) return '';
    const last = s[s.length - 1].replace(/[^가-힣]/g, '');
    return last.slice(-3);
  }).filter(Boolean);
  if (closers.length < 3) return 0;
  const uniq = new Set(closers).size;
  return clamp01(1 - uniq / closers.length);   // 높을수록 정형 마무리 반복
}

// 비인칭 단정 마무리(셈이다/것이다/뿐이다/된다…)로 닫는 문단 비율 — 정형 흐름 보강 신호
const CLOSER_IMPERSONAL = /(된다|것이다|셈이다|뿐이다|마련이다|법이다|신호다|때문이다|있다|없다)\.?$/;
function impersonalCloserRatio(text) {
  const paras = (text || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  if (!paras.length) return 0;
  let n = 0;
  for (const p of paras) { const s = sg.splitSentences(p); if (s.length && CLOSER_IMPERSONAL.test(s[s.length - 1].trim())) n++; }
  return n / paras.length;
}

// ★ 구체성 등급(사장님 L0~L4): 카피킬러 "구체적 근거 부족"은 명사 유무가 아니라 *검증가능 구체*(L3) 유무가 가른다.
//   L3(검증가능): 수치·연도·%·단위, 라틴 약어(BYD/WHO/ESS), 고유명사+제도(법/조례/조사/지수/청/부/협약), 지역명(시/구/동).
//   L1(장식 구체): 골목·벤치·놀이터·정류장·공원 등 일반 장면명사(특정성 없음) — 많아도 카피킬러는 '구체 부족'으로 봄.
//   ※ 대문자 약어는 둘로 갈린다: buzzword(AI·ESG·SNS·IT…)는 검증가능 구체가 아니다(주제어일 뿐).
//   실제 고유 약어(WHO·OECD·BYD·SNE…)만 L3. surfaceguard.SEG_ACRONYM과 동일 stoplist로 일관.
const L3_RE = /(\d|[％%]|(?:19|20)\d{2}|[가-힣]\s*(?:만|억|조|명|건|배|차례|위)(?=$|[^가-힣A-Za-z0-9_])|[가-힣]{2,}(?:법|조례|협약|조사|지수|청|부처|위원회)|[가-힣]{2,}(?:시|구|동|군|읍|면|도)(?=$|[^가-힣A-Za-z0-9_])/;
const BUZZWORD_ACR = new Set(['AI', 'ESG', 'SNS', 'IT', 'MVP', 'CEO', 'KPI', 'ROI', 'DX']);
const DECOR_RE = /(골목|벤치|놀이터|정류장|공원|거리|보도|횡단보도|가게|카페|시장|상가|광장|화단|가로등|간판|놀이|산책로|벽|담장)/;
function hasL3(t) {
  if (L3_RE.test(t)) return true;
  const acrs = t.match(/[A-Z]{2,}/g) || [];           // 대문자 약어는 buzzword 제외 후에만 L3
  return acrs.some(a => !BUZZWORD_ACR.has(a));
}
function measureConcreteness(text) {
  const s = sg.splitSentences(text);
  if (!s.length) return { verifiableRatio: 0, decorativeRatio: 0, n: 0 };
  let verifiable = 0, decorative = 0;
  for (const x of s) {
    const t = x.trim();
    if (hasL3(t)) verifiable++;
    else if (DECOR_RE.test(t)) decorative++;   // 장식 명사만 있고 L3 없음 = 장식적 구체
  }
  return { verifiableRatio: Number((verifiable / s.length).toFixed(3)), decorativeRatio: Number((decorative / s.length).toFixed(3)), n: s.length };
}

// ★ B7 학부생 보고서형 점수(7요소) — 생성이 흔들리지 않게 서버가 강제 측정. prompts.js DETECT의 B7 시그니처와 정렬.
const B7_HEDGE = [/(인\s*것\s*같습니다|것\s*같습니다)/, /(지도\s*모릅니다|지\s*모르겠)/, /(않을까요|을까요\s*\?|ㄹ까요\s*\?)/, /(기도\s*합니다)/, /(로\s*보입니다|것으로\s*보입니다)/, /(라고\s*생각합니다)/];
const B7_AUTHOR = /(저는|제\s*생각|저로서는|제가\s*보기|제가\s*더|제가\s*가장)/;
function measureB7Formal(text) {
  const s = sg.splitSentences(text);
  if (!s.length) return { score: 0, feats: {}, n: 0 };
  let hap = 0, plain = 0;
  s.forEach(x => { const r = sg.sentRegister(x); if (r === 'hap') hap++; else if (r === 'handa') plain++; });
  const politeRegister = (hap / s.length) >= 0.6 && (plain / s.length) <= 0.15;
  const hedgeCounts = B7_HEDGE.map(p => s.filter(x => p.test(x)).length);
  const hedgeTypes = hedgeCounts.filter(c => c > 0).length;
  const maxHedge = Math.max(0, ...hedgeCounts);
  const hedgeDiversity = hedgeTypes >= 2 && maxHedge < 3;
  const authorAnchorCount = s.filter(x => B7_AUTHOR.test(x)).length;
  const authorAnchor = authorAnchorCount >= 2 && authorAnchorCount <= 6;
  const commaDiscipline = (s.filter(x => ((x.match(/,/g) || []).length) >= 2).length / s.length) <= 0.15;
  const longRatio = s.filter(x => x.replace(/\s+/g, '').length >= 60).length / s.length;
  const longOK = longRatio <= 0.20;
  const passiveRatio = sg.measureImpersonal(text);
  const passiveOK = passiveRatio <= 0.25;
  const last = (s[s.length - 1] || '').trim();
  const finalHedged = /(\?|것\s*같|보입니다|모릅니다|않을까|아닐까|남습니다|생각합니다|봅니다)/.test(last);
  const feats = { politeRegister, hedgeDiversity, authorAnchor, commaDiscipline, longOK, passiveOK, finalHedged };
  const score = Object.values(feats).filter(Boolean).length;
  return { score, feats, authorAnchorCount, longRatio: Number(longRatio.toFixed(2)), passiveRatio: Number(passiveRatio.toFixed(2)), politeShare: Number((hap / s.length).toFixed(2)), n: s.length };
}

function spacingErrorCount(text) {
  // 흔한 붙임 오류: 의존명사 '수' 붙음, '~만대/~만명' 붙음, 조사+동사 붙음 일부
  const pats = [/[가-힣](할|볼|낼|줄|들|버틸|쓸|살)수(가|는|도|를|\s|[.,])/g, /\d만(대|명|개|원)/g, /기꺼이끌어/g, /도가만히/g, /생활속/g];
  let c = 0; for (const re of pats) c += (text.match(re) || []).length; return c;
}

// 종합 register 위험(0~1, 높을수록 AI 비인칭·정형). components로 어떤 신호가 큰지 노출.
function registerScore(text) {
  const impersonal = sg.measureImpersonal(text);                       // 0~1 (비인칭 종결)
  const subjectivity = measureSubjectivity(text);                      // 0~ (1인칭+격식판단+구어 주관)
  const subjAbsence = clamp01(1 - subjectivity / 0.25);               // 주관성 배제(높을수록 배제)
  const uni = sg.measureUniformity(text);
  const lenRisk = clamp01((0.65 - uni.lengthCV) / 0.65);              // 길이 균일(낮은 CV)
  const endRisk = clamp01((uni.maxEndingRun - 3) / 6);               // 같은 종결 연속
  const uniformity = 0.6 * lenRisk + 0.4 * endRisk;
  const paraComp = sg.measureParagraphCompression(text);              // 문단 요약·압축 과밀
  const templatedFlow = clamp01(0.5 * paraComp + 0.5 * (0.5 * closerRepetition(text) + 0.5 * impersonalCloserRatio(text)));
  const abstraction = sg.classifyInputRisk(text).abstractRiskRatio;   // 0~1 추상문단 비율

  const punch = cc.measurePunch(text);
  const ordinals = cc.countOrdinals(text);
  const spacing = spacingErrorCount(text);
  const penalty = Math.min(0.05, Math.max(0, (punch - 10)) * 0.004) + Math.min(0.04, ordinals * 0.01) + Math.min(0.04, spacing * 0.005);

  const risk = 0.30 * impersonal + 0.25 * templatedFlow + 0.20 * uniformity + 0.15 * subjAbsence + 0.10 * abstraction + penalty;
  return {
    risk: Number(risk.toFixed(3)),
    components: {
      impersonal: Number(impersonal.toFixed(3)),
      templatedFlow: Number(templatedFlow.toFixed(3)),
      uniformity: Number(uniformity.toFixed(3)),
      subjectivityAbsence: Number(subjAbsence.toFixed(3)),
      abstraction: Number(abstraction.toFixed(3)),
      subjectivity: Number(subjectivity.toFixed(3)),
      penalty: Number(penalty.toFixed(3)),
      punch, ordinals, spacing,
    },
  };
}

module.exports = { registerScore, measureSubjectivity, measureConcreteness, measureB7Formal, closerRepetition, impersonalCloserRatio, spacingErrorCount };
