// 레시피 편집 도우미: 전역 스텝 번호(#4.2)·스텝 트리, 변수 사용처·이름 바꾸기, 스텝 묶기·풀기, 녹화 입력 정리.
// 화면(브라우저)과 Node 가 함께 쓰는 ES 모듈 — Node 전용 API 를 쓰지 않는다.
// 바꾸는 함수(renameVariable·wrapSteps·unwrapStep·applyInputModes)는 받은 레시피를 그 자리에서 고친다.

import { targetName } from './steps.js';

const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const VAR_KINDS = new Set(['varEquals', 'varContains', 'varCompare', 'varEmpty', 'matches']); // var 칸에 변수 이름을 쓰는 조건
const WRAP_TYPES = { repeat: 'body', forEach: 'body', branch: 'then' };
const WRAP_NAMES = { repeat: '반복', forEach: '항목마다', branch: '조건' };
const INPUT_MODES = ['fixed', 'excel', 'prompt', 'secret'];

const cleanVarName = (v) => String(v ?? '').replace(/^\{\{|\}\}$/g, '').trim();
const tokenName = (inner) => String(inner).split('|')[0].trim();
/** 예약 이름: 행 번호·알림 문구·날짜 토큰·항목/반복 토큰 */
export const isReservedName = (name) => name === 'row' || name === 'lastDialogMessage' || /^sys:/.test(name) || /^(item|loop)\./.test(name);

const blocksOf = (recipe) => (recipe?.blocks && typeof recipe.blocks === 'object' && !Array.isArray(recipe.blocks) ? recipe.blocks : {});
const allSteps = (recipe) => Object.values(blocksOf(recipe)).flatMap((s) => (Array.isArray(s) ? s : []));
const varOf = (recipe, name) => (recipe?.variables ?? []).find((v) => v?.id === name) ?? (recipe?.variables ?? []).find((v) => v?.name === name);

/** 스텝이 부르는 블록 [역할, 블록 이름] (branch.then/else, repeat·forEach.body) */
export function childBlocks(step) {
  if (!step || typeof step !== 'object') return [];
  if (step.type === 'branch')
    return [
      ['then', step.then],
      ['else', step.else],
    ].filter(([, b]) => b);
  if (step.type === 'repeat' || step.type === 'forEach') return step.body ? [['body', step.body]] : [];
  return [];
}

// ---------- 트리·번호 ----------

/**
 * 시작 블록부터 순서대로 스텝을 늘어놓는다. 반복·분기의 몸통(then/else 는 이어서 번호)을 부모 아래에 둔다.
 * 블록은 처음 부르는 곳에서 한 번만 펼친다(같은 블록을 두 번 부르거나 자기 자신을 불러도 끝난다).
 * 어디서도 부르지 않는 블록은 끝에 orphan: true, no: '#-' 로 붙인다.
 * @returns {{id, no, depth, step, block, index, parentId, role, orphan}[]}
 */
export function stepTree(recipe) {
  const blocks = blocksOf(recipe);
  const out = [];
  const expanded = new Set();
  const walk = (block, prefix, depth, parentId, role, orphan, offset) => {
    const steps = Array.isArray(blocks[block]) ? blocks[block] : [];
    expanded.add(block);
    steps.forEach((step, index) => {
      const n = offset + index + 1;
      const no = orphan ? '#-' : prefix ? `${prefix}.${n}` : `#${n}`;
      out.push({ id: step?.id, no, depth, step, block, index, parentId, role, orphan });
      let placed = 0; // then 다음 else 는 번호를 이어서 붙인다 (#4.1 #4.2 | #4.3)
      for (const [r, child] of childBlocks(step)) {
        if (expanded.has(child) || !Array.isArray(blocks[child])) continue;
        placed += walk(child, no, depth + 1, step?.id ?? null, r, orphan, placed);
      }
    });
    return steps.length;
  };
  const entry = recipe?.entryBlock || 'main';
  if (Array.isArray(blocks[entry])) walk(entry, '', 0, null, null, false, 0);
  for (const name of Object.keys(blocks)) if (!expanded.has(name) && Array.isArray(blocks[name])) walk(name, '', 0, null, null, true, 0);
  return out;
}

/** 스텝 id → 전역 번호 ('#4.2', 부르지 않는 블록은 '#-') */
export function stepNumbers(recipe) {
  const map = new Map();
  for (const n of stepTree(recipe)) if (n.id && !map.has(n.id)) map.set(n.id, n.no);
  return map;
}

/** '#4.2'·'4.2' 또는 's12' → { block, index, step } | null (id 를 먼저 본다) */
export function findStep(recipe, idOrNo) {
  const key = String(idOrNo ?? '').trim();
  if (!key) return null;
  for (const [block, steps] of Object.entries(blocksOf(recipe))) {
    if (!Array.isArray(steps)) continue;
    const index = steps.findIndex((s) => s?.id === key);
    if (index >= 0) return { block, index, step: steps[index] };
  }
  const m = /^#?(\d+(?:\.\d+)*)$/.exec(key);
  if (!m) return null;
  const node = stepTree(recipe).find((n) => !n.orphan && n.no === `#${m[1]}`);
  return node ? { block: node.block, index: node.index, step: node.step } : null;
}

// ---------- 변수 ----------

/** 값 안의 {{이름}} 과 조건 var 칸을 찾아 add(이름, 칸 경로) 를 부른다 (녹화 정보 meta 는 보지 않는다). */
function scanNames(value, path, add) {
  if (typeof value === 'string') {
    for (const m of value.matchAll(TOKEN_RE)) add(tokenName(m[1]), path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanNames(v, path ? `${path}.${i}` : String(i), add));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const varKind = VAR_KINDS.has(value.kind);
  if (varKind && value.var) add(cleanVarName(value.var), path ? `${path}.var` : 'var');
  for (const [k, v] of Object.entries(value)) {
    if (k === 'meta' || (varKind && k === 'var')) continue;
    scanNames(v, path ? `${path}.${k}` : k, add);
  }
}

/**
 * 이름 → 쓰는 곳 [{ stepId, no, field }]. 스텝의 모든 문자열 칸({{이름}}, {{이름|필터}})과 조건의 var 칸.
 * 이름은 쓴 그대로(변수 id 든 이름이든) 모은다. static 변수 값 안의 참조는 { stepId: null, no: '', field: 'source.value', varId } 로 넣는다.
 */
export function variableUsages(recipe) {
  const out = {};
  const push = (name, use) => {
    if (!name) return;
    if (!Object.hasOwn(out, name)) out[name] = [];
    out[name].push(use);
  };
  for (const n of stepTree(recipe)) {
    if (!n.step || typeof n.step !== 'object') continue;
    const base = { stepId: n.id, no: n.no, ...(n.step.disabled ? { disabled: true } : {}) };
    for (const [k, v] of Object.entries(n.step)) {
      if (k === 'meta' || k === 'id' || k === 'type') continue;
      scanNames(v, k, (name, field) => push(name, { ...base, field }));
    }
  }
  for (const v of recipe?.variables ?? []) {
    if (v?.source?.kind !== 'static') continue;
    scanNames(String(v.source.value ?? ''), 'source.value', (name, field) => push(name, { stepId: null, no: '', field, varId: v.id }));
  }
  return out;
}

/** 이름으로 쓸 수 있는지 (문제가 있으면 문장) */
function nameProblem(name) {
  if (!name) return '이름이 비어 있습니다.';
  if (/[{}|]/.test(name)) return `이름 "${name}" 에 {, }, | 는 쓸 수 없습니다.`;
  if (isReservedName(name)) return `"${name}" 은(는) 예약된 이름이라 쓸 수 없습니다.`;
  return '';
}

/**
 * 변수 이름을 바꾸고 모든 참조({{이름|필터}} 의 필터는 그대로)를 바꾼다. 변수의 id·name 을 둘 다 to 로 맞춘다.
 * 값 읽기(extract) 이름이면 saveAs 도 바꾼다. 엑셀 변수의 열 이름은 그대로 둔다.
 * @returns {number} 바꾼 참조 수
 */
export function renameVariable(recipe, from, to) {
  const src = cleanVarName(from);
  const dst = cleanVarName(to);
  if (!src) throw new Error('바꿀 변수 이름이 없습니다.');
  const bad = nameProblem(dst);
  if (bad) throw new Error(bad);
  const vars = recipe.variables ?? [];
  const v = varOf(recipe, src);
  const old = new Set([src]);
  if (v) {
    old.add(v.id);
    if (v.name) old.add(v.name);
  }
  const extracts = allSteps(recipe).filter((s) => s?.type === 'extract' && old.has(cleanVarName(s.saveAs)));
  if (!v && !extracts.length && !Object.hasOwn(variableUsages(recipe), src)) throw new Error(`변수 "${src}" 을(를) 찾을 수 없습니다.`);
  if (!old.has(dst)) {
    if (vars.some((x) => x && x !== v && (x.id === dst || x.name === dst))) throw new Error(`이름 "${dst}" 을(를) 이미 다른 변수가 씁니다.`);
    if (allSteps(recipe).some((s) => s?.type === 'extract' && cleanVarName(s.saveAs) === dst)) throw new Error(`이름 "${dst}" 을(를) 이미 값 읽기 스텝이 씁니다.`);
  }
  let count = 0;
  const swap = (s) =>
    s.replace(TOKEN_RE, (all, inner) => {
      const parts = String(inner).split('|');
      if (!old.has(parts[0].trim())) return all;
      count += 1;
      return `{{${[dst, ...parts.slice(1)].join('|')}}}`;
    });
  const rewrite = (obj) => {
    if (Array.isArray(obj)) {
      obj.forEach((x, i) => {
        if (typeof x === 'string') obj[i] = swap(x);
        else rewrite(x);
      });
      return;
    }
    if (!obj || typeof obj !== 'object') return;
    const varKind = VAR_KINDS.has(obj.kind);
    for (const [k, x] of Object.entries(obj)) {
      if (k === 'meta') continue;
      if (varKind && k === 'var' && typeof x === 'string') {
        if (old.has(cleanVarName(x))) {
          obj[k] = /^\s*\{\{/.test(x) ? `{{${dst}}}` : dst;
          count += 1;
        }
      } else if (typeof x === 'string') obj[k] = swap(x);
      else rewrite(x);
    }
  };
  for (const s of allSteps(recipe)) {
    if (!s || typeof s !== 'object') continue;
    for (const [k, x] of Object.entries(s)) {
      if (k === 'meta' || k === 'id' || k === 'type' || (s.type === 'extract' && k === 'saveAs')) continue;
      if (typeof x === 'string') s[k] = swap(x);
      else rewrite(x);
    }
  }
  for (const x of vars) if (x?.source?.kind === 'static' && typeof x.source.value === 'string') x.source.value = swap(x.source.value);
  for (const s of extracts) s.saveAs = dst;
  if (v) {
    if (v.source?.kind === 'excel' && !String(v.source.column ?? '').trim()) v.source.column = v.name || v.id; // 열 이름은 그대로
    v.id = dst;
    v.name = dst;
  }
  return count;
}

// ---------- 묶기·풀기 ----------

function newStepId(recipe) {
  const used = new Set(allSteps(recipe).map((s) => s?.id));
  let n = used.size + 1;
  while (used.has(`s${n}`)) n += 1;
  return `s${n}`;
}

function newBlockName(recipe, base) {
  const blocks = blocksOf(recipe);
  const clean = String(base ?? '').trim() || '블록';
  if (!Object.hasOwn(blocks, clean)) return clean;
  let n = 2;
  while (Object.hasOwn(blocks, `${clean}${n}`)) n += 1;
  return `${clean}${n}`;
}

/** 블록을 부르는 스텝들 */
function callersOf(recipe, block) {
  return allSteps(recipe).filter((s) => childBlocks(s).some(([, b]) => b === block));
}

/**
 * 같은 블록의 이어진 스텝들을 새 블록으로 옮기고, 그 자리에 wrapper 스텝(repeat|forEach|branch)을 넣는다.
 * wrapper 의 body(반복)·then(분기)에 이름을 주면 그 이름으로(겹치면 뒤에 번호), 없으면 '반복'·'항목마다'·'조건'.
 * 반복 횟수·조건을 하나도 주지 않은 repeat 은 times: 2 로 만든다.
 * @returns {{stepId: string, block: string}}
 */
export function wrapSteps(recipe, stepIds, wrapper = {}) {
  const ids = (Array.isArray(stepIds) ? stepIds : [stepIds]).filter((x) => x !== undefined && x !== null && String(x).trim());
  if (!ids.length) throw new Error('묶을 스텝을 하나 이상 고르세요.');
  const type = wrapper?.type ?? wrapper?.kind;
  const field = WRAP_TYPES[type];
  if (!field) throw new Error('묶는 스텝 종류는 repeat·forEach·branch 중 하나여야 합니다.');
  const found = ids.map((id) => {
    const f = findStep(recipe, id);
    if (!f) throw new Error(`스텝 ${id} 을(를) 찾을 수 없습니다.`);
    return f;
  });
  const block = found[0].block;
  if (found.some((f) => f.block !== block)) throw new Error('같은 블록 안의 스텝만 함께 묶을 수 있습니다.');
  const idx = [...new Set(found.map((f) => f.index))].sort((a, b) => a - b);
  if (idx.some((x, i) => i > 0 && x !== idx[i - 1] + 1)) throw new Error('이어진 스텝만 묶을 수 있습니다. 사이에 있는 스텝도 함께 고르세요.');
  const name = newBlockName(recipe, wrapper[field] || WRAP_NAMES[type]);
  const step = JSON.parse(JSON.stringify(wrapper));
  delete step.kind; // AI 도구 인자({ stepIds, kind, … })를 그대로 넘겨도 되게
  delete step.stepIds;
  if (!step.id || allSteps(recipe).some((s) => s?.id === step.id)) step.id = newStepId(recipe);
  step.type = type;
  step[field] = name;
  if (type === 'repeat' && step.times === undefined && !step.while && !step.until) step.times = 2;
  const steps = recipe.blocks[block];
  const moved = steps.splice(idx[0], idx.length, step);
  recipe.blocks[name] = moved;
  return { stepId: step.id, block: name };
}

/**
 * 반복·분기 스텝을 풀어 몸통(분기는 then) 스텝을 그 자리에 되돌리고 몸통 블록을 지운다.
 * 분기의 else 블록은 지우지 않고 남긴다(keptBlocks). 몸통 블록을 다른 스텝도 부르면 풀지 않는다.
 * @returns {{block: string, index: number, stepIds: string[], keptBlocks: string[]}}
 */
export function unwrapStep(recipe, stepId) {
  const f = findStep(recipe, stepId);
  if (!f) throw new Error(`스텝 ${stepId} 을(를) 찾을 수 없습니다.`);
  const { step, block, index } = f;
  const field = WRAP_TYPES[step.type];
  if (!field) throw new Error('반복·목록의 항목마다·조건 분기 스텝만 풀 수 있습니다.');
  const inner = step[field];
  const blocks = blocksOf(recipe);
  let moved = [];
  if (inner && Array.isArray(blocks[inner])) {
    if (inner === (recipe.entryBlock || 'main') || inner === block) throw new Error(`블록 "${inner}" 은(는) 이 스텝이 들어 있는 블록이라 풀 수 없습니다.`);
    const others = callersOf(recipe, inner).filter((s) => s !== step);
    if (others.length) throw new Error(`블록 "${inner}" 을(를) 다른 스텝(${others.map((s) => s.id).join(', ')})도 불러서 풀 수 없습니다.`);
    moved = blocks[inner];
    delete blocks[inner];
  }
  blocks[block].splice(index, 1, ...moved);
  return { block, index, stepIds: moved.map((s) => s?.id), keptBlocks: step.type === 'branch' && step.else ? [step.else] : [] };
}

// ---------- 목록(forEach) 도우미: 녹화한 요소의 경로에서 "그 요소를 품은 행(항목)과 같은 모양의 형제 전체" 를 만든다 ----------

const NTH_RE = /:nth-(?:of-type|child)\(\s*\d+\s*\)/g;
const ROW_TAGS = ['tr', 'li']; // 표의 행이 먼저 (페이지 쪽 itemOf 와 같은 순서)
const segTag = (seg) => /^([a-z][a-z0-9-]*)/i.exec(seg)?.[1]?.toLowerCase() ?? '';
const nthOf = (seg) => Number(/:nth-(?:of-type|child)\(\s*(\d+)\s*\)/.exec(seg)?.[1] ?? /\[(\d+)\]$/.exec(seg)?.[1] ?? 0);
const sigOf = (t) => JSON.stringify([t?.candidates ?? [], t?.framePath ?? [], t?.within ?? '']);
const clone = (x) => JSON.parse(JSON.stringify(x));

/** css 경로("#result > tbody > tr:nth-of-type(1) > td:nth-of-type(4)") → { tag, list, rel, col } (행 경로가 없으면 null) */
function cssRowSplit(value) {
  const v = String(value ?? '').trim();
  if (!v || /[\s,]/.test(v.replace(/\s*>\s*/g, '>'))) return null; // 자손(공백)·여러 선택자는 다루지 않는다
  const segs = v.split(/\s*>\s*/);
  const tags = segs.map(segTag);
  for (const tag of ROW_TAGS) {
    const k = tags.lastIndexOf(tag);
    if (k <= 0) continue; // 부모 경로가 있어야 같은 모양 형제를 가리킬 수 있다
    const rowSeg = segs[k].replace(NTH_RE, '');
    if (!new RegExp(`^${tag}(\\.[\\w-]+)*$`, 'i').test(rowSeg)) continue;
    const rest = segs.slice(k + 1);
    return {
      tag,
      list: `${segs.slice(0, k).join(' > ')} > ${rowSeg}${tag === 'tr' ? ':has(> td)' : ''}`,
      rel: rest.length ? `:scope > ${rest.join(' > ')}` : ':scope',
      col: tag === 'tr' && /^t[dh]\b/i.test(rest[0] ?? '') ? nthOf(rest[0]) || 1 : 0,
    };
  }
  return null;
}

/** 절대 XPath("/html/body/table/tbody/tr[1]/td[4]") → { tag, list, rel, col } */
function xpathRowSplit(value) {
  const m = /^(\/\/\*\[@id=(["'])[^"'/]+\2\]|\/html)((?:\/[a-z][\w-]*(?:\[\d+\])?)*)$/i.exec(String(value ?? '').trim());
  if (!m) return null;
  const segs = m[3].split('/').filter(Boolean);
  const tags = segs.map(segTag);
  for (const tag of ROW_TAGS) {
    const k = tags.lastIndexOf(tag);
    if (k < 0) continue;
    const rest = segs.slice(k + 1);
    return {
      tag,
      list: `${m[1]}/${[...segs.slice(0, k), tag === 'tr' ? 'tr[td]' : 'li'].join('/')}`,
      rel: rest.length ? `./${rest.join('/')}` : null,
      col: tag === 'tr' && /^t[dh]\b/i.test(rest[0] ?? '') ? nthOf(rest[0]) || 1 : 0,
    };
  }
  return null;
}

/**
 * 녹화한 요소(표 칸·목록 항목 안 요소)의 대상에서, 그 요소를 품은 행(항목)과 같은 모양 형제 전체를 가리키는 목록(items)과
 * 그 요소를 항목 기준으로 가리키는 대상(within: 'item')을 만든다. 경로에 표의 행·목록 항목이 없으면 null.
 * @param {object} target 녹화 대상
 * @param {{ name?: string }} [o] 항목 안 대상의 이름 (예: 값 읽기 이름)
 * @returns {{ tag: 'tr'|'li', col: number, items: object, relative: object|null } | null}
 */
export function listFromTarget(target, { name } = {}) {
  if (!target || !Array.isArray(target.candidates) || target.within === 'item') return null;
  const cands = [...target.candidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  let tag = '';
  let col = 0;
  const items = [];
  const rel = [];
  const push = (arr, c) => arr.some((x) => x.kind === c.kind && x.value === c.value) || arr.push(c);
  for (const c of cands) {
    const s = c.kind === 'css' ? cssRowSplit(c.value) : c.kind === 'xpath' ? xpathRowSplit(c.value) : null;
    if (!s || (tag && s.tag !== tag)) continue;
    tag = s.tag;
    col ||= s.col;
    push(items, { kind: c.kind, value: s.list, score: c.kind === 'css' ? 80 : 45 });
    if (s.rel) push(rel, { kind: c.kind, value: s.rel, score: c.kind === 'css' ? 80 : 55 });
  }
  if (!tag) return null;
  const frame = target.framePath?.length ? { framePath: clone(target.framePath) } : { framePath: [] };
  const m = target.meta ?? {};
  const label = String(name ?? '').trim() || m.label || m.name || m.placeholder || (col ? `${col}번째 칸` : '');
  const relMeta = { ...(m.tag ? { tag: m.tag } : {}), ...(m.type ? { type: m.type } : {}), ...(label ? { label } : {}), ...(col ? { colIndex: col } : {}) };
  return {
    tag,
    col,
    items: { ...frame, candidates: items, meta: { tag, label: tag === 'tr' ? '표의 행' : '목록의 항목' } },
    relative: rel.length ? { ...frame, within: 'item', candidates: rel, meta: relMeta } : null,
  };
}

const normCss = (v) =>
  String(v ?? '')
    .replace(/:has\(\s*>\s*td\s*\)/gi, '')
    .replace(/\s*>\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
const normXpath = (v) => String(v ?? '').trim().replace(/\/tr\[td\]$/i, '/tr');

/** 이 대상이 목록(items)의 어느 한 행(항목) 안을 가리키면, 그 요소를 항목 기준으로 가리키는 대상(within: 'item'). 아니면 null. */
export function relativeToList(target, items, o) {
  const w = listFromTarget(target, o);
  if (!w?.relative || !Array.isArray(items?.candidates)) return null;
  const key = (c) => (c?.kind === 'css' ? `css:${normCss(c.value)}` : c?.kind === 'xpath' ? `xpath:${normXpath(c.value)}` : '');
  const want = new Set(w.items.candidates.map(key));
  return items.candidates.some((c) => want.has(key(c))) ? w.relative : null;
}

/** 목록 요소가 화면에서 하나만 가리킬 것 같은지 (녹화한 요소 하나를 고른 경우 — 항목이 1개라 한 번만 돈다) */
export function looksSingle(items) {
  if (!items || !Array.isArray(items.candidates) || !items.candidates.length) return false;
  if (items.meta?.single) return true;
  if (items.meta?.count > 1) return false;
  return items.candidates.some((c) => c.kind === 'text') || items.candidates.every((c) => (c.kind === 'css' && /^#[\w-]+$/.test(String(c.value).trim())) || c.kind === 'attr');
}

const PASSIVE = new Set(['extract', 'sleep', 'wait', 'assert', 'screenshot', 'pdf']); // 화면을 바꾸지 않는 스텝

/**
 * 목록의 항목마다(forEach) 안에 있지만 "항목 안에서 찾기" 가 아니라 항목마다 같은 요소를 쓰는 스텝.
 * - 대상 경로가 그 목록의 어느 한 행(항목)을 가리키면 (definite) — 늘 첫 행 같은 한 곳만 본다
 * - 또는 몸통에서 화면을 바꾸는 스텝(클릭·입력 등)보다 앞에 있는 값 읽기 — 항목마다 같은 값을 읽는다
 * @returns {{ stepId, forEachId, definite: boolean, relative: object|null }[]}
 */
export function sameElementSteps(recipe) {
  const blocks = blocksOf(recipe);
  const out = [];
  const seen = new Set();
  const walk = (block, fe, state, depth, path) => {
    const steps = Array.isArray(blocks[block]) ? blocks[block] : [];
    if (depth > 12 || path.has(block)) return;
    const inner = new Set(path).add(block);
    for (const s of steps) {
      if (!s || typeof s !== 'object' || s.disabled) continue;
      const t = s.target;
      if (t && Array.isArray(t.candidates) && t.candidates.length && t.within !== 'item' && s.id && !seen.has(s.id)) {
        const relative = relativeToList(t, fe.items, { name: s.type === 'extract' ? s.saveAs : undefined });
        if (relative || (s.type === 'extract' && !state.active)) {
          seen.add(s.id);
          out.push({ stepId: s.id, forEachId: fe.id, definite: !!relative, relative });
        }
      }
      if (s.type === 'forEach') {
        state.active = true; // 안쪽 목록은 따로 본다
        continue;
      }
      const kids = childBlocks(s);
      if (kids.length) {
        let any = false;
        for (const [, child] of kids) {
          const st = { active: state.active };
          walk(child, fe, st, depth + 1, inner);
          any ||= st.active;
        }
        state.active ||= any;
      } else if (!PASSIVE.has(s.type)) state.active = true;
    }
  };
  for (const s of allSteps(recipe)) if (s?.type === 'forEach' && !s.disabled && s.body && Array.isArray(s.items?.candidates)) walk(s.body, s, { active: false }, 0, new Set());
  return out;
}

/** 반복 몸통의 끝이 반복 조건의 요소를 누르는 클릭이면 그 클릭 스텝 id ("다음" 을 누른 뒤 조건을 보므로 마지막 쪽을 빠뜨린다) */
export function pagingRisk(recipe, step) {
  if (step?.type !== 'repeat' || !step.body || pagingOf(recipe, step)) return null;
  const cond = step.while ?? step.until;
  if (!cond) return null;
  const targets = [];
  const scan = (c) => {
    if (!c || typeof c !== 'object') return;
    if (c.kind === 'exists' && c.target) targets.push(sigOf(c.target));
    if (c.condition) scan(c.condition);
    for (const x of c.conditions ?? []) scan(x);
  };
  scan(cond);
  const body = blocksOf(recipe)[step.body];
  if (!Array.isArray(body) || body.length < 2) return null; // "더 보기" 만 누르는 반복은 괜찮다
  const last = [...body].reverse().find((x) => x && !x.disabled);
  return last && (last.type === 'click' || last.type === 'dblclick') && last.target && targets.includes(sigOf(last.target)) ? last.id : null;
}

const isPageGuard = (c) => c?.kind === 'varCompare' && cleanVarName(c.var) === 'loop.index' && (c.op ?? '=') === '>' && String(c.value ?? '').trim() === '1';

/**
 * 쪽 넘기기 반복인지: until 이 "다음 단추가 없음" 이고, 몸통 첫 스텝이 "두 번째 반복부터 다음 누르기" 분기.
 * @returns {{ branchId, clickId, block, target } | null}
 */
export function pagingOf(recipe, step) {
  if (step?.type !== 'repeat' || !step.body) return null;
  const u = step.until;
  if (u?.kind !== 'not' || u.condition?.kind !== 'exists' || !u.condition.target) return null;
  const blocks = blocksOf(recipe);
  const br = Array.isArray(blocks[step.body]) ? blocks[step.body][0] : null;
  if (br?.type !== 'branch' || !isPageGuard(br.condition) || !br.then || br.else) return null;
  const inner = blocks[br.then];
  const click = Array.isArray(inner) ? inner.find((x) => (x?.type === 'click' || x?.type === 'dblclick') && sigOf(x.target) === sigOf(u.condition.target)) : null;
  return click ? { branchId: br.id, clickId: click.id, block: br.then, target: click.target } : null;
}

/**
 * 반복을 "다음 쪽이 없을 때까지 (쪽 넘기기)" 로 바꾼다: 지금 쪽을 처리하고, "다음" 이 있으면 누르고 다시.
 * 몸통의 "다음" 클릭(clickStepId)을 "두 번째 반복부터 누르기" 분기로 몸통 맨 앞에 옮기거나(target 이면 새 클릭을 만든다),
 * 반복 방법을 until: "다음" 이 없음 으로 바꾼다. 최대 반복 횟수가 없으면 100.
 * @returns {{ branchId: string, clickId: string, block: string }}
 */
export function makePaging(recipe, repeatId, { clickStepId, target } = {}) {
  const f = findStep(recipe, repeatId);
  if (!f || f.step.type !== 'repeat') throw new Error('반복 스텝을 찾을 수 없습니다.');
  const s = f.step;
  const blocks = blocksOf(recipe);
  if (!s.body || !Array.isArray(blocks[s.body])) throw new Error('반복할 블록이 없습니다.');
  const done = pagingOf(recipe, s);
  if (done) return { branchId: done.branchId, clickId: done.clickId, block: done.block };
  const body = blocks[s.body];
  let click;
  if (clickStepId) {
    const i = body.findIndex((x) => x?.id === clickStepId);
    if (i < 0) throw new Error('"다음" 을 누르는 클릭 스텝이 반복 안에 없습니다.');
    if (body[i].type !== 'click' && body[i].type !== 'dblclick') throw new Error('"다음" 단추로는 클릭 스텝을 골라야 합니다.');
    click = body.splice(i, 1)[0];
  } else if (target?.candidates?.length) click = { id: newStepId(recipe), type: 'click', target: clone(target) };
  else throw new Error('누를 "다음" 단추를 고르세요.');
  if (!click.target?.candidates?.length) throw new Error('"다음" 클릭 스텝에 대상 요소가 없습니다.');
  const name = newBlockName(recipe, '다음누르기');
  blocks[name] = [click];
  const branch = { id: newStepId(recipe), type: 'branch', condition: { kind: 'varCompare', var: 'loop.index', op: '>', value: '1' }, then: name };
  body.unshift(branch);
  delete s.times;
  delete s.while;
  s.until = { kind: 'not', condition: { kind: 'exists', target: clone(click.target) } };
  if (s.maxIterations === undefined || s.maxIterations === null || s.maxIterations === '') s.maxIterations = 100;
  return { branchId: branch.id, clickId: click.id, block: name };
}

/** 쪽 넘기기를 풀어 "다음" 클릭을 몸통 끝으로 되돌린다 (반복 방법은 부르는 쪽이 정한다). 쪽 넘기기가 아니면 null. */
export function unmakePaging(recipe, repeatId) {
  const f = findStep(recipe, repeatId);
  const p = f ? pagingOf(recipe, f.step) : null;
  if (!p) return null;
  const blocks = blocksOf(recipe);
  const body = blocks[f.step.body];
  body.splice(body.findIndex((x) => x?.id === p.branchId), 1);
  if (callersOf(recipe, p.block).length === 0) {
    body.push(...blocks[p.block]);
    delete blocks[p.block];
  }
  return { clickId: p.clickId, target: p.target };
}

/**
 * 로그인 스텝 묶음: 비밀번호 칸(또는 비밀 변수) 입력과 그 앞의 이어진 입력들, 바로 뒤의 로그인 클릭(또는 Enter).
 * 이미 분기 안에 있으면(로그인 화면일 때만) null. 엑셀 여러 행을 돌리면 2행부터는 이미 로그인돼 있어 로그인 화면이 없다.
 * @returns {{ stepIds: string[], first: object, block: string } | null}
 */
export function loginSteps(recipe) {
  const entry = recipe?.entryBlock || 'main';
  const steps = blocksOf(recipe)[entry];
  if (!Array.isArray(steps)) return null;
  const secretVar = (s) => {
    const m = /^\s*\{\{\s*([^{}|]+?)\s*(?:\|[^{}]*)?\}\}\s*$/.exec(String(s?.value ?? ''));
    return !!(m && varOf(recipe, m[1])?.source?.secret);
  };
  const isPw = (s) => s?.type === 'input' && !s.disabled && (s.target?.meta?.type === 'password' || secretVar(s));
  const pw = steps.findIndex(isPw);
  if (pw < 0) return null;
  const fill = (s) => s && !s.disabled && ['input', 'select', 'check'].includes(s.type) && s.target?.candidates?.length;
  let a = pw;
  while (a > 0 && fill(steps[a - 1])) a -= 1;
  let b = pw;
  while (b + 1 < steps.length && fill(steps[b + 1])) b += 1;
  const next = steps[b + 1];
  if (next && !next.disabled && (next.type === 'click' || (next.type === 'keypress' && /^enter$/i.test(String(next.key ?? ''))))) b += 1;
  const group = steps.slice(a, b + 1);
  if (!group.every((s) => s?.id)) return null;
  return { stepIds: group.map((s) => s.id), first: steps[a], block: entry };
}

/** 로그인 스텝을 "아이디 칸(첫 입력 칸)이 있으면" 분기로 묶는다 → wrapSteps 결과 */
export function wrapLogin(recipe) {
  const g = loginSteps(recipe);
  if (!g) throw new Error('묶을 로그인 스텝(비밀번호 입력)을 찾지 못했습니다.');
  return wrapSteps(recipe, g.stepIds, { type: 'branch', condition: { kind: 'exists', target: clone(g.first.target) }, then: '로그인' });
}

// ---------- 녹화 입력 정리 ----------

/** 스텝 값이 가리키는 그대로의 값 (녹화 값 → static 값 → prompt 기본값). 모르면 undefined. */
function literalOf(recipe, s) {
  const raw = s.value === undefined || s.value === null ? '' : String(s.value);
  if (!raw.includes('{{')) return s.type === 'select' && s.label ? String(s.label) : raw;
  const toks = [...raw.matchAll(TOKEN_RE)];
  const v = toks.length === 1 && toks[0][0] === raw.trim() ? varOf(recipe, tokenName(toks[0][1])) : null;
  if (v?.source?.secret) return undefined; // 비밀값은 어디에도 남기지 않는다
  if (s.meta?.recordedValue !== undefined && s.meta?.recordedValue !== null) return String(s.meta.recordedValue);
  if (v?.source?.kind === 'static' && !String(v.source.value ?? '').includes('{{')) return String(v.source.value ?? '');
  if (v?.source?.kind === 'prompt' && v.source.default !== undefined && v.source.default !== '') return String(v.source.default);
  return undefined;
}

function modeOf(recipe, s, saveAs) {
  const raw = s.value === undefined || s.value === null ? '' : String(s.value);
  const toks = [...raw.matchAll(TOKEN_RE)];
  if (!toks.length) return { mode: 'fixed' };
  if (toks.length > 1 || toks[0][0] !== raw.trim()) return { mode: 'mixed' };
  const name = tokenName(toks[0][1]);
  const v = varOf(recipe, name);
  if (v) {
    const k = v.source?.kind;
    const mode = k === 'excel' ? 'excel' : k === 'prompt' ? (v.source.secret ? 'secret' : 'prompt') : k === 'static' ? 'fixed' : 'mixed';
    return { mode, varName: v.name || v.id };
  }
  if (saveAs.has(name) || isReservedName(name)) return { mode: 'mixed', varName: name };
  return { mode: 'excel', varName: name }; // 변수 정의 없이 엑셀 열 이름을 바로 쓴 경우
}

/**
 * 녹화한 입력·선택 스텝 목록 (트리 순서).
 * @returns {{stepId, no, type, label, recordedValue, value, mode: 'fixed'|'excel'|'prompt'|'secret'|'mixed', varName?, disabled?}[]}
 */
export function inputSteps(recipe) {
  const saveAs = new Set(allSteps(recipe).filter((s) => s?.type === 'extract').map((s) => cleanVarName(s.saveAs)));
  const out = [];
  for (const n of stepTree(recipe)) {
    const s = n.step;
    if (!s || (s.type !== 'input' && s.type !== 'select')) continue;
    const { mode, varName } = modeOf(recipe, s, saveAs);
    const lit = mode === 'secret' ? '' : literalOf(recipe, s);
    const row = { stepId: s.id, no: n.no, type: s.type, label: targetName(s.target), recordedValue: lit ?? '', value: s.value === undefined || s.value === null ? '' : String(s.value), mode };
    if (varName) row.varName = varName;
    if (s.disabled) row.disabled = true;
    out.push(row);
  }
  return out;
}

function cleanName(s) {
  return String(s ?? '')
    .replace(/[{}|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

const sameKind = (v, mode) => {
  const s = v?.source ?? {};
  if (mode === 'excel') return s.kind === 'excel';
  return s.kind === 'prompt' && !!s.secret === (mode === 'secret');
};

/** 이름 변수를 kind 로 맞춘다 (없으면 만들고, 종류가 다르면 바꾼다). 변수 객체를 돌려준다. */
function ensureVariable(recipe, name, source) {
  recipe.variables ??= [];
  let v = varOf(recipe, name);
  if (!v && source.kind === 'excel') v = recipe.variables.find((x) => x?.source?.kind === 'excel' && (x.source.column || x.name || x.id) === name);
  if (!v) {
    v = { id: name, name, source };
    recipe.variables.push(v);
    return v;
  }
  const s = v.source ?? {};
  if (source.kind === 'excel') v.source = s.kind === 'excel' ? { ...s, column: s.column || v.name || v.id } : source;
  else if (source.secret) v.source = { kind: 'prompt', secret: true };
  else if (s.kind !== 'prompt' || s.secret) v.source = source;
  return v;
}

/**
 * 입력 방식을 한 번에 바꾼다. decisions: [{ stepId, mode: 'fixed'|'excel'|'prompt'|'secret', name? }]
 * - fixed: 녹화 값(없으면 static 값·기본값)을 그대로 넣는다. - excel: 엑셀 열 변수 {{열}} (녹화 값은 meta.recordedValue 에).
 * - prompt: 실행 때 입력 (녹화 값을 기본값으로). - secret: 실행 때 입력 + 가림, 기본값 없음, 녹화 값도 지운다.
 * 하나라도 바꿀 수 없으면 아무것도 바꾸지 않고 오류를 낸다.
 * @returns {{changed: string[], variables: string[]}}
 */
export function applyInputModes(recipe, decisions) {
  const rows = new Map(inputSteps(recipe).map((r) => [r.stepId, r]));
  const plan = (decisions ?? []).map((d, k) => {
    const f = findStep(recipe, d?.stepId);
    if (!f || (f.step.type !== 'input' && f.step.type !== 'select')) throw new Error(`입력 스텝 ${d?.stepId} 을(를) 찾을 수 없습니다.`);
    if (!INPUT_MODES.includes(d.mode)) throw new Error(`입력 방식 "${d.mode}" 은(는) 쓸 수 없습니다 (fixed·excel·prompt·secret).`);
    const row = rows.get(f.step.id);
    const literal = literalOf(recipe, f.step);
    if (d.mode === 'fixed' && literal === undefined && row?.mode !== 'fixed') throw new Error(`${row?.no ?? f.step.id} ${row?.label ?? ''}: 녹화 값이 없어 "그대로"로 바꿀 수 없습니다.`);
    const given = cleanName(d.name);
    if (d.mode !== 'fixed' && given) {
      const bad = nameProblem(given);
      if (bad) throw new Error(bad);
    }
    return { step: f.step, mode: d.mode, given, row, literal, k };
  });
  const changed = [];
  const made = [];
  for (const { step: s, mode, given, row, literal, k } of plan) {
    const before = JSON.stringify(s);
    // 이름: 준 이름 그대로(같은 이름 변수가 있으면 그 종류로 바꾼다) → 방식이 같으면 지금 변수 → 칸 이름(다른 종류 변수와 겹치면 번호)
    let name = given;
    if (!name && mode !== 'fixed') {
      if (row?.mode === mode && row.varName) name = row.varName;
      else {
        const base = cleanName(row?.label) || `입력${k + 1}`;
        const root = isReservedName(base) ? `${base}값` : base;
        name = root;
        for (let n = 2; varOf(recipe, name) && !sameKind(varOf(recipe, name), mode); n += 1) name = `${root}${n}`;
      }
    }
    if (mode === 'fixed') {
      if (literal !== undefined) s.value = literal;
      if (s.type === 'select') delete s.label;
    } else {
      const source = mode === 'excel' ? { kind: 'excel', column: name } : mode === 'secret' ? { kind: 'prompt', secret: true } : { kind: 'prompt', ...(literal ? { default: literal } : {}) };
      const v = ensureVariable(recipe, name, source);
      if (!made.includes(v.id)) made.push(v.id);
      s.value = `{{${v.id}}}`;
      if (s.type === 'select') delete s.label;
      if (mode === 'secret') {
        // 비밀 변수를 쓰는 입력은 녹화 값을 남기지 않는다
        for (const x of allSteps(recipe)) {
          if (x?.meta && (x.type === 'input' || x.type === 'select') && [v.id, v.name].includes(tokenName(cleanVarName(x.value)))) delete x.meta.recordedValue;
        }
      } else if (literal !== undefined && literal !== '') s.meta = { ...(s.meta ?? {}), recordedValue: literal };
    }
    if (JSON.stringify(s) !== before) changed.push(s.id);
  }
  return { changed, variables: made };
}
