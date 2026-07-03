'use strict';
const { splitSentences, splitParagraphs, shingleSet, jaccard, countOccurrences } = require('../analysis/textStats');
const { protectedTermLoss, termContextMap } = require('../analysis/protectedTerms');
const { scoreText, patterns } = require('../analysis/riskScorer');
const { analyzeSpeaker, speakerShift } = require('../analysis/speakerProfile');
const { blockize } = require('../length/blockizer');

function runGates({ sourceText, outputText, policy, protectedTerms, mode, sourceRisk, blocks, resultObject }) {
  const gates = [];
  const afterRisk = scoreText(outputText, policy);

  gates.push(protectedTermsGate(sourceText, outputText, protectedTerms));
  gates.push(grammarGate(outputText));
  gates.push(speakerGate(sourceText, outputText));
  gates.push(structureGate(sourceText, outputText));
  gates.push(styleRegressionGate(sourceRisk, afterRisk, policy));
  gates.push(effectiveChangeGate(sourceText, outputText, policy));
  gates.push(factRoleDriftGate(sourceText, outputText, protectedTerms));
  gates.push(newNounPhraseGate(sourceText, outputText, policy));
  gates.push(protocolGate({ mode, sourceBlocks: blocks, resultObject }));

  const hardFails = gates.filter(g => !g.pass && g.severity === 'hard');
  const softFails = gates.filter(g => !g.pass && g.severity !== 'hard');

  let status = 'done';
  if (hardFails.length) status = 'reverted_to_policy_safe';
  else if (softFails.some(g => g.name === 'effective_change')) status = 'done_low_effect';
  else if (softFails.some(g => g.name === 'surrogate_risk')) status = 'done_limited_risk_drop';
  else if (softFails.length) status = 'done_limited_effect';

  return { status, gates, hardFails, softFails, afterRisk };
}

function protectedTermsGate(before, after, terms) {
  const lost = protectedTermLoss(before, after, terms)
    // Some single numbers may disappear when spacing changes; only hard fail meaningful terms.
    .filter(t => t.length >= 2 && !/^\d+$/.test(t));
  return {
    name: 'protected_terms',
    pass: lost.length === 0,
    severity: 'hard',
    detail: lost.length ? { lost: lost.slice(0, 25) } : 'ok'
  };
}

function grammarGate(text) {
  const orphan = [];
  const re = /(?:^|[.!?。！？]\s+)(있으며|하고|하며|이며|이고|되는 한편|하는 한편),/g;
  let m;
  while ((m = re.exec(text))) orphan.push(m[1]);
  const dangling = (text.match(/\.\s*(있으며|하고|하며|이며),\s*(반대로|또한|그리고|다만)/g) || []);
  const bad = orphan.concat(dangling);
  return { name: 'grammar_quality', pass: bad.length === 0, severity: 'hard', detail: bad.length ? { orphanConnectives: bad } : 'ok' };
}

function speakerGate(before, after) {
  const reasons = speakerShift(analyzeSpeaker(before), analyzeSpeaker(after));
  return { name: 'speaker_lock', pass: reasons.length === 0, severity: 'hard', detail: reasons.length ? { reasons } : 'ok' };
}

function structureGate(before, after) {
  const b = blockize(before);
  const a = blockize(after);
  const headingBefore = b.filter(x => x.type === 'heading').map(x => x.text.trim());
  const lostHeadings = headingBefore.filter(h => !after.includes(h));
  const paraRatio = a.filter(x => x.type === 'paragraph').length / Math.max(1, b.filter(x => x.type === 'paragraph').length);
  const reasons = [];
  if (lostHeadings.length) reasons.push({ lostHeadings });
  if (b.length >= 8 && paraRatio < 0.65) reasons.push({ paragraphMergeRatio: paraRatio });
  return { name: 'structure_preservation', pass: reasons.length === 0, severity: 'hard', detail: reasons.length ? reasons : 'ok' };
}

function styleRegressionGate(beforeRisk, afterRisk, policy) {
  const b = beforeRisk.components;
  const a = afterRisk.components;
  const reasons = [];
  if (afterRisk.risk > beforeRisk.risk + policy.regression.maxRiskIncrease) reasons.push(['risk_increased', beforeRisk.risk, afterRisk.risk]);
  if (a.rhetorical > b.rhetorical + policy.regression.maxRhetoricalIncrease) reasons.push(['rhetorical_increased', b.rhetorical, a.rhetorical]);
  if (a.claimStrength > b.claimStrength + policy.regression.maxClaimStrengthIncrease) reasons.push(['claim_strength_increased', b.claimStrength, a.claimStrength]);
  if (a.formulaic > b.formulaic + policy.regression.maxFormulaicIncrease) reasons.push(['formulaic_increased', b.formulaic, a.formulaic]);
  if (a.abstractness > b.abstractness + policy.regression.maxAbstractIncrease) reasons.push(['abstractness_increased', b.abstractness, a.abstractness]);
  if (a.uniformity > b.uniformity + policy.regression.maxUniformityIncrease) reasons.push(['uniformity_increased', b.uniformity, a.uniformity]);
  const severity = reasons.some(r => ['risk_increased','rhetorical_increased','claim_strength_increased'].includes(r[0])) ? 'hard' : 'soft';
  return { name: 'surrogate_risk', pass: reasons.length === 0, severity, detail: reasons.length ? { reasons, before: beforeRisk.risk, after: afterRisk.risk } : { before: beforeRisk.risk, after: afterRisk.risk } };
}

function effectiveChangeGate(before, after, policy) {
  const bSent = splitSentences(before);
  const aSent = splitSentences(after);
  const bParas = splitParagraphs(before);
  const aParas = splitParagraphs(after);
  const sim = jaccard(shingleSet(before, 5), shingleSet(after, 5));
  const exact = new Set(bSent.map(s => s.replace(/\s+/g, '')));
  const carry = aSent.filter(s => exact.has(s.replace(/\s+/g, ''))).length;
  const exactCarryover = aSent.length ? carry / aSent.length : 1;
  const changedSentenceRatio = 1 - exactCarryover;
  let changedPara = 0;
  const bParaNorm = new Set(bParas.map(p => p.replace(/\s+/g, '')));
  for (const p of aParas) if (!bParaNorm.has(p.replace(/\s+/g, ''))) changedPara++;
  const changedParagraphRatio = aParas.length ? changedPara / aParas.length : 0;
  const lengthRatio = after.replace(/\s+/g, '').length / Math.max(1, before.replace(/\s+/g, '').length);
  const shingleChange = 1 - sim;

  const reasons = [];
  if (shingleChange < policy.effectiveChange.minCharShingleChange) reasons.push(['char_shingle_change_low', shingleChange]);
  if (changedSentenceRatio < policy.effectiveChange.minChangedSentenceRatio) reasons.push(['sentence_change_low', changedSentenceRatio]);
  if (changedParagraphRatio < policy.effectiveChange.minChangedParagraphRatio && bParas.length >= 3) reasons.push(['paragraph_change_low', changedParagraphRatio]);
  if (exactCarryover > policy.effectiveChange.maxExactSentenceCarryoverRatio) reasons.push(['exact_sentence_carryover_high', exactCarryover]);
  if (lengthRatio > policy.effectiveChange.maxLengthRatio) reasons.push(['length_expanded_too_much', lengthRatio]);
  if (lengthRatio < policy.effectiveChange.minLengthRatio) reasons.push(['length_compressed_too_much', lengthRatio]);
  return { name: 'effective_change', pass: reasons.length === 0, severity: 'soft', detail: reasons.length ? { reasons, shingleChange, changedSentenceRatio, changedParagraphRatio, exactCarryover, lengthRatio } : { shingleChange, changedSentenceRatio, changedParagraphRatio, exactCarryover, lengthRatio } };
}

function factRoleDriftGate(before, after, terms) {
  const sourceSentences = splitSentences(before);
  const afterSentences = splitSentences(after);
  const causal = /(덕분|때문|통해|으로 인해|함으로써|기여|줄|낮추|높이|최소화|예방|확보|개선|강화|확대|만든다|이어진다)/;
  const termPairsInSource = new Set();
  for (const s of sourceSentences) {
    const present = terms.filter(t => t.length >= 3 && s.includes(t)).slice(0, 10);
    for (let i = 0; i < present.length; i++) for (let j = i + 1; j < present.length; j++) {
      termPairsInSource.add(pairKey(present[i], present[j]));
    }
  }
  const suspicious = [];
  for (const s of afterSentences) {
    if (!causal.test(s)) continue;
    const present = terms.filter(t => t.length >= 3 && s.includes(t)).slice(0, 10);
    for (let i = 0; i < present.length; i++) for (let j = i + 1; j < present.length; j++) {
      const key = pairKey(present[i], present[j]);
      if (!termPairsInSource.has(key)) suspicious.push({ pair: key, sentence: s.slice(0, 180) });
    }
  }
  // Avoid over-triggering: only fail if a sentence creates multiple new causal pairings.
  const fail = suspicious.length >= 1;
  return { name: 'fact_role_drift', pass: !fail, severity: 'hard', detail: fail ? { suspicious: suspicious.slice(0, 8) } : 'ok' };
}

function pairKey(a, b) { return [a, b].sort().join(' ↔ '); }

function newNounPhraseGate(before, after, policy) {
  const extract = t => new Set((t.match(/[가-힣A-Za-z0-9]+(?:\s+[가-힣A-Za-z0-9]+){0,3}\s*(?:구성|단서|경계|목적|위력|영역|방향|구조|문제|효과|가치|기능|역할|전략|경험|사례)/g) || []).map(x => x.trim()));
  const b = extract(before);
  const a = extract(after);
  const added = [...a].filter(x => !b.has(x));
  const ratio = added.length / Math.max(1, a.size);
  return { name: 'new_noun_phrase_budget', pass: ratio <= policy.regression.maxNewNounPhraseRatio, severity: ratio > policy.regression.maxNewNounPhraseRatio * 1.5 ? 'hard' : 'soft', detail: ratio <= policy.regression.maxNewNounPhraseRatio ? { ratio } : { ratio, added: added.slice(0, 15) } };
}

function protocolGate({ mode, sourceBlocks, resultObject }) {
  if (mode === 'block_locked_single_call') {
    const blocks = Array.isArray(resultObject.blocks) ? resultObject.blocks : [];
    const reasons = [];
    if (blocks.length !== sourceBlocks.length) reasons.push(['block_count_changed', sourceBlocks.length, blocks.length]);
    for (let i = 0; i < Math.min(blocks.length, sourceBlocks.length); i++) {
      if (blocks[i].id !== sourceBlocks[i].id) reasons.push(['block_order_or_id_changed', i, sourceBlocks[i].id, blocks[i].id]);
      if (sourceBlocks[i].type === 'heading' && blocks[i].text !== sourceBlocks[i].text) reasons.push(['heading_changed', sourceBlocks[i].id]);
    }
    return { name: 'block_protocol', pass: reasons.length === 0, severity: 'hard', detail: reasons.length ? { reasons } : 'ok' };
  }
  if (mode === 'patch_single_call') {
    const patches = Array.isArray(resultObject.patches) ? resultObject.patches : [];
    const sourceIds = new Set(sourceBlocks.map(b => b.id));
    const seen = new Set();
    const invalid = [];
    for (const p of patches) {
      if (!sourceIds.has(p.id)) invalid.push(['invalid_patch_id', p.id]);
      if (seen.has(p.id)) invalid.push(['duplicate_patch_id', p.id]);
      seen.add(p.id);
    }
    return { name: 'patch_protocol', pass: invalid.length === 0, severity: 'hard', detail: invalid.length ? { invalid } : 'ok' };
  }
  return { name: 'protocol', pass: true, severity: 'soft', detail: 'ok' };
}

module.exports = { runGates };
