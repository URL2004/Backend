// llm/localRuns.js - local-only JSONL telemetry for Gemini routing experiments.

const fs = require('fs');
const path = require('path');

function shouldWrite() {
  return process.env.LLM_BACKEND === 'gemini' || process.env.LLM_SHADOW_MODE === '1';
}

function safeRecord(record) {
  const out = { ...record };
  delete out.system;
  delete out.user;
  delete out.prompt;
  delete out.text;
  delete out.outputText;
  if (out.error) out.error = String(out.error).slice(0, 500);
  return out;
}

function write(record) {
  if (!shouldWrite()) return;
  try {
    const dir = path.join(__dirname, '..', 'results', 'gemini-local-runs');
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `${day}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...safeRecord(record) }) + '\n', 'utf8');
  } catch (_) {
    // Local telemetry must never affect user-facing results.
  }
}

module.exports = { write };
