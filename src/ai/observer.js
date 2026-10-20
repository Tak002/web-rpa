// AI 화면 관찰기: 숨긴 브라우저로 레시피를 지정 스텝까지 실행한 뒤 화면 요소 목록(참조 번호 f<프레임>e<번호>)을 만들고,
// 참조 번호로 녹화기와 같은 규칙의 타겟 번들을 돌려준다. 출력 스텝은 건너뛰고, 되돌릴 수 없는 버튼은 허용 없이는 누르지 않는다.

import os from 'node:os';
import path from 'node:path';
import { startBrowser, framePathOf } from '../browser.js';
import { Session } from '../engine/session.js';
import { Executor, Signal } from '../engine/executor.js';
import { Scope } from '../engine/vars.js';
import { doNavigate } from '../engine/actions.js';
import { targetName } from '../../public/shared/steps.js';

const OUTPUT_STEPS = new Set(['pdf', 'screenshot', 'download', 'upload']);
// 제출·신고·결제·삭제·발송처럼 되돌릴 수 없는 동작의 버튼 이름
const RISKY = /제출|신고|결제|삭제|발송|송금|이체|납부하기|전송|신청하기|해지|탈퇴|승인|확정|파기|구매|주문|계약/;
const MAX_PER_FRAME = 250;
const MAX_LINES = 600;
const firstLine = (s) => String(s ?? '').split('\n')[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN_ONLY = /^\{\{\s*([^{}|]+?)\s*(?:\|[^{}]*)?\}\}$/;

/** 엑셀 연결 때 남긴 녹화 값(meta.recordedValue)으로 견본 행을 만든다 { 열 이름: 값 }. */
export function sampleRowFrom(recipe) {
  const out = {};
  const vars = recipe?.variables ?? [];
  for (const steps of Object.values(recipe?.blocks ?? {})) {
    for (const s of Array.isArray(steps) ? steps : []) {
      if (s?.meta?.recordedValue === undefined || typeof s.value !== 'string') continue;
      const m = TOKEN_ONLY.exec(s.value.trim());
      if (!m) continue;
      const name = m[1].trim();
      const v = vars.find((x) => x?.id === name || x?.name === name);
      const col = v?.source?.kind === 'excel' ? v.source.column || v.name || v.id : name;
      if (!(col in out)) out[col] = String(s.meta.recordedValue);
    }
  }
  return out;
}

function riskyLabel(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t && t.length <= 20 && RISKY.test(t) ? t : null;
}

const riskError = (name, step) =>
  Object.assign(new Error(`"${name}" 은(는) 되돌릴 수 없는 동작(제출·신고·결제·삭제·발송 등)일 수 있어 관찰 실행에서 누르지 않았습니다. 이 스텝 전까지만 관찰하거나, 사용자가 허용하면 누를 수 있습니다.`), {
    failure: step ? { stepId: step.id } : undefined,
  });

export class Observer {
  /**
   * @param {{recipe: object, profileDir: string, browser?: object, sampleRow?: object, allowRisky?: boolean, onLog?: (m: string) => void}} o
   */
  constructor({ recipe, profileDir, browser, sampleRow = {}, allowRisky = false, onLog }) {
    this.recipe = recipe;
    this.profileDir = profileDir;
    this.browser = browser;
    this.sampleRow = sampleRow ?? {};
    this.allowRisky = !!allowRisky;
    this.onLog = onLog;
    this.ctx = null;
    this.sess = null;
    this.refFrames = [];
  }

  note(m) {
    try {
      this.onLog?.(m);
    } catch {
      /* 로그 실패는 무시 */
    }
  }

  async open() {
    if (this.ctx) return;
    this.ctx = await startBrowser({ profileDir: this.profileDir, headless: true, browser: this.browser });
    this.sess = new Session({ ctx: this.ctx, log: (_level, m) => this.note(m) });
    await this.sess.init();
  }

  async close() {
    const ctx = this.ctx;
    this.ctx = null;
    this.sess = null;
    this.refFrames = [];
    await ctx?.close().catch(() => {});
  }

  /** 되돌릴 수 없는 버튼인지 (녹화 이름 기준) */
  riskyStep(step) {
    if (this.allowRisky || !['click', 'dblclick'].includes(step.type) || !step.target) return null;
    const m = step.target.meta ?? {};
    for (const t of [m.label, m.text, targetName(step.target), ...(step.target.candidates ?? []).filter((c) => c.kind === 'text').map((c) => c.value?.text)]) {
      const hit = riskyLabel(t);
      if (hit) return hit;
    }
    return null;
  }

  /** 실제 화면의 버튼 글자로 한 번 더 확인 */
  async guard(loc) {
    if (this.allowRisky) return;
    const text = await loc.handle
      .evaluate((el) => [el.innerText, el.value, el.getAttribute('aria-label'), el.getAttribute('title')].filter((x) => typeof x === 'string' && x.trim()).join(' / '))
      .catch(() => '');
    for (const part of String(text).split(' / ')) {
      const hit = riskyLabel(part);
      if (hit) throw riskError(hit);
    }
  }

  /** 화면이 다 그려질 때까지 (불러오기 + DOM 변화가 잠잠해질 때까지, 최대 5초) */
  async settle() {
    const page = await this.sess.livePage();
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page
      .evaluate(
        ([quiet, max]) =>
          new Promise((resolve) => {
            let t = 0;
            const done = () => {
              o.disconnect();
              clearTimeout(t);
              clearTimeout(cap);
              resolve(true);
            };
            const o = new MutationObserver(() => {
              clearTimeout(t);
              t = setTimeout(done, quiet);
            });
            o.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
            t = setTimeout(done, quiet);
            const cap = setTimeout(done, max);
          }),
        [800, 5000],
      )
      .catch(() => sleep(500));
  }

  /**
   * 레시피를 처음부터 stepId 까지(포함) 실행한다. stepId 가 없으면 시작 주소만 연다.
   * @returns {Promise<{ok: boolean, error?: string, failedStep?: string}>}
   */
  async runTo(stepId) {
    await this.open();
    const sess = this.sess;
    sess.aborted = false;
    await sess.resetRow();
    const recipe = this.recipe;
    const params = {};
    for (const v of recipe.variables ?? []) if (v?.source?.kind === 'prompt') params[v.id] = v.source.default ?? '';
    const missing = new Set();
    const scope = new Scope({
      recipe,
      row: { ...this.sampleRow },
      rowNumber: 1,
      params,
      extracted: {},
      dialog: () => sess.lastDialogMessage,
      lenient: true,
      onMissing: (n) => {
        if (!missing.has(n)) this.note(`견본 값이 없는 변수 {{${n}}} 는 빈 값으로 넣습니다.`);
        missing.add(n);
      },
    });
    const rc = {
      sess,
      scope,
      recipe,
      options: { headless: true },
      runDir: os.tmpdir(),
      filesDir: path.join(os.tmpdir(), 'web-rpa-observe'),
      log: (_level, m) => this.note(m),
      sleep,
      waitUser: async () => {},
      addFile: () => {},
      guardClick: (loc) => this.guard(loc),
    };
    const entry = recipe.blocks?.[recipe.entryBlock || 'main'] ?? [];
    try {
      if (!stepId || entry[0]?.type !== 'navigate') {
        if (!recipe.startUrl) throw new Error('레시피에 시작 주소가 없습니다.');
        await doNavigate(rc, { url: recipe.startUrl });
      }
      if (!stepId) {
        await this.settle();
        return { ok: true };
      }
      if (!Object.values(recipe.blocks ?? {}).some((steps) => Array.isArray(steps) && steps.some((s) => s?.id === stepId))) return { ok: false, error: `스텝 ${stepId} 이(가) 레시피에 없습니다.` };
      const executor = new Executor({
        recipe,
        log: (_level, m) => this.note(m),
        hooks: {
          before: (step) => {
            if (OUTPUT_STEPS.has(step.type)) return { skip: true, note: '관찰 실행에서는 출력 스텝(PDF·캡처·다운로드·첨부)을 건너뜁니다' };
            if (step.type === 'pause') return { skip: true, note: '관찰 실행에서는 사용자 확인 대기를 건너뜁니다' };
            const risky = this.riskyStep(step);
            if (risky) throw riskError(risky, step);
            return null;
          },
          after: (step) => {
            if (step.id === stepId) throw new Signal('관찰 목표 스텝까지 실행했습니다.', { reached: true });
          },
          step: (e) => {
            if (e.status === 'start') this.note(`${e.block === (recipe.entryBlock || 'main') ? '' : `[${e.block}] `}${e.index + 1}. ${e.desc}`);
            if (e.status === 'skip' && e.note) this.note(`   건너뜀: ${e.note}`);
          },
        },
      });
      await executor.runRow(rc);
      return { ok: false, error: `스텝 ${stepId} 까지 가지 못했습니다 (분기에서 다른 길로 갔을 수 있습니다).` };
    } catch (e) {
      if (e.reached) {
        await this.settle();
        return { ok: true };
      }
      await this.settle().catch(() => {});
      return { ok: false, error: firstLine(e.message), failedStep: e.failure?.stepId };
    }
  }

  /** 지금 화면의 요소 목록 (참조 번호 f<프레임>e<번호>) */
  async snapshot() {
    if (!this.sess) throw new Error('관찰 브라우저가 열려 있지 않습니다.');
    const page = await this.sess.livePage();
    const frames = page.frames();
    this.refFrames = frames;
    const title = await page.title().catch(() => '');
    const out = [`페이지: ${title || '(제목 없음)'} — ${page.url()}`];
    const others = this.sess.pages().filter((p) => p !== page);
    if (others.length) out.push(`다른 창: ${others.map((p) => p.url()).join(' · ')}`);
    for (let i = 0; i < frames.length; i += 1) {
      if (out.length >= MAX_LINES) {
        out.push(`(요소가 많아 여기까지만 보여 줍니다 — 프레임 ${frames.length}개 중 ${i}개)`);
        break;
      }
      const f = frames[i];
      const depth = framePathOf(f).length;
      const head = `# 프레임 f${i}${i === 0 ? ' (메인)' : ''}${f.name() ? ` name="${f.name()}"` : ''}${depth > 1 ? ` (안쪽 ${depth}단계)` : ''} ${f.url()}`;
      let snap;
      try {
        snap = await this.sess.callLib(f, 'snapshot', MAX_PER_FRAME);
      } catch (e) {
        out.push(head, `(이 프레임은 읽지 못했습니다: ${firstLine(e.message)})`);
        continue;
      }
      out.push(head);
      for (const line of snap.lines.slice(0, Math.max(0, MAX_LINES - out.length))) out.push(`f${i}${line}`);
      if (!snap.lines.length) out.push('(보이는 요소 없음)');
      if (snap.truncated) out.push(`(요소가 많아 앞 ${MAX_PER_FRAME}개만 보여 줍니다)`);
    }
    return out.join('\n');
  }

  /** 참조 번호 → 타겟 번들 (녹화기와 같은 규칙) */
  async targetFor(ref) {
    const m = /^f(\d+)e(\d+)$/.exec(String(ref ?? '').trim());
    if (!m) throw new Error(`참조 번호 형식이 아닙니다: "${ref}" (예: f0e12)`);
    const frame = this.refFrames[Number(m[1])];
    if (!this.sess || !frame || frame.isDetached()) throw new Error(`프레임 f${m[1]} 을(를) 찾을 수 없습니다. 화면을 다시 관찰해 주세요.`);
    const t = await this.sess.callLib(frame, 'targetOfRef', Number(m[2]));
    return { framePath: framePathOf(frame), candidates: t.candidates, meta: t.meta };
  }
}
