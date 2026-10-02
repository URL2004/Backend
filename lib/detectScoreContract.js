'use strict';

// Provider units are never guessed: 0 and 1 are valid scores, .43 is not 43.
const VERSION = 'detect-score-contract-v1';
function scoreContract(value) {
  const reason = typeof value !== 'number' || !Number.isFinite(value) ? 'not_finite_number'
    : value < 0 || value > 100 ? 'outside_range'
      : !Number.isInteger(value) ? 'non_integer' : null;
  return { valid: reason === null, reason };
}
function assertScore(value) {
  const contract = scoreContract(value);
  if (!contract.valid) throw Object.assign(new Error('DETECT_SCORE_CONTRACT'), {
    code: 'DETECT_SCORE_CONTRACT', scoreContractReason: contract.reason
  });
  return value;
}
module.exports = { VERSION, scoreContract, assertScore };
