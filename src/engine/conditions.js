// 조건 판정 (wait·assert·branch·repeat): exists · textVisible · urlContains · varEquals · dialogContains · not · all · any
// · varContains · varCompare · varEmpty · matches · elementText · elementCount
// 조건 안에서 정의되지 않은 변수는 거짓으로 본다 (varEmpty 만 "비어 있음"으로 본다).

import { locate, findList } from './locate.js';
import { UndefinedVariableError } from './vars.js';
import { conditionText, COMPARE_OPS } from '../../public/shared/steps.js';

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

// ---------- 값 비교 ----------
const numberOf = (s) => {
  const t = String(s ?? '').trim().replace(/,/g, '');
  return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : null;
};
/** YYYY-MM-DD · YYYY.MM.DD · YYYY/MM/DD · YYYYMMDD → 비교용 숫자 YYYYMMDD (아니면 null) */
const dateOf = (s) => {
  const t = String(s ?? '').trim();
  const m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})\.?$/.exec(t) || /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? y * 10000 + mo * 100 + d : null;
};

/** a op b — 양쪽이 숫자(쉼표 허용)면 숫자, 날짜면 날짜, 아니면 글자(앞뒤 공백 무시)로 비교한다 */
export function compareValues(a, op, b) {
  if (!COMPARE_OPS.includes(op)) throw new Error(`알 수 없는 비교 기호 "${op}" (= != > < >= <= 중 하나)`);
  let x = numberOf(a);
  let y = numberOf(b);
  if (x === null || y === null) {
    x = dateOf(a);
    y = dateOf(b);
  }
  if (x === null || y === null) {
    x = String(a ?? '').trim();
    y = String(b ?? '').trim();
  }
  switch (op) {
    case '=':
      return x === y;
    case '!=':
      return x !== y;
    case '>':
      return x > y;
    case '<':
      return x < y;
    case '>=':
      return x >= y;
    default:
      return x <= y;
  }
}

function regexOf(pattern, flags) {
  const f = String(flags ?? '');
  if (!/^[dgimsuyv]*$/.test(f)) throw new Error(`정규식 옵션 "${f}" 이(가) 올바르지 않습니다 (i·m·s·u 등).`);
  try {
    return new RegExp(String(pattern ?? ''), f.replace(/[gy]/g, ''));
  } catch (e) {
    throw new Error(`정규식이 올바르지 않습니다: /${pattern}/ (${e.message})`);
  }
}

/** 조건의 var 칸 값 (변수·값 읽기 이름·item.text·item.cell:2·loop.index·row). 정의 안 됐으면 undefined. */
const varValue = (scope, name) => {
  const n = cleanVarName(name);
  return n ? scope.get(n) : undefined;
};

/** 요소의 글자 (입력 요소는 값) */
async function elementTextOf(rc, target) {
  const loc = await locate(rc.sess, target, rc.scope, { timeout: 0, purpose: 'exists' });
  try {
    return String(await loc.handle.evaluate((el) => (window.__webRpa ? window.__webRpa.valueOf(el, null) : String(el.innerText ?? el.value ?? ''))));
  } finally {
    await loc.handle.dispose().catch(() => {});
  }
}

function textMatches(text, op, value, flags) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const v = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (op === 'equals') return t === v;
  if (op === 'matches') return !!v && regexOf(value, flags).test(t);
  if (op === 'contains' || op === undefined) return !!v && t.includes(v);
  throw new Error(`알 수 없는 글자 비교 "${op}" (equals·contains·matches 중 하나)`);
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
    case 'varContains': {
      const v = varValue(scope, c.var);
      const want = scope.resolve(String(c.value ?? ''));
      return v !== undefined && !!want && String(v).includes(want);
    }
    case 'varCompare': {
      const v = varValue(scope, c.var);
      if (v === undefined) return false;
      return compareValues(v, c.op ?? '=', scope.resolve(String(c.value ?? '')));
    }
    case 'varEmpty': {
      const v = varValue(scope, c.var);
      return v === undefined || v === null || String(v).trim() === ''; // 값 읽기를 건너뛰어 값이 없는 것도 비어 있음
    }
    case 'matches': {
      const v = varValue(scope, c.var);
      const pattern = scope.resolve(String(c.pattern ?? ''));
      if (v === undefined || !pattern) return false;
      return regexOf(pattern, c.flags).test(String(v));
    }
    case 'elementText': {
      const text = await elementTextOf(rc, c.target);
      return textMatches(text, c.op ?? 'contains', scope.resolve(String(c.value ?? '')), c.flags);
    }
    case 'elementCount': {
      const list = await findList(sess, c.target, scope, { outer: scope.currentItem?.() });
      const want = Number(scope.resolve(String(c.value ?? 1)).replace(/,/g, ''));
      if (!Number.isFinite(want)) throw new Error(`요소 개수 비교 값이 숫자가 아닙니다: ${c.value}`);
      return compareValues(String(list.count), c.op ?? '>=', String(want));
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
    for (const k of ['text', 'value', 'pattern']) {
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
