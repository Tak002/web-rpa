// 편집기 스텝 탭: stepTree 로 그린 트리(전역 번호 #4.2, 반복·분기 몸통 들여쓰기, 쓰이지 않는 블록),
// 검색·필터, 체크로 여러 개 고르기 → 일괄 작업(삭제·끄기·켜기·묶기·조건부·AI 에게), 스텝 편집, 스텝 추가.

import { h, add, mount, field, toast } from '/ui.js';
import { stepText, STEP_LABELS, targetText, targetName, withJosa } from '/shared/steps.js';
import { stepTree, stepNumbers, findStep, variableUsages, wrapSteps, unwrapStep, childBlocks, isReservedName, listFromTarget, relativeToList, looksSingle, sameElementSteps, pagingOf, pagingRisk, makePaging, unmakePaging } from '/shared/recipe-edit.js';
import { aiAskButton, askAi, setAiContext } from '/ai-panel.js';
import { conditionEditor, defaultCondition, elementChoices } from '/editor-cond.js';
import { valueInput } from '/editor-input.js';

// ---------- 스텝 추가 목록 ----------
const ADDABLE = [
  { key: 'navigate', label: '주소 이동', make: () => ({ type: 'navigate', url: 'https://' }) },
  { key: 'sleep', label: '잠시 대기', make: () => ({ type: 'sleep', ms: 2000 }) },
  { key: 'waitText', label: '글자가 보일 때까지 대기', make: () => ({ type: 'wait', condition: { kind: 'textVisible', text: '' }, timeoutMs: 15000 }) },
  { key: 'waitUrl', label: '주소가 바뀔 때까지 대기', make: () => ({ type: 'wait', condition: { kind: 'urlContains', value: '' }, timeoutMs: 15000 }) },
  { key: 'pdf', label: 'PDF 저장', make: (r) => ({ type: 'pdf', fileName: `${r.name}_{{row}}.pdf` }) },
  { key: 'screenshot', label: '화면 캡처', make: () => ({ type: 'screenshot', fileName: '화면_{{row}}.png', fullPage: true }) },
  { key: 'pause', label: '사용자 확인 대기', make: () => ({ type: 'pause', message: '브라우저에서 확인 후 [계속]을 눌러 주세요.' }) },
  { key: 'keypress', label: '키 입력', make: () => ({ type: 'keypress', key: 'Enter' }) },
  { key: 'closeTab', label: '팝업 창 닫기', make: () => ({ type: 'closeTab' }) },
  { key: 'assertText', label: '글자 확인(없으면 실패)', make: () => ({ type: 'assert', condition: { kind: 'textVisible', text: '' }, message: '' }) },
  { key: 'repeat', label: '반복 (N번 · 조건이 맞는 동안)', flow: true, make: () => ({ type: 'repeat', times: 2 }), block: ['body', '반복'] },
  { key: 'forEach', label: '목록의 항목마다', flow: true, make: () => ({ type: 'forEach', maxItems: 100 }), block: ['body', '항목마다'] },
  { key: 'branch', label: '조건 분기 (만약 …이면)', flow: true, make: (r) => ({ type: 'branch', condition: defaultCondition(r) }), block: ['then', '조건'] },
];

// ---------- 작은 도우미 ----------
const entryOf = (r) => r.entryBlock || 'main';
const allStepsOf = (r) => Object.values(r.blocks ?? {}).flatMap((x) => (Array.isArray(x) ? x : []));
const CONTAINERS = new Set(['repeat', 'forEach', 'branch']);

/** 새 스텝 id 를 차례로 만든다 (s12 처럼, 겹치지 않게) */
export function idMaker(r) {
  const used = new Set(allStepsOf(r).map((s) => s?.id));
  let n = used.size + 1;
  return () => {
    while (used.has(`s${n}`)) n += 1;
    used.add(`s${n}`);
    return `s${n}`;
  };
}
/** 새 블록 이름 (겹치면 뒤에 번호) */
function blockName(r, base) {
  if (!Object.hasOwn(r.blocks, base)) return base;
  let n = 2;
  while (Object.hasOwn(r.blocks, `${base}${n}`)) n += 1;
  return `${base}${n}`;
}
/** 값 안에 "항목 안에서 찾기" 대상이 있는지 (녹화 정보 meta 는 보지 않는다) */
function usesWithin(v) {
  if (Array.isArray(v)) return v.some(usesWithin);
  if (!v || typeof v !== 'object') return false;
  if (v.within === 'item') return true;
  return Object.entries(v).some(([k, x]) => k !== 'meta' && k !== 'items' && usesWithin(x));
}
const filtering = (ed) => !!(ed.query.trim() || ed.kind || ed.state);

/** 서버 검사 문장 → 스텝 id 별 고칠 점 */
function problemMap(ed) {
  const map = new Map();
  const uses = variableUsages(ed.recipe);
  const push = (id, p) => {
    if (!map.has(id)) map.set(id, []);
    if (!map.get(id).includes(p)) map.get(id).push(p);
  };
  for (const p of ed.problems ?? []) {
    for (const m of String(p).matchAll(/스텝\(([^)\s]+)\)/g)) push(m[1], p);
    const dup = /스텝 id "([^"]+)" 이\(가\) 겹칩니다/.exec(p);
    if (dup) push(dup[1], p);
    const u = /정의되지 않은 변수 \{\{(.+?)\}\}/.exec(p);
    if (u) for (const use of uses[u[1]] ?? []) if (use.stepId) push(use.stepId, p);
  }
  return map;
}
/** 스텝 id → 그 스텝이 쓰는 변수 이름(예약 이름 제외) */
function varUsers(ed) {
  const map = new Map();
  for (const [name, list] of Object.entries(variableUsages(ed.recipe))) {
    if (isReservedName(name)) continue;
    for (const u of list) {
      if (!u.stepId) continue;
      if (!map.has(u.stepId)) map.set(u.stepId, new Set());
      map.get(u.stepId).add(name);
    }
  }
  return map;
}

/** 검사 문장의 "main 블록 3번 스텝(s3)" 을 "#3 스텝" 으로 (번호는 눌러서 그 스텝으로) */
function problemLine(ed, p, nums) {
  const out = [];
  let last = 0;
  for (const m of String(p).matchAll(/(\S+) 블록 (\d+)번 스텝\(([^)\s]+)\)/g)) {
    out.push(p.slice(last, m.index));
    const no = nums.get(m[3]);
    out.push(h('button', { class: 'link', title: '이 스텝으로 가기', onclick: () => ed.goToStep(m[3]) }, no && no !== '#-' ? no : `${m[1]} 블록 ${m[2]}번`), ' 스텝');
    last = m.index + m[0].length;
  }
  out.push(String(p).slice(last));
  return out;
}

/** 편집기 머리의 "실행 전에 고칠 점" */
export function problemsNotice(ed) {
  if (!ed.problems?.length) return null;
  const nums = stepNumbers(ed.recipe);
  return h('div', { class: 'notice warn' }, h('b', null, '실행 전에 고칠 점'), h('ul', null, ed.problems.map((p) => h('li', null, problemLine(ed, p, nums)))));
}

// =====================================================================
// 스텝 탭
// =====================================================================
export function stepsTab(ed) {
  const r = ed.recipe;
  ed.onStepChange = null; // 펼친 스텝(반복)이 다시 그릴 때 정한다
  r.blocks[entryOf(r)] ??= [];
  const tree = stepTree(r);
  const ids = new Set(tree.map((n) => n.id));
  for (const id of [...ed.selected]) if (!ids.has(id)) ed.selected.delete(id);
  const ctx = { tree, nums: stepNumbers(r), problems: problemMap(ed), users: varUsers(ed), same: new Map(sameElementSteps(r).map((x) => [x.stepId, x])), byId: new Map(tree.filter((n) => n.id).map((n) => [n.id, n])) };
  const listBox = h('div', { class: 'step-list' });
  const bulkBox = h('div', { class: 'bulk-slot' });
  const renderList = () => {
    ed.heads = new Map();
    mount(listBox, filtering(ed) ? foundList(ed, ctx, renderList) : treeList(ed, ctx));
  };
  const renderBulk = () => mount(bulkBox, bulkBar(ed, ctx));
  ed.onSelect = () => {
    renderBulk();
    syncSelection(ed, ctx);
  };
  renderList();
  renderBulk();
  syncSelection(ed, ctx);
  return h('div', null, toolbar(ed, ctx, renderList), listBox, bulkBox, addBar(ed));
}

function ordered(ed, ctx) {
  return ctx.tree.map((n) => n.id).filter((id, i, a) => id && ed.selected.has(id) && a.indexOf(id) === i);
}
function syncSelection(ed, ctx) {
  const list = ordered(ed, ctx);
  setAiContext({ selectedStepIds: list.length ? list : undefined });
}

function toolbar(ed, ctx, renderList) {
  const order = Object.keys(STEP_LABELS);
  const types = [...new Set(ctx.tree.map((n) => n.step?.type).filter(Boolean))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const search = h('input', {
    type: 'search',
    class: 'step-search',
    placeholder: '찾기: 글자 또는 번호(#3)',
    'aria-label': '스텝 찾기',
    value: ed.query,
    oninput: (e) => {
      ed.query = e.target.value;
      renderList();
    },
  });
  const kindSel = h(
    'select',
    { 'aria-label': '종류로 거르기', onchange: (e) => ((ed.kind = e.target.value), renderList()) },
    h('option', { value: '' }, '모든 종류'),
    types.map((t) => h('option', { value: t, selected: ed.kind === t }, STEP_LABELS[t] ?? t)),
  );
  const stateSel = h(
    'select',
    { 'aria-label': '상태로 거르기', onchange: (e) => ((ed.state = e.target.value), renderList()) },
    [
      ['', '모든 스텝'],
      ['problem', '고칠 점 있음'],
      ['vars', '변수를 쓰는 스텝'],
      ['off', '꺼 둔 스텝'],
    ].map(([k, label]) => h('option', { value: k, selected: ed.state === k }, label)),
  );
  return h('div', { class: 'step-tools' }, search, kindSel, stateSel, h('button', { class: 'sm', title: '녹화한 입력을 한 표에서 엑셀 열·비밀 등으로 한 번에 바꿉니다', onclick: () => ed.openInputs() }, '입력값 정리'));
}

function matcher(ed, ctx) {
  const q = ed.query.trim();
  const low = q.toLowerCase();
  const num = /^(#)?(\d+(?:\.\d+)*)\.?$/.exec(q);
  return (n) => {
    const s = n.step ?? {};
    if (ed.kind && s.type !== ed.kind) return false;
    if (ed.state === 'problem' && !ctx.problems.has(n.id)) return false;
    if (ed.state === 'vars' && !ctx.users.has(n.id)) return false;
    if (ed.state === 'off' && !s.disabled) return false;
    if (!q) return true;
    if (num && (n.no === `#${num[2]}` || n.no.startsWith(`#${num[2]}.`))) return true;
    if (num?.[1]) return false; // "#3" 은 번호로만 찾는다
    const hay = [n.no, STEP_LABELS[s.type], stepText(s, ed.recipe), s.id, s.target ? targetName(s.target) : '', s.saveAs, s.value, s.url, s.fileName, s.message]
      .filter((x) => x !== undefined && x !== null && x !== '')
      .join(' ')
      .toLowerCase();
    return hay.includes(low);
  };
}

/** 검색·필터 결과: 맞는 스텝을 트리 순서대로 한 줄씩 */
function foundList(ed, ctx, renderList) {
  const found = ctx.tree.filter(matcher(ed, ctx));
  const head = h(
    'div',
    { class: 'row step-found' },
    h('span', { class: 'muted small' }, `찾은 스텝 ${found.length}개`),
    found.length
      ? h(
          'button',
          {
            class: 'sm',
            onclick: () => {
              for (const n of found) if (n.id) ed.selected.add(n.id);
              renderList();
              ed.onSelect?.();
            },
          },
          '찾은 스텝 모두 고르기',
        )
      : null,
    h(
      'button',
      {
        class: 'sm ghost',
        onclick: () => {
          ed.query = '';
          ed.kind = '';
          ed.state = '';
          ed.draw();
        },
      },
      '거르기 지우기',
    ),
  );
  return [head, found.length ? h('ul', { class: 'steps found' }, found.map((n) => stepItem(ed, ctx, n, { flat: true }))) : h('p', { class: 'muted' }, '맞는 스텝이 없습니다.')];
}

const kidLabel = (s, role) => (role === 'then' ? '그러면 (조건이 맞을 때)' : role === 'else' ? '아니면 (조건이 맞지 않을 때)' : s.type === 'forEach' ? '항목마다 할 스텝' : '반복할 스텝');

/** 트리: 시작 블록부터, 반복·분기의 몸통은 부모 아래에 들여쓰기. 끝에 쓰이지 않는 블록 */
function treeList(ed, ctx) {
  const r = ed.recipe;
  const kids = new Map();
  const top = [];
  const orphans = new Map();
  const firstCaller = new Map();
  for (const n of ctx.tree) {
    if (n.parentId === null || n.parentId === undefined) {
      if (n.orphan) {
        if (!orphans.has(n.block)) orphans.set(n.block, []);
        orphans.get(n.block).push(n);
      } else top.push(n);
    } else {
      if (!kids.has(n.parentId)) kids.set(n.parentId, []);
      kids.get(n.parentId).push(n);
      if (!firstCaller.has(n.block)) firstCaller.set(n.block, n.parentId);
    }
  }
  const renderNode = (n) => {
    const li = stepItem(ed, ctx, n);
    const groups = childBlocks(n.step);
    if (!groups.length || !n.id) return li;
    const box = h('div', { class: 'step-kids' });
    for (const [role, block] of groups) {
      const nodes = (kids.get(n.id) ?? []).filter((k) => k.block === block && k.role === role);
      add(box, h('div', { class: 'kid-label' }, kidLabel(n.step, role), h('span', { class: 'muted' }, ` · ${block} 블록`)));
      if (nodes.length) add(box, h('ul', { class: 'steps' }, nodes.map(renderNode)));
      else if (!Array.isArray(r.blocks[block])) add(box, h('div', { class: 'kid-empty warn' }, `블록 "${block}" 이(가) 없습니다.`));
      else if (!r.blocks[block].length) add(box, emptyBlock(ed, block));
      else add(box, h('div', { class: 'kid-empty' }, `"${block}" 블록은 ${ctx.nums.get(firstCaller.get(block)) ?? '다른 스텝'} 아래에 펼쳐 보입니다.`));
    }
    li.append(box);
    return li;
  };
  const out = [top.length ? h('ul', { class: 'steps' }, top.map(renderNode)) : h('p', { class: 'muted' }, '스텝이 없습니다. 아래 "스텝 추가" 로 넣으세요.')];
  const shown = new Set(ctx.tree.map((n) => n.block));
  const called = new Set(allStepsOf(r).flatMap((s) => childBlocks(s).map(([, b]) => b)));
  const empty = Object.keys(r.blocks).filter((b) => b !== entryOf(r) && Array.isArray(r.blocks[b]) && !shown.has(b) && !called.has(b));
  if (orphans.size || empty.length) {
    out.push(
      h(
        'div',
        { class: 'orphans' },
        h('h3', null, '쓰이지 않는 블록'),
        h('p', { class: 'muted small' }, '어디서도 부르지 않아 실행되지 않는 블록입니다. 필요 없으면 지우세요.'),
        [...orphans].map(([b, nodes]) => h('div', { class: 'orphan', 'data-block': b }, orphanHead(ed, b), h('ul', { class: 'steps' }, nodes.map(renderNode)))),
        empty.map((b) => h('div', { class: 'orphan', 'data-block': b }, orphanHead(ed, b))),
      ),
    );
  }
  return out;
}

function orphanHead(ed, block) {
  const n = ed.recipe.blocks[block]?.length ?? 0;
  return h(
    'div',
    { class: 'row orphan-head' },
    h('b', null, `${block} 블록`),
    h('span', { class: 'muted small' }, n ? `스텝 ${n}개` : '빈 블록'),
    h(
      'button',
      {
        class: 'sm danger',
        onclick: () => {
          if (n && !confirm(`"${block}" 블록과 그 안의 스텝 ${n}개를 지울까요?`)) return;
          delete ed.recipe.blocks[block];
          ed.markDirty();
          ed.draw();
        },
      },
      '블록 지우기',
    ),
  );
}

function emptyBlock(ed, block) {
  return h(
    'div',
    { class: 'kid-empty' },
    '비어 있습니다. ',
    h('button', { class: 'sm', onclick: () => addInto(ed, block) }, '＋ 여기에 스텝 추가'),
  );
}
/** 스텝 추가 막대가 이 블록 안(끝)에 넣게 하고 그리로 간다 */
function addInto(ed, block) {
  ed.addAt = { block };
  ed.draw();
  const bar = document.querySelector('.add-bar');
  bar?.scrollIntoView({ block: 'center' });
  bar?.querySelector('select')?.focus();
}

function stepItem(ed, ctx, n, { flat = false } = {}) {
  const s = n.step && typeof n.step === 'object' ? n.step : { type: '?' };
  const open = !!s.id && ed.openId === s.id;
  const picked = ed.selected.has(s.id);
  const probs = ctx.problems.get(s.id);
  const desc = h('span', { class: 'desc' }, stepText(s, ed.recipe));
  const riskBadge = s.type === 'repeat' ? h('span', { class: 'badge warn', title: '"다음" 을 누른 뒤 조건을 보므로 마지막 쪽을 처리하지 않습니다', hidden: !pagingRisk(ed.recipe, s) }, '마지막 쪽 빠짐') : null;
  ed.heads.set(s.id, () => {
    desc.textContent = stepText(s, ed.recipe);
    if (riskBadge) riskBadge.hidden = !pagingRisk(ed.recipe, s);
    ed.onStepChange?.(s.id);
  });
  let li;
  const box = h('input', {
    type: 'checkbox',
    checked: picked,
    'aria-label': `${n.no} 스텝 고르기`,
    onchange: (e) => {
      if (e.target.checked) ed.selected.add(s.id);
      else ed.selected.delete(s.id);
      li.classList.toggle('picked', e.target.checked);
      ed.onSelect?.();
    },
  });
  const head = h(
    'div',
    {
      class: 'step-head',
      tabindex: '0',
      onclick: () => {
        ed.openId = open ? null : s.id;
        ed.draw();
      },
      onkeydown: (e) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        ed.openId = open ? null : s.id;
        ed.draw();
        [...document.querySelectorAll('.step[data-step]')].find((x) => x.dataset.step === s.id)?.querySelector(':scope > .step-head')?.focus();
      },
    },
    s.id ? h('label', { class: 'step-pick', title: '고르기 (여러 개 골라 한꺼번에 바꾸기)', onclick: (e) => e.stopPropagation() }, box) : null,
    h('span', { class: 'num' }, n.no),
    h('span', { class: `type t-${s.type}` }, STEP_LABELS[s.type] ?? s.type),
    desc,
    flat && n.parentId ? h('span', { class: 'badge' }, `${ctx.nums.get(n.parentId) ?? ''} 안`) : null,
    usesWithin(s) ? h('span', { class: 'badge acc', title: '목록의 지금 항목 안에서만 찾습니다' }, '항목 안에서 찾기') : null,
    ctx.same?.has(s.id) ? h('span', { class: 'badge warn', title: '목록 안에 있지만 항목 안에서 찾지 않아 항목마다 같은 요소를 씁니다' }, '항목마다 같은 요소') : null,
    riskBadge,
    s.optional ? h('span', { class: 'badge' }, '없으면 건너뜀') : null,
    s.onError === 'continue' ? h('span', { class: 'badge warn' }, '실패해도 계속') : null,
    s.disabled ? h('span', { class: 'badge' }, '꺼짐') : null,
    probs ? h('span', { class: 'badge warn', title: probs.join('\n') }, '고칠 점') : null,
  );
  li = h(
    'li',
    { class: `step${open ? ' open' : ''}${s.disabled ? ' disabled' : ''}${picked ? ' picked' : ''}${flat ? ' flat' : ''}`, 'data-step': s.id, style: flat && n.depth ? `margin-left:${Math.min(n.depth, 4) * 14}px` : undefined },
    head,
    open ? stepBody(ed, ctx, n) : null,
  );
  return li;
}

// =====================================================================
// 일괄 작업
// =====================================================================
function bulkBar(ed, ctx) {
  const ids = ordered(ed, ctx);
  if (!ids.length) return null;
  const nos = ids.map((id) => ctx.nums.get(id) ?? id);
  const btn = (label, fn, cls = '') => h('button', { class: `sm ${cls}`.trim(), onclick: fn }, label);
  const firstTarget = ids.map((id) => findStep(ed.recipe, id)?.step?.target).find((t) => t?.candidates?.length);
  // 휴대폰 폭에서는 자주 쓰는 단추만 보이고 나머지(class more)는 [더보기] 로 펼친다 (막대가 화면을 덮지 않게)
  const bar = h(
    'div',
    { class: `bulk-bar${ed.bulkMore ? ' show-more' : ''}`, role: 'toolbar', 'aria-label': '고른 스텝 한꺼번에 바꾸기' },
    h('b', null, `${ids.length}개 고름`),
    h('span', { class: 'muted small bulk-nos' }, nos.length > 6 ? `${nos.slice(0, 6).join(', ')} …` : nos.join(', ')),
    btn('삭제', () => removeSteps(ed, ids, { ask: true }), 'danger'),
    btn('끄기', () => setDisabled(ed, ids, true)),
    btn('켜기', () => setDisabled(ed, ids, false), 'more'),
    btn('반복으로 묶기', () =>
      wrap(ed, ids, { type: 'repeat', times: 2 }, (next) => {
        const last = ids.map((id) => findStep(next, id)?.step).at(-1);
        return last?.type === 'click' ? '반복으로 묶었습니다 — 쪽을 넘기려면 반복 방법 "쪽 넘기기"' : '반복으로 묶었습니다 — 아래에서 반복 방법을 정하세요.';
      }),
      'more',
    ),
    btn('목록의 항목마다로 묶기', () => wrap(ed, ids, { type: 'forEach', maxItems: 100 }, (next, stepId) => autoList(next, stepId) || '목록의 항목마다로 묶었습니다 — 아래에서 목록 요소를 고르세요.'), 'more'),
    btn('조건부로 만들기', () =>
      // 요소가 없는 스텝(화면 캡처 등)은 그 자리에서 늘 참인 조건 대신 빈 조건으로 — 사용자가 정하게 한다
      wrap(ed, ids, { type: 'branch', condition: firstTarget ? { kind: 'exists', target: structuredClone(firstTarget) } : { kind: 'textVisible', text: '' } }, firstTarget ? '조건부로 만들었습니다 — 아래에서 조건을 고르세요.' : '조건부로 만들었습니다 — 어떤 때 실행할지 조건을 정해 주세요.'),
      'more',
    ),
    h(
      'button',
      {
        class: 'sm ai-ask',
        title: '고른 스텝을 맥락으로 AI 도우미 입력창에 넣습니다',
        onclick: () => askAi({ draft: `${nos.length > 8 ? `${nos.slice(0, 8).join(', ')} 등 ${nos.length}개` : nos.join(', ')} 스텝을 `, context: { selectedStepIds: ids } }),
      },
      '✦ AI 에게',
    ),
    btn(
      '선택 해제',
      () => {
        ed.selected.clear();
        ed.draw();
      },
      'ghost',
    ),
    h(
      'button',
      {
        class: 'sm bulk-toggle',
        'aria-expanded': ed.bulkMore ? 'true' : 'false',
        onclick: (e) => {
          ed.bulkMore = !ed.bulkMore;
          bar.classList.toggle('show-more', ed.bulkMore);
          e.currentTarget.textContent = ed.bulkMore ? '접기' : '더보기 …';
          e.currentTarget.setAttribute('aria-expanded', String(ed.bulkMore));
        },
      },
      ed.bulkMore ? '접기' : '더보기 …',
    ),
  );
  return bar;
}

function friendly(msg) {
  if (/같은 블록 안의 스텝만/.test(msg)) return `${msg} 반복·분기 안의 스텝과 밖의 스텝을 섞어 고르지 마세요.`;
  return msg;
}

/** 목록의 항목마다로 묶은 직후: 묶은 스텝의 요소가 표의 행·목록 항목 안에 있으면 그 행 전체를 목록으로 정하고,
 * 그 행 안을 가리키는 스텝을 "항목 안에서 찾기" 로 바꾼다 → 알림 문장 (못 정하면 '') */
function autoList(r, stepId) {
  const fe = findStep(r, stepId)?.step;
  const body = fe?.body ? r.blocks[fe.body] : null;
  if (!Array.isArray(body)) return '';
  const src = body.find((s) => s?.target && listFromTarget(s.target));
  if (!src) return '';
  const w = listFromTarget(src.target);
  fe.items = w.items;
  const moved = convertBody(r, fe);
  const nums = stepNumbers(r);
  return `"${w.items.meta.label}" 전체를 목록으로 정했습니다${moved.length ? ` · ${moved.map((id) => nums.get(id) ?? id).join(', ')} 항목 안에서 찾기` : ''}`; // 한 줄 (자세한 것은 펼친 스텝 안내에)
}

/** forEach 몸통에서 목록의 한 행(항목) 안을 가리키는 스텝을 "항목 안에서 찾기" 로 바꾼다 → 바꾼 스텝 id */
function convertBody(r, fe) {
  const out = [];
  for (const x of sameElementSteps(r)) {
    if (x.forEachId !== fe.id || !x.relative) continue;
    const s = findStep(r, x.stepId)?.step;
    if (!s) continue;
    s.target = x.relative;
    out.push(s.id);
  }
  return out;
}

function wrap(ed, ids, wrapper, done) {
  const next = structuredClone(ed.recipe);
  try {
    const { stepId } = wrapSteps(next, ids, wrapper);
    if (typeof done === 'function') done = done(next, stepId);
    ed.recipe = next;
    ed.selected.clear();
    ed.openId = stepId;
    ed.query = '';
    ed.kind = '';
    ed.state = '';
    ed.markDirty();
    ed.draw();
    toast(done);
  } catch (e) {
    toast(friendly(e.message), 'error');
  }
}

/** 지울 스텝과 함께 지울 몸통 블록(그 스텝들만 부르는 블록, 안쪽까지) */
function deletionPlan(r, ids) {
  const del = new Set(ids);
  const blocks = new Set();
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of allStepsOf(r)) {
      if (!del.has(s?.id)) continue;
      for (const [, b] of childBlocks(s)) {
        if (blocks.has(b) || b === entryOf(r) || !Array.isArray(r.blocks[b])) continue;
        const callers = allStepsOf(r).filter((x) => childBlocks(x).some(([, y]) => y === b));
        if (!callers.every((x) => del.has(x.id))) continue;
        blocks.add(b);
        grew = true;
        for (const x of r.blocks[b]) if (x?.id) del.add(x.id);
      }
    }
  }
  return { del, blocks };
}

function removeSteps(ed, ids, { ask }) {
  const r = ed.recipe;
  const { del, blocks } = deletionPlan(r, ids);
  const inner = del.size - ids.length;
  const msg = inner > 0 ? `스텝 ${ids.length}개와 그 안의 스텝 ${inner}개를 지울까요?` : `스텝 ${ids.length}개를 지울까요?`;
  if ((ask || inner > 0) && !confirm(msg)) return;
  for (const b of blocks) delete r.blocks[b];
  for (const [b, steps] of Object.entries(r.blocks)) if (Array.isArray(steps)) r.blocks[b] = steps.filter((s) => !del.has(s?.id));
  for (const id of del) ed.selected.delete(id);
  if (del.has(ed.openId)) ed.openId = null;
  ed.markDirty();
  ed.draw();
  if (ids.length > 1 || inner > 0) toast(`스텝 ${del.size}개를 지웠습니다.`);
}

function setDisabled(ed, ids, off) {
  for (const id of ids) {
    const s = findStep(ed.recipe, id)?.step;
    if (!s) continue;
    if (off) s.disabled = true;
    else delete s.disabled;
  }
  ed.markDirty();
  ed.draw();
  toast(off ? `스텝 ${ids.length}개를 껐습니다.` : `스텝 ${ids.length}개를 켰습니다.`);
}

/** 스텝 복제: 반복·분기면 안의 블록도 새 이름으로 복제한다 */
function cloneDeep(r, step, nextId, busy = new Set()) {
  const copy = structuredClone(step);
  copy.id = nextId();
  for (const [role, b] of childBlocks(step)) {
    if (!Array.isArray(r.blocks[b]) || busy.has(b)) continue;
    busy.add(b);
    const name = blockName(r, b);
    r.blocks[name] = [];
    r.blocks[name] = r.blocks[b].map((x) => cloneDeep(r, x, nextId, busy));
    busy.delete(b);
    copy[role] = name;
  }
  return copy;
}

function unwrap(ed, s) {
  const next = structuredClone(ed.recipe);
  try {
    const res = unwrapStep(next, s.id);
    ed.recipe = next;
    ed.openId = null;
    ed.markDirty();
    ed.draw();
    toast(res.keptBlocks.length ? `풀었습니다. "아니면" 블록(${res.keptBlocks.join(', ')})은 쓰이지 않는 블록으로 남겼습니다.` : '풀었습니다. 안의 스텝을 밖으로 꺼냈습니다.');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// =====================================================================
// 스텝 편집
// =====================================================================
function stepBody(ed, ctx, n) {
  const r = ed.recipe;
  const s = n.step;
  const id = s.id;
  const steps = r.blocks[n.block];
  const t = (key, o = {}) => valueInput(ed, s, key, { stepId: id, ...o });
  const redraw = () => (ed.markDirty(), ed.draw());
  const selectOf = (label, options, cur, onPick) =>
    field(
      label,
      h(
        'select',
        { onchange: (e) => onPick(e.target.value) },
        options.map(([v, l]) => h('option', { value: v, selected: v === cur }, l)),
      ),
    );
  const condEd = (key, title) => conditionEditor(ed, { get: () => s[key], set: (c) => (s[key] = c), stepId: id, onChange: () => ed.changed(id), title });
  const fields = [];
  const wide = [];
  switch (s.type) {
    case 'navigate':
      fields.push(field('주소 ({{ 로 변수 넣기)', t('url', { auto: true })));
      break;
    case 'input':
      fields.push(field('입력값 ({{ 를 치면 변수·엑셀 열 고르기)', t('value', { auto: true })));
      break;
    case 'select':
      fields.push(field('선택값', t('value', { auto: true })), field('보이는 이름(선택)', t('label')));
      break;
    case 'check':
      fields.push(
        selectOf(
          '상태',
          [
            ['on', '체크'],
            ['off', '체크 해제'],
          ],
          s.checked === false ? 'off' : 'on',
          (v) => ((s.checked = v === 'on'), ed.changed(id)),
        ),
      );
      break;
    case 'keypress':
      fields.push(field('키 (예: Enter, Escape, Tab, Control+A)', t('key')));
      break;
    case 'sleep':
      fields.push(field('대기 시간(ms)', t('ms', { type: 'number', num: true })));
      break;
    case 'wait':
      wide.push(condEd('condition', '이 조건이 맞을 때까지 기다립니다'));
      break;
    case 'assert':
      wide.push(condEd('condition', '확인할 조건 (맞지 않으면 아래처럼 처리)'));
      fields.push(
        field('실패 메시지', t('message')),
        selectOf(
          '조건이 맞지 않으면',
          [
            ['fail', '그 행을 실패로'],
            ['warn', '경고만 남기고 계속'],
          ],
          s.onFail === 'warn' ? 'warn' : 'fail',
          (v) => (v === 'warn' ? (s.onFail = 'warn') : delete s.onFail, ed.changed(id)),
        ),
      );
      break;
    case 'branch':
      if (s.condition?.kind === 'textVisible' && !String(s.condition.text ?? '').trim()) wide.push(h('div', { class: 'notice warn small' }, '조건을 정해 주세요: 아래 "무엇이" 와 "어떠하면" 을 고르고 값을 넣어야 실행할 수 있습니다.'));
      wide.push(condEd('condition', '만약 이 조건이 맞으면 "그러면" 스텝을 실행합니다'), branchBlocks(ed, s));
      break;
    case 'repeat':
      repeatParts(ed, s, t, fields, wide, condEd, redraw);
      break;
    case 'forEach':
      forEachParts(ed, s, t, fields, wide, n);
      break;
    case 'extract':
      fields.push(field('저장할 변수 이름 (결과 엑셀 열 이름)', t('saveAs')), field('속성(비우면 글자)', t('attr', { placeholder: '예: href, value' })));
      break;
    case 'dialog':
      fields.push(
        selectOf(
          '응답',
          [
            ['accept', '확인'],
            ['dismiss', '취소'],
          ],
          s.action === 'dismiss' ? 'dismiss' : 'accept',
          (v) => ((s.action = v), ed.changed(id)),
        ),
      );
      if (s.meta?.dialogType === 'prompt') fields.push(field('입력할 글자', t('promptText', { auto: true })));
      break;
    case 'pdf':
      fields.push(
        field('파일 이름 ({{열}}, {{row}}, {{sys:date:YYYYMMDD}})', t('fileName', { auto: true })),
        selectOf(
          '용지 방향',
          [
            ['p', '세로'],
            ['l', '가로'],
          ],
          s.landscape ? 'l' : 'p',
          (v) => ((s.landscape = v === 'l'), ed.changed(id)),
        ),
      );
      break;
    case 'screenshot':
      fields.push(field('파일 이름', t('fileName', { auto: true })));
      break;
    case 'download':
      fields.push(field('저장 이름 ({{열}}, {{row}} 사용 가능 · 비우면 원래 이름 · 확장자는 원래 것 유지)', t('fileName', { auto: true, placeholder: s.meta?.suggestedFilename ?? '' })));
      break;
    case 'upload':
      fields.push(field('첨부할 파일 경로 (예: C:\\자료\\{{상호}}.pdf)', t('path', { auto: true })));
      break;
    case 'pause':
      fields.push(field('안내 문구', t('message')));
      break;
    default:
      break;
  }
  if (s.target || ['wait', 'assert'].includes(s.type)) fields.push(field('최대 대기(ms, 기본 10000)', t('timeoutMs', { type: 'number', num: true })));
  if (!['pdf', 'download', 'upload', 'branch', 'pause', 'dialog', 'repeat', 'forEach'].includes(s.type)) fields.push(field('시도 횟수(기본 1)', t('attempts', { type: 'number', num: true })));

  const toggle = (key, label, on = true) =>
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: s[key] === on,
        onchange: (e) => {
          if (e.target.checked) s[key] = on;
          else delete s[key];
          redraw();
        },
      }),
      label,
    );

  const at = () => steps.indexOf(s);
  const move = (d) => () => {
    const i = at();
    const j = i + d;
    if (i < 0 || j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j], steps[i]];
    redraw();
  };
  const insertAfter = (step) => {
    steps.splice(at() + 1, 0, step);
    ed.openId = step.id;
    redraw();
  };
  const nextId = idMaker(r);
  const actions = [
    h('button', { class: 'sm', onclick: move(-1), disabled: n.index === 0 }, '↑ 위로'),
    h('button', { class: 'sm', onclick: move(1), disabled: n.index === steps.length - 1 }, '↓ 아래로'),
    h('button', { class: 'sm', onclick: () => insertAfter(cloneDeep(r, s, nextId)) }, '복제'),
  ];
  if ((s.type === 'input' || s.type === 'select') && !String(s.value ?? '').includes('{{')) {
    actions.push(
      h(
        'button',
        {
          class: 'sm',
          onclick: () => {
            const suggestion = s.target?.meta?.label || s.target?.meta?.name || '';
            const col = prompt('연결할 엑셀 열 이름을 입력하세요. 실행할 때 엑셀의 이 열 값이 들어갑니다.', suggestion);
            if (!col?.trim()) return;
            s.meta = { ...(s.meta ?? {}), recordedValue: s.label || s.value }; // AI 화면 관찰 때 견본 값으로 쓴다
            s.value = `{{${col.trim()}}}`;
            delete s.label;
            r.variables ??= [];
            if (!r.variables.some((v) => v.id === col.trim() || v.name === col.trim())) r.variables.push({ id: col.trim(), name: col.trim(), source: { kind: 'excel', column: col.trim() } });
            redraw();
          },
        },
        '엑셀 열로 바꾸기',
      ),
    );
  }
  if (s.type === 'click' && s.target) actions.push(h('button', { class: 'sm', onclick: () => ((s.type = 'download'), (s.fileName = ''), redraw()) }, '파일 다운로드로 바꾸기'));
  if (s.type === 'download') actions.push(h('button', { class: 'sm', onclick: () => ((s.type = 'click'), delete s.fileName, redraw()) }, '일반 클릭으로 되돌리기'));
  if (s.target) {
    actions.push(
      h(
        'button',
        {
          class: 'sm',
          onclick: () => {
            const name = prompt('읽은 값을 저장할 이름 (결과 엑셀의 열 이름이 됩니다)', s.target.meta?.label || s.target.meta?.text?.slice(0, 20) || '값');
            if (!name?.trim()) return;
            insertAfter({ id: nextId(), type: 'extract', target: structuredClone(s.target), saveAs: name.trim() });
          },
        },
        '이 요소의 글자 읽기 추가',
      ),
      h('button', { class: 'sm', onclick: () => insertAfter({ id: nextId(), type: 'wait', condition: { kind: 'exists', target: structuredClone(s.target) }, timeoutMs: 15000 }) }, '이 요소가 나올 때까지 대기 추가'),
    );
  }
  if (CONTAINERS.has(s.type)) {
    actions.push(h('button', { class: 'sm', title: '이 스텝을 없애고 안의 스텝을 이 자리로 꺼냅니다', onclick: () => unwrap(ed, s) }, '풀기 (안의 스텝을 밖으로)'));
    if (s.type === 'branch') {
      if (s.then) actions.push(h('button', { class: 'sm', onclick: () => addInto(ed, s.then) }, '＋ "그러면"에 스텝 추가'));
      if (s.else) actions.push(h('button', { class: 'sm', onclick: () => addInto(ed, s.else) }, '＋ "아니면"에 스텝 추가'));
    } else if (s.body) actions.push(h('button', { class: 'sm', onclick: () => addInto(ed, s.body) }, '＋ 안에 스텝 추가'));
  }
  actions.push(
    aiAskButton(() => `${stepNumbers(ed.recipe).get(s.id) ?? s.id} 스텝(${STEP_LABELS[s.type] ?? s.type}: ${stepText(s).slice(0, 60)})을 `, { openStepId: s.id, selectedStepIds: [s.id] }),
    h('button', { class: 'sm danger', onclick: () => removeSteps(ed, [s.id], { ask: false }) }, '삭제'),
  );

  const probs = ctx.problems.get(id);
  const nums = ctx.nums;
  const recorded = (s.type === 'input' || s.type === 'select') && s.meta?.recordedValue !== undefined && s.meta?.recordedValue !== null && s.meta.recordedValue !== '' ? String(s.meta.recordedValue) : null;
  return h(
    'div',
    { class: 'step-body' },
    probs ? h('div', { class: 'notice warn small step-probs' }, h('b', null, '고칠 점'), h('ul', null, probs.map((p) => h('li', null, problemLine(ed, p, nums))))) : null,
    sameElementNotice(ed, ctx, s),
    wide,
    fields.length ? h('div', { class: 'fields' }, fields) : null,
    recorded ? h('div', { class: 'muted small' }, '녹화 때 값: ', h('code', null, recorded)) : null,
    h(
      'div',
      { class: 'row' },
      s.target || ['wait'].includes(s.type) ? toggle('optional', '없으면 건너뜀 (2초만 찾음)') : null,
      toggle('onError', '실패해도 다음 스텝 계속', 'continue'),
      toggle('disabled', '이 스텝 끄기'),
    ),
    h('div', { class: 'actions' }, actions),
    s.target
      ? h(
          'details',
          { class: 'cands' },
          h('summary', { class: 'muted' }, `대상 요소: ${targetText(s.target)} · 후보 ${s.target.candidates?.length ?? 0}개${s.target.framePath?.length ? ` · 프레임 ${s.target.framePath.length}단계` : ''}`),
          h('ol', null, (s.target.candidates ?? []).map((c) => h('li', null, h('span', { class: 'badge' }, c.score), ' ', h('code', null, c.kind), ' ', c.kind === 'text' ? `<${c.value?.tag}> "${c.value?.text}"` : c.value))),
          h('div', { class: 'muted' }, s.target.within === 'item' ? '목록의 지금 항목 안에서만 찾습니다. 후보는 항목 기준 선택자입니다.' : '실행할 때 점수가 높은 후보부터 시도해, 화면에서 정확히 하나만 맞는 후보를 씁니다.'),
        )
      : null,
    s.meta?.url ? h('div', { class: 'muted small', style: 'margin-top:6px;overflow-wrap:anywhere' }, `녹화 당시 주소: ${s.meta.url}`) : null,
  );
}

/** 목록의 항목마다 안인데 항목 안에서 찾지 않는 스텝: 경고 + [항목 안에서 찾기로 바꾸기] (경로로 못 바꾸면 AI 에게) */
function sameElementNotice(ed, ctx, s) {
  const x = ctx.same?.get(s.id);
  if (!x) return null;
  const feNo = ctx.nums.get(x.forEachId) ?? '';
  const convert = () => {
    const next = structuredClone(ed.recipe);
    const st = findStep(next, s.id)?.step;
    const rel = st && (relativeToList(st.target, findStep(next, x.forEachId)?.step?.items, { name: st.type === 'extract' ? st.saveAs : undefined }) ?? x.relative);
    if (!rel) return toast('이 요소를 항목 기준으로 바꾸지 못했습니다. AI 에게 맡겨 주세요.', 'error');
    st.target = rel;
    ed.recipe = next;
    ed.markDirty();
    ed.draw();
    toast(`${withJosa(ctx.nums.get(s.id) ?? '이 스텝', '을', '를')} 항목 안에서 찾기로 바꿨습니다.`);
  };
  return h(
    'div',
    { class: 'notice warn small same-el' },
    h('b', null, '항목마다 같은 요소를 씁니다. '),
    `이 스텝은 ${feNo} 목록의 항목마다 안에 있지만 "항목 안에서 찾기" 가 아니라서, 항목이 바뀌어도 늘 같은 곳(${s.target ? targetText(s.target) : '같은 요소'})을 ${s.type === 'extract' ? '읽습니다 (같은 값이 되풀이됩니다)' : '씁니다'}.`,
    h(
      'div',
      { class: 'row', style: 'margin-top:6px' },
      x.relative
        ? h('button', { class: 'sm primary', onclick: convert }, '항목 안에서 찾기로 바꾸기')
        : h(
            'button',
            {
              class: 'sm',
              onclick: () => askAi({ draft: `${ctx.nums.get(s.id) ?? s.id} 스텝을 ${feNo} 목록의 항목마다 그 항목 안의 요소에서 찾도록 고쳐 줘 (지금은 항목마다 같은 요소를 씁니다). `, context: { openStepId: s.id, selectedStepIds: [s.id] } }),
            },
            'AI 에게 항목 안 요소로 바꿔 달라고 하기',
          ),
    ),
  );
}

/** repeat: N번 / 조건이 참인 동안 / 조건이 참이 될 때까지 + 최대 횟수 */
function repeatParts(ed, s, t, fields, wide, condEd, redraw) {
  const r = ed.recipe;
  const paging = pagingOf(r, s);
  const choosingPages = !paging && ed.pagesFor === s.id; // 쪽 넘기기를 골랐지만 누를 "다음" 단추를 아직 못 정함
  const mode = paging || choosingPages ? 'pages' : s.until ? 'until' : s.while ? 'while' : 'times';
  const body = Array.isArray(r.blocks[s.body]) ? r.blocks[s.body] : [];
  const clicks = body.filter((x) => (x?.type === 'click' || x?.type === 'dblclick') && x.target?.candidates?.length);
  const toPages = (opts) => {
    const next = structuredClone(r);
    try {
      makePaging(next, s.id, opts);
      ed.recipe = next;
      ed.pagesFor = null;
      ed.openId = s.id;
      redraw();
      toast('쪽 넘기기로 바꿨습니다 — 마지막 쪽까지 처리합니다.');
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  // 반복 방법은 한 줄 전체 폭으로 (고른 글이 잘리지 않게) — 조건·요약보다 먼저
  wide.push(
    h(
      'div',
      { class: 'repeat-mode-row' },
      field(
      '반복 방법',
      h(
        'select',
        {
          class: 'repeat-mode',
          'aria-label': '반복 방법',
          onchange: (e) => {
            const m = e.target.value;
            if (m === 'pages') {
              if (clicks.length) return toPages({ clickStepId: clicks.at(-1).id });
              ed.pagesFor = s.id; // 아래에서 누를 단추를 고른다
              return redraw();
            }
            ed.pagesFor = null;
            const back = unmakePaging(r, s.id); // 쪽 넘기기를 풀면 "다음" 클릭을 몸통 끝으로 되돌린다
            // 처음 조건: 몸통 끝의 클릭 요소(보통 "다음")가 있는 동안 / 없어질 때까지 — 없으면 지금 조건·레시피의 첫 요소
            const nextT = back?.target ?? (s.while || s.until ? null : clicks.at(-1)?.target);
            const cond = nextT ? (m === 'while' ? { kind: 'exists', target: structuredClone(nextT) } : { kind: 'not', condition: { kind: 'exists', target: structuredClone(nextT) } }) : (s.while ?? s.until ?? defaultCondition(r));
            delete s.times;
            delete s.while;
            delete s.until;
            if (m === 'times') {
              s.times = 2;
              delete s.maxIterations;
            } else {
              s[m] = cond;
              s.maxIterations ??= 100;
            }
            redraw();
          },
        },
        h('option', { value: 'times', selected: mode === 'times' }, 'N번 반복'),
        h('option', { value: 'while', selected: mode === 'while' }, '조건이 참인 동안 (매번 시작 전에 확인)'),
        h('option', { value: 'until', selected: mode === 'until' }, '조건이 참이 될 때까지 (매번 끝난 뒤 확인)'),
        h('option', { value: 'pages', selected: mode === 'pages' }, '쪽 넘기기 — 다음 쪽이 없을 때까지'),
      ),
      ),
    ),
  );
  if (mode === 'times') fields.push(field('반복 횟수 (1~1000)', t('times', { type: 'number', num: true })));
  else fields.push(field('최대 반복 횟수 (기본 100, 닿으면 경고를 남기고 다음 스텝으로)', t('maxIterations', { type: 'number', num: true, placeholder: '100' })));
  if (paging) {
    const no = stepNumbers(r).get(paging.clickId) ?? '';
    wide.push(
      h(
        'div',
        { class: 'notice info small paging-sum' },
        h('b', null, '쪽 넘기기: '),
        `지금 쪽의 스텝을 처리하고, ${withJosa(targetText(paging.target), '이', '가')} 있으면 눌러 다음 쪽에서 다시 합니다. 첫 쪽에서는 누르지 않고(${withJosa(no || '그 클릭', '은', '는')} 두 번째 반복부터), "다음" 이 없는 마지막 쪽까지 처리한 뒤 끝납니다.`,
      ),
    );
  } else if (choosingPages) {
    const choices = elementChoices(r).filter((x) => !x.target.within);
    wide.push(
      h(
        'div',
        { class: 'notice warn small' },
        h('b', null, '누를 "다음" 단추를 고르세요. '),
        '반복할 스텝 안에 "다음" 을 누르는 클릭 스텝이 없습니다. 이 레시피의 요소에서 고르면 그 단추를 누르는 스텝을 만들어 넣습니다.',
        h(
          'div',
          { class: 'row', style: 'margin-top:6px' },
          h(
            'select',
            {
              'aria-label': '누를 다음 단추',
              style: 'width:auto;max-width:100%',
              onchange: (e) => {
                const c = choices.find((x) => x.key === e.target.value);
                if (c) toPages({ target: c.target });
              },
            },
            h('option', { value: '' }, choices.length ? '"다음" 단추 고르기…' : '(요소가 있는 스텝이 없습니다)'),
            choices.map((x) => h('option', { value: x.key }, x.label)),
          ),
          h('button', { class: 'sm ghost', onclick: () => ((ed.pagesFor = null), redraw()) }, '취소'),
        ),
      ),
    );
  } else if (mode !== 'times') {
    // 몸통 끝이 조건의 요소("다음")를 누르는 클릭이면 마지막 쪽을 빠뜨린다 — 조건을 고칠 때마다 다시 본다
    const riskBox = h('div', { class: 'paging-risk-slot' });
    const drawRisk = () => {
      const risk = pagingRisk(ed.recipe, s);
      mount(
        riskBox,
        risk
          ? h(
              'div',
              { class: 'notice warn small paging-risk' },
              h('b', null, '마지막 쪽은 처리되지 않습니다. '),
              `반복할 스텝 끝(${stepNumbers(ed.recipe).get(risk) ?? ''})에서 "다음" 을 누른 뒤 조건을 보므로, "다음" 이 없는 마지막 쪽을 처리하기 전에 반복이 끝납니다. 모든 쪽을 처리하려면 쪽 넘기기로 바꾸세요.`,
              h('div', { class: 'row', style: 'margin-top:6px' }, h('button', { class: 'sm primary', onclick: () => toPages({ clickStepId: risk }) }, '쪽 넘기기로 바꾸기')),
            )
          : null,
      );
    };
    drawRisk();
    ed.onStepChange = (stepId) => stepId === s.id && drawRisk();
    wide.push(riskBox, condEd(mode, mode === 'while' ? '이 조건이 참인 동안 반복합니다' : '이 조건이 참이 되면 반복을 멈춥니다'));
  }
  wide.push(h('p', { class: 'muted small hint' }, '반복 안의 스텝에서 ', h('code', null, '{{loop.index}}'), ' 로 몇 번째 반복인지 쓸 수 있습니다.'));
}

/** forEach: 목록 요소(요약·개수 안내), 최대 개수, 항목마다 뒤로 가기 */
function forEachParts(ed, s, t, fields, wide, n) {
  const items = s.items;
  const limit = Number(s.maxItems) > 0 ? Math.floor(Number(s.maxItems)) : 100;
  const top = (items?.candidates ?? []).slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  const single = looksSingle(items);
  const askList = () => askAi({ draft: `${n.no} 목록의 항목마다 스텝의 목록 요소를 화면에서 찾아 줘 (표의 행이나 목록 항목). `, context: { openStepId: s.id, selectedStepIds: [s.id] } });
  // 고를 거리: 표 칸·목록 항목 안 요소면 "그 요소가 있는 행(항목) 전체" 를 먼저, 그다음 요소 그대로 (보통 1개짜리)
  const choices = [];
  for (const x of elementChoices(ed.recipe)) {
    if (x.target === items || x.target.within) continue;
    const w = listFromTarget(x.target);
    if (w) choices.push({ key: `${x.key}-row`, label: `${x.label} → 이 ${w.tag === 'tr' ? '칸이 있는 표의 행' : '항목이 있는 목록'} 전체 (${w.tag === 'tr' ? '행' : '항목'}마다)`, target: w.items, widen: true });
    const isList = x.label.endsWith('(목록)') || x.target.meta?.count > 1;
    choices.push({ key: x.key, label: isList ? x.label : `${x.label} — 요소 1개 (항목 1개)`, target: x.target, single: !isList });
  }
  wide.push(
    h(
      'div',
      { class: `notice ${items?.candidates?.length && !single ? 'info' : 'warn'} small foreach-sum` },
      items?.candidates?.length
        ? [
            h('b', null, `목록: ${targetName(items)}`),
            ` · 찾는 방법 ${items.candidates.length}가지`,
            items.meta?.count ? ` · 관찰 때 항목 ${items.meta.count}개` : ' · 항목 수는 실행할 때 셉니다',
            h('br'),
            single
              ? h('b', { class: 'single-warn' }, '이 목록 요소는 화면에서 요소 하나만 가리킵니다 — 항목이 1개라 한 번만 실행됩니다. 아래에서 "…표의 행 전체" 를 고르거나 AI 에게 목록 찾기를 맡기세요.')
              : `실행할 때 화면에서 이 목록에 맞는 항목을 세어 (최대 ${limit}개) 항목마다 아래 스텝을 실행합니다. 항목이 없으면 건너뜁니다.`,
          ]
        : [
            h('b', null, '아직 목록 요소가 없습니다.'),
            ' AI 에게 화면에서 찾아 달라고 하거나, 아래에서 기존 스텝의 요소(그 요소가 있는 표의 행 전체)를 고르거나 CSS 선택자를 쓰세요.',
            h('div', { class: 'row', style: 'margin-top:6px' }, h('button', { class: 'sm primary', onclick: askList }, 'AI 에게 목록 찾기 맡기기')),
          ],
    ),
  );
  const pick = h(
    'select',
    {
      'aria-label': '기존 스텝 요소에서 고르기',
      onchange: (e) => {
        const c = choices.find((x) => x.key === e.target.value);
        if (!c) return;
        s.items = structuredClone(c.target);
        delete s.items.within;
        if (c.single) s.items.meta = { ...(s.items.meta ?? {}), single: true };
        else if (s.items.meta) delete s.items.meta.single;
        // 행 전체를 골랐으면 그 행 안을 가리키는 몸통 스텝을 "항목 안에서 찾기" 로 바꾼다 (항목마다 그 행의 값을 읽게)
        const moved = c.widen ? convertBody(ed.recipe, s) : [];
        ed.markDirty();
        ed.draw();
        if (moved.length) toast(`"${targetName(s.items)}" 전체를 목록으로 정했습니다 · ${moved.map((id) => stepNumbers(ed.recipe).get(id) ?? id).join(', ')} 항목 안에서 찾기`);
        else if (c.single) toast('요소 하나를 목록으로 골랐습니다 — 항목이 1개라 한 번만 실행됩니다.');
      },
    },
    h('option', { value: '' }, choices.length ? '기존 스텝 요소에서 고르기…' : '(요소가 있는 스텝이 없습니다)'),
    choices.map((x) => h('option', { value: x.key }, x.label)),
  );
  const css = h('input', {
    type: 'text',
    class: 'foreach-css',
    value: top?.kind === 'css' ? top.value : '',
    placeholder: '예: #result tbody tr',
    'aria-label': '목록 CSS 선택자',
    oninput: (e) => {
      const v = e.target.value.trim();
      if (!v) delete s.items;
      else {
        const meta = { ...(s.items?.meta ?? {}) };
        delete meta.count;
        delete meta.text;
        meta.label ||= '목록의 항목';
        s.items = { ...(s.items?.framePath?.length ? { framePath: s.items.framePath } : {}), candidates: [{ kind: 'css', value: v, score: 60 }], meta };
      }
      ed.changed(s.id);
    },
  });
  const label = h('input', {
    type: 'text',
    value: items?.meta?.label ?? '',
    placeholder: '예: 결과 표의 행',
    'aria-label': '목록 이름',
    oninput: (e) => {
      if (!s.items) return;
      s.items.meta = { ...(s.items.meta ?? {}), label: e.target.value };
      ed.changed(s.id);
    },
  });
  fields.push(
    field('목록 요소 고르기', pick),
    field('또는 CSS 선택자로 정하기', css),
    field('목록 이름 (화면에 보일 이름)', label),
    field('최대 항목 수 (기본 100)', t('maxItems', { type: 'number', num: true, placeholder: '100' })),
  );
  wide.push(
    h(
      'div',
      { class: 'row' },
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: s.restore === 'back',
          onchange: (e) => {
            if (e.target.checked) s.restore = 'back';
            else delete s.restore;
            ed.changed(s.id);
          },
        }),
        '항목마다 끝나면 뒤로 가기 (상세 화면에 들어갔다 목록으로 돌아올 때)',
      ),
      items?.candidates?.length ? h('button', { class: 'sm', onclick: askList }, 'AI 에게 목록 찾기 맡기기') : null,
    ),
    h(
      'p',
      { class: 'muted small hint' },
      '항목 안 스텝에서 쓸 수 있는 값: ',
      h('code', null, '{{item.text}}'),
      ' 항목 글자, ',
      h('code', null, '{{item.index}}'),
      ' 항목 번호, ',
      h('code', null, '{{item.cell:2}}'),
      ' 표의 2번째 칸. 대상에 "항목 안에서 찾기" 가 붙은 스텝은 지금 항목 안에서만 찾습니다.',
    ),
  );
}

/** branch: 그러면·아니면 블록 */
function branchBlocks(ed, s) {
  const r = ed.recipe;
  const count = (b) => (Array.isArray(r.blocks[b]) ? r.blocks[b].length : 0);
  return h(
    'div',
    { class: 'row branch-blocks' },
    h('span', { class: 'muted small' }, `그러면: "${s.then ?? '?'}" 블록 (스텝 ${count(s.then)}개)`),
    s.else
      ? [
          h('span', { class: 'muted small' }, `· 아니면: "${s.else}" 블록 (스텝 ${count(s.else)}개)`),
          h(
            'button',
            {
              class: 'sm',
              onclick: () => {
                const b = s.else;
                const steps = Array.isArray(r.blocks[b]) ? r.blocks[b] : [];
                const others = allStepsOf(r).filter((x) => x !== s && childBlocks(x).some(([, y]) => y === b));
                if (steps.length && !others.length && !confirm(`"아니면" 블록의 스텝 ${steps.length}개도 지울까요?`)) return;
                if (!others.length && b !== entryOf(r)) {
                  const { blocks } = deletionPlan(r, steps.map((x) => x?.id).filter(Boolean));
                  for (const x of blocks) delete r.blocks[x];
                  delete r.blocks[b];
                }
                delete s.else;
                ed.markDirty();
                ed.draw();
              },
            },
            '아니면 블록 빼기',
          ),
        ]
      : h(
          'button',
          {
            class: 'sm',
            onclick: () => {
              const name = blockName(r, '아니면');
              r.blocks[name] = [];
              s.else = name;
              ed.markDirty();
              ed.draw();
            },
          },
          '＋ 아니면 블록 추가',
        ),
  );
}

// =====================================================================
// 스텝 추가
// =====================================================================
export function addBar(ed) {
  const r = ed.recipe;
  const sel = h(
    'select',
    { style: 'width:auto;max-width:100%', 'aria-label': '추가할 스텝 종류' },
    h('optgroup', { label: '스텝' }, ADDABLE.filter((a) => !a.flow).map((a) => h('option', { value: a.key }, a.label))),
    h('optgroup', { label: '반복·조건' }, ADDABLE.filter((a) => a.flow).map((a) => h('option', { value: a.key }, a.label))),
  );
  const into = ed.addAt && Array.isArray(r.blocks[ed.addAt.block]) ? ed.addAt.block : null;
  return h(
    'div',
    { class: 'card flat row add-bar' },
    h('b', null, '스텝 추가'),
    sel,
    h('button', { onclick: () => addStep(ed, sel.value) }, '＋ 추가'),
    h('span', { class: 'muted small' }, into ? `"${into}" 블록 안(끝)에 들어갑니다.` : '펼쳐 둔 스텝 바로 뒤(없으면 맨 끝)에 들어갑니다.'),
    into ? h('button', { class: 'sm ghost', onclick: () => ((ed.addAt = null), ed.draw()) }, '취소') : null,
  );
}

/** 이 블록을 감싼 가장 안쪽 반복의 번호 토큰 (목록의 항목마다 → item.index, 반복 → loop.index, 반복 밖 → '') */
function loopTokenOf(r, block, seen = new Set()) {
  if (seen.has(block)) return '';
  seen.add(block);
  for (const [b, steps] of Object.entries(r.blocks ?? {})) {
    if (!Array.isArray(steps)) continue;
    for (const s of steps) {
      if (!childBlocks(s).some(([, x]) => x === block)) continue;
      if (s.type === 'forEach') return 'item.index';
      if (s.type === 'repeat') return 'loop.index';
      return loopTokenOf(r, b, seen); // 분기 안이면 그 분기가 든 블록을 본다
    }
  }
  return '';
}

function addStep(ed, key) {
  const def = ADDABLE.find((a) => a.key === key);
  if (!def) return;
  const r = ed.recipe;
  const entry = entryOf(r);
  r.blocks[entry] ??= [];
  let block = entry;
  let at = r.blocks[entry].length;
  if (ed.addAt && Array.isArray(r.blocks[ed.addAt.block])) {
    block = ed.addAt.block;
    at = r.blocks[block].length;
  } else if (ed.openId) {
    const f = findStep(r, ed.openId);
    if (f) {
      block = f.block;
      at = f.index + 1;
    }
  }
  const step = { ...def.make(r), id: idMaker(r)() };
  // 반복 안에 넣는 화면 캡처·PDF 는 항목(반복)마다 다른 파일 이름이 되게 번호를 붙인다
  const tok = loopTokenOf(r, block);
  if (tok && (step.type === 'screenshot' || step.type === 'pdf') && step.fileName && !step.fileName.includes(`{{${tok}}}`)) step.fileName = step.fileName.replace(/(\.[a-z]+)$/i, `_{{${tok}}}$1`);
  if (def.block) {
    const [key2, base] = def.block;
    const name = blockName(r, base);
    r.blocks[name] = [];
    step[key2] = name;
  }
  r.blocks[block].splice(at, 0, step);
  ed.openId = step.id;
  ed.addAt = null;
  ed.markDirty();
  ed.draw();
}
