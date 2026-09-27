'use strict';

// Quotation marks can wrap a speaker's authored script, not an external quote.
// Require repeated explicit script cues AND spoken delivery. Never use one
// first-person pronoun, document genre, or quote length as sole authorization.
function authoredSpeechRanges(value, syntax) {
  const text = String(value || '');
  const quotes = syntax.filter(x => x.spanType === 'quote');
  const outer = quotes.filter(x => !quotes.some(y => y !== x && y.start < x.start && y.end > x.end));
  const candidates = [];
  const interviewGuide = /면접\s*(?:준비|연습|예상)|예상\s*(?:꼬리)?질문\s*(?:&|·|과|및)\s*답변/u.test(text);
  for (const quote of outer) {
    if (quote.end - quote.start < 60 || !/["“「『]/u.test(text[quote.start])) continue;
    const lineStart = text.lastIndexOf('\n', quote.start - 1) + 1;
    if (text.slice(lineStart, quote.start).trim()) continue;
    const tail = text.slice(quote.end).split(/\r?\n/u)[0];
    if (tail.trim()) continue;
    const before = text.slice(0, lineStart);
    const cueMatch = before.match(/([^\r\n]+)[\r\n\s]*$/u);
    if (!cueMatch) continue;
    const cue = cueMatch[1].trim();
    const plain = cue.replace(/^[#*\s]+|[*\s]+$/gu, '');
    const scriptCue = /^(?:\[?(?:슬라이드|발표자|이전 발표자|다음 발표자|브릿지 멘트|발표 멘트|답변)(?:\s|[:：\](])|[①-⑳\d]+[.)]?\s*(?:자기소개|지원동기|답변|질문|졸업 후|대학생활|본인의))/u.test(plain);
    const interviewCue = interviewGuide && /^[①-⑳\d]+[.)]?\s*[^\n]{5,100}[?？]$/u.test(plain);
    if ((!scriptCue && !interviewCue) || /(?:인용|출처|발췌|녹취|인터뷰 기록|외부 발언)/u.test(cue)) continue;
    const body = text.slice(quote.start + 1, quote.end - 1);
    if (!/(?:습니다|입니다|합니다|됩니다|드립니다|세요)[.!?。！？]/u.test(body.replace(/\s+/gu, ''))) continue;
    const cueStart = before.lastIndexOf(cueMatch[1]);
    candidates.push({ ...quote, cueStart, cueEnd: cueStart + cueMatch[1].length });
  }
  if (candidates.length < 2) return [];
  // Source-attributed anthologies and quotations are never a script wrapper.
  const outside = candidates.reduceRight((s, q) => s.slice(0, q.start) + s.slice(q.end), text);
  if (/(?:출처\s*[:：]|인용문\s*[:：]|발췌문\s*[:：]|연설문\s*발췌|인터뷰\s*녹취)/u.test(outside)) return [];
  return candidates;
}

module.exports = { authoredSpeechRanges };
