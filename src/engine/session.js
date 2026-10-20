// 실행 세션: 브라우저 하나에서 업무 탭·팝업 전환, 알림창 응답 방침, 다운로드 대기를 맡는다. 실행기와 AI 관찰기가 같이 쓴다.

import { DOM_SCRIPT, PLAY_SCRIPT, asInitScript, asExpression } from '../recorder/scripts.js';

const DIALOG_KO = { alert: '알림', confirm: '확인창', prompt: '입력창', beforeunload: '페이지 나가기' };
const clip = (s, n = 60) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** 사용자가 중지했을 때 진행 중인 대기를 끊는 신호 */
export class StopSignal extends Error {
  constructor() {
    super('사용자가 실행을 중지했습니다.');
    this.signal = true;
    this.stop = true;
  }
}

export class Session {
  /**
   * @param {{ctx: import('playwright-core').BrowserContext, log?: (level: string, message: string) => void}} o
   */
  constructor({ ctx, log = () => {} }) {
    this.ctx = ctx;
    this.log = log;
    this.work = null; // 업무 탭 (행마다 이 탭만 남긴다)
    this.current = null; // 지금 스텝을 실행할 탭
    this.history = []; // 팝업이 닫히면 돌아갈 탭들
    this.dialogQueue = []; // dialog 스텝이 걸어 둔 다음 알림창 방침
    this.dialogs = []; // 이번 행에 뜬 알림창
    this.lastDialogMessage = '';
    this.downloadWaiters = [];
    this.downloadCount = 0;
    this.attached = new WeakSet();
    this.sitePages = new Set(); // 업무 탭 + 사이트가 연 창 (브라우저가 스스로 만든 빈 탭은 뺀다)
    this.aborted = false;
  }

  async init() {
    await this.ctx.addInitScript({ content: asInitScript(DOM_SCRIPT, PLAY_SCRIPT) });
    this.ctx.on('page', (p) => this.attach(p));
    for (const p of this.ctx.pages()) this.attach(p);
    this.work = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    this.sitePages.add(this.work);
    this.current = this.work;
    for (const f of this.work.frames()) await f.evaluate(asExpression(DOM_SCRIPT, PLAY_SCRIPT)).catch(() => {});
  }

  attach(page) {
    if (this.attached.has(page)) return;
    this.attached.add(page);
    page.on('dialog', (d) => this.onDialog(d));
    page.on('download', (d) => this.onDownload(d));
    page.on('popup', (p) => this.onPopup(p));
    page.on('close', () => this.onClose(page));
    page.on('filechooser', () => {}); // 파일 선택창은 가로채 둔다 (OS 창이 떠서 멈추지 않게)
  }

  checkAbort() {
    if (this.aborted) throw new StopSignal();
  }

  // ---------- 탭 ----------
  /** 지금 탭 (닫혔으면 돌아갈 탭, 없으면 새 탭) */
  async livePage() {
    if (this.current && !this.current.isClosed()) return this.current;
    const alive = [...this.history].reverse().find((p) => !p.isClosed()) ?? (this.work && !this.work.isClosed() ? this.work : null) ?? this.pages()[0];
    if (alive) {
      this.current = alive;
      return alive;
    }
    this.work = await this.ctx.newPage();
    this.sitePages.add(this.work);
    this.current = this.work;
    return this.work;
  }

  get page() {
    return this.current && !this.current.isClosed() ? this.current : null;
  }

  /** 업무 탭과 사이트가 연 창 (열린 것만) */
  pages() {
    return [...this.sitePages].filter((p) => !p.isClosed());
  }

  /** 사이트가 연 창(opener 가 있는 창)으로 옮긴다. */
  onPopup(p) {
    this.attach(p);
    this.sitePages.add(p);
    if (p.isClosed() || this.current === p) return;
    if (this.current && !this.current.isClosed()) this.history.push(this.current);
    this.current = p;
    this.log('info', '사이트가 새 창을 열어 그 창에서 계속합니다.');
  }

  /** 창이 닫히면 직전 탭으로 돌아온다. */
  onClose(page) {
    this.sitePages.delete(page);
    this.history = this.history.filter((p) => p !== page && !p.isClosed());
    if (page === this.work) this.work = null;
    if (this.current === page) {
      this.current = this.history.pop() ?? this.work ?? this.pages()[0] ?? null;
      if (!this.quietClose) this.log('info', '창이 닫혀 이전 창으로 돌아왔습니다.');
    }
  }

  switchTo(page, reason) {
    if (page === this.current) return;
    if (this.current && !this.current.isClosed()) this.history.push(this.current);
    this.current = page;
    this.log('info', `${reason} — ${clip(page.url(), 80)} 탭으로 전환했습니다.`);
  }

  /** 행 시작: 업무 탭 하나만 남기고 나머지를 닫는다. 알림창 방침·기록도 비운다. */
  async resetRow() {
    this.dialogQueue = [];
    this.dialogs = [];
    this.lastDialogMessage = '';
    for (const w of this.downloadWaiters.splice(0)) w.cancel();
    if (!this.work || this.work.isClosed()) {
      this.work = this.pages()[0] ?? (await this.ctx.newPage());
      this.sitePages.add(this.work);
    }
    this.quietClose = true;
    try {
      // 브라우저가 스스로 만든 빈 탭은 건드리지 않는다 (닫기가 끝나지 않는 경우가 있다)
      for (const p of this.pages()) if (p !== this.work) await Promise.race([p.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    } finally {
      this.quietClose = false;
    }
    this.history = [];
    this.current = this.work;
  }

  // ---------- 알림창 ----------
  queueDialog(policy) {
    this.dialogQueue.push(policy);
  }

  /** 방침이 있으면 그대로, 없으면 알림은 확인·확인창/입력창은 취소 (예상 못 한 동작을 승인하지 않는다). */
  async onDialog(dialog) {
    const type = dialog.type();
    const message = dialog.message();
    this.lastDialogMessage = message;
    this.dialogs.push({ type, message, at: Date.now() });
    const policy = type === 'beforeunload' ? null : this.dialogQueue.shift();
    const accept = policy ? policy.action !== 'dismiss' : type === 'alert' || type === 'beforeunload';
    try {
      if (accept) await dialog.accept(type === 'prompt' ? (policy?.promptText ?? dialog.defaultValue()) : undefined);
      else await dialog.dismiss();
    } catch {
      /* 이미 닫힌 알림창 */
    }
    const how = accept ? '확인' : '취소';
    const why = policy ? '' : type === 'alert' || type === 'beforeunload' ? ' (기본 응답)' : ' (지정된 응답이 없어 기본으로 취소)';
    this.log(policy || accept ? 'info' : 'warn', `알림창(${DIALOG_KO[type] ?? type}) "${clip(message)}" → ${how}${why}`);
  }

  // ---------- 다운로드 ----------
  onDownload(d) {
    this.downloadCount += 1;
    const w = this.downloadWaiters.shift();
    if (w) w.resolve(d);
    else {
      let name = '';
      try {
        name = d.suggestedFilename();
      } catch {
        /* 이름 없음 */
      }
      this.log('warn', `다운로드 스텝이 아닌 곳에서 파일이 받아졌습니다 (${name}) — 저장하지 않습니다. 필요하면 그 클릭을 "다운로드 저장" 스텝으로 바꾸세요.`);
    }
  }

  /** 어느 탭에서 시작되든 다음 다운로드 하나를 기다린다. */
  waitDownload(timeoutMs) {
    let entry;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.downloadWaiters = this.downloadWaiters.filter((x) => x !== entry);
        reject(Object.assign(new Error(`다운로드가 ${Math.round(timeoutMs / 1000)}초 안에 시작되지 않았습니다.`), { sideEffect: true }));
      }, timeoutMs);
      entry = {
        resolve: (d) => {
          clearTimeout(timer);
          resolve(d);
        },
        cancel: () => {
          clearTimeout(timer);
          this.downloadWaiters = this.downloadWaiters.filter((x) => x !== entry);
          reject(Object.assign(new Error('다운로드 대기를 취소했습니다.'), { cancelled: true }));
        },
      };
    });
    promise.catch(() => {});
    this.downloadWaiters.push(entry);
    return { promise, cancel: () => entry.cancel() };
  }

  // ---------- 페이지 안 도구 ----------
  /** 프레임에서 window.__webRpa[method](...args) 를 부른다. 도구가 없으면 설치하고 다시 부른다. */
  async callLib(frame, method, ...args) {
    const run = () =>
      frame.evaluate(
        ([m, a]) => {
          const L = window.__webRpa;
          if (!L) return { missing: true };
          return { value: L[m](...a) };
        },
        [method, args],
      );
    let r = await run();
    if (r?.missing) {
      await frame.evaluate(asExpression(DOM_SCRIPT, PLAY_SCRIPT));
      r = await run();
    }
    if (!r || r.missing) throw new Error('페이지 도구를 설치하지 못했습니다.');
    return r.value;
  }
}
