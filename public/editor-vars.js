// 편집기 변수 탭: 변수는 이름 하나(이름을 바꾸면 참조까지), 쓰는 곳(누르면 그 스텝으로), 안 쓰는 변수, 지울 때 확인.
// 비밀 변수에는 기본값 칸이 없다(저장은 실행 화면에서). 그리고 녹화 입력을 한 표에서 정리하는 "입력값 정리" 화면.

import { h, mount, field, toast, safely, api, uploadFile } from '/ui.js';
import { STEP_LABELS } from '/shared/steps.js';
import { variableUsages, renameVariable, findStep, inputSteps, applyInputModes, isReservedName } from '/shared/recipe-edit.js';
import { valueInput } from '/editor-input.js';

const KINDS = [
  ['excel', '엑셀 열'],
  ['static', '고정값'],
  ['prompt', '실행할 때 입력'],
  ['secret', '비밀값 (실행할 때 입력)'],
];
const kindOf = (v) => (v?.source?.kind === 'prompt' && v.source.secret ? 'secret' : (v?.source?.kind ?? 'static'));
const nameOf = (v) => v?.name || v?.id || '';
const FIELD_WORDS = { url: '주소', fileName: '파일 이름', path: '파일 경로', message: '메시지', promptText: '입력할 글자', condition: '조건', while: '반복 조건', until: '반복 조건', items: '목록', key: '키', label: '선택 이름', target: '대상', saveAs: '값 읽기' };

/** 변수 종류를 바꾼다 (비밀로 바꾸면 기본값을 지운다) */
function setKind(recipe, v, k) {
  const s = v.source ?? {};
  if (k === 'excel') v.source = { kind: 'excel', column: s.column || nameOf(v) };
  else if (k === 'static') v.source = { kind: 'static', value: s.kind === 'prompt' && !s.secret ? (s.default ?? '') : (s.value ?? '') };
  else if (k === 'prompt') v.source = { kind: 'prompt', ...(s.kind === 'static' && s.value ? { default: s.value } : s.kind === 'prompt' && !s.secret && s.default ? { default: s.default } : {}) };
  else {
    v.source = { kind: 'prompt', secret: true };
    // 비밀 변수를 쓰는 입력의 녹화 값도 남기지 않는다
    for (const st of Object.values(recipe.blocks ?? {}).flat()) {
      const m = /^\s*\{\{\s*([^{}|]+?)\s*(\|[^{}]*)?\}\}\s*$/.exec(String(st?.value ?? ''));
      if (st?.meta && m && [v.id, v.name].includes(m[1])) delete st.meta.recordedValue;
    }
  }
}

/** 새 이름으로 쓸 수 없으면 그 까닭 */
function nameProblem(recipe, name, self) {
  if (!name) return '이름을 넣어 주세요.';
  if (/[{}|]/.test(name)) return '이름에 {, }, | 는 쓸 수 없습니다.';
  if (isReservedName(name)) return `"${name}" 은(는) 예약된 이름이라 쓸 수 없습니다 (row, sys:…, item.…, loop.…).`;
  if ((recipe.variables ?? []).some((v) => v !== self && (v?.id === name || v?.name === name))) return `"${name}" 이름의 변수가 이미 있습니다.`;
  if (Object.values(recipe.blocks ?? {}).flat().some((s) => s?.type === 'extract' && String(s.saveAs ?? '').trim() === name)) return `"${name}" 은(는) 값 읽기 스텝이 이미 쓰는 이름입니다.`;
  return '';
}

/** 쓰는 곳 한 줄 이름: "#3 입력", "#7 파일 이름" */
function useLabel(recipe, u) {
  if (!u.stepId) return `변수 ${u.varId} 의 값`;
  const s = findStep(recipe, u.stepId)?.step;
  const top = String(u.field ?? '').split('.')[0];
  const word = top === 'value' ? (STEP_LABELS[s?.type] ?? '값') : (FIELD_WORDS[top] ?? STEP_LABELS[s?.type] ?? top);
  return `${u.no || u.stepId} ${word}${u.disabled ? ' (꺼짐)' : ''}`;
}
/** 변수 하나의 쓰는 곳 (id·이름 둘 다, 같은 칸은 한 번) */
function usesOf(recipe, uses, v) {
  const out = [];
  const seen = new Set();
  for (const key of new Set([v.id, v.name].filter(Boolean))) {
    for (const u of uses[key] ?? []) {
      const sig = `${u.stepId}|${u.field}|${u.varId ?? ''}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push({ ...u, label: useLabel(recipe, u) });
    }
  }
  return out;
}

/** 비밀 변수의 "이 PC 에 저장됨" 표시 (실행 화면에서 저장한 값) */
function secretStateText(ed, v) {
  const x = ed.secretInfo?.get(v.id);
  if (!ed.secretInfo) return '';
  if (!x?.saved) return '지금은 이 PC 에 저장된 값이 없습니다 (실행할 때 묻습니다).';
  const at = x.savedAt ? new Date(x.savedAt) : null;
  return `●●●● 이 PC 에 저장됨${at && !Number.isNaN(at.getTime()) ? ` (${at.getMonth() + 1}/${at.getDate()})` : ''}`;
}
/** 저장 상태를 한 번 불러와 표시를 고친다 (비밀 변수가 있을 때만 부른다) */
function loadSecretState(ed) {
  if (ed.secretLoading || ed.secretInfo || !ed.recipe?.id || !(ed.recipe.variables ?? []).some((v) => kindOf(v) === 'secret')) return;
  ed.secretLoading = true;
  api('GET', `/api/recipes/${encodeURIComponent(ed.recipe.id)}/secrets`)
    .then((list) => (ed.secretInfo = new Map((Array.isArray(list) ? list : []).map((x) => [x.varId, x]))))
    .catch(() => (ed.secretInfo = new Map()))
    .finally(() => {
      ed.secretLoading = false;
      for (const el of document.querySelectorAll('.secret-state[data-secret]')) {
        const v = (ed.recipe.variables ?? []).find((x) => x.id === el.dataset.secret);
        if (v) el.textContent = secretStateText(ed, v);
      }
    });
}

// =====================================================================
// 변수 탭
// =====================================================================
export function varsTab(ed) {
  const r = ed.recipe;
  r.variables ??= [];
  loadSecretState(ed);
  const uses = variableUsages(r);
  const linkInput = h('input', {
    type: 'file',
    accept: '.xlsx,.csv',
    style: 'display:none',
    onchange: safely(async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      if (ed.dirty) await ed.save();
      const up = await uploadFile(f);
      const { recipe: linked, linked: links } = await api('POST', `/api/recipes/${ed.recipe.id}/autolink`, { uploadId: up.id });
      if (!links.length) return toast('첫 행 값과 똑같은 입력값을 찾지 못했습니다. "입력값 정리" 에서 엑셀 열을 골라 주세요.');
      ed.recipe = linked;
      ed.markDirty();
      toast(`${links.length}개 입력을 엑셀 열에 연결했습니다: ${links.map((l) => l.column).join(', ')} — 저장을 눌러 주세요.`);
      ed.draw();
    }),
  });
  const defined = new Set(r.variables.flatMap((v) => [v?.id, v?.name]).filter(Boolean));
  const saveAs = new Set(Object.values(r.blocks ?? {}).flat().filter((s) => s?.type === 'extract').map((s) => String(s.saveAs ?? '').trim()));
  const loose = Object.entries(uses).filter(([n, list]) => !defined.has(n) && !saveAs.has(n) && !isReservedName(n) && list.some((u) => u.stepId));
  return h(
    'div',
    null,
    h(
      'div',
      { class: 'card' },
      h('h2', null, '엑셀 연결'),
      h('p', { class: 'muted small', style: 'margin-top:0' }, '녹화한 입력을 엑셀 열·실행 때 입력·비밀로 한 번에 바꾸려면 "입력값 정리" 를 누르세요. 첫 거래처 값으로 녹화했다면 그 값이 든 엑셀을 올려 같은 값의 입력을 자동으로 {{열 이름}} 으로 바꿀 수도 있습니다 (한 열에서만 일치할 때).'),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => ed.openInputs() }, '입력값 정리'), linkInput, h('button', { onclick: () => linkInput.click() }, '엑셀 첫 행으로 자동 연결'), h('a', { class: 'btn', href: `/api/recipes/${r.id}/template` }, '입력 양식 받기')),
    ),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'row', style: 'margin-bottom:10px' }, h('h2', { style: 'margin:0' }, '변수'), h('div', { style: 'flex:1' }), h('button', { class: 'sm', onclick: () => ((ed.newVar = true), ed.draw()) }, '＋ 변수 추가')),
      ed.newVar ? newVarForm(ed) : null,
      r.variables.length ? h('div', { class: 'var-list' }, r.variables.map((v, i) => varItem(ed, v, i, usesOf(r, uses, v)))) : h('p', { class: 'muted' }, '변수가 없습니다.'),
      loose.length
        ? h(
            'div',
            { class: 'notice info small loose-names' },
            h('b', null, '변수로 만들지 않고 쓰는 이름'),
            ' — 실행할 때 같은 이름의 엑셀 열 값을 넣습니다.',
            h(
              'ul',
              null,
              loose.map(([n, list]) =>
                h(
                  'li',
                  null,
                  h('code', null, `{{${n}}}`),
                  ' ',
                  list.filter((u) => u.stepId).map((u) => h('button', { class: 'link', onclick: () => ed.goToStep(u.stepId) }, useLabel(r, u))),
                  ' ',
                  h(
                    'button',
                    {
                      class: 'sm',
                      onclick: () => {
                        r.variables.push({ id: n, name: n, source: { kind: 'excel', column: n } });
                        ed.markDirty();
                        ed.draw();
                      },
                    },
                    '엑셀 열 변수로 만들기',
                  ),
                ),
              ),
            ),
          )
        : null,
      h(
        'p',
        { class: 'muted small' },
        '그 밖에 쓸 수 있는 값: ',
        h('code', null, '{{row}}'),
        ' 행 번호, ',
        h('code', null, '{{sys:date:YYYYMMDD}}'),
        ' 오늘 날짜, ',
        h('code', null, '{{sys:month:-1}}'),
        ' 지난달, ',
        h('code', null, '{{sys:quarter}}'),
        ' 분기, ',
        h('code', null, '{{값이름|digits}}'),
        ' 숫자만. 값 칸에서 ',
        h('code', null, '{{'),
        ' 를 치면 고를 수 있습니다.',
      ),
    ),
  );
}

function varItem(ed, v, i, list) {
  const r = ed.recipe;
  const name = nameOf(v);
  const kind = kindOf(v);
  const src = v.source ?? (v.source = { kind: 'static', value: '' });
  let done = false;
  const nameIn = h('input', { type: 'text', class: 'var-name', value: name, 'aria-label': '변수 이름' });
  const commit = () => {
    if (done) return;
    const to = nameIn.value.trim();
    if (to === name) return;
    const bad = nameProblem(r, to, v);
    const next = structuredClone(r);
    try {
      if (bad) throw new Error(bad);
      const n = renameVariable(next, v.id || name, to);
      done = true;
      ed.recipe = next;
      ed.markDirty();
      ed.draw();
      toast(`이름을 "${to}"(으)로 바꿨습니다. 쓰는 곳 ${n}군데도 함께 바꿨습니다.`);
    } catch (e) {
      nameIn.value = name;
      toast(e.message, 'error');
    }
  };
  nameIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') nameIn.value = name;
  });
  nameIn.addEventListener('change', commit);
  const kindSel = h(
    'select',
    {
      'aria-label': '변수 종류',
      onchange: (e) => {
        setKind(r, v, e.target.value);
        ed.markDirty();
        ed.draw();
      },
    },
    KINDS.map(([k, label]) => h('option', { value: k, selected: k === kind }, label)),
  );
  const detail =
    kind === 'excel'
      ? field('엑셀 열 이름', valueInput(ed, src, 'column', { label: '엑셀 열 이름' }))
      : kind === 'static'
        ? field('값', valueInput(ed, src, 'value', { auto: true, label: '고정값' }))
        : kind === 'prompt'
          ? field('미리 채울 값 (비워도 됨)', valueInput(ed, src, 'default', { label: '미리 채울 값' }))
          : h(
              'p',
              { class: 'muted small secret-note' },
              '레시피에는 저장하지 않습니다. 비밀값은 실행 화면에서 이 PC 에 저장할 수 있습니다. ',
              h('span', { class: 'secret-state', 'data-secret': v.id }, secretStateText(ed, v)),
            );
  const remove = () => {
    if (list.length && !confirm(`"${name}" 변수를 ${list.map((u) => u.label).join(', ')} 에서 씁니다.\n지우면 이 스텝들은 값을 찾지 못해 "고칠 점" 이 됩니다. 그래도 지울까요?`)) return;
    r.variables.splice(i, 1);
    ed.markDirty();
    ed.draw();
    toast(`"${name}" 변수를 지웠습니다.`);
  };
  return h(
    'div',
    { class: 'var-item', 'data-var': name },
    h(
      'div',
      { class: 'row var-top' },
      h('code', { class: 'var-token' }, `{{${name}}}`),
      list.length ? null : h('span', { class: 'badge warn' }, '안 쓰는 변수'),
      h('div', { style: 'flex:1' }),
      h('button', { class: 'sm danger', onclick: remove }, '삭제'),
    ),
    h('div', { class: 'var-grid' }, field('이름 (바꾸면 쓰는 곳도 함께 바뀝니다)', nameIn), field('종류', kindSel), h('div', { class: 'var-detail' }, detail)),
    h(
      'div',
      { class: 'var-uses' },
      h('span', { class: 'muted small' }, '쓰는 곳: '),
      list.length
        ? list.map((u) => (u.stepId ? h('button', { class: 'sm use-chip', title: '이 스텝으로 가기', onclick: () => ed.goToStep(u.stepId) }, u.label) : h('span', { class: 'badge' }, u.label)))
        : h('span', { class: 'muted small' }, '없음 — 어느 스텝도 쓰지 않습니다.'),
    ),
  );
}

function newVarForm(ed) {
  const r = ed.recipe;
  const nameIn = h('input', { type: 'text', placeholder: '예: 사업자번호', 'aria-label': '새 변수 이름' });
  const kindSel = h('select', { 'aria-label': '새 변수 종류' }, KINDS.map(([k, label]) => h('option', { value: k, selected: k === 'excel' }, label)));
  const msg = h('div', { class: 'muted small' }, '이름을 먼저 정하세요. 스텝의 값 칸에서는 {{이름}} 으로 씁니다.');
  const create = () => {
    const name = nameIn.value.trim();
    const bad = nameProblem(r, name);
    if (bad) {
      msg.textContent = bad;
      msg.className = 'small warn-text';
      nameIn.focus();
      return;
    }
    const v = { id: name, name, source: {} };
    setKind(r, v, kindSel.value);
    r.variables.push(v);
    ed.newVar = false;
    ed.markDirty();
    ed.draw();
    toast(`"${name}" 변수를 만들었습니다.`);
  };
  nameIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      create();
    } else if (e.key === 'Escape') {
      ed.newVar = false;
      ed.draw();
    }
  });
  setTimeout(() => nameIn.focus());
  return h(
    'div',
    { class: 'var-new' },
    h('div', { class: 'var-grid' }, field('새 변수 이름', nameIn), field('종류', kindSel), h('div', { class: 'row', style: 'align-self:end' }, h('button', { class: 'primary sm', onclick: create }, '만들기'), h('button', { class: 'sm', onclick: () => ((ed.newVar = false), ed.draw()) }, '취소'))),
    msg,
  );
}

// =====================================================================
// 입력값 정리: 녹화 입력 한 표 → 그대로 / 엑셀 열 / 실행 때 입력 / 비밀 → 모두 적용
// =====================================================================
const MODES = [
  ['fixed', '그대로'],
  ['excel', '엑셀 열'],
  ['prompt', '실행 때 입력'],
  ['secret', '비밀'],
];
const MODE_WORD = { fixed: '그대로', excel: '엑셀 열', prompt: '실행 때 입력', secret: '비밀', mixed: '직접 고친 값' };
const cleanLabel = (s) =>
  String(s ?? '')
    .replace(/[{}|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);

export function openInputTidy(ed) {
  const rows = inputSteps(ed.recipe);
  const state = new Map(rows.map((r) => [r.stepId, { mode: r.mode === 'mixed' ? null : r.mode, name: '', touched: false }]));
  const defaultName = (r, mode) => (r.mode === mode && r.varName ? r.varName : cleanLabel(r.label) || '입력');
  const summary = h('div', { class: 'muted small tidy-sum' });
  const showSummary = () => {
    const count = {};
    for (const r of rows) {
      const m = state.get(r.stepId).mode ?? 'mixed';
      count[m] = (count[m] ?? 0) + 1;
    }
    summary.textContent = `입력 ${rows.length}개 · ${Object.entries(count)
      .map(([m, n]) => `${MODE_WORD[m]} ${n}`)
      .join(' · ')}`;
  };
  const errBox = h('div');
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && document.body.contains(back) && !e.defaultPrevented) close();
  };
  const rowEl = (r) => {
    const c = state.get(r.stepId);
    const shownRec = (m) => (r.mode === 'secret' || m === 'secret' ? '●●●●' : r.recordedValue === '' ? '(없음)' : r.recordedValue);
    const recEl = h('code', { class: 'tidy-rec' }, shownRec(c.mode));
    // 목록 선택은 내부 값(H1) 대신 보이는 글자(2026년 1기 …)를 먼저 보인다
    const st = findStep(ed.recipe, r.stepId)?.step;
    const selLabel = r.type === 'select' && st?.label && !r.value.includes('{{') ? String(st.label) : '';
    // 비밀로 고른 칸은 지금 값도 가린다 (녹화한 글자 그대로인 경우)
    const shownNow = (m) => (m === 'secret' && r.value !== '' && !r.value.includes('{{') ? '●●●●' : r.value === '' ? '(빈 값)' : selLabel && selLabel !== r.value ? `${selLabel} (값 ${r.value})` : r.value);
    const nowEl = h('code', { class: 'tidy-now' }, shownNow(c.mode));
    const example = selLabel || (r.recordedValue && !r.recordedValue.includes('{{') ? r.recordedValue : '');
    const selHint = r.type === 'select' ? h('div', { class: 'muted small tidy-hint', hidden: c.mode !== 'excel' }, `엑셀에는 목록에 보이는 글자${example ? `(예: ${example})` : ''}를 적으세요. 목록의 값${r.value && !r.value.includes('{{') && r.value !== example ? `(${r.value})` : ''}을 적어도 됩니다.`) : null;
    const nameLabel = h('span', null, c.mode === 'excel' ? '엑셀 열 이름' : '변수 이름');
    const nameIn = h('input', {
      type: 'text',
      class: 'tidy-name',
      value: c.mode && c.mode !== 'fixed' ? defaultName(r, c.mode) : '',
      'aria-label': `${r.no} 이름`,
      oninput: (e) => {
        c.name = e.target.value;
        c.touched = true;
      },
    });
    const nameField = h('label', { class: 'field tidy-name-field', hidden: !c.mode || c.mode === 'fixed' }, nameLabel, nameIn);
    const noLiteral = r.mode !== 'fixed' && r.recordedValue === '';
    const radios = MODES.map(([m, label]) =>
      h(
        'label',
        { class: `check tidy-mode${m === 'secret' ? ' secret' : ''}`, title: m === 'fixed' && noLiteral ? '녹화 값이 없어 그대로 둘 수 없습니다' : undefined },
        h('input', {
          type: 'radio',
          name: `tidy-${r.stepId}`,
          value: m,
          checked: c.mode === m,
          disabled: m === 'fixed' && noLiteral,
          onchange: () => {
            c.mode = m;
            if (!c.touched) nameIn.value = m === 'fixed' ? '' : defaultName(r, m);
            nameField.hidden = m === 'fixed';
            if (selHint) selHint.hidden = m !== 'excel';
            nameLabel.textContent = m === 'excel' ? '엑셀 열 이름' : '변수 이름';
            recEl.textContent = shownRec(m);
            nowEl.textContent = shownNow(m);
            showSummary();
          },
        }),
        label,
      ),
    );
    const isPw = findStep(ed.recipe, r.stepId)?.step?.target?.meta?.type === 'password';
    return h(
      'div',
      { class: `tidy-row${r.disabled ? ' off' : ''}`, 'data-step': r.stepId },
      h(
        'div',
        { class: 'tidy-info' },
        h('b', { class: 'tidy-no' }, r.no),
        h('span', { class: 'tidy-label' }, r.label),
        h('span', { class: 'badge' }, r.type === 'select' ? '목록 선택' : '입력'),
        isPw ? h('span', { class: 'badge warn' }, '비밀번호 칸') : null,
        r.disabled ? h('span', { class: 'badge' }, '꺼짐') : null,
        r.mode === 'mixed' ? h('span', { class: 'badge warn', title: '여러 값을 섞어 쓴 칸입니다. 고르면 그 방식으로 바뀝니다.' }, '직접 고친 값') : null,
      ),
      h('div', { class: 'tidy-vals' }, h('div', null, h('span', { class: 'muted small' }, '녹화 때 값 '), recEl), h('div', null, h('span', { class: 'muted small' }, '지금 값 '), nowEl)),
      h('div', { class: 'tidy-modes', role: 'radiogroup', 'aria-label': `${r.no} 이렇게 쓰기` }, radios),
      h('div', { class: 'tidy-name-box' }, nameField, selHint),
    );
  };
  const applyAll = () => {
    const decisions = [];
    for (const r of rows) {
      const c = state.get(r.stepId);
      if (!c.mode) continue;
      const name = c.touched ? cleanLabel(c.name) : '';
      if (c.mode === r.mode && !(name && name !== (r.varName ?? ''))) continue;
      decisions.push({ stepId: r.stepId, mode: c.mode, ...(name && c.mode !== 'fixed' ? { name } : {}) });
    }
    if (!decisions.length) return toast('바꿀 입력이 없습니다.');
    const next = structuredClone(ed.recipe);
    try {
      const res = applyInputModes(next, decisions);
      ed.recipe = next;
      ed.markDirty();
      close();
      ed.draw();
      toast(`입력 ${res.changed.length}개를 바꿨습니다${res.variables.length ? ` (변수: ${res.variables.join(', ')})` : ''}. 저장을 눌러 주세요.`);
    } catch (e) {
      mount(errBox, h('div', { class: 'notice warn' }, e.message));
    }
  };
  const back = h(
    'div',
    { class: 'modal-back' },
    h(
      'div',
      { class: 'modal tidy', role: 'dialog', 'aria-modal': 'true', 'aria-label': '입력값 정리' },
      h('div', { class: 'row modal-head' }, h('h2', { style: 'margin:0' }, '입력값 정리'), h('div', { style: 'flex:1' }), h('button', { class: 'ghost icon', title: '닫기', onclick: close }, '✕')),
      h('p', { class: 'muted small', style: 'margin-top:0' }, '녹화한 입력을 한 곳에서 보고, 칸마다 값을 어떻게 넣을지 고른 뒤 [모두 적용] 을 누르세요. 엑셀 열은 실행할 때 엑셀의 그 열 값을, 실행 때 입력은 실행 화면에서 묻는 값을 넣습니다. 비밀은 화면에 가리고 레시피에 저장하지 않습니다.'),
      summary,
      h('div', { class: 'modal-body tidy-list' }, rows.length ? rows.map(rowEl) : h('p', { class: 'muted' }, '녹화한 입력·목록 선택 스텝이 없습니다.')),
      errBox,
      h('div', { class: 'modal-foot row' }, h('button', { class: 'primary', onclick: applyAll, disabled: !rows.length }, '모두 적용'), h('button', { onclick: close }, '닫기')),
    ),
  );
  showSummary();
  document.body.append(back);
  document.addEventListener('keydown', onKey, true);
}
