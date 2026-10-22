// 새 버전 확인·설치: 피드(latest.json) 읽기 → 버전 비교 → 설치 파일 내려받기(크기·sha256·Ed25519 서명 확인)
//   → 숨긴 PowerShell 이 지금 web-rpa 가 끝나기를 기다렸다가 설치 파일(/SILENT)을 돌리고 web-rpa 를 다시 띄운다.
// 실행기(launch.js — 시작할 때 자동 설치)와 서버(server.js — 화면 배너·설정)가 함께 쓴다. 의존성 없음(node:crypto 의 Ed25519).
//
// 시험용 환경 변수
//   WEB_RPA_UPDATE_URL     피드 주소 (설정보다 우선)
//   WEB_RPA_UPDATE_PUBKEY  서명 공개 키(base64 SPKI DER, 쉼표로 여러 개) — 앱 속 키 대신
//   WEB_RPA_UPDATE_KIND    설치 형태 installer | portable | source — 판별 대신
//   WEB_RPA_UPDATE_DRYRUN  파일 경로 — 설치 파일 실행·종료 대신 계획 JSON {setup, args, relaunch, pid} 을 기록

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { cmpSemver, isSemver } from './set/core.mjs';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const CURRENT_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
export const FEED_FORMAT = 'web-rpa-update';
export const FEED_FORMAT_VERSION = 1;
export const DEFAULT_FEED_URL = 'https://github.com/Tak002/web-rpa/releases/latest/download/latest.json';
export const RELEASES_PAGE = 'https://github.com/Tak002/web-rpa/releases/latest';
/** 설정 기본값: 시작할 때 확인하고, 새 버전이 있으면 묻지 않고 설치한다 (설치본만). */
export const UPDATE_DEFAULTS = Object.freeze({ check: true, auto: true, feedUrl: '' });
export const FEED_MAX_BYTES = 64 * 1024;
export const FEED_TIMEOUT_MS = 5000;
export const MAX_SETUP_BYTES = 300 * 1024 * 1024;
const DOWNLOAD_IDLE_MS = 60_000; // 이 시간 동안 한 바이트도 오지 않으면 내려받기를 멈춘다
const EXIT_WAIT_MS = 60_000; // 대기 스크립트가 web-rpa 종료를 기다리는 시간
const BOM = String.fromCharCode(0xfeff); // 대기 스크립트 머리 (Windows PowerShell 5.1 이 한글을 UTF-8 로 읽게)
const BOM_RE = new RegExp(`^${BOM}`);

/**
 * 앱에 넣은 업데이트 서명 공개 키 (Ed25519, base64 SPKI DER). 개인 키는 저장소 밖에 둔다 (scripts/update-key.mjs).
 * 키를 바꿀 때는 새 키를 이 배열에 더한 버전을 먼저 낸 뒤, 그다음 버전부터 새 키로 서명한다.
 */
export const PUBLIC_KEYS = [
  'MCowBQYDK2VwAyEAShNeqNH5wS7pT/xHyY3Q5l1BDc+rb4f6IT82ZlPytpg=', // 2026-10-22, 지문 f637a1ebb1bcd755…
];

const updateError = (message, code, status = 400) => Object.assign(new Error(message), { code, status });
const str = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;

// ---------------------------------------------------------------- 설치 형태·설정

/** installer(설치 파일로 설치: unins000.exe 와 같이 담은 node.exe) · portable(압축본: node.exe 만) · source(그 밖) */
export function installKind(root = ROOT) {
  const forced = process.env.WEB_RPA_UPDATE_KIND;
  if (['installer', 'portable', 'source'].includes(forced)) return forced;
  const base = path.dirname(root);
  if (!fs.existsSync(path.join(base, 'node', 'node.exe'))) return 'source';
  return fs.existsSync(path.join(base, 'unins000.exe')) ? 'installer' : 'portable';
}

/** settings.json 의 update 칸 → { check, auto, feedUrl } (빠진 칸은 기본값) */
export function updateConfigOf(data) {
  const u = data?.update && typeof data.update === 'object' ? data.update : {};
  return {
    check: typeof u.check === 'boolean' ? u.check : UPDATE_DEFAULTS.check,
    auto: typeof u.auto === 'boolean' ? u.auto : UPDATE_DEFAULTS.auto,
    feedUrl: typeof u.feedUrl === 'string' ? u.feedUrl : UPDATE_DEFAULTS.feedUrl,
  };
}

/** 실행기용: 서버를 띄우기 전에 작업 폴더의 settings.json 에서 업데이트 설정만 읽는다. */
export function readUpdateConfig(workspace) {
  try {
    return updateConfigOf(JSON.parse(fs.readFileSync(path.join(workspace, 'settings.json'), 'utf8')));
  } catch {
    return updateConfigOf({});
  }
}

/** 쓸 피드 주소: 환경 변수 → 설정 → 기본값 */
export const feedUrlOf = (cfg) => process.env.WEB_RPA_UPDATE_URL || cfg?.feedUrl || DEFAULT_FEED_URL;
/** 소스에서 실행하면 확인하지 않는다 (피드 환경 변수를 주면 확인) */
export const canCheck = (kind) => kind !== 'source' || !!process.env.WEB_RPA_UPDATE_URL;
export const updatesDir = (workspace) => path.join(workspace, 'updates');

/** 피드·내려받기 주소 검사: https 만 (이 PC 안의 시험용 주소는 http 도 허용) */
export function checkUpdateUrl(raw, what = '업데이트 피드 주소') {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    throw updateError(`${what}가 올바르지 않습니다: ${raw}`, 'url');
  }
  const loopback = u.hostname === 'localhost' || u.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(u.hostname);
  if (u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) return u.href;
  throw updateError(`${what}는 https:// 로 시작해야 합니다 (이 PC 안의 시험용 주소만 http 허용): ${raw}`, 'url');
}
const safeLink = (raw, base) => {
  try {
    return checkUpdateUrl(new URL(String(raw), base).href);
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- 버전·서명

/** latest 가 current 보다 새 버전일 때만 참 (같거나 낮으면 거짓 — 다운그레이드 막기) */
export const isNewer = (latest, current = CURRENT_VERSION) => isSemver(latest) && isSemver(current) && cmpSemver(latest, current) > 0;

/** 서명하는 글: 버전·sha256·크기를 묶는다 (옛 설치 파일을 새 버전인 척 다시 내밀지 못하게) */
export const signedMessage = (version, { sha256, size }) => Buffer.from(`web-rpa-update:1\n${version}\n${String(sha256).toLowerCase()}\n${size}`, 'utf8');

/** 쓸 공개 키 목록 (시험은 WEB_RPA_UPDATE_PUBKEY 로 바꾼다) */
export function publicKeys() {
  const env = process.env.WEB_RPA_UPDATE_PUBKEY;
  return env ? env.split(/[\s,]+/).filter(Boolean) : PUBLIC_KEYS;
}

/** 'ok' · 'missing'(서명 없음) · 'bad'(어느 공개 키로도 맞지 않음) */
export function verifyEntry(version, entry, keys = publicKeys()) {
  if (!entry?.signature) return 'missing';
  const sig = Buffer.from(entry.signature, 'base64');
  if (sig.length !== 64) return 'bad';
  const msg = signedMessage(version, entry);
  for (const k of keys) {
    try {
      const key = crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' });
      if (key.asymmetricKeyType === 'ed25519' && crypto.verify(null, msg, key, sig)) return 'ok';
    } catch {
      // 형식이 틀린 키는 건너뛴다
    }
  }
  return 'bad';
}

/** 개인 키(KeyObject 또는 PEM)로 서명 → base64 (package-win.mjs·시험) */
export const signEntry = (privateKey, version, entry) => crypto.sign(null, signedMessage(version, entry), privateKey).toString('base64');
/** 키(개인·공개) → 공개 키 base64 SPKI DER */
export const publicKeyOf = (key) => (key?.type === 'public' ? key : crypto.createPublicKey(key)).export({ type: 'spki', format: 'der' }).toString('base64');
/** 공개 키 지문: SPKI DER 의 sha256 hex */
export const keyFingerprint = (b64) => crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');

// ---------------------------------------------------------------- 피드

/** 받은 피드를 검사·정리한다 (모르는 칸은 버리고, 주소는 절대 주소로). 틀리면 throw. */
export function normalizeFeed(raw, feedUrl) {
  if (!raw || typeof raw !== 'object' || raw.format !== FEED_FORMAT) throw updateError('업데이트 피드 형식이 아닙니다 (format 이 web-rpa-update 가 아님).', 'format', 502);
  if (raw.formatVersion !== FEED_FORMAT_VERSION) throw updateError(`업데이트 피드 형식 버전 ${raw.formatVersion} 은(는) 지원하지 않습니다.`, 'format', 502);
  if (!isSemver(raw.version)) throw updateError('업데이트 피드의 version 이 1.2.3 같은 세 자리 버전이 아닙니다.', 'format', 502);
  const file = (f, what) => {
    if (!f || typeof f !== 'object') throw updateError(`업데이트 피드에 ${what} 정보가 없습니다.`, 'format', 502);
    let url;
    try {
      url = checkUpdateUrl(new URL(String(f.url ?? ''), feedUrl).href, `${what} 주소`);
    } catch (e) {
      throw updateError(e.message, 'url', 502);
    }
    const sha256 = str(f.sha256, 80).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw updateError(`업데이트 피드의 ${what} sha256 이 없거나 형식이 틀립니다.`, 'format', 502);
    const size = Number(f.size);
    if (!Number.isSafeInteger(size) || size <= 0) throw updateError(`업데이트 피드의 ${what} 크기(size)가 없거나 틀립니다.`, 'format', 502);
    if (size > MAX_SETUP_BYTES) throw updateError(`${what}이(가) 너무 큽니다 (${mb(size)}, 상한 ${mb(MAX_SETUP_BYTES)}).`, 'size', 502);
    const out = { url, sha256, size };
    const sig = str(f.signature, 200);
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(sig)) out.signature = sig;
    return out;
  };
  let zip = null;
  try {
    zip = raw.zip ? file(raw.zip, '압축본') : null;
  } catch {
    zip = null; // 압축본 정보가 틀려도 설치 파일 업데이트는 쓴다
  }
  return {
    version: raw.version,
    publishedAt: str(raw.publishedAt, 40) || null,
    notesUrl: raw.notesUrl ? safeLink(raw.notesUrl, feedUrl) : null,
    installer: file(raw.installer, '설치 파일'),
    zip,
  };
}

/** 피드 받기: 5초 제한, 64KB 상한. 실패는 code 를 단 Error (not-found · network · http · format · url · size) */
export async function fetchFeed(url, { timeoutMs = FEED_TIMEOUT_MS } = {}) {
  const href = checkUpdateUrl(url);
  let res;
  let buf;
  try {
    res = await fetch(href, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': `web-rpa/${CURRENT_VERSION}`, accept: 'application/json' } });
    if (res.status === 404) throw updateError('업데이트 피드가 없습니다 (HTTP 404).', 'not-found', 502);
    if (!res.ok) throw updateError(`업데이트 피드를 받지 못했습니다: HTTP ${res.status}`, 'http', 502);
    if (res.url) checkUpdateUrl(res.url); // 넘겨준(리디렉션) 주소도 https 여야 한다
    if (Number(res.headers.get('content-length')) > FEED_MAX_BYTES) throw updateError('업데이트 피드가 너무 큽니다.', 'size', 502);
    const chunks = [];
    let size = 0;
    for await (const c of res.body ?? []) {
      size += c.length;
      if (size > FEED_MAX_BYTES) throw updateError('업데이트 피드가 너무 큽니다.', 'size', 502);
      chunks.push(Buffer.from(c));
    }
    buf = Buffer.concat(chunks);
  } catch (e) {
    if (e.code && typeof e.status === 'number') throw e;
    const reason = e.name === 'TimeoutError' ? `${timeoutMs / 1000}초 안에 응답이 없습니다` : (e.cause?.code ?? e.cause?.message ?? e.message);
    throw updateError(`업데이트 피드를 받지 못했습니다: ${reason}`, 'network', 502);
  }
  let raw;
  try {
    raw = JSON.parse(buf.toString('utf8').replace(BOM_RE, ''));
  } catch {
    throw updateError('업데이트 피드가 JSON 이 아닙니다.', 'format', 502);
  }
  return normalizeFeed(raw, res.url || href);
}

// ---------------------------------------------------------------- 내려받기

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const c of fs.createReadStream(file)) hash.update(c);
  return hash.digest('hex');
}
async function closeStream(out) {
  if (out.closed) return;
  const done = once(out, 'close').catch(() => {});
  out.destroy();
  await done;
}

/**
 * 설치 파일 내려받기: 새 버전인지 → 서명 → (스트림으로) 크기·sha256. 하나라도 틀리면 받은 파일을 지우고 throw.
 * 같은 파일을 이미 받아 두었고 sha256 이 맞으면 다시 받지 않는다.
 * @returns {{ file: string, sha256: string, size: number, reused: boolean }}
 */
export async function downloadSetup(feed, { dir, keys = publicKeys(), current = CURRENT_VERSION, onProgress, maxBytes = MAX_SETUP_BYTES } = {}) {
  if (!isNewer(feed?.version, current)) throw updateError(`피드의 버전 ${feed?.version} 은(는) 지금 버전 ${current} 보다 새 버전이 아닙니다. 설치하지 않습니다.`, 'downgrade', 409);
  const entry = feed.installer;
  const sig = verifyEntry(feed.version, entry, keys);
  if (sig === 'missing') throw updateError('새 버전 설치 파일에 서명이 없어 자동으로 설치하지 않습니다. 내려받기 페이지에서 직접 받아 설치해 주세요.', 'signature');
  if (sig !== 'ok') throw updateError('새 버전 설치 파일의 서명이 맞지 않습니다 — 공식 배포본이 아니거나 바뀐 파일일 수 있어 설치하지 않습니다.', 'signature');
  if (entry.size > maxBytes) throw updateError(`설치 파일이 너무 큽니다 (${mb(entry.size)}, 상한 ${mb(maxBytes)}).`, 'size');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `web-rpa-setup-${feed.version}.exe`);
  const part = `${file}.part`;
  const st = await fsp.stat(file).catch(() => null);
  if (st?.size === entry.size && (await sha256File(file)) === entry.sha256) return { file, sha256: entry.sha256, size: entry.size, reused: true };
  await fsp.rm(file, { force: true });
  await fsp.rm(part, { force: true });

  const ac = new AbortController();
  let idle;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ac.abort(updateError(`설치 파일을 받는 중 ${DOWNLOAD_IDLE_MS / 1000}초 동안 응답이 없어 멈췄습니다.`, 'network', 502)), DOWNLOAD_IDLE_MS);
  };
  touch();
  let out = null;
  try {
    let res;
    try {
      res = await fetch(checkUpdateUrl(entry.url, '설치 파일 주소'), { signal: ac.signal, headers: { 'user-agent': `web-rpa/${CURRENT_VERSION}` } });
    } catch (e) {
      if (e.code === 'url') throw e;
      throw updateError(`설치 파일을 받지 못했습니다: ${e.cause?.code ?? e.cause?.message ?? e.message}`, 'network', 502);
    }
    if (!res.ok) throw updateError(`설치 파일을 받지 못했습니다: HTTP ${res.status}`, 'http', 502);
    if (Number(res.headers.get('content-length')) > entry.size) throw updateError(`설치 파일이 피드에 적힌 크기(${entry.size}바이트)보다 큽니다. 설치하지 않습니다.`, 'size');
    out = fs.createWriteStream(part);
    const hash = crypto.createHash('sha256');
    let received = 0;
    onProgress?.({ received, total: entry.size });
    for await (const c of res.body ?? []) {
      touch();
      received += c.length;
      if (received > entry.size) throw updateError(`설치 파일이 피드에 적힌 크기(${entry.size}바이트)보다 큽니다. 설치하지 않습니다.`, 'size');
      hash.update(c);
      if (!out.write(c)) await once(out, 'drain');
      onProgress?.({ received, total: entry.size });
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    if (received !== entry.size) throw updateError(`설치 파일 크기가 피드와 다릅니다 (피드 ${entry.size}바이트, 받은 파일 ${received}바이트). 설치하지 않습니다.`, 'size');
    const got = hash.digest('hex');
    if (got !== entry.sha256) {
      throw updateError(`내려받은 설치 파일의 sha256 이 피드와 다릅니다 — 중간에 바뀌었거나 손상된 파일일 수 있어 설치하지 않습니다. (피드 ${entry.sha256.slice(0, 12)}…, 받은 파일 ${got.slice(0, 12)}…)`, 'sha256');
    }
    await fsp.rename(part, file);
    return { file, sha256: got, size: received, reused: false };
  } catch (e) {
    if (out) await closeStream(out);
    await fsp.rm(part, { force: true }).catch(() => {});
    if (ac.signal.aborted && ac.signal.reason?.code) throw ac.signal.reason;
    throw e;
  } finally {
    clearTimeout(idle);
  }
}

/** 지금 버전 이하의 받아 둔 설치 파일·대기 스크립트를 지운다 (설치 로그는 남긴다). */
export async function cleanupUpdates(workspace, current = CURRENT_VERSION) {
  const dir = updatesDir(workspace);
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    const m = /^(?:web-rpa-setup|update)-(\d+\.\d+\.\d+)\.(?:exe|ps1)(\.part)?$/.exec(name);
    if (m && (m[2] || !isNewer(m[1], current))) await fsp.rm(path.join(dir, name), { force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------- 적용

/** 실행기가 서버를 띄우기 전에 남긴 정보 (다시 띄울 명령, 시작할 때 확인한 결과). 같은 프로세스 안에서만 쓴다. */
let launchInfo = null;
export const setLaunchInfo = (info) => (launchInfo = info);
export const getLaunchInfo = () => launchInfo;

/** 설치 계획: 설치 파일 명령줄과 다시 띄울 명령 */
export function updatePlan({ setup, version, workspace, relaunch, appDir = path.dirname(ROOT), pid = process.pid }) {
  const dir = updatesDir(workspace);
  return {
    setup,
    args: ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', `/DIR=${appDir}`, `/LOG=${path.join(dir, `setup-${version}.log`)}`],
    relaunch: { file: relaunch.file, args: relaunch.args, cwd: relaunch.cwd, hidden: !!relaunch.hidden },
    pid,
    from: CURRENT_VERSION,
    to: version,
    log: path.join(dir, 'update-log.txt'),
  };
}

const psq = (s) => `'${String(s).replaceAll("'", "''")}'`; // PowerShell 작은따옴표 문자열
/** 명령줄 인자 하나 (Windows CRT 규칙: 따옴표 앞·끝의 역슬래시는 두 배로) */
const cmdArg = (raw) => {
  const s = String(raw);
  if (s && !/[\s"]/.test(s)) return s;
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
};
const setupArg = (a) => {
  const m = /^(\/[A-Z]+=)(.*)$/.exec(a); // /DIR=경로 → /DIR="경로"
  return m ? `${m[1]}"${m[2]}"` : a;
};

/** 대기 스크립트 (PowerShell): PID 종료 대기 → 설치 파일 → 다시 띄우기 → update-log.txt 에 한 줄 */
export function waitScript(plan) {
  const head = `web-rpa ${plan.from} -> ${plan.to}`;
  return [
    "$ErrorActionPreference = 'Continue'",
    `$log = ${psq(plan.log)}`,
    'function Log([string]$m) { try { [IO.File]::AppendAllText($log, ((Get-Date).ToString(\'yyyy-MM-ddTHH:mm:sszzz\') + \' \' + $m + "`r`n"), (New-Object Text.UTF8Encoding($false))) } catch {} }',
    '$exited = $true',
    `try { $p = Get-Process -Id ${Number(plan.pid)} -ErrorAction Stop; $exited = $p.WaitForExit(${EXIT_WAIT_MS}) } catch {}`,
    `if (-not $exited) { Log ${psq(`${head}: 지금 실행 중인 web-rpa 가 ${EXIT_WAIT_MS / 1000}초 안에 끝나지 않아 설치하지 않았습니다`)}; exit 1 }`,
    'Start-Sleep -Milliseconds 500',
    '$code = -1',
    `try { $sp = Start-Process -FilePath ${psq(plan.setup)} -ArgumentList ${psq(plan.args.map(setupArg).join(' '))} -Wait -PassThru; $code = $sp.ExitCode } catch { Log (${psq(`${head}: 설치 파일을 실행하지 못했습니다: `)} + $_.Exception.Message) }`,
    `if ($code -eq 0) { Log ${psq(`${head}: 설치 완료`)} } else { Log (${psq(`${head}: 설치 실패 (종료 코드 `)} + $code + ${psq(`, 설치 로그 ${plan.args.find((a) => a.startsWith('/LOG='))?.slice(5) ?? ''})`)}) }`,
    `try { Start-Process -FilePath ${psq(plan.relaunch.file)} -ArgumentList ${psq(plan.relaunch.args.map(cmdArg).join(' '))} -WorkingDirectory ${psq(plan.relaunch.cwd)}${plan.relaunch.hidden ? ' -WindowStyle Hidden' : ''}; Log ${psq(`${head}: 다시 실행`)} } catch { Log (${psq(`${head}: 다시 실행하지 못했습니다: `)} + $_.Exception.Message) }`,
    '',
  ].join('\r\n');
}

/**
 * 계획대로 숨긴 PowerShell 대기 스크립트를 띄운다. 부른 쪽은 곧 스스로 끝나야 한다 (실행 중인 node.exe 는 바꿀 수 없다).
 * WEB_RPA_UPDATE_DRYRUN 이 있으면 띄우지 않고 계획만 기록한다 → { dryRun: true }
 *
 * 띄우는 방법: 대기 스크립트를 updates\update-<버전>.ps1 (UTF-8 BOM) 로 쓰고, 잠깐 도는 숨긴 PowerShell 이
 * `Start-Process -WindowStyle Hidden` 으로 그 스크립트를 새 (숨긴) 콘솔에서 띄운 뒤 끝난다.
 *   - Windows PowerShell 은 콘솔 없이(DETACHED_PROCESS = Node 의 detached) 띄우면 아무것도 하지 않고 0 으로 끝난다.
 *   - 그렇다고 그냥 자식으로 띄우면 Node 가 끝날 때 함께 끝난다 (libuv 가 자식을 kill-on-close 작업 개체에 넣는다).
 *   - Start-Process 로 띄운 손자는 그 작업 개체에 들지 않고(조용한 이탈 허용) 자기 콘솔을 숨긴 채로 받는다.
 */
export async function applyUpdate(plan) {
  const dry = process.env.WEB_RPA_UPDATE_DRYRUN;
  if (dry) {
    fs.mkdirSync(path.dirname(path.resolve(dry)), { recursive: true });
    fs.writeFileSync(dry, JSON.stringify(plan, null, 2));
    return { dryRun: true, plan };
  }
  if (process.platform !== 'win32') throw updateError('자동 설치는 Windows 에서만 됩니다.', 'platform');
  const dir = path.dirname(plan.log);
  fs.mkdirSync(dir, { recursive: true });
  const ps1 = path.join(dir, `update-${plan.to}.ps1`);
  fs.writeFileSync(ps1, BOM + waitScript(plan)); // BOM: Windows PowerShell 5.1 이 한글을 UTF-8 로 읽게
  const relay = `Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -WorkingDirectory ${psq(dir)} -ArgumentList ${psq(`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${ps1}"`)}`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(relay, 'utf16le').toString('base64')], {
    cwd: dir, // 앱 폴더를 붙잡지 않게
    stdio: 'ignore',
    windowsHide: true,
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  }).catch((e) => {
    throw updateError(`설치를 시작하지 못했습니다 (PowerShell): ${e.message}`, 'apply', 500);
  });
  if (code !== 0) throw updateError(`설치를 시작하지 못했습니다 (PowerShell 종료 코드 ${code}).`, 'apply', 500);
  return { dryRun: false, plan, script: ps1 };
}

// ---------------------------------------------------------------- 실행기: 시작할 때 자동 설치

/**
 * 설치본이고 update.check·update.auto 가 켜져 있으면 서버를 띄우기 전에 확인 → 내려받기(콘솔 진행률) → 적용 → 종료.
 * 어느 단계든 실패하면 한 줄 남기고 확인 결과를 돌려준다 (서버가 배너에 쓴다). 확인하지 않았으면 null.
 */
export async function updateAtLaunch({ workspace, relaunch, log = (m) => console.log(m), exit = (code) => process.exit(code) }) {
  const kind = installKind();
  const cfg = readUpdateConfig(workspace);
  if (kind !== 'installer' || !cfg.check || !cfg.auto) return null;
  const checkedAt = new Date().toISOString();
  let latest;
  try {
    latest = await fetchFeed(feedUrlOf(cfg));
  } catch (e) {
    log(`새 버전 확인: ${e.message} — 지금 버전(${CURRENT_VERSION})으로 실행합니다.`);
    return { checkedAt, latest: null, error: e.message, errorCode: e.code };
  }
  const checked = { checkedAt, latest, error: null, errorCode: null };
  if (!isNewer(latest.version)) return checked;
  log(`새 버전 ${latest.version} 이(가) 있습니다 (지금 ${CURRENT_VERSION}). 내려받아 설치합니다…`);
  try {
    let shown = -1;
    const dl = await downloadSetup(latest, {
      dir: updatesDir(workspace),
      onProgress: ({ received, total }) => {
        const pct = Math.floor((received / total) * 100);
        if (process.stdout.isTTY) process.stdout.write(`\r  내려받는 중 ${mb(received)} / ${mb(total)} (${pct}%)   `);
        else if (pct >= shown + 25 || received === total) log(`  내려받는 중 ${mb(received)} / ${mb(total)} (${pct}%)`);
        if (pct >= shown + 25) shown = pct;
      },
    });
    if (process.stdout.isTTY) process.stdout.write('\n');
    log(`  ${dl.reused ? '받아 둔 설치 파일' : '내려받은 설치 파일'}의 크기·sha256·서명을 확인했습니다.`);
    const r = await applyUpdate(updatePlan({ setup: dl.file, version: latest.version, workspace, relaunch }));
    if (r.dryRun) {
      log('  (시험) 설치 계획만 기록했습니다.');
      return checked;
    }
    log('설치 파일을 실행합니다. 설치가 끝나면 web-rpa 가 다시 열립니다.');
    exit(0);
    return checked;
  } catch (e) {
    if (process.stdout.isTTY) process.stdout.write('\n');
    log(`자동 업데이트를 하지 못했습니다: ${e.message} — 지금 버전(${CURRENT_VERSION})으로 실행합니다.`);
    return { ...checked, installError: { version: latest.version, message: e.message, code: e.code } };
  }
}

// ---------------------------------------------------------------- 서버: 상태·확인·설치

/**
 * 서버 쪽 업데이트 상태. 바뀔 때마다 onChange(view) 를 부른다 (SSE `update`).
 * @param {{ workspace: string, config: () => {check, auto, feedUrl}, onChange?: (view) => void, initial?: object }} opts
 */
export class Updater {
  constructor({ workspace, config, onChange = () => {}, initial = null }) {
    this.workspace = workspace;
    this.config = config;
    this.onChange = onChange;
    this.kind = installKind();
    this.startedAt = new Date().toISOString();
    this.checking = null; // 진행 중인 확인 Promise
    this.checkedAt = initial?.checkedAt ?? null;
    this.latest = initial?.latest ?? null;
    this.error = initial?.error ?? null;
    this.errorCode = initial?.errorCode ?? null;
    this.installError = initial?.installError ?? null; // { version, message, code }
    this.installing = null; // { version, phase: 'download' | 'restart', received, total }
    this.lastProgress = 0;
  }

  /** 시작할 때 확인할지 (설정의 "시작할 때 확인" + 설치 형태) */
  get enabled() {
    return canCheck(this.kind) && this.config().check;
  }

  view() {
    const latest = this.latest;
    const available = !!latest && isNewer(latest.version);
    const signature = latest ? verifyEntry(latest.version, latest.installer) : null;
    const failed = this.installError && latest && this.installError.version === latest.version ? this.installError : null;
    const cfg = this.config();
    return {
      current: CURRENT_VERSION,
      kind: this.kind,
      enabled: this.enabled,
      canCheck: canCheck(this.kind),
      auto: cfg.auto,
      feedUrl: feedUrlOf(cfg),
      startedAt: this.startedAt,
      checking: !!this.checking,
      checkedAt: this.checkedAt,
      latest: latest ? { version: latest.version, publishedAt: latest.publishedAt, notesUrl: latest.notesUrl, installer: { url: latest.installer.url, size: latest.installer.size, sha256: latest.installer.sha256 }, zip: latest.zip ? { url: latest.zip.url, size: latest.zip.size } : null } : null,
      available,
      signature,
      installable: available && this.kind === 'installer' && signature === 'ok',
      downloadUrl: latest?.notesUrl || RELEASES_PAGE,
      error: this.error,
      errorCode: this.errorCode,
      installError: failed ? { version: failed.version, message: failed.message, code: failed.code ?? null } : null,
      installing: this.installing ? { ...this.installing } : null,
    };
  }

  changed() {
    try {
      this.onChange(this.view());
    } catch {
      // 화면 알림 실패는 무시
    }
  }

  /** 피드 확인. 실패해도 throw 하지 않고 상태(error)에만 남긴다. */
  async check() {
    if (!canCheck(this.kind)) return this.view();
    if (this.checking) {
      await this.checking;
      return this.view();
    }
    this.checking = (async () => {
      try {
        this.latest = await fetchFeed(feedUrlOf(this.config()));
        this.error = null;
        this.errorCode = null;
      } catch (e) {
        this.latest = null;
        this.error = e.message;
        this.errorCode = e.code ?? null;
      } finally {
        this.checkedAt = new Date().toISOString();
      }
    })();
    this.changed();
    try {
      await this.checking;
    } finally {
      this.checking = null;
      this.changed();
    }
    return this.view();
  }

  /**
   * 새 버전 설치 준비: 내려받기·검증까지 하고 계획을 돌려준다. 실제 실행(applyUpdate)과 종료는 서버가 응답을 보낸 뒤에 한다.
   * @param {{ busy?: () => string | null, relaunch: object }} opts
   */
  async prepareInstall({ busy = () => null, relaunch }) {
    if (this.installing) throw updateError('이미 업데이트를 설치하는 중입니다.', 'installing', 409);
    const b = busy();
    if (b) throw updateError(`${b} (업데이트는 작업이 끝난 뒤에 설치합니다)`, 'busy', 409);
    if (this.kind !== 'installer') {
      throw updateError(this.kind === 'portable' ? '압축본은 자동으로 설치하지 않습니다. 내려받기 페이지에서 새 압축본을 받아 풀어 주세요.' : '소스에서 실행 중이라 자동으로 설치하지 않습니다.', 'kind');
    }
    if (!this.latest) await this.check();
    const latest = this.latest;
    if (!latest) throw updateError(`새 버전을 확인하지 못했습니다: ${this.error ?? '알 수 없는 오류'}`, this.errorCode ?? 'network', 502);
    if (!isNewer(latest.version)) throw updateError(`설치할 새 버전이 없습니다 (지금 ${CURRENT_VERSION}, 피드 ${latest.version}).`, 'downgrade', 409);
    this.installing = { version: latest.version, phase: 'download', received: 0, total: latest.installer.size };
    this.installError = null;
    this.changed();
    try {
      const dl = await downloadSetup(latest, {
        dir: updatesDir(this.workspace),
        onProgress: ({ received, total }) => {
          this.installing.received = received;
          const now = Date.now();
          if (now - this.lastProgress > 300 || received === total) {
            this.lastProgress = now;
            this.changed();
          }
        },
      });
      this.installing.phase = 'restart';
      this.changed();
      return updatePlan({ setup: dl.file, version: latest.version, workspace: this.workspace, relaunch });
    } catch (e) {
      this.installing = null;
      this.installError = { version: latest.version, message: e.message, code: e.code ?? null };
      this.changed();
      throw e;
    }
  }

  /** 계획 실행. 시험(dry-run)이면 기록만 하고 상태를 되돌린다. */
  async apply(plan) {
    try {
      const r = await applyUpdate(plan);
      if (r.dryRun) {
        this.installing = null;
        this.changed();
      }
      return r;
    } catch (e) {
      this.installing = null;
      this.installError = { version: plan.to, message: e.message, code: e.code ?? null };
      this.changed();
      throw e;
    }
  }
}
