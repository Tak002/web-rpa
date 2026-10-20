// 엑셀(xlsx·csv) 읽기·쓰기. 값은 모두 문자열로 다룬다(사업자번호 앞자리 0 보존).

import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';

const pad = (n) => String(n).padStart(2, '0');

/** 엑셀 셀 값 → 문자열 */
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return Math.abs(v) < 1e21 ? v.toLocaleString('en-US', { useGrouping: false }) : String(v);
    return String(Number(v.toPrecision(15)));
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) {
    // ExcelJS 는 날짜 셀을 UTC 기준 Date 로 준다
    const d = `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
    const t = v.getUTCHours() || v.getUTCMinutes() || v.getUTCSeconds() ? ` ${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}` : '';
    return d + t;
  }
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text ?? '').join('');
    if ('result' in v) return cellText(v.result); // 수식
    if ('text' in v) return cellText(v.text); // 하이퍼링크
    if ('error' in v) return String(v.error);
  }
  return String(v);
}

/** 머리글 정리: 빈 칸은 "열N", 겹치면 뒤에 번호. */
function cleanHeaders(raw) {
  const seen = new Map();
  return raw.map((h, i) => {
    let name = String(h ?? '').replace(/\s+/g, ' ').trim() || `열${i + 1}`;
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    if (n) name = `${name}_${n + 1}`;
    return name;
  });
}

function toTable(matrix) {
  const rows = matrix.filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
  if (!rows.length) return { headers: [], rows: [] };
  const width = Math.max(...rows.map((r) => r.length));
  const headerRow = rows[0].concat(Array(width - rows[0].length).fill(''));
  // 머리글 오른쪽 끝의 빈 칸은 버린다
  let last = headerRow.length;
  while (last > 0 && String(headerRow[last - 1] ?? '').trim() === '') last -= 1;
  const headers = cleanHeaders(headerRow.slice(0, last));
  const data = rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? '')])));
  return { headers, rows: data };
}

/** CSV 한 덩어리를 행·열로 나눈다 (따옴표·줄바꿈 처리). */
function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delim = !firstLine.includes(',') && firstLine.includes('\t') ? '\t' : !firstLine.includes(',') && firstLine.includes(';') ? ';' : ',';
  const out = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

/** UTF-8 이 아니면 한국어 엑셀이 저장하는 CP949(EUC-KR)로 읽는다. */
function decodeText(buf) {
  let b = buf;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return new TextDecoder('euc-kr').decode(b);
  }
}

/**
 * 첫 시트(또는 csv)를 읽는다.
 * @returns {Promise<{headers: string[], rows: Record<string, string>[]}>}
 */
export async function readTable(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.xls') throw new Error('오래된 .xls 형식은 읽을 수 없습니다. 엑셀에서 .xlsx 로 저장한 뒤 올려 주세요.');
  if (ext === '.csv' || ext === '.txt') return toTable(parseCsv(decodeText(await fs.readFile(file))));
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(file);
  } catch (e) {
    throw new Error(`엑셀 파일을 읽지 못했습니다: ${e.message}`);
  }
  const ws = wb.worksheets.find((w) => w.actualRowCount > 0) ?? wb.worksheets[0];
  if (!ws) return { headers: [], rows: [] };
  const matrix = [];
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    const vals = [];
    for (let c = 1; c <= row.cellCount; c += 1) vals.push(cellText(row.getCell(c).value));
    matrix[n - 1] = vals;
  });
  return toTable(Array.from(matrix, (r) => r ?? []));
}

/** 레시피가 쓰는 열로 빈 입력 양식을 만든다 (셀 서식은 텍스트 → 앞자리 0 유지). */
export async function writeTemplate(columns, file) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('입력');
  ws.columns = columns.map((c) => ({ header: c, key: c, width: Math.max(12, Math.min(40, String(c).length * 2 + 4)), style: { numFmt: '@' } }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  await wb.xlsx.writeFile(file);
}

/**
 * 결과 엑셀: 행 · 입력 열 · 결과 · 읽은 값 열 · 오류.
 * @param {string} file
 * @param {{headers: string[], valueKeys: string[], rows: object[]}} data
 */
export async function writeResults(file, { headers, valueKeys, rows }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('결과');
  const cols = ['행', ...headers, '결과', ...valueKeys, '오류'];
  ws.columns = cols.map((c) => ({ header: c, key: c, width: Math.max(8, Math.min(50, String(c).length * 2 + 4)) }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of rows) {
    const line = [String(r.rowNumber), ...headers.map((h) => r.input?.[h] ?? ''), r.status === 'ok' ? '성공' : '실패', ...valueKeys.map((k) => r.values?.[k] ?? ''), r.error ?? ''];
    const row = ws.addRow(line.map((v) => String(v)));
    row.eachCell((cell) => {
      cell.numFmt = '@';
    });
    row.getCell(headers.length + 2).font = { color: { argb: r.status === 'ok' ? 'FF1A7F37' : 'FFB3261E' }, bold: true };
  }
  await wb.xlsx.writeFile(file);
}
