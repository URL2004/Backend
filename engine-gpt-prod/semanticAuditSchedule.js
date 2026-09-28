'use strict';
function planVerdictPairs(source, output, pairs, allowRepair = true) {
  if (allowRepair !== false || pairs.length <= 2
      || Math.max(source.length, output.length) > 12000
      || !pairs.every(p => p.alignment === 'shared_unique_heading')) return pairs;
  // A three-section queue leaves its last request only the remainder of the
  // same final deadline. Two complete heading-owned windows can start together.
  // Never invent a cut, cross uncertain ownership or exceed the ordinary
  // 6,000-character whole-document envelope already used by the audit.
  const balanced = require('./reviewAlignment').alignedReviewPairs(source, output, 6000);
  return balanced.length === 2
    && balanced.every(p => p.alignment === 'shared_unique_heading'
      && Math.max(p.sourceContext.length, p.output.length) <= 6000)
    && balanced.map(p => p.sourceContext).join('') === source
    && balanced.map(p => p.output).join('') === output ? balanced : pairs;
}
function scheduleReviewPairs(pairs, allowRepair = true) {
  const rows = pairs.map((pair, index) => ({ pair, index }));
  return allowRepair === false ? rows.sort((a, b) =>
    (b.pair.sourceContext.length + b.pair.output.length)
      - (a.pair.sourceContext.length + a.pair.output.length) || a.index - b.index) : rows;
}
module.exports = { scheduleReviewPairs, planVerdictPairs };
