// [engine/antidetect.js] GPTZero 전용 2차 우회 패스 (보고서 §우회) — LLM
// ────────────────────────────────────────────────────────────────
// 1차(FLOOR v2 humanize)가 의미·사실·화자·분량을 보존한 CLEAN 출력을 만든 뒤,
// 이 패스는 "통계적 예측가능성(perplexity)"만 파괴한다 — 의미는 그대로, AI 특유의 매끄러움만 제거.
// 핵심: 챗 모델은 기본적으로 확률 높은(=perplexity 낮은=탐지되는) 문장을 쓴다. 그래서 *덜 흔한 어휘 선택·
// 구조 교란·인간적 불규칙*을 명시적으로 강제하고 temperature를 높여 분포를 흔든다.
// 안전망: 이 패스 결과는 호출부에서 FLOOR 가드로 재검사 → 사실 날조·소실·화자/분량 위반이면 폐기하고
//   1차 출력을 유지한다(FLOOR가 우회보다 항상 우선).

const { llmText } = require('./judge');

function buildAntiDetectSystem(lang = 'ko', speakerType = 'individual') {
  if (lang === 'en') {
    return [
      '[Goal: evade AI detectors — preserve meaning 100%, destroy only statistical predictability]',
      'The text below is already correct in meaning. Keep its meaning, facts, speaker, length, and conclusion direction EXACTLY. Remove only the "AI-written statistical smoothness."',
      '',
      'MUST NOT (FLOOR — violating any voids the result):',
      '- Do not change ANY number, figure, date, amount, proper noun, or brand. Add no new facts; drop no existing information.',
      '- Keep the same speaker. Keep the conclusion direction. Keep length similar to the input.',
      '',
      'TO EVADE DETECTORS, aggressively:',
      '1. Replace predictable words with LESS COMMON but valid synonyms — avoid the first "default" word the model reaches for (meaning identical, still natural).',
      '2. Make sentence length wildly uneven — mix very short (2-5 words) with long sentences.',
      '3. Add human irregularity: sentence fragments, em-dashes (—), parenthetical asides, ellipses (…), small self-corrections ("well, more precisely ~").',
      '4. Deliberately break some smooth transitions — if every sentence flows perfectly, it reads as AI.',
      '5. Vary structure: inversions, fronting, topic shifts.',
      '6. Never repeat the same sentence ending in a row.',
      '',
      'Output the rewritten body only — no preamble, no markdown.'
    ].join('\n');
  }
  const speakerLine = speakerType === 'impersonal'
    ? '화자: 1인칭(나/저/우리)을 새로 넣지 마라. 비인칭 유지.'
    : speakerType === 'organization'
      ? '화자: 조직(우리/저희) 시점 유지, 개인 1인칭 도입 금지.'
      : '화자: 원문 1인칭 시점 유지(새 일화·감정 추가 금지).';
  return [
    '[목표: AI 탐지기 우회 — 의미는 100% 보존, 통계적 예측가능성만 파괴]',
    '아래 글은 의미가 이미 정확하다. 의미·사실·화자·분량·결론 방향은 그대로 두고, "AI가 쓴 듯한 통계적 매끄러움"만 깨라.',
    '',
    '절대 금지(FLOOR — 어기면 결과 무효):',
    '- 숫자·수치·날짜·금액·고유명사·브랜드를 한 글자도 바꾸지 마라. 새 사실 추가 금지, 기존 정보 삭제 금지.',
    `- ${speakerLine} 결론 방향 유지. 분량은 입력과 비슷하게.`,
    '',
    '탐지기 우회를 위해 적극적으로:',
    '1. 예측 가능한 단어를 *덜 흔한* 동의어·표현으로 교체 — 모델이 가장 먼저 떠올리는 "정석" 단어를 피하라(의미는 동일, 어색하지 않게).',
    '2. 문장 길이를 극단적으로 들쭉날쭉하게 — 아주 짧은 문장(2~6자)과 긴 문장을 섞어라.',
    '3. 사람 특유의 불규칙 삽입: 문장 조각, 줄표(—), 삽입구(괄호), 말줄임(…), 가벼운 자기정정("아니, 정확히는~").',
    '4. 매끄러운 연결을 일부러 일부 끊어라 — 모든 문장이 완벽하게 이어지면 AI로 읽힌다.',
    '5. 어순 도치·강조 도치로 문장 구조를 다양하게.',
    '6. 같은 종결어미를 연속으로 반복하지 마라.',
    '',
    '본문만 출력(머리말·마크다운 금지).'
  ].join('\n');
}

// 1차 출력(firstOutput)의 perplexity를 끌어올린 변형 텍스트 반환. 실패(빈 응답) 시 firstOutput 그대로.
async function antiDetectPass(firstOutput, { lang = 'ko', speakerType = 'individual', signal } = {}) {
  if (!firstOutput || firstOutput.replace(/\s+/g, '').length < 10) return firstOutput;
  const system = buildAntiDetectSystem(lang, speakerType);
  const user = `[다시 쓸 글]\n${firstOutput}`;
  // temperature는 llmText 백엔드(claudecode/api)에 따라 내부 기본값 사용. 분포 교란이 목적이므로 재시도는 짧게.
  const out = await llmText({ system, user, signal, maxTokens: 8192 });
  return out && out.replace(/\s+/g, '').length >= 10 ? out : firstOutput;
}

module.exports = { antiDetectPass, buildAntiDetectSystem };
