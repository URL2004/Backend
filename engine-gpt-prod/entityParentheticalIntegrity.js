'use strict';

// Parenthetical alias ownership: "마틴 로웰(Martin Lowell)" binds a cross-script
// alias to the name directly before it. A rewrite can keep every word and
// still attach the alias to a different person. This module only NOMINATES a
// paired exact span for semantic review. It is never a verdict, never repairs
// text, and never claims that a name or historical fact is correct.
const { splitSentenceSpans } = require('../engine/koreanText');

const VERSION = 'alias-owner-v3-drop-evidence';
const CODE = 'alias_owner_binding_candidate';
const MAX_PARENTHETICALS = 400;
const MAX_ROWS = 6;
const MAX_ALIAS_LENGTH = 48;
const MAX_OWNER_TOKENS = 4;
const OWNER_WINDOW = 64;
const MIN_SPAN = 12;

const CITATION = /(?:\bet\s+al\b|\bibid\b|\bcf\b|\bsic\b|\bpp?\.|\beds?\b|\btrans\b|\bvol\b|\bno\.|\bsee\b|\bfig\b|\bch\.)/iu;
// Digits, operators and list/citation punctuation: dates, quantities, math,
// citations and enumerations never bind as a person alias.
const NON_NAME = /[0-9０-９=+<>/*^%&|~:;,?!"'“”‘’[\]{}_#@$\\]/u;
// Title-case glossary words mark a term definition, not a person name.
const TERM_WORDS = new Set(['learning', 'model', 'models', 'network', 'networks', 'system', 'systems',
  'theory', 'analysis', 'intelligence', 'method', 'methods', 'data', 'law', 'act', 'university',
  'institute', 'association', 'organization', 'committee', 'program', 'project', 'index', 'test',
  'effect', 'syndrome', 'process', 'policy', 'standard', 'protocol', 'framework', 'language',
  'science', 'studies', 'study', 'journal', 'review', 'press', 'company', 'corporation', 'group',
  'agency', 'department', 'ministry', 'council', 'fund', 'bank', 'union', 'school', 'college']);
const NAME_PARTICLES = new Set(['de', 'del', 'della', 'der', 'van', 'von', 'da', 'di', 'la', 'le', 'bin', 'al']);
const TITLES = new Set(['교수', '박사', '연구원', '선생', '선생님', '대표', '감독', '작가', '의원', '장관',
  '대통령', '총리', '회장', '사장', '기자', '위원', '위원장', '씨', '님', '팀장', '소장', '원장', '이사',
  'Professor', 'Prof', 'Dr', 'Mr', 'Ms', 'Mrs']);

const HANGUL = /^[가-힣]+$/u;
const HAN = /^\p{Script=Han}+$/u;
const LATIN_TOKEN = /^[A-Za-z][A-Za-z'’-]*\.?$/u;
const compact = value => String(value || '').replace(/\s+/gu, '');

function latinNameTokens(tokens) {
  if (!tokens.length || tokens.length > MAX_OWNER_TOKENS) return false;
  let named = 0;
  for (const [index, token] of tokens.entries()) {
    if (!LATIN_TOKEN.test(token)) return false;
    const bare = token.replace(/\.$/u, '');
    if (TERM_WORDS.has(bare.toLowerCase())) return false;
    if (/^[A-Z]$/u.test(bare)) continue; // initial
    // One leading capital per name part: mixed-case acronyms (IoT, mRNA,
    // PhD) and all-caps abbreviations are not person names.
    if (/^(?:Mc|Mac|O['’]|D['’])?[A-Z][a-z]+(?:['’-][A-Z]?[a-z]+)*$/u.test(bare)) { named += 1; continue; }
    // Lower-case particles only inside a name; all-caps acronyms never bind.
    if (NAME_PARTICLES.has(bare) && index > 0 && index < tokens.length - 1) continue;
    return false;
  }
  return named >= 1 && tokens.join('').replace(/\./gu, '').length >= 3;
}

function hangulNameTokens(tokens) {
  return tokens.length >= 1 && tokens.length <= MAX_OWNER_TOKENS
    && tokens.every(token => HANGUL.test(token) && token.length <= 6);
}

function aliasShape(content) {
  const text = String(content || '').trim();
  if (!text || text.length > MAX_ALIAS_LENGTH || /[\r\n()（）]/u.test(text)) return null;
  if (NON_NAME.test(text) || CITATION.test(text)) return null;
  const tokens = text.split(/[ \t]+/u).filter(Boolean);
  if (tokens.every(token => /^[A-Za-z.'’-]+$/u.test(token))) {
    return latinNameTokens(tokens) ? { script: 'latin', tokens, key: tokens.join(' ').toLowerCase() } : null;
  }
  if (tokens.length === 1 && HAN.test(tokens[0])) {
    const size = [...tokens[0]].length;
    return size >= 3 && size <= 4 ? { script: 'han', tokens, key: tokens[0] } : null;
  }
  if (hangulNameTokens(tokens)) return { script: 'hangul', tokens, key: tokens.join(' ') };
  return null;
}

// Tokens of one script directly before the parenthesis. The window stops at
// a previous parenthetical, clause punctuation, a quote or a line break.
function ownerWindow(text, open, aliasScript) {
  const raw = text.slice(Math.max(0, open - OWNER_WINDOW), open);
  // One space before the parenthesis ("Martin Lowell (마틴 로웰)") is ordinary
  // spacing. A wider gap is not treated as a binding (conservative miss).
  const clause = raw.split(/[)）(（,.;:!?…。、，·"'“”‘’「」『』《》\r\n]/u).pop().replace(/[ \t]$/u, '');
  if (!clause || /[ \t]$/u.test(clause)) return [];
  const ownerScript = aliasScript === 'hangul' ? 'latin' : 'hangul';
  const accept = ownerScript === 'hangul'
    ? token => HANGUL.test(token) && token.length <= 8
    : token => /^[A-Z][A-Za-z'’-]*\.?$/u.test(token);
  const out = [];
  for (const token of clause.split(/[ \t]+/u).filter(Boolean).reverse()) {
    if (!accept(token) || out.length >= MAX_OWNER_TOKENS + 1) break;
    out.unshift(token);
  }
  return out;
}

function stripTitles(tokens) {
  const out = tokens.slice();
  while (out.length > 1 && TITLES.has(out.at(-1).replace(/\.$/u, ''))) out.pop();
  return out;
}

function collectBindings(value) {
  const text = String(value || '');
  const sentences = splitSentenceSpans(text);
  const rows = [];
  let seen = 0, cursor = 0, from = 0;
  while (from < text.length && seen < MAX_PARENTHETICALS) {
    const open = nextOpen(text, from);
    if (open < 0) break;
    seen += 1;
    from = open + 1;
    const limit = Math.min(text.length, open + 1 + MAX_ALIAS_LENGTH + 1);
    let close = -1;
    for (let i = open + 1; i < limit; i++) {
      const ch = text[i];
      if (ch === ')' || ch === '）') { close = i; break; }
      if (ch === '(' || ch === '（' || ch === '\n' || ch === '\r') break;
    }
    if (close < 0) continue;
    from = close + 1;
    const alias = aliasShape(text.slice(open + 1, close));
    if (!alias) continue;
    const window = stripTitles(ownerWindow(text, open, alias.script));
    if (!window.length) continue;
    // A Hanja reading is one syllable per character; a transliterated name
    // normally keeps the token count of the alias.
    const size = alias.script === 'han' ? 1 : Math.min(alias.tokens.length, window.length, MAX_OWNER_TOKENS);
    const owner = window.slice(-size);
    if (alias.script === 'han' && [...owner[0]].length !== [...alias.key].length) continue;
    if (alias.script === 'hangul' && !latinNameTokens(owner)) continue;
    while (cursor < sentences.length && Number(sentences[cursor].end) <= open) cursor += 1;
    const sentence = sentences[cursor];
    if (!sentence || Number(sentence.start) > open || Number(sentence.end) < close) continue;
    rows.push({ alias: alias.key, owner: owner.join(' '), ownerKey: compact(owner.join(' ')),
      ownerTokens: owner, windowKey: compact(window.join(' ')), windowTokens: window,
      span: sentence.text, ordinal: cursor + 1 });
  }
  return rows;
}

function nextOpen(text, from) {
  const a = text.indexOf('(', from), b = text.indexOf('（', from);
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

const uniqueSpan = (text, span) => typeof span === 'string' && span.length >= MIN_SPAN
  && text.indexOf(span) >= 0 && text.indexOf(span) === text.lastIndexOf(span);
const nested = (a, b) => a.endsWith(b) || b.endsWith(a);
// Tokens both owner windows share directly before the parenthesis.
function sharedTrailingRun(a, b) {
  const out = [];
  for (let i = 1; i <= Math.min(a.length, b.length); i++) {
    if (a[a.length - i] !== b[b.length - i]) break;
    out.unshift(a[a.length - i]);
  }
  return out;
}
const endsWithTokens = (tokens, run) => run.length <= tokens.length
  && run.every((token, i) => tokens[tokens.length - run.length + i] === token);
// Same word with a changed particle or ending ("운영자인" / "운영자").
const sameStem = (a, b) => typeof a === 'string' && typeof b === 'string'
  && (a === b || (Math.min(a.length, b.length) >= 2 && (a.startsWith(b) || b.startsWith(a))));
// How the candidate window relates to one source window of the same alias.
function compareWindows(sourceTokens, candidateTokens) {
  const run = sharedTrailingRun(sourceTokens, candidateTokens);
  const before = (tokens, offset) => tokens[tokens.length - run.length - offset];
  const sourcePrev = before(sourceTokens, 1), candidatePrev = before(candidateTokens, 1);
  return {
    run,
    sourcePrev,
    // The word before the unchanged name is the same word: only context moved.
    sameContext: run.length >= 2 && sameStem(sourcePrev, candidatePrev),
    // The source token before the run is gone and the text before it still
    // lines up: a name token was actually removed.
    dropped: run.length >= 1 && sourcePrev !== undefined
      && (candidatePrev === undefined || sameStem(candidatePrev, before(sourceTokens, 2)))
  };
}

// documentSource (optional): the whole source when `source` is one section of
// it. It only supplies the OTHER owners and ambiguity evidence, so a sibling
// owner bound in a different section is still recognised. Evidence spans and
// the aliases under review always come from `source` / `candidate`.
function auditParentheticalAliasOwners(source, candidate, { documentSource = '' } = {}) {
  const before = String(source || ''), after = String(candidate || '');
  const empty = { version: VERSION, candidateOnly: true, candidates: [] };
  if (!before || !after || before === after) return empty;
  if (!/[(（]/u.test(before) || !/[(（]/u.test(after)) return empty;
  const sourceRows = collectBindings(before);
  if (!sourceRows.length) return empty;
  const context = typeof documentSource === 'string' && documentSource && documentSource !== before
    ? collectBindings(documentSource) : [];
  // One alias with two different source owners is already ambiguous: skip it
  // rather than guess which owner the writer meant.
  const ownerKeys = new Map();
  for (const row of [...sourceRows, ...context]) {
    if (!ownerKeys.has(row.alias)) ownerKeys.set(row.alias, { keys: new Set(), first: row });
    ownerKeys.get(row.alias).keys.add(row.ownerKey);
  }
  const bound = new Map();
  for (const row of sourceRows) {
    if (ownerKeys.get(row.alias).keys.size !== 1) continue;
    if (!bound.has(row.alias)) bound.set(row.alias, []);
    bound.get(row.alias).push(row);
  }
  if (!bound.size) return empty;
  const owners = [...ownerKeys.entries()].filter(([, item]) => item.keys.size === 1)
    .map(([alias, item]) => ({ alias, ownerKey: item.first.ownerKey, ownerTokens: item.first.ownerTokens }));
  const candidates = [], emitted = new Set();
  for (const row of collectBindings(after)) {
    if (candidates.length >= MAX_ROWS) break;
    const rows = bound.get(row.alias);
    if (!rows) continue;
    const own = rows[0];
    if (row.windowKey.endsWith(own.ownerKey)) continue; // preserved (context, title, spacing)
    const others = owners.filter(item => item.alias !== row.alias && item.ownerKey !== own.ownerKey
      && !nested(item.ownerKey, own.ownerKey));
    let kind = '';
    if (others.some(item => row.windowKey.endsWith(item.ownerKey))) kind = 'owner_swap';
    // The owner size follows the alias token count, so an alias longer than
    // the name (middle name, suffix) pulls the modifier before the name into
    // the owner. When the same two or more tokens still stand directly before
    // the parenthesis and no other source owner ends with them, the name is
    // unchanged and only its context was edited.
    // The same name can also carry a second alias (senior / junior), so a
    // shared run alone cannot be blocked by another owner with that name.
    else {
      const compared = rows.map(item => compareWindows(item.windowTokens, row.windowTokens));
      if (compared.some(item => item.sameContext || (item.run.length >= 2
          && !others.some(other => endsWithTokens(other.ownerTokens, item.run))))) continue;
      // A shortened owner matters only when the remaining tokens no longer
      // tell two source owners apart (shared surname or given name), and only
      // when a source owner token was actually removed.
      const last = row.windowTokens.at(-1);
      if (compared.some(item => item.dropped && own.ownerTokens.includes(item.sourcePrev))
          && own.ownerTokens.length > 1 && own.ownerTokens.includes(last)
          && others.some(item => item.ownerTokens.includes(last))) kind = 'owner_truncated';
    }
    if (!kind || !uniqueSpan(after, row.span)) continue;
    const origin = rows.find(item => uniqueSpan(before, item.span));
    if (!origin) continue;
    const key = `${origin.span}\u0000${row.span}`;
    if (emitted.has(key)) continue;
    emitted.add(key);
    candidates.push({ code: CODE, kind, sourceOrdinal: origin.ordinal, outputOrdinal: row.ordinal,
      sourceSpan: origin.span, outputSpan: row.span });
  }
  return { version: VERSION, candidateOnly: true, candidates };
}

module.exports = { VERSION, CODE, auditParentheticalAliasOwners, collectBindings };
