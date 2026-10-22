// 문장형 조건 편집기: "만약 [무엇이] [어떠하면] [값]" 으로 고르고, 그리고/또는 묶음을 더하고 뺀다.
// wait·assert·branch·repeat(while/until) 이 함께 쓴다. 아래에 conditionText 미리보기 문장을 보인다.

import { h, mount } from '/ui.js';
import { conditionText, targetText, STEP_LABELS } from '/shared/steps.js';
import { stepTree } from '/shared/recipe-edit.js';
import { withAuto, nameChoices } from '/editor-input.js';

const GROUP = new Set(['all', 'any']);
const not = (c) => ({ kind: 'not', condition: c });
const blank = () => ({ kind: 'textVisible', text: '' });

/** 이 레시피의 스텝들이 가진 대상 요소 [{ key, target, label }] (같은 요소는 한 번) */
export function elementChoices(recipe) {
  const out = [];
  const seen = new Set();
  const add = (t, no, what) => {
    if (!t || !Array.isArray(t.candidates) || !t.candidates.length) return;
    const sig = JSON.stringify([t.candidates, t.framePath ?? [], t.within ?? '']);
    if (seen.has(sig)) return;
    seen.add(sig);
    out.push({ key: `e${out.length}`, sig, target: t, label: `${no} ${targetText(t)}${what ? ` (${what})` : ''}` });
  };
  const walkCond = (c, no) => {
    if (!c || typeof c !== 'object') return;
    if (c.target) add(c.target, no, '조건');
    if (c.condition) walkCond(c.condition, no);
    for (const x of c.conditions ?? []) walkCond(x, no);
  };
  for (const n of stepTree(recipe)) {
    const s = n.step;
    if (!s || typeof s !== 'object') continue;
    add(s.target, n.no, STEP_LABELS[s.type]);
    if (s.type === 'forEach') add(s.items, n.no, '목록');
    for (const k of ['condition', 'while', 'until']) walkCond(s[k], n.no);
  }
  return out;
}
const sigOf = (t) => JSON.stringify([t?.candidates ?? [], t?.framePath ?? [], t?.within ?? '']);

// ---------- 조건 ↔ (무엇이, 어떠하면) ----------
const PREDS = {
  page: [
    ['seen', '글자가 보이면'],
    ['unseen', '글자가 보이지 않으면'],
  ],
  url: [
    ['has', '글자가 들어 있으면'],
    ['hasNot', '글자가 없으면'],
  ],
  dialog: [['has', '글자가 들어 있으면']],
  el: [
    ['exists', '이(가) 있으면'],
    ['missing', '이(가) 없으면'],
    ['visible', '이(가) 보이면'],
    ['textHas', '의 글자에 다음이 들어 있으면'],
    ['textEq', '의 글자가 다음과 같으면'],
    ['textRe', '의 글자가 정규식에 맞으면'],
    ['count', '의 개수가'],
  ],
  var: [
    ['eq', '이(가) 다음과 같으면'],
    ['has', '에 다음이 들어 있으면'],
    ['hasNot', '에 다음이 없으면'],
    ['cmp:>=', '이(가) 다음 이상이면 (≥)'],
    ['cmp:<=', '이(가) 다음 이하이면 (≤)'],
    ['cmp:>', '이(가) 다음보다 크면 (>)'],
    ['cmp:<', '이(가) 다음보다 작으면 (<)'],
    ['cmp:=', '이(가) 다음과 같으면 (숫자·날짜, =)'],
    ['cmp:!=', '이(가) 다음과 다르면 (≠)'],
    ['empty', '이(가) 비어 있으면'],
    ['filled', '이(가) 비어 있지 않으면'],
    ['re', '이(가) 정규식에 맞으면'],
  ],
};
const COUNT_OPS = [
  ['>=', '개 이상이면 (≥)'],
  ['<=', '개 이하이면 (≤)'],
  ['=', '개이면 (=)'],
  ['!=', '개가 아니면 (≠)'],
  ['>', '개보다 많으면 (>)'],
  ['<', '개보다 적으면 (<)'],
];

/** 조건 → { subject, pred, base(실제 값이 든 객체), extraNeg(문장으로 못 쓰는 "반대로") } | null(모르는 종류) */
function parse(c) {
  let neg = false;
  let b = c;
  if (c?.kind === 'not' && c.condition && !GROUP.has(c.condition.kind) && c.condition.kind !== 'not') {
    neg = true;
    b = c.condition;
  }
  const r = (subject, pred, extraNeg = false) => ({ subject, pred, base: b, extraNeg });
  switch (b?.kind) {
    case 'textVisible':
      return r('page', neg ? 'unseen' : 'seen');
    case 'urlContains':
      return r('url', neg ? 'hasNot' : 'has');
    case 'dialogContains':
      return r('dialog', 'has', neg);
    case 'exists':
      if (b.visible) return r('el', 'visible', neg);
      return r('el', neg ? 'missing' : 'exists');
    case 'elementText':
      return r('el', b.op === 'equals' ? 'textEq' : b.op === 'matches' ? 'textRe' : 'textHas', neg);
    case 'elementCount':
      return r('el', 'count', neg);
    case 'varEquals':
      return r('var', 'eq', neg);
    case 'varContains':
      return r('var', neg ? 'hasNot' : 'has');
    case 'varCompare':
      return r('var', `cmp:${b.op || '='}`, neg);
    case 'varEmpty':
      return r('var', neg ? 'filled' : 'empty');
    case 'matches':
      return r('var', 're', neg);
    default:
      return null;
  }
}

const valueOfBase = (b) => String(b?.text ?? b?.value ?? b?.pattern ?? '');
const cleanVar = (v) => String(v ?? '').replace(/^\{\{|\}\}$/g, '').trim();

/** (무엇이, 어떠하면) → 새 조건. prev 의 글자 값·요소·이름을 이어 받는다 */
function build(subject, pred, { target, varName, prev }) {
  const val = valueOfBase(prev);
  const flags = prev?.flags;
  switch (subject) {
    case 'page':
      return pred === 'unseen' ? not({ kind: 'textVisible', text: val }) : { kind: 'textVisible', text: val };
    case 'url':
      return pred === 'hasNot' ? not({ kind: 'urlContains', value: val }) : { kind: 'urlContains', value: val };
    case 'dialog':
      return { kind: 'dialogContains', value: val };
    case 'el': {
      const t = target ? structuredClone(target) : undefined;
      if (pred === 'missing') return not({ kind: 'exists', target: t });
      if (pred === 'visible') return { kind: 'exists', target: t, visible: true };
      if (pred === 'textHas') return { kind: 'elementText', target: t, op: 'contains', value: val };
      if (pred === 'textEq') return { kind: 'elementText', target: t, op: 'equals', value: val };
      if (pred === 'textRe') return { kind: 'elementText', target: t, op: 'matches', value: val, ...(flags ? { flags } : {}) };
      if (pred === 'count') return { kind: 'elementCount', target: t, op: prev?.kind === 'elementCount' ? prev.op || '>=' : '>=', value: Number(val) >= 0 && val !== '' ? Number(val) : 1 };
      return { kind: 'exists', target: t };
    }
    default: {
      const v = varName ?? '';
      if (pred === 'eq') return { kind: 'varEquals', var: v, value: val };
      if (pred === 'has') return { kind: 'varContains', var: v, value: val };
      if (pred === 'hasNot') return not({ kind: 'varContains', var: v, value: val });
      if (pred === 'empty') return { kind: 'varEmpty', var: v };
      if (pred === 'filled') return not({ kind: 'varEmpty', var: v });
      if (pred === 're') return { kind: 'matches', var: v, pattern: val, ...(flags ? { flags } : {}) };
      return { kind: 'varCompare', var: v, op: pred.slice(4) || '=', value: val };
    }
  }
}

/**
 * 조건 편집기. get() 은 지금 조건, set(c) 는 조건을 바꾼다(스텝의 칸에 넣는다).
 * @param ed 편집기 상태 (recipe, markDirty)
 * @param {{ get: () => object, set: (c: object) => void, stepId?: string, onChange?: () => void, title?: string }} o
 */
export function conditionEditor(ed, { get, set, stepId, onChange, title = '조건' }) {
  const box = h('div', { class: 'cond', role: 'group', 'aria-label': title });
  const preview = h('div', { class: 'cond-preview' });
  const showPreview = () => {
    preview.replaceChildren(h('span', { class: 'muted' }, '미리보기: '), h('b', null, conditionText(get())));
  };
  const touched = () => {
    ed.markDirty();
    showPreview();
    onChange?.();
  };
  const changed = () => {
    ed.markDirty();
    render();
    onChange?.();
  };

  function render() {
    if (!get() || typeof get() !== 'object') set(blank());
    const elements = elementChoices(ed.recipe);
    const names = nameChoices(ed.recipe, stepId);
    mount(box, h('div', { class: 'cond-title' }, title), node(get(), set, { lead: '만약', top: true, elements, names }), preview);
    showPreview();
  }

  /** 조건 하나(묶음이면 묶음 상자) */
  function node(c, put, o) {
    if (GROUP.has(c?.kind)) return group(c, put, o);
    if (c?.kind === 'not' && (GROUP.has(c.condition?.kind) || c.condition?.kind === 'not')) {
      return h(
        'div',
        { class: 'cond-group' },
        h('div', { class: 'cond-row' }, h('span', { class: 'cond-lead' }, o.lead), h('span', null, '다음이 아니면 (반대로)'), h('button', { type: 'button', class: 'sm ghost', onclick: () => (put(c.condition), changed()) }, '반대 풀기')),
        node(c.condition, (x) => (c.condition = x), { ...o, lead: '·', top: false }),
      );
    }
    return row(c, put, o);
  }

  function group(c, put, o) {
    c.conditions ??= [];
    const isAll = c.kind === 'all';
    const kindSel = h(
      'select',
      { class: 'cond-join', 'aria-label': '묶음 방법', onchange: (e) => ((c.kind = e.target.value), changed()) },
      h('option', { value: 'all', selected: isAll }, '다음이 모두 맞으면 (그리고)'),
      h('option', { value: 'any', selected: !isAll }, '다음 중 하나라도 맞으면 (또는)'),
    );
    const remove = (i) => {
      c.conditions.splice(i, 1);
      if (c.conditions.length === 1) put(c.conditions[0]);
      else if (!c.conditions.length) put(blank());
      changed();
    };
    return h(
      'div',
      { class: 'cond-group' },
      h('div', { class: 'cond-row' }, h('span', { class: 'cond-lead' }, o.lead), kindSel, o.onRemove ? h('button', { type: 'button', class: 'sm ghost', title: '이 묶음 빼기', onclick: o.onRemove }, '✕ 빼기') : null),
      h(
        'div',
        { class: 'cond-items' },
        c.conditions.map((sub, i) =>
          node(sub, (x) => (c.conditions[i] = x), { ...o, top: false, lead: i === 0 ? '·' : isAll ? '그리고' : '또는', onRemove: () => remove(i) }),
        ),
      ),
      h(
        'div',
        { class: 'row cond-add' },
        h('button', { type: 'button', class: 'sm', onclick: () => (c.conditions.push(blank()), changed()) }, '＋ 조건 더하기'),
        h('button', { type: 'button', class: 'sm', onclick: () => (c.conditions.push({ kind: isAll ? 'any' : 'all', conditions: [blank(), blank()] }), changed()) }, isAll ? '＋ 또는 묶음 더하기' : '＋ 그리고 묶음 더하기'),
      ),
    );
  }

  function row(c, put, o) {
    const p = parse(c);
    if (!p) {
      return h(
        'div',
        { class: 'cond-row' },
        h('span', { class: 'cond-lead' }, o.lead),
        h('span', { class: 'muted' }, `이 화면에서 고칠 수 없는 조건입니다 (${c?.kind ?? '없음'}) — JSON 탭에서 고치거나 새로 고르세요.`),
        h('button', { type: 'button', class: 'sm', onclick: () => (put(blank()), changed()) }, '새 조건으로 바꾸기'),
      );
    }
    const { subject, pred, base, extraNeg } = p;
    const { elements, names } = o;
    // 무엇이
    const curEl = subject === 'el' ? elements.find((x) => x.sig === sigOf(base.target)) : null;
    const curVar = subject === 'var' ? cleanVar(base.var) : '';
    const varKnown = names.some((n) => n.token === curVar);
    const subjValue = subject === 'el' ? (curEl ? `el:${curEl.key}` : 'el:cur') : subject === 'var' ? (curVar ? `var:${curVar}` : 'var:*') : subject;
    const subjSel = h(
      'select',
      {
        class: 'cond-subject',
        'aria-label': '무엇이',
        onchange: (e) => {
          const v = e.target.value;
          const [sub, ...rest] = v.split(':');
          const key = rest.join(':');
          let next;
          if (sub === 'el') {
            const t = key === 'cur' ? base.target : elements.find((x) => x.key === key)?.target;
            if (subject === 'el') {
              base.target = structuredClone(t);
              return changed();
            }
            next = build('el', 'exists', { target: t, prev: base });
          } else if (sub === 'var') {
            const name = key === '*' ? '' : key;
            if (subject === 'var') {
              base.var = name;
              return changed();
            }
            next = build('var', 'eq', { varName: name, prev: base });
          } else next = build(sub, PREDS[sub][0][0], { prev: base });
          put(next);
          changed();
        },
      },
      h(
        'optgroup',
        { label: '화면' },
        h('option', { value: 'page', selected: subjValue === 'page' }, '화면에'),
        h('option', { value: 'url', selected: subjValue === 'url' }, '주소에'),
        h('option', { value: 'dialog', selected: subjValue === 'dialog' }, '알림창 문구에'),
      ),
      h(
        'optgroup',
        { label: '요소 (이 레시피의 스텝에서)' },
        subject === 'el' && !curEl ? h('option', { value: 'el:cur', selected: true }, base.target ? `지금 요소: ${targetText(base.target)}` : '(요소를 고르세요)') : null,
        elements.length ? elements.map((x) => h('option', { value: `el:${x.key}`, selected: subjValue === `el:${x.key}` }, x.label)) : h('option', { value: 'el:none', disabled: true }, '(요소가 있는 스텝이 없습니다)'),
      ),
      h(
        'optgroup',
        { label: '값 (변수·값 읽기·반복)' },
        names.map((n) => h('option', { value: `var:${n.token}`, selected: subjValue === `var:${n.token}` }, `{{${n.token}}} — ${n.desc}`)),
        subject === 'var' && curVar && !varKnown ? h('option', { value: `var:${curVar}`, selected: true }, `{{${curVar}}}`) : null,
        h('option', { value: 'var:*', selected: subjValue === 'var:*' }, '다른 이름 직접 쓰기…'),
      ),
    );
    // 어떠하면
    const predSel = h(
      'select',
      {
        class: 'cond-pred',
        'aria-label': '어떠하면',
        onchange: (e) => {
          put(build(subject, e.target.value, { target: base.target, varName: base.var, prev: base }));
          changed();
        },
      },
      PREDS[subject].map(([k, label]) => h('option', { value: k, selected: k === pred }, label)),
    );
    const text = (key, placeholder, aria) => {
      const input = h('input', { type: 'text', class: 'cond-value', value: base[key] ?? '', placeholder, 'aria-label': aria, oninput: (e) => ((base[key] = e.target.value), touched()) });
      return withAuto(input, ed, { stepId });
    };
    const parts = [];
    if (subject === 'var' && !curVar) {
      parts.push(h('input', { type: 'text', class: 'cond-var', value: base.var ?? '', placeholder: '값 이름 (예: 금액)', 'aria-label': '값 이름', oninput: (e) => ((base.var = cleanVar(e.target.value)), touched()) }));
    }
    if (subject === 'page') {
      parts.push(text('text', '보일 글자', '글자'));
      parts.push(h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: !!base.exact, onchange: (e) => (e.target.checked ? (base.exact = true) : delete base.exact, touched()) }), '정확히 일치'));
    } else if (subject === 'url' || subject === 'dialog') parts.push(text('value', '들어 있을 글자', '글자'));
    else if (subject === 'el') {
      if (pred === 'textHas' || pred === 'textEq') parts.push(text('value', '글자', '글자'));
      if (pred === 'textRe') parts.push(text('value', '정규식 (예: ^정상)', '정규식'), flagsBox(base));
      if (pred === 'count') {
        parts.push(
          h('input', { type: 'number', class: 'cond-num', min: 0, value: base.value ?? 1, 'aria-label': '개수', oninput: (e) => ((base.value = e.target.value === '' ? 1 : Number(e.target.value)), touched()) }),
          h(
            'select',
            { 'aria-label': '개수 비교', onchange: (e) => ((base.op = e.target.value), touched()) },
            COUNT_OPS.map(([op, label]) => h('option', { value: op, selected: (base.op || '>=') === op }, label)),
          ),
        );
      }
    } else if (subject === 'var') {
      if (pred === 're') parts.push(text('pattern', '정규식 (예: ^정상)', '정규식'), flagsBox(base));
      else if (!['empty', 'filled'].includes(pred)) parts.push(text('value', '값', '비교할 값'));
    }
    const negBox = extraNeg
      ? h('label', { class: 'check small', title: '조건이 맞지 않을 때 참' }, h('input', { type: 'checkbox', checked: true, onchange: () => (put(structuredClone(base)), changed()) }), '반대로 (아닐 때)')
      : null;
    const combine = o.top
      ? [
          h('button', { type: 'button', class: 'sm', onclick: () => (put({ kind: 'all', conditions: [c, blank()] }), changed()) }, '＋ 그리고'),
          h('button', { type: 'button', class: 'sm', onclick: () => (put({ kind: 'any', conditions: [c, blank()] }), changed()) }, '＋ 또는'),
        ]
      : [];
    return h(
      'div',
      { class: 'cond-row' },
      h('span', { class: 'cond-lead' }, o.lead),
      subjSel,
      predSel,
      parts,
      negBox,
      o.onRemove ? h('button', { type: 'button', class: 'sm ghost', title: '이 조건 빼기', 'aria-label': '이 조건 빼기', onclick: o.onRemove }, '✕') : null,
      combine.length ? h('span', { class: 'cond-combine' }, combine) : null,
    );
  }

  function flagsBox(base) {
    return h(
      'label',
      { class: 'check small' },
      h('input', {
        type: 'checkbox',
        checked: String(base.flags ?? '').includes('i'),
        onchange: (e) => {
          const f = String(base.flags ?? '').replace(/i/g, '');
          const next = e.target.checked ? `${f}i` : f;
          if (next) base.flags = next;
          else delete base.flags;
          touched();
        },
      }),
      '대소문자 무시',
    );
  }

  render();
  return box;
}

/** 처음 쓸 조건: 요소가 있으면 그 요소가 있는지, 없으면 글자가 보이는지 */
export function defaultCondition(recipe) {
  const el = elementChoices(recipe).find((x) => !x.target.within);
  return el ? { kind: 'exists', target: structuredClone(el.target) } : blank();
}
