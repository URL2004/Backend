'use strict';
const fs = require('node:fs');
const { buildGrowthReport } = require('../lib/growthMeasurement');
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node scripts/growth-report.js input.local.json output.local.json');
const report = buildGrowthReport(JSON.parse(fs.readFileSync(input, 'utf8')));
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, matureLoginAttempts: report.auth?.mature ?? null,
  purchaseDifferences: report.purchases?.differenceCount ?? null, adCampaigns: report.ads?.rows.length ?? null }));
