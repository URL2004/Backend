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
  logger.info('diagnose.completed', { grade, abstractRiskRatio: ir.abstractRiskRatio, textLength: text.length });
  res.json({
    ok: true,
    grade,
    abstractRiskRatio: ir.abstractRiskRatio,
    needsUserAnchor: !!ir.needsUserAnchor,
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
