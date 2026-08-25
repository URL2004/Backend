'use strict';

// 이미 성공한 Writing Lab 작업을 기존 휴머나이징 엔진에 연결한 뒤 같은
// 서명 원장으로 최종 검사한다. 토큰은 메모리에서만 사용하고 결과 파일에 저장하지 않는다.

const fs = require('node:fs');
const path = require('node:path');

const reportPath = path.resolve(process.argv[2]);
const outputPath = path.resolve(process.argv[3]);
const jobBase = String(process.env.WRITING_LAB_JOB_BASE_URL || 'http://127.0.0.1:3101').replace(/\/$/u, '');
const chainBase = String(process.env.WRITING_LAB_CHAIN_BASE_URL || 'http://127.0.0.1:3102').replace(/\/$/u, '');
const wanted = new Set(String(process.env.WRITING_LAB_HUMANIZE_IDS || 'resume_dense,review_dense').split(',').map(v => v.trim()).filter(Boolean));
const requestedMode = String(process.env.WRITING_LAB_HUMANIZE_MODE || 'auto').trim();

function humanizeModeFor(generation) {
  if (['blog', 'polish'].includes(requestedMode)) return requestedMode;
  return ['resume', 'general'].includes(generation.genre) ? 'polish' : 'blog';
}

async function request(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: response.status, data };
}

async function poll(jobId) {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const response = await request(chainBase, `/transform/${encodeURIComponent(jobId)}`);
    if (response.data?.status === 'done' || ['blocked', 'error', 'cancelled'].includes(response.data?.status) || response.status >= 400) return response;
  }
  return { status: 408, data: { status: 'timeout' } };
}

async function runChain(record) {
  const recovered = await request(jobBase, `/writing-lab/v2/jobs/${encodeURIComponent(record.requestId)}`);
  const generation = recovered.data || {};
  if (recovered.status !== 200 || !generation.draft || !generation.verificationToken) {
    return { id: record.id, state: 'generation_recovery_failed', httpStatus: recovered.status, code: generation.code || '' };
  }
  const startedAt = Date.now();
  const transformMode = humanizeModeFor(generation);
  const start = await request(chainBase, '/transform', {
    method: 'POST',
    body: JSON.stringify({
      text: generation.draft,
      mode: transformMode,
      basicStyle: generation.humanize?.basicStyle || 'report',
      memo: [
        '아래 사실 원장의 범위만 사용하세요. 새 사실·행동·순서·수치·평가를 만들지 말고 원래 분량을 유지하세요.',
        String(generation.factsheet || '')
      ].join('\n').slice(0, 2000),
      documentProfile: generation.humanize?.documentProfile || '',
      lang: 'ko', evidence: false, length: 'keep', effectNoticeAccepted: true,
      adminHumanizeLab: true, adminLabProfile: 'gpt_engine', humanizeExperiment: true
    })
  });
  if (start.status !== 200 || !start.data?.jobId) {
    return { id: record.id, state: 'transform_start_failed', httpStatus: start.status, error: start.data?.error || start.data?.code || '' };
  }
  const completed = await poll(start.data.jobId);
  const outputText = completed.data?.result?.outputText || '';
  if (completed.data?.status !== 'done' || !outputText) {
    return {
      id: record.id, state: completed.data?.status || 'transform_failed', httpStatus: completed.status,
      error: completed.data?.error || completed.data?.reason || '', elapsedMs: Date.now() - startedAt
    };
  }
  const checked = await request(chainBase, '/writing-lab/v2/finalize', {
    method: 'POST',
    body: JSON.stringify({ text: outputText, verificationToken: generation.verificationToken })
  });
  const deliveredText = checked.data?.text || '';
  return {
    id: record.id,
    state: 'done',
    inputLength: Array.from(generation.draft).length,
    outputLength: Array.from(outputText).length,
    outputText,
    transformMode,
    transformEngineVersion: completed.data?.result?.engineVersion || completed.data?.engineVersion || '',
    qualityWarning: completed.data?.result?.qualityWarning || null,
    checkHttpStatus: checked.status,
    humanizedRelease: checked.data?.attempts?.[0] || null,
    finalRelease: checked.data?.release || null,
    finalChecks: checked.data?.checks || null,
    deliveredText,
    deliveredLength: Array.from(deliveredText).length,
    delivery: checked.data?.delivery || null,
    finalizationAttempts: checked.data?.attempts || [],
    elapsedMs: Date.now() - startedAt
  };
}

async function main() {
  const source = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const records = (source.generations || []).filter(record => wanted.has(record.id) && record.release?.pass === true);
  const results = [];
  for (const record of records) results.push(await runChain(record));
  const report = {
    version: 'writing-lab-humanize-chain-v1',
    testedAt: new Date().toISOString(),
    jobBase,
    chainBase,
    results,
    summary: {
      count: results.length,
      humanizedPassed: results.filter(item => item.humanizedRelease?.pass === true).length,
      repairedPassed: results.filter(item => item.delivery?.source === 'humanized_repaired').length,
      fallbackUsed: results.filter(item => item.delivery?.source === 'verified_generation_fallback').length,
      deliveredPassed: results.filter(item => item.delivery?.releasePass === true).length,
      failed: results.filter(item => item.delivery?.releasePass !== true).map(item => item.id)
    }
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(JSON.stringify(report.summary));
  if (report.summary.failed.length) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
