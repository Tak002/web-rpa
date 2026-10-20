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
  const pages = { recipes: recipesPage, record: recordPage, recipe: () => editorPage(parts[1]), run: () => runPage(params), reports: reportsPage, report: () => reportPage(parts[1]), settings: settingsPage };
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
      h('td', null, h('a', { href: `#/recipe/${r.id}` }, h('b', null, r.name)), h('div', { class: 'muted small', style: 'overflow-wrap:anywhere' }, r.startUrl)),
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
              `${Object.values(detail.recipe.blocks).flat().length}스텝`,
              ' · ',
              h('a', { href: `#/recipe/${selected}` }, '편집'),
              detail.problems.length ? h('span', { class: 'badge bad' }, `고칠 점 ${detail.problems.length}개`) : null,
            )
          : null,
        detail?.problems.length ? h('div', { class: 'notice warn' }, h('ul', null, detail.problems.map((p) => h('li', null, p)))) : null,
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
    mount(box, browserCard(s.browser, draw), aiCard(s.openrouter, draw));
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

// ---------- 시작 ----------
connect();
route();
