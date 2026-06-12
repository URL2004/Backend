// JSON 새니타이저 검증 (실사고 재현 — 문자열 안 비이스케이프 한국어 인용부호)
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '../engine/judge.js'), 'utf8');
const m = src.match(/function sanitizeJsonQuotes[\s\S]*?\nfunction parseJSON[\s\S]*?\n\}/);
eval(m[0]);

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : (fail++, console.log('FAIL: ' + n)); };

// 1. 실사고 그대로: span/detail 안에 비이스케이프 큰따옴표
const poison = `{"violations":[{"type":"added_claim","span":"대학이 AI 시대에 내놓는 답이 결국 "알아서 잘 써라"랑 뭐가 다른 걸까.","detail":"원장에 없는 "평가"를 도입"}]}`;
const r1 = parseJSON(poison);
ok('실사고 파싱 복구', r1 && r1.violations.length === 1 && r1.violations[0].span.includes('알아서 잘 써라'));

// 2. 정상 JSON 무손상(이미 이스케이프된 따옴표·콤마·콜론 포함 문자열)
const clean = `{"a":"hello \\"x\\" world","b":[1,2],"c":{"d":"한글, 쉼표: 포함"}}`;
const r2 = parseJSON(clean);
ok('정상 JSON 무손상', r2 && r2.a === 'hello "x" world' && r2.c.d === '한글, 쉼표: 포함');

// 3. slot plan 류: title에 인용부호
const plan = `{"title":"AI 시대, "알아서 써라"는 답의 함정","subtitle":"부제","slots":[{"role":"hook_fact","claims":["C1"]}]}`;
const r3 = parseJSON(plan);
ok('slot plan 류 복구', r3 && Array.isArray(r3.slots) && r3.title.includes('알아서'));

// 4. 코드펜스 + 머리말
const fenced = '```json\n{"x":"y"}\n```';
ok('코드펜스', parseJSON(fenced) && parseJSON(fenced).x === 'y');

console.log(`json sanitize: ${pass}통과 / ${fail}실패`);
process.exit(fail ? 1 : 0);
