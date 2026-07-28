// [engine/genreframes.js] badFrameGuard v2 — 연구보고서 프레임 + "AI 해설문" 프레임 감지 (사장님 v2 설계)
// ────────────────────────────────────────────────────────────────
// v1(genretransfer.detectBadFrame)은 명시적 연구보고서 흔적만 잡음 → 장르전환 v1 출력이 badFrame 0인데 94%.
// 사장님 진단: 그 출력은 "~란 무엇인가/도움이 되는 순간/위험한 지점/해야 할 일" 식 AI 해설문 템플릿으로 갈아탄 것.
// v2 = 연구보고서 + 해설문 템플릿 + 정형 문장틀을 전부 카운트 → genreRiskScore로 출고/후보선택 게이트.

const sg = require('./surfaceguard');

const RESEARCH_FRAMES = [
  /[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]\s*\.\s*(서론|이론적\s*배경|결론|논의|제언)/g,
  /연구의\s*필요성/g, /이론적\s*배경/g, /본\s*연구[는의]/g, /연구\s*문제/g, /연구\s*방법/g, /연구\s*목적/g,
  /가상\s*설문/g, /문헌\s*연구/g, /(분석|고찰)하고자\s*한다/g,
  /첫째[,.][\s\S]{0,400}둘째[,.][\s\S]{0,400}셋째[,.]/g,
  /에\s*미치는\s*영향\s*(연구|보고서)/g,
];

// AI 해설문 소제목/문장 템플릿(이번 94% 출력의 실제 문제 계열)
const EXPLAINER_HEADINGS = [
  /^.{0,24}[이란은는]\s*무엇인가\??$/m, /^.{0,20}의\s*(의미|개념|필요성)$/m,
  /^.{0,20}(도움이\s*되나|해가\s*되나|득인가\s*실인가).{0,10}$/m,
  /^.{0,24}(도움이|도움)\s*되는\s*(순간|지점|이유).{0,8}$/m,
  /^.{0,24}위험(한|은)?\s*(지점|순간|이유).{0,8}$/m,
  /^.{0,24}해야\s*할\s*일.{0,4}$/m,
  /^.{0,24}(대학|정부|기관|학교|사회)의\s*대응.{0,8}$/m,
];
const EXPLAINER_SENTENCES = [
  /결국\s*[^.!?]{0,40}에\s*달려\s*있다/g,
  /이\s*(구조|과정|지점)에서\s*가장\s*중요한/g,
  /이\s*(사실|결과|수치|점)[은는]\s*[^.!?]{0,40}보여준다/g,
  /같은\s*맥락을\s*가리킨다/g,
  /[^.!?]{0,20}(이|가)\s*무엇인지\s*(부터)?\s*짚/g,
  /두\s*(얼굴|측면)[을을]?\s*가지/g,
  /도움이\s*될\s*수도,?\s*해가\s*될\s*수도/g,
  /[^.!?]{0,40}(라고\s*할\s*수\s*있다|로\s*볼\s*수\s*있다|로\s*해석된다|로\s*나타났다)/g,
];
const INDIRECT_SPEECH = [
  /에\s*따르면/g, /에\s*의하면/g, /라고\s*(답했|밝혔|설명했|말했)/g,
  /조사\s*결과/g, /발표(?:에|했|한)\s*따르면/g, /로\s*나타났다/g,
];
const ABSTRACT_SUBJECT = [
  /(이|그)\s*(구조|과정|결과|사실|수치|점|맥락|흐름|문제|특징|차이|현상)[은는이가]/g,
  /(핵심|본질|의미|가치|필요성|중요성)[은는이가]/g,
];
// 정형 문장틀(약신호 — 사람 글에도 가끔 있어 카운트만, 하드밴 아님)
const FORMULAIC_SOFT = [
  /문제는\s*[^.!?]{0,25}이다/g, /핵심은\s*[^.!?]{0,25}이다/g,
  /물론\s*[^.!?]{0,40}(아니다|않는다)/g,
];

function countAll(text, regexes) {
  const hits = [];
  for (const re of regexes) {
    const m = (text || '').match(re);
    if (m) hits.push(...m.map(x => x.replace(/\s+/g, ' ').trim().slice(0, 40)));
  }
  return hits;
}

function measureGenreFrames(text) {
  const research = countAll(text, RESEARCH_FRAMES);
  const explainerHeadings = countAll(text, EXPLAINER_HEADINGS);
  const explainerSentences = countAll(text, EXPLAINER_SENTENCES);
  const formulaicSoft = countAll(text, FORMULAIC_SOFT);
  const indirectSpeech = countAll(text, INDIRECT_SPEECH);
  const abstractSubject = countAll(text, ABSTRACT_SUBJECT);
  return { research, explainerHeadings, explainerSentences, formulaicSoft, indirectSpeech, abstractSubject };
}

// 근거 덤프: 전체 숫자 토큰이 한 문단에 과밀(>40%)하면 "근거 나열" 신호
function evidenceDumpPenalty(text) {
  const paras = (text || '').split(/\n{2,}/).map(p => p.trim()).filter(p => p.replace(/\s+/g, '').length > 40);
  const counts = paras.map(p => (p.match(/\d[\d,.]*/g) || []).length);
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total || paras.length < 3) return 0;
  return Math.max(...counts) / total > 0.4 ? 1 : 0;
}

// 문단 시작 다양성(사람 편집물은 문단 도입이 제각각)
function openerDiversity(text) {
  const paras = (text || '').split(/\n{2,}/).map(p => p.trim()).filter(p => p.replace(/\s+/g, '').length > 40);
  if (paras.length < 3) return 1;
  const openers = paras.map(p => (p.split(/\s+/)[0] || '').replace(/[^가-힣A-Za-z]/g, '').slice(0, 3));
  return new Set(openers).size / paras.length;
}

// 종합 genreRiskScore(후보 비교·출고 게이트) — 낮을수록 사람 문서에 가까움
function genreRiskScore(text) {
  const f = measureGenreFrames(text);
  const paras = (text || '').split(/\n{2,}/).map(p => p.trim()).filter(p => p.replace(/\s+/g, '').length > 40);
  const lens = paras.map(p => p.replace(/\s+/g, '').length);
  const mean = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const cv = lens.length > 1 ? Math.sqrt(lens.map(l => (l - mean) ** 2).reduce((a, b) => a + b, 0) / lens.length) / (mean || 1) : 0;
  const formulaEnd = paras.length ? paras.filter(p => /(필요하다|중요하다|해야\s*한다|것이다|셈이다)\s*\.?$/.test(p)).length / paras.length : 0;
  const impersonal = sg.measureImpersonal(text);

  const score =
    3.0 * f.research.length +
    2.5 * f.explainerHeadings.length +
    2.5 * f.explainerSentences.length +
    2.0 * Math.max(0, f.indirectSpeech.length - 2) +
    1.8 * Math.max(0, f.abstractSubject.length - 2) +
    0.4 * Math.max(0, f.formulaicSoft.length - 2) +     // 소프트 틀은 2개까지 무벌점
    1.5 * evidenceDumpPenalty(text) +
    1.2 * Math.max(0, (0.45 - cv)) * 10 +               // 문단 균일(저CV) 벌점
    1.2 * Math.max(0, formulaEnd - 0.25) * 10 +         // 교훈 마무리 과다 벌점
    0.8 * impersonal * 5 +
    1.0 * Math.max(0, (0.6 - openerDiversity(text))) * 10;
  return {
    score: Number(score.toFixed(2)),
    detail: {
      research: f.research, explainerHeadings: f.explainerHeadings, explainerSentences: f.explainerSentences,
      indirectSpeech: f.indirectSpeech.length, abstractSubject: f.abstractSubject.length,
      formulaicSoft: f.formulaicSoft.length, evidenceDump: evidenceDumpPenalty(text),
      paragraphLenCV: Number(cv.toFixed(2)), formulaEndingRatio: Number(formulaEnd.toFixed(2)),
      impersonal: Number(impersonal.toFixed(2)), openerDiversity: Number(openerDiversity(text).toFixed(2)),
    },
  };
}

module.exports = { measureGenreFrames, genreRiskScore, evidenceDumpPenalty, openerDiversity };
