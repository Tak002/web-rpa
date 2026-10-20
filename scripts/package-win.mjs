// Windows 배포 패키지: Node 런타임을 함께 담아, 설치한 Node 가 없어도 실행된다.
// 실행: node scripts/package-win.mjs [--installer] [--smoke]
//   결과: dist/web-rpa-<버전>-win-x64.zip (압축을 풀어 web-rpa.cmd 실행)
//         dist/web-rpa-setup-<버전>.exe  (--installer: 설치 파일, Inno Setup 6 필요)
//   --smoke: 만든 압축(과 설치 파일)을 실제로 풀어·설치해 서버를 띄우고 화면·API 가 응답하는지 확인한 뒤 지운다.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NAME = `web-rpa-${pkg.version}-win-x64`;
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'stage', 'web-rpa');
const ZIP = path.join(DIST, `${NAME}.zip`);
const SETUP = path.join(DIST, `web-rpa-setup-${pkg.version}.exe`);
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

async function buildInstaller() {
  await fsp.rm(SETUP, { force: true });
  run(findIscc(), ['/Q', `/DStage=${STAGE}`, `/DVersion=${pkg.version}`, `/DOutDir=${DIST}`, path.join(ROOT, 'scripts', 'installer.iss')]);
  console.log(`만들었습니다: ${SETUP} (${((await fsp.stat(SETUP)).size / 1024 / 1024).toFixed(1)}MB)`);
}

/** 설치·압축 해제된 폴더에서 실행기로 서버를 띄워 화면·API 를 확인한다. */
async function checkRunning(base, label) {
  const port = 4870 + Math.floor(Math.random() * 20);
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-rpa-ws-'));
  const proc = spawn(path.join(base, 'node', 'node.exe'), [path.join(base, 'app', 'src', 'launch.js'), '--port', String(port), '--workspace', ws, '--no-open'], { cwd: path.join(base, 'app'), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  try {
    let ok = false;
    for (let i = 0; i < 60 && !ok; i += 1) {
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

await stage();
await buildZip();
if (process.argv.includes('--installer')) await buildInstaller();
if (process.argv.includes('--smoke')) {
  await smokeZip();
  if (process.argv.includes('--installer')) await smokeInstaller();
}
