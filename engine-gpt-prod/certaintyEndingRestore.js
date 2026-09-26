'use strict';

const { splitSentenceSpans } = require('../engine/koreanText');
const { syntaxSpans } = require('../engine/textSyntax');
const { sentenceSimilarity } = require('./sentenceAlignment');

// "대표적인 사례로 볼 수 있다" rewritten as "대표적인 사례다" turns the
// writer's interpretation into an assertion. The relation audit already
// nominates this (certainty_scope_candidate), but restoring the whole source
// sentence fails whenever the rewrite merged sentences, and when it succeeds
// it discards every other edit in that sentence. Restore only the source's own
// epistemic frame on the SAME modifier + predicate; never add a frame the
// source lacks and never change another word.
const HEDGED_NOMINAL_ENDING = /(?<modifier>[가-힣A-Za-z0-9]+)\s+(?<noun>[가-힣A-Za-z0-9]+?)(?<particle>으로|로|이라고|라고|이라|라)\s+(?<frame>(?:볼|할)\s+수\s+있(?<register>다|습니다))(?<end>[.!?。]?)["”’')\]）]*\s*$/u;
const PLAIN_NOMINAL_ENDING = /(?<modifier>[가-힣A-Za-z0-9]+)\s+(?<noun>[가-힣A-Za-z0-9]+?)(?<copula>이다|다|입니다)(?<end>[.!?。]?)\s*$/u;
// "사이에 놓인다고 할 수 있다" -> "사이에 놓인다". Plain register only: a
// 합니다-style verb changes its own ending and cannot be matched literally.
const HEDGED_VERBAL_ENDING = /(?<modifier>[가-힣A-Za-z0-9]+)\s+(?<verb>[가-힣]+[는ㄴ]?다)(?<particle>고)\s+(?<frame>(?:볼|할)\s+수\s+있(?<register>다))(?<end>[.!?。]?)["”’')\]）]*\s*$/u;
const PLAIN_VERBAL_ENDING = /(?<modifier>[가-힣A-Za-z0-9]+)\s+(?<verb>[가-힣]+다)(?<end>[.!?。]?)\s*$/u;
const MAX_RESTORES = 6;

function frameMatchesParticle(particle, frame) {
  if (/^볼/u.test(frame)) return /로$/u.test(particle) || particle === '고';
  return /라(?:고)?$/u.test(particle) || particle === '고';
}

function hedgedEndings(sourceText) {
  const hedged = [];
  for (const span of splitSentenceSpans(sourceText)) {
    const nominal = span.text.match(HEDGED_NOMINAL_ENDING);
    if (nominal && frameMatchesParticle(nominal.groups.particle, nominal.groups.frame)) {
      hedged.push({ kind: 'nominal', sentence: span.text, ...nominal.groups,
        predicate: nominal.groups.noun, key: `${nominal.groups.modifier} ${nominal.groups.noun}` });
      continue;
    }
    const verbal = span.text.match(HEDGED_VERBAL_ENDING);
    if (verbal && frameMatchesParticle(verbal.groups.particle, verbal.groups.frame)) {
      hedged.push({ kind: 'verbal', sentence: span.text, ...verbal.groups,
        predicate: verbal.groups.verb, key: `${verbal.groups.modifier} ${verbal.groups.verb}` });
    }
  }
  return hedged;
}

function plainEndingKey(kind, text) {
  const match = text.match(kind === 'nominal' ? PLAIN_NOMINAL_ENDING : PLAIN_VERBAL_ENDING);
  if (!match) return null;
  return { match, key: `${match.groups.modifier} ${kind === 'nominal' ? match.groups.noun : match.groups.verb}` };
}

function restoreCertaintyEndings(source, output) {
  const text = String(output || '');
  const unchanged = { text, applied: false, restoredCount: 0, restored: [] };
  const sourceText = String(source || '');
  if (!sourceText.trim() || !text.trim()) return unchanged;
  const hedged = hedgedEndings(sourceText);
  if (!hedged.length) return unchanged;
  const sourceSpans = splitSentenceSpans(sourceText);
  const outputSpans = splitSentenceSpans(text);
  const protectedRanges = syntaxSpans(text).filter(span => span.spanType !== 'parenthetical');
  const replacements = [];
  for (const item of hedged) {
    if (replacements.length >= MAX_RESTORES) break;
    if (hedged.filter(other => other.key === item.key).length !== 1) continue;
    // A merged rewrite may carry an earlier sentence in front; compare the
    // source sentence with the output tail it would correspond to.
    const score = (sourceSentence, outputSentence) => {
      const tail = outputSentence.slice(-Math.min(outputSentence.length, Math.ceil(sourceSentence.length * 1.4)));
      return Math.max(sentenceSimilarity(sourceSentence, outputSentence), sentenceSimilarity(sourceSentence, tail));
    };
    // The same predicate may end several output sentences. Only the one that
    // clearly corresponds to the hedged source sentence is a restore target.
    const targets = outputSpans.map(span => ({ span, plain: plainEndingKey(item.kind, span.text) }))
      .filter(({ plain }) => plain?.key === item.key)
      .map(target => ({ ...target, score: score(item.sentence, target.span.text) }))
      .sort((left, right) => right.score - left.score);
    if (!targets.length || targets[0].score < 0.35
        || (targets[1] && targets[0].score - targets[1].score < 0.08)) continue;
    const { span, plain, score: hedgedScore } = targets[0];
    const match = plain.match;
    if (item.kind === 'nominal' && (match.groups.copula === '입니다') !== (item.register === '습니다')) continue;
    if (item.kind === 'verbal' && item.verb !== match.groups.verb) continue;
    if (text.slice(span.start, span.end) !== span.text) continue;
    // When the source also states the same predicate plainly elsewhere, the
    // output sentence must correspond to the hedged sentence by a clear margin.
    const plainRivals = sourceSpans.filter(other => other.text !== item.sentence
      && plainEndingKey(item.kind, other.text)?.key === item.key);
    if (plainRivals.some(other => score(other.text, span.text) + 0.08 > hedgedScore)) continue;
    const predicateEnd = span.start + match.index + match[0].trimEnd().length - match.groups.end.length;
    const replaceStart = item.kind === 'nominal' ? predicateEnd - match.groups.copula.length : predicateEnd;
    if (protectedRanges.some(range => range.start < predicateEnd && range.end > replaceStart - 1)) continue;
    replacements.push({
      start: replaceStart,
      end: predicateEnd,
      text: `${item.particle} ${item.frame}`,
      key: item.key
    });
  }
  if (!replacements.length) return unchanged;
  let restored = text;
  for (const item of replacements.sort((left, right) => right.start - left.start)) {
    restored = restored.slice(0, item.start) + item.text + restored.slice(item.end);
  }
  return {
    text: restored,
    applied: restored !== text,
    restoredCount: replacements.length,
    restored: replacements.map(item => ({ key: item.key }))
  };
}

module.exports = { restoreCertaintyEndings };
