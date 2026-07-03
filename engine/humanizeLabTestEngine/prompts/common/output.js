function outputRules(ctx = {}) {
  const registerLine = ctx.registerLine ? `\n${ctx.registerLine}` : '';
  return `
[출력 형식]
수정된 본문만 출력한다.
제목, 소제목, 줄바꿈, 목록, 항목 구조는 원문 형식을 따른다.
작업 설명, "수정했습니다", "아래는" 같은 머리말은 쓰지 않는다.
마크다운 기호(*, #, -, 백틱)는 원문에 있던 경우가 아니면 새로 만들지 않는다.${registerLine}
`.trim();
}

module.exports = { outputRules };
