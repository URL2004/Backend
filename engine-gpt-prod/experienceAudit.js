'use strict';

const surfaceguard = require('../engine/surfaceguard');
const { computePovSeed } = require('../engine/pov');

const VERSION = 1;
const TIME_MARKER = /(?:^|[^가-힣A-Za-z0-9_])(?:그때|당시|어느\s*날|지난해|작년|올해|그날|그\s*후|이후|처음으로|학창\s*시절|근무\s*당시)(?=$|[^가-힣A-Za-z0-9_])/gu;
const LIVED_ACTION = /(?:방문|참여|근무|만나|겪|느꼈|깨달|배웠|담당|수행|제작|개발|조사|발표|협업|해결|실수|도전|시도|경험했|목격|인터뷰)/gu;

function detectExperienceCandidate(source, output, allowedExtra = '') {
  const before = String(source || '');
  const after = String(output || '');
  let legacy = { count: 0, items: [] };
  try {
    legacy = surfaceguard.measurePersonalExperienceNovelty(before, after, allowedExtra) || legacy;
  } catch {}
  const sourceSignals = signalCounts(before);
  const outputSignals = signalCounts(after);
  const introduced = {
    firstPerson: Math.max(0, outputSignals.firstPerson - sourceSignals.firstPerson),
    time: Math.max(0, outputSignals.time - sourceSignals.time),
    action: Math.max(0, outputSignals.action - sourceSignals.action)
  };
  const candidate = introduced.firstPerson > 0
    && introduced.time > 0
    && introduced.action > 0;
  return {
    version: VERSION,
    candidate,
    candidateCount: candidate ? Math.max(1, Number(legacy.count || 0)) : 0,
    legacyCount: Number(legacy.count || 0),
    introduced,
    sourceSignals,
    outputSignals
  };
}

function signalCounts(value) {
  const pov = computePovSeed(value);
  return {
    firstPerson: pov.fp_singular + pov.fp_plural,
    time: count(value, TIME_MARKER),
    action: count(value, LIVED_ACTION)
  };
}

function count(value, pattern) {
  pattern.lastIndex = 0;
  return (String(value || '').match(pattern) || []).length;
}

module.exports = {
  VERSION,
  detectExperienceCandidate,
  signalCounts
};
