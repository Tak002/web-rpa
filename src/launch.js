// 바로가기·설치본에서 쓰는 실행기: 이미 떠 있으면 화면만 열고, 아니면 서버를 띄운 뒤 화면을 연다.
// 실행: node src/launch.js [--port 4800] [--workspace 폴더] [--no-open]
//   작업 폴더 기본값은 %LOCALAPPDATA%\web-rpa — 다시 설치하거나 지워도 레시피·실행 결과가 남는다.
//   설치본이고 설정의 "시작할 때 자동 설치"가 켜져 있으면(기본) 서버를 띄우기 전에 새 버전을 확인해 설치한다 (src/update.js).

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { updateAtLaunch, setLaunchInfo } from './update.js';

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const port = Number(argOf('--port', 4800));
const workspace = path.resolve(argOf('--workspace', path.join(process.env.LOCALAPPDATA || os.homedir(), 'web-rpa')));
const url = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 'web-rpa' · 'other'(다른 프로그램이 포트를 씀) · null(비어 있음) */
async function whoIsOnPort() {
  try {
    const res = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(1500) });
    const body = await res.json().catch(() => null);
    return res.ok && body && 'recording' in body && 'run' in body ? 'web-rpa' : 'other';
  } catch (e) {
    return e?.cause?.code === 'ECONNREFUSED' ? null : 'other';
  }
}

function openScreen() {
  if (args.includes('--no-open')) return;
  // 기본 브라우저로 연다
  if (process.platform === 'win32') spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

async function fail(message) {
  console.error(`\n${message}\n`);
  if (process.stdin.isTTY) {
    console.error('아무 키나 누르면 창을 닫습니다.');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    await new Promise((r) => process.stdin.once('data', r));
  }
  process.exit(1);
}

process.title = 'web-rpa';
const who = await whoIsOnPort();
if (who === 'web-rpa') {
  console.log(`web-rpa 가 이미 실행 중입니다: ${url}`);
  openScreen();
  process.exit(0);
}
if (who === 'other') await fail(`포트 ${port} 를 다른 프로그램이 쓰고 있습니다. 그 프로그램을 끄거나 --port 로 다른 번호를 지정해 주세요.`);

// 새 버전이 있으면 여기서 설치하고 끝난다 (설치 뒤 같은 인자로 다시 뜬다). 실패하면 지금 버전으로 계속.
const relaunch = { file: process.execPath, args: [path.join(import.meta.dirname, 'launch.js'), ...args], cwd: process.cwd(), hidden: !process.stdout.isTTY };
const checked = await updateAtLaunch({ workspace, relaunch }).catch((e) => (console.log(`새 버전 확인 중 오류: ${e.message}`), null));
setLaunchInfo({ ...relaunch, checked });

process.argv = [process.argv[0], path.join(import.meta.dirname, 'server.js'), '--port', String(port), '--workspace', workspace];
await import('./server.js');
for (let i = 0; i < 50 && (await whoIsOnPort()) !== 'web-rpa'; i += 1) await sleep(200);
openScreen();
console.log('이 창을 닫으면 web-rpa 가 멈춥니다.');
