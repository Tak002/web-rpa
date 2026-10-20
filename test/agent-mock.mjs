// AI 도우미 점검 (가짜 OpenRouter): 레시피 읽기 → 화면 관찰 → 참조 번호로 값 읽기 스텝 추가 → 검사 → 적용 후 실제 실행.
// 먼저 node test/e2e.mjs 로 test/out/recipe.json, input.xlsx 를 만들어 둘 것.
// 실행: node test/agent-mock.mjs

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './fixture-server.mjs';
import { Observer } from '../src/ai/observer.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const PORT = 4898;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 가짜 OpenRouter ----------
const seen = { requests: 0, auth: null, model: null, snapshot: '' };
function startMockOpenRouter() {
  const call = (name, args) => ({ id: `call_${seen.requests}_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seen.requests += 1;
    seen.auth = req.headers.authorization;
    seen.model = body.model;
    assert.ok(body.tools?.some((t) => t.function.name === 'observe_page'), '도구 정의가 함께 가야 한다');
    const tools = body.messages.filter((m) => m.role === 'tool');
    const last = tools.at(-1)?.content ?? '';
    let message;
    if (tools.length === 0) message = { role: 'assistant', content: null, tool_calls: [call('get_recipe', {})] };
    else if (tools.length === 1) {
      const recipe = JSON.parse(last);
      const search = recipe.blocks.main.find((s) => s.type === 'click' && s.desc.includes('"조회"'));
      seen.searchId = search.id;
      message = { role: 'assistant', content: '조회 버튼을 누른 뒤의 화면을 확인하겠습니다.', tool_calls: [call('observe_page', { runUntilStepId: search.id })] };
    } else if (tools.length === 2) {
      seen.snapshot = last;
      const line = last.split('\n').find((l) => l.includes('"조회결과:'));
      const ref = line?.split(' ')[0];
      message = {
        role: 'assistant',
        content: null,
        tool_calls: [
          call('insert_steps', {
            afterStepId: seen.searchId,
            steps: [
              { type: 'wait', condition: { kind: 'textVisible', text: '조회결과' }, timeoutMs: 15000 },
              { type: 'extract', targetRef: ref, saveAs: '조회결과' },
            ],
          }),
        ],
      };
    } else if (tools.length === 3) message = { role: 'assistant', content: null, tool_calls: [call('validate_recipe', {})] };
    else message = { role: 'assistant', content: '1. 조회 뒤 "조회결과" 글자가 보일 때까지 기다리는 스텝을 넣었습니다.\n2. 결과 글자를 읽어 {{조회결과}} 로 저장하는 스텝을 넣었습니다.' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: body.model, choices: [{ message }], usage: { prompt_tokens: 1000, completion_tokens: 50, cost: 0.0025 } }));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

async function api(method, url, body, raw) {
  const res = await fetch(BASE + url, { method, headers: body && !raw ? { 'content-type': 'application/json' } : undefined, body: raw ? body : body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${url}: ${data.error}`);
  return data;
}

async function main() {
  const ws = path.join(OUT, 'ws-agent');
  await fs.rm(ws, { recursive: true, force: true });
  const fixture = await startFixture();
  const site = `http://127.0.0.1:${fixture.address().port}/`;
  const mock = await startMockOpenRouter();
  const server = spawn(process.execPath, ['src/server.js', '--port', String(PORT), '--workspace', ws], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, OPENROUTER_BASE_URL: `http://127.0.0.1:${mock.address().port}/api/v1`, OPENROUTER_API_KEY: '' },
  });
  for (let i = 0; i < 50; i += 1) {
    try {
      await fetch(`${BASE}/api/state`);
      break;
    } catch {
      await sleep(100);
    }
  }
  try {
    // 1. 설정: 키는 화면으로 돌아오지 않는다
    const s0 = await api('GET', '/api/settings');
    assert.equal(s0.openrouter.hasKey, false);
    const s1 = await api('PUT', '/api/settings', { openrouter: { apiKey: 'sk-or-test-key-9876', model: 'anthropic/claude-sonnet-5.5' } });
    assert.equal(s1.openrouter.hasKey, true);
    assert.equal(s1.openrouter.keyHint, '…9876');
    assert.ok(!JSON.stringify(s1).includes('sk-or-test'), '키 원문이 응답에 있으면 안 된다');

    // 2. AI 가 고칠 레시피: e2e 결과에서 값 읽기 스텝을 뺀 것
    let text = (await fs.readFile(path.join(OUT, 'recipe.json'), 'utf8')).replace(/http:\/\/127\.0\.0\.1:\d+\//g, site);
    const base = JSON.parse(text);
    base.blocks.main = base.blocks.main.filter((st) => st.type !== 'extract');
    const { recipe } = await api('POST', '/api/recipes', base);
    assert.ok(recipe.blocks.main.some((st) => st.meta?.recordedValue === '1234567890'), '엑셀 연결 때 녹화 값이 남아 있어야 관찰에 쓸 수 있다');

    // 3. 화면에서 대화 (패널) → 가짜 AI 응답 → 적용 → 저장
    const browser = await chromium.launch({ channel: 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${BASE}/#/recipe/${recipe.id}`);
    await page.getByRole('button', { name: '✦ AI 도우미' }).click();
    await page.locator('.ai-input textarea').fill('조회 결과 글자를 읽어서 결과 엑셀에 남겨 줘');
    await page.getByRole('button', { name: '보내기', exact: true }).click();
    await page.waitForSelector('.ai-changes', { timeout: 120000 });
    await page.screenshot({ path: path.join(OUT, 'shots', 'ai-panel.png') });
    console.log('[관찰 결과 앞부분]\n' + seen.snapshot.split('\n').slice(0, 14).join('\n'));
    assert.equal(seen.auth, 'Bearer sk-or-test-key-9876');
    assert.equal(seen.model, 'anthropic/claude-sonnet-5.5');
    assert.match(seen.snapshot, /^실행 성공/, '조회 스텝까지 실행돼야 한다');
    assert.match(seen.snapshot, /# 프레임 f1/, 'iframe 요소도 관찰돼야 한다');
    assert.match(seen.snapshot, /button "선택" row="가"/, '표 안 요소는 열·행 정보를 함께 준다');
    const changesText = await page.locator('.ai-changes').innerText();
    assert.match(changesText, /제안된 변경 2건/);
    await page.getByRole('button', { name: '적용', exact: true }).click();
    await page.getByRole('button', { name: '저장 *' }).click();
    await page.waitForSelector('text=저장했습니다');
    await browser.close();
    assert.deepEqual(errors, []);

    const saved = (await api('GET', `/api/recipes/${recipe.id}`)).recipe;
    const ex = saved.blocks.main.find((st) => st.type === 'extract');
    assert.ok(ex?.target?.candidates?.length, 'AI 가 참조 번호로 만든 타겟이 있어야 한다');
    console.log('[AI 가 만든 타겟 후보]', ex.target.candidates.map((c) => `${c.score} ${c.kind}:${typeof c.value === 'string' ? c.value : c.value.text}`).join(' | '));

    // 4. 적용한 레시피를 실제로 실행: 값이 읽혀야 한다
    const up = await api('POST', `/api/uploads?name=input.xlsx`, await fs.readFile(path.join(OUT, 'input.xlsx')), true);
    const { runId } = await api('POST', '/api/runs', { recipeId: recipe.id, uploadId: up.id, options: { headless: true } });
    for (let i = 0; i < 240; i += 1) {
      const st = await api('GET', '/api/state');
      if (['done', 'failed', 'stopped'].includes(st.run?.status)) break;
      await sleep(500);
    }
    const report = await api('GET', `/api/runs/${runId}`);
    assert.equal(report.rows[0].values['조회결과'], '조회결과: 다라상사 (0123456789) P2 상세');
    assert.equal(report.rows[2].values['조회결과'], '조회결과: 마바상사 (5558887777) P1 상세');

    // 5. 위험 버튼 보호: "신고하기" 클릭은 관찰 실행에서 누르지 않는다
    const risky = structuredClone(saved);
    const click = risky.blocks.main.find((st) => st.type === 'click');
    click.target.meta.label = '신고하기';
    const obs = new Observer({ recipe: risky, profileDir: path.join(OUT, 'probe-risky'), sampleRow: { 사업자번호: '1', 상호: 'a', 기간: '1기 (예정+확정)' } });
    await obs.open();
    const r = await obs.runTo(click.id);
    await obs.close();
    assert.equal(r.ok, false);
    assert.match(r.error, /되돌릴 수 없는 동작/);

    console.log('\n✅ AI 도우미 점검 통과 (가짜 OpenRouter 요청', seen.requests, '회)');
  } finally {
    server.kill();
    mock.close();
    fixture.close();
  }
}

main().catch((e) => {
  console.error('\n❌ AI 도우미 점검 실패:', e);
  process.exit(1);
});
