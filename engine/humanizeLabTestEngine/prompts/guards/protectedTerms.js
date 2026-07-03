function protectedTermsBlock(terms) {
  const list = [...new Set((terms || []).map(x => String(x || '').trim()).filter(Boolean))].slice(0, 80);
  if (!list.length) return '';
  return [
    '[보호 표현]',
    '아래 표현은 삭제, 압축, 일반화, 순서 변경하지 않는다. 자연스러운 문장 안에 그대로 보존한다.',
    ...list.map(t => `- ${t}`)
  ].join('\n');
}

module.exports = { protectedTermsBlock };
