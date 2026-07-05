'use strict';

const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(__dirname, 'python', 'layout_nlp.py');
const PY_TARGET = path.join(ROOT, '.python-packages');

async function runLayoutNlp(text, opts = {}) {
  const payload = {
    text: String(text || ''),
    needsSpacingRepair: opts.needsSpacingRepair === true,
    maxChars: Math.max(500, Math.min(12000, Number(opts.maxChars || 6000) || 6000))
  };
  const candidates = pythonCandidates();
  const attempts = [];
  for (const cmd of candidates) {
    const res = await tryPython(cmd, payload, opts);
    attempts.push({ command: cmd.command, ok: res.ok, error: res.error || '' });
    if (res.ok) return { ...res, attempts };
  }
  return {
    ok: false,
    error: attempts.map(a => `${a.command}:${a.error || 'failed'}`).join('; '),
    attempts,
    engines: unavailableEngines('python_unavailable')
  };
}

function pythonCandidates() {
  const env = process.env.LAYOUT_NLP_PYTHON || process.env.PYTHON || '';
  const out = [];
  if (env) out.push({ command: env, args: [] });
  out.push({ command: 'python3', args: [] });
  out.push({ command: 'python', args: [] });
  if (process.platform === 'win32') out.push({ command: 'py', args: ['-3'] });
  const seen = new Set();
  return out.filter(c => {
    const key = [c.command, ...(c.args || [])].join(' ');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tryPython(cmd, payload, opts = {}) {
  return new Promise(resolve => {
    const timeoutMs = Math.max(1200, Math.min(12000, Number(opts.timeoutMs || process.env.LAYOUT_NLP_TIMEOUT_MS || 5000) || 5000));
    let stdout = '';
    let stderr = '';
    let settled = false;
    const env = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONPATH: [PY_TARGET, process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter)
    };
    let child;
    try {
      child = spawn(cmd.command, [...(cmd.args || []), SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env
      });
    } catch (err) {
      return resolve({ ok: false, error: err && err.message || String(err) });
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: err && err.message || String(err) });
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        return resolve({ ok: false, error: stderr.trim() || `exit_${code}` });
      }
      try {
        const json = JSON.parse(stdout.trim());
        return resolve({ ...json, ok: json.ok === true });
      } catch (err) {
        return resolve({ ok: false, error: err && err.message || String(err), stderr: stderr.slice(-500) });
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function unavailableEngines(error) {
  return {
    kss: { ok: false, engine: 'kss', error },
    kiwipiepy: { ok: false, engine: 'kiwipiepy', error },
    pykospacing: { ok: false, engine: 'pykospacing', error }
  };
}

module.exports = {
  runLayoutNlp,
  PY_TARGET
};
