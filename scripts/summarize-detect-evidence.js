'use strict';
const fs = require('node:fs');
const { summarizeEvents } = require('../lib/detectEvidenceMonitoring');
const [input, output] = process.argv.slice(2);
if (!input || !output) throw Error('Usage: node scripts/summarize-detect-evidence.js local-events.jsonl local-summary.json');
const content = fs.readFileSync(input, 'utf8').trim();
const events = content.startsWith('[') ? JSON.parse(content) : content.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
fs.writeFileSync(output, JSON.stringify(summarizeEvents(events), null, 2), { flag: 'wx' });
