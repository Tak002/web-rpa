// Windows 배포 패키지: Node 런타임을 함께 담아, 설치한 Node 가 없어도 실행된다.
// 실행: node scripts/package-win.mjs [--installer] [--smoke] [--upgrade] [--release-base URL]
//   결과: dist/web-rpa-<버전>-win-x64.zip (압축을 풀어 web-rpa.cmd 실행)
//         dist/web-rpa-setup-<버전>.exe  (--installer: 설치 파일, Inno Setup 6 필요)
//         dist/latest.json              (--installer: 업데이트 피드 — 서명 개인 키가 있으면 서명, scripts/update-key.mjs)
//         dist/SHA256SUMS.txt           (설치 파일·zip 의 sha256)
//   --release-base: 피드에 적을 내려받기 주소 (기본 https://github.com/Tak002/web-rpa/releases/download/v<버전>/)
//   --smoke: 만든 압축(과 설치 파일)을 실제로 풀어·설치해 서버를 띄우고 화면·API 가 응답하는지 확인한 뒤 지운다.
//   --upgrade (--installer --smoke 와 함께): 가짜 옛 버전(0.0.1)을 설치해 두고, 시험 키로 서명한 로컬 피드로
//            [지금 업데이트](서버 API)와 시작할 때 자동 설치(실행기) 두 길을 실제로 거쳐 같은 포트에 새 버전이 다시 뜨는지 확인한 뒤 지운다.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { FEED_FORMAT, FEED_FORMAT_VERSION, PUBLIC_KEYS, signEntry, verifyEntry, publicKeyOf, keyFingerprint } from '../src/update.js';
import { loadSigningKey, signingKeyPath } from './update-key.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NAME = `web-rpa-${pkg.version}-win-x64`;
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'stage', 'web-rpa');
const ZIP = path.join(DIST, `${NAME}.zip`);
const SETUP = path.join(DIST, `web-rpa-setup-${pkg.version}.exe`);
const FEED_FILE = path.join(DIST, 'latest.json');
const SUMS_FILE = path.join(DIST, 'SHA256SUMS.txt');
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const RELEASE_BASE = (() => {
  const raw = argOf('--release-base') ?? `https://github.com/Tak002/web-rpa/releases/download/v${pkg.version}/`;
  return raw.endsWith('/') ? raw : `${raw}/`;
})();
const APP_FILES = ['src', 'public', 'docs', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'package.json', 'pnpm-lock.yaml'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LAUNCHER = [
  '@echo off',
  'setlocal',
  'chcp 65001 >nul',
  'rem web-rpa 실행. 이 창을 닫으면 서버가 멈춘다. 작업 데이터는 %LOCALAPPDATA%\\web-rpa 에 남는다.',
  'rem 명령줄: web-rpa.cmd set lint 파일.wrset · web-rpa.cmd hub list … (app\\src\\cli.js — 파일은 지금 폴더 기준으로 찾는다)',
  'if /i "%~1"=="set" goto cli',
  'if /i "%~1"=="hub" goto cli',
  'title web-rpa',
  'cd /d "%~dp0app"',
  '"%~dp0node\\node.exe" "%~dp0app\\src\\launch.js" %*',
  'if errorlevel 1 pause',
  'goto :eof',
  ':cli',
  'set "WEB_RPA_CWD=%CD%"',
  '"%~dp0node\\node.exe" "%~dp0app\\src\\cli.js" %*',
  'exit /b %errorlevel%',
  '',
].join('\r\n');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 실패 (종료 코드 ${r.status})`);
}

async function nodeLicense() {
  const cache = path.join(DIST, 'cache', `node-${process.version}-LICENSE.txt`);
  if (fs.existsSync(cache)) return fsp.readFile(cache, 'utf8');
  const res = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`);
  if (!res.ok) throw new Error(`Node 라이선스 파일을 받지 못했습니다 (${res.status}). 인터넷 연결을 확인해 주세요.`);
  const text = await res.text();
  await fsp.mkdir(path.dirname(cache), { recursive: true });
  await fsp.writeFile(cache, text);
  return text;
}

async function stage() {
  if (process.platform !== 'win32') throw new Error('Windows 에서만 만들 수 있습니다 (node.exe 를 함께 담는다).');
  await fsp.rm(path.join(DIST, 'stage'), { recursive: true, force: true });
  await fsp.mkdir(path.join(STAGE, 'app'), { recursive: true });
  for (const f of APP_FILES) await fsp.cp(path.join(ROOT, f), path.join(STAGE, 'app', f), { recursive: true });
  // 운영 의존성만, 심볼릭 링크 없이 펼쳐서 설치한다 (압축·이동해도 깨지지 않게)
  run('cmd.exe', ['/d', '/s', '/c', 'pnpm', 'install', '--prod', '--frozen-lockfile', '--prefer-offline', '--config.node-linker=hoisted', '--ignore-scripts'], { cwd: path.join(STAGE, 'app') });
  await fsp.mkdir(path.join(STAGE, 'node'), { recursive: true });
  await fsp.copyFile(process.execPath, path.join(STAGE, 'node', 'node.exe'));
  await fsp.writeFile(path.join(STAGE, 'node', 'LICENSE.txt'), await nodeLicense());
  await fsp.copyFile(path.join(ROOT, 'assets', 'web-rpa.ico'), path.join(STAGE, 'web-rpa.ico'));
  await fsp.writeFile(path.join(STAGE, 'web-rpa.cmd'), LAUNCHER);
  await fsp.writeFile(
    path.join(STAGE, '읽어보기.txt'),
    [
      `web-rpa ${pkg.version}`,
      '',
      '1. 이 폴더를 원하는 곳(예: 문서 폴더)에 풀어 둡니다. Program Files 처럼 쓰기가 막힌 곳은 피하세요.',
      '2. web-rpa.cmd 를 두 번 누르면 브라우저에 화면이 열립니다. 검은 창을 닫으면 멈춥니다.',
      '3. 레시피·실행 결과·브라우저 프로필은 %LOCALAPPDATA%\\web-rpa 에 저장됩니다.',
      '',
      'Edge 또는 Chrome 이 설치돼 있어야 합니다. 라이선스: app\\LICENSE, 제3자 고지: app\\THIRD_PARTY_NOTICES.md, Node.js: node\\LICENSE.txt',
      '',
    ].join('\r\n'),
  );
}

async function buildZip() {
  await fsp.rm(ZIP, { force: true });
  // 한글 파일 이름이 다른 언어 환경에서도 깨지지 않게 UTF-8 이름으로 압축한다 (Compress-Archive 는 그렇지 않다)
  run('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${STAGE}', '${ZIP}', 'Optimal', $true, [Text.Encoding]::UTF8)`]);
  console.log(`만들었습니다: ${ZIP} (${((await fsp.stat(ZIP)).size / 1024 / 1024).toFixed(1)}MB)`);
}

function findIscc() {
  const candidates = [process.env.INNO_ISCC, path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe'), path.join(process.env['ProgramFiles(x86)'] ?? '', 'Inno Setup 6', 'ISCC.exe'), path.join(process.env.ProgramFiles ?? '', 'Inno Setup 6', 'ISCC.exe')];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) throw new Error('Inno Setup 6 이 없습니다. winget install --id JRSoftware.InnoSetup -e --scope user 로 설치하거나 INNO_ISCC 에 ISCC.exe 경로를 지정해 주세요.');
  return found;
}

function iscc({ stage, version, outDir, compression }) {
  run(findIscc(), ['/Q', `/DStage=${stage}`, `/DVersion=${version}`, `/DOutDir=${outDir}`, ...(compression ? [`/DCompression=${compression}`] : []), path.join(ROOT, 'scripts', 'installer.iss')]);
  return path.join(outDir, `web-rpa-setup-${version}.exe`);
}

async function buildInstaller() {
  await fsp.rm(SETUP, { force: true });
  iscc({ stage: STAGE, version: pkg.version, outDir: DIST });
  console.log(`만들었습니다: ${SETUP} (${((await fsp.stat(SETUP)).size / 1024 / 1024).toFixed(1)}MB)`);
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const c of fs.createReadStream(file)) hash.update(c);
  return hash.digest('hex');
}
const fileEntry = async (file, base) => ({ url: new URL(encodeURIComponent(path.basename(file)), base).href, sha256: await sha256File(file), size: (await fsp.stat(file)).size });

/**
 * 업데이트 피드(latest.json)와 SHA256SUMS.txt. 서명은 저장소 밖의 개인 키로 (없으면 경고하고 서명 없이 — 그 피드로는 자동 설치되지 않는다).
 * @returns {object} 쓴 피드
 */
async function writeRelease({ withInstaller }) {
  const sums = [];
  let feed = null;
  await fsp.rm(FEED_FILE, { force: true });
  if (withInstaller) {
    const installer = await fileEntry(SETUP, RELEASE_BASE);
    let key = null;
    try {
      key = loadSigningKey();
    } catch (e) {
      console.warn(`경고: 서명 개인 키를 읽지 못했습니다 — ${e.message}`);
    }
    if (key) {
      installer.signature = signEntry(key, pkg.version, installer);
      const fp = keyFingerprint(publicKeyOf(key)).slice(0, 16);
      if (verifyEntry(pkg.version, installer, PUBLIC_KEYS) !== 'ok') console.warn(`경고: 서명 키(지문 ${fp}…)가 앱 속 공개 키(src/update.js PUBLIC_KEYS)와 짝이 아닙니다. 이 피드로는 설치본이 자동 설치하지 않습니다.`);
      else console.log(`서명했습니다: 공개 키 지문 ${fp}…`);
    } else {
      console.warn(`경고: 서명 개인 키가 없습니다 (${signingKeyPath()}). latest.json 을 서명 없이 씁니다 — 설치본은 이 버전을 자동 설치하지 않고 내려받기 페이지만 안내합니다. node scripts/update-key.mjs 로 만들거나 WEB_RPA_SIGNING_KEY 를 지정해 주세요.`);
    }
    const zip = fs.existsSync(ZIP) ? await fileEntry(ZIP, RELEASE_BASE) : null;
    feed = {
      format: FEED_FORMAT,
      formatVersion: FEED_FORMAT_VERSION,
      version: pkg.version,
      publishedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      notesUrl: `https://github.com/Tak002/web-rpa/releases/tag/v${pkg.version}`,
      installer,
      ...(zip ? { zip } : {}),
    };
    await fsp.writeFile(FEED_FILE, `${JSON.stringify(feed, null, 2)}\n`);
    console.log(`만들었습니다: ${FEED_FILE} (내려받기 주소 ${RELEASE_BASE}${installer.signature ? '' : ', 서명 없음'})`);
    sums.push(`${installer.sha256}  ${path.basename(SETUP)}`);
  }
  if (fs.existsSync(ZIP)) sums.push(`${await sha256File(ZIP)}  ${path.basename(ZIP)}`);
  await fsp.writeFile(SUMS_FILE, `${sums.join('\n')}\n`);
  console.log(`만들었습니다: ${SUMS_FILE}`);
  return feed;
}

/** 시험 실행용 작업 폴더: 실제 피드를 보고 스스로 업데이트하지 않게 확인을 끈다 */
async function testWorkspace(update = { check: false }) {
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-rpa-ws-'));
  if (update) await fsp.writeFile(path.join(ws, 'settings.json'), JSON.stringify({ update }));
  return ws;
}

/** 설치·압축 해제된 폴더에서 실행기로 서버를 띄워 화면·API 를 확인한다. */
async function checkRunning(base, label) {
  const port = 4870 + Math.floor(Math.random() * 20);
  const ws = await testWorkspace();
  const proc = spawn(path.join(base, 'node', 'node.exe'), [path.join(base, 'app', 'src', 'launch.js'), '--port', String(port), '--workspace', ws, '--no-open'], { cwd: path.join(base, 'app'), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  try {
    let ok = false;
    // 새로 설치한 node.exe 의 첫 실행은 백신 검사로 15초 넘게 걸리기도 한다
    for (let i = 0; i < 240 && !ok; i += 1) {
      await sleep(250);
      ok = await fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.ok, () => false);
    }
    if (!ok) throw new Error(`${label}: 서버가 응답하지 않습니다.\n${log}`);
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    if (!html.includes('<script')) throw new Error(`${label}: 화면(index.html)이 비어 있습니다.`);
    const settings = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json();
    const found = (settings.browser?.choices ?? []).filter((b) => b.found && !['auto', 'custom'].includes(b.id)).map((b) => b.label);
    console.log(`${label}: 화면·API 응답 정상, 감지된 브라우저: ${found.join(', ') || '없음'}`);
  } finally {
    proc.kill();
    await sleep(800);
    await fsp.rm(ws, { recursive: true, force: true }).catch(() => {});
  }
}

async function smokeZip() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-rpa-zip-'));
  try {
    run('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory('${ZIP}', '${dir}', [Text.Encoding]::UTF8)`]);
    if (!fs.existsSync(path.join(dir, 'web-rpa', '읽어보기.txt'))) throw new Error('압축을 풀었더니 한글 파일 이름이 깨졌습니다.');
    await checkRunning(path.join(dir, 'web-rpa'), '압축 해제본');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function smokeInstaller() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-rpa-inst-'));
  const target = path.join(dir, 'app');
  const shortcut = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'web-rpa.lnk');
  run(SETUP, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/DIR=${target}`]);
  try {
    for (const f of ['node\\node.exe', 'app\\src\\launch.js', 'web-rpa.ico', 'unins000.exe']) if (!fs.existsSync(path.join(target, f))) throw new Error(`설치본에 ${f} 가 없습니다.`);
    if (!fs.existsSync(shortcut)) throw new Error('시작 메뉴 바로가기가 만들어지지 않았습니다.');
    await checkRunning(target, '설치본');
  } finally {
    run(path.join(target, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']);
    for (let i = 0; i < 40 && fs.existsSync(path.join(target, 'app')); i += 1) await sleep(250); // 제거 프로그램은 스스로를 복사해 이어서 지운다
    const left = fs.existsSync(path.join(target, 'app')) || fs.existsSync(shortcut);
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (left) throw new Error('제거한 뒤에도 파일이나 바로가기가 남았습니다.');
    console.log('설치본: 조용히 제거 → 파일·시작 메뉴 바로가기 남지 않음');
  }
}

// ---------------------------------------------------------------- 업그레이드 시험

/** 포트에서 듣고 있는 프로세스 PID (다시 뜬 서버는 대기 스크립트가 띄워 이 스크립트의 자식이 아니다) */
function listeningPid(port) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`], { encoding: 'utf8' });
  const pid = Number(String(r.stdout).trim());
  return pid > 0 ? pid : null;
}
async function killPort(port) {
  for (let i = 0; i < 20; i += 1) {
    const pid = listeningPid(port);
    if (!pid) return;
    try {
      process.kill(pid);
    } catch {
      // 이미 끝남
    }
    await sleep(500);
  }
}
async function getJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
async function until(what, fn, ms, step = 500) {
  for (let t = Date.now(); Date.now() - t < ms; ) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  throw new Error(`업그레이드: ${what} — ${Math.round(ms / 1000)}초 안에 되지 않았습니다.`);
}
function startLaunch(target, port, ws, env) {
  const proc = spawn(path.join(target, 'node', 'node.exe'), [path.join(target, 'app', 'src', 'launch.js'), '--port', String(port), '--workspace', ws, '--no-open'], { cwd: path.join(target, 'app'), stdio: ['ignore', 'pipe', 'pipe'], env });
  proc.log = '';
  proc.stdout.on('data', (d) => (proc.log += d));
  proc.stderr.on('data', (d) => (proc.log += d));
  proc.exited = new Promise((r) => proc.on('exit', (code) => r(code)));
  return proc;
}

/**
 * 실제 업그레이드: 가짜 옛 버전 0.0.1 설치 → 시험 키로 서명한 로컬 피드 → (A) [지금 업데이트] API, (B) 시작할 때 자동 설치
 * → 옛 서버 종료 → 같은 포트에 새 버전 → 옛 버전에만 있던 파일 없음 → 조용히 제거.
 */
async function smokeUpgrade() {
  const OLD = '0.0.1';
  const oldStage = path.join(DIST, 'stage-old', 'web-rpa');
  const outDir = path.join(DIST, 'upgrade');
  console.log(`업그레이드 시험: 옛 버전 ${OLD} 설치 파일을 만듭니다…`);
  await fsp.rm(path.dirname(oldStage), { recursive: true, force: true });
  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.cp(STAGE, oldStage, { recursive: true });
  const oldPkgFile = path.join(oldStage, 'app', 'package.json');
  await fsp.writeFile(oldPkgFile, JSON.stringify({ ...JSON.parse(await fsp.readFile(oldPkgFile, 'utf8')), version: OLD }, null, 2));
  const oldSetup = iscc({ stage: oldStage, version: OLD, outDir, compression: 'lzma2/fast' });

  // 시험 키(메모리에만)로 서명한 피드를 로컬 http 로 낸다
  const key = crypto.generateKeyPairSync('ed25519');
  const installer = { url: '', sha256: await sha256File(SETUP), size: (await fsp.stat(SETUP)).size };
  installer.signature = signEntry(key.privateKey, pkg.version, installer);
  const feedServer = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${feedServer.address().port}`;
    if (req.url === '/latest.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ format: FEED_FORMAT, formatVersion: FEED_FORMAT_VERSION, version: pkg.version, publishedAt: new Date().toISOString(), notesUrl: `${base}/notes`, installer: { ...installer, url: `${base}/${path.basename(SETUP)}` } }));
    }
    if (req.url === `/${path.basename(SETUP)}`) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': installer.size });
      return fs.createReadStream(SETUP).pipe(res);
    }
    res.writeHead(404);
    return res.end();
  });
  await new Promise((r) => feedServer.listen(0, '127.0.0.1', r));
  const env = { ...process.env, WEB_RPA_UPDATE_URL: `http://127.0.0.1:${feedServer.address().port}/latest.json`, WEB_RPA_UPDATE_PUBKEY: publicKeyOf(key.publicKey) };
  for (const k of ['WEB_RPA_UPDATE_KIND', 'WEB_RPA_UPDATE_DRYRUN']) delete env[k];

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-rpa-upg-'));
  const target = path.join(dir, 'app');
  const shortcut = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'web-rpa.lnk');
  const port = 4880 + Math.floor(Math.random() * 10);
  const base = `http://127.0.0.1:${port}`;
  const ws = await testWorkspace(null);
  const stale = path.join(target, 'app', 'src', '__stale.txt');
  const installedVersion = () => JSON.parse(fs.readFileSync(path.join(target, 'app', 'package.json'), 'utf8')).version;
  const installOld = async () => {
    run(oldSetup, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/DIR=${target}`]);
    if (installedVersion() !== OLD) throw new Error(`업그레이드: 옛 버전 ${OLD} 이(가) 설치되지 않았습니다 (${installedVersion()}).`);
    await fsp.writeFile(stale, '옛 버전에만 있던 파일 — 업데이트하면 없어져야 한다');
  };
  /** 실패했을 때 원인을 볼 수 있게: 옛 서버 출력, update-log.txt, 설치 로그 끝부분 */
  const diag = async (proc) => {
    const upd = path.join(ws, 'updates');
    const names = await fsp.readdir(upd).catch(() => []);
    const log = await fsp.readFile(path.join(upd, 'update-log.txt'), 'utf8').catch(() => '(없음)');
    const setupLog = await fsp.readFile(path.join(upd, `setup-${pkg.version}.log`), 'utf8').catch(() => '(없음)');
    return `\n--- 옛 web-rpa 출력\n${proc.log}\n--- updates 폴더: ${names.join(', ')}\n--- update-log.txt\n${log}\n--- 설치 로그 끝\n${setupLog.split(/\r?\n/).slice(-25).join('\n')}`;
  };
  /** 옛 서버가 끝나고 같은 포트에 새 버전이 다시 떴는지 */
  const expectNew = async (label, proc) => {
    const code = await Promise.race([proc.exited, sleep(60_000).then(() => 'timeout')]);
    if (code === 'timeout') throw new Error(`업그레이드(${label}): 옛 web-rpa 가 끝나지 않았습니다.${await diag(proc)}`);
    const v = await until(`${label}: 같은 포트(${port})에 새 버전 ${pkg.version}`, async () => {
      const u = await getJson(`${base}/api/update`);
      return u?.current === pkg.version ? u : null;
    }, 240_000).catch(async (e) => {
      throw new Error(`${e.message} (옛 web-rpa 종료 코드 ${code})${await diag(proc)}`);
    });
    if (fs.existsSync(stale)) throw new Error(`업그레이드(${label}): 옛 버전 파일 app\\src\\__stale.txt 가 남았습니다 ([InstallDelete]).`);
    if (installedVersion() !== pkg.version) throw new Error(`업그레이드(${label}): 설치 폴더의 버전이 ${installedVersion()} 입니다.`);
    const log = await fsp.readFile(path.join(ws, 'updates', 'update-log.txt'), 'utf8').catch(() => '');
    if (!new RegExp(`${OLD} -> ${pkg.version}: 설치 완료`).test(log)) throw new Error(`업그레이드(${label}): update-log.txt 에 설치 완료 줄이 없습니다.\n${log}`);
    if (!fs.existsSync(path.join(ws, 'updates', `setup-${pkg.version}.log`))) throw new Error(`업그레이드(${label}): 설치 로그(setup-${pkg.version}.log)가 없습니다.`);
    console.log(`업그레이드(${label}): ${OLD} 종료(코드 ${code}) → 같은 포트에 ${v.current} (설치 형태 ${v.kind}) · 옛 파일 없음 · update-log.txt 기록`);
  };

  try {
    // (A) 화면의 [지금 업데이트] = POST /api/update/install (시작할 때 자동 설치는 끔)
    await installOld();
    await fsp.writeFile(path.join(ws, 'settings.json'), JSON.stringify({ update: { auto: false } }));
    let proc = startLaunch(target, port, ws, env);
    const u = await until('옛 버전이 새 버전을 찾음', async () => {
      const x = await getJson(`${base}/api/update`);
      return x?.checkedAt && !x.checking ? x : null;
    }, 90_000);
    if (u.current !== OLD || !u.available || !u.installable || u.kind !== 'installer' || u.latest?.version !== pkg.version) throw new Error(`업그레이드: 옛 버전이 새 버전을 설치할 수 있다고 보지 않습니다: ${JSON.stringify(u)}\n${proc.log}`);
    const r = await fetch(`${base}/api/update/install`, { method: 'POST' });
    if (!r.ok) throw new Error(`업그레이드: 설치 요청 실패 ${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
    await expectNew('지금 업데이트', proc);
    await killPort(port);

    // (B) 시작할 때 자동 설치 (기본값): 옛 버전을 다시 깔고 실행기만 띄운다
    await installOld();
    await fsp.rm(path.join(ws, 'settings.json'), { force: true });
    await fsp.rm(path.join(ws, 'updates'), { recursive: true, force: true });
    proc = startLaunch(target, port, ws, env);
    await expectNew('시작할 때 자동 설치', proc);
    if (!/새 버전 .* 있습니다/.test(proc.log)) throw new Error(`업그레이드: 실행기가 새 버전 안내를 남기지 않았습니다.\n${proc.log}`);
    console.log(`업그레이드: ${OLD} → ${pkg.version} 설치·재시작 확인`);
  } finally {
    await killPort(port);
    feedServer.close();
    if (fs.existsSync(path.join(target, 'unins000.exe'))) run(path.join(target, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']);
    for (let i = 0; i < 40 && fs.existsSync(path.join(target, 'app')); i += 1) await sleep(250);
    const left = fs.existsSync(path.join(target, 'app')) || fs.existsSync(shortcut);
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(ws, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(path.dirname(oldStage), { recursive: true, force: true }).catch(() => {});
    await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
    if (left) throw new Error('업그레이드 시험: 제거한 뒤에도 파일이나 바로가기가 남았습니다.');
    console.log('업그레이드 시험: 조용히 제거 → 파일·시작 메뉴 바로가기·임시 폴더 남지 않음');
  }
}

await stage();
await buildZip();
if (process.argv.includes('--installer')) await buildInstaller();
await writeRelease({ withInstaller: process.argv.includes('--installer') });
if (process.argv.includes('--smoke')) {
  await smokeZip();
  if (process.argv.includes('--installer')) await smokeInstaller();
  if (process.argv.includes('--upgrade')) {
    if (!process.argv.includes('--installer')) throw new Error('--upgrade 는 --installer --smoke 와 함께 씁니다.');
    await smokeUpgrade();
  }
}
