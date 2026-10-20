// 조건 판정 (wait·assert·branch): exists · textVisible · urlContains · varEquals · dialogContains · not · all · any
// 조건 안에서 정의되지 않은 변수는 거짓으로 본다.

import { locate } from './locate.js';
import { UndefinedVariableError } from './vars.js';
import { conditionText } from '../../public/shared/steps.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanVarName = (v) => String(v ?? '').replace(/^\{\{|\}\}$/g, '').trim();

export class ConditionTimeout extends Error {
  constructor(message) {
    super(message);
    this.timeout = true;
  }
}

/** 지금 한 번 판정한다. */
export async function checkCondition(rc, cond) {
  try {
    return await check(rc, cond);
  } catch (e) {
    if (e instanceof UndefinedVariableError || e.notFound) return false;
    throw e;
  }
}

async function check(rc, c) {
  if (!c || typeof c !== 'object') return false;
  const { sess, scope } = rc;
  switch (c.kind) {
    case 'exists': {
      const loc = await locate(sess, c.target, scope, { timeout: 0, purpose: 'exists' });
      await loc.handle.dispose().catch(() => {});
      return c.visible ? !loc.hidden : true;
    }
    case 'textVisible': {
      const text = scope.resolve(c.text ?? '');
      if (!text.trim()) return false;
      const page = await sess.livePage();
      for (const f of page.frames()) {
        if (await sess.callLib(f, 'hasText', text, !!c.exact).catch(() => false)) return true;
      }
      return false;
    }
    case 'urlContains': {
      const v = scope.resolve(c.value ?? '');
      const page = await sess.livePage();
      return !!v && (page.url().includes(v) || decodeURIComponentSafe(page.url()).includes(v));
    }
    case 'varEquals': {
      const name = cleanVarName(c.var);
      const v = name ? scope.get(name) : undefined;
      if (v === undefined) return false;
      return String(v) === scope.resolve(c.value ?? '');
    }
    case 'dialogContains': {
      const v = scope.resolve(c.value ?? '');
      return !!v && String(sess.lastDialogMessage ?? '').includes(v);
    }
    case 'not':
      return !(await checkCondition(rc, c.condition));
    case 'all':
      for (const sub of c.conditions ?? []) if (!(await checkCondition(rc, sub))) return false;
      return (c.conditions ?? []).length > 0;
    case 'any':
      for (const sub of c.conditions ?? []) if (await checkCondition(rc, sub)) return true;
      return false;
    default:
      throw new Error(`알 수 없는 조건 종류: ${c.kind}`);
  }
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 사람이 읽는 조건 문장 (변수는 이번 행 값으로 바꿔 보여 준다) */
export function describeCondition(rc, cond) {
  const fill = (c) => {
    if (!c || typeof c !== 'object') return c;
    const out = { ...c };
    for (const k of ['text', 'value']) {
      if (typeof out[k] !== 'string') continue;
      try {
        out[k] = rc.scope.resolve(out[k]);
      } catch {
        /* 모르는 변수는 그대로 */
      }
    }
    if (out.condition) out.condition = fill(out.condition);
    if (Array.isArray(out.conditions)) out.conditions = out.conditions.map(fill);
    return out;
  };
  return conditionText(fill(cond));
}

/** 조건이 참이 될 때까지 기다린다. 시간이 지나면 ConditionTimeout. */
export async function waitFor(rc, cond, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    rc.sess.checkAbort();
    if (await checkCondition(rc, cond)) return true;
    if (Date.now() >= deadline) throw new ConditionTimeout(`${Math.round(timeoutMs / 100) / 10}초 안에 조건이 맞지 않았습니다: ${describeCondition(rc, cond)}`);
    await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
  }
}

/** 알림창 문구 조건이 들어 있는지 (늦게 뜨는 알림을 잠깐 기다릴지 판단) */
export function usesDialog(cond) {
  if (!cond || typeof cond !== 'object') return false;
  if (cond.kind === 'dialogContains') return true;
  if (cond.condition && usesDialog(cond.condition)) return true;
  return (cond.conditions ?? []).some(usesDialog);
}
