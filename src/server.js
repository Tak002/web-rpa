// 로컬 웹 서버: 화면(public/) + API + 실시간 이벤트(SSE).
// 실행: node src/server.js [--port 4800] [--workspace 폴더]

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { Store } from './store.js';
import { Recorder } from './recorder/recorder.js';
import { Runner } from './engine/runner.js';
import { readTable, writeTemplate } from './engine/excel.js';
import { recipeProblems, excelColumnsOf, promptVariablesOf, autoLinkExcel } from './recipe.js';
import { Settings } from './settings.js';
import { startBrowser, profileNameFor } from './browser.js';
import { AgentSession } from './ai/agent.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const PORT = Number(argOf('--port', process.env.PORT || 4800));
const HOST = argOf('--host', '127.0.0.1');
// 이름으로 접속을 허용할 호스트 (IP 주소와 localhost 는 항상 허용). 예: --allow-host mypc.tailnet.ts.net
const ALLOWED_HOSTS = new Set(['localhost', ...String(argOf('--allow-host', process.env.WEB_RPA_ALLOWED_HOSTS ?? '')).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)]);
const store = new Store(path.resolve(argOf('--workspace', path.join(ROOT, 'workspace'))));
const settings = new Settings(store.root);

/** 설정된 브라우저와 그 브라우저 전용 프로필 폴더. */
function browserTarget() {
  const browser = settings.browser;
  return { browser, profileDir: path.join(store.root, 'profiles', profileNameFor(browser.id)) };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.pdf': 'application/pdf', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.webm': 'video/webm' };

// ---------- 상태 ----------
let recording = null; // Recorder
let run = null; // { runner, runId, recipeName, progress, waiting, current }
const clients = new Set();

function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

const agents = new Map(); // sessionId → AgentSession
let agentTurns = 0; // 진행 중인 AI 턴 (화면 관찰 브라우저가 같은 프로필을 쓴다)

/** 브라우저 프로필을 쓰는 작업(녹화·실행)이 진행 중인지. */
function browserBusy() {
  if (recording && recording.state !== 'stopped') return '녹화가 진행 중입니다. 녹화를 끝낸 뒤 다시 시도해 주세요.';
  if (run && !['done', 'failed', 'stopped'].includes(run.runner.status)) return '실행이 진행 중입니다. 끝나거나 중지한 뒤 다시 시도해 주세요.';
  return null;
}
function busy() {
  return browserBusy() ?? (agentTurns > 0 ? 'AI 도우미가 화면을 확인하는 중입니다. 답변이 끝난 뒤 다시 시도해 주세요.' : null);
}

function publicState() {
  return {
    recording: recording ? { state: recording.state, recipe: recording.recipe } : null,
    run: run
      ? { runId: run.runId, recipeId: run.recipeId, recipeName: run.recipeName, status: run.runner.status, progress: run.progress, waiting: run.waiting, current: run.current, row: run.row, log: run.runner.logLines.slice(-300) }
      : null,
  };
}

// ---------- HTTP 보조 ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};
async function readBody(req, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, '파일이 너무 큽니다 (25MB 제한).');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
async function readJson(req) {
  const buf = await readBody(req, 5 * 1024 * 1024);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON 형식이 아닙니다.');
  }
}

async function serveFile(res, file, { download = false, name } = {}) {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat?.isFile()) return send(res, 404, { error: '파일이 없습니다.' });
  const ext = path.extname(file).toLowerCase();
  const headers = { 'content-type': MIME[ext] ?? 'application/octet-stream', 'content-length': stat.size, 'cache-control': 'no-store' };
  if (download || !['.pdf', '.png', '.txt', '.html', '.js', '.css', '.svg', '.json', '.webm'].includes(ext)) {
    headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name ?? path.basename(file))}`;
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

async function excelPreview(id) {
  const t = await readTable(store.uploadPath(id));
  return { id, headers: t.headers, rowCount: t.rows.length, sample: t.rows.slice(0, 5) };
}

// ---------- 라우트 ----------
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn });

route('GET', '/api/state', () => publicState());

route('GET', '/api/recipes', () => store.listRecipes());
route('GET', '/api/recipes/:id', async ({ p }) => {
  const recipe = await store.getRecipe(p.id);
  return { recipe, problems: recipeProblems(recipe), excelColumns: excelColumnsOf(recipe), prompts: promptVariablesOf(recipe) };
});
route('POST', '/api/recipes', async ({ req }) => {
  const body = await readJson(req);
  const recipe = body.recipe ?? body;
  if (!recipe?.blocks) throw new HttpError(400, '레시피 파일이 아닙니다 (blocks 없음).');
  delete recipe.id; // 가져오기는 항상 새 레시피로
  recipe.name = recipe.name ? `${recipe.name}` : '가져온 레시피';
  const saved = await store.saveRecipe(recipe);
  return { recipe: saved, problems: recipeProblems(saved) };
});
route('PUT', '/api/recipes/:id', async ({ req, p }) => {
  const recipe = await readJson(req);
  if (!recipe?.blocks) throw new HttpError(400, '레시피 형식이 아닙니다.');
  recipe.id = p.id;
  const saved = await store.saveRecipe(recipe);
  return { recipe: saved, problems: recipeProblems(saved), excelColumns: excelColumnsOf(saved), prompts: promptVariablesOf(saved) };
});
route('DELETE', '/api/recipes/:id', async ({ p }) => {
  await store.deleteRecipe(p.id);
  return { ok: true };
});
route('POST', '/api/recipes/:id/duplicate', async ({ p }) => {
  const r = await store.getRecipe(p.id);
  delete r.id;
  delete r.createdAt;
  r.name = `${r.name} (복사본)`;
  return store.saveRecipe(r);
});
route('GET', '/api/recipes/:id/template', async ({ p, res }) => {
  const r = await store.getRecipe(p.id);
  const cols = excelColumnsOf(r);
  if (!cols.length) throw new HttpError(400, '이 레시피는 엑셀 열을 쓰지 않습니다.');
  const file = path.join(os.tmpdir(), `web-rpa-template-${Date.now()}.xlsx`);
  await writeTemplate(cols, file);
  await serveFile(res, file, { download: true, name: `${r.name}_입력양식.xlsx` });
  return undefined;
});
route('POST', '/api/recipes/:id/autolink', async ({ req, p }) => {
  const { uploadId } = await readJson(req);
  const r = await store.getRecipe(p.id);
  const t = await readTable(store.uploadPath(uploadId));
  if (!t.rows.length) throw new HttpError(400, '엑셀에 데이터 행이 없습니다.');
  const { recipe, linked } = autoLinkExcel(r, t.headers, t.rows[0]);
  return { recipe, linked };
});

route('POST', '/api/uploads', async ({ req, url }) => {
  const name = url.searchParams.get('name') || 'upload.xlsx';
  const buf = await readBody(req);
  const id = await store.saveUpload(name, buf);
  return excelPreview(id);
});
route('GET', '/api/uploads/:id', ({ p }) => excelPreview(decodeURIComponent(p.id)));

// ---------- 녹화 ----------
route('POST', '/api/record/start', async ({ req }) => {
  const b = busy();
  if (b) throw new HttpError(409, b);
  const { name, startUrl } = await readJson(req);
  let url;
  try {
    url = new URL(String(startUrl).trim().match(/^https?:\/\//i) ? String(startUrl).trim() : `https://${String(startUrl).trim()}`);
  } catch {
    throw new HttpError(400, '시작 주소가 올바르지 않습니다.');
  }
  const session = new Recorder({ name: name || '새 레시피', startUrl: url.href, ...browserTarget() });
  session.on('change', (s) => broadcast('recording', s));
  session.on('warn', (m) => broadcast('notice', { level: 'warn', message: m }));
  session.on('ended', async () => {
    // 사용자가 녹화 브라우저 창을 닫은 경우: 지금까지 녹화한 내용을 저장한다.
    const saved = await store.saveRecipe(session.recipe);
    broadcast('recording', { state: 'stopped', recipe: saved, savedId: saved.id });
    broadcast('notice', { level: 'info', message: '녹화 브라우저가 닫혀 녹화를 마쳤습니다. 지금까지의 내용을 저장했습니다.' });
  });
  recording = session;
  try {
    await session.start();
  } catch (e) {
    recording = null;
    throw new HttpError(500, e.message);
  }
  return { state: session.state, recipe: session.recipe };
});
route('POST', '/api/record/pause', () => {
  recording?.pause();
  return publicState().recording;
});
route('POST', '/api/record/resume', () => {
  recording?.resume();
  return publicState().recording;
});
route('POST', '/api/record/add-step', async ({ req }) => {
  if (!recording || recording.state === 'stopped') throw new HttpError(409, '녹화 중이 아닙니다.');
  const { step } = await readJson(req);
  await recording.addManualStep(step);
  return publicState().recording;
});
route('POST', '/api/record/remove-step', async ({ req }) => {
  const { id } = await readJson(req);
  recording?.removeStep(id);
  return publicState().recording;
});
route('POST', '/api/record/stop', async () => {
  if (!recording) throw new HttpError(409, '녹화 중이 아닙니다.');
  const recipe = await recording.stop();
  const saved = await store.saveRecipe(recipe);
  broadcast('recording', { state: 'stopped', recipe: saved, savedId: saved.id });
  return { recipe: saved, problems: recipeProblems(saved) };
});

// ---------- 실행 ----------
route('POST', '/api/runs', async ({ req }) => {
  const b = busy();
  if (b) throw new HttpError(409, b);
  const { recipeId, uploadId, params = {}, options = {} } = await readJson(req);
  const recipe = await store.getRecipe(recipeId);
  const problems = recipeProblems(recipe);
  if (problems.length) throw new HttpError(400, `레시피에 고칠 점이 있습니다:\n- ${problems.join('\n- ')}`);
  const excelPath = uploadId ? store.uploadPath(uploadId) : undefined;
  const runId = store.newRunId();
  const runDir = store.runDir(runId);
  const runner = new Runner({
    recipe,
    runId,
    runDir,
    ...browserTarget(),
    excelPath,
    params,
    options: {
      headless: !!options.headless,
      humanPacing: !!options.humanPacing,
      recordVideo: !!options.recordVideo,
      startRow: Number(options.startRow) || 1,
      maxRows: Number(options.maxRows) || undefined,
      onRowError: options.onRowError === 'stop' ? 'stop' : 'skip',
    },
  });
  run = { runner, runId, recipeId, recipeName: recipe.name, progress: null, waiting: null, current: null, row: null };
  const r = run;
  runner.on('log', (e) => broadcast('run-log', { runId, ...e }));
  runner.on('status', (e) => {
    r.waiting = e.status === 'waiting-user' ? e.message : null;
    broadcast('run-status', { runId, status: e.status, message: e.message, report: e.report ? { totals: e.report.totals, status: e.report.status } : undefined });
  });
  runner.on('progress', (e) => {
    r.progress = e;
    broadcast('run-progress', { runId, ...e });
  });
  runner.on('step', (e) => {
    r.current = e;
    broadcast('run-step', { runId, ...e });
  });
  runner.on('row', (e) => {
    r.row = { rowNumber: e.rowNumber, label: e.label, status: e.status };
    broadcast('run-row', { runId, rowNumber: e.rowNumber, label: e.label, status: e.status, error: e.error });
  });
  runner.start().catch((e) => broadcast('notice', { level: 'error', message: `실행 오류: ${e.message}` }));
  return { runId };
});
route('POST', '/api/runs/current/:action', ({ p }) => {
  if (!run) throw new HttpError(409, '진행 중인 실행이 없습니다.');
  const { runner } = run;
  if (p.action === 'pause') runner.pause();
  else if (p.action === 'resume') runner.resume();
  else if (p.action === 'stop') runner.stop();
  else throw new HttpError(400, '알 수 없는 동작');
  return publicState().run;
});
route('GET', '/api/runs', () => store.listRuns());
route('GET', '/api/runs/:id', ({ p }) => store.getRun(p.id));
route('DELETE', '/api/runs/:id', async ({ p }) => {
  if (run?.runId === p.id && !['done', 'failed', 'stopped'].includes(run.runner.status)) throw new HttpError(409, '진행 중인 실행은 지울 수 없습니다.');
  await store.deleteRun(p.id);
  return { ok: true };
});
route('GET', '/api/runs/:id/file', async ({ p, url, res }) => {
  const file = store.runFile(p.id, url.searchParams.get('path'));
  await serveFile(res, file, { download: url.searchParams.get('download') === '1' });
  return undefined;
});
route('POST', '/api/runs/:id/open-folder', ({ p }) => {
  const dir = store.runDir(p.id);
  if (process.platform === 'win32') spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, dir };
});

// ---------- 설정 · AI 도우미 ----------
route('GET', '/api/settings', () => settings.publicView());
route('PUT', '/api/settings', async ({ req }) => settings.update(await readJson(req)));
route('POST', '/api/settings/test-browser', async () => {
  // 설정된 브라우저를 실제로 띄워 버전을 확인한다 (숨김, 빈 페이지).
  const b = busy();
  if (b) throw new HttpError(409, b);
  const t = browserTarget();
  agentTurns += 1; // 시험하는 동안 녹화·실행 시작을 막는다 (같은 프로필)
  let ctx;
  try {
    ctx = await startBrowser({ ...t, headless: true });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const cdp = await ctx.newCDPSession(page);
    const v = await cdp.send('Browser.getVersion');
    return { ok: true, browser: ctx.__channel, product: v.product, userAgent: v.userAgent, profile: profileNameFor(t.browser.id) };
  } catch (e) {
    throw new HttpError(500, e.message);
  } finally {
    await ctx?.close().catch(() => {});
    agentTurns -= 1;
  }
});

route('POST', '/api/agent/turn', async ({ req }) => {
  const { sessionId, recipe, message, allowRisky, previousApplied } = await readJson(req);
  if (!sessionId || !/^[\w-]{6,80}$/.test(sessionId)) throw new HttpError(400, '잘못된 세션입니다.');
  if (!recipe?.blocks) throw new HttpError(400, '레시피가 없습니다.');
  if (!String(message ?? '').trim()) throw new HttpError(400, '요청을 입력해 주세요.');
  for (const [id, s] of agents) if (Date.now() - s.touchedAt > 3600_000) agents.delete(id); // 1시간 지난 대화 정리
  let session = agents.get(sessionId);
  if (!session) {
    session = new AgentSession({ id: sessionId, settings, browserTarget, canObserve: browserBusy, onProgress: (e) => broadcast('agent-progress', e) });
    agents.set(sessionId, session);
  }
  if (session.running) throw new HttpError(409, '이전 요청을 처리하는 중입니다.');
  session.running = true;
  agentTurns += 1;
  try {
    const result = await session.turn({ message: String(message), recipe, allowRisky: !!allowRisky, previousApplied: previousApplied !== false });
    return { ...result, problems: recipeProblems(result.recipe) };
  } catch (e) {
    throw new HttpError(e.status && e.status >= 400 && e.status < 600 ? e.status : 500, e.message);
  } finally {
    session.running = false;
    agentTurns -= 1;
  }
});
route('POST', '/api/agent/reset', async ({ req }) => {
  const { sessionId } = await readJson(req);
  agents.delete(sessionId);
  return { ok: true };
});

route('GET', '/api/events', ({ req, res }) => {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
  return undefined;
});

// ---------- 요청 출처 확인 ----------
// 사용자가 연 다른 웹사이트가 이 로컬 서버에 요청을 보내지 못하게 한다.
//  - 접속 주소(Host)는 IP 주소·localhost·허용한 이름만 받는다.
//  - 브라우저가 출처(Origin)를 보낸 요청은 화면과 같은 주소에서 온 것만 받는다.
function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase().replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
  return net.isIP(host) !== 0 || ALLOWED_HOSTS.has(host);
}
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 브라우저가 아닌 호출(시험 스크립트 등)
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// ---------- 서버 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!hostAllowed(req.headers.host)) return send(res, 403, { error: '허용되지 않은 주소로 접속했습니다. IP 주소나 localhost 로 접속하거나 --allow-host 로 이름을 추가해 주세요.' });
  if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req)) return send(res, 403, { error: '다른 웹사이트에서 보낸 요청은 받지 않습니다.' });
  try {
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const result = await r.fn({ req, res, url, p: m.groups ?? {} });
        if (result !== undefined && !res.headersSent) send(res, 200, result);
        return;
      }
      return send(res, 404, { error: '없는 API 입니다.' });
    }
    // 정적 파일 (SPA)
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.resolve(PUBLIC, `.${rel}`);
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 400, { error: '잘못된 경로' });
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(res, file);
    return serveFile(res, path.join(PUBLIC, 'index.html'));
  } catch (e) {
    const status = e.status ?? 500;
    if (status >= 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`web-rpa 실행 중: http://${HOST}:${PORT}  (작업 폴더: ${store.root})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    run?.runner.stop();
    await recording?.stop().catch(() => {});
    process.exit(0);
  });
}
