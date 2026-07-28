const fs = require('fs');
const path = require('path');

process.env.FORMAL_HUMAN = '1';

const root = path.resolve(__dirname, '..');
const rawPath = 'C:/Users/dbvision10/.codex/attachments/21f0695a-375d-4b94-9e77-1f166600edc2/pasted-text.txt';
const compactPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-plain-korean-compact-output.md');
const outPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-plain-korean-section-weave-output.md');
const sumPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-plain-korean-section-weave-summary.json');
const polishedOutPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-polished-section-weave-output.md');
const polishedSumPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-polished-section-weave-summary.json');

const proxy = require('../engine/copykillerproxy');
const floor = require('../engine/floor');
const weaveMaxChars = Number(process.env.PARA_WEAVE_MAX) || 900;

function normalize(text) {
  return String(text || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function isMajorBlock(block) {
  const b = String(block || '').trim();
  return (
    /^[ⅠⅡⅢ]\./.test(b) ||
    /^\d+\.\s+「/.test(b) ||
    b.startsWith('참고문헌') ||
    b.includes('law.go.kr') ||
    b.includes('KCI') ||
    b.includes('DBpia') ||
    b.includes('―')
  );
}

function weaveParagraphsBySection(text, maxChars = 900) {
  const blocks = String(text || '').split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  const out = [];
  let current = '';
  const flush = () => {
    if (current.trim()) out.push(current.trim());
    current = '';
  };

  for (const block of blocks) {
    if (isMajorBlock(block)) {
      flush();
      out.push(block);
      continue;
    }
    current = current ? `${current} ${block}` : block;
    if (current.replace(/\s+/g, '').length >= maxChars) flush();
  }
  flush();
  return normalize(out.join('\n\n'));
}

function polishLegalKorean(text) {
  return normalize(String(text || '')
    .replace(/「복지사업법」/g, '「사회복지사업법」')
    .replace(/(^|[^사회])복지사업법/g, '$1사회복지사업법')
    .replace(/복지 제도의 틀/g, '복지 제도의 기본 틀')
    .replace(/복지틀의 틀/g, '복지 제도의 기본 틀')
    .replace(/틀적 틀/g, '제도적 틀')
    .replace(/틀적 변화/g, '제도 변화')
    .replace(/복지 안전망틀/g, '복지 안전망 제도')
    .replace(/복지 안전망정보원/g, '사회보장정보원')
    .replace(/분명한 문장 바꿔야/g, '분명한 문장으로 바꿔야')
    .replace(/문구 바꿔야/g, '문구를 바꿔야')
    .replace(/분명한 문구를 바꿔야 할 방향/g, '문구를 어떻게 고칠지')
    .replace(/문구를 어떻게 고칠지을/g, '문구를 어떻게 고칠지')
    .replace(/분석 선은/g, '분석의 출발점은')
    .replace(/법의 큰 내용은 크게/g, '법의 내용은')
    .replace(/받을 권리 대목군/g, '받을 권리 관련 부분')
    .replace(/선임하는 선/g, '선임 원칙')
    .replace(/틀적 통로/g, '공식 통로')
    .replace(/담기할 통로/g, '담을 통로')
    .replace(/분명한 법 고쳐 쓴 방향은/g, '구체적인 수정 방향은')
    .replace(/분명한으로/g, '구체적으로')
    .replace(/분명한 내용/g, '큰 내용')
    .replace(/법의 큰 내용은 크게/g, '법의 내용은')
    .replace(/분명한 지원/g, '구체적인 지원')
    .replace(/분명하게 안내/g, '구체적으로 안내')
    .replace(/복지 일하는 사람/g, '복지 현장 인력')
    .replace(/일하는 사람 인건비/g, '현장 인력 인건비')
    .replace(/일하는 사람 보수/g, '현장 인력 보수')
    .replace(/일하는 사람의 보수/g, '현장 인력의 보수')
    .replace(/일하는 사람 모두/g, '현장 인력 모두')
    .replace(/현장 일하는 사람/g, '현장 인력')
    .replace(/시설 일하는 사람/g, '시설 인력')
    .replace(/법 쓰기 범위/g, '법이 미치는 범위')
    .replace(/쓰기 범위/g, '적용 범위')
    .replace(/쓰기 대상/g, '적용 대상')
    .replace(/쓰기할/g, '적용할')
    .replace(/쓰기했다/g, '적용했다')
    .replace(/쓰기로/g, '적용으로')
    .replace(/끌어안음할/g, '포괄할')
    .replace(/지원를/g, '지원을')
    .replace(/지원 지원/g, '지원')
    .replace(/담기한/g, '담은')
    .replace(/틀화/g, '제도화')
    .replace(/틀은/g, '제도는')
    .replace(/틀는/g, '제도는')
    .replace(/틀가/g, '제도가')
    .replace(/틀를/g, '제도를')
    .replace(/틀 안/g, '제도 안')
    .replace(/틀 시행/g, '제도 시행')
    .replace(/틀의 안착/g, '제도의 안착')
    .replace(/선 중위소득/g, '기준 중위소득')
    .replace(/인정 소득/g, '소득인정액')
    .replace(/가족 부양 선 선/g, '가족 부양 요건')
    .replace(/가족 부양 선/g, '가족 부양 요건')
    .replace(/부양의무자 선/g, '부양의무자 요건')
    .replace(/통합지원/g, '통합급여')
    .replace(/돈 부담/g, '재정 부담')
    .replace(/돈 상태/g, '재정 상황')
    .replace(/돈적/g, '재정적')
    .replace(/재정 상황를/g, '재정 상황을')
    .replace(/시설 설치 및 감독 선/g, '시설 설치와 감독 원칙')
    .replace(/인구학적 선/g, '인구학적 조건')
    .replace(/소득과 재산만을 선으로/g, '소득과 재산만을 잣대로')
    .replace(/든든한 돈/g, '충분한 재정')
    .replace(/돈 형편/g, '재정 여건')
    .replace(/새로 두기변경/g, '신설변경')
    .replace(/법 체계화/g, '법제화')
    .replace(/2023년 선 수급자/g, '2023년 기준 수급자')
    .replace(/분명히 세워/g, '분명히 정해')
    .replace(/선선을/g, '선을')
    .replace(/선 선/g, '기준')
    .replace(/과반수 이상이 되도록 선을/g, '과반수 이상이 되도록 비율을')
    .replace(/법 차원의 선은/g, '법 차원의 장치는')
    .replace(/자활 연계 성과 선의 제도화/g, '자활 연계 성과 관리 장치 마련')
    .replace(/자활 연계 성과 관리 장치 마련다/g, '자활 연계 성과 관리 장치를 마련하는 일이다')
    .replace(/주거비 실태를 선으로/g, '주거비 실태를 보고')
    .replace(/보수 선/g, '보수 하한선')
    .replace(/생활뒷받침 틀의 문제/g, '기초생활보장 제도의 문제')
    .replace(/현장 현장 인력/g, '현장 인력')
    .replace(/일하는 사람들의 지원 차이/g, '현장 인력의 보수 차이')
    .replace(/협력 구조를 명확히 내용하여/g, '협력 구조를 분명히 하여')
    .replace(/쥐는 실질 소득/g, '실제로 확보하는 소득')
    .replace(/온기가/g, '효과가'));
}

function summarize(output, outputPath) {
  const rawText = fs.readFileSync(rawPath, 'utf8');
  const metrics = proxy.measure(output, { rawText, mode: 'assignment' });
  const floorReport = floor.buildFloorReport({ result: { outputText: output }, rawText, mode: 'assignment' });
  return {
    output: path.relative(root, outputPath),
    after: {
      score: metrics.score,
      aiRate: metrics.aiSuspicion.predictedAiRate,
      levels: metrics.aiSuspicion.levels,
      qualityGate: metrics.qualityGate,
      longParagraphs: metrics.longParagraphs,
      rows: metrics.aiSuspicion.rows.map(r => ({
        idx: r.idx,
        score: r.score,
        level: r.level,
        reasons: r.reasons,
        abstractRiskRatio: r.abstractRiskRatio,
        legalReport: r.legalReport,
        head: r.head,
      })),
    },
    floor: { status: floorReport.status, criticals: floorReport.criticals },
  };
}

const compact = fs.readFileSync(compactPath, 'utf8');
const sectionWeave = weaveParagraphsBySection(compact, weaveMaxChars);
fs.writeFileSync(outPath, sectionWeave, 'utf8');
const sectionSummary = summarize(sectionWeave, outPath);
sectionSummary.weaveMaxChars = weaveMaxChars;
fs.writeFileSync(sumPath, JSON.stringify(sectionSummary, null, 2), 'utf8');

const polished = polishLegalKorean(sectionWeave);
fs.writeFileSync(polishedOutPath, polished, 'utf8');
const polishedSummary = summarize(polished, polishedOutPath);
polishedSummary.weaveMaxChars = weaveMaxChars;
fs.writeFileSync(polishedSumPath, JSON.stringify(polishedSummary, null, 2), 'utf8');

console.log(JSON.stringify({ sectionWeave: sectionSummary, polished: polishedSummary }, null, 2));
