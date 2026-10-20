// 녹화기: 브라우저를 열어 사람이 한 동작(클릭·입력·선택·키·다운로드·첨부·알림창·인쇄·팝업 닫기)을 레시피 스텝으로 모은다.
// 페이지 안 캡처(capture.page.js)가 보낸 이벤트를 도착 순서대로 하나씩 처리한다.

import { EventEmitter } from 'node:events';
import { startBrowser, framePathOf } from '../browser.js';
import { STEP_LABELS } from '../../public/shared/steps.js';
import { DOM_SCRIPT, CAPTURE_SCRIPT, asInitScript, asExpression } from './scripts.js';

const BINDING = '__webRpaEmit';
const POLL_MS = 400; // Node 연결이 없는 문서(드문 경우)에서 쌓인 이벤트를 가져오는 간격
const DOWNLOAD_SETTLE_MS = 500; // 다운로드 원인 클릭이 먼저 도착하도록 잠깐 기다린다
const CLOSE_SETTLE_MS = 300; // 창이 닫히며 늦게 도착하는 마지막 클릭을 기다린다
const DBLCLICK_MS = 1500;
const DOWNLOAD_LOOKBACK_MS = 5 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstLine = (s) => String(s ?? '').split('\n')[0];
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

export class Recorder extends EventEmitter {
  /**
   * @param {{name: string, startUrl: string, profileDir: string, headless?: boolean, browser?: object}} o
   */
  constructor({ name, startUrl, profileDir, headless = false, browser, recordVideo }) {
    super();
    this.name = name || '새 레시피';
    this.startUrl = startUrl;
    this.profileDir = profileDir;
    this.headless = headless;
    this.browser = browser;
    this.recordVideo = recordVideo; // { dir, size } 면 녹화 화면도 탭마다 동영상으로 남긴다
    this.state = 'idle';
    this.ctx = null;
    this.recipe = { schemaVersion: 1, name: this.name, startUrl, variables: [], entryBlock: 'main', blocks: { main: [] }, loop: { onRowError: 'skip' } };
    this.seq = 0;
    this.pageIds = new Map();
    this.frameIds = new WeakMap();
    this.nextFrameId = 1;
    this.stepKey = new Map(); // 스텝 id → 요소 열쇠 (같은 칸 이어 입력 판단)
    this.eidStep = new Map(); // 페이지 이벤트 번호 → 스텝 id (알림창·인쇄의 원인 찾기)
    this.chooserFor = new Map(); // 파일 선택창을 연 클릭 스텝 id → 파일 칸 열쇠
    this.popups = new WeakSet();
    this.downloadPages = new WeakSet();
    this.pollFrames = new Set();
    this.timers = new Map(); // 늦게 처리할 일 (다운로드 원인 찾기·팝업 닫힘)
    this.chain = Promise.resolve();
    this.stopping = false;
    this.mainPage = null;
    this.activePage = null;
  }

  get main() {
    return this.recipe.blocks.main;
  }

  // ---------- 공개 동작 ----------
  async start() {
    if (this.state !== 'idle') throw new Error('이미 시작한 녹화입니다.');
    this.setState('starting');
    try {
      this.ctx = await startBrowser({ profileDir: this.profileDir, headless: this.headless, browser: this.browser, recordVideo: this.recordVideo });
    } catch (e) {
      this.setState('stopped');
      throw e;
    }
    const ctx = this.ctx;
    await ctx.exposeBinding(BINDING, (source, evt) => this.enqueue(source.frame, evt));
    await ctx.addInitScript({ content: asInitScript(DOM_SCRIPT, CAPTURE_SCRIPT) });
    ctx.on('page', (p) => this.attachPage(p));
    ctx.on('close', () => this.finishByUser('녹화 브라우저가 닫혔습니다.'));
    for (const p of ctx.pages()) this.attachPage(p);
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    this.mainPage = page;
    this.activePage = page;
    this.addStep({ type: 'navigate', url: this.startUrl, meta: { url: this.startUrl, pageId: this.pageId(page), ts: Date.now() } }, { append: true });
    this.poller = setInterval(() => this.poll(), POLL_MS);
    this.setState('recording');
    try {
      await page.goto(this.startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      this.emit('warn', `시작 주소를 여는 중 문제가 있었습니다: ${firstLine(e.message)}`);
    }
    return this.recipe;
  }

  pause() {
    if (this.state !== 'recording') return;
    this.setState('paused');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.setState('recording');
  }

  /** 화면에서 직접 넣는 스텝. navigate 에 url 이 없으면 지금 탭 주소. */
  async addManualStep(step) {
    if (!step || !STEP_LABELS[step.type]) throw new Error(`알 수 없는 스텝 종류: ${step?.type ?? '(없음)'}`);
    const s = structuredClone(step);
    delete s.id;
    const page = this.livePage();
    const url = page ? page.url() : '';
    if (s.type === 'navigate' && !s.url) s.url = url;
    s.meta = { ...(s.meta ?? {}), url, pageId: page ? this.pageId(page) : 1, ts: Date.now(), manual: true };
    return this.addStep(s, { append: true });
  }

  removeStep(id) {
    for (const steps of Object.values(this.recipe.blocks)) {
      const i = steps.findIndex((s) => s.id === id);
      if (i >= 0) steps.splice(i, 1);
    }
    this.stepKey.delete(id);
    this.chooserFor.delete(id);
    this.changed();
  }

  /** 녹화를 마치고 레시피를 돌려준다. 아직 보내지 않은 입력값까지 반영하고 브라우저를 닫는다. */
  async stop() {
    if (this.state === 'stopped') return structuredClone(this.recipe);
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      if (this.ctx && this.state === 'recording') {
        const frames = this.ctx.pages().flatMap((p) => p.frames());
        const results = await Promise.all(
          frames.map((f) =>
            withTimeout(
              f.evaluate(() => (typeof window.__webRpaFlush === 'function' ? window.__webRpaFlush() : [])),
              1500,
            ).catch(() => []), // 이동 중이거나 알림창이 떠 있는 문서
          ),
        );
        results.forEach((queued, i) => (queued ?? []).forEach((e) => this.enqueue(frames[i], e)));
        await sleep(250); // 연결 함수로 막 보낸 이벤트가 도착하도록
        this.runTimersNow();
      }
      await this.chain;
      this.stopping = true;
      clearInterval(this.poller);
      await this.chain;
      await this.ctx?.close().catch(() => {});
      this.setState('stopped');
      return structuredClone(this.recipe);
    })();
    return this.stopPromise;
  }

  // ---------- 페이지·프레임 ----------
  pageId(page) {
    if (!this.pageIds.has(page)) this.pageIds.set(page, this.pageIds.size + 1);
    return this.pageIds.get(page);
  }

  frameKey(frame) {
    if (!this.frameIds.has(frame)) this.frameIds.set(frame, this.nextFrameId++);
    return this.frameIds.get(frame);
  }

  livePage() {
    if (this.activePage && !this.activePage.isClosed()) return this.activePage;
    const pages = this.ctx?.pages() ?? [];
    return pages.at(-1) ?? null;
  }

  attachPage(page) {
    if (page.__webRpaAttached) return;
    page.__webRpaAttached = true;
    this.pageId(page);
    page.on('dialog', () => {}); // 사람이 직접 응답하게 둔다 (듣는 쪽이 없으면 자동으로 닫히므로 꼭 둔다)
    page.on('download', (d) => this.onDownload(page, d));
    page.on('popup', (p) => {
      this.popups.add(p);
      this.activePage = p;
    });
    page.on('close', () => this.onPageClose(page));
    // window.open 창은 첫 문서에 문서 시작 스크립트가 안 붙을 수 있어, 문서가 바뀔 때마다 설치를 확인한다
    page.on('framenavigated', (f) => this.install(f));
    page.on('domcontentloaded', () => page.frames().forEach((f) => this.install(f)));
    page
      .opener()
      .then((o) => o && this.popups.add(page))
      .catch(() => {});
    for (const f of page.frames()) this.install(f);
  }

  async install(frame) {
    if (this.state === 'stopped' || this.stopping) return;
    try {
      this.absorb(frame, await frame.evaluate(asExpression(DOM_SCRIPT, CAPTURE_SCRIPT)));
    } catch {
      /* 문서가 바뀌는 중이면 다음 이벤트 때 다시 */
    }
  }

  absorb(frame, r) {
    if (!r) return;
    for (const e of r.queued ?? []) this.enqueue(frame, e);
    if (r.binding) this.pollFrames.delete(frame);
    else this.pollFrames.add(frame);
  }

  async poll() {
    if (this.polling || !this.pollFrames.size) return;
    this.polling = true;
    try {
      for (const f of [...this.pollFrames]) {
        if (f.isDetached()) {
          this.pollFrames.delete(f);
          continue;
        }
        try {
          const r = await withTimeout(
            f.evaluate(() => {
              const S = window.__webRpaRec;
              return S ? { binding: typeof window.__webRpaEmit === 'function', queued: S.queue.splice(0) } : null;
            }),
            1000,
          );
          this.absorb(f, r);
        } catch {
          /* 다음에 */
        }
      }
    } finally {
      this.polling = false;
    }
  }

  // ---------- 이벤트 처리 ----------
  enqueue(frame, evt) {
    this.chain = this.chain
      .then(() => this.handle(frame, evt))
      .catch((e) => this.emit('warn', `녹화 이벤트 처리 오류: ${firstLine(e.message)}`));
  }

  later(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.chain = this.chain.then(fn).catch((e) => this.emit('warn', `녹화 처리 오류: ${firstLine(e.message)}`));
    }, ms);
    this.timers.set(t, fn);
  }

  runTimersNow() {
    for (const [t, fn] of this.timers) {
      clearTimeout(t);
      this.chain = this.chain.then(fn).catch(() => {});
    }
    this.timers.clear();
  }

  async handle(frame, evt) {
    if (this.state !== 'recording' || !evt || typeof evt !== 'object') return; // 일시정지 중 이벤트는 버린다
    let page;
    try {
      page = frame.page();
    } catch {
      return;
    }
    if (!page.isClosed()) this.activePage = page;
    const key = evt.uid ? `${this.frameKey(frame)}|${evt.uid}` : null;
    const target = evt.target ? { framePath: framePathOf(frame), candidates: evt.target.candidates ?? [], meta: evt.target.meta ?? {} } : undefined;
    const meta = { url: evt.top || page.url(), pageId: this.pageId(page), ts: Number(evt.ts) || Date.now() };
    switch (evt.kind) {
      case 'click':
        if (evt.detail >= 2) return; // 더블클릭의 두 번째 클릭은 dblclick 이 합친다
        this.addStep({ type: 'click', target, meta }, { key, eid: evt.eid });
        return;
      case 'dblclick':
        return this.onDblclick(evt, key, target, meta);
      case 'key': {
        const step = { type: 'keypress', key: evt.key };
        if (target) step.target = target;
        step.meta = meta;
        this.addStep(step, { key, eid: evt.eid });
        return;
      }
      case 'input':
        return this.onInput(evt, key, target, meta);
      case 'select':
        return this.mergeOrAdd(key, evt.eid, 'select', (s) => Object.assign(s, { value: String(evt.value ?? ''), label: evt.label || undefined }), { type: 'select', target, value: String(evt.value ?? ''), label: evt.label || undefined, meta });
      case 'check':
        return this.mergeOrAdd(key, evt.eid, 'check', (s) => Object.assign(s, { checked: !!evt.checked }), { type: 'check', target, checked: !!evt.checked, meta });
      case 'file':
        return this.onFile(evt, key, target, meta);
      case 'chooser': {
        const stepId = this.eidStep.get(evt.of);
        if (stepId) this.chooserFor.set(stepId, key);
        return;
      }
      case 'dialog':
        return this.onDialog(evt, meta);
      case 'print':
        return this.onPrint(evt, meta);
      default:
    }
  }

  onDblclick(evt, key, target, meta) {
    for (let i = this.main.length - 1; i >= 0; i -= 1) {
      const s = this.main[i];
      if (meta.ts - (s.meta?.ts ?? 0) > DBLCLICK_MS) break;
      if ((s.type === 'click' || s.type === 'dblclick') && this.stepKey.get(s.id) === key) {
        s.type = 'dblclick'; // 앞선 두 번의 클릭을 하나의 더블클릭으로
        this.eidStep.set(evt.eid, s.id);
        this.changed();
        return;
      }
    }
    this.addStep({ type: 'dblclick', target, meta }, { key, eid: evt.eid });
  }

  onInput(evt, key, target, meta) {
    const value = evt.password ? `{{${this.secretVariable(target)}}}` : String(evt.value ?? '');
    this.mergeOrAdd(key, evt.eid, 'input', (s) => (s.value = value), { type: 'input', target, value, meta });
  }

  /** 마지막 스텝이 같은 칸의 같은 종류면 값만 갱신, 아니면 새 스텝 */
  mergeOrAdd(key, eid, type, update, step) {
    const last = this.main.at(-1);
    if (key && last && last.type === type && this.stepKey.get(last.id) === key) {
      update(last);
      if (last.label === undefined) delete last.label;
      if (eid) this.eidStep.set(eid, last.id);
      this.changed();
      return last;
    }
    if (step.label === undefined) delete step.label;
    return this.addStep(step, { key, eid });
  }

  onFile(evt, key, target, meta) {
    const fileNames = Array.isArray(evt.fileNames) ? evt.fileNames : [];
    // 버튼이 숨은 파일 칸을 눌러 연 선택창이면, 그 클릭을 첨부 스텝으로 바꾼다 (재생 때 버튼을 눌러 선택창에 넣는다)
    for (const [stepId, fileKey] of this.chooserFor) {
      if (fileKey !== key) continue;
      const s = this.findStep(stepId);
      this.chooserFor.delete(stepId);
      if (s && s.type === 'click') {
        s.type = 'upload';
        s.path = '';
        s.meta = { ...s.meta, fileNames };
        this.eidStep.set(evt.eid, s.id);
        this.changed();
        return;
      }
    }
    this.mergeOrAdd(key, evt.eid, 'upload', (s) => (s.meta = { ...s.meta, fileNames }), { type: 'upload', target, path: '', meta: { ...meta, fileNames } });
  }

  onDialog(evt, meta) {
    const step = { type: 'dialog', action: evt.accepted ? 'accept' : 'dismiss' };
    if (evt.dialogType === 'prompt' && evt.accepted) step.promptText = String(evt.promptText ?? '');
    step.meta = { ...meta, dialogType: evt.dialogType, message: String(evt.message ?? '') };
    const trig = evt.trigger ? this.findStep(this.eidStep.get(evt.trigger)) : null;
    if (trig) {
      // 재생 때 미리 방침을 걸 수 있게 원인 동작 앞에 넣는다
      step.meta.triggerStepId = trig.id;
      step.meta.ts = trig.meta?.ts ?? meta.ts;
      this.addStep(step, { before: trig });
    } else this.addStep(step);
  }

  onPrint(evt, meta) {
    const trig = evt.trigger ? this.findStep(this.eidStep.get(evt.trigger)) : null;
    const step = { type: 'pdf', meta: { ...meta, ...(trig ? { triggerStepId: trig.id } : {}) } };
    if (trig) this.addStep(step, { after: trig });
    else this.addStep(step);
  }

  onDownload(page, download) {
    if (this.state !== 'recording' || this.stopping) return;
    this.downloadPages.add(page);
    const at = Date.now();
    this.later(() => this.attributeDownload(download, at), DOWNLOAD_SETTLE_MS);
  }

  /** 다운로드를 일으킨 최근 클릭을 download 스텝으로 바꾼다 (새 창·늦게 시작된 다운로드 포함). */
  attributeDownload(download, at) {
    let name = '';
    try {
      name = download.suggestedFilename();
    } catch {
      /* 이름 없음 */
    }
    for (let i = this.main.length - 1; i >= 0; i -= 1) {
      const s = this.main[i];
      const ts = s.meta?.ts ?? 0;
      if (ts > at) continue; // 다운로드가 시작된 뒤의 동작
      if (at - ts > DOWNLOAD_LOOKBACK_MS) break;
      if (s.type === 'click') {
        s.type = 'download';
        s.meta = { ...s.meta, suggestedFilename: name };
        this.changed();
        return;
      }
      if (s.type === 'download') {
        this.emit('warn', `한 번의 클릭으로 파일이 하나 더 받아졌습니다 (${name}). 재생 때는 첫 파일만 저장합니다.`);
        return;
      }
      if (s.type === 'keypress' || s.type === 'dblclick' || s.type === 'navigate') break;
    }
    this.emit('warn', `다운로드(${name || '이름 없음'})를 일으킨 클릭을 찾지 못했습니다. 필요하면 해당 클릭 스텝을 "파일 다운로드로 바꾸기" 해 주세요.`);
  }

  onPageClose(page) {
    if (this.stopping || this.state === 'stopped') return;
    const pageId = this.pageId(page);
    const url = page.url();
    const usedInSteps = this.main.some((s) => s.meta?.pageId === pageId);
    // 사이트가 연 팝업이 닫히면 closeTab (창이 닫히며 마지막 클릭이 유실될 수 있으므로).
    // 다운로드만 하고 닫힌 창, 문서를 한 번도 열지 않은 빈 창은 뺀다.
    const blank = !url || url === 'about:blank';
    const downloadOnly = (this.downloadPages.has(page) || blank) && !usedInSteps;
    if (page !== this.mainPage && this.popups.has(page) && !downloadOnly && this.state === 'recording') {
      const at = Date.now();
      this.later(() => this.addStep({ type: 'closeTab', meta: { url, pageId, ts: at } }), CLOSE_SETTLE_MS);
    }
    if (this.activePage === page) this.activePage = null;
    if (this.ctx && this.ctx.pages().length === 0) this.finishByUser('녹화 브라우저 창이 모두 닫혔습니다.');
  }

  /** 사용자가 브라우저를 닫아 녹화가 끝난 경우 */
  finishByUser(reason) {
    if (this.stopping || this.state === 'stopped' || this.state === 'idle' || this.state === 'starting') return;
    this.stopping = true;
    clearInterval(this.poller);
    this.runTimersNow();
    this.chain.then(async () => {
      await this.ctx?.close().catch(() => {});
      this.setState('stopped');
      this.emit('ended', { reason });
    });
  }

  // ---------- 스텝 목록 ----------
  findStep(id) {
    if (!id) return null;
    for (const steps of Object.values(this.recipe.blocks)) {
      const s = steps.find((x) => x.id === id);
      if (s) return s;
    }
    return null;
  }

  newId() {
    const used = new Set(Object.values(this.recipe.blocks).flat().map((s) => s.id));
    let id;
    do id = `s${(this.seq += 1)}`;
    while (used.has(id));
    return id;
  }

  /**
   * 스텝을 넣는다. 기본은 시간 순서 자리(늦게 도착한 이벤트도 제자리에), before/after 로 특정 스텝 옆에.
   */
  addStep(step, { key, eid, before, after, append } = {}) {
    const steps = this.main;
    const s = { id: this.newId(), ...step };
    const ts = s.meta?.ts ?? Date.now();
    let at = steps.length;
    if (before && steps.includes(before)) at = steps.indexOf(before);
    else if (after && steps.includes(after)) at = steps.indexOf(after) + 1;
    else if (!append) while (at > 0 && (steps[at - 1].meta?.ts ?? 0) > ts) at -= 1;
    const prev = steps[at - 1];
    if (s.meta) s.meta.recordedGapMs = prev?.meta?.ts ? Math.max(0, ts - prev.meta.ts) : 0;
    steps.splice(at, 0, s);
    if (key) this.stepKey.set(s.id, key);
    if (eid) this.eidStep.set(eid, s.id);
    this.changed();
    return s;
  }

  /** 비밀번호 칸 → 실행 때 입력받는 비밀 변수 (같은 이름의 칸은 같은 변수) */
  secretVariable(target) {
    const base =
      String(target?.meta?.label || target?.meta?.name || '비밀번호')
        .replace(/[{}|]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 30) || '비밀번호';
    const vars = (this.recipe.variables ??= []);
    for (let n = 1; ; n += 1) {
      const id = n === 1 ? base : `${base}${n}`;
      const v = vars.find((x) => x.id === id || x.name === id);
      if (!v) {
        vars.push({ id, name: id, source: { kind: 'prompt', secret: true } });
        return id;
      }
      if (v.source?.kind === 'prompt' && v.source.secret) return v.id;
    }
  }

  setState(state) {
    this.state = state;
    this.changed();
  }

  changed() {
    this.emit('change', { state: this.state, recipe: this.recipe });
  }
}
