// 레시피 도우미: 참조하는 변수·엑셀 열 찾기, 실행 전 검사, 엑셀 첫 행으로 입력값 자동 연결.

import { STEP_LABELS, COMPARE_OPS } from '../public/shared/steps.js';
import { childBlocks, findStep, sameElementSteps } from '../public/shared/recipe-edit.js';
import { TOKEN_RE, parseToken, isReservedName } from './engine/vars.js';

/** 대상 요소(target)가 꼭 필요한 스텝 */
export const TARGET_STEPS = new Set(['click', 'dblclick', 'input', 'select', 'check', 'extract', 'download', 'upload']);
const CONDITION_KINDS = new Set(['exists', 'textVisible', 'urlContains', 'varEquals', 'dialogContains', 'not', 'all', 'any', 'varContains', 'varCompare', 'varEmpty', 'matches', 'elementText', 'elementCount']);
const VAR_KINDS = new Set(['varEquals', 'varContains', 'varCompare', 'varEmpty', 'matches']); // var 칸에 변수 이름을 쓰는 조건
const TEXT_OPS = new Set(['equals', 'contains', 'matches']);
const LOOP_MAX = 1000;
const blank = (v) => v === undefined || v === null || String(v).trim() === '';

const namesIn = (s, out) => {
  for (const m of String(s).matchAll(TOKEN_RE)) out.add(parseToken(m[1]).name);
};
const cleanVarName = (v) => String(v ?? '').replace(/^\{\{|\}\}$/g, '').trim();

/** 스텝(또는 그 일부) 안의 모든 {{이름}} 과 변수 조건(varEquals 등)의 변수 이름. 녹화 정보(meta)는 보지 않는다. */
function collect(value, out) {
  if (typeof value === 'string') return namesIn(value, out);
  if (Array.isArray(value)) return value.forEach((v) => collect(v, out));
  if (value && typeof value === 'object') {
    if (VAR_KINDS.has(value.kind) && value.var) out.add(cleanVarName(value.var));
    for (const [k, v] of Object.entries(value)) if (k !== 'meta') collect(v, out);
  }
}

const allSteps = (recipe) => Object.values(recipe?.blocks ?? {}).flatMap((s) => (Array.isArray(s) ? s : []));

/** 블록과 static 변수 값에서 {{이름}} 을 모은다 (변환 부분 제외). */
export function referencedNames(recipe) {
  const out = new Set();
  for (const st of allSteps(recipe)) if (st && !st.disabled) collect(st, out);
  for (const v of recipe?.variables ?? []) if (v?.source?.kind === 'static') namesIn(v.source.value ?? '', out);
  return [...out];
}

/** 블록에서 실제로 쓰는 이름 + 그 이름이 가리키는 static 변수 값 안의 이름까지 (정의만 남은 변수는 빠진다). */
function usedNames(recipe) {
  const out = new Set();
  for (const st of allSteps(recipe)) if (st && !st.disabled) collect(st, out);
  const byName = new Map();
  for (const v of recipe?.variables ?? []) {
    if (!v?.id) continue;
    byName.set(v.id, v);
    if (v.name && !byName.has(v.name)) byName.set(v.name, v);
  }
  const queue = [...out];
  while (queue.length) {
    const v = byName.get(queue.shift());
    if (v?.source?.kind !== 'static') continue;
    const inner = new Set();
    namesIn(v.source.value ?? '', inner);
    for (const n of inner) {
      if (out.has(n)) continue;
      out.add(n);
      queue.push(n);
    }
  }
  return out;
}

const isUsed = (v, used) => used.has(v.id) || (v.name && used.has(v.name));

/** 실제로 참조되는 excel 변수의 열 이름 (겹치지 않게, 변수 순서대로). */
export function excelColumnsOf(recipe) {
  const used = usedNames(recipe);
  const cols = [];
  for (const v of recipe?.variables ?? []) {
    if (v?.source?.kind !== 'excel' || !isUsed(v, used)) continue;
    const col = v.source.column || v.name || v.id;
    if (col && !cols.includes(col)) cols.push(col);
  }
  return cols;
}

/** 실행 전에 물어야 하는 prompt 변수 */
export function promptVariablesOf(recipe) {
  const used = usedNames(recipe);
  return (recipe?.variables ?? []).filter((v) => v?.source?.kind === 'prompt' && isUsed(v, used));
}

const validTarget = (t) => t && typeof t === 'object' && Array.isArray(t.candidates) && t.candidates.length > 0;

function regexProblem(pattern, flags, where, out) {
  if (flags !== undefined && !/^[dgimsuyv]*$/.test(String(flags))) return out.push(`${where}: 정규식 옵션 "${flags}" 이(가) 올바르지 않습니다.`);
  if (String(pattern).includes('{{')) return undefined; // 변수를 넣은 정규식은 실행 때 본다
  try {
    new RegExp(String(pattern), String(flags ?? '').replace(/[gy]/g, ''));
  } catch (e) {
    out.push(`${where}: 정규식이 올바르지 않습니다: /${pattern}/ (${e.message})`);
  }
  return undefined;
}

/** 반복 상한 칸 (없으면 기본값 100) */
function limitProblem(v, label, where, out) {
  if (v === undefined || v === null || v === '') return;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > LOOP_MAX) out.push(`${where}: ${label}은(는) 1~${LOOP_MAX} 사이의 정수여야 합니다 (지금: ${v}).`);
}

function bodyProblem(s, block, blocks, where, out) {
  if (!s.body) out.push(`${where}: 반복할 블록(body)이 없습니다.`);
  else if (!Array.isArray(blocks[s.body])) out.push(`${where}: 반복할 블록 "${s.body}" 이(가) 없습니다.`);
  else if (s.body === block) out.push(`${where}: 반복할 블록으로 자기가 들어 있는 블록 "${block}" 을(를) 쓸 수 없습니다.`);
}

/** 값 안에 within: 'item' 대상이 있는지 (녹화 정보 meta 는 보지 않는다) */
function usesWithin(value) {
  if (Array.isArray(value)) return value.some(usesWithin);
  if (!value || typeof value !== 'object') return false;
  if (value.within === 'item') return true;
  return Object.entries(value).some(([k, v]) => k !== 'meta' && usesWithin(v));
}

/** within: 'item' 이 목록의 항목마다(forEach) 몸통(그 몸통에서 부르는 블록 포함) 밖에서 쓰이면 문제 */
function withinProblems(recipe, out) {
  const blocks = recipe.blocks;
  const seen = new Set();
  const flagged = new Set();
  const queue = [[recipe.entryBlock || 'main', false]];
  while (queue.length) {
    const [block, inItem] = queue.shift();
    if (seen.has(`${block}|${inItem}`)) continue;
    seen.add(`${block}|${inItem}`);
    const steps = blocks[block];
    if (!Array.isArray(steps)) continue;
    steps.forEach((s, i) => {
      if (!s || typeof s !== 'object' || s.disabled) return;
      if (!inItem && !flagged.has(s) && usesWithin(s)) {
        flagged.add(s);
        out.push(`${block} 블록 ${i + 1}번 스텝${s.id ? `(${s.id})` : ''}: "항목 안에서 찾기"(within: item) 대상은 목록의 항목마다(forEach) 몸통 안에서만 쓸 수 있습니다.`);
      }
      for (const [, child] of childBlocks(s)) queue.push([child, s.type === 'forEach' || inItem]);
    });
  }
}

function conditionProblems(c, where, blocks, out) {
  if (!c || typeof c !== 'object') return out.push(`${where}: 조건이 없습니다.`);
  if (!CONDITION_KINDS.has(c.kind)) return out.push(`${where}: 알 수 없는 조건 종류 "${c.kind}"`);
  switch (c.kind) {
    case 'exists':
      if (!validTarget(c.target)) out.push(`${where}: "요소가 있음" 조건에 대상 요소가 없습니다.`);
      break;
    case 'textVisible':
      if (!String(c.text ?? '').trim()) out.push(`${where}: 조건의 글자(화면에 보일 글자)가 비어 있습니다.`);
      break;
    case 'urlContains':
      if (!String(c.value ?? '').trim()) out.push(`${where}: 주소에 포함될 글자가 비어 있습니다.`);
      break;
    case 'varEquals':
      if (!cleanVarName(c.var)) out.push(`${where}: 비교할 변수 이름이 없습니다.`);
      break;
    case 'dialogContains':
      if (!String(c.value ?? '').trim()) out.push(`${where}: 알림 문구가 비어 있습니다.`);
      break;
    case 'varContains':
      if (!cleanVarName(c.var)) out.push(`${where}: 비교할 변수 이름이 없습니다.`);
      if (blank(c.value)) out.push(`${where}: 포함될 글자가 비어 있습니다.`);
      break;
    case 'varCompare':
      if (!cleanVarName(c.var)) out.push(`${where}: 비교할 변수 이름이 없습니다.`);
      if (c.op !== undefined && !COMPARE_OPS.includes(c.op)) out.push(`${where}: 비교 기호 "${c.op}" 은(는) 쓸 수 없습니다 (= != > < >= <=).`);
      if (blank(c.value)) out.push(`${where}: 비교할 값이 비어 있습니다.`);
      break;
    case 'varEmpty':
      if (!cleanVarName(c.var)) out.push(`${where}: 비어 있는지 볼 변수 이름이 없습니다.`);
      break;
    case 'matches':
      if (!cleanVarName(c.var)) out.push(`${where}: 비교할 변수 이름이 없습니다.`);
      if (blank(c.pattern)) out.push(`${where}: 정규식이 비어 있습니다.`);
      else regexProblem(c.pattern, c.flags, where, out);
      break;
    case 'elementText':
      if (!validTarget(c.target)) out.push(`${where}: "요소의 글자" 조건에 대상 요소가 없습니다.`);
      if (c.op !== undefined && !TEXT_OPS.has(c.op)) out.push(`${where}: 글자 비교 "${c.op}" 은(는) 쓸 수 없습니다 (equals·contains·matches).`);
      if (c.op !== 'equals' && blank(c.value)) out.push(`${where}: 비교할 글자가 비어 있습니다.`);
      else if (c.op === 'matches') regexProblem(c.value, c.flags, where, out);
      break;
    case 'elementCount': {
      if (!validTarget(c.target)) out.push(`${where}: "요소 개수" 조건에 대상 요소가 없습니다.`);
      if (c.op !== undefined && !COMPARE_OPS.includes(c.op)) out.push(`${where}: 비교 기호 "${c.op}" 은(는) 쓸 수 없습니다 (= != > < >= <=).`);
      const v = String(c.value ?? 1);
      if (!v.includes('{{') && !(Number(v) >= 0)) out.push(`${where}: 요소 개수 비교 값이 0 이상의 숫자가 아닙니다: ${c.value}`);
      break;
    }
    case 'not':
      conditionProblems(c.condition, where, blocks, out);
      break;
    default:
      if (!Array.isArray(c.conditions) || !c.conditions.length) out.push(`${where}: 묶음 조건(${c.kind})에 조건이 없습니다.`);
      else c.conditions.forEach((sub) => conditionProblems(sub, where, blocks, out));
  }
  return out;
}

/** 실행 전에 고칠 점 (문장 배열). 빈 배열이면 실행할 수 있다. */
export function recipeProblems(recipe) {
  const p = [];
  if (!recipe || typeof recipe !== 'object') return ['레시피 형식이 아닙니다.'];
  if (!String(recipe.name ?? '').trim()) p.push('레시피 이름이 없습니다.');
  const blocks = recipe.blocks;
  if (!blocks || typeof blocks !== 'object' || Array.isArray(blocks)) {
    p.push('스텝 블록(blocks)이 없습니다.');
    return p;
  }
  const entry = recipe.entryBlock || 'main';
  if (!Array.isArray(blocks[entry])) p.push(`시작 블록 "${entry}" 이(가) 없습니다.`);
  const ids = new Map();
  const saveAs = new Set();
  for (const st of allSteps(recipe)) if (st?.type === 'extract' && st.saveAs) saveAs.add(String(st.saveAs).trim());

  for (const [block, steps] of Object.entries(blocks)) {
    if (!Array.isArray(steps)) {
      p.push(`블록 "${block}" 이(가) 스텝 목록이 아닙니다.`);
      continue;
    }
    steps.forEach((s, i) => {
      const where = `${block} 블록 ${i + 1}번 스텝${s?.id ? `(${s.id})` : ''}`;
      if (!s || typeof s !== 'object') return p.push(`${where}: 스텝 형식이 아닙니다.`);
      if (!s.id) p.push(`${where}: 스텝 id 가 없습니다.`);
      else if (ids.has(s.id)) p.push(`스텝 id "${s.id}" 이(가) 겹칩니다 (${ids.get(s.id)} 블록과 ${block} 블록).`);
      else ids.set(s.id, block);
      if (!STEP_LABELS[s.type]) return p.push(`${where}: 알 수 없는 스텝 종류 "${s.type}"`);
      if (s.disabled) return undefined; // 꺼 둔 스텝은 내용 검사를 하지 않는다
      if (TARGET_STEPS.has(s.type) && !validTarget(s.target)) p.push(`${where}: 대상 요소가 없습니다.`);
      switch (s.type) {
        case 'navigate':
          if (!String(s.url ?? '').trim()) p.push(`${where}: 이동할 주소가 없습니다.`);
          break;
        case 'extract': {
          const name = String(s.saveAs ?? '').trim();
          if (!name) p.push(`${where}: 읽은 값을 저장할 이름(saveAs)이 없습니다.`);
          else if (/[{}|]/.test(name)) p.push(`${where}: 저장할 이름 "${name}" 에 {, }, | 는 쓸 수 없습니다.`);
          else if (isReservedName(name)) p.push(`${where}: "${name}" 은(는) 예약된 이름이라 저장 이름으로 쓸 수 없습니다.`);
          break;
        }
        case 'branch':
          conditionProblems(s.condition, where, blocks, p);
          if (!s.then) p.push(`${where}: 조건이 맞을 때 실행할 블록(then)이 없습니다.`);
          else if (!Array.isArray(blocks[s.then])) p.push(`${where}: 분기할 블록 "${s.then}" 이(가) 없습니다.`);
          if (s.else && !Array.isArray(blocks[s.else])) p.push(`${where}: 분기할 블록 "${s.else}" 이(가) 없습니다.`);
          break;
        case 'wait':
        case 'assert':
          conditionProblems(s.condition, where, blocks, p);
          break;
        case 'repeat': {
          const ways = ['times', 'while', 'until'].filter((k) => s[k] !== undefined && s[k] !== null && s[k] !== '');
          if (!ways.length) p.push(`${where}: 반복 방법(횟수 times · 조건 while · until)이 없습니다.`);
          else if (ways.length > 1) p.push(`${where}: 반복 방법은 하나만 정해야 합니다 (지금: ${ways.join(', ')}).`);
          if (ways.includes('times')) limitProblem(s.times, '반복 횟수(times)', where, p);
          if (ways.includes('while')) conditionProblems(s.while, `${where} 반복 조건`, blocks, p);
          if (ways.includes('until')) conditionProblems(s.until, `${where} 반복 끝 조건`, blocks, p);
          limitProblem(s.maxIterations, '최대 반복 횟수(maxIterations)', where, p);
          bodyProblem(s, block, blocks, where, p);
          break;
        }
        case 'forEach':
          if (!validTarget(s.items)) p.push(`${where}: 목록 요소(items)의 후보가 없습니다.`);
          limitProblem(s.maxItems, '최대 항목 수(maxItems)', where, p);
          if (s.restore !== undefined && s.restore !== null && !['none', 'back'].includes(s.restore)) p.push(`${where}: 항목 뒤 되돌리기(restore)는 none 또는 back 이어야 합니다.`);
          bodyProblem(s, block, blocks, where, p);
          break;
        case 'keypress':
          if (!String(s.key ?? '').trim()) p.push(`${where}: 누를 키가 없습니다.`);
          break;
        case 'sleep':
          if (s.ms !== undefined && s.ms !== '' && !(Number(s.ms) >= 0)) p.push(`${where}: 쉬는 시간(ms)이 올바르지 않습니다.`); // 비면 1초
          break;
        case 'dialog':
          if (s.action !== 'accept' && s.action !== 'dismiss') p.push(`${where}: 알림창 응답은 accept(확인) 또는 dismiss(취소)여야 합니다.`);
          break;
        case 'upload':
          if (!String(s.path ?? '').trim()) p.push(`${where}: 첨부할 파일 경로가 비어 있습니다. 편집에서 경로를 지정해 주세요.`);
          break;
        case 'select':
          if ((s.value === undefined || s.value === null || s.value === '') && !s.label) p.push(`${where}: 고를 값이 없습니다.`);
          break;
        default:
          break;
      }
    });
  }
  withinProblems(recipe, p);
  // 목록의 항목마다 안에서 항목 안에서 찾지 않아 항목마다 같은 요소를 쓰는 스텝 (같은 값을 되풀이해 읽는다)
  for (const x of sameElementSteps(recipe)) {
    const f = findStep(recipe, x.stepId);
    if (!f) continue;
    const fix = x.relative ? ' 편집기에서 이 스텝을 펼쳐 [항목 안에서 찾기로 바꾸기] 를 누르세요.' : ' 대상을 항목 안의 요소로 바꾸세요 (AI 에게 맡길 수 있습니다).';
    p.push(`${f.block} 블록 ${f.index + 1}번 스텝(${x.stepId}): 목록의 항목마다 안에 있지만 "항목 안에서 찾기" 가 아니라서 항목마다 같은 요소를 씁니다 (같은 값을 되풀이합니다).${fix}`);
  }

  // 정의되지 않은 변수
  const defined = new Set();
  for (const v of recipe.variables ?? []) {
    if (!v || typeof v !== 'object') continue;
    if (!v.id) {
      p.push('id 가 없는 변수가 있습니다.');
      continue;
    }
    defined.add(v.id);
    if (v.name) defined.add(v.name);
    const k = v.source?.kind;
    if (!['excel', 'static', 'prompt'].includes(k)) p.push(`변수 {{${v.id}}}: 종류(source.kind)가 올바르지 않습니다.`);
    if (k === 'excel' && !String(v.source.column ?? v.name ?? v.id).trim()) p.push(`변수 {{${v.id}}}: 엑셀 열 이름이 없습니다.`);
  }
  for (const name of usedNames(recipe)) {
    if (!name || defined.has(name) || isReservedName(name) || saveAs.has(name)) continue;
    p.push(`정의되지 않은 변수 {{${name}}} — 변수·엑셀 탭에서 추가하거나 이름을 고쳐 주세요.`);
  }
  return p;
}

/** column 을 읽는 excel 변수를 보장한다. 쓸 변수 객체를 돌려준다. */
export function ensureExcelVariable(recipe, column) {
  recipe.variables ??= [];
  const same = recipe.variables.find((v) => v?.source?.kind === 'excel' && (v.source.column || v.name || v.id) === column);
  if (same) return same;
  const taken = (id) => recipe.variables.some((v) => v?.id === id || v?.name === id);
  let id = column;
  for (let n = 2; taken(id); n += 1) id = `${column}_엑셀${n > 2 ? n - 1 : ''}`;
  const v = { id, name: id, source: { kind: 'excel', column } };
  recipe.variables.push(v);
  return v;
}

/**
 * 엑셀 첫 행 값과 똑같은 입력·선택 값을 {{열}} 로 바꾼다 (한 열에서만 일치할 때만).
 * @returns {{recipe: object, linked: {stepId: string, column: string}[]}}
 */
export function autoLinkExcel(recipe, headers, firstRow) {
  const copy = structuredClone(recipe);
  const linked = [];
  const values = (headers ?? []).map((h) => [h, String(firstRow?.[h] ?? '').trim()]).filter(([, v]) => v !== '');
  for (const s of allSteps(copy)) {
    if (!s || (s.type !== 'input' && s.type !== 'select')) continue;
    const raw = s.value === undefined || s.value === null ? '' : String(s.value);
    if (raw.includes('{{')) continue;
    const seen = [raw, s.type === 'select' ? s.label : undefined].map((x) => String(x ?? '').trim()).filter(Boolean);
    if (!seen.length) continue;
    const cols = [...new Set(values.filter(([, v]) => seen.includes(v)).map(([h]) => h))];
    if (cols.length !== 1) continue;
    const v = ensureExcelVariable(copy, cols[0]);
    s.meta = { ...(s.meta ?? {}), recordedValue: s.type === 'select' ? String(s.label || raw) : raw };
    s.value = `{{${v.id}}}`;
    if (s.type === 'select') delete s.label;
    linked.push({ stepId: s.id, column: cols[0] });
  }
  return { recipe: copy, linked };
}
