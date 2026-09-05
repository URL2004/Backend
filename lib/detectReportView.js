'use strict';

const sg = require('../engine/surfaceguard');
const { assessCauseCoverage } = require('./detectSignalPolicy');
const { buildDetectInterpretation } = require('./detectInterpretation');

const SYNTHESIS_LIMITATION = '문체 패턴을 바탕으로 한 참고 결과이며 작성 주체나 외부 검사 결과를 확정하지 않아요.';
const PROFESSOR_RADAR_DISCLAIMER = '현재 점수에 맞춘 서비스 내 해석이며, 실제 교수님의 판단·과제 평가나 외부 AI 감지 도구의 통과를 보장하지 않아요.';

function normalizeScore(value) {
  if (value === null || value === undefined || value === '') return null;
  const score = Number(value);
  if (!Number.isFinite(score)) return null;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function resolveProfessorRadar(scoreValue) {
  const score = normalizeScore(scoreValue);
  if (score === null) {
    return {
      status: 'limited',
      score: null,
      band: 'unknown',
      range: null,
      label: '판정 보류',
      headline: '교수님 레이더 · 판정 보류',
      disclaimer: PROFESSOR_RADAR_DISCLAIMER
    };
  }
  if (score >= 50) {
    return {
      status: 'ready', score, band: 'hard', range: '50~100',
      label: 'AI식 문체 신호 높음', headline: 'AI식 문체 신호 · 높음',
      disclaimer: PROFESSOR_RADAR_DISCLAIMER
    };
  }
  if (score >= 21) {
    return {
      status: 'ready', score, band: 'revise', range: '21~49',
      label: 'AI식 문체 신호 중간', headline: 'AI식 문체 신호 · 중간',
      disclaimer: PROFESSOR_RADAR_DISCLAIMER
    };
  }
  return {
    status: 'ready', score, band: 'low', range: '0~20',
    label: 'AI식 문체 신호 낮음', headline: 'AI식 문체 신호 · 낮음',
    disclaimer: PROFESSOR_RADAR_DISCLAIMER
  };
}

function resolveStyleBand(score, riskLevel) {
  if (score === null) return 'unknown';
  if (['low', 'moderate', 'high'].includes(riskLevel)) return riskLevel;
  if (score <= 20) return 'low';
  if (score <= 49) return 'moderate';
  return 'high';
}

const CONTENT_MIN_SENTENCES = 3;   // 이 미만이면 내용 근거 판정 보류(limited)
const SAMPLE_SMALL_SENTENCES = 5;  // 이 미만이면 계측 띠·레이더에 "표본 적음"을 붙인다

// ── 원인 레이더 축 정책(2026-09-03) ────────────────────────────────────────────
// 구체 근거·화자 입장은 글 종류마다 "있어야 정상"인 정도가 다르고, 문장이 적으면 비율 자체가 무의미하다.
// 축마다 on(기준 적용) · off(이 글 종류엔 해당 없음, 또는 종류를 못 가려 비활성) · sparse(문장 부족)를
// 내려보내고 프런트는 정책대로 그리기만 한다. 점수(AI 티 지수)와는 무관하다 — 원인 설명 전용.
// 기준값(target)은 2026-09-03 운영 감지 입력 1,077건을 현재 결정론 계측기로 전수 재생해 다시 잡았다.
// 숫자·고유명사만 세던 realAnchor는 보고서·학생 기록의 구체 사례를 놓쳐서, 설명·기록 계열은
// lived+specific 문장 비율(grounded)을 쓴다. 자소서·에세이는 실제 경험(lived)을 계속 별도로 본다.
const RADAR_AXIS_POLICY_VERSION = 'axis-policy-v3-ops1077';
const AXIS_MIN_SENTENCES = Object.freeze({ uniform: 4, ending: 4, generic: 3, anchor: 6, stance: 6 });
const AXIS_PROFILE_LABELS = Object.freeze({
  academic_paper: '논문', report_assignment: '보고서·과제', long_explainer: '설명글', clinical_record: '진료 기록',
  legal_contract: '계약·법률 문서', student_record_teacher: '학생 기록', student_self_assessment: '자기평가서',
  resume_application: '자기소개서', personal_essay: '에세이', review_blog: '후기·블로그', social: 'SNS 글',
  marketing: '홍보 문구', mail_notice: '안내문', creative: '창작 글', general: '일반 글', unknown: '종류 미확정'
});
// anchor.metric: 'grounded' = 구체 사실·경험 문장 비율, 'anchor' = 숫자·연도·고유명사·행동 문장 비율,
// 'lived' = 실제 경험 문장 비율.
// target = 이 비율이면 '부족 0'. off인 축은 reason이 화면 문구가 된다.
const AXIS_POLICY_BY_PROFILE = Object.freeze({
  academic_paper: { anchor: { status: 'on', metric: 'grounded', target: 0.20 }, stance: { status: 'off', reason: '논문은 사견보다 근거가 우선이라 화자 입장 축은 보지 않아요' } },
  report_assignment: { anchor: { status: 'on', metric: 'grounded', target: 0.20 }, stance: { status: 'off', reason: '보고서·과제에는 화자 입장이 꼭 필요하지 않아 이 축은 보지 않아요' } },
  long_explainer: { anchor: { status: 'on', metric: 'grounded', target: 0.15 }, stance: { status: 'off', reason: '설명글에는 화자 입장이 꼭 필요하지 않아 이 축은 보지 않아요' } },
  clinical_record: { anchor: { status: 'on', metric: 'grounded', target: 0.20 }, stance: { status: 'off', reason: '기록 문서에는 화자 입장이 필요하지 않아 이 축은 보지 않아요' } },
  legal_contract: { anchor: { status: 'on', metric: 'grounded', target: 0.15 }, stance: { status: 'off', reason: '계약·법률 문서에는 화자 입장이 필요하지 않아 이 축은 보지 않아요' } },
  mail_notice: { anchor: { status: 'off', reason: '안내문은 구체 근거 축을 보지 않아요' }, stance: { status: 'off', reason: '안내문에는 화자 입장이 필요하지 않아 이 축은 보지 않아요' } },
  marketing: { anchor: { status: 'off', reason: '홍보 문구는 구체 근거 축을 보지 않아요' }, stance: { status: 'off', reason: '홍보 문구에는 화자 입장이 필요하지 않아 이 축은 보지 않아요' } },
  student_record_teacher: { anchor: { status: 'on', metric: 'grounded', target: 0.20 }, stance: { status: 'off', reason: '교사가 3인칭으로 쓰는 기록이라 화자 입장 축은 보지 않아요' } },
  student_self_assessment: { anchor: { status: 'on', metric: 'lived', target: 0.20 }, stance: { status: 'on', target: 0.20 } },
  resume_application: { anchor: { status: 'on', metric: 'lived', target: 0.15 }, stance: { status: 'on', target: 0.20 } },
  personal_essay: { anchor: { status: 'on', metric: 'lived', target: 0.20 }, stance: { status: 'on', target: 0.18 } },
  review_blog: { anchor: { status: 'on', metric: 'grounded', target: 0.20 }, stance: { status: 'on', target: 0.18 } },
  social: { anchor: { status: 'off', reason: 'SNS 글은 구체 근거 축을 보지 않아요' }, stance: { status: 'on', target: 0.20 } },
  creative: { anchor: { status: 'off', reason: '창작 글은 구체 근거 축을 보지 않아요' }, stance: { status: 'off', reason: '창작 글은 화자 입장 축을 보지 않아요' } },
  general: { anchor: { status: 'off', reason: '글 종류를 확실히 가리지 못해 이 축은 보지 않았어요' }, stance: { status: 'off', reason: '글 종류를 확실히 가리지 못해 이 축은 보지 않았어요' } },
  unknown: { anchor: { status: 'off', reason: '글 종류를 확실히 가리지 못해 이 축은 보지 않았어요' }, stance: { status: 'off', reason: '글 종류를 확실히 가리지 못해 이 축은 보지 않았어요' } }
});
const AXIS_LOW_CONFIDENCE = 0.55;
const AXIS_AMBIGUOUS_PROFILE_MARGIN = 0.5;
const AXIS_LOW_CONFIDENCE_REASON = '글 종류를 확실히 가리지 못해 이 축은 보지 않았어요';
const AXIS_AMBIGUOUS_REASON = '비슷한 글 종류가 함께 감지돼 이 축은 보지 않았어요';
const AXIS_SPARSE_REASON = '문장이 적어 재지 않았어요';
const AXIS_SPARSE_ALL_NOTE = '짧은 글은 문체 통계 신호를 잴 수 없어요. 600자쯤(약 8문장)부터 원인 분석이 열려요.';

function resolveRadarAxisPolicy({ profile, confidence, profileMargin, sentenceTotal } = {}) {
  const total = Math.max(0, Math.floor(Number(sentenceTotal) || 0));
  const conf = Number.isFinite(Number(confidence)) ? Number(confidence) : 0;
  const margin = Number.isFinite(Number(profileMargin)) ? Math.max(0, Number(profileMargin)) : null;
  let key = String(profile || 'unknown');
  if (!AXIS_POLICY_BY_PROFILE[key]) key = 'unknown';
  const lowConfidence = key === 'unknown' || conf < AXIS_LOW_CONFIDENCE;
  const ambiguousProfile = margin !== null && margin < AXIS_AMBIGUOUS_PROFILE_MARGIN;
  const base = AXIS_POLICY_BY_PROFILE[key];
  const sparse = (axis) => total < AXIS_MIN_SENTENCES[axis];
  const simple = (axis) => (sparse(axis)
    ? { status: 'sparse', reason: AXIS_SPARSE_REASON, minSentences: AXIS_MIN_SENTENCES[axis] }
    : { status: 'on', reason: null });
  const conditioned = (axis, spec) => {
    if (sparse(axis)) {
      return { status: 'sparse', metric: spec.metric || axis, target: null, reason: AXIS_SPARSE_REASON, minSentences: AXIS_MIN_SENTENCES[axis] };
    }
    if (spec.status === 'off') return { status: 'off', metric: spec.metric || axis, target: null, reason: spec.reason };
    // 흐린 막대도 실제 등급처럼 읽힌다. 글 종류가 불확실하거나 경계가 모호하면
    // 종류 의존 축을 참고값으로 그리지 않고 아예 비활성화한다.
    if (lowConfidence || ambiguousProfile) {
      return {
        status: 'off', metric: spec.metric || axis, target: null,
        reason: ambiguousProfile && !lowConfidence ? AXIS_AMBIGUOUS_REASON : AXIS_LOW_CONFIDENCE_REASON
      };
    }
    return { status: 'on', metric: spec.metric || axis, target: spec.target, reason: null };
  };
  const axes = {
    uniform: simple('uniform'),
    ending: simple('ending'),
    generic: simple('generic'),
    anchor: conditioned('anchor', base.anchor),
    stance: conditioned('stance', base.stance)
  };
  const allSparse = Object.values(axes).every((axis) => axis.status === 'sparse');
  return {
    version: RADAR_AXIS_POLICY_VERSION,
    profile: key,
    profileLabel: AXIS_PROFILE_LABELS[key] || AXIS_PROFILE_LABELS.unknown,
    confidence: Number(conf.toFixed(3)),
    profileMargin: margin === null ? null : Number(margin.toFixed(3)),
    lowConfidence,
    ambiguousProfile,
    sentenceTotal: total,
    mode: allSparse ? 'sparse_all' : 'axes',
    note: allSparse ? AXIS_SPARSE_ALL_NOTE : null,
    axes
  };
}

function resolveContentEvidence(measurements = {}) {
  const details = Array.isArray(measurements.detail) ? measurements.detail : [];
  const genericness = measurements.genericness || {};
  const lived = details.reduce((sum, item) => sum + Math.max(0, Number(item?.lived) || 0), 0);
  const specific = details.reduce((sum, item) => sum + Math.max(0, Number(item?.specific) || 0), 0);
  const detailTotal = details.reduce((sum, item) => sum + Math.max(0, Number(item?.sents) || 0), 0);
  const total = Math.max(0, Number(genericness.total) || detailTotal || 0);
  const generic = Math.min(total, Math.max(0, Number(genericness.count) || 0));

  if (!total) {
    return {
      status: 'limited', label: '분석 근거 부족', lived: 0, specific: 0,
      generic: 0, total: 0, groundedRatio: null
    };
  }
  // 1~2문장은 근거를 "확인했다"고 말할 표본이 아니다. 계측은 그대로 주되 판정·전환은 보류한다.
  if (total < CONTENT_MIN_SENTENCES) {
    return {
      status: 'limited', label: '문장이 적어 판정 보류', lived, specific, generic, total,
      groundedRatio: Number((Math.min(total, lived + specific) / total).toFixed(3))
    };
  }

  // lived와 specific은 한 문장에서 겹칠 수 있으므로 총 문장 수를 넘지 않게 제한한다.
  const groundedRatio = Math.min(total, lived + specific) / total;
  if (groundedRatio >= 0.35) {
    return {
      status: 'strong', label: '구체 근거 충분', lived, specific, generic, total,
      groundedRatio: Number(groundedRatio.toFixed(3))
    };
  }
  if (groundedRatio >= 0.125) {
    return {
      status: 'mixed', label: '구체 근거 일부', lived, specific, generic, total,
      groundedRatio: Number(groundedRatio.toFixed(3))
    };
  }
  return {
    status: 'weak', label: '근거 보강 필요', lived, specific, generic, total,
    groundedRatio: Number(groundedRatio.toFixed(3))
  };
}

function buildSynthesis(styleBand, contentStatus) {
  const evidenceClause = contentStatus === 'strong'
    ? '구체적인 근거는 충분히 확인됐어요.'
    : contentStatus === 'mixed'
      ? '구체적인 근거는 일부만 확인됐어요.'
      : contentStatus === 'weak'
        ? '구체적인 근거는 더 보강할 필요가 있어요.'
        : '내용 근거는 아직 충분히 분석하지 못했어요.';

  if (styleBand === 'high') {
    return {
      headline: `문장 패턴은 정형적이고, ${evidenceClause}`,
      description: contentStatus === 'strong'
        ? '구체적인 사실은 유지하고, 반복되는 종결과 정형적인 연결만 먼저 다듬어 보세요.'
        : '원문의 핵심 내용은 유지하고, 반복되는 종결과 일반적인 결론 문장을 먼저 다듬어 보세요.',
      limitation: SYNTHESIS_LIMITATION
    };
  }
  if (styleBand === 'moderate') {
    return {
      headline: `일부 문장 패턴이 정형적으로 보이고, ${evidenceClause}`,
      description: '구체적인 내용은 유지한 채 반복되는 문장 구조부터 선별해서 다듬어 보세요.',
      limitation: SYNTHESIS_LIMITATION
    };
  }
  if (styleBand === 'low') {
    return {
      headline: `AI식 문체 신호는 낮고, ${evidenceClause}`,
      description: contentStatus === 'weak'
        ? '문체 점수는 낮지만 주장에 근거가 필요한 부분은 별도로 보강해 보세요.'
        : '현재 글의 구체적인 내용과 표현을 우선 유지해도 좋아요.',
      limitation: SYNTHESIS_LIMITATION
    };
  }
  return {
    headline: '분석 가능한 문체 근거가 충분하지 않아요.',
    description: '결과를 단정하거나 유료 수정을 권하지 않고, 입력 상태를 먼저 확인해 주세요.',
    limitation: SYNTHESIS_LIMITATION
  };
}

function buildDetectReportView({
  probability,
  probSource,
  riskLevel,
  calibrationApplied = false,
  preCalibrationProbability = null,
  measurements = {},
  documentProfile = null,
  confidence = null,
  textLength = null,
  signalEvidence = [],
  signals = []
} = {}) {
  const score = normalizeScore(probability);
  const source = probSource === 'llm' ? 'llm' : 'engine';
  const sourceLimited = source !== 'llm';
  const scoreRadar = resolveProfessorRadar(score);
  const professorRadar = sourceLimited
    ? {
        ...scoreRadar,
        status: 'limited',
        band: 'unknown',
        // "판정 보류"는 사장님 지시로 금지된 표현이다(routes/detectreport.js). 게이지는 숫자를 보여주되,
        // 약한 추정을 모델 판정과 같은 무게로 내밀지도 않는 중간 표현을 쓴다.
        label: '간이 추정 기준',
        headline: '교수님 레이더 · 간이 추정 기준',
        description: 'AI 모델 분석이 완료되지 않아 문체 엔진의 간이 추정만 확인됐어요.',
        disclaimer: PROFESSOR_RADAR_DISCLAIMER
      }
    : scoreRadar;
  const styleBand = resolveStyleBand(score, riskLevel);
  const styleBandLabel = { low: '낮음', moderate: '중간', high: '높음', unknown: '판정 보류' }[styleBand];
  const contentEvidence = resolveContentEvidence(measurements);
  const measurable = score !== null && contentEvidence.status !== 'limited' && !sourceLimited;
  const uniformity = measurements.uniformity || {};
  const genericness = measurements.genericness || {};
  const realAnchorDensity = measurements.realAnchorDensity || {};
  const stance = measurements.stance || {};
  const axisPolicy = resolveRadarAxisPolicy({
    profile: documentProfile && documentProfile.profile,
    confidence: documentProfile && documentProfile.confidence,
    profileMargin: documentProfile && documentProfile.profileMargin,
    sentenceTotal: contentEvidence.total
  });
  const causeAnalysis = assessCauseCoverage(
    score,
    Array.isArray(signalEvidence) && signalEvidence.length ? signalEvidence : signals,
    { source, calibrated: calibrationApplied === true }
  );
  causeAnalysis.scoreBasis = calibrationApplied === true ? 'calibrated_display_score' : 'display_score';
  causeAnalysis.calibrationApplied = calibrationApplied === true;
  causeAnalysis.preCalibrationScore = calibrationApplied === true
    ? normalizeScore(preCalibrationProbability)
    : null;
  if (calibrationApplied === true && causeAnalysis.status === 'aligned') {
    causeAnalysis.label = '표시 점수와 원문에서 관찰된 문체 특징을 함께 확인해 주세요.';
  }
  const reportStatus = !measurable
    ? 'limited'
    : causeAnalysis.status === 'aligned'
      ? 'ready'
      : 'partial';
  const synthesis = sourceLimited
    ? {
        headline: 'AI 모델 분석이 완료되지 않아 간이 추정만 표시해요.',
        description: '현재 점수만으로 유료 수정을 권하지 않고, 입력을 확인한 뒤 다시 분석해 주세요.',
        limitation: SYNTHESIS_LIMITATION
      }
    : causeAnalysis.status === 'partial'
      ? {
          headline: '점수는 확인됐지만 원인 설명은 일부만 연결됐어요.',
          description: '표시된 원인만으로 점수를 충분히 설명하기 어려워 단정적인 수정 권고는 하지 않아요.',
          limitation: SYNTHESIS_LIMITATION
        }
      : buildSynthesis(styleBand, contentEvidence.status);

  return {
    version: 'evidence-v3-cause-aligned',
    interpretation: buildDetectInterpretation({
      probability: score, probSource: source, confidence, textLength,
      sentenceTotal: contentEvidence.total,
      signalEvidence,
      causeCoverageStatus: causeAnalysis.status
    }),
    status: reportStatus,
    alignment: {
      status: reportStatus === 'ready' ? 'aligned' : reportStatus,
      label: reportStatus === 'ready'
        ? '점수·교수님 레이더·설명을 같은 기준으로 정렬했어요.'
        : reportStatus === 'partial'
          ? '점수는 표시하되 확인된 원인이 충분하지 않아 부분 설명으로 표시해요.'
        : sourceLimited
          ? 'AI 모델 분석이 완료되지 않아 간이 추정 결과로 제한했어요.'
          : '표시 가능한 점수나 내용 근거가 부족해요.',
      scoreBand: styleBand,
      evidenceStatus: contentEvidence.status,
      causeCoverageStatus: causeAnalysis.status
    },
    styleSignal: {
      status: score === null || sourceLimited ? 'limited' : 'ready',
      score,
      band: styleBand,
      bandLabel: styleBandLabel,
      label: `AI식 문체 신호 · ${styleBandLabel}`,
      source,
      sourceLabel: source === 'llm' ? 'AI 모델 분석' : '문체 엔진 간이 추정',
      calibrated: calibrationApplied === true
    },
    professorRadar,
    contentEvidence,
    causeAnalysis,
    synthesis,
    measuredEvidence: {
      maxEndingRun: Number.isFinite(Number(uniformity.maxEndingRun)) ? Number(uniformity.maxEndingRun) : null,
      avgLength: Number.isFinite(Number(uniformity.avgLength)) ? Number(uniformity.avgLength) : null,
      lengthCV: Number.isFinite(Number(uniformity.lengthCV)) ? Number(uniformity.lengthCV) : null,
      paragraphCountCV: Number.isFinite(Number(uniformity.paragraphCountCV)) ? Number(uniformity.paragraphCountCV) : null,
      genericCount: contentEvidence.generic,
      genericTotal: contentEvidence.total,
      livedCount: contentEvidence.lived,
      livedTotal: contentEvidence.total,
      specificCount: contentEvidence.specific,
      specificTotal: contentEvidence.total,
      groundedCount: Math.min(contentEvidence.total, contentEvidence.lived + contentEvidence.specific),
      groundedRatio: contentEvidence.groundedRatio,
      realAnchorCount: Math.max(0, Number(realAnchorDensity.count) || 0),
      realAnchorTotal: Math.max(0, Number(realAnchorDensity.total) || 0),
      genericRatio: Number.isFinite(Number(genericness.ratio)) ? Number(genericness.ratio) : null,
      // 레이더(원인 분석) 축에 쓰는 값 — 전부 결정론 계측이라 추가 비용이 없다.
      realAnchorRatio: Number.isFinite(Number(realAnchorDensity.ratio)) ? Number(realAnchorDensity.ratio) : null,
      stanceRatio: Number.isFinite(Number(stance.ratio)) ? Number(stance.ratio) : null,
      // 표본 크기 — 2문장 통계를 786문장과 같은 확신으로 보이지 않게 화면이 한 줄 붙인다.
      sentenceTotal: contentEvidence.total,
      sampleSize: contentEvidence.total < SAMPLE_SMALL_SENTENCES ? 'small' : 'ok',
      // 축 정책 — 글 종류·문장 수에 따라 어떤 축을 어떤 기준으로 보는지. 프런트는 이대로 그린다.
      axisPolicy
    },
    preservation: {
      label: '유지할 근거',
      items: [
        { key: 'lived', label: '실제 경험 문장', count: contentEvidence.lived, status: 'preserve' },
        { key: 'specific', label: '구체 사실 문장', count: contentEvidence.specific, status: 'preserve' },
        { key: 'grounding', label: '원문 밖 새 사실', value: '생성하지 않음', status: 'guarded' }
      ]
    },
    conversion: {
      eligible: reportStatus === 'ready' && professorRadar.band !== 'low',
      action: reportStatus === 'ready' && professorRadar.band !== 'low' ? 'review_recommendation' : 'keep_or_review_input'
    }
  };
}

// ── 미리보기 게이트 ─────────────────────────────────────────────────────────
//   다듬은 문장을 통째로 보여주면 짧은 글은 감지만 돌려 다듬어 가는 구멍이 생긴다(사장님 9/2).
//   원문(before)과 다듬은 문장(after)을 낱말 단위로 대조해 "새로 쓰인 낱말이 가장 길게 이어진 자리"
//   주변 12~18자만 공개하고, 나머지는 같은 길이의 무의미한 글자로 바꿔 화면이 블러로 덮는다.
//   원문 나머지는 응답에 실리지 않으므로 네트워크 탭으로도 꺼낼 수 없다.
const EXAMPLE_PREVIEW_MIN = 12;
const EXAMPLE_PREVIEW_MAX = 18;
function scrambleText(text) {
  return String(text || '')
    .replace(/[가-힣]/gu, () => String.fromCharCode(0xac00 + Math.floor(Math.random() * 11172)))
    .replace(/[A-Za-z]/gu, 'x')
    .replace(/[0-9]/gu, '0');
}
function wordSpans(text) {
  const out = [];
  const re = /\S+/gu;
  let m;
  while ((m = re.exec(text)) !== null) {
    const key = String(m[0]).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (key) out.push({ word: m[0], key, start: m.index, end: m.index + m[0].length });
  }
  return out;
}
// 두 문장의 낱말 LCS에서 서로 대응하는 하나의 edit block을 고른다. before와
// after를 따로 골랐던 구현은 변경 지점이 여러 개일 때 서로 다른 구간을 짝지을
// 수 있었다. 삽입·삭제는 반대편에 길이 0인 위치를 내려 화면이 정확한 자리에
// caret/삭제 표시를 그릴 수 있게 한다.
function tokenRange(spans, startIndex, endIndex) {
  if (startIndex < endIndex) {
    const start = spans[startIndex].start;
    const end = spans[endIndex - 1].end;
    return { start, end, len: end - start };
  }
  const position = startIndex < spans.length
    ? spans[startIndex].start
    : spans.length
      ? spans[spans.length - 1].end
      : 0;
  return { start: position, end: position, len: 0 };
}
function changedSpans(before, after) {
  const Aw = wordSpans(before), Bw = wordSpans(after);
  const A = Aw.map(w => w.key), B = Bw.map(w => w.key);
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const matches = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { matches.push({ before: i, after: j }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  let previousBefore = -1;
  let previousAfter = -1;
  let best = null;
  for (const match of [...matches, { before: n, after: m }]) {
    const beforeStart = previousBefore + 1;
    const afterStart = previousAfter + 1;
    if (beforeStart < match.before || afterStart < match.after) {
      const beforeRange = tokenRange(Aw, beforeStart, match.before);
      const afterRange = tokenRange(Bw, afterStart, match.after);
      const changeKind = beforeRange.len === 0
        ? 'insertion'
        : afterRange.len === 0
          ? 'deletion'
          : 'replacement';
      const score = Math.max(beforeRange.len, afterRange.len);
      const candidate = { before: beforeRange, after: afterRange, changeKind, score };
      if (!best
          || candidate.score > best.score
          || (candidate.score === best.score && candidate.after.start < best.after.start)) {
        best = candidate;
      }
    }
    previousBefore = match.before;
    previousAfter = match.after;
  }
  return best
    ? { before: best.before, after: best.after, changeKind: best.changeKind }
    : { before: null, after: null, changeKind: 'none' };
}
function mostChangedSpan(before, after) {
  return changedSpans(before, after).after;
}
function normalizedPreviewText(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}
function meaningfulPreviewChange(before, after) {
  const source = String(before || '').trim();
  const output = String(after || '').trim();
  if (!source || !output || normalizedPreviewText(source) === normalizedPreviewText(output)) return null;
  const spans = changedSpans(source, output);
  if (!spans.before || !spans.after || spans.changeKind === 'none') return null;
  const beforeChanged = source.slice(spans.before.start, spans.before.end);
  const afterChanged = output.slice(spans.after.start, spans.after.end);
  const beforeNormalized = normalizedPreviewText(beforeChanged);
  const afterNormalized = normalizedPreviewText(afterChanged);
  if (spans.changeKind === 'replacement' && (!beforeNormalized || !afterNormalized)) return null;
  if (spans.changeKind === 'insertion' && !afterNormalized) return null;
  if (spans.changeKind === 'deletion' && !beforeNormalized) return null;
  if (beforeNormalized && afterNormalized && beforeNormalized === afterNormalized) return null;
  return spans;
}
function splitExamplePreview(after, before) {
  const text = String(after || '').trim();
  if (!text) return null;
  const change = meaningfulPreviewChange(before, text);
  if (!change) return null;
  const total = text.length;
  if (total <= EXAMPLE_PREVIEW_MAX) {
    return {
      parts: [{ text, visible: true }], preview: text, hiddenLength: 0, totalLength: total,
      gated: false, anchor: 'changed', meaningfulChange: true, changeKind: change.changeKind,
      beforeFocus: { start: change.before.start, end: change.before.end },
      afterFocus: { start: change.after.start, end: change.after.end }
    };
  }
  // 공개 창은 실제 어휘가 달라진 구간만 기준으로 잡는다. 같은 문장·공백·구두점
  // 교정은 위에서 제거되므로 바뀌지 않은 머리 문장을 예시로 내보내지 않는다.
  const changed = change.after;
  const anchor = 'changed';
  const want = Math.max(EXAMPLE_PREVIEW_MIN, Math.min(EXAMPLE_PREVIEW_MAX, changed.len));
  const proposedStart = changed.len === 0 ? changed.start - Math.floor(want / 2) : changed.start;
  let start = Math.max(0, Math.min(proposedStart, total - want));
  let end = Math.min(total, start + want);
  // 낱말 중간에서 끊기지 않게 창 안쪽으로 당긴다(최소 길이는 지킨다)
  if (start > 0 && !/\s/u.test(text[start - 1])) {
    const back = text.lastIndexOf(' ', start);
    if (back >= 0 && end - (back + 1) <= EXAMPLE_PREVIEW_MAX) start = back + 1;
  }
  if (end < total && !/\s/u.test(text[end])) {
    const fwd = text.indexOf(' ', end);
    if (fwd >= 0 && fwd - start <= EXAMPLE_PREVIEW_MAX) end = fwd;
  }
  const parts = [];
  if (start > 0) parts.push({ text: scrambleText(text.slice(0, start)), visible: false });
  parts.push({ text: text.slice(start, end), visible: true });
  if (end < total) parts.push({ text: scrambleText(text.slice(end)), visible: false });
  const beforeSpan = change.before;
  // The public preview may expose only part of a long changed run. Return the
  // intersection with that visible window so the client can prove and mark the
  // change instead of rejecting the whole preview because hidden text exists.
  const visibleAfterStart = Math.max(changed.start, start);
  const visibleAfterEnd = Math.min(changed.end, end);
  return {
    parts,
    preview: text.slice(start, end),
    hiddenLength: total - (end - start),
    totalLength: total,
    gated: total - (end - start) > 0,
    anchor,
    meaningfulChange: true,
    changeKind: change.changeKind,
    beforeFocus: { start: beforeSpan.start, end: beforeSpan.end },
    afterFocus: { start: visibleAfterStart, end: Math.max(visibleAfterStart, visibleAfterEnd) }
  };
}

// 미리보기는 문단 등급이 아니라 문장 자체를 다시 판정한다. 구체 문단 안의 일반론 문장은
// 후보가 될 수 있지만, 실제 경험·수치·인용 등 구체 사실 문장은 제외해 새 사실 생성을 유도하지 않는다.
function pickAiSentence(paras, detail) {
  const candidates = [];
  (Array.isArray(paras) ? paras : []).forEach((paragraph, index) => {
    const paragraphKind = detail?.[index]?.kind || 'thin';
    const paragraphPriority = paragraphKind === 'abstract_risk' ? 3 : paragraphKind === 'thin' ? 2 : 1;
    sg.splitSentences(paragraph).forEach(sentence => {
      if (sentence.length < 30 || sentence.length > 160) return;
      if (sg.isLivedScene(sentence)) return;
      if (sg.classifyParagraphKind(sentence) === 'concrete') return;
      candidates.push({ sentence, paragraphPriority });
    });
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.paragraphPriority - a.paragraphPriority || b.sentence.length - a.sentence.length);
  return candidates[0].sentence;
}

// ── 문장 지도(2026-09-01) ────────────────────────────────────────────────────
// 보고서가 "왜 이 점수인지"를 사용자 문장으로 직접 보여주려면 문단 집계만으로는 부족하다.
// 문장마다 유지할 근거인지 다듬을 후보인지 표시하되, 3만자 문서(문장 수백 개)에서도
// 응답과 렌더가 무너지지 않게 두 층으로 나눈다.
//   ① paragraphs — 항상 전량. 문단별 집계라 길이와 무관하게 작다.
//   ② sentences  — 신호·근거 위주로 상한까지만. 넘치면 capped로 알리고 화면이 그렇게 말한다.
// LLM을 부르지 않으므로 비용은 늘지 않는다.
const SENTENCE_TEXT_CAP = 240;    // 문장 하나를 보내는 최대 길이
const SENTENCE_SHOW_CAP = 200;    // 장문에서 문장 마크를 보내는 최대 개수
const PRESERVE_SHOW_CAP = 40;     // 그중 "유지할 근거"가 차지할 수 있는 몫
const PARA_FAIR_SHARE = 0.6;      // 상한을 넘는 장문에서 "문단마다 한 문장"에 먼저 배정하는 몫
// 프론트 문단 지도가 "신호 많음"(진한 칸)으로 칠하는 기준과 같은 값이어야 한다.
// 지도가 진하게 칠한 칸은 눌렀을 때 반드시 문장이 있어야 하므로, 이 비율 이상인 문단은
// 예산 배분에서 무조건 먼저 한 문장을 가져간다. (Frontend assets/js/evasion-flow.js repParaLevel)
const PARA_HOT_RATIO = 0.5;
const ENDING_RUN_MIN = 4;         // 같은 활용이 이만큼 이어지면 리듬 신호로 본다(3은 한국어 격식체에서 흔하다)
const ENDING_KEY_LENGTH = 4;

// 종결 비교용 꼬리 — 엔진(surfaceguard.endingGroup)과 같은 4글자 기준.
// 3글자("습니다")로 자르면 합니다체 문장 전부가 같은 종결이 되어 마침표에 밑줄 치는 꼴이 된다.
// "했습니다 / 겠습니다 / 입니다 / 었습니다"처럼 활용 단위로 봐야 "같은 활용 반복"이라는 진짜 신호가 잡힌다.
function sentenceEnding(sentence) {
  const hangulTail = (String(sentence || '')
    .trim()
    .replace(/[^가-힣]+$/u, '')
    .match(/[가-힣]+$/u) || [''])[0];
  return hangulTail.slice(-ENDING_KEY_LENGTH);
}

// 문장 하나의 성격. lived와 specific은 "유지할 근거", generic은 "다듬을 후보"다.
// classifyParagraphKind는 단일 문장을 한 문단으로 보고 판정하므로 그대로 쓸 수 있다.
function classifySentenceKind(sentence) {
  if (sg.isLivedScene(sentence)) return 'lived';
  if (sg.classifyParagraphKind(sentence) === 'concrete') return 'specific';
  const generic = sg.measureGenericness(sentence);
  return generic && generic.count > 0 ? 'generic' : 'plain';
}

// 같은 종결이 연속으로 몇 개 이어졌는지 문서 전체 순서로 계산해 각 문장에 심는다.
// 상한 때문에 일부만 전송되더라도 이 값은 잘리기 전 전체 순서 기준이라 정확하다.
// runStart는 화면이 "8문장 연속" 배지를 줄마다 반복하지 않고 묶음의 첫 줄에만 붙이게 한다.
function markEndingRuns(marks) {
  // 1차: 묶음 경계를 전부 찾는다.
  const runs = [];
  let runStart = 0;
  for (let index = 1; index <= marks.length; index += 1) {
    const sameAsRun = index < marks.length
      && marks[index].ending
      && marks[index].ending === marks[runStart].ending;
    if (sameAsRun) continue;
    if (marks[runStart].ending) runs.push({ start: runStart, end: index, length: index - runStart });
    runStart = index;
  }
  // 2차: 가장 긴 묶음 하나만 표시한다(동률이면 앞쪽). 4문장 미만이면 아무것도 표시하지 않는다.
  // 격식체 문서는 짧은 반복이 곳곳에 있어서, 전부 칠하면 밑줄이 정보를 잃고 도구가 순진해 보인다.
  const longest = runs.reduce((best, run) => (run.length > (best ? best.length : 0) ? run : best), null);
  if (!longest || longest.length < ENDING_RUN_MIN) return;
  for (let inner = longest.start; inner < longest.end; inner += 1) {
    marks[inner].endingRun = longest.length;
    marks[inner].runStart = inner === longest.start;
  }
}

function buildSentenceMap(paras, detail) {
  const paragraphs = Array.isArray(paras) ? paras : [];
  const marks = [];
  const paragraphRows = [];

  paragraphs.forEach((paragraph, paragraphIndex) => {
    const sentences = sg.splitSentences(paragraph);
    const row = {
      index: paragraphIndex,
      kind: detail?.[paragraphIndex]?.kind || 'thin',
      head: paragraph.replace(/\s+/g, ' ').trim().slice(0, 40),
      sentences: sentences.length,
      lived: 0,
      specific: 0,
      generic: 0,
      avgLength: 0,
      maxEndingRun: 0,
      excerpt: 0          // 이 문단에서 실제로 전달한 문장 수(장문 상한 뒤 채워진다)
    };
    let lengthSum = 0;
    sentences.forEach(sentence => {
      const kind = classifySentenceKind(sentence);
      if (kind === 'lived') row.lived += 1;
      else if (kind === 'specific') row.specific += 1;
      else if (kind === 'generic') row.generic += 1;
      lengthSum += sentence.length;
      marks.push({
        index: marks.length,
        paragraph: paragraphIndex,
        length: sentence.length,
        kind,
        ending: sentenceEnding(sentence),
        endingRun: 0,
        runStart: false,
        text: sentence.length > SENTENCE_TEXT_CAP
          ? `${sentence.slice(0, SENTENCE_TEXT_CAP)}…`
          : sentence
      });
    });
    row.avgLength = sentences.length ? Number((lengthSum / sentences.length).toFixed(1)) : 0;
    paragraphRows.push(row);
  });

  // 계측용 최장 묶음은 표시 임계와 무관하게 실제 값을 센다(2·3도 그대로 보고).
  const maxEndingRun = (() => {
    let best = 0, current = 0, prev = null;
    marks.forEach(mark => {
      current = mark.ending && mark.ending === prev ? current + 1 : 1;
      prev = mark.ending;
      if (mark.ending && current > best) best = current;
    });
    return best;
  })();
  markEndingRuns(marks);
  paragraphRows.forEach(row => {
    const own = marks.filter(mark => mark.paragraph === row.index);
    row.maxEndingRun = own.reduce((max, mark) => Math.max(max, mark.endingRun), 0);
  });

  const total = marks.length;
  const countExcerpts = sentences => {
    const per = new Map();
    sentences.forEach(mark => per.set(mark.paragraph, (per.get(mark.paragraph) || 0) + 1));
    paragraphRows.forEach(row => { row.excerpt = per.get(row.index) || 0; });
  };

  if (total <= SENTENCE_SHOW_CAP) {
    countExcerpts(marks);
    return { total, shown: total, capped: false, maxEndingRun, sentences: marks, paragraphs: paragraphRows };
  }

  // 상한을 넘는 장문: 예전에는 원문 순서로 신호 문장부터 채워서 앞쪽 문단이 예산을 다 먹었다.
  // 그 결과 3만자 글에서 문단 지도 269칸 중 153칸이 눌러도 빈 목록이었다(진한 칸 107개 중 49개).
  // 지도가 "여기에 신호가 있다"고 말한 칸은 반드시 열려야 하므로, 예산의 절반을 먼저
  // 문단별 대표 문장 한 개씩에 배정한다 — 신호가 센 문단부터.
  const byParagraph = new Map();
  marks.forEach(mark => {
    if (!byParagraph.has(mark.paragraph)) byParagraph.set(mark.paragraph, []);
    byParagraph.get(mark.paragraph).push(mark);
  });
  const paragraphOrder = paragraphRows
    .map(row => ({
      index: row.index,
      ratio: row.sentences ? row.generic / row.sentences : 0,
      generic: row.generic
    }))
    .sort((a, b) => (b.ratio - a.ratio) || (b.generic - a.generic) || (a.index - b.index));
  const representative = list => {
    // 그 문단을 대표할 한 문장: 일반 표현 → 같은 종결이 이어지는 문장 → 첫 문장.
    return list.find(mark => mark.kind === 'generic')
      || list.find(mark => mark.endingRun >= ENDING_RUN_MIN)
      || list[0];
  };

  const chosen = new Map();
  const fairBudget = Math.floor(SENTENCE_SHOW_CAP * PARA_FAIR_SHARE);
  const takeRepresentative = row => {
    const mark = representative(byParagraph.get(row.index) || []);
    if (mark) chosen.set(mark.index, mark);
  };
  // ① 진한 칸(신호 많음)은 예외 없이 먼저 — 지도가 한 약속을 지키는 자리다.
  for (const row of paragraphOrder) {
    if (row.ratio < PARA_HOT_RATIO || chosen.size >= fairBudget) continue;
    takeRepresentative(row);
  }
  // ② 남은 공정 배분 몫으로 나머지 문단도 신호 순으로 한 문장씩.
  for (const row of paragraphOrder) {
    if (chosen.size >= fairBudget) break;
    takeRepresentative(row);
  }

  // 남은 자리에 유지할 근거와 신호 문장을 섞어 "무엇을 고칠지"와 "무엇을 지킬지"를 둘 다 보인다.
  const signal = marks.filter(mark => mark.endingRun >= ENDING_RUN_MIN || mark.kind === 'generic');
  const preserve = marks.filter(mark => mark.kind === 'lived' || mark.kind === 'specific');
  let preserveTaken = 0;
  for (const mark of preserve) {
    if (preserveTaken >= PRESERVE_SHOW_CAP || chosen.size >= SENTENCE_SHOW_CAP) break;
    if (chosen.has(mark.index)) continue;
    chosen.set(mark.index, mark);
    preserveTaken += 1;
  }
  for (const mark of signal) {
    if (chosen.size >= SENTENCE_SHOW_CAP) break;
    chosen.set(mark.index, mark);
  }
  for (const mark of marks) {
    if (chosen.size >= SENTENCE_SHOW_CAP) break;
    chosen.set(mark.index, mark);
  }
  const sentences = [...chosen.values()].sort((a, b) => a.index - b.index);
  countExcerpts(sentences);
  return { total, shown: sentences.length, capped: true, maxEndingRun, sentences, paragraphs: paragraphRows };
}

module.exports = {
  AXIS_MIN_SENTENCES,
  AXIS_POLICY_BY_PROFILE,
  RADAR_AXIS_POLICY_VERSION,
  resolveRadarAxisPolicy,
  SYNTHESIS_LIMITATION,
  PROFESSOR_RADAR_DISCLAIMER,
  SENTENCE_SHOW_CAP,
  ENDING_RUN_MIN,
  PARA_HOT_RATIO,
  CONTENT_MIN_SENTENCES,
  SAMPLE_SMALL_SENTENCES,
  normalizeScore,
  resolveProfessorRadar,
  resolveContentEvidence,
  sentenceEnding,
  classifySentenceKind,
  buildSentenceMap,
  buildDetectReportView,
  pickAiSentence,
  splitExamplePreview,
  mostChangedSpan,
  changedSpans,
  EXAMPLE_PREVIEW_MIN,
  EXAMPLE_PREVIEW_MAX
};
