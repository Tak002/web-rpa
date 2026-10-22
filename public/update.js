// 새 버전 안내: 모든 화면 위의 배너 + 설정 화면의 "업데이트" 카드.
// 서버 상태는 GET /api/update 와 SSE `update` 로 받는다. 설치는 POST /api/update/install — 서버가 끝났다가 새 버전으로 다시 뜨면 화면을 새로 고친다.

import { h, mount, api, toast, onLive, fmtTime, safely } from '/ui.js';

let state = null; // 서버의 업데이트 상태 (view)
let pending = null; // 이 화면에서 [지금 업데이트] 를 누른 뒤: { version, from, phase: 'request' | 'restart' }
let waiting = null; // 다시 뜨기를 기다리는 타이머
let bar = null;
const listeners = new Set();
const KIND = { installer: '설치본', portable: '압축본', source: '소스에서 실행' };
const DISMISS_KEY = 'web-rpa:update-dismissed';
const mbOf = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;

/** 닫은 배너: 이번 실행(서버를 띄운 때) 동안 그 버전은 다시 보이지 않는다 */
const dismissKey = (s) => `${s.latest?.version}@${s.startedAt}`;
function dismissed(s) {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === dismissKey(s);
  } catch {
    return false;
  }
}
function dismiss(s) {
  try {
    sessionStorage.setItem(DISMISS_KEY, dismissKey(s));
  } catch {
    // 저장소를 못 쓰면 이 화면에서만 숨긴다
  }
  s.__dismissed = true;
  render();
}

function setState(s) {
  if (!s || typeof s !== 'object') return;
  if (state?.__dismissed && state.latest?.version === s.latest?.version) s.__dismissed = true;
  state = s;
  // 응답을 받은 뒤 서버가 설치 파일을 띄우지 못한 경우: 기다리기를 그만두고 오류를 보인다
  if (pending?.phase === 'restart' && !s.installing && s.installError?.version === pending.version) {
    pending = null;
    clearInterval(waiting);
    waiting = null;
    toast(s.installError.message, 'error');
  }
  if (s.installing?.phase === 'restart' && !waiting) waitForRestart(s.current);
  render();
  for (const fn of listeners) fn(s);
}

/** 앱 셸에 배너 자리를 만들고 상태를 받기 시작한다 */
export function initUpdate() {
  bar = h('div', { id: 'update-banner', class: 'update-banner', role: 'status', hidden: true });
  const top = document.querySelector('header.top');
  if (top) top.after(bar);
  else document.body.prepend(bar);
  onLive((type, d) => {
    if (type === 'update') setState(d);
  });
  api('GET', '/api/update').then(setState, () => {});
}

/** 서버가 끝났다가 새 버전으로 다시 뜨면 새로 고친다 (5분까지 기다린다) */
function waitForRestart(from) {
  const started = Date.now();
  clearInterval(waiting);
  waiting = setInterval(async () => {
    try {
      const res = await fetch('/api/update', { cache: 'no-store' });
      const s = await res.json();
      if (res.ok && s.current && s.current !== from) {
        clearInterval(waiting);
        location.reload();
        return;
      }
    } catch {
      // 아직 내려가 있는 중
    }
    if (Date.now() - started > 5 * 60_000) {
      clearInterval(waiting);
      waiting = null;
      if (pending) pending.phase = 'slow';
      render();
    }
  }, 1500);
}

async function install() {
  const s = state;
  if (!s?.installable) return;
  if (!confirm(`새 버전 ${s.latest.version} 을(를) 설치할까요?\n\nweb-rpa 가 잠시 꺼졌다가 다시 열립니다. 편집 중인 레시피는 먼저 저장해 주세요.`)) return;
  pending = { version: s.latest.version, from: s.current, phase: 'request' };
  render();
  try {
    const r = await api('POST', '/api/update/install');
    pending.phase = 'restart';
    render();
    if (!r.dryRun) waitForRestart(s.current);
  } catch (e) {
    pending = null;
    toast(e.message, 'error');
    render();
  }
}

function render() {
  if (!bar) return;
  const s = state;
  const inst = s?.installing;
  const phase = pending?.phase ?? (inst?.phase === 'restart' ? 'restart' : inst ? 'download' : null);
  if (phase) {
    const version = pending?.version ?? inst?.version ?? '';
    const progress = inst?.phase === 'download' && inst.total ? ` ${mbOf(inst.received ?? 0)} / ${mbOf(inst.total)} (${Math.floor(((inst.received ?? 0) / inst.total) * 100)}%)` : '';
    const text =
      phase === 'slow'
        ? `새 버전 ${version} 설치가 오래 걸립니다. web-rpa 가 다시 열리지 않으면 시작 메뉴의 web-rpa 를 눌러 주세요.`
        : phase === 'restart'
          ? `새 버전 ${version} 을(를) 설치하는 중입니다. 설치가 끝나면 web-rpa 가 다시 열립니다 — 이 화면은 저절로 새로 고쳐집니다.`
          : `새 버전 ${version} 을(를) 내려받는 중…${progress}`;
    bar.hidden = false;
    bar.className = 'update-banner busy';
    mount(bar, h('span', { class: 'ub-dot' }), h('span', { class: 'ub-text' }, text));
    return;
  }
  if (!s?.available || s.__dismissed || dismissed(s)) {
    bar.hidden = true;
    mount(bar);
    return;
  }
  const v = s.latest.version;
  let why = null;
  if (s.kind === 'portable') why = '압축본은 새 압축본을 내려받아 풀어 쓰세요 (작업 데이터는 그대로 남습니다).';
  else if (s.kind === 'installer' && s.signature !== 'ok') why = s.signature === 'missing' ? '설치 파일에 서명이 없어 자동으로 설치하지 않습니다.' : '설치 파일 서명이 맞지 않아 자동으로 설치하지 않습니다.';
  else if (s.installError) why = `지난번 설치를 하지 못했습니다: ${s.installError.message}`;
  bar.hidden = false;
  bar.className = 'update-banner';
  mount(
    bar,
    h('span', { class: 'ub-text' }, h('b', null, `새 버전 ${v}`), ` 이(가) 나왔습니다 (지금 ${s.current}).`, why ? h('span', { class: 'ub-why' }, ` ${why}`) : null),
    h(
      'span',
      { class: 'ub-actions' },
      s.latest.notesUrl ? h('a', { class: 'btn sm', href: s.latest.notesUrl, target: '_blank', rel: 'noopener noreferrer' }, '변경 내용') : null,
      s.installable ? h('button', { class: 'sm primary', onclick: install }, '지금 업데이트') : h('a', { class: 'btn sm primary', href: s.downloadUrl, target: '_blank', rel: 'noopener noreferrer' }, '내려받기 페이지'),
      h('button', { class: 'sm ghost', 'aria-label': '이 안내 닫기', title: '이번 실행 동안 이 버전 안내를 숨깁니다', onclick: () => dismiss(s) }, '닫기'),
    ),
  );
}

/** 마지막 확인 결과 한 줄 */
function statusText(s) {
  if (!s) return '상태를 불러오는 중…';
  if (!s.canCheck) return '소스에서 실행 중이라 새 버전을 확인하지 않습니다 (git pull 로 받으세요).';
  if (s.checking) return '확인하는 중…';
  if (!s.checkedAt) return '아직 확인하지 않았습니다.';
  const at = fmtTime(s.checkedAt);
  if (s.error) return `${at} 확인 못 함 — ${s.error}`;
  if (s.available) return `${at} 확인 — 새 버전 ${s.latest.version} 이(가) 있습니다.${s.installable ? ' 위 안내의 [지금 업데이트] 로 설치합니다.' : ''}`;
  return `${at} 확인 — 최신 버전입니다 (피드 ${s.latest?.version ?? '?'}).`;
}

/** 설정 화면: 업데이트 카드. u = /api/settings 의 update */
export function updateCard(u, redraw) {
  const check = h('input', { type: 'checkbox', checked: u.check });
  const auto = h('input', { type: 'checkbox', checked: u.auto });
  const feed = h('input', { type: 'text', value: u.feedUrl ?? '', placeholder: u.feedDefault, 'aria-label': '업데이트 피드 주소' });
  const status = h('div', { class: 'small update-status' });
  const head = h('p', { class: 'muted small', style: 'margin:0' });
  const checkBtn = h(
    'button',
    {
      onclick: safely(async () => {
        checkBtn.disabled = true;
        mount(status, '확인하는 중…');
        try {
          setState(await api('POST', '/api/update/check'));
        } finally {
          checkBtn.disabled = false;
        }
      }),
    },
    '지금 확인',
  );
  const draw = (s) => {
    mount(head, `지금 버전 ${s?.current ?? '?'} · ${KIND[s?.kind] ?? '확인 중'}. 새 버전은 서명(Ed25519)과 sha256 을 확인한 뒤에만 설치합니다. 작업 데이터(레시피·실행 결과·설정)는 그대로 남습니다.`);
    mount(status, statusText(s));
    checkBtn.disabled = !!s && (!s.canCheck || s.checking);
  };
  draw(state);
  // 화면을 옮겨 카드가 사라지면 구독을 끊는다
  let shown = false;
  const listener = (s) => {
    if (status.isConnected) {
      shown = true;
      draw(s);
    } else if (shown) listeners.delete(listener);
  };
  listeners.add(listener);
  if (!state) api('GET', '/api/update').then(setState, () => {});
  return h(
    'div',
    { class: 'card stack update-card' },
    h('h2', null, '업데이트'),
    head,
    h('label', { class: 'check update-check' }, check, h('span', null, '시작할 때 새 버전 확인')),
    h('label', { class: 'check update-check' }, auto, h('span', null, '새 버전이 있으면 시작할 때 묻지 않고 설치 (설치본만 · 끄면 위 안내의 [지금 업데이트] 로 설치)')),
    h('label', { class: 'field' }, h('span', null, '피드 주소 (비우면 기본값)'), feed),
    u.feedFromEnv ? h('div', { class: 'small' }, '지금은 환경 변수 WEB_RPA_UPDATE_URL 의 피드 주소를 씁니다.') : null,
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'primary',
          onclick: safely(async () => {
            await api('PUT', '/api/settings', { update: { check: check.checked, auto: auto.checked, feedUrl: feed.value.trim() } });
            toast('업데이트 설정을 저장했습니다.');
            await redraw();
          }),
        },
        '저장',
      ),
      checkBtn,
    ),
    status,
  );
}
