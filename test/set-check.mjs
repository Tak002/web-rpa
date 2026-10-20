// 진행 세트(.wrset)·허브 점검 (실제 브라우저, 숨김 모드).
//   1. 단위: 압축 왕복·결정성, 개인정보 찾기, 버전 범위
//   2. 실험실에서 녹화한 레시피 정리 (녹화 정보·쿼리·남은 값)
//   3. 실험실 세트 만들기 + 세트 검사 실패 사례
//   4. 가짜 허브: 목록·설명·미리보기·sha256 불일치·엔진 범위 거절·설치 → 예시 실행 → 기대 결과 비교 → 업데이트 · 세트 파일 가져오기 · 내보내기 API
//   5. 세트 사이트 제한 (이동·팝업 차단), 행 간격·행 수 상한, 제한 없는 레시피는 그대로
//   6. 화면: 허브 목록·상세·가져오기·예시로 실행, 내보내기 마법사, 모바일 폭
//   7. 명령줄: set unpack/lint/pack/test, hub list/install
// 실행: node test/set-check.mjs   (결과 test/out/set/)

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { Recorder } from '../src/recorder/recorder.js';
import { Runner } from '../src/engine/runner.js';
import { recipeProblems } from '../src/recipe.js';
import { writeZip, readZip } from '../src/set/zip.mjs';
import { scrubRecipe, applyDecisions, findPII, satisfies, engineRangeFor, compareExpected, toCsv } from '../src/set/core.mjs';
import { readSetDir, packSetDir, packFiles, unpackSet } from '../src/set/folder.mjs';
import { setDraft, buildSet, inspectFiles, inspectSet, sha256, ENGINE_VERSION } from '../src/set/index.js';
import { startLab, LAB_USER, ledgerRows } from './lab-server.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'test', 'out', 'set');
const SHOTS = path.join(OUT, 'shots');
const PORT = 4894;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 결과 ----------
let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  return !!ok;
}
const section = (t) => console.log(`\n==================== ${t}`);
const errorOf = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
};
const has = (list, re) => (list ?? []).some((x) => re.test(x));

async function api(method, url, body, { raw = false, headers = {} } = {}) {
  const res = await fetch(BASE + url, { method, headers: { ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { ok: res.ok, status: res.status, data, headers: res.headers };
}

// ---------- 실험실 세트 레시피 (사람이 쓴 레시피: 로그인 분기 + 조회 + 값 읽기 + 다운로드) ----------
const css = (value, score = 90) => ({ kind: 'css', value, score });
const tgt = (candidates, meta = {}) => ({ framePath: [], candidates, meta });
function labRecipe(LAB) {
  const biz = tgt([css('[id^="biz_"]')], { tag: 'input', label: '사업자번호' });
  return {
    schemaVersion: 1,
    name: '실험실 원장 합계',
    startUrl: `${LAB}/ledger.html`,
    entryBlock: 'main',
    variables: [
      { id: '사업자번호', name: '사업자번호', source: { kind: 'excel', column: '사업자번호' } },
      { id: '기간', name: '기간', source: { kind: 'excel', column: '기간' } },
      { id: '아이디', name: '아이디', source: { kind: 'prompt', default: LAB_USER.id } },
      { id: '비밀번호', name: '비밀번호', source: { kind: 'prompt', secret: true } },
    ],
    blocks: {
      main: [
        { id: 's1', type: 'navigate', url: `${LAB}/ledger.html` },
        { id: 's2', type: 'branch', condition: { kind: 'exists', target: tgt([css('#uid')], { tag: 'input', label: '아이디' }) }, then: 'login' },
        { id: 's3', type: 'input', target: biz, value: '{{사업자번호}}' },
        { id: 's4', type: 'select', target: tgt([css('#period')], { tag: 'select', label: '기간' }), value: '{{기간}}' },
        { id: 's5', type: 'click', target: tgt([css('[id^="btnSearch_"]'), { kind: 'text', value: { tag: 'button', text: '조회' }, score: 70 }], { tag: 'button', text: '조회' }) },
        { id: 's6', type: 'wait', condition: { kind: 'textVisible', text: '조회 완료' }, timeoutMs: 10000 },
        { id: 's7', type: 'extract', target: tgt([css('#total')], { tag: 'b' }), saveAs: '합계' },
        { id: 's8', type: 'download', target: tgt([css('a[href="/files/manual.txt"]')], { tag: 'a', text: '① 사용 설명서 받기' }), fileName: '사용설명서_{{사업자번호}}' },
      ],
      login: [
        { id: 'l1', type: 'input', target: tgt([css('#uid')], { tag: 'input', label: '아이디' }), value: '{{아이디}}' },
        { id: 'l2', type: 'input', target: tgt([css('#upw')], { tag: 'input', type: 'password', label: '비밀번호' }), value: '{{비밀번호}}' },
        { id: 'l3', type: 'click', target: tgt([css('button[type=submit]')], { tag: 'button', text: '로그인' }) },
        { id: 'l4', type: 'wait', condition: { kind: 'exists', target: biz }, timeoutMs: 10000 },
      ],
    },
  };
}
const SAMPLE = [
  { 사업자번호: '1111111111', 기간: 'H1' },
  { 사업자번호: '2222222222', 기간: 'H2' },
];
const totalText = (biz, period) => `${ledgerRows(biz, period).reduce((s, r) => s + r.amount, 0).toLocaleString('en-US')}원`;
const EXPECTED = {
  totals: { rows: 2, ok: 2, failed: 0 },
  rows: {
    '*': { status: 'ok', values: { 합계: { regex: '^[\\d,]+원$' } }, files: [{ glob: '사용설명서_*.txt', type: 'txt' }] },
    1111111111: { values: { 합계: { equals: totalText('1111111111', 'H1') } } },
    2222222222: { values: { 합계: { equals: totalText('2222222222', 'H2') } } },
  },
};
function labSetInput(LAB, recipe, { version = '1.0.0', id = 'tak002/lab-ledger-total' } = {}) {
  const decisions = Object.fromEntries(setDraft(recipe).remaining.map((r) => [r.id, 'keep']));
  return {
    manifest: {
      id,
      version,
      summary: '실험실 사이트에서 사업자번호마다 원장 합계를 읽고 설명서를 받습니다.',
      author: { name: 'Tak002', github: 'Tak002' },
      tags: '실험실, 시험',
      sites: [{ origin: LAB, purpose: '매출 원장 조회와 설명서 내려받기' }],
      columns: [
        { name: '사업자번호', help: '숫자 10자리 (지어낸 값)', example: '1111111111' },
        { name: '기간', help: 'H1(1기) 또는 H2(2기)', example: 'H1' },
      ],
    },
    decisions,
    sampleRows: SAMPLE,
    expected: EXPECTED,
  };
}

// ---------- 가짜 허브 (목록 + 세트 파일 + README + 사이트 제한 시험용 페이지) ----------
function startHub() {
  const files = new Map(); // 경로 → { type, body }
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const f = files.get(p);
    if (!f) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': f.type, 'cache-control': 'no-store' }).end(f.body);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, files, port: server.address().port })));
}
const page = (title, body = '') => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

function indexEntry(built, url, extra = {}) {
  const m = built.manifest;
  return {
    id: m.id,
    name: m.name,
    summary: m.summary,
    author: { name: m.author.name, github: m.author.github },
    license: m.license,
    tags: m.tags,
    latest: m.version,
    versions: [{ version: m.version, engine: m.engine.webRpa, url, sha256: built.sha256, size: built.buffer.length, publishedAt: '2026-10-20T00:00:00Z', risk: m.risk, sites: m.sites.map((s) => s.origin), columns: m.columns.map((c) => c.name), verified: { at: '2026-10-20', result: '2/2' } }],
    readme: `sets/${m.id}/${m.version}/README.md`,
    ...extra,
  };
}

async function waitRun(runId) {
  for (let i = 0; i < 240; i += 1) {
    const s = (await api('GET', '/api/state')).data;
    if (s.run?.runId === runId && ['done', 'failed', 'stopped'].includes(s.run.status)) break;
    await sleep(500);
  }
  return (await api('GET', `/api/runs/${runId}`)).data;
}

function runCli(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['src/cli.js', ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WEB_RPA_CWD: OUT } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(SHOTS, { recursive: true });
  const lab = await startLab();
  const LAB = `http://127.0.0.1:${lab.address().port}`;
  const hub = await startHub();
  const HUB = `http://127.0.0.1:${hub.port}`;
  let server;
  try {
    // =====================================================================
    section('1. 단위: 압축·개인정보·버전');
    const entries = [
      { name: 'b.txt', data: 'B' },
      { name: 'input/sample.csv', data: '﻿열\r\n값\r\n' },
      { name: 'README.md', data: '# 가나\n'.repeat(50) },
    ];
    const z1 = writeZip(entries);
    const z2 = writeZip([...entries].reverse());
    check('압축: 같은 내용이면 순서와 상관없이 같은 바이트', z1.equals(z2));
    const back = readZip(z1);
    check('압축: 다시 읽으면 같은 내용', back.size === 3 && back.get('README.md').toString() === '# 가나\n'.repeat(50) && back.get('input/sample.csv').toString().startsWith('﻿'));
    check('압축: 경로 탈출(../) 거절', /허용하지 않는 경로/.test(errorOf(() => readZip(writeZip([{ name: '../evil.txt', data: 'x' }])))?.message ?? ''));
    check('압축: zip 이 아니면 거절', !!errorOf(() => readZip(Buffer.from('이것은 zip 파일이 아닙니다 — 그냥 글자입니다'))));
    const dirA = path.join(OUT, 'pack-a');
    await fs.mkdir(path.join(dirA, 'input'), { recursive: true });
    await fs.writeFile(path.join(dirA, 'README.md'), '# 시험\n');
    await fs.writeFile(path.join(dirA, 'input', 'sample.csv'), '열\r\n값\r\n');
    await fs.mkdir(path.join(dirA, '.git'), { recursive: true });
    await fs.writeFile(path.join(dirA, '.git', 'HEAD'), 'ref');
    check('폴더 묶기: 숨은 폴더는 빼고 같은 바이트', packSetDir(dirA).equals(packSetDir(dirA)) && !readSetDir(dirA).has('.git/HEAD') && readSetDir(dirA).has('input/sample.csv'));

    const rrn = (() => {
      const d = '900101123456';
      const w = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
      const sum = w.reduce((a, x, i) => a + x * Number(d[i]), 0);
      return `${d.slice(0, 6)}-${d.slice(6)}${(11 - (sum % 11)) % 10}`;
    })();
    const brn = (() => {
      const d = '123456789';
      const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
      let sum = w.reduce((a, x, i) => a + x * Number(d[i]), 0);
      sum += Math.floor((5 * Number(d[8])) / 10);
      return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}${(10 - (sum % 10)) % 10}`;
    })();
    const email = ['hong', 'mail.co.kr'].join('@');
    const kinds = findPII(`주민 ${rrn} 사업자 ${brn} 전화 010-1234-5678 메일 ${email} 카드 4111 1111 1111 1111 예시 ${['me', 'example.com'].join('@')}`).map((x) => x.kind);
    check('개인정보: 주민번호·사업자번호·휴대전화·이메일·카드번호', ['주민·외국인등록번호', 'brn', '휴대전화', '이메일', '카드번호'].every((k) => kinds.includes(k)), kinds.join(','));
    check('개인정보: example.com 이메일·검증번호가 틀린 숫자는 제외', kinds.filter((k) => k === '이메일').length === 1 && !findPII('1111111111 900101-1234567').length);
    check('버전 범위', satisfies('0.2.0', '>=0.2.0 <0.3.0') && !satisfies('0.3.0', '>=0.2.0 <0.3.0') && engineRangeFor('0.2.0') === '>=0.2.0 <0.3.0' && ENGINE_VERSION === '0.2.0');

    // =====================================================================
    section('2. 실험실에서 녹화한 레시피 정리');
    const rec = new Recorder({ name: '실험실 녹화', startUrl: `${LAB}/ledger.html`, profileDir: path.join(OUT, 'rec-profile'), headless: true });
    await rec.start();
    let recorded;
    try {
      const pg = rec.ctx.pages()[0];
      await pg.waitForSelector('#uid');
      await pg.getByLabel('아이디').fill(LAB_USER.id);
      await pg.getByLabel('비밀번호').fill(LAB_USER.pw);
      await pg.getByRole('button', { name: '로그인' }).click();
      await pg.waitForSelector('text=매출 원장 조회');
      await pg.getByLabel('사업자번호').fill('1111111111');
      await pg.getByLabel('기간').selectOption('H1');
      await pg.getByRole('button', { name: '조회' }).click();
      await pg.waitForSelector('text=조회 완료');
      await sleep(400);
    } finally {
      recorded = await rec.stop();
    }
    await fs.writeFile(path.join(OUT, 'recorded.json'), JSON.stringify(recorded, null, 2));
    check('녹화: 비밀번호 값은 레시피에 없다', !JSON.stringify(recorded).includes(LAB_USER.pw));
    const scrub = scrubRecipe(recorded);
    const steps = Object.values(scrub.recipe.blocks).flat();
    check('정리: id·만든 시각 제거', !scrub.recipe.id && !scrub.recipe.createdAt && !scrub.recipe.updatedAt);
    check('정리: 녹화 시각·위치(meta.ts·rect) 제거', steps.every((s) => s.meta?.ts === undefined && s.target?.meta?.rect === undefined));
    check('정리: 녹화 당시 주소의 쿼리 제거', scrub.removed.some((r) => r.what === '녹화 당시 주소의 쿼리') && steps.every((s) => !String(s.meta?.url ?? '').includes('?')), JSON.stringify(scrub.removed));
    check('정리: 변수로 바꾸지 않은 입력값은 남은 값으로 확인받는다', scrub.remaining.some((r) => r.value === LAB_USER.id) && scrub.remaining.some((r) => r.value === '1111111111'), JSON.stringify(scrub.remaining));
    check('정리: 비밀번호는 실행 때 묻는 비밀 변수', scrub.recipe.variables.some((v) => v.source?.kind === 'prompt' && v.source.secret));
    const cleared = applyDecisions(scrub.recipe, Object.fromEntries(scrub.remaining.map((r) => [r.id, 'clear'])));
    check(
      '정리: "지우기" 고른 값은 비운다',
      scrub.remaining.filter((r) => !r.id.startsWith('var:') && !r.id.endsWith(':target')).every((r) => {
        const [b, i, f] = r.id.split(':');
        return cleared.blocks[b][Number(i)][f] === '';
      }),
    );
    const undecided = errorOf(() => buildSet(recorded, { manifest: {}, decisions: {} }));
    check('세트 만들기: 남은 값을 정하지 않으면 거절', undecided?.status === 400 && /정해 주세요/.test(undecided.message), undecided?.message);

    // =====================================================================
    section('3. 실험실 세트 만들기 + 세트 검사');
    const recipe = labRecipe(LAB);
    check('세트 레시피: 레시피 검사 통과', !recipeProblems(recipe).length, recipeProblems(recipe).join(' / '));
    const built = buildSet(recipe, labSetInput(LAB, recipe));
    await fs.writeFile(path.join(OUT, built.fileName), built.buffer);
    check('세트 만들기: 검사 통과', !built.lint.errors.length, built.lint.errors.join(' / '));
    check('세트 만들기: 같은 입력이면 같은 sha256', buildSet(recipe, labSetInput(LAB, recipe)).sha256 === built.sha256);
    check('세트 만들기: 파일 이름 게시자-이름-버전', built.fileName === 'tak002-lab-ledger-total-1.0.0.wrset', built.fileName);
    check('세트 만들기: 위험 표시 계산 (파일 저장·http·로그인)', ['download', 'insecure-http', 'login'].every((f) => built.manifest.risk.includes(f)), built.manifest.risk.join(','));
    check('세트 만들기: 요약 문장', built.summary[0] === `이 세트는 ${LAB} 에만 접속합니다.` && built.summary.includes('파일을 저장합니다.'), built.summary.join(' / '));
    const preview = inspectSet(built.buffer);
    check('미리보기: 엔진 범위 맞음·오류 없음', preview.engine.ok && !preview.errors.length && preview.sample.rows.length === 2, preview.errors.join(' / '));
    const builtRecipe = JSON.parse(built.files.get('recipe.json'));
    check('세트 안 레시피: id·origin 없음, 이름은 세트 이름', !builtRecipe.id && !builtRecipe.origin && builtRecipe.name === '실험실 원장 합계');

    const mutate = (fn) => {
      const f = new Map(built.files);
      fn(f);
      return inspectFiles(f, packFiles(f));
    };
    const editJson = (f, name, fn) => {
      const v = JSON.parse(f.get(name).toString('utf8'));
      fn(v);
      f.set(name, Buffer.from(JSON.stringify(v)));
    };
    let r = mutate((f) => f.delete('manifest.json'));
    check('검사 실패: manifest.json 없음', has(r.errors, /manifest\.json 이 없습니다/));
    r = mutate((f) => f.set('run.exe', Buffer.from('MZ')));
    check('검사 실패: 넣을 수 없는 파일', has(r.errors, /넣을 수 없는 파일/));
    r = mutate((f) => f.set('input/sample.csv', Buffer.from(toCsv(['사업자번호', '기간'], [{ 사업자번호: '010-1234-5678', 기간: 'H1' }]))));
    check('검사 실패: 예시 입력에 휴대전화', has(r.errors, /휴대전화/));
    r = mutate((f) => f.set('input/sample.csv', Buffer.from(toCsv(['사업자번호', '기간'], [{ 사업자번호: '=1+1', 기간: 'H1' }]))));
    check('검사 실패: 수식으로 읽힐 값', has(r.errors, /수식/));
    r = mutate((f) => editJson(f, 'recipe.json', (x) => x.blocks.main.push({ id: 'x9', type: 'navigate', url: 'https://other.example.com/page' })));
    check('검사 실패: manifest 에 없는 사이트로 이동', has(r.errors, /manifest 에 없는 사이트로 접속합니다: https:\/\/other\.example\.com/));
    r = mutate((f) => editJson(f, 'manifest.json', (m) => (m.risk = m.risk.filter((x) => x !== 'download'))));
    check('검사 실패: 위험 표시 누락', has(r.errors, /위험 표시 "download"/));
    r = mutate((f) => editJson(f, 'recipe.json', (x) => (x.blocks.main[2].meta = { recordedValue: '1234567890' })));
    check('검사 실패: 녹화 정보가 남음', has(r.errors, /meta\.recordedValue/));
    r = mutate((f) => f.set('media/big.png', Buffer.alloc(600 * 1024, 1)));
    check('검사 실패: 500KB 넘는 그림', has(r.errors, /500KB/));
    r = mutate((f) => f.set('input/template.xlsx', writeZip([{ name: '[Content_Types].xml', data: '<x/>' }, { name: 'xl/vbaProject.bin', data: 'macro' }])));
    check('검사 실패: 매크로가 든 엑셀 양식', has(r.errors, /매크로/));
    r = mutate((f) => editJson(f, 'manifest.json', (m) => (m.engine.webRpa = '>=9.0.0 <10.0.0')));
    check('검사 실패: 엔진 범위가 안 맞음', !r.engine.ok && has(r.errors, /web-rpa >=9\.0\.0 <10\.0\.0/));
    r = mutate((f) => editJson(f, 'manifest.json', (m) => (m.summary = '짧음')));
    check('검사 실패: 설명이 짧음', has(r.errors, /summary/));
    check('검사: expected.json 이 없으면 경고', has(mutate((f) => f.delete('expected.json')).warnings, /expected\.json/));

    // =====================================================================
    section('4. 가짜 허브 → 미리보기·sha256·엔진 범위 → 설치 → 예시 실행 → 기대 결과');
    // 허브 목록: 정상 세트, 내용이 바뀐 세트(sha256 다름), 엔진 범위가 안 맞는 세트
    const tamperedBuilt = buildSet(recipe, labSetInput(LAB, recipe, { id: 'tak002/tampered' }));
    const futureFiles = new Map(built.files);
    const fm = JSON.parse(futureFiles.get('manifest.json'));
    Object.assign(fm, { id: 'tak002/future-set', version: '2.0.0', engine: { ...fm.engine, webRpa: '>=9.0.0 <10.0.0' } });
    futureFiles.set('manifest.json', Buffer.from(JSON.stringify(fm, null, 2)));
    const futureBuf = packFiles(futureFiles);
    const futureBuilt = { manifest: fm, buffer: futureBuf, sha256: sha256(futureBuf) };
    const setUrl = (b) => `sets/${b.manifest.id}/${b.manifest.version}.wrset`;
    const indexDoc = {
      format: 'web-rpa-hub-index',
      formatVersion: 1,
      generatedAt: new Date().toISOString(),
      hub: { name: '시험 허브', url: `${HUB}/`, repo: 'https://github.com/Tak002/web-rpa-hub' },
      sets: [indexEntry(built, setUrl(built)), indexEntry(tamperedBuilt, setUrl(tamperedBuilt)), indexEntry(futureBuilt, setUrl(futureBuilt))],
    };
    indexDoc.sets[1].versions[0].sha256 = 'a'.repeat(64); // 목록과 다른 파일
    const publish = () => hub.files.set('/index.json', { type: 'application/json; charset=utf-8', body: JSON.stringify(indexDoc) });
    for (const b of [built, tamperedBuilt, futureBuilt]) {
      hub.files.set(`/${setUrl(b)}`, { type: 'application/octet-stream', body: b.buffer });
      hub.files.set(`/sets/${b.manifest.id}/${b.manifest.version}/README.md`, { type: 'text/markdown; charset=utf-8', body: built.files.get('README.md') });
    }
    publish();
    hub.files.set('/site/a.html', { type: 'text/html; charset=utf-8', body: page('A 페이지') });
    hub.files.set('/site/start.html', { type: 'text/html; charset=utf-8', body: page('시작', `<a id="out" href="http://localhost:${hub.port}/site/a.html" target="_blank">밖으로</a> <a id="same" href="/site/a.html" target="_blank">안으로</a>`) });

    const WS = path.join(OUT, 'ws');
    server = spawn(process.execPath, ['src/server.js', '--port', String(PORT), '--workspace', WS], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
    server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
    for (let i = 0; i < 50; i += 1) {
      if (await fetch(`${BASE}/api/state`).then(() => true, () => false)) break;
      await sleep(100);
    }
    const SRC = `${HUB}/index.json`;
    let res = await api('PUT', '/api/settings', { hubSources: [{ name: 'http 허브', url: 'http://example.com/index.json' }] });
    check('설정: 인터넷 허브는 https 만', res.status === 400, JSON.stringify(res.data));
    res = await api('PUT', '/api/settings', { hubSources: [{ name: '시험 허브', url: SRC }] });
    check('설정: 시험 허브 저장', res.ok && res.data.hubSources?.[0]?.url === SRC);

    let list = (await api('GET', '/api/hub')).data;
    const labSet = () => list.sets.find((s) => s.id === 'tak002/lab-ledger-total');
    check('허브 목록: 세트 3개, 연결 정상', list.sources[0]?.ok && list.sets.length === 3, JSON.stringify(list.sources));
    check('허브 목록: 주소를 목록 기준 절대 주소로', labSet()?.entry.url === `${HUB}/${setUrl(built)}`);
    check('허브 목록: 설치 전·엔진 범위 표시', labSet()?.installed === null && labSet()?.entry.compatible && list.sets.find((s) => s.id === 'tak002/future-set')?.entry.compatible === false);
    res = await api('GET', `/api/hub/readme?source=${encodeURIComponent(SRC)}&id=tak002/lab-ledger-total`);
    check('허브 설명(README)', res.ok && res.data.text.startsWith('# 실험실 원장 합계'));
    res = await api('GET', `/api/hub/readme?source=${encodeURIComponent('https://evil.example/index.json')}&id=tak002/lab-ledger-total`);
    check('허브: 설정에 없는 허브 주소는 거절', res.status === 400);

    res = await api('POST', '/api/hub/preview', { source: SRC, id: 'tak002/lab-ledger-total' });
    check('허브 미리보기: sha256 확인·엔진 맞음·오류 없음', res.ok && res.data.verified === 'hub' && res.data.sha256 === built.sha256 && res.data.engine.ok && !res.data.errors.length, JSON.stringify(res.data.errors ?? res.data));
    check('허브 미리보기: 사이트·하는 일·열 설명·위험 위치', res.data.sites?.[0]?.purpose === '매출 원장 조회와 설명서 내려받기' && res.data.columns?.[0]?.help && res.data.risks?.some((x) => x.flag === 'download' && /main 블록 8번/.test(x.where ?? '')));
    res = await api('POST', '/api/hub/preview', { source: SRC, id: 'tak002/tampered' });
    check('sha256 이 다르면 거절 (미리보기)', res.status === 400 && /sha256 이 허브 목록과 다릅니다/.test(res.data.error), res.data.error);
    res = await api('POST', '/api/hub/install', { source: SRC, id: 'tak002/tampered' });
    check('sha256 이 다르면 거절 (설치)', res.status === 400 && /sha256/.test(res.data.error));
    res = await api('POST', '/api/hub/install', { source: SRC, id: 'tak002/future-set' });
    check('엔진 범위가 안 맞으면 거절', res.status === 400 && /web-rpa >=9\.0\.0 <10\.0\.0 에서 동작합니다/.test(res.data.error), res.data.error);
    check('거절한 세트는 설치되지 않음', !(await api('GET', '/api/recipes')).data.some((x) => x.set));

    res = await api('POST', '/api/hub/install', { source: SRC, id: 'tak002/lab-ledger-total' });
    const inst = res.data;
    check('허브 설치', res.ok && inst.recipeId && inst.uploadId && inst.version === '1.0.0' && !inst.updated, JSON.stringify(res.data));
    const installed = (await api('GET', `/api/recipes/${inst.recipeId}`)).data;
    const o = installed.recipe.origin;
    check('설치한 레시피: origin(세트·버전·sha256·출처·사이트·간격)', o?.set === 'tak002/lab-ledger-total' && o.version === '1.0.0' && o.sha256 === built.sha256 && o.source === SRC && o.sites?.[0] === LAB && o.pacing?.minRowIntervalMs === 1000 && o.installedAt, JSON.stringify(o));
    check('설치한 레시피: 실행 전 검사 통과', !installed.problems.length, installed.problems.join(' / '));
    const up = (await api('GET', `/api/uploads/${encodeURIComponent(inst.uploadId)}`)).data;
    check('설치: 예시 입력이 올린 파일로 들어감', up.rowCount === 2 && up.headers.join() === '사업자번호,기간', JSON.stringify(up));
    const reg = JSON.parse(await fs.readFile(path.join(WS, 'sets', 'installed.json'), 'utf8'));
    check('설치 기록 (sets/installed.json) + 원본 보관', reg.sets['tak002/lab-ledger-total']?.recipeId === inst.recipeId && !!(await fs.stat(path.join(WS, 'sets', 'packages', built.fileName)).catch(() => null)));
    list = (await api('GET', '/api/hub')).data;
    check('허브 목록: 설치됨 표시', labSet()?.installed?.version === '1.0.0' && !labSet()?.update);
    check('레시피 목록: 세트 표시', (await api('GET', '/api/recipes')).data.some((x) => x.id === inst.recipeId && x.set?.id === 'tak002/lab-ledger-total'));

    // 예시로 실행 (실행기 · 숨김) → 기대 결과 비교
    res = await api('POST', '/api/runs', { recipeId: inst.recipeId, uploadId: inst.uploadId, params: { 비밀번호: LAB_USER.pw }, options: { headless: true } });
    check('예시 실행 시작', res.ok, JSON.stringify(res.data));
    const report = await waitRun(res.data.runId);
    console.log(`    결과: ${report.status} ${JSON.stringify(report.totals)} ${report.rows?.map((x) => `${x.rowNumber}:${x.status}:${x.values?.합계 ?? ''}:${x.error ?? ''}`).join(' | ')}`);
    const diffs = compareExpected(report, EXPECTED, '사업자번호');
    check('예시 실행: expected.json 과 같음', report.status === 'done' && !diffs.length, diffs.join(' / ') || report.error);
    check('예시 실행: 세트 사이트 제한·간격 기록', /세트 사이트 제한/.test(report.log) && /세트 실행 간격: 행 사이 1초/.test(report.log));
    check('기대 결과 비교가 다른 값을 잡는다', compareExpected(report, { rows: { 1111111111: { values: { 합계: { equals: '0원' } } } } }, '사업자번호').length === 1);

    // 업데이트: 허브에 1.1.0 이 올라오면 표시하고, 설치하면 같은 레시피를 바꾼다
    const v11 = buildSet(recipe, labSetInput(LAB, recipe, { version: '1.1.0' }));
    hub.files.set(`/${setUrl(v11)}`, { type: 'application/octet-stream', body: v11.buffer });
    indexDoc.sets[0].latest = '1.1.0';
    indexDoc.sets[0].versions.unshift(indexEntry(v11, setUrl(v11)).versions[0]);
    publish();
    list = (await api('GET', '/api/hub?refresh=1')).data;
    check('허브 목록: 새 버전이 있으면 업데이트 표시', labSet()?.update === true && labSet()?.entry.version === '1.1.0');
    res = await api('POST', '/api/hub/install', { source: SRC, id: 'tak002/lab-ledger-total' });
    check('업데이트 설치: 같은 레시피를 새 버전으로', res.ok && res.data.updated && res.data.recipeId === inst.recipeId && res.data.previousVersion === '1.0.0', JSON.stringify(res.data));
    res = await api('POST', '/api/hub/preview', { source: SRC, id: 'tak002/lab-ledger-total', version: '1.0.0' });
    check('허브: 이전 버전도 고를 수 있다', res.ok && res.data.version === '1.0.0' && res.data.installed?.version === '1.1.0');

    // 세트 파일 가져오기
    res = await api('POST', '/api/sets/preview', built.buffer, { raw: true });
    check('세트 파일 미리보기', res.ok && res.data.verified === 'file' && res.data.sha256 === built.sha256 && res.data.installed?.version === '1.1.0' && !('recipe' in res.data));
    res = await api('POST', '/api/sets/preview', Buffer.from('zip 이 아닌 파일입니다 — 세트가 아닙니다'), { raw: true });
    check('세트 파일 미리보기: 형식이 아니면 400', res.status === 400 && /세트 파일/.test(res.data.error));
    const piiFiles = new Map(built.files);
    piiFiles.set('README.md', Buffer.from(`# 실험실\n문의: 010-9876-5432\n`));
    res = await api('POST', '/api/sets/install', packFiles(piiFiles), { raw: true });
    check('세트 파일 설치: 검사 오류가 있으면 거절', res.status === 400 && /휴대전화/.test(res.data.error));
    res = await api('POST', '/api/sets/install', built.buffer, { raw: true, headers: { origin: 'http://evil.example' } });
    check('세트 파일 설치: 다른 웹사이트에서 온 요청은 거절', res.status === 403);
    res = await api('POST', '/api/sets/install', built.buffer, { raw: true, headers: { origin: BASE } });
    check('세트 파일 설치: 같은 화면에서 온 요청은 받음 (이전 버전으로 되돌림)', res.ok && res.data.version === '1.0.0' && res.data.recipeId === inst.recipeId, JSON.stringify(res.data));

    // 내보내기 API (레시피 → 세트)
    const imported = (await api('POST', '/api/recipes', labRecipe(LAB))).data.recipe;
    res = await api('GET', `/api/recipes/${imported.id}/set-draft`);
    const draft = res.data;
    check('내보내기 초안: manifest·남은 값·위험·열', res.ok && draft.manifest.engine.webRpa === '>=0.2.0 <0.3.0' && draft.remaining.some((x) => x.id === 'var:2:default') && draft.columns.join() === '사업자번호,기간' && draft.origins[0] === LAB, JSON.stringify(draft).slice(0, 300));
    check('내보내기 초안: 기대 결과 초안(값 이름만)', draft.expected?.rows?.['*']?.values?.합계?.regex === '\\S');
    const body = labSetInput(LAB, labRecipe(LAB));
    res = await api('POST', `/api/recipes/${imported.id}/set`, { ...body, check: true });
    check('내보내기 검사', res.ok && res.data.ok && res.data.fileName === built.fileName && res.data.sha256 === built.sha256, JSON.stringify(res.data.errors ?? res.data));
    res = await api('POST', `/api/recipes/${imported.id}/set`, body);
    check('내보내기: .wrset 내려받기', res.ok && Buffer.isBuffer(res.data) && res.data.equals(built.buffer) && /tak002-lab-ledger-total-1\.0\.0\.wrset/.test(decodeURIComponent(res.headers.get('content-disposition') ?? '')));
    res = await api('POST', `/api/recipes/${imported.id}/set`, { ...body, sampleRows: [{ 사업자번호: rrn, 기간: 'H1' }] });
    check('내보내기: 예시에 주민번호가 있으면 거절', res.status === 400 && /주민/.test(res.data.error));

    // =====================================================================
    section('5. 세트 사이트 제한 · 행 간격 · 행 수 상한');
    const OTHER = `http://localhost:${hub.port}`; // 같은 서버지만 다른 사이트(origin)
    const csvFile = path.join(OUT, 'guard.csv');
    await fs.writeFile(csvFile, toCsv(['주소'], [{ 주소: `${HUB}/site/a.html` }, { 주소: `${OTHER}/site/a.html` }, { 주소: `${HUB}/site/a.html` }]));
    const h1 = tgt([css('h1')], { tag: 'h1' });
    const navRecipe = (origin) => ({
      schemaVersion: 1,
      name: '사이트 제한 시험',
      entryBlock: 'main',
      variables: [{ id: '주소', name: '주소', source: { kind: 'excel', column: '주소' } }],
      blocks: { main: [{ id: 'n1', type: 'navigate', url: '{{주소}}' }, { id: 'n2', type: 'extract', target: h1, saveAs: '제목' }] },
      ...(origin ? { origin } : {}),
    });
    const runGuard = async (name, rcp, excelPath) => {
      const times = [];
      const runner = new Runner({ recipe: rcp, runId: name, runDir: path.join(OUT, name), profileDir: path.join(OUT, 'guard-profile'), excelPath, options: { headless: true } });
      runner.on('row', (e) => times.push({ row: e.rowNumber, status: e.status, at: Date.now() }));
      const rep = await runner.start();
      console.log(`    ${name}: ${rep.status} ${rep.rows.map((x) => `${x.rowNumber}:${x.status}:${x.values?.제목 ?? ''}:${x.error ?? ''}`).join(' | ')}`);
      return { rep, times };
    };
    const g1 = await runGuard('guard-nav', navRecipe({ set: 'test/guard', version: '1.0.0', sites: [HUB], pacing: { minRowIntervalMs: 1500, maxRowsPerRun: 2 } }), csvFile);
    check('사이트 제한: 밝힌 사이트는 그대로', g1.rep.rows[0]?.status === 'ok' && g1.rep.rows[0].values.제목 === 'A 페이지');
    check('사이트 제한: 밝히지 않은 사이트로 이동하면 그 행 실패', g1.rep.rows[1]?.status === 'failed' && /세트에 적히지 않은 사이트\(http:\/\/localhost:\d+\)로 이동하려 해 막았습니다/.test(g1.rep.rows[1].error ?? ''), g1.rep.rows[1]?.error);
    check('사이트 제한: 실패 스텝 기록', g1.rep.rows[1]?.failure?.stepId === 'n1');
    const end1 = g1.times.find((x) => x.row === 1 && x.status !== 'start')?.at;
    const start2 = g1.times.find((x) => x.row === 2 && x.status === 'start')?.at;
    check('행 간격: 행 사이 1.5초 이상 쉰다', start2 - end1 >= 1400, `${start2 - end1}ms`);
    check('행 수 상한: 2행에서 멈추고 이어서 할 행을 알려 준다', g1.rep.totals.rows === 2 && g1.rep.limit?.nextRow === 3 && /3행부터 1행은 실행하지 않았습니다/.test(g1.rep.error ?? ''), g1.rep.error);

    const popupRecipe = {
      schemaVersion: 1,
      name: '팝업 제한 시험',
      entryBlock: 'main',
      variables: [],
      origin: { set: 'test/guard', version: '1.0.0', sites: [HUB], pacing: { minRowIntervalMs: 0, maxRowsPerRun: 10 } },
      blocks: {
        main: [
          { id: 'p1', type: 'navigate', url: `${HUB}/site/start.html` },
          { id: 'p2', type: 'click', target: tgt([css('#out')], { tag: 'a', text: '밖으로' }) },
          { id: 'p3', type: 'wait', condition: { kind: 'textVisible', text: 'A 페이지' }, timeoutMs: 3000 },
        ],
      },
    };
    const g2 = await runGuard('guard-popup', popupRecipe);
    check('사이트 제한: 밝히지 않은 사이트로 여는 팝업도 막는다', g2.rep.rows[0]?.status === 'failed' && /막았습니다/.test(g2.rep.rows[0].error ?? ''), g2.rep.rows[0]?.error);
    const popupSame = structuredClone(popupRecipe);
    popupSame.blocks.main[1].target = tgt([css('#same')], { tag: 'a', text: '안으로' });
    const g3 = await runGuard('guard-popup-same', popupSame);
    check('사이트 제한: 같은 사이트 팝업은 된다', g3.rep.status === 'done', g3.rep.rows[0]?.error);
    const g4 = await runGuard('guard-none', navRecipe(null), csvFile);
    check('세트가 아닌 레시피는 그대로 (제한·간격·상한 없음)', g4.rep.status === 'done' && g4.rep.totals.ok === 3 && !/세트/.test(g4.rep.error ?? '') && !g4.rep.limit);

    // =====================================================================
    section('6. 화면: 허브 · 가져오기 · 예시로 실행 · 내보내기 마법사');
    const browser = await chromium.launch({ channel: 'msedge' });
    const errors = [];
    try {
      const pg = await browser.newPage({ viewport: { width: 1360, height: 900 } });
      pg.on('pageerror', (e) => errors.push(e.message));
      pg.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
      await pg.goto(`${BASE}/#/hub`);
      await pg.waitForSelector('.hub-card');
      check('화면 허브: 세트 카드 3개', (await pg.locator('.hub-card').count()) === 3);
      check('화면 허브: 설치됨·위험 배지', (await pg.locator('.hub-card', { hasText: '실험실 원장 합계' }).first().innerText()).includes('업데이트 있음'));
      await pg.screenshot({ path: path.join(SHOTS, 'hub.png'), fullPage: true });
      await pg.getByPlaceholder('이름·설명·태그·사이트·엑셀 열로 찾기').fill('future');
      check('화면 허브: 찾기', (await pg.locator('.hub-card').count()) === 1);
      await pg.getByPlaceholder('이름·설명·태그·사이트·엑셀 열로 찾기').fill('');
      await pg.goto(`${BASE}/#/hub?source=${encodeURIComponent(SRC)}&id=${encodeURIComponent('tak002/lab-ledger-total')}`);
      await pg.waitForSelector('.set-details');
      await pg.waitForSelector('.md h2');
      check('화면 상세: README·사이트·열·위험', (await pg.locator('.md').innerText()).includes('접속하는 사이트') && (await pg.locator('.set-details').innerText()).includes('매출 원장 조회와 설명서 내려받기'));
      await pg.getByRole('button', { name: '가져오기', exact: true }).click();
      await pg.waitForSelector('.set-import');
      const confirmText = await pg.locator('.set-import').innerText();
      check('화면 가져오기 확인: sha256·엔진·요약 문장', confirmText.includes('허브 목록의 sha256 과 같습니다') && confirmText.includes('실행할 수 있습니다') && confirmText.includes('에만 접속합니다') && confirmText.includes('파일을 저장합니다'));
      await pg.screenshot({ path: path.join(SHOTS, 'hub-detail.png'), fullPage: true });
      await pg.locator('.set-import button.primary').click();
      await pg.getByRole('link', { name: '▶ 예시로 실행' }).waitFor();
      check('화면 설치: 결과와 바로가기', (await pg.locator('.set-import').innerText()).includes('레시피 열기'));
      await pg.getByRole('link', { name: '▶ 예시로 실행' }).click();
      await pg.waitForSelector('text=2. 엑셀 데이터');
      await pg.waitForSelector('text=_예시.csv');
      check('화면 예시로 실행: 예시 입력을 골라 둔다', (await pg.locator('.badge.bad').count()) === 0 && (await pg.getByRole('button', { name: '▶ 실행 시작' }).isEnabled()) === true && (await pg.locator('main').innerText()).includes('에만 접속하고'));
      await pg.screenshot({ path: path.join(SHOTS, 'run-sample.png'), fullPage: true });

      // 세트 파일 가져오기 (화면)
      await pg.goto(`${BASE}/#/hub`);
      await pg.waitForSelector('.hub-card');
      await pg.locator('input[type=file][accept=".wrset"]').setInputFiles(path.join(OUT, built.fileName));
      await pg.waitForSelector('.set-import');
      check('화면 세트 파일 가져오기: 미리보기', (await pg.locator('.set-import').innerText()).includes('허브가 아닌 파일이라'));

      // 내보내기 마법사
      await pg.goto(`${BASE}/#/recipe/${imported.id}`);
      await pg.getByRole('button', { name: '세트로 내보내기' }).click();
      await pg.waitForSelector('.modal');
      await pg.locator('.modal label.field', { hasText: '무엇을 하는지' }).locator('textarea').fill('실험실 사이트에서 원장 합계를 읽어 옵니다.');
      await pg.locator('.modal label.field', { hasText: '만든 사람 이름' }).locator('input').fill('시험');
      await pg.locator('.modal label.field', { hasText: 'GitHub 아이디' }).locator('input').fill('tester-gh');
      check('마법사: GitHub 아이디로 세트 id 를 채운다', (await pg.locator('.modal label.field', { hasText: '세트 id' }).locator('input').inputValue()) === 'tester-gh/set');
      await pg.locator('.modal label.field', { hasText: '세트 id' }).locator('input').fill('tester-gh/lab-total');
      await pg.locator('.modal .site-row input').first().fill('원장 조회');
      await pg.getByRole('button', { name: '다음 →' }).click();
      check('마법사 2단계: 남은 값을 정해야 다음으로', await pg.getByRole('button', { name: '다음 →' }).isDisabled());
      await pg.getByRole('button', { name: '모두 그대로 둠' }).click();
      await pg.getByRole('button', { name: '다음 →' }).click();
      await pg.waitForSelector('text=실제 고객·거래처 정보는 넣지 마세요.');
      const firstCells = pg.locator('.modal tbody tr').first().locator('input');
      await firstCells.nth(0).fill('1111111111');
      await firstCells.nth(1).fill('H1');
      await pg.getByRole('button', { name: '다음 →' }).click();
      await pg.getByRole('button', { name: /초안 만들기/ }).click();
      await pg.getByRole('button', { name: '다음 →' }).click();
      await pg.waitForSelector('text=검사를 통과했습니다.');
      await pg.screenshot({ path: path.join(SHOTS, 'wizard.png') });
      const [dl] = await Promise.all([pg.waitForEvent('download'), pg.getByRole('button', { name: '⬇ 세트 파일 내려받기' }).click()]);
      const dlPath = path.join(OUT, dl.suggestedFilename());
      await dl.saveAs(dlPath);
      const exported = inspectSet(await fs.readFile(dlPath));
      check('마법사: 내려받은 세트가 검사를 통과', dl.suggestedFilename() === 'tester-gh-lab-total-1.0.0.wrset' && !exported.errors.length && exported.manifest.author.name === '시험', exported.errors.join(' / '));
      await pg.waitForSelector('text=CONTRIBUTING');
      check('마법사: 허브에 올리는 방법 안내', (await pg.locator('.modal').innerText()).includes('pull request'));

      // 모바일 폭
      const mb = await browser.newPage({ viewport: { width: 390, height: 844 } });
      mb.on('pageerror', (e) => errors.push(e.message));
      for (const [name, url, sel] of [
        ['m-hub', `${BASE}/#/hub`, '.hub-card'],
        ['m-hub-detail', `${BASE}/#/hub?source=${encodeURIComponent(SRC)}&id=${encodeURIComponent('tak002/lab-ledger-total')}`, '.set-details'],
        ['m-settings', `${BASE}/#/settings`, '.hub-src'],
      ]) {
        await mb.goto(url);
        await mb.waitForSelector(sel);
        await sleep(300);
        const sw = await mb.evaluate(() => document.documentElement.scrollWidth);
        check(`${name}: 가로 스크롤 없음`, sw <= 392, `scrollWidth=${sw}`);
        await mb.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
      }
      await mb.goto(`${BASE}/#/recipe/${imported.id}`);
      await mb.getByRole('button', { name: '세트로 내보내기' }).click();
      await mb.waitForSelector('.modal .site-row');
      const swm = await mb.evaluate(() => Math.max(document.documentElement.scrollWidth, document.querySelector('.modal-back').scrollWidth));
      check('m-wizard: 가로 스크롤 없음', swm <= 392, `scrollWidth=${swm}`);
      await mb.screenshot({ path: path.join(SHOTS, 'm-wizard.png') });
      check('화면 오류 없음', !errors.length, errors.join(' | '));
    } finally {
      await browser.close();
    }

    // =====================================================================
    section('7. 명령줄');
    const unpacked = path.join(OUT, 'unpacked');
    let c = await runCli(['set', 'unpack', built.fileName, '-o', 'unpacked']);
    check('set unpack', c.code === 0 && (await fs.stat(path.join(unpacked, 'manifest.json')).catch(() => null)), c.out);
    c = await runCli(['set', 'lint', 'unpacked']);
    check('set lint (폴더)', c.code === 0 && /검사 통과/.test(c.out), c.out);
    c = await runCli(['set', 'pack', 'unpacked', '-o', 'repacked.wrset']);
    const repacked = await fs.readFile(path.join(OUT, 'repacked.wrset')).catch(() => Buffer.alloc(0));
    check('set pack: 풀었다 다시 묶어도 같은 sha256', c.code === 0 && sha256(repacked) === built.sha256, c.out);
    const broken = path.join(OUT, 'broken');
    await fs.cp(unpacked, broken, { recursive: true });
    await fs.appendFile(path.join(broken, 'README.md'), '\n문의: 010-2345-6789\n');
    c = await runCli(['set', 'lint', 'broken']);
    check('set lint: 오류가 있으면 종료 코드 1', c.code === 1 && /휴대전화/.test(c.out), c.out);
    c = await runCli(['set', 'pack', 'broken', '-o', 'broken.wrset']);
    check('set pack: 오류가 있으면 묶지 않는다', c.code === 1 && !(await fs.stat(path.join(OUT, 'broken.wrset')).catch(() => null)));
    c = await runCli(['set', 'test', 'repacked.wrset']);
    check('set test: 비밀값이 없으면 사용법 오류', c.code === 2 && /--param 비밀번호=값/.test(c.out), c.out);
    c = await runCli(['set', 'test', 'repacked.wrset', '--param', `비밀번호=${LAB_USER.pw}`]);
    check('set test: 예시 실행 → expected.json 과 같음', c.code === 0 && /세트 시험 통과/.test(c.out), c.out.slice(-1500));
    const wrongExpected = path.join(OUT, 'wrong');
    await fs.cp(unpacked, wrongExpected, { recursive: true });
    const wrong = structuredClone(EXPECTED);
    wrong.rows['1111111111'].values.합계.equals = '0원';
    await fs.writeFile(path.join(wrongExpected, 'expected.json'), JSON.stringify(wrong, null, 2));
    c = await runCli(['set', 'test', 'wrong', '--param', `비밀번호=${LAB_USER.pw}`]);
    check('set test: 기대 결과와 다르면 종료 코드 1', c.code === 1 && /기대 "0원"/.test(c.out), c.out.slice(-800));
    c = await runCli(['hub', 'list', '--workspace', 'ws']);
    check('hub list', c.code === 0 && /tak002\/lab-ledger-total@1\.1\.0/.test(c.out) && /\[(설치됨|업데이트 있음)/.test(c.out), c.out);
    const wsCli = path.join(OUT, 'ws-cli');
    await fs.mkdir(wsCli, { recursive: true });
    await fs.writeFile(path.join(wsCli, 'settings.json'), JSON.stringify({ hubSources: [{ name: '시험 허브', url: SRC }] }));
    c = await runCli(['hub', 'install', 'tak002/future-set', '--workspace', 'ws-cli']);
    check('hub install: 엔진 범위가 안 맞으면 실패', c.code === 1 && /에서 동작합니다/.test(c.out), c.out);
    c = await runCli(['hub', 'install', 'tak002/tampered', '--workspace', 'ws-cli']);
    check('hub install: sha256 이 다르면 실패', c.code === 1 && /sha256/.test(c.out), c.out);
    c = await runCli(['hub', 'install', 'tak002/lab-ledger-total@1.0.0', '--workspace', 'ws-cli']);
    const cliReg = JSON.parse(await fs.readFile(path.join(wsCli, 'sets', 'installed.json'), 'utf8').catch(() => '{}'));
    check('hub install <id>@버전', c.code === 0 && cliReg.sets?.['tak002/lab-ledger-total']?.version === '1.0.0', c.out);
    c = await runCli(['set', 'install', 'repacked.wrset', '--workspace', 'ws-cli']);
    check('set install: 같은 세트는 같은 레시피로', c.code === 0 && /설치했습니다|로 바꿨습니다/.test(c.out), c.out);
  } finally {
    server?.kill();
    lab.close();
    hub.server.close();
  }

  console.log(`\n세트 시험: ${passed}/${passed + failures.length} 통과`);
  if (failures.length) {
    for (const f of failures) console.log(`  ❌ ${f}`);
    process.exit(1);
  }
  console.log('✅ 세트·허브 점검 통과');
}

main().catch((e) => {
  console.error('\n❌ 세트·허브 점검 실패:', e);
  process.exit(1);
});
