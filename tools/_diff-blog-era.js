// 숏폼 블로그: 과거 36% 출력 vs 현재 49% 출력 결정론 비교 (회귀 원인 데이터)
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

function body(md) {
  const t = fs.readFileSync(path.join(root, md), 'utf8').replace(/\r\n/g, '\n');
  return t.split(/\n---\n/).slice(1).join('\n---\n').trim();
}
function stats(label, text, src) {
  const paras = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const sents = text.match(/[^.!?…]+[.!?…]+/g) || [];
  const end = (re) => sents.filter(s => re.test(s.trim())).length;
  const total = sents.length;
  // 종결 분류
  const yo = end(/(요|죠|에요|예요|네요|거든요|잖아요|더라고요|까요)[.!?…]*$/);
  const da = end(/(다|이다|있다|간다|온다|난다|진다|든다|한다|었다|았다|겠다|니다)[.!?…]*$/);
  const nida = end(/(습니다|입니다|합니다|됩니다|있습니다)[.!?…]*$/);
  // 원문 verbatim 비율(20자 슬라이딩 — 미가공 패스스루 측정)
  const bareSrc = src.replace(/\s+/g, '');
  const bareOut = text.replace(/\s+/g, '');
  let verbatim = 0;
  const step = 20;
  for (let i = 0; i + step <= bareOut.length; i += step) {
    if (bareSrc.includes(bareOut.slice(i, i + step))) verbatim += step;
  }
  const lens = paras.map(p => p.replace(/\s+/g, '').length);
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  const cv = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length) / mean;
  const count = (re) => (text.match(re) || []).length;
  console.log(`\n=== ${label} ===`);
  console.log(`공백제외 ${bareOut.length}자 | 문단 ${paras.length}개(평균 ${Math.round(mean)}자, CV ${cv.toFixed(2)}) | 문장 ${total}`);
  console.log(`종결: 해요체 ${yo}(${Math.round(yo / total * 100)}%) · 합니다체 ${nida}(${Math.round(nida / total * 100)}%) · 평어단정 ${da - nida}(${Math.round((da - nida) / total * 100)}%)`);
  console.log(`원문 verbatim 비율: ${Math.round(verbatim / bareOut.length * 100)}% (미가공 패스스루)`);
  console.log(`구어 장치: 거든요 ${count(/거든요/g)} · 잖아요 ${count(/잖아요/g)} · 더라고요 ${count(/더라고요/g)} · 죠 ${count(/죠[.!?…]/g)} · 까요 ${count(/까요/g)}`);
}

const src = fs.readFileSync(path.join(root, 'samples/shortform.txt'), 'utf8');
stats('과거 36% (숏폼-C등급-스택.md)', body('results/숏폼-C등급-스택.md'), src);
stats('현재 49% (숏폼-blog-재측정.md)', body('results/숏폼-blog-재측정.md'), src);
