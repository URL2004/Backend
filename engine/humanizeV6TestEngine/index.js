// Admin-only wrapper for Humanizing Engine V9.
// The upstream V9 source lives under ./src and is intentionally isolated from the production prompt path.

const { createCopykillerSafeHumanizer } = require('./src');
const { DEFAULT_POLICY } = require('./src/policy');

const VERSION = 'humanizing-engine-v9-registerlock';
const PROFILE = 'v6_engine';

function buildStructuredTool() {
  return {
    name: 'return_v9_humanize_json',
    description: 'Return the structured result requested by the V9 Copykiller-safe humanizing engine.',
    input_schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        outputText: {
          type: 'string',
          description: 'Full-mode transformed text.'
        },
        blocks: {
          type: 'array',
          description: 'Block-locked mode transformed blocks.',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              id: { type: 'string' },
              type: { type: 'string' },
              text: { type: 'string' }
            }
          }
        },
        patches: {
          type: 'array',
          description: 'Patch-mode transformed block patches.',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              id: { type: 'string' },
              text: { type: 'string' }
            }
          }
        },
        editIntensity: {
          type: 'string',
          description: 'light, medium, effective, or high_effective.'
        },
        changedRiskPatterns: {
          type: 'array',
          items: { type: 'string' }
        },
        warnings: {
          type: 'array',
          items: { type: 'string' }
        },
        protectedTermPolicy: {
          type: 'string'
        },
        notes: {
          type: 'array',
          items: { type: 'string' }
        },
        rawJson: {
          type: 'string',
          description: 'Backward-compatible fallback only. Prefer the structured fields above.'
        }
      }
    }
  };
}

function serializeStructuredToolResult(parsed) {
  if (!parsed || typeof parsed !== 'object') return JSON.stringify({});
  if (typeof parsed.rawJson === 'string' && !parsed.outputText && !parsed.blocks && !parsed.patches) {
    return parsed.rawJson;
  }
  if (parsed.rawJson && typeof parsed.rawJson === 'object' && !parsed.outputText && !parsed.blocks && !parsed.patches) {
    return JSON.stringify(parsed.rawJson);
  }
  const payload = {
    outputText: typeof parsed.outputText === 'string' ? parsed.outputText : undefined,
    blocks: Array.isArray(parsed.blocks) ? parsed.blocks : undefined,
    patches: Array.isArray(parsed.patches) ? parsed.patches : undefined,
    editIntensity: parsed.editIntensity,
    changedRiskPatterns: Array.isArray(parsed.changedRiskPatterns) ? parsed.changedRiskPatterns : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    protectedTermPolicy: parsed.protectedTermPolicy || 'kept',
    notes: Array.isArray(parsed.notes) ? parsed.notes : []
  };
  Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);
  return JSON.stringify(payload);
}

function createModelAdapter({ callModel, extractModelResult, signal, mode = 'assignment' }) {
  return {
    async complete({ system, user, temperature, maxOutputTokens }) {
      const tool = buildStructuredTool();
      const data = await callModel({
        userText: user,
        systemText: [
          system,
          '',
          '[서비스 어댑터 규칙]',
          '위 프롬프트가 요구한 JSON 객체를 tool 입력 필드로 직접 반환한다.',
          'full_single_call이면 outputText를, block_locked_single_call이면 blocks를, patch_single_call이면 patches를 채운다.',
          'rawJson 문자열에 JSON을 다시 넣지 않는다. 설명, 마크다운, 코드블록을 넣지 않는다.'
        ].join('\n'),
        tool,
        temperature,
        maxOutputTokens,
        signal,
        task: 'admin_humanize_lab_v9',
        phase: 'v9:main',
        mode
      });
      const parsed = extractModelResult(data, tool.name) || {};
      return serializeStructuredToolResult(parsed);
    }
  };
}

function policyForMode(mode) {
  return {
    ...DEFAULT_POLICY,
    // Admin lab should exercise the V9 model path instead of returning a local-only minimal result.
    lowRiskThreshold: -1,
    minimalPreserveThreshold: -1,
    temperature: mode === 'formal' ? 0.42 : DEFAULT_POLICY.temperature,
    length: {
      ...DEFAULT_POLICY.length,
      // Blog bodies above a few paragraphs need block-level accountability.
      // Full mode tended to edit only the opening paragraphs and copy the rest.
      fullMaxChars: mode === 'formal' ? 250 : DEFAULT_POLICY.length.fullMaxChars
    }
  };
}

function summarizeModel(model) {
  if (!model || typeof model !== 'object') return null;
  const summary = {
    editIntensity: model.editIntensity || null,
    changedRiskPatterns: Array.isArray(model.changedRiskPatterns) ? model.changedRiskPatterns.slice(0, 12) : [],
    warnings: Array.isArray(model.warnings) ? model.warnings.slice(0, 12) : [],
    protectedTermPolicy: model.protectedTermPolicy || null,
    notes: Array.isArray(model.notes) ? model.notes.slice(0, 12) : []
  };
  if (Array.isArray(model.blocks)) summary.returnedBlockCount = model.blocks.length;
  if (Array.isArray(model.patches)) summary.returnedPatchCount = model.patches.length;
  if (model.patchTargetCount != null) summary.patchTargetCount = model.patchTargetCount;
  return summary;
}

function gateWarnings(gates) {
  return (gates || [])
    .filter(g => g && !g.pass)
    .map(g => ({
      gate: `v9_${g.name || 'gate'}`,
      detail: detailText(g.detail || g.reasons || g.issues || g.missing || 'not_passed'),
      severity: g.severity || 'soft'
    }));
}

function detailText(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function buildMeta(result) {
  const diagnostics = result?.diagnostics || {};
  const gates = diagnostics.gates || [];
  const warnings = gateWarnings(gates);
  return {
    version: VERSION,
    upstreamPolicy: 'v9-cksafe',
    profile: PROFILE,
    path: result?.lengthMode || 'unknown',
    status: result?.status || 'unknown',
    decision: result?.status || 'unknown',
    reason: reasonForStatus(result?.status),
    operation: result?.operation || 'humanize_only',
    ignoredUserInstructions: result?.ignoredUserInstructions !== false,
    lengthMode: result?.lengthMode || null,
    profileDetected: diagnostics.profile || null,
    sourceRisk: diagnostics.sourceRisk || null,
    afterRisk: diagnostics.afterRisk || null,
    fallbackRisk: null,
    gates,
    hardFails: diagnostics.hardFails || [],
    softFails: diagnostics.softFails || [],
    warnings,
    patchTargets: diagnostics.patchTargets || null,
    model: summarizeModel({
      notes: diagnostics.modelNotes || []
    })
  };
}

function reasonForStatus(status) {
  if (status === 'done') return 'V9 카피킬러 안전 엔진 결과가 로컬 게이트를 통과했습니다.';
  if (status === 'done_low_effect') return 'V9 유효 변화 기준이 낮아 제한 효과로 표시합니다.';
  if (status === 'done_limited_risk_drop') return 'V9 대리 위험 감소가 제한적이라 제한 효과로 표시합니다.';
  if (status === 'done_limited_effect') return 'V9 결과에 일부 소프트 경고가 있어 제한 효과로 표시합니다.';
  if (status === 'reverted_to_policy_safe') return 'V9 하드 게이트가 감지되어 정책상 안전한 기준 출력으로 되돌렸습니다.';
  if (status === 'model_output_parse_failed') return 'V9 모델 JSON 파싱에 실패해 기준 출력으로 처리했습니다.';
  if (status === 'llm_error') return 'V9 모델 호출 오류로 기준 출력을 반환했습니다.';
  if (status === 'minimal_preserve') return 'V9 로컬 최소 보존 경로로 처리했습니다.';
  return 'V9 카피킬러 안전 테스트 엔진으로 처리했습니다.';
}

function floorReportFromMeta(meta) {
  const warnings = [
    ...(meta.warnings || []),
    ...(meta.status && meta.status !== 'done' ? [{ gate: 'v8_status', detail: meta.status }] : [])
  ];
  return {
    status: 'clean',
    criticals: [],
    warnings,
    metrics: {
      v9Status: meta.status,
      lengthMode: meta.lengthMode,
      sourceRisk: riskNumber(meta.sourceRisk),
      afterRisk: riskNumber(meta.afterRisk),
      gateWarnings: warnings.length
    }
  };
}

function riskNumber(risk) {
  if (typeof risk?.risk === 'number') return round(risk.risk);
  if (typeof risk?.score === 'number') return round(risk.score);
  return null;
}

async function run({ text, mode = 'assignment', lang = 'ko', userNotes = '', evidence = '', signal, callModel, extractModelResult } = {}) {
  if (typeof callModel !== 'function') throw new Error('humanizeV6TestEngine requires callModel');
  if (typeof extractModelResult !== 'function') throw new Error('humanizeV6TestEngine requires extractModelResult');

  const policy = policyForMode(mode);
  const engine = createCopykillerSafeHumanizer({
    policy,
    llm: createModelAdapter({ callModel, extractModelResult, signal, mode })
  });
  const result = await engine.transform({
    text,
    metadata: {
      lang,
      userNotes,
      evidence,
      adminLabProfile: PROFILE
    }
  });
  const meta = buildMeta(result);
  const output = {
    outputText: result.outputText || '',
    styleProfile: PROFILE,
    adminLabProfile: PROFILE,
    v6Engine: meta,
    humanizeMeta: meta
  };
  return {
    result: output,
    floorReport: floorReportFromMeta(meta),
    chunkCount: 1,
    fallbackCount: ['reverted_to_policy_safe', 'model_output_parse_failed', 'llm_error'].includes(result.status) ? 1 : 0,
    gate: meta,
    plan: { version: VERSION, policy }
  };
}

function round(n) {
  return Math.round(Number(n || 0) * 1000) / 1000;
}

module.exports = { run, VERSION, PROFILE };
