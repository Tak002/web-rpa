// AI 도우미가 쓰는 도구: 레시피 사본을 읽고 고치며, 화면을 관찰해 새 요소의 타겟을 만든다.

import { stepText, conditionText, STEP_LABELS, targetText } from '../../public/shared/steps.js';
import { recipeProblems, excelColumnsOf } from '../recipe.js';

const fn = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});
const STEP_OBJ = { type: 'object', description: '스텝 객체 (id 제외). 형식은 시스템 안내 참고. 화면 요소가 필요하면 target 대신 targetRef(관찰 참조 번호) 또는 targetFromStep(기존 스텝 id)을 쓴다.' };

export const TOOL_DEFS = [
  fn('get_recipe', '레시피 전체 개요: 변수, 블록별 스텝(id·종류·설명·주요 값·대상 요소 요약). 작업 전에 먼저 호출한다.', {}),
  fn('get_step', '스텝 하나의 전체 JSON (대상 요소의 후보 선택자 포함).', { stepId: { type: 'string' } }, ['stepId']),
  fn(
    'update_step',
    '스텝 필드를 바꾼다. changes 의 값이 null 이면 그 필드를 지운다. id 는 못 바꾼다.',
    { stepId: { type: 'string' }, changes: { type: 'object', description: '바꿀 필드. target 대신 targetRef / targetFromStep 사용 가능' } },
    ['stepId', 'changes'],
  ),
  fn(
    'insert_steps',
    '스텝들을 afterStepId 바로 뒤에 넣는다 (null 이면 블록 맨 앞). 블록이 없으면 새로 만든다. 새 id 목록을 돌려준다.',
    { afterStepId: { type: ['string', 'null'] }, block: { type: 'string', description: '기본 main' }, steps: { type: 'array', items: STEP_OBJ } },
    ['afterStepId', 'steps'],
  ),
  fn('delete_steps', '스텝들을 지운다.', { stepIds: { type: 'array', items: { type: 'string' } } }, ['stepIds']),
  fn('move_step', '스텝을 afterStepId 바로 뒤로 옮긴다 (null 이면 블록 맨 앞).', { stepId: { type: 'string' }, afterStepId: { type: ['string', 'null'] }, block: { type: 'string' } }, ['stepId', 'afterStepId']),
  fn(
    'set_variables',
    '변수를 추가·수정(upsert, id 기준)하거나 지운다.',
    {
      upsert: { type: 'array', items: { type: 'object', description: '{id, name, source:{kind:"excel",column} | {kind:"static",value} | {kind:"prompt",default?,secret?}}' } },
      remove: { type: 'array', items: { type: 'string' } },
    },
  ),
  fn('set_recipe_fields', '레시피 이름·시작 주소·행 실패 처리를 바꾼다.', { name: { type: 'string' }, startUrl: { type: 'string' }, onRowError: { type: 'string', enum: ['skip', 'stop'] } }),
  fn('validate_recipe', '레시피 검사. 고칠 점 목록을 돌려준다. 수정을 마치면 반드시 호출한다.', {}),
  fn(
    'observe_page',
    '숨긴 브라우저로 레시피를 처음부터 runUntilStepId 까지(포함) 실제로 실행한 뒤, 그 화면의 요소 목록(참조 번호 f<프레임>e<번호>)을 돌려준다. runUntilStepId 를 비우면 시작 주소만 연다. PDF·다운로드 같은 출력 스텝은 건너뛴다. 엑셀 변수는 sampleValues 또는 녹화 때 값으로 채운다.',
    {
      runUntilStepId: { type: ['string', 'null'] },
      sampleValues: { type: 'object', description: '{변수/열 이름: 값} — 엑셀 열 견본 값' },
    },
  ),
  fn('describe_target', '관찰 참조 번호로 만든 타겟(후보 선택자)을 미리 본다. 스텝에는 targetRef 로 바로 넣으면 된다.', { ref: { type: 'string' } }, ['ref']),
];

export class RecipeTools {
  /**
   * @param {object} recipe 작업 사본 (직접 고친다)
   * @param {{observe: (stepId, sample) => Promise<string>, targetFor: (ref) => Promise<object>, progress: (text) => void}} env
   */
  constructor(recipe, env) {
    this.recipe = recipe;
    this.env = env;
    this.changes = [];
  }

  blocks() {
    return this.recipe.blocks;
  }

  find(stepId) {
    for (const [block, steps] of Object.entries(this.recipe.blocks)) {
      const index = steps.findIndex((s) => s.id === stepId);
      if (index >= 0) return { block, steps, index, step: steps[index] };
    }
    throw new Error(`스텝 ${stepId} 이(가) 없습니다. get_recipe 로 id 를 확인하세요.`);
  }

  newId() {
    const used = new Set(Object.values(this.recipe.blocks).flat().map((s) => s.id));
    let n = used.size + 1;
    while (used.has(`s${n}`)) n += 1;
    return `s${n}`;
  }

  async resolveTargetFields(obj) {
    if (obj.targetRef) {
      obj.target = await this.env.targetFor(obj.targetRef);
      delete obj.targetRef;
    } else if (obj.targetFromStep) {
      obj.target = structuredClone(this.find(obj.targetFromStep).step.target);
      if (!obj.target) throw new Error(`스텝 ${obj.targetFromStep} 에는 대상 요소가 없습니다.`);
      delete obj.targetFromStep;
    }
    if (obj.condition) await this.resolveConditionTargets(obj.condition);
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
  }

  summaryOfStep(s, i) {
    const out = { id: s.id, n: i + 1, type: s.type, desc: stepText(s) };
    for (const k of ['value', 'label', 'url', 'key', 'ms', 'fileName', 'saveAs', 'attr', 'then', 'else', 'checked', 'action', 'message', 'path']) if (s[k] !== undefined && s[k] !== '') out[k] = s[k];
    if (s.condition) out.condition = conditionText(s.condition);
    for (const k of ['optional', 'onError', 'attempts', 'timeoutMs', 'disabled']) if (s[k]) out[k] = s[k];
    if (s.target) {
      out.target = targetText(s.target);
      out.candidates = s.target.candidates.slice(0, 3).map((c) => `${c.score} ${c.kind}:${typeof c.value === 'string' ? c.value : `<${c.value.tag}>"${c.value.text}"`}`);
      if (s.target.framePath?.length) out.frameDepth = s.target.framePath.length;
    }
    if (s.meta?.url) out.recordedUrl = s.meta.url;
    if (s.meta?.recordedValue !== undefined) out.recordedValue = s.meta.recordedValue;
    if (s.meta?.message) out.dialogMessage = s.meta.message;
    if (s.meta?.triggerStepId) out.triggerStepId = s.meta.triggerStepId;
    return out;
  }

  async call(name, args) {
    const a = args ?? {};
    switch (name) {
      case 'get_recipe': {
        const r = this.recipe;
        return {
          name: r.name,
          startUrl: r.startUrl,
          entryBlock: r.entryBlock ?? 'main',
          onRowError: r.loop?.onRowError ?? 'skip',
          variables: r.variables ?? [],
          excelColumns: excelColumnsOf(r),
          blocks: Object.fromEntries(Object.entries(r.blocks).map(([b, steps]) => [b, steps.map((s, i) => this.summaryOfStep(s, i))])),
        };
      }
      case 'get_step':
        return this.find(a.stepId).step;
      case 'update_step': {
        const { step } = this.find(a.stepId);
        const changes = await this.resolveTargetFields(structuredClone(a.changes ?? {}));
        delete changes.id;
        const before = stepText(step);
        for (const [k, v] of Object.entries(changes)) {
          if (v === null) delete step[k];
          else step[k] = v;
        }
        this.checkStep(step);
        this.changes.push(`수정 ${step.id}: ${before} → ${stepText(step)}`);
        return { ok: true, step: this.summaryOfStep(step, this.find(step.id).index) };
      }
      case 'insert_steps': {
        const block = a.block || this.recipe.entryBlock || 'main';
        this.recipe.blocks[block] ??= [];
        const steps = this.recipe.blocks[block];
        let at = 0;
        if (a.afterStepId) {
          const f = this.find(a.afterStepId);
          if (f.block !== block) throw new Error(`스텝 ${a.afterStepId} 은(는) ${f.block} 블록에 있습니다. block 을 맞추세요.`);
          at = f.index + 1;
        }
        const ids = [];
        for (const raw of a.steps ?? []) {
          const step = await this.resolveTargetFields({ ...structuredClone(raw), id: this.newId() });
          this.checkStep(step);
          steps.splice(at, 0, step);
          at += 1;
          ids.push(step.id);
          this.changes.push(`추가 ${step.id} (${block}): ${stepText(step)}`);
        }
        return { ok: true, ids };
      }
      case 'delete_steps': {
        for (const id of a.stepIds ?? []) {
          const f = this.find(id);
          f.steps.splice(f.index, 1);
          this.changes.push(`삭제 ${id}: ${stepText(f.step)}`);
        }
        return { ok: true };
      }
      case 'move_step': {
        const f = this.find(a.stepId);
        f.steps.splice(f.index, 1);
        const block = a.block || f.block;
        this.recipe.blocks[block] ??= [];
        const steps = this.recipe.blocks[block];
        let at = 0;
        if (a.afterStepId) {
          const g = this.find(a.afterStepId);
          if (g.block !== block) throw new Error(`스텝 ${a.afterStepId} 은(는) ${g.block} 블록에 있습니다.`);
          at = g.index + 1;
        }
        steps.splice(at, 0, f.step);
        this.changes.push(`이동 ${a.stepId}: ${a.afterStepId ? `${a.afterStepId} 뒤로` : `${block} 맨 앞으로`}`);
        return { ok: true };
      }
      case 'set_variables': {
        this.recipe.variables ??= [];
        for (const v of a.upsert ?? []) {
          if (!v?.id || !v.source?.kind) throw new Error('변수에는 id 와 source.kind 가 필요합니다.');
          const i = this.recipe.variables.findIndex((x) => x.id === v.id);
          const full = { id: v.id, name: v.name ?? v.id, source: v.source };
          if (i >= 0) this.recipe.variables[i] = full;
          else this.recipe.variables.push(full);
          this.changes.push(`변수 ${i >= 0 ? '수정' : '추가'}: {{${v.id}}} (${v.source.kind}${v.source.column ? `: ${v.source.column}` : ''})`);
        }
        for (const id of a.remove ?? []) {
          this.recipe.variables = this.recipe.variables.filter((x) => x.id !== id);
          this.changes.push(`변수 삭제: {{${id}}}`);
        }
        return { ok: true, variables: this.recipe.variables };
      }
      case 'set_recipe_fields': {
        if (a.name) this.recipe.name = a.name;
        if (a.startUrl) this.recipe.startUrl = a.startUrl;
        if (a.onRowError) this.recipe.loop = { ...(this.recipe.loop ?? {}), onRowError: a.onRowError };
        this.changes.push(`레시피 설정 변경: ${JSON.stringify(a)}`);
        return { ok: true };
      }
      case 'validate_recipe':
        return { problems: recipeProblems(this.recipe) };
      case 'observe_page':
        return this.env.observe(a.runUntilStepId ?? null, a.sampleValues ?? {});
      case 'describe_target': {
        const t = await this.env.targetFor(a.ref);
        return { target: targetText(t), candidates: t.candidates.map((c) => `${c.score} ${c.kind}:${typeof c.value === 'string' ? c.value : `<${c.value.tag}>"${c.value.text}"`}`), framePath: t.framePath };
      }
      default:
        throw new Error(`알 수 없는 도구: ${name}`);
    }
  }
}
