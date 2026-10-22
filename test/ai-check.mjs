// AI 대화·도구·비밀값 점검 (가짜 OpenRouter — 스트리밍 SSE 와 JSON 두 방식).
// 대화 저장(서버 재시작)·대기 제안 이어서 고치기·적용·버리기·409, [맥락] 블록, 새 도구, 비밀값 저장(DPAPI)·가리기, 지표, 관찰 브라우저 수명.
// 실행: node test/ai-check.mjs   (포트 4940–4942, 출력 test/out-ai/ — 끝나면 지운다. KEEP_OUT=1 이면 남긴다)

import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SecretStore } from '../src/secrets.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'test', 'out-ai');
const WS = path.join(OUT, 'ws');
const PORT = 4940;
const SITE_PORT = 4941;
const MOCK_PORT = 4942;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const MODEL = 'anthropic/claude-sonnet-5.5';
// 심어 둔 비밀값: 어디에도(가짜 모델이 받은 요청, thread.json, 지표, 로그, 레시피) 나오면 안 된다
const SECRET = 'Pw-심어둔비밀-7731!';
const SECRET2 = 'Pw-두번째비밀-4410#';
const SECRET3 = 'Pw-세번째비밀-9902$';
const SECRETS = [SECRET, SECRET2, SECRET3];
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

// ---------- 시험 사이트 ----------
const page = (title, body) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const LOGIN = page(
  '로그인 (AI 점검)',
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
const LIST = page(
  '거래처 목록 (AI 점검)',
  `<h1>거래처 목록</h1>
<table><thead><tr><th>거래처</th><th>금액</th><th></th></tr></thead><tbody>
<tr><td>가나상사</td><td>1,000</td><td><a href="#" onclick="return false">보기</a></td></tr>
<tr><td>다라상사</td><td>2,000</td><td><a href="#" onclick="return false">보기</a></td></tr>
<tr><td>마바상사</td><td>3,000</td><td><a href="#" onclick="return false">보기</a></td></tr>
</tbody></table>`,
);

function startSite() {
  const accepted = new Set(SECRETS);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, SITE);
    if (req.method === 'POST' && url.pathname === '/check') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: accepted.has(Buffer.concat(chunks).toString('utf8')) }));
    }
    const html = url.pathname === '/login' ? LOGIN : url.pathname === '/list' ? LIST : null;
    res.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html ?? 'not found');
  });
  return new Promise((r) => server.listen(SITE_PORT, '127.0.0.1', () => r(server)));
}

// ---------- 가짜 OpenRouter ----------
const mock = { mode: 'json', log: [], raw: [], snapshot: '' };
const textOf = (c) => (Array.isArray(c) ? c.map((p) => p?.text ?? '').join('\n') : String(c ?? ''));
const refOf = (snapshot, needle) => String(snapshot ?? '').split('\n').find((l) => /^f\d+e\d+ /.test(l) && l.includes(needle))?.split(' ')[0];
let callNo = 0;
const call = (name, args) => ({ id: `call_${(callNo += 1)}_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const say = (content) => ({ role: 'assistant', content });
const use = (...calls) => ({ role: 'assistant', content: null, tool_calls: calls });

/** 요청마다: 마지막 [요청] 의 [T:태그] 와 그 뒤 도구 결과 수(k)로 대본을 고른다 */
function script(tag, k, last) {
  switch (tag) {
    case 'rename':
      return k === 0 ? use(call('rename_variable', { from: '아이디', to: '사용자' })) : say('아이디 변수를 사용자로 바꿨습니다.');
    case 'wrap':
      if (k === 0) return use(call('get_recipe', {}));
      if (k === 1) return use(call('wrap_steps', { stepIds: ['#5', '#6'], kind: 'repeat', times: 3 }));
      return say('1. #5~#6 을 3번 반복으로 묶었습니다.\n2. [적용]을 눌러 반영하세요.');
    case 'slow':
      return say('천천히 답했습니다.');
    case 'choice':
      return use(
        call('ask_choice', {
          question: '결과가 없을 때 어떻게 할까요?',
          options: [
            { label: '그 행은 실패로 남기고 다음 행', message: '결과가 없으면 그 행을 실패로 남기고 다음 행으로 가 줘' },
            { label: '뒤 스텝만 건너뛰기', message: '결과가 없으면 뒤 스텝을 건너뛰어 줘' },
          ],
        }),
      );
    case 'remember':
      return k === 0 ? use(call('remember', { note: '조회 뒤 표가 2초 늦게 뜬다' })) : say('기억해 두었습니다.');
    case 'delete':
      return k === 0 ? use(call('delete_steps', { stepIds: ['#1'] })) : say('#1 을 지웠습니다.');
    case 'loop15':
      return use(call('validate_recipe', {}));
    case 'legacy':
      return k === 0 ? use(call('set_recipe_fields', { name: 'AI 점검 편집 (옛 화면)' })) : say('이름을 바꿨습니다.');
    case 'observe':
      return k === 0 ? use(call('observe_page', { runUntilStepId: '#5' })) : say('로그인 뒤 화면을 확인했습니다.');
    case 'list': {
      if (k === 0) return use(call('observe_page', { runUntilStepId: '#7' }));
      if (k === 1) {
        mock.snapshot = last;
        return use(call('make_list_target', { ref: refOf(last, '"보기"') ?? 'f0e999' }));
      }
      const row = refOf(mock.snapshot, '"보기"');
      if (k === 2)
        return use(
          call('insert_steps', { afterStepId: '#7', steps: [{ type: 'forEach', itemsRef: row, body: '행마다', maxItems: 10 }] }),
          call('insert_steps', { afterStepId: null, block: '행마다', steps: [{ type: 'extract', targetRef: refOf(mock.snapshot, '"1,000"'), withinRef: row, saveAs: '금액' }] }),
        );
      if (k === 4) return use(call('validate_recipe', {}));
      return say('#8 표의 행마다 금액을 읽게 했습니다.');
    }
    case 'sample':
      return k === 0 ? use(call('run_sample', { rows: 1 })) : say('시험 실행이 성공했습니다.');
    case 'lastrun':
      return k === 0 ? use(call('get_last_run', {})) : say('1행이 로그인에서 실패했습니다.');
    case 'shot':
      return k === 0 ? use(call('get_failure_screenshot', { row: 1 })) : say('실패 화면을 봤습니다.');
    default:
      return say('알겠습니다.');
  }
}

function writeSse(res, model, message, usage) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  res.write(': OPENROUTER PROCESSING\n\n');
  const chunk = (delta, extra = {}) => `data: ${JSON.stringify({ id: 'gen-mock', model, choices: [{ index: 0, delta, ...extra }] })}\n\n`;
  const out = [];
  if (message.content) for (let i = 0; i < message.content.length; i += 5) out.push(chunk({ content: message.content.slice(i, i + 5) }));
  (message.tool_calls ?? []).forEach((tc, i) => {
    out.push(chunk({ tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] }));
    const a = tc.function.arguments;
    for (let j = 0; j < a.length; j += 7) out.push(chunk({ tool_calls: [{ index: i, function: { arguments: a.slice(j, j + 7) } }] }));
  });
  out.push(`data: ${JSON.stringify({ id: 'gen-mock', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`, 'data: [DONE]\n\n');
  // 줄 중간에서 끊어 보내도 이어 붙여야 한다
  const all = out.join('');
  const cut = Math.floor(all.length / 3);
  res.write(all.slice(0, cut));
  setTimeout(() => res.end(all.slice(cut)), 20);
}

function startMock() {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    mock.raw.push(raw);
    const body = JSON.parse(raw);
    const msgs = body.messages ?? [];
    let at = -1;
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i].role === 'user' && textOf(msgs[i].content).includes('[요청]')) {
        at = i;
        break;
      }
    }
    const user = at >= 0 ? textOf(msgs[at].content) : '';
    const after = msgs.slice(at + 1);
    const tools = after.filter((m) => m.role === 'tool');
    const tag = /\[T:([\w-]+)\]/.exec(user.slice(user.lastIndexOf('[요청]')))?.[1] ?? '';
    const entry = { tag, k: tools.length, body, user, last: tools.at(-1)?.content ?? '', after };
    mock.log.push(entry);
    if (tag === 'slow') await sleep(1500);
    const message = script(tag, entry.k, entry.last);
    const usage = { prompt_tokens: 1200, completion_tokens: 40, cost: 0.003 };
    if (mock.mode === 'sse' && body.stream) return writeSse(res, body.model, message, usage);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: body.model, choices: [{ message }], usage }));
  });
  return new Promise((r) => server.listen(MOCK_PORT, '127.0.0.1', () => r(server)));
}
const logOf = (tag) => mock.log.filter((e) => e.tag === tag);

// ---------- 앱 서버 ----------
let serverLog = '';
let server = null;
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

async function api(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
async function ok(method, url, body) {
  const r = await api(method, url, body);
  if (r.status !== 200) throw new Error(`${method} ${url} → ${r.status} ${r.data?.error ?? ''}`);
  return r.data;
}

// SSE 이벤트 받기
const events = [];
let sseCtrl = null;
async function listen() {
  sseCtrl?.abort();
  sseCtrl = new AbortController();
  const res = await fetch(`${BASE}/api/events`, { signal: sseCtrl.signal });
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const part of res.body) {
        buf += dec.decode(part, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (type && data) events.push({ type, data: JSON.parse(data) });
        }
      }
    } catch {
      /* 끊김 */
    }
  })();
}

/** 앞 턴의 이벤트가 늦게 도착할 수 있어 잠시 기다린 뒤 비운다 */
async function clearEvents() {
  await sleep(300);
  events.length = 0;
}

async function waitRun(runId) {
  for (let i = 0; i < 240; i += 1) {
    const st = await ok('GET', '/api/state');
    if (st.run?.runId === runId && ['done', 'failed', 'stopped'].includes(st.run.status)) break;
    await sleep(500);
  }
  return ok('GET', `/api/runs/${runId}`);
}

async function filesUnder(dir, skip = []) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, e.name);
    if (skip.some((s) => full.startsWith(s))) continue;
    if (e.isDirectory()) out.push(...(await filesUnder(full, skip)));
    else out.push(full);
  }
  return out;
}
const countSecrets = (text) => SECRETS.reduce((n, s) => n + String(text).split(s).length - 1, 0);

// ---------- 레시피 ----------
const T = (css, meta = {}) => ({ candidates: [{ kind: 'css', value: css, score: 90 }], meta });
function loginRecipe() {
  return {
    schemaVersion: 1,
    name: 'AI 점검 로그인',
    startUrl: `${SITE}/login`,
    entryBlock: 'main',
    loop: { onRowError: 'skip' },
    variables: [
      { id: '아이디', name: '아이디', source: { kind: 'static', value: 'tester' } },
      { id: '비밀번호', name: '비밀번호', source: { kind: 'prompt', secret: true, default: SECRET } },
    ],
    blocks: {
      main: [
        { id: 's1', type: 'navigate', url: `${SITE}/login` },
        { id: 's2', type: 'input', target: T('#uid', { tag: 'input', label: '아이디' }), value: '{{아이디}}' },
        { id: 's3', type: 'input', target: T('#pw', { tag: 'input', type: 'password', label: '비밀번호' }), value: '{{비밀번호}}', meta: { recordedValue: SECRET } },
        { id: 's4', type: 'click', target: T('#go', { tag: 'button', text: '로그인' }) },
        { id: 's5', type: 'wait', condition: { kind: 'textVisible', text: '로그인 성공' }, timeoutMs: 4000 },
        { id: 's6', type: 'extract', target: T('#msg', { tag: 'p' }), saveAs: '결과' },
        { id: 's7', type: 'navigate', url: `${SITE}/list` },
      ],
    },
  };
}
function editRecipe() {
  return {
    schemaVersion: 1,
    name: 'AI 점검 편집',
    startUrl: `${SITE}/list`,
    entryBlock: 'main',
    loop: { onRowError: 'skip' },
    variables: [{ id: '아이디', name: '아이디', source: { kind: 'excel', column: '아이디' } }],
    blocks: {
      main: [
        { id: 's1', type: 'navigate', url: `${SITE}/list` },
        { id: 's2', type: 'input', target: T('#q', { tag: 'input', label: '검색어' }), value: '{{아이디}}' },
        { id: 's3', type: 'click', target: T('#find', { tag: 'button', text: '찾기' }) },
        { id: 's4', type: 'wait', condition: { kind: 'textVisible', text: '결과' } },
        { id: 's5', type: 'extract', target: T('#a', { tag: 'span' }), saveAs: '금액' },
        { id: 's6', type: 'click', target: T('#next', { tag: 'a', text: '다음' }) },
        { id: 's7', type: 'sleep', ms: 500 },
      ],
    },
  };
}

// =====================================================================
async function main() {
  console.log('\n[변경 문구 (고침 1회차 R1-04·09)]');
  {
    const { changeText, recipeDiff } = await import('../src/ai/tools.js');
    const cell = { framePath: [], candidates: [{ kind: 'css', value: '#result > tbody > tr:nth-of-type(1) > td:nth-of-type(4)', score: 55 }], meta: { tag: 'td', text: '12,000' } };
    const inItem = { framePath: [], within: 'item', candidates: [{ kind: 'css', value: ':scope > td:nth-of-type(4)', score: 80 }], meta: { tag: 'td', text: '12,000', col: '금액', label: '금액' } };
    const a = { id: 's4', type: 'extract', target: cell, saveAs: '금액' };
    const b = { ...a, target: inItem };
    await check('R1-04 update_step 문구: 대상이 바뀌면 "대상: 앞 → 뒤" (견본 글자 대신 열 이름 · 항목 안)', async () => {
      const t = changeText(a, b);
      expect(t === '"12,000"의 글자 읽어 {{금액}}에 저장 → "금액"의 글자 읽어 {{금액}}에 저장 (대상: "12,000" 표 칸 → "금액" 표 칸 · 항목 안)', t);
    });
    await check('R1-04 문장이 같고 대상도 같으면 바뀐 칸 이름 ("세부 설정 바뀜: timeoutMs")', async () => {
      const t = changeText(a, { ...a, timeoutMs: 5000 });
      expect(t === '"12,000"의 글자 읽어 {{금액}}에 저장 (세부 설정 바뀜: timeoutMs)', t);
    });
    await check('R1-04 recipeDiff(사용자가 바꾼 것)도 같은 문구', async () => {
      const r0 = { blocks: { main: [a] } };
      const r1 = { blocks: { main: [b] } };
      const d = recipeDiff(r0, r1);
      expect(d.length === 1 && d[0].startsWith('수정 #1 s4: ') && d[0].includes('(대상: "12,000" 표 칸 → "금액" 표 칸 · 항목 안)'), JSON.stringify(d));
    });
  }
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(WS, { recursive: true });
  const site = await startSite();
  const mockServer = await startMock();
  await startServer();
  await listen();
  const turn = (recipeId, recipe, message, extra = {}) => ok('POST', '/api/agent/turn', { recipeId, recipe, message, ...extra });
  const secretStore = new SecretStore(WS);
  let A; // 로그인 레시피 (실행·관찰·비밀값)
  let B; // 편집 레시피 (대화·제안)

  try {
    await ok('PUT', '/api/settings', { openrouter: { apiKey: 'sk-or-ai-check-1234', model: MODEL } });

    console.log('\n[비밀값 저장]');
    A = (await ok('POST', '/api/recipes', loginRecipe())).recipe;
    await check('레시피를 저장하면 비밀 기본값과 녹화값이 레시피에서 빠진다', async () => {
      const file = await fs.readFile(path.join(WS, 'recipes', `${A.id}.json`), 'utf8');
      expect(countSecrets(file) === 0, '레시피 파일에 비밀값이 있다');
      const v = A.variables.find((x) => x.id === '비밀번호');
      expect(v.source.default === undefined, '응답 레시피에 default 가 남았다');
      expect(A.blocks.main[2].meta?.recordedValue === undefined, '비밀 스텝 녹화값이 남았다');
    });
    await check('secrets.json 에 평문 없이 DPAPI 로 암호화해 저장', async () => {
      const text = await fs.readFile(path.join(WS, 'secrets.json'), 'utf8');
      const d = JSON.parse(text);
      expect(d.version === 1 && d.items[`${A.id}/비밀번호`]?.data, `항목이 없다: ${Object.keys(d.items ?? {})}`);
      expect(countSecrets(text) === 0 && !text.includes(Buffer.from(SECRET).toString('base64')), '평문(또는 base64 평문)이 있다');
    });
    await check('DPAPI 왕복: 저장한 값을 다시 풀 수 있다', async () => {
      const got = await secretStore.getAll(A.id);
      expect(got['비밀번호'] === SECRET, '복호화 값이 다르다');
    });
    await check('GET /api/recipes/:id/secrets → 저장됨 표시', async () => {
      const list = await ok('GET', `/api/recipes/${A.id}/secrets`);
      expect(list.length === 1 && list[0].varId === '비밀번호' && list[0].saved === true && list[0].savedAt, JSON.stringify(list));
    });

    console.log('\n[대화·맥락 — JSON 응답]');
    B = (await ok('POST', '/api/recipes', editRecipe())).recipe;
    const ctx = { page: 'editor', selectedStepIds: ['s3'], openStepId: 's2', upload: { headers: ['아이디', '금액'], firstRow: { 아이디: 'kim', 금액: '1000' } } };
    await clearEvents();
    const r1 = await turn(B.id, B, '[T:rename] 아이디 변수 이름을 사용자로 바꿔 줘', { context: ctx });
    await check('rename_variable: 변수 id·이름과 스텝 참조가 함께 바뀐다', async () => {
      expect(r1.changes.length === 1 && r1.changes[0].includes('변수 이름 바꾸기'), JSON.stringify(r1.changes));
      expect(r1.recipe.variables[0].id === '사용자' && r1.recipe.variables[0].name === '사용자', '변수가 안 바뀌었다');
      expect(r1.recipe.blocks.main[1].value === '{{사용자}}', `스텝 값: ${r1.recipe.blocks.main[1].value}`);
    });
    const m1 = logOf('rename')[0];
    await check('[맥락] 에 화면·고른 스텝·펼친 스텝이 전역 번호로 들어간다', async () => {
      expect(m1.user.startsWith('[맥락]'), '맥락 블록이 앞에 없다');
      expect(m1.user.includes('화면: 레시피 편집'), '화면 종류 없음');
      expect(/사용자가 고른 스텝:\n- #3 s3 /.test(m1.user), '고른 스텝 없음');
      expect(m1.user.includes('펼쳐 둔 스텝: #2 s2'), '펼친 스텝 없음');
    });
    await check('[맥락] 에 올린 엑셀 열·첫 행과 레시피 개요(#번호 한 줄씩)가 들어간다', async () => {
      expect(m1.user.includes('올린 엑셀 열: 아이디, 금액') && m1.user.includes('엑셀 첫 행: 아이디=kim'), '엑셀 열 없음');
      expect(/^#1 s1 주소 이동: /m.test(m1.user) && /^#7 s7 /m.test(m1.user), '개요 줄 없음');
      expect(m1.user.includes('[요청]\n[T:rename]'), '요청 표시 없음');
    });
    await check('스트리밍 요청 + Anthropic 모델이면 시스템에 cache_control', async () => {
      expect(m1.body.stream === true, 'stream 이 아니다');
      const sys = m1.body.messages[0];
      expect(sys.role === 'system' && Array.isArray(sys.content) && sys.content[0].cache_control?.type === 'ephemeral', '시스템 캐시 표시 없음');
      expect(m1.body.tools.some((t) => t.function.name === 'wrap_steps') && m1.body.tools.some((t) => t.function.name === 'ask_choice'), '새 도구 정의 없음');
    });
    await check('SSE: agent-progress(sessionId=recipeId)·agent-done', async () => {
      await sleep(200);
      const prog = events.filter((e) => e.type === 'agent-progress' && e.data.recipeId === B.id);
      expect(prog.length > 0 && prog.every((e) => e.data.sessionId === B.id), `진행 이벤트 ${prog.length}`);
      expect(events.some((e) => e.type === 'agent-done' && e.data.recipeId === B.id), 'agent-done 없음');
    });
    await check('대기 제안이 서버에 남는다 (GET /api/agent/thread)', async () => {
      const t = await ok('GET', `/api/agent/thread?recipeId=${B.id}`);
      expect(t.pending?.changes.length === 1 && t.pending.recipe.variables[0].id === '사용자', 'pending 없음');
      expect(t.display.length === 2 && t.display[0].role === 'user' && t.display[1].changeState === 'pending' && t.display[1].usage?.model, JSON.stringify(t.display).slice(0, 200));
      expect(t.running === false && t.usage.cost > 0, '사용량 없음');
    });
    await check('잘못된 레시피 id 는 400', async () => {
      const a = await api('GET', '/api/agent/thread');
      const b = await api('POST', '/api/agent/turn', { recipeId: '../x', recipe: B, message: 'x' });
      const c = await api('POST', '/api/agent/turn', { recipe: B, message: 'x' });
      expect(a.status === 400 && b.status === 400 && c.status === 400, `${a.status} ${b.status} ${c.status}`);
    });
    await check('metrics.jsonl 에 턴마다 한 줄 {at, recipeId, ms, firstTokenMs, rounds, cost, model}', async () => {
      const lines = (await fs.readFile(path.join(WS, 'ai', 'metrics.jsonl'), 'utf8')).trim().split('\n');
      const m = JSON.parse(lines.at(-1));
      expect(lines.length === 1, `줄 수 ${lines.length}`);
      for (const k of ['at', 'recipeId', 'ms', 'firstTokenMs', 'rounds', 'cost', 'model']) expect(m[k] !== undefined && m[k] !== null, `${k} 없음`);
      expect(m.recipeId === B.id && m.rounds === 2, JSON.stringify(m));
    });

    console.log('\n[스트리밍·이어서 고치기]');
    mock.mode = 'sse';
    await clearEvents();
    const r2 = await turn(B.id, B, '[T:wrap] #5 와 #6 을 3번 반복하게 묶어 줘', { context: { page: 'editor' } });
    mock.mode = 'json';
    await check('스트리밍 글자가 SSE agent-delta 로 오고 답변과 같다', async () => {
      await sleep(200);
      const deltas = events.filter((e) => e.type === 'agent-delta' && e.data.recipeId === B.id);
      expect(deltas.length > 3, `조각 ${deltas.length}개`);
      expect(deltas.map((e) => e.data.text).join('') === r2.reply, '조각을 이은 글이 답변과 다르다');
    });
    await check('스트리밍 도구 호출 조각을 이어 wrap_steps(#번호) 로 반복을 만든다', async () => {
      const main = r2.recipe.blocks.main;
      const rep = main.find((s) => s.type === 'repeat');
      expect(rep && rep.times === 3 && rep.body, '반복 스텝 없음');
      expect(r2.recipe.blocks[rep.body].map((s) => s.id).join() === 's5,s6', `몸통: ${r2.recipe.blocks[rep.body]?.map((s) => s.id)}`);
    });
    await check('대기 제안 위에 이어서 고치고 변경을 합친다 (앞 제안은 merged)', async () => {
      expect(r2.changes.length === 2 && r2.changes[0].includes('변수 이름 바꾸기') && r2.changes[1].includes('묶기'), JSON.stringify(r2.changes));
      expect(r2.recipe.blocks.main[1].value === '{{사용자}}', '앞 제안 위가 아니다');
      const states = r2.display.filter((d) => d.changeState).map((d) => d.changeState);
      expect(states.join() === 'merged,pending', states.join());
    });
    await check('get_recipe 결과 형식 유지 (blocks.main[].{id,no,type,desc})', async () => {
      const g = JSON.parse(logOf('wrap')[1].last);
      const s = g.blocks.main[0];
      expect(s.id === 's1' && s.no === '#1' && s.type === 'navigate' && s.desc, JSON.stringify(s));
    });

    console.log('\n[서버 재시작·정리]');
    const oldDir = path.join(WS, 'ai', 'old-recipe-1');
    await fs.mkdir(oldDir, { recursive: true });
    await fs.writeFile(path.join(oldDir, 'thread.json'), JSON.stringify({ version: 1, recipeId: 'old-recipe-1', updatedAt: new Date(Date.now() - 40 * 86400_000).toISOString(), messages: [], display: [] }));
    await fs.writeFile(path.join(oldDir, 'notes.md'), '- 옛 메모\n');
    // 예전 버전이 남긴 레시피: 비밀 기본값이 평문으로 들어 있다
    const legacyFile = path.join(WS, 'recipes', 'legacy-secret-1.json');
    await fs.writeFile(legacyFile, JSON.stringify({ ...loginRecipe(), id: 'legacy-secret-1', variables: [{ id: '비밀번호', name: '비밀번호', source: { kind: 'prompt', secret: true, default: SECRET2 } }] }, null, 2));
    await stopServer();
    await startServer();
    await listen();
    await check('서버를 껐다 켜도 대화·대기 제안이 그대로', async () => {
      const t = await ok('GET', `/api/agent/thread?recipeId=${B.id}`);
      expect(t.display.length === 4, `표시 ${t.display.length}개`);
      expect(t.pending?.changes.length === 2 && t.pending.recipe.blocks.main.some((s) => s.type === 'repeat'), 'pending 이 없다');
    });
    await check('서버 시작 때 예전 레시피 파일의 비밀 기본값을 저장소로 옮긴다', async () => {
      let text = '';
      for (let i = 0; i < 50; i += 1) {
        text = await fs.readFile(legacyFile, 'utf8');
        if (!countSecrets(text)) break;
        await sleep(100);
      }
      expect(countSecrets(text) === 0, '레시피 파일에 비밀값이 남았다');
      expect((await new SecretStore(WS).getAll('legacy-secret-1'))['비밀번호'] === SECRET2, '저장소에 없다');
    });
    await check('30일 지난 대화는 서버 시작 때 지우고 메모는 남긴다', async () => {
      const left = await fs.readdir(oldDir);
      expect(!left.includes('thread.json') && left.includes('notes.md'), left.join());
    });

    console.log('\n[동시 요청·선택지·메모]');
    await check('같은 레시피에 진행 중인 턴이 있으면 409', async () => {
      const first = api('POST', '/api/agent/turn', { recipeId: B.id, recipe: B, message: '[T:slow] 천천히' });
      await sleep(400);
      const t = await ok('GET', `/api/agent/thread?recipeId=${B.id}`);
      const second = await api('POST', '/api/agent/turn', { recipeId: B.id, recipe: B, message: '[T:plain] 하나 더' });
      const r = await first;
      expect(t.running === true, '진행 중 표시가 없다');
      expect(second.status === 409, `두 번째 요청 ${second.status}`);
      expect(r.status === 200, `첫 요청 ${r.status}`);
    });
    const r4 = await turn(B.id, B, '[T:choice] 조회 결과가 없으면 넘어가게 해 줘');
    await check('ask_choice: 턴을 끝내고 선택지(choices)를 돌려준다', async () => {
      expect(r4.choices?.length === 2 && r4.choices[0].label && r4.choices[0].message, JSON.stringify(r4.choices));
      expect(r4.reply.includes('결과가 없을 때 어떻게 할까요?'), r4.reply);
      expect(logOf('choice').length === 1, `모델 요청 ${logOf('choice').length}번`);
      expect(r4.display.at(-1).choices?.length === 2, '표시에 choices 없음');
    });
    await turn(B.id, B, '[T:remember] 이거 기억해 둬');
    await check('remember: notes.md 에 한 줄 남고 thread 에 보인다', async () => {
      const notes = await fs.readFile(path.join(WS, 'ai', B.id, 'notes.md'), 'utf8');
      expect(notes.includes('- 조회 뒤 표가 2초 늦게 뜬다'), notes);
      const t = await ok('GET', `/api/agent/thread?recipeId=${B.id}`);
      expect(t.notes.includes('2초 늦게'), 'thread notes 없음');
    });
    await turn(B.id, B, '[T:plain] 메모 보이니');
    await check('다음 턴 [맥락] 에 레시피 메모가 들어간다', async () => {
      const u = logOf('plain').at(-1).user;
      expect(u.includes('레시피 메모:\n- 조회 뒤 표가 2초 늦게 뜬다'), '메모 없음');
    });
    await check('PUT /api/agent/notes 로 메모를 고친다', async () => {
      await ok('PUT', '/api/agent/notes', { recipeId: B.id, text: '사람이 고친 메모\n- 조회 뒤 표가 2초 늦게 뜬다\n' });
      const t = await ok('GET', `/api/agent/thread?recipeId=${B.id}`);
      expect(t.notes.startsWith('사람이 고친 메모'), t.notes);
    });

    console.log('\n[적용·사용자 변경·버리기]');
    let saved;
    await check('POST /api/agent/pending apply+save: 레시피 파일에 저장되고 제안은 applied', async () => {
      const r = await ok('POST', '/api/agent/pending', { recipeId: B.id, action: 'apply', save: true });
      expect(r.recipe.blocks.main.some((s) => s.type === 'repeat') && Array.isArray(r.problems), '적용 결과 없음');
      saved = (await ok('GET', `/api/recipes/${B.id}`)).recipe;
      expect(saved.blocks.main.some((s) => s.type === 'repeat') && saved.variables[0].id === '사용자', '저장되지 않았다');
      const t = await ok('GET', `/api/agent/thread?recipeId=${B.id}`);
      expect(t.pending === null && t.display.filter((d) => d.changeState).map((d) => d.changeState).join() === 'merged,applied', JSON.stringify(t.display.map((d) => d.changeState)));
    });
    await check('지난 AI 턴 이후 사용자가 바꾼 스텝이 [맥락] 에 들어간다', async () => {
      const mine = structuredClone(saved);
      mine.blocks.main.find((s) => s.id === 's7').ms = 900;
      saved = (await ok('PUT', `/api/recipes/${B.id}`, mine)).recipe;
      await turn(B.id, saved, '[T:plain] 내가 고친 것 보이니');
      const u = logOf('plain').at(-1).user;
      expect(/지난 AI 턴 이후 사용자가 직접 바꾼 것:\n- 수정 #6 s7: 0\.5초 쉬기 → 0\.9초 쉬기/.test(u), u.slice(u.indexOf('지난 AI')).slice(0, 200) || '변경 없음');
    });
    await check('POST /api/agent/pending discard: 제안을 버리고 discarded', async () => {
      const r = await turn(B.id, saved, '[T:delete] 첫 스텝 지워 줘');
      expect(r.changes.length === 1 && r.changes[0].startsWith('삭제 #1 s1'), JSON.stringify(r.changes));
      const d = await ok('POST', '/api/agent/pending', { recipeId: B.id, action: 'discard' });
      expect(d.ok === true, 'ok 아님');
      const t = await ok('GET', `/api/agent/thread?recipeId=${B.id}`);
      expect(t.pending === null && t.display.at(-1).changeState === 'discarded', 'discarded 아님');
      const again = await api('POST', '/api/agent/pending', { recipeId: B.id, action: 'discard' });
      expect(again.status === 409, `두 번 버리기 ${again.status}`);
    });
    await check('버린 뒤에는 사용자 변경으로 잘못 알리지 않는다', async () => {
      await turn(B.id, saved, '[T:plain] 다음 요청');
      expect(!logOf('plain').at(-1).user.includes('사용자가 직접 바꾼 것'), '버린 제안을 사용자 변경으로 보냈다');
    });
    await check('도구 라운드 상한 15', async () => {
      const r = await turn(B.id, saved, '[T:loop15] 계속 검사해');
      expect(logOf('loop15').length === 15, `요청 ${logOf('loop15').length}번`);
      expect(r.reply.includes('멈췄'), r.reply);
    });
    await check('지난 턴의 [맥락] 은 요약으로 줄여 보낸다', async () => {
      const b = logOf('loop15')[0].body;
      const users = b.messages.filter((m) => m.role === 'user').map((m) => textOf(m.content));
      expect(users.length > 3 && users.slice(0, -1).every((u) => !u.startsWith('[맥락]')), '옛 맥락이 그대로');
      const oldRecipe = b.messages.filter((m) => m.role === 'tool').find((m) => m.content.includes('레시피 개요'));
      expect(oldRecipe && oldRecipe.content.startsWith('(요약)'), '옛 get_recipe 결과가 요약되지 않았다');
    });

    console.log('\n[옛 화면 호환 (sessionId)]');
    await check('sessionId 만 보내도 recipe.id 대화로 이어지고 진행 이벤트는 그 sessionId', async () => {
      await clearEvents();
      const legacyRecipe = structuredClone(saved);
      legacyRecipe.variables.push({ id: '암호', name: '암호', source: { kind: 'prompt', secret: true, default: SECRET3 } });
      legacyRecipe.blocks.main.push({ id: 's90', type: 'input', target: T('#pw2', { tag: 'input', type: 'password' }), value: '{{암호}}' });
      const r = await ok('POST', '/api/agent/turn', { sessionId: 's-legacy-abc123', recipe: legacyRecipe, message: '[T:legacy] 이름 바꿔 줘', allowRisky: false, previousApplied: true });
      expect(r.changes.length === 1 && r.changes[0].includes('레시피 설정 변경'), JSON.stringify(r.changes));
      expect(r.recipe.variables.find((v) => v.id === '암호').source.default === undefined, '비밀 기본값이 응답에 남았다');
      await sleep(200);
      const prog = events.filter((e) => e.type === 'agent-progress' && e.data.recipeId === B.id);
      expect(prog.length && prog.every((e) => e.data.sessionId === 's-legacy-abc123'), `진행 이벤트 sessionId: ${JSON.stringify(prog.map((e) => [e.data.sessionId, e.data.text]))}`);
      const t = await ok('GET', `/api/agent/thread?recipeId=${B.id}`);
      expect(t.pending?.changes.length === 1, 'pending 없음');
    });
    await check('AI 턴에 실려 온 비밀 기본값은 저장소로 옮기고 AI 에 보내지 않는다', async () => {
      const got = await new SecretStore(WS).getAll(B.id);
      expect(got['암호'] === SECRET3, '저장소에 없다');
      expect(logOf('legacy').every((e) => countSecrets(JSON.stringify(e.body)) === 0), 'AI 요청에 비밀값');
      expect(logOf('legacy')[0].user.includes('{{암호}}'), '맥락에 비밀 변수 참조가 없다');
    });
    await check('POST /api/agent/reset {sessionId} → 그 레시피 대화를 지운다 (메모는 남김)', async () => {
      await ok('POST', '/api/agent/reset', { sessionId: 's-legacy-abc123' });
      const t = await ok('GET', `/api/agent/thread?recipeId=${B.id}`);
      expect(t.display.length === 0 && t.pending === null && t.notes.startsWith('사람이 고친 메모'), JSON.stringify(t).slice(0, 200));
    });

    console.log('\n[관찰·시험 실행·실행 결과]');
    await clearEvents();
    await turn(A.id, A, '[T:observe] 로그인 뒤 화면 봐 줘', { context: { page: 'editor' } });
    const opened = () => events.filter((e) => e.type === 'agent-progress' && e.data.recipeId === A.id && e.data.text.includes('숨긴 브라우저를 여는 중')).length;
    await check('관찰 실행에 저장된 비밀값이 전달된다 (로그인 성공 화면)', async () => {
      const res = logOf('observe')[1].last;
      expect(res.startsWith('실행 성공'), res.split('\n')[0]);
      expect(res.includes('로그인 성공'), '로그인 뒤 화면이 아니다');
      expect(opened() === 1, `브라우저 연 횟수 ${opened()}`);
    });
    const rList = await turn(A.id, A, '[T:list] 표의 행마다 금액 읽어 줘');
    await check('관찰 브라우저를 턴 사이에 열어 둔다 (다시 열지 않음)', async () => {
      expect(opened() === 1, `브라우저 연 횟수 ${opened()}`);
    });
    await check('make_list_target: 표의 같은 모양 행을 찾는다', async () => {
      const r = JSON.parse(logOf('list')[2].last);
      expect(!r.error, r.error);
      expect(r.count === 3 && r.sample?.length >= 1 && r.target, JSON.stringify(r).slice(0, 200));
    });
    await check('forEach 를 itemsRef 로, 몸통 스텝을 withinRef 로 만든다 (within: item)', async () => {
      const fe = rList.recipe.blocks.main.find((x) => x.type === 'forEach');
      expect(fe?.items?.candidates?.length && fe.body === '행마다' && fe.maxItems === 10, JSON.stringify(fe).slice(0, 200));
      const ex = rList.recipe.blocks['행마다']?.[0];
      expect(ex?.type === 'extract' && ex.target?.within === 'item' && ex.target.candidates.every((c) => c.kind !== 'text'), JSON.stringify(ex).slice(0, 200));
      expect(rList.changes.some((c) => c.startsWith('추가 #8 ')), JSON.stringify(rList.changes));
      await ok('POST', '/api/agent/pending', { recipeId: A.id, action: 'discard' });
    });
    await turn(A.id, A, '[T:sample] 한 번 돌려 봐');
    await check('run_sample: 숨김 실행으로 행 결과·읽은 값을 돌려준다', async () => {
      const r = JSON.parse(logOf('sample')[1].last);
      expect(r.rows?.[0]?.status === 'ok', JSON.stringify(r).slice(0, 300));
      expect(r.rows[0].values['결과'] === '로그인 성공: tester', JSON.stringify(r.rows[0].values));
    });
    let run1;
    await check('관찰 브라우저가 실행 시작 전에 닫히고, 비어 있는 비밀값은 저장값으로 채운다', async () => {
      const { runId } = await ok('POST', '/api/runs', { recipeId: A.id, options: { headless: true } });
      run1 = await waitRun(runId);
      expect(run1.status === 'done', `${run1.status}: ${run1.error ?? run1.rows?.[0]?.error}`);
      expect(run1.rows[0].values['결과'] === '로그인 성공: tester', JSON.stringify(run1.rows[0].values));
    });
    await check('실행 뒤 다음 관찰은 브라우저를 새로 연다 (닫혔던 것)', async () => {
      await turn(A.id, A, '[T:observe] 다시 봐 줘');
      expect(opened() === 2, `브라우저 연 횟수 ${opened()}`);
    });
    await check('틀린 비밀번호로 실행하면 실패 행과 실패 화면이 남는다', async () => {
      const { runId } = await ok('POST', '/api/runs', { recipeId: A.id, params: { 비밀번호: 'wrong-password-1' }, options: { headless: true } });
      const r = await waitRun(runId);
      expect(r.status === 'failed' && r.rows[0].status === 'failed' && r.rows[0].screenshot, `${r.status} ${r.rows?.[0]?.screenshot}`);
    });
    await turn(A.id, A, '[T:lastrun] 왜 실패했어?', { context: { page: 'report' } });
    await check('get_last_run: 실패 행·오류·로그 끝부분', async () => {
      const r = JSON.parse(logOf('lastrun')[1].last);
      expect(r.status === 'failed' && r.failedRows?.[0]?.row === 1 && r.failedRows[0].error && r.failedRows[0].screenshot === true, JSON.stringify(r).slice(0, 300));
      expect(Array.isArray(r.logTail) && r.logTail.length > 0 && r.logTail.length <= 40, '로그 끝 없음');
      expect(logOf('lastrun')[0].user.includes('화면: 실행 결과(리포트)') && logOf('lastrun')[0].user.includes('마지막 실행:'), '맥락에 마지막 실행 없음');
    });
    await turn(A.id, A, '[T:shot] 실패 화면 보여 줘');
    await check('get_failure_screenshot: 다음 메시지에 이미지가 붙고 thread.json 에는 남지 않는다', async () => {
      const after = logOf('shot')[1].after;
      const img = after.find((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
      expect(img && img.content.find((p) => p.type === 'image_url').image_url.url.startsWith('data:image/png;base64,'), '이미지 메시지 없음');
      const thread = await fs.readFile(path.join(WS, 'ai', A.id, 'thread.json'), 'utf8');
      expect(!thread.includes('data:image/png'), 'thread.json 에 이미지가 있다');
    });

    console.log('\n[실행 화면 비밀값]');
    await check('POST /api/runs saveSecrets: 입력한 값을 저장하고 다음 실행은 묻지 않는다', async () => {
      const a = await waitRun((await ok('POST', '/api/runs', { recipeId: A.id, params: { 비밀번호: SECRET2 }, saveSecrets: ['비밀번호'], options: { headless: true } })).runId);
      expect(a.status === 'done', `첫 실행 ${a.status}`);
      expect((await new SecretStore(WS).getAll(A.id))['비밀번호'] === SECRET2, '저장값이 바뀌지 않았다');
      const b = await waitRun((await ok('POST', '/api/runs', { recipeId: A.id, options: { headless: true } })).runId);
      expect(b.status === 'done', `두 번째 실행 ${b.status}: ${b.rows?.[0]?.error}`);
    });
    await check('비밀값 지우기·다시 넣기 (DELETE·PUT /api/recipes/:id/secrets/:varId)', async () => {
      await ok('DELETE', `/api/recipes/${A.id}/secrets/${encodeURIComponent('비밀번호')}`);
      expect((await ok('GET', `/api/recipes/${A.id}/secrets`))[0].saved === false, '지워지지 않았다');
      await ok('PUT', `/api/recipes/${A.id}/secrets/${encodeURIComponent('비밀번호')}`, { value: SECRET });
      expect((await ok('GET', `/api/recipes/${A.id}/secrets`))[0].saved === true, '저장되지 않았다');
      const bad = await api('PUT', `/api/recipes/${A.id}/secrets/${encodeURIComponent('아이디')}`, { value: 'x' });
      expect(bad.status === 404, `비밀이 아닌 변수 ${bad.status}`);
    });
    await check('대화 지우기 (DELETE /api/agent/thread) — 메모는 남는다', async () => {
      await ok('PUT', '/api/agent/notes', { recipeId: A.id, text: '- 로그인 레시피 메모\n' });
      await ok('DELETE', `/api/agent/thread?recipeId=${A.id}`);
      const t = await ok('GET', `/api/agent/thread?recipeId=${A.id}`);
      expect(t.display.length === 0 && t.notes.includes('로그인 레시피 메모'), JSON.stringify(t).slice(0, 200));
    });

    console.log('\n[비밀값 유출 검사]');
    await check('가짜 모델이 받은 모든 요청 본문에 비밀값 0건', async () => {
      const n = mock.raw.reduce((s, raw) => s + countSecrets(raw) + countSecrets(JSON.stringify(JSON.parse(raw))), 0);
      expect(mock.raw.length > 20 && n === 0, `요청 ${mock.raw.length}개 중 비밀값 ${n}건`);
    });
    await check('thread.json·notes·metrics 에 비밀값 0건', async () => {
      const files = await filesUnder(path.join(WS, 'ai'));
      let n = 0;
      for (const f of files) n += countSecrets(await fs.readFile(f, 'utf8'));
      expect(files.some((f) => f.endsWith('metrics.jsonl')) && n === 0, `파일 ${files.length}개, 비밀값 ${n}건`);
    });
    await check('레시피·실행 기록(로그·리포트)·서버 로그에 비밀값 0건', async () => {
      const files = await filesUnder(WS, [path.join(WS, 'profiles'), path.join(WS, 'secrets.json')]);
      let n = 0;
      for (const f of files) n += countSecrets(await fs.readFile(f, 'utf8'));
      n += countSecrets(serverLog);
      expect(files.some((f) => f.endsWith('log.txt')) && n === 0, `파일 ${files.length}개, 비밀값 ${n}건`);
    });
  } finally {
    sseCtrl?.abort();
    await stopServer();
    mockServer.close();
    site.close();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\nAI 점검: ${passed}/${results.length} 통과`);
  if (passed !== results.length) {
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.why}`);
    if (serverLog.trim()) console.log(`\n[서버 출력 끝]\n${serverLog.split('\n').slice(-20).join('\n')}`);
  }
  if (!process.env.KEEP_OUT) await fs.rm(OUT, { recursive: true, force: true }).catch(() => {});
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\n❌ AI 점검 중단:', e);
  await stopServer().catch(() => {});
  process.exit(1);
});
