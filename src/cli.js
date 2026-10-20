// web-rpa 명령줄: 진행 세트(.wrset) 검사·묶기·풀기·시험·설치, 공개 허브 목록·설치.
// 실행: node src/cli.js <명령> …   (설치본: web-rpa.cmd <명령> …)
//   종료 코드: 0 성공, 1 실패(검사 오류·기대 결과와 다름 등), 2 사용법 오류

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Store } from './store.js';
import { Settings } from './settings.js';
import { Runner } from './engine/runner.js';
import { promptVariablesOf } from './recipe.js';
import { profileNameFor } from './browser.js';
import { compareExpected } from './set/core.mjs';
import { readSetDir, packFiles, unpackSet } from './set/folder.mjs';
import { ENGINE_VERSION, RISK_LABELS, inspectSet, installSet, installedSets, setFileName } from './set/index.js';
import { hubList, resolveHubSet, downloadHubSet } from './set/hub.js';

const USAGE = `web-rpa ${ENGINE_VERSION} 명령줄

  set lint <폴더|파일.wrset>              세트 검사 (허브 CI 와 같은 규칙). 오류가 있으면 종료 코드 1
  set pack <폴더> [-o 파일.wrset]         풀어 둔 세트 폴더를 .wrset 으로 묶기 (같은 내용이면 같은 sha256)
  set unpack <파일.wrset> [-o 폴더]       .wrset 을 폴더로 풀기 (README 등을 고친 뒤 pack)
  set test <폴더|파일.wrset> [--headed] [--param 이름=값 …] [--browser auto|msedge|chrome|brave|chromium] [--keep]
                                          임시 작업 폴더에 설치해 예시 입력을 실행하고 expected.json 과 비교. 다르면 종료 코드 1
  set install <파일.wrset>                작업 폴더에 설치
  hub list [--refresh]                    허브의 세트 목록 (설정의 허브 주소)
  hub install <id>[@버전] [--source 이름|주소]   허브에서 내려받아 sha256·엔진 범위를 확인하고 설치

  공통: --workspace <폴더>  작업 폴더 (기본: %LOCALAPPDATA%\\web-rpa)
`;

// ---------- 인자 ----------
const FLAGS_WITH_VALUE = new Set(['-o', '--out', '--workspace', '--param', '--source', '--browser']);
function parseArgs(argv) {
  const pos = [];
  const flags = { param: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (FLAGS_WITH_VALUE.has(a)) {
      const v = argv[(i += 1)];
      if (v === undefined) throw usage(`${a} 뒤에 값이 필요합니다.`);
      if (a === '--param') flags.param.push(v);
      else flags[a === '-o' ? 'out' : a.slice(2)] = v;
    } else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else pos.push(a);
  }
  return { pos, flags };
}
const usage = (m) => Object.assign(new Error(m), { usage: true });
// web-rpa.cmd 는 앱 폴더로 옮겨 실행하므로, 사용자가 명령을 친 폴더를 WEB_RPA_CWD 로 넘겨받는다
const CWD = process.env.WEB_RPA_CWD || process.cwd();
const resolvePath = (p) => path.resolve(CWD, p);
const workspaceOf = (flags) => path.resolve(flags.workspace ? resolvePath(flags.workspace) : path.join(process.env.LOCALAPPDATA || os.homedir(), 'web-rpa'));

// ---------- 출력 ----------
const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
function printPreview(p, { verbose = true } = {}) {
  console.log(`세트: ${p.id ?? '(id 없음)'} ${p.version ? `v${p.version}` : ''}  ${p.name ?? ''}`);
  if (p.sha256) console.log(`sha256: ${p.sha256}  (${kb(p.size)})`);
  if (p.engine?.required) console.log(`엔진: ${p.engine.required} — 지금 ${p.engine.current} ${p.engine.ok ? '(맞음)' : '(안 맞음)'}`);
  if (verbose) {
    for (const s of p.summary ?? []) console.log(`  · ${s}`);
    if (p.risks?.length) {
      console.log('위험 표시:');
      for (const r of p.risks) console.log(`  - ${RISK_LABELS[r.flag] ?? r.flag}: ${r.detail}${r.where ? ` (${r.where})` : ''}`);
    }
  }
  for (const w of p.warnings ?? []) console.log(`  [경고] ${w}`);
  for (const e of p.errors ?? []) console.log(`  [오류] ${e}`);
}

/** 폴더면 묶어서, 파일이면 그대로 .wrset 바이트 */
async function loadSet(target) {
  if (!target) throw usage('세트 폴더나 .wrset 파일을 지정해 주세요.');
  const full = resolvePath(target);
  const st = await fsp.stat(full).catch(() => null);
  if (!st) throw new Error(`없는 경로입니다: ${full}`);
  return st.isDirectory() ? packFiles(readSetDir(full)) : fsp.readFile(full);
}

// ---------- set ----------
async function setLint(target) {
  const p = inspectSet(await loadSet(target));
  printPreview(p);
  console.log(p.errors.length ? `\n검사 실패: 오류 ${p.errors.length}개, 경고 ${p.warnings.length}개` : `\n검사 통과 (경고 ${p.warnings.length}개)`);
  return p.errors.length ? 1 : 0;
}

async function setPack(dir, flags) {
  if (!dir) throw usage('묶을 세트 폴더를 지정해 주세요.');
  const full = resolvePath(dir);
  if (!fs.statSync(full, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`폴더가 아닙니다: ${full}`);
  const buf = packFiles(readSetDir(full));
  const p = inspectSet(buf);
  printPreview(p, { verbose: false });
  if (p.errors.length) {
    console.log(`\n묶지 않았습니다: 오류 ${p.errors.length}개`);
    return 1;
  }
  const out = flags.out ? resolvePath(flags.out) : path.join(CWD, setFileName(p.id, p.version));
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await fsp.writeFile(out, buf);
  console.log(`\n만들었습니다: ${out}`);
  return 0;
}

async function setUnpack(file, flags) {
  if (!file) throw usage('풀 .wrset 파일을 지정해 주세요.');
  const full = resolvePath(file);
  const out = flags.out ? resolvePath(flags.out) : full.replace(/\.wrset$/i, '');
  if (out === full) throw usage('-o 로 풀 폴더를 지정해 주세요.');
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`폴더가 비어 있지 않습니다: ${out}`);
  const names = unpackSet(await fsp.readFile(full), out);
  console.log(`${names.length}개 파일을 풀었습니다: ${out}`);
  return 0;
}

async function setTest(target, flags) {
  const buf = await loadSet(target);
  const p = inspectSet(buf);
  printPreview(p, { verbose: false });
  if (p.errors.length) {
    console.log(`\n시험하지 않았습니다: 세트 검사 오류 ${p.errors.length}개`);
    return 1;
  }
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-rpa-settest-'));
  let passed = false;
  let ran = false;
  try {
    const store = new Store(tmp);
    const inst = await installSet(store, buf, { source: 'test' });
    const recipe = await store.getRecipe(inst.recipeId);
    const params = {};
    for (const kv of flags.param) {
      const i = kv.indexOf('=');
      if (i < 1) throw usage(`--param 은 이름=값 형식입니다: ${kv}`);
      params[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const missing = promptVariablesOf(recipe).filter((v) => (params[v.id] ?? params[v.name]) === undefined && v.source.default === undefined);
    if (missing.length) throw usage(`실행할 때 넣을 값이 필요합니다: ${missing.map((v) => `--param ${v.name || v.id}=값`).join(' ')}`);
    const browser = { id: String(flags.browser || process.env.WEB_RPA_BROWSER || 'auto') };
    const runId = store.newRunId();
    const runDir = store.runDir(runId);
    const runner = new Runner({ recipe, runId, runDir, profileDir: path.join(tmp, 'profiles', profileNameFor(browser.id)), excelPath: store.uploadPath(inst.uploadId), params, options: { headless: !flags.headed }, browser });
    runner.on('log', ({ line }) => console.log(`  ${line}`));
    runner.on('status', ({ status, message }) => {
      if (status !== 'waiting-user') return;
      if (!flags.headed) {
        console.log(`\n사용자 확인 대기 스텝이 있어 숨김 실행으로는 끝까지 시험할 수 없습니다 (${message}). --headed 로 다시 실행해 주세요.`);
        runner.stop();
        return;
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`\n${message}\n브라우저에서 처리한 뒤 Enter 를 누르세요… `, () => {
        rl.close();
        runner.resume();
      });
    });
    console.log(`\n예시 입력 ${p.sample.rows.length}행으로 실행합니다 (${flags.headed ? '창 표시' : '창 숨김'}).`);
    ran = true;
    const report = await runner.start();
    const keyColumn = p.sample.headers[0];
    const diffs = p.expected ? compareExpected(report, p.expected, keyColumn) : [];
    if (report.error) diffs.unshift(`실행 오류: ${report.error}`);
    if (!report.totals.rows) diffs.push('실행한 행이 없습니다.');
    if (!p.expected && report.totals.failed) diffs.push(`실패한 행 ${report.totals.failed}개 (expected.json 이 없어 모든 행이 성공해야 합니다)`);
    console.log(`\n결과: ${report.totals.rows}행 중 성공 ${report.totals.ok}, 실패 ${report.totals.failed}${p.expected ? ' · expected.json 과 비교' : ' · expected.json 없음'}`);
    for (const d of diffs) console.log(`  ✕ ${d}`);
    passed = !diffs.length;
    console.log(passed ? '세트 시험 통과' : `세트 시험 실패 (${diffs.length}건)`);
    if (!passed || flags.keep) console.log(`실행 결과 폴더: ${runDir}`);
  } finally {
    if ((passed || !ran) && !flags.keep) await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); // 실패하면 결과를 볼 수 있게 남긴다
  }
  return passed ? 0 : 1;
}

async function setInstall(file, flags) {
  if (!file) throw usage('설치할 .wrset 파일을 지정해 주세요.');
  const buf = await fsp.readFile(resolvePath(file));
  const p = inspectSet(buf);
  printPreview(p);
  if (p.errors.length) return 1;
  const store = new Store(workspaceOf(flags));
  const r = await installSet(store, buf, { source: 'file' });
  console.log(`\n${r.updated ? `v${r.previousVersion} → v${r.version} 로 바꿨습니다` : '설치했습니다'}: ${r.name} (레시피 ${r.recipeId}, 예시 입력 ${r.uploadId})`);
  console.log(`작업 폴더: ${store.root}`);
  return 0;
}

// ---------- hub ----------
async function hubListCmd(flags) {
  const ws = workspaceOf(flags);
  const settings = new Settings(ws);
  const store = new Store(ws);
  const list = await hubList(settings.hubSources, await installedSets(store), { refresh: true });
  for (const s of list.sources) console.log(`${s.ok ? '●' : '✕'} ${s.name} — ${s.url}${s.ok ? ` (${s.count}개)` : ` — ${s.error}`}`);
  if (!list.sets.length) {
    console.log('\n세트가 없습니다.');
    return list.sources.some((s) => s.ok) ? 0 : 1;
  }
  console.log('');
  for (const s of list.sets) {
    const state = s.installed ? (s.update ? `업데이트 있음 (설치 ${s.installed.version})` : `설치됨 ${s.installed.version}`) : '';
    console.log(`${s.id}@${s.entry.version}  ${s.name}${state ? `  [${state}]` : ''}${s.entry.compatible ? '' : '  [이 web-rpa 와 안 맞음]'}`);
    if (s.summary) console.log(`    ${s.summary}`);
    console.log(`    사이트: ${s.entry.sites.join(', ') || '-'}${s.entry.risk.length ? ` · 위험: ${s.entry.risk.map((f) => RISK_LABELS[f] ?? f).join(', ')}` : ''}`);
  }
  return 0;
}

async function hubInstallCmd(spec, flags) {
  if (!spec) throw usage('설치할 세트 id 를 지정해 주세요 (예: tak002/dart-report 또는 tak002/dart-report@1.0.0).');
  const [id, version] = spec.split('@');
  const ws = workspaceOf(flags);
  const settings = new Settings(ws);
  const { src, entry } = await resolveHubSet(settings.hubSources, { source: flags.source, id, version });
  console.log(`${src.name} 에서 ${id}@${entry.version} 내려받는 중…`);
  const buf = await downloadHubSet(entry);
  console.log('sha256 확인: 허브 목록과 같습니다.');
  const p = inspectSet(buf);
  printPreview(p);
  if (p.errors.length) return 1;
  if (p.id !== id || p.version !== entry.version) {
    console.log(`  [오류] 허브 목록(${id} ${entry.version})과 세트 안의 manifest(${p.id} ${p.version})가 다릅니다.`);
    return 1;
  }
  const store = new Store(ws);
  const r = await installSet(store, buf, { source: src.url });
  console.log(`\n${r.updated ? `v${r.previousVersion} → v${r.version} 로 바꿨습니다` : '설치했습니다'}: ${r.name} (레시피 ${r.recipeId}, 예시 입력 ${r.uploadId})`);
  return 0;
}

// ---------- 시작 ----------
export async function main(argv) {
  const { pos, flags } = parseArgs(argv);
  const [group, cmd, arg] = pos;
  if (!group || flags.help || group === 'help') {
    console.log(USAGE);
    return group ? 0 : 2;
  }
  if (group === 'set') {
    if (cmd === 'lint') return setLint(arg);
    if (cmd === 'pack') return setPack(arg, flags);
    if (cmd === 'unpack') return setUnpack(arg, flags);
    if (cmd === 'test') return setTest(arg, flags);
    if (cmd === 'install') return setInstall(arg, flags);
  }
  if (group === 'hub') {
    if (cmd === 'list') return hubListCmd(flags);
    if (cmd === 'install') return hubInstallCmd(arg, flags);
  }
  throw usage(`알 수 없는 명령: ${pos.join(' ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  // process.exit() 를 바로 부르지 않는다: Windows 에서 내려받기 연결이 닫히는 중에 끝내면 Node 가 비정상 종료한다
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code ?? 0;
    },
    (e) => {
      console.error(`\n오류: ${e.message}`);
      if (e.usage) console.error(`\n${USAGE}`);
      process.exitCode = e.usage ? 2 : 1;
    },
  );
}
