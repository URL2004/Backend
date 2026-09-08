'use strict';

const { createHash } = require('node:crypto');
const VERSION = 'semantic-provenance-v1';
const textDigest = value => createHash('sha256').update(String(value || ''), 'utf8').digest('hex');

// Whitespace-run projection. Replacing one whitespace run with another
// (space, line break, paragraph gap, CRLF) never changes a token or Korean
// word segmentation, so a judge verdict for the exact text also holds for
// this projection. Inserting or removing whitespace between characters is
// NOT covered: `한 뒤` and `한뒤` project to different digests.
const layoutProjection = value => String(value || '').replace(/\s+/gu, ' ').trim();
const layoutDigest = value => textDigest(layoutProjection(value));

function bindSemanticValidation(report, source, candidate, { model = '', phase = 'semantic', now = Date.now } = {}) {
  const value = report && typeof report === 'object' ? report : {};
  return {
    ...value,
    validation: {
      version: VERSION,
      sourceDigest: textDigest(source),
      candidateDigest: textDigest(candidate),
      sourceLayoutDigest: layoutDigest(source),
      candidateLayoutDigest: layoutDigest(candidate),
      status: value.ran !== true ? 'skipped' : value.uncertain === true ? 'uncertain'
        : value.pass === true && value.repairRejected !== true ? 'validated_pass' : 'validated_fail',
      model: String(model || value.selectedJudgeModel || '').slice(0, 80),
      phase: String(phase).slice(0, 80),
      checkedAt: new Date(now()).toISOString()
    }
  };
}

function digestMatch(validation, { source, candidate }) {
  const exact = (source == null || validation.sourceDigest === textDigest(source))
    && (candidate == null || validation.candidateDigest === textDigest(candidate));
  if (exact) return 'exact';
  if (!validation.sourceLayoutDigest || !validation.candidateLayoutDigest) return '';
  const layout = (source == null || validation.sourceLayoutDigest === layoutDigest(source))
    && (candidate == null || validation.candidateLayoutDigest === layoutDigest(candidate));
  return layout ? 'whitespace_layout' : '';
}

function verifySemanticValidation(report, { source, candidate, requireDigest = false } = {}) {
  if (!report || typeof report !== 'object') return { status: 'unknown', rank: 1 };
  if (report.ran === false || report.skipped === true) return { status: 'skipped', rank: 1 };
  if (report.uncertain === true) return { status: 'unknown', rank: 1 };
  const validation = report.validation;
  let materialization = '';
  if (validation?.version === VERSION) {
    materialization = digestMatch(validation, { source, candidate });
    if (!materialization) return { status: 'stale', rank: 1 };
    if (validation.status === 'skipped') return { status: 'skipped', rank: 1 };
  } else if (requireDigest) return { status: 'unknown', rank: 1 };
  if (report.pass === false || report.repairRejected === true) return { status: 'fail', rank: 0, materialization };
  if (report.ran === true && report.pass === true) return { status: 'pass', rank: 2, materialization };
  return { status: 'unknown', rank: 1 };
}

// The caller supplies the already-validated strings and a deterministic
// materialization (for example restoring frozen literal tokens). This never
// authorizes an arbitrary rewritten candidate or a stale input report.
function projectSemanticValidation(report, { source, candidate, project } = {}) {
  if (typeof project !== 'function'
      || verifySemanticValidation(report, { source, candidate, requireDigest: true }).status !== 'pass') return report;
  const projected = bindSemanticValidation(report, project(source), project(candidate), {
    model: report.validation.model, phase: 'deterministic_materialization'
  });
  projected.validation.parentCandidateDigest = report.validation.candidateDigest;
  projected.validation.parentSourceDigest = report.validation.sourceDigest;
  return projected;
}

function finalValidationWarnings(report, validation) {
  if (report?.ran !== true || !['stale', 'unknown'].includes(validation?.status)) return [];
  return [{
    code: validation.status === 'stale' ? 'semantic_validation_stale' : 'semantic_validation_unconfirmed',
    severity: 'warning',
    message: '최종 편집본의 의미 검증이 확인되지 않아 원문과 대조가 필요해요.'
  }];
}

module.exports = {
  VERSION,
  textDigest,
  layoutProjection,
  layoutDigest,
  bindSemanticValidation,
  verifySemanticValidation,
  projectSemanticValidation,
  finalValidationWarnings
};
