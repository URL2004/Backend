// 카피킬러 264 PDF → AI작성률 before/after 추출 + CSV 모드 조인
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');

const DIR = 'C:/Users/dbvision10/Downloads/카피킬러 AI생성검사 상세 결과확인서 모음 - 미입력 - 366681314/';
const CSV_JSON = 'C:/Users/dbvision10/Documents/당근대학생/오늘-원문-휴머나이징-2026-06-19.json';

const files = fs.readdirSync(DIR).filter(f => f.toLowerCase().endsWith('.pdf'));

function parseName(fn) {
  // ...0001_06192108-29_01_원문... / ...0002..._02_휴머나이징결과...
  const m = fn.match(/(\d{4})_([\d-]+)_\d{2}_(원문|휴머나이징결과)/);
  if (!m) return null;
  return { pair: +m[1], side: m[3] === '원문' ? 'orig' : 'human', stamp: m[2] };
}

function extractAi(text) {
  // "AI작성률" 다음 첫 퍼센트
  const m = text.match(/AI작성률[\s\S]{0,30}?(\d{1,3})\s*%/);
  return m ? +m[1] : null;
}
function extractSchool(text) {
  const m = text.match(/소속\s*([^\n]+)/);
  return m ? m[1].trim().slice(0, 40) : '';
}

async function run() {
  const limit = 8;
  const results = {};
  let i = 0;
  async function worker() {
    while (i < files.length) {
      const idx = i++;
      const fn = files[idx];
      const meta = parseName(fn);
      if (!meta) { console.error('SKIP name', fn); continue; }
      try {
        const d = await pdf(fs.readFileSync(path.join(DIR, fn)));
        const ai = extractAi(d.text);
        results[meta.pair] = results[meta.pair] || {};
        results[meta.pair][meta.side] = ai;
        results[meta.pair].school = results[meta.pair].school || extractSchool(d.text);
        if (ai == null) console.error('NO_AI%', fn);
      } catch (e) {
        console.error('ERR', fn, e.message);
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));

  // join mode from CSV
  const arr = JSON.parse(fs.readFileSync(CSV_JSON, 'utf8'));
  const modeByNum = {}, emailByNum = {}, inLenByNum = {};
  arr.forEach(r => { modeByNum[+r['번호']] = r['모드'] || '(빈)'; emailByNum[+r['번호']] = r['이메일']; inLenByNum[+r['번호']] = +r['원문길이'] || 0; });

  const rows = [];
  for (let p = 1; p <= 132; p++) {
    const r = results[p];
    if (!r) { rows.push({ pair: p, orig: null, human: null, mode: modeByNum[p] }); continue; }
    rows.push({
      pair: p, orig: r.orig, human: r.human, delta: (r.orig != null && r.human != null) ? r.orig - r.human : null,
      mode: modeByNum[p], email: emailByNum[p], inLen: inLenByNum[p], school: r.school
    });
  }
  fs.writeFileSync('C:/Users/dbvision10/Documents/당근대학생/copykiller_results.json', JSON.stringify(rows, null, 1));
  console.log('WROTE copykiller_results.json — pairs:', rows.length);
  console.log('missing AI% pairs:', rows.filter(r => r.orig == null || r.human == null).map(r => r.pair).join(',') || 'none');
}
run();
