'use strict';

const engine = require('../engine-gpt-prod');
const runtime = require('../lib/gptRuntimeConfig');
const structure = require('../engine-gpt-prod/structureChunk');
const layout = require('../engine-gpt-prod/layoutStructure');

const CASES = [
  {
    id: 'production_system_labels',
    mode: 'blog',
    basicStyle: 'report',
    headings: ['1. 서론', '2. 본론', '1) 생산시스템의 기본 구조', '3. 결론'],
    source: [
      '1. 서론',
      '생산시스템은 자원과 정보를 투입해 제품이나 서비스로 전환하는 전체 과정을 의미합니다. 각 단계는 독립적으로 보이지만 실제로는 품질, 납기, 비용이라는 공통 목표 아래 서로 연결됩니다. 따라서 운영 성과를 이해하려면 개별 공정뿐 아니라 투입부터 피드백까지 이어지는 흐름을 함께 살펴봐야 합니다.',
      '2. 본론',
      '1) 생산시스템의 기본 구조',
      '투입 (Input): 원재료, 인력, 설비, 기술, 고객 정보처럼 생산을 시작하는 데 필요한 자원을 준비합니다.',
      '변환 과정 (Transformation Process): 투입된 자원을 작업 순서와 품질 기준에 따라 처리해 가치 있는 결과로 바꿉니다. 이 과정에는 조립, 검사, 운송, 정보 처리 등이 포함됩니다.',
      '산출 (Output): 공정을 거쳐 완성된 제품과 서비스, 품질 기록, 고객에게 전달할 정보를 제공합니다.',
      '피드백 및 통제 (Feedback & Control): 불량률과 납기 준수율, 고객 반응을 점검하고 문제 원인을 다음 생산 계획과 공정 개선에 반영합니다.',
      '2) 단계 간 연계',
      '투입 정보가 정확하지 않으면 변환 과정에서 대기와 재작업이 늘어날 수 있습니다. 반대로 산출 결과를 구체적으로 측정하고 피드백하면 같은 문제가 반복되는 것을 줄일 수 있습니다. 생산관리자는 어느 한 단계만 최적화하기보다 전체 흐름에서 병목이 발생하는 지점을 찾아야 합니다.',
      '3. 결론',
      '생산시스템의 성과는 자원을 많이 투입하는 것보다 각 단계의 정보를 끊김 없이 연결하는 데 달려 있습니다. 투입, 변환, 산출, 피드백의 관계를 함께 관리할 때 품질과 효율을 안정적으로 높일 수 있습니다.'
    ].join('\n')
  },
  {
    id: 'swot_category_groups',
    mode: 'formal',
    basicStyle: 'report',
    headings: [
      'SWOT 분석',
      '강점 (Strength - 내부 긍정 요인)',
      '약점 (Weakness - 내부 부정 요인)',
      '기회 (Opportunity - 외부 긍정 요인)',
      '위협 (Threat - 외부 부정 요인)',
      '실행 방향'
    ],
    source: [
      'SWOT 분석',
      '강점 (Strength - 내부 긍정 요인)',
      '기술 역량: 회로 설계부터 시제품 검증까지 직접 수행한 경험이 있어 문제 발생 지점을 빠르게 좁힐 수 있습니다.',
      '협업 역량: 기구, 소프트웨어, 품질 부서와 요구사항을 조율하며 설계 변경의 영향 범위를 문서로 정리해 왔습니다.',
      '검증 경험: 시험 조건과 판정 기준을 먼저 정의한 뒤 결과를 성적서로 남겨 후속 설계의 근거로 활용했습니다.',
      '약점 (Weakness - 내부 부정 요인)',
      '보완 과제: 대규모 양산 이관 경험은 상대적으로 부족해 제조 공정 담당자와의 협업 범위를 더 넓힐 필요가 있습니다.',
      '시간 관리: 여러 검증 업무가 동시에 진행될 때 핵심 위험을 먼저 선별하는 기준을 더 정교하게 다듬어야 합니다.',
      '기회 (Opportunity - 외부 긍정 요인)',
      '시장 변화: 의료기기 전원 구조가 USB-C PD 중심으로 바뀌면서 기존 회로 설계 경험을 확장할 기회가 커지고 있습니다.',
      '직무 확장: 규격 대응과 시험 문서 작성 경험을 설계 초기 단계에 연결하면 개발 기간을 줄이는 데 기여할 수 있습니다.',
      '위협 (Threat - 외부 부정 요인)',
      '규제 변화: 국가별 인증 요구가 달라지면 동일 제품이라도 추가 시험과 설계 변경이 필요할 수 있습니다.',
      '부품 수급: 핵심 반도체의 단종이나 납기 지연은 일정과 원가에 동시에 영향을 줄 수 있습니다.',
      '실행 방향',
      '강점인 설계·검증 경험은 유지하되 양산과 인증 단계의 협업을 넓히겠습니다. 또한 부품 대체 가능성과 규격 요구를 설계 초기에 확인해 일정 지연 위험을 줄이겠습니다.'
    ].join('\n')
  },
  {
    id: 'technical_career_sections',
    mode: 'formal',
    basicStyle: 'report',
    headings: ['[현 직장 – 의료기기 하드웨어 개발]', '[이전 직장 – 방산 장비 개발]', '[향후 기여 방향]'],
    source: [
      '[현 직장 – 의료기기 하드웨어 개발]',
      '담당 역할: 임상적 요구를 성능 사양과 시스템 전원 구조로 구체화하고, 회로 설계와 핵심 부품 선정을 담당했습니다.',
      '핵심 과제: 전동식 모유착유기의 원가 절감형 설계 변경과 프리미엄 신제품 개발을 병행했습니다.',
      '설계 판단 (Design Decision): 1차 후보 펌프로 실현 가능성을 검증한 결과 목표 음압과 유량을 동시에 만족하기 어려웠습니다. 후보 부품의 소음, 소비전력, 크기, 원가를 비교해 고유량 듀얼 펌프 구조를 제안했고 내부 검토를 거쳐 채택했습니다.',
      '전원 구조 (Power Architecture): 전체 전력 예산을 다시 계산하고 일반 어댑터 방식과 USB-C PD 방식을 비교 검토했습니다. PD Sink IC 기반 전원 회로를 설계하고 PCB artwork와 Gerber file을 검토했습니다.',
      '검증 및 문서화: FDA 510(k) 대응을 위해 반복 동작 수명 시험 조건을 정의하고 시험용 F/W를 작성했습니다. 시험 결과는 내부 성적서로 문서화해 설계 검증 근거로 남겼습니다.',
      '[이전 직장 – 방산 장비 개발]',
      '담당 역할: 방산 레이더 장비와 RF PLL 모듈의 하드웨어 설계 검토 및 기능 시험을 수행했습니다.',
      '개발 절차: SRR, SDR, PDR, CDR 단계별 설계 검토에 참여해 요구사항과 설계 산출물의 추적 관계를 확인했습니다.',
      '시험 경험: 전원 무결성, 인터페이스 동작, 환경 조건별 기능을 점검하고 이상 현상의 재현 조건과 조치 결과를 시험 기록에 남겼습니다.',
      '성과: 고객 요구사항을 설계 산출물에 일관되게 반영하고 검증 결과로 설명하는 역량을 길렀습니다.',
      '[향후 기여 방향]',
      '요구사항 정의부터 회로 설계, 부품 선정, 검증, 인허가 문서화까지 이어지는 경험을 바탕으로 개발 초기에 위험을 발견하겠습니다. 설계 변경이 성능과 원가, 일정에 미치는 영향을 근거와 함께 제시해 의사결정의 정확도를 높이겠습니다.'
    ].join('\n')
  }
];

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, ...rest] = arg.slice(2).split('=');
    out[key] = rest.length ? rest.join('=') : '1';
  }
  return out;
}

function compact(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, '');
}

function anchorKey(value) {
  return compact(value).toLowerCase();
}

function labelPrefix(value) {
  const text = String(value || '').trim();
  const colon = text.search(/[:：]/u);
  return colon >= 0 ? text.slice(0, colon + 1) : '';
}

function outputLineIndex(records, anchor, prefix = false, start = 0) {
  const key = anchorKey(anchor);
  return records.findIndex((record, index) => {
    if (index < start || record.blank) return false;
    const line = anchorKey(record.text);
    return prefix ? line.startsWith(key) : line === key;
  });
}

function labelBlockGapAudit(source, output) {
  const sourceLines = layout.buildLineRecords(source).filter(record => !record.blank);
  const outputLines = layout.buildLineRecords(output);
  const failures = [];
  let cursor = 0;
  for (let index = 0; index < sourceLines.length - 1; index += 1) {
    const left = sourceLines[index];
    const right = sourceLines[index + 1];
    if (left.role !== 'label_inline' || right.role !== 'label_inline') continue;
    const leftPrefix = labelPrefix(left.text);
    const rightPrefix = labelPrefix(right.text);
    const leftIndex = outputLineIndex(outputLines, leftPrefix, true, cursor);
    const rightIndex = outputLineIndex(outputLines, rightPrefix, true, Math.max(cursor, leftIndex + 1));
    if (leftIndex < 0 || rightIndex < 0 || rightIndex !== leftIndex + 1) {
      failures.push({ left: leftPrefix, right: rightPrefix, gap: rightIndex - leftIndex });
    }
    if (rightIndex >= 0) cursor = rightIndex;
  }
  return { pass: failures.length === 0, failures };
}

function headingAudit(expected, output) {
  const records = layout.buildLineRecords(output).filter(record => !record.blank);
  const failures = [];
  let cursor = 0;
  for (const heading of expected || []) {
    const found = outputLineIndex(records, heading, false, cursor);
    if (found < 0) failures.push(heading);
    else cursor = found + 1;
  }
  return { pass: failures.length === 0, failures };
}

function validateRun(testCase, out) {
  const output = String(out?.result?.outputText || out?.outputText || '');
  const lineAnchors = structure.compareLineAnchorLayout(testCase.source, output);
  const inlineLabels = structure.compareInlineLabelBodyLayout(testCase.source, output);
  const headings = headingAudit(testCase.headings, output);
  const labelGaps = labelBlockGapAudit(testCase.source, output);
  const maxBlankRun = Math.max(0, ...(output.match(/\n+/gu) || []).map(value => value.length));
  const checks = {
    completed: out?.status !== 'error' && out?.status !== 'blocked' && Boolean(output),
    engineVersion: out?.engineMeta?.engineVersion === 'gpt-prod-v2.5.35',
    lineAnchors: lineAnchors.pass,
    inlineLabels: inlineLabels.pass,
    headings: headings.pass,
    labelGaps: labelGaps.pass,
    structureSignature: out?.engineMeta?.structureSignaturePass !== false,
    noExcessiveBlankRuns: maxBlankRun <= 2,
    contentPresent: compact(output).length >= Math.floor(compact(testCase.source).length * 0.72)
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    lineAnchorChanges: lineAnchors.boundaryChanges || [],
    inlineLabelSplits: inlineLabels.violations || [],
    missingHeadings: headings.failures,
    labelGapFailures: labelGaps.failures,
    maxBlankRun,
    output
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.execute !== '1') throw new Error('실제 API 비용이 발생합니다. --execute=1을 지정하세요.');
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY가 필요합니다.');
  if (!process.env.OPENAI_SAFETY_SALT) throw new Error('OPENAI_SAFETY_SALT가 필요합니다.');
  const iterations = Math.max(1, Math.min(5, Number.parseInt(args.iterations || '3', 10) || 3));
  const maximumUsd = Math.max(0.1, Number(args['max-usd'] || 2));
  const config = runtime.publicConfig(runtime.DEFAULT_CONFIG, 'live_layout_integrity_v2535');
  const results = [];
  let estimatedUsd = 0;
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    for (const testCase of CASES) {
      if (estimatedUsd >= maximumUsd) throw new Error(`비용 상한 도달: $${estimatedUsd.toFixed(4)} / $${maximumUsd.toFixed(2)}`);
      const started = Date.now();
      const out = await engine.run({
        text: testCase.source,
        mode: testCase.mode,
        basicStyle: testCase.basicStyle,
        allowPolish: true,
        uid: `live-layout-v2535-${testCase.id}-${iteration}`,
        config
      });
      const validation = validateRun(testCase, out);
      const cost = Number(out?.gptEngine?.usage?.estimatedUsd || out?.result?.humanizeMeta?.usage?.estimatedUsd || 0);
      estimatedUsd += cost;
      const row = {
        caseId: testCase.id,
        iteration,
        pass: validation.pass,
        checks: validation.checks,
        status: out?.status || '',
        qualityStatus: out?.qualityStatus || out?.result?.qualityStatus || '',
        effectStatus: out?.engineMeta?.effectStatus || '',
        profile: out?.engineMeta?.documentProfile || '',
        substantiveEditRatio: Number(out?.engineMeta?.substantiveEditRatio || 0),
        inlineLabelBodyRepairCount: Number(out?.engineMeta?.inlineLabelBodyRepairCount || 0),
        inlineLabelBodySplitCount: Number(out?.engineMeta?.inlineLabelBodySplitCount || 0),
        paragraphVisualGapRepairCount: Number(out?.engineMeta?.paragraphVisualGapRepairCount || 0),
        maxBlankRun: validation.maxBlankRun,
        estimatedUsd: cost,
        elapsedMs: Date.now() - started,
        failures: {
          lineAnchorChanges: validation.lineAnchorChanges,
          inlineLabelSplits: validation.inlineLabelSplits,
          missingHeadings: validation.missingHeadings,
          labelGapFailures: validation.labelGapFailures
        },
        outputExcerpt: validation.pass ? undefined : validation.output.slice(0, 1800)
      };
      results.push(row);
      console.log(JSON.stringify(row));
    }
  }
  const failed = results.filter(row => !row.pass);
  const summary = {
    engineVersion: engine.VERSION,
    iterations,
    caseCount: CASES.length,
    runCount: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    needsReview: results.filter(row => row.qualityStatus === 'needs_review').length,
    inlineLabelRepairs: results.reduce((sum, row) => sum + row.inlineLabelBodyRepairCount, 0),
    residualInlineLabelSplits: results.reduce((sum, row) => sum + row.inlineLabelBodySplitCount, 0),
    totalEstimatedUsd: Number(estimatedUsd.toFixed(6)),
    maximumUsd,
    pass: failed.length === 0
  };
  console.log(JSON.stringify({ summary }, null, 2));
  if (!summary.pass) process.exitCode = 2;
}

main().catch(error => {
  console.error(JSON.stringify({ error: String(error?.message || error).slice(0, 500) }));
  process.exitCode = 1;
});
