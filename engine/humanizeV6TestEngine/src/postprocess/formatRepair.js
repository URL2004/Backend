const { splitLines } = require('../analysis/textStats');

function formatRepair(outputText, sourceText) {
  let out = String(outputText || '').replace(/\r\n/g, '\n').trim();
  out = repairObviousHeadingMerges(out, sourceText);
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

function repairObviousHeadingMerges(out, sourceText) {
  const sourceHeadings = splitLines(sourceText)
    .map(l => l.trim())
    .filter(l => l && l.length <= 48 && (/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\./.test(l) || /^\d+\.\s*/.test(l) || (!/[.!?。！？]$/.test(l) && /[가-힣A-Za-z]/.test(l))));
  let repaired = out;
  for (const h of sourceHeadings) {
    const escaped = escapeRegExp(h);
    repaired = repaired.replace(new RegExp(`(^|\n)(${escaped})[ \t]+(?=[가-힣A-Za-z0-9])`, 'g'), `$1$2\n`);
  }
  // Generic roman/number heading repair.
  repaired = repaired
    .replace(/(^|\n)([ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\.\s*[^\n]{1,24})\s+(?=[가-힣A-Za-z0-9])/g, '$1$2\n')
    .replace(/(^|\n)(\d+\.\s*[^\n.?!]{2,40})\s+(?=[가-힣A-Za-z0-9])/g, '$1$2\n');
  return repaired;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { formatRepair };
