// AI 화면 점검 (가짜 OpenRouter — 스트리밍 SSE): 모든 화면의 AI 패널, 화면 이동·서버 재시작 뒤 대화·대기 제안·입력 중 글 유지,
// 스트리밍 글자·라운드, choices 단추, 리포트에서 적용하고 저장, [✦ AI 에게] 맥락·초안, 메모, 대화 지우기,
// 실행 화면 비밀값 저장(두 번째 실행은 칸을 비워도 로그인), 390px 가로 스크롤, 콘솔 오류.
// 실행: node test/ai-ui-check.mjs   (포트 4950–4952, 출력 test/out-ai-ui/ — 끝나면 지운다. KEEP_OUT=1 이면 남긴다)

import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'test', 'out-ai-ui');
const WS = path.join(OUT, 'ws');
const SHOTS = path.join(OUT, 'shots');
const PORT = 4950;
const SITE_PORT = 4951;
const MOCK_PORT = 4952;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const MODEL = 'anthropic/claude-sonnet-5.5';
const PASSWORD = 'Pw-화면점검-5521!';
const NAME = 'AI 화면 점검';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 결과 ----------
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ ok: true, name });
    console.log(`  ✅ ${name}`);
  } catch (e) {
    results.push({ ok: false, name, why: e.message });
    console.log(`  ❌ ${name} — ${String(e.message).split('\n')[0]}`);
  }
}
function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}
/** fn 이 참 값을 돌려줄 때까지 기다린다 (그 값을 돌려준다, 시간이 지나면 null) */
async function until(fn, ms = 15000, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(step);
  }
  return null;
}

// ---------- 시험 사이트: 로그인 · 거래처 찾기 ----------
const html = (title, body) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const LOGIN = html(
  '로그인 (AI 화면 점검)',
  `<h1>로그인</h1>
<p><label for="uid">아이디</label> <input id="uid"></p>
<p><label for="pw">비밀번호</label> <input id="pw" type="password"></p>
<button id="go" type="button">로그인</button>
<p id="msg"></p>
<script>
document.getElementById('go').addEventListener('click', async () => {
  const r = await fetch('/check', { method: 'POST', body: document.getElementById('pw').value });
  const j = await r.json();
  document.getElementById('msg').textContent = j.ok ? '로그인 성공: ' + document.getElementById('uid').value : '로그인 실패';
});
</script>`,
);
function startSite() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, SITE);
    if (req.method === 'POST' && url.pathname === '/check') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: Buffer.concat(chunks).toString('utf8') === PASSWORD }));
    }
    if (url.pathname === '/login') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(LOGIN);
    }
    if (url.pathname === '/find') {
      const name = url.searchParams.get('name') ?? '';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html('거래처 찾기', `<h1>거래처 찾기</h1><p id="r">${name === '없는상사' ? '결과 없음' : `찾음: ${name}`}</p>`));
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  return new Promise((r) => server.listen(SITE_PORT, '127.0.0.1', () => r(server)));
}

// ---------- 가짜 OpenRouter (스트리밍 SSE) ----------
const mock = { log: [] };
const textOf = (c) => (Array.isArray(c) ? c.map((p) => p?.text ?? '').join('\n') : String(c ?? ''));
let callNo = 0;
const call = (name, args) => ({ id: `call_${(callNo += 1)}_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const say = (content, o = {}) => ({ message: { role: 'assistant', content }, ...o });
const use = (content, ...calls) => ({ message: { role: 'assistant', content, tool_calls: calls } });
const CHOICES = [
  { label: '그 행은 실패로 남기고 다음 행', message: '[T:picked] 결과가 없으면 그 행을 실패로 남기고 다음 행으로 가 줘' },
  { label: '뒤 스텝만 건너뛰기', message: '[T:picked] 결과가 없으면 뒤 스텝만 건너뛰어 줘' },
];

/** 대본: 마지막 [요청] 의 [T:태그] 와 그 뒤 도구 결과 수(k). parts 는 스트리밍 조각, pause 는 첫 조각 뒤 쉬는 시간 */
function script(tag, k) {
  switch (tag) {
    case 'hello':
      return say('스트리밍 첫 조각입니다. 이어지는 둘째 조각, 마지막 조각.', { parts: ['스트리밍 첫 조각입니다. ', '이어지는 둘째 조각, ', '마지막 조각.'], pause: 1800 });
    case 'edit':
      if (k === 0) return { ...use('이름을 바꾸겠습니다.', call('set_recipe_fields', { name: `${NAME} (고침)` })), parts: ['이름을 ', '바꾸겠습니다.'] };
      return say('레시피 이름을 바꿨습니다. [적용]을 눌러 반영하세요.', { parts: ['레시피 이름을 ', '바꿨습니다. [적용]을 눌러 반영하세요.'], pause: 1800 });
    case 'choice':
      return use(null, call('ask_choice', { question: '결과가 없을 때 어떻게 할까요?', options: CHOICES }));
    case 'picked':
      return k === 0 ? use(null, call('set_recipe_fields', { onRowError: 'skip' })) : say('행 실패 처리를 "기록하고 다음 행" 으로 정했습니다.');
    case 'edit2':
      return k === 0 ? use(null, call('insert_steps', { afterStepId: '#7', steps: [{ type: 'sleep', ms: 300 }] })) : say('끝에 0.3초 쉬기를 넣었습니다.');
    case 'edit3':
      return k === 0 ? use(null, call('set_recipe_fields', { name: '버릴 이름' })) : say('이름을 바꿨습니다.');
    case 'ctx':
      return say('맥락을 받았습니다.');
    default:
      return say('알겠습니다.');
  }
}

function writeSse(res, model, { message, parts, pause = 0 }, usage) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  res.write(': OPENROUTER PROCESSING\n\n');
  const chunk = (delta, extra = {}) => `data: ${JSON.stringify({ id: 'gen-mock', model, choices: [{ index: 0, delta, ...extra }] })}\n\n`;
  const out = [];
  const pieces = message.content ? parts ?? message.content.match(/[\s\S]{1,6}/g) : [];
  for (const p of pieces) out.push(chunk({ content: p }));
  (message.tool_calls ?? []).forEach((tc, i) => {
    out.push(chunk({ tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] }));
    out.push(chunk({ tool_calls: [{ index: i, function: { arguments: tc.function.arguments } }] }));
  });
  out.push(`data: ${JSON.stringify({ id: 'gen-mock', model, choices: [{ index: 0, delta: {}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage })}\n\n`, 'data: [DONE]\n\n');
  let i = 0;
  const next = () => {
    if (i >= out.length) return res.end();
    res.write(out[i]);
    i += 1;
    setTimeout(next, i === 1 && pause ? pause : 40);
  };
  next();
}

function startMock() {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const msgs = body.messages ?? [];
    let at = -1;
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i].role === 'user' && textOf(msgs[i].content).includes('[요청]')) {
        at = i;
        break;
      }
    }
    const user = at >= 0 ? textOf(msgs[at].content) : '';
    const tools = msgs.slice(at + 1).filter((m) => m.role === 'tool');
    const request = user.slice(user.lastIndexOf('[요청]'));
    const tag = /\[T:([\w-]+)\]/.exec(request)?.[1] ?? '';
    mock.log.push({ tag, k: tools.length, user, request, stream: !!body.stream });
    const plan = script(tag, tools.length);
    const usage = { prompt_tokens: 1200, completion_tokens: 40, cost: 0.003 };
    if (body.stream) return writeSse(res, body.model, plan, usage);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: body.model, choices: [{ message: plan.message }], usage }));
  });
  return new Promise((r) => server.listen(MOCK_PORT, '127.0.0.1', () => r(server)));
}
const lastLog = (tag) => mock.log.filter((e) => e.tag === tag && e.k === 0).at(-1);

// ---------- 앱 서버 ----------
let server = null;
let serverLog = '';
async function startServer() {
  server = spawn(process.execPath, ['src/server.js', '--port', String(PORT), '--workspace', WS], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OPENROUTER_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/api/v1`, OPENROUTER_API_KEY: '' },
  });
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
  for (let i = 0; i < 100; i += 1) {
    try {
      await fetch(`${BASE}/api/state`);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error('서버가 뜨지 않았습니다.');
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const p = server;
  p.kill();
  await once(p, 'exit').catch(() => {});
}
async function api(method, url, body, raw) {
  const res = await fetch(BASE + url, { method, headers: body && !raw ? { 'content-type': 'application/json' } : undefined, body: raw ? body : body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data?.error ?? ''}`);
  return data;
}
async function waitRunDone(prev) {
  const st = await until(async () => {
    const s = await api('GET', '/api/state');
    return s.run && s.run.runId !== prev && ['done', 'failed', 'stopped'].includes(s.run.status) ? s.run : null;
  }, 120000, 500);
  expect(st, '실행이 끝나지 않았습니다');
  return api('GET', `/api/runs/${st.runId}`);
}

// ---------- 레시피 ----------
const T = (css, meta = {}) => ({ candidates: [{ kind: 'css', value: css, score: 90 }], meta });
function recipe() {
  return {
    schemaVersion: 1,
    name: NAME,
    startUrl: `${SITE}/login`,
    entryBlock: 'main',
    loop: { onRowError: 'stop' },
    variables: [
      { id: '비밀번호', name: '비밀번호', source: { kind: 'prompt', secret: true } },
      { id: '상호', name: '상호', source: { kind: 'excel', column: '상호' } },
    ],
    blocks: {
      main: [
        { id: 's1', type: 'navigate', url: `${SITE}/login` },
        { id: 's2', type: 'input', target: T('#uid', { tag: 'input', label: '아이디' }), value: 'tester' },
        { id: 's3', type: 'input', target: T('#pw', { tag: 'input', type: 'password', label: '비밀번호' }), value: '{{비밀번호}}' },
        { id: 's4', type: 'click', target: T('#go', { tag: 'button', text: '로그인' }) },
        { id: 's5', type: 'wait', condition: { kind: 'textVisible', text: '로그인 성공' }, timeoutMs: 5000 },
        { id: 's6', type: 'navigate', url: `${SITE}/find?name={{상호}}` },
        { id: 's7', type: 'assert', condition: { kind: 'textVisible', text: '찾음' }, message: '찾는 거래처가 없습니다' },
      ],
    },
  };
}

// =====================================================================
async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(SHOTS, { recursive: true });
  const csv = path.join(OUT, '거래처.csv');
  await fs.writeFile(csv, '상호\n가나상사\n없는상사\n', 'utf8');
  const site = await startSite();
  const mockServer = await startMock();
  await startServer();
  let browser = null;
  const errors = [];
  try {
    await api('PUT', '/api/settings', { openrouter: { apiKey: 'sk-or-ui-test-1234', model: MODEL } });
    // 실행 중단 설정으로 시작 (AI 가 skip 으로 바꾼다)
    const { recipe: saved } = await api('POST', '/api/recipes', recipe());
    const id = saved.id;
    // 실행이 2행에서 멈추지 않게 실행 옵션은 화면에서 "기록하고 다음 행" 을 고른다(기본값)

    browser = await chromium.launch({ channel: 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    let dialogMode = 'accept'; // 고침 2회차: 어긋난 상태의 확인창은 [취소] 로 시험한다
    const dialogs = [];
    const watch = (p) => {
      p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      p.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
      p.on('dialog', (d) => {
        dialogs.push(d.message());
        return dialogMode === 'dismiss' ? d.dismiss() : d.accept();
      });
    };
    watch(page);
    const panel = page.locator('.ai-panel');
    const input = page.locator('.ai-input textarea');
    const sendBtn = page.locator('.ai-input button.primary');
    const go = async (hash, sel) => {
      await page.evaluate((h) => (location.hash = h), hash);
      await page.waitForSelector(sel);
      await sleep(250);
    };
    const closePanel = async () => {
      if (await panel.isVisible()) await panel.locator('.ai-head button[title="닫기"]').click();
    };
    const turnDone = () => until(async () => (await sendBtn.innerText()) === '보내기' && (await page.locator('.ai-msg.streaming').count()) === 0, 30000);
    const sendText = async (text) => {
      await input.fill(text);
      await sendBtn.click();
      expect(await turnDone(), `답변이 끝나지 않았습니다: ${text}`);
      await sleep(200);
    };

    // =================================================================
    console.log('\n[1] 실행 화면 비밀값');
    await page.goto(`${BASE}/#/run?recipe=${id}`);
    await page.waitForSelector('text=2. 엑셀 데이터');
    const saveBox = page.getByRole('checkbox', { name: /이 PC 에 저장/ });
    await check('비밀값 칸: 입력 칸 + "이 PC 에 저장" 체크(기본 꺼짐)', async () => {
      expect(await page.locator('.secret-field input[type=password]').isVisible(), '비밀번호 칸이 없습니다');
      expect((await saveBox.count()) === 1 && !(await saveBox.isChecked()), '저장 체크가 없거나 켜져 있습니다');
      expect((await page.locator('.badge.bad').count()) === 0, '.badge.bad 가 생겼습니다');
    });
    const startRun = async ({ password } = {}) => {
      await page.locator('input[type=file][accept=".xlsx,.csv"]').setInputFiles(csv);
      await page.locator('main').getByText('· 2행').waitFor();
      if (password) {
        await page.locator('.secret-field input[type=password]').fill(password);
        await saveBox.check();
      }
      await page.getByRole('checkbox', { name: /브라우저 창 숨기고/ }).check();
      await page.getByRole('button', { name: '▶ 실행 시작' }).click();
    };
    await startRun({ password: PASSWORD });
    await check('첫 실행: 저장 체크 → "●●●● 저장됨 · 바꾸기 · 지우기"', async () => {
      await page.waitForSelector('text=●●●● 저장됨', { timeout: 15000 });
      const row = await page.locator('.secret-saved-row').innerText();
      expect(/●●●● 저장됨\s*·\s*바꾸기\s*·\s*지우기/.test(row), row);
      const s = await api('GET', `/api/recipes/${id}/secrets`);
      expect(s[0]?.saved === true, JSON.stringify(s));
    });
    const report1 = await waitRunDone();
    const run1 = report1.runId;
    await check('첫 실행: 1행 로그인 성공, 2행 실패 / secrets.json 에 평문 없음', async () => {
      expect(report1.rows[0]?.status === 'ok' && report1.rows[1]?.status === 'failed', JSON.stringify(report1.rows.map((r) => [r.status, r.error])));
      const text = await fs.readFile(path.join(WS, 'secrets.json'), 'utf8');
      expect(!text.includes(PASSWORD), 'secrets.json 에 비밀값 평문');
      expect(!(await fs.readFile(path.join(WS, 'recipes', `${id}.json`), 'utf8')).includes(PASSWORD), '레시피 파일에 비밀값');
    });
    await page.reload();
    await page.waitForSelector('text=2. 엑셀 데이터');
    await check('두 번째 실행: 비밀값 칸을 비워도 저장된 값으로 로그인', async () => {
      await page.waitForSelector('text=●●●● 저장됨');
      expect((await page.locator('.secret-field input[type=password]').count()) === 0, '저장됐는데 입력 칸이 보입니다');
      await startRun();
      const r = await waitRunDone(run1);
      expect(r.runId !== run1, '새 실행이 아닙니다');
      expect(r.rows[0]?.status === 'ok', `1행: ${r.rows[0]?.error}`);
    });
    await page.screenshot({ path: path.join(SHOTS, 'run-secret-saved.png'), fullPage: true });
    await check('[바꾸기] → 새 값 칸(저장 체크 켜짐) · [취소] 하면 저장된 값으로 돌아옴', async () => {
      await page.locator('.secret-saved-row').getByRole('button', { name: '바꾸기' }).click();
      await page.waitForSelector('.secret-field input[type=password]');
      expect(await saveBox.isChecked(), '바꿀 때 저장 체크가 꺼져 있습니다');
      await page.locator('.secret-field').getByRole('button', { name: /취소/ }).click();
      await page.waitForSelector('text=●●●● 저장됨');
    });
    await check('비밀값 지우기 → 입력 칸으로 돌아오고 저장소에서도 지움', async () => {
      await page.locator('.secret-saved-row').getByRole('button', { name: '지우기' }).click();
      await page.waitForSelector('.secret-field input[type=password]');
      const s = await api('GET', `/api/recipes/${id}/secrets`);
      expect(s[0]?.saved === false, JSON.stringify(s));
    });

    // =================================================================
    console.log('\n[2] 모든 화면에서 AI 패널 열기');
    const views = [
      ['레시피 목록', '#/recipes', 'table', 'pick'],
      ['녹화', '#/record', '.card', 'pick'],
      ['실행', `#/run?recipe=${id}`, 'text=2. 엑셀 데이터', 'fixed'],
      ['리포트 목록', '#/reports', 'table', 'pick'],
      ['리포트', `#/report/${run1}`, '.statline', 'fixed'],
      ['허브', '#/hub', '.page-head', 'pick'],
      ['설정', '#/settings', '.browser-opt', 'pick'],
      ['편집기', `#/recipe/${id}`, '.step-head', 'fixed'],
    ];
    for (const [label, hash, sel, kind] of views) {
      await check(`패널 열기: ${label} (${kind === 'fixed' ? '그 레시피 대화' : '레시피 고르기'})`, async () => {
        await closePanel();
        await go(hash, sel);
        await page.locator('.ai-top').click();
        await panel.waitFor({ state: 'visible', timeout: 5000 });
        if (kind === 'fixed') {
          const name = await until(async () => (await page.locator('.ai-scope .ai-recipe').innerText()) || null, 5000);
          expect(name === NAME, `레시피 이름: ${name}`);
        } else {
          const v = await until(async () => (await page.locator('.ai-scope select').inputValue()) || null, 5000);
          expect(v === id, `고른 레시피: ${v}`);
        }
      });
    }
    await check('편집기 머리의 "✦ AI 도우미" 단추로 닫고 열기', async () => {
      await page.getByRole('button', { name: '✦ AI 도우미' }).click();
      expect(!(await panel.isVisible()), '닫히지 않았습니다');
      await page.getByRole('button', { name: '✦ AI 도우미' }).click();
      expect(await panel.isVisible(), '열리지 않았습니다');
    });

    // =================================================================
    console.log('\n[3] 스트리밍 · 진행 줄 · 라운드');
    await input.fill('[T:hello] 이 레시피가 하는 일을 알려 줘');
    await sendBtn.click();
    let progressSeen = '';
    await check('스트리밍: 답이 끝나기 전에 첫 조각이 말풍선에 보인다', async () => {
      const partial = await until(async () => {
        const t = await page.locator('.ai-msg.streaming .ai-text').innerText();
        return t.includes('스트리밍 첫 조각') ? t : null;
      }, 10000, 50);
      expect(partial, '첫 조각이 보이지 않았습니다');
      expect(!partial.includes('마지막 조각'), `벌써 다 보였습니다: ${partial}`);
      expect((await sendBtn.innerText()) === '작업 중…', '보내기 단추가 작업 중이 아닙니다');
      progressSeen = await page.locator('.ai-progress').innerText();
    });
    await check('진행 줄: 턴 동안 "AI가 생각하는 중…"', async () => expect(/AI가 생각하는 중/.test(progressSeen), progressSeen));
    await check('답변 완료: 마지막 조각까지 · 이번 요청 비용 · 누적 비용', async () => {
      expect(await turnDone(), '끝나지 않았습니다');
      const last = await page.locator('.ai-msg.assistant').last().innerText();
      expect(last.includes('마지막 조각.') && last.includes('이번 요청 $0.0030'), last);
      expect((await page.locator('.ai-scope').innerText()).includes('누적 $0.0030'), await page.locator('.ai-scope').innerText());
      expect(mock.log.some((e) => e.tag === 'hello' && e.stream), '스트리밍 요청이 아닙니다');
    });
    await input.fill('[T:edit] 레시피 이름을 바꿔 줘');
    await sendBtn.click();
    await check('라운드가 바뀌면 새 말풍선 (도구 앞 설명은 따로)', async () => {
      const ok = await until(async () => {
        const interim = await page.locator('.ai-msg.interim').innerText();
        const cur = await page.locator('.ai-msg.streaming .ai-text').innerText();
        return interim.includes('이름을 바꾸겠습니다') && cur.includes('레시피 이름을') && !cur.includes('바꾸겠습니다');
      }, 10000, 50);
      expect(ok, '라운드별 말풍선이 보이지 않았습니다');
    });
    await check('대기 제안 카드 (편집기): "제안된 변경 1건" · [적용] · [버리기]', async () => {
      expect(await turnDone(), '끝나지 않았습니다');
      await page.waitForSelector('.ai-changes');
      expect((await page.locator('.ai-changes').innerText()).includes('제안된 변경 1건'), await page.locator('.ai-changes').innerText());
      expect(await panel.getByRole('button', { name: '적용', exact: true }).isVisible(), '[적용] 없음');
      expect(await panel.getByRole('button', { name: '버리기' }).isVisible(), '[버리기] 없음');
      expect((await panel.getByRole('button', { name: '적용하고 저장' }).count()) === 0, '편집기에서 적용하고 저장이 보입니다');
    });
    await page.screenshot({ path: path.join(SHOTS, 'editor-pending.png') });

    // =================================================================
    console.log('\n[4] 화면 이동 · 서버 재시작 뒤 유지');
    await check('답하는 도중 화면을 옮겨도 스트리밍이 이어지고 답이 남는다', async () => {
      await input.fill('[T:hello] 한 번 더 알려 줘');
      await sendBtn.click();
      expect(await until(async () => (await page.locator('.ai-msg.streaming .ai-text').innerText()).includes('스트리밍 첫 조각'), 10000, 50), '첫 조각이 보이지 않았습니다');
      await go(`#/run?recipe=${id}`, 'text=2. 엑셀 데이터');
      expect((await sendBtn.innerText()) === '작업 중…', '화면을 옮기자 진행 표시가 사라졌습니다');
      expect(await turnDone(), '끝나지 않았습니다');
      const last = await page.locator('.ai-msg.assistant').last().innerText();
      expect(last.includes('마지막 조각.'), last);
      await go(`#/recipe/${id}`, '.step-head');
    });
    const DRAFT = '[T:ctx] 아직 보내지 않은 글';
    await input.fill(DRAFT);
    const kept = async (where, applyName) => {
      expect(await panel.isVisible(), `${where}: 패널이 닫혔습니다`);
      expect((await input.inputValue()) === DRAFT, `${where}: 입력 중 글 = ${await input.inputValue()}`);
      const card = await until(async () => (await page.locator('.ai-changes').innerText()) || null, 5000);
      expect(card?.includes('제안된 변경 1건'), `${where}: 대기 제안 ${card}`);
      expect(await panel.getByRole('button', { name: applyName, exact: true }).isVisible(), `${where}: [${applyName}] 없음`);
      expect((await page.locator('.ai-msg.user').allInnerTexts()).some((t) => t.includes('[T:hello]')), `${where}: 대화가 없습니다`);
    };
    await check('편집기 → 실행: 패널 열림·입력 중 글·대기 제안 유지 ([적용하고 저장])', async () => {
      await page.locator('#nav a[data-nav=run]').click();
      await page.waitForSelector('text=2. 엑셀 데이터');
      await kept('실행', '적용하고 저장');
    });
    await check('상단 단추에 대기 제안 표시', async () => expect((await page.locator('.ai-top .ai-dot').count()) === 1, '점이 없습니다'));
    await check('실행 → 리포트: 유지', async () => {
      await go(`#/report/${run1}`, '.statline');
      await kept('리포트', '적용하고 저장');
    });
    await check('리포트 → 편집기: 유지 ([적용])', async () => {
      await go(`#/recipe/${id}`, '.step-head');
      await kept('편집기', '적용');
    });
    await check('서버를 다시 켜고 새로 고쳐도 대화·대기 제안·입력 중 글 유지', async () => {
      await page.goto('about:blank'); // 서버가 꺼진 동안 화면이 다시 연결하며 오류를 남기지 않게
      await stopServer();
      await startServer();
      await page.goto(`${BASE}/#/recipe/${id}`);
      await page.waitForSelector('.step-head');
      await panel.waitFor({ state: 'visible', timeout: 5000 });
      await kept('재시작 뒤', '적용');
    });
    await page.screenshot({ path: path.join(SHOTS, 'after-restart.png') });

    // =================================================================
    console.log('\n[4b] 고침 1회차: 메뉴로 실행 화면에 가도 같은 대화 · 바뀌면 안내 · 쉬운 표기 (R1-01·07·08·09·14)');
    const other = (await api('POST', '/api/recipes', { schemaVersion: 1, name: 'AI 화면 점검 둘째', startUrl: `${SITE}/login.html`, entryBlock: 'main', variables: [], blocks: { main: [{ id: 's1', type: 'navigate', url: `${SITE}/login.html` }] } })).recipe.id;
    await check('R1-01 위 메뉴 [실행] 링크가 지금 대화 중인 레시피를 고른 채 열린다 (마지막 실행 레시피가 달라도)', async () => {
      await page.evaluate((x) => localStorage.setItem('rpa:lastRecipe', x), other); // 다른 레시피를 마지막에 실행한 것처럼
      await go('#/recipes', 'table');
      const href = await page.locator('#nav a[data-nav=run]').getAttribute('href');
      expect(href === `#/run?recipe=${id}`, `메뉴 링크 ${href}`);
      await go('#/run', 'text=2. 엑셀 데이터'); // 옛 링크(레시피 없음)로 와도
      expect((await page.locator('main select').first().inputValue()) === id, `실행 화면이 고른 레시피: ${await page.locator('main select').first().inputValue()}`);
      expect((await page.locator('.ai-scope .ai-recipe').innerText()) === NAME, await page.locator('.ai-scope .ai-recipe').innerText());
      await kept('실행 (메뉴, 레시피 없는 주소)', '적용하고 저장');
      expect((await page.locator('.ai-switched .notice').count()) === 0, '바뀌지 않았는데 안내가 보입니다');
    });
    await check('R1-01 실행 화면에서 다른 레시피를 고르면 AI 패널에 "대화로 바뀌었습니다" 안내 → [돌아가기] 로 원래 레시피·대화', async () => {
      await page.locator('main select').first().selectOption(other);
      const note = page.locator('.ai-switched .notice');
      await note.waitFor({ timeout: 5000 });
      const t = await note.innerText();
      expect(t.includes('AI 화면 점검 둘째') && t.includes(`"${NAME}" 대화로 돌아가기`), t);
      expect((await page.locator('.ai-scope .ai-recipe').innerText()) === 'AI 화면 점검 둘째', '패널이 바뀌지 않았습니다');
      await note.getByRole('button', { name: `"${NAME}" 대화로 돌아가기` }).click();
      expect(await until(async () => (await page.locator('main select').first().inputValue()) === id, 5000), '실행 화면 레시피가 돌아오지 않았습니다');
      await kept('돌아간 뒤', '적용하고 저장');
      expect((await page.locator('.ai-switched .notice').count()) === 0, '안내가 남았습니다');
    });
    await check('R1-14 끝난 지난 실행은 한 줄 요약(리포트 보기 · 기록 펼치기)으로 접혀 설정이 첫 화면에 보인다', async () => {
      // 서버를 다시 켠 뒤라 지난 실행이 없다 → 다른 레시피를 한 번 실행해 둔다
      const { runId } = await api('POST', '/api/runs', { recipeId: other, options: { headless: true } });
      expect(await until(async () => ['done', 'failed'].includes((await api('GET', '/api/state')).run?.status) && (await api('GET', '/api/state')).run.runId === runId, 60000, 300), '실행이 끝나지 않았습니다');
      await go('#/recipes', 'table');
      await go(`#/run?recipe=${id}`, 'text=2. 엑셀 데이터');
      const last = page.locator('.last-run');
      await last.waitFor({ timeout: 5000 });
      const t = await last.innerText();
      expect(t.includes('다른 레시피의 지난 실행') && t.includes('AI 화면 점검 둘째') && t.includes('리포트 보기') && (await page.locator('.logbox').count()) === 0, t);
      const h2 = await page.getByText('1. 레시피').boundingBox();
      expect(h2 && h2.y < 260, `설정 위치 ${JSON.stringify(h2)}`);
      await last.getByRole('button', { name: '기록 펼치기' }).click();
      expect(await page.locator('.logbox').isVisible(), '기록이 펼쳐지지 않았습니다');
    });
    await check('R1-08 위쪽 단추 이름 "✦ AI 대화" + 대기 제안 "제안 1" (편집기 "✦ AI 도우미" 와 겹치지 않음)', async () => {
      const t = (await page.locator('.ai-top').innerText()).replace(/\s+/g, ' ');
      expect(t.includes('✦ AI 대화') && t.includes('제안 1'), t);
      await go(`#/recipe/${id}`, '.step-head');
      expect((await page.getByRole('button', { name: '✦ AI 도우미' }).count()) === 1, '"✦ AI 도우미" 단추가 하나가 아닙니다');
    });
    await check('R1-09 제안 카드·말풍선·맥락 줄에 내부 표기 없음 (s9·(main)·모델 id·실행 id)', async () => {
      const items = await page.locator('.ai-changes li').allInnerTexts();
      expect(items.length && items.every((x) => !/\bs\d+\b|\(main\)|\{"/.test(x)), items.join(' | '));
      const meta = await page.locator('.ai-msg.assistant .muted.small').allInnerTexts();
      expect(meta.length && meta.every((x) => !x.includes('anthropic/')), meta.join(' | '));
      await go(`#/report/${run1}`, '.statline');
      const ctx = await page.locator('.ai-ctx').innerText();
      expect(/\d+\/\d+ \d\d:\d\d 실행/.test(ctx) && !ctx.includes(run1), ctx);
    });
    await check('R1-09 변경 문구: "추가 #8 s9 (main): …" → "#8 추가: …", 몸통 블록은 "(행마다 안)", 남은 s 번호는 화면 번호로', async () => {
      const out = await page.evaluate(async () => {
        const { changeLine } = await import('/ai-panel.js');
        const nums = new Map([['s4', '#3.1']]);
        return [changeLine('추가 #8 s9 (main): 화면에 "조회 완료" 글자가 보일 때까지 기다리기 (최대 15초)', null), changeLine('수정 #3.1 s4: "금액"의 글자 읽어 {{금액}}에 저장 (대상: "12,000" 표 칸 → "금액" 표 칸 · 항목 안)', null), changeLine('추가 #2.1 s7 (행마다): 0.3초 쉬기', null), changeLine('이동 #3 s4: #2 뒤로', null), changeLine('묶기 s9: 남은 s4 번호', nums)];
      });
      expect(out[0] === '#8 추가: 화면에 "조회 완료" 글자가 보일 때까지 기다리기 (최대 15초)' && out[1].startsWith('#3.1 수정: ') && out[1].includes('대상: "12,000" 표 칸 → "금액" 표 칸 · 항목 안') && out[2] === '#2.1 추가 (행마다 안): 0.3초 쉬기' && out[3] === '#3 이동: #2 뒤로' && out[4] === '묶기: 남은 #3.1 번호', out.join(' | '));
    });
    await check('R1-07 리포트 머리: 레시피 이름이 편집기 링크, [편집]·[▶ 다시 실행]', async () => {
      expect((await page.locator('.page-head h1 a').getAttribute('href')) === `#/recipe/${id}`, '이름 링크 없음');
      expect((await page.locator('.page-head a', { hasText: '▶ 다시 실행' }).getAttribute('href')) === `#/run?recipe=${id}`, '다시 실행 링크 없음');
      await page.locator('.page-head a', { hasText: '편집' }).first().click();
      await page.waitForSelector('.step-head');
      await kept('리포트 → [편집]', '적용');
    });

    // =================================================================
    console.log('\n[4c] 고침 2회차: 편집기 레시피와 AI 대화가 어긋나지 않게 (R2-01) · 실행·리포트의 "✦ AI 도우미" (R2-08)');
    const OTHER = 'AI 화면 점검 둘째';
    const otherBefore = JSON.stringify((await api('GET', `/api/recipes/${other}`)).recipe.blocks);
    await check('R2-01 편집기 A(대화 중) → 편집기 B 를 열면 "대화로 바뀌었습니다" 안내 없이 패널이 B 로 맞는다', async () => {
      await go(`#/recipe/${id}`, '.step-head');
      expect(await panel.isVisible(), '패널이 닫혀 있습니다');
      await go(`#/recipe/${other}`, '.step-head');
      expect(await until(async () => (await page.locator('.ai-scope .ai-recipe').innerText()) === OTHER, 5000), `패널 레시피: ${await page.locator('.ai-scope .ai-recipe').innerText()}`);
      expect((await page.locator('.ai-switched .notice').count()) === 0, `안내가 떴습니다: ${await page.locator('.ai-switched').innerText()}`);
      expect((await page.locator('.ai-mismatch .notice').count()) === 0, '어긋남 경고가 떴습니다');
    });
    await check('R2-01 리포트에서 연 레시피도 안내 없이 패널이 그 레시피 (리포트 → 편집기 A 로 와도 안내 없음)', async () => {
      await go(`#/report/${run1}`, '.statline');
      expect(await until(async () => (await page.locator('.ai-scope .ai-recipe').innerText()) === NAME, 5000), '패널이 리포트의 레시피가 아닙니다');
      expect((await page.locator('.ai-switched .notice').count()) === 0, '리포트에서 안내가 떴습니다');
      await go(`#/recipe/${other}`, '.step-head');
      expect((await page.locator('.ai-switched .notice').count()) === 0, '편집기에서 안내가 떴습니다');
    });
    await check('R2-01 어긋난 상태(편집기 B · 대화 A): 경고 줄, [적용하고 저장]·[보내기] 는 한 번 묻고, 취소하면 B 도 A 도 그대로', async () => {
      // 다른 화면 코드가 대화를 바꾼 경우를 흉내 낸다 (편집기는 B 그대로)
      await page.evaluate(async ([rid, nm]) => (await import('/ai-panel.js')).setAiRecipe(rid, { name: nm }), [id, NAME]);
      const warn = page.locator('.ai-mismatch .notice');
      await warn.waitFor({ timeout: 5000 });
      const t = await warn.innerText();
      expect(t.includes(`편집기에 열린 것은 "${OTHER}"`) && t.includes(`"${NAME}" 레시피를 고칩니다`), t);
      const applyBtn = panel.getByRole('button', { name: '적용하고 저장' });
      expect(await applyBtn.isVisible(), '어긋난 상태에서 [적용하고 저장] 이 없습니다 (편집기 [적용] 이면 B 가 바뀐다)');
      expect((await panel.getByRole('button', { name: '적용', exact: true }).count()) === 0, '편집기 [적용] 단추가 보입니다');
      dialogMode = 'dismiss';
      const n0 = dialogs.length;
      await applyBtn.click();
      await sleep(400);
      expect(dialogs.length === n0 + 1 && dialogs.at(-1).includes(`편집기에 열린 "${OTHER}" 가 아니라 "${NAME}"`), dialogs.at(-1) ?? '확인창 없음');
      const sent0 = mock.log.length;
      await input.fill('[T:ctx] 어긋난 채 보내기');
      await sendBtn.click();
      await sleep(400);
      dialogMode = 'accept';
      expect(dialogs.length === n0 + 2 && dialogs.at(-1).includes('그래도') && mock.log.length === sent0, `보내기 확인 ${dialogs.at(-1)} · 요청 ${mock.log.length - sent0}건`);
      expect((await input.inputValue()) === '[T:ctx] 어긋난 채 보내기', '취소했는데 입력 글이 사라졌습니다');
      await input.fill(DRAFT);
      const th = await api('GET', `/api/agent/thread?recipeId=${id}`);
      expect(th.pending?.changes?.length === 1, 'A 의 대기 제안이 사라졌습니다 (적용됨)');
      expect(JSON.stringify((await api('GET', `/api/recipes/${other}`)).recipe.blocks) === otherBefore && (await page.locator('.page-head button.primary').innerText()) === '저장', '편집기 B 가 바뀌었습니다');
    });
    await check('R2-01 경고의 [편집기의 "B" 대화로] → 패널이 편집기 레시피로, 경고 사라짐', async () => {
      await page.locator('.ai-mismatch').getByRole('button', { name: `편집기의 "${OTHER}" 대화로` }).click();
      expect(await until(async () => (await page.locator('.ai-scope .ai-recipe').innerText()) === OTHER, 5000), '패널이 B 로 바뀌지 않았습니다');
      expect((await page.locator('.ai-mismatch .notice').count()) === 0, '경고가 남았습니다');
      await go(`#/recipe/${id}`, '.step-head');
      await input.fill(DRAFT);
      await kept('편집기 A 로 돌아옴', '적용');
    });
    await check('R2-08 실행·리포트 머리에도 "✦ AI 도우미" (편집기에서는 그 이름의 단추가 하나뿐)', async () => {
      expect((await page.getByRole('button', { name: '✦ AI 도우미' }).count()) === 1, '편집기에서 "✦ AI 도우미" 가 하나가 아닙니다');
      for (const [hash, sel] of [[`#/run?recipe=${id}`, 'text=2. 엑셀 데이터'], [`#/report/${run1}`, '.statline']]) {
        await go(hash, sel);
        const b = page.locator('main .page-head').getByRole('button', { name: '✦ AI 도우미' });
        expect((await b.count()) === 1, `${hash}: 단추 ${await b.count()}개`);
        await b.click();
        expect(!(await panel.isVisible()), `${hash}: 닫히지 않았습니다`);
        await b.click();
        expect(await panel.isVisible(), `${hash}: 열리지 않았습니다`);
      }
      await go(`#/recipe/${id}`, '.step-head');
      await kept('편집기', '적용');
    });

    // =================================================================
    console.log('\n[5] choices · 이어서 고치기 · 리포트에서 적용하고 저장');
    await sendText('[T:choice] 결과가 없을 때는 어떻게 할까?');
    await check('choices 단추 2개 → 누르면 그 message 를 보낸다', async () => {
      const btns = page.locator('.ai-choices button');
      expect((await btns.count()) === 2, `단추 ${await btns.count()}개`);
      expect((await btns.first().innerText()) === CHOICES[0].label, await btns.first().innerText());
      await btns.first().click();
      expect(await turnDone(), '끝나지 않았습니다');
      const users = await page.locator('.ai-msg.user').allInnerTexts();
      expect(users.at(-1).includes(CHOICES[0].message), users.at(-1));
      expect(lastLog('picked')?.request.includes(CHOICES[0].message), '가짜 모델이 고른 문장을 받지 못했습니다');
      expect((await page.locator('.ai-choices button').count()) === 0, '지난 선택지가 남았습니다');
    });
    await check('이어서 고치면 제안이 합쳐진다 ("제안된 변경 2건", 앞 제안은 합쳐짐 표시)', async () => {
      expect((await page.locator('.ai-changes').count()) === 1, `카드 ${await page.locator('.ai-changes').count()}개`);
      expect((await page.locator('.ai-changes').innerText()).includes('제안된 변경 2건'), await page.locator('.ai-changes').innerText());
      expect((await page.locator('.ai-change-past').allInnerTexts()).some((t) => t.includes('다음 제안에 합쳐짐')), '합쳐짐 표시 없음');
    });
    await check('리포트에서 [적용하고 저장] → 확인 → 레시피 파일에 저장', async () => {
      await go(`#/report/${run1}`, '.statline');
      await panel.getByRole('button', { name: '적용하고 저장' }).click();
      await page.waitForSelector('text=AI 제안을 적용하고 저장했습니다');
      const r = (await api('GET', `/api/recipes/${id}`)).recipe;
      expect(r.name === `${NAME} (고침)` && r.loop?.onRowError === 'skip', `${r.name} / ${r.loop?.onRowError}`);
      await until(async () => (await page.locator('.ai-changes').count()) === 0, 5000);
      expect((await page.locator('.ai-changes').count()) === 0, '카드가 남았습니다');
      expect((await page.locator('.ai-change-past').allInnerTexts()).some((t) => t.includes('적용함')), '적용함 표시 없음');
      const th = await api('GET', `/api/agent/thread?recipeId=${id}`);
      expect(th.pending === null, '서버에 대기 제안이 남았습니다');
    });
    await page.screenshot({ path: path.join(SHOTS, 'report-applied.png') });

    // =================================================================
    console.log('\n[6] [✦ AI 에게] · 화면 맥락');
    await input.fill('');
    await check('리포트 실패 행 [✦ AI 에게] → 패널에 초안·맥락(2행), 바로 보내지 않음', async () => {
      await closePanel();
      const n = mock.log.length;
      await page.locator('main').getByRole('button', { name: '✦ AI 에게' }).click();
      await panel.waitFor({ state: 'visible' });
      const v = await input.inputValue();
      expect(v.startsWith('2행이 실패했습니다') && v.includes('찾는 거래처가 없습니다'), v);
      const ctx = await page.locator('.ai-ctx').innerText();
      expect(ctx.includes('리포트') && ctx.includes('2행'), ctx);
      await sleep(300);
      expect(mock.log.length === n, '바로 보냈습니다');
    });
    await check('리포트 맥락이 AI 요청에 들어감 (보고 있는 실행·행)', async () => {
      await sendText(`${await input.inputValue()} [T:ctx]`);
      const u = lastLog('ctx')?.user ?? '';
      expect(u.includes('화면: 실행 결과(리포트)') && u.includes(`보고 있는 실행: ${run1}`) && u.includes('보고 있는 행: 2행 실패'), u.slice(0, 400));
      expect((await page.locator('.ai-msg.user').last().innerText()).includes('리포트 · 2행'), '말풍선에 맥락 표시 없음');
    });
    await check('편집기 스텝 [✦ AI 에게] → "#3 스텝…" 초안, 고른 스텝이 맥락으로', async () => {
      await go(`#/recipe/${id}`, '.step-head');
      await page.locator('.step-head').nth(2).click();
      await page.locator('.step-body').getByRole('button', { name: '✦ AI 에게' }).click();
      const v = await input.inputValue();
      expect(v.startsWith('#3 스텝(입력'), v);
      const ctx = await page.locator('.ai-ctx').innerText();
      expect(ctx.includes('고른 스텝 #3'), ctx);
      await sendText(`${v}확인해 줘 [T:ctx]`);
      const u = lastLog('ctx')?.user ?? '';
      expect(u.includes('화면: 레시피 편집') && u.includes('사용자가 고른 스텝:\n- #3 s3') && u.includes('펼쳐 둔 스텝: #3 s3'), u.slice(0, 500));
    });
    await check('실행 화면 맥락: 올린 엑셀 열·첫 행', async () => {
      await go(`#/run?recipe=${id}`, 'text=2. 엑셀 데이터');
      await page.locator('input[type=file][accept=".xlsx,.csv"]').setInputFiles(csv);
      await page.locator('main').getByText('· 2행').waitFor();
      expect((await page.locator('.ai-ctx').innerText()).includes('엑셀 열 1개'), await page.locator('.ai-ctx').innerText());
      await sendText('[T:ctx] 엑셀 열을 확인해 줘');
      const u = lastLog('ctx')?.user ?? '';
      expect(u.includes('화면: 실행') && u.includes('올린 엑셀 열: 상호') && u.includes('엑셀 첫 행: 상호=가나상사'), u.slice(0, 400));
    });

    // =================================================================
    console.log('\n[7] 편집기 적용·저장 · 버리기 · 메모');
    await check('편집기 [적용] → "저장 *" → 저장', async () => {
      await go(`#/recipe/${id}`, '.step-head');
      await sendText('[T:edit2] 끝에 잠깐 쉬기를 넣어 줘');
      await panel.getByRole('button', { name: '적용', exact: true }).click();
      await page.getByRole('button', { name: '저장 *' }).click();
      await page.waitForSelector('text=저장했습니다');
      const r = (await api('GET', `/api/recipes/${id}`)).recipe;
      expect(r.blocks.main.length === 8 && r.blocks.main.at(-1).type === 'sleep', r.blocks.main.map((s) => s.type).join(','));
    });
    await check('[버리기] → 제안이 사라지고 레시피는 그대로', async () => {
      await sendText('[T:edit3] 이름을 바꿔 줘');
      await panel.getByRole('button', { name: '버리기' }).click();
      await until(async () => (await page.locator('.ai-changes').count()) === 0, 5000);
      expect((await page.locator('.ai-changes').count()) === 0, '카드가 남았습니다');
      expect((await page.locator('.ai-change-past').last().innerText()).includes('버림'), await page.locator('.ai-change-past').last().innerText());
      const r = (await api('GET', `/api/recipes/${id}`)).recipe;
      expect(r.name === `${NAME} (고침)`, r.name);
    });
    const MEMO = '조회 뒤 표가 2초 늦게 뜬다';
    await check('메모 보기·고치기 → 서버에 저장', async () => {
      await panel.getByRole('button', { name: /^메모/ }).click();
      await page.locator('.ai-notes textarea').fill(MEMO);
      await page.locator('.ai-notes').getByRole('button', { name: '메모 저장' }).click();
      await page.waitForSelector('text=메모를 저장했습니다');
      const th = await api('GET', `/api/agent/thread?recipeId=${id}`);
      expect(th.notes === MEMO, th.notes);
      await page.locator('.ai-notes').getByRole('button', { name: '닫기' }).click();
    });
    await check('고친 메모가 다음 요청의 맥락에 들어감', async () => {
      await sendText('[T:ctx] 메모 확인');
      const u = lastLog('ctx')?.user ?? '';
      expect(u.includes('레시피 메모:') && u.includes(MEMO), u.slice(-300));
    });

    // =================================================================
    console.log('\n[8] 휴대폰 폭 390px');
    const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
    watch(m);
    const sw = () => m.evaluate(() => document.documentElement.scrollWidth);
    await check('390px: 패널을 닫은 상태 5개 화면에서 가로 스크롤 없음', async () => {
      const bad = [];
      for (const [name, hash, sel] of [
        ['recipes', '#/recipes', 'table'],
        ['editor', `#/recipe/${id}`, '.step-head'],
        ['run', `#/run?recipe=${id}`, 'text=2. 엑셀 데이터'],
        ['report', `#/report/${run1}`, '.statline'],
        ['settings', '#/settings', '.browser-opt'],
      ]) {
        await m.goto(`${BASE}/${hash}`);
        await m.waitForSelector(sel);
        await sleep(300);
        const w = await sw();
        if (w > 392) bad.push(`${name}=${w}`);
        await m.screenshot({ path: path.join(SHOTS, `m-${name}.png`) });
      }
      expect(!bad.length, bad.join(', '));
    });
    await check('390px: 패널을 열면 화면 전체를 덮고, 열고 닫아도 가로 스크롤 없음', async () => {
      await m.goto(`${BASE}/#/recipe/${id}`);
      await m.waitForSelector('.step-head');
      await m.locator('.ai-top').click();
      const mp = m.locator('.ai-panel');
      await mp.waitFor({ state: 'visible' });
      await m.waitForSelector('.ai-msg.assistant');
      await sleep(300);
      const box = await mp.boundingBox();
      expect(box && box.x === 0 && box.width === 390 && box.height >= 840, JSON.stringify(box));
      const open = await sw();
      const inner = await mp.evaluate((p) => Math.max(...[...p.querySelectorAll('*')].map((e) => e.getBoundingClientRect().right)));
      await m.screenshot({ path: path.join(SHOTS, 'm-panel-open.png') });
      await mp.locator('.ai-head button[title="닫기"]').click();
      await sleep(200);
      const closed = await sw();
      expect(open <= 392 && closed <= 392 && inner <= 391, `열림 ${open} · 닫힘 ${closed} · 패널 안 오른쪽 끝 ${inner}`);
    });
    await check('R1-15·08 390px: 입력창 안내에 "Ctrl+Enter" 가 없고, 위쪽 단추는 짧게 "✦ AI" (넓은 화면은 "Ctrl+Enter" 안내)', async () => {
      const ph = await m.locator('.ai-input textarea').getAttribute('placeholder');
      const top = await m.locator('.ai-top').innerText();
      const wide = await page.locator('.ai-input textarea').getAttribute('placeholder');
      expect(!ph.includes('Ctrl+Enter') && wide.includes('Ctrl+Enter') && top.startsWith('✦ AI') && !top.includes('대화'), `${ph} | ${top} | ${wide}`);
    });
    await m.close();

    // =================================================================
    console.log('\n[9] 대화 지우기 · 오류');
    await check('대화 지우기 → 대화·대기 제안 지움, 메모는 남김', async () => {
      await panel.getByRole('button', { name: '대화 지우기' }).click();
      await page.waitForSelector('text=대화를 지웠습니다');
      expect((await page.locator('.ai-msg').count()) === 0 && (await page.locator('.ai-empty').isVisible()), '대화가 남았습니다');
      const th = await api('GET', `/api/agent/thread?recipeId=${id}`);
      expect(th.display.length === 0 && th.pending === null && th.notes === MEMO, JSON.stringify({ n: th.display.length, p: !!th.pending, notes: th.notes }));
    });
    await check('화면 오류 0 (pageerror · console error)', async () => expect(!errors.length, errors.join(' | ')));
  } finally {
    await browser?.close().catch(() => {});
    await stopServer();
    site.close();
    mockServer.close();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\nAI 화면 점검: ${passed}/${results.length} 통과`);
  if (passed !== results.length) {
    for (const r of results.filter((x) => !x.ok)) console.log(`  ❌ ${r.name} — ${r.why}`);
    if (process.env.SHOW_LOG) console.log(serverLog.slice(-4000));
    console.log(`(출력 남김: ${OUT})`);
    process.exit(1);
  }
  if (process.env.KEEP_OUT !== '1') await fs.rm(OUT, { recursive: true, force: true }).catch(() => {});
}

main().catch(async (e) => {
  console.error('\n❌ AI 화면 점검 실패:', e);
  await stopServer();
  process.exit(1);
});
