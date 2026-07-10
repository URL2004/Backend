'use strict';

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = String(text || '').replace(/^\uFEFF/u, '');
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field.replace(/\r$/u, ''));
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/u, ''));
    rows.push(row);
  }
  const headers = rows.shift() || [];
  return rows
    .filter(values => values.some(value => value !== ''))
    .map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function stringifyCsv(rows, headers = null) {
  const keys = headers || [...new Set((rows || []).flatMap(row => Object.keys(row || {})))];
  return [keys, ...(rows || []).map(row => keys.map(key => row?.[key] ?? ''))]
    .map(values => values.map(csvCell).join(','))
    .join('\r\n') + '\r\n';
}

function csvCell(value) {
  const text = String(value == null ? '' : value);
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

module.exports = { parseCsv, stringifyCsv };
