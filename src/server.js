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
import { ThreadStore } from './ai/thread.js';
import { secretVariablesOf } from './secrets.js';
import { setDraft, buildSet, inspectSet, publicPreview, installSet, installedSets, readSet, ENGINE_VERSION } from './set/index.js';
import { hubList, hubReadme, resolveHubSet, downloadHubSet } from './set/hub.js';
import { Updater, getLaunchInfo, cleanupUpdates } from './update.js';

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
const secrets = store.secrets;
const threads = new ThreadStore(store.root);
threads.cleanup(); // 30일 넘게 쓰지 않은 AI 대화 정리
store.migrateSecrets().catch((e) => console.warn(`비밀값 옮기기 실패: ${e.message}`));

/** 설정된 브라우저와 그 브라우저 전용 프로필 폴더. */
function browserTarget() {
  const browser = settings.browser;
  return { browser, profileDir: path.join(store.root, 'profiles', profileNameFor(browser.id)) };
}

const SET_BODY_LIMIT = 4 * 1024 * 1024; // .wrset 은 2MB 까지
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.pdf': 'application/pdf', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.webm': 'video/webm' };

// ---------- 상태 ----------
let recording = null; // Recorder
let run = null; // { runner, runId, recipeName, progress, waiting, current }
const clients = new Set();

function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// 새 버전 확인·설치. 실행기(launch.js)가 시작할 때 이미 확인했으면 그 결과를 쓴다.
const updater = new Updater({ workspace: store.root, config: () => settings.updateConfig, onChange: (v) => broadcast('update', v), initial: getLaunchInfo()?.checked });

const agents = new Map(); // recipeId → AgentSession (대화는 레시피 단위)
const sessionAlias = new Map(); // 옛 화면의 sessionId → recipeId
let agentTurns = 0; // 진행 중인 AI 턴 (화면 관찰 브라우저가 같은 프로필을 쓴다)

function agentFor(recipeId) {
  threads.checkId(recipeId);
  let s = agents.get(recipeId);
  if (!s) {
    s = new AgentSession({
      recipeId,
      threads,
      store,
      secrets,
      settings,
      browserTarget,
      canObserve: browserBusy,
      onProgress: (e) => broadcast('agent-progress', e),
      onDelta: (e) => broadcast('agent-delta', e),
    });
    agents.set(recipeId, s);
  }
  return s;
}

/** 녹화·실행·브라우저 시험 전에 열어 둔 관찰 브라우저를 닫는다 (같은 프로필을 두 번 열 수 없다) */
async function closeObservers() {
  await Promise.all([...agents.values()].map((s) => s.closeObserver()));
}

/** 브라우저 프로필을 쓰는 작업(녹화·실행)이 진행 중인지. */
function browserBusy() {
  if (recording && recording.state !== 'stopped') return '녹화가 진행 중입니다. 녹화를 끝낸 뒤 다시 시도해 주세요.';
  if (run && !['done', 'failed', 'stopped'].includes(run.runner.status)) return '실행이 진행 중입니다. 끝나거나 중지한 뒤 다시 시도해 주세요.';
  return null;
}
function busy() {
  return browserBusy() ?? (agentTurns > 0 ? 'AI 도우미가 화면을 확인하는 중입니다. 답변이 끝난 뒤 다시 시도해 주세요.' : null) ?? (updater.installing ? '새 버전을 설치하는 중입니다. 설치가 끝나면 web-rpa 가 다시 열립니다.' : null);
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
    if (size > limit) throw new HttpError(413, `파일이 너무 큽니다 (${Math.round(limit / 1024 / 1024)}MB 제한).`);
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

// ---------- 진행 세트 (.wrset) ----------
/** 이 레시피의 가장 최근 성공 행이 있는 실행 리포트 (기대 결과 초안용) */
async function lastGoodRun(recipeId) {
  for (const r of await store.listRuns()) {
    if (r.recipe?.id !== recipeId || !r.totals?.ok) continue;
    return store.getRun(r.runId).catch(() => null);
  }
  return null;
}
/** 설치 상태를 붙인 미리보기 */
async function previewWithInstall(p, extra = {}) {
  const inst = p.id ? (await installedSets(store))[p.id] : null;
  return { ...publicPreview(p), installed: inst ? { version: inst.version, recipeId: inst.recipeId, uploadId: inst.uploadId, sha256: inst.sha256 } : null, ...extra };
}

route('GET', '/api/recipes/:id/set-draft', async ({ p }) => {
  const recipe = await store.getRecipe(p.id);
  return setDraft(recipe, { runReport: await lastGoodRun(recipe.id) });
});
route('POST', '/api/recipes/:id/set', async ({ req, p, res }) => {
  const body = await readJson(req);
  const recipe = await store.getRecipe(p.id);
  const built = buildSet(recipe, body);
  const { errors, warnings } = built.lint;
  if (body.check) return { ok: !errors.length, errors, warnings, fileName: built.fileName, sha256: built.sha256, size: built.buffer.length, manifest: built.manifest, summary: built.summary };
  if (errors.length) throw new HttpError(400, `세트로 내보낼 수 없습니다:\n- ${errors.join('\n- ')}`);
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-length': built.buffer.length,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(built.fileName)}`,
    'cache-control': 'no-store',
    'x-wrset-sha256': built.sha256,
  });
  res.end(built.buffer);
  return undefined;
});
route('POST', '/api/sets/preview', async ({ req }) => previewWithInstall(inspectSet(await readBody(req, SET_BODY_LIMIT)), { verified: 'file' }));
route('POST', '/api/sets/install', async ({ req }) => {
  const buf = await readBody(req, SET_BODY_LIMIT);
  readSet(buf); // 형식이 아니면 400
  return installSet(store, buf, { source: 'file' });
});
route('GET', '/api/sets/installed', () => installedSets(store));

// ---------- 공개 허브 ----------
route('GET', '/api/hub', async ({ url }) => hubList(settings.hubSources, await installedSets(store), { refresh: url.searchParams.get('refresh') === '1' }));
route('GET', '/api/hub/readme', async ({ url }) => ({ text: await hubReadme(settings.hubSources, { source: url.searchParams.get('source'), id: url.searchParams.get('id') }) }));
/** 허브 세트 내려받기 + sha256·엔진 범위 확인 */
async function hubFetch(body) {
  const { src, set, entry } = await resolveHubSet(settings.hubSources, { source: body.source, id: body.id, version: body.version || undefined });
  const buf = await downloadHubSet(entry);
  const p = inspectSet(buf);
  if (p.id !== set.id || p.version !== entry.version) p.errors.push(`허브 목록(${set.id} ${entry.version})과 세트 안의 manifest(${p.id} ${p.version})가 다릅니다.`);
  return { src, set, entry, buf, p };
}
route('POST', '/api/hub/preview', async ({ req }) => {
  const { src, entry, p } = await hubFetch(await readJson(req));
  return previewWithInstall(p, { verified: 'hub', hub: { source: src.url, sourceName: src.name, version: entry.version, sha256: entry.sha256, url: entry.url, engine: entry.engine, verified: entry.verified } });
});
route('POST', '/api/hub/install', async ({ req }) => {
  const { src, buf, p } = await hubFetch(await readJson(req));
  if (p.errors.length) throw new HttpError(400, `설치할 수 없는 세트입니다:\n- ${p.errors.join('\n- ')}`);
  return installSet(store, buf, { source: src.url });
});

// ---------- 녹화 ----------
route('POST', '/api/record/start', async ({ req }) => {
  const b = busy();
  if (b) throw new HttpError(409, b);
  await closeObservers();
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
  const { recipeId, uploadId, params: given = {}, options = {}, saveSecrets = [] } = await readJson(req);
  const recipe = await store.getRecipe(recipeId);
  const problems = recipeProblems(recipe);
  if (problems.length) throw new HttpError(400, `레시피에 고칠 점이 있습니다:\n- ${problems.join('\n- ')}`);
  const excelPath = uploadId ? store.uploadPath(uploadId) : undefined;
  const params = await secretParams(recipe, given && typeof given === 'object' ? given : {}, saveSecrets);
  await closeObservers();
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
    broadcast('run-status', { runId, recipeId, recipeName: recipe.name, status: e.status, message: e.message, report: e.report ? { totals: e.report.totals, status: e.report.status } : undefined });
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
/** 실행 입력값: 저장하라고 한 비밀값은 저장하고, 비어 있는 비밀값은 저장된 값으로 채운다 */
async function secretParams(recipe, given, saveSecrets) {
  const params = { ...given };
  const vars = secretVariablesOf(recipe);
  if (!vars.length) return params;
  const valueOf = (v) => params[v.id] ?? params[v.name];
  const empty = (x) => x === undefined || x === null || x === '';
  const toSave = {};
  for (const id of Array.isArray(saveSecrets) ? saveSecrets : []) {
    const v = vars.find((x) => x.id === id || x.name === id);
    const val = v ? valueOf(v) : undefined;
    if (v && typeof val === 'string' && val !== '') toSave[v.id] = val;
  }
  if (Object.keys(toSave).length) {
    try {
      await secrets.setMany(recipe.id, toSave);
    } catch (e) {
      broadcast('notice', { level: 'warn', message: `비밀값을 저장하지 못했습니다: ${e.message}` });
    }
  }
  if (vars.some((v) => empty(valueOf(v)))) {
    const saved = await secrets.getAll(recipe.id).catch(() => ({}));
    for (const v of vars) if (empty(valueOf(v)) && saved[v.id]) params[v.id] = saved[v.id];
  }
  return params;
}

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
  await closeObservers();
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

// ---------- 새 버전 (업데이트) ----------
route('GET', '/api/update', () => updater.view());
route('POST', '/api/update/check', () => updater.check());
route('POST', '/api/update/install', async ({ res }) => {
  let plan;
  try {
    plan = await updater.prepareInstall({ busy, relaunch: relaunchCommand() });
  } catch (e) {
    send(res, e.status ?? 500, { error: e.message, code: e.code ?? null });
    return undefined;
  }
  // 응답을 보낸 뒤에 대기 스크립트를 띄우고 끝낸다 (실행 중인 node.exe 는 설치 파일이 바꿀 수 없다)
  res.on('finish', async () => {
    try {
      await closeObservers();
      const r = await updater.apply(plan);
      if (r.dryRun) return;
      console.log(`새 버전 ${plan.to} 을(를) 설치합니다. 설치가 끝나면 web-rpa 가 다시 열립니다.`);
      setTimeout(() => process.exit(0), 300);
    } catch (e) {
      console.error(`업데이트를 시작하지 못했습니다: ${e.message}`);
    }
  });
  return { ok: true, version: plan.to, from: plan.from, dryRun: !!process.env.WEB_RPA_UPDATE_DRYRUN };
});
/** 설치가 끝난 뒤 다시 띄울 명령: 실행기가 남긴 원래 인자 + --no-open (화면은 지금 열린 탭이 새로 고친다) */
function relaunchCommand() {
  const info = getLaunchInfo();
  const base = info ?? { file: process.execPath, args: [path.join(ROOT, 'src', 'launch.js'), '--port', String(PORT), '--workspace', store.root], cwd: ROOT, hidden: !process.stdout.isTTY };
  return { ...base, args: base.args.includes('--no-open') ? base.args : [...base.args, '--no-open'] };
}

// ---------- AI 도우미 대화 (레시피 단위, 파일로 남는다) ----------
const recipeIdOf = (v) => {
  const id = typeof v === 'string' ? v : '';
  if (!/^[\w-]{1,80}$/.test(id)) throw new HttpError(400, '잘못된 레시피 id 입니다.');
  return id;
};
const idle = (session) => {
  if (session.running) throw new HttpError(409, '이 레시피의 AI 요청을 처리하는 중입니다. 답변이 끝난 뒤 다시 시도해 주세요.');
  return session;
};

route('GET', '/api/agent/thread', ({ url }) => agentFor(recipeIdOf(url.searchParams.get('recipeId'))).view());

route('POST', '/api/agent/turn', async ({ req }) => {
  const body = await readJson(req);
  const { sessionId, recipe, message, context, allowRisky, previousApplied } = body;
  // 옛 화면: sessionId 만 보낸다 → 레시피 id 로 대화를 찾는다
  const legacy = !body.recipeId;
  if (legacy && (!sessionId || !/^[\w-]{6,80}$/.test(sessionId))) throw new HttpError(400, '잘못된 세션입니다.');
  if (!recipe?.blocks) throw new HttpError(400, '레시피가 없습니다.');
  if (!String(message ?? '').trim()) throw new HttpError(400, '요청을 입력해 주세요.');
  const recipeId = recipeIdOf(body.recipeId ?? recipe.id ?? sessionId);
  if (legacy) sessionAlias.set(sessionId, recipeId);
  const session = idle(agentFor(recipeId));
  session.running = true;
  agentTurns += 1;
  try {
    return await session.turn({ message: String(message), recipe, context, allowRisky: !!allowRisky, legacy, sessionId, previousApplied: previousApplied !== false });
  } catch (e) {
    throw new HttpError(e.status && e.status >= 400 && e.status < 600 ? e.status : 500, e.message);
  } finally {
    session.running = false;
    agentTurns -= 1;
    broadcast('agent-done', { recipeId, sessionId: session.sessionId });
  }
});

route('POST', '/api/agent/pending', async ({ req }) => {
  const { recipeId: rid, action, save } = await readJson(req);
  const recipeId = recipeIdOf(rid);
  const session = idle(agentFor(recipeId));
  const pending = session.thread.pending;
  if (!pending) throw new HttpError(409, '대기 중인 AI 제안이 없습니다.');
  if (action === 'discard') {
    session.settlePending('discard');
    return { ok: true };
  }
  if (action !== 'apply') throw new HttpError(400, 'action 은 apply 또는 discard 입니다.');
  let recipe = structuredClone(pending.recipe);
  if (save) {
    await store.getRecipe(recipeId); // 없는 레시피면 404
    recipe = await store.saveRecipe({ ...recipe, id: recipeId });
  }
  session.settlePending('apply');
  return { recipe, problems: recipeProblems(recipe) };
});

route('DELETE', '/api/agent/thread', ({ url }) => {
  idle(agentFor(recipeIdOf(url.searchParams.get('recipeId')))).clear();
  return { ok: true };
});

route('PUT', '/api/agent/notes', async ({ req }) => {
  const { recipeId, text } = await readJson(req);
  return { ok: true, notes: threads.setNotes(recipeIdOf(recipeId), text) };
});

// 옛 화면의 [새 대화]: 그 레시피 대화를 지운다
route('POST', '/api/agent/reset', async ({ req }) => {
  const { sessionId } = await readJson(req);
  const recipeId = sessionAlias.get(sessionId) ?? (threads.exists(sessionId) ? sessionId : null);
  sessionAlias.delete(sessionId);
  const session = recipeId ? agents.get(recipeId) ?? agentFor(recipeId) : null;
  if (session && !session.running) session.clear();
  return { ok: true };
});

// ---------- 비밀값 (이 PC 에만, Windows 계정으로 암호화) ----------
async function secretVar(recipeId, varId) {
  const recipe = await store.getRecipe(recipeId);
  const name = decodeURIComponent(varId);
  const v = secretVariablesOf(recipe).find((x) => x.id === name || x.name === name);
  if (!v) throw new HttpError(404, `비밀 변수 "${name}" 이(가) 이 레시피에 없습니다.`);
  return v;
}
route('GET', '/api/recipes/:id/secrets', async ({ p }) => {
  const recipe = await store.getRecipe(p.id);
  const saved = secrets.savedOf(recipe.id);
  return secretVariablesOf(recipe).map((v) => ({ varId: v.id, name: v.name ?? v.id, saved: Object.hasOwn(saved, v.id), savedAt: saved[v.id] ?? null }));
});
route('PUT', '/api/recipes/:id/secrets/:varId', async ({ req, p }) => {
  const v = await secretVar(p.id, p.varId);
  const { value } = await readJson(req);
  if (typeof value !== 'string' || !value) throw new HttpError(400, '저장할 값을 입력해 주세요.');
  if (!secrets.available) throw new HttpError(400, secrets.unavailableReason);
  await secrets.set(p.id, v.id, value);
  return { ok: true, varId: v.id, saved: true, savedAt: secrets.savedOf(p.id)[v.id] ?? null };
});
route('DELETE', '/api/recipes/:id/secrets/:varId', async ({ p }) => {
  const v = await secretVar(p.id, p.varId);
  secrets.delete(p.id, v.id);
  return { ok: true, varId: v.id, saved: false };
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
  console.log(`web-rpa ${ENGINE_VERSION} 실행 중: http://${HOST}:${PORT}  (작업 폴더: ${store.root})`);
  // 새 버전 확인은 시작을 막지 않는다 (실패는 상태에만 남는다)
  cleanupUpdates(store.root).catch(() => {});
  if (updater.enabled && !updater.checkedAt) updater.check().catch(() => {});
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    run?.runner.stop();
    await recording?.stop().catch(() => {});
    await closeObservers();
    process.exit(0);
  });
}
