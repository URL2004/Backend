const fs = require('fs');
const path = require('path');

process.env.FORMAL_HUMAN = '1';

const root = path.resolve(__dirname, '..');
const rawPath = 'C:/Users/dbvision10/.codex/attachments/21f0695a-375d-4b94-9e77-1f166600edc2/pasted-text.txt';
const inputPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-internal-low-output.md');
const outPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-note-style-output.md');
const sumPath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-note-style-summary.json');

const proxy = require('../engine/copykillerproxy');
const floor = require('../engine/floor');

function normalize(text) {
  return String(text || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function isHeading(line) {
  return /^(Ⅰ\.|Ⅱ\.|Ⅲ\.|\d+\.\s+「|참고문헌|세 가지)/.test(line.trim());
}

function splitSentences(block) {
  return String(block || '')
    .split(/(?<=[.!?。])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function softenSentence(sentence) {
  return String(sentence || '')
    .replace(/필자의 판단으로는/g, '읽어보면')
    .replace(/필자 입장에서는/g, '내가 먼저 본 것은')
    .replace(/필자가 보기에/g, '내가 보기에는')
    .replace(/내가 보기에/g, '내가 보기에는')
    .replace(/첫 번째이자 가장 큰 문제는/g, '가장 먼저 걸리는 점은')
    .replace(/첫 번째 문제는/g, '먼저 걸리는 점은')
    .replace(/두 번째로 필자가 중요하게 보는 문제는/g, '다음으로 걸리는 점은')
    .replace(/세 번째로 필자가 문제 삼는 부분은/g, '마지막으로 걸리는 점은')
    .replace(/세 번째 문제는/g, '마지막으로 남는 점은')
    .replace(/이 문제를 해결하려면/g, '그래서 고친다면')
    .replace(/구체적인 수정 방향은/g, '내가 정리한 수정 방향은')
    .replace(/문구를 어떻게 고칠지 제안하려 한다/g, '어떤 문구부터 손봐야 할지 정리해 보려 한다')
    .replace(/실제로 작동하는 힘/g, '작동하는 힘')
    .replace(/짜여진/g, '정리된');
}

function toNoteStyle(text) {
  const paragraphs = String(text || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const out = [];
  for (const p of paragraphs) {
    if (/^현행 복지 관련 법/.test(p)) {
      out.push('세 가지 복지 법을 읽고 남긴 정리');
      continue;
    }
    if (/^Ⅰ\.\s*서론/.test(p)) {
      out.push('들어가며');
      continue;
    }
    if (/^Ⅱ\.\s*본론/.test(p)) {
      out.push('살펴본 내용');
      continue;
    }
    if (/^Ⅲ\.\s*결론/.test(p)) {
      out.push('마무리');
      continue;
    }
    if (/^\d+\.\s+「/.test(p) || /^참고문헌/.test(p)) {
      out.push(p
        .replace(/문제점과 바꿔야 할 방향/g, '살펴본 점')
        .replace(/참고문헌/g, '참고한 자료'));
      continue;
    }
    if (/국가법령정보센터|law\.go\.kr|KCI|DBpia|보건복지부\.|행정안전부\./.test(p)) {
      out.push(p);
      continue;
    }

    const sentences = splitSentences(p).map(softenSentence);
    if (sentences.length <= 2) {
      out.push(sentences.join(' '));
      continue;
    }
    const lines = [];
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      if (!s) continue;
      if (i === 0) lines.push(s);
      else lines.push(`- ${s}`);
    }
    out.push(lines.join('\n'));
  }
  return normalize(out.join('\n\n'));
}

function summarize(output) {
  const rawText = fs.readFileSync(rawPath, 'utf8');
  const metrics = proxy.measure(output, { rawText, mode: 'assignment' });
  const floorReport = floor.buildFloorReport({ result: { outputText: output }, rawText, mode: 'assignment' });
  return {
    input: path.relative(root, inputPath),
    output: path.relative(root, outPath),
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
        structuredFlow: r.structuredFlow,
        legalReport: r.legalReport,
        head: r.head,
      })),
    },
    floor: { status: floorReport.status, criticals: floorReport.criticals },
  };
}

const input = fs.readFileSync(inputPath, 'utf8');
const output = toNoteStyle(input);
fs.writeFileSync(outPath, output, 'utf8');
const summary = summarize(output);
fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2), 'utf8');
console.log(JSON.stringify(summary, null, 2));
