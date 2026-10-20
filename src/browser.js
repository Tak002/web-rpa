// 브라우저 찾기·실행: PC 에 설치된 Chromium 계열 브라우저를 영속 프로필로 띄우고, iframe 경로를 계산한다.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

export const BROWSERS = [
  { id: 'auto', label: '자동 (Edge → Chrome → Brave → 내장 Chromium)' },
  { id: 'msedge', label: 'Microsoft Edge' },
  { id: 'chrome', label: 'Google Chrome' },
  { id: 'brave', label: 'Brave' },
  { id: 'chromium', label: '내장 Chromium (Playwright)' },
  { id: 'custom', label: '직접 지정' },
];

/** 실행 기록에 남길 사람이 읽는 이름 */
const DISPLAY = { msedge: 'Microsoft Edge', chrome: 'Google Chrome', brave: 'Brave', chromium: 'Chromium (내장)' };
const AUTO_ORDER = ['msedge', 'chrome', 'brave', 'chromium'];

// 브라우저별 실행 파일 위치 (Windows 는 Program Files·LocalAppData, 그 밖은 흔한 경로)
const WIN_REL = {
  msedge: ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
  chrome: ['Google', 'Chrome', 'Application', 'chrome.exe'],
  brave: ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
};
const OTHER_PATHS = {
  msedge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
  chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
  brave: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/usr/bin/brave-browser'],
};

const exists = (p) => {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

function findInstalled(id) {
  if (id === 'chromium') {
    try {
      const p = chromium.executablePath();
      return exists(p) ? p : null;
    } catch {
      return null;
    }
  }
  const list = [];
  if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432, process.env.LOCALAPPDATA].filter(Boolean);
    for (const r of new Set(roots)) list.push(path.join(r, ...WIN_REL[id]));
  } else list.push(...(OTHER_PATHS[id] ?? []));
  return list.find(exists) ?? null;
}

/** 설정 화면용: 브라우저마다 설치 여부와 경로. */
export function detectBrowsers() {
  const found = Object.fromEntries(AUTO_ORDER.map((id) => [id, findInstalled(id)]));
  const autoId = AUTO_ORDER.find((id) => found[id]);
  return BROWSERS.map((b) => {
    if (b.id === 'auto') return { ...b, found: !!autoId, path: autoId ? found[autoId] : '' };
    if (b.id === 'custom') return { ...b, found: true, path: '' };
    return { ...b, found: !!found[b.id], path: found[b.id] ?? '' };
  });
}

/** 브라우저마다 프로필 폴더를 나눈다. 자동·Edge 는 예전 기본 프로필을 그대로 쓴다. */
export function profileNameFor(id) {
  if (!id || id === 'auto' || id === 'msedge') return 'default';
  return BROWSERS.some((b) => b.id === id) ? id : 'default';
}

/** {id, path?} | 'id' | 실행 파일 경로 | 없음 → { id, path, name } */
function resolveBrowser(browser) {
  let spec = browser ?? (process.env.WEB_RPA_BROWSER || 'auto');
  if (typeof spec === 'string') {
    const s = spec.trim().replace(/^"(.*)"$/, '$1');
    spec = /[\\/]/.test(s) ? { id: 'custom', path: s } : { id: s || 'auto' };
  }
  const id = spec.id || 'auto';
  if (id === 'custom') {
    const p = String(spec.path ?? '').trim().replace(/^"(.*)"$/, '$1');
    if (!exists(p)) throw new Error(`직접 지정한 브라우저 실행 파일이 없습니다: ${p || '(비어 있음)'}`);
    return { id, path: p, name: `직접 지정 (${path.basename(p)})` };
  }
  if (id === 'auto') {
    for (const cand of AUTO_ORDER) {
      const p = findInstalled(cand);
      if (p) return { id: cand, path: p, name: DISPLAY[cand] };
    }
    throw new Error('설치된 브라우저를 찾지 못했습니다. Edge·Chrome·Brave 중 하나를 설치하거나 설정에서 실행 파일을 직접 지정해 주세요.');
  }
  if (!DISPLAY[id]) throw new Error(`알 수 없는 브라우저: ${id}`);
  const p = findInstalled(id);
  if (!p) {
    const hint = id === 'chromium' ? ' (npx playwright install chromium 으로 설치할 수 있습니다)' : '';
    throw new Error(`${DISPLAY[id]} 이(가) 이 PC 에 설치돼 있지 않습니다${hint}. 설정에서 다른 브라우저를 골라 주세요.`);
  }
  return { id, path: p, name: DISPLAY[id] };
}

/** 같은 프로필을 다른 브라우저 창이 쓰고 있는지 (Windows 는 lockfile 을 독점으로 연다). */
function profileInUse(dir) {
  if (process.platform === 'win32') {
    const lock = path.join(dir, 'lockfile');
    if (!fs.existsSync(lock)) return false;
    try {
      fs.closeSync(fs.openSync(lock, 'r+'));
      return false;
    } catch (e) {
      return ['EBUSY', 'EPERM', 'EACCES'].includes(e.code);
    }
  }
  try {
    const target = fs.readlinkSync(path.join(dir, 'SingletonLock'));
    const pid = Number(String(target).split('-').pop());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const busyError = (dir) =>
  Object.assign(new Error(`브라우저 프로필이 이미 사용 중입니다. 같은 프로필로 열린 녹화·실행 브라우저 창을 닫은 뒤 다시 시도해 주세요. (${dir})`), { status: 409 });

export const DEFAULT_VIEWPORT = { width: 1366, height: 900 };

/**
 * 영속 프로필 BrowserContext 를 연다. 다운로드 허용, 한국어(ko-KR).
 * @param {{profileDir: string, headless?: boolean, viewport?: object|null, browser?: object|string, recordVideo?: {dir: string, size?: object}}} opts
 */
export async function startBrowser({ profileDir, headless = false, viewport, browser, recordVideo } = {}) {
  if (!profileDir) throw new Error('브라우저 프로필 폴더가 지정되지 않았습니다.');
  const b = resolveBrowser(browser);
  fs.mkdirSync(profileDir, { recursive: true });
  if (profileInUse(profileDir)) throw busyError(profileDir);
  // 화면 표시 모드는 창 크기에 맞춰 그린다(사람이 창을 키우면 페이지도 커진다). 숨김 모드는 고정 크기.
  const vp = viewport !== undefined ? viewport : headless ? DEFAULT_VIEWPORT : null;
  const args = [
    // 자동화 브라우저 표시(navigator.webdriver 등)를 끈다: 사이트가 자동화라는 이유로 다르게 동작하지 않게.
    '--disable-blink-features=AutomationControlled',
    // 가려지거나 뒤로 간 창·탭에서도 타이머와 렌더링이 느려지지 않게.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (!headless && vp === null) args.push('--window-size=1400,960');
  const options = {
    executablePath: b.path,
    headless,
    viewport: vp,
    acceptDownloads: true,
    locale: 'ko-KR',
    args,
    ignoreDefaultArgs: ['--enable-automation'],
  };
  if (recordVideo?.dir) options.recordVideo = { dir: recordVideo.dir, size: recordVideo.size ?? (vp ? { width: vp.width, height: vp.height } : { width: 1280, height: 800 }) };
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(profileDir, options);
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/ProcessSingleton|already in use|existing browser session|user data dir|SingletonLock|lock file/i.test(msg) || profileInUse(profileDir)) throw busyError(profileDir);
    if (/has been closed|exited|Browser closed/i.test(msg)) throw new Error(`${b.name} 을(를) 시작하지 못했습니다. 같은 프로필의 브라우저가 열려 있거나 실행 파일이 맞지 않을 수 있습니다. (${msg.split('\n')[0]})`);
    throw new Error(`${b.name} 을(를) 시작하지 못했습니다: ${msg.split('\n')[0]}`);
  }
  ctx.__channel = b.name;
  ctx.__browserId = b.id;
  ctx.__browserPath = b.path;
  return ctx;
}

/** 브라우저 버전 문자열 (실행 기록용, 실패하면 빈 값). */
export async function browserVersion(ctx) {
  try {
    const page = ctx.pages()[0];
    if (!page) return '';
    const cdp = await ctx.newCDPSession(page);
    const v = await cdp.send('Browser.getVersion');
    await cdp.detach().catch(() => {});
    return v.product ?? '';
  } catch {
    return '';
  }
}

// ---------- 프레임 경로 ----------

/** 프레임 → 바깥에서 안쪽 순서의 [{ name, url, index }] (메인 프레임이면 빈 배열). */
export function framePathOf(frame) {
  const out = [];
  for (let f = frame; f && f.parentFrame(); f = f.parentFrame()) {
    const parent = f.parentFrame();
    out.unshift({ name: f.name() || '', url: f.url(), index: parent.childFrames().indexOf(f) });
  }
  return out;
}

const stripQuery = (u) => String(u ?? '').split(/[?#]/)[0];

/** 프레임 경로를 이름 → 주소 → 순번으로 따라간다. 못 따라가면 null. */
export function resolveFramePath(page, framePath = []) {
  let frame = page.mainFrame();
  for (const seg of framePath ?? []) {
    const kids = frame.childFrames().filter((f) => !f.isDetached());
    let next = null;
    if (seg.name) {
      const byName = kids.filter((f) => f.name() === seg.name);
      if (byName.length === 1) next = byName[0];
    }
    if (!next && seg.url) {
      const exact = kids.filter((f) => f.url() === seg.url);
      if (exact.length === 1) next = exact[0];
      else {
        const loose = kids.filter((f) => stripQuery(f.url()) === stripQuery(seg.url));
        if (loose.length === 1) next = loose[0];
      }
    }
    if (!next && Number.isInteger(seg.index) && kids[seg.index]) next = kids[seg.index];
    if (!next) return null;
    frame = next;
  }
  return frame;
}
