// 설정 점검: 브라우저 목록 감지 → Brave 선택 저장 → 시험 실행 → 실행이 Brave 전용 프로필을 쓰는지, 설정 화면 스크린샷.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const WS = path.join(OUT, 'ws-settings');
const PORT = 4897;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

await fs.rm(WS, { recursive: true, force: true });
const server = spawn(process.execPath, ['src/server.js', '--port', String(PORT), '--workspace', WS], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, WEB_RPA_BROWSER: '' } });
for (let i = 0; i < 50; i += 1) {
  try {
    await fetch(`${BASE}/api/state`);
    break;
  } catch {
    await sleep(100);
  }
}
try {
  const s0 = (await api('GET', '/api/settings')).data.browser;
  console.log('감지:', s0.choices.map((c) => `${c.id}=${c.found ? 'O' : 'X'}`).join(' '));
  assert.equal(s0.id, 'auto');
  assert.ok(s0.choices.find((c) => c.id === 'brave').found, 'Brave 가 감지돼야 한다');

  const bad = await api('PUT', '/api/settings', { browser: { id: 'custom', path: 'C:\\nope\\x.exe' } });
  assert.equal(bad.status, 400, '없는 실행 파일 경로는 거부');

  const s1 = (await api('PUT', '/api/settings', { browser: { id: 'brave' } })).data.browser;
  assert.equal(s1.id, 'brave');
  assert.equal(s1.profile, 'brave');
  const t = await api('POST', '/api/settings/test-browser');
  console.log('시험 실행:', t.data);
  assert.ok(t.ok && t.data.browser === 'Brave', `Brave 시험 실행 실패: ${JSON.stringify(t.data)}`);
  await fs.access(path.join(WS, 'profiles', 'brave')); // 브라우저 전용 프로필

  // 직접 지정: Brave 실행 파일 경로를 그대로 넣어도 된다
  const bravePath = s0.choices.find((c) => c.id === 'brave').path;
  const s2 = (await api('PUT', '/api/settings', { browser: { id: 'custom', path: `"${bravePath}"` } })).data.browser;
  assert.equal(s2.id, 'custom');
  const t2 = await api('POST', '/api/settings/test-browser');
  assert.ok(t2.ok, `직접 지정 시험 실행 실패: ${JSON.stringify(t2.data)}`);
  await api('PUT', '/api/settings', { browser: { id: 'brave' } });

  // 설정 화면
  const browser = await chromium.launch({ channel: 'msedge' });
  const errors = [];
  for (const [name, vp] of [
    ['settings', { width: 1360, height: 900 }],
    ['m-settings', { width: 390, height: 844 }],
  ]) {
    const page = await browser.newPage({ viewport: vp });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${BASE}/#/settings`);
    await page.waitForSelector('.browser-opt');
    if (name === 'settings') {
      await page.getByRole('button', { name: '저장된 설정으로 시험 실행' }).click();
      await page.waitForSelector('.badge.ok', { timeout: 30000 });
    }
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(sw <= vp.width + 2, `${name}: 가로 스크롤 없음 (${sw})`);
    await page.screenshot({ path: path.join(OUT, 'shots', `${name}.png`), fullPage: true });
  }
  await browser.close();
  assert.deepEqual(errors, []);
  console.log('✅ 설정 점검 통과');
} finally {
  server.kill();
}
