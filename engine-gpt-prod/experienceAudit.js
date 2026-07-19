'use strict';

const surfaceguard = require('../engine/surfaceguard');

const VERSION = 1;
const FIRST_PERSON = /(?:^|[^가-힣A-Za-z0-9_])(?:나는|내가|나의|나도|나를|저는|제가|저의|저도|저를|우리는|우리가|우리의|저희는|저희가)(?=$|[^가-힣A-Za-z0-9_])/gu;
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
  return {
    firstPerson: count(value, FIRST_PERSON),
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
