// [_fix-routine.js] routine v1 결과물의 지시문 윙크 누출 1문장 결정론 수정(임시 스크립트)
const fs = require('fs');
const floor = require('./engine/floor');
const gf = require('./engine/genreframes');

const FILE = 'results/routine-목소리앵커-v1.md';
const raw = fs.readFileSync('samples/routine.txt', 'utf8').trim();
const md = fs.readFileSync(FILE, 'utf8');
const head = md.split(/\n---\n+/)[0];
let doc = md.split(/\n---\n+/).slice(1).join('\n---\n').trim();

const OLD = '문제는 이것이 하루 이틀이 아니라는 데 있다(아, 이 표현 쓰지 말라고 했지). 솔직하게 쓰자면: 이 패턴이 쌓이면 사람은 자기 하루를 믿지 못하게 된다.';
const NEW = '하루 이틀이면 그러려니 하는데, 이게 반복되면 이야기가 달라진다. 이 패턴이 쌓이면 사람은 자기 하루를 믿지 못하게 된다.';

if (!doc.includes(OLD)) { console.log('❌ 대상 문장 못 찾음'); process.exit(1); }
doc = doc.replace(OLD, NEW);

const WINK_RE = /(표현|단어|문장|어투)[^.”"]{0,12}(쓰지\s*말|말라고\s*했|금지)/;
const nov = floor.measureNovelty(raw, doc, '').count;
const lost = floor.measureLostFacts(raw, doc).count;
const risk = gf.genreRiskScore(doc).score;
console.log('novelty', nov, '| lost', lost, '| genreRisk', risk, '| 윙크 잔존:', WINK_RE.test(doc));
if (nov > 0 || lost > 0 || WINK_RE.test(doc)) { console.log('❌ 게이트 불통 — 저장 안 함'); process.exit(1); }
fs.writeFileSync(FILE, head.replace('v1(36% 스택', 'v1b(36% 스택+윙크제거') + '\n---\n\n' + doc + '\n', 'utf8');
console.log('저장:', FILE);
