// 레시피 편집기 화면: 머리(저장·실행·내보내기·AI), 탭(스텝 트리 · 변수·엑셀 · JSON).
// 스텝 탭은 editor-steps.js, 변수 탭·입력값 정리는 editor-vars.js, 조건 편집기는 editor-cond.js, {{ 자동완성은 editor-input.js.

import { h, add, mount, toast, api, safely, download } from '/ui.js';
import { setAiRecipe, setAiContext, setAiEditor, toggleAi } from '/ai-panel.js';
import { stepsTab, problemsNotice } from '/editor-steps.js';
import { varsTab, openInputTidy } from '/editor-vars.js';
import { loginSteps, wrapLogin, stepNumbers } from '/shared/recipe-edit.js';

const LOGIN_HINT_KEY = (id) => `rpa:loginHint:${id}`; // "로그인 화면일 때만" 안내를 닫은 레시피

function storage(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback; // 저장 불가 환경
  }
}

/**
 * 로그인부터 녹화한 레시피: 엑셀 여러 행을 돌리면 2행부터는 이미 로그인돼 있어 로그인 화면이 없다 →
 * 로그인 스텝을 "아이디 칸이 있으면(로그인 화면일 때만)" 분기로 묶자는 안내 (한 번 누르면 묶인다)
 */
function loginNotice(ed, { recorded }) {
  const g = loginSteps(ed.recipe);
  if (!g || (!recorded && storage(() => localStorage.getItem(LOGIN_HINT_KEY(ed.recipe.id)), null) === 'off')) return null;
  const nums = stepNumbers(ed.recipe);
  const nos = g.stepIds.map((id) => nums.get(id) ?? id);
  const range = nos.length > 1 ? `${nos[0]}~${nos.at(-1)}` : nos[0];
  const wrapNow = () => {
    const next = structuredClone(ed.recipe);
    try {
      const { stepId } = wrapLogin(next);
      ed.recipe = next;
      ed.openId = stepId;
      ed.markDirty();
      ed.draw();
      toast('로그인 단계를 "로그인 화면일 때만" 으로 묶었습니다 — 저장을 눌러 주세요.');
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  const later = () => {
    storage(() => localStorage.setItem(LOGIN_HINT_KEY(ed.recipe.id), 'off'));
    ed.loginHintOff = true;
    ed.draw();
  };
  return h(
    'div',
    { class: 'notice info login-hint' },
    h('b', null, '로그인 단계가 있습니다'),
    // 휴대폰에서는 한 줄 요약만 (긴 설명은 넓은 화면에서) — 스텝 목록이 첫 화면에 보이게
    h('span', { class: 'lh-short' }, ` (${range}) — 2행부터 실패할 수 있어요.`),
    h('span', { class: 'lh-long' }, ` (${range}). 엑셀 여러 행을 실행하면 2행부터는 이미 로그인돼 있어 로그인 화면이 나오지 않으므로 이 단계에서 실패합니다. "아이디" 칸이 보일 때(로그인 화면일 때)만 로그인하게 묶을까요?`),
    h('div', { class: 'row login-hint-actions' }, h('button', { class: 'sm primary', onclick: wrapNow }, '로그인 화면일 때만 하도록 묶기'), h('button', { class: 'sm ghost', onclick: later }, '이대로 두기')),
  );
}

/**
 * @param {HTMLElement} app 화면 자리
 * @param {string} id 레시피 id
 * @param {{ openSetWizard: (id: string) => void, setLimitText: (origin: object) => string, onCleanup: (fn: () => void) => void }} hooks
 */
export async function editorPage(app, id, { openSetWizard, setLimitText, onCleanup, params }) {
  const recorded = params?.get?.('recorded') === '1'; // 녹화를 막 끝내고 왔다
  let data;
  try {
    data = await api('GET', `/api/recipes/${id}`);
  } catch (e) {
    add(app, h('div', { class: 'card notice bad' }, e.message));
    return;
  }
  const root = h('div', { class: 'editor' });
  add(app, root);
  const saveBtn = h('button', { class: 'primary', onclick: () => ed.save(), disabled: true }, '저장');

  /** 편집기 상태: 화면 모듈들이 함께 본다 */
  const ed = {
    recipe: data.recipe,
    problems: data.problems,
    dirty: false,
    tab: 'steps',
    openId: null,
    selected: new Set(),
    query: '',
    kind: '',
    state: '',
    addAt: null,
    newVar: false,
    heads: new Map(),
    onSelect: null,
    markDirty() {
      ed.dirty = true;
      saveBtn.disabled = false;
      saveBtn.textContent = '저장 *';
    },
    /** 값 칸을 고쳤을 때: 저장 표시 + 그 스텝의 한 줄 설명만 새로 (화면 전체는 그대로) */
    changed(stepId) {
      ed.markDirty();
      if (stepId) ed.heads.get(stepId)?.();
    },
    save: safely(async () => {
      const r = await api('PUT', `/api/recipes/${ed.recipe.id}`, ed.recipe);
      ed.recipe = r.recipe;
      ed.problems = r.problems;
      ed.dirty = false;
      toast(ed.problems.length ? `저장했습니다. 고칠 점 ${ed.problems.length}개가 있습니다.` : '저장했습니다.');
      draw();
    }),
    draw: () => draw(),
    /** 스텝 탭으로 가서 그 스텝을 펼치고 보이게 한다 */
    goToStep(stepId) {
      ed.tab = 'steps';
      ed.query = '';
      ed.kind = '';
      ed.state = '';
      ed.openId = stepId;
      draw();
      const el = [...document.querySelectorAll('.step[data-step]')].find((x) => x.dataset.step === stepId);
      el?.scrollIntoView({ block: 'center' });
    },
    openInputs: () => openInputTidy(ed),
  };

  window.onbeforeunload = () => (ed.dirty ? '저장하지 않은 변경이 있습니다.' : undefined);
  storage(() => localStorage.setItem('rpa:lastRecipe', ed.recipe.id)); // 위 메뉴 [실행] 이 이 레시피를 고른 채 열리게
  setAiRecipe(ed.recipe.id, { name: ed.recipe.name });
  if (recorded && loginSteps(ed.recipe)) setTimeout(() => toast('녹화에 로그인 단계가 있습니다 — 위 안내에서 "로그인 화면일 때만" 으로 묶을 수 있습니다.'), 300);
  setAiEditor({
    recipeId: ed.recipe.id,
    getRecipe: () => ed.recipe,
    applyRecipe: (next) => {
      ed.recipe = { ...next, id: ed.recipe.id };
      ed.markDirty();
      draw();
      toast('AI 제안을 적용했습니다. 확인 후 저장을 눌러 주세요.');
    },
  });
  onCleanup(() => {
    window.onbeforeunload = null;
    setAiEditor(null);
  });
  const stepCount = () => Object.values(ed.recipe.blocks ?? {}).reduce((n, s) => n + (Array.isArray(s) ? s.length : 0), 0);

  function draw() {
    const recipe = ed.recipe;
    const nameIn = h('input', { type: 'text', value: recipe.name, oninput: (e) => ((ed.recipe.name = e.target.value), ed.markDirty()) });
    const urlIn = h('input', { type: 'text', value: recipe.startUrl ?? '', oninput: (e) => ((ed.recipe.startUrl = e.target.value), ed.markDirty()) });
    saveBtn.disabled = !ed.dirty;
    saveBtn.textContent = ed.dirty ? '저장 *' : '저장';
    setAiContext({ openStepId: ed.openId ?? undefined });
    const guarded = (msg, go) => async () => {
      if (ed.dirty) {
        if (!confirm(msg)) return;
        await ed.save();
        if (ed.dirty) return; // 저장 실패
      }
      go();
    };
    mount(
      root,
      h(
        'div',
        { class: 'page-head' },
        h('a', { href: '#/recipes', class: 'muted' }, '← 레시피'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'ai-btn', onclick: () => toggleAi() }, '✦ AI 도우미'),
        h('button', { onclick: () => download(`${ed.recipe.name}.json`, JSON.stringify(ed.recipe, null, 2)) }, '내보내기'),
        h('button', { onclick: guarded('저장하지 않은 변경이 있습니다. 저장한 뒤 세트로 내보낼까요?', () => openSetWizard(ed.recipe.id)) }, '세트로 내보내기'),
        h('button', { onclick: guarded('저장하지 않은 변경이 있습니다. 저장하고 실행 화면으로 갈까요?', () => (location.hash = `#/run?recipe=${ed.recipe.id}`)) }, '▶ 실행하기'),
        saveBtn,
      ),
      h('div', { class: 'card grid2' }, h('label', { class: 'field' }, h('span', null, '레시피 이름'), nameIn), h('label', { class: 'field' }, h('span', null, '시작 주소'), urlIn)),
      problemsNotice(ed),
      ed.loginHintOff ? null : loginNotice(ed, { recorded }),
      recipe.origin ? h('div', { class: 'notice info small' }, setLimitText(recipe.origin), ' 제한은 JSON 탭의 origin 에 있습니다.') : null,
      h(
        'div',
        { class: 'tabs' },
        [
          ['steps', `스텝 (${stepCount()})`],
          ['vars', `변수·엑셀 (${recipe.variables?.length ?? 0})`],
          ['json', 'JSON'],
        ].map(([k, label]) => h('button', { class: ed.tab === k ? 'active' : '', onclick: () => ((ed.tab = k), draw()) }, label)),
      ),
      ed.tab === 'steps' ? stepsTab(ed) : ed.tab === 'vars' ? varsTab(ed) : jsonTab(),
    );
  }

  function jsonTab() {
    const ta = h('textarea', { class: 'json', spellcheck: 'false' });
    ta.value = JSON.stringify(ed.recipe, null, 2);
    return h(
      'div',
      { class: 'card stack' },
      h('p', { class: 'muted small', style: 'margin:0' }, '레시피 전체를 JSON 으로 보고 고칠 수 있습니다. 반복·조건 분기·블록은 스텝 탭에서도 만들고 고칠 수 있습니다.'),
      ta,
      h(
        'div',
        null,
        h(
          'button',
          {
            class: 'primary',
            onclick: () => {
              try {
                const parsed = JSON.parse(ta.value);
                if (!parsed.blocks) throw new Error('blocks 가 없습니다.');
                parsed.id = ed.recipe.id;
                ed.recipe = parsed;
                ed.markDirty();
                toast('적용했습니다. 저장을 눌러 주세요.');
                draw();
              } catch (e) {
                toast(`JSON 오류: ${e.message}`, 'error');
              }
            },
          },
          'JSON 적용',
        ),
      ),
    );
  }

  draw();
}
