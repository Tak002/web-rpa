// AI 도우미 패널: 앱 셸에 하나만 둔다(모든 화면). 대화는 레시피 단위로 서버에 저장되고(GET /api/agent/thread),
// 화면을 옮겨도 열림 상태·입력 중 글·대기 제안이 그대로 남는다.
//
// 화면 모듈이 쓰는 함수:
//   initAiPanel()                         앱 시작 때 한 번 (상단 막대 단추 + 패널)
//   setAiScope({ page, recipeId, fixed }) 라우터가 화면을 바꿀 때 (화면 맥락을 비운다)
//   setAiRecipe(id, { name, onSaved })    화면이 레시피를 정했을 때 (편집·실행·리포트)
//   setAiContext({ … })                   화면 맥락: openStepId, selectedStepIds, upload, uploadId, runId, rowNumber
//   setAiEditor({ recipeId, getRecipe, applyRecipe } | null)  편집기가 열려 있는 동안
//   toggleAi(force?) · askAi({ draft, context }) · aiAskButton(draft, context)

import { h, add, mount, api, safely, toast, onLive } from '/ui.js';
import { stepNumbers } from '/shared/recipe-edit.js';

const AI_EXAMPLES = [
  '입력값들을 엑셀 열로 바꿔 줘',
  '조회 결과 화면에서 금액을 읽어서 결과 엑셀에 남겨 줘',
  '조회 결과가 없다는 알림이 뜨면 그 행은 실패로 표시하고 넘어가게 해 줘',
  '결과 표의 행마다 상세 화면을 PDF 로 저장해 줘',
  '이 레시피가 하는 일을 순서대로 설명해 줘',
];
const PAGE_LABEL = { editor: '편집기', run: '실행 화면', report: '리포트', recipes: '레시피 목록', other: '다른 화면' };
const STATE_LABEL = { applied: '적용함', discarded: '버림', merged: '다음 제안에 합쳐짐', pending: '대기 중' };
const SS_KEY = 'rpa:aiPanel'; // 열림·입력 중 글 (새로 고침해도 남게, 탭마다)
const LAST_KEY = 'rpa:aiRecipe'; // 레시피를 정하지 않는 화면에서 고를 마지막 레시피

const st = {
  open: false,
  page: 'other',
  recipeId: null, // 지금 보이는 대화의 레시피
  recipeName: '',
  fixed: false, // 화면이 레시피를 정했는지 (편집·실행·리포트)
  view: null, // GET /api/agent/thread 결과
  busy: null, // 이 화면에서 보낸 턴의 레시피 id
  local: null, // 보내는 중인 요청 { recipeId, text, context } — 서버 표시에 들어가기 전까지 보여 준다
  localError: null, // { recipeId, text }
  stream: null, // { recipeId, parts: [{ round, text }] } — agent-delta 조각
  pageCtx: {}, // 화면이 넣는 맥락
  pinCtx: {}, // [✦ AI 에게] 로 넣은 맥락 (보내면 비운다)
  drafts: {}, // 레시피 id → 입력 중 글
  editor: null,
  onSaved: null,
  settings: null,
  recipes: null,
  switched: null, // 화면 때문에 대화 레시피가 바뀌었을 때 { fromId, fromName, toName, page, onReturn }
  onReturn: null, // 화면이 준 "그 레시피로 돌아가기" (실행 화면: 그 레시피를 고른다)
};
let el = null; // 패널 요소들 (initAiPanel 이 만든다)
const narrow = () => storage(() => matchMedia('(max-width: 760px)').matches, false);

const isRunning = () => !!st.recipeId && (st.busy === st.recipeId || !!st.view?.running);
const firstLine = (s) => String(s ?? '').split('\n')[0];
const short = (s, n = 60) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

function storage(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback; // 저장 불가 환경
  }
}
function saveSession() {
  if (st.recipeId) st.drafts[st.recipeId] = el.input.value;
  storage(() => sessionStorage.setItem(SS_KEY, JSON.stringify({ open: st.open, drafts: st.drafts, free: st.recipeId ? '' : el.input.value })));
}

// =====================================================================
// 패널 만들기
// =====================================================================
export function initAiPanel() {
  if (el) return;
  const saved = storage(() => JSON.parse(sessionStorage.getItem(SS_KEY) || 'null'), null);
  st.drafts = saved?.drafts && typeof saved.drafts === 'object' ? saved.drafts : {};

  const input = h('textarea', { placeholder: narrow() ? '레시피를 어떻게 고칠지 말해 주세요.' : '레시피를 어떻게 고칠지 말해 주세요. (Ctrl+Enter 로 보내기)', rows: 3, 'aria-label': 'AI 에게 보낼 요청' });
  input.value = saved?.free ?? '';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
  });
  input.addEventListener('input', saveSession);
  el = {
    input,
    top: h('button', { class: 'ai-btn ai-top', title: 'AI 도우미와 대화 (모든 화면에서 열 수 있습니다)', onclick: () => toggleAi() }),
    switched: h('div', { class: 'ai-switched' }),
    mismatch: h('div', { class: 'ai-mismatch' }),
    model: h('span', { class: 'muted small ai-model' }),
    scope: h('div', { class: 'ai-scope' }),
    settings: h('div', { class: 'ai-settings', hidden: true }),
    notes: h('div', { class: 'ai-notes', hidden: true }),
    thread: h('div', { class: 'ai-thread' }),
    progress: h('div', { class: 'ai-progress' }),
    ctx: h('div', { class: 'ai-ctx small' }),
    risky: h('input', { type: 'checkbox' }),
    send: h('button', { class: 'primary', onclick: () => send() }, '보내기'),
    clear: h('button', { class: 'ghost sm', onclick: clearThread }, '대화 지우기'),
    notesBtn: h('button', { class: 'ghost sm', onclick: () => toggleBox('notes') }, '메모'),
  };
  el.panel = h(
    'aside',
    { class: 'ai-panel', hidden: true, 'aria-label': 'AI 도우미' },
    h(
      'div',
      { class: 'ai-head' },
      h('b', null, '✦ AI 도우미'),
      h('div', { style: 'flex:1' }),
      el.notesBtn,
      h('button', { class: 'ghost sm', onclick: () => toggleBox('settings') }, '설정'),
      el.clear,
      h('button', { class: 'ghost icon', title: '닫기', onclick: () => toggleAi(false) }, '✕'),
    ),
    el.scope,
    el.mismatch,
    el.switched,
    el.settings,
    el.notes,
    el.thread,
    el.progress,
    h(
      'div',
      { class: 'ai-input' },
      el.ctx,
      input,
      h('div', { class: 'row ai-send-row' }, h('label', { class: 'check small' }, el.risky, '화면 관찰 때 제출·결제 같은 버튼도 누르기 허용'), el.send),
    ),
  );
  el.panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggleAi(false);
  });
  document.querySelector('header.top')?.append(el.top);
  document.body.append(el.panel);
  onLive(onEvent);
  drawTop();
  drawAll();
  if (saved?.open) toggleAi(true, { focus: false });
}

/** 패널 열기·닫기 */
export function toggleAi(force, { focus = true } = {}) {
  st.open = force ?? !st.open;
  el.panel.hidden = !st.open;
  document.body.classList.toggle('ai-open', st.open);
  saveSession();
  if (!st.open) return;
  loadSettings();
  if (!st.fixed || !st.recipeId) loadRecipes();
  if (st.recipeId) loadThread();
  drawAll();
  if (focus) el.input.focus();
}

/** 라우터: 화면이 바뀔 때. fixed 면 화면이 곧 레시피를 정한다(그동안 지금 대화를 그대로 둔다). */
export function setAiScope({ page = 'other', recipeId, fixed = !!recipeId } = {}) {
  if (!el) return;
  st.page = page;
  st.pageCtx = {};
  st.onSaved = null;
  st.fixed = fixed;
  st.onReturn = null;
  st.switched = null; // 안내는 그 안내가 뜬 화면에서만
  if (recipeId) switchRecipe(recipeId); // 편집기: 사용자가 그 레시피를 직접 열었다 — 안내 없이 패널을 맞춘다
  else if (!fixed && !st.recipeId) {
    const last = storage(() => localStorage.getItem(LAST_KEY), null);
    if (last) switchRecipe(last);
  }
  if (st.open && (!st.fixed || !st.recipeId)) loadRecipes();
  drawScope();
  drawCtx();
}

/**
 * 화면이 레시피를 정했을 때 (편집기·실행·리포트). onReturn(id) 를 주면 "이 대화로 바뀌었습니다" 안내의
 * [돌아가기] 가 화면의 레시피도 그 레시피로 바꾼다 (실행 화면).
 */
export function setAiRecipe(recipeId, { name, onSaved, onReturn, notice = false } = {}) {
  if (!el) return;
  st.fixed = !!recipeId;
  st.onSaved = onSaved ?? null;
  st.onReturn = onReturn ?? null;
  // notice: 화면이 레시피를 바꿔 대화가 바뀌었음을 알린다 (실행 화면의 고르기). 편집기·리포트는 사용자가 연 레시피라 알리지 않는다
  if (recipeId) switchRecipe(recipeId, name, { byScreen: notice });
  drawScope();
}

/** 지금 대화 중인 레시피 id (없으면 null) — 실행 화면이 기본으로 고른다 */
export function getAiRecipe() {
  return st.recipeId ?? storage(() => localStorage.getItem(LAST_KEY), null) ?? null;
}

/** 화면 맥락을 더한다 (undefined 값은 지운다) */
export function setAiContext(patch) {
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === undefined || v === null || (Array.isArray(v) && !v.length)) delete st.pageCtx[k];
    else st.pageCtx[k] = v;
  }
  if (el) drawCtx();
}

/** 편집기 연결: 열려 있는 동안 대기 제안을 편집기 상태에 적용한다(저장은 편집기에서) */
export function setAiEditor(bridge) {
  st.editor = bridge ?? null;
  if (!el) return;
  drawMismatch();
  drawThread();
  drawCtx();
}

/** [✦ AI 에게]: 맥락을 넣고 패널을 열어 입력창에 초안을 넣는다 (바로 보내지 않는다) */
export function askAi({ draft = '', context = {} } = {}) {
  st.pinCtx = { ...st.pinCtx, ...context };
  toggleAi(true, { focus: false });
  const cur = el.input.value.replace(/\s+$/, '');
  el.input.value = cur ? `${cur}\n${draft}` : draft;
  el.input.focus();
  el.input.setSelectionRange(el.input.value.length, el.input.value.length);
  saveSession();
  drawCtx();
}

/** 스텝·실패 행 옆의 [✦ AI 에게] 단추. draft 는 글자 또는 글자를 돌려주는 함수 */
export function aiAskButton(draft, context = {}) {
  return h(
    'button',
    {
      class: 'sm ai-ask',
      title: '이 내용을 맥락으로 AI 도우미 입력창에 넣습니다',
      onclick: (e) => {
        e.stopPropagation();
        askAi({ draft: typeof draft === 'function' ? draft() : draft, context });
      },
    },
    '✦ AI 에게',
  );
}

// =====================================================================
// 대화 불러오기·바꾸기
// =====================================================================
/** 위 메뉴 [실행] 링크가 지금 대화 중인 레시피를 고른 채 열리게 한다 */
function syncNav() {
  const a = document.querySelector('#nav a[data-nav="run"]');
  if (a) a.setAttribute('href', st.recipeId ? `#/run?recipe=${encodeURIComponent(st.recipeId)}` : '#/run');
}

function switchRecipe(id, name, { byScreen = false } = {}) {
  if (id === st.recipeId) {
    if (name) st.recipeName = name;
    if (name && st.switched) st.switched.toName = name;
    return;
  }
  // 화면 때문에 대화가 바뀌면(실행 화면에서 다른 레시피를 고름 등) 눈에 띄게 알리고 돌아갈 길을 준다
  const had = st.recipeId && (st.view?.display?.length || st.view?.pending || el.input.value.trim());
  if (byScreen && had) st.switched = { fromId: st.recipeId, fromName: st.recipeName || st.recipeId, page: st.page };
  else if (st.switched?.fromId === id || !byScreen) st.switched = null;
  if (st.recipeId) st.drafts[st.recipeId] = el.input.value;
  const keep = st.recipeId ? (st.drafts[id] ?? '') : el.input.value || (st.drafts[id] ?? ''); // 레시피 없이 쓰던 글은 이어서 쓴다
  st.recipeId = id;
  st.recipeName = name ?? st.recipes?.find((r) => r.id === id)?.name ?? '';
  st.view = null;
  st.pinCtx = {};
  st.localError = null;
  if (st.stream?.recipeId !== id) st.stream = null;
  el.input.value = keep;
  mount(el.progress);
  storage(() => localStorage.setItem(LAST_KEY, id));
  syncNav();
  saveSession();
  loadThread();
  drawAll();
}

/** 편집기에 열린 레시피와 대화 레시피가 다르면 { editorId, editorName, chatName } — 그 상태로 보내거나 적용하면 다른 레시피가 바뀐다 */
function mismatch() {
  if (!st.editor?.recipeId || !st.recipeId || st.editor.recipeId === st.recipeId) return null;
  let name = '';
  try {
    name = st.editor.getRecipe?.()?.name ?? '';
  } catch {
    /* 편집기가 닫히는 중 */
  }
  return { editorId: st.editor.recipeId, editorName: name || st.editor.recipeId, chatName: st.recipeName || st.recipeId };
}

/** 어긋남 경고 줄 + [편집기 레시피 대화로] */
function drawMismatch() {
  if (!el) return;
  const m = mismatch();
  if (!m) return mount(el.mismatch);
  mount(
    el.mismatch,
    h(
      'div',
      { class: 'notice bad small ai-mismatch-line', role: 'alert' },
      h('b', null, '편집기와 다른 레시피의 대화입니다. '),
      `편집기에 열린 것은 "${short(m.editorName, 30)}" 인데, 이 대화는 "${short(m.chatName, 30)}" 레시피를 고칩니다. 보내기·적용 전에 한 번 더 묻습니다.`,
      h('div', { class: 'row' }, h('button', { class: 'sm primary', onclick: () => switchRecipe(m.editorId, m.editorName) }, `편집기의 "${short(m.editorName, 24)}" 대화로`)),
    ),
  );
}

/** "다른 레시피 대화로 바뀌었습니다" 안내 줄 */
function drawSwitched() {
  const s = st.switched;
  if (!s || s.fromId === st.recipeId) {
    st.switched = null;
    return mount(el.switched);
  }
  const back = () => {
    const to = s.fromId;
    st.switched = null;
    if (st.onReturn) st.onReturn(to);
    else location.hash = `#/recipe/${encodeURIComponent(to)}`; // 패널만 옮기지 않고 그 레시피를 연다 (편집기·패널이 같은 레시피)
    drawAll();
  };
  mount(
    el.switched,
    h(
      'div',
      { class: 'notice warn small ai-switched-line', role: 'status' },
      h('span', null, `${PAGE_LABEL[s.page] ?? '이 화면'}의 레시피 "${short(st.recipeName || st.recipeId, 30)}" 대화로 바뀌었습니다. 하던 "${short(s.fromName, 30)}" 대화는 그대로 남아 있습니다.`),
      h('div', { class: 'row' }, h('button', { class: 'sm', onclick: back }, `"${short(s.fromName, 24)}" 대화로 돌아가기`), h('button', { class: 'ghost sm', title: '이 안내 닫기', onclick: () => ((st.switched = null), drawSwitched()) }, '닫기')),
    ),
  );
}

async function loadThread() {
  const id = st.recipeId;
  if (!id) return;
  let v;
  try {
    v = await api('GET', `/api/agent/thread?recipeId=${encodeURIComponent(id)}`);
  } catch (e) {
    v = { error: e.message, display: [], pending: null, notes: '', usage: null };
  }
  if (id !== st.recipeId) return;
  st.view = v;
  if (!v.running && st.busy !== id) {
    st.stream = null;
    mount(el.progress);
  } else if (v.running && !el.progress.childElementCount) add(el.progress, h('div', { class: 'small' }, 'AI 가 답하는 중…'));
  if (!el.notes.hidden) drawNotes();
  drawAll();
}

async function loadRecipes() {
  try {
    st.recipes = await api('GET', '/api/recipes');
  } catch {
    st.recipes = [];
  }
  if (!st.fixed && st.recipeId && !st.recipes.some((r) => r.id === st.recipeId)) {
    // 지워진 레시피: 고르기로 돌아간다
    st.recipeId = null;
    st.view = null;
    storage(() => localStorage.removeItem(LAST_KEY));
  }
  if (st.recipeId && !st.recipeName) st.recipeName = st.recipes.find((r) => r.id === st.recipeId)?.name ?? '';
  drawAll();
}

async function loadSettings() {
  st.settings = (await api('GET', '/api/settings').catch(() => null))?.openrouter ?? null;
  const m = st.settings?.models?.find((x) => x.id === st.settings?.model);
  el.model.textContent = st.settings ? (m ? m.label.split(' (')[0] : st.settings.model) : '';
  if (st.settings && !st.settings.hasKey) el.settings.hidden = false;
  if (!el.settings.hidden) drawSettings();
}

// =====================================================================
// 보내기
// =====================================================================
function contextNow() {
  const c = { page: st.page, ...st.pageCtx, ...st.pinCtx };
  for (const [k, v] of Object.entries(c)) if (v === undefined || v === null || (Array.isArray(v) && !v.length)) delete c[k];
  return c;
}

async function send(message) {
  const fromInput = message === undefined;
  const text = String(message ?? el.input.value).trim();
  const id = st.recipeId;
  if (!text || isRunning()) return;
  if (!id) return toast('먼저 대화할 레시피를 골라 주세요.', 'error');
  if (!st.settings) await loadSettings();
  if (!st.settings?.hasKey) {
    el.settings.hidden = false;
    drawSettings();
    return toast('먼저 OpenRouter 키를 넣어 주세요.', 'error');
  }
  const mm = mismatch();
  if (mm && !confirm(`이 요청은 편집기에 열린 "${mm.editorName}" 가 아니라 "${mm.chatName}" 레시피를 고칩니다.\n그래도 "${mm.chatName}" 에 보낼까요?`)) return;
  const context = contextNow();
  st.switched = null; // 바뀐 대화에서 이어서 말하면 안내는 그만 보인다
  st.busy = id;
  st.local = { recipeId: id, text, context };
  st.localError = null;
  st.stream = { recipeId: id, parts: [] };
  const pinned = st.pinCtx;
  st.pinCtx = {};
  if (fromInput) el.input.value = '';
  saveSession();
  mount(el.progress, h('div', { class: 'muted small' }, 'AI 에 보내는 중…'));
  drawAll();
  let error = null;
  try {
    const recipe = st.editor?.recipeId === id ? st.editor.getRecipe() : (await api('GET', `/api/recipes/${encodeURIComponent(id)}`)).recipe;
    await api('POST', '/api/agent/turn', { recipeId: id, recipe, message: text, context, allowRisky: el.risky.checked });
  } catch (e) {
    error = e.message;
  }
  st.busy = null;
  st.local = null;
  st.stream = null;
  if (st.recipeId !== id) return; // 그새 다른 레시피로 옮겼다 (그 대화는 서버에 남아 있다)
  mount(el.progress);
  await loadThread();
  if (error) {
    const d = st.view?.display ?? [];
    const last = d.at(-1);
    if (!(last?.role === 'error' && last.text === error)) st.localError = { recipeId: id, text: error };
    // 서버에 들어가지 못한 요청이면(409 등) 쓴 글과 [✦ AI 에게] 맥락을 되돌려 둔다
    if (!d.some((x) => x.role === 'user' && x.text === text)) {
      if (fromInput && !el.input.value.trim()) el.input.value = text;
      if (!Object.keys(st.pinCtx).length) st.pinCtx = pinned;
    }
    saveSession();
    drawThread();
    drawCtx();
  }
}

// =====================================================================
// 대기 제안 · 메모 · 대화 지우기
// =====================================================================
const settle = (action, save) => api('POST', '/api/agent/pending', { recipeId: st.recipeId, action, ...(save ? { save: true } : {}) });

const applyInEditor = safely(async () => {
  const r = await settle('apply');
  st.editor?.applyRecipe(r.recipe);
  await loadThread();
});

const applyAndSave = safely(async () => {
  const mm = mismatch();
  const ask = mm
    ? `이 제안은 편집기에 열린 "${mm.editorName}" 가 아니라 "${mm.chatName}" 레시피를 바꿉니다.\n"${mm.chatName}" 에 적용하고 바로 저장할까요? (편집기의 "${mm.editorName}" 는 바뀌지 않습니다)`
    : 'AI 가 제안한 변경을 레시피에 적용하고 바로 저장할까요?\n저장한 뒤에도 편집기에서 다시 고칠 수 있습니다.';
  if (!confirm(ask)) return;
  const id = st.recipeId;
  const r = await settle('apply', true);
  const msg = r.problems?.length ? `AI 제안을 적용하고 저장했습니다. 고칠 점 ${r.problems.length}개가 있습니다.` : 'AI 제안을 적용하고 저장했습니다.';
  // 실행 화면 밖(리포트 등)에서는 바로 다시 실행하러 갈 수 있게
  toast(st.page === 'run' || r.problems?.length ? msg : h('span', null, `${msg} `, h('a', { href: `#/run?recipe=${encodeURIComponent(id)}`, class: 'toast-link' }, '▶ 다시 실행')));
  await loadThread();
  st.onSaved?.(r.recipe);
});

const discard = safely(async () => {
  await settle('discard');
  await loadThread();
});

const clearThread = safely(async () => {
  if (!st.recipeId) return;
  if (!confirm('이 레시피의 AI 대화와 적용하지 않은 제안을 지울까요? 메모는 남습니다.')) return;
  await api('DELETE', `/api/agent/thread?recipeId=${encodeURIComponent(st.recipeId)}`);
  st.localError = null;
  await loadThread();
  toast('대화를 지웠습니다.');
});

function toggleBox(which) {
  const box = el[which];
  box.hidden = !box.hidden;
  if (box.hidden) return;
  if (which === 'settings') drawSettings();
  else drawNotes();
}

function drawNotes() {
  if (!st.recipeId) return mount(el.notes, h('div', { class: 'small muted' }, '레시피를 고르면 그 레시피의 메모를 볼 수 있습니다.'));
  const ta = h('textarea', { rows: 6, 'aria-label': '레시피 메모', placeholder: '예: 조회 뒤 표가 2초 늦게 뜬다\n예: 이 사이트는 사업자번호를 하이픈 없이 넣는다' });
  ta.value = st.view?.notes ?? '';
  const save = safely(async () => {
    const id = st.recipeId;
    const r = await api('PUT', '/api/agent/notes', { recipeId: id, text: ta.value });
    if (st.view && id === st.recipeId) st.view.notes = r.notes ?? ta.value;
    toast('메모를 저장했습니다.');
    drawTop();
  });
  mount(
    el.notes,
    h('div', { class: 'small muted' }, 'AI 가 이 레시피에 대해 기억하는 내용입니다. 요청할 때마다 함께 보냅니다. AI 가 알아낸 사실을 스스로 적기도 합니다.'),
    ta,
    h('div', { class: 'row' }, h('button', { class: 'primary sm', onclick: save }, '메모 저장'), h('button', { class: 'sm', onclick: () => (el.notes.hidden = true) }, '닫기')),
  );
}

function drawSettings() {
  const s = st.settings;
  if (!s) return mount(el.settings, h('div', { class: 'small muted' }, '설정을 불러오는 중…'));
  const key = h('input', { type: 'password', placeholder: s.hasKey ? `저장된 키 ${s.keyHint} — 바꿀 때만 입력` : 'sk-or-v1-…', autocomplete: 'off' });
  const model = h(
    'select',
    null,
    s.models.map((m) => h('option', { value: m.id, selected: m.id === s.model }, m.label)),
    s.models.some((m) => m.id === s.model) ? null : h('option', { value: s.model, selected: true }, s.model),
  );
  const custom = h('input', { type: 'text', placeholder: '다른 OpenRouter 모델 id (선택)' });
  mount(
    el.settings,
    h('div', { class: 'small muted' }, 'OpenRouter 키는 이 PC 의 workspace\\settings.json 에만 저장되고 화면에 다시 보이지 않습니다. 키는 openrouter.ai/keys 에서 만들 수 있습니다.'),
    s.fromEnv ? h('div', { class: 'small' }, '지금은 환경 변수 OPENROUTER_API_KEY 의 키를 쓰고 있습니다.') : null,
    h('label', { class: 'field' }, h('span', null, 'API 키'), key),
    h('label', { class: 'field' }, h('span', null, '모델'), model),
    h('label', { class: 'field' }, h('span', null, '직접 입력 (비우면 위 선택)'), custom),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'primary sm',
          onclick: safely(async () => {
            const body = { openrouter: { model: custom.value.trim() || model.value } };
            if (key.value.trim()) body.openrouter.apiKey = key.value.trim();
            await api('PUT', '/api/settings', body);
            toast('AI 설정을 저장했습니다.');
            el.settings.hidden = true;
            await loadSettings();
          }),
        },
        '저장',
      ),
      s.hasKey && !s.fromEnv
        ? h(
            'button',
            {
              class: 'sm danger',
              onclick: safely(async () => {
                if (!confirm('저장된 OpenRouter 키를 지울까요?')) return;
                await api('PUT', '/api/settings', { openrouter: { apiKey: '' } });
                await loadSettings();
              }),
            },
            '키 지우기',
          )
        : null,
    ),
  );
}

// =====================================================================
// 그리기
// =====================================================================
function drawAll() {
  drawTop();
  drawScope();
  drawMismatch();
  drawSwitched();
  drawThread();
  drawCtx();
  drawInputState();
}

/** 상단 막대 단추 "✦ AI 대화" (휴대폰은 "✦ AI"): 적용을 기다리는 제안이 있으면 "제안 N" 표시 */
function drawTop() {
  const pending = st.view?.pending;
  const n = pending?.changes?.length ?? 0;
  mount(
    el.top,
    '✦ AI',
    h('span', { class: 'ai-top-word' }, ' 대화'),
    pending ? h('span', { class: 'ai-dot', title: '적용을 기다리는 AI 제안이 있습니다' }, n ? `제안 ${n}` : '제안') : null,
  );
  el.top.classList.toggle('active', st.open);
  el.notesBtn.textContent = st.view?.notes?.trim() ? '메모 ●' : '메모';
}

function drawScope() {
  if (!el) return;
  const cost = st.view?.usage?.cost ? h('span', { class: 'muted small', title: '이 레시피 대화에 쓴 비용 (OpenRouter 기준)' }, `누적 $${st.view.usage.cost.toFixed(4)}`) : null;
  const meta = h('div', { class: 'ai-meta' }, el.model, cost);
  if (st.fixed && st.recipeId) {
    mount(el.scope, h('span', { class: 'muted small' }, '레시피'), h('b', { class: 'ai-recipe' }, st.recipeName || st.recipeId), meta);
    return;
  }
  const list = st.recipes ?? [];
  const sel = h(
    'select',
    { 'aria-label': '대화할 레시피', onchange: (e) => e.target.value && switchRecipe(e.target.value, list.find((r) => r.id === e.target.value)?.name) },
    st.recipeId ? null : h('option', { value: '', selected: true }, list.length ? '대화할 레시피를 고르세요' : st.recipes ? '레시피가 없습니다' : '레시피 목록을 불러오는 중…'),
    list.map((r) => h('option', { value: r.id, selected: r.id === st.recipeId }, r.name)),
    st.recipeId && !list.some((r) => r.id === st.recipeId) ? h('option', { value: st.recipeId, selected: true }, st.recipeName || st.recipeId) : null,
  );
  mount(el.scope, h('span', { class: 'muted small' }, '레시피'), h('div', { class: 'ai-pick' }, sel), meta);
}

/** 실행 id(20261021-143737-c1b6) → "10/21 14:37 실행" */
function runLabel(runId) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(String(runId));
  return m ? `${Number(m[2])}/${Number(m[3])} ${m[4]}:${m[5]} 실행` : '보고 있는 실행';
}

/** 모델 id → 설정의 보이는 이름 (anthropic/claude-sonnet-5.5 → Claude Sonnet 5.5) */
function modelLabel(id) {
  if (!id) return '';
  const m = st.settings?.models?.find((x) => x.id === id);
  if (m) return m.label.split(' (')[0];
  const tail = String(id).split('/').pop();
  return tail.replace(/-/g, ' ').replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

/**
 * 제안 카드의 한 줄: 서버 문구("추가 #8 s9 (main): …")에서 내부 id·블록 이름을 빼고 번호부터 쉬운 문장으로
 * ("#8 추가: …", 몸통 블록이면 "#3.1 추가 (행마다 안): …"). 남은 s12 같은 id 는 제안 레시피의 번호로 바꾼다.
 */
export function changeLine(c, nums) {
  const text = String(c ?? '');
  const m = /^(추가|수정|삭제|묶기|풀기|이동) (?:(#[\d.-]+) )?(s[\w-]+)(?: \(([^)]*)\))?: ([\s\S]*)$/.exec(text);
  const ids = (s) => s.replace(/\bs\d+\b/g, (id) => nums?.get(id) ?? id);
  if (!m) return ids(text);
  const [, verb, no, id, block, rest] = m;
  const where = block && block !== 'main' ? ` (${block} 안)` : '';
  const num = no ?? nums?.get(id) ?? '';
  return `${num ? `${num} ` : ''}${verb}${where}: ${ids(rest)}`;
}

function ctxParts(c) {
  const out = [];
  const nums = st.editor?.recipeId === st.recipeId ? stepNumbers(st.editor.getRecipe()) : null;
  const no = (id) => nums?.get(id) ?? id;
  if (c.selectedStepIds?.length) out.push(c.selectedStepIds.length === 1 ? `고른 스텝 ${no(c.selectedStepIds[0])}` : `고른 스텝 ${c.selectedStepIds.length}개`);
  if (c.openStepId && !(c.selectedStepIds?.length === 1 && c.selectedStepIds[0] === c.openStepId)) out.push(`펼친 스텝 ${no(c.openStepId)}`);
  if (c.upload?.headers?.length) out.push(`엑셀 열 ${c.upload.headers.length}개`);
  if (c.runId) out.push(runLabel(c.runId));
  if (c.rowNumber) out.push(`${c.rowNumber}행`);
  return out;
}

function drawCtx() {
  if (!el) return;
  const c = contextNow();
  const parts = ctxParts(c);
  const pinned = Object.keys(st.pinCtx).length > 0;
  mount(
    el.ctx,
    h('span', { class: 'muted' }, '함께 보내는 맥락: '),
    h('span', { class: 'ai-ctx-text' }, [PAGE_LABEL[st.page] ?? st.page, ...parts].join(' · ')),
    pinned ? h('button', { class: 'ghost sm', title: '[✦ AI 에게] 로 넣은 맥락 빼기', onclick: () => ((st.pinCtx = {}), drawCtx()) }, '✕') : null,
  );
}

function drawInputState() {
  const running = isRunning();
  el.send.disabled = running || !st.recipeId;
  el.send.textContent = running ? '작업 중…' : '보내기';
  el.clear.disabled = running || !st.recipeId;
}

function userContextTag(c) {
  if (!c) return null;
  const parts = [];
  if (c.page && c.page !== 'editor') parts.push(PAGE_LABEL[c.page] ?? c.page);
  if (c.selectedStepIds?.length) parts.push(`스텝 ${c.selectedStepIds.length}개`);
  if (c.rowNumber) parts.push(`${c.rowNumber}행`);
  return parts.length ? h('div', { class: 'ai-msg-ctx' }, parts.join(' · ')) : null;
}

function metaLine(e) {
  const cost = e.usage?.cost ? `이번 요청 $${e.usage.cost.toFixed(4)}` : '';
  const text = [modelLabel(e.usage?.model), cost].filter(Boolean).join(' · ');
  return text ? h('div', { class: 'muted small' }, text) : null;
}

const numsOf = (r) => {
  try {
    return r?.blocks ? stepNumbers(r) : null;
  } catch {
    return null;
  }
};

function pendingCard(p) {
  const inEditor = st.editor?.recipeId === st.recipeId;
  const running = isRunning();
  const nums = numsOf(p.recipe);
  return h(
    'div',
    { class: 'ai-changes' },
    h('b', null, `제안된 변경 ${p.changes.length}건`),
    h('ol', null, p.changes.map((c) => h('li', { title: c }, changeLine(c, nums)))),
    p.problems?.length ? h('div', { class: 'notice warn small' }, `검사에서 고칠 점 ${p.problems.length}개: ${p.problems.join(' / ')}`) : null,
    h(
      'div',
      { class: 'row' },
      inEditor ? h('button', { class: 'primary sm', disabled: running, onclick: applyInEditor }, '적용') : h('button', { class: 'primary sm', disabled: running, onclick: applyAndSave }, '적용하고 저장'),
      h('button', { class: 'sm', disabled: running, onclick: discard }, '버리기'),
    ),
    inEditor ? h('div', { class: 'muted small' }, '[적용] 하면 편집기에 반영됩니다. 확인한 뒤 [저장] 을 눌러 주세요.') : h('div', { class: 'muted small' }, '편집기 밖에서는 적용과 함께 레시피를 저장합니다. 이어서 요청하면 이 제안 위에서 고칩니다.'),
  );
}

function pastChanges(e) {
  return h(
    'details',
    { class: 'ai-change-past' },
    h('summary', { class: 'small' }, `변경 ${e.changes.length}건 · `, h('span', { class: `ai-state ${e.changeState ?? ''}` }, STATE_LABEL[e.changeState] ?? e.changeState ?? '')),
    h('ol', { class: 'small' }, e.changes.map((c) => h('li', { title: c }, changeLine(c, null)))),
  );
}

function entryEl(e, isLast) {
  if (e.role === 'user') return h('div', { class: 'ai-msg user' }, e.text, userContextTag(e.context));
  if (e.role === 'error') return h('div', { class: 'ai-msg error' }, e.text);
  const pending = st.view?.pending;
  return h(
    'div',
    { class: 'ai-msg assistant' },
    h('div', { class: 'ai-text' }, e.text),
    metaLine(e),
    e.changes?.length ? (e.changeState === 'pending' && pending ? pendingCard(pending) : pastChanges(e)) : null,
    e.choices?.length && isLast && !isRunning()
      ? h(
          'div',
          { class: 'ai-choices' },
          e.choices.map((c) => h('button', { class: 'chip choice', title: c.message, onclick: () => send(c.message) }, c.label)),
        )
      : null,
  );
}

function drawEmpty() {
  return h(
    'div',
    { class: 'ai-empty' },
    h('p', { class: 'small muted' }, '녹화한 레시피를 대화로 다듬습니다. AI 는 레시피를 읽고 고치며, 필요하면 숨긴 브라우저로 특정 스텝까지 실제로 실행해 화면을 확인합니다. 바꾼 내용은 [적용]을 눌러야 반영됩니다. 대화는 레시피마다 저장되어 다른 화면에서도 이어집니다.'),
    AI_EXAMPLES.map((ex) => h('button', { class: 'chip', onclick: () => ((el.input.value = ex), el.input.focus(), saveSession()) }, ex)),
  );
}

function drawThread() {
  if (!el) return;
  const near = el.thread.scrollHeight - el.thread.scrollTop - el.thread.clientHeight < 80;
  const kids = [];
  if (!st.recipeId) kids.push(h('div', { class: 'ai-empty' }, h('p', { class: 'small muted' }, '위에서 레시피를 고르면 그 레시피의 대화를 이어서 합니다. 편집·실행·리포트 화면에서는 그 레시피의 대화가 바로 열립니다.')));
  else if (!st.view) kids.push(h('div', { class: 'muted small' }, '대화를 불러오는 중…'));
  else {
    const d = st.view.display ?? [];
    if (st.view.error) kids.push(h('div', { class: 'ai-msg error' }, `대화를 불러오지 못했습니다: ${st.view.error}`));
    const local = st.local?.recipeId === st.recipeId && !d.some((x, i) => x.role === 'user' && x.text === st.local.text && i >= d.length - 2) ? st.local : null;
    if (!d.length && !local && !st.stream) kids.push(drawEmpty());
    d.forEach((e, i) => kids.push(entryEl(e, i === d.length - 1)));
    if (st.view.pending && !d.some((e) => e.changeState === 'pending')) kids.push(h('div', { class: 'ai-msg assistant' }, pendingCard(st.view.pending)));
    if (local) kids.push(h('div', { class: 'ai-msg user' }, local.text, userContextTag(local.context)));
    if (st.stream?.recipeId === st.recipeId) kids.push(streamEl());
    if (st.localError?.recipeId === st.recipeId) kids.push(h('div', { class: 'ai-msg error' }, st.localError.text));
  }
  mount(el.thread, kids);
  if (near || st.stream) el.thread.scrollTop = el.thread.scrollHeight;
  drawInputState();
}

function streamEl() {
  const parts = st.stream.parts.length ? st.stream.parts : [{ round: 0, text: '' }];
  return h(
    'div',
    { class: 'ai-stream' },
    parts.map((p, i) => {
      const last = i === parts.length - 1;
      return h('div', { class: `ai-msg assistant ${last ? 'streaming' : 'interim'}` }, h('div', { class: 'ai-text' }, p.text || (last ? '' : '…')));
    }),
  );
}

function drawStream() {
  const box = el.thread.querySelector('.ai-stream');
  if (!box) return drawThread();
  box.replaceWith(streamEl());
  el.thread.scrollTop = el.thread.scrollHeight;
}

// =====================================================================
// 서버 이벤트
// =====================================================================
function onEvent(type, d) {
  if (!d || d.recipeId !== st.recipeId) return;
  if (type === 'agent-progress') {
    if (!isRunning() && st.view) {
      st.view.running = true; // 다른 창에서 보낸 턴 — agent-done 때 다시 불러온다
      drawInputState();
    }
    add(el.progress, h('div', { class: 'small' }, d.text));
    while (el.progress.childElementCount > 40) el.progress.firstElementChild.remove();
    el.progress.scrollTop = el.progress.scrollHeight;
  } else if (type === 'agent-delta') {
    // 라운드가 바뀌면(도구를 부른 뒤 다시 답하면) 새 말풍선에서 이어 쓴다. 마지막 라운드 글이 답변이다.
    const round = d.round ?? 0;
    if (!st.stream) st.stream = { recipeId: d.recipeId, parts: [] };
    let part = st.stream.parts.at(-1);
    if (!part || part.round !== round) st.stream.parts.push((part = { round, text: '' }));
    part.text += d.text ?? '';
    drawStream();
  } else if (type === 'agent-done') {
    if (st.busy === d.recipeId) return; // 이 화면이 보낸 턴은 응답을 받을 때 다시 그린다
    st.stream = null;
    mount(el.progress);
    loadThread();
  }
}
