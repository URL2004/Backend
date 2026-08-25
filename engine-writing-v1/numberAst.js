'use strict';

const { factKey } = require('../engine/factast');

const UNIT_KIND = Object.freeze({
  '명': 'person', '인': 'person',
  '개': 'count', '건': 'count', '회': 'count', '번': 'count', '팀': 'count', '곳': 'count', '대': 'count', '권': 'count', '장': 'count', '인분': 'count',
  '년': 'duration_year', '개월': 'duration_month', '주': 'duration_week', '일': 'duration_day', '시간': 'duration_hour', '분': 'duration_minute', '초': 'duration_second',
  '점': 'score', '배': 'ratio', '위': 'rank', '학점': 'score',
  'kg': 'weight', 'g': 'weight', 'km': 'distance', 'm': 'distance', 'cm': 'distance', 'mm': 'distance', '㎡': 'area', '평': 'area'
});

function extractQuantities(value) {
  const text = String(value || '').normalize('NFKC');
  const rows = [];
  const occupied = [];
  const addMatches = (re, make) => {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text))) {
      const start = match.index;
      const end = start + match[0].length;
      if (occupied.some(range => start < range.end && end > range.start)) continue;
      const item = make(match, start, end);
      if (!item) continue;
      rows.push(item);
      occupied.push({ start, end });
    }
  };

  addMatches(/(?<!\d)(19\d{2}|20\d{2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})(?:\s*\.)?(?!\d)/gu, (m, start, end) => {
    const date = validDate(m[1], m[2], m[3]);
    return date && token('date', date, 'date', m[0], start, end);
  });
  addMatches(/(?<!\d)(19\d{2}|20\d{2})년\s*(\d{1,2})월\s*(\d{1,2})일(?!\d)/gu, (m, start, end) => {
    const date = validDate(m[1], m[2], m[3]);
    return date && token('date', date, 'date', m[0], start, end);
  });
  addMatches(/(?<!\d)(\d{1,2})월\s*(\d{1,2})일(?!\d)/gu, (m, start, end) => {
    const month = Number(m[1]); const day = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return token('month_day', `${pad(month)}-${pad(day)}`, 'date', m[0], start, end);
  });
  addMatches(/(?:(오전|오후)\s*)?(\d{1,2})시(?!간)(?:\s*(\d{1,2})분)?/gu, (m, start, end) => {
    let hour = Number(m[2]);
    const minute = Number(m[3] || 0);
    if (hour > 23 || minute > 59) return null;
    if (m[1] === '오후' && hour < 12) hour += 12;
    if (m[1] === '오전' && hour === 12) hour = 0;
    return token('time', `${pad(hour)}:${pad(minute)}`, 'time', m[0], start, end);
  });
  // 한국식 복합 금액 전체를 한 토큰으로 잡는다. `1만8천원`을 `1`과 `8천원`으로
  // 쪼개면 18,000원 ↔ 1만8천원의 동치 판단과 항목 합계 검사가 모두 깨진다.
  addMatches(/[-+]?(?:\d[\d,]*(?:\.\d+)?)(?:\s*(?:조|억|만|천|백|십)\s*(?:\d[\d,]*(?:\.\d+)?)?)*\s*원/gu, (m, start, end) => {
    const key = factKey(m[0]).replace(/\s+/gu, '');
    const amount = Number(key.replace(/원$/u, ''));
    return Number.isFinite(amount) ? token('money', String(amount), 'KRW', m[0], start, end) : null;
  });
  addMatches(/[-+]?\d[\d,]*(?:\.\d+)?\s*(?:%|퍼센트)/gu, (m, start, end) => {
    const number = numericPart(m[0]);
    return number != null ? token('percentage', number, '%', m[0], start, end) : null;
  });
  addMatches(/(?<!\d)1\s*(?:명|인)(?=당)/gu, (m, start, end) => token('structural_person', '1', 'person', m[0], start, end, true));
  addMatches(/[-+]?\d[\d,]*(?:\.\d+)?\s*(?:개월|시간|학점|인분|kg|km|cm|mm|㎡|명|인|개|건|회|번|팀|곳|대|권|장|년|주|일|분|초|점|배|위|g|m|평)(?![A-Za-z0-9])/giu, (m, start, end) => {
    const unitMatch = m[0].match(/(개월|시간|학점|인분|kg|km|cm|mm|㎡|명|인|개|건|회|번|팀|곳|대|권|장|년|주|일|분|초|점|배|위|g|m|평)$/iu);
    const unit = unitMatch ? unitMatch[1].toLowerCase() : '';
    const number = numericPart(m[0]);
    if (number == null || !unit) return null;
    const trailing = text.slice(end, end + 2);
    if ((unit === '인' || unit === '명') && Number(number) === 1 && /^당/u.test(trailing)) {
      return token('structural_person', number, unit, m[0], start, end, true);
    }
    const normalized = normalizeMeasuredQuantity(UNIT_KIND[unit] || 'quantity', number, unit);
    return token(normalized.kind, normalized.value, normalized.unit, m[0], start, end);
  });
  addMatches(/(?<!\d)(19\d{2}|20\d{2})년(?!\d)/gu, (m, start, end) => token('year', String(Number(m[1])), 'year', m[0], start, end));
  addMatches(/(?<![A-Za-z0-9_])[-+]?\d[\d,]*(?:\.\d+)?(?![A-Za-z0-9_])/gu, (m, start, end) => {
    const number = numericPart(m[0]);
    return number != null ? token('number', number, '', m[0], start, end) : null;
  });

  return rows.sort((a, b) => a.start - b.start);
}

function token(kind, value, unit, raw, start, end, structural = false) {
  return { kind, value: String(value), unit, canonical: `${kind}:${value}:${unit}`, raw, start, end, structural };
}

function numericPart(value) {
  const match = String(value || '').replace(/,/gu, '').match(/[-+]?\d+(?:\.\d+)?/u);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? String(number) : null;
}

function validDate(year, month, day) {
  const y = Number(year); const m = Number(month); const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return '';
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return '';
  return `${y}-${pad(m)}-${pad(d)}`;
}

function pad(value) { return String(Number(value)).padStart(2, '0'); }

function normalizeMeasuredQuantity(kind, number, unit) {
  const value = Number(number);
  if (!Number.isFinite(value)) return { kind, value: number, unit };
  if (kind === 'person') return { kind: 'person', value: String(value), unit: 'person' };
  if (kind === 'weight') {
    const grams = unit === 'kg' ? value * 1000 : value;
    return { kind: 'weight', value: cleanNumber(grams), unit: 'g' };
  }
  if (kind === 'distance') {
    const factor = { km: 1000000, m: 1000, cm: 10, mm: 1 }[unit];
    return { kind: 'distance', value: cleanNumber(value * factor), unit: 'mm' };
  }
  if (kind === 'duration_hour' || kind === 'duration_minute' || kind === 'duration_second') {
    const factor = kind === 'duration_hour' ? 3600 : kind === 'duration_minute' ? 60 : 1;
    return { kind: 'duration', value: cleanNumber(value * factor), unit: 'second' };
  }
  return { kind, value: String(value), unit };
}

function cleanNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e9) / 1e9);
}

function compareQuantities(sourceText, outputText) {
  const source = extractQuantities(sourceText).filter(item => !item.structural);
  const output = extractQuantities(outputText).filter(item => !item.structural);
  const allowed = new Set(source.flatMap(canonicalAliases));
  const added = [];
  for (const item of output) {
    if (allowed.has(item.canonical)) continue;
    if (item.kind === 'number' && isHarmlessStructure(outputText, item)) continue;
    if (!added.some(existing => existing.canonical === item.canonical)) added.push(item);
  }
  return {
    pass: added.length === 0,
    source,
    output,
    added,
    addedTokens: added.map(item => item.raw).slice(0, 20)
  };
}

function canonicalAliases(item) {
  const aliases = [item.canonical];
  if (item.kind === 'date' && /^\d{4}-\d{2}-\d{2}$/u.test(item.value)) {
    aliases.push(`year:${item.value.slice(0, 4)}:year`);
    aliases.push(`month_day:${item.value.slice(5)}:date`);
  }
  return aliases;
}

function isHarmlessStructure(text, item) {
  const before = String(text || '').slice(Math.max(0, item.start - 4), item.start);
  const after = String(text || '').slice(item.end, item.end + 5);
  return /(?:^|\s)(?:제|단계\s*)$/u.test(before) || /^(?:번째|단계|문단|가지|첫째|차례)/u.test(after);
}

module.exports = { UNIT_KIND, extractQuantities, compareQuantities, validDate, normalizeMeasuredQuantity, canonicalAliases };
