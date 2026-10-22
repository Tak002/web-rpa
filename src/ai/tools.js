// AI 도우미가 쓰는 도구: 레시피 사본을 읽고 고치며, 화면을 관찰해 새 요소의 타겟을 만들고, 실행 결과를 본다.
// 스텝은 id(s12) 와 화면과 같은 전역 번호(#4.2) 둘 다로 가리킬 수 있다. AI 에게 가는 내용에서 비밀값은 가린다.

import { stepText, conditionText, STEP_LABELS, targetText } from '../../public/shared/steps.js';
import { stepTree, stepNumbers, findStep, renameVariable, wrapSteps, unwrapStep } from '../../public/shared/recipe-edit.js';
import { recipeProblems, excelColumnsOf } from '../recipe.js';
import { maskRecipe } from '../secrets.js';

const fn = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});
const STEP_REF = { type: 'string', description: '스텝 id(s12) 또는 화면 번호(#4.2)' };
const STEP_OBJ = {
  type: 'object',
  description:
    '스텝 객체 (id 제외). 형식은 시스템 안내 참고. 화면 요소가 필요하면 target 대신 targetRef(관찰 참조 번호) 또는 targetFromStep(기존 스텝)을 쓴다. forEach 몸통 안에서 지금 항목 안의 요소면 withinRef(항목 참조 번호)를 함께 준다. forEach 의 items 는 itemsRef(목록 항목 하나의 참조 번호)로 만든다.',
};
const COND = { type: 'object', description: '조건 객체 (시스템 안내의 조건 종류). 요소가 필요하면 target 대신 targetRef / targetFromStep' };

export const MAX_SAMPLE_ROWS = 2;

export const TOOL_DEFS = [
  fn('get_recipe', '레시피 전체 개요: 변수, 블록별 스텝(id·번호·종류·설명·주요 값·대상 요소 요약). [맥락]의 개요로 부족할 때 부른다.', {}),
  fn('get_step', '스텝 하나의 전체 JSON (대상 요소의 후보 선택자 포함).', { stepId: STEP_REF }, ['stepId']),
  fn(
    'update_step',
    '스텝 필드를 바꾼다. changes 의 값이 null 이면 그 필드를 지운다. id 는 못 바꾼다.',
    { stepId: STEP_REF, changes: { type: 'object', description: '바꿀 필드. target 대신 targetRef / targetFromStep (+ withinRef) 사용 가능' } },
    ['stepId', 'changes'],
  ),
  fn(
    'insert_steps',
    '스텝들을 afterStepId 바로 뒤에 넣는다 (null 이면 block 맨 앞). block 을 비우면 afterStepId 가 있는 블록(없으면 main). 블록이 없으면 새로 만든다. 새 id 목록을 돌려준다.',
    { afterStepId: { type: ['string', 'null'], description: '스텝 id 또는 번호' }, block: { type: 'string' }, steps: { type: 'array', items: STEP_OBJ } },
    ['afterStepId', 'steps'],
  ),
  fn('delete_steps', '스텝들을 지운다.', { stepIds: { type: 'array', items: STEP_REF } }, ['stepIds']),
  fn('move_step', '스텝을 afterStepId 바로 뒤로 옮긴다 (null 이면 블록 맨 앞).', { stepId: STEP_REF, afterStepId: { type: ['string', 'null'] }, block: { type: 'string' } }, ['stepId', 'afterStepId']),
  fn(
    'set_variables',
    '변수를 추가·수정(upsert, id 기준)하거나 지운다. 이름을 바꿀 때는 rename_variable 을 쓴다.',
    {
      upsert: { type: 'array', items: { type: 'object', description: '{id, name, source:{kind:"excel",column} | {kind:"static",value} | {kind:"prompt",default?,secret?}}' } },
      remove: { type: 'array', items: { type: 'string' } },
    },
  ),
  fn('rename_variable', '변수 이름을 바꾸고, 모든 스텝의 {{이름}} 참조를 함께 바꾼다 (|필터 유지).', { from: { type: 'string' }, to: { type: 'string' } }, ['from', 'to']),
  fn('set_recipe_fields', '레시피 이름·시작 주소·행 실패 처리를 바꾼다.', { name: { type: 'string' }, startUrl: { type: 'string' }, onRowError: { type: 'string', enum: ['skip', 'stop'] } }),
  fn(
    'wrap_steps',
    '같은 블록에 이어진 스텝들을 새 블록으로 옮기고, 그 자리에 반복(repeat)·목록의 항목마다(forEach)·조건 분기(branch) 스텝을 넣는다.',
    {
      stepIds: { type: 'array', items: STEP_REF, description: '이어진 스텝들 (순서대로)' },
      kind: { type: 'string', enum: ['repeat', 'forEach', 'branch'] },
      times: { type: 'integer', description: 'repeat: N번' },
      while: { ...COND, description: 'repeat: 반복 전에 검사, 참인 동안' },
      until: { ...COND, description: 'repeat: 반복 뒤에 검사, 참이면 끝' },
      maxIterations: { type: 'integer', description: 'repeat 상한 (기본 100, 1–1000)' },
      itemsRef: { type: 'string', description: 'forEach: 목록 항목 하나의 관찰 참조 번호 (같은 모양의 형제들을 찾는다)' },
      maxItems: { type: 'integer', description: 'forEach 상한 (기본 100)' },
      restore: { type: 'string', enum: ['none', 'back'], description: 'forEach: 항목마다 뒤로 가기' },
      condition: { ...COND, description: 'branch: 조건' },
      blockName: { type: 'string', description: '새 블록 이름 (선택)' },
    },
    ['stepIds', 'kind'],
  ),
  fn('unwrap_step', '반복·분기 스텝을 풀어 몸통 스텝들을 그 자리로 되돌린다.', { stepId: STEP_REF }, ['stepId']),
  fn('validate_recipe', '레시피 검사. 고칠 점 목록을 돌려준다. 수정을 마치면 반드시 호출한다.', {}),
  fn(
    'observe_page',
    '숨긴 브라우저로 레시피를 처음부터 runUntilStepId 까지(포함) 실제로 실행한 뒤, 그 화면의 요소 목록(참조 번호 f<프레임>e<번호>)을 돌려준다. runUntilStepId 를 비우면 시작 주소만 연다. PDF·다운로드 같은 출력 스텝은 건너뛴다. 엑셀 변수는 sampleValues 또는 녹화 때 값으로 채운다.',
    {
      runUntilStepId: { type: ['string', 'null'], description: '스텝 id 또는 번호' },
      sampleValues: { type: 'object', description: '{변수/열 이름: 값} — 엑셀 열 견본 값' },
    },
  ),
  fn('describe_target', '관찰 참조 번호로 만든 타겟(후보 선택자)을 미리 본다. 스텝에는 targetRef 로 바로 넣으면 된다.', { ref: { type: 'string' } }, ['ref']),
  fn('make_list_target', '관찰 참조 번호의 요소와 같은 모양의 형제들(표의 행, 목록 항목, 카드)을 찾아 개수와 첫 항목들을 보여 준다. forEach 의 itemsRef 로 쓰기 전에 확인한다.', { ref: { type: 'string' } }, ['ref']),
  fn('get_last_run', '이 레시피의 최근 실행 요약: 상태, 행 수, 실패 행과 오류·실패 스텝, 로그 끝 40줄.', { runId: { type: 'string', description: '비우면 가장 최근 실행' } }),
  fn('get_failure_screenshot', '실패한 행의 그때 화면 이미지를 다음 메시지에 붙여 보여 준다.', { runId: { type: 'string' }, row: { type: 'integer' } }, ['row']),
  fn(
    'run_sample',
    '고친 레시피를 숨긴 브라우저로 1~2행 실제로 실행해 본다 (출력 스텝 포함, 되돌릴 수 없는 버튼은 누르지 않음). 행마다 성공·실패, 읽은 값, 만든 파일을 돌려준다. 고친 뒤 스스로 확인할 때 쓴다.',
    { rows: { type: 'integer', description: '1 또는 2 (기본 1)' }, sampleValues: { type: ['object', 'array'], description: '{열 이름: 값} 또는 행마다 [{…}, {…}]' } },
  ),
  fn('remember', '이 레시피에 대해 알아낸 사실을 메모에 한 줄 남긴다 (예: "조회 뒤 표가 2초 늦게 뜬다"). 다음 대화에서도 보인다.', { note: { type: 'string' } }, ['note']),
  fn(
    'ask_choice',
    '해석이 둘 이상일 때 사용자에게 고르게 한다. 이 턴을 끝내고 화면에 버튼을 보인다. 사용자가 고른 버튼의 message 가 다음 요청으로 온다.',
    {
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, message: { type: 'string' } }, required: ['label', 'message'] }, description: '2~4개' },
    },
    ['question', 'options'],
  ),
];

const candidateText = (c) => `${c.score} ${c.kind}:${typeof c.value === 'string' ? c.value : `<${c.value?.tag}>"${c.value?.text}"`}`;
const isStepRef = (s) => typeof s === 'string' && s.trim() !== '';

/** 사람이 읽는 레시피 개요 (전역 번호 한 줄씩). 길면 앞 maxLines 줄만. */
export function recipeOverview(recipe, { maxLines = 150 } = {}) {
  const tree = stepTree(recipe);
  const lines = [];
  for (const n of tree) {
    if (lines.length >= maxLines) {
      lines.push(`… (스텝 ${tree.length - maxLines}개 더 있음 — get_recipe 로 본다)`);
      break;
    }
    const s = n.step ?? {};
    const flags = [s.disabled ? '꺼짐' : '', s.optional ? '없으면 건너뜀' : '', s.onError === 'continue' ? '실패해도 계속' : ''].filter(Boolean);
    const where = n.orphan ? ` [${n.block} 블록 — 어디서도 부르지 않음]` : n.role ? ` (${n.role === 'body' ? '몸통' : n.role === 'then' ? '맞으면' : '아니면'})` : '';
    lines.push(`${'  '.repeat(n.depth ?? 0)}${n.no} ${s.id} ${STEP_LABELS[s.type] ?? s.type}: ${stepText(s)}${flags.length ? ` [${flags.join(', ')}]` : ''}${where}`);
  }
  return lines;
}

/** 변수 한 줄 요약 */
export function variablesLine(recipe) {
  const vs = (recipe?.variables ?? []).filter((v) => v?.id);
  if (!vs.length) return '(변수 없음)';
  return vs
    .map((v) => {
      const s = v.source ?? {};
      const kind = s.kind === 'excel' ? `엑셀 열 "${s.column || v.name || v.id}"` : s.kind === 'static' ? '고정 값' : s.kind === 'prompt' ? (s.secret ? '실행 때 입력·비밀' : '실행 때 입력') : s.kind;
      return `{{${v.id}}}${v.name && v.name !== v.id ? `(${v.name})` : ''} ${kind}`;
    })
    .join(' · ');
}

const stepKey = (s) => {
  const { meta, ...rest } = s ?? {};
  return JSON.stringify(rest);
};

const targetKey = (t) => JSON.stringify([t?.candidates ?? [], t?.framePath ?? [], t?.within ?? '']);
/** 스텝 수정 문구: "앞 → 뒤" + 대상이 바뀌었으면 그 내용, 문장이 같으면 바뀐 칸 이름 */
export function changeText(before, after) {
  const t0 = stepText(before);
  const t1 = stepText(after);
  const extra = [];
  for (const k of ['target', 'items']) {
    if (targetKey(before?.[k]) === targetKey(after?.[k])) continue;
    const a = before?.[k] ? targetText(before[k]) : '(없음)';
    const b = after?.[k] ? targetText(after[k]) : '(없음)';
    extra.push(a === b ? `${k === 'items' ? '목록' : '대상'} 찾는 방법 바뀜` : `${k === 'items' ? '목록' : '대상'}: ${a} → ${b}`);
  }
  if (t0 === t1 && !extra.length) {
    const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter((k) => k !== 'meta' && JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]));
    return `${t1} (세부 설정 바뀜${keys.length ? `: ${keys.join(', ')}` : ''})`;
  }
  return `${t0 === t1 ? t1 : `${t0} → ${t1}`}${extra.length ? ` (${extra.join(' · ')})` : ''}`;
}

/** 두 레시피의 스텝·변수 차이 (사람이 읽는 줄). before 가 없으면 빈 목록. */
export function recipeDiff(before, after, { maxLines = 30 } = {}) {
  if (!before?.blocks || !after?.blocks) return [];
  const index = (r) => {
    const m = new Map();
    for (const [block, steps] of Object.entries(r.blocks)) (Array.isArray(steps) ? steps : []).forEach((s, i) => s?.id && m.set(s.id, { block, i, step: s }));
    return m;
  };
  const a = index(before);
  const b = index(after);
  const noA = stepNumbers(before);
  const noB = stepNumbers(after);
  const out = [];
  for (const [id, x] of b) {
    const y = a.get(id);
    if (!y) out.push(`추가 ${noB.get(id) ?? ''} ${id}: ${stepText(x.step)}`);
    else if (stepKey(x.step) !== stepKey(y.step)) out.push(`수정 ${noB.get(id) ?? ''} ${id}: ${changeText(y.step, x.step)}`);
    else if (x.block !== y.block) out.push(`이동 ${id}: ${y.block} → ${x.block} 블록 (${noB.get(id) ?? ''})`); // 번호만 밀린 것은 알리지 않는다
  }
  for (const [id, y] of a) if (!b.has(id)) out.push(`삭제 ${noA.get(id) ?? ''} ${id}: ${stepText(y.step)}`);
  const vars = (r) => new Map((r.variables ?? []).filter((v) => v?.id).map((v) => [v.id, JSON.stringify(v)]));
  const va = vars(before);
  const vb = vars(after);
  for (const [id, j] of vb) if (!va.has(id)) out.push(`변수 추가 {{${id}}}`);
  else if (va.get(id) !== j) out.push(`변수 수정 {{${id}}}`);
  for (const id of va.keys()) if (!vb.has(id)) out.push(`변수 삭제 {{${id}}}`);
  if (out.length > maxLines) return [...out.slice(0, maxLines), `… (그 밖에 ${out.length - maxLines}건)`];
  return out.map((l) => l.replace(/\s+/g, ' ').trim());
}

/** 지난 턴의 큰 도구 결과를 요약으로 바꾼다 (refs: 그 뒤에 실제로 쓴 참조 번호). 이미 요약이면 그대로. */
export function compactToolResult(name, content, refs = new Set()) {
  const text = String(content ?? '');
  if (text.startsWith('(요약)')) return text;
  switch (name) {
    case 'get_recipe':
      return '(요약) 그때의 레시피 개요 — 지금 레시피는 [맥락]의 개요를 본다.';
    case 'observe_page': {
      const lines = text.split('\n');
      const page = lines.find((l) => l.startsWith('페이지:')) ?? '';
      const used = lines.filter((l) => [...refs].some((r) => l.startsWith(`${r} `)));
      return ['(요약) ' + lines[0], page, used.length ? `그때 고른 요소:\n${used.join('\n')}` : '', '(화면 요소 목록은 생략 — 참조 번호는 다시 관찰해야 쓸 수 있다)'].filter(Boolean).join('\n');
    }
    case 'run_sample':
    case 'get_last_run': {
      if (text.length <= 800) return text;
      try {
        const o = JSON.parse(text);
        delete o.logTail;
        delete o.log;
        const s = JSON.stringify(o);
        return `(요약) ${s.length > 1500 ? `${s.slice(0, 1500)}…` : s}`;
      } catch {
        return `(요약) ${text.slice(0, 800)}…`;
      }
    }
    default:
      return text.length <= 1200 ? text : `(요약) ${name} 결과 (${text.length}자) — 필요하면 다시 부른다. 앞부분: ${text.slice(0, 400)}…`;
  }
}

/** 도구 인자 안의 참조 번호 (targetRef·ref·itemsRef·withinRef) */
export function refsIn(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => refsIn(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (['targetRef', 'ref', 'itemsRef', 'withinRef'].includes(k) && typeof v === 'string') out.add(v.trim());
      else refsIn(v, out);
    }
  }
  return out;
}

export class RecipeTools {
  /**
   * @param {object} recipe 작업 사본 (직접 고친다)
   * @param {{observe: Function, targetFor: Function, listTargetFor?: Function, runSample?: Function, lastRun?: Function, failureShot?: Function, remember?: Function}} env
   */
  constructor(recipe, env) {
    this.recipe = recipe;
    this.env = env;
    this.changes = [];
    this.attachments = []; // 다음 사용자 메시지에 붙일 이미지 (data URL)
    this.choice = null; // ask_choice → { question, options }
  }

  blocks() {
    return this.recipe.blocks;
  }

  /** id(s12) 또는 번호(#4.2) → { block, steps, index, step } */
  find(ref) {
    const key = String(ref ?? '').trim();
    const f = isStepRef(key) ? findStep(this.recipe, key) : null;
    if (!f) throw new Error(`스텝 ${key || '(빈 값)'} 이(가) 없습니다. [맥락]의 개요나 get_recipe 로 id·번호를 확인하세요.`);
    return { ...f, steps: this.recipe.blocks[f.block] };
  }

  no(id) {
    return stepNumbers(this.recipe).get(id) ?? '';
  }

  newId() {
    const used = new Set(Object.values(this.recipe.blocks).flat().map((s) => s?.id));
    let n = used.size + 1;
    while (used.has(`s${n}`)) n += 1;
    return `s${n}`;
  }

  async resolveTargetFields(obj) {
    if (obj.targetRef) {
      obj.target = await this.env.targetFor(obj.targetRef, obj.withinRef ? { withinRef: obj.withinRef } : undefined);
      delete obj.targetRef;
    } else if (obj.targetFromStep) {
      obj.target = structuredClone(this.find(obj.targetFromStep).step.target);
      if (!obj.target) throw new Error(`스텝 ${obj.targetFromStep} 에는 대상 요소가 없습니다.`);
      delete obj.targetFromStep;
    }
    delete obj.withinRef;
    if (obj.itemsRef) {
      if (!this.env.listTargetFor) throw new Error('목록 타겟을 만들 수 없습니다.');
      obj.items = (await this.env.listTargetFor(obj.itemsRef)).target;
      delete obj.itemsRef;
    }
    for (const k of ['condition', 'while', 'until']) if (obj[k]) await this.resolveConditionTargets(obj[k]);
    // 값 읽기 대상은 행마다 글자가 바뀌므로, 견본 화면의 글자로 만든 text 후보는 뺀다.
    if (obj.type === 'extract' && obj.target?.candidates?.some((c) => c.kind !== 'text')) {
      obj.target = { ...obj.target, candidates: obj.target.candidates.filter((c) => c.kind !== 'text') };
    }
    return obj;
  }

  async resolveConditionTargets(c) {
    if (!c || typeof c !== 'object') return;
    if (c.targetRef || c.targetFromStep) await this.resolveTargetFields(c);
    if (c.condition) await this.resolveConditionTargets(c.condition);
    for (const sub of c.conditions ?? []) await this.resolveConditionTargets(sub);
  }

  checkStep(step) {
    if (!STEP_LABELS[step.type]) throw new Error(`알 수 없는 스텝 종류 "${step.type}". 가능: ${Object.keys(STEP_LABELS).join(', ')}`);
    if (step.target && !Array.isArray(step.target.candidates)) throw new Error('target 형식이 잘못됐습니다. targetRef 또는 targetFromStep 을 쓰세요.');
    if (step.items && !Array.isArray(step.items.candidates)) throw new Error('items 형식이 잘못됐습니다. itemsRef 를 쓰세요.');
  }

  summaryOfStep(s, i, numbers) {
    const out = { id: s.id, no: numbers?.get(s.id) ?? '', n: i + 1, type: s.type, desc: stepText(s) };
    for (const k of ['value', 'label', 'url', 'key', 'ms', 'fileName', 'saveAs', 'attr', 'then', 'else', 'body', 'times', 'maxIterations', 'maxItems', 'restore', 'checked', 'action', 'message', 'path']) {
      if (s[k] !== undefined && s[k] !== '') out[k] = s[k];
    }
    if (s.condition) out.condition = conditionText(s.condition);
    if (s.while) out.while = conditionText(s.while);
    if (s.until) out.until = conditionText(s.until);
    if (s.items) out.items = targetText(s.items);
    for (const k of ['optional', 'onError', 'attempts', 'timeoutMs', 'disabled']) if (s[k]) out[k] = s[k];
    if (s.target) {
      out.target = targetText(s.target);
      out.candidates = (s.target.candidates ?? []).slice(0, 3).map(candidateText);
      if (s.target.framePath?.length) out.frameDepth = s.target.framePath.length;
      if (s.target.within) out.within = s.target.within;
    }
    if (s.meta?.url) out.recordedUrl = s.meta.url;
    if (s.meta?.recordedValue !== undefined) out.recordedValue = s.meta.recordedValue;
    if (s.meta?.message) out.dialogMessage = s.meta.message;
    if (s.meta?.triggerStepId) out.triggerStepId = s.meta.triggerStepId;
    return out;
  }

  change(text) {
    this.changes.push(text.replace(/\s+/g, ' ').trim());
  }

  wrapperOf(a) {
    const w = { type: a.kind };
    if (a.kind === 'repeat') {
      const modes = ['times', 'while', 'until'].filter((k) => a[k] !== undefined && a[k] !== null);
      if (modes.length !== 1) throw new Error('repeat 에는 times·while·until 중 정확히 하나를 줍니다.');
      for (const k of ['times', 'while', 'until', 'maxIterations']) if (a[k] !== undefined && a[k] !== null) w[k] = structuredClone(a[k]);
    } else if (a.kind === 'forEach') {
      if (!a.itemsRef) throw new Error('forEach 에는 itemsRef(목록 항목 하나의 관찰 참조 번호)가 필요합니다. 먼저 observe_page·make_list_target 으로 확인하세요.');
      w.itemsRef = a.itemsRef;
      for (const k of ['maxItems', 'restore']) if (a[k] !== undefined && a[k] !== null) w[k] = a[k];
    } else if (a.kind === 'branch') {
      if (!a.condition) throw new Error('branch 에는 condition 이 필요합니다.');
      w.condition = structuredClone(a.condition);
    } else throw new Error(`묶을 수 있는 종류: repeat, forEach, branch (받은 값: ${a.kind})`);
    if (a.blockName) w[a.kind === 'branch' ? 'then' : 'body'] = String(a.blockName).trim();
    return w;
  }

  async call(name, args) {
    const a = args ?? {};
    switch (name) {
      case 'get_recipe': {
        const r = maskRecipe(this.recipe);
        const numbers = stepNumbers(r);
        return {
          name: r.name,
          startUrl: r.startUrl,
          entryBlock: r.entryBlock ?? 'main',
          onRowError: r.loop?.onRowError ?? 'skip',
          variables: r.variables ?? [],
          excelColumns: excelColumnsOf(r),
          blocks: Object.fromEntries(Object.entries(r.blocks).map(([b, steps]) => [b, (Array.isArray(steps) ? steps : []).map((s, i) => this.summaryOfStep(s, i, numbers))])),
        };
      }
      case 'get_step': {
        const { block, index } = this.find(a.stepId);
        return maskRecipe(this.recipe).blocks[block][index];
      }
      case 'update_step': {
        const { step } = this.find(a.stepId);
        const changes = await this.resolveTargetFields(structuredClone(a.changes ?? {}));
        delete changes.id;
        const before = structuredClone(step);
        for (const [k, v] of Object.entries(changes)) {
          if (v === null) delete step[k];
          else step[k] = v;
        }
        this.checkStep(step);
        this.change(`수정 ${this.no(step.id)} ${step.id}: ${changeText(before, step)}`);
        const f = this.find(step.id);
        return { ok: true, step: this.summaryOfStep(step, f.index, stepNumbers(this.recipe)) };
      }
      case 'insert_steps': {
        const after = a.afterStepId ? this.find(a.afterStepId) : null;
        const block = a.block || after?.block || this.recipe.entryBlock || 'main';
        if (after && after.block !== block) throw new Error(`스텝 ${a.afterStepId} 은(는) ${after.block} 블록에 있습니다. block 을 맞추세요.`);
        this.recipe.blocks[block] ??= [];
        const steps = this.recipe.blocks[block];
        let at = after ? after.index + 1 : 0;
        const ids = [];
        for (const raw of a.steps ?? []) {
          const step = await this.resolveTargetFields({ ...structuredClone(raw), id: this.newId() });
          this.checkStep(step);
          steps.splice(at, 0, step);
          at += 1;
          ids.push(step.id);
        }
        for (const id of ids) this.change(`추가 ${this.no(id)} ${id} (${block}): ${stepText(this.find(id).step)}`);
        return { ok: true, ids, numbers: ids.map((id) => this.no(id)) };
      }
      case 'delete_steps': {
        const found = (a.stepIds ?? []).map((ref) => this.find(ref));
        const label = new Map(found.map((f) => [f.step.id, `${this.no(f.step.id)} ${f.step.id}`]));
        for (const f of found) {
          const g = this.find(f.step.id);
          g.steps.splice(g.index, 1);
          this.change(`삭제 ${label.get(f.step.id)}: ${stepText(f.step)}`);
        }
        return { ok: true };
      }
      case 'move_step': {
        const f = this.find(a.stepId);
        const target = a.afterStepId ? this.find(a.afterStepId) : null;
        if (target?.step === f.step) throw new Error('같은 스텝 뒤로는 옮길 수 없습니다.');
        const block = a.block || target?.block || f.block;
        if (target && target.block !== block) throw new Error(`스텝 ${a.afterStepId} 은(는) ${target.block} 블록에 있습니다.`);
        f.steps.splice(f.index, 1);
        this.recipe.blocks[block] ??= [];
        const steps = this.recipe.blocks[block];
        const at = target ? steps.indexOf(target.step) + 1 : 0;
        steps.splice(at, 0, f.step);
        this.change(`이동 ${this.no(f.step.id)} ${f.step.id}: ${target ? `${this.no(target.step.id)} 뒤로` : `${block} 블록 맨 앞으로`}`);
        return { ok: true, no: this.no(f.step.id) };
      }
      case 'set_variables': {
        this.recipe.variables ??= [];
        for (const v of a.upsert ?? []) {
          if (!v?.id || !v.source?.kind) throw new Error('변수에는 id 와 source.kind 가 필요합니다.');
          const i = this.recipe.variables.findIndex((x) => x.id === v.id);
          const full = { id: v.id, name: v.name ?? v.id, source: v.source };
          if (i >= 0) this.recipe.variables[i] = full;
          else this.recipe.variables.push(full);
          this.change(`변수 ${i >= 0 ? '수정' : '추가'}: {{${v.id}}} (${v.source.kind}${v.source.column ? `: ${v.source.column}` : ''})`);
        }
        for (const id of a.remove ?? []) {
          this.recipe.variables = this.recipe.variables.filter((x) => x.id !== id);
          this.change(`변수 삭제: {{${id}}}`);
        }
        return { ok: true, variables: maskRecipe(this.recipe).variables };
      }
      case 'rename_variable': {
        const from = String(a.from ?? '').replace(/^\{\{|\}\}$/g, '').trim();
        const to = String(a.to ?? '').replace(/^\{\{|\}\}$/g, '').trim();
        if (!from || !to) throw new Error('from 과 to 가 필요합니다.');
        if (/[{}|]/.test(to)) throw new Error('변수 이름에 {, }, | 는 쓸 수 없습니다.');
        const count = renameVariable(this.recipe, from, to);
        this.change(`변수 이름 바꾸기: {{${from}}} → {{${to}}} (참조 ${count}곳)`);
        return { ok: true, references: count };
      }
      case 'set_recipe_fields': {
        if (a.name) this.recipe.name = a.name;
        if (a.startUrl) this.recipe.startUrl = a.startUrl;
        if (a.onRowError) this.recipe.loop = { ...(this.recipe.loop ?? {}), onRowError: a.onRowError };
        const said = [a.name ? `이름 → "${a.name}"` : '', a.startUrl ? `시작 주소 → ${a.startUrl}` : '', a.onRowError ? `행이 실패하면 → ${a.onRowError === 'stop' ? '실행 중단' : '기록하고 다음 행'}` : ''].filter(Boolean);
        this.change(`레시피 설정 변경: ${said.join(', ') || '(바뀐 것 없음)'}`);
        return { ok: true };
      }
      case 'wrap_steps': {
        const ids = (a.stepIds ?? []).map((ref) => this.find(ref).step.id);
        if (!ids.length) throw new Error('묶을 스텝을 stepIds 로 주세요.');
        const wrapper = await this.resolveTargetFields(this.wrapperOf(a));
        const r = wrapSteps(this.recipe, ids, wrapper);
        const step = this.find(r.stepId).step;
        this.change(`묶기 ${this.no(step.id)} ${step.id}: ${stepText(step)} — 스텝 ${ids.length}개를 [${r.block}] 블록으로`);
        return { ok: true, stepId: r.stepId, no: this.no(r.stepId), block: r.block };
      }
      case 'unwrap_step': {
        const { step } = this.find(a.stepId);
        const desc = stepText(step);
        unwrapStep(this.recipe, step.id);
        this.change(`풀기 ${step.id}: ${desc}`);
        return { ok: true };
      }
      case 'validate_recipe':
        return { problems: recipeProblems(this.recipe) };
      case 'observe_page': {
        const until = a.runUntilStepId ? this.find(a.runUntilStepId).step.id : null;
        return this.env.observe(until, a.sampleValues ?? {});
      }
      case 'describe_target': {
        const t = await this.env.targetFor(a.ref);
        return { target: targetText(t), candidates: t.candidates.map(candidateText), framePath: t.framePath };
      }
      case 'make_list_target': {
        if (!this.env.listTargetFor) throw new Error('목록 타겟을 만들 수 없습니다.');
        const r = await this.env.listTargetFor(a.ref);
        return { itemsRef: a.ref, count: r.count, sample: r.sample, target: targetText(r.target), candidates: (r.target?.candidates ?? []).slice(0, 3).map(candidateText) };
      }
      case 'get_last_run':
        return this.env.lastRun(a.runId);
      case 'get_failure_screenshot': {
        const shot = await this.env.failureShot(a.runId, a.row);
        this.attachments.push({ text: `${shot.runId} 실행 ${shot.row}행 실패 화면${shot.error ? ` — 오류: ${shot.error}` : ''}`, url: shot.dataUrl });
        return { ok: true, runId: shot.runId, row: shot.row, note: '실패 화면 이미지를 다음 메시지에 붙였습니다.' };
      }
      case 'run_sample': {
        const rows = Math.min(Math.max(Math.floor(Number(a.rows) || 1), 1), MAX_SAMPLE_ROWS);
        return this.env.runSample({ recipe: this.recipe, rows, sampleValues: a.sampleValues ?? {} });
      }
      case 'remember':
        return this.env.remember(a.note);
      case 'ask_choice': {
        const options = (Array.isArray(a.options) ? a.options : [])
          .map((o) => ({ label: String(o?.label ?? '').trim().slice(0, 60), message: String(o?.message ?? o?.label ?? '').trim().slice(0, 600) }))
          .filter((o) => o.label && o.message)
          .slice(0, 4);
        if (options.length < 2) throw new Error('선택지는 2개 이상이어야 합니다.');
        const question = String(a.question ?? '').trim() || '어느 쪽으로 할까요?';
        this.choice = { question, options };
        return { ok: true, note: '사용자에게 선택지를 보였습니다. 다음 사용자 메시지가 고른 답이다.' };
      }
      default:
        throw new Error(`알 수 없는 도구: ${name}`);
    }
  }
}
