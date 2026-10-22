// 실행기: 엑셀 행마다 레시피를 실행하고 결과(리포트·받은 파일·실패 화면·결과 엑셀·실행 기록)를 남긴다.
// 세트로 설치한 레시피(recipe.origin)는 세트가 밝힌 사이트에만 접속하고, 행 사이 간격·한 번에 실행할 행 수를 지킨다.

import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startBrowser, browserVersion } from '../browser.js';
import { excelColumnsOf, promptVariablesOf } from '../recipe.js';
import { readTable } from './excel.js';
import { Scope } from './vars.js';
import { Session, StopSignal } from './session.js';
import { Executor } from './executor.js';
import { writeRunFiles } from './report.js';
import { guardSites, normOrigin } from './sites.js';
import { stepNumbers } from '../../public/shared/recipe-edit.js';

const pad = (n) => String(n).padStart(2, '0');
const firstLine = (s) => String(s ?? '').split('\n')[0];
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Runner extends EventEmitter {
  /**
   * @param {{recipe: object, runId: string, runDir: string, profileDir: string, excelPath?: string, params?: object, options?: object, browser?: object}} o
   */
  constructor({ recipe, runId, runDir, profileDir, excelPath, params = {}, options = {}, browser }) {
    super();
    this.recipe = recipe;
    this.runId = runId;
    this.runDir = runDir;
    this.profileDir = profileDir;
    this.excelPath = excelPath;
    this.params = params ?? {};
    this.browser = browser;
    this.options = {
      headless: !!options.headless,
      humanPacing: !!options.humanPacing,
      recordVideo: !!options.recordVideo,
      startRow: Math.max(1, Math.floor(Number(options.startRow) || 1)),
      maxRows: Number(options.maxRows) > 0 ? Math.floor(Number(options.maxRows)) : undefined,
      onRowError: options.onRowError === 'stop' || options.onRowError === 'skip' ? options.onRowError : recipe?.loop?.onRowError === 'stop' ? 'stop' : 'skip',
    };
    this.status = 'idle';
    this.logLines = [];
    this.stopRequested = false;
    this.waiters = [];
    this.filesDir = path.join(runDir, 'files');
    // 세트 제한 (설치한 세트만 — 직접 녹화한 레시피는 그대로)
    const origin = recipe?.origin && typeof recipe.origin === 'object' ? recipe.origin : null;
    this.siteLimit = Array.isArray(origin?.sites) ? origin.sites.map(normOrigin).filter(Boolean) : null;
    const pacing = origin?.pacing ?? {};
    this.rowGapMs = Math.min(Math.max(Math.floor(Number(pacing.minRowIntervalMs) || 0), 0), 600_000);
    this.rowCap = Number(pacing.maxRowsPerRun) >= 1 ? Math.floor(Number(pacing.maxRowsPerRun)) : 0;
    this.limit = null; // 행 수 상한에 닿았을 때 { maxRowsPerRun, nextRow, skipped }
    this.rowBlocked = null; // 이번 행에서 막은 이동
    this.lastStep = null;
  }

  // ---------- 바깥에서 부르는 조작 ----------
  pause() {
    if (this.status === 'running') {
      this.setStatus('paused');
      this.log('info', '일시정지했습니다. 지금 스텝을 마친 뒤 멈춥니다.');
    }
  }

  resume() {
    if (this.status === 'paused') {
      this.setStatus('running');
      this.log('info', '다시 실행합니다.');
    }
    for (const w of this.waiters.splice(0)) w();
  }

  stop() {
    if (['done', 'failed', 'stopped'].includes(this.status)) return;
    if (!this.stopRequested) this.log('warn', '중지 요청: 진행 중인 동작을 마무리하고 멈춥니다.');
    this.stopRequested = true;
    if (this.sess) this.sess.aborted = true;
    for (const w of this.waiters.splice(0)) w();
  }

  // ---------- 기록·상태 ----------
  log(level, message) {
    const d = new Date();
    const line = `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]${level === 'info' ? '' : ` [${level}]`} ${message}`;
    this.logLines.push(line);
    this.emit('log', { level, message, line });
  }

  setStatus(status, extra = {}) {
    this.status = status;
    this.emit('status', { status, ...extra });
  }

  async checkpoint() {
    while (this.status === 'paused' && !this.stopRequested) await new Promise((r) => this.waiters.push(r));
    if (this.stopRequested) throw new StopSignal();
    if (this.rowBlocked) throw this.blockedError(); // 세트 밖 사이트로 이동했으면 다음 스텝으로 가지 않는다
  }

  // ---------- 세트 사이트 제한 ----------
  onSiteBlocked({ url, origin, redirect }) {
    if (!this.rowBlocked) this.rowBlocked = { url, origin, redirect };
    this.log('error', `세트에 적히지 않은 사이트로 ${redirect ? '넘어가 되돌렸습니다' : '이동하려 해 막았습니다'}: ${clip(origin || url, 100)}`);
  }

  /** 행을 실패시키는 오류 (스텝 실패로 다시 시도하거나 "실패해도 계속"으로 넘기지 않게 신호로 보낸다) */
  blockedError() {
    const b = this.rowBlocked;
    const allowed = this.siteLimit?.length ? this.siteLimit.join(', ') : '(없음)';
    return Object.assign(new Error(`세트에 적히지 않은 사이트(${b.origin || clip(b.url, 80)})로 이동하려 해 막았습니다. 이 세트는 ${allowed} 에만 접속할 수 있습니다.`), { signal: true, siteBlocked: true });
  }

  /** 중지하면 바로 끊기는 대기 */
  async sleep(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.stopRequested) throw new StopSignal();
      await sleep(Math.min(200, end - Date.now()));
    }
  }

  /** pause 스텝: 사람이 [계속]을 누를 때까지 기다린다 */
  async waitUser(message) {
    this.log('info', `사용자 확인 대기: ${message}`);
    this.setStatus('waiting-user', { message });
    await new Promise((r) => this.waiters.push(r));
    if (this.stopRequested) throw new StopSignal();
    this.setStatus('running');
    this.log('info', '사용자가 [계속]을 눌러 이어서 실행합니다.');
  }

  // ---------- 실행 ----------
  /** 엑셀을 읽고 실행할 행을 정한다. 문제가 있으면 시작 전에 오류. */
  async plan() {
    const cols = excelColumnsOf(this.recipe);
    let headers = [];
    let rows = [];
    if (this.excelPath) {
      const t = await readTable(this.excelPath);
      headers = t.headers;
      rows = t.rows;
      const missing = cols.filter((c) => !headers.includes(c));
      if (missing.length) throw new Error(`엑셀에 레시피가 쓰는 열이 없습니다: ${missing.join(', ')} — 엑셀 첫 줄의 열 이름을 확인해 주세요 (있는 열: ${headers.join(', ') || '없음'}).`);
      if (!rows.length) throw new Error('엑셀에 데이터 행이 없습니다.');
    } else if (cols.length) throw new Error(`이 레시피는 엑셀 열(${cols.join(', ')})을 씁니다. 엑셀 파일을 넣어 주세요.`);
    for (const v of promptVariablesOf(this.recipe)) {
      const p = this.params[v.id] ?? this.params[v.name];
      if ((p === undefined || p === null || p === '') && v.source.default === undefined) throw new Error(`실행할 때 넣을 값이 없습니다: ${v.name || v.id}`);
    }
    let list = this.excelPath ? rows.map((values, i) => ({ rowNumber: i + 1, values })) : [{ rowNumber: 1, values: {} }];
    list = list.filter((r) => r.rowNumber >= this.options.startRow);
    if (this.options.maxRows) list = list.slice(0, this.options.maxRows);
    if (!list.length) throw new Error(`시작 행(${this.options.startRow})부터 실행할 행이 없습니다 (엑셀 ${rows.length}행).`);
    if (this.rowCap && list.length > this.rowCap) {
      // 세트가 정한 한 번에 실행할 행 수: 넘는 행은 이번에 실행하지 않는다
      this.limit = { maxRowsPerRun: this.rowCap, nextRow: list[this.rowCap].rowNumber, skipped: list.length - this.rowCap };
      list = list.slice(0, this.rowCap);
    }
    return { headers, list, excel: this.excelPath ? { file: path.basename(this.excelPath), headers, rowCount: rows.length } : null };
  }

  /** @returns {Promise<object>} 리포트 */
  async start() {
    if (this.status !== 'idle') throw new Error('이미 시작한 실행입니다.');
    const startedAt = new Date();
    this.setStatus('running');
    const report = {
      runId: this.runId,
      recipe: { id: this.recipe?.id, name: this.recipe?.name },
      status: 'running',
      error: null,
      startedAt: startedAt.toISOString(),
      endedAt: null,
      durationMs: 0,
      options: { ...this.options },
      excel: null,
      totals: { rows: 0, ok: 0, failed: 0 },
      rows: [],
      files: [],
    };
    let fatal = false;
    try {
      await fs.mkdir(this.filesDir, { recursive: true });
      const plan = await this.plan();
      this.headers = plan.headers;
      report.excel = plan.excel;
      this.log('info', `실행 시작: ${this.recipe.name} · ${plan.excel ? `엑셀 ${plan.list.length}행` : '엑셀 없이 1회'} · ${this.options.headless ? '창 숨김' : '창 표시'}`);
      this.emit('progress', { rowsTotal: plan.list.length, rowsDone: 0, rowsFailed: 0 });
      if (this.stopRequested) throw new StopSignal();
      this.ctx = await startBrowser({
        profileDir: this.profileDir,
        headless: this.options.headless,
        browser: this.browser,
        recordVideo: this.options.recordVideo ? { dir: path.join(this.runDir, 'video') } : undefined,
      });
      const version = await browserVersion(this.ctx);
      this.log('info', `브라우저: ${this.ctx.__channel}${version ? ` (${version})` : ''}`);
      if (this.siteLimit) {
        await guardSites(this.ctx, this.siteLimit, (e) => this.onSiteBlocked(e));
        this.log('info', `세트 사이트 제한: ${this.siteLimit.join(', ') || '(없음)'} 밖으로는 이동하지 않습니다.`);
      }
      if (this.rowGapMs || this.rowCap) this.log('info', `세트 실행 간격: 행 사이 ${this.rowGapMs / 1000}초 이상${this.rowCap ? `, 한 번에 최대 ${this.rowCap}행` : ''}`);
      this.sess = new Session({ ctx: this.ctx, log: (level, m) => this.log(level, m) });
      this.sess.aborted = this.stopRequested;
      await this.sess.init();
      this.executor = new Executor({
        recipe: this.recipe,
        log: (level, m) => this.log(level, m),
        options: this.options,
        hooks: {
          checkpoint: () => this.checkpoint(),
          step: (e) => this.onStep(e),
        },
      });
      let lastEnd = 0;
      let cut = false;
      for (const row of plan.list) {
        if (this.stopRequested) break;
        if (this.rowGapMs && lastEnd) {
          const wait = lastEnd + this.rowGapMs - Date.now();
          if (wait > 0) await this.sleep(wait);
        }
        const result = await this.runRow(row);
        lastEnd = Date.now();
        report.rows.push(result);
        report.files.push(...result.files);
        const failed = report.rows.filter((r) => r.status === 'failed').length;
        this.emit('progress', { rowsTotal: plan.list.length, rowsDone: report.rows.length, rowsFailed: failed });
        if (result.status === 'failed' && this.options.onRowError === 'stop' && !this.stopRequested) {
          this.log('warn', '행이 실패해 실행을 멈춥니다 (행 실패 시 중단).');
          cut = true;
          break;
        }
      }
      if (this.limit && !cut && !this.stopRequested) {
        report.limit = this.limit;
        report.error = `이 세트는 한 번에 ${this.limit.maxRowsPerRun}행까지만 실행합니다 — ${this.limit.nextRow}행부터 ${this.limit.skipped}행은 실행하지 않았습니다. 시작 행을 ${this.limit.nextRow}(으)로 정해 이어서 실행하세요.`;
        this.log('warn', report.error);
      }
    } catch (e) {
      if (!(e instanceof StopSignal)) {
        fatal = true;
        report.error = firstLine(e.message);
        this.log('error', `실행 오류: ${report.error}`);
      }
    } finally {
      if (this.sess) this.sess.quietClose = true;
      await this.ctx?.close().catch(() => {});
      const ok = report.rows.filter((r) => r.status === 'ok').length;
      report.totals = { rows: report.rows.length, ok, failed: report.rows.length - ok };
      report.status = this.stopRequested ? 'stopped' : fatal || report.totals.failed ? 'failed' : report.limit ? 'stopped' : 'done';
      const endedAt = new Date();
      report.endedAt = endedAt.toISOString();
      report.durationMs = endedAt - startedAt;
      this.log(report.status === 'done' ? 'info' : 'warn', `실행 끝: ${{ done: '완료', failed: '실패 있음', stopped: '중지됨' }[report.status]} — ${report.totals.rows}행 중 성공 ${ok}, 실패 ${report.totals.failed}`);
      try {
        await writeRunFiles(this.runDir, report, this.logLines);
      } catch (e) {
        this.log('error', `리포트 저장 실패: ${e.message}`);
      }
      this.setStatus(report.status, { report });
    }
    return report;
  }

  onStep(e) {
    if (e.status === 'start') {
      this.lastStep = { stepId: e.stepId, block: e.block, index: e.index, desc: e.desc };
      // 화면(편집기)과 같은 전역 번호(#2.2). 번호가 없으면(어디서도 부르지 않는 블록) 블록 이름과 블록 안 번호
      const no = this.numberOf(e.stepId);
      this.log('info', `  ${no ?? `${e.block === (this.recipe.entryBlock || 'main') ? '' : `[${e.block}] `}${e.index + 1}.`} ${e.desc}`);
    } else if (e.status === 'ok' && e.note) this.log('info', `     → ${e.note}`);
    this.emit('step', e);
  }

  /** 스텝의 전역 번호 (#2.2) — 없으면 undefined */
  numberOf(stepId) {
    this.numbers ??= stepNumbers(this.recipe);
    const no = this.numbers.get(stepId);
    return no && no !== '#-' ? no : undefined;
  }

  rowLabel(values) {
    const parts = (this.headers ?? [])
      .slice(0, 2)
      .map((h) => String(values?.[h] ?? '').trim())
      .filter(Boolean);
    return clip(parts.join(' · '), 40);
  }

  async runRow({ rowNumber, values }) {
    const t0 = Date.now();
    const label = this.rowLabel(values);
    const result = { rowNumber, label, input: values, status: 'ok', values: {}, files: [], durationMs: 0 };
    this.emit('row', { rowNumber, label, status: 'start' });
    this.log('info', `── ${rowNumber}행 시작${label ? ` (${label})` : ''}`);
    const scope = new Scope({ recipe: this.recipe, row: values, rowNumber, params: this.params, extracted: result.values, dialog: () => this.sess.lastDialogMessage });
    const rc = {
      sess: this.sess,
      scope,
      recipe: this.recipe,
      options: this.options,
      runDir: this.runDir,
      filesDir: this.filesDir,
      log: (level, m) => this.log(level, m),
      sleep: (ms) => this.sleep(ms),
      waitUser: (m) => this.waitUser(m),
      addFile: (abs) => result.files.push(path.relative(this.runDir, abs).split(path.sep).join('/')),
    };
    try {
      await this.sess.resetRow();
      this.rowBlocked = null;
      this.lastStep = null;
      await this.executor.runRow(rc);
      if (this.rowBlocked) throw this.blockedError();
      this.log('info', `${rowNumber}행 성공 (${((Date.now() - t0) / 1000).toFixed(1)}초)`);
    } catch (e0) {
      // 세트 밖 사이트로 가다 막혔으면, 그 때문에 난 스텝 오류(주소를 열지 못함 등) 대신 막은 이유를 남긴다
      const e = this.rowBlocked && !e0.stop ? Object.assign(this.blockedError(), { failure: e0.failure ?? this.lastStep ?? undefined }) : e0;
      result.status = 'failed';
      result.error = e.stop ? '사용자가 실행을 중지했습니다.' : firstLine(e.message);
      const detail = e.stop ? '' : String(e.message ?? '').split('\n').slice(1).join('\n').trim();
      if (detail) result.errorDetail = detail; // 리포트에서 [자세히] 로 접어 보인다 (시도한 후보 등)
      if (e.failure) result.failure = { ...e.failure, ...(this.numberOf(e.failure.stepId) ? { no: this.numberOf(e.failure.stepId) } : {}) }; // no: 화면 번호 (#2.1)
      this.log(e.stop ? 'warn' : 'error', `${rowNumber}행 실패: ${result.error}${e.failure ? ` [스텝 ${this.numberOf(e.failure.stepId) ?? e.failure.stepId}: ${e.failure.desc}]` : ''}`);
      if (detail) this.log('info', `     ${clip(detail.replace(/\s+/g, ' '), 400)}`);
      result.screenshot = await this.failureShot(rowNumber);
    }
    result.durationMs = Date.now() - t0;
    this.emit('row', result);
    return result;
  }

  /** 실패 화면: failures/row-N.png */
  async failureShot(rowNumber) {
    const page = this.sess?.page ?? this.sess?.work;
    if (!page || page.isClosed()) return undefined;
    const rel = `failures/row-${rowNumber}.png`;
    try {
      await fs.mkdir(path.join(this.runDir, 'failures'), { recursive: true });
      await page.screenshot({ path: path.join(this.runDir, rel), timeout: 10000 });
      return rel;
    } catch {
      return undefined;
    }
  }
}
