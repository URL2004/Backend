'use strict';

const { db } = require('../config');
const {
  DEFAULT_MAX_EVENTS,
  MAX_WINDOW_MS,
  aggregateSignupCreditEvents,
  scanSignupCreditEvents
} = require('../lib/signupCreditMonitoring');

function parseArguments(argv) {
  const options = { json: false, maxEvents: DEFAULT_MAX_EVENTS, nowMs: Date.now() };
  for (const argument of argv) {
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument.startsWith('--max-events=')) {
      const value = Number(argument.slice('--max-events='.length));
      if (!Number.isInteger(value) || value < 1 || value > 100_000) {
        throw new Error('--max-events must be an integer from 1 to 100000');
      }
      options.maxEvents = value;
      continue;
    }
    if (argument.startsWith('--now=')) {
      const value = Date.parse(argument.slice('--now='.length));
      if (!Number.isFinite(value)) throw new Error('--now must be an ISO-8601 timestamp');
      options.nowMs = value;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function formatCohort(label, cohort) {
  return [
    `${label}: accounts=${cohort.accounts}`,
    `any_use=${cohort.anyUse.accounts} (${(cohort.anyUse.rate * 100).toFixed(1)}%)`,
    `first_use_median=${cohort.firstUse.medianMinutes ?? '-'}m`,
    `first_use_p90=${cohort.firstUse.p90Minutes ?? '-'}m`,
    `remaining<=1=${cohort.remainingAtOrBelowOne.accounts} (${(cohort.remainingAtOrBelowOne.rate * 100).toFixed(1)}%)`,
    `zero=${cohort.exhausted.accounts} (${(cohort.exhausted.rate * 100).toFixed(1)}%)`,
    `detect_humanize_18=${cohort.detectHumanize18.accounts} (${(cohort.detectHumanize18.rate * 100).toFixed(1)}%)`,
    `principal_max=${cohort.principalQuota.maxAccountsPerPrincipal.hourly}/h,${cohort.principalQuota.maxAccountsPerPrincipal.daily}/d`
  ].join(' | ');
}

function formatReport(summary) {
  return [
    `signup credit report: status=${summary.status} events=${summary.validEvents}/${summary.scannedEvents} generated=${summary.generatedAt}`,
    formatCohort('24h', summary.cohorts.hours24),
    formatCohort('7d', summary.cohorts.days7),
    `balance buckets (7d): ${Object.entries(summary.cohorts.days7.balanceBuckets).map(([key, value]) => `${key}=${value}`).join(', ')}`,
    `threshold buckets (7d): soft=${summary.cohorts.days7.principalQuota.soft.hourly.bucketsAtOrAbove}/h,${summary.cohorts.days7.principalQuota.soft.daily.bucketsAtOrAbove}/d hard=${summary.cohorts.days7.principalQuota.hard.hourly.bucketsAtOrAbove}/h,${summary.cohorts.days7.principalQuota.hard.daily.bucketsAtOrAbove}/d`
  ].join('\n');
}

async function main({
  database = db,
  argv = process.argv.slice(2),
  write = value => console.log(value),
  writeError = value => console.error(value)
} = {}) {
  try {
    const options = parseArguments(argv);
    const scan = await scanSignupCreditEvents({
      db: database,
      sinceMs: options.nowMs - MAX_WINDOW_MS,
      limit: options.maxEvents
    });
    const summary = aggregateSignupCreditEvents(scan.events, {
      nowMs: options.nowMs,
      source: scan.source,
      truncated: scan.truncated,
      scanned: scan.scanned
    });
    write(options.json ? JSON.stringify(summary, null, 2) : formatReport(summary));
    return { exitCode: 0, summary };
  } catch (error) {
    writeError(`signup credit report failed: ${error?.code || error?.message || 'unknown error'}`);
    return { exitCode: 1, summary: null };
  }
}

if (require.main === module) {
  main().then(result => {
    process.exitCode = result.exitCode;
  });
}

module.exports = { formatReport, main, parseArguments };
