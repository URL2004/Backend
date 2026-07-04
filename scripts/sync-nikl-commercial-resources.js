'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { TextDecoder } = require('util');

const ROOT = path.resolve(__dirname, '..');
const RESOURCE_DIR = path.join(ROOT, 'engine', 'koreanQuality', 'resources');

const DATASETS = {
  publicLanguage: {
    id: 'publicLanguage',
    publicDataPk: '15130006',
    publicDataDetailPk: 'uddi:965e39a6-8b5f-4eb1-aeb2-8d8a2122147c',
    dataName: 'nikl_public_language_terms.csv',
    title: '문화체육관광부 국립국어원_쉽고 바른 공공언어 쓰기 평가용 용어 목록',
    sourceUrl: 'https://www.data.go.kr/data/15130006/fileData.do',
    license: 'KOG Type 1 - attribution required'
  },
  normRules: {
    id: 'normRules',
    publicDataPk: '15122678',
    publicDataDetailPk: 'uddi:c3fbb318-f030-4aa4-9266-8a67deda5ae2',
    dataName: 'nikl_norm_regulations.zip',
    title: '문화체육관광부 국립국어원_한국어 어문규범 규정 정보',
    sourceUrl: 'https://www.data.go.kr/data/15122678/fileData.do',
    license: 'KOG Type 1 - attribution required'
  },
  corpusStats: {
    id: 'corpusStats',
    publicDataPk: '15123464',
    publicDataDetailPk: 'uddi:dae1d3fd-5b62-4639-a4d8-82c1063a7f64',
    dataName: 'nikl_corpus_stats.csv',
    title: '문화체육관광부 국립국어원_말뭉치 통계 목록',
    sourceUrl: 'https://www.data.go.kr/data/15123464/fileData.do',
    license: 'KOG Type 1 - attribution required'
  }
};

async function main() {
  fs.mkdirSync(RESOURCE_DIR, { recursive: true });

  const publicLanguageBuffer = await downloadDataFile(DATASETS.publicLanguage);
  const publicLanguageRows = parseCsv(decodeText(publicLanguageBuffer, 'utf8'));
  const publicLanguage = buildPublicLanguageTerms(publicLanguageRows, DATASETS.publicLanguage);
  writeJson('publicLanguageTerms.json', publicLanguage);

  const normBuffer = await downloadDataFile(DATASETS.normRules);
  const normRules = buildNormRegulations(normBuffer, DATASETS.normRules);
  writeJson('normRegulations.json', normRules);

  const corpusBuffer = await downloadDataFile(DATASETS.corpusStats);
  const corpusRows = parseCsv(decodeText(corpusBuffer, 'euc-kr'));
  const corpusStats = buildCorpusStats(corpusRows, DATASETS.corpusStats);
  writeJson('corpusStats.json', corpusStats);

  const sources = {
    generatedAt: new Date().toISOString(),
    commercialUsePolicy: 'Only KOG Type 1 datasets are bundled. Runtime APIs must filter or ignore non-commercial items.',
    datasets: Object.fromEntries(Object.entries(DATASETS).map(([key, value]) => [key, {
      title: value.title,
      sourceUrl: value.sourceUrl,
      publicDataPk: value.publicDataPk,
      publicDataDetailPk: value.publicDataDetailPk,
      license: value.license
    }]))
  };
  writeJson('sources.json', sources);

  console.log(JSON.stringify({
    ok: true,
    resourceDir: RESOURCE_DIR,
    counts: {
      publicLanguageTerms: publicLanguage.terms.length,
      normCodes: normRules.codes.length,
      normRules: normRules.rules.length,
      corpusRows: corpusStats.rows.length
    }
  }, null, 2));
}

async function downloadDataFile(dataset) {
  const downloadInfoUrl = 'https://www.data.go.kr/tcs/dss/selectFileDataDownload.do';
  const body = new URLSearchParams({
    publicDataPk: dataset.publicDataPk,
    publicDataDetailPk: dataset.publicDataDetailPk,
    atchFileId: '',
    fileDetailSn: '1'
  });
  const info = await fetch(downloadInfoUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      referer: dataset.sourceUrl
    },
    body
  });
  if (!info.ok) throw new Error(`download info failed: ${dataset.id} ${info.status}`);
  const json = await info.json();
  if (!json.status || !json.atchFileId || !json.fileDetailSn) {
    throw new Error(`download info invalid: ${dataset.id}`);
  }
  const fileUrl = new URL('https://www.data.go.kr/cmm/cmm/fileDownload.do');
  fileUrl.searchParams.set('atchFileId', json.atchFileId);
  fileUrl.searchParams.set('fileDetailSn', json.fileDetailSn);
  fileUrl.searchParams.set('dataNm', dataset.dataName);
  const file = await fetch(fileUrl, { headers: { referer: dataset.sourceUrl } });
  if (!file.ok) throw new Error(`file download failed: ${dataset.id} ${file.status}`);
  return Buffer.from(await file.arrayBuffer());
}

function buildPublicLanguageTerms(rows, dataset) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const term = cleanCell(row['단어_용어'] || row['단어 용어'] || row['용어']);
    if (!term) continue;
    const alternatives = splitMultiValue(row['대안어(안)'] || row['대안어'] || row['대체어']);
    const variants = splitMultiValue(row['이표기_오표기'] || row['이표기 오표기'] || row['오표기']);
    const key = normalizeKey(term);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      term,
      variants,
      alternatives,
      license: 'KOG-1',
      source: dataset.title
    });
  }
  return {
    version: 'nikl-public-language-terms-v1',
    generatedAt: new Date().toISOString(),
    sourceTitle: dataset.title,
    sourceUrl: dataset.sourceUrl,
    license: dataset.license,
    terms: out
  };
}

function buildNormRegulations(zipBuffer, dataset) {
  const entries = unzipEntries(zipBuffer);
  const codes = [];
  const rules = [];
  const seenCode = new Set();
  const seenRule = new Set();

  for (const entry of entries) {
    const text = decodeCsvEntry(entry.buffer);
    if (!text || text.length < 20) continue;
    const rows = parseCsv(text);
    if (!rows.length) continue;
    const headers = Object.keys(rows[0] || {});
    if (headers.includes('고시번호') && headers.includes('고시제목') && headers.includes('규정코드')) {
      for (const row of rows) {
        const code = cleanCell(row['규정코드']);
        if (!code || seenCode.has(code)) continue;
        seenCode.add(code);
        codes.push({
          code,
          title: cleanCell(row['고시제목']),
          effectiveDate: cleanCell(row['시행일']),
          status: cleanCell(row['고시상태'])
        });
      }
      continue;
    }

    if (!headers.includes('규정코드') || !headers.includes('제목')) continue;
    if (headers.includes('용례번호') || headers.includes('외래어구분')) continue;

    for (const row of rows) {
      const code = cleanCell(row['규정코드']);
      const title = cleanCell(row['제목']);
      const subject = cleanCell(row['주제어']);
      const subSubject = cleanCell(row['부주제어']);
      const section = cleanCell(row['규정경로']);
      if (!code || (!title && !subject && !subSubject)) continue;
      const key = [code, section, title, subject, subSubject].join('|');
      if (seenRule.has(key)) continue;
      seenRule.add(key);
      rules.push({
        code,
        section,
        title,
        subject,
        subSubject,
        level: cleanCell(row['규정레벨']),
        status: cleanCell(row['상태'])
      });
      if (rules.length >= 3000) break;
    }
  }

  return {
    version: 'nikl-norm-regulations-v1',
    generatedAt: new Date().toISOString(),
    sourceTitle: dataset.title,
    sourceUrl: dataset.sourceUrl,
    license: dataset.license,
    note: 'The runtime uses rule titles and topics only. Full normative text and example rows are not bundled into prompts.',
    codes,
    rules
  };
}

function buildCorpusStats(rows, dataset) {
  const compactRows = [];
  let totals = {
    fileCount: 0,
    documentCount: 0,
    paragraphCount: 0,
    sentenceCount: 0,
    eojeolCount: 0
  };
  for (const row of rows) {
    const name = cleanCell(row['배포 말뭉치'] || row['말뭉치 명칭'] || row['말뭉치명'] || row['말뭉치']);
    if (!name) continue;
    const item = {
      name,
      category: cleanCell(row['성격'] || row['분류'] || row['유형']),
      fileCount: firstNumber(row, ['파일 수', '파일수']),
      documentCount: firstNumber(row, ['문서 수', '문서수']),
      paragraphCount: firstNumber(row, ['문단 수', '문단수']),
      sentenceCount: firstNumber(row, ['문장 수', '문장수']),
      eojeolCount: firstNumber(row, ['어절 수', '어절수'])
    };
    compactRows.push(item);
    totals.fileCount += item.fileCount || 0;
    totals.documentCount += item.documentCount || 0;
    totals.paragraphCount += item.paragraphCount || 0;
    totals.sentenceCount += item.sentenceCount || 0;
    totals.eojeolCount += item.eojeolCount || 0;
  }
  const aggregate = {
    ...totals,
    avgSentencesPerParagraph: safeRatio(totals.sentenceCount, totals.paragraphCount),
    avgEojeolPerSentence: safeRatio(totals.eojeolCount, totals.sentenceCount),
    rowCount: compactRows.length
  };
  return {
    version: 'nikl-corpus-stats-v1',
    generatedAt: new Date().toISOString(),
    sourceTitle: dataset.title,
    sourceUrl: dataset.sourceUrl,
    license: dataset.license,
    aggregate,
    rows: compactRows
  };
}

function parseCsv(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuote = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (inQuote) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuote = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuote = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows.shift().map(h => cleanCell(h));
  return rows
    .filter(r => r.some(v => cleanCell(v)))
    .map(r => {
      const obj = {};
      headers.forEach((h, i) => { obj[h || `col${i}`] = cleanCell(r[i]); });
      return obj;
    });
}

function unzipEntries(buffer) {
  const entries = [];
  let pos = 0;
  while (pos < buffer.length - 30) {
    if (buffer.readUInt32LE(pos) !== 0x04034b50) {
      pos += 1;
      continue;
    }
    const method = buffer.readUInt16LE(pos + 8);
    const compSize = buffer.readUInt32LE(pos + 18);
    const uncompSize = buffer.readUInt32LE(pos + 22);
    const nameLen = buffer.readUInt16LE(pos + 26);
    const extraLen = buffer.readUInt16LE(pos + 28);
    const dataStart = pos + 30 + nameLen + extraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > buffer.length) break;
    const raw = buffer.slice(dataStart, dataEnd);
    const inflated = method === 8 ? zlib.inflateRawSync(raw) : raw;
    if (uncompSize && inflated.length !== uncompSize) {
      // Some ZIPs contain UTF-8 extra fields. The inflated data is still usable.
    }
    entries.push({ buffer: inflated });
    pos = dataEnd;
  }
  return entries;
}

function decodeCsvEntry(buffer) {
  const utf8 = decodeText(buffer, 'utf8');
  if (replacementRatio(utf8) <= 0.03) return utf8;
  return decodeText(buffer, 'euc-kr');
}

function decodeText(buffer, preferred) {
  if (preferred === 'euc-kr') {
    return new TextDecoder('euc-kr').decode(buffer).replace(/^\uFEFF/, '');
  }
  return new TextDecoder('utf-8').decode(buffer).replace(/^\uFEFF/, '');
}

function replacementRatio(text) {
  const source = String(text || '');
  if (!source.length) return 0;
  const replacements = (source.match(/\uFFFD/g) || []).length;
  return replacements / source.length;
}

function splitMultiValue(value) {
  return [...new Set(String(value || '')
    .split(/[,;/\n]|(?:\s{2,})/)
    .map(cleanCell)
    .filter(v => v && v !== '-' && v !== '없음')
    .slice(0, 12))];
}

function cleanCell(value) {
  return String(value == null ? '' : value)
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeKey(value) {
  return cleanCell(value).toLowerCase();
}

function firstNumber(row, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) return parseNumber(row[key]);
  }
  return 0;
}

function parseNumber(value) {
  const n = Number(String(value || '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function safeRatio(a, b) {
  return b > 0 ? Number((a / b).toFixed(3)) : 0;
}

function writeJson(fileName, value) {
  const target = path.join(RESOURCE_DIR, fileName);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
