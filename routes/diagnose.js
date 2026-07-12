// [routes/diagnose.js] 회피 모드 P1 — 입력 글 사전 진단 (결정론·무LLM·무과금)
// ────────────────────────────────────────────────────────────────
// surfaceguard.classifyInputRisk(추상위험비율→등급 A/B/C)를 그대로 노출해 프런트 진단 배너를 채운다.
// 밴드 수치는 전부 실측 기반(§gp-c-grade-neutral-stack): 보존형 다듬기 = 등급별 실측 범위,
// 블로그 = inputGrade.expectedBand(스택 캘리브레이션), 격식 재구성 = 36~43%(ai-learning 36/routine 37·40/ai-study 41).
// "보장"이 아니라 "실측 밴드" — 카피는 프런트에서 고정 문구로 명시.

const express = require('express');
const router = express.Router();
const sg = require('../engine/surfaceguard');
const { logger } = require('../lib/logger');

// ★ UI 표기 밴드는 실측보다 보수적으로(2026-06-12 사장님 지시): 약속을 낮게 잡아 실망 방지.
//   실측은 분포의 한 샘플이고 짧은 글은 ±15%p 출렁이므로, 표기는 실측 상단을 넉넉히 잡는다.
// 보존형(그대로 다듬기) 실측: A=ESG 18·개인정보 35 / B=EV 73~81 / C=도시 87·보고서 94~100.
const POLISH_BAND = { A: '30~55%', B: '60~85%', C: '85%+' };
// 블로그 회피 실측: 숏폼 C가 27~54 분포. 보수 표기로 상단을 넉넉히.
const BLOG_BAND = { A: '30~45%', B: '35~50%', C: '40~55%' };
// 재구성 풀레시피(근거 분산) 실측 누적 36·37·40·41·47·48 → 외부 검사기 편차(카피킬러 등) 흡수 위해
//   넉넉한 보수 표기 35~60%. (UI 헤드라인 "예상 탐지율 35~60%"와 단일 표기로 일치)
const RESTRUCTURE_BAND = '35~60%';

// ★ 재구성 부적합 사전감지 — engine/inputrouting로 단일화(2026-06-16 탐구/생기부·짧고추상 확장 포함).
//   /diagnose(프런트 고급 잠금)와 /transform(생성 호출 '전' 차단)이 같은 결정론 판정을 공유한다 →
//   막다른 재구성(자소서·생기부·탐구문·짧고추상)을 생성 시작 전에 걸러 API 낭비를 0으로. 사유도 같이 노출.
const { looksLikeResume, factDensity, restructureUnfit, genreAdvisory, FACT_DENSE_THRESHOLD } = require('../engine/inputrouting');

const COPY = {
  A: {
    title: '구체적 정보가 풍부한 글이에요',
    desc: '실제 수치·사례·이름이 충분해서, 다듬기만으로도 탐지 위험이 낮은 편이에요.'
  },
  B: {
    title: '추상과 구체가 섞인 글이에요',
    desc: '일부 문단이 일반론에 가까워요. AI 티 줄이기로 더 사람이 쓴 글에 가깝게 만들 수 있어요.'
  },
  C: {
    title: '추상적 일반론 비중이 높은 글이에요',
    desc: '구체적 사례·수치가 적어, 그대로 제출하면 AI 탐지 위험이 높아요. 어떻게 할지 골라주세요.'
  }
};

function v2BasicRecommendation(kind, fallback) {
  if (process.env.HUMANIZE_ENGINE_V2_ENABLED !== '1') return fallback;
  if (kind === 'resume') {
    return '이 글은 자소서·생활기록부·탐구활동처럼 개인 경험과 관찰을 정확히 지키는 것이 중요해요. 기본 휴머나이징에도 해당 장르의 화자·경험 보존 규칙과 의미 검증이 적용되어, 고급의 추가 비용 대비 차이가 작습니다. 기본 휴머나이징을 권장해요.';
  }
  if (kind === 'reflection') {
    return '이 글은 독후감·서평처럼 개인의 감상과 해석을 지키는 것이 중요해요. 기본 휴머나이징에도 감상문 장르 보존과 의미 검증이 적용되므로 기본을 권장합니다. 맞춤법과 연결만 고치려면 과제 어투로 다듬기를 선택하세요.';
  }
  if (kind === 'thin') {
    return '글이 짧고 추상적이라 검증할 구체 정보가 적어요. 고급 휴머나이징도 원문에 없는 경험이나 수치를 만들지 않으므로 추가 이점이 작습니다. 구체적인 경험·수치를 원문에 보태거나 기본 휴머나이징으로 진행해 주세요.';
  }
  return fallback;
}

router.post('/diagnose', (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  const bare = text.replace(/\s+/g, '');
  if (bare.length < 50) return res.status(400).json({ error: '진단하려면 최소 50자가 필요해요.' });
  if (text.length > 50000) return res.status(400).json({ error: '텍스트가 너무 깁니다. (최대 50,000자)' });

  let ir;
  try {
    ir = sg.classifyInputRisk(text);
  } catch (e) {
    logger.error('diagnose.failed', { err: e });
    return res.status(500).json({ error: '진단 처리 중 오류가 발생했어요.' });
  }

  const grade = ir.grade || 'B';
  const copy = COPY[grade] || COPY.B;
  const resumeLike = looksLikeResume(text);
  const density = factDensity(text);
  const factDense = density >= FACT_DENSE_THRESHOLD;   // 연도·%·인용 빼곡 → 재구성 시 사실오류 위험(권장 안내)
  const ru = restructureUnfit(text, ir);                // 재구성 부적합(자소서·생기부·탐구문·짧고추상) + 명확한 사유
  const recommendationReason = v2BasicRecommendation(ru.kind, ru.reason);
  const adv = genreAdvisory(text);                      // 회피 난이도 사전 안내(STEM 스펙·구조화 보고서) — 소프트(진행 가능)
  logger.info('diagnose.completed', { grade, abstractRiskRatio: ir.abstractRiskRatio, textLength: text.length, resumeLike, density: Number(density.toFixed(1)), factDense, restructureUnfit: ru.unfit, unfitKind: ru.kind, advisoryKind: adv?.kind });
  res.json({
    ok: true,
    grade,
    abstractRiskRatio: ir.abstractRiskRatio,
    needsUserAnchor: !!ir.needsUserAnchor,
    resumeLike,
    factDense,
    restructureUnfit: ru.unfit,         // 프런트: 고급 시작 자체를 막고 사유 노출
    restructureUnfitReason: recommendationReason,  // 사용자에게 보여줄 '명확한 사유'
    restructureUnfitKind: ru.kind,
    advisory: adv ? adv.reason : null,  // 회피 난이도 소프트 안내(STEM·구조화 보고서) — 차단 아님
    advisoryKind: adv ? adv.kind : null,
    title: copy.title,
    desc: copy.desc,
    bands: {
      polish: POLISH_BAND[grade] || POLISH_BAND.B,
      blog: BLOG_BAND[grade] || BLOG_BAND.B,
      restructure: RESTRUCTURE_BAND
    }
  });
});

// ★ 밴드 테이블 재사용(routes/detectreport.js — 감지 보고서의 경로별 예상 밴드를 한 곳에 유지)
router.BANDS = { POLISH_BAND, BLOG_BAND, RESTRUCTURE_BAND };
router.COPY = COPY;
module.exports = router;
