// 블록 실행기: 스텝을 차례로 실행한다 (꺼짐·재시도·없으면 건너뜀·실패해도 계속·분기 호출·무한 반복 상한).
// 실행기(Runner)와 AI 관찰기(Observer)가 같이 쓴다. 화면에 알리는 일은 hooks 로 바깥에 맡긴다.

import { stepText } from '../../public/shared/steps.js';
import { checkCondition, waitFor, usesDialog, describeCondition } from './conditions.js';
import { doNavigate, doInput, doSelect, doCheck, doKeypress, doExtract, doDownload, doUpload, doCloseTab, clickElement, locateFor } from './actions.js';
import { savePdf, saveScreenshot } from './output.js';

const MAX_DEPTH = 12; // 블록 호출 중첩 상한
const MAX_STEPS_PER_ROW = 3000; // 한 행에서 실행할 수 있는 스텝 수 (무한 반복 방지)
const HUMAN_GAP_MAX_MS = 3000;
const ONCE = new Set(['download', 'pdf', 'upload', 'dialog', 'pause', 'branch', 'closeTab']); // 재시도하지 않는 스텝
const PACED = new Set(['click', 'dblclick', 'input', 'select', 'check', 'keypress', 'download', 'upload']);
const firstLine = (s) => String(s ?? '').split('\n')[0];

/** 실행을 멈추게 하는 신호 (중지·관찰 목표 도달 등) — 스텝 실패로 보지 않는다 */
export class Signal extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.signal = true;
    Object.assign(this, extra);
  }
}

export class Executor {
  /**
   * @param {{recipe: object, log: Function, options?: object, hooks?: {checkpoint?: Function, before?: Function, step?: Function}}} o
   */
  constructor({ recipe, log, options = {}, hooks = {} }) {
    this.recipe = recipe;
    this.log = log;
    this.options = options;
    this.hooks = hooks;
  }

  /** 한 행: 시작 블록을 실행한다. rc 는 행 실행 문맥 (sess, scope, files …). */
  async runRow(rc) {
    this.budget = MAX_STEPS_PER_ROW;
    await this.runBlock(this.recipe.entryBlock || 'main', rc, 0);
  }

  async runBlock(name, rc, depth) {
    if (depth > MAX_DEPTH) throw new Error(`블록 호출이 너무 깊습니다 (${MAX_DEPTH}단계). 분기가 같은 블록을 계속 부르는지 확인해 주세요.`);
    const steps = this.recipe.blocks?.[name];
    if (!Array.isArray(steps)) throw new Error(`블록 "${name}" 이(가) 없습니다.`);
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      await this.hooks.checkpoint?.();
      const info = { stepId: step.id, block: name, index, desc: stepText(step), rowNumber: rc.scope.rowNumber };
      if (step.disabled) {
        this.emit(info, 'skip', { note: '꺼진 스텝' });
        continue;
      }
      this.budget -= 1;
      if (this.budget < 0) throw new Error(`한 행에서 실행한 스텝이 ${MAX_STEPS_PER_ROW}개를 넘었습니다 (무한 반복 의심).`);
      const pre = await this.hooks.before?.(step, info, rc);
      if (pre?.skip) {
        this.emit(info, 'skip', { note: pre.note });
        continue;
      }
      this.emit(info, 'start');
      try {
        const note = await this.runStep(step, info, rc, depth);
        this.emit(info, 'ok', note ? { note } : {});
      } catch (e) {
        if (e.signal) throw e;
        if (e.skip) {
          this.log('info', `건너뜀 — ${info.desc}: ${e.message}`);
          this.emit(info, 'skip', { note: e.message });
          continue;
        }
        if (step.onError === 'continue') {
          this.log('warn', `실패했지만 계속합니다 — ${info.desc}: ${firstLine(e.message)}`);
          this.emit(info, 'fail', { error: firstLine(e.message), note: '실패해도 계속' });
          continue;
        }
        e.failure ??= { stepId: step.id, block: name, index, desc: info.desc };
        this.emit(info, 'fail', { error: firstLine(e.message) });
        throw e;
      }
      await this.hooks.after?.(step, info, rc);
    }
  }

  emit(info, status, extra = {}) {
    this.hooks.step?.({ ...info, status, ...extra });
  }

  async runStep(step, info, rc, depth) {
    if (this.options.humanPacing && PACED.has(step.type)) {
      const gap = Math.min(Math.max(Number(step.meta?.recordedGapMs) || 0, 0), HUMAN_GAP_MAX_MS);
      if (gap > 0) await rc.sleep(gap);
    }
    const max = ONCE.has(step.type) ? 1 : Math.max(1, Math.floor(Number(step.attempts) || 1));
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.relocating(() => this.dispatch(step, info, rc, depth));
      } catch (e) {
        if (e.signal) throw e;
        if (step.optional && (e.notFound || e.timeout)) throw Object.assign(new Error(e.notFound ? '대상이 없어 건너뜁니다.' : '조건이 맞지 않아 건너뜁니다.'), { skip: true });
        if (attempt >= max || e.sideEffect || e.noRetry) throw e;
        this.log('warn', `재시도 ${attempt}/${max - 1} — ${info.desc}: ${firstLine(e.message)}`);
        await rc.sleep(700);
      }
    }
  }

  /** 찾은 요소가 동작 직전에 다시 그려졌으면(아직 아무것도 하지 않은 경우) 한 번 더 찾아서 한다 */
  async relocating(fn) {
    try {
      return await fn();
    } catch (e) {
      if (!e.detached) throw e;
      this.log('info', '대상 요소가 다시 그려져 한 번 더 찾습니다.');
      return fn();
    }
  }

  async dispatch(step, info, rc, depth) {
    switch (step.type) {
      case 'navigate':
        return doNavigate(rc, step);
      case 'click':
      case 'dblclick': {
        const loc = await locateFor(rc, step);
        return clickElement(rc, loc, { double: step.type === 'dblclick' });
      }
      case 'input':
        return doInput(rc, step);
      case 'select':
        return doSelect(rc, step);
      case 'check':
        return doCheck(rc, step);
      case 'keypress':
        return doKeypress(rc, step);
      case 'extract':
        return doExtract(rc, step);
      case 'wait': {
        const timeout = Number(step.timeoutMs) > 0 ? Number(step.timeoutMs) : step.optional ? 2000 : 10000;
        await waitFor(rc, step.condition, timeout);
        return undefined;
      }
      case 'sleep':
        await rc.sleep(Math.min(Math.max(Number(step.ms ?? 1000) || 0, 0), 10 * 60_000)); // ms 가 없으면 1초 (이전 버전과 같게)
        return undefined;
      case 'assert': {
        const timeout = Number(step.timeoutMs) > 0 ? Number(step.timeoutMs) : 2000;
        try {
          await waitFor(rc, step.condition, timeout);
          return undefined;
        } catch (e) {
          if (!e.timeout) throw e;
          const msg = `${step.message ? `${step.message} — ` : ''}확인 실패: ${describeCondition(rc, step.condition)}`;
          if (step.onFail === 'warn') {
            this.log('warn', msg);
            return '확인 실패 (경고만)';
          }
          throw Object.assign(new Error(msg), { noRetry: true });
        }
      }
      case 'branch': {
        let ok = await checkCondition(rc, step.condition);
        if (!ok && usesDialog(step.condition)) {
          // 알림 문구로 분기할 때는 늦게 뜨는 알림을 잠깐 기다린다
          const until = Date.now() + 1500;
          while (!ok && Date.now() < until) {
            await rc.sleep(150);
            ok = await checkCondition(rc, step.condition);
          }
        }
        const block = ok ? step.then : step.else;
        this.log('info', `분기: ${describeCondition(rc, step.condition)} → ${ok ? '참' : '거짓'}${block ? `, [${block}] 블록 실행` : ', 그대로 진행'}`);
        if (block) await this.runBlock(block, rc, depth + 1);
        return ok ? '조건 참' : '조건 거짓';
      }
      case 'dialog': {
        const promptText = step.promptText !== undefined && step.promptText !== null ? rc.scope.resolve(step.promptText) : undefined;
        rc.sess.queueDialog({ action: step.action === 'dismiss' ? 'dismiss' : 'accept', promptText, stepId: step.id });
        return undefined;
      }
      case 'pdf':
        return savePdf(rc, step);
      case 'screenshot':
        return saveScreenshot(rc, step);
      case 'download':
        return doDownload(rc, step);
      case 'upload':
        return doUpload(rc, step);
      case 'pause':
        await rc.waitUser(step.message || '브라우저에서 확인한 뒤 [계속]을 눌러 주세요.');
        return undefined;
      case 'closeTab':
        return doCloseTab(rc);
      default:
        throw new Error(`알 수 없는 스텝 종류: ${step.type}`);
    }
  }
}
