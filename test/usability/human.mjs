// 사람처럼 화면을 조작하는 과제 도우미: 보이는 이름으로 찾기, 단추마다 0.4–0.8초 쉬기, 자막·클릭 표시,
// 녹화(recordVideo → mp4), 핵심 순간 캡처, 클릭 수·시간·콘솔 오류·헤맨 지점·확인창 기록.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sleep } from './env.mjs';

const CAP_KEY = '__usab_cap';
// 영상 위 자막(왼쪽 아래 두 줄: 과제 이름 / 지금 하는 일), 처음 1.8초는 과제 흐름, 끝 2초는 결과 카드.
// 모두 pointer-events:none 이라 조작에 끼어들지 않는다. 상태는 localStorage 에 두어 새로 고침·화면 이동에도 남는다.
const OVERLAY = '(' + function overlay(KEY) {
  const font = '"Malgun Gothic","Apple SD Gothic Neo",sans-serif';
  const ensure = () => {
    if (!document.body) return;
    let st = {};
    try {
      st = JSON.parse(localStorage.getItem(KEY) || '{}');
    } catch {}
    let d = document.getElementById('__usab_cap');
    if (!d) {
      d = document.createElement('div');
      d.id = '__usab_cap';
      d.setAttribute('aria-hidden', 'true');
      d.append(document.createElement('div'), document.createElement('div'));
      document.body.appendChild(d);
    }
    const intro = st.mode === 'intro';
    d.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2147483647;pointer-events:none;background:rgba(17,24,39,.88);color:#fff;font-family:' + font + ';padding:' + (intro ? '10px 14px' : '6px 12px') + ';border-radius:8px;max-width:min(calc(100vw - 20px),780px);box-shadow:0 2px 10px rgba(0,0,0,.35);' + (st.title || st.action ? '' : 'display:none;') + (intro ? 'border-left:5px solid #60a5fa;' : '');
    d.children[0].style.cssText = 'font-size:' + (intro ? '15px' : '12px') + ';font-weight:600;opacity:' + (intro ? '1' : '.75') + ';line-height:1.4';
    d.children[1].style.cssText = 'font-size:' + (intro ? '16px' : '14.5px') + ';font-weight:700;line-height:1.45;margin-top:2px';
    d.children[0].textContent = st.title || '';
    d.children[1].textContent = st.action || '';
    let f = document.getElementById('__usab_final');
    if (!st.final) {
      if (f) f.remove();
      return;
    }
    if (!f) {
      f = document.createElement('div');
      f.id = '__usab_final';
      f.setAttribute('aria-hidden', 'true');
      document.body.appendChild(f);
    }
    const ok = st.final.status === '성공';
    f.style.cssText = 'position:fixed;left:50%;bottom:72px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;background:rgba(255,255,255,.97);color:#111827;font-family:' + font + ';padding:18px 26px;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.35);border:4px solid ' + (ok ? '#16a34a' : st.final.status === '일부' ? '#d97706' : '#dc2626') + ';min-width:min(320px,calc(100vw - 40px));max-width:min(680px,calc(100vw - 40px))';
    f.replaceChildren();
    const head = document.createElement('div');
    head.style.cssText = 'font-size:20px;font-weight:800;margin-bottom:6px;color:' + (ok ? '#15803d' : st.final.status === '일부' ? '#b45309' : '#b91c1c');
    head.textContent = st.final.head;
    f.append(head);
    for (const line of st.final.lines || []) {
      const p = document.createElement('div');
      p.style.cssText = 'font-size:15px;line-height:1.5;margin-top:3px';
      p.textContent = line;
      f.append(p);
    }
  };
  window.__usabCap = ensure;
  document.addEventListener('DOMContentLoaded', ensure);
  setInterval(ensure, 400);
} + ')(' + JSON.stringify(CAP_KEY) + ');';

const rand = (a, b) => a + Math.floor(Math.random() * (b - a));

export class Task {
  constructor(browser, { id, title, flow = '', outDir, viewport = { width: 1280, height: 800 }, env, mobile = false }) {
    Object.assign(this, { browser, id, title, flow, outDir, viewport, env, mobile });
    this.outcomes = [];
    this.introduced = false;
    this.clicks = 0;
    this.actions = [];
    this.wanders = [];
    this.notes = [];
    this.checks = [];
    this.shots = [];
    this.dialogs = [];
    this.consoleErrors = [];
    this.answers = [];
    this.status = null;
    this.t0 = 0;
  }

  async open() {
    const videoDir = path.join(this.outDir, 'videos', 'raw', this.id);
    await fs.rm(videoDir, { recursive: true, force: true });
    this.context = await this.browser.newContext({
      viewport: this.viewport,
      recordVideo: { dir: videoDir, size: this.viewport },
      locale: 'ko-KR',
      acceptDownloads: true,
      ...(this.mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    });
    await this.context.addInitScript({ content: OVERLAY });
    this.page = await this.context.newPage();
    this.page.on('console', (m) => m.type() === 'error' && this.consoleErrors.push(`console: ${m.text()}`));
    this.page.on('pageerror', (e) => this.consoleErrors.push(`pageerror: ${e.message}`));
    // 확인창(브라우저 기본 창)은 영상에 안 보이므로, 답한 뒤 그 문구를 자막으로 잠깐 보인다.
    // (창이 떠 있는 동안 page.evaluate 를 부르면 멈추므로 먼저 답한다)
    this.page.on('dialog', async (d) => {
      const a = this.answers.shift();
      const msg = d.message();
      this.dialogs.push({ at: this.elapsed(), type: d.type(), message: msg, answer: a === undefined ? '(확인)' : String(a) });
      await sleep(400);
      if (a === false) await d.dismiss().catch(() => {});
      else await d.accept(typeof a === 'string' ? a : d.type() === 'prompt' ? d.defaultValue() : undefined).catch(() => {});
      setTimeout(() => this.caption(`[${d.type() === 'prompt' ? '입력창' : '확인창'}] ${msg.replace(/\s+/g, ' ').slice(0, 110)} → ${a === false ? '취소' : typeof a === 'string' ? `"${a}"` : '확인'}`, { keep: true }), 50);
    });
    this.t0 = Date.now();
    return this.page;
  }

  elapsed() {
    const s = Math.round((Date.now() - this.t0) / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  async setOverlay(state) {
    await this.page
      .evaluate(
        ([k, v]) => {
          try {
            localStorage.setItem(k, v);
          } catch {}
          window.__usabCap?.();
        },
        [CAP_KEY, JSON.stringify(state)],
      )
      .catch(() => {});
  }

  /** 자막: 첫 줄 "T5 · 과제 이름", 둘째 줄 지금 하는 일. 과제의 첫 자막 앞에는 과제 흐름("할 일: …")을 1.8초 보인다 */
  async caption(text, { keep = false } = {}) {
    const title = `${this.id} · ${this.title}`;
    if (!this.introduced && this.flow) {
      this.introduced = true;
      await this.setOverlay({ title, action: `할 일: ${this.flow}`, mode: 'intro' });
      await sleep(1800);
    }
    this.introduced = true;
    if (!keep) this.lastAction = text;
    await this.setOverlay({ title, action: keep ? `${this.lastAction ?? ''}  ${text}` : text });
    this.actions.push({ at: this.elapsed(), caption: text });
  }

  /** 끝 장면에 보일 결과 한 줄 */
  outcome(text) {
    this.outcomes.push(String(text));
  }

  /** 끝 장면: 결과 카드를 2초 남짓 보인다 */
  async finale() {
    const status = this.computeStatus();
    const core = this.checks.filter((c) => c.core);
    const okN = core.filter((c) => c.ok).length;
    const lines = [...this.outcomes.slice(-3), `성공 기준 ${okN}/${core.length} 충족${this.wanders.length ? ` · 헤맴 ${this.wanders.length}` : ''}`];
    await this.setOverlay({ title: `${this.id} · ${this.title}`, action: '결과', final: { status, head: `${this.id} 결과: ${status}`, lines } });
    await sleep(2200);
  }

  /** 과제 성공 여부는 규약의 성공 기준(핵심 점검)으로만 정한다. "[R…]"·"[확인]" 은 이전 회차 문제·회귀 확인용 */
  computeStatus() {
    const core = this.checks.filter((c) => c.core);
    const failed = core.filter((c) => !c.ok);
    return !core.length ? '실패' : !failed.length ? '성공' : failed.length === core.length ? '실패' : '일부';
  }

  pause(a = 400, b = 800) {
    return sleep(rand(a, b));
  }

  /** 확인·입력창에 줄 답 (true=확인, false=취소, 글자=prompt 입력) */
  answer(...a) {
    this.answers.push(...a);
  }

  async goto(url) {
    await this.page.goto(url);
    await this.page.waitForLoadState('domcontentloaded');
    await this.pause(500, 800);
  }

  async mark(loc) {
    const box = await loc.boundingBox().catch(() => null);
    if (!box) return;
    await this.page
      .evaluate(({ x, y }) => {
        const d = document.createElement('div');
        d.style.cssText = `position:fixed;left:${x - 14}px;top:${y - 14}px;width:28px;height:28px;border-radius:50%;border:3px solid #ef4444;background:rgba(239,68,68,.18);z-index:2147483646;pointer-events:none;transition:transform .5s,opacity .5s`;
        document.body.appendChild(d);
        setTimeout(() => ((d.style.transform = 'scale(1.8)'), (d.style.opacity = '0')), 60);
        setTimeout(() => d.remove(), 700);
      }, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
      .catch(() => {});
  }

  async ready(loc, timeout = 6000) {
    await loc.waitFor({ state: 'visible', timeout });
    await loc.scrollIntoViewIfNeeded().catch(() => {});
  }

  /** 단추 누르기 (보이는 이름으로 찾은 locator) */
  async click(loc, label = '', { timeout = 6000, force = false } = {}) {
    await this.ready(loc, timeout);
    await loc.hover({ timeout: 2000 }).catch(() => {});
    await this.pause();
    await this.mark(loc);
    await loc.click({ timeout: 4000, force });
    this.clicks += 1;
    this.actions.push({ at: this.elapsed(), click: label });
    await this.pause(300, 500);
  }

  /** 글자 입력 (칸을 누르고 사람처럼 친다) */
  async type(loc, text, label = '', { clear = true, delay = 22 } = {}) {
    await this.ready(loc);
    await this.pause(300, 500);
    await this.mark(loc);
    await loc.click();
    this.clicks += 1;
    if (clear) await loc.fill('');
    await loc.pressSequentially(text, { delay });
    this.actions.push({ at: this.elapsed(), type: label || text });
    await this.pause(300, 500);
  }

  async choose(loc, option, label = '') {
    await this.ready(loc);
    await this.pause();
    await this.mark(loc);
    await loc.selectOption(option);
    this.clicks += 1;
    this.actions.push({ at: this.elapsed(), select: `${label} = ${JSON.stringify(option)}` });
    await this.pause(300, 600);
  }

  async check(loc, label = '') {
    await this.ready(loc);
    await this.pause();
    await this.mark(loc);
    await loc.check();
    this.clicks += 1;
    this.actions.push({ at: this.elapsed(), check: label });
    await this.pause(300, 500);
  }

  /**
   * 사람이 찾을 법한 여러 경로를 차례로 본다. 첫 경로에 없으면 헤맴으로 남긴다.
   * @param {Array<[string, () => import('playwright-core').Locator]>} ways
   */
  async find(what, ways, { timeout = 1500 } = {}) {
    for (let i = 0; i < ways.length; i += 1) {
      const [desc, fn] = ways[i];
      const loc = fn();
      const ok = await loc
        .first()
        .waitFor({ state: 'visible', timeout })
        .then(() => true)
        .catch(() => false);
      if (ok) {
        if (i > 0) this.wander(`${what}: "${ways[0][0]}" 로 찾지 못해 "${desc}" 로 찾음`);
        return loc.first();
      }
      if (i < ways.length - 1) await this.pause(600, 900); // 찾는 데 쓴 시간
    }
    this.wander(`${what}: 찾지 못함 (${ways.map((w) => w[0]).join(' / ')})`);
    return null;
  }

  wander(text) {
    this.wanders.push({ at: this.elapsed(), text });
  }

  note(text) {
    this.notes.push({ at: this.elapsed(), text });
  }

  /** 성공 기준 하나 */
  expect(name, ok, detail = '') {
    this.checks.push({ name, ok: !!ok, core: !/^\[(R\d+-\d+|확인)/.test(name), detail: String(detail ?? '').slice(0, 400) });
    return !!ok;
  }

  /** 핵심 순간 캡처 (자막은 잠깐 숨긴다). full 이면 전체 페이지 */
  async shot(name, { full = false, note = '' } = {}) {
    const file = `${this.id}-${name}.png`;
    const p = path.join(this.outDir, 'shots', file);
    const vis = (v) => this.page.evaluate((x) => ['__usab_cap', '__usab_final'].forEach((id) => (x ? document.getElementById(id)?.style.removeProperty('visibility') : document.getElementById(id)?.style.setProperty('visibility', 'hidden'))), v).catch(() => {});
    await vis(false);
    await this.page.screenshot({ path: p, fullPage: full }).catch((e) => this.note(`캡처 실패 ${file}: ${e.message}`));
    await vis(true);
    this.shots.push({ file: `shots/${file}`, at: this.elapsed(), note });
  }

  /** 끝: 영상 저장(mp4), 결과 */
  async close() {
    this.timeMs = Date.now() - this.t0;
    await this.pause(800, 1000);
    const video = this.page.video();
    await this.context.close();
    const raw = await video?.path().catch(() => null);
    if (raw) {
      const mp4 = path.join(this.outDir, 'videos', `${this.id}.mp4`);
      const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '27', '-movflags', '+faststart', mp4], { encoding: 'utf8' });
      if (r.status !== 0) this.note(`mp4 변환 실패: ${r.stderr}`);
      else this.video = `videos/${this.id}.mp4`;
    }
    this.status ??= this.computeStatus();
    return this.result();
  }

  result() {
    return {
      id: this.id,
      title: this.title,
      status: this.status,
      seconds: Math.round((this.timeMs ?? 0) / 1000),
      clicks: this.clicks,
      checks: this.checks,
      wanders: this.wanders,
      notes: this.notes,
      dialogs: this.dialogs,
      consoleErrors: this.consoleErrors,
      shots: this.shots,
      video: this.video ?? null,
      actions: this.actions,
    };
  }
}
