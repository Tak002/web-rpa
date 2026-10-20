import { stepText, STEP_LABELS, targetText } from '/shared/steps.js';

// ---------- 작은 DOM 도우미 ----------
function h(tag, props, ...children) {
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
const app = document.getElementById('app');
// append/replaceChildren 에 null 을 넘기면 "null" 글자가 들어가므로 빈 값을 걸러서 넣는다.
const clean = (kids) => kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false);
const add = (el, ...kids) => el.append(...clean(kids));
const mount = (el, ...kids) => el.replaceChildren(...clean(kids));
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'medium' }) : '');
const fmtDur = (ms) => (ms === undefined ? '' : ms < 60000 ? `${(ms / 1000).toFixed(1)}초` : `${Math.floor(ms / 60000)}분 ${Math.round((ms % 60000) / 1000)}초`);
const STATUS = { running: ['실행 중', 'acc'], paused: ['일시정지', 'warn'], 'waiting-user': ['확인 대기', 'warn'], done: ['완료', 'ok'], failed: ['실패 있음', 'bad'], stopped: ['중지됨', ''], idle: ['준비', ''] };
const statusBadge = (s) => h('span', { class: `badge ${STATUS[s]?.[1] ?? ''}` }, STATUS[s]?.[0] ?? s);

function toast(message, kind = 'info') {
  const t = h('div', { class: `toast ${kind}` }, message);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 8000 : 3500);
}

async function api(method, url, body, { raw = false } = {}) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined && !raw ? { 'content-type': 'application/json' } : undefined,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}
const safely = (fn) => async (...a) => {
  try {
    return await fn(...a);
  } catch (e) {
    toast(e.message, 'error');
    return undefined;
  }
};
function download(name, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function uploadFile(file) {
  return api('POST', `/api/uploads?name=${encodeURIComponent(file.name)}`, file, { raw: true });
}

// ---------- 서버 상태 (SSE) ----------
const live = { recording: null, run: null, log: [] };
const listeners = new Set();
function onLive(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emitLive(type, data) {
  for (const fn of listeners) fn(type, data);
  renderLivePill();
}
function connect() {
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
  es.addEventListener('agent-progress', (e) => emitLive('agent-progress', JSON.parse(e.data)));
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

// ---------- 라우터 ----------
let cleanup = null;
function route() {
  cleanup?.();
  cleanup = null;
  const [path, query] = location.hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  const params = new URLSearchParams(query ?? '');
  const section = parts[0] || 'recipes';
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('active', a.dataset.nav === (section === 'recipe' ? 'recipes' : section === 'report' ? 'reports' : section));
  app.replaceChildren();
  window.scrollTo(0, 0);
  const pages = { recipes: recipesPage, record: recordPage, recipe: () => editorPage(parts[1]), run: () => runPage(params), reports: reportsPage, report: () => reportPage(parts[1]), hub: () => hubPage(params), settings: settingsPage };
  (pages[section] ?? recipesPage)();
}
window.addEventListener('hashchange', route);

// =====================================================================
// 레시피 목록
// =====================================================================
async function recipesPage() {
  const fileInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    style: 'display:none',
    onchange: safely(async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const { recipe, problems } = await api('POST', '/api/recipes', JSON.parse(await f.text()));
      toast(`가져왔습니다: ${recipe.name}${problems.length ? ` (고칠 점 ${problems.length}개)` : ''}`);
      location.hash = `#/recipe/${recipe.id}`;
    }),
  });
  add(app, 
    h('div', { class: 'page-head' }, h('h1', null, '레시피'), h('div', { class: 'spacer' }), fileInput, h('button', { onclick: () => fileInput.click() }, '가져오기'), h('a', { class: 'btn primary', href: '#/record' }, '＋ 새로 녹화')),
  );
  const list = await api('GET', '/api/recipes').catch((e) => (toast(e.message, 'error'), []));
  if (!list.length) {
    add(app, 
      h(
        'div',
        { class: 'card empty' },
        h('h2', null, '아직 레시피가 없습니다'),
        h('ol', null, h('li', null, '녹화: 웹사이트에서 평소처럼 클릭·입력하면 스텝으로 기록됩니다.'), h('li', null, '편집: 입력값을 엑셀 열로 바꾸고, PDF 저장·값 읽기 스텝을 더합니다.'), h('li', null, '실행: 엑셀 행마다 같은 작업을 반복하고 결과를 리포트로 남깁니다.')),
        h('div', null, h('a', { class: 'btn primary', href: '#/record' }, '첫 녹화 시작하기')),
      ),
    );
    return;
  }
  const rows = list.map((r) =>
    h(
      'tr',
      null,
      h('td', null, h('a', { href: `#/recipe/${r.id}` }, h('b', null, r.name)), r.set ? h('span', { class: 'badge acc', style: 'margin-left:6px', title: `허브 세트 ${r.set.id}` }, `세트 v${r.set.version}`) : null, h('div', { class: 'muted small', style: 'overflow-wrap:anywhere' }, r.startUrl)),
      h('td', null, h('span', { class: 'badge' }, `${r.steps}스텝`)),
      h('td', null, r.excelColumns.length ? r.excelColumns.map((c) => h('span', { class: 'badge acc', style: 'margin:0 4px 4px 0' }, c)) : h('span', { class: 'muted small' }, '엑셀 없음')),
      h('td', { class: 'muted small' }, fmtTime(r.updatedAt)),
      h(
        'td',
        null,
        h(
          'div',
          { class: 'row', style: 'flex-wrap:nowrap' },
          h('a', { class: 'btn sm primary', href: `#/run?recipe=${r.id}` }, '실행'),
          h('a', { class: 'btn sm', href: `#/recipe/${r.id}` }, '편집'),
          h('button', { class: 'sm', onclick: safely(async () => (await api('POST', `/api/recipes/${r.id}/duplicate`), route())) }, '복제'),
          h(
            'button',
            {
              class: 'sm',
              onclick: safely(async () => {
                const { recipe } = await api('GET', `/api/recipes/${r.id}`);
                download(`${recipe.name}.json`, JSON.stringify(recipe, null, 2));
              }),
            },
            '내보내기',
          ),
          h(
            'button',
            {
              class: 'sm danger',
              onclick: safely(async () => {
                if (!confirm(`"${r.name}" 레시피를 삭제할까요? (작업 폴더 trash 로 옮겨집니다)`)) return;
                await api('DELETE', `/api/recipes/${r.id}`);
                route();
              }),
            },
            '삭제',
          ),
        ),
      ),
    ),
  );
  add(app, h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, h('th', null, '이름'), h('th', null, '스텝'), h('th', null, '엑셀 열'), h('th', null, '수정'), h('th', null, ''))), h('tbody', null, rows))));
}

// =====================================================================
// 녹화
// =====================================================================
function recordPage() {
  const box = h('div');
  add(app, h('div', { class: 'page-head' }, h('h1', null, '녹화')), box);
  const draw = () => {
    const r = live.recording;
    mount(box, r && r.state !== 'stopped' ? recordingView(r) : recordForm());
  };
  draw();
  cleanup = onLive((type, d) => {
    if (type === 'recording' && d.state === 'stopped' && d.savedId) {
      toast('녹화를 저장했습니다.');
      location.hash = `#/recipe/${d.savedId}`;
      return;
    }
    if (type === 'recording' || type === 'state') draw();
  });
}

function recordForm() {
  const name = h('input', { type: 'text', placeholder: '예: 홈택스 부가세 조회', value: localStorage.getItem('rpa:lastName') ?? '' });
  const url = h('input', { type: 'url', placeholder: 'https://…', value: localStorage.getItem('rpa:lastUrl') ?? '' });
  const start = h(
    'button',
    {
      class: 'primary',
      onclick: safely(async () => {
        if (!url.value.trim()) throw new Error('시작 주소를 입력해 주세요.');
        try {
          localStorage.setItem('rpa:lastName', name.value);
          localStorage.setItem('rpa:lastUrl', url.value);
        } catch {
          /* 저장 불가 환경 */
        }
        start.disabled = true;
        start.textContent = '브라우저 여는 중…';
        try {
          const r = await api('POST', '/api/record/start', { name: name.value.trim() || '새 레시피', startUrl: url.value.trim() });
          live.recording = r;
          emitLive('recording', r);
        } finally {
          start.disabled = false;
          start.textContent = '● 녹화 시작';
        }
      }),
    },
    '● 녹화 시작',
  );
  return h(
    'div',
    { class: 'grid2' },
    h('div', { class: 'card stack' }, h('h2', null, '새 녹화'), h('label', { class: 'field' }, h('span', null, '레시피 이름'), name), h('label', { class: 'field' }, h('span', null, '시작 주소'), url), h('div', null, start)),
    h(
      'div',
      { class: 'card' },
      h('h2', null, '녹화 요령'),
      h(
        'ul',
        { class: 'small', style: 'padding-left:18px;margin:0' },
        h('li', null, '녹화용 브라우저(Edge)가 이 PC 화면에 따로 열립니다. 그 창에서 평소처럼 작업하세요.'),
        h('li', null, '입력은 칸마다 마지막 값만 기록됩니다. 엑셀로 바꿀 값은 실제 첫 거래처 값으로 입력해 두면 나중에 자동 연결됩니다.'),
        h('li', null, '로그인은 녹화 브라우저에서 직접 해 두면 같은 프로필이라 실행할 때도 유지됩니다. 비밀번호 입력은 저장하지 않고 실행할 때 묻습니다.'),
        h('li', null, '사이트의 확인창은 직접 누르면 그 선택이 기록됩니다. 인쇄 버튼을 누르면 실제 인쇄 대신 "PDF 저장" 스텝이 들어갑니다.'),
        h('li', null, '녹화 브라우저 창을 닫아도 그때까지 녹화한 내용은 저장됩니다.'),
      ),
    ),
  );
}

function recordingView(r) {
  const steps = r.recipe?.blocks?.main ?? [];
  const add = (step) => safely(() => api('POST', '/api/record/add-step', { step }));
  const paused = r.state === 'paused';
  const list = h(
    'ul',
    { class: 'steps live-steps' },
    steps.map((s, i) =>
      h(
        'li',
        { class: 'step' },
        h(
          'div',
          { class: 'step-head' },
          h('span', { class: 'num' }, i + 1),
          h('span', { class: `type t-${s.type}` }, STEP_LABELS[s.type] ?? s.type),
          h('span', { class: 'desc' }, stepText(s)),
          h('button', { class: 'ghost icon', title: '이 스텝 지우기', onclick: safely(() => api('POST', '/api/record/remove-step', { id: s.id })) }, '✕'),
        ),
      ),
    ),
  );
  setTimeout(() => list.lastElementChild?.scrollIntoView({ block: 'nearest' }), 0);
  return h(
    'div',
    null,
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'row' },
        h('span', { class: `pill ${paused ? '' : 'rec'}` }, h('span', { class: 'dot' }), paused ? '일시정지' : '녹화 중'),
        h('b', null, r.recipe?.name),
        h('span', { class: 'muted small' }, `${steps.length}스텝`),
        h('div', { style: 'flex:1' }),
        h('button', { onclick: safely(() => api('POST', paused ? '/api/record/resume' : '/api/record/pause')) }, paused ? '▶ 재개' : '❚❚ 일시정지'),
        h(
          'button',
          {
            class: 'danger solid',
            onclick: safely(async (e) => {
              e.target.disabled = true;
              e.target.textContent = '저장 중…';
              const { recipe } = await api('POST', '/api/record/stop');
              location.hash = `#/recipe/${recipe.id}`;
            }),
          },
          '■ 녹화 종료하고 저장',
        ),
      ),
      h('p', { class: 'muted small', style: 'margin:10px 0 6px' }, '필요하면 아래 스텝을 녹화 중에 바로 넣을 수 있습니다.'),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'sm', onclick: add({ type: 'navigate' }) }, '＋ 현재 주소로 이동'),
        h('button', { class: 'sm', onclick: add({ type: 'sleep', ms: 2000 }) }, '＋ 2초 대기'),
        h('button', { class: 'sm', onclick: add({ type: 'pdf', fileName: `${r.recipe?.name ?? '출력'}_{{row}}.pdf` }) }, '＋ PDF 저장'),
        h('button', { class: 'sm', onclick: add({ type: 'screenshot', fileName: `화면_{{row}}.png` }) }, '＋ 화면 캡처'),
        h('button', { class: 'sm', onclick: add({ type: 'pause', message: '브라우저에서 확인 후 [계속]을 눌러 주세요.' }) }, '＋ 사용자 확인 대기'),
      ),
    ),
    steps.length ? list : h('div', { class: 'card empty' }, '녹화 브라우저에서 작업을 시작하면 여기에 스텝이 쌓입니다.'),
  );
}

// =====================================================================
// 레시피 편집기
// =====================================================================
const ADDABLE = [
  ['navigate', '주소 이동', () => ({ type: 'navigate', url: 'https://' })],
  ['sleep', '잠시 대기', () => ({ type: 'sleep', ms: 2000 })],
  ['waitText', '글자가 보일 때까지 대기', () => ({ type: 'wait', condition: { kind: 'textVisible', text: '' }, timeoutMs: 15000 })],
  ['waitUrl', '주소가 바뀔 때까지 대기', () => ({ type: 'wait', condition: { kind: 'urlContains', value: '' }, timeoutMs: 15000 })],
  ['pdf', 'PDF 저장', (r) => ({ type: 'pdf', fileName: `${r.name}_{{row}}.pdf` })],
  ['screenshot', '화면 캡처', () => ({ type: 'screenshot', fileName: '화면_{{row}}.png', fullPage: true })],
  ['pause', '사용자 확인 대기', () => ({ type: 'pause', message: '브라우저에서 확인 후 [계속]을 눌러 주세요.' })],
  ['keypress', '키 입력', () => ({ type: 'keypress', key: 'Enter' })],
  ['closeTab', '팝업 창 닫기', () => ({ type: 'closeTab' })],
  ['assertText', '글자 확인(없으면 실패)', () => ({ type: 'assert', condition: { kind: 'textVisible', text: '' }, message: '' })],
];

async function editorPage(id) {
  let data;
  try {
    data = await api('GET', `/api/recipes/${id}`);
  } catch (e) {
    add(app, h('div', { class: 'card notice bad' }, e.message));
    return;
  }
  let recipe = data.recipe;
  let problems = data.problems;
  let dirty = false;
  let openId = null;
  let tab = 'steps';
  const root = h('div');
  add(app, root);

  const markDirty = () => {
    dirty = true;
    saveBtn.disabled = false;
    saveBtn.textContent = '저장 *';
  };
  const save = safely(async () => {
    const r = await api('PUT', `/api/recipes/${recipe.id}`, recipe);
    recipe = r.recipe;
    problems = r.problems;
    dirty = false;
    toast(problems.length ? `저장했습니다. 고칠 점 ${problems.length}개가 있습니다.` : '저장했습니다.');
    draw();
  });
  const saveBtn = h('button', { class: 'primary', onclick: save, disabled: true }, '저장');
  window.onbeforeunload = () => (dirty ? '저장하지 않은 변경이 있습니다.' : undefined);
  const ai = aiPanel({
    getRecipe: () => recipe,
    applyRecipe: (next) => {
      recipe = { ...next, id: recipe.id };
      markDirty();
      draw();
      toast('AI 제안을 적용했습니다. 확인 후 저장을 눌러 주세요.');
    },
  });
  cleanup = () => {
    window.onbeforeunload = null;
    ai.destroy();
  };
  const allSteps = () => Object.values(recipe.blocks).flat();
  const newId = () => {
    const used = new Set(allSteps().map((s) => s.id));
    let n = allSteps().length + 1;
    while (used.has(`s${n}`)) n += 1;
    return `s${n}`;
  };

  function draw() {
    const nameIn = h('input', { type: 'text', value: recipe.name, oninput: (e) => ((recipe.name = e.target.value), markDirty()) });
    const urlIn = h('input', { type: 'text', value: recipe.startUrl ?? '', oninput: (e) => ((recipe.startUrl = e.target.value), markDirty()) });
    saveBtn.disabled = !dirty;
    saveBtn.textContent = dirty ? '저장 *' : '저장';
    mount(root, 
      h(
        'div',
        { class: 'page-head' },
        h('a', { href: '#/recipes', class: 'muted' }, '← 레시피'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'ai-btn', onclick: () => ai.toggle() }, '✦ AI 도우미'),
        h('button', { onclick: () => download(`${recipe.name}.json`, JSON.stringify(recipe, null, 2)) }, '내보내기'),
        h(
          'button',
          {
            onclick: async () => {
              if (dirty) {
                if (!confirm('저장하지 않은 변경이 있습니다. 저장한 뒤 세트로 내보낼까요?')) return;
                await save();
                if (dirty) return; // 저장 실패
              }
              openSetWizard(recipe.id);
            },
          },
          '세트로 내보내기',
        ),
        h(
          'button',
          {
            onclick: async () => {
              if (dirty) {
                if (!confirm('저장하지 않은 변경이 있습니다. 저장하고 실행 화면으로 갈까요?')) return;
                await save();
                if (dirty) return; // 저장 실패
              }
              location.hash = `#/run?recipe=${recipe.id}`;
            },
          },
          '▶ 실행하기',
        ),
        saveBtn,
      ),
      h('div', { class: 'card grid2' }, h('label', { class: 'field' }, h('span', null, '레시피 이름'), nameIn), h('label', { class: 'field' }, h('span', null, '시작 주소'), urlIn)),
      problems.length ? h('div', { class: 'notice warn' }, h('b', null, '실행 전에 고칠 점'), h('ul', null, problems.map((p) => h('li', null, p)))) : null,
      recipe.origin ? h('div', { class: 'notice info small' }, setLimitText(recipe.origin), ' 제한은 JSON 탭의 origin 에 있습니다.') : null,
      h(
        'div',
        { class: 'tabs' },
        [
          ['steps', `스텝 (${allSteps().length})`],
          ['vars', `변수·엑셀 (${recipe.variables?.length ?? 0})`],
          ['json', 'JSON'],
        ].map(([k, label]) => h('button', { class: tab === k ? 'active' : '', onclick: () => ((tab = k), draw()) }, label)),
      ),
      tab === 'steps' ? stepsTab() : tab === 'vars' ? varsTab() : jsonTab(),
    );
  }

  // ----- 스텝 탭 -----
  function stepsTab() {
    const blocks = Object.entries(recipe.blocks);
    return h(
      'div',
      null,
      blocks.map(([block, steps]) =>
        h(
          'div',
          { style: 'margin-bottom:16px' },
          blocks.length > 1 ? h('h3', null, block === (recipe.entryBlock ?? 'main') ? `${block} (시작 블록)` : `${block} 블록`) : null,
          h('ul', { class: 'steps' }, steps.map((s, i) => stepItem(s, i, steps))),
        ),
      ),
      addBar(),
    );
  }

  function stepItem(s, i, steps) {
    const open = openId === s.id;
    return h(
      'li',
      { class: `step ${open ? 'open' : ''} ${s.disabled ? 'disabled' : ''}` },
      h(
        'div',
        { class: 'step-head', onclick: () => ((openId = open ? null : s.id), draw()) },
        h('span', { class: 'num' }, i + 1),
        h('span', { class: `type t-${s.type}` }, STEP_LABELS[s.type] ?? s.type),
        h('span', { class: 'desc' }, stepText(s)),
        s.optional ? h('span', { class: 'badge' }, '없으면 건너뜀') : null,
        s.onError === 'continue' ? h('span', { class: 'badge warn' }, '실패해도 계속') : null,
        s.disabled ? h('span', { class: 'badge' }, '꺼짐') : null,
      ),
      open ? stepBody(s, i, steps) : null,
    );
  }

  function field(label, input) {
    return h('label', { class: 'field' }, h('span', null, label), input);
  }
  function text(obj, key, { type = 'text', placeholder, num = false } = {}) {
    return h('input', {
      type,
      value: obj[key] ?? '',
      placeholder,
      oninput: (e) => {
        obj[key] = num ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value;
        markDirty();
      },
      onchange: () => draw(),
    });
  }

  function stepBody(s, i, steps) {
    const fields = [];
    switch (s.type) {
      case 'navigate':
        fields.push(field('주소', text(s, 'url')));
        break;
      case 'input':
        fields.push(field('입력값 ({{열이름}} 으로 엑셀 값)', text(s, 'value')));
        break;
      case 'select':
        fields.push(field('선택값', text(s, 'value')), field('보이는 이름(선택)', text(s, 'label')));
        break;
      case 'check':
        fields.push(field('상태', h('select', { onchange: (e) => ((s.checked = e.target.value === 'on'), markDirty(), draw()) }, h('option', { value: 'on', selected: s.checked !== false }, '체크'), h('option', { value: 'off', selected: s.checked === false }, '체크 해제'))));
        break;
      case 'keypress':
        fields.push(field('키 (예: Enter, Escape, Tab, Control+A)', text(s, 'key')));
        break;
      case 'sleep':
        fields.push(field('대기 시간(ms)', text(s, 'ms', { type: 'number', num: true })));
        break;
      case 'wait':
      case 'assert': {
        const c = s.condition ?? (s.condition = { kind: 'textVisible', text: '' });
        fields.push(
          field(
            '조건',
            h(
              'select',
              {
                onchange: (e) => {
                  s.condition = e.target.value === 'urlContains' ? { kind: 'urlContains', value: '' } : e.target.value === 'exists' && c.target ? { kind: 'exists', target: c.target } : { kind: 'textVisible', text: '' };
                  markDirty();
                  draw();
                },
              },
              h('option', { value: 'textVisible', selected: c.kind === 'textVisible' }, '화면에 글자가 보임'),
              h('option', { value: 'urlContains', selected: c.kind === 'urlContains' }, '주소에 글자가 포함됨'),
              c.target ? h('option', { value: 'exists', selected: c.kind === 'exists' }, '요소가 있음') : null,
            ),
          ),
        );
        if (c.kind === 'textVisible') fields.push(field('글자', text(c, 'text')));
        if (c.kind === 'urlContains') fields.push(field('주소에 포함될 글자', text(c, 'value')));
        if (s.type === 'assert') fields.push(field('실패 메시지', text(s, 'message')));
        break;
      }
      case 'extract':
        fields.push(field('저장할 변수 이름 (결과 엑셀 열 이름)', text(s, 'saveAs')), field('속성(비우면 글자)', text(s, 'attr', { placeholder: '예: href, value' })));
        break;
      case 'dialog':
        fields.push(
          field('응답', h('select', { onchange: (e) => ((s.action = e.target.value), markDirty(), draw()) }, h('option', { value: 'accept', selected: s.action !== 'dismiss' }, '확인'), h('option', { value: 'dismiss', selected: s.action === 'dismiss' }, '취소'))),
        );
        if (s.meta?.dialogType === 'prompt') fields.push(field('입력할 글자', text(s, 'promptText')));
        break;
      case 'pdf':
        fields.push(field('파일 이름 ({{열}}, {{row}}, {{sys:date:YYYYMMDD}})', text(s, 'fileName')), field('용지 방향', h('select', { onchange: (e) => ((s.landscape = e.target.value === 'l'), markDirty()) }, h('option', { value: 'p', selected: !s.landscape }, '세로'), h('option', { value: 'l', selected: !!s.landscape }, '가로'))));
        break;
      case 'screenshot':
        fields.push(field('파일 이름', text(s, 'fileName')));
        break;
      case 'download':
        fields.push(field('저장 이름 ({{열}}, {{row}} 사용 가능 · 비우면 원래 이름 · 확장자는 원래 것 유지)', text(s, 'fileName', { placeholder: s.meta?.suggestedFilename ?? '' })));
        break;
      case 'upload':
        fields.push(field('첨부할 파일 경로 (예: C:\\자료\\{{상호}}.pdf)', text(s, 'path')));
        break;
      case 'pause':
        fields.push(field('안내 문구', text(s, 'message')));
        break;
      default:
        break;
    }
    if (s.target || ['wait', 'assert'].includes(s.type)) fields.push(field('최대 대기(ms, 기본 10000)', text(s, 'timeoutMs', { type: 'number', num: true })));
    if (!['pdf', 'download', 'upload', 'branch', 'pause', 'dialog'].includes(s.type)) fields.push(field('시도 횟수(기본 1)', text(s, 'attempts', { type: 'number', num: true })));

    const toggle = (key, label, on = true, off = undefined) =>
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s[key] === on, onchange: (e) => ((s[key] = e.target.checked ? on : off), markDirty(), draw()) }), label);

    const move = (d) => () => {
      const j = i + d;
      if (j < 0 || j >= steps.length) return;
      [steps[i], steps[j]] = [steps[j], steps[i]];
      markDirty();
      draw();
    };
    const insertAfter = (step) => {
      steps.splice(i + 1, 0, { id: newId(), ...step });
      openId = steps[i + 1].id;
      markDirty();
      draw();
    };
    const actions = [
      h('button', { class: 'sm', onclick: move(-1), disabled: i === 0 }, '↑ 위로'),
      h('button', { class: 'sm', onclick: move(1), disabled: i === steps.length - 1 }, '↓ 아래로'),
      h('button', { class: 'sm', onclick: () => insertAfter(structuredClone({ ...s, id: undefined })) }, '복제'),
    ];
    if ((s.type === 'input' || s.type === 'select') && !String(s.value ?? '').includes('{{')) {
      actions.push(
        h(
          'button',
          {
            class: 'sm',
            onclick: () => {
              const suggestion = s.target?.meta?.label || s.target?.meta?.name || '';
              const col = prompt('연결할 엑셀 열 이름을 입력하세요. 실행할 때 엑셀의 이 열 값이 들어갑니다.', suggestion);
              if (!col?.trim()) return;
              s.meta = { ...(s.meta ?? {}), recordedValue: s.label || s.value }; // AI 화면 관찰 때 견본 값으로 쓴다
              s.value = `{{${col.trim()}}}`;
              delete s.label;
              recipe.variables ??= [];
              if (!recipe.variables.some((v) => v.id === col.trim() || v.name === col.trim())) recipe.variables.push({ id: col.trim(), name: col.trim(), source: { kind: 'excel', column: col.trim() } });
              markDirty();
              draw();
            },
          },
          '엑셀 열로 바꾸기',
        ),
      );
    }
    if (s.type === 'click' && s.target) {
      actions.push(h('button', { class: 'sm', onclick: () => ((s.type = 'download'), (s.fileName = ''), markDirty(), draw()) }, '파일 다운로드로 바꾸기'));
    }
    if (s.type === 'download') {
      actions.push(h('button', { class: 'sm', onclick: () => ((s.type = 'click'), delete s.fileName, markDirty(), draw()) }, '일반 클릭으로 되돌리기'));
    }
    if (s.target) {
      actions.push(
        h(
          'button',
          {
            class: 'sm',
            onclick: () => {
              const name = prompt('읽은 값을 저장할 이름 (결과 엑셀의 열 이름이 됩니다)', s.target.meta?.label || s.target.meta?.text?.slice(0, 20) || '값');
              if (!name?.trim()) return;
              insertAfter({ type: 'extract', target: structuredClone(s.target), saveAs: name.trim() });
            },
          },
          '이 요소의 글자 읽기 추가',
        ),
        h('button', { class: 'sm', onclick: () => insertAfter({ type: 'wait', condition: { kind: 'exists', target: structuredClone(s.target) }, timeoutMs: 15000 }) }, '이 요소가 나올 때까지 대기 추가'),
      );
    }
    actions.push(
      h(
        'button',
        {
          class: 'sm danger',
          onclick: () => {
            steps.splice(i, 1);
            openId = null;
            markDirty();
            draw();
          },
        },
        '삭제',
      ),
    );

    return h(
      'div',
      { class: 'step-body' },
      fields.length ? h('div', { class: 'fields' }, fields) : null,
      h('div', { class: 'row' }, s.target || ['wait'].includes(s.type) ? toggle('optional', '없으면 건너뜀 (2초만 찾음)') : null, toggle('onError', '실패해도 다음 스텝 계속', 'continue'), toggle('disabled', '이 스텝 끄기')),
      h('div', { class: 'actions' }, actions),
      s.target
        ? h(
            'details',
            { class: 'cands' },
            h('summary', { class: 'muted' }, `대상 요소: ${targetText(s.target)} · 후보 ${s.target.candidates.length}개${s.target.framePath?.length ? ` · 프레임 ${s.target.framePath.length}단계` : ''}`),
            h('ol', null, s.target.candidates.map((c) => h('li', null, h('span', { class: 'badge' }, c.score), ' ', h('code', null, c.kind), ' ', c.kind === 'text' ? `<${c.value.tag}> "${c.value.text}"` : c.value))),
            h('div', { class: 'muted' }, '실행할 때 점수가 높은 후보부터 시도해, 화면에서 정확히 하나만 맞는 후보를 씁니다.'),
          )
        : null,
      s.meta?.url ? h('div', { class: 'muted small', style: 'margin-top:6px;overflow-wrap:anywhere' }, `녹화 당시 주소: ${s.meta.url}`) : null,
    );
  }

  function addBar() {
    const sel = h('select', { style: 'width:auto' }, ADDABLE.map(([k, label]) => h('option', { value: k }, label)));
    return h(
      'div',
      { class: 'card flat row' },
      h('b', null, '스텝 추가'),
      sel,
      h(
        'button',
        {
          onclick: () => {
            const make = ADDABLE.find(([k]) => k === sel.value)[2];
            const main = recipe.blocks[recipe.entryBlock ?? 'main'];
            let at = main.length;
            const openIdx = main.findIndex((s) => s.id === openId);
            if (openIdx >= 0) at = openIdx + 1;
            const step = { id: newId(), ...make(recipe) };
            main.splice(at, 0, step);
            openId = step.id;
            markDirty();
            draw();
          },
        },
        '＋ 추가',
      ),
      h('span', { class: 'muted small' }, '펼쳐 둔 스텝 바로 뒤(없으면 맨 끝)에 들어갑니다.'),
    );
  }

  // ----- 변수 탭 -----
  function varsTab() {
    recipe.variables ??= [];
    const KIND = { excel: '엑셀 열', static: '고정값', prompt: '실행할 때 입력' };
    const rows = recipe.variables.map((v, i) => {
      const src = v.source ?? (v.source = { kind: 'static', value: '' });
      const detail =
        src.kind === 'excel'
          ? field('엑셀 열 이름', text(src, 'column'))
          : src.kind === 'static'
            ? field('값', text(src, 'value'))
            : h('div', { class: 'row' }, field('기본값', text(src, 'default')), h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!src.secret, onchange: (e) => ((src.secret = e.target.checked), markDirty()) }), '비밀값(화면에 가림)'));
      return h(
        'tr',
        null,
        h('td', null, h('code', null, `{{${v.id}}}`)),
        h('td', null, text(v, 'name')),
        h(
          'td',
          null,
          h(
            'select',
            {
              onchange: (e) => {
                v.source = e.target.value === 'excel' ? { kind: 'excel', column: v.name || v.id } : e.target.value === 'prompt' ? { kind: 'prompt' } : { kind: 'static', value: '' };
                markDirty();
                draw();
              },
            },
            Object.entries(KIND).map(([k, label]) => h('option', { value: k, selected: src.kind === k }, label)),
          ),
        ),
        h('td', null, detail),
        h('td', null, h('button', { class: 'sm danger', onclick: () => (recipe.variables.splice(i, 1), markDirty(), draw()) }, '삭제')),
      );
    });
    const linkInput = h('input', {
      type: 'file',
      accept: '.xlsx,.csv',
      style: 'display:none',
      onchange: safely(async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        if (dirty) await save();
        const up = await uploadFile(f);
        const { recipe: linked, linked: links } = await api('POST', `/api/recipes/${recipe.id}/autolink`, { uploadId: up.id });
        if (!links.length) return toast('첫 행 값과 똑같은 입력값을 찾지 못했습니다. 스텝에서 "엑셀 열로 바꾸기"를 써 주세요.');
        recipe = linked;
        markDirty();
        toast(`${links.length}개 입력을 엑셀 열에 연결했습니다: ${links.map((l) => l.column).join(', ')} — 저장을 눌러 주세요.`);
        draw();
      }),
    });
    return h(
      'div',
      null,
      h(
        'div',
        { class: 'card' },
        h('h2', null, '엑셀 연결'),
        h('p', { class: 'muted small', style: 'margin-top:0' }, '녹화할 때 첫 거래처 값으로 입력해 두었다면, 그 값이 들어 있는 엑셀을 올리면 같은 값의 입력 스텝을 자동으로 {{열 이름}} 으로 바꿉니다 (한 열에서만 일치할 때).'),
        h('div', { class: 'row' }, linkInput, h('button', { onclick: () => linkInput.click() }, '엑셀 첫 행으로 자동 연결'), h('a', { class: 'btn', href: `/api/recipes/${recipe.id}/template` }, '입력 양식 받기')),
      ),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'row', style: 'margin-bottom:10px' }, h('h2', { style: 'margin:0' }, '변수'), h('div', { style: 'flex:1' }), h('button', { class: 'sm', onclick: () => (recipe.variables.push({ id: `var${recipe.variables.length + 1}`, name: '', source: { kind: 'static', value: '' } }), markDirty(), draw()) }, '＋ 변수 추가')),
        recipe.variables.length
          ? h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, h('th', null, '쓰는 법'), h('th', null, '이름'), h('th', null, '종류'), h('th', null, '설정'), h('th', null, ''))), h('tbody', null, rows)))
          : h('p', { class: 'muted' }, '변수가 없습니다.'),
        h(
          'p',
          { class: 'muted small' },
          '그 밖에 쓸 수 있는 값: ',
          h('code', null, '{{row}}'),
          ' 행 번호, ',
          h('code', null, '{{sys:date:YYYYMMDD}}'),
          ' 오늘 날짜, ',
          h('code', null, '{{sys:month:-1}}'),
          ' 지난달, ',
          h('code', null, '{{sys:quarter}}'),
          ' 분기, ',
          h('code', null, '{{값이름|digits}}'),
          ' 숫자만.',
        ),
      ),
    );
  }

  // ----- JSON 탭 -----
  function jsonTab() {
    const ta = h('textarea', { class: 'json', spellcheck: 'false' });
    ta.value = JSON.stringify(recipe, null, 2);
    return h(
      'div',
      { class: 'card stack' },
      h('p', { class: 'muted small', style: 'margin:0' }, '조건 분기(branch)·추가 블록 같은 고급 편집은 여기서 직접 고칠 수 있습니다.'),
      ta,
      h(
        'div',
        null,
        h(
          'button',
          {
            class: 'primary',
            onclick: () => {
              try {
                const parsed = JSON.parse(ta.value);
                if (!parsed.blocks) throw new Error('blocks 가 없습니다.');
                parsed.id = recipe.id;
                recipe = parsed;
                markDirty();
                toast('적용했습니다. 저장을 눌러 주세요.');
                draw();
              } catch (e) {
                toast(`JSON 오류: ${e.message}`, 'error');
              }
            },
          },
          'JSON 적용',
        ),
      ),
    );
  }

  draw();
}

// =====================================================================
// AI 도우미 패널 (편집기 오른쪽)
// =====================================================================
const AI_EXAMPLES = [
  '입력값들을 엑셀 열로 바꿔 줘',
  '조회 결과 화면에서 금액을 읽어서 결과 엑셀에 남겨 줘',
  '조회 결과가 없다는 알림이 뜨면 그 행은 실패로 표시하고 넘어가게 해 줘',
  '행마다 결과 화면을 {{상호}}_날짜.pdf 로 저장해 줘',
  '이 레시피가 하는 일을 순서대로 설명해 줘',
];

function aiPanel({ getRecipe, applyRecipe }) {
  const sessionId = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let sid = sessionId;
  let open = false;
  let busyNow = false;
  let pending = null; // { recipe, changes, usage }
  let previousApplied = true;
  let settingsView = null;
  const thread = h('div', { class: 'ai-thread' });
  const progressBox = h('div', { class: 'ai-progress' });
  const input = h('textarea', { placeholder: '레시피를 어떻게 고칠지 말해 주세요. (Ctrl+Enter 로 보내기)', rows: 3 });
  const risky = h('input', { type: 'checkbox' });
  const sendBtn = h('button', { class: 'primary', onclick: () => send() }, '보내기');
  const settingsBox = h('div', { class: 'ai-settings' });
  const modelLabel = h('span', { class: 'muted small' });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
  });

  const panel = h(
    'aside',
    { class: 'ai-panel', hidden: true },
    h(
      'div',
      { class: 'ai-head' },
      h('b', null, '✦ AI 도우미'),
      modelLabel,
      h('div', { style: 'flex:1' }),
      h('button', { class: 'ghost sm', onclick: () => ((settingsBox.hidden = !settingsBox.hidden), drawSettings()) }, '설정'),
      h('button', { class: 'ghost sm', onclick: resetChat }, '새 대화'),
      h('button', { class: 'ghost icon', title: '닫기', onclick: () => toggle(false) }, '✕'),
    ),
    settingsBox,
    thread,
    progressBox,
    h(
      'div',
      { class: 'ai-input' },
      input,
      h('div', { class: 'row' }, h('label', { class: 'check small' }, risky, '화면 관찰 때 제출·결제 같은 버튼도 누르기 허용'), h('div', { style: 'flex:1' }), sendBtn),
    ),
  );
  document.body.append(panel);
  settingsBox.hidden = true;

  async function loadSettings() {
    settingsView = (await api('GET', '/api/settings').catch(() => null))?.openrouter ?? null;
    const m = settingsView?.models?.find((x) => x.id === settingsView?.model);
    modelLabel.textContent = settingsView ? (m ? m.label.split(' (')[0] : settingsView.model) : '';
    if (settingsView && !settingsView.hasKey) settingsBox.hidden = false;
    drawSettings();
  }

  function drawSettings() {
    if (!settingsView) return mount(settingsBox);
    const key = h('input', { type: 'password', placeholder: settingsView.hasKey ? `저장된 키 ${settingsView.keyHint} — 바꿀 때만 입력` : 'sk-or-v1-…', autocomplete: 'off' });
    const model = h(
      'select',
      null,
      settingsView.models.map((m) => h('option', { value: m.id, selected: m.id === settingsView.model }, m.label)),
      settingsView.models.some((m) => m.id === settingsView.model) ? null : h('option', { value: settingsView.model, selected: true }, settingsView.model),
    );
    const custom = h('input', { type: 'text', placeholder: '다른 OpenRouter 모델 id (선택)' });
    mount(
      settingsBox,
      h('div', { class: 'small muted' }, 'OpenRouter 키는 이 PC 의 workspace\\settings.json 에만 저장되고 화면에 다시 보이지 않습니다. 키는 openrouter.ai/keys 에서 만들 수 있습니다.'),
      settingsView.fromEnv ? h('div', { class: 'small' }, '지금은 환경 변수 OPENROUTER_API_KEY 의 키를 쓰고 있습니다.') : null,
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
              settingsBox.hidden = true;
              await loadSettings();
            }),
          },
          '저장',
        ),
        settingsView.hasKey && !settingsView.fromEnv
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

  function bubble(role, ...content) {
    const el = h('div', { class: `ai-msg ${role}` }, ...content);
    add(thread, el);
    thread.scrollTop = thread.scrollHeight;
    return el;
  }

  function drawEmpty() {
    if (thread.childElementCount) return;
    add(
      thread,
      h(
        'div',
        { class: 'ai-empty' },
        h('p', { class: 'small muted' }, '녹화한 레시피를 대화로 다듬습니다. AI 는 레시피를 읽고 고치며, 필요하면 숨긴 브라우저로 특정 스텝까지 실제로 실행해 화면을 확인합니다. 바꾼 내용은 [적용]을 눌러야 반영됩니다.'),
        AI_EXAMPLES.map((ex) => h('button', { class: 'chip', onclick: () => ((input.value = ex), input.focus()) }, ex)),
      ),
    );
  }

  function resetChat() {
    api('POST', '/api/agent/reset', { sessionId: sid }).catch(() => {});
    sid = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    pending = null;
    previousApplied = true;
    mount(thread);
    mount(progressBox);
    drawEmpty();
  }

  function changeCard(result) {
    const card = h(
      'div',
      { class: 'ai-changes' },
      h('b', null, `제안된 변경 ${result.changes.length}건`),
      h('ol', null, result.changes.map((c) => h('li', null, c))),
      result.problems?.length ? h('div', { class: 'notice warn small' }, `검사에서 고칠 점 ${result.problems.length}개: ${result.problems.join(' / ')}`) : null,
    );
    const actions = h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'primary sm',
          onclick: () => {
            applyRecipe(pending.recipe);
            pending = null;
            previousApplied = true;
            mount(actions, h('span', { class: 'badge ok' }, '적용함'));
          },
        },
        '적용',
      ),
      h(
        'button',
        {
          class: 'sm',
          onclick: () => {
            pending = null;
            previousApplied = false;
            mount(actions, h('span', { class: 'badge' }, '버림'));
          },
        },
        '버리기',
      ),
    );
    add(card, actions);
    return card;
  }

  async function send() {
    const text = input.value.trim();
    if (!text || busyNow) return;
    if (!settingsView?.hasKey) {
      settingsBox.hidden = false;
      drawSettings();
      return toast('먼저 OpenRouter 키를 넣어 주세요.', 'error');
    }
    busyNow = true;
    sendBtn.disabled = true;
    sendBtn.textContent = '작업 중…';
    input.value = '';
    thread.querySelector('.ai-empty')?.remove();
    bubble('user', text);
    mount(progressBox, h('div', { class: 'muted small' }, 'AI 에 보내는 중…'));
    // 아직 적용/버리기를 안 한 제안이 있으면 그 위에 이어서 고친다.
    const base = pending ? pending.recipe : getRecipe();
    const prevChanges = pending ? pending.changes : [];
    try {
      const r = await api('POST', '/api/agent/turn', { sessionId: sid, recipe: base, message: text, allowRisky: risky.checked, previousApplied });
      previousApplied = true;
      const cost = r.usage?.turn?.cost ? ` · 이번 요청 $${r.usage.turn.cost.toFixed(4)}` : '';
      const msg = bubble('assistant', h('div', { class: 'ai-text' }, r.reply || '(답변 없음)'), h('div', { class: 'muted small' }, `${r.usage?.model ?? ''}${cost}`));
      if (r.changes.length || prevChanges.length) {
        thread.querySelectorAll('.ai-changes .row').forEach((row) => row.querySelector('button') && mount(row, h('span', { class: 'badge' }, '다음 제안에 합쳐짐')));
        pending = { recipe: r.recipe, changes: [...prevChanges, ...r.changes] };
        add(msg, changeCard({ ...r, changes: pending.changes }));
      }
    } catch (e) {
      bubble('error', e.message);
    } finally {
      busyNow = false;
      sendBtn.disabled = false;
      sendBtn.textContent = '보내기';
      mount(progressBox);
      thread.scrollTop = thread.scrollHeight;
    }
  }

  const off = onLive((type, d) => {
    if (type !== 'agent-progress' || d.sessionId !== sid || !busyNow) return;
    add(progressBox, h('div', { class: 'small' }, d.text));
    while (progressBox.childElementCount > 40) progressBox.firstElementChild.remove();
    progressBox.scrollTop = progressBox.scrollHeight;
  });

  function toggle(force) {
    open = force ?? !open;
    panel.hidden = !open;
    document.body.classList.toggle('ai-open', open);
    if (open) {
      loadSettings();
      drawEmpty();
      input.focus();
    }
  }

  return {
    toggle,
    destroy() {
      off();
      panel.remove();
      document.body.classList.remove('ai-open');
      if (!pending) api('POST', '/api/agent/reset', { sessionId: sid }).catch(() => {});
    },
  };
}

// =====================================================================
// 실행
// =====================================================================
async function runPage(params) {
  const recipes = await api('GET', '/api/recipes').catch(() => []);
  const head = h('div', { class: 'page-head' }, h('h1', null, '실행'));
  const livePanel = h('div');
  const setup = h('div');
  add(app, head, livePanel, setup);

  let selected = params.get('recipe') || localStorage.getItem('rpa:lastRecipe') || recipes[0]?.id;
  const presetUpload = params.get('recipe') && params.get('upload'); // 세트 [예시로 실행]: 설치한 예시 입력을 골라 둔다
  let detail = null;
  let upload = null;
  const values = {};
  const opts = { headless: false, humanPacing: false, recordVideo: false, startRow: '', maxRows: '', onRowError: 'skip' };

  function drawLive() {
    const run = live.run;
    if (!run) return mount(livePanel);
    const active = ['running', 'paused', 'waiting-user'].includes(run.status);
    const p = run.progress ?? { rowsDone: 0, rowsTotal: 0 };
    const pct = p.rowsTotal ? Math.round((p.rowsDone / p.rowsTotal) * 100) : 0;
    const logBox = h(
      'div',
      { class: 'logbox' },
      live.log.slice(-600).map((l) => h('div', { class: /\[error\]/.test(l) ? 'err' : /\[warn\]/.test(l) ? 'warn' : '' }, l)),
    );
    mount(livePanel, 
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'row' },
          statusBadge(run.status),
          h('b', null, run.recipeName ?? ''),
          h('div', { style: 'flex:1' }),
          active
            ? [
                run.status === 'running' ? h('button', { onclick: safely(() => api('POST', '/api/runs/current/pause')) }, '❚❚ 일시정지') : h('button', { onclick: safely(() => api('POST', '/api/runs/current/resume')) }, '▶ 재개'),
                h('button', { class: 'danger', onclick: safely(() => confirm('실행을 중지할까요? 진행 중인 동작을 마무리하고 멈춥니다.') && api('POST', '/api/runs/current/stop')) }, '■ 중지'),
              ]
            : h('a', { class: 'btn primary', href: `#/report/${run.runId}` }, '리포트 보기'),
        ),
        run.status === 'waiting-user'
          ? h('div', { class: 'notice warn waiting', style: 'margin-top:12px' }, h('span', null, run.waiting || '브라우저에서 확인이 필요합니다.'), h('button', { class: 'primary', onclick: safely(() => api('POST', '/api/runs/current/resume')) }, '계속'))
          : null,
        h(
          'div',
          { class: 'statline' },
          h('div', { class: 'stat' }, h('b', null, `${p.rowsDone ?? 0} / ${p.rowsTotal ?? 0}`), h('span', null, '처리한 행')),
          h('div', { class: 'stat' }, h('b', { style: p.rowsFailed ? 'color:var(--bad)' : '' }, p.rowsFailed ?? 0), h('span', null, '실패한 행')),
          h('div', { class: 'stat' }, h('b', { style: 'font-size:14px' }, run.row ? `${run.row.rowNumber}행 ${run.row.label ?? ''}` : '-'), h('span', null, '현재 행')),
        ),
        h('div', { class: 'progress' }, h('div', { style: `width:${pct}%` })),
        run.current && active ? h('p', { class: 'small', style: 'margin:10px 0 0' }, h('span', { class: 'muted' }, '현재 스텝: '), run.current.desc) : null,
        h('h3', { style: 'margin-top:16px' }, '실행 기록'),
        logBox,
      ),
    );
    logBox.scrollTop = logBox.scrollHeight;
  }

  async function loadDetail() {
    detail = selected ? await api('GET', `/api/recipes/${selected}`).catch(() => null) : null;
    drawSetup();
  }

  function drawSetup() {
    const run = live.run;
    const running = run && ['running', 'paused', 'waiting-user'].includes(run.status);
    if (!recipes.length) {
      mount(setup, h('div', { class: 'card empty' }, '실행할 레시피가 없습니다. ', h('a', { href: '#/record' }, '먼저 녹화해 주세요.')));
      return;
    }
    const recipeSel = h(
      'select',
      {
        onchange: (e) => {
          selected = e.target.value;
          upload = null;
          try {
            localStorage.setItem('rpa:lastRecipe', selected);
          } catch {
            /* 무시 */
          }
          loadDetail();
        },
      },
      recipes.map((r) => h('option', { value: r.id, selected: r.id === selected }, r.name)),
    );
    const cols = detail?.excelColumns ?? [];
    const missing = upload ? cols.filter((c) => !upload.headers.includes(c)) : [];
    const fileIn = h('input', {
      type: 'file',
      accept: '.xlsx,.csv',
      style: 'display:none',
      onchange: safely(async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        upload = await uploadFile(f);
        drawSetup();
      }),
    });
    const prompts = detail?.prompts ?? [];
    const optCheck = (key, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!opts[key], onchange: (e) => (opts[key] = e.target.checked) }), label);
    const canStart = detail && !detail.problems.length && (!cols.length || (upload && !missing.length)) && !running;

    mount(setup, 
      h(
        'div',
        { class: 'card stack' },
        h('h2', null, '1. 레시피'),
        recipeSel,
        detail
          ? h(
              'div',
              { class: 'row small muted' },
              detail.recipe.origin ? h('span', { class: 'badge acc' }, `세트 v${detail.recipe.origin.version}`) : null,
              `${Object.values(detail.recipe.blocks).flat().length}스텝`,
              ' · ',
              h('a', { href: `#/recipe/${selected}` }, '편집'),
              detail.problems.length ? h('span', { class: 'badge bad' }, `고칠 점 ${detail.problems.length}개`) : null,
            )
          : null,
        detail?.problems.length ? h('div', { class: 'notice warn' }, h('ul', null, detail.problems.map((p) => h('li', null, p)))) : null,
        detail?.recipe.origin ? h('div', { class: 'small muted' }, setLimitText(detail.recipe.origin)) : null,
      ),
      h(
        'div',
        { class: 'card stack' },
        h('h2', null, '2. 엑셀 데이터'),
        cols.length
          ? [
              h('div', { class: 'row' }, h('span', { class: 'muted small' }, '필요한 열:'), cols.map((c) => h('span', { class: `badge ${upload && !upload.headers.includes(c) ? 'bad' : 'acc'}` }, c))),
              h('div', { class: 'row' }, fileIn, h('button', { onclick: () => fileIn.click() }, upload ? '다른 파일 선택' : '엑셀 파일 선택 (xlsx·csv)'), h('a', { class: 'btn', href: `/api/recipes/${selected}/template` }, '입력 양식 받기')),
              upload
                ? h(
                    'div',
                    { class: 'stack' },
                    h('div', { class: 'small' }, h('b', null, upload.id.replace(/^\d+-/, '')), ` · ${upload.rowCount}행`),
                    missing.length ? h('div', { class: 'notice bad' }, `엑셀에 없는 열: ${missing.join(', ')}`) : null,
                    h(
                      'div',
                      { class: 'table-wrap' },
                      h(
                        'table',
                        null,
                        h('thead', null, h('tr', null, h('th', null, '행'), upload.headers.map((x) => h('th', null, x)))),
                        h(
                          'tbody',
                          null,
                          upload.sample.map((r, i) => h('tr', null, h('td', { class: 'muted' }, i + 1), upload.headers.map((x) => h('td', null, r[x])))),
                        ),
                      ),
                    ),
                    upload.rowCount > upload.sample.length ? h('div', { class: 'muted small' }, `…외 ${upload.rowCount - upload.sample.length}행`) : null,
                  )
                : null,
            ]
          : h('p', { class: 'muted', style: 'margin:0' }, '이 레시피는 엑셀 열을 쓰지 않아 한 번만 실행합니다.'),
      ),
      prompts.length
        ? h(
            'div',
            { class: 'card stack' },
            h('h2', null, '3. 실행할 때 넣을 값'),
            prompts.map((v) =>
              field2(
                v.name || v.id,
                h('input', {
                  type: v.source.secret ? 'password' : 'text',
                  value: values[v.id] ?? v.source.default ?? '',
                  autocomplete: 'off',
                  oninput: (e) => (values[v.id] = e.target.value),
                }),
              ),
            ),
            h('p', { class: 'muted small', style: 'margin:0' }, '비밀값은 저장하지 않고 이번 실행에만 씁니다.'),
          )
        : null,
      h(
        'div',
        { class: 'card stack' },
        h('h2', null, `${prompts.length ? 4 : 3}. 실행 옵션`),
        h('div', { class: 'row' }, optCheck('headless', '브라우저 창 숨기고 실행 (PDF가 인쇄용 품질로 저장됨)'), optCheck('humanPacing', '사람처럼 천천히 (녹화 때 간격, 최대 3초)'), optCheck('recordVideo', '실행 화면을 동영상으로 남기기 (리포트에서 재생)')),
        h(
          'div',
          { class: 'grid2' },
          field2('시작 행 (중단된 곳부터 다시 할 때)', h('input', { type: 'number', min: 1, placeholder: '1', value: opts.startRow, oninput: (e) => (opts.startRow = e.target.value) })),
          field2('최대 행 수 (시험 삼아 몇 행만)', h('input', { type: 'number', min: 1, placeholder: '전체', value: opts.maxRows, oninput: (e) => (opts.maxRows = e.target.value) })),
        ),
        field2(
          '행이 실패하면',
          h('select', { onchange: (e) => (opts.onRowError = e.target.value) }, h('option', { value: 'skip', selected: opts.onRowError === 'skip' }, '기록하고 다음 행 계속'), h('option', { value: 'stop', selected: opts.onRowError === 'stop' }, '실행 중단')),
        ),
        h(
          'div',
          null,
          h(
            'button',
            {
              class: 'primary',
              disabled: !canStart,
              onclick: safely(async () => {
                const missingPrompt = prompts.filter((v) => !(values[v.id] ?? v.source.default));
                if (missingPrompt.length) throw new Error(`값을 넣어 주세요: ${missingPrompt.map((v) => v.name || v.id).join(', ')}`);
                live.log = [];
                const { runId } = await api('POST', '/api/runs', { recipeId: selected, uploadId: upload?.id, params: values, options: opts });
                live.run = { runId, status: 'running', recipeName: detail.recipe.name };
                drawLive();
                drawSetup();
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }),
            },
            '▶ 실행 시작',
          ),
          running ? h('span', { class: 'muted small', style: 'margin-left:10px' }, '다른 실행이 진행 중입니다.') : null,
        ),
      ),
    );
  }
  const field2 = (label, input) => h('label', { class: 'field' }, h('span', null, label), input);

  drawLive();
  if (presetUpload) upload = await api('GET', `/api/uploads/${encodeURIComponent(presetUpload)}`).catch((e) => (toast(`예시 입력을 찾지 못했습니다: ${e.message}`, 'error'), null));
  await loadDetail();
  cleanup = onLive((type) => {
    if (type.startsWith('run-') || type === 'state') drawLive();
    if (type === 'run-status' || type === 'state') drawSetup();
  });
}

// =====================================================================
// 리포트
// =====================================================================
async function reportsPage() {
  add(app, h('div', { class: 'page-head' }, h('h1', null, '리포트')));
  const list = await api('GET', '/api/runs').catch(() => []);
  if (!list.length) {
    add(app, h('div', { class: 'card empty' }, '아직 실행 기록이 없습니다.'));
    return;
  }
  add(app, 
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        null,
        h('thead', null, h('tr', null, h('th', null, '시작'), h('th', null, '레시피'), h('th', null, '결과'), h('th', null, '성공 / 실패'), h('th', null, '소요'))),
        h(
          'tbody',
          null,
          list.map((r) =>
            h(
              'tr',
              { class: 'click', onclick: () => (location.hash = `#/report/${r.runId}`) },
              h('td', null, fmtTime(r.startedAt)),
              h('td', null, r.recipe?.name),
              h('td', null, statusBadge(r.status), r.error ? h('div', { class: 'small muted' }, r.error) : null),
              h('td', null, `${r.totals?.ok ?? 0} / `, h('span', { style: r.totals?.failed ? 'color:var(--bad);font-weight:600' : '' }, r.totals?.failed ?? 0)),
              h('td', null, fmtDur(r.durationMs)),
            ),
          ),
        ),
      ),
    ),
  );
}

async function reportPage(runId) {
  let r;
  try {
    r = await api('GET', `/api/runs/${runId}`);
  } catch (e) {
    add(app, h('div', { class: 'notice bad' }, e.message));
    return;
  }
  const fileUrl = (p, dl) => `/api/runs/${runId}/file?path=${encodeURIComponent(p)}${dl ? '&download=1' : ''}`;
  const valueKeys = [...new Set(r.rows.flatMap((x) => Object.keys(x.values ?? {})))];
  add(app, 
    h(
      'div',
      { class: 'page-head' },
      h('a', { href: '#/reports', class: 'muted' }, '← 리포트'),
      h('h1', null, r.recipe?.name),
      statusBadge(r.status),
      h('div', { class: 'spacer' }),
      h('button', { onclick: safely(() => api('POST', `/api/runs/${runId}/open-folder`)) }, '폴더 열기'),
      r.rows.length ? h('a', { class: 'btn', href: fileUrl('results.xlsx', true) }, '결과 엑셀') : null,
      h(
        'button',
        {
          class: 'danger',
          onclick: safely(async () => {
            if (!confirm('이 실행 기록과 저장된 파일을 모두 지울까요?')) return;
            await api('DELETE', `/api/runs/${runId}`);
            location.hash = '#/reports';
          }),
        },
        '삭제',
      ),
    ),
    r.error ? h('div', { class: 'notice bad' }, r.error) : null,
    h(
      'div',
      { class: 'statline' },
      h('div', { class: 'stat' }, h('b', null, r.totals.rows), h('span', null, '실행한 행')),
      h('div', { class: 'stat' }, h('b', { style: 'color:var(--ok)' }, r.totals.ok), h('span', null, '성공')),
      h('div', { class: 'stat' }, h('b', { style: r.totals.failed ? 'color:var(--bad)' : '' }, r.totals.failed), h('span', null, '실패')),
      h('div', { class: 'stat' }, h('b', { style: 'font-size:15px' }, fmtDur(r.durationMs)), h('span', null, fmtTime(r.startedAt))),
      h('div', { class: 'stat' }, h('b', null, r.files.length), h('span', null, '저장한 파일')),
    ),
    r.rows.length
      ? h(
          'div',
          { class: 'table-wrap', style: 'margin-bottom:16px' },
          h(
            'table',
            null,
            h('thead', null, h('tr', null, h('th', null, '행'), h('th', null, '데이터'), h('th', null, '결과'), valueKeys.map((k) => h('th', null, k)), h('th', null, '파일'), h('th', null, '오류'))),
            h(
              'tbody',
              null,
              r.rows.map((row) =>
                h(
                  'tr',
                  null,
                  h('td', null, row.rowNumber),
                  h('td', null, row.label),
                  h('td', null, h('span', { class: `badge ${row.status === 'ok' ? 'ok' : 'bad'}` }, row.status === 'ok' ? '성공' : '실패'), h('div', { class: 'muted small' }, fmtDur(row.durationMs))),
                  valueKeys.map((k) => h('td', null, row.values?.[k] ?? '')),
                  h('td', null, (row.files ?? []).map((f) => h('div', null, h('a', { href: fileUrl(f), target: '_blank' }, f.replace(/^files[\\/]/, ''))))),
                  h(
                    'td',
                    { style: 'max-width:360px' },
                    row.failure ? h('div', { class: 'small' }, h('b', null, row.failure.desc)) : null,
                    row.error ? h('div', { class: 'small', style: 'color:var(--bad)' }, row.error) : null,
                    row.screenshot ? h('a', { class: 'small', href: fileUrl(row.screenshot), target: '_blank' }, '실패 화면 보기') : null,
                  ),
                ),
              ),
            ),
          ),
        )
      : null,
    r.videos?.length
      ? h(
          'div',
          { class: 'card' },
          h('h3', null, `실행 영상 (${r.videos.length})`),
          h('div', { class: 'muted small' }, '탭마다 영상 하나입니다. 첫 영상이 업무 탭이고, 나머지는 사이트가 연 창입니다.'),
          ...r.videos.map((v, i) =>
            h('div', { style: 'margin-top:10px' }, h('div', { class: 'small' }, i === 0 ? '업무 탭' : `새 창 ${i}`), h('video', { src: fileUrl(v.path), controls: true, preload: 'metadata', style: 'width:100%;max-width:960px;border:1px solid var(--line);border-radius:6px' })),
          ),
        )
      : null,
    h('div', { class: 'card' }, h('h3', null, '실행 기록'), h('div', { class: 'logbox' }, r.log)),
  );
}

// =====================================================================
// 설정
// =====================================================================
async function settingsPage() {
  add(app, h('div', { class: 'page-head' }, h('h1', null, '설정')));
  const box = h('div');
  add(app, box);
  const draw = async () => {
    const s = await api('GET', '/api/settings').catch((e) => (toast(e.message, 'error'), null));
    if (!s) return;
    mount(box, browserCard(s.browser, draw), hubSourcesCard(s, draw), aiCard(s.openrouter, draw));
  };
  await draw();
}

function browserCard(b, redraw) {
  let selected = b.id;
  const pathIn = h('input', { type: 'text', value: b.path ?? '', placeholder: 'C:\\…\\browser.exe (Chromium 계열: Chrome·Edge·Brave·Vivaldi·Whale 등)' });
  const result = h('div', { class: 'small' });
  const options = b.choices.map((c) =>
    h(
      'label',
      { class: `browser-opt ${c.found ? '' : 'missing'}` },
      h('input', {
        type: 'radio',
        name: 'browser',
        value: c.id,
        checked: c.id === b.id,
        disabled: !c.found,
        onchange: () => {
          selected = c.id;
          pathIn.disabled = selected !== 'custom';
        },
      }),
      h(
        'div',
        null,
        h('b', null, c.label),
        c.id === b.id ? h('span', { class: 'badge acc', style: 'margin-left:6px' }, '사용 중') : null,
        h('div', { class: 'muted small', style: 'overflow-wrap:anywhere' }, c.id === 'auto' ? '설치된 것 중 첫 번째' : c.id === 'custom' ? '아래에 실행 파일 경로를 넣으세요' : c.found ? c.path : '이 PC 에 설치돼 있지 않음'),
      ),
    ),
  );
  pathIn.disabled = selected !== 'custom';
  return h(
    'div',
    { class: 'card stack' },
    h('h2', null, '브라우저'),
    h('p', { class: 'muted small', style: 'margin:0' }, '녹화·실행·AI 화면 관찰에 쓸 브라우저입니다. 브라우저마다 프로필(로그인 상태)을 따로 둡니다. 바꾸면 새 브라우저에서 사이트에 한 번 다시 로그인해야 할 수 있습니다.'),
    h('div', { class: 'browser-opts' }, options),
    h('label', { class: 'field' }, h('span', null, '직접 지정 경로'), pathIn),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'primary',
          onclick: safely(async () => {
            await api('PUT', '/api/settings', { browser: { id: selected, path: pathIn.value } });
            toast('브라우저 설정을 저장했습니다. 다음 녹화·실행부터 적용됩니다.');
            await redraw();
          }),
        },
        '저장',
      ),
      h(
        'button',
        {
          onclick: safely(async (e) => {
            e.target.disabled = true;
            mount(result, h('span', { class: 'muted' }, '브라우저를 띄워 확인하는 중…'));
            try {
              const r = await api('POST', '/api/settings/test-browser');
              mount(result, h('span', { class: 'badge ok' }, '실행됨'), ` ${r.browser} · ${r.product} · 프로필 "${r.profile}"`);
            } catch (err) {
              mount(result, h('span', { class: 'badge bad' }, '실패'), ` ${err.message}`);
            } finally {
              e.target.disabled = false;
            }
          }),
        },
        '저장된 설정으로 시험 실행',
      ),
      result,
    ),
  );
}

function aiCard(o, redraw) {
  const key = h('input', { type: 'password', autocomplete: 'off', placeholder: o.hasKey ? `저장된 키 ${o.keyHint} — 바꿀 때만 입력` : 'sk-or-v1-…' });
  const model = h('select', null, o.models.map((m) => h('option', { value: m.id, selected: m.id === o.model }, m.label)), o.models.some((m) => m.id === o.model) ? null : h('option', { value: o.model, selected: true }, o.model));
  const custom = h('input', { type: 'text', placeholder: '다른 OpenRouter 모델 id (선택)' });
  return h(
    'div',
    { class: 'card stack' },
    h('h2', null, 'AI 도우미 (OpenRouter)'),
    h('p', { class: 'muted small', style: 'margin:0' }, '키는 이 PC 의 workspace\\settings.json 에만 저장되고 화면에 다시 보이지 않습니다. openrouter.ai/keys 에서 만들 수 있습니다.'),
    o.fromEnv ? h('div', { class: 'small' }, '지금은 환경 변수 OPENROUTER_API_KEY 의 키를 쓰고 있습니다.') : null,
    h('div', { class: 'grid2' }, h('label', { class: 'field' }, h('span', null, `API 키 ${o.hasKey ? `(저장됨 ${o.keyHint})` : '(없음)'}`), key), h('label', { class: 'field' }, h('span', null, '모델'), model)),
    h('label', { class: 'field' }, h('span', null, '모델 직접 입력 (비우면 위 선택)'), custom),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'primary',
          onclick: safely(async () => {
            const body = { openrouter: { model: custom.value.trim() || model.value } };
            if (key.value.trim()) body.openrouter.apiKey = key.value.trim();
            await api('PUT', '/api/settings', body);
            toast('AI 설정을 저장했습니다.');
            await redraw();
          }),
        },
        '저장',
      ),
      o.hasKey && !o.fromEnv
        ? h(
            'button',
            {
              class: 'danger',
              onclick: safely(async () => {
                if (!confirm('저장된 OpenRouter 키를 지울까요?')) return;
                await api('PUT', '/api/settings', { openrouter: { apiKey: '' } });
                await redraw();
              }),
            },
            '키 지우기',
          )
        : null,
    ),
  );
}

// =====================================================================
// 진행 세트·허브 공용 조각
// =====================================================================
const RISK = { submit: ['제출·결제', 'bad'], download: ['파일 저장', 'acc'], upload: ['파일 첨부', 'warn'], login: ['로그인', 'warn'], 'insecure-http': ['암호화 안 된 사이트', 'bad'], 'var-in-url': ['주소에 변수', 'warn'] };
const riskBadge = (f) => h('span', { class: `badge ${RISK[f]?.[1] ?? ''}` }, RISK[f]?.[0] ?? f);
const riskBadges = (flags) => (flags ?? []).map(riskBadge);
const hostOf = (o) => {
  try {
    const u = new URL(o);
    return u.protocol === 'http:' ? u.origin : u.host;
  } catch {
    return String(o ?? '');
  }
};
const SET_ID_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const HUB_REPO = 'https://github.com/Tak002/web-rpa-hub';

/** 설치한 세트 레시피의 제한 안내 한 줄 */
function setLimitText(o) {
  const sites = (o.sites ?? []).map(hostOf).join(', ') || '(없음)';
  const p = o.pacing ?? {};
  return `세트 ${o.set} v${o.version} 에서 설치한 레시피입니다. 실행할 때 ${sites} 에만 접속하고, 행 사이 ${(Number(p.minRowIntervalMs) || 0) / 1000}초 이상 쉬며 한 번에 최대 ${p.maxRowsPerRun ?? '-'}행까지 실행합니다.`;
}

// ---------- 마크다운 (README): 제목·목록·문단·코드만. 글자는 모두 텍스트 노드로 넣어 HTML 로 해석되지 않는다 ----------
function mdInline(text) {
  const out = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(h('code', null, m[1].slice(1, -1)));
    else if (m[2]) out.push(h('b', null, m[2].slice(2, -2)));
    else out.push(h('a', { href: m[5], target: '_blank', rel: 'noopener noreferrer' }, m[4]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function renderMarkdown(src) {
  const box = h('div', { class: 'md' });
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const LIST = /^\s*([-*+]|\d+[.)])\s+/;
  let para = [];
  const flush = () => {
    if (para.length) add(box, h('p', null, mdInline(para.join(' '))));
    para = [];
  };
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code = [];
      for (i += 1; i < lines.length && !/^\s*```/.test(lines[i]); i += 1) code.push(lines[i]);
      add(box, h('pre', null, h('code', null, code.join('\n'))));
      i += 1;
      continue;
    }
    const hm = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hm) {
      flush();
      add(box, h(`h${Math.min(hm[1].length + 1, 6)}`, null, mdInline(hm[2].replace(/\s+#+\s*$/, '')))); // 페이지 제목(h1) 아래로 한 단계씩 내린다
      i += 1;
      continue;
    }
    if (LIST.test(line)) {
      flush();
      const list = h(/^\s*\d/.test(line) ? 'ol' : 'ul');
      for (; i < lines.length && LIST.test(lines[i]); i += 1) add(list, h('li', null, mdInline(lines[i].replace(LIST, ''))));
      add(box, list);
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line.trim());
    i += 1;
  }
  flush();
  return box;
}

/** 세트 안 내용: 사이트·엑셀 열·입력값·첨부·위험·예시 */
function setDetailSections(p) {
  const table = (head, rows) => h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, head.map((x) => h('th', null, x)))), h('tbody', null, rows)));
  return h(
    'div',
    { class: 'set-details' },
    h('h3', null, '접속하는 사이트'),
    h(
      'ul',
      null,
      p.sites.map((s) =>
        h('li', null, h('b', null, hostOf(s.origin)), s.purpose ? ` — ${s.purpose}` : '', s.login === 'required' ? h('span', { class: 'badge warn', style: 'margin-left:6px' }, '로그인 필요') : null, s.used === false ? h('span', { class: 'muted small' }, ' (레시피 밖 주소 — 다운로드 등)') : null),
      ),
    ),
    h('h3', null, '엑셀 열'),
    p.columns.length
      ? table(
          ['열', '설명', '예'],
          p.columns.map((c) => h('tr', null, h('td', null, h('b', null, c.name), c.required === false ? h('span', { class: 'muted small' }, ' (선택)') : null), h('td', null, c.help || ''), h('td', null, c.example || ''))),
        )
      : h('p', { class: 'muted small', style: 'margin:0' }, '엑셀 없이 한 번 실행합니다.'),
    p.prompts.length ? [h('h3', null, '실행할 때 넣는 값'), h('ul', null, p.prompts.map((x) => h('li', null, x.name, x.secret ? ' (비밀값 — 저장하지 않음)' : '')))] : null,
    p.attachments.length ? [h('h3', null, '첨부할 파일'), h('p', { class: 'muted small', style: 'margin:0' }, '설치한 뒤 편집 화면에서 첨부 파일 경로를 정해야 실행할 수 있습니다.'), h('ul', null, p.attachments.map((a) => h('li', null, a.where, a.help ? ` — ${a.help}` : '')))] : null,
    h('h3', null, '주의할 동작'),
    p.risks.length
      ? h('ul', { class: 'risk-list' }, p.risks.map((r) => h('li', null, riskBadge(r.flag), ' ', r.detail, r.where ? h('span', { class: 'muted small' }, ` (${r.where})`) : null)))
      : h('p', { class: 'muted small', style: 'margin:0' }, '표시할 위험 동작이 없습니다.'),
    p.sample?.rows?.length
      ? [
          h('h3', null, `예시 입력 (${p.sample.rows.length}행)`),
          table(
            p.sample.headers,
            p.sample.rows.map((r) => h('tr', null, p.sample.headers.map((x) => h('td', null, r[x] ?? '')))),
          ),
        ]
      : null,
  );
}

/** 설치 결과: 레시피 열기 · 예시로 실행 */
function installedView(r) {
  return [
    h('h2', null, `${r.updated ? '새 버전으로 바꿨습니다' : '설치했습니다'}: ${r.name} v${r.version}`),
    r.updated ? h('p', { class: 'small muted', style: 'margin:0' }, `이전 버전(v${r.previousVersion})의 레시피는 작업 폴더 trash 에 보관했습니다.`) : null,
    h('p', { class: 'small', style: 'margin:0' }, '먼저 세트에 들어 있는 예시 입력으로 실행해 결과를 확인해 보세요. 실행할 때 넣을 값(비밀번호 등)이 있으면 실행 화면에서 넣습니다. 이 레시피는 세트가 밝힌 사이트에만 접속합니다.'),
    h('div', { class: 'row' }, h('a', { class: 'btn primary', href: `#/run?recipe=${encodeURIComponent(r.recipeId)}&upload=${encodeURIComponent(r.uploadId)}` }, '▶ 예시로 실행'), h('a', { class: 'btn', href: `#/recipe/${r.recipeId}` }, '레시피 열기')),
    r.warnings?.length ? h('div', { class: 'notice warn small' }, h('ul', null, r.warnings.map((w) => h('li', null, w)))) : null,
  ];
}

/**
 * 가져오기 확인: sha256·엔진 확인, 하는 일 요약, 오류·경고, [설치].
 * @param {object} p 미리보기 (/api/hub/preview, /api/sets/preview)
 * @param {{install: () => Promise<object>, details?: boolean}} o
 */
function setImportCard(p, { install, details = false }) {
  const card = h('div', { class: 'card stack set-import' });
  const check = (ok, text) => h('li', { class: ok === true ? 'ok' : ok === false ? 'bad' : 'info' }, text);
  const installBtn = h(
    'button',
    {
      class: 'primary',
      disabled: p.errors.length > 0,
      onclick: safely(async () => {
        installBtn.disabled = true;
        installBtn.textContent = '설치 중…';
        try {
          mount(card, installedView(await install()));
        } catch (e) {
          installBtn.disabled = false;
          installBtn.textContent = '설치';
          throw e;
        }
      }),
    },
    p.installed ? (p.installed.version === p.version ? '다시 설치' : `v${p.version}(으)로 바꾸기`) : '설치',
  );
  mount(
    card,
    h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, `가져오기 확인: ${p.name || '(이름 없음)'}`), p.version ? h('span', { class: 'badge' }, `v${p.version}`) : null, riskBadges(p.flags)),
    h(
      'ul',
      { class: 'checks' },
      p.verified === 'hub'
        ? check(true, `내려받은 파일이 허브 목록의 sha256 과 같습니다 (${p.sha256.slice(0, 12)}…).`)
        : check(null, `허브가 아닌 파일이라 비교할 sha256 이 없습니다. 믿을 수 있는 곳에서 받은 파일인지 확인하세요. (sha256 ${p.sha256?.slice(0, 12)}…)`),
      p.engine.required ? check(p.engine.ok, p.engine.ok ? `지금 web-rpa ${p.engine.current} 에서 실행할 수 있습니다 (필요: ${p.engine.required}).` : `web-rpa ${p.engine.required} 가 필요합니다 (지금 ${p.engine.current}).`) : null,
      p.manifest?.author?.name ? check(null, `만든 사람: ${p.manifest.author.name}${p.manifest.author.github ? ` (GitHub ${p.manifest.author.github})` : ''} · 라이선스 ${p.manifest.license ?? '-'}`) : null,
    ),
    p.summary?.length ? h('div', { class: 'notice info' }, p.summary.map((x) => h('div', null, x))) : null,
    p.installed ? h('div', { class: 'small' }, `이미 v${p.installed.version} 이(가) 설치돼 있습니다. 설치하면 그 레시피를 이 버전으로 바꿉니다 (이전 레시피는 작업 폴더 trash 에 보관).`) : null,
    p.errors.length ? h('div', { class: 'notice bad' }, h('b', null, '설치할 수 없습니다'), h('ul', null, p.errors.map((e) => h('li', null, e)))) : null,
    p.warnings.length ? h('div', { class: 'notice warn' }, h('b', null, '확인할 점'), h('ul', null, p.warnings.map((e) => h('li', null, e)))) : null,
    details ? setDetailSections(p) : null,
    details && p.readme ? h('details', null, h('summary', null, '설명(README) 보기'), renderMarkdown(p.readme)) : null,
    h('div', { class: 'row' }, installBtn, h('span', { class: 'muted small' }, '설치하면 레시피와 예시 입력이 추가됩니다. 실행은 직접 시작해야 합니다.')),
  );
  return card;
}

/** [세트 파일 가져오기]: .wrset 고르기 → 미리보기 → 설치 */
function setFilePicker(box) {
  return h('input', {
    type: 'file',
    accept: '.wrset',
    style: 'display:none',
    onchange: async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      mount(box, h('div', { class: 'card muted' }, `${f.name} 확인 중…`));
      try {
        const p = await api('POST', '/api/sets/preview', f, { raw: true });
        mount(box, setImportCard(p, { install: () => api('POST', '/api/sets/install', f, { raw: true }), details: true }));
      } catch (err) {
        mount(box, h('div', { class: 'notice bad' }, h('b', null, `${f.name}: 가져올 수 없습니다`), h('div', { style: 'white-space:pre-wrap' }, err.message)));
      }
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  });
}

// =====================================================================
// 허브
// =====================================================================
async function hubPage(params) {
  if (params.get('id')) return hubDetailPage(params);
  const importBox = h('div');
  const fileIn = setFilePicker(importBox);
  const listBox = h('div', null, h('div', { class: 'card muted' }, '허브 목록을 불러오는 중…'));
  const search = h('input', { type: 'text', placeholder: '이름·설명·태그·사이트·엑셀 열로 찾기', value: params.get('q') ?? '', 'aria-label': '세트 찾기', oninput: () => draw() });
  let data = null;
  add(
    app,
    h('div', { class: 'page-head' }, h('h1', null, '허브'), h('div', { class: 'spacer' }), fileIn, h('button', { onclick: () => fileIn.click() }, '세트 파일 가져오기'), h('button', { onclick: () => load(true) }, '새로 고침')),
    h('p', { class: 'muted small', style: 'margin:-8px 0 14px' }, '다른 사람이 공개한 진행 세트(레시피 + 예시 입력 + 설명)를 찾아 가져옵니다. 가져오기 전에 접속하는 사이트와 하는 일을 꼭 확인하세요.'),
    importBox,
    h('div', { style: 'margin-bottom:12px' }, search),
    listBox,
  );

  const haystack = (s) => [s.name, s.summary, s.id, s.author?.name, ...(s.tags ?? []), ...(s.entry?.sites ?? []), ...(s.entry?.columns ?? [])].join(' ').toLowerCase();

  function draw() {
    if (!data) return;
    const failed = data.sources.filter((x) => !x.ok);
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const sets = data.sets.filter((s) => words.every((w) => haystack(s).includes(w)));
    const notes = failed.length && failed.length < data.sources.length ? failed.map((x) => h('div', { class: 'notice warn small' }, `${x.name} 에 연결하지 못했습니다: ${x.error}`)) : null;
    let body;
    if (data.error) body = h('div', { class: 'card empty' }, h('h2', null, '허브 목록을 불러오지 못했습니다'), h('p', null, data.error));
    else if (!data.sources.length) body = h('div', { class: 'card empty' }, h('h2', null, '허브 주소가 없습니다'), h('p', null, '설정 → 허브에서 허브 주소를 넣거나, 받아 둔 세트 파일(.wrset)을 [세트 파일 가져오기]로 설치하세요.'), h('a', { class: 'btn', href: '#/settings' }, '설정 열기'));
    else if (failed.length === data.sources.length)
      body = h(
        'div',
        { class: 'card empty' },
        h('h2', null, '허브에 연결하지 못했습니다'),
        h('p', null, '인터넷 연결이나 설정의 허브 주소를 확인한 뒤 [새로 고침]을 눌러 주세요. 받아 둔 세트 파일(.wrset)이 있으면 [세트 파일 가져오기]로 설치할 수 있습니다.'),
        h('ul', { class: 'small', style: 'display:inline-block;text-align:left' }, failed.map((x) => h('li', null, `${x.name}: ${x.error}`))),
      );
    else if (!data.sets.length) body = h('div', { class: 'card empty' }, '아직 올라온 세트가 없습니다.');
    else if (!sets.length) body = h('div', { class: 'card empty' }, `"${search.value.trim()}" 에 맞는 세트가 없습니다.`);
    else body = h('div', { class: 'hub-grid' }, sets.map(hubSetCard));
    mount(listBox, notes, body);
  }

  async function load(refresh) {
    mount(listBox, h('div', { class: 'card muted' }, '허브 목록을 불러오는 중…'));
    try {
      data = await api('GET', `/api/hub${refresh ? '?refresh=1' : ''}`);
    } catch (e) {
      data = { sources: [], sets: [], error: e.message };
    }
    draw();
  }
  await load(false);
}

function hubSetCard(s) {
  const v = s.entry;
  const meta = [s.author?.name, v.verified?.at ? `마지막 확인 ${v.verified.at}${v.verified.result ? ` (${v.verified.result})` : ''}` : '', s.tags?.length ? s.tags.map((t) => `#${t}`).join(' ') : ''].filter(Boolean).join(' · ');
  return h(
    'a',
    { class: 'card hub-card', href: `#/hub?source=${encodeURIComponent(s.source)}&id=${encodeURIComponent(s.id)}` },
    h(
      'div',
      { class: 'row' },
      h('b', { class: 'hub-name' }, s.name),
      h('span', { class: 'badge' }, `v${v.version}`),
      s.installed ? h('span', { class: `badge ${s.update ? 'warn' : 'ok'}` }, s.update ? `업데이트 있음 (설치 v${s.installed.version})` : '설치됨') : null,
      v.compatible ? null : h('span', { class: 'badge bad' }, '이 web-rpa 와 안 맞음'),
    ),
    s.summary ? h('div', { class: 'small hub-summary' }, s.summary) : null,
    h('div', { class: 'small muted hub-summary' }, '사이트: ', v.sites.map(hostOf).join(', ') || '-'),
    v.columns.length ? h('div', { class: 'small muted hub-summary' }, '엑셀 열: ', v.columns.join(', ')) : null,
    v.risk.length ? h('div', { class: 'row' }, riskBadges(v.risk)) : null,
    meta ? h('div', { class: 'small muted hub-summary' }, meta) : null,
  );
}

async function hubDetailPage(params) {
  const source = params.get('source');
  const id = params.get('id');
  add(app, h('div', { class: 'page-head' }, h('a', { href: '#/hub', class: 'muted' }, '← 허브')));
  let data;
  try {
    data = await api('GET', '/api/hub');
  } catch (e) {
    add(app, h('div', { class: 'notice bad' }, e.message));
    return;
  }
  const s = data.sets.find((x) => x.id === id && (!source || x.source === source));
  if (!s) {
    const failed = data.sources.filter((x) => !x.ok);
    add(app, h('div', { class: 'card empty' }, `허브에서 ${id} 세트를 찾지 못했습니다.${failed.length ? ` (${failed.map((x) => `${x.name}: ${x.error}`).join(' / ')})` : ''}`));
    return;
  }
  let version = params.get('version') || s.entry.version;
  let preview = null;
  let previewErr = null;
  let pending = null;
  const confirmBox = h('div');
  const infoBox = h('div');
  const readmeBox = h('div', { class: 'card' }, h('div', { class: 'muted small' }, '설명을 불러오는 중…'));
  const verSel = h(
    'select',
    { style: 'width:auto', 'aria-label': '버전', onchange: (e) => ((version = e.target.value), mount(confirmBox), loadPreview()) },
    s.versions.map((v) => h('option', { value: v.version, selected: v.version === version }, `v${v.version}${v.version === s.latest ? ' · 최신' : ''}${v.compatible ? '' : ' · 이 web-rpa 와 안 맞음'}`)),
  );
  const entry = () => s.versions.find((v) => v.version === version) ?? s.entry;
  add(
    app,
    h(
      'div',
      { class: 'card stack' },
      h('div', { class: 'row' }, h('h1', { style: 'overflow-wrap:anywhere' }, s.name), s.installed ? h('span', { class: `badge ${s.update ? 'warn' : 'ok'}` }, s.update ? `업데이트 있음 (설치 v${s.installed.version})` : `설치됨 v${s.installed.version}`) : null),
      s.summary ? h('p', { style: 'margin:0' }, s.summary) : null,
      h('div', { class: 'small muted', style: 'overflow-wrap:anywhere' }, [s.id, s.author?.name ? `만든 사람 ${s.author.name}` : '', s.license ? `라이선스 ${s.license}` : '', s.sourceName].filter(Boolean).join(' · ')),
      h('div', { class: 'row' }, riskBadges(entry().risk), entry().verified?.at ? h('span', { class: 'small muted' }, `마지막 확인 ${entry().verified.at}${entry().verified.result ? ` (${entry().verified.result})` : ''}`) : null),
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'muted small' }, '버전'),
        verSel,
        h('button', { class: 'primary', onclick: () => showConfirm() }, '가져오기'),
        s.installed ? h('a', { class: 'btn', href: `#/recipe/${s.installed.recipeId}` }, '설치한 레시피 열기') : null,
      ),
    ),
    confirmBox,
    infoBox,
    readmeBox,
  );

  function loadPreview() {
    const want = version;
    preview = null;
    previewErr = null;
    mount(infoBox, h('div', { class: 'card muted small' }, '세트를 내려받아 확인하는 중…'));
    pending = api('POST', '/api/hub/preview', { source: s.source, id: s.id, version: want }).then(
      (p) => want === version && (preview = p),
      (e) => want === version && (previewErr = e.message),
    );
    pending.then(() => {
      if (want !== version) return;
      if (previewErr) mount(infoBox, h('div', { class: 'notice bad' }, h('b', null, '세트를 확인하지 못했습니다'), h('div', { style: 'white-space:pre-wrap' }, previewErr)));
      else mount(infoBox, h('div', { class: 'card' }, setDetailSections(preview)));
    });
  }

  async function showConfirm() {
    if (!preview && !previewErr) mount(confirmBox, h('div', { class: 'card muted small' }, '세트를 내려받아 확인하는 중…'));
    await pending;
    if (previewErr) mount(confirmBox, h('div', { class: 'notice bad' }, h('b', null, '가져올 수 없습니다'), h('div', { style: 'white-space:pre-wrap' }, previewErr)));
    else if (preview) mount(confirmBox, setImportCard(preview, { install: () => api('POST', '/api/hub/install', { source: s.source, id: s.id, version: preview.version }) }));
    confirmBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  api('GET', `/api/hub/readme?source=${encodeURIComponent(s.source)}&id=${encodeURIComponent(s.id)}`).then(
    (r) => mount(readmeBox, r.text ? renderMarkdown(r.text) : h('p', { class: 'muted', style: 'margin:0' }, '설명(README)이 없습니다.')),
    (e) => mount(readmeBox, h('div', { class: 'muted small' }, `설명을 불러오지 못했습니다: ${e.message}`)),
  );
  loadPreview();
}

// =====================================================================
// 세트로 내보내기 (편집기에서 여는 마법사)
// =====================================================================
async function openSetWizard(recipeId) {
  let draft;
  try {
    draft = await api('GET', `/api/recipes/${recipeId}/set-draft`);
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem('rpa:setAuthor') || '{}');
  } catch {
    /* 저장 불가 환경 */
  }
  const slug = (s) =>
    String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  const m = draft.manifest;
  const st = {
    step: 0,
    idTouched: false,
    info: { name: m.name, summary: '', id: '', version: '1.0.0', author: saved.name ?? '', github: saved.github ?? '', license: m.license, tags: '', description: '' },
    sites: m.sites.map((x) => ({ origin: x.origin, purpose: '', login: x.login, extra: false })),
    columns: m.columns.map((c) => ({ name: c.name, help: '', example: '' })),
    attachments: m.attachments.map((a) => ({ where: a.where, help: '' })),
    decisions: {},
    rows: [],
    expectedText: '',
    check: null,
  };
  const autoId = () => `${slug(st.info.github) || 'me'}/${slug(st.info.name) || 'set'}`;
  st.info.id = autoId();
  const headers = st.columns.length ? st.columns.map((c) => c.name) : ['메모'];
  const STEPS = ['정보', '정리 검토', '예시 입력', '기대 결과', '내려받기'];

  const stepper = h('ol', { class: 'stepper' });
  const body = h('div', { class: 'modal-body' });
  const errBox = h('div');
  const foot = h('div', { class: 'modal-foot row' });
  const close = () => back.remove();
  const back = h(
    'div',
    { class: 'modal-back' },
    h(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '세트로 내보내기' },
      h('div', { class: 'row modal-head' }, h('h2', { style: 'margin:0' }, '세트로 내보내기'), h('div', { style: 'flex:1' }), h('button', { class: 'ghost icon', title: '닫기', onclick: () => confirm('내보내기를 그만둘까요? 적은 내용은 남지 않습니다.') && close() }, '✕')),
      stepper,
      body,
      errBox,
      foot,
    ),
  );
  document.body.append(back);

  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', null, label), input, hint ? h('div', { class: 'muted small' }, hint) : null);
  const text = (obj, key, { placeholder, after, area } = {}) =>
    h(area ? 'textarea' : 'input', {
      ...(area ? { rows: 3, style: 'min-height:64px' } : { type: 'text' }),
      value: obj[key] ?? '',
      placeholder,
      oninput: (e) => {
        obj[key] = e.target.value;
        after?.(e);
      },
    });
  const decisionsDone = () => draft.remaining.every((r) => st.decisions[r.id]);
  const payload = () => ({
    manifest: {
      id: st.info.id.trim(),
      name: st.info.name.trim(),
      version: st.info.version.trim(),
      summary: st.info.summary.trim(),
      author: { name: st.info.author.trim(), github: st.info.github.trim() },
      license: st.info.license.trim(),
      tags: st.info.tags,
      sites: st.sites.map(({ origin, purpose, login }) => ({ origin, purpose, login })),
      columns: st.columns,
      attachments: st.attachments,
    },
    decisions: st.decisions,
    sampleRows: st.rows,
    expected: st.expectedText.trim() ? JSON.parse(st.expectedText) : null,
    description: st.info.description,
    extraSites: st.sites.filter((x) => x.extra).map((x) => x.origin),
  });

  /** 다음으로 넘어가기 전 확인 → 문제 문장 배열 */
  function problemsOf(step) {
    const p = [];
    if (step === 0) {
      if (!st.info.name.trim()) p.push('세트 이름을 적어 주세요.');
      if (st.info.summary.trim().length < 10) p.push('무엇을 하는지 10자 이상 적어 주세요.');
      if (!st.info.author.trim()) p.push('만든 사람 이름을 적어 주세요.');
      if (!SET_ID_RE.test(st.info.id.trim())) p.push('세트 id 는 "게시자/이름" 형식(영문 소문자·숫자·하이픈)이어야 합니다. 예: tak002/dart-report');
      if (!/^\d+\.\d+\.\d+$/.test(st.info.version.trim())) p.push('버전은 1.0.0 처럼 숫자 세 자리로 적어 주세요.');
      if (!st.sites.length) p.push('접속하는 사이트가 없습니다. 레시피에 이동 스텝이나 시작 주소가 있어야 합니다.');
      for (const x of st.sites) if (!x.purpose.trim()) p.push(`${hostOf(x.origin)}: 이 사이트에서 하는 일을 적어 주세요.`);
    }
    if (step === 1 && !decisionsDone()) p.push(`남은 값 ${draft.remaining.filter((r) => !st.decisions[r.id]).length}개를 "그대로 둠" 또는 "지우기"로 정해 주세요.`);
    if (step === 2 && !st.rows.some((r) => headers.some((c) => String(r[c] ?? '').trim()))) p.push('예시 행을 하나 이상 채워 주세요.');
    if (step === 3 && st.expectedText.trim()) {
      try {
        const v = JSON.parse(st.expectedText);
        if (!v || typeof v !== 'object' || Array.isArray(v)) p.push('기대 결과는 { … } 모양의 JSON 이어야 합니다.');
      } catch (e) {
        p.push(`기대 결과 JSON 오류: ${e.message}`);
      }
    }
    return p;
  }

  function go(to) {
    if (to > st.step) {
      for (let s2 = st.step; s2 < to; s2 += 1) {
        const p = problemsOf(s2);
        if (p.length) {
          st.step = s2;
          draw();
          mount(errBox, h('div', { class: 'notice warn' }, h('ul', null, p.map((x) => h('li', null, x)))));
          return;
        }
      }
    }
    st.step = to;
    draw();
    back.scrollTop = 0;
  }

  function drawFoot() {
    mount(
      foot,
      st.step > 0 ? h('button', { onclick: () => go(st.step - 1) }, '← 이전') : null,
      h('div', { style: 'flex:1' }),
      st.step < STEPS.length - 1 ? h('button', { class: 'primary', disabled: st.step === 1 && !decisionsDone(), onclick: () => go(st.step + 1) }, '다음 →') : h('button', { onclick: close }, '닫기'),
    );
  }

  function draw() {
    mount(errBox);
    mount(
      stepper,
      STEPS.map((label, i) => h('li', { class: i === st.step ? 'active' : i < st.step ? 'done' : '', onclick: i < st.step ? () => go(i) : null }, `${i + 1}. ${label}`)),
    );
    mount(body, [infoStep, scrubStep, sampleStep, expectedStep, finishStep][st.step]());
    drawFoot();
  }

  // ----- 1. 정보 -----
  function infoStep() {
    const idIn = text(st.info, 'id', { after: () => (st.idTouched = true) });
    const syncId = () => {
      if (!st.idTouched) idIn.value = st.info.id = autoId();
    };
    const sitesBox = h('div', { class: 'stack' });
    const drawSites = () =>
      mount(
        sitesBox,
        st.sites.map((x, i) =>
          h(
            'div',
            { class: 'site-row' },
            h('b', { style: 'overflow-wrap:anywhere' }, hostOf(x.origin)),
            text(x, 'purpose', { placeholder: '이 사이트에서 하는 일 (예: 공시 목록에서 최신 보고서 찾기)' }),
            h(
              'div',
              { class: 'row', style: 'flex-wrap:nowrap' },
              h(
                'select',
                { style: 'width:auto', 'aria-label': '로그인', onchange: (e) => (x.login = e.target.value) },
                [['none', '로그인 없음'], ['required', '로그인 필요'], ['optional', '로그인 선택']].map(([v, l]) => h('option', { value: v, selected: x.login === v }, l)),
              ),
              x.extra ? h('button', { class: 'sm danger', onclick: () => (st.sites.splice(i, 1), drawSites()) }, '빼기') : null,
            ),
          ),
        ),
      );
    drawSites();
    const extraIn = h('input', { type: 'text', placeholder: 'https://files.example.com (다운로드만 하는 다른 주소 등)' });
    const addSite = () => {
      let o;
      try {
        o = new URL(extraIn.value.trim()).origin;
      } catch {
        return toast('https:// 로 시작하는 주소를 넣어 주세요.', 'error');
      }
      if (!/^https?:/.test(o)) return toast('웹 주소만 넣을 수 있습니다.', 'error');
      if (!st.sites.some((x) => x.origin === o)) st.sites.push({ origin: o, purpose: '', login: 'none', extra: true });
      extraIn.value = '';
      drawSites();
    };
    return [
      draft.problems?.length ? h('div', { class: 'notice warn' }, h('b', null, '레시피에 고칠 점이 있어 세트 검사를 통과하지 못합니다. 편집기에서 먼저 고쳐 주세요.'), h('ul', null, draft.problems.map((x) => h('li', null, x)))) : null,
      h('p', { class: 'muted small', style: 'margin:0' }, '레시피를 다른 사람이 쓸 수 있는 진행 세트(.wrset)로 묶습니다. 세트에는 정리한 레시피, 예시 입력, 설명이 들어가며 녹화 때 입력한 실제 값과 실행 결과는 넣지 않습니다.'),
      h('div', { class: 'grid2' }, field('세트 이름', text(st.info, 'name', { after: syncId })), field('버전', text(st.info, 'version', { placeholder: '1.0.0' }))),
      field('무엇을 하는지 (10자 이상)', text(st.info, 'summary', { area: true, placeholder: '예: DART 에서 회사마다 가장 최근 정기보고서를 찾아 PDF 로 저장합니다.' })),
      h('div', { class: 'grid2' }, field('만든 사람 이름', text(st.info, 'author')), field('GitHub 아이디 (허브에 올릴 때)', text(st.info, 'github', { after: syncId }))),
      h('div', { class: 'grid2' }, field('세트 id (게시자/이름)', idIn, '영문 소문자·숫자·하이픈. 허브에서 세트를 가리키는 이름입니다.'), field('라이선스', text(st.info, 'license'), 'CC0-1.0 은 누구나 조건 없이 쓸 수 있게 공개합니다.')),
      field('태그 (쉼표로 나눔)', text(st.info, 'tags', { placeholder: '예: 공시, 세무, PDF' })),
      h('h3', { style: 'margin:6px 0 0' }, '접속하는 사이트'),
      h('p', { class: 'muted small', style: 'margin:0' }, '세트를 설치한 사람의 실행기는 여기 적은 사이트 밖으로 이동하지 않습니다.'),
      sitesBox,
      h('div', { class: 'row' }, h('div', { style: 'flex:1;min-width:200px' }, extraIn), h('button', { class: 'sm', onclick: addSite }, '＋ 사이트 추가')),
      st.columns.length ? [h('h3', { style: 'margin:6px 0 0' }, '엑셀 열'), st.columns.map((c) => h('div', { class: 'col-row' }, h('b', { style: 'overflow-wrap:anywhere' }, c.name), text(c, 'help', { placeholder: '설명 (예: 상장회사 이름)' }), text(c, 'example', { placeholder: '예시 값 (공개 정보)' })))] : null,
      st.attachments.length ? [h('h3', { style: 'margin:6px 0 0' }, '첨부할 파일'), st.attachments.map((a) => field(a.where, text(a, 'help', { placeholder: '어떤 파일을 첨부하는지' })))] : null,
      field('자세한 설명 (선택 · README 에 들어갑니다)', text(st.info, 'description', { area: true })),
    ];
  }

  // ----- 2. 정리 검토 -----
  function scrubStep() {
    const rows = draft.remaining.map((r, i) =>
      h(
        'div',
        { class: 'decide' },
        h('div', null, h('div', { class: 'small muted' }, `${r.where} · ${r.label}`), h('code', { style: 'overflow-wrap:anywhere' }, r.value)),
        h(
          'div',
          { class: 'row', style: 'flex-wrap:nowrap' },
          ['keep', 'clear']
            .filter((d) => d === 'keep' || !r.id.endsWith(':target'))
            .map((d) =>
              h('label', { class: 'check' }, h('input', { type: 'radio', name: `dec-${i}`, value: d, checked: st.decisions[r.id] === d, onchange: () => ((st.decisions[r.id] = d), drawFoot()) }), d === 'keep' ? '그대로 둠' : '지우기'),
            ),
        ),
        r.id.endsWith(':target') ? h('div', { class: 'small muted', style: 'grid-column:1/-1' }, '대상 요소 안의 글자는 지울 수 없습니다. 개인정보라면 다른 요소로 다시 녹화하거나 변수로 바꿔 주세요.') : null,
      ),
    );
    const all = (d) => () => {
      for (const r of draft.remaining) st.decisions[r.id] = d === 'clear' && r.id.endsWith(':target') ? 'keep' : d;
      draw();
    };
    return [
      h('p', { class: 'small', style: 'margin:0' }, '녹화 정보(녹화 때 입력한 값의 원본, 받은 파일 이름, 알림창 문구, 주소의 쿼리, 첨부 파일 경로 등)는 자동으로 지웠습니다. 아래 남은 값은 하나씩 정해 주세요. 실제 고객·거래처 정보라면 "지우기"를 고르세요 — 지운 칸은 비어서, 설치한 사람이 엑셀 열이나 변수로 바꿔 써야 합니다.'),
      h('details', null, h('summary', { class: 'small' }, `자동으로 지운 것 ${draft.removed.length}개`), h('ul', { class: 'small' }, draft.removed.map((r) => h('li', null, `${r.where}: ${r.what}`)))),
      draft.remaining.length
        ? [h('div', { class: 'row' }, h('b', null, `남은 값 ${draft.remaining.length}개`), h('div', { style: 'flex:1' }), h('button', { class: 'sm', onclick: all('keep') }, '모두 그대로 둠'), h('button', { class: 'sm', onclick: all('clear') }, '모두 지우기')), h('div', null, rows)]
        : h('div', { class: 'notice info' }, '확인할 남은 값이 없습니다.'),
    ];
  }

  // ----- 3. 예시 입력 -----
  function sampleStep() {
    if (!st.rows.length) st.rows.push(Object.fromEntries(headers.map((c) => [c, st.columns.find((x) => x.name === c)?.example ?? (c === '메모' ? '예시' : '')])));
    const tableBox = h('div');
    const drawTable = () =>
      mount(
        tableBox,
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            null,
            h('thead', null, h('tr', null, headers.map((c) => h('th', null, c)), h('th', null, ''))),
            h(
              'tbody',
              null,
              st.rows.map((r, i) => h('tr', null, headers.map((c) => h('td', null, text(r, c, { placeholder: st.columns.find((x) => x.name === c)?.help || '' }))), h('td', null, st.rows.length > 1 ? h('button', { class: 'sm danger', onclick: () => (st.rows.splice(i, 1), drawTable()) }, '삭제') : null))),
            ),
          ),
        ),
        st.rows.length < 5 ? h('div', { style: 'margin-top:8px' }, h('button', { class: 'sm', onclick: () => (st.rows.push(Object.fromEntries(headers.map((c) => [c, '']))), drawTable()) }, '＋ 행 추가')) : null,
      );
    drawTable();
    return [
      h('div', { class: 'notice warn' }, h('b', null, '실제 고객·거래처 정보는 넣지 마세요.'), ' 세트는 누구나 볼 수 있게 공개됩니다. 공개된 정보(예: 상장회사 이름)나 지어낸 값만 쓰세요. 주민등록번호·휴대전화·이메일·카드번호로 보이는 값이 있으면 내보낼 수 없습니다.'),
      h('p', { class: 'muted small', style: 'margin:0' }, st.columns.length ? '설치한 사람이 [예시로 실행]으로 바로 돌려 볼 입력입니다 (1~5행).' : '이 레시피는 엑셀 열을 쓰지 않아, 예시 입력은 "메모" 열 하나로 만듭니다 (행마다 한 번 실행).'),
      tableBox,
    ];
  }

  // ----- 4. 기대 결과 -----
  function expectedStep() {
    const ta = text(st, 'expectedText', { area: true });
    ta.classList.add('json');
    ta.style.minHeight = '200px';
    ta.spellcheck = false;
    return [
      h('p', { class: 'small', style: 'margin:0' }, '예시 입력으로 실행했을 때 나와야 하는 결과입니다(선택). 허브가 세트를 주기적으로 실행해 볼 때 이 결과와 비교합니다. 값은 모양(정규식)이나 일부 글자로 적으면 날마다 바뀌는 값에도 맞습니다.'),
      h(
        'div',
        { class: 'row' },
        draft.expected
          ? h('button', { class: 'sm', onclick: () => ((ta.value = st.expectedText = JSON.stringify(draft.expected, null, 2)), undefined) }, draft.expectedFrom ? '지난 실행으로 초안 만들기' : '레시피로 초안 만들기')
          : null,
        h('button', { class: 'sm', onclick: () => ((ta.value = st.expectedText = ''), undefined) }, '비우기'),
        draft.expectedFrom ? h('span', { class: 'muted small' }, '지난 실행의 값 이름·값 모양·파일 종류만 씁니다 (실제 값은 넣지 않음).') : null,
      ),
      ta,
      h('details', null, h('summary', { class: 'small' }, '형식'), h('pre', { class: 'small' }, '{\n  "rows": {\n    "*":      { "status": "ok", "values": { "합계": { "regex": "^[\\\\d,]+원$" } }, "files": [{ "glob": "*.pdf", "type": "pdf" }] },\n    "예시값": { "values": { "회사명": { "equals": "예시값" } } }\n  }\n}\n"*" 는 모든 행, 그 밖의 키는 예시 입력 첫 열 값입니다. 값 확인: equals(같음) · contains(포함) · regex(모양).')),
    ];
  }

  // ----- 5. 확인·내려받기 -----
  function finishStep() {
    const box = h('div', { class: 'stack' }, h('div', { class: 'muted small' }, '세트를 검사하는 중…'));
    (async () => {
      let r;
      try {
        r = await api('POST', `/api/recipes/${recipeId}/set`, { ...payload(), check: true });
      } catch (e) {
        mount(box, h('div', { class: 'notice bad', style: 'white-space:pre-wrap' }, e.message));
        return;
      }
      st.check = r;
      const done = h('div');
      const dl = h(
        'button',
        {
          class: 'primary',
          disabled: !r.ok,
          onclick: safely(async () => {
            const res = await fetch(`/api/recipes/${recipeId}/set`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload()) });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `요청 실패 (${res.status})`);
            const a = h('a', { href: URL.createObjectURL(await res.blob()), download: r.fileName });
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 2000);
            try {
              localStorage.setItem('rpa:setAuthor', JSON.stringify({ name: st.info.author.trim(), github: st.info.github.trim() }));
            } catch {
              /* 저장 불가 환경 */
            }
            mount(
              done,
              h(
                'div',
                { class: 'notice info' },
                h('b', null, `${r.fileName} 을(를) 내려받았습니다.`),
                h(
                  'ol',
                  null,
                  h('li', null, '받은 세트를 [허브 → 세트 파일 가져오기]로 설치해 [예시로 실행]이 되는지 먼저 확인해 보세요.'),
                  h('li', null, '공개 허브에 올리려면 ', h('a', { href: `${HUB_REPO}/blob/main/CONTRIBUTING.md`, target: '_blank', rel: 'noopener noreferrer' }, '허브 저장소의 CONTRIBUTING 안내'), '에 따라 pull request 로 보냅니다. 허브는 같은 검사와 예시 실행을 다시 합니다.'),
                  h('li', null, '명령줄 검사: ', h('code', null, `web-rpa.cmd set lint ${r.fileName}`)),
                ),
              ),
            );
          }),
        },
        '⬇ 세트 파일 내려받기',
      );
      mount(
        box,
        h('div', { class: 'small' }, h('b', null, r.fileName), ` · ${(r.size / 1024).toFixed(1)}KB · sha256 ${r.sha256.slice(0, 16)}…`),
        r.summary?.length ? h('div', { class: 'notice info' }, r.summary.map((x) => h('div', null, x))) : null,
        r.manifest?.risk?.length ? h('div', { class: 'row' }, h('span', { class: 'small muted' }, '위험 표시:'), riskBadges(r.manifest.risk)) : null,
        r.errors.length ? h('div', { class: 'notice bad' }, h('b', null, '고쳐야 내보낼 수 있습니다'), h('ul', null, r.errors.map((x) => h('li', null, x)))) : h('div', { class: 'notice info' }, '검사를 통과했습니다.'),
        r.warnings.length ? h('div', { class: 'notice warn' }, h('b', null, '확인할 점'), h('ul', null, r.warnings.map((x) => h('li', null, x)))) : null,
        h('div', null, dl),
        done,
      );
    })();
    return box;
  }

  draw();
}

/** 설정: 허브 주소 */
function hubSourcesCard(s, redraw) {
  const list = (s.hubSources ?? []).map((x) => ({ ...x }));
  const box = h('div', { class: 'stack' });
  const drawList = () =>
    mount(
      box,
      list.length
        ? list.map((x, i) =>
            h(
              'div',
              { class: 'hub-src' },
              h('input', { type: 'text', value: x.name, placeholder: '이름', 'aria-label': '허브 이름', oninput: (e) => (x.name = e.target.value) }),
              h('input', { type: 'text', value: x.url, placeholder: 'https://…/index.json', 'aria-label': '허브 주소', oninput: (e) => (x.url = e.target.value) }),
              h('button', { class: 'sm danger', onclick: () => (list.splice(i, 1), drawList()) }, '삭제'),
            ),
          )
        : h('p', { class: 'muted small', style: 'margin:0' }, '허브를 쓰지 않습니다. 세트 파일(.wrset)은 그래도 가져올 수 있습니다.'),
    );
  drawList();
  return h(
    'div',
    { class: 'card stack' },
    h('h2', null, '허브'),
    h('p', { class: 'muted small', style: 'margin:0' }, '진행 세트를 찾을 허브 목록(index.json) 주소입니다. https 주소만 쓸 수 있습니다. 허브 목록은 세트 파일의 sha256 을 함께 알려 주고, 내려받은 파일이 그 값과 다르면 설치하지 않습니다.'),
    box,
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'sm', onclick: () => (list.push({ name: '', url: '' }), drawList()) }, '＋ 허브 추가'),
      h('button', { class: 'sm', onclick: () => (list.splice(0, list.length, { ...s.hubDefault }), drawList()) }, '기본값으로'),
      h(
        'button',
        {
          class: 'primary',
          onclick: safely(async () => {
            await api('PUT', '/api/settings', { hubSources: list.filter((x) => x.url.trim()) });
            toast('허브 설정을 저장했습니다.');
            await redraw();
          }),
        },
        '저장',
      ),
    ),
  );
}

// ---------- 시작 ----------
connect();
route();
