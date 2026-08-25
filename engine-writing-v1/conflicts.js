'use strict';

const { extractQuantities } = require('./numberAst');

function detectConflicts(input) {
  const answers = input?.answers || {};
  const conflicts = [];

  if (input?.genre === 'review_blog') {
    const declaredTotal = firstMoney(answers.spending);
    const itemAggregate = /(?:합계|총액|총\s*금액|메뉴\s*합)/u.test(answers.items || '')
      ? firstMoney(answers.items)
      : null;
    if (declaredTotal && itemAggregate && declaredTotal.value !== itemAggregate.value) {
      conflicts.push({
        code: 'REVIEW_TOTAL_MISMATCH',
        fields: ['items', 'spending'],
        label: '항목 합계와 총 지출이 달라요',
        message: `주문·구매 항목에는 ${itemAggregate.raw}, 총 지출에는 ${declaredTotal.raw}(으)로 적혀 있어요. 어느 금액이 맞는지 한쪽을 고쳐 주세요.`,
        values: [itemAggregate.raw, declaredTotal.raw]
      });
    }
  }

  if (input?.genre === 'general') {
    const explicitDate = firstDate(answers.dateTime);
    const messageDate = firstDate(answers.keyMessage);
    if (explicitDate && messageDate && explicitDate.value !== messageDate.value) {
      conflicts.push({
        code: 'GENERAL_EVENT_DATE_MISMATCH',
        fields: ['keyMessage', 'dateTime'],
        label: '핵심 메시지와 날짜·시간의 날짜가 달라요',
        message: `핵심 메시지에는 ${messageDate.raw}, 날짜·시간에는 ${explicitDate.raw}(으)로 적혀 있어요. 실제 일정을 확인해 주세요.`,
        values: [messageDate.raw, explicitDate.raw]
      });
    }
  }

  if (input?.genre === 'resume') {
    const personal = normalizedSentence(answers.personalActions);
    const team = normalizedSentence(answers.teamActions);
    if (personal.length >= 20 && personal === team) {
      conflicts.push({
        code: 'ACTION_OWNERSHIP_AMBIGUOUS',
        fields: ['personalActions', 'teamActions'],
        label: '내 행동과 팀 행동이 같은 내용이에요',
        message: '본인이 직접 한 행동과 팀 전체가 한 행동을 구분해 적어 주세요. 구분할 수 없다면 팀 행동 칸을 비워도 됩니다.',
        values: []
      });
    }
  }

  return conflicts;
}

function firstMoney(value) {
  return extractQuantities(value).find(item => item.kind === 'money') || null;
}

function firstDate(value) {
  return extractQuantities(value).find(item => item.kind === 'date') || null;
}

function normalizedSentence(value) {
  return String(value || '').normalize('NFKC').replace(/[\s.,!?"'“”‘’()\[\]{}]/gu, '').toLowerCase();
}

module.exports = { detectConflicts, normalizedSentence };
