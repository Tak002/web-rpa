// 블록 실행기: 스텝을 차례로 실행한다 (꺼짐·재시도·없으면 건너뜀·실패해도 계속·분기 호출·블록 반복·목록 항목마다·무한 반복 상한).
// 실행기(Runner)와 AI 관찰기(Observer)가 같이 쓴다. 화면에 알리는 일은 hooks 로 바깥에 맡긴다.

import { stepText, targetText, loopEndText } from '../../public/shared/steps.js';
import { pagingOf } from '../../public/shared/recipe-edit.js';
import { checkCondition, waitFor, usesDialog, describeCondition } from './conditions.js';
import { doNavigate, doInput, doSelect, doCheck, doKeypress, doExtract, doDownload, doUpload, doCloseTab, clickElement, locateFor } from './actions.js';
import { findList, itemFrame, NotFoundError } from './locate.js';
import { savePdf, saveScreenshot } from './output.js';

const MAX_DEPTH = 12; // 블록 호출 중첩 상한
const MAX_STEPS_PER_ROW = 3000; // 한 행에서 (반복 밖에서) 실행할 수 있는 스텝 수 (무한 반복 방지)
const MAX_LOOP_STEPS_PER_ROW = 100_000; // 한 행에서 반복 안에서 실행할 수 있는 스텝 수 (반복 상한과 별도의 안전장치)
const HUMAN_GAP_MAX_MS = 3000;
const ONCE = new Set(['download', 'pdf', 'upload', 'dialog', 'pause', 'branch', 'closeTab', 'repeat', 'forEach']); // 재시도하지 않는 스텝
const LOOP_LIMIT = { def: 100, min: 1, max: 1000 }; // maxIterations·maxItems 기본값과 범위
const ITEMS_WAIT_MS = 2000; // 목록 항목이 나타나기를 기다리는 시간 (timeoutMs 가 있으면 그 값)
const clipText = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** 반복 상한 (없으면 기본값, 범위 밖이면 범위 안으로) */
export function loopLimit(v) {
  const n = Math.floor(Number(v));
  if (v === undefined || v === null || v === '' || !Number.isFinite(n)) return LOOP_LIMIT.def;
  return Math.min(Math.max(n, LOOP_LIMIT.min), LOOP_LIMIT.max);
}
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
    this.loopBudget = MAX_LOOP_STEPS_PER_ROW;
    await this.runBlock(this.recipe.entryBlock || 'main', rc, 0);
  }

  async runBlock(name, rc, depth) {
    if (depth > MAX_DEPTH) throw new Error(`블록 호출이 너무 깊습니다 (${MAX_DEPTH}단계). 분기가 같은 블록을 계속 부르는지 확인해 주세요.`);
    const steps = this.recipe.blocks?.[name];
    if (!Array.isArray(steps)) throw new Error(`블록 "${name}" 이(가) 없습니다.`);
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      await this.hooks.checkpoint?.();
      const info = { stepId: step.id, block: name, index, desc: stepText(step, this.recipe), rowNumber: rc.scope.rowNumber };
      if (step.disabled) {
        this.emit(info, 'skip', { note: '꺼진 스텝' });
        continue;
      }
      if (rc.scope.loops?.length) {
        this.loopBudget -= 1;
        if (this.loopBudget < 0) throw new Error(`한 행에서 반복 안의 스텝을 ${MAX_LOOP_STEPS_PER_ROW}개 넘게 실행했습니다 (반복 상한을 확인해 주세요).`);
      } else {
        this.budget -= 1;
        if (this.budget < 0) throw new Error(`한 행에서 실행한 스텝이 ${MAX_STEPS_PER_ROW}개를 넘었습니다 (무한 반복 의심).`);
      }
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
        const ok = await this.decide(rc, step.condition);
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
      case 'repeat':
        return this.runRepeat(step, rc, depth);
      case 'forEach':
        return this.runForEach(step, rc, depth);
      default:
        throw new Error(`알 수 없는 스텝 종류: ${step.type}`);
    }
  }

  /** 조건을 지금 판정한다. 알림 문구 조건이면 늦게 뜨는 알림을 잠깐 기다린다 (분기·반복 공통). */
  async decide(rc, cond) {
    let ok = await checkCondition(rc, cond);
    if (!ok && usesDialog(cond)) {
      const until = Date.now() + 1500;
      while (!ok && Date.now() < until) {
        await rc.sleep(150);
        ok = await checkCondition(rc, cond);
      }
    }
    return ok;
  }

  /** 반복 조건·목록을 보기 전에 화면 이동이 끝나기를 기다린다 (몸통 끝의 "다음" 클릭으로 새 문서가 뜨는 중일 수 있다) */
  async settle(rc) {
    const page = await rc.sess.livePage();
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  }

  /** 몸통 블록을 반복 문맥 하나로 실행한다 */
  async runBody(rc, name, depth, entry) {
    rc.scope.loops.push(entry);
    try {
      await this.runBlock(name, rc, depth + 1);
    } finally {
      rc.scope.loops.pop();
      rc.scope.lastLoopCount = entry.count;
    }
  }

  /** repeat: times(N번) · while(반복 전 검사, 참인 동안) · until(반복 뒤 검사, 참이면 끝) 중 하나 */
  async runRepeat(step, rc, depth) {
    const ways = ['times', 'while', 'until'].filter((k) => step[k] !== undefined && step[k] !== null && step[k] !== '');
    if (ways.length !== 1) throw Object.assign(new Error('반복 방법(times·while·until)은 정확히 하나만 정해야 합니다.'), { noRetry: true });
    if (!step.body) throw Object.assign(new Error('반복할 블록(body)이 없습니다.'), { noRetry: true });
    const way = ways[0];
    if (way === 'times') {
      const n = Math.floor(Number(step.times));
      if (!(n >= 1 && n <= LOOP_LIMIT.max)) throw Object.assign(new Error(`반복 횟수는 1~${LOOP_LIMIT.max} 사이여야 합니다: ${step.times}`), { noRetry: true });
      for (let i = 1; i <= n; i += 1) {
        await this.hooks.checkpoint?.();
        this.log('info', `반복 ${i}/${n} — [${step.body}] 블록`);
        await this.runBody(rc, step.body, depth, { kind: 'repeat', index: i, count: i });
      }
      return `${n}번 반복`;
    }
    const max = loopLimit(step.maxIterations);
    const cond = step[way];
    let i = 0;
    for (;;) {
      await this.hooks.checkpoint?.();
      if (way === 'while') {
        await this.settle(rc);
        if (!(await this.decide(rc, cond))) {
          this.log('info', `반복 끝 (${i}번 실행): ${loopEndText(cond, false)} 멈춥니다.`);
          break;
        }
      }
      if (i >= max) {
        this.log('warn', `최대 반복 횟수 ${max} 에 도달해 멈춥니다 — ${describeCondition(rc, cond)}`);
        return `${i}번 반복 (최대 횟수에서 멈춤)`;
      }
      i += 1;
      this.log('info', `반복 ${i} — [${step.body}] 블록`);
      await this.runBody(rc, step.body, depth, { kind: 'repeat', index: i, count: i });
      if (way === 'until') {
        await this.settle(rc);
        if (await this.decide(rc, cond)) {
          // 쪽 넘기기면 "다음" 이 없는 마지막 쪽까지 처리하고 끝난 것이다
          const paging = pagingOf(this.recipe, step);
          this.log('info', paging ? `반복 끝 (${i}번 실행): ${loopEndText(cond, true).replace(/없어서$/, '없어')} 마지막 쪽까지 처리했습니다.` : `반복 끝 (${i}번 실행): ${loopEndText(cond, true)} 멈춥니다.`);
          break;
        }
      }
    }
    return `${i}번 반복`;
  }

  /** forEach: 화면 목록의 항목마다 몸통 블록을 실행한다. 시작할 때 세고, 항목은 매번 같은 후보의 i 번째로 다시 찾는다. */
  async runForEach(step, rc, depth) {
    if (!step.body) throw Object.assign(new Error('항목마다 실행할 블록(body)이 없습니다.'), { noRetry: true });
    const outer = rc.scope.currentItem();
    const max = loopLimit(step.maxItems);
    const wait = Number(step.timeoutMs) > 0 ? Number(step.timeoutMs) : ITEMS_WAIT_MS;
    await this.settle(rc);
    let list = { count: 0 };
    for (const until = Date.now() + wait; ; ) {
      rc.sess.checkAbort();
      list = await findList(rc.sess, step.items, rc.scope, { outer });
      if (list.count > 0 || Date.now() >= until) break;
      await rc.sleep(200);
    }
    if (!list.count) {
      this.log('info', `목록 ${targetText(step.items)} 에 항목이 없어 [${step.body}] 블록을 건너뜁니다.`);
      return '항목 0개';
    }
    let n = list.count;
    if (n === 1 && !outer) this.log('warn', `목록 ${targetText(step.items)} 의 항목이 1개뿐입니다 — 목록 요소가 표의 행 전체가 아니라 요소 하나를 가리키면 한 번만 실행됩니다.`);
    if (n > max) {
      this.log('warn', `목록 항목 ${n}개 중 앞의 ${max}개만 처리합니다 (최대 항목 수 ${max}).`);
      n = max;
    }
    const base = { page: list.page, framePath: list.framePath, chain: list.chain, cand: list.cand };
    const startUrl = list.page.url();
    for (let i = 0; i < n; i += 1) {
      await this.hooks.checkpoint?.();
      const item = { page: list.page, framePath: list.framePath, chain: [...list.chain, { c: list.cand, i }] };
      const info = await this.itemInfo(rc, item, i, list.count, step);
      this.log('info', `항목 ${i + 1}/${n} — ${clipText(info.text, 50) || '(글자 없음)'}`);
      await this.runBody(rc, step.body, depth, { kind: 'forEach', index: i + 1, count: i + 1, total: n, info, ...item });
      if (step.restore === 'back') await this.restoreList(rc, base, startUrl);
    }
    return `항목 ${n}개 처리`;
  }

  /** i 번째 항목의 글자·칸 (다시 그려지는 중이면 3초까지 기다린다) */
  async itemInfo(rc, item, i, total, step) {
    for (const until = Date.now() + 3000; ; ) {
      rc.sess.checkAbort();
      if (item.page.isClosed()) throw new Error('목록이 있던 창이 닫혀 다음 항목으로 갈 수 없습니다.');
      const frame = itemFrame(item);
      const info = frame ? await rc.sess.callLib(frame, 'itemInfo', item.chain).catch(() => null) : null;
      if (info) return info;
      if (Date.now() >= until) {
        const hint = step.restore === 'back' ? '' : ' 몸통에서 다른 화면으로 옮겨 갔다면 "항목마다 원래 화면으로 돌아오기"(restore: back)를 켜 주세요.';
        throw new NotFoundError(`목록 ${targetText(step.items)} 의 ${i + 1}번째 항목을 찾지 못했습니다 (처음 ${total}개).${hint}`);
      }
      await rc.sleep(200);
    }
  }

  /** 목록 후보에 맞는 보이는 요소 수 (바깥 항목이 있으면 그 안에서) */
  async listVisible(rc, list) {
    const frame = itemFrame(list);
    if (!frame) return 0;
    if (list.chain.length) return (await rc.sess.callLib(frame, 'countIn', list.chain, [list.cand]).catch(() => null))?.counts?.[0]?.visible ?? 0;
    return (await rc.sess.callLib(frame, 'count', [list.cand]).catch(() => null))?.[0]?.visible ?? 0;
  }

  /** restore: back — 주소가 바뀌었으면 뒤로 가서 목록이 다시 보일 때까지 기다린다 */
  async restoreList(rc, list, startUrl) {
    const page = list.page;
    if (page.isClosed()) throw new Error('목록이 있던 창이 닫혀 목록 화면으로 돌아갈 수 없습니다.');
    if (page.url() === startUrl) return;
    this.log('info', '항목을 마치고 목록 화면으로 돌아갑니다 (뒤로 가기).');
    for (let k = 0; k < 5 && page.url() !== startUrl; k += 1) {
      const r = await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
      if (!r && page.url() !== startUrl) break; // 더 뒤로 갈 곳이 없다
    }
    if (page.url() !== startUrl) {
      this.log('warn', `뒤로 가기로 목록 주소에 돌아오지 못해 다시 엽니다: ${clipText(startUrl, 80)}`);
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    for (const until = Date.now() + 10000; ; ) {
      rc.sess.checkAbort();
      if ((await this.listVisible(rc, list)) > 0) return;
      if (Date.now() >= until) throw new Error('목록 화면으로 돌아왔지만 목록이 다시 보이지 않습니다.');
      await rc.sleep(200);
    }
  }
}
