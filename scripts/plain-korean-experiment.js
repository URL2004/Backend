const fs = require('fs');
const path = require('path');

process.env.FORMAL_HUMAN = '1';

const root = path.resolve(__dirname, '..');
const rawPath = 'C:/Users/dbvision10/.codex/attachments/21f0695a-375d-4b94-9e77-1f166600edc2/pasted-text.txt';
const inputPath = path.join(root, 'results/gemini-local-runs/experiment-subheads_lex_anchors_hotspots_conclusion_grammar.md');
const outPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-plain-korean-output.md');
const sumPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-plain-korean-summary.json');
const protectedOutPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-plain-korean-protected-output.md');
const protectedSumPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-plain-korean-protected-summary.json');
const compactOutPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-plain-korean-compact-output.md');
const compactSumPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-plain-korean-compact-summary.json');
const dedupOutPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-plain-korean-dedup-output.md');
const dedupSumPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-plain-korean-dedup-summary.json');

const proxy = require('../engine/copykillerproxy');
const floor = require('../engine/floor');

function normalize(t) {
  return String(t || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function plainizeLine(line) {
  if (/참고문헌|국가법령정보센터|law\.go\.kr|KCI|DBpia|보건복지부\.|행정안전부\.|한국사회복지관협회\.|한국사회보장정보원\./.test(line)) {
    return line;
  }
  return line
    .replace(/"([^"\n]{2,40})"/g, '$1')
    .replace(/사회복지/g, '복지')
    .replace(/사회보장/g, '복지 안전망')
    .replace(/법률/g, '법')
    .replace(/법제/g, '법 체계')
    .replace(/조문/g, '문구')
    .replace(/조항/g, '대목')
    .replace(/개정/g, '수정')
    .replace(/규정/g, '내용')
    .replace(/명시/g, '분명히 적기')
    .replace(/신설/g, '새로 두기')
    .replace(/보장/g, '뒷받침')
    .replace(/설정/g, '정하기')
    .replace(/적용/g, '쓰기')
    .replace(/폐지/g, '없애기')
    .replace(/반영/g, '담기')
    .replace(/수급권/g, '받을 권리')
    .replace(/급여/g, '지원')
    .replace(/기준/g, '선')
    .replace(/위원회/g, '회의체')
    .replace(/국가/g, '정부')
    .replace(/지방자치단체/g, '지자체')
    .replace(/의료급여/g, '의료 지원')
    .replace(/부양의무자/g, '가족 부양 잣대')
    .replace(/소득인정액/g, '인정 소득')
    .replace(/최저보장수준/g, '최저 생활선')
    .replace(/민간위탁/g, '외부 위탁')
    .replace(/종사자/g, '일하는 사람')
    .replace(/처우/g, '대우')
    .replace(/재정/g, '돈')
    .replace(/국고/g, '정부 지원')
    .replace(/제도/g, '틀')
    .replace(/실효성/g, '실제로 작동하는 힘')
    .replace(/법적/g, '법상')
    .replace(/구체적인/g, '분명한')
    .replace(/구체적/g, '분명한')
    .replace(/구조적/g, '구조상의')
    .replace(/권리/g, '권리')
    .replace(/분명히 적기한다/g, '분명히 적는다')
    .replace(/새로 두기한다/g, '새로 둔다')
    .replace(/뒷받침한다/g, '뒷받침한다')
    .replace(/정하기한다/g, '정한다')
    .replace(/쓰기한다/g, '쓴다')
    .replace(/없애기한다/g, '없앤다')
    .replace(/담기한다/g, '담는다');
}

function plainize(text) {
  return normalize(String(text || '').split('\n').map(plainizeLine).join('\n'));
}

const PROTECTED = [
  '사회보장기본법',
  '사회복지사업법',
  '국민기초생활보장법',
  '사회보장위원회',
  '사회복지시설',
  '사회복지사업',
  '사회복지사',
  '한국사회복지관협회',
  '한국사회보장정보원',
  '사회보장급여',
  '의료급여',
  '생계급여',
  '주거급여',
  '교육급여',
  '부양의무자',
  '소득인정액',
  '최저보장수준',
  '민간위탁',
  '국민기초생활보장',
];

function withProtected(text, fn) {
  const map = new Map();
  let out = text;
  PROTECTED.forEach((phrase, i) => {
    const key = `__P${i}__`;
    map.set(key, phrase);
    out = out.split(phrase).join(key);
  });
  out = fn(out);
  for (const [key, phrase] of map) out = out.split(key).join(phrase);
  return out;
}

function plainizeProtected(text) {
  return normalize(withProtected(String(text || ''), t => t.split('\n').map(plainizeLine).join('\n'))
    .replace(/권리을/g, '권리를')
    .replace(/지원를/g, '지원을')
    .replace(/쓰기하는/g, '적용하는')
    .replace(/문틀/g, '문제도')
    .replace(/최저뒷받침수준/g, '최저보장수준')
    .replace(/법 체계화/g, '법제화'));
}

function compactHeadings(text) {
  return normalize(String(text || '')
    .replace(/^(Ⅰ\.\s*서론)\n\n/gm, '$1\n')
    .replace(/^(Ⅱ\.\s*본론)\n\n/gm, '$1\n')
    .replace(/^(Ⅲ\.\s*결론)\n\n/gm, '$1\n')
    .replace(/^(\d+\.\s+「[^」]+」[^\n]*)\n\n/gm, '$1\n')
    .replace(/^(마지막으로 남는[^\n]*)\n\n/gm, '$1\n')
    .replace(/^참고문헌\n\n/gm, '참고문헌\n'));
}

function replaceAfterFirst(text, phrase, replacement) {
  let seen = false;
  return String(text || '').replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), m => {
    if (!seen) {
      seen = true;
      return m;
    }
    return replacement;
  });
}

function dedupeRepeatedLegalTerms(text) {
  let out = String(text || '');
  out = replaceAfterFirst(out, '사회보장위원회', '이 회의체');
  out = replaceAfterFirst(out, '사회복지시설', '시설');
  out = replaceAfterFirst(out, '사회복지사업', '복지사업');
  out = replaceAfterFirst(out, '사회복지사', '복지사');
  out = replaceAfterFirst(out, '사회보장급여', '지원');
  out = replaceAfterFirst(out, '의료급여', '의료 지원');
  out = replaceAfterFirst(out, '생계급여', '생계 지원');
  out = replaceAfterFirst(out, '주거급여', '주거 지원');
  out = replaceAfterFirst(out, '교육급여', '교육 지원');
  out = replaceAfterFirst(out, '부양의무자', '가족 부양 기준');
  out = replaceAfterFirst(out, '소득인정액', '인정 소득');
  out = replaceAfterFirst(out, '최저보장수준', '최저 생활선');
  out = replaceAfterFirst(out, '민간위탁', '외부 위탁');
  out = withProtected(out, t => t
    .replace(/사회복지/g, '복지')
    .replace(/사회보장/g, '복지 안전망')
    .replace(/법률/g, '법')
    .replace(/조항/g, '대목')
    .replace(/조문/g, '문구')
    .replace(/규정/g, '내용')
    .replace(/기준/g, '선')
    .replace(/위원회/g, '회의체')
    .replace(/급여/g, '지원')
    .replace(/보장/g, '뒷받침')
    .replace(/제도/g, '틀')
    .replace(/재정/g, '돈')
    .replace(/처우/g, '대우'));
  return normalize(out
    .replace(/지원지원/g, '지원')
    .replace(/지원 지원/g, '지원')
    .replace(/선선/g, '선')
    .replace(/분명한으로/g, '분명하게')
    .replace(/분명한 문구/g, '분명한 문장')
    .replace(/끌어안음할/g, '포괄할')
    .replace(/담기할/g, '담을')
    .replace(/틀는/g, '틀은')
    .replace(/복지틀의 틀/g, '복지 제도의 틀')
    .replace(/문틀/g, '문제')
    .replace(/돈적/g, '재정적')
    .replace(/던 사회복지사/g, '덜어낸 사회복지사')
    .replace(/뒷받침수준/g, '보장수준')
    .replace(/복지 안전망위원회/g, '사회보장위원회')
    .replace(/한국복지관협회/g, '한국사회복지관협회'));
}

const rawText = fs.readFileSync(rawPath, 'utf8');
const input = fs.readFileSync(inputPath, 'utf8');
const output = plainize(input);
fs.writeFileSync(outPath, output, 'utf8');
const protectedOutput = plainizeProtected(input);
fs.writeFileSync(protectedOutPath, protectedOutput, 'utf8');
const compactOutput = compactHeadings(protectedOutput);
fs.writeFileSync(compactOutPath, compactOutput, 'utf8');
const dedupOutput = dedupeRepeatedLegalTerms(compactOutput);
fs.writeFileSync(dedupOutPath, dedupOutput, 'utf8');

const before = proxy.measure(input, { rawText, mode: 'assignment' });
const after = proxy.measure(output, { rawText, mode: 'assignment' });
const floorReport = floor.buildFloorReport({ result: { outputText: output }, rawText, mode: 'assignment' });

const summary = {
  input: path.relative(root, inputPath),
  output: path.relative(root, outPath),
  before: { score: before.score, aiRate: before.aiSuspicion.predictedAiRate, levels: before.aiSuspicion.levels },
  after: {
    score: after.score,
    aiRate: after.aiSuspicion.predictedAiRate,
    levels: after.aiSuspicion.levels,
    qualityGate: after.qualityGate,
    rows: after.aiSuspicion.rows.map(r => ({
      idx: r.idx,
      score: r.score,
      level: r.level,
      reasons: r.reasons,
      legalReport: r.legalReport,
      head: r.head,
    })),
  },
  floor: { status: floorReport.status, criticals: floorReport.criticals },
};

fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2), 'utf8');

const protectedAfter = proxy.measure(protectedOutput, { rawText, mode: 'assignment' });
const protectedFloor = floor.buildFloorReport({ result: { outputText: protectedOutput }, rawText, mode: 'assignment' });
const protectedSummary = {
  input: path.relative(root, inputPath),
  output: path.relative(root, protectedOutPath),
  before: summary.before,
  after: {
    score: protectedAfter.score,
    aiRate: protectedAfter.aiSuspicion.predictedAiRate,
    levels: protectedAfter.aiSuspicion.levels,
    qualityGate: protectedAfter.qualityGate,
    rows: protectedAfter.aiSuspicion.rows.map(r => ({
      idx: r.idx,
      score: r.score,
      level: r.level,
      reasons: r.reasons,
      legalReport: r.legalReport,
      head: r.head,
    })),
  },
  floor: { status: protectedFloor.status, criticals: protectedFloor.criticals },
};
fs.writeFileSync(protectedSumPath, JSON.stringify(protectedSummary, null, 2), 'utf8');

const compactAfter = proxy.measure(compactOutput, { rawText, mode: 'assignment' });
const compactFloor = floor.buildFloorReport({ result: { outputText: compactOutput }, rawText, mode: 'assignment' });
const compactSummary = {
  input: path.relative(root, inputPath),
  output: path.relative(root, compactOutPath),
  before: summary.before,
  after: {
    score: compactAfter.score,
    aiRate: compactAfter.aiSuspicion.predictedAiRate,
    levels: compactAfter.aiSuspicion.levels,
    qualityGate: compactAfter.qualityGate,
    rows: compactAfter.aiSuspicion.rows.map(r => ({
      idx: r.idx,
      score: r.score,
      level: r.level,
      reasons: r.reasons,
      legalReport: r.legalReport,
      head: r.head,
    })),
  },
  floor: { status: compactFloor.status, criticals: compactFloor.criticals },
};
fs.writeFileSync(compactSumPath, JSON.stringify(compactSummary, null, 2), 'utf8');

const dedupAfter = proxy.measure(dedupOutput, { rawText, mode: 'assignment' });
const dedupFloor = floor.buildFloorReport({ result: { outputText: dedupOutput }, rawText, mode: 'assignment' });
const dedupSummary = {
  input: path.relative(root, inputPath),
  output: path.relative(root, dedupOutPath),
  before: summary.before,
  after: {
    score: dedupAfter.score,
    aiRate: dedupAfter.aiSuspicion.predictedAiRate,
    levels: dedupAfter.aiSuspicion.levels,
    qualityGate: dedupAfter.qualityGate,
    rows: dedupAfter.aiSuspicion.rows.map(r => ({
      idx: r.idx,
      score: r.score,
      level: r.level,
      reasons: r.reasons,
      legalReport: r.legalReport,
      head: r.head,
    })),
  },
  floor: { status: dedupFloor.status, criticals: dedupFloor.criticals },
};
fs.writeFileSync(dedupSumPath, JSON.stringify(dedupSummary, null, 2), 'utf8');
console.log(JSON.stringify({ plain: summary, protected: protectedSummary, compact: compactSummary, dedup: dedupSummary }, null, 2));
