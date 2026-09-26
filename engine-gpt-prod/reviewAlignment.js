'use strict';
const { createHash } = require('node:crypto');
const { splitSentenceSpans, normalizeCompact, ngramSet } = require('../engine/koreanText');

// Boundaries belong to source sentences, never to independently estimated
// percentages of the output. Repeated/ambiguous anchors cannot authorize repair.
function alignedReviewPairs(source, output, maxChars = 9000) {
  const from = String(source || ''), to = String(output || '');
  const id = createHash('sha256').update(from).digest('hex').slice(0, 16);
  const whole = () => [{ index: 0, sourceId: `${id}:0:${from.length}`, sourceStart: 0, sourceEnd: from.length,
    outputStart: 0, outputEnd: to.length, sourceContext: from, output: to,
    alignment: 'whole_document_uncertain', repairSafe: false }];
  // Complete, unique headings in the same order are stronger ownership
  // evidence than fuzzy sentence matches. A legitimate split/merge inside
  // a section must not disable repair for the entire long document.
  const headingPairs = alignedHeadingPairs(from, to, id, maxChars);
  if (headingPairs) return headingPairs;
  const a = splitSentenceSpans(from), b = splitSentenceSpans(to);
  if (a.length < 2 || b.length < 2 || a.length > 2000 || b.length > 2000) return whole();
  const keys = list => {
    const counts = new Map();
    list.forEach((s, index) => {
      const key = normalizeCompact(s.text);
      counts.set(key, counts.has(key) ? -1 : index);
    });
    return counts;
  };
  const ak = keys(a), bk = keys(b);
  const identities = list => {
    const map = new Map();
    list.forEach((sentence, index) => {
      const key = (sentence.text.match(/\d+(?:\.\d+)?/gu) || []).join('|');
      if (key) map.set(key, map.has(key) ? -1 : index);
    });
    return map;
  };
  const ai = identities(a), bi = identities(b);
  const features = b.map(s => ngramSet(s.text, 3));
  const inverted = new Map();
  features.forEach((set, index) => { for (const key of set) {
    if (!inverted.has(key)) inverted.set(key, []);
    inverted.get(key).push(index);
  } });
  const matches = [];
  for (let i = 0; i < a.length; i++) {
    const key = normalizeCompact(a[i].text);
    if (ak.get(key) !== i) continue;
    if (bk.has(key)) { if (bk.get(key) >= 0) matches.push({ i, j: bk.get(key) }); continue; }
    const grams = ngramSet(a[i].text, 3);
    const identity = (a[i].text.match(/\d+(?:\.\d+)?/gu) || []).join('|');
    const identityTarget = bi.get(identity);
    if (identity && ai.get(identity) === i && identityTarget >= 0) {
      let overlap = 0;
      for (const gram of grams) if (features[identityTarget].has(gram)) overlap++;
      if (overlap / Math.min(grams.size, features[identityTarget].size) >= 0.5) {
        matches.push({ i, j: identityTarget }); continue;
      }
    }
    if (grams.size < 12) continue;
    const counts = new Map();
    for (const gram of grams) {
      const owners = inverted.get(gram) || [];
      if (owners.length > 80) continue; // generic repeated prose is not an anchor
      for (const j of owners) counts.set(j, (counts.get(j) || 0) + 1);
    }
    const scored = [...counts].map(([j, overlap]) => ({ j,
      score: overlap / Math.min(grams.size, features[j].size), overlap }))
      .sort((x, y) => y.score - x.score);
    if (scored[0]?.score >= 0.72 && scored[0].overlap >= 12
        && scored[0].score - (scored[1]?.score || 0) >= 0.14) matches.push({ i, j: scored[0].j });
  }
  const headingKeys = text => {
    const map = new Map();
    for (const row of require('./layoutStructure').buildLineRecords(text)) {
      if (!['heading', 'title', 'legal_clause'].includes(row.role)) continue;
      const key = normalizeCompact(row.text);
      if (key.length >= 2) map.set(key, map.has(key) ? -1 : row.start);
    }
    return map;
  };
  const ah = headingKeys(from), bh = headingKeys(to);
  const shared = matches.filter(match => !require('./relationAudit').hasAdjacentRelationCoverage(
    a[match.i].text, b[match.j].text, to))
    .map(match => ({ sourceStart: a[match.i].start, outputStart: b[match.j].start }));
  for (const [key, sourceStart] of ah) if (sourceStart >= 0 && bh.get(key) >= 0) {
    shared.push({ sourceStart, outputStart: bh.get(key) });
  }
  shared.sort((x, y) => x.sourceStart - y.sourceStart || x.outputStart - y.outputStart);
  const unique = shared.filter((point, index) => !index || point.sourceStart !== shared[index - 1].sourceStart
    || point.outputStart !== shared[index - 1].outputStart);
  // A copied phrase can create one crossed anchor in an otherwise aligned
  // document. Do not choose either side of that ambiguity, or disable all
  // local review: discard EVERY anchor participating in a crossing. The gap
  // is then reviewed together between the surrounding uncontested boundaries.
  const suffixMin = new Array(unique.length + 1).fill(Infinity);
  for (let i = unique.length - 1; i >= 0; i--)
    suffixMin[i] = Math.min(unique[i].outputStart, suffixMin[i + 1]);
  let prefixMax = -1;
  const monotonic = unique.filter((point, i) => {
    const safe = point.outputStart > prefixMax && point.outputStart < suffixMin[i + 1]
      && (!i || point.sourceStart !== unique[i - 1].sourceStart)
      && (i + 1 === unique.length || point.sourceStart !== unique[i + 1].sourceStart);
    prefixMax = Math.max(prefixMax, point.outputStart);
    return safe;
  });
  if (monotonic.length < 2) return whole();
  const anchors = [{ sourceStart: 0, outputStart: 0 }];
  for (const { sourceStart, outputStart } of monotonic) {
    if (sourceStart > anchors.at(-1).sourceStart && outputStart > anchors.at(-1).outputStart) anchors.push({ sourceStart, outputStart });
  }
  anchors.push({ sourceStart: from.length, outputStart: to.length });
  const boundaries = [anchors[0]];
  for (let i = 1; i < anchors.length - 1; i++) {
    const left = boundaries.at(-1), next = anchors[i + 1];
    if (Math.max(next.sourceStart - left.sourceStart, next.outputStart - left.outputStart) > maxChars) boundaries.push(anchors[i]);
  }
  boundaries.push(anchors.at(-1));
  // With no reliable inner boundary, do not repair a guessed subsection.
  if (boundaries.length < 3) return whole();
  return boundaries.slice(0, -1).map((left, index) => {
    const right = boundaries[index + 1];
    return { index, sourceId: `${id}:${left.sourceStart}:${right.sourceStart}`,
      sourceStart: left.sourceStart, sourceEnd: right.sourceStart,
      outputStart: left.outputStart, outputEnd: right.outputStart,
      sourceContext: from.slice(left.sourceStart, right.sourceStart), output: to.slice(left.outputStart, right.outputStart),
      alignment: 'shared_monotonic_sentence', repairSafe: true };
  });
}

function alignedHeadingPairs(from, to, id, maxChars) {
  const headings = text => require('./layoutStructure').buildLineRecords(text)
    .filter(row => ['heading','title','legal_clause'].includes(row.role))
    .map(row => ({ key: normalizeCompact(row.text), start: row.start }));
  const a = headings(from), b = headings(to);
  if (a.length < 2 || a.length !== b.length || new Set(a.map(h => h.key)).size !== a.length
      || a.some((h,i) => h.key.length < 2 || h.key !== b[i].key)) return null;
  const points = [{sourceStart:0,outputStart:0}];
  for (let i=0;i<a.length;i++) {
    if (a[i].start > 0 && b[i].start > 0) points.push({sourceStart:a[i].start,outputStart:b[i].start});
    else if (a[i].start !== b[i].start) return null;
  }
  points.push({sourceStart:from.length,outputStart:to.length});
  // Never cut the body of an oversized section based on a length ratio.
  if (points.slice(1).some((p,i) => Math.max(p.sourceStart-points[i].sourceStart,
      p.outputStart-points[i].outputStart) > maxChars)) return null;
  const bounds = [points[0]];
  for (let i=1;i<points.length-1;i++) {
    const left=bounds.at(-1), next=points[i+1];
    if (Math.max(next.sourceStart-left.sourceStart,next.outputStart-left.outputStart)>maxChars) bounds.push(points[i]);
  }
  bounds.push(points.at(-1));
  if (bounds.length < 3) return null;
  return bounds.slice(0,-1).map((left,index) => {
    const right=bounds[index+1];
    return {index,sourceId:`${id}:${left.sourceStart}:${right.sourceStart}`,
      sourceStart:left.sourceStart,sourceEnd:right.sourceStart,
      outputStart:left.outputStart,outputEnd:right.outputStart,
      sourceContext:from.slice(left.sourceStart,right.sourceStart),output:to.slice(left.outputStart,right.outputStart),
      alignment:'shared_unique_heading',repairSafe:true};
  });
}
module.exports = { alignedReviewPairs };
