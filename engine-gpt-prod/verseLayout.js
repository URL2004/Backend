'use strict';

// Punctuation is not a prose/verse boundary: punctuated refrains still own lines.
// Conservative evidence shared by preflight and profile selection.
function hasStanzaRefrainLayout(value) {
  const text = String(value || '').replace(/\r\n?/gu, '\n');
  const lines = text.split('\n').map(x => x.trim()).filter(Boolean);
  if (lines.length < 8 || lines.some(x => x.length > 80)) return false;
  if (lines.filter(x => x.length <= 40).length / lines.length < .8) return false;
  if (lines.some(x => /^(?:#{1,6}\s|[-*•●■]\s|\d+[.)]\s|제\s*\d+\s*조)|\t|\|/u.test(x))) return false;
  if (lines.filter(x => /^[^:：]{1,25}[:：]/u.test(x)).length >= 2) return false;
  const stanzas = text.trim().split(/\n\s*\n/u).map(x => x.split('\n').filter(y => y.trim()));
  if (stanzas.filter(x => x.length >= 3).length < 2) return false;
  const frequencies = new Map();
  for (const line of lines) if (line.length >= 5) frequencies.set(line, (frequencies.get(line) || 0) + 1);
  return [...frequencies.values()].filter(n => n >= 2).length >= 2;
}

// Some creative passages have no blank stanza separators. Preserve irregular
// short, unpunctuated lines before prose seam repair can consume their layout.
// Regular-width PDF rows, code, lists, labels and tables are not this evidence.
function hasUnstanzaedVerseLayout(value) {
  const text=String(value||'').replace(/\r\n?/gu,'\n');
  if (/\n\s*\n/u.test(text.trim())) return false;
  const lines=text.split('\n').map(s=>s.trim()).filter(Boolean);
  if(lines.length<8||lines.some(s=>s.length>60||/[.!?。！？][”’"']?$/u.test(s)
    || /^(?:#{1,6}\s|[-*•●■]\s|\d+[.)]\s|제\s*\d+\s*조|[`~]{3})|\t|\||[:：]/u.test(s)))return false;
  const lengths=lines.map(s=>s.length).sort((a,b)=>a-b),median=lengths[Math.floor(lengths.length/2)];
  return median<=32 && lengths.filter(n=>n<=40).length/lengths.length>=.9
    && lengths.filter(n=>n<=median*.7).length>=2;
}

module.exports = { hasStanzaRefrainLayout, hasUnstanzaedVerseLayout };
