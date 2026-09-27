'use strict';
const { syntaxSpans } = require('../engine/textSyntax');

// Recover explicit alternating field boundaries, never infer topic breaks.
// Numbers must agree across both fields and increase consecutively. Quoted
// examples, code and tables are not a source of layout instructions.
function repairPairedLabelLayout(value) {
  const text = String(value || '');
  const protectedSpans = syntaxSpans(text).filter(s => ['quote','code'].includes(s.spanType));
  const tokens = [...text.matchAll(/(장면|이유|질문|답변|문항|근거)\s*(\d{1,3})[.)][ \t]*/gu)]
    .filter(m => !protectedSpans.some(s => m.index < s.end && m.index + m[0].length > s.start));
  const unchanged = { text, changes: [] };
  if (tokens.length < 4 || tokens.length % 2 || tokens.length > 80) return unchanged;
  const pairs = new Map([['장면','이유'],['질문','답변'],['문항','근거']]);
  const left = tokens[0][1], right = pairs.get(left);
  if (!right || text.slice(0,tokens[0].index).trim()) return unchanged;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i], next = tokens[i+1];
    const body = text.slice(token.index + token[0].length, next?.index ?? text.length);
    if (token[1] !== (i % 2 ? right : left)
        || Number(token[2]) !== Number(tokens[0][2]) + Math.floor(i/2)
        || body.trim().length < 6 || body.length > 1800 || /\t|\|/u.test(body)) return unchanged;
  }
  let result = text; const changes = [];
  for (let i=tokens.length-1; i>0; i--) {
    const start = tokens[i].index;
    const prefix = result.slice(0,start);
    if (/[\r\n][ \t]*$/u.test(prefix)) continue;
    result = prefix.replace(/[ \t]+$/u,'') + '\n\n' + result.slice(start);
    changes.push({code:'source_paired_label_boundary',lineOrdinal:1,
      message:'반복 번호가 일치하는 문항과 답변의 붙은 경계를 나눴어요.'});
  }
  return {text:result,changes};
}
module.exports = { repairPairedLabelLayout };
