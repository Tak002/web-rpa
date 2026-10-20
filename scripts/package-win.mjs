// Windows 배포 패키지: Node 런타임을 함께 담은 압축 파일을 만든다 (설치한 Node 가 없어도 실행된다).
// 실행: node scripts/package-win.mjs [--smoke]
//   결과: dist/web-rpa-<버전>-win-x64.zip
//   --smoke: 만든 압축을 임시 폴더에 풀어 서버를 띄우고 화면·API 가 응답하는지 확인한다.

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
const APP_FILES = ['src', 'public', 'docs', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'package.json', 'pnpm-lock.yaml'];

const LAUNCHER = [
  '@echo off',
  'chcp 65001 >nul',
  'rem web-rpa 실행. 이 창을 닫으면 서버가 멈춘다. 작업 데이터는 %LOCALAPPDATA%\\web-rpa 에 남는다.',
  'title web-rpa (http://127.0.0.1:4800)',
  'cd /d "%~dp0"',
  'start "" http://127.0.0.1:4800',
  '"%~dp0node\\node.exe" "%~dp0app\\src\\server.js" --port 4800 --workspace "%LOCALAPPDATA%\\web-rpa"',
  'pause',
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

async function build() {
  if (process.platform !== 'win32') throw new Error('Windows 에서만 만들 수 있습니다 (node.exe 를 함께 담는다).');
  await fsp.rm(path.join(DIST, 'stage'), { recursive: true, force: true });
  await fsp.mkdir(path.join(STAGE, 'app'), { recursive: true });
  for (const f of APP_FILES) await fsp.cp(path.join(ROOT, f), path.join(STAGE, 'app', f), { recursive: true });
  // 운영 의존성만, 심볼릭 링크 없이 펼쳐서 설치한다 (압축·이동해도 깨지지 않게)
  run('cmd.exe', ['/d', '/s', '/c', 'pnpm', 'install', '--prod', '--frozen-lockfile', '--prefer-offline', '--config.node-linker=hoisted', '--ignore-scripts'], { cwd: path.join(STAGE, 'app') });
  await fsp.mkdir(path.join(STAGE, 'node'), { recursive: true });
  await fsp.copyFile(process.execPath, path.join(STAGE, 'node', 'node.exe'));
  await fsp.writeFile(path.join(STAGE, 'node', 'LICENSE.txt'), await nodeLicense());
  await fsp.writeFile(path.join(STAGE, 'web-rpa.cmd'), LAUNCHER);
  await fsp.writeFile(
    path.join(STAGE, '읽어보기.txt'),
    [
      `web-rpa ${pkg.version}`,
      '',
      '1. 이 폴더를 원하는 곳(예: 문서 폴더)에 풀어 둡니다. Program Files 처럼 쓰기가 막힌 곳은 피하세요.',
      '2. web-rpa.cmd 를 두 번 누르면 브라우저에 화면이 열립니다. 창을 닫으면 멈춥니다.',
      '3. 레시피·실행 결과·브라우저 프로필은 %LOCALAPPDATA%\\web-rpa 에 저장됩니다.',
      '',
      'Edge 또는 Chrome 이 설치돼 있어야 합니다. 라이선스: app\\LICENSE, 제3자 고지: app\\THIRD_PARTY_NOTICES.md, Node.js: node\\LICENSE.txt',
      '',
    ].join('\r\n'),
  );
  await fsp.rm(ZIP, { force: true });
  // 한글 파일 이름이 다른 언어 환경에서도 깨지지 않게 UTF-8 이름으로 압축한다 (Compress-Archive 는 그렇지 않다)
  run('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${STAGE}', '${ZIP}', 'Optimal', $true, [Text.Encoding]::UTF8)`]);
  const { size } = await fsp.stat(ZIP);
  console.log(`만들었습니다: ${ZIP} (${(size / 1024 / 1024).toFixed(1)}MB)`);
}

async function smoke() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-rpa-smoke-'));
  run('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory('${ZIP}', '${dir}', [Text.Encoding]::UTF8)`]);
  const base = path.join(dir, 'web-rpa');
  const port = 4870 + Math.floor(Math.random() * 20);
  const server = spawn(path.join(base, 'node', 'node.exe'), [path.join(base, 'app', 'src', 'server.js'), '--port', String(port), '--workspace', path.join(dir, 'ws')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  try {
    let ok = false;
    for (let i = 0; i < 40 && !ok; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      ok = await fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.ok, () => false);
    }
    if (!ok) throw new Error(`압축을 푼 패키지의 서버가 응답하지 않습니다.\n${log}`);
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    const settings = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json();
    const found = (settings.browser?.choices ?? []).filter((b) => b.found && !['auto', 'custom'].includes(b.id)).map((b) => b.label);
    if (!fs.existsSync(path.join(base, '읽어보기.txt'))) throw new Error('압축을 풀었더니 한글 파일 이름이 깨졌습니다.');
    if (!html.includes('<script')) throw new Error('화면(index.html)이 비어 있습니다.');
    console.log(`풀어서 실행 확인: 화면·API 응답 정상, 한글 파일 이름 정상, 감지된 브라우저: ${found.join(', ') || '없음'}`);
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 500));
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

await build();
if (process.argv.includes('--smoke')) await smoke();
