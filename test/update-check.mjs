// 업데이트 점검 (설치는 하지 않는다 — 실제 설치·재시작은 node scripts/package-win.mjs --installer --smoke --upgrade).
//   1. 단위: 버전 비교, 주소·피드 형식 거절, 서명 OK/불일치/없음, 다운그레이드, sha256·크기, 피드 상한·시간 제한, 설치 형태, 설정 기본값, 대기 스크립트
//   2. 가짜 피드 + dry-run 서버: API·SSE, 작업 중 거절, 서명·sha256 거절, 계획 명령줄(/SILENT·/DIR=·launch.js), 피드 없음, 압축본·소스
//   3. 실행기(launch.js): 시작할 때 자동 설치(dry-run) · 끄면 그냥 실행 · 실패해도 실행 · 이미 실행 중이면 확인 안 함
//   4. 화면: 배너(모든 화면 위)·닫기·설정 카드·설치 중 문구·압축본 안내·390px
// 실행: node test/update-check.mjs   (포트 4970–4974, 출력 test/out-update/ — 끝나면 지운다. KEEP_OUT=1 이면 남긴다)

import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import * as U from '../src/update.js';
import { Settings } from '../src/settings.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'test', 'out-update');
const SHOTS = path.join(OUT, 'shots');
const P = { feed: 4970, inst: 4971, portable: 4972, launch: 4973, other: 4974 };
const FEED = `http://127.0.0.1:${P.feed}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 결과 ----------
let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  return !!ok;
}
const section = (t) => console.log(`\n==================== ${t}`);
const errorOf = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
};
const rejection = (p) => p.then(() => null, (e) => e);
const exists = (p) => fss.existsSync(p);

// ---------- 버전·키·가짜 설치 파일 ----------
const CUR = U.CURRENT_VERSION;
const [maj, min] = CUR.split('.').map(Number);
const NEXT = `${maj}.${min + 1}.0`;
const OLD = '0.0.1';
const KEY = crypto.generateKeyPairSync('ed25519');
const OTHER = crypto.generateKeyPairSync('ed25519');
const PUB = U.publicKeyOf(KEY.publicKey);
const SETUP = crypto.randomBytes(256 * 1024);
const TAMPERED = Buffer.from(SETUP);
TAMPERED[1000] ^= 0xff;
const SHA = crypto.createHash('sha256').update(SETUP).digest('hex');
const SIZE = SETUP.length;
const NOTES = `${FEED}/notes/v${NEXT}`;

/** 피드 만들기: 기본은 NEXT 버전, 시험 키로 서명 */
function feedOf({ version = NEXT, url = `${FEED}/files/setup.exe`, sha256 = SHA, size = SIZE, key = KEY.privateKey, signFor = version, signature, extra = {} } = {}) {
  const installer = { url, sha256, size };
  if (signature !== null) installer.signature = signature ?? U.signEntry(key, signFor, { sha256, size });
  return { format: 'web-rpa-update', formatVersion: 1, version, publishedAt: '2026-10-22T00:00:00Z', notesUrl: NOTES, installer, zip: { url: `${FEED}/files/app.zip`, sha256: SHA, size: SIZE }, ...extra };
}
const FEEDS = {
  ok: () => feedOf(),
  badsig: () => feedOf({ key: OTHER.privateKey }),
  nosig: () => feedOf({ signature: null }),
  tampered: () => feedOf({ url: `${FEED}/files/tampered.exe` }),
  bigger: () => feedOf({ url: `${FEED}/files/bigger.exe` }),
  same: () => feedOf({ version: CUR }),
  old: () => feedOf({ version: OLD }),
  replay: () => feedOf({ signFor: OLD }), // 옛 버전에 한 서명을 새 버전인 척
};
let dyn = 'ok'; // /dyn/latest.json 이 내는 피드
let feedHits = 0;

function startFeedServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, FEED);
    const json = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const m = /^\/(\w+)\/latest\.json$/.exec(url.pathname);
    if (m) {
      feedHits += 1;
      const name = m[1] === 'dyn' ? dyn : m[1];
      if (name === 'big') return json({ ...feedOf(), pad: 'x'.repeat(70 * 1024) });
      if (name === 'slow') {
        await sleep(3000);
        return json(feedOf());
      }
      if (name === 'notjson') return res.end('<html>nope</html>');
      if (!FEEDS[name]) return json({ error: 'not found' }, 404);
      return json(FEEDS[name]());
    }
    if (url.pathname === '/files/setup.exe') return res.end(SETUP);
    if (url.pathname === '/files/tampered.exe') return res.end(TAMPERED);
    if (url.pathname === '/files/bigger.exe') return res.end(Buffer.concat([SETUP, Buffer.alloc(10)]));
    if (url.pathname === '/page.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><title>바쁜 페이지</title><p>잠시 기다립니다</p>');
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((r) => server.listen(P.feed, '127.0.0.1', () => r(server)));
}

// ---------- web-rpa 서버·실행기 ----------
const baseEnv = () => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('WEB_RPA_UPDATE_')) delete env[k];
  return env;
};
const procs = [];
function startProc(args, env, { port }) {
  const proc = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env });
  proc.out = '';
  proc.stdout.on('data', (d) => (proc.out += d));
  proc.stderr.on('data', (d) => (proc.out += d));
  proc.exited = new Promise((r) => proc.on('exit', (code) => r(code)));
  proc.port = port;
  procs.push(proc);
  return proc;
}
async function waitUp(port, ms = 15000) {
  for (let t = Date.now(); Date.now() - t < ms; ) {
    const ok = await fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.ok, () => false);
    if (ok) return true;
    await sleep(150);
  }
  return false;
}
async function stopProc(proc) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill();
  await Promise.race([proc.exited, sleep(5000)]);
}
async function api(port, method, url, body) {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}
async function waitFor(fn, ms = 10000, step = 150) {
  for (let t = Date.now(); Date.now() - t < ms; ) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}
/** SSE 듣기: 받은 이벤트를 쌓아 둔다 */
function listen(port) {
  const events = [];
  let buf = '';
  const req = http.get(`http://127.0.0.1:${port}/api/events`, (res) => {
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const type = /^event: (.+)$/m.exec(chunk)?.[1];
        const data = /^data: (.+)$/m.exec(chunk)?.[1];
        if (type) events.push({ type, data: data ? JSON.parse(data) : null });
      }
    });
  });
  req.on('error', () => {});
  return { events, close: () => req.destroy() };
}
async function serverFor(name, port, extraEnv, { settings } = {}) {
  const ws = path.join(OUT, `ws-${name}`);
  await fs.rm(ws, { recursive: true, force: true });
  await fs.mkdir(ws, { recursive: true });
  if (settings) await fs.writeFile(path.join(ws, 'settings.json'), JSON.stringify(settings));
  const proc = startProc(['src/server.js', '--port', String(port), '--workspace', ws], { ...baseEnv(), ...extraEnv }, { port });
  proc.ws = ws;
  if (!(await waitUp(port))) throw new Error(`${name} 서버가 뜨지 않았습니다:\n${proc.out}`);
  return proc;
}

// =====================================================================
async function unitChecks() {
  section('1. 단위: 버전·주소·피드 형식');
  check(
    '버전 비교: 더 높을 때만 새 버전 (같거나 낮으면 아님)',
    U.isNewer(NEXT, CUR) && !U.isNewer(CUR, CUR) && !U.isNewer(OLD, CUR) && U.isNewer('1.10.0', '1.9.0') && !U.isNewer('1.9.0', '1.10.0') && !U.isNewer('x.y.z', CUR) && !U.isNewer('1.0', '0.1.0'),
  );
  const urlBad = ['http://example.com/latest.json', 'ftp://example.com/x', 'javascript:alert(1)', 'file:///C:/x.json', ''].map((u) => errorOf(() => U.checkUpdateUrl(u)));
  const urlOk = ['https://example.com/latest.json', 'http://127.0.0.1:4970/x', 'http://localhost/x'].map((u) => errorOf(() => U.checkUpdateUrl(u)));
  check('주소: https 와 이 PC 안의 http 만 허용 (바깥 http·ftp·javascript·file 거절)', urlBad.every((e) => e?.code === 'url') && urlOk.every((e) => e === null), JSON.stringify(urlBad.map((e) => e?.message)));

  const norm = (raw, url = `${FEED}/x/latest.json`) => errorOf(() => U.normalizeFeed(raw, url));
  check('피드 형식: format 이 다르면 거절', norm({ ...feedOf(), format: 'web-rpa-hub-index' })?.code === 'format');
  check('피드 형식: formatVersion 2 는 거절', norm({ ...feedOf(), formatVersion: 2 })?.code === 'format');
  check('피드 형식: version 이 세 자리 버전이 아니면 거절', norm({ ...feedOf(), version: '1.0' })?.code === 'format' && norm({ ...feedOf(), version: 'latest' })?.code === 'format');
  check('피드 형식: 설치 파일 주소가 바깥 http 면 거절', norm(feedOf({ url: 'http://example.com/setup.exe' }))?.code === 'url');
  check('피드 형식: sha256 형식이 틀리면 거절', norm(feedOf({ sha256: 'abc' }))?.code === 'format');
  check('피드 형식: 설치 파일 크기 300MB 초과 거절', norm(feedOf({ size: 301 * 1024 * 1024 }))?.code === 'size' && norm(feedOf({ size: -1 }))?.code === 'format');
  check('피드 형식: 설치 파일 정보가 없으면 거절', norm({ ...feedOf(), installer: undefined })?.code === 'format');
  const f = U.normalizeFeed({ ...feedOf({ url: '../files/setup.exe' }), notesUrl: 'javascript:alert(1)', evil: { a: 1 }, installer: { ...feedOf({ url: '../files/setup.exe' }).installer, extra: 'x' } }, `${FEED}/x/latest.json`);
  check(
    '피드 형식: 모르는 칸은 버리고, 상대 주소는 피드 기준 절대 주소로, notesUrl 은 https 만',
    f.installer.url === `${FEED}/files/setup.exe` && !('evil' in f) && !('extra' in f.installer) && f.notesUrl === null && f.version === NEXT,
    JSON.stringify(f),
  );

  section('1. 단위: 서명·다운그레이드');
  const ok = U.normalizeFeed(feedOf(), FEED);
  check('서명 OK (버전·sha256·크기 묶음)', U.verifyEntry(NEXT, ok.installer, [PUB]) === 'ok');
  const bad = U.normalizeFeed(FEEDS.badsig(), FEED);
  const changedSha = { ...ok.installer, sha256: crypto.createHash('sha256').update(TAMPERED).digest('hex') };
  const changedSize = { ...ok.installer, size: SIZE + 1 };
  const dir = path.join(OUT, 'dl');
  const sigErr = await rejection(U.downloadSetup(bad, { dir, keys: [PUB] }));
  check(
    '서명 불일치 거절',
    U.verifyEntry(NEXT, bad.installer, [PUB]) === 'bad' && U.verifyEntry(NEXT, changedSha, [PUB]) === 'bad' && U.verifyEntry(NEXT, changedSize, [PUB]) === 'bad' && sigErr?.code === 'signature' && !exists(path.join(dir, `web-rpa-setup-${NEXT}.exe`)),
    sigErr?.message,
  );
  check('서명: 앱 속 공개 키(시험 키 아님)로는 시험 서명이 맞지 않음', U.verifyEntry(NEXT, ok.installer, U.PUBLIC_KEYS) === 'bad' && U.PUBLIC_KEYS.length >= 1);
  const nosig = U.normalizeFeed(FEEDS.nosig(), FEED);
  const noSigErr = await rejection(U.downloadSetup(nosig, { dir, keys: [PUB] }));
  check('서명 없음: 자동 설치하지 않음 (내려받기 페이지 안내)', U.verifyEntry(NEXT, nosig.installer, [PUB]) === 'missing' && noSigErr?.code === 'signature' && /서명이 없어/.test(noSigErr.message), noSigErr?.message);
  const downErr = await rejection(U.downloadSetup(U.normalizeFeed(FEEDS.old(), FEED), { dir, keys: [PUB] }));
  const sameErr = await rejection(U.downloadSetup(U.normalizeFeed(FEEDS.same(), FEED), { dir, keys: [PUB] }));
  const replay = U.normalizeFeed(FEEDS.replay(), FEED);
  check('다운그레이드 거절 (낮은·같은 버전, 옛 버전 서명을 새 버전인 척)', downErr?.code === 'downgrade' && sameErr?.code === 'downgrade' && U.verifyEntry(NEXT, replay.installer, [PUB]) === 'bad', `${downErr?.message} / ${sameErr?.message}`);

  section('1. 단위: 내려받기·피드 받기');
  const shaErr = await rejection(U.downloadSetup(U.normalizeFeed(FEEDS.tampered(), FEED), { dir, keys: [PUB] }));
  const left = await fs.readdir(dir).catch(() => []);
  check('sha256 불일치 거절', shaErr?.code === 'sha256' && !left.length, `${shaErr?.message} / 남은 파일 ${left.join(',')}`); // 받은 파일도 지운다
  const sizeErr = await rejection(U.downloadSetup(U.normalizeFeed(FEEDS.bigger(), FEED), { dir, keys: [PUB] }));
  const limitErr = await rejection(U.downloadSetup(ok, { dir, keys: [PUB], maxBytes: 1024 }));
  check('크기 초과 거절 (피드보다 큰 파일·상한 초과, 받은 파일 지움)', sizeErr?.code === 'size' && limitErr?.code === 'size' && !(await fs.readdir(dir).catch(() => [])).length, `${sizeErr?.message} / ${limitErr?.message}`);
  let progress = 0;
  const dl = await U.downloadSetup(ok, { dir, keys: [PUB], onProgress: (p) => (progress = p.received) });
  const dlSha = crypto.createHash('sha256').update(await fs.readFile(dl.file)).digest('hex');
  const again = await U.downloadSetup(ok, { dir, keys: [PUB] });
  check('내려받기: 크기·sha256·서명이 맞으면 파일, 진행률, 다시 부르면 받아 둔 파일을 씀', dlSha === SHA && dl.size === SIZE && progress === SIZE && !dl.reused && again.reused && path.basename(dl.file) === `web-rpa-setup-${NEXT}.exe`);
  const big = await rejection(U.fetchFeed(`${FEED}/big/latest.json`));
  const notJson = await rejection(U.fetchFeed(`${FEED}/notjson/latest.json`));
  check('피드 받기: 64KB 를 넘거나 JSON 이 아니면 거절', big?.code === 'size' && notJson?.code === 'format', `${big?.message} / ${notJson?.message}`);
  const t0 = Date.now();
  const slow = await rejection(U.fetchFeed(`${FEED}/slow/latest.json`, { timeoutMs: 800 }));
  check('피드 받기: 제한 시간 안에 응답이 없으면 넘어감 (기본 5초)', slow?.code === 'network' && Date.now() - t0 < 2500 && U.FEED_TIMEOUT_MS === 5000, slow?.message);
  const missing = await rejection(U.fetchFeed(`${FEED}/nothing/latest.json`));
  check('피드 받기: 404 는 not-found', missing?.code === 'not-found', missing?.message);

  section('1. 단위: 설치 형태·설정·대기 스크립트');
  const kinds = {};
  for (const [name, files] of Object.entries({ installer: ['node/node.exe', 'unins000.exe'], portable: ['node/node.exe'], source: [] })) {
    const base = path.join(OUT, 'kind', name);
    await fs.mkdir(path.join(base, 'app'), { recursive: true });
    for (const f2 of files) {
      await fs.mkdir(path.dirname(path.join(base, f2)), { recursive: true });
      await fs.writeFile(path.join(base, f2), '');
    }
    kinds[name] = U.installKind(path.join(base, 'app'));
  }
  process.env.WEB_RPA_UPDATE_KIND = 'portable';
  const forced = U.installKind(path.join(OUT, 'kind', 'installer', 'app'));
  delete process.env.WEB_RPA_UPDATE_KIND;
  check('설치 형태 판별: unins000.exe+node → installer, node 만 → portable, 그 밖 → source (환경 변수로 바꿈)', kinds.installer === 'installer' && kinds.portable === 'portable' && kinds.source === 'source' && forced === 'portable' && U.installKind() === 'source', JSON.stringify(kinds));

  const sdir = path.join(OUT, 'settings');
  await fs.mkdir(sdir, { recursive: true });
  const s = new Settings(sdir);
  const view = s.publicView().update;
  check('자동 설치 기본값 켜짐', s.updateConfig.auto === true && s.updateConfig.check === true && view.auto === true && view.check === true && view.feedUrl === '' && view.feedDefault === U.DEFAULT_FEED_URL && U.UPDATE_DEFAULTS.auto === true, JSON.stringify(view));
  check('피드 기본값: GitHub 최신 릴리스의 latest.json', U.DEFAULT_FEED_URL === 'https://github.com/Tak002/web-rpa/releases/latest/download/latest.json');
  const httpErr = errorOf(() => s.update({ update: { feedUrl: 'http://example.com/latest.json' } }));
  const typeErr = errorOf(() => s.update({ update: { auto: 'yes' } }));
  s.update({ update: { auto: false, feedUrl: 'https://example.com/feed/latest.json' } });
  const s2 = new Settings(sdir);
  s2.update({ update: { feedUrl: '' } });
  check(
    '설정: 바깥 http 피드·잘못된 값은 400, 끄기·피드 주소는 저장, 빈 값은 기본 피드',
    httpErr?.status === 400 && typeErr?.status === 400 && s2.updateConfig.auto === false && new Settings(sdir).updateConfig.feedUrl === '' && U.feedUrlOf(new Settings(sdir).updateConfig) === U.DEFAULT_FEED_URL,
    `${httpErr?.message} / ${JSON.stringify(s2.updateConfig)}`,
  );

  const plan = U.updatePlan({ setup: 'C:\\임시 폴더\\web-rpa-setup-9.9.9.exe', version: '9.9.9', workspace: 'C:\\작업 폴더', relaunch: { file: 'C:\\앱\\node\\node.exe', args: ['C:\\앱\\app\\src\\launch.js', '--port', '4800', '--workspace', 'C:\\작업 폴더'], cwd: 'C:\\앱\\app' }, appDir: 'C:\\앱', pid: 1234 });
  const script = U.waitScript(plan);
  check(
    '대기 스크립트: PID 종료 대기 → /SILENT·/DIR="…"·/LOG 로 설치 → launch.js 다시 실행 → 기록',
    /Get-Process -Id 1234/.test(script) && /WaitForExit\(60000\)/.test(script) && /\/SILENT \/SUPPRESSMSGBOXES \/NORESTART \/CLOSEAPPLICATIONS \/DIR="C:\\앱" \/LOG="C:\\작업 폴더\\updates\\setup-9\.9\.9\.log"/.test(script) && /launch\.js --port 4800 --workspace "C:\\작업 폴더"/.test(script) && /update-log\.txt/.test(script),
    script,
  );
  const upd = path.join(OUT, 'cleanup', 'updates');
  await fs.mkdir(upd, { recursive: true });
  for (const n of [`web-rpa-setup-${OLD}.exe`, `web-rpa-setup-${CUR}.exe`, `web-rpa-setup-${NEXT}.exe`, `web-rpa-setup-${NEXT}.exe.part`, 'update-log.txt']) await fs.writeFile(path.join(upd, n), 'x');
  await U.cleanupUpdates(path.join(OUT, 'cleanup'));
  check('받아 둔 설치 파일 정리: 지금 버전 이하·덜 받은 파일만 지우고 로그는 남김', (await fs.readdir(upd)).sort().join(',') === [`web-rpa-setup-${NEXT}.exe`, 'update-log.txt'].sort().join(','), (await fs.readdir(upd)).join(','));
}

// =====================================================================
async function serverChecks() {
  section('2. 서버: 가짜 피드 + dry-run (설치본으로 가정)');
  const planFile = path.join(OUT, 'plan-server.json');
  const env = { WEB_RPA_UPDATE_URL: `${FEED}/dyn/latest.json`, WEB_RPA_UPDATE_PUBKEY: PUB, WEB_RPA_UPDATE_KIND: 'installer', WEB_RPA_UPDATE_DRYRUN: planFile };
  dyn = 'ok';
  const srv = await serverFor('inst', P.inst, env);
  const v0 = await waitFor(async () => {
    const r = await api(P.inst, 'GET', '/api/update');
    return r.data?.checkedAt && !r.data.checking ? r.data : null;
  });
  check('서버: 시작한 뒤 비동기로 확인 → 새 버전 available·설치 가능', v0?.available === true && v0.installable === true && v0.latest?.version === NEXT && v0.current === CUR && v0.kind === 'installer' && v0.signature === 'ok', JSON.stringify(v0));
  const keys = ['current', 'kind', 'enabled', 'checking', 'checkedAt', 'latest', 'available', 'error', 'installing'];
  check('서버: GET /api/update 칸 (current·kind·enabled·checking·checkedAt·latest·available·error·installing)', v0 && keys.every((k) => k in v0) && v0.enabled === true && v0.installing === null && v0.error === null);

  const sse = listen(P.inst);
  await sleep(300);
  const c1 = await api(P.inst, 'POST', '/api/update/check');
  const ev = await waitFor(() => sse.events.find((e) => e.type === 'update' && e.data?.checking === false && e.data?.available), 3000);
  check('서버: POST /api/update/check → SSE update 이벤트', c1.ok && c1.data.available && !!ev, JSON.stringify(sse.events.map((e) => e.type)));

  // 작업 중(실행 중)이면 설치하지 않는다
  const recipe = { schemaVersion: 1, name: '업데이트 시험 — 바쁜 레시피', startUrl: `${FEED}/page.html`, entryBlock: 'main', variables: [], blocks: { main: [{ id: 's1', type: 'navigate', url: `${FEED}/page.html` }, { id: 's2', type: 'sleep', ms: 20000 }] } };
  const saved = await api(P.inst, 'POST', '/api/recipes', recipe);
  const runStart = await api(P.inst, 'POST', '/api/runs', { recipeId: saved.data?.recipe?.id, options: { headless: true } });
  await waitFor(async () => (await api(P.inst, 'GET', '/api/state')).data?.run?.status === 'running', 15000);
  const busyRes = await api(P.inst, 'POST', '/api/update/install');
  check('작업 중 설치 거절', runStart.ok && busyRes.status === 409 && busyRes.data?.code === 'busy' && /실행이 진행 중/.test(busyRes.data?.error) && !exists(planFile), `${runStart.data?.error ?? ''} / ${busyRes.status} ${busyRes.data?.error}`);
  await api(P.inst, 'POST', '/api/runs/current/stop');
  await waitFor(async () => ['done', 'failed', 'stopped'].includes((await api(P.inst, 'GET', '/api/state')).data?.run?.status), 20000);

  dyn = 'badsig';
  const vb = (await api(P.inst, 'POST', '/api/update/check')).data;
  const rb = await api(P.inst, 'POST', '/api/update/install');
  check('서버: 서명이 틀리면 설치 거절 (400, 배너는 내려받기 안내로)', vb.available && vb.signature === 'bad' && !vb.installable && rb.status === 400 && rb.data?.code === 'signature' && !exists(planFile), `${rb.status} ${rb.data?.error}`);

  dyn = 'tampered';
  await api(P.inst, 'POST', '/api/update/check');
  const rt = await api(P.inst, 'POST', '/api/update/install');
  const updFiles = await fs.readdir(path.join(srv.ws, 'updates')).catch(() => []);
  const vt = (await api(P.inst, 'GET', '/api/update')).data;
  check('서버: sha256 이 다르면 설치 거절·받은 파일 지움·오류를 상태에 남김', rt.status === 400 && rt.data?.code === 'sha256' && !updFiles.some((n) => n.endsWith('.exe') || n.endsWith('.part')) && vt.installError?.code === 'sha256' && vt.installing === null && !exists(planFile), `${rt.status} ${rt.data?.error} / ${updFiles.join(',')}`);

  dyn = 'ok';
  await api(P.inst, 'POST', '/api/update/check');
  const ri = await api(P.inst, 'POST', '/api/update/install');
  const plan = await waitFor(async () => (exists(planFile) ? JSON.parse(await fs.readFile(planFile, 'utf8')) : null), 5000);
  const relaunch = plan?.relaunch ?? {};
  const setupSha = plan?.setup && exists(plan.setup) ? crypto.createHash('sha256').update(await fs.readFile(plan.setup)).digest('hex') : null;
  check(
    '서버: 설치 → 계획 명령줄 (/SILENT·/SUPPRESSMSGBOXES·/NORESTART·/CLOSEAPPLICATIONS·/DIR=·/LOG=)',
    ri.ok && ri.data?.dryRun && plan && ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS'].every((a) => plan.args.includes(a)) && plan.args.includes(`/DIR=${path.dirname(ROOT)}`) && plan.args.some((a) => a.startsWith('/LOG=') && a.endsWith(`setup-${NEXT}.log`)),
    JSON.stringify(plan?.args),
  );
  check(
    '서버: 계획 — 검증한 설치 파일, 이 서버 PID, launch.js 를 같은 포트·작업 폴더·--no-open 으로 다시 실행',
    setupSha === SHA && plan.pid === srv.pid && relaunch.file === process.execPath && /launch\.js$/.test(relaunch.args?.[0] ?? '') && relaunch.args.includes('--no-open') && relaunch.args.join(' ').includes(`--port ${P.inst}`) && relaunch.args.includes(srv.ws) && plan.from === CUR && plan.to === NEXT,
    JSON.stringify(plan),
  );
  const alive = await api(P.inst, 'GET', '/api/state');
  const vAfter = (await api(P.inst, 'GET', '/api/update')).data;
  check('서버: dry-run 이면 끝나지 않고 계속 돈다 (installing 비움)', alive.ok && vAfter.installing === null && srv.exitCode === null);
  await fs.rm(planFile, { force: true });

  const noticeBefore = sse.events.filter((e) => e.type === 'notice').length;
  dyn = 'missing';
  const vm = (await api(P.inst, 'POST', '/api/update/check')).data;
  const stillUp = await api(P.inst, 'GET', '/api/state');
  check('피드 없음은 조용히 넘어감', vm.available === false && vm.errorCode === 'not-found' && vm.latest === null && stillUp.ok && sse.events.filter((e) => e.type === 'notice').length === noticeBefore, JSON.stringify(vm));

  dyn = 'same';
  const vs = (await api(P.inst, 'POST', '/api/update/check')).data;
  const rs = await api(P.inst, 'POST', '/api/update/install');
  dyn = 'old';
  const vo = (await api(P.inst, 'POST', '/api/update/check')).data;
  check('같은 버전·낮은 버전 피드는 새 버전이 아님 (설치 409)', vs.available === false && vo.available === false && rs.status === 409 && rs.data?.code === 'downgrade', `${rs.status} ${rs.data?.error}`);
  dyn = 'ok';
  await api(P.inst, 'POST', '/api/update/check');
  sse.close();

  section('2. 서버: 압축본·소스·시작할 때 확인 끔');
  const port = await serverFor('portable', P.portable, { ...env, WEB_RPA_UPDATE_KIND: 'portable', WEB_RPA_UPDATE_DRYRUN: path.join(OUT, 'plan-portable.json') });
  const vp = await waitFor(async () => {
    const r = (await api(P.portable, 'GET', '/api/update')).data;
    return r?.checkedAt && !r.checking ? r : null;
  });
  const rp = await api(P.portable, 'POST', '/api/update/install');
  check('압축본은 설치 대신 내려받기 안내', vp?.available && vp.kind === 'portable' && !vp.installable && vp.downloadUrl === NOTES && rp.status === 400 && rp.data?.code === 'kind' && /압축본/.test(rp.data?.error) && !exists(path.join(OUT, 'plan-portable.json')), `${rp.status} ${rp.data?.error}`);

  const src = await serverFor('source', P.other, {});
  await sleep(500);
  const vsrc = (await api(P.other, 'GET', '/api/update')).data;
  const csrc = (await api(P.other, 'POST', '/api/update/check')).data;
  check('소스에서 실행하면 확인하지 않음 (피드 환경 변수가 없을 때)', vsrc.kind === 'source' && vsrc.canCheck === false && vsrc.enabled === false && vsrc.checkedAt === null && csrc.checkedAt === null);
  await stopProc(src);

  const hits = feedHits;
  const off = await serverFor('check-off', P.other, env, { settings: { update: { check: false } } });
  await sleep(800);
  const voff = (await api(P.other, 'GET', '/api/update')).data;
  check('설정: "시작할 때 확인" 을 끄면 시작할 때 확인하지 않음 ([지금 확인]은 됨)', voff.enabled === false && voff.checkedAt === null && feedHits === hits && (await api(P.other, 'POST', '/api/update/check')).data?.available === true);
  await stopProc(off);
  return { srv, port, planFile };
}

// =====================================================================
async function launcherChecks() {
  section('3. 실행기: 시작할 때 자동 설치 (dry-run)');
  const run = async (name, extraEnv, { settings, wait = true } = {}) => {
    const ws = path.join(OUT, `ws-launch-${name}`);
    await fs.rm(ws, { recursive: true, force: true });
    await fs.mkdir(ws, { recursive: true });
    if (settings) await fs.writeFile(path.join(ws, 'settings.json'), JSON.stringify(settings));
    const planFile = path.join(OUT, `plan-launch-${name}.json`);
    await fs.rm(planFile, { force: true });
    const env = { ...baseEnv(), WEB_RPA_UPDATE_PUBKEY: PUB, WEB_RPA_UPDATE_KIND: 'installer', WEB_RPA_UPDATE_DRYRUN: planFile, ...extraEnv };
    const proc = startProc(['src/launch.js', '--port', String(P.launch), '--workspace', ws, '--no-open'], env, { port: P.launch });
    const up = wait ? await waitUp(P.launch, 20000) : false;
    const plan = exists(planFile) ? JSON.parse(await fs.readFile(planFile, 'utf8')) : null;
    return { proc, up, plan, ws, planFile };
  };

  const a = await run('auto', { WEB_RPA_UPDATE_URL: `${FEED}/ok/latest.json` });
  const va = a.up ? (await api(P.launch, 'GET', '/api/update')).data : null;
  check(
    '실행기: 자동 설치(기본 켜짐) — 서버를 띄우기 전에 내려받아 검증하고 계획 기록',
    a.plan && a.plan.pid === a.proc.pid && /launch\.js$/.test(a.plan.relaunch.args[0]) && a.plan.relaunch.args.join(' ').includes(`--port ${P.launch}`) && a.plan.relaunch.args.includes('--no-open') && exists(path.join(a.ws, 'updates', `web-rpa-setup-${NEXT}.exe`)) && /새 버전 .* 있습니다/.test(a.proc.out),
    `${JSON.stringify(a.plan)}\n${a.proc.out}`,
  );
  check('실행기: 확인 결과를 서버에 넘김 (서버가 다시 확인하지 않음)', va?.checkedAt && va.available === true && va.latest?.version === NEXT, JSON.stringify(va));
  await stopProc(a.proc);

  const hits = feedHits;
  const b = await run('auto-off', { WEB_RPA_UPDATE_URL: `${FEED}/ok/latest.json` }, { settings: { update: { auto: false } } });
  const vb = b.up ? await waitFor(async () => {
    const r = (await api(P.launch, 'GET', '/api/update')).data;
    return r?.checkedAt && !r.checking ? r : null;
  }) : null;
  check('실행기: 자동 설치를 끄면 내려받지 않고 서버만 (배너용 확인은 서버가)', b.up && !b.plan && !exists(path.join(b.ws, 'updates', `web-rpa-setup-${NEXT}.exe`)) && vb?.available === true && vb.auto === false && feedHits === hits + 1, b.proc.out);

  // 이미 떠 있으면 확인하지 않고 끝난다 (위 서버가 같은 포트에 떠 있음)
  const hits2 = feedHits;
  const c = await run('running', { WEB_RPA_UPDATE_URL: `${FEED}/ok/latest.json` }, { wait: false });
  const code = await Promise.race([c.proc.exited, sleep(10000).then(() => 'timeout')]);
  check('실행기: 이미 실행 중이면 확인하지 않음', code === 0 && /이미 실행 중/.test(c.proc.out) && feedHits === hits2 && !exists(c.planFile), c.proc.out);
  await stopProc(b.proc);

  const d = await run('missing', { WEB_RPA_UPDATE_URL: `${FEED}/nothing/latest.json` });
  check('실행기: 피드가 없으면 한 줄 남기고 평소처럼 실행', d.up && !d.plan && /새 버전 확인: 업데이트 피드가 없습니다/.test(d.proc.out) && d.proc.out.split('\n').filter((l) => /업데이트|새 버전/.test(l)).length === 1, d.proc.out);
  await stopProc(d.proc);

  const e = await run('badsig', { WEB_RPA_UPDATE_URL: `${FEED}/badsig/latest.json` });
  const ve = e.up ? (await api(P.launch, 'GET', '/api/update')).data : null;
  check('실행기: 서명이 틀리면 설치하지 않고 실행 (배너는 내려받기 안내)', e.up && !e.plan && /자동 업데이트를 하지 못했습니다/.test(e.proc.out) && ve?.signature === 'bad' && ve.installable === false && ve.available === true, e.proc.out);
  await stopProc(e.proc);

  const f = await run('portable', { WEB_RPA_UPDATE_URL: `${FEED}/ok/latest.json`, WEB_RPA_UPDATE_KIND: 'portable' });
  check('실행기: 압축본은 시작할 때 설치하지 않음', f.up && !f.plan, f.proc.out);
  await stopProc(f.proc);
}

// =====================================================================
async function screenChecks(planFile) {
  section('4. 화면: 배너·설정 카드·390px');
  await fs.mkdir(SHOTS, { recursive: true });
  const INST = `http://127.0.0.1:${P.inst}`;
  dyn = 'ok';
  await api(P.inst, 'POST', '/api/update/check');
  const browser = await chromium.launch({ channel: 'msedge' });
  const errors = [];
  const newPage = async (vp = { width: 1360, height: 900 }) => {
    const ctx = await browser.newContext({ viewport: vp });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
    return page;
  };
  try {
    let page = await newPage();
    await page.goto(`${INST}/#/recipes`);
    const banner = page.locator('#update-banner');
    await banner.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    const text = (await banner.textContent().catch(() => '')) ?? '';
    const notes = await banner.getByRole('link', { name: '변경 내용' }).getAttribute('href').catch(() => null);
    check('새 버전 배너 표시', (await banner.isVisible()) && text.includes(`새 버전 ${NEXT}`) && text.includes(`지금 ${CUR}`) && (await banner.getByRole('button', { name: '지금 업데이트' }).isVisible()) && notes === NOTES, text);
    await page.screenshot({ path: path.join(SHOTS, 'banner.png') });
    await banner.getByRole('button', { name: '이 안내 닫기' }).click();
    const hidden1 = await banner.isHidden();
    await page.reload();
    await sleep(800);
    check('배너 [닫기] → 이번 실행 동안 그 버전 숨김 (새로 고쳐도)', hidden1 && (await page.locator('#update-banner').isHidden()));

    page = await newPage();
    await page.goto(`${INST}/#/hub`);
    await page.locator('#update-banner').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    check('배너: 다른 화면(허브)에서도 앱 셸 위에 보임', await page.locator('#update-banner').isVisible());
    await page.goto(`${INST}/#/settings`);
    const card = page.locator('.update-card');
    await card.waitFor({ timeout: 5000 }).catch(() => {});
    const autoBox = card.getByRole('checkbox', { name: /묻지 않고 설치/ });
    const checkBox = card.getByRole('checkbox', { name: /시작할 때 새 버전 확인/ });
    check('설정 카드: 시작할 때 확인·자동 설치 기본 켜짐, 피드 주소 칸', (await card.isVisible()) && (await autoBox.isChecked()) && (await checkBox.isChecked()) && (await card.getByRole('textbox', { name: '업데이트 피드 주소' }).getAttribute('placeholder')) === U.DEFAULT_FEED_URL);
    await card.getByRole('button', { name: '지금 확인' }).click();
    await page.waitForFunction(() => /새 버전/.test(document.querySelector('.update-status')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {});
    const status = await card.locator('.update-status').textContent();
    check('설정 카드: [지금 확인] → 마지막 결과 표시', /확인 — 새 버전 .* 있습니다/.test(status) && (await card.textContent()).includes(`지금 버전 ${CUR}`) && (await card.textContent()).includes('설치본'), status);
    check('설정 카드: 성공·실패 배지(.badge.ok/.bad)를 쓰지 않음 (다른 시험이 기대는 이름)', (await card.locator('.badge.ok, .badge.bad').count()) === 0 && (await page.locator('#update-banner .badge.ok, #update-banner .badge.bad').count()) === 0);
    await autoBox.uncheck();
    await card.getByRole('button', { name: '저장', exact: true }).click();
    const saved = await waitFor(async () => (await api(P.inst, 'GET', '/api/settings')).data?.update?.auto === false, 3000);
    await page.locator('.update-card').waitFor();
    check('설정 카드: 자동 설치를 끄고 저장 → 설정에 남음', saved && !(await page.locator('.update-card').getByRole('checkbox', { name: /묻지 않고 설치/ }).isChecked()));
    await api(P.inst, 'PUT', '/api/settings', { update: { auto: true } });
    await page.screenshot({ path: path.join(SHOTS, 'settings.png'), fullPage: true });

    // [지금 업데이트] → 설치 중 문구 (dry-run: 계획만 기록)
    await fs.rm(planFile, { force: true });
    page.once('dialog', (d) => d.accept());
    await page.locator('#update-banner').getByRole('button', { name: '지금 업데이트' }).click();
    await page.waitForFunction(() => /설치가 끝나면 web-rpa 가 다시 열립니다/.test(document.getElementById('update-banner')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {});
    const busyText = await page.locator('#update-banner').textContent();
    check('[지금 업데이트] → 확인 후 "설치가 끝나면 web-rpa 가 다시 열립니다" (계획 기록)', /설치가 끝나면 web-rpa 가 다시 열립니다/.test(busyText) && exists(planFile), busyText);
    await page.screenshot({ path: path.join(SHOTS, 'installing.png') });

    // 390px: 배너와 설정 카드가 화면 안
    const m = await newPage({ width: 390, height: 844 });
    let mobileOk = true;
    const widths = [];
    for (const hash of ['#/recipes', '#/settings']) {
      await m.goto(`${INST}/${hash}`);
      await m.locator('#update-banner').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      if (hash === '#/settings') await m.locator('.update-card').waitFor({ timeout: 5000 }).catch(() => {});
      await sleep(300);
      const sw = await m.evaluate(() => document.documentElement.scrollWidth);
      widths.push(sw);
      const box = await m.locator('#update-banner').boundingBox();
      mobileOk &&= sw <= 392 && !!box && box.x + box.width <= 392;
      await m.screenshot({ path: path.join(SHOTS, `m-${hash.slice(2)}.png`), fullPage: true });
    }
    check('390px: 배너·설정 카드 가로 스크롤 없음', mobileOk, widths.join(','));

    // 압축본: [지금 업데이트] 대신 [내려받기 페이지]
    const pp = await newPage();
    await pp.goto(`http://127.0.0.1:${P.portable}/#/recipes`);
    const pb = pp.locator('#update-banner');
    await pb.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    const dlHref = await pb.getByRole('link', { name: '내려받기 페이지' }).getAttribute('href').catch(() => null);
    check('압축본 화면: [지금 업데이트] 없이 [내려받기 페이지]', dlHref === NOTES && (await pb.getByRole('button', { name: '지금 업데이트' }).count()) === 0 && /압축본/.test(await pb.textContent()));
    await pp.screenshot({ path: path.join(SHOTS, 'portable.png') });

    // 피드가 없으면 배너도 없다
    dyn = 'missing';
    await api(P.inst, 'POST', '/api/update/check');
    const q = await newPage();
    await q.goto(`${INST}/#/recipes`);
    await q.locator('.page-head').first().waitFor({ timeout: 5000 }).catch(() => {});
    await sleep(800);
    check('피드 없음: 배너를 띄우지 않고 알림도 없음', (await q.locator('#update-banner').isHidden()) && (await q.locator('#toasts .toast').count()) === 0);
    dyn = 'ok';
  } finally {
    await browser.close();
  }
  check('화면 오류 0 (pageerror · console error)', !errors.length, errors.join(' / '));
}

// =====================================================================
async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });
  const feed = await startFeedServer();
  try {
    await unitChecks();
    const { planFile } = await serverChecks();
    await launcherChecks();
    await screenChecks(planFile);
  } finally {
    for (const p of procs) await stopProc(p);
    feed.close();
  }
  console.log(`\n업데이트 점검: ${passed}/${passed + failures.length} 통과`);
  if (failures.length) {
    for (const f of failures) console.log(`  ❌ ${f}`);
    process.exit(1);
  }
  if (!process.env.KEEP_OUT) await fs.rm(OUT, { recursive: true, force: true }).catch(() => {});
  console.log('✅ 업데이트 점검 통과');
}

main().catch(async (e) => {
  console.error('\n❌ 업데이트 점검 실패:', e);
  for (const p of procs) await stopProc(p).catch(() => {});
  process.exit(1);
});
