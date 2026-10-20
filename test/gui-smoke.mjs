// 서버 + 화면 점검: 레시피 가져오기 → 엑셀 업로드 → 숨김 실행 → 리포트, 그리고 화면별 스크린샷.
// 먼저 node test/e2e.mjs 로 test/out/recipe.json, input.xlsx 를 만들어 둘 것.
// 실행: node test/gui-smoke.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './fixture-server.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const SHOTS = path.join(OUT, 'shots');
const PORT = 4899;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, body, raw) {
  const res = await fetch(BASE + url, { method, headers: body && !raw ? { 'content-type': 'application/json' } : undefined, body: raw ? body : body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${url}: ${data.error}`);
  return data;
}

async function main() {
  await fs.rm(path.join(OUT, 'ws'), { recursive: true, force: true });
  await fs.mkdir(SHOTS, { recursive: true });
  const fixture = await startFixture();
  const site = `http://127.0.0.1:${fixture.address().port}/`;
  const server = spawn(process.execPath, ['src/server.js', '--port', String(PORT), '--workspace', path.join(OUT, 'ws')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  for (let i = 0; i < 50; i += 1) {
    try {
      await fetch(`${BASE}/api/state`);
      break;
    } catch {
      await sleep(100);
    }
  }

  try {
    // 레시피 가져오기 (녹화 때 fixture 주소를 이번 주소로 바꾼다)
    let text = await fs.readFile(path.join(OUT, 'recipe.json'), 'utf8');
    text = text.replace(/http:\/\/127\.0\.0\.1:\d+\//g, site);
    const { recipe, problems } = await api('POST', '/api/recipes', JSON.parse(text));
    assert.deepEqual(problems, []);
    const up = await api('POST', `/api/uploads?name=${encodeURIComponent('거래처.xlsx')}`, await fs.readFile(path.join(OUT, 'input.xlsx')), true);
    assert.equal(up.rowCount, 3);
    const { runId } = await api('POST', '/api/runs', { recipeId: recipe.id, uploadId: up.id, options: { headless: true } });

    const browser = await chromium.launch({ channel: 'msedge' });
    const errors = [];
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    // 실행 중 화면
    await page.goto(`${BASE}/#/run?recipe=${recipe.id}`);
    await page.waitForSelector('.logbox');
    await sleep(2500);
    await page.screenshot({ path: path.join(SHOTS, 'run-live.png') });

    for (let i = 0; i < 120; i += 1) {
      const s = await api('GET', '/api/state');
      if (['done', 'failed', 'stopped'].includes(s.run?.status)) break;
      await sleep(500);
    }
    const report = await api('GET', `/api/runs/${runId}`);
    assert.equal(report.totals.ok, 2);
    assert.equal(report.totals.failed, 1);
    await sleep(500);
    await page.screenshot({ path: path.join(SHOTS, 'run-done.png') });
    assert.ok(await page.getByText('리포트 보기').isVisible(), '실행이 끝나면 리포트 보기 버튼');

    const views = [
      ['recipes', `${BASE}/#/recipes`],
      ['editor', `${BASE}/#/recipe/${recipe.id}`],
      ['reports', `${BASE}/#/reports`],
      ['report', `${BASE}/#/report/${runId}`],
      ['record', `${BASE}/#/record`],
    ];
    for (const [name, url] of views) {
      await page.goto(url);
      await page.waitForSelector('#app > *');
      await sleep(300);
      await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: name !== 'editor' });
    }
    // 편집기: 스텝 하나 펼치기 + 변수 탭
    await page.goto(`${BASE}/#/recipe/${recipe.id}`);
    await page.locator('.step-head').nth(1).click();
    await sleep(200);
    await page.screenshot({ path: path.join(SHOTS, 'editor-open.png') });
    await page.getByRole('button', { name: /변수·엑셀/ }).click();
    await page.screenshot({ path: path.join(SHOTS, 'editor-vars.png') });
    // 편집 저장 왕복
    await page.getByRole('button', { name: /스텝/ }).first().click();
    await page.locator('.step-head').nth(2).click();
    await page.getByRole('button', { name: '↑ 위로' }).click();
    await page.getByRole('button', { name: '저장 *' }).click();
    await page.waitForSelector('text=저장했습니다');
    const saved = await api('GET', `/api/recipes/${recipe.id}`);
    assert.equal(saved.recipe.blocks.main[1].id, recipe.blocks.main[2].id, '위로 이동 후 저장이 반영돼야 한다');

    // 모바일 폭
    const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
    m.on('pageerror', (e) => errors.push(e.message));
    for (const [name, url] of [
      ['m-report', `${BASE}/#/report/${runId}`],
      ['m-editor', `${BASE}/#/recipe/${recipe.id}`],
      ['m-run', `${BASE}/#/run?recipe=${recipe.id}`],
      ['m-hub', `${BASE}/#/hub`], // 허브에 연결되지 않아도 화면은 그려져야 한다
    ]) {
      await m.goto(url);
      await m.waitForSelector('#app > *');
      await sleep(300);
      const sw = await m.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(sw <= 392, `${name}: 가로 스크롤 없음 (scrollWidth=${sw})`);
      await m.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    }
    // 실패 화면·PDF 파일 링크
    const pdfFile = report.rows[0].files.find((f) => f.endsWith('.pdf'));
    const pdfRes = await fetch(`${BASE}/api/runs/${runId}/file?path=${encodeURIComponent(pdfFile)}`);
    assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');
    const bad = await fetch(`${BASE}/api/runs/${runId}/file?path=${encodeURIComponent('../../recipes')}`);
    assert.equal(bad.status, 400, '경로 탈출은 막혀야 한다');

    assert.deepEqual(errors, [], `화면 오류: ${errors.join(' | ')}`);
    await browser.close();
    console.log(`\n✅ GUI 점검 통과 — 스크린샷: ${SHOTS}`);
  } finally {
    server.kill();
    fixture.close();
  }
}

main().catch((e) => {
  console.error('\n❌ GUI 점검 실패:', e);
  process.exit(1);
});
