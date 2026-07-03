// Admin-only wrapper for Humanizing Engine V8.1.
// The upstream V8.1 source lives under ./src and is intentionally isolated from the production prompt path.

const { createPolicyLockedHumanizer, DEFAULT_POLICY } = require('./src');

const VERSION = 'humanizing-engine-v8.1-high-semantic-locked';
const PROFILE = 'v6_engine';

function buildStructuredTool() {
  return {
    name: 'return_v8_humanize_json',
    description: 'Return the structured result requested by the V8.1 humanizing engine.',
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
    protectedTermPolicy: parsed.protectedTermPolicy || 'kept'
  };
  Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);
  return JSON.stringify(payload);
}

function createAnthropicAdapter({ callClaude, extractClaudeResult, signal, mode = 'assignment' }) {
  return {
    async complete({ system, user, temperature, maxOutputTokens }) {
      const tool = buildStructuredTool();
      const data = await callClaude({
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
        task: 'admin_humanize_lab_v8',
        phase: 'v8:main',
        mode
      });
      const parsed = extractClaudeResult(data, tool.name) || {};
      return serializeStructuredToolResult(parsed);
    }
  };
}

function policyForMode(mode) {
  const strength = mode === 'formal' ? 'high_effective' : 'effective';
  return {
    ...DEFAULT_POLICY,
    strength,
    allowFallbackToOriginal: false,
    // Admin lab should exercise the V8.1 model path instead of returning a local-only minimal result.
    lowRiskThreshold: -1,
    minimalPreserveThreshold: -1
  };
}

function summarizeModel(model) {
  if (!model || typeof model !== 'object') return null;
  const summary = {
    editIntensity: model.editIntensity || null,
    changedRiskPatterns: Array.isArray(model.changedRiskPatterns) ? model.changedRiskPatterns.slice(0, 12) : [],
    warnings: Array.isArray(model.warnings) ? model.warnings.slice(0, 12) : [],
    protectedTermPolicy: model.protectedTermPolicy || null
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
      gate: `v8_${g.name || 'gate'}`,
      detail: g.detail || (g.reasons || g.issues || g.missing || []).join(',') || 'not_passed',
      severity: g.severity || 'soft'
    }));
}

function buildMeta(result) {
  const diagnostics = result?.diagnostics || {};
  const gates = diagnostics.gates || [];
  const warnings = gateWarnings(gates);
  return {
    version: VERSION,
    upstreamPolicy: result?.policy || DEFAULT_POLICY.version,
    profile: PROFILE,
    path: result?.lengthMode || 'unknown',
    status: result?.status || 'unknown',
    decision: result?.status || 'unknown',
    reason: reasonForStatus(result?.status),
    operation: result?.operation || 'humanize_only',
    ignoredUserInstructions: result?.ignoredUserInstructions !== false,
    lengthMode: result?.lengthMode || null,
    profileDetected: result?.profile || null,
    sourceRisk: diagnostics.sourceRisk || null,
    afterRisk: diagnostics.afterRisk || null,
    fallbackRisk: diagnostics.fallbackRisk || null,
    gates,
    warnings,
    patchTargets: diagnostics.patchTargets || null,
    model: summarizeModel(result?.model)
  };
}

function reasonForStatus(status) {
  if (status === 'done') return 'V8.1 정책 잠금 엔진 결과가 로컬 게이트를 통과했습니다.';
  if (status === 'done_low_effect') return 'V8.1 유효 변화 기준이 낮아 제한 효과로 표시합니다.';
  if (status === 'done_limited_risk_drop') return 'V8.1 표면 위험 감소가 제한적이라 제한 효과로 표시합니다.';
  if (status === 'done_limited_effect') return 'V8.1 결과에 일부 소프트 경고가 있어 제한 효과로 표시합니다.';
  if (status === 'reverted_to_policy_safe') return 'V8.1 하드 게이트가 감지되어 정책상 안전한 기준 출력으로 되돌렸습니다.';
  if (status === 'model_output_parse_failed') return 'V8.1 모델 JSON 파싱에 실패해 기준 출력으로 처리했습니다.';
  if (status === 'llm_error') return 'V8.1 모델 호출 오류로 기준 출력을 반환했습니다.';
  if (status === 'minimal_preserve') return 'V8.1 로컬 최소 보존 경로로 처리했습니다.';
  return 'V8.1 정책 잠금 테스트 엔진으로 처리했습니다.';
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
      v8Status: meta.status,
      lengthMode: meta.lengthMode,
      sourceRisk: typeof meta.sourceRisk?.score === 'number' ? round(meta.sourceRisk.score) : null,
      afterRisk: typeof meta.afterRisk?.score === 'number' ? round(meta.afterRisk.score) : null,
      gateWarnings: warnings.length
    }
  };
}

async function run({ text, mode = 'assignment', lang = 'ko', userNotes = '', evidence = '', signal, callClaude, extractClaudeResult } = {}) {
  if (typeof callClaude !== 'function') throw new Error('humanizeV6TestEngine requires callClaude');
  if (typeof extractClaudeResult !== 'function') throw new Error('humanizeV6TestEngine requires extractClaudeResult');

  const policy = policyForMode(mode);
  const engine = createPolicyLockedHumanizer({
    policy,
    llm: createAnthropicAdapter({ callClaude, extractClaudeResult, signal, mode })
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
