'use strict';

const { charCounts } = require('./checks');

const NON_CONTENT_CATEGORIES = new Set(['prompt', 'constraint', 'policy']);
const MAX_PROJECTION_UNITS = 48;

function measuredLength(text, mode) {
  const counts = charCounts(text);
  if (mode === 'no_space') return counts.noSpace;
  if (mode === 'byte2') return counts.byte2;
  return counts.withSpace;
}

function contentFacts(ledger) {
  return (ledger?.facts || []).filter(fact =>
    !fact.categories.some(category => NON_CONTENT_CATEGORIES.has(category))
  );
}

function splitVerbatim(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  const parts = text
    .split(/\n+|(?<=[.!?。！？])\s+/gu)
    .map(part => part.trim())
    .filter(Boolean);
  return parts.length ? parts : [text];
}

function unitUtility(fact, segment) {
  const importance = fact.importance === 'core' ? 1_000 : fact.importance === 'helpful' ? 300 : 100;
  return importance + Math.min(200, Array.from(segment).length);
}

function betterState(next, current) {
  if (!current) return true;
  if (next.utility !== current.utility) return next.utility > current.utility;
  if (next.labelCount !== current.labelCount) return next.labelCount < current.labelCount;
  return next.selected.length < current.selected.length;
}

function buildDeterministicProjection(prepared, targetChars) {
  const facts = contentFacts(prepared?.ledger);
  const mode = prepared?.input?.charLimitMode || 'with_space';
  const target = Math.max(1, Number(targetChars) || 0);
  if (!facts.length || !target) return null;

  const requiredFacts = facts.filter(fact => fact.importance === 'core' || fact.categories.includes('disclosure'));
  if (requiredFacts.length > 20) return null;
  const requiredBits = new Map(requiredFacts.map((fact, index) => [fact.id, 1 << index]));
  const requiredMask = requiredFacts.reduce((mask, fact) => mask | requiredBits.get(fact.id), 0);
  const separator = '\n\n';
  const separatorCost = measuredLength(separator, mode);
  const minimum = Math.ceil(target * 0.88);
  const maximum = target;
  const maxCost = maximum + separatorCost;

  const units = [];
  for (const fact of facts) {
    for (const segment of splitVerbatim(fact.value)) {
      units.push({ fact, segment });
      if (units.length >= MAX_PROJECTION_UNITS) break;
    }
    if (units.length >= MAX_PROJECTION_UNITS) break;
  }

  let states = new Map([['0|0', { cost: 0, mask: 0, utility: 0, labelCount: 0, selected: [] }]]);
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    const variants = [
      { text: unit.segment, labeled: false },
      { text: `${unit.fact.label}\n${unit.segment}`, labeled: true }
    ];
    const nextStates = new Map(states);
    for (const state of states.values()) {
      for (const variant of variants) {
        const cost = state.cost + measuredLength(variant.text, mode) + separatorCost;
        if (cost > maxCost) continue;
        const mask = state.mask | (requiredBits.get(unit.fact.id) || 0);
        const candidate = {
          cost,
          mask,
          utility: state.utility + unitUtility(unit.fact, unit.segment) - (variant.labeled ? 1 : 0),
          labelCount: state.labelCount + (variant.labeled ? 1 : 0),
          selected: [...state.selected, { ...unit, ...variant }]
        };
        const key = `${cost}|${mask}`;
        if (betterState(candidate, nextStates.get(key))) nextStates.set(key, candidate);
      }
    }
    states = nextStates;
  }

  const desired = Math.max(minimum, Math.floor(target * 0.96));
  const feasible = [...states.values()]
    .filter(state => {
      const length = state.cost - separatorCost;
      return state.selected.length > 0 && state.mask === requiredMask && length >= minimum && length <= maximum;
    })
    .sort((a, b) => {
      const distance = Math.abs((a.cost - separatorCost) - desired) - Math.abs((b.cost - separatorCost) - desired);
      if (distance) return distance;
      if (a.utility !== b.utility) return b.utility - a.utility;
      if (a.labelCount !== b.labelCount) return a.labelCount - b.labelCount;
      return a.selected.length - b.selected.length;
    });
  const selected = feasible[0]?.selected;
  if (!selected?.length) return null;

  const usedFactIds = [...new Set(selected.map(item => item.fact.id))];
  const structured = {
    paragraphs: selected.map(item => ({
      sentences: [{
        text: item.text,
        kind: item.fact.kind === 'opinion' ? 'opinion' : 'fact',
        factRefs: [item.fact.id]
      }]
    })),
    omittedFactIds: facts.filter(fact => !usedFactIds.includes(fact.id)).map(fact => fact.id),
    followupQuestions: []
  };
  const proof = proveDeterministicProjection(structured, prepared.ledger);
  return proof.pass ? { structured, proof } : null;
}

function proveDeterministicProjection(structured, ledger) {
  const facts = new Map(contentFacts(ledger).map(fact => [fact.id, fact]));
  const rows = (structured?.paragraphs || []).flatMap(paragraph => paragraph?.sentences || []);
  if (!rows.length) return { pass: false, code: 'NO_PROJECTION_ROWS' };
  const factIds = [];
  for (const row of rows) {
    const refs = Array.isArray(row?.factRefs) ? row.factRefs : [];
    if (refs.length !== 1 || !facts.has(refs[0])) return { pass: false, code: 'INVALID_PROJECTION_REF' };
    const fact = facts.get(refs[0]);
    const text = String(row.text || '').trim();
    const prefix = `${fact.label}\n`;
    const segment = text.startsWith(prefix) ? text.slice(prefix.length).trim() : text;
    if (!segment || !String(fact.value).includes(segment)) return { pass: false, code: 'NON_VERBATIM_PROJECTION' };
    factIds.push(fact.id);
  }
  return {
    pass: true,
    proof: 'verbatim_fact_projection_v1',
    factIds: [...new Set(factIds)]
  };
}

module.exports = {
  NON_CONTENT_CATEGORIES,
  buildDeterministicProjection,
  proveDeterministicProjection
};
