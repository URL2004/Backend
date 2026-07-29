'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseCsv, stringifyCsv } = require('./lib/csv');
const { rtfToText } = require('./lib/rtfText');
const { detectDocumentProfile, DOCUMENT_PROFILES } = require('../engine-gpt-prod/documentProfile');
const { compareNaturalnessShadow } = require('../engine-gpt-prod/naturalnessShadow');
const floor = require('../engine/floor');
const structureChunk = require('../engine-gpt-prod/structureChunk');

const LIVE_COMMIT_CUTOFF_KST = '2026-07-09 13:10:00';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'help';
  if (command === 'sample') return makeLabelSample(args);
  if (command === 'baseline') return makeBaselineReport(args);
  if (command === 'router-summary') return makeRouterSummary(args);
  if (command === 'chunk-summary') return makeChunkSummary(args);
  if (command === 'chunk-detail') return makeChunkDetail(args);
  if (command === 'score-router') return scoreRouter(args);
  if (command === 'replay') return replay(args);
  if (command === 'replay-summary') return makeReplaySummary(args);
  if (command === 'report') return makeCrossTab(args);
  if (command === 'copykiller-template') return makeCopykillerTemplate(args);
  if (command === 'copykiller-score') return scoreCopykiller(args);
  printHelp();
}

function loadManifest(manifestPath) {
  const full = path.resolve(requireArg(manifestPath, '--manifest'));
  const rows = parseCsv(fs.readFileSync(full, 'utf8'));
  return { full, dir: path.dirname(full), rows };
}

function makeLabelSample(args) {
  const manifest = loadManifest(args.manifest);
  const outPath = path.resolve(requireArg(args.out, '--out'));
  const selected = manifest.rows
    .map(row => ({ row, hash: stableHash(row.history_id) }))
    .sort((a, b) => a.hash.localeCompare(b.hash))
    .slice(0, 200)
    .map((item, index) => ({
      case_id: item.hash.slice(0, 16),
      split: index < 140 ? 'dev' : 'holdout',
      requested_mode: validMode(item.row.mode),
      original_file: item.row.original_file,
      original_chars: item.row.original_chars,
      basic_style: '',
      document_profile_label: '',
      reviewer_note: ''
    }));
  ensureOutsideRepository(outPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, stringifyCsv(selected), 'utf8');
  console.log(JSON.stringify({ ok: true, output: outPath, rows: selected.length, dev: 140, holdout: 60, uidIncluded: false }, null, 2));
}

function makeBaselineReport(args) {
  const manifest = loadManifest(args.manifest);
  const rows = manifest.rows.filter(row => String(row.created_at_kst || '') >= LIVE_COMMIT_CUTOFF_KST);
  const metrics = rows.map(row => {
    const source = readRtf(path.join(manifest.dir, row.original_file));
    const current = readRtf(path.join(manifest.dir, row.humanized_file));
    const shadow = compareNaturalnessShadow(source, current);
    return {
      requestedMode: validMode(row.mode),
      sourceChars: source.length,
      currentChars: current.length,
      riskIncreased: shadow.riskIncreased,
      rhythmUniformityDelta: shadow.rhythmUniformityDelta,
      lengthRatio: source.length ? current.length / source.length : 1
    };
  });
  const mean = key => metrics.length
    ? metrics.reduce((sum, item) => sum + (Number(item[key]) || 0), 0) / metrics.length
    : 0;
  const report = {
    baselineCommit: 'e13cbf48f30b39f455be0cfc0ed03394158136a5',
    cutoffKst: LIVE_COMMIT_CUTOFF_KST,
    count: metrics.length,
    requestedModes: countBy(metrics, item => item.requestedMode),
    naturalnessRiskIncreased: metrics.filter(item => item.riskIncreased).length,
    averageRhythmUniformityDelta: mean('rhythmUniformityDelta'),
    averageLengthRatio: mean('lengthRatio'),
    containsUserText: false,
    containsUid: false
  };
  if (args.out) {
    const outPath = path.resolve(args.out);
    ensureOutsideRepository(outPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    report.output = outPath;
  }
  console.log(JSON.stringify(report, null, 2));
}

function makeRouterSummary(args) {
  const manifest = loadManifest(args.manifest);
  const rows = manifest.rows.map(row => {
    const source = readRtf(path.join(manifest.dir, row.original_file));
    const report = detectDocumentProfile(source, { basicStyle: '' });
    const withMode = detectDocumentProfile(source, { basicStyle: '', requestedMode: validMode(row.mode) });
    return {
      requestedMode: validMode(row.mode),
      profile: report.profile,
      confidence: report.confidence,
      modeInvariant: report.profile === withMode.profile
    };
  });
  const report = {
    total: rows.length,
    profiles: countBy(rows, row => row.profile),
    confidenceTiers: countBy(rows, row => row.confidence >= 0.75 ? 'high_ge075' : row.confidence >= 0.55 ? 'tie_055_074' : 'unknown_lt055'),
    requestedModeByProfile: crossCount(rows, ['requestedMode', 'profile']),
    modeInvariantViolations: rows.filter(row => !row.modeInvariant).length,
    containsUserText: false,
    containsUid: false
  };
  if (args.out) {
    const outPath = path.resolve(args.out);
    ensureOutsideRepository(outPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    report.output = outPath;
  }
  console.log(JSON.stringify(report, null, 2));
}

function makeChunkSummary(args) {
  const manifest = loadManifest(args.manifest);
  const scope = args.scope || 'current81';
  let rows = [...manifest.rows];
  if (scope === 'current81') rows = rows.filter(row => String(row.created_at_kst || '') >= LIVE_COMMIT_CUTOFF_KST);
  const counts = rows.map(row => {
    const source = readRtf(path.join(manifest.dir, row.original_file));
    return {
      legacy: structureChunk.splitChunksForGpt(source).chunks.length,
      v2: structureChunk.splitChunksForGpt(source, { coalesceEditable: true }).chunks.length
    };
  });
  const report = {
    scope,
    total: counts.length,
    legacy: summarizeNumbers(counts.map(item => item.legacy)),
    v2: summarizeNumbers(counts.map(item => item.v2)),
    documentsReduced: counts.filter(item => item.v2 < item.legacy).length,
    containsUserText: false,
    containsUid: false
  };
  if (args.out) {
    const outPath = path.resolve(args.out);
    ensureOutsideRepository(outPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    report.output = outPath;
  }
  console.log(JSON.stringify(report, null, 2));
}

function makeChunkDetail(args) {
  const manifest = loadManifest(args.manifest);
  const scope = args.scope || 'current81';
  let rows = [...manifest.rows];
  if (scope === 'current81') rows = rows.filter(row => String(row.created_at_kst || '') >= LIVE_COMMIT_CUTOFF_KST);
  const requestedMode = ['blog', 'polish', 'formal'].includes(String(args.mode || '')) ? String(args.mode) : '';
  if (requestedMode) rows = rows.filter(row => validMode(row.mode) === requestedMode);
  const caseIdFilter = String(args.caseId || args['case-id'] || '').trim();
  if (caseIdFilter) rows = rows.filter(row => stableHash(row.history_id).slice(0, 16) === caseIdFilter);
  if (args.limit) rows = rows.slice(0, Number(args.limit));
  const documents = rows.map(row => {
    const source = readRtf(path.join(manifest.dir, row.original_file));
    const plan = structureChunk.splitChunksForGpt(source, { coalesceEditable: true });
    return {
      caseId: stableHash(row.history_id).slice(0, 16),
      requestedMode: validMode(row.mode),
      sourceChars: source.length,
      chunkCount: plan.chunks.length,
      chunks: plan.chunks.map(chunk => ({
        index: chunk.index,
        chars: String(chunk.text || '').length,
        locked: chunk.locked === true,
        lockType: chunk.lockType || 'body'
      }))
    };
  });
  console.log(JSON.stringify({
    scope,
    requestedMode: requestedMode || 'all',
    total: documents.length,
    documents,
    containsUserText: false,
    containsUid: false
  }, null, 2));
}

function scoreRouter(args) {
  const manifest = loadManifest(args.manifest);
  const labelsPath = path.resolve(requireArg(args.labels, '--labels'));
  const labels = parseCsv(fs.readFileSync(labelsPath, 'utf8'));
  const manifestByCase = new Map(manifest.rows.map(row => [stableHash(row.history_id).slice(0, 16), row]));
  const evaluated = [];
  for (const label of labels) {
    const expected = String(label.document_profile_label || '').trim();
    if (!DOCUMENT_PROFILES.includes(expected) || expected === 'unknown') continue;
    const row = manifestByCase.get(label.case_id);
    if (!row) continue;
    const source = readRtf(path.join(manifest.dir, row.original_file));
    const basicStyle = String(label.basic_style || '').trim();
    const withoutRequestedMode = detectDocumentProfile(source, { basicStyle });
    const withRequestedMode = detectDocumentProfile(source, { basicStyle, requestedMode: validMode(row.mode) });
    evaluated.push({
      expected,
      predicted: withoutRequestedMode.profile,
      confidence: withoutRequestedMode.confidence,
      split: label.split,
      mode: validMode(row.mode),
      modeInvariant: withRequestedMode.profile === withoutRequestedMode.profile
    });
  }
  const report = classificationReport(evaluated, args.split || 'all');
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 2;
}

async function replay(args) {
  if (args.execute !== '1' && args.execute !== true) throw new Error('실제 API 비용이 발생합니다. --execute=1을 명시하세요.');
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY가 필요합니다.');
  if (!process.env.OPENAI_SAFETY_SALT) throw new Error('OPENAI_SAFETY_SALT가 필요합니다.');
  const engine = require('../engine-gpt-prod');
  const runtime = require('../lib/gptRuntimeConfig');
  const manifest = loadManifest(args.manifest);
  const outDir = path.resolve(requireArg(args.outDir || args['out-dir'], '--out-dir'));
  ensureOutsideRepository(outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const scope = args.scope || 'current81';
  let rows = [...manifest.rows];
  if (scope === 'current81') rows = rows.filter(row => String(row.created_at_kst || '') >= LIVE_COMMIT_CUTOFF_KST);
  const requestedModeFilter = ['blog', 'polish', 'formal'].includes(String(args.mode || '')) ? String(args.mode) : '';
  if (requestedModeFilter) rows = rows.filter(row => validMode(row.mode) === requestedModeFilter);
  const caseIdFilter = String(args.caseId || args['case-id'] || '').trim();
  if (caseIdFilter) rows = rows.filter(row => stableHash(row.history_id).slice(0, 16) === caseIdFilter);
  const resume = args.resume === '1' || args.resume === true;
  const skipCount = Math.max(0, Number.parseInt(String(args.skip || '0'), 10) || 0);
  if (resume !== (skipCount > 0)) {
    throw new Error('재개 실행은 --resume=1과 1 이상의 --skip을 함께 지정해야 합니다.');
  }
  if (skipCount > rows.length) throw new Error(`--skip=${skipCount}가 대상 ${rows.length}건보다 큽니다.`);
  const expectedPrefix = rows.slice(0, skipCount).map(row => stableHash(row.history_id).slice(0, 16));
  rows = rows.slice(skipCount);
  if (args.limit) rows = rows.slice(0, Number(args.limit));
  const scopeLabel = caseIdFilter
    ? `${scope}-case-${caseIdFilter}`
    : (requestedModeFilter ? `${scope}-${requestedModeFilter}` : scope);
  const resultPath = path.join(outDir, `v2-replay-${scopeLabel}.jsonl`);
  if (resume) {
    if (!fs.existsSync(resultPath)) throw new Error(`재개할 결과 파일이 없습니다: ${resultPath}`);
    const existing = readJsonLines(resultPath);
    if (existing.length !== skipCount) {
      throw new Error(`재개 위치 불일치: 기존 ${existing.length}건, --skip=${skipCount}`);
    }
    const mismatched = existing.findIndex((record, index) => record.caseId !== expectedPrefix[index]);
    if (mismatched >= 0) {
      throw new Error(`재개 대상 순서 불일치: ${mismatched + 1}번째 caseId가 매니페스트와 다릅니다.`);
    }
  } else if (fs.existsSync(resultPath) && fs.statSync(resultPath).size > 0) {
    throw new Error(`기존 결과 파일이 있습니다. 새 출력 폴더를 쓰거나 --resume=1 --skip=<기존 건수>를 지정하세요: ${resultPath}`);
  }
  const stream = fs.createWriteStream(resultPath, { flags: resume ? 'a' : 'w', encoding: 'utf8' });
  const cfg = runtime.publicConfig(runtime.DEFAULT_CONFIG, 'local_eval');
  const summaries = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const caseId = stableHash(row.history_id).slice(0, 16);
    const source = readRtf(path.join(manifest.dir, row.original_file));
    const current = readRtf(path.join(manifest.dir, row.humanized_file));
    const started = Date.now();
    try {
      const out = await engine.run({
        text: source,
        mode: validMode(row.mode),
        allowPolish: true,
        uid: `eval-${caseId}`,
        // 운영 추출물에는 실제 basicStyle이 없으므로 요청 mode에서 역추정하지 않는다.
        // 요청 축이 문서 프로필 판정에 새어 들어가지 않는 조건을 그대로 지킨다.
        basicStyle: ['blog', 'report'].includes(String(row.basic_style || '')) ? row.basic_style : '',
        config: cfg
      });
      const v2 = out.result?.outputText || '';
      const record = buildReplayRecord({ caseId, row, source, current, v2, out, elapsedMs: Date.now() - started });
      stream.write(JSON.stringify(record) + '\n');
      summaries.push(record);
      console.log(`[${skipCount + index + 1}/${skipCount + rows.length}] ${caseId} ${record.status} ${record.documentProfile}`);
    } catch (error) {
      const record = { caseId, requestedMode: validMode(row.mode), status: 'error', error: String(error?.message || error).slice(0, 240), elapsedMs: Date.now() - started };
      stream.write(JSON.stringify(record) + '\n');
      summaries.push(record);
      console.error(`[${skipCount + index + 1}/${skipCount + rows.length}] ${caseId} error`);
    }
  }
  await new Promise(resolve => stream.end(resolve));
  const summaryRows = resume ? readJsonLines(resultPath) : summaries;
  const summary = aggregateReplay(summaryRows, scopeLabel);
  fs.writeFileSync(path.join(outDir, `v2-replay-${scopeLabel}-summary.json`), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ resultPath, summary }, null, 2));
}

function buildReplayRecord({ caseId, row, source, current, v2, out, elapsedMs }) {
  const novelty = floor.measureNovelty(source, v2, '');
  const lost = floor.measureLostFacts(source, v2);
  const currentNaturalness = compareNaturalnessShadow(source, current);
  const v2Naturalness = compareNaturalnessShadow(source, v2);
  const floorReport = out.result?.floorReport || out.floorReport || {};
  const strictGateCodes = [...new Set((floorReport.criticals || [])
    .map(item => String(item?.gate || item?.type || '').trim())
    .filter(Boolean))];
  return {
    caseId,
    requestedMode: validMode(row.mode),
    status: out.status,
    qualityStatus: out.qualityStatus || out.result?.qualityStatus || 'clean',
    qualityWarningCodes: (out.qualityWarnings || []).map(item => item.code),
    engineVersion: out.engineMeta?.engineVersion || '',
    documentProfile: out.engineMeta?.documentProfile || 'unknown',
    profileConfidence: out.engineMeta?.profileConfidence || 0,
    targetRegister: out.engineMeta?.targetRegister || out.engineMeta?.tonePolicy || 'source_preserve',
    semanticJudgeRan: out.engineMeta?.semanticJudgeRan === true,
    repairCount: out.engineMeta?.repairCount || 0,
    chunkCount: out.engineMeta?.chunkCount || 0,
    fallbackCount: out.engineMeta?.fallbackCount || 0,
    humanizationPolicyVersion: out.engineMeta?.humanizationPolicyVersion || '',
    humanizationMinimumRatio: out.engineMeta?.humanizationMinimumRatio || 0,
    humanizationHardMinimumRatio: out.engineMeta?.humanizationHardMinimumRatio || 0,
    humanizationTargetMinRatio: out.engineMeta?.humanizationTargetMinRatio || 0,
    humanizationTargetMaxRatio: out.engineMeta?.humanizationTargetMaxRatio || 0,
    substantiveEditRatio: out.engineMeta?.substantiveEditRatio || 0,
    substantiveChangedSentenceRatio: out.engineMeta?.substantiveChangedSentenceRatio || 0,
    materiallyRecastSentenceCount: out.engineMeta?.materiallyRecastSentenceCount || 0,
    effectiveStructuralChangedSentenceCount: out.engineMeta?.effectiveStructuralChangedSentenceCount || 0,
    clauseLevelStructuralAlternative: out.engineMeta?.clauseLevelStructuralAlternative === true,
    sectionRecoveryAttemptCount: out.engineMeta?.sectionRecoveryAttemptCount || 0,
    sectionRecoveryTargetOnlyCount: out.engineMeta?.sectionRecoveryTargetOnlyCount || 0,
    sectionRecoveryAppliedCount: out.engineMeta?.sectionRecoveryAppliedCount || 0,
    sectionRecoveryRejectedAttemptCount: out.engineMeta?.sectionRecoveryRejectedAttemptCount || 0,
    sectionRecoveryRejectionCodes: out.engineMeta?.sectionRecoveryRejectionCodes || [],
    semanticRelationShiftCount: out.engineMeta?.semanticRelationShiftCount || 0,
    semanticRelationShiftFamilies: out.engineMeta?.semanticRelationShiftFamilies || [],
    formalRegisterResidualCount: out.engineMeta?.formalRegisterResidualCount || 0,
    humanizationTargetDepthMet: out.engineMeta?.humanizationTargetDepthMet === true,
    humanizationTargetDepthGap: out.engineMeta?.humanizationTargetDepthGap || 0,
    humanizationMinimumEffectPass: out.engineMeta?.humanizationMinimumEffectPass === true,
    humanizationDepthSoftDelivered: out.engineMeta?.humanizationDepthSoftDelivered === true,
    humanizationDeliveryDepthBand: out.engineMeta?.humanizationDeliveryDepthBand || '',
    strictGateCodes,
    chunkFailureReasons: [...new Set((out.chunks || out.result?.records || [])
      .flatMap(item => [item?.hardFailReason, item?.error])
      .map(value => String(value || '').trim())
      .filter(Boolean))].slice(0, 12),
    sourceChars: source.length,
    currentChars: current.length,
    v2Chars: v2.length,
    lengthRatio: source.length ? v2.length / source.length : 1,
    charEditRatio: out.result?.editMetrics?.charEditRatio || 0,
    noTransform: compact(source) === compact(v2),
    newFactCount: novelty.count,
    lostFactCount: lost.count,
    currentNaturalnessRiskIncreased: currentNaturalness.riskIncreased,
    v2NaturalnessRiskIncreased: v2Naturalness.riskIncreased,
    currentRhythmUniformityDelta: currentNaturalness.rhythmUniformityDelta,
    v2RhythmUniformityDelta: v2Naturalness.rhythmUniformityDelta,
    estimatedUsd: out.gptEngine?.usage?.estimatedUsd || 0,
    elapsedMs,
    v2Output: v2
  };
}

function aggregateReplay(rows, scope) {
  const ok = rows.filter(row => row.status !== 'error');
  const mean = (key) => ok.length ? ok.reduce((sum, row) => sum + (Number(row[key]) || 0), 0) / ok.length : 0;
  const count = predicate => ok.filter(predicate).length;
  return {
    scope,
    generatedAt: new Date().toISOString(),
    total: rows.length,
    completed: ok.length,
    errors: rows.length - ok.length,
    noTransform: count(row => row.noTransform),
    newFacts: count(row => row.newFactCount > 0),
    lostFacts: count(row => row.lostFactCount > 0),
    strictBlocked: count(row => row.status === 'blocked'),
    needsReview: count(row => row.qualityStatus === 'needs_review'),
    naturalnessRiskIncreased: count(row => row.v2NaturalnessRiskIncreased),
    currentNaturalnessRiskIncreased: count(row => row.currentNaturalnessRiskIncreased),
    averageRhythmUniformityDelta: mean('v2RhythmUniformityDelta'),
    currentAverageRhythmUniformityDelta: mean('currentRhythmUniformityDelta'),
    averageLengthRatio: mean('lengthRatio'),
    averageSubstantiveEditRatio: mean('substantiveEditRatio'),
    averageTargetDepthGap: mean('humanizationTargetDepthGap'),
    targetDepthMet: count(row => row.humanizationTargetDepthMet),
    minimumEffectPass: count(row => row.humanizationMinimumEffectPass),
    depthSoftDelivered: count(row => row.humanizationDepthSoftDelivered),
    clauseLevelStructuralAlternatives: count(row => row.clauseLevelStructuralAlternative),
    sectionRecoveryAttemptedDocuments: count(row => row.sectionRecoveryAttemptCount > 0),
    targetOnlyRecoveryAttemptedDocuments: count(row => row.sectionRecoveryTargetOnlyCount > 0),
    sectionRecoveryAppliedDocuments: count(row => row.sectionRecoveryAppliedCount > 0),
    sectionRecoveryRejectedDocuments: count(row => row.sectionRecoveryRejectedAttemptCount > 0),
    semanticRelationShiftDocuments: count(row => row.semanticRelationShiftCount > 0),
    formalRegisterResidualDocuments: count(row => row.formalRegisterResidualCount > 0),
    targetRegisters: countBy(ok, row => row.targetRegister || 'source_preserve'),
    deliveryDepthBands: countBy(ok, row => row.humanizationDeliveryDepthBand || 'not_applicable'),
    totalEstimatedUsd: ok.reduce((sum, row) => sum + (Number(row.estimatedUsd) || 0), 0),
    passCriteria: {
      errorsZero: rows.length === ok.length,
      noTransformZero: count(row => row.noTransform) === 0,
      newFactsZero: count(row => row.newFactCount > 0) === 0,
      lostFactsZero: count(row => row.lostFactCount > 0) === 0,
      strictBlockedZero: count(row => row.status === 'blocked') === 0,
      naturalnessRiskAtMost12Of81: scope !== 'current81' || count(row => row.v2NaturalnessRiskIncreased) <= 12,
      rhythmDeltaNonPositive: mean('v2RhythmUniformityDelta') <= 0,
      lengthRatioInRange: mean('lengthRatio') >= 0.9 && mean('lengthRatio') <= 1.12
    }
  };
}

function makeReplaySummary(args) {
  const input = path.resolve(requireArg(args.input, '--input'));
  const rows = readJsonLines(input);
  const scope = String(args.scope || 'current81');
  const summary = aggregateReplay(rows, scope);
  const outPath = args.out
    ? path.resolve(args.out)
    : input.replace(/\.jsonl$/iu, '-summary.json');
  ensureOutsideRepository(outPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ output: outPath, summary }, null, 2));
}

function makeCrossTab(args) {
  const input = path.resolve(requireArg(args.input, '--input'));
  const out = args.out ? path.resolve(args.out) : '';
  const rows = readJsonLines(input);
  const counts = new Map();
  for (const row of rows) {
    const key = [row.requestedMode || 'legacy_unknown', row.documentProfile || 'unknown', row.engineVersion || 'unknown', row.qualityStatus || 'unknown'].join('\t');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const table = [...counts.entries()].map(([key, count]) => {
    const [requestedMode, documentProfile, engineVersion, qualityStatus] = key.split('\t');
    return { requestedMode, documentProfile, engineVersion, qualityStatus, count };
  }).sort((a, b) => b.count - a.count);
  const csv = stringifyCsv(table);
  if (out) {
    ensureOutsideRepository(out);
    fs.writeFileSync(out, csv, 'utf8');
  } else process.stdout.write(csv);
}

function makeCopykillerTemplate(args) {
  const replayPath = path.resolve(requireArg(args.replay, '--replay'));
  const outPath = path.resolve(requireArg(args.out, '--out'));
  const rows = readJsonLines(replayPath).filter(row => row.status !== 'error');
  const targets = { blog: 36, polish: 12, formal: 12 };
  const tuningTargets = { blog: 24, polish: 8, formal: 8 };
  const selected = [];
  for (const [mode, count] of Object.entries(targets)) {
    const pool = rows.filter(row => row.requestedMode === mode)
      .sort((a, b) => stratifiedKey(a).localeCompare(stratifiedKey(b)) || a.caseId.localeCompare(b.caseId));
    const chosen = takeAcrossLengthBands(pool, count);
    if (chosen.length !== count) throw new Error(`${mode} 재생 결과가 ${count}건보다 적습니다(${chosen.length}건). full 495 재생 결과를 사용하세요.`);
    const tuning = new Set(takeAcrossLengthBands([...chosen].sort((a, b) => stratifiedKey(a).localeCompare(stratifiedKey(b))), tuningTargets[mode]).map(row => row.caseId));
    selected.push(...chosen.map(row => ({ ...row, copykillerSplit: tuning.has(row.caseId) ? 'tuning' : 'blind_holdout' })));
  }
  const template = selected
    .sort((a, b) => a.copykillerSplit.localeCompare(b.copykillerSplit) || a.requestedMode.localeCompare(b.requestedMode) || a.caseId.localeCompare(b.caseId))
    .map(row => ({
    case_id: row.caseId,
    split: row.copykillerSplit,
    requested_mode: row.requestedMode,
    document_profile: row.documentProfile,
    source_chars: row.sourceChars,
    length_band: lengthBand(row),
    original_score_band: '',
    original_score: '',
    current_score: '',
    v2_score: '',
    major_meaning_damage: '',
    evaluator_note: ''
  }));
  ensureOutsideRepository(outPath);
  fs.writeFileSync(outPath, stringifyCsv(template), 'utf8');
  console.log(JSON.stringify({ ok: true, output: outPath, rows: template.length, tuning: 40, blindHoldout: 20, apiConnected: false }, null, 2));
}

function scoreCopykiller(args) {
  const inputPath = path.resolve(requireArg(args.input, '--input'));
  const rows = parseCsv(fs.readFileSync(inputPath, 'utf8'));
  const scored = rows.map(row => {
    const originalScore = requiredScore(row.original_score, row.case_id, 'original_score');
    return {
      ...row,
      original_score_band: scoreBand(originalScore),
      originalScore,
      currentScore: requiredScore(row.current_score, row.case_id, 'current_score'),
      v2Score: requiredScore(row.v2_score, row.case_id, 'v2_score'),
      majorMeaningDamage: truthyCell(row.major_meaning_damage)
    };
  });
  const holdout = scored.filter(row => row.split === 'blind_holdout');
  if (scored.length !== 60 || holdout.length !== 20) throw new Error(`60건/holdout 20건이 필요합니다(현재 ${scored.length}/${holdout.length}).`);
  const reductions = holdout.map(row => row.currentScore - row.v2Score);
  const worsenedOver10 = holdout.filter(row => row.v2Score - row.currentScore > 10);
  const lowOriginalSpike = holdout.filter(row => row.originalScore < 30 && row.v2Score - row.originalScore > 15);
  const highOriginal = holdout.filter(row => row.originalScore >= 50);
  const highOriginalImproved = highOriginal.filter(row => row.v2Score < row.originalScore);
  const majorDamage = scored.filter(row => row.majorMeaningDamage);
  const report = {
    total: scored.length,
    blindHoldout: holdout.length,
    distribution: crossCount(scored, ['split', 'requested_mode', 'length_band', 'original_score_band']),
    holdoutMedianReductionVsCurrent: median(reductions),
    worsenedOver10Count: worsenedOver10.length,
    worsenedOver10Rate: worsenedOver10.length / holdout.length,
    lowOriginalSpikeOver15Count: lowOriginalSpike.length,
    highOriginalCount: highOriginal.length,
    highOriginalImprovedCount: highOriginalImproved.length,
    highOriginalImprovedRate: highOriginal.length ? highOriginalImproved.length / highOriginal.length : 0,
    majorMeaningDamageCount: majorDamage.length,
    passCriteria: {
      medianReductionAtLeast5: median(reductions) >= 5,
      worsenedOver10AtMost10Percent: worsenedOver10.length / holdout.length <= 0.1,
      lowOriginalSpikeZero: lowOriginalSpike.length === 0,
      highOriginalAtLeast40PercentImproved: highOriginal.length > 0 && highOriginalImproved.length / highOriginal.length >= 0.4,
      majorMeaningDamageZero: majorDamage.length === 0
    }
  };
  report.pass = Object.values(report.passCriteria).every(Boolean);
  if (args.out) {
    const outPath = path.resolve(args.out);
    ensureOutsideRepository(outPath);
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 2;
}

function classificationReport(rows, split) {
  const filtered = split === 'all' ? rows : rows.filter(row => row.split === split);
  const labels = [...new Set(filtered.flatMap(row => [row.expected, row.predicted]))].filter(Boolean);
  const perClass = labels.map(label => {
    const tp = filtered.filter(row => row.expected === label && row.predicted === label).length;
    const fp = filtered.filter(row => row.expected !== label && row.predicted === label).length;
    const fn = filtered.filter(row => row.expected === label && row.predicted !== label).length;
    const precision = tp / Math.max(1, tp + fp);
    const recall = tp / Math.max(1, tp + fn);
    return { label, support: tp + fn, precision, recall, f1: 2 * precision * recall / Math.max(1e-12, precision + recall) };
  });
  const macroF1 = perClass.length ? perClass.reduce((sum, row) => sum + row.f1, 0) / perClass.length : 0;
  const sensitive = ['academic_paper', 'student_record', 'resume_application', 'creative'];
  const sensitivePass = sensitive.every(label => {
    const row = perClass.find(item => item.label === label);
    return !row || row.support === 0 || row.recall >= 0.95;
  });
  const modeInvariantViolations = filtered.filter(row => row.modeInvariant === false).length;
  return {
    split,
    evaluated: filtered.length,
    macroF1,
    perClass,
    modeInvariantViolations,
    pass: filtered.length > 0 && macroF1 >= 0.85 && sensitivePass && modeInvariantViolations === 0
  };
}

function readRtf(filePath) {
  return rtfToText(fs.readFileSync(filePath));
}

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
}

function takeAcrossLengthBands(rows, count) {
  const bands = [
    rows.filter(row => Number(row.sourceChars) < 500),
    rows.filter(row => Number(row.sourceChars) >= 500 && Number(row.sourceChars) < 1500),
    rows.filter(row => Number(row.sourceChars) >= 1500)
  ];
  const out = [];
  let cursor = 0;
  while (out.length < count && bands.some(band => band.length)) {
    const band = bands[cursor % bands.length];
    if (band.length) out.push(band.shift());
    cursor += 1;
  }
  return out;
}

function lengthBand(row) {
  const chars = Number(row.sourceChars) || 0;
  if (chars < 500) return 'short_lt500';
  if (chars < 1500) return 'medium_500_1499';
  return 'long_ge1500';
}

function stratifiedKey(row) {
  return `${row.documentProfile || 'unknown'}:${stableHash(row.caseId).slice(0, 12)}`;
}

function validMode(value) {
  return ['blog', 'polish', 'formal'].includes(String(value || '').trim()) ? String(value).trim() : 'formal';
}

function countBy(rows, selector) {
  const counts = {};
  for (const row of rows) {
    const key = String(selector(row) || 'unknown');
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function summarizeNumbers(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = value => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * value) - 1))] : 0;
  return {
    mean: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : 0,
    median: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.length ? sorted[sorted.length - 1] : 0
  };
}

function scoreBand(score) {
  if (score < 30) return 'low_lt30';
  if (score < 50) return 'mid_30_49';
  return 'high_ge50';
}

function crossCount(rows, fields) {
  const counts = new Map();
  for (const row of rows) {
    const key = fields.map(field => String(row[field] || 'unknown')).join('\t');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => {
    const values = key.split('\t');
    return Object.assign(Object.fromEntries(fields.map((field, index) => [field, values[index]])), { count });
  });
}

function requiredScore(value, caseId, field) {
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error(`${caseId}의 ${field}에 0~100 점수가 필요합니다.`);
  return score;
}

function truthyCell(value) {
  return ['1', 'true', 'yes', 'y', '예', '있음'].includes(String(value || '').trim().toLowerCase());
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function compact(value) {
  return String(value || '').replace(/\s+/gu, '');
}

function ensureOutsideRepository(target) {
  const repo = path.resolve(__dirname, '..');
  const full = path.resolve(target);
  if (full === repo || full.startsWith(repo + path.sep)) throw new Error('운영 원문·평가 결과는 저장소 안에 쓸 수 없습니다. --out/--out-dir를 로컬 문서 경로로 지정하세요.');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!arg.startsWith('--')) out._.push(arg);
    else {
      const [key, ...rest] = arg.slice(2).split('=');
      out[key] = rest.length ? rest.join('=') : true;
    }
  }
  return out;
}

function requireArg(value, name) {
  if (!value || value === true) throw new Error(`${name}가 필요합니다.`);
  return value;
}

function printHelp() {
  console.log([
    '사용법:',
    '  node scripts/humanize-v2-eval.js sample --manifest=.../pair_manifest.csv --out=.../v2-labels.csv',
    '  node scripts/humanize-v2-eval.js baseline --manifest=.../pair_manifest.csv --out=.../current81-baseline.json',
    '  node scripts/humanize-v2-eval.js router-summary --manifest=.../pair_manifest.csv --out=.../router-summary.json',
    '  node scripts/humanize-v2-eval.js chunk-summary --manifest=.../pair_manifest.csv --scope=current81 --out=.../chunk-summary.json',
    '  node scripts/humanize-v2-eval.js chunk-detail --manifest=... --scope=current81 --mode=polish --limit=1',
    '  node scripts/humanize-v2-eval.js score-router --manifest=... --labels=... --split=holdout',
    '  node scripts/humanize-v2-eval.js replay --manifest=... --scope=current81 --case-id=... --out-dir=... --execute=1',
    '  node scripts/humanize-v2-eval.js replay --manifest=... --scope=current81 --out-dir=... --execute=1 --resume=1 --skip=57',
    '  node scripts/humanize-v2-eval.js replay-summary --input=...jsonl --scope=current81 --out=...summary.json',
    '  node scripts/humanize-v2-eval.js report --input=...jsonl --out=...csv',
    '  node scripts/humanize-v2-eval.js copykiller-template --replay=...jsonl --out=...csv',
    '  node scripts/humanize-v2-eval.js copykiller-score --input=...csv --out=...json'
  ].join('\n'));
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
