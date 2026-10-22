// 편집기 값 칸: {{ 자동완성(변수·엑셀 열·값 읽기 이름·내장 토큰·반복 토큰)과 칸 만들기 도우미.
// 키보드로 고른다: ↑↓ 움직이기, Enter(또는 Tab) 넣기, Esc 닫기.

import { h } from '/ui.js';
import { stepTree, isReservedName } from '/shared/recipe-edit.js';

const pad2 = (n) => String(n).padStart(2, '0');
function builtins() {
  const d = new Date();
  const last = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return [
    { token: 'row', desc: '행 번호 (엑셀 몇 번째 행)', group: '내장' },
    { token: 'sys:date:YYYYMMDD', desc: `오늘 날짜 (예: ${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())})`, group: '내장' },
    { token: 'sys:month:-1', desc: `지난달 (월 숫자, 예: ${last.getMonth() + 1})`, group: '내장' },
    { token: 'sys:quarter', desc: `이번 분기 (예: ${Math.floor(d.getMonth() / 3) + 1}분기)`, group: '내장' },
  ];
}

const KIND_WORD = { excel: '엑셀 열', static: '고정값', prompt: '실행할 때 입력' };

/** 스텝을 감싼 반복 종류들 (가장 바깥부터) — 'repeat' | 'forEach' */
export function loopKindsAround(recipe, stepId) {
  if (!stepId) return [];
  const byId = new Map();
  for (const n of stepTree(recipe)) if (n.id && !byId.has(n.id)) byId.set(n.id, n);
  const kinds = [];
  let cur = byId.get(stepId);
  for (let guard = 0; cur?.parentId && guard < 50; guard += 1) {
    const parent = byId.get(cur.parentId);
    if (!parent) break;
    if (parent.step?.type === 'repeat' || parent.step?.type === 'forEach') kinds.unshift(parent.step.type);
    cur = parent;
  }
  return kinds;
}

/**
 * 이 스텝의 값 칸에서 쓸 수 있는 이름들 [{ token, desc, group }].
 * withSys=false 면 날짜 토큰을 뺀다(조건의 "값" 고르기용).
 */
export function tokenChoices(recipe, stepId, { withSys = true } = {}) {
  const out = [];
  const seen = new Set();
  const push = (token, desc, group) => {
    if (!token || seen.has(token)) return;
    seen.add(token);
    out.push({ token, desc, group });
  };
  for (const v of recipe?.variables ?? []) {
    const name = v?.name || v?.id;
    if (!name) continue;
    const src = v.source ?? {};
    const word = src.kind === 'prompt' && src.secret ? '비밀값 (실행할 때 입력)' : src.kind === 'excel' && src.column && src.column !== name ? `엑셀 열 "${src.column}"` : (KIND_WORD[src.kind] ?? '변수');
    push(name, word, '변수');
  }
  for (const s of Object.values(recipe?.blocks ?? {}).flat()) {
    if (s?.type === 'extract' && String(s.saveAs ?? '').trim()) push(String(s.saveAs).trim(), '값 읽기로 읽은 값', '값 읽기');
  }
  const loops = loopKindsAround(recipe, stepId);
  if (loops.includes('forEach')) {
    push('item.text', '지금 항목의 글자', '반복');
    push('item.index', '지금 항목 번호 (1부터)', '반복');
    push('item.cell:1', '표의 행이면 1번째 칸 글자 (숫자를 바꿔 쓰세요)', '반복');
  }
  if (loops.length) {
    push('loop.index', '지금 몇 번째 반복인지 (1부터)', '반복');
    if (loops.includes('repeat')) push('loop.count', '지금까지 반복한 횟수', '반복');
  }
  for (const b of builtins()) if (withSys || !b.token.startsWith('sys:')) push(b.token, b.desc, b.group);
  return out;
}

/** 조건의 "값" 으로 고를 수 있는 이름 (예약 이름은 row·item·loop 만) */
export function nameChoices(recipe, stepId) {
  return tokenChoices(recipe, stepId, { withSys: false }).filter((c) => !isReservedName(c.token) || /^(row|item\.|loop\.)/.test(c.token));
}

let autoSeq = 0;

/**
 * 입력 칸에 {{ 자동완성을 붙인다. 감싼 요소(.auto-wrap)를 돌려준다.
 * 고르면 칸 값을 바꾸고 input 이벤트를 보내 바깥 처리기가 값을 저장하게 한다.
 */
export function withAuto(input, ed, { stepId } = {}) {
  const listId = `auto-${(autoSeq += 1)}`;
  const wrap = h('div', { class: 'auto-wrap' }, input);
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('aria-autocomplete', 'list');
  let list = null;
  let items = [];
  let active = 0;
  let start = -1;
  const close = () => {
    list?.remove();
    list = null;
    items = [];
    input.removeAttribute('aria-expanded');
    input.removeAttribute('aria-activedescendant');
  };
  const pick = (item) => {
    const v = input.value;
    const caret = input.selectionStart ?? v.length;
    let after = v.slice(caret);
    if (after.startsWith('}}')) after = after.slice(2);
    const head = `${v.slice(0, start)}{{${item.token}}}`;
    input.value = head + after;
    input.setSelectionRange(head.length, head.length);
    close();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  };
  const render = () => {
    if (!items.length) return close();
    if (!list) {
      list = h('div', { class: 'auto-list', role: 'listbox', id: listId });
      wrap.append(list);
      input.setAttribute('aria-expanded', 'true');
      input.setAttribute('aria-controls', listId);
    }
    list.replaceChildren(
      ...items.map((it, i) =>
        h(
          'div',
          {
            class: `auto-item${i === active ? ' active' : ''}`,
            role: 'option',
            id: `${listId}-${i}`,
            'aria-selected': i === active ? 'true' : 'false',
            onmousedown: (e) => {
              e.preventDefault(); // 칸의 포커스를 지킨다
              pick(it);
            },
          },
          h('code', null, `{{${it.token}}}`),
          h('span', { class: 'muted small' }, it.desc),
        ),
      ),
    );
    input.setAttribute('aria-activedescendant', `${listId}-${active}`);
    list.children[active]?.scrollIntoView?.({ block: 'nearest' });
  };
  const update = () => {
    const v = input.value;
    const caret = input.selectionStart ?? v.length;
    const before = v.slice(0, caret);
    const i = before.lastIndexOf('{{');
    if (i < 0 || before.slice(i).includes('}}')) return close();
    const query = before.slice(i + 2);
    if (/[{}|]/.test(query) || query.length > 40) return close();
    start = i;
    const q = query.trim().toLowerCase();
    const all = tokenChoices(ed.recipe, stepId);
    const starts = all.filter((c) => c.token.toLowerCase().startsWith(q));
    const rest = all.filter((c) => !c.token.toLowerCase().startsWith(q) && (c.token.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q)));
    items = [...starts, ...rest].slice(0, 12);
    active = 0;
    render();
  };
  input.addEventListener('input', update);
  input.addEventListener('click', update);
  input.addEventListener('keydown', (e) => {
    if (!list || !items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      render();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pick(items[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => document.activeElement !== input && close(), 120));
  return wrap;
}

/**
 * 객체의 한 칸을 고치는 입력 칸. 바꾸면 ed.changed(stepId) 로 저장 표시와 스텝 한 줄 설명을 고친다(화면 전체를 다시 그리지 않는다).
 * auto 면 {{ 자동완성을 붙인 감싼 요소를 돌려준다.
 */
export function valueInput(ed, obj, key, { stepId, type = 'text', placeholder, num = false, auto = false, after, area = false, label } = {}) {
  const input = h(area ? 'textarea' : 'input', {
    ...(area ? { rows: 2, style: 'min-height:56px' } : { type }),
    value: obj[key] ?? '',
    placeholder,
    'aria-label': label,
    oninput: (e) => {
      const v = e.target.value;
      if (num) {
        if (v === '') delete obj[key];
        else obj[key] = Number(v);
      } else obj[key] = v;
      ed.changed(stepId);
      after?.(v);
    },
  });
  return auto ? withAuto(input, ed, { stepId }) : input;
}
