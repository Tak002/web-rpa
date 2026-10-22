// 평가용 레시피: 시험 사이트에서 Recorder 로 녹화한 것(로그인 비밀번호 칸 포함)과 API 로 넣는 것.

import fs from 'node:fs/promises';
import path from 'node:path';
import { Recorder } from '../../src/recorder/recorder.js';
import { applyInputModes, inputSteps } from '../../public/shared/recipe-edit.js';
import { LAB_USER } from '../lab-server.mjs';
import { sleep } from './env.mjs';

const clone = (x) => structuredClone(x);

/** 실험실: 로그인(tester / lab-pass-123) → 원장 조회(사업자번호·기간) → 조회 → ② 엑셀 다운로드 */
export async function recordLab(env) {
  const rec = new Recorder({ name: '원장 조회 (녹화)', startUrl: `${env.labBase}/login.html`, profileDir: path.join(env.ws, 'rec-profile-lab'), headless: true });
  await rec.start();
  const page = rec.ctx.pages()[0];
  page.on('dialog', (d) => d.accept());
  await page.waitForSelector('#uid');
  await page.getByLabel('아이디').fill(LAB_USER.id);
  await page.getByLabel('비밀번호').fill(LAB_USER.pw);
  await page.getByRole('button', { name: '로그인' }).click();
  await page.waitForSelector('text=매출 원장 조회');
  await sleep(300);
  await page.getByLabel('사업자번호').fill('1234567890');
  await page.getByLabel('기간').selectOption({ label: '2026년 1기 (1~6월)' });
  await page.getByRole('button', { name: '조회' }).click();
  await page.waitForSelector('text=조회 완료');
  await sleep(300);
  await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '② 엑셀 다운로드' }).click()]);
  await sleep(800);
  const recipe = await rec.stop();
  return recipe;
}

/** 반복 표: 1쪽 첫 행의 금액 칸 클릭 → "다음" 클릭 */
export async function recordLoop(env) {
  const rec = new Recorder({ name: '거래처 목록 (녹화)', startUrl: `${env.loopBase}/list.html`, profileDir: path.join(env.ws, 'rec-profile-loop'), headless: true });
  await rec.start();
  const page = rec.ctx.pages()[0];
  await page.waitForSelector('#result tbody tr');
  await sleep(300);
  await page.locator('#result tbody tr').first().locator('td').nth(3).click();
  await sleep(300);
  await page.getByRole('button', { name: '다음' }).click();
  await page.waitForURL(/page=2/);
  await sleep(600);
  return rec.stop();
}

export const secretVarOf = (r) => (r.variables ?? []).find((v) => v.source?.secret);

/** 녹화 레시피에서 사업자번호·기간을 엑셀 열로 (입력값 정리와 같은 도우미) */
export function withExcel(recorded, name) {
  const r = clone(recorded);
  delete r.id;
  r.name = name;
  const rows = inputSteps(r);
  const decisions = rows.filter((x) => /사업자번호|기간/.test(x.label)).map((x) => ({ stepId: x.stepId, mode: 'excel', name: /사업자번호/.test(x.label) ? '사업자번호' : '기간' }));
  applyInputModes(r, decisions);
  return r;
}

// ---------- API 로 만드는 반복 표 레시피 ----------
const css = (value, score = 90) => ({ kind: 'css', value, score });
const tgt = (cands, meta = {}) => ({ framePath: [], candidates: cands, meta });
const inItem = (n, label) => ({ framePath: [], within: 'item', candidates: [css(`td:nth-child(${n})`, 80), { kind: 'xpath', value: `./td[${n}]`, score: 60 }], meta: { tag: 'td', label } });
export const ROWS = tgt([css('#result > tbody > tr', 90)], { tag: 'tr', label: '거래처 결과 표의 행', count: 4 });
export const NEXT = tgt([css('#next', 95), { kind: 'text', value: { tag: 'button', text: '다음' }, score: 70 }], { tag: 'button', text: '다음' });

/** T6: 표의 행마다 상호·상태·금액 읽기 (조건은 사용자가 화면에서 더한다) */
export function loopRowsRecipe(env, name = '거래처 상태 확인') {
  return {
    schemaVersion: 1,
    name,
    startUrl: `${env.loopBase}/list.html`,
    entryBlock: 'main',
    loop: { onRowError: 'skip' },
    variables: [],
    blocks: {
      main: [
        { id: 's1', type: 'navigate', url: `${env.loopBase}/list.html` },
        { id: 's2', type: 'forEach', items: clone(ROWS), body: '행마다', maxItems: 100 },
      ],
      행마다: [
        { id: 's3', type: 'extract', target: inItem(2, '상호'), saveAs: '상호' },
        { id: 's4', type: 'extract', target: inItem(3, '상태'), saveAs: '상태' },
        { id: 's5', type: 'extract', target: inItem(4, '금액'), saveAs: '금액' },
      ],
    },
  };
}

/** T7: 1쪽 표의 행마다 상호 읽기 → "다음" 클릭 (쪽 반복은 사용자가 만든다) */
export function pagesRecipe(env, name = '거래처 전체 쪽 읽기') {
  return {
    schemaVersion: 1,
    name,
    startUrl: `${env.loopBase}/list.html`,
    entryBlock: 'main',
    loop: { onRowError: 'skip' },
    variables: [],
    blocks: {
      main: [
        { id: 's1', type: 'navigate', url: `${env.loopBase}/list.html` },
        { id: 's2', type: 'forEach', items: clone(ROWS), body: '행마다', maxItems: 100 },
        { id: 's3', type: 'click', target: clone(NEXT) },
      ],
      행마다: [{ id: 's4', type: 'extract', target: inItem(2, '상호'), saveAs: '상호' }],
    },
  };
}

/** 1회차 화면 방법으로 만든 상태: 목록은 CSS 로 정했지만 몸통 값 읽기가 녹화한 칸 그대로(항목 안 아님) — 고친 화면이 알아보는지 */
export function oldStyleLoop(recorded, name) {
  const r = clone(recorded);
  delete r.id;
  r.name = name;
  const cell = r.blocks.main.find((s) => s.type === 'click' && s.target?.meta?.tag === 'td') ?? r.blocks.main[1];
  const at = r.blocks.main.indexOf(cell);
  r.blocks.main.splice(at + 1, 0, { id: 's90', type: 'forEach', items: tgt([css('#result tbody tr', 60)], { label: '결과 표의 행' }), body: '항목마다', maxItems: 100 });
  r.blocks.항목마다 = [{ id: 's91', type: 'extract', target: clone(cell.target), saveAs: '금액' }];
  return r;
}

/** T9: 긴 레시피 (40여 스텝, 반복 1개) — 실행하지 않고 찾기·고르기만 한다 */
export function longRecipe(env) {
  const main = [{ id: 's1', type: 'navigate', url: `${env.loopBase}/cond.html` }];
  let n = 1;
  const id = () => `s${(n += 1)}`;
  const fields = ['거래처명', '대표자', '사업장 주소', '업태', '종목', '담당자', '연락처', '이메일', '비고', '계좌'];
  for (const f of fields) main.push({ id: id(), type: 'input', target: tgt([css(`#f-${n}`)], { tag: 'input', label: f }), value: `${f} 값` });
  for (const b of ['다음', '확인', '저장', '조회', '닫기', '다음', '확인', '목록']) main.push({ id: id(), type: 'click', target: tgt([css(`#b-${n}`)], { tag: 'button', text: b }) });
  for (const v of ['합계', '부가세', '공급가액']) main.push({ id: id(), type: 'extract', target: tgt([css(`#v-${n}`)], { tag: 'span', label: v }), saveAs: v });
  main.push({ id: id(), type: 'forEach', items: tgt([css('#fruits > li')], { tag: 'li', label: '과일 목록의 항목' }), body: '항목마다' });
  const each = [
    { id: id(), type: 'extract', target: { framePath: [], within: 'item', candidates: [css(':scope', 80)], meta: { tag: 'li', label: '항목 이름' } }, saveAs: '품목' },
    { id: id(), type: 'extract', target: { framePath: [], within: 'item', candidates: [css(':scope', 80)], meta: { tag: 'li', label: '항목 금액' } }, saveAs: '금액' },
  ];
  for (const b of ['인쇄', '확인', '다음', '저장']) main.push({ id: id(), type: 'click', target: tgt([css(`#c-${n}`)], { tag: 'button', text: b }) });
  for (const v of ['접수번호', '처리상태']) main.push({ id: id(), type: 'extract', target: tgt([css(`#w-${n}`)], { tag: 'span', label: v }), saveAs: v });
  main.push({ id: id(), type: 'sleep', ms: 1000 });
  for (const f of ['메모1', '메모2', '메모3', '메모4', '메모5', '메모6']) main.push({ id: id(), type: 'input', target: tgt([css(`#m-${n}`)], { tag: 'input', label: f }), value: '' });
  main.push({ id: id(), type: 'screenshot', fileName: '끝_{{row}}.png' });
  return { schemaVersion: 1, name: '긴 레시피 (스텝 찾기)', startUrl: `${env.loopBase}/cond.html`, entryBlock: 'main', loop: { onRowError: 'skip' }, variables: [], blocks: { main, 항목마다: each } };
}

/** 엑셀(csv) 파일 */
export async function writeCsv(file, rows) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `﻿${rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n')}\r\n`, 'utf8');
  return file;
}
