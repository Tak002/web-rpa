// 값 치환: {{이름}}, {{이름|변환|변환}}, 예약 이름(row, lastDialogMessage), 날짜 토큰({{sys:…}}).

export const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
export const RESERVED_NAMES = new Set(['row', 'lastDialogMessage']);

/** "이름|trim|default:x" → { name, transforms } */
export function parseToken(inner) {
  const parts = String(inner).split('|');
  return { name: parts[0].trim(), transforms: parts.slice(1).map((t) => t.trim()).filter(Boolean) };
}

export const isReservedName = (name) => RESERVED_NAMES.has(name) || /^sys:/.test(name);

export class UndefinedVariableError extends Error {
  constructor(name) {
    super(`정의되지 않은 변수 {{${name}}} 를 썼습니다. 변수·엑셀 열 이름을 확인해 주세요.`);
    this.name = 'UndefinedVariableError';
    this.variable = name;
  }
}

// ---------- 날짜 ----------
const pad2 = (n) => String(n).padStart(2, '0');

/** 월 단위 이동 (말일 보정: 1/31 + 1개월 = 2월 말일) */
export function addMonths(d, n) {
  const y = d.getFullYear();
  const m = d.getMonth() + n;
  const last = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(d.getDate(), last), d.getHours(), d.getMinutes(), d.getSeconds());
}
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds());

/** 형식 문자 YYYY YY MM M DD D HH mm ss, 나머지 글자는 그대로 */
export function formatDate(d, fmt) {
  const map = {
    YYYY: String(d.getFullYear()),
    YY: String(d.getFullYear()).slice(-2),
    MM: pad2(d.getMonth() + 1),
    M: String(d.getMonth() + 1),
    DD: pad2(d.getDate()),
    D: String(d.getDate()),
    HH: pad2(d.getHours()),
    mm: pad2(d.getMinutes()),
    ss: pad2(d.getSeconds()),
  };
  return String(fmt).replace(/YYYY|YY|MM|M|DD|D|HH|mm|ss/g, (t) => map[t]);
}

/** {{sys:…}} 토큰 값. 모르는 토큰이면 undefined. */
export function sysValue(name, now = new Date()) {
  const rest = name.slice(4); // 'sys:' 뒤
  const m = /^(year|month|day|quarter)(?::([+-]?\d+))?$/.exec(rest);
  if (m) {
    const n = Number(m[2] ?? 0);
    if (m[1] === 'year') return String(addMonths(now, 12 * n).getFullYear());
    // 월·일은 앞자리 0 없이 (두 자리가 필요하면 {{sys:date:MM}}·{{sys:date:DD}})
    if (m[1] === 'month') return String(addMonths(now, n).getMonth() + 1);
    if (m[1] === 'day') return String(addDays(now, n).getDate());
    const q = addMonths(now, 3 * n);
    return `${Math.floor(q.getMonth() / 3) + 1}분기`;
  }
  const dm = /^date:(.*)$/s.exec(rest);
  if (dm) {
    let fmt = dm[1];
    let n = 0;
    const off = /:([+-]?\d+)$/.exec(fmt);
    if (off && fmt.length > off[0].length) {
      n = Number(off[1]);
      fmt = fmt.slice(0, -off[0].length);
    }
    if (!fmt) fmt = 'YYYY-MM-DD';
    // 일(D)이 있으면 일 단위, 월(M)만 있으면 월 단위, 아니면 년 단위로 옮긴다
    const d = /D/.test(fmt) ? addDays(now, n) : /M/.test(fmt) ? addMonths(now, n) : addMonths(now, 12 * n);
    return formatDate(d, fmt);
  }
  if (rest === 'date') return formatDate(now, 'YYYY-MM-DD');
  if (rest === 'time') return formatDate(now, 'HHmmss');
  return undefined;
}

// ---------- 변환 ----------
function applyTransforms(value, transforms, name) {
  let v = value;
  for (const t of transforms) {
    if (t === 'trim') v = String(v ?? '').trim();
    else if (t === 'digits') v = String(v ?? '').replace(/\D/g, '');
    else if (t === 'upper') v = String(v ?? '').toUpperCase();
    else if (t === 'lower') v = String(v ?? '').toLowerCase();
    else if (t.startsWith('default:')) {
      if (v === undefined || v === null || String(v) === '') v = t.slice(8);
    } else throw new Error(`{{${name}|${t}}}: 알 수 없는 변환 "${t}" (trim·digits·upper·lower·default:값)`);
  }
  if (v === undefined) throw new UndefinedVariableError(name);
  return String(v ?? '');
}

/**
 * 한 행의 값 공간: 예약 이름 → 값 읽기 결과 → 레시피 변수 → 엑셀 열.
 */
export class Scope {
  /**
   * @param {{recipe: object, row?: object, rowNumber?: number, params?: object, extracted?: object, dialog?: () => string, lenient?: boolean, onMissing?: (name: string) => void}} o
   */
  constructor({ recipe, row = {}, rowNumber = 1, params = {}, extracted = {}, dialog, lenient = false, onMissing }) {
    this.recipe = recipe;
    this.row = row;
    this.rowNumber = rowNumber;
    this.params = params;
    this.extracted = extracted; // 값 읽기로 만든 변수 (행마다 새로)
    this.dialog = dialog ?? (() => '');
    this.lenient = lenient; // AI 관찰용: 모르는 변수는 빈 값
    this.onMissing = onMissing;
    this.vars = new Map();
    for (const v of recipe.variables ?? []) {
      if (!v?.id) continue;
      this.vars.set(v.id, v);
      if (v.name && !this.vars.has(v.name)) this.vars.set(v.name, v);
    }
    this.secretNames = new Set((recipe.variables ?? []).filter((v) => v.source?.secret).flatMap((v) => [v.id, v.name].filter(Boolean)));
    this.depth = 0;
  }

  /** 이름의 값. 없으면 undefined. */
  get(name) {
    if (name === 'row') return String(this.rowNumber);
    if (name === 'lastDialogMessage') return this.dialog() ?? '';
    if (name.startsWith('sys:')) return sysValue(name);
    if (Object.hasOwn(this.extracted, name)) return this.extracted[name];
    const v = this.vars.get(name);
    if (v) {
      const s = v.source ?? {};
      if (s.kind === 'excel') {
        const col = s.column || v.name || v.id;
        return Object.hasOwn(this.row, col) ? this.row[col] : undefined;
      }
      if (s.kind === 'static') {
        if (this.depth > 10) throw new Error(`변수 {{${name}}} 가 서로를 끝없이 참조합니다.`);
        this.depth += 1;
        try {
          return this.resolve(String(s.value ?? ''));
        } finally {
          this.depth -= 1;
        }
      }
      if (s.kind === 'prompt') {
        const p = this.params[v.id] ?? this.params[v.name];
        return p !== undefined && p !== null && p !== '' ? String(p) : s.default !== undefined ? String(s.default) : undefined;
      }
      return undefined;
    }
    if (Object.hasOwn(this.row, name)) return this.row[name]; // 변수 정의 없이 엑셀 열 이름을 바로 쓴 경우
    return undefined;
  }

  has(name) {
    try {
      return this.get(name) !== undefined;
    } catch {
      return false;
    }
  }

  /** 문자열 안의 {{…}} 를 모두 치환한다. 정의 안 된 변수는 오류. */
  resolve(template) {
    if (template === undefined || template === null) return template;
    const s = String(template);
    if (!s.includes('{{')) return s;
    return s.replace(TOKEN_RE, (_, inner) => {
      const { name, transforms } = parseToken(inner);
      let v = this.get(name);
      if (v === undefined && !transforms.some((t) => t.startsWith('default:'))) {
        if (this.lenient) {
          this.onMissing?.(name);
          v = '';
        } else throw new UndefinedVariableError(name);
      }
      return applyTransforms(v, transforms, name);
    });
  }

  /** 템플릿이 비밀 변수를 쓰는지 (로그에 값을 남기지 않기 위해) */
  isSecret(template) {
    const s = String(template ?? '');
    for (const m of s.matchAll(TOKEN_RE)) if (this.secretNames.has(parseToken(m[1]).name)) return true;
    return false;
  }
}
