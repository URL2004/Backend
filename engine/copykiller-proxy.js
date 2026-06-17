// [engine/copykiller-proxy.js] 카피킬러-risk 프록시 런타임 예측기(Node).
//   Python(sklearn TF-IDF char_wb + word, LogReg)으로 학습→export_proxy.py로 JSON화한 모델을 그대로 재현.
//   predict(text) → { 'tag:…': prob, 'severity:중간': prob, composite_risk }. detect-report 코칭/재랭커용.
//   ※ 모델 재학습 시 export_proxy.py 재실행 + _test-proxy-parity.js로 Python 일치 재검증할 것.
const fs = require('fs');
const path = require('path');

let M = null;
function model() {
  if (M === null) {
    const p = path.join(__dirname, 'copykiller_proxy_model.json');
    M = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : false;
  }
  return M;
}
function available() { return !!model(); }

// char_wb: 소문자→공백 분리→각 단어 " w " 패딩→char n-gram(2~5) 카운트 (sklearn 재현)
function charCounts(lowered, lo, hi) {
  const c = new Map();
  for (const w of lowered.split(/\s+/)) {
    if (!w) continue;
    const p = ' ' + w + ' ';
    for (let n = lo; n <= hi; n++) {
      for (let i = 0; i + n <= p.length; i++) {
        const g = p.slice(i, i + n);
        c.set(g, (c.get(g) || 0) + 1);
      }
    }
  }
  return c;
}
// word: token_pattern \b\w\w+\b (유니코드 2+ 워드문자)→ 1·2-gram 공백조인 카운트
const WORD_RE = /[\p{L}\p{N}_]{2,}/gu;
function wordCounts(lowered, lo, hi) {
  const toks = lowered.match(WORD_RE) || [];
  const c = new Map();
  for (let n = lo; n <= hi; n++) {
    for (let i = 0; i + n <= toks.length; i++) {
      const g = toks.slice(i, i + n).join(' ');
      c.set(g, (c.get(g) || 0) + 1);
    }
  }
  return c;
}
// tf-count Map → vocab idx별 tf*idf, L2 정규화한 sparse {idx: val}
function tfidf(counts, vec) {
  const raw = [];
  let ss = 0;
  for (const [term, cnt] of counts) {
    const idx = vec.vocab[term];
    if (idx === undefined) continue;
    const v = cnt * vec.idf[idx];
    raw.push([idx, v]);
    ss += v * v;
  }
  const norm = Math.sqrt(ss) || 1;
  const out = new Map();
  for (const [idx, v] of raw) out.set(idx, v / norm);
  return out;
}

function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

// 텍스트 → 모든 head 확률 + composite_risk
function predict(text) {
  const m = model();
  if (!m) return null;
  const cfg = m.config;
  const lowered = cfg.lowercase ? String(text || '').toLowerCase() : String(text || '');
  const charTf = tfidf(charCounts(lowered, cfg.char_ngram[0], cfg.char_ngram[1]), m.char);
  const wordTf = tfidf(wordCounts(lowered, cfg.word_ngram[0], cfg.word_ngram[1]), m.word);
  const cd = cfg.char_dim;
  const out = {};
  for (const name in m.heads) {
    const h = m.heads[name];
    let z = h.intercept;
    for (const [idx, v] of charTf) z += v * h.coef[idx];
    for (const [idx, v] of wordTf) z += v * h.coef[cd + idx];
    out[name] = sigmoid(z);
  }
  const rw = m.risk_weights || {};
  let num = 0, den = 0;
  for (const t in rw) { num += rw[t] * (out['tag:' + t] || 0); den += rw[t]; }
  out.composite_risk = den ? num / den : 0;
  return out;
}

module.exports = { predict, available };
