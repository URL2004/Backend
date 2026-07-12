'use strict';

// 운영 원문을 저장소에 복제하지 않고 로컬 JSON에서 장르·형식 계약만 재생한다.
// 원문, 결과, UID, history_id는 출력하지 않는다.
const fs = require('fs');
const path = require('path');
const { detectDocumentProfile } = require('../engine-gpt-prod/documentProfile');
const structure = require('../engine-gpt-prod/structureChunk');

const inputPath = process.argv[2] || process.env.HUMANIZE_REPLAY_JSON || '';
if (!inputPath) {
  console.error('사용법: npm run eval:profiles -- <로컬 원문-결과 JSON 경로>');
  process.exit(2);
}

const absolutePath = path.resolve(inputPath);
const parsed = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.pairs) ? parsed.pairs : []);
if (!rows.length) throw new Error('재생할 행이 없습니다. 배열 또는 { pairs: [] } 형식이어야 합니다.');

const summary = {
  schemaVersion: 1,
  rowCount: rows.length,
  profileInvariantFailures: 0,
  questionnaireRoundtripFailures: 0,
  errors: 0,
  contentGenres: {},
  formatProfiles: {},
  tonePolicies: {},
  riskFlags: {}
};

for (const row of rows) {
  try {
    const source = String(row?.inputText ?? row?.source ?? row?.input ?? '').trim();
    if (!source) throw new Error('empty source');
    const variants = ['', 'blog', 'report'].map(basicStyle => detectDocumentProfile(source, { basicStyle }));
    if (new Set(variants.map(profile => profile.contentGenre)).size !== 1) summary.profileInvariantFailures += 1;
    const profile = variants[0];
    increment(summary.contentGenres, profile.contentGenre);
    increment(summary.formatProfiles, profile.formatProfile?.primary || 'plain');
    for (const item of variants) increment(summary.tonePolicies, item.tonePolicy || 'source_preserve');
    for (const flag of profile.riskFlags || []) increment(summary.riskFlags, flag);
    if (profile.formatProfile?.flags?.includes?.('questionnaire')) {
      const plan = structure.splitChunksForGpt(source, {
        coalesceEditable: true,
        formatProfile: profile.formatProfile
      });
      const lockedQuestions = plan.chunks.filter(chunk => chunk.lockType === 'questionnaire_question').length;
      if (lockedQuestions === 0 || structure.mergeChunks(plan.chunks) !== source) {
        summary.questionnaireRoundtripFailures += 1;
      }
    }
  } catch {
    summary.errors += 1;
  }
}

console.log(JSON.stringify(summary, null, 2));
if (summary.profileInvariantFailures || summary.questionnaireRoundtripFailures || summary.errors) process.exitCode = 1;

function increment(target, key) {
  const normalized = String(key || 'unknown');
  target[normalized] = (target[normalized] || 0) + 1;
}
