// 편집기 점검 (실제 브라우저, 숨김): 스텝 트리(전역 번호·들여쓰기·쓰이지 않는 블록), 검색·필터, 여러 개 고르기와 일괄 작업
// (반복으로 묶기·풀기·목록의 항목마다로 묶기·조건부로 만들기·AI 에게), 문장형 조건 편집기, repeat while 편집, 같은 블록 안 이동,
// 변수 이름 바꾸기·사용처·지울 때 확인·비밀 기본값 칸 없음, 입력값 정리 → 저장 → 실제 실행에 엑셀 값이 들어감,
// {{ 자동완성 키보드 선택, 390px 가로 스크롤, 콘솔 오류.
// 실행: node test/editor-check.mjs   (포트 4955–4959, 출력 test/out-editor/ — 끝나면 지운다. KEEP_OUT=1 이면 shots/ 포함 남긴다)

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startLoopSite } from './loop-fixture/server.mjs';
import { startLab, LAB_USER } from './lab-server.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'test', 'out-editor');
const WS = path.join(OUT, 'ws');
const SHOTS = path.join(OUT, 'shots');
const PORT = 4955;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = '98765';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 결과 ----------
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ ok: true, name });
    console.log(`  ✅ ${name}`);
  } catch (e) {
    results.push({ ok: false, name, why: e.message });
    console.log(`  ❌ ${name} — ${String(e.message).split('\n')[0]}`);
  }
}
function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}
/** fn 이 참 값을 돌려줄 때까지 기다린다 (그 값, 시간이 지나면 null) */
async function until(fn, ms = 10000, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(step);
  }
  return null;
}

// ---------- 앱 서버 ----------
let server = null;
let serverLog = '';
async function startServer() {
  server = spawn(process.execPath, ['src/server.js', '--port', String(PORT), '--workspace', WS], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OPENROUTER_BASE_URL: 'http://127.0.0.1:9/api/v1', OPENROUTER_API_KEY: '' },
  });
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
  for (let i = 0; i < 100; i += 1) {
    try {
      await fetch(`${BASE}/api/state`);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error('서버가 뜨지 않았습니다.');
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const p = server;
  p.kill();
  await once(p, 'exit').catch(() => {});
}
async function api(method, url, body, raw) {
  const res = await fetch(BASE + url, { method, headers: body && !raw ? { 'content-type': 'application/json' } : undefined, body: raw ? body : body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data?.error ?? ''}`);
  return data;
}
const getRecipe = async (id) => (await api('GET', `/api/recipes/${id}`)).recipe;
const allSteps = (r) => Object.values(r.blocks).flat();
const byId = (r, id) => allSteps(r).find((s) => s.id === id);

// ---------- 레시피 ----------
const T = (css, meta = {}, extra = {}) => ({ candidates: [{ kind: 'css', value: css, score: 90 }], meta, ...extra });
function recipeA(site) {
  return {
    schemaVersion: 1,
    name: '편집기 점검 A',
    startUrl: `${site}/list.html`,
    entryBlock: 'main',
    loop: { onRowError: 'skip' },
    variables: [
      { id: '상호', name: '상호', source: { kind: 'excel', column: '상호' } },
      { id: '금액', name: '금액', source: { kind: 'static', value: '12000' } },
      { id: '안쓰는값', name: '안쓰는값', source: { kind: 'static', value: 'x' } },
      { id: '비밀번호', name: '비밀번호', source: { kind: 'prompt', secret: true } },
    ],
    blocks: {
      main: [
        { id: 'a1', type: 'navigate', url: `${site}/list.html` },
        { id: 'a2', type: 'input', target: T('#memo', { tag: 'input', label: '메모' }), value: '메모 {{상호}}' },
        { id: 'a3', type: 'forEach', items: T('#result tbody tr', { tag: 'tr', label: '거래처 결과 표의 행', count: 4 }), body: '행마다', maxItems: 100 },
        { id: 'a4', type: 'click', target: T('#next', { tag: 'button', text: '다음' }) },
        { id: 'a5', type: 'sleep', ms: 500 },
        { id: 'a6', type: 'screenshot', fileName: '{{상호}}_{{row}}.png' },
        { id: 'a7', type: 'sleep', ms: 300 },
        { id: 'a8', type: 'navigate', url: '' },
      ],
      행마다: [
        { id: 'b1', type: 'extract', target: T('td:nth-child(3)', { tag: 'td', text: '정상' }, { within: 'item' }), saveAs: '상태' },
        { id: 'b2', type: 'branch', condition: { kind: 'varContains', var: '상태', value: '폐업' }, then: '폐업이면' },
      ],
      폐업이면: [{ id: 'c1', type: 'screenshot', fileName: '{{상호}}_{{item.index}}.png' }],
      남은블록: [{ id: 'd1', type: 'sleep', ms: 100 }],
    },
  };
}
function recipeB(site) {
  return {
    schemaVersion: 1,
    name: '편집기 점검 B',
    startUrl: `${site}/list.html`,
    entryBlock: 'main',
    loop: { onRowError: 'skip' },
    variables: [],
    blocks: {
      main: [
        { id: 's1', type: 'navigate', url: `${site}/list.html` },
        { id: 's2', type: 'input', target: T('#memo', { tag: 'input', label: '메모' }), value: '가나상사' },
        { id: 's3', type: 'extract', target: T('#memo', { tag: 'input', label: '메모' }), saveAs: '메모값' },
        { id: 's4', type: 'navigate', url: `${site}/secret.html` },
        { id: 's5', type: 'input', target: T('#pin', { tag: 'input', label: '접속 번호' }), value: '4321' },
        { id: 's6', type: 'extract', target: T('#echo', { tag: 'span' }), saveAs: '확인' },
      ],
    },
  };
}

// ---------- 고침 1회차 레시피 (사용성 평가 round 1 의 T5·T7·T3 모양) ----------
const C = (value, score) => ({ kind: 'css', value, score });
const X = (value, score) => ({ kind: 'xpath', value, score });
/** 녹화기가 표의 첫 행 금액 칸을 클릭했을 때 남기는 대상 그대로 */
const REC_CELL = () => ({
  framePath: [],
  candidates: [{ kind: 'text', value: { tag: 'td', text: '12,000' }, score: 75 }, X("//tr[*[1][normalize-space()='1']]//td[normalize-space()='12,000']", 68), C('#result > tbody > tr:nth-of-type(1) > td:nth-of-type(4)', 55), X('/html/body/table/tbody/tr[1]/td[4]', 40)],
  meta: { tag: 'td', text: '12,000' },
});
const NEXT_T = () => ({ framePath: [], candidates: [C('#next', 95), { kind: 'text', value: { tag: 'button', text: '다음' }, score: 75 }], meta: { tag: 'button', text: '다음' } });
const ROWS_T = () => ({ framePath: [], candidates: [C('#result > tbody > tr', 90)], meta: { tag: 'tr', label: '거래처 결과 표의 행', count: 4 } });
const IN_ITEM = (n, label) => ({ framePath: [], within: 'item', candidates: [C(`td:nth-child(${n})`, 80), X(`./td[${n}]`, 60)], meta: { tag: 'td', label } });
/** T5: 금액 칸 클릭 → 다음 (녹화 그대로) */
const recipeList = (site) => ({
  schemaVersion: 1,
  name: '고침 C 금액 목록',
  startUrl: `${site}/list.html`,
  entryBlock: 'main',
  loop: { onRowError: 'skip' },
  variables: [],
  blocks: { main: [{ id: 's1', type: 'navigate', url: `${site}/list.html` }, { id: 's2', type: 'click', target: REC_CELL() }, { id: 's3', type: 'click', target: NEXT_T() }] },
});
/** T5 2차: CSS 로 정한 목록 + 몸통이 녹화한 칸을 그대로 읽음 (항목마다 같은 값) */
const recipeSame = (site) => ({
  schemaVersion: 1,
  name: '고침 C2 같은 값',
  startUrl: `${site}/list.html`,
  entryBlock: 'main',
  loop: { onRowError: 'skip' },
  variables: [],
  blocks: {
    main: [{ id: 's1', type: 'navigate', url: `${site}/list.html` }, { id: 's2', type: 'forEach', items: { framePath: [], candidates: [C('#result tbody tr', 60)], meta: { label: '결과 표의 행' } }, body: '항목마다', maxItems: 100 }],
    항목마다: [{ id: 's3', type: 'extract', target: REC_CELL(), saveAs: '금액' }],
  },
});
/** T7: 1쪽 행마다 상호 → "다음" */
const recipePages = (site) => ({
  schemaVersion: 1,
  name: '고침 D 쪽 넘기기',
  startUrl: `${site}/list.html`,
  entryBlock: 'main',
  loop: { onRowError: 'skip' },
  variables: [],
  blocks: {
    main: [{ id: 's1', type: 'navigate', url: `${site}/list.html` }, { id: 's2', type: 'forEach', items: ROWS_T(), body: '행마다', maxItems: 100 }, { id: 's3', type: 'click', target: NEXT_T() }],
    행마다: [{ id: 's4', type: 'extract', target: IN_ITEM(2, '상호'), saveAs: '상호' }],
  },
});
/** T3·T8: 로그인부터 녹화 (실험실) — 엑셀 2행 */
const recipeLogin = (lab) => ({
  schemaVersion: 1,
  name: '고침 L 로그인',
  startUrl: `${lab}/login.html`,
  entryBlock: 'main',
  loop: { onRowError: 'skip' },
  variables: [
    { id: '비밀번호', name: '비밀번호', source: { kind: 'prompt', secret: true } },
    { id: '번호', name: '번호', source: { kind: 'excel', column: '번호' } },
  ],
  blocks: {
    main: [
      { id: 's1', type: 'navigate', url: `${lab}/login.html` },
      { id: 's2', type: 'input', target: { framePath: [], candidates: [C('#uid', 95)], meta: { tag: 'input', label: '아이디' } }, value: LAB_USER.id },
      { id: 's3', type: 'input', target: { framePath: [], candidates: [C('#upw', 95)], meta: { tag: 'input', type: 'password', label: '비밀번호' } }, value: '{{비밀번호}}' },
      { id: 's4', type: 'click', target: { framePath: [], candidates: [C('form button[type=submit]', 90)], meta: { tag: 'button', text: '로그인' } } },
      { id: 's5', type: 'navigate', url: `${lab}/ledger.html?row={{번호}}` },
      { id: 's6', type: 'extract', target: { framePath: [], candidates: [C('h1', 90)], meta: { tag: 'h1', text: '매출 원장 조회' } }, saveAs: '제목' },
    ],
  },
});
/** R1-12: 목록 선택 입력 (보이는 글자 ≠ 값) */
const recipeSelect = (site) => ({
  schemaVersion: 1,
  name: '고침 S 목록 선택',
  startUrl: `${site}/cond.html`,
  entryBlock: 'main',
  loop: { onRowError: 'skip' },
  variables: [],
  blocks: { main: [{ id: 's1', type: 'navigate', url: `${site}/cond.html` }, { id: 's2', type: 'select', target: { framePath: [], candidates: [C('#period', 90)], meta: { tag: 'select', label: '기간' } }, value: 'H1', label: '2026년 1기 (1~6월)' }] },
});

// =====================================================================
async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(SHOTS, { recursive: true });
  const site = await startLoopSite([4956, 4957, 4958, 4959]);
  const lab = await startLab(0); // 고침 1회차: 로그인 레시피 (빈 포트)
  const LAB = `http://127.0.0.1:${lab.address().port}`;
  await startServer();
  let browser = null;
  const errors = [];
  const dialogs = [];
  let dialogMode = 'accept';
  let promptAnswer = null; // 입력 창(prompt)에 넣을 글자 (null 이면 기본값 그대로)
  try {
    const A = (await api('POST', '/api/recipes', recipeA(site.base))).recipe.id;
    const B = (await api('POST', '/api/recipes', recipeB(site.base))).recipe.id;

    browser = await chromium.launch({ channel: 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    const watch = (p) => {
      p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      p.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
      p.on('dialog', (d) => {
        dialogs.push(d.message());
        if (dialogMode === 'dismiss') d.dismiss();
        else if (d.type() === 'prompt' && promptAnswer !== null) d.accept(promptAnswer);
        else d.accept();
      });
    };
    watch(page);
    const head = (id) => page.locator(`.step[data-step="${id}"] > .step-head`);
    const pickBox = (id) => head(id).locator('input[type=checkbox]');
    const body = page.locator('.step-body');
    const bulk = page.locator('.bulk-bar');
    const saveBtn = page.locator('.page-head button.primary');
    const saveNow = async () => {
      await page.getByRole('button', { name: '저장 *' }).click();
      expect(await until(async () => (await saveBtn.innerText()) === '저장'), '저장이 끝나지 않았습니다');
    };
    /** 편집기 열기: 같은 문서 안 주소(#) 이동이어도 그 레시피가 그려질 때까지 기다린다 */
    const openIn = async (p, hash, name) => {
      await p.goto(`${BASE}/${hash}`);
      await p.waitForFunction((n) => document.querySelector('.editor .card.grid2 input')?.value === n && !!document.querySelector('.step-head'), name);
      await sleep(200);
    };
    const open = (hash, name) => openIn(page, hash, name);
    const isOpen = async (id) => (await page.locator(`.step.open[data-step="${id}"]`).count()) === 1;
    const openStep = async (id) => {
      if (!(await isOpen(id))) await head(id).click();
    };
    const closeStep = async (id) => {
      if (await isOpen(id)) await head(id).click();
    };
    const nums = () => page.locator('.step-head .num').allInnerTexts();
    const foundIds = () => page.locator('.steps.found > li.step').evaluateAll((els) => els.map((e) => e.dataset.step));
    const toastHas = (text, kind = '') => until(async () => (await page.locator(`.toast${kind}`).allInnerTexts()).some((t) => t.includes(text)), 5000);
    const selectByText = async (sel, text) => {
      const value = await sel.locator('option').evaluateAll((os, t) => os.find((o) => o.textContent.includes(t))?.value, text);
      expect(value, `"${text}" 고르기 항목이 없습니다`);
      await sel.selectOption(value);
    };
    const tab = (name) => page.locator('.tabs button', { hasText: name }).click();
    const ctxText = () => page.locator('.ai-ctx').evaluate((e) => e.textContent);

    // =================================================================
    console.log('\n[1] 스텝 트리');
    await open(`#/recipe/${A}`, '편집기 점검 A');
    await check('트리: 전역 번호가 트리 순서대로 (#3.1 · #3.2 · #3.2.1 · 끝에 #-)', async () => {
      const n = await nums();
      const want = ['#1', '#2', '#3', '#3.1', '#3.2', '#3.2.1', '#4', '#5', '#6', '#7', '#8', '#-'];
      expect(JSON.stringify(n) === JSON.stringify(want), n.join(' '));
    });
    await check('트리: 반복·분기 몸통은 부모 안에 들여쓰기 (#3 > #3.1 > #3.2.1)', async () => {
      expect((await page.locator('.step[data-step="a3"] .step[data-step="b1"]').count()) === 1, 'b1 이 a3 안에 없습니다');
      expect((await page.locator('.step[data-step="b2"] .step[data-step="c1"]').count()) === 1, 'c1 이 b2 안에 없습니다');
      const [x3, x31, x321] = await Promise.all(['a3', 'b1', 'c1'].map(async (id) => (await head(id).boundingBox()).x));
      expect(x3 < x31 && x31 < x321, `x: ${x3} ${x31} ${x321}`);
      const label = await page.locator('.step[data-step="b2"] .kid-label').first().innerText();
      expect(label.includes('그러면'), label);
    });
    await check('main 블록 스텝은 .step-head 순서 (nth(0..2) = #1 #2 #3)', async () => {
      const t = await Promise.all([0, 1, 2].map((i) => page.locator('.step-head').nth(i).locator('.num').innerText()));
      expect(t.join(',') === '#1,#2,#3', t.join(','));
    });
    await check('쓰이지 않는 블록: 끝에 "남은블록" (#-)', async () => {
      const t = await page.locator('.orphans').innerText();
      expect(t.includes('쓰이지 않는 블록') && t.includes('남은블록 블록'), t);
      expect((await page.locator('.orphans .step[data-step="d1"] .num').innerText()) === '#-', 'd1 번호');
    });
    await check('"항목 안에서 찾기" 배지 (목록 몸통의 within:item 스텝)', async () => {
      expect((await head('b1').innerText()).includes('항목 안에서 찾기'), await head('b1').innerText());
      expect(!(await head('a2').innerText()).includes('항목 안에서 찾기'), 'a2 에 배지');
    });
    await check('고칠 점: 머리 목록은 "#8 스텝", 그 스텝에 "고칠 점" 배지', async () => {
      const t = await page.locator('.notice.warn').first().innerText();
      expect(t.includes('#8 스텝') && !t.includes('main 블록 8번'), t);
      expect((await head('a8').innerText()).includes('고칠 점'), await head('a8').innerText());
    });
    await page.screenshot({ path: path.join(SHOTS, 'tree.png'), fullPage: true });

    // =================================================================
    console.log('\n[2] 검색 · 필터');
    const search = page.locator('.step-search');
    await check('검색 "다음" → #4 하나', async () => {
      await search.fill('다음');
      const ids = await foundIds();
      expect(ids.join(',') === 'a4', ids.join(','));
      expect((await page.locator('.step-found').innerText()).includes('찾은 스텝 1개'), await page.locator('.step-found').innerText());
    });
    await check('번호 검색 "#3" → #3 과 그 안 (#3.1 #3.2 #3.2.1)', async () => {
      await search.fill('#3');
      const ids = await foundIds();
      expect(ids.join(',') === 'a3,b1,b2,c1', ids.join(','));
    });
    await check('번호 검색 "#3.2" → #3.2 · #3.2.1', async () => {
      await search.fill('#3.2');
      const ids = await foundIds();
      expect(ids.join(',') === 'b2,c1', ids.join(','));
    });
    await check('종류 필터 "화면 캡처" → #6 · #3.2.1', async () => {
      await search.fill('');
      await page.locator('select[aria-label="종류로 거르기"]').selectOption('screenshot');
      const ids = await foundIds();
      expect(ids.join(',') === 'c1,a6', ids.join(','));
      await page.locator('select[aria-label="종류로 거르기"]').selectOption('');
    });
    await check('필터 "고칠 점 있음" → #8', async () => {
      await page.locator('select[aria-label="상태로 거르기"]').selectOption('problem');
      const ids = await foundIds();
      expect(ids.join(',') === 'a8', ids.join(','));
    });
    await check('필터 "변수를 쓰는 스텝" → #2 · #3.2 · #3.2.1 · #6', async () => {
      await page.locator('select[aria-label="상태로 거르기"]').selectOption('vars');
      const ids = await foundIds();
      expect(ids.join(',') === 'a2,b2,c1,a6', ids.join(','));
    });
    await check('거르기 지우기 → 트리로 돌아옴', async () => {
      await page.getByRole('button', { name: '거르기 지우기' }).click();
      expect((await page.locator('.steps.found').count()) === 0 && (await nums()).length === 12, '트리가 아닙니다');
    });

    // =================================================================
    console.log('\n[3] 여러 개 고르기 · 반복으로 묶기 · 풀기');
    let repId = null;
    await check('체크로 고르기: 펼쳐지지 않고 일괄 막대 "2개 고름", AI 맥락에 고른 스텝', async () => {
      await pickBox('a5').check();
      await pickBox('a6').check();
      expect((await body.count()) === 0, '체크를 누르자 스텝이 펼쳐졌습니다');
      expect((await bulk.innerText()).includes('2개 고름'), await bulk.innerText());
      const bb = await bulk.boundingBox();
      expect(bb && bb.y >= 0 && bb.y + bb.height <= 900, `일괄 막대가 화면 밖에 있습니다: ${JSON.stringify(bb)}`);
      const c = await ctxText();
      expect(c.includes('고른 스텝 2개'), c);
    });
    await check('반복으로 묶기 → 저장한 JSON 에 repeat + 새 블록(반복) [a5, a6]', async () => {
      await bulk.getByRole('button', { name: '반복으로 묶기' }).click();
      await toastHas('반복으로 묶었습니다');
      repId = await page.locator('.step.open').getAttribute('data-step');
      expect((await page.locator(`.step[data-step="${repId}"] .step[data-step="a5"]`).count()) === 1, '몸통이 부모 아래에 없습니다');
      await saveNow();
      const r = await getRecipe(A);
      const rep = byId(r, repId);
      expect(rep?.type === 'repeat' && rep.body === '반복' && rep.times === 2, JSON.stringify(rep));
      expect(r.blocks['반복']?.map((s) => s.id).join(',') === 'a5,a6', JSON.stringify(r.blocks['반복']));
      expect(!r.blocks.main.some((s) => ['a5', 'a6'].includes(s.id)) && r.blocks.main[4].id === repId, r.blocks.main.map((s) => s.id).join(','));
    });
    await check('풀기 → 안의 스텝이 제자리로, 반복 블록 없어짐', async () => {
      await body.getByRole('button', { name: /^풀기/ }).click();
      await saveNow();
      const r = await getRecipe(A);
      expect(r.blocks.main.map((s) => s.id).join(',') === 'a1,a2,a3,a4,a5,a6,a7,a8', r.blocks.main.map((s) => s.id).join(','));
      expect(!r.blocks['반복'] && !byId(r, repId), Object.keys(r.blocks).join(','));
    });
    await check('이어지지 않은 스텝 묶기 → 쉬운 안내, 레시피 그대로', async () => {
      await pickBox('a1').check();
      await pickBox('a4').check();
      await bulk.getByRole('button', { name: '반복으로 묶기' }).click();
      expect(await toastHas('이어진 스텝만 묶을 수 있습니다', '.error'), '안내가 없습니다');
      expect((await saveBtn.innerText()) === '저장', '레시피가 바뀌었습니다');
      await bulk.getByRole('button', { name: '선택 해제' }).click();
      expect((await bulk.count()) === 0, '일괄 막대가 남았습니다');
    });
    await check('다른 블록의 스텝을 섞어 묶기 → 쉬운 안내', async () => {
      await pickBox('a2').check();
      await pickBox('b1').check();
      await bulk.getByRole('button', { name: '조건부로 만들기' }).click();
      expect(await toastHas('같은 블록 안의 스텝만', '.error'), '안내가 없습니다');
      await bulk.getByRole('button', { name: '선택 해제' }).click();
    });

    // =================================================================
    console.log('\n[4] 목록의 항목마다로 묶기');
    let feId = null;
    await check('목록의 항목마다로 묶기 → 목록 요소·최대 개수·뒤로 가기 → 저장 JSON', async () => {
      await pickBox('a6').check();
      await pickBox('a7').check();
      await bulk.getByRole('button', { name: '목록의 항목마다로 묶기' }).click();
      await toastHas('목록의 항목마다로 묶었습니다');
      feId = await page.locator('.step.open').getAttribute('data-step');
      expect((await body.locator('.foreach-sum').innerText()).includes('아직 목록 요소가 없습니다'), '목록 요약이 없습니다');
      await body.locator('.foreach-css').fill('#result tbody tr');
      await body.locator('label.field', { hasText: '목록 이름' }).locator('input').fill('결과 표의 행');
      await body.locator('label.field', { hasText: '최대 항목 수' }).locator('input').fill('50');
      await body.getByRole('checkbox', { name: /항목마다 끝나면 뒤로 가기/ }).check();
      const desc = await head(feId).innerText();
      expect(desc.includes('목록의 항목마다: 결과 표의 행 (최대 50개, 항목마다 원래 화면으로 돌아옴) → 안의 스텝 2개'), desc); // 고침 2회차 R2-05: 블록 이름 대신 안의 스텝 수
      await saveNow();
      const r = await getRecipe(A);
      const fe = byId(r, feId);
      expect(fe?.type === 'forEach' && fe.items?.candidates?.[0]?.value === '#result tbody tr' && fe.maxItems === 50 && fe.restore === 'back' && fe.body === '항목마다', JSON.stringify(fe));
      expect(r.blocks['항목마다']?.map((s) => s.id).join(',') === 'a6,a7', JSON.stringify(r.blocks['항목마다']));
    });
    await check('목록 요약: 목록 이름·찾는 방법 수·최대 개수 안내', async () => {
      const t = await body.locator('.foreach-sum').innerText();
      expect(t.includes('목록: 결과 표의 행') && t.includes('찾는 방법 1가지') && t.includes('최대 50개'), t); // 고침 1회차: "후보 N개" → "찾는 방법 N가지" (항목 수로 오해, R1-02)
    });

    // =================================================================
    console.log('\n[5] 조건부로 만들기 · 문장형 조건');
    let brId = null;
    const cond = body.locator('.cond');
    await check('조건부로 만들기 → 분기 스텝과 조건 편집기 (처음 조건은 그 스텝의 요소가 있으면)', async () => {
      await pickBox('a4').check();
      await bulk.getByRole('button', { name: '조건부로 만들기' }).click();
      await toastHas('조건부로 만들었습니다');
      brId = await page.locator('.step.open').getAttribute('data-step');
      expect((await cond.count()) === 1, '조건 편집기가 없습니다');
      const p = await cond.locator('.cond-preview').innerText();
      expect(p.includes('"다음" 버튼 있음'), p);
    });
    await check('문장형 조건: 값 {{금액}} ≥ 10000 그리고 "다음" 요소의 글자에 "다음" 포함 (미리보기)', async () => {
      await cond.locator('.cond-subject').selectOption('var:금액');
      await cond.locator('.cond-pred').selectOption('cmp:>=');
      await cond.locator('input.cond-value').fill('10000');
      await cond.getByRole('button', { name: '＋ 그리고' }).click();
      const second = cond.locator('.cond-items > .cond-row').nth(1);
      await selectByText(second.locator('.cond-subject'), '"다음" 버튼');
      await second.locator('.cond-pred').selectOption('textHas');
      await second.locator('input.cond-value').fill('다음');
      const p = await cond.locator('.cond-preview').innerText();
      expect(p.includes('{{금액}} ≥ 10000 그리고 "다음" 요소의 글자에 "다음" 포함'), p);
      expect((await head(brId).innerText()).includes('{{금액}} ≥ 10000 그리고'), await head(brId).innerText());
    });
    await check('조건 더하기·빼기, 그리고 ↔ 또는', async () => {
      await cond.getByRole('button', { name: '＋ 조건 더하기' }).click();
      expect((await cond.locator('.cond-items > .cond-row').count()) === 3, '3번째 조건이 없습니다');
      await cond.locator('.cond-items > .cond-row').nth(2).getByRole('button', { name: '이 조건 빼기' }).click();
      expect((await cond.locator('.cond-items > .cond-row').count()) === 2, '빼지 않았습니다');
      await cond.locator('.cond-join').selectOption('any');
      expect((await cond.locator('.cond-preview').innerText()).includes(' 또는 '), '또는이 아닙니다');
      await cond.locator('.cond-join').selectOption('all');
    });
    await check('아니면 블록 추가 → 저장 JSON: all[varCompare, elementText] · then [a4] · else 블록', async () => {
      await body.getByRole('button', { name: '＋ 아니면 블록 추가' }).click();
      await saveNow();
      const r = await getRecipe(A);
      const br = byId(r, brId);
      const c = br?.condition;
      expect(br?.type === 'branch' && c?.kind === 'all' && c.conditions?.length === 2, JSON.stringify(br));
      const [v, e] = c.conditions;
      expect(v.kind === 'varCompare' && v.var === '금액' && v.op === '>=' && v.value === '10000', JSON.stringify(v));
      expect(e.kind === 'elementText' && e.op === 'contains' && e.value === '다음' && e.target?.candidates?.[0]?.value === '#next', JSON.stringify(e));
      expect(r.blocks[br.then]?.map((s) => s.id).join(',') === 'a4', JSON.stringify(r.blocks[br.then]));
      expect(br.else && Array.isArray(r.blocks[br.else]) && r.blocks[br.else].length === 0, `else=${br.else}`);
      expect((await getRecipe(A)) && !(await api('GET', `/api/recipes/${A}`)).problems.some((p) => p.includes(brId)), '분기에 고칠 점이 있습니다');
    });
    await page.screenshot({ path: path.join(SHOTS, 'branch-condition.png'), fullPage: true });

    // =================================================================
    console.log('\n[6] 스텝 추가 · repeat while 편집');
    let newRep = null;
    await check('스텝 추가에 반복·목록의 항목마다·조건 분기가 있다', async () => {
      const opts = await page.locator('select[aria-label="추가할 스텝 종류"] option').allInnerTexts();
      expect(['반복', '목록의 항목마다', '조건 분기'].every((w) => opts.some((o) => o.startsWith(w))), opts.join(' | '));
    });
    await check('반복 추가 → 조건이 참인 동안 + 요소 있으면 + 최대 20번 (스텝 한 줄 설명)', async () => {
      await page.locator('select[aria-label="추가할 스텝 종류"]').selectOption('repeat');
      await page.getByRole('button', { name: '＋ 추가' }).click();
      newRep = await page.locator('.step.open').getAttribute('data-step');
      expect((await page.locator(`.step[data-step="${newRep}"] .kid-empty`).innerText()).includes('비어 있습니다'), '빈 몸통 안내가 없습니다');
      await body.locator('.repeat-mode').selectOption('while');
      await selectByText(cond.locator('.cond-subject'), '"다음" 버튼');
      expect((await cond.locator('.cond-pred').inputValue()) === 'exists', await cond.locator('.cond-pred').inputValue());
      await body.locator('label.field', { hasText: '최대 반복 횟수' }).locator('input').fill('20');
      const desc = await head(newRep).innerText();
      expect(desc.includes('반복: "다음" 버튼이 있는 동안 (최대 20번) → 안의 스텝 없음'), desc); // 고침 2회차 R2-05: 블록 이름 대신 안의 스텝 수 (아직 빈 몸통)
    });
    await check('빈 몸통 "＋ 여기에 스텝 추가" → 그 블록 안에 들어감', async () => {
      await page.locator(`.step[data-step="${newRep}"] .kid-empty`).getByRole('button', { name: '＋ 여기에 스텝 추가' }).click();
      expect((await page.locator('.add-bar').innerText()).includes('"반복" 블록 안(끝)에 들어갑니다'), await page.locator('.add-bar').innerText());
      await page.locator('select[aria-label="추가할 스텝 종류"]').selectOption('sleep');
      await page.getByRole('button', { name: '＋ 추가' }).click();
      const sleepId = await page.locator('.step.open').getAttribute('data-step');
      expect((await page.locator(`.step[data-step="${newRep}"] .step[data-step="${sleepId}"]`).count()) === 1, '몸통 안에 없습니다');
    });
    await check('저장 JSON: repeat while{exists #next} · maxIterations 20 · times 없음 · 몸통에 sleep', async () => {
      await saveNow();
      const r = await getRecipe(A);
      const rep = byId(r, newRep);
      expect(rep?.while?.kind === 'exists' && rep.while.target?.candidates?.[0]?.value === '#next' && rep.maxIterations === 20 && rep.times === undefined && !rep.until, JSON.stringify(rep));
      expect(r.blocks[rep.body]?.length === 1 && r.blocks[rep.body][0].type === 'sleep', JSON.stringify(r.blocks[rep.body]));
      expect(r.blocks.main.findIndex((s) => s.id === newRep) === r.blocks.main.findIndex((s) => s.id === brId) + 1, '펼친 스텝 뒤가 아닙니다');
    });
    await check('반복 방법을 "참이 될 때까지" 로 → until 로 옮겨짐', async () => {
      await openStep(newRep);
      await body.locator('.repeat-mode').selectOption('until');
      await saveNow();
      const rep = byId(await getRecipe(A), newRep);
      expect(rep?.until?.kind === 'exists' && !rep.while && rep.maxIterations === 20, JSON.stringify(rep));
    });

    // =================================================================
    console.log('\n[7] 같은 블록 안 이동');
    await check('몸통 스텝 ↓ 아래로 → 그 블록 안에서만 바뀜 (#3.1 ↔ #3.2)', async () => {
      await openStep('b1');
      await body.getByRole('button', { name: '↓ 아래로' }).click();
      await saveNow();
      const r = await getRecipe(A);
      expect(r.blocks['행마다'].map((s) => s.id).join(',') === 'b2,b1', r.blocks['행마다'].map((s) => s.id).join(','));
      expect(await body.getByRole('button', { name: '↓ 아래로' }).isDisabled(), '마지막인데 ↓ 가 켜져 있습니다');
    });
    await check('main .step-head nth(2) → ↑ 위로 → main 2번째가 됨', async () => {
      await page.locator('.step-head').nth(2).click();
      await page.getByRole('button', { name: '↑ 위로' }).click();
      await saveNow();
      const r = await getRecipe(A);
      expect(r.blocks.main[1].id === 'a3', r.blocks.main.map((s) => s.id).join(','));
    });

    // =================================================================
    console.log('\n[8] 변수');
    const item = (name) => page.locator(`.var-item[data-var="${name}"]`);
    await check('변수 탭: 사용처 (#.. 입력 · 파일 이름 · 조건), 안 쓰는 변수 표시', async () => {
      await tab('변수·엑셀');
      const uses = await item('상호').locator('.use-chip').allInnerTexts();
      expect(uses.some((u) => /^#\d+ 입력$/.test(u)) && uses.filter((u) => u.endsWith('파일 이름')).length === 2, uses.join(' | '));
      const money = await item('금액').locator('.use-chip').allInnerTexts();
      expect(money.some((u) => u.endsWith('조건')), money.join(' | '));
      expect((await item('안쓰는값').innerText()).includes('안 쓰는 변수'), await item('안쓰는값').innerText());
      expect(!(await item('상호').innerText()).includes('안 쓰는 변수'), '쓰는 변수에 표시');
    });
    await check('비밀 변수: 기본값 칸 없음 · 실행 화면 저장 안내', async () => {
      const it = item('비밀번호');
      expect((await it.locator('input').count()) === 1, `입력 칸 ${await it.locator('input').count()}개`);
      expect((await it.locator('select[aria-label="변수 종류"]').inputValue()) === 'secret', '종류가 비밀이 아닙니다');
      expect((await it.innerText()).includes('비밀값은 실행 화면에서 이 PC 에 저장할 수 있습니다'), await it.innerText());
    });
    await check('이름 바꾸기 → 모든 참조가 바뀜 (엑셀 열 이름은 그대로)', async () => {
      await item('상호').locator('input.var-name').fill('거래처명');
      await item('상호').locator('input.var-name').press('Enter');
      expect(await toastHas('쓰는 곳 3군데도 함께 바꿨습니다'), '안내가 없습니다');
      await item('거래처명').waitFor();
      await saveNow();
      const r = await getRecipe(A);
      const v = r.variables.find((x) => x.id === '거래처명');
      expect(v?.name === '거래처명' && v.source.column === '상호', JSON.stringify(v));
      expect(byId(r, 'a2').value === '메모 {{거래처명}}' && byId(r, 'a6').fileName === '{{거래처명}}_{{row}}.png' && byId(r, 'c1').fileName === '{{거래처명}}_{{item.index}}.png', JSON.stringify([byId(r, 'a2').value, byId(r, 'a6').fileName, byId(r, 'c1').fileName]));
      expect(!JSON.stringify(r.blocks).includes('{{상호}}'), '옛 이름이 남았습니다');
    });
    await check('이름 충돌 → 안내, 이름 그대로', async () => {
      await item('거래처명').locator('input.var-name').fill('금액');
      await item('거래처명').locator('input.var-name').press('Enter');
      expect(await toastHas('이미', '.error'), '안내가 없습니다');
      expect((await item('거래처명').locator('input.var-name').inputValue()) === '거래처명', '이름이 바뀌었습니다');
      expect((await saveBtn.innerText()) === '저장', '레시피가 바뀌었습니다');
    });
    await check('사용처를 누르면 그 스텝으로 (스텝 탭, 펼침)', async () => {
      await item('거래처명').locator('.use-chip', { hasText: '입력' }).click();
      expect((await page.locator('.tabs button.active').innerText()).startsWith('스텝'), '스텝 탭이 아닙니다');
      expect((await page.locator('.step.open').getAttribute('data-step')) === 'a2', '그 스텝이 펼쳐지지 않았습니다');
      expect((await body.locator('input[type=text]').first().inputValue()) === '메모 {{거래처명}}', '입력값이 다릅니다');
    });
    await check('쓰는 변수를 지울 때 확인창 (사용처 목록) → 취소하면 그대로', async () => {
      await tab('변수·엑셀');
      dialogMode = 'dismiss';
      const n = dialogs.length;
      await item('거래처명').getByRole('button', { name: '삭제' }).click();
      dialogMode = 'accept';
      expect(dialogs.length === n + 1 && /#\d+ 입력/.test(dialogs.at(-1)) && dialogs.at(-1).includes('그래도 지울까요'), dialogs.at(-1) ?? '확인창 없음');
      expect((await item('거래처명').count()) === 1, '지워졌습니다');
    });
    await check('안 쓰는 변수는 확인창 없이 지움', async () => {
      const n = dialogs.length;
      await item('안쓰는값').getByRole('button', { name: '삭제' }).click();
      expect(dialogs.length === n && (await item('안쓰는값').count()) === 0, `확인창 ${dialogs.length - n}번 · 남음 ${await item('안쓰는값').count()}`);
    });
    await check('새 변수: 이름부터 묻고(겹치면 안내) 엑셀 열로 만듦 → 저장', async () => {
      await page.getByRole('button', { name: '＋ 변수 추가' }).click();
      const nameIn = page.locator('input[aria-label="새 변수 이름"]');
      await nameIn.fill('금액');
      await nameIn.press('Enter');
      expect((await page.locator('.var-new').innerText()).includes('이미 있습니다'), await page.locator('.var-new').innerText());
      await nameIn.fill('기간');
      await page.locator('.var-new').getByRole('button', { name: '만들기' }).click();
      await item('기간').waitFor();
      expect((await item('기간').locator('select[aria-label="변수 종류"]').inputValue()) === 'excel', '엑셀 열이 아닙니다');
      await saveNow();
      const v = (await getRecipe(A)).variables.find((x) => x.id === '기간');
      expect(v?.name === '기간' && v.source.kind === 'excel' && v.source.column === '기간', JSON.stringify(v));
    });
    await page.screenshot({ path: path.join(SHOTS, 'vars.png'), fullPage: true });

    // =================================================================
    console.log('\n[9] {{ 자동완성');
    const valueIn = body.locator('input[type=text]').first();
    await check('{{ → 목록: 변수·값 읽기·내장 토큰 (반복 밖이면 item 없음)', async () => {
      await tab('스텝');
      await openStep('a2');
      await valueIn.fill('');
      await valueIn.pressSequentially('{{');
      await body.locator('.auto-list').waitFor();
      const items = await body.locator('.auto-item code').allInnerTexts();
      for (const w of ['{{거래처명}}', '{{금액}}', '{{상태}}', '{{row}}', '{{sys:date:YYYYMMDD}}', '{{sys:month:-1}}', '{{sys:quarter}}']) expect(items.includes(w), `${w} 없음: ${items.join(' ')}`);
      expect(!items.some((t) => t.startsWith('{{item.')), 'item 토큰이 있습니다');
    });
    await check('키보드: ↓ 로 둘째 항목 → Enter 로 넣기', async () => {
      await valueIn.press('ArrowDown');
      const active = await body.locator('.auto-item.active code').innerText();
      const second = await body.locator('.auto-item code').nth(1).innerText();
      expect(active === second, `${active} ≠ ${second}`);
      await valueIn.press('Enter');
      expect((await valueIn.inputValue()) === second, await valueIn.inputValue());
      expect((await body.locator('.auto-list').count()) === 0, '목록이 남았습니다');
    });
    await check('글자로 좁히기 "{{거래" → Enter → {{거래처명}}, ↑ 로 마지막 항목, Esc 로 닫기', async () => {
      await valueIn.fill('');
      await valueIn.pressSequentially('메모 {{거래');
      await body.locator('.auto-list').waitFor();
      expect((await body.locator('.auto-item.active code').innerText()) === '{{거래처명}}', await body.locator('.auto-item.active code').innerText());
      await valueIn.press('Enter');
      expect((await valueIn.inputValue()) === '메모 {{거래처명}}', await valueIn.inputValue());
      await valueIn.pressSequentially(' {{');
      await valueIn.press('ArrowUp');
      const last = await body.locator('.auto-item code').last().innerText();
      expect((await body.locator('.auto-item.active code').innerText()) === last, '↑ 가 마지막으로 가지 않았습니다');
      await valueIn.press('Escape');
      expect((await body.locator('.auto-list').count()) === 0, 'Esc 로 닫히지 않았습니다');
      await valueIn.fill('메모 {{거래처명}}');
    });
    await check('목록의 항목마다 안 스텝: item.text · item.index · item.cell:1 · loop.index', async () => {
      await openStep('c1');
      const f = body.locator('input[type=text]').first();
      await f.click();
      await f.press('End');
      await f.pressSequentially('{{item');
      await body.locator('.auto-list').waitFor();
      const items = await body.locator('.auto-item code').allInnerTexts();
      for (const w of ['{{item.text}}', '{{item.index}}', '{{item.cell:1}}']) expect(items.includes(w), `${w} 없음: ${items.join(' ')}`);
      await f.press('Escape');
      await f.fill('{{거래처명}}_{{item.index}}.png');
      await f.pressSequentially('{{loop');
      expect((await body.locator('.auto-item code').allInnerTexts()).includes('{{loop.index}}'), 'loop.index 없음');
      await f.press('Escape');
      await f.fill('{{거래처명}}_{{item.index}}.png');
    });
    await page.screenshot({ path: path.join(SHOTS, 'autocomplete.png') });

    // =================================================================
    console.log('\n[10] 일괄 ✦ AI 에게');
    await check('일괄 ✦ AI 에게 → 패널에 "#1, #2 스텝을" 초안 · 맥락 고른 스텝 2개', async () => {
      await closeStep('c1');
      await pickBox('a1').check();
      await pickBox('a3').check(); // 앞에서 위로 옮겨 #2
      await bulk.getByRole('button', { name: '✦ AI 에게' }).click();
      await page.locator('.ai-panel').waitFor({ state: 'visible' });
      const v = await page.locator('.ai-input textarea').inputValue();
      expect(v.startsWith('#1, #2 스텝을'), v);
      const c = await page.locator('.ai-ctx').innerText();
      expect(c.includes('고른 스텝 2개'), c);
      await page.locator('.ai-head button[title="닫기"]').click();
    });
    await check('선택 해제 → 맥락에서 고른 스텝이 빠짐', async () => {
      await bulk.getByRole('button', { name: '선택 해제' }).click();
      // [✦ AI 에게] 로 넣은 맥락은 ✕ 로 빼기 전까지 남는다 — 화면 맥락(체크)만 본다
      await page.locator('.ai-top').click();
      const pinX = page.locator('.ai-ctx button[title^="[✦ AI 에게]"]');
      if (await pinX.count()) await pinX.click();
      const c = await ctxText();
      expect(!c.includes('고른 스텝'), c);
      await page.locator('.ai-head button[title="닫기"]').click();
    });

    // =================================================================
    console.log('\n[11] 모든 조건 종류 · 일괄 끄기/켜기/삭제 · 목록 요소 고르기');
    await check('대기 스텝의 문장형 조건: 무엇이 × 어떠하면 으로 조건 14종을 모두 만든다 (미리보기 문장)', async () => {
      await page.locator('select[aria-label="추가할 스텝 종류"]').selectOption('waitText');
      await page.getByRole('button', { name: '＋ 추가' }).click();
      const plan = [
        ['page', 'seen', '글자 보임'],
        ['page', 'unseen', '글자 안 보임'], // 고침 2회차 R2-03: 아님(…) 대신 자연스러운 부정
        ['url', 'has', '주소에'],
        ['url', 'hasNot', '주소에 (값을 정하세요) 없음'],
        ['dialog', 'has', '알림창 문구에'],
        ['el', 'exists', '"다음" 버튼 있음'],
        ['el', 'missing', '"다음" 버튼 없음'],
        ['el', 'visible', '"다음" 버튼 보임'],
        ['el', 'textHas', '요소의 글자에'],
        ['el', 'textEq', '요소의 글자가 "'],
        ['el', 'textRe', '요소의 글자가 정규식'],
        ['el', 'count', '요소가 1개 이상'],
        ['var', 'eq', '{{금액}} 값이'],
        ['var', 'has', '{{금액}} 에 "'],
        ['var', 'hasNot', '{{금액}} 에 "1" 없음'], // 고침 2회차 R2-03: 아님(…) 대신 "…없음" (값 1 은 앞 개수 조건에서 이어 받음)
        ['var', 'cmp:<=', '{{금액}} ≤'],
        ['var', 'empty', '{{금액}} 가 비어 있음'],
        ['var', 'filled', '{{금액}} 가 비어 있지 않음'],
        ['var', 're', '{{금액}} 가 정규식'],
      ];
      const bad = [];
      for (const [sub, pred, want] of plan) {
        const subj = cond.locator('.cond-subject');
        if (sub === 'el') await selectByText(subj, '"다음" 버튼');
        else if (sub === 'var') await subj.selectOption('var:금액');
        else await subj.selectOption(sub);
        await cond.locator('.cond-pred').selectOption(pred);
        const p = await cond.locator('.cond-preview').innerText();
        if (!p.includes(want)) bad.push(`${sub}/${pred}: ${p}`);
      }
      expect(!bad.length, bad.join(' | '));
    });
    await check('그 대기 스텝 지우기 (안에 스텝이 없으면 확인창 없이)', async () => {
      const id = await page.locator('.step.open').getAttribute('data-step');
      const n = dialogs.length;
      await body.getByRole('button', { name: '삭제', exact: true }).click();
      expect((await page.locator(`.step[data-step="${id}"]`).count()) === 0 && dialogs.length === n, '지워지지 않았거나 확인창이 떴습니다');
    });
    await check('일괄 끄기 → 꺼짐 표시·저장 JSON disabled, 켜기 → 되돌림', async () => {
      await pickBox('a8').check();
      await pickBox('a1').check();
      await bulk.getByRole('button', { name: '끄기' }).click();
      expect((await head('a8').innerText()).includes('꺼짐') && (await head('a1').innerText()).includes('꺼짐'), '꺼짐 표시가 없습니다');
      await saveNow();
      let r = await getRecipe(A);
      expect(byId(r, 'a8').disabled === true && byId(r, 'a1').disabled === true, 'disabled 가 아닙니다');
      await bulk.getByRole('button', { name: '켜기' }).click();
      await saveNow();
      r = await getRecipe(A);
      expect(!byId(r, 'a8').disabled && !byId(r, 'a1').disabled, '켜지지 않았습니다');
      await bulk.getByRole('button', { name: '선택 해제' }).click();
    });
    await check('일괄 삭제: 목록의 항목마다 스텝 → "안의 스텝 2개" 확인 → 몸통 블록까지 지움', async () => {
      await pickBox(feId).check();
      const n = dialogs.length;
      await bulk.getByRole('button', { name: '삭제' }).click();
      expect(dialogs.length === n + 1 && dialogs.at(-1).includes('그 안의 스텝 2개'), dialogs.at(-1) ?? '확인창 없음');
      await saveNow();
      const r = await getRecipe(A);
      expect(!byId(r, feId) && !byId(r, 'a6') && !byId(r, 'a7') && !r.blocks['항목마다'], Object.keys(r.blocks).join(','));
    });
    await check('목록의 항목마다: 기존 스텝 요소에서 목록 고르기 → 요약이 바뀜', async () => {
      await openStep('a3');
      await selectByText(body.locator('select[aria-label="기존 스텝 요소에서 고르기"]'), '"메모"');
      const t = await body.locator('.foreach-sum').innerText();
      expect(t.includes('목록: 메모'), t);
      await saveNow();
      expect(byId(await getRecipe(A), 'a3').items?.candidates?.[0]?.value === '#memo', '목록 요소가 바뀌지 않았습니다');
      await closeStep('a3');
    });

    // =================================================================
    console.log('\n[12] JSON 탭');
    await check('JSON 탭 안내에 "분기는 여기서만" 뜻이 없다', async () => {
      await tab('JSON');
      const t = await page.locator('.card.stack p').first().innerText();
      expect(!t.includes('고급 편집은 여기서') && t.includes('스텝 탭에서도'), t);
      await tab('스텝');
    });

    // =================================================================
    console.log('\n[13] 입력값 정리 → 저장 → 실제 실행');
    const tidy = page.locator('.modal.tidy');
    const trow = (id) => tidy.locator(`.tidy-row[data-step="${id}"]`);
    await check('스텝 탭 머리 [입력값 정리] → 표 (번호·칸 이름·녹화 때 값·지금 값·그대로)', async () => {
      await open(`#/recipe/${B}`, '편집기 점검 B');
      await page.locator('.step-tools').getByRole('button', { name: '입력값 정리' }).click();
      await tidy.waitFor();
      expect((await tidy.locator('.tidy-row').count()) === 2, `행 ${await tidy.locator('.tidy-row').count()}개`);
      const t2 = await trow('s2').innerText();
      expect(t2.includes('#2') && t2.includes('메모') && t2.includes('녹화 때 값') && t2.includes('가나상사'), t2);
      expect(await trow('s2').getByRole('radio', { name: '그대로' }).isChecked(), '그대로가 아닙니다');
    });
    await check('엑셀 열(이름 상호)·비밀(이름 접속번호) 고르기 — 비밀은 녹화값 ●●●●', async () => {
      await trow('s2').getByRole('radio', { name: '엑셀 열' }).check();
      expect((await trow('s2').locator('input.tidy-name').inputValue()) === '메모', await trow('s2').locator('input.tidy-name').inputValue());
      await trow('s2').locator('input.tidy-name').fill('상호');
      await trow('s5').getByRole('radio', { name: '비밀' }).check();
      await trow('s5').locator('input.tidy-name').fill('접속번호');
      expect((await trow('s5').locator('.tidy-rec').innerText()) === '●●●●', await trow('s5').locator('.tidy-rec').innerText());
      expect(!(await tidy.innerText()).includes('4321'), '비밀 녹화값이 보입니다');
    });
    await page.screenshot({ path: path.join(SHOTS, 'input-tidy.png') });
    await check('모두 적용 → 저장 JSON: {{상호}} 엑셀 변수 · {{접속번호}} 비밀 변수(기본값·녹화값 없음)', async () => {
      await tidy.getByRole('button', { name: '모두 적용' }).click();
      expect((await tidy.count()) === 0, '창이 닫히지 않았습니다');
      await saveNow();
      const r = await getRecipe(B);
      expect(byId(r, 's2').value === '{{상호}}' && byId(r, 's2').meta?.recordedValue === '가나상사', JSON.stringify(byId(r, 's2')));
      expect(byId(r, 's5').value === '{{접속번호}}' && byId(r, 's5').meta?.recordedValue === undefined, JSON.stringify(byId(r, 's5')));
      const ex = r.variables.find((v) => v.id === '상호');
      const se = r.variables.find((v) => v.id === '접속번호');
      expect(ex?.source.kind === 'excel' && ex.source.column === '상호', JSON.stringify(ex));
      expect(se?.source.kind === 'prompt' && se.source.secret === true && se.source.default === undefined, JSON.stringify(se));
      expect(!JSON.stringify(r).includes('4321'), '녹화 비밀값이 남았습니다');
    });
    await check('변수 탭의 [입력값 정리] 로 다시 열면 엑셀 열·비밀이 골라져 있다', async () => {
      await tab('변수·엑셀');
      await page.locator('main').getByRole('button', { name: '입력값 정리' }).click();
      await tidy.waitFor();
      expect(await trow('s2').getByRole('radio', { name: '엑셀 열' }).isChecked(), '엑셀 열이 아닙니다');
      expect(await trow('s5').getByRole('radio', { name: '비밀' }).isChecked(), '비밀이 아닙니다');
      expect((await trow('s5').locator('.tidy-rec').innerText()) === '●●●●', '비밀 녹화값이 보입니다');
      await tidy.getByRole('button', { name: '닫기' }).click();
    });
    await check('실제 실행: 엑셀 값이 입력에 들어가고 비밀값으로 입력됨 (2행)', async () => {
      const up = await api('POST', `/api/uploads?name=${encodeURIComponent('거래처.csv')}`, Buffer.from('상호\n다라상사\n마바상사\n', 'utf8'), true);
      const { runId } = await api('POST', '/api/runs', { recipeId: B, uploadId: up.id, params: { 접속번호: SECRET }, options: { headless: true } });
      const st = await until(async () => {
        const s = await api('GET', '/api/state');
        return s.run?.runId === runId && ['done', 'failed', 'stopped'].includes(s.run.status) ? s.run : null;
      }, 120000, 500);
      expect(st, '실행이 끝나지 않았습니다');
      const rep = await api('GET', `/api/runs/${runId}`);
      const vals = rep.rows.map((x) => `${x.status}:${x.values?.['메모값']}:${x.values?.['확인']}`);
      expect(vals.join(' | ') === `ok:다라상사:입력됨 (${SECRET.length}자) | ok:마바상사:입력됨 (${SECRET.length}자)`, vals.join(' | '));
    });
    await check('비밀값이 레시피 파일에 없다', async () => {
      const dir = path.join(WS, 'recipes');
      const files = await fs.readdir(dir).catch(() => []);
      let hit = '';
      for (const f of files) if ((await fs.readFile(path.join(dir, f), 'utf8')).includes(SECRET)) hit = f;
      expect(files.length && !hit, hit ? `${hit} 에 비밀값` : '레시피 파일이 없습니다');
    });

    // =================================================================
    console.log('\n[15] 고침 1회차: 화면만으로 목록·쪽 넘기기·로그인 분기 (사용성 평가 R1-02·03·04·05·10·11·12·16·17)');
    const runNow = async (recipeId, body = {}) => {
      const { runId } = await api('POST', '/api/runs', { recipeId, options: { headless: true }, ...body });
      const st = await until(async () => {
        const s = await api('GET', '/api/state');
        return s.run?.runId === runId && ['done', 'failed', 'stopped'].includes(s.run.status) ? s.run : null;
      }, 120000, 500);
      expect(st, '실행이 끝나지 않았습니다');
      return api('GET', `/api/runs/${runId}`);
    };
    const lines = (v) => String(v ?? '').split('\n').filter(Boolean);
    const LC = (await api('POST', '/api/recipes', recipeList(site.base))).recipe.id;
    const LC2 = (await api('POST', '/api/recipes', recipeSame(site.base))).recipe.id;
    const LD = (await api('POST', '/api/recipes', recipePages(site.base))).recipe.id;
    const LL = (await api('POST', '/api/recipes', recipeLogin(LAB))).recipe.id;
    const LS = (await api('POST', '/api/recipes', recipeSelect(site.base))).recipe.id;
    let feC = null;
    await check('R1-02 값 읽기 추가 → 목록의 항목마다로 묶기: 그 칸이 있는 표의 행 전체가 목록, 몸통 값 읽기는 "항목 안에서 찾기"', async () => {
      await open(`#/recipe/${LC}`, '고침 C 금액 목록');
      await openStep('s2');
      promptAnswer = '금액';
      await body.getByRole('button', { name: '이 요소의 글자 읽기 추가' }).click();
      promptAnswer = null;
      const exId = await page.locator('.step.open').getAttribute('data-step');
      await pickBox(exId).check();
      await bulk.getByRole('button', { name: '목록의 항목마다로 묶기' }).click();
      expect(await toastHas('전체를 목록으로 정했습니다'), '자동 목록 안내가 없습니다');
      feC = await page.locator('.step.open').getAttribute('data-step');
      const sum = await body.locator('.foreach-sum').innerText();
      expect(sum.includes('목록: 표의 행') && sum.includes('찾는 방법 2가지') && !sum.includes('요소 하나만'), sum);
      expect((await head(exId).innerText()).includes('항목 안에서 찾기'), await head(exId).innerText());
      await saveNow();
      const r = await getRecipe(LC);
      const fe = byId(r, feC);
      const ex = byId(r, exId);
      expect(fe.items.candidates.some((c) => c.value === '#result > tbody > tr:has(> td)'), JSON.stringify(fe.items));
      expect(ex.target.within === 'item' && ex.target.candidates.some((c) => c.value === ':scope > td:nth-of-type(4)') && ex.saveAs === '금액', JSON.stringify(ex.target));
      expect(!(await api('GET', `/api/recipes/${LC}`)).problems.length, '고칠 점이 있습니다');
    });
    await check('R1-04 트리 문장: 항목 안 값 읽기는 견본 글자 "12,000" 대신 이름 ("금액" 표 칸 · 항목 안)', async () => {
      const exId = (await getRecipe(LC)).blocks[byId(await getRecipe(LC), feC).body][0].id;
      const t = await head(exId).innerText();
      expect(t.includes('"금액"의 글자 읽어 {{금액}}에 저장') && !t.includes('12,000'), t);
      await openStep(exId);
      expect((await body.locator('.cands summary').innerText()).includes('"금액" 표 칸 · 항목 안'), await body.locator('.cands summary').innerText());
    });
    await check('R1-02 목록 요소 고르기: 표 칸은 "이 칸이 있는 표의 행 전체" 가 먼저, 요소 그대로는 "요소 1개" · 고르면 요약이 분명히 알린다', async () => {
      await openStep(feC);
      const opts = await body.locator('select[aria-label="기존 스텝 요소에서 고르기"] option').allInnerTexts();
      const iRow = opts.findIndex((o) => o.includes('12,000') && o.includes('표의 행 전체'));
      const iOne = opts.findIndex((o) => o.includes('12,000') && o.includes('요소 1개'));
      expect(iRow > 0 && iOne > iRow, opts.join(' | '));
      await selectByText(body.locator('select[aria-label="기존 스텝 요소에서 고르기"]'), '요소 1개');
      expect((await body.locator('.foreach-sum').innerText()).includes('요소 하나만 가리킵니다'), await body.locator('.foreach-sum').innerText());
      await selectByText(body.locator('select[aria-label="기존 스텝 요소에서 고르기"]'), '표의 행 전체');
      expect(!(await body.locator('.foreach-sum').innerText()).includes('요소 하나만'), '요약이 바뀌지 않았습니다');
      await saveNow();
    });
    await check('R1-02 실제 실행: 1쪽 4행 금액이 행마다 다르게 (12,000 · 8,500 · 1,500,000 · 300)', async () => {
      const rep = await runNow(LC);
      expect(rep.status === 'done' && lines(rep.rows[0].values?.금액).join(',') === '12,000,8,500,1,500,000,300', JSON.stringify(rep.rows[0].values ?? rep.rows[0].error));
    });
    await check('R1-11 반복 안에 넣는 화면 캡처 이름에 {{item.index}}, 요소 없는 스텝을 조건부로 만들면 빈 조건 + "조건을 정해 주세요"', async () => {
      await openStep(feC);
      await body.getByRole('button', { name: '＋ 안에 스텝 추가' }).click();
      await page.locator('select[aria-label="추가할 스텝 종류"]').selectOption('screenshot');
      await page.getByRole('button', { name: '＋ 추가' }).click();
      const capId = await page.locator('.step.open').getAttribute('data-step');
      expect((await head(capId).innerText()).includes('화면_{{row}}_{{item.index}}.png'), await head(capId).innerText());
      await pickBox(capId).check();
      await bulk.getByRole('button', { name: '조건부로 만들기' }).click();
      expect(await toastHas('어떤 때 실행할지 조건을 정해'), '안내가 없습니다');
      expect((await body.innerText()).includes('조건을 정해 주세요'), '조건 안내가 없습니다');
      expect((await body.locator('.cond-subject').first().inputValue()) === 'page', await body.locator('.cond-subject').first().inputValue());
    });
    await check('R1-16 알림은 한 번에 하나, 화면 위쪽 (일괄 끄기 → 켜기를 잇달아)', async () => {
      await open(`#/recipe/${LC}`, '고침 C 금액 목록');
      await pickBox('s1').check();
      await pickBox('s3').check();
      await bulk.getByRole('button', { name: '끄기' }).click();
      await bulk.getByRole('button', { name: '켜기' }).click();
      await sleep(150);
      const n = await page.locator('#toasts .toast').count();
      const bb = await page.locator('#toasts .toast').first().boundingBox();
      expect(n === 1 && (await page.locator('#toasts .toast').innerText()).includes('켰습니다'), `알림 ${n}개`);
      expect(bb && bb.y < 160, `알림 위치 ${JSON.stringify(bb)}`);
      // 고침 2회차 R2-02: 머리 단추(✦ AI 도우미·내보내기·저장) 아래에 뜨고, 글자만 있는 알림은 눌러도 아래로 지나간다
      const headBottom = (await page.locator('.editor .page-head').boundingBox())?.y + (await page.locator('.editor .page-head').boundingBox())?.height;
      const pe = await page.locator('#toasts .toast').first().evaluate((e) => getComputedStyle(e).pointerEvents);
      expect(bb.y >= headBottom - 1 && pe === 'none', `머리 아래 ${headBottom} · 알림 ${bb.y} · pointer-events ${pe}`);
      await bulk.getByRole('button', { name: '선택 해제' }).click();
    });
    await check('R1-02 CSS 로 정한 목록 + 녹화 칸 그대로: 고칠 점·배지·실행 막힘 → [항목 안에서 찾기로 바꾸기] → 4행 다른 값', async () => {
      const before = await api('GET', `/api/recipes/${LC2}`);
      expect(before.problems.some((p) => p.includes('(s3)') && p.includes('항목마다 같은 요소')), before.problems.join(' / '));
      const blocked = await fetch(`${BASE}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recipeId: LC2, options: { headless: true } }) });
      expect(blocked.status === 400, `실행이 막히지 않았습니다 (${blocked.status})`);
      await open(`#/recipe/${LC2}`, '고침 C2 같은 값');
      expect((await head('s3').innerText()).includes('항목마다 같은 요소'), await head('s3').innerText());
      await openStep('s3');
      expect((await body.locator('.same-el').innerText()).includes('같은 값이 되풀이됩니다'), await body.locator('.same-el').innerText());
      await body.getByRole('button', { name: '항목 안에서 찾기로 바꾸기' }).click();
      expect(!(await head('s3').innerText()).includes('항목마다 같은 요소') && (await head('s3').innerText()).includes('항목 안에서 찾기'), await head('s3').innerText());
      await saveNow();
      expect(!(await api('GET', `/api/recipes/${LC2}`)).problems.length, '고칠 점이 남았습니다');
      const rep = await runNow(LC2);
      expect(rep.status === 'done' && lines(rep.rows[0].values?.금액).join(',') === '12,000,8,500,1,500,000,300', JSON.stringify(rep.rows[0].values ?? rep.rows[0].error));
    });
    await check('R1-02 빈 목록 안내의 첫 단추는 [AI 에게 목록 찾기 맡기기] (단추 하나)', async () => {
      await open(`#/recipe/${LC2}`, '고침 C2 같은 값');
      await pickBox('s1').check();
      await bulk.getByRole('button', { name: '목록의 항목마다로 묶기' }).click();
      const btns = body.getByRole('button', { name: 'AI 에게 목록 찾기 맡기기' });
      expect((await btns.count()) === 1 && (await body.locator('.foreach-sum button.primary').innerText()) === 'AI 에게 목록 찾기 맡기기', `단추 ${await btns.count()}개`);
    });
    let repD = null;
    await check('R1-03 반복으로 묶기 → 반복 방법 "다음 쪽이 없을 때까지 (쪽 넘기기)" → 첫 쪽 처리 · 2번째부터 "다음" 누르기 구조', async () => {
      await open(`#/recipe/${LD}`, '고침 D 쪽 넘기기');
      await pickBox('s2').check();
      await pickBox('s3').check();
      await bulk.getByRole('button', { name: '반복으로 묶기' }).click();
      expect(await toastHas('쪽 넘기기'), '쪽 넘기기 안내가 없습니다');
      repD = await page.locator('.step.open').getAttribute('data-step');
      expect((await body.locator('.repeat-mode option').allInnerTexts()).includes('쪽 넘기기 — 다음 쪽이 없을 때까지'), '방법이 없습니다'); // 고침 2회차 R2-06: 핵심이 앞에 오게
      await body.locator('.repeat-mode').selectOption('pages');
      expect((await body.locator('.repeat-mode').inputValue()) === 'pages' && (await body.locator('.paging-sum').innerText()).includes('마지막 쪽까지'), '쪽 넘기기 요약이 없습니다');
      await saveNow();
      const r = await getRecipe(LD);
      const rep = byId(r, repD);
      const b = r.blocks[rep.body];
      expect(rep.until?.kind === 'not' && rep.until.condition?.target?.candidates?.[0]?.value === '#next' && !rep.times && !rep.while, JSON.stringify(rep));
      expect(b[0].type === 'branch' && b[0].condition.var === 'loop.index' && r.blocks[b[0].then]?.[0]?.id === 's3' && b[1].id === 's2', JSON.stringify(b));
    });
    await check('R2-06 반복 방법 칸은 한 줄 전체 폭이라 고른 글("쪽 넘기기 — 다음 쪽이 없을 때까지")이 잘리지 않는다', async () => {
      await openStep(repD);
      const sel = body.locator('.repeat-mode');
      const bb = await sel.boundingBox();
      const fits = await sel.evaluate((e) => {
        const c = document.createElement('canvas').getContext('2d');
        c.font = getComputedStyle(e).font;
        return c.measureText(e.options[e.selectedIndex].text).width + 40 <= e.clientWidth;
      });
      expect(bb && bb.width >= 380 && fits && (await sel.locator('option:checked').innerText()) === '쪽 넘기기 — 다음 쪽이 없을 때까지', `폭 ${bb?.width} · 글이 들어감 ${fits}`);
    });
    await check('R1-03 "조건이 참인 동안" 으로 되돌리면 "다음" 클릭이 끝으로 가고 "마지막 쪽은 처리되지 않습니다" 경고 + 배지 → [쪽 넘기기로 바꾸기]', async () => {
      await openStep(repD);
      await body.locator('.repeat-mode').selectOption('while');
      expect((await body.locator('.paging-risk').innerText()).includes('마지막 쪽은 처리되지 않습니다'), '경고가 없습니다');
      expect((await head(repD).innerText()).includes('마지막 쪽 빠짐'), await head(repD).innerText());
      const mid = await getRecipe(LD); // 저장 전 (서버) — 화면 상태는 아래 저장으로 확인
      void mid;
      await body.getByRole('button', { name: '쪽 넘기기로 바꾸기' }).click();
      expect((await body.locator('.repeat-mode').inputValue()) === 'pages', '쪽 넘기기로 바뀌지 않았습니다');
      await saveNow();
      expect(!(await api('GET', `/api/recipes/${LD}`)).problems.length, '고칠 점이 있습니다');
    });
    await check('R1-03 실제 실행: 3쪽 12행 모두 (마지막 쪽 포함)', async () => {
      const rep = await runNow(LD);
      const n = lines(rep.rows[0].values?.상호);
      expect(rep.status === 'done' && n.length === 12 && n[11] === '새솔상사', `${rep.status} ${n.length}개 ${n.join(',')}`);
      expect(/반복 끝 \(3번 실행\)/.test(rep.log), '끝난 이유 로그가 없습니다');
    });
    await check('R1-03 T7 경로 그대로: "조건이 참인 동안" 을 고르면 처음 조건이 "다음" 이 있으면, 조건을 바꿀 때마다 경고·배지가 바로 따라온다', async () => {
      const LD2 = (await api('POST', '/api/recipes', { ...recipePages(site.base), name: '고침 D2 경고' })).recipe.id;
      await open(`#/recipe/${LD2}`, '고침 D2 경고');
      await pickBox('s2').check();
      await pickBox('s3').check();
      await bulk.getByRole('button', { name: '반복으로 묶기' }).click();
      const rep = await page.locator('.step.open').getAttribute('data-step');
      await body.locator('.repeat-mode').selectOption('while');
      expect((await cond.locator('.cond-preview').innerText()).includes('"다음" 버튼 있음'), await cond.locator('.cond-preview').innerText());
      expect(await body.locator('.paging-risk').isVisible(), '처음부터 경고가 없습니다');
      await selectByText(cond.locator('.cond-subject'), '거래처 결과 표의 행');
      expect((await body.locator('.paging-risk').count()) === 0 && !(await head(rep).locator('.badge', { hasText: '마지막 쪽 빠짐' }).isVisible()), '조건을 바꿨는데 경고가 남았습니다');
      await selectByText(cond.locator('.cond-subject'), '"다음" 버튼');
      await cond.locator('.cond-pred').selectOption('exists');
      expect(await body.locator('.paging-risk').isVisible(), '다시 "다음" 으로 바꿨는데 경고가 없습니다');
      expect(await head(rep).locator('.badge', { hasText: '마지막 쪽 빠짐' }).isVisible(), '머리 배지가 없습니다');
    });
    let failRun = null;
    await check('R1-05 로그인부터 녹화한 레시피(묶기 전): 2행 실패 · 첫 줄은 쉬운 문장, 시도한 후보는 errorDetail', async () => {
      const up = await api('POST', `/api/uploads?name=${encodeURIComponent('번호.csv')}`, Buffer.from('번호\n1\n2\n', 'utf8'), true);
      const rep = await runNow(LL, { uploadId: up.id, params: { 비밀번호: LAB_USER.pw }, saveSecrets: ['비밀번호'] });
      failRun = rep.runId;
      const r2 = rep.rows[1];
      expect(rep.rows[0].status === 'ok' && r2?.status === 'failed', JSON.stringify(rep.rows.map((x) => [x.status, x.error])));
      expect(r2.error.startsWith('"아이디" 입력칸을 화면에서 찾지 못했습니다.') && r2.error.includes('이미 로그인돼') && !/css|xpath|시도한 후보/.test(r2.error), r2.error);
      expect(/^자세히 — 시도한 후보: css #uid/.test(r2.errorDetail ?? ''), r2.errorDetail);
    });
    await check('R1-05·07·10 리포트: 오류 첫 문장 + [자세히] 접힘, 머리에 [편집]·[▶ 다시 실행], [✦ AI 에게] 초안은 쉬운 문장만', async () => {
      await page.goto(`${BASE}/#/report/${failRun}`);
      await page.locator('.statline').waitFor();
      const cell = page.locator('.report-rows tr.row-fail td.c-error');
      expect((await cell.locator('.err-text').innerText()).startsWith('"아이디" 입력칸을 화면에서 찾지 못했습니다'), await cell.innerText());
      const det = cell.locator('details.err-detail');
      expect((await det.count()) === 1 && !(await det.evaluate((d) => d.open)) && (await det.innerText()).includes('자세히'), '자세히가 접혀 있지 않습니다');
      expect((await page.locator('.page-head a', { hasText: '편집' }).getAttribute('href')) === `#/recipe/${LL}` && (await page.locator('.page-head a', { hasText: '다시 실행' }).getAttribute('href')) === `#/run?recipe=${LL}`, '머리 링크가 없습니다');
      expect((await page.locator('.page-head h1 a').getAttribute('href')) === `#/recipe/${LL}`, '레시피 이름 링크가 없습니다');
      await page.locator('main').getByRole('button', { name: '✦ AI 에게' }).click();
      const v = await page.locator('.ai-input textarea').inputValue();
      expect(v.startsWith('2행이 실패했습니다') && v.includes('"아이디" 입력칸을 화면에서 찾지 못했습니다') && !/xpath|css|시도한 후보|normalize-space/.test(v), v);
      // 고침 2회차 R2-04: 번호로 가리키고 따옴표가 겹치지 않으며 ".)." 로 끝나지 않는다
      expect(v.startsWith('2행이 실패했습니다 — #2 스텝(아이디에 tester 입력): "아이디" 입력칸을 화면에서 찾지 못했습니다 (이미 로그인돼') && !v.includes('""') && !v.includes('.)') && v.endsWith('). 원인을 찾아 고쳐 줘.'), v);
      await page.locator('.ai-input textarea').fill('');
      await page.locator('.ai-head button[title="닫기"]').click();
    });
    await check('R1-17 변수 탭: 비밀 변수 설명이 되풀이되지 않고 "●●●● 이 PC 에 저장됨" 이 보인다', async () => {
      await open(`#/recipe/${LL}`, '고침 L 로그인');
      await tab('변수·엑셀');
      const it = page.locator('.var-item[data-var="비밀번호"]');
      await until(async () => (await it.locator('.secret-state').innerText()).includes('저장됨'), 5000);
      const t = await it.innerText();
      expect(t.includes('●●●● 이 PC 에 저장됨') && (t.match(/비밀값은/g) ?? []).length === 1, t);
      await tab('스텝');
    });
    await check('R1-05 편집기 안내 "로그인 단계가 있습니다" → [로그인 화면일 때만 하도록 묶기] 한 번 → 분기(아이디 칸이 있으면)', async () => {
      await open(`#/recipe/${LL}?recorded=1`, '고침 L 로그인');
      const hint = page.locator('.login-hint');
      expect((await hint.innerText()).includes('2행부터는 이미 로그인돼'), await hint.innerText());
      await hint.getByRole('button', { name: '로그인 화면일 때만 하도록 묶기' }).click();
      expect(await toastHas('로그인 화면일 때만'), '안내가 없습니다');
      expect((await page.locator('.login-hint').count()) === 0, '안내가 남았습니다');
      await saveNow();
      const r = await getRecipe(LL);
      const br = r.blocks.main[1];
      expect(br.type === 'branch' && br.condition.kind === 'exists' && br.condition.target.candidates[0].value === '#uid' && r.blocks[br.then].map((s) => s.id).join() === 's2,s3,s4', JSON.stringify(r.blocks));
      expect((await head(br.id).innerText()).includes('만약 "아이디" 입력칸이 있으면'), await head(br.id).innerText());
    });
    await check('R1-05 묶은 뒤 실제 실행: 2행 모두 성공 (2행은 로그인 건너뜀, 저장한 비밀값 사용)', async () => {
      const up = await api('POST', `/api/uploads?name=${encodeURIComponent('번호.csv')}`, Buffer.from('번호\n1\n2\n', 'utf8'), true);
      const rep = await runNow(LL, { uploadId: up.id });
      expect(rep.status === 'done' && rep.rows.length === 2 && rep.rows.every((x) => x.status === 'ok' && x.values?.제목 === '매출 원장 조회'), JSON.stringify(rep.rows.map((x) => [x.status, x.error, x.values])));
    });
    await check('R1-12 입력값 정리: 목록 선택은 보이는 글자를 먼저, 엑셀 열을 고르면 "목록에 보이는 글자를 적으세요"', async () => {
      await open(`#/recipe/${LS}`, '고침 S 목록 선택');
      await page.locator('.step-tools').getByRole('button', { name: '입력값 정리' }).click();
      await tidy.waitFor();
      expect((await trow('s2').locator('.tidy-now').innerText()) === '2026년 1기 (1~6월) (값 H1)', await trow('s2').locator('.tidy-now').innerText());
      expect(!(await trow('s2').locator('.tidy-hint').isVisible()), '안내가 처음부터 보입니다');
      await trow('s2').getByRole('radio', { name: '엑셀 열' }).check();
      expect((await trow('s2').locator('.tidy-hint').innerText()).includes('목록에 보이는 글자(예: 2026년 1기 (1~6월))'), await trow('s2').locator('.tidy-hint').innerText());
      await tidy.getByRole('button', { name: '닫기' }).click();
    });

    // =================================================================
    console.log('\n[14] 휴대폰 폭 390px');
    const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
    watch(m);
    const sw = (p = m) => p.evaluate(() => Math.max(document.documentElement.scrollWidth, document.querySelector('.modal-back')?.scrollWidth ?? 0));
    const rightEdge = (sel) => m.evaluate((s) => Math.max(0, ...[...document.querySelectorAll(s)].map((e) => e.getBoundingClientRect().right)), sel);
    await check('390px: 트리 화면 가로 스크롤 없음', async () => {
      await openIn(m, `#/recipe/${A}`, '편집기 점검 A');
      const w = await sw();
      const r = await rightEdge('.step-head, .step-tools *');
      await m.screenshot({ path: path.join(SHOTS, 'm-tree.png'), fullPage: true });
      expect(w <= 392 && r <= 391, `scrollWidth=${w} · 오른쪽 끝 ${r}`);
    });
    await check('390px: 조건 편집기(분기 펼침) 가로 스크롤 없음', async () => {
      await m.locator(`.step[data-step="${brId}"] > .step-head`).click();
      await m.locator('.step-body .cond').waitFor();
      await sleep(200);
      const w = await sw();
      const r = await rightEdge('.step-body .cond, .step-body .cond *');
      await m.screenshot({ path: path.join(SHOTS, 'm-condition.png'), fullPage: true });
      expect(w <= 392 && r <= 391, `scrollWidth=${w} · 오른쪽 끝 ${r}`);
    });
    await check('390px: 일괄 막대 가로 스크롤 없음', async () => {
      await m.locator('.step[data-step="a1"] > .step-head input[type=checkbox]').check();
      await m.locator('.bulk-bar').waitFor();
      const bb = await m.locator('.bulk-bar').boundingBox();
      expect(bb && bb.y >= 0 && bb.y + bb.height <= 844, `일괄 막대가 화면 밖에 있습니다: ${JSON.stringify(bb)}`);
      const w = await sw();
      const r = await rightEdge('.bulk-bar, .bulk-bar *');
      await m.screenshot({ path: path.join(SHOTS, 'm-bulk.png') });
      expect(w <= 392 && r <= 391, `scrollWidth=${w} · 오른쪽 끝 ${r}`);
    });
    await check('R1-15 390px: 스텝 고르기 체크의 누르는 영역이 40×40 이상', async () => {
      const bb = await m.locator('.step[data-step="a1"] > .step-head .step-pick').boundingBox();
      expect(bb && bb.width >= 40 && bb.height >= 40, JSON.stringify(bb));
    });
    await check('R1-15 390px: 일괄 막대는 자주 쓰는 단추만 (나머지는 [더보기 …]), 펼쳐도 가로 스크롤 없음', async () => {
      const bar = m.locator('.bulk-bar');
      const bb = await bar.boundingBox();
      expect(bb && bb.height <= 120, `막대 높이 ${bb?.height}`);
      expect(!(await bar.getByRole('button', { name: '반복으로 묶기' }).isVisible()), '접힌 단추가 보입니다');
      await bar.getByRole('button', { name: '더보기 …' }).click();
      expect(await bar.getByRole('button', { name: '반복으로 묶기' }).isVisible(), '더보기로 펼쳐지지 않았습니다');
      const r = await rightEdge('.bulk-bar, .bulk-bar *');
      expect(r <= 391, `오른쪽 끝 ${r}`);
      await bar.getByRole('button', { name: '접기' }).click();
      await bar.getByRole('button', { name: '선택 해제' }).click();
    });
    await check('390px: 변수 탭 가로 스크롤 없음', async () => {
      await m.locator('.tabs button', { hasText: '변수·엑셀' }).click();
      await m.locator('.var-item').first().waitFor();
      const w = await sw();
      await m.screenshot({ path: path.join(SHOTS, 'm-vars.png'), fullPage: true });
      expect(w <= 392, `scrollWidth=${w}`);
    });
    await check('390px: 입력값 정리 (카드형) 가로 스크롤 없음', async () => {
      await openIn(m, `#/recipe/${B}`, '편집기 점검 B');
      await m.locator('.step-tools').getByRole('button', { name: '입력값 정리' }).click();
      await m.locator('.modal.tidy').waitFor();
      await sleep(200);
      const w = await sw();
      const r = await rightEdge('.modal.tidy, .modal.tidy *');
      await m.screenshot({ path: path.join(SHOTS, 'm-input-tidy.png'), fullPage: true });
      expect(w <= 392 && r <= 391, `scrollWidth=${w} · 오른쪽 끝 ${r}`);
    });
    await check('R2-07 390px: 로그인 안내는 한 줄 요약 + 단추 — 첫 화면에 스텝이 둘 이상 보인다 (첫 스텝이 맨 아래가 아님)', async () => {
      if (await m.locator('.modal.tidy').count()) await m.locator('.modal.tidy').getByRole('button', { name: '닫기' }).click(); // 앞 검사의 입력값 정리 창
      const LL2 = (await api('POST', '/api/recipes', { ...recipeLogin(LAB), name: '고침 L2 로그인 (휴대폰)' })).recipe.id;
      await openIn(m, `#/recipe/${LL2}`, '고침 L2 로그인 (휴대폰)');
      const hint = m.locator('.login-hint');
      const hb = await hint.boundingBox();
      const first = await m.locator('.step-head').first().boundingBox();
      await m.screenshot({ path: path.join(SHOTS, 'm-login-hint.png') });
      expect(hb && hb.height <= 110 && (await hint.innerText()).includes('2행부터 실패할 수 있어요') && !(await hint.locator('.lh-long').isVisible()) && (await hint.getByRole('button', { name: '로그인 화면일 때만 하도록 묶기' }).isVisible()), `안내 높이 ${hb?.height}`);
      const shown = await m.locator('.step-head').evaluateAll((hs) => hs.filter((x) => x.getBoundingClientRect().bottom <= innerHeight).length);
      expect(first && first.y + first.height <= 844 - 100 && shown >= 2, `첫 스텝 위치 ${JSON.stringify(first)} · 첫 화면에 보이는 스텝 ${shown}개`);
    });
    await check('R1-06 390px 리포트: 실패 행은 카드 — 오류 첫 문장과 [✦ AI 에게] 가 화면 안 (가로 스크롤 없음)', async () => {
      if (await m.locator('.modal.tidy').count()) await m.locator('.modal.tidy').getByRole('button', { name: '닫기' }).click(); // 앞 검사의 입력값 정리 창
      await m.goto(`${BASE}/#/report/${failRun}`);
      await m.locator('.statline').waitFor();
      await sleep(300);
      const card = m.locator('.report-rows tr.row-fail');
      const cb = await card.boundingBox();
      const err = await card.locator('.err-text').boundingBox();
      const ask = card.getByRole('button', { name: '✦ AI 에게' });
      await ask.scrollIntoViewIfNeeded();
      const ab = await ask.boundingBox();
      await m.screenshot({ path: path.join(SHOTS, 'm-report.png'), fullPage: true });
      const w = await sw();
      expect(w <= 392 && cb && cb.x >= 0 && cb.x + cb.width <= 391 && err && err.x + err.width <= 391 && ab && ab.x >= 0 && ab.x + ab.width <= 391 && ab.height >= 36, `scrollWidth=${w} 카드 ${JSON.stringify(cb)} 오류 ${JSON.stringify(err)} 단추 ${JSON.stringify(ab)}`);
    });
    await m.close();

    await check('화면 오류 0 (pageerror · console error)', async () => expect(!errors.length, errors.join(' | ')));
  } finally {
    await browser?.close().catch(() => {});
    await stopServer();
    await site.close();
    lab.closeAllConnections?.();
    await new Promise((r) => lab.close(() => r()));
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n편집기 점검: ${passed}/${results.length} 통과`);
  if (passed !== results.length) {
    for (const r of results.filter((x) => !x.ok)) console.log(`  ❌ ${r.name} — ${r.why}`);
    if (process.env.SHOW_LOG) console.log(serverLog.slice(-4000));
    console.log(`(출력 남김: ${OUT})`);
    process.exit(1);
  }
  if (process.env.KEEP_OUT !== '1') await fs.rm(OUT, { recursive: true, force: true }).catch(() => {});
}

main().catch(async (e) => {
  console.error('\n❌ 편집기 점검 실패:', e);
  await stopServer();
  process.exit(1);
});
