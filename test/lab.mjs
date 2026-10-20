// RPA 실험실 종합 시험 (실제 브라우저 + 실행 화면 동영상).
//   A. 녹화 → 녹화된 레시피 그대로 재생 (다운로드 9종·팝업·업로드·대화상자·iframe·shadow DOM 녹화가 제대로 되는지)
//   B. 엑셀 3행 재생 (2행은 일부러 실패) — 받은 파일 내용·서버가 받은 저장 요청까지 대조
//   C. 월별 고지서 — 특정 월 / 직전 월(날짜 토큰) / 최신 / 미납만, 새 달이 올라오기 전·후, 정렬이 바뀐 경우
// 실행: node test/lab.mjs [--headed] [--only=A,B,C] [--no-video]
// 결과: test/out-lab/<headless|headed>/<시나리오>/… , results.json

import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import { Recorder } from '../src/recorder/recorder.js';
import { Runner } from '../src/engine/runner.js';
import { recipeProblems } from '../src/recipe.js';
import { stepText } from '../public/shared/steps.js';
import { startLab, LAB_USER, MANUAL_TEXT, BIG_SIZE, bigFile, ledgerRows, sha256, ymLabel } from './lab-server.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const HEADED = argv.includes('--headed');
const VIDEO = !argv.includes('--no-video');
const ONLY = (argv.find((a) => a.startsWith('--only='))?.slice(7) ?? 'A,B,C').split(',');
const OUT = path.join(ROOT, 'test', 'out-lab', HEADED ? 'headed' : 'headless'); // e2e 가 test/out 을 통째로 지우므로 따로 둔다
const PROFILE = path.join(OUT, 'profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 결과 기록 ----------
const results = { startedAt: new Date().toISOString(), headed: HEADED, browser: process.env.WEB_RPA_BROWSER || 'auto', scenarios: {} };
let cur = null;
function scenario(key, title) {
  cur = results.scenarios[key] = { title, checks: [], runs: [], notes: [] };
  console.log(`\n==================== ${key}. ${title}`);
}
function check(name, ok, detail = '') {
  cur.checks.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  return !!ok;
}
const note = (s) => {
  cur.notes.push(s);
  console.log(`  📝 ${s}`);
};

// ---------- 타겟 만들기 (녹화기가 만드는 모양과 같게) ----------
const css = (value, score = 90) => ({ kind: 'css', value, score });
const xpath = (value, score = 80) => ({ kind: 'xpath', value, score });
const text = (tag, t, score = 70) => ({ kind: 'text', value: { tag, text: t }, score });
const tgt = (candidates, meta = {}, framePath = []) => ({ framePath, candidates, meta });
let seq = 0;
const step = (type, fields = {}) => ({ id: `t${(seq += 1)}`, type, ...fields });

async function runRecipe(name, recipe, { excelPath, params = {}, dir }) {
  const problems = recipeProblems(recipe);
  if (problems.length) throw new Error(`레시피 문제: ${problems.join(' / ')}`);
  const runDir = path.join(OUT, dir);
  await fs.rm(runDir, { recursive: true, force: true });
  const runner = new Runner({ recipe, runId: dir, runDir, profileDir: PROFILE, excelPath, params, options: { headless: !HEADED, recordVideo: VIDEO } });
  runner.on('log', ({ line }) => console.log(`    ${line}`));
  const t0 = Date.now();
  const report = await runner.start();
  const videos = (await fs.readdir(path.join(runDir, 'video')).catch(() => [])).filter((f) => f.endsWith('.webm')).map((f) => path.join(dir, 'video', f));
  const run = { name, dir, status: report.status, totals: report.totals, seconds: Math.round((Date.now() - t0) / 100) / 10, videos, rows: report.rows };
  cur.runs.push(run);
  await fs.writeFile(path.join(runDir, 'recipe.json'), JSON.stringify(recipe, null, 2));
  return { report, runDir };
}

async function labEvents(base) {
  return (await (await fetch(`${base}/api/events`)).json()).events;
}
async function labState(base, s) {
  await fetch(`${base}/api/admin/state`, { method: 'POST', body: JSON.stringify(s) });
}

/** 로그인 화면이면 로그인 (같은 브라우저에서 두 번째 행부터는 이미 로그인돼 있다). */
function loginBlock() {
  return [
    step('input', { target: tgt([css('#uid', 100)], { tag: 'input', label: '아이디' }), value: '{{아이디}}' }),
    step('input', { target: tgt([css('#upw', 100)], { tag: 'input', type: 'password', label: '비밀번호' }), value: '{{비밀번호}}' }),
    step('click', { target: tgt([text('button', '로그인')], { tag: 'button', text: '로그인' }) }),
    step('wait', { condition: { kind: 'urlContains', value: '.html' }, timeoutMs: 10000 }),
  ];
}
const loginVars = (base) => [
  { id: '실험실', name: '실험실', source: { kind: 'static', value: base } },
  { id: '아이디', name: '아이디', source: { kind: 'static', value: LAB_USER.id } },
  { id: '비밀번호', name: '비밀번호', source: { kind: 'prompt', secret: true } },
];

async function writeXlsx(file, headers, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('입력');
  ws.addRow(headers);
  for (const r of rows) ws.addRow(headers.map((h) => r[h] ?? ''));
  await wb.xlsx.writeFile(file);
}

async function makeInputs(biz) {
  const dir = path.join(OUT, 'inputs');
  await fs.mkdir(dir, { recursive: true });
  const f1 = path.join(dir, `증빙_${biz}.txt`);
  await fs.writeFile(f1, `증빙 자료 ${biz}\r\n${new Date().toISOString()}\r\n`);
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]);
  doc.setTitle(`biz ${biz}`);
  const f2 = path.join(dir, `사업자등록증_${biz}.pdf`);
  await fs.writeFile(f2, await doc.save());
  return { f1, f2, sha1: sha256(await fs.readFile(f1)), sha2: sha256(await fs.readFile(f2)) };
}

/** 받은 파일 9종의 이름·내용을 확인한다. */
async function verifyDownloads(prefix, filesDir, rowFiles, biz, period) {
  const names = rowFiles.map((f) => path.basename(f));
  const find = (re) => names.find((n) => re.test(n));
  const read = (n) => fs.readFile(path.join(filesDir, n));
  const total = ledgerRows(biz, period).reduce((s, r) => s + r.amount, 0);

  let n = find(/^사용설명서( \(\d+\))?\.txt$/);
  check(`${prefix} ① 링크 다운로드`, n && (await read(n)).toString() === MANUAL_TEXT, n ?? '파일 없음');
  n = find(new RegExp(`^매출장_${biz}_${period}( \\(\\d+\\))?\\.xlsx$`));
  let xlsxOk = false;
  if (n) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await read(n));
    const ws = wb.worksheets[0];
    xlsxOk = String(ws.getCell('A2').value) === biz && ws.rowCount === 4;
  }
  check(`${prefix} ② 폼 POST 엑셀 (한글 파일명, xlsx 내용)`, xlsxOk, n ?? '파일 없음');
  n = find(new RegExp(`^ledger_${biz}( \\(\\d+\\))?\\.csv$`));
  check(`${prefix} ③ Blob CSV`, n && (await read(n)).toString().includes('가나상사'), n ?? '파일 없음');
  n = find(new RegExp(`^납세증명서_${biz}( \\(\\d+\\))?\\.pdf$`));
  let pdfPages = 0;
  if (n) pdfPages = (await PDFDocument.load(await read(n))).getPageCount();
  check(`${prefix} ④ 확인창 → PDF`, pdfPages === 1, n ?? '파일 없음');
  n = find(new RegExp(`^대용량_${biz}( \\(\\d+\\))?\\.bin$`));
  let bigOk = false;
  if (n) {
    const b = await read(n);
    bigOk = b.length === BIG_SIZE && sha256(b) === sha256(bigFile(biz));
  }
  check(`${prefix} ⑤ 늦게 생기는 3MB 파일 (크기·해시 일치)`, bigOk, n ?? '파일 없음');
  n = find(new RegExp(`^popup_${biz}( \\(\\d+\\))?\\.csv$`));
  check(`${prefix} ⑥ 새 창 다운로드`, n && (await read(n)).toString().includes(biz), n ?? '파일 없음');
  n = find(new RegExp(`^frame_${biz}( \\(\\d+\\))?\\.txt$`));
  check(`${prefix} ⑦ iframe 안 다운로드`, n && (await read(n)).toString().includes(biz), n ?? '파일 없음');
  n = find(/^data-url( \(\d+\))?\.csv$/);
  check(`${prefix} ⑧ data URL`, n && (await read(n)).toString().includes(`${biz},${total}`), n ?? '파일 없음');
  n = find(new RegExp(`^blank_${biz}( \\(\\d+\\))?\\.txt$`));
  check(`${prefix} ⑨ target=_blank 새 탭 다운로드`, n && (await read(n)).toString().includes(biz), n ?? '파일 없음');
}

function verifySave(prefix, events, biz, exp) {
  const saves = events.filter((e) => e.type === 'save' && e.fields.biz === biz);
  check(`${prefix} 저장 요청이 정확히 1번 (이중 제출 없음)`, saves.length === 1, `${saves.length}번`);
  const s = saves[0];
  if (!s) return;
  const f = s.fields;
  check(`${prefix} 팝업 검색 → 더블클릭 선택 값이 원래 창에 들어감`, f.partnerCode === exp.partnerCode, `${f.partnerCode} ${f.partnerName}`);
  check(`${prefix} 마스크 전화번호`, f.tel.replace(/\D/g, '') === exp.tel.replace(/\D/g, ''), f.tel);
  check(`${prefix} 날짜 입력칸`, f.supplyDate === exp.supplyDate, f.supplyDate);
  check(`${prefix} 라디오`, f.taxType === exp.taxType, f.taxType);
  check(`${prefix} 숨은 커스텀 체크박스`, f.agree === 'true', f.agree);
  if (exp.memo) check(`${prefix} 텍스트 영역 + 날짜 토큰`, f.memo === exp.memo, f.memo);
  check(`${prefix} prompt 대화상자 입력값`, f.reason === exp.reason, f.reason);
  check(`${prefix} 2중 iframe 입력·클릭`, f.verifyCode === exp.verifyCode, f.verifyCode);
  check(`${prefix} shadow DOM 버튼`, f.helpOpened === 'true', f.helpOpened);
  const file1 = s.files.find((x) => x.field === 'file1');
  const file2 = s.files.find((x) => x.field === 'file2');
  check(`${prefix} 파일 첨부 (보이는 input)`, file1?.sha === exp.sha1, file1 ? `${file1.name} ${file1.size}B` : '없음');
  check(`${prefix} 파일 첨부 (버튼 → 파일 선택창)`, file2?.sha === exp.sha2, file2 ? `${file2.name} ${file2.size}B` : '없음');
  const reviews = events.filter((e) => e.type === 'review' && e.receipt === s.receipt).length;
  check(`${prefix} 조건 분기 (검토 필요일 때만 검토 요청)`, reviews === (s.review ? 1 : 0), `검토필요=${s.review}, 요청 ${reviews}번`);
}

// =====================================================================
// A. 녹화 → 그대로 재생
// =====================================================================
function nextDownload(context, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const pages = new Set();
    const on = (d) => {
      done();
      resolve(d);
    };
    const attach = (p) => {
      if (pages.has(p)) return;
      pages.add(p);
      p.on('download', on);
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error('녹화 중 다운로드가 시작되지 않음'));
    }, timeout);
    function done() {
      clearTimeout(timer);
      context.off('page', attach);
      for (const p of pages) p.off('download', on);
    }
    context.pages().forEach(attach);
    context.on('page', attach);
  });
}

async function scenarioA(base) {
  scenario('A', '녹화 → 녹화된 레시피 그대로 재생');
  const biz = '2468013579';
  const inputs = await makeInputs(biz);
  await fs.rm(PROFILE, { recursive: true, force: true });
  const rec = new Recorder({ name: '실험실 녹화', startUrl: `${base}/ledger.html`, profileDir: PROFILE, headless: !HEADED });
  const warnings = [];
  rec.on('warn', (w) => warnings.push(w));
  await rec.start();
  let recipe;
  try {
    recipe = await recordA(rec, biz, inputs);
  } finally {
    if (rec.state !== 'stopped') await rec.stop().catch(() => {});
  }
  await checkRecordedA(base, recipe, biz, inputs, warnings);
}

async function recordA(rec, biz, inputs) {
  const ctx = rec.ctx;
  const page = ctx.pages()[0];
  const answer = (d) => (d.type() === 'prompt' ? d.accept('정기 점검') : d.accept()).catch(() => {});
  page.on('dialog', answer);

  await page.waitForSelector('#uid');
  await page.getByLabel('아이디').fill(LAB_USER.id);
  await page.getByLabel('비밀번호').fill(LAB_USER.pw);
  await page.getByRole('button', { name: '로그인' }).click();
  await page.waitForSelector('text=매출 원장 조회');
  await page.getByLabel('사업자번호').fill(biz);
  await page.getByLabel('기간').selectOption({ label: '2026년 1기 (1~6월)' });
  await page.getByLabel('사업자번호').press('Enter');
  await page.waitForSelector('text=조회 완료');
  const dl = async (fn) => {
    const w = nextDownload(ctx);
    await fn();
    await (await w).path();
    await sleep(400);
  };
  await dl(() => page.getByText('① 사용 설명서 받기').click());
  await dl(() => page.getByRole('button', { name: '② 엑셀 다운로드' }).click());
  await dl(() => page.getByRole('button', { name: '③ CSV 내려받기 (브라우저 생성)' }).click());
  await dl(() => page.getByRole('button', { name: '④ 증명서 발급' }).click());
  await page.getByRole('button', { name: '⑤ 대용량 자료 요청' }).click();
  await page.waitForSelector('text=생성 완료');
  await dl(() => page.getByText('대용량 자료 받기').click());
  await dl(() => page.getByRole('button', { name: '⑥ 새 창에서 받기' }).click());
  await sleep(3800); // 새 창이 스스로 닫힐 때까지
  await dl(() => page.frameLocator('iframe[name=dlframe]').getByText('⑦ 프레임 안 자료 받기').click());
  await dl(() => page.getByText('⑧ data URL 받기').click());
  await dl(() => page.getByText('⑨ 새 탭 링크로 받기').click());
  await sleep(800);
  await page.getByText('입력 작업으로 이동 →').click();
  await page.waitForSelector('text=거래처 등록');
  const [popup] = await Promise.all([ctx.waitForEvent('page'), page.getByRole('button', { name: '거래처 검색' }).click()]);
  await popup.waitForLoadState();
  await popup.getByLabel('거래처명').fill('다라상사');
  await popup.getByLabel('거래처명').press('Enter');
  await popup.waitForSelector('td:text-is("다라상사")');
  // 더블클릭과 동시에 창이 닫혀 Playwright 쪽 호출은 "닫힘" 오류로 끝난다
  await Promise.all([popup.waitForEvent('close'), popup.locator('td:text-is("다라상사")').dblclick().catch(() => {})]);
  await page.getByLabel('담당자 전화').fill('01012345678');
  await page.getByLabel('공급일자').fill('2026-10-19');
  await page.getByLabel('과세', { exact: true }).check();
  await page.getByText('개인정보 수집에 동의합니다').click();
  await page.getByLabel('비고').fill('녹화 시험');
  await page.getByLabel('증빙 파일').setInputFiles(inputs.f1);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: '파일 찾기…' }).click()]);
  await chooser.setFiles(inputs.f2);
  await page.getByRole('button', { name: '도움말 보기' }).click();
  const inner = page.frameLocator('iframe[name=verify]').frameLocator('iframe[name=inner]');
  await inner.getByLabel('확인 코드').fill('123456');
  await inner.getByRole('button', { name: '코드 확인' }).click();
  await sleep(300);
  await page.getByRole('button', { name: '저장' }).click();
  await page.waitForSelector('text=저장 완료');
  await page.getByRole('button', { name: '검토 요청' }).click(); // 끝자리 9 → 검토 필요
  await sleep(800);
  return rec.stop();
}

async function checkRecordedA(base, recipe, biz, inputs, warnings) {
  const steps = recipe.blocks.main;
  cur.recordedSteps = steps.map((s, i) => `${String(i + 1).padStart(2)}. ${stepText(s)}`);
  console.log(cur.recordedSteps.join('\n'));
  const count = (t) => steps.filter((s) => s.type === t).length;
  check('녹화: 다운로드 9종이 모두 "다운로드 저장" 스텝으로 기록됨', count('download') === 9, `${count('download')}개`);
  check('녹화: 파일 첨부 2건이 "파일 첨부" 스텝으로 기록됨', count('upload') === 2, `${count('upload')}개`);
  check('녹화: 팝업 행 더블클릭', count('dblclick') === 1, `${count('dblclick')}개`);
  check('녹화: Enter 키 2건 (조회, 팝업 검색)', count('keypress') === 2, `${count('keypress')}개`);
  const dialogs = steps.filter((s) => s.type === 'dialog');
  check('녹화: 대화상자 4건 (증명서 확인, 사유 입력, 저장 확인, 검토 알림)', dialogs.length === 4, dialogs.map((d) => `${d.meta.dialogType}:${d.action}`).join(', '));
  check('녹화: prompt 입력값이 기록됨', dialogs.some((d) => d.promptText === '정기 점검'));
  check('녹화: 비밀번호는 레시피에 남지 않고 실행 때 입력받는 변수로', recipe.variables.some((v) => v.source.kind === 'prompt' && v.source.secret) && !JSON.stringify(recipe).includes(LAB_USER.pw));
  const fileClick = steps.find((s) => s.type === 'click' && /파일 찾기/.test(stepText(s)));
  if (fileClick) note('녹화 결과에 "파일 찾기…" 버튼 클릭이 별도 스텝으로 남음 → 재생 때 실제 파일 선택창을 띄울 수 있다 (아래 재생 결과로 확인)');
  if (warnings.length) note(`녹화 경고: ${warnings.join(' / ')}`);
  await fs.mkdir(path.join(OUT, 'A'), { recursive: true });
  await fs.writeFile(path.join(OUT, 'A', 'recorded.json'), JSON.stringify(recipe, null, 2));

  // ---- 녹화된 그대로 재생: 사람이 편집기에서 하는 일은 첨부 파일 경로 지정뿐 ----
  const replay = structuredClone(recipe);
  const ups = replay.blocks.main.filter((s) => s.type === 'upload');
  if (ups[0]) ups[0].path = inputs.f1;
  if (ups[1]) ups[1].path = inputs.f2;
  const secret = recipe.variables.find((v) => v.source.secret);
  const before = (await labEvents(base)).length;
  const { report, runDir } = await runRecipe('녹화 그대로 재생', replay, { params: { [secret.id]: LAB_USER.pw }, dir: 'A/replay' });
  const row = report.rows[0];
  check('재생: 전체 성공', report.status === 'done', row?.error ?? '');
  if (row?.status === 'ok') await verifyDownloads('재생:', path.join(runDir, 'files'), row.files, biz, 'H1');
  const ev = (await labEvents(base)).slice(before);
  verifySave('재생:', ev, biz, { partnerCode: 'P002', tel: '01012345678', supplyDate: '2026-10-19', taxType: 'T', reason: '정기 점검', verifyCode: '123456', sha1: inputs.sha1, sha2: inputs.sha2, memo: '녹화 시험' });
  const log = await fs.readFile(path.join(runDir, 'log.txt'), 'utf8');
  const tabSwitch = (log.match(/탭으로 전환/g) ?? []).length;
  if (tabSwitch) note(`재생 중 탭 전환 ${tabSwitch}번 (팝업 → 원래 창 복귀 등)`);
}

// =====================================================================
// B. 엑셀 3행 (손으로 쓴 레시피: 대기·값 읽기·확인·분기·캡처·PDF 포함)
// =====================================================================
function recipeB(base) {
  seq = 0;
  const L = { url: `${base}/ledger.html` };
  const W = { url: `${base}/work.html` };
  const bizTarget = tgt([css('#biz_1234567', 45), css('input[id^="biz_"]', 50)], { tag: 'input', label: '사업자번호' });
  const main = [
    step('navigate', { url: '{{실험실}}/ledger.html' }),
    step('branch', { condition: { kind: 'exists', target: tgt([css('#uid', 100)], { tag: 'input' }) }, then: 'login' }),
    step('input', { target: bizTarget, value: '{{사업자번호}}', meta: L }),
    step('select', { target: tgt([css('#period', 100)], { tag: 'select', label: '기간' }), value: '{{기간}}', meta: L }),
    step('keypress', { key: 'Enter', target: bizTarget, meta: L }),
    step('wait', { condition: { kind: 'textVisible', text: '조회 완료' }, timeoutMs: 8000 }),
    step('extract', { target: tgt([css('#total', 100)], { tag: 'b' }), attr: 'data-total', saveAs: '합계', meta: L }),
    step('extract', { target: tgt([css('#status', 100)], { tag: 'div' }), saveAs: '조회상태', meta: L }),
    step('assert', { condition: { kind: 'textVisible', text: '마바상사' }, message: '조회 결과에 거래처가 없습니다' }),
    step('screenshot', { fileName: '{{row}}_{{사업자번호}}_1_조회결과.png' }),
    step('download', { target: tgt([text('a', '① 사용 설명서 받기')], { tag: 'a' }), meta: L }),
    step('download', { target: tgt([text('button', '② 엑셀 다운로드')], { tag: 'button' }), meta: L }),
    step('download', { target: tgt([css('#btnBlob', 100)], { tag: 'button' }), meta: L }),
    step('dialog', { action: 'accept' }),
    step('download', { target: tgt([css('#btnCert', 100)], { tag: 'button' }), meta: L }),
    step('click', { target: tgt([css('#btnJob', 100)], { tag: 'button' }), meta: L }),
    step('wait', { condition: { kind: 'textVisible', text: '생성 완료' }, timeoutMs: 15000 }),
    step('download', { target: tgt([css('#job_1a2b3c4d', 100), text('a', '대용량 자료 받기')], { tag: 'a' }), meta: L }),
    step('download', { target: tgt([css('#btnPopup', 100)], { tag: 'button' }), meta: L }),
    step('download', { target: tgt([css('#fl', 100)], { tag: 'a' }, [{ name: 'dlframe' }]), meta: L }),
    step('download', { target: tgt([css('#dataLink', 100)], { tag: 'a' }), meta: L }),
    step('download', { target: tgt([css('#blankLink', 100)], { tag: 'a' }), meta: L }),
    step('screenshot', { fileName: '{{row}}_{{사업자번호}}_2_다운로드후.png' }),
    step('click', { target: tgt([css('#toWork', 100)], { tag: 'a' }), meta: L }),
    step('click', { target: tgt([text('button', '거래처 검색')], { tag: 'button' }), meta: W }),
    step('input', { target: tgt([css('#q', 100)], { tag: 'input', label: '거래처명' }), value: '{{거래처}}' }),
    step('keypress', { key: 'Enter', target: tgt([css('#q', 100)], { tag: 'input' }) }),
    step('dblclick', { target: tgt([text('td', '{{거래처}}')], { tag: 'td' }) }),
    step('input', { target: tgt([css('#tel', 100)], { tag: 'input', label: '담당자 전화' }), value: '{{전화}}', meta: W }),
    step('input', { target: tgt([css('#supplyDate', 100)], { tag: 'input', type: 'date' }), value: '{{공급일자}}', meta: W }),
    step('check', { target: tgt([xpath("//label[normalize-space()='{{과세구분}}']/input")], { tag: 'input', type: 'radio' }), checked: true, meta: W }),
    step('check', { target: tgt([css('#agree', 100)], { tag: 'input', type: 'checkbox' }), checked: true, meta: W }),
    step('input', { target: tgt([css('#memo', 100)], { tag: 'textarea' }), value: '{{사업자번호|digits}} 자동 입력 {{sys:date:YYYY-MM-DD}}', meta: W }),
    step('upload', { target: tgt([css('#file1', 100)], { tag: 'input', type: 'file' }), path: '{{증빙파일}}', meta: W }),
    step('upload', { target: tgt([text('button', '파일 찾기…')], { tag: 'button' }), path: '{{등록증파일}}', meta: W }),
    step('click', { target: tgt([text('button', '도움말 보기')], { tag: 'button', inShadow: true }), meta: W }),
    step('input', { target: tgt([css('#code', 100)], { tag: 'input' }, [{ name: 'verify' }, { name: 'inner' }]), value: '{{확인코드}}' }),
    step('click', { target: tgt([css('#btnVerify', 100)], { tag: 'button' }, [{ name: 'verify' }, { name: 'inner' }]) }),
    step('wait', { condition: { kind: 'textVisible', text: '확인 완료' } }),
    step('dialog', { action: 'accept', promptText: '{{사유}}' }),
    step('dialog', { action: 'accept' }),
    step('click', { target: tgt([css('#btnSave', 100)], { tag: 'button' }), meta: W }),
    step('wait', { condition: { kind: 'textVisible', text: '저장 완료' }, timeoutMs: 10000 }),
    step('extract', { target: tgt([css('[id^="receipt_"]', 50)], { tag: 'p' }), attr: 'data-receipt', saveAs: '접수번호', meta: W }),
    step('branch', { condition: { kind: 'textVisible', text: '검토 필요', exact: true }, then: 'review' }),
    step('screenshot', { fileName: '{{row}}_{{사업자번호}}_3_저장완료.png' }),
    step('pdf', { fileName: '{{사업자번호}}_저장결과_{{sys:date:YYYYMMDD}}.pdf' }),
  ];
  const review = [
    step('dialog', { action: 'accept' }),
    step('click', { target: tgt([css('#btnReview', 100)], { tag: 'button' }), meta: W }),
    step('assert', { condition: { kind: 'dialogContains', value: '검토 요청이 접수' }, timeoutMs: 5000, message: '검토 요청 알림이 뜨지 않았습니다' }),
  ];
  const excelCols = ['사업자번호', '기간', '거래처', '전화', '공급일자', '과세구분', '확인코드', '사유', '증빙파일', '등록증파일'];
  return {
    schemaVersion: 1,
    id: 'lab-b',
    name: '실험실 B · 엑셀 행 반복 종합',
    startUrl: `${base}/ledger.html`,
    variables: [...loginVars(base), ...excelCols.map((c) => ({ id: c, name: c, source: { kind: 'excel', column: c } }))],
    entryBlock: 'main',
    blocks: { main, login: loginBlock(), review },
    loop: { onRowError: 'skip' },
  };
}

async function scenarioB(base) {
  scenario('B', '엑셀 3행 반복 (다운로드 9종 · 팝업 · 첨부 · 대화상자 · iframe · 분기, 2행은 일부러 실패)');
  const rows = [
    { 사업자번호: '1234567891', 기간: '2026년 1기 (1~6월)', 거래처: '다라상사', 전화: '01012345678', 공급일자: '2026-10-19', 과세구분: '과세', 확인코드: '123456', 사유: '정기 점검', period: 'H1', code: 'P002', tax: 'T' },
    { 사업자번호: '', 기간: '2026년 1기 (1~6월)', 거래처: '가나상사', 전화: '01000000000', 공급일자: '2026-10-19', 과세구분: '과세', 확인코드: '111111', 사유: '빈 번호' },
    { 사업자번호: '0987654320', 기간: '2026년 2기(7~12월)', 거래처: '사아상사', 전화: '010-9876-5432', 공급일자: '2026-09-30', 과세구분: '면세', 확인코드: '654321', 사유: '거래처 변경', period: 'H2', code: 'P004', tax: 'F' },
  ];
  for (const r of rows) {
    const inp = await makeInputs(r.사업자번호 || 'empty');
    Object.assign(r, { 증빙파일: inp.f1, 등록증파일: inp.f2, sha1: inp.sha1, sha2: inp.sha2 });
  }
  await fs.mkdir(path.join(OUT, 'B'), { recursive: true });
  const excelPath = path.join(OUT, 'B', 'input.xlsx');
  await writeXlsx(excelPath, ['사업자번호', '기간', '거래처', '전화', '공급일자', '과세구분', '확인코드', '사유', '증빙파일', '등록증파일'], rows);
  const before = (await labEvents(base)).length;
  const { report, runDir } = await runRecipe('엑셀 3행', recipeB(base), { excelPath, params: { 비밀번호: LAB_USER.pw }, dir: 'B/run' });
  const ev = (await labEvents(base)).slice(before);

  check('3행 처리, 1·3행 성공, 2행 실패', report.totals.rows === 3 && report.totals.ok === 2 && report.rows[1]?.status === 'failed', JSON.stringify(report.totals));
  check('실패가 있으면 전체 상태는 "실패 있음"', report.status === 'failed', report.status);
  check('2행 실패 사유가 리포트에 남음', /조회 완료|사업자번호/.test(report.rows[1]?.error ?? '') || !!report.rows[1]?.failure, report.rows[1]?.error);
  check('2행 실패 화면 캡처', !!report.rows[1]?.screenshot && (await fs.stat(path.join(runDir, report.rows[1].screenshot)).catch(() => null)), report.rows[1]?.screenshot);
  check('앞자리 0 사업자번호 보존 (0987654320)', report.rows[2]?.input?.사업자번호 === '0987654320', report.rows[2]?.input?.사업자번호);
  for (const i of [0, 2]) {
    const r = rows[i];
    const row = report.rows[i];
    const p = `${i + 1}행:`;
    if (row?.status !== 'ok') {
      check(`${p} 성공`, false, row?.error);
      continue;
    }
    const total = ledgerRows(r.사업자번호, r.period).reduce((s, x) => s + x.amount, 0);
    check(`${p} 값 읽기 (속성) 합계`, row.values.합계 === String(total), row.values.합계);
    check(`${p} 값 읽기 (글자) 조회상태`, row.values.조회상태 === '조회 완료 (3건)', row.values.조회상태);
    check(`${p} 값 읽기 접수번호`, /^R-\d{4}$/.test(row.values.접수번호 ?? ''), row.values.접수번호);
    await verifyDownloads(p, path.join(runDir, 'files'), row.files, r.사업자번호, r.period);
    const shots = row.files.filter((f) => f.endsWith('.png'));
    const pdfs = row.files.filter((f) => f.endsWith('.pdf') && f.includes('저장결과'));
    check(`${p} 화면 캡처 3장`, shots.length === 3, shots.map((s) => path.basename(s)).join(', '));
    check(`${p} PDF 저장 (이름 규칙 {{사업자번호}}_저장결과_{{날짜}})`, pdfs.length === 1, pdfs.map((s) => path.basename(s)).join(', '));
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; // {{sys:date}} 은 현지 날짜
    verifySave(p, ev, r.사업자번호, { partnerCode: r.code, tel: r.전화, supplyDate: r.공급일자, taxType: r.tax, reason: r.사유, verifyCode: r.확인코드, sha1: r.sha1, sha2: r.sha2, memo: `${r.사업자번호} 자동 입력 ${today}` });
    const exports = ev.filter((e) => e.type === 'export' && e.biz === r.사업자번호).length;
    check(`${p} 엑셀 내보내기 요청 1번`, exports === 1, `${exports}번`);
  }
  check('2행(빈 번호)은 서버에 저장 요청이 가지 않음', !ev.some((e) => e.type === 'save' && !e.fields.biz));
  for (const f of ['report.json', 'rows.csv', 'log.txt', 'results.xlsx']) check(`리포트 파일 ${f}`, await fs.stat(path.join(runDir, f)).catch(() => null));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(runDir, 'results.xlsx'));
  const head = wb.worksheets[0].getRow(1).values.filter(Boolean).map(String);
  check('결과 엑셀에 읽은 값 열(합계·조회상태·접수번호)이 붙음', ['합계', '조회상태', '접수번호'].every((h) => head.includes(h)), head.join(', '));
  const log = await fs.readFile(path.join(runDir, 'log.txt'), 'utf8');
  for (const m of new Set(log.match(/(재시도[^\r\n]*|[^\r\n]*탭으로 전환[^\r\n]*|[^\r\n]*스크립트 클릭[^\r\n]*)/g) ?? [])) note(`실행 로그: ${m.replace(/^\[[^\]]+\]\s*/, '')}`);
}

// =====================================================================
// C. 월별 고지서: 새 달이 올라오기 전·후
// =====================================================================
function nhisRecipe(base, { id, name, pick, monthVar, excel }) {
  seq = 0;
  const N = { url: `${base}/nhis.html` };
  const rowOf = (ym) => `//table[@id='bills']//tr[td[1][normalize-space()='${ym}']]`;
  const main = [
    step('navigate', { url: '{{실험실}}/nhis.html' }),
    step('branch', { condition: { kind: 'exists', target: tgt([css('#uid', 100)], { tag: 'input' }) }, then: 'login' }),
    step('wait', { condition: { kind: 'textVisible', text: '고지서 받기' }, timeoutMs: 8000 }),
    step('extract', { target: tgt([css('#summary', 100)], { tag: 'span' }), saveAs: '목록요약', meta: N }),
  ];
  const blocks = { main, login: loginBlock() };
  if (monthVar) {
    // 특정 월: 그 달 행이 있으면 받고, 없으면 "없음" 화면을 남기고 넘어간다 (행 실패로 만들지 않음)
    main.push(step('branch', { condition: { kind: 'exists', target: tgt([xpath(`${rowOf(monthVar)}//button`)], { tag: 'button' }) }, then: 'get', else: 'missing' }));
    blocks.get = [
      step('extract', { target: tgt([xpath(`${rowOf(monthVar)}/td[2]`)], { tag: 'td' }), saveAs: '보험료', meta: N }),
      step('download', { target: tgt([xpath(`${rowOf(monthVar)}//button`)], { tag: 'button' }), meta: N }),
    ];
    blocks.missing = [
      step('screenshot', { fileName: '없음_{{row}}.png' }),
      step('assert', { condition: { kind: 'textVisible', text: monthVar, exact: true }, onFail: 'warn', message: '대상 월 고지서가 아직 올라오지 않았습니다' }),
    ];
  } else {
    main.push(
      step('extract', { target: tgt([xpath(`${pick}/td[1]`)], { tag: 'td' }), saveAs: '받은월', meta: N }),
      step('download', { target: tgt([xpath(`${pick}//button`)], { tag: 'button' }), meta: N }),
    );
  }
  return {
    schemaVersion: 1,
    id,
    name,
    startUrl: `${base}/nhis.html`,
    variables: [...loginVars(base), ...(excel ? [{ id: '대상월', name: '대상월', source: { kind: 'excel', column: '대상월' } }] : [])],
    entryBlock: 'main',
    blocks,
    loop: { onRowError: 'skip' },
  };
}

async function scenarioC(base) {
  scenario('C', '월별 고지서 — 특정 월 / 직전 월 / 최신 / 미납만, 새 달이 올라오기 전·후');
  const FIRST = "(//table[@id='bills']//tbody/tr)[1]";
  const LAST = "(//table[@id='bills']//tbody/tr)[last()]";
  const MAX = "//table[@id='bills']//tbody/tr[not(@data-ym < ../tr/@data-ym)]"; // 정렬과 무관하게 가장 큰 년월
  const UNPAID = "//table[@id='bills']//tbody/tr[td[3][contains(normalize-space(),'미납')]]";
  const recipes = {
    specific: nhisRecipe(base, { id: 'lab-c1', name: '고지서 · 엑셀로 지정한 월', monthVar: '{{대상월}}', excel: true }),
    prev: nhisRecipe(base, { id: 'lab-c2', name: '고지서 · 직전 월 (날짜 토큰)', monthVar: '{{sys:date:YYYY년 MM월:-1}}' }),
    first: nhisRecipe(base, { id: 'lab-c3', name: '고지서 · 최신 (맨 윗줄)', pick: FIRST }),
    max: nhisRecipe(base, { id: 'lab-c4', name: '고지서 · 최신 (정렬 무관, 년월 최댓값)', pick: MAX }),
    unpaid: nhisRecipe(base, { id: 'lab-c5', name: '고지서 · 미납 건만', pick: UNPAID }),
  };
  cur.recipes = Object.fromEntries(Object.entries(recipes).map(([k, r]) => [k, r.name]));
  const excelPath = path.join(OUT, 'C', 'months.xlsx');
  await fs.mkdir(path.dirname(excelPath), { recursive: true });
  await writeXlsx(excelPath, ['대상월'], [7, 8, 9, 10].map((m) => ({ 대상월: ymLabel(m) })));
  const prevMonth = ymLabel(((new Date().getMonth() + 11) % 12) + 1);
  note(`오늘 기준 직전 월 = ${prevMonth}`);
  const params = { 비밀번호: LAB_USER.pw };
  const got = (report) =>
    report.rows
      .flatMap((r) => r.files)
      .filter((f) => f.endsWith('.pdf'))
      .map((f) => path.basename(f).replace(/^건강보험_고지서_|( \(\d+\))?\.pdf$/g, ''));

  // ---- 1단계: 7월분까지만 올라와 있음 (최신이 위) ----
  await labState(base, { nhisUpto: 7, nhisOrder: 'desc' });
  let r = (await runRecipe('1단계 · 지정 월 07~10', recipes.specific, { excelPath, params, dir: 'C/1-specific' })).report;
  check('1단계 지정 월: 07월만 받고 08~10월은 "없음"으로 넘어감 (행 실패 아님)', r.totals.ok === 4 && got(r).join() === '2026년 07월', `받은 것 ${got(r).join(', ') || '없음'} · ${JSON.stringify(r.totals)}`);
  r = (await runRecipe('1단계 · 직전 월', recipes.prev, { params, dir: 'C/1-prev' })).report;
  check(`1단계 직전 월(${prevMonth}): 아직 없으니 받지 않음`, r.status === 'done' && got(r).length === 0, got(r).join(', ') || '받은 것 없음');
  r = (await runRecipe('1단계 · 최신(맨 윗줄)', recipes.first, { params, dir: 'C/1-first' })).report;
  check('1단계 최신: 07월', got(r).join() === '2026년 07월', got(r).join());

  // ---- 2단계: 8·9·10월분이 새로 올라옴 ----
  await labState(base, { nhisUpto: 10, nhisOrder: 'desc' });
  r = (await runRecipe('2단계 · 지정 월 07~10', recipes.specific, { excelPath, params, dir: 'C/2-specific' })).report;
  check('2단계 지정 월: 07·08·09·10월 모두 받음', got(r).join() === ['07', '08', '09', '10'].map((m) => `2026년 ${m}월`).join(), got(r).join(', '));
  r = (await runRecipe('2단계 · 직전 월', recipes.prev, { params, dir: 'C/2-prev' })).report;
  check(`2단계 직전 월: ${prevMonth} 받음`, got(r).join() === prevMonth, got(r).join());
  r = (await runRecipe('2단계 · 최신(맨 윗줄)', recipes.first, { params, dir: 'C/2-first' })).report;
  check('2단계 최신(맨 윗줄): 10월', got(r).join() === '2026년 10월', got(r).join());
  r = (await runRecipe('2단계 · 미납만', recipes.unpaid, { params, dir: 'C/2-unpaid' })).report;
  check('2단계 필터(미납만): 10월', got(r).join() === '2026년 10월', got(r).join());

  // ---- 3단계: 사이트가 오래된 순으로 정렬을 바꿈 ----
  await labState(base, { nhisUpto: 10, nhisOrder: 'asc' });
  r = (await runRecipe('3단계 · 최신(맨 윗줄), 정렬 바뀜', recipes.first, { params, dir: 'C/3-first' })).report;
  const firstPick = got(r).join();
  check('3단계 "맨 윗줄" 방식은 정렬이 바뀌면 틀린 달을 받는다 (예상된 함정)', firstPick === '2026년 05월', `받은 것 ${firstPick} — 오류 없이 "성공"으로 끝남`);
  r = (await runRecipe('3단계 · 최신(년월 최댓값)', recipes.max, { params, dir: 'C/3-max' })).report;
  check('3단계 "년월 최댓값" 방식은 정렬과 무관하게 10월', got(r).join() === '2026년 10월', got(r).join());
  await labState(base, { nhisUpto: 7, nhisOrder: 'desc' });
  note('"새로 올라온 달만 자동으로 모두 받기"(목록 전체를 돌며 이전에 받은 달은 건너뛰기)는 지금 스텝 종류로는 표현할 수 없다 — 받을 달을 엑셀 행으로 나열하는 방식으로만 가능');
}

// =====================================================================
async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const server = await startLab();
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`실험실: ${base}  · ${HEADED ? '화면 표시' : '숨김'} 모드 · 동영상 ${VIDEO ? '켬' : '끔'}`);
  const t0 = Date.now();
  try {
    for (const [key, fn] of [
      ['A', scenarioA],
      ['B', scenarioB],
      ['C', scenarioC],
    ]) {
      if (!ONLY.includes(key)) continue;
      try {
        await fn(base);
      } catch (e) {
        scenario(`${key}!`, `${key} 시나리오 중단`);
        check('시나리오가 끝까지 실행됨', false, e.stack?.split('\n').slice(0, 3).join(' | '));
      }
    }
  } finally {
    server.close();
  }
  results.seconds = Math.round((Date.now() - t0) / 1000);
  const all = Object.values(results.scenarios).flatMap((s) => s.checks);
  results.summary = { checks: all.length, passed: all.filter((c) => c.ok).length, failed: all.filter((c) => !c.ok).length };
  await fs.writeFile(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\n결과: ${results.summary.passed}/${results.summary.checks} 통과 · ${results.seconds}초 · ${path.join(OUT, 'results.json')}`);
  process.exit(results.summary.failed ? 1 : 0); // 중단된 시나리오가 남긴 브라우저가 있어도 끝낸다
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
