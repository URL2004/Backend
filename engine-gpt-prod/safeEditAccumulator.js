'use strict';

const {
  splitSentenceSpans,
  levenshteinDistance
} = require('../engine/koreanText');
const { alignSourceSentence, sentenceSimilarity } = require('./sentenceAlignment');
const humanizationDepth = require('./humanizationDepth');

const VERSION = 1;
const MIN_ALIGNMENT_SCORE = 0.34;
const MIN_SUBSTANTIVE_DISTANCE = 3;
const MIN_SUBSTANTIVE_RATIO = 0.055;

/**
 * A model recovery can contain ten useful sentence rewrites and one unsafe
 * rewrite. Rejecting the whole document loses every useful edit and causes the
 * final result to collapse back to a light polish. This accumulator applies
 * each aligned sentence proposal to the last accepted draft and keeps only
 * proposals that pass the document-level safety validator and move the depth
 * report forward.
 *
 * The validator still sees the complete document. Sentence-level acceptance
 * therefore does not weaken number, POV, quote, legal, structure, or semantic
 * guards.
 */
function accumulateSafeEdits({
  source = '',
  current = '',
  candidate = '',
  plan = null,
  currentReport = null,
  validateCandidate = null,
  evaluateDepth = null,
  maxApplied = 24
} = {}) {
  const before = String(current || '');
  const proposed = String(candidate || '');
  const depthFor = typeof evaluateDepth === 'function'
    ? evaluateDepth
    : value => humanizationDepth.evaluateHumanizationDepth(source, value, plan);
  const validate = typeof validateCandidate === 'function'
    ? validateCandidate
    : () => ({ pass: true, codes: [] });
  const proposals = buildSentenceProposals(before, proposed);
  let accepted = [];
  let output = before;
  let report = currentReport || depthFor(before);
  const rejectedCodes = [];
  const rejected = [];

  for (const proposal of proposals.slice(0, Math.max(1, Number(maxApplied) || 24))) {
    const trialAccepted = [...accepted, proposal].sort((left, right) => left.currentStart - right.currentStart);
    const trial = applyProposalSet(before, trialAccepted);
    if (!trial || normalizeSubstantive(trial) === normalizeSubstantive(output)) continue;
    const validation = normalizeValidation(validate(trial, {
      proposal,
      accepted: trialAccepted,
      previousOutput: output
    }));
    if (!validation.pass) {
      addCodes(rejectedCodes, validation.codes);
      rejected.push({ currentIndex: proposal.currentIndex, codes: validation.codes });
      continue;
    }
    const trialReport = depthFor(trial);
    if (!isMonotonicDepthGain(report, trialReport)) {
      addCodes(rejectedCodes, ['partial_depth_not_improved']);
      rejected.push({ currentIndex: proposal.currentIndex, codes: ['partial_depth_not_improved'] });
      continue;
    }
    accepted = trialAccepted;
    output = trial;
    report = trialReport;
  }

  return {
    version: VERSION,
    applied: accepted.length > 0,
    outputText: output,
    report,
    proposalCount: proposals.length,
    appliedCount: accepted.length,
    rejectedCount: rejected.length,
    rejectedCodes,
    appliedSentenceIndices: accepted.map(item => item.currentIndex),
    rejected
  };
}

function buildSentenceProposals(current, candidate) {
  const currentSpans = splitSentenceSpans(String(current || ''));
  const candidateSpans = splitSentenceSpans(String(candidate || ''));
  if (!currentSpans.length || !candidateSpans.length) return [];
  const proposals = [];
  const usedCandidateRanges = [];

  if (currentSpans.length === candidateSpans.length) {
    for (let index = 0; index < currentSpans.length; index += 1) {
      addProposal(proposals, currentSpans, candidateSpans, index, index, index + 1);
    }
    return prioritizeProposals(proposals);
  }

  let minimumCandidateStart = 0;
  const candidateTexts = candidateSpans.map(item => item.text);
  for (let index = 0; index < currentSpans.length; index += 1) {
    const alignment = alignSourceSentence(
      currentSpans[index].text,
      index,
      currentSpans.length,
      candidateTexts,
      { window: 4, maxOutputGroup: 2 }
    );
    const options = (alignment?.candidates || [])
      .filter(item => item.score >= MIN_ALIGNMENT_SCORE)
      .filter(item => item.start >= minimumCandidateStart)
      .filter(item => !usedCandidateRanges.some(range => overlaps(range, item)))
      .sort((left, right) => right.score - left.score || left.start - right.start);
    const selected = options[0];
    if (!selected) continue;
    const added = addProposal(
      proposals,
      currentSpans,
      candidateSpans,
      index,
      selected.start,
      selected.end,
      selected.score
    );
    if (added) {
      usedCandidateRanges.push({ start: selected.start, end: selected.end });
      minimumCandidateStart = selected.end;
    }
  }
  return prioritizeProposals(proposals);
}

function addProposal(proposals, currentSpans, candidateSpans, currentIndex, candidateStart, candidateEnd, alignmentScore = null) {
  const currentSpan = currentSpans[currentIndex];
  const selected = candidateSpans.slice(candidateStart, candidateEnd);
  if (!currentSpan || !selected.length) return false;
  const replacement = selected.length === 1
    ? selected[0].text
    : selected.map(item => item.text).join(' ');
  const change = substantiveChange(currentSpan.text, replacement);
  const score = alignmentScore == null
    ? sentenceSimilarity(currentSpan.text, replacement)
    : alignmentScore;
  if (!change.substantive || score < MIN_ALIGNMENT_SCORE) return false;
  proposals.push({
    currentIndex,
    currentStart: currentSpan.start,
    currentEnd: currentSpan.end,
    currentText: currentSpan.text,
    replacement,
    candidateStart,
    candidateEnd,
    alignmentScore: round4(score),
    substantiveRatio: round4(change.ratio),
    substantiveDistance: change.distance
  });
  return true;
}

function prioritizeProposals(values) {
  return [...values].sort((left, right) => (
    right.substantiveRatio - left.substantiveRatio
      || right.alignmentScore - left.alignmentScore
      || left.currentIndex - right.currentIndex
  ));
}

function applyProposalSet(current, proposals) {
  const source = String(current || '');
  const ordered = [...(proposals || [])].sort((left, right) => left.currentStart - right.currentStart);
  let cursor = 0;
  let output = '';
  for (const proposal of ordered) {
    if (proposal.currentStart < cursor || proposal.currentEnd < proposal.currentStart) continue;
    output += source.slice(cursor, proposal.currentStart);
    output += proposal.replacement;
    cursor = proposal.currentEnd;
  }
  return output + source.slice(cursor);
}

function substantiveChange(left, right) {
  const from = normalizeSubstantive(left);
  const to = normalizeSubstantive(right);
  const distance = levenshteinDistance(from, to);
  const ratio = distance / Math.max(1, from.length, to.length);
  return {
    distance,
    ratio,
    substantive: distance >= MIN_SUBSTANTIVE_DISTANCE && ratio >= MIN_SUBSTANTIVE_RATIO
  };
}

function isMonotonicDepthGain(current, candidate) {
  if (!candidate?.applicable || candidate.metrics?.trivialOnly) return false;
  if (candidate.pass === true && current?.pass !== true) return true;
  const before = current?.metrics || {};
  const after = candidate.metrics || {};
  const beforeScore = humanizationDepth.humanizationCandidateScore(current);
  const afterScore = humanizationDepth.humanizationCandidateScore(candidate);
  if (afterScore + 0.006 < beforeScore) return false;
  if (number(after.substantiveEditRatio) + 0.002 < number(before.substantiveEditRatio)) return false;
  if (number(after.substantiveChangedSentenceCount) < number(before.substantiveChangedSentenceCount)) return false;
  if (number(after.effectiveStructuralChangedSentenceCount ?? after.structurallyChangedSentenceCount)
      < number(before.effectiveStructuralChangedSentenceCount ?? before.structurallyChangedSentenceCount)) return false;
  if (number(after.targetChangedCount) < number(before.targetChangedCount)) return false;
  const improved = afterScore >= beforeScore + 0.002
    || number(after.substantiveEditRatio) >= number(before.substantiveEditRatio) + 0.002
    || number(after.substantiveChangedSentenceCount) > number(before.substantiveChangedSentenceCount)
    || number(after.effectiveStructuralChangedSentenceCount ?? after.structurallyChangedSentenceCount)
      > number(before.effectiveStructuralChangedSentenceCount ?? before.structurallyChangedSentenceCount)
    || number(after.targetChangedCount) > number(before.targetChangedCount)
    || number(after.targetChangedParagraphCount) > number(before.targetChangedParagraphCount)
    || number(after.remediation?.achievedReduction) > number(before.remediation?.achievedReduction)
    || number(after.resumeRepetition?.achievedReduction) > number(before.resumeRepetition?.achievedReduction);
  return improved;
}

function normalizeValidation(value) {
  if (value === true) return { pass: true, codes: [] };
  if (value === false || value == null) return { pass: false, codes: ['partial_safety_audit_failed'] };
  return {
    pass: value.pass === true,
    codes: [...new Set((value.codes || value.reasons || [])
      .map(item => String(item || '').trim())
      .filter(Boolean))]
  };
}

function addCodes(target, values) {
  for (const value of values || []) {
    const code = String(value || '').trim();
    if (code && !target.includes(code)) target.push(code);
  }
}

function overlaps(left, right) {
  return left.start < right.end && right.start < left.end;
}

function normalizeSubstantive(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, '');
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round4(value) {
  return Math.round(number(value) * 10000) / 10000;
}

module.exports = {
  VERSION,
  MIN_ALIGNMENT_SCORE,
  accumulateSafeEdits,
  buildSentenceProposals,
  applyProposalSet,
  substantiveChange,
  isMonotonicDepthGain
};
