// 실행 결과 파일: report.json · rows.csv (UTF-8 BOM, 수식 주입 차단) · results.xlsx · log.txt

import fs from 'node:fs/promises';
import path from 'node:path';
import { writeResults } from './excel.js';

/** CSV 칸: =, +, @, 탭·CR, 그리고 숫자가 아닌 - 로 시작하면 앞에 ' 를 붙여 엑셀이 수식으로 읽지 않게 한다. 음수(-1,000)는 숫자로 남긴다. */
export function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+@\t\r]/.test(s) || /^-(?![\d.,]+$)/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 행들의 읽은 값 이름 (처음 나온 순서) */
export function valueKeysOf(rows) {
  const keys = [];
  for (const r of rows) for (const k of Object.keys(r.values ?? {})) if (!keys.includes(k)) keys.push(k);
  return keys;
}

export async function writeRunFiles(runDir, report, logLines) {
  await fs.mkdir(runDir, { recursive: true });
  const headers = report.excel?.headers ?? [];
  const valueKeys = valueKeysOf(report.rows);
  await fs.writeFile(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  const lines = [['행', ...headers, '결과', ...valueKeys, '오류']];
  for (const r of report.rows) lines.push([r.rowNumber, ...headers.map((h) => r.input?.[h] ?? ''), r.status === 'ok' ? '성공' : '실패', ...valueKeys.map((k) => r.values?.[k] ?? ''), r.error ?? '']);
  await fs.writeFile(path.join(runDir, 'rows.csv'), `﻿${lines.map((l) => l.map(csvCell).join(',')).join('\r\n')}\r\n`, 'utf8');
  await fs.writeFile(path.join(runDir, 'log.txt'), `${logLines.join('\r\n')}\r\n`, 'utf8');
  await writeResults(path.join(runDir, 'results.xlsx'), { headers, valueKeys, rows: report.rows });
}
