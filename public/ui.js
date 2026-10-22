// 화면 공용 도우미: DOM 만들기, 서버 요청, 알림(토스트), 서버 상태(SSE) 구독.
// app.js · ai-panel.js · editor-*.js 가 함께 쓴다.

// ---------- 작은 DOM 도우미 ----------
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'disabled') el.disabled = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
// append/replaceChildren 에 null 을 넘기면 "null" 글자가 들어가므로 빈 값을 걸러서 넣는다.
export const clean = (kids) => kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false);
export const add = (el, ...kids) => el.append(...clean(kids));
export const mount = (el, ...kids) => el.replaceChildren(...clean(kids));
/** 이름표 + 입력 칸 */
export const field = (label, input) => h('label', { class: 'field' }, h('span', null, label), input);
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'medium' }) : '');
export const fmtDur = (ms) => (ms === undefined ? '' : ms < 60000 ? `${(ms / 1000).toFixed(1)}초` : `${Math.floor(ms / 60000)}분 ${Math.round((ms % 60000) / 1000)}초`);
export const STATUS = { running: ['실행 중', 'acc'], paused: ['일시정지', 'warn'], 'waiting-user': ['확인 대기', 'warn'], done: ['완료', 'ok'], failed: ['실패 있음', 'bad'], stopped: ['중지됨', ''], idle: ['준비', ''] };
export const statusBadge = (s) => h('span', { class: `badge ${STATUS[s]?.[1] ?? ''}` }, STATUS[s]?.[0] ?? s);

/** 알림 한 줄: 한 번에 하나만 (새 알림이 앞 알림을 바꾼다 — 쌓여서 스텝 줄·일괄 막대를 가리지 않게) */
export function toast(message, kind = 'info') {
  const box = document.getElementById('toasts');
  box.replaceChildren();
  const t = h('div', { class: `toast ${kind}` }, message);
  box.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 8000 : 3500);
}

/** 서버 요청. 실패하면 서버의 오류 문구로 throw (e.status 에 상태 코드) */
export async function api(method, url, body, { raw = false } = {}) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined && !raw ? { 'content-type': 'application/json' } : undefined,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `요청 실패 (${res.status})`), { status: res.status });
  return data;
}
/** 오류를 토스트로 보여 주는 함수로 감싼다 */
export const safely = (fn) => async (...a) => {
  try {
    return await fn(...a);
  } catch (e) {
    toast(e.message, 'error');
    return undefined;
  }
};
export function download(name, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export async function uploadFile(file) {
  return api('POST', `/api/uploads?name=${encodeURIComponent(file.name)}`, file, { raw: true });
}

// ---------- 서버 상태 (SSE) ----------
export const live = { recording: null, run: null, log: [] };
const listeners = new Set();
/** 서버 이벤트 구독. 돌려준 함수를 부르면 구독을 끊는다 */
export function onLive(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emitLive(type, data) {
  for (const fn of listeners) fn(type, data);
  renderLivePill();
}
export function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => {
    const s = JSON.parse(e.data);
    live.recording = s.recording;
    live.run = s.run;
    live.log = s.run?.log ?? [];
    emitLive('state', s);
  });
  es.addEventListener('recording', (e) => {
    live.recording = JSON.parse(e.data);
    emitLive('recording', live.recording);
  });
  for (const t of ['run-log', 'run-status', 'run-progress', 'run-step', 'run-row']) {
    es.addEventListener(t, (e) => {
      const d = JSON.parse(e.data);
      if (!live.run || live.run.runId !== d.runId) live.run = { runId: d.runId, status: 'running' };
      if (d.recipeId) live.run.recipeId = d.recipeId; // 다른 곳(다른 창·API)에서 시작한 실행도 레시피 이름을 보이게
      if (d.recipeName) live.run.recipeName = d.recipeName;
      if (t === 'run-log') {
        live.log.push(d.line);
        if (live.log.length > 2000) live.log = live.log.slice(-1500);
      }
      if (t === 'run-status') {
        live.run.status = d.status;
        live.run.waiting = d.status === 'waiting-user' ? d.message : null;
      }
      if (t === 'run-progress') live.run.progress = d;
      if (t === 'run-step') live.run.current = d;
      if (t === 'run-row') live.run.row = d;
      emitLive(t, d);
    });
  }
  for (const t of ['agent-progress', 'agent-delta', 'agent-done', 'update']) es.addEventListener(t, (e) => emitLive(t, JSON.parse(e.data)));
  es.addEventListener('notice', (e) => {
    const d = JSON.parse(e.data);
    toast(d.message, d.level === 'error' ? 'error' : 'info');
  });
  es.onerror = () => {
    es.close();
    setTimeout(connect, 2000);
  };
}

function renderLivePill() {
  const box = document.getElementById('live');
  if (!box) return;
  mount(box);
  const r = live.recording;
  if (r && r.state !== 'stopped') {
    add(box, h('a', { class: 'pill rec', href: '#/record' }, h('span', { class: 'dot' }), r.state === 'paused' ? '녹화 일시정지' : '녹화 중'));
  }
  const run = live.run;
  if (run && ['running', 'paused', 'waiting-user'].includes(run.status)) {
    const p = run.progress;
    add(box, h('a', { class: 'pill run', href: '#/run' }, h('span', { class: 'dot' }), `${STATUS[run.status][0]}${p ? ` ${p.rowsDone}/${p.rowsTotal}행` : ''}`));
  }
}
