const { splitSentences } = require('./textStats');

const ORPHAN_CONNECTIVE_RE = /(?:^|[.!?。！？]\s+)(있으며|이며|이고|하고|하며|되며|되어|이어지며|나타나며|보이며|만들어내며)[,，]\s*/g;
const SENTENCE_START_ORPHAN_RE = /^\s*(있으며|이며|이고|하고|하며|되며|되어|이어지며|나타나며|보이며|만들어내며)[,，]/;

function findGrammarIssues(text) {
  const src = String(text || '');
  const issues = [];
  let m;
  while ((m = ORPHAN_CONNECTIVE_RE.exec(src)) !== null) {
    issues.push({
      type: 'orphan_connective_after_period',
      token: m[1],
      index: m.index,
      excerpt: excerpt(src, m.index)
    });
  }

  const sentences = splitSentences(src);
  for (const s of sentences) {
    const mm = s.match(SENTENCE_START_ORPHAN_RE);
    if (mm) {
      issues.push({ type: 'sentence_starts_with_orphan_connective', token: mm[1], excerpt: s.slice(0, 80) });
    }
    if (/다\.\s*(있으며|이며|이고|하고|하며)[,，]/.test(s)) {
      issues.push({ type: 'broken_split_connective', excerpt: s.slice(0, 100) });
    }
  }

  return dedupeIssues(issues);
}

function repairOrphanConnectives(text) {
  return String(text || '')
    .replace(/([.!?。！？])\s+(있으며|이며|이고|하고|하며|되며|되어|이어지며|나타나며|보이며|만들어내며)[,，]\s*/g, '$1 ')
    .replace(/(^|\n\s*)(있으며|이며|이고|하고|하며|되며|되어|이어지며|나타나며|보이며|만들어내며)[,，]\s*/g, '$1');
}

function excerpt(text, idx) {
  return String(text || '').slice(Math.max(0, idx - 40), idx + 80).replace(/\s+/g, ' ');
}

function dedupeIssues(issues) {
  const seen = new Set();
  const out = [];
  for (const issue of issues) {
    const key = issue.type + '|' + issue.token + '|' + issue.excerpt;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

module.exports = { findGrammarIssues, repairOrphanConnectives };
