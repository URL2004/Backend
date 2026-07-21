'use strict';
// [lib/coachsuggest.js] 자동 코칭 후보 생성(2026-06-18). 사용자가 메모를 "직접 안 쓰는" 채택 문제 해결:
//   시스템이 글에서 입장(관점)·경험 후보를 생성한다. 변환 잡(transform.js)이 '자동 코칭' ON일 때 시작 시
//   1회 호출해 입장만 userNotes로 자동 적용(생성-매번-eager 낭비 없음).
// ★무날조 경계: 입장 후보 = 글 자체 논리의 1인칭화(안전, 자동 적용 OK). 경험 후보 = 검증불가 실명·수치 없는
//   장면(사용자가 자기 현실로 채워야 함 → 자동 적용 금지, 직접 입력/확인 경로에서만).
const gptAnalyze = require('../routes/analyze-gpt');
const gptRuntimeConfig = require('./gptRuntimeConfig');
const { db } = require('../config');
const { logger } = require('./logger');

const COACH_SUGGEST_TOOL = {
  name: 'return_coach_suggestions',
  description: '글에 더할 입장·경험 메모 후보를 반환한다.',
  input_schema: {
    type: 'object',
    properties: {
      stances: {
        type: 'array',
        description: '입장·관점 후보 2~3개. 글이 이미 함의하는 논지를 "나는 ~라고 본다" 1인칭 단정으로 바꾼 한 문장.',
        items: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
      },
      experiences: {
        type: 'array',
        description: '구체 경험·사례 후보 2~3개. 이 주제에서 흔히 겪을 법한 1인칭 장면 한 문장.',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            field: { type: 'string', enum: ['exp', 'case'], description: 'exp=직접 겪은 일, case=구체 사례' }
          },
          required: ['text', 'field']
        }
      }
    },
    required: ['stances', 'experiences']
  }
};

const COACH_SUGGEST_SYSTEM = `너는 한국어 글쓰기 코치다. 학생이 제출한 글을 읽고, 그 학생이 "체크 한 번으로 자기 글에 넣을 수 있는" 메모 후보를 만든다. 학생은 메모를 직접 쓰기 귀찮아하므로, 네가 후보를 제시하고 학생은 실제 자기 생각·경험이면 채택한다.

만들 것:
1) 입장·관점 후보 2~3개(stances): 글이 이미 깔고 있는 논지·결론을 "나는 ~라고 본다 / 내가 보기엔 ~다"처럼 1인칭 단정으로 바꾼 한 문장. 글에 없는 새 주장·사실을 지어내지 말고, 글의 논리를 화자의 목소리로 드러내라.
2) 구체 경험·사례 후보 2~3개(experiences): 이 글의 주제에서 학생·직장인·생활인이 흔히 겪을 법한 1인칭 장면. 직접 겪은 일이면 field='exp', 일반 사례면 field='case'.

★무날조 규칙(절대 준수): 경험 후보에 특정 회사·기관·인물의 실명, 정확한 연도·금액·퍼센트 같은 "검증 불가능한 구체 디테일"을 지어 넣지 마라. 학생이 자기 현실로 채울 수 있게 일반적이되 장면이 그려지는 수준으로만 써라(예: "목표가 자주 바뀌는 조직에서 일하며 팀이 방향을 잃는 걸 본 적이 있다"). 학생이 안 겪은 일이면 채택하지 않을 것이므로, 그럴듯하게 과장하지 말고 평범하고 흔한 경험으로.

각 후보는 한 문장, 메모는 평서문으로. 도구로만 반환.`;

// 글에서 입장·경험 후보 생성. 실패·짧은 글이면 빈 배열(흐름 안 막음).
async function generateCoach(text, { signal } = {}) {
  if (!text || text.replace(/\s/g, '').length < 80) return { stances: [], experiences: [] };
  let data;
  try {
    const cfg = await gptRuntimeConfig.getRuntimeConfig({ db, logger });
    if (!gptRuntimeConfig.isGptActive(cfg)) return { stances: [], experiences: [] };
    data = await gptAnalyze.callGpt({
      userText: text.slice(0, 12000),
      systemText: COACH_SUGGEST_SYSTEM,
      tool: COACH_SUGGEST_TOOL,
      temperature: 0.7,
      maxOutputTokens: 700,
      task: 'coach_suggest',
      phase: 'coach:suggest',
      mode: 'coach',
      signal,
      config: cfg
    });
  } catch {
    return { stances: [], experiences: [] };
  }
  const r = gptAnalyze.extractGptResult(data, 'return_coach_suggestions') || {};
  const clean = arr => Array.isArray(arr) ? arr.filter(x => x && typeof x.text === 'string' && x.text.trim()).slice(0, 3) : [];
  return {
    stances: clean(r.stances).map((x, i) => ({ id: 'v' + i, field: 'view', text: x.text.trim() })),
    experiences: clean(r.experiences).map((x, i) => ({ id: 'e' + i, field: x.field === 'case' ? 'case' : 'exp', text: x.text.trim() }))
  };
}

module.exports = { generateCoach, COACH_SUGGEST_TOOL, COACH_SUGGEST_SYSTEM };
