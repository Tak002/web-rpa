// 반복 점검: repeat·forEach(항목 안 찾기·뒤로 가기·값 모으기·토큰), 조건 6종, 반복 상한 경고, recipeProblems 새 검사,
// 공유 편집 도우미(recipe-edit.js), AI 관찰기 listTargetFor·항목 기준 targetFor·params(비밀값 가림). 실제 브라우저(숨김)로 돈다.
// 실행: node test/loop-check.mjs [--keep]   (결과: test/out-loop/ — --keep 이 없으면 끝날 때 지운다)

import fs from 'node:fs/promises';
import path from 'node:path';
import { Runner } from '../src/engine/runner.js';
import { Session } from '../src/engine/session.js';
import { Scope } from '../src/engine/vars.js';
import { checkCondition } from '../src/engine/conditions.js';
import { startBrowser } from '../src/browser.js';
import { recipeProblems } from '../src/recipe.js';
import { Observer } from '../src/ai/observer.js';
import { stepText, conditionText, targetName, targetText, withJosa, loopEndText } from '../public/shared/steps.js';
import { stepTree, stepNumbers, findStep, variableUsages, renameVariable, wrapSteps, unwrapStep, inputSteps, applyInputModes } from '../public/shared/recipe-edit.js';
import { listFromTarget, relativeToList, looksSingle, sameElementSteps, pagingOf, pagingRisk, makePaging, unmakePaging, loginSteps, wrapLogin } from '../public/shared/recipe-edit.js';
import { startLoopSite, COMPANIES, memoOf } from './loop-fixture/server.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'test', 'out-loop');
const KEEP = process.argv.includes('--keep');

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
  return !!ok;
}
const attempt = (f) => {
  try {
    return { value: f() };
  } catch (e) {
    return { error: e };
  }
};
const lines = (s) => String(s ?? '').split('\n');
const show = (v) => JSON.stringify(v)?.slice(0, 300);

// ---------- 타겟 ----------
const css = (value, score = 90) => ({ kind: 'css', value, score });
const xp = (value, score = 80) => ({ kind: 'xpath', value, score });
const txt = (tag, t, score = 75) => ({ kind: 'text', value: { tag, text: t }, score });
const tgt = (candidates, meta = {}) => ({ framePath: [], candidates, meta });
const inItem = (candidates, meta = {}) => ({ framePath: [], within: 'item', candidates, meta });
const ROWS = tgt([css('#result > tbody > tr', 90)], { tag: 'tr', label: '거래처 결과 표의 행' });
const NEXT = tgt([css('#next', 95), txt('button', '다음')], { tag: 'button', text: '다음' });
const CELL = (n, label) => inItem([css(`td:nth-child(${n})`, 80), xp(`./td[${n}]`, 60)], { tag: 'td', label });
let seq = 0;
const step = (type, fields = {}) => ({ id: `t${(seq += 1)}`, type, ...fields });
const recipeOf = (name, blocks, extra = {}) => ({ schemaVersion: 1, id: name, name, entryBlock: 'main', variables: [], blocks, ...extra });

async function run(name, recipe, params = {}) {
  const problems = recipeProblems(recipe);
  if (problems.length) throw new Error(`레시피 문제 (${name}): ${problems.join(' / ')}`);
  const runDir = path.join(OUT, `run-${name}`);
  await fs.rm(runDir, { recursive: true, force: true });
  const runner = new Runner({ recipe, runId: name, runDir, profileDir: path.join(OUT, 'profile'), params, options: { headless: true } });
  const report = await runner.start();
  const row = report.rows[0] ?? {};
  if (report.status !== 'done') console.log(`    (실행 ${name}: ${report.status} — ${row.error ?? report.error ?? ''})\n    ${runner.logLines.slice(-12).join('\n    ')}`);
  return { report, row, log: runner.logLines.join('\n') };
}

// =====================================================================
console.log('\n== 공유 편집 도우미 (recipe-edit.js)');
{
  const T = (label) => tgt([css('#x')], { tag: 'input', label });
  const base = () => ({
    name: '편집',
    entryBlock: 'main',
    variables: [
      { id: 'var1', name: '상호', source: { kind: 'excel' } },
      { id: '고정', name: '고정', source: { kind: 'static', value: '지점-{{상호}}' } },
      { id: '비번', name: '비번', source: { kind: 'prompt', secret: true } },
    ],
    blocks: {
      main: [
        { id: 's1', type: 'navigate', url: 'https://x/{{var1|trim}}' },
        { id: 's2', type: 'input', target: T('상호'), value: '{{상호}}', meta: { recordedValue: '가나상사' } },
        { id: 's3', type: 'input', target: T('비밀번호'), value: '{{비번}}' },
        { id: 's4', type: 'branch', condition: { kind: 'varContains', var: '상호', value: '상사' }, then: '맞음', else: '아님' },
        { id: 's5', type: 'repeat', body: '반복몸통', times: 2 },
        { id: 's6', type: 'select', target: T('기간'), value: 'P1', label: '1기' },
      ],
      맞음: [
        { id: 's7', type: 'sleep', ms: 1 },
        { id: 's8', type: 'input', target: T('메모'), value: '{{상호|upper}}-{{row}}' },
      ],
      아님: [{ id: 's9', type: 'sleep', ms: 1 }],
      반복몸통: [{ id: 's10', type: 'input', target: T('검색어'), value: '검색값' }],
      쓰지않음: [{ id: 's11', type: 'sleep', ms: 1 }],
    },
  });
  const tree = stepTree(base());
  const no = (id) => tree.find((n) => n.id === id)?.no;
  check('stepTree: 분기 then/else·반복 몸통을 부모 아래 번호로 (#4.2, #4.3, #5.1)', no('s8') === '#4.2' && no('s9') === '#4.3' && no('s10') === '#5.1' && no('s6') === '#6', show(tree.map((n) => `${n.no}:${n.id}`)));
  const s8 = tree.find((n) => n.id === 's8');
  check('stepTree: 깊이·부모·역할, 부르지 않는 블록은 끝에 #-', s8.depth === 1 && s8.parentId === 's4' && s8.role === 'then' && tree.at(-1).id === 's11' && tree.at(-1).orphan === true && tree.at(-1).no === '#-');
  check('stepNumbers·findStep (#4.2 와 s12 둘 다)', stepNumbers(base()).get('s10') === '#5.1' && findStep(base(), '#4.2')?.step.id === 's8' && findStep(base(), 's10')?.block === '반복몸통' && findStep(base(), '#9') === null);
  const uses = variableUsages(base());
  check(
    'variableUsages: {{이름|필터}}·조건 var·static 값까지',
    uses.상호?.length === 4 && uses.상호.some((u) => u.no === '#4' && u.field === 'condition.var') && uses.상호.some((u) => u.no === '#4.2' && u.field === 'value') && uses.var1?.[0]?.field === 'url' && uses.상호.some((u) => u.varId === '고정'),
    show(uses),
  );
  const r1 = base();
  const n = renameVariable(r1, '상호', '거래처');
  check(
    'renameVariable: 참조 수·필터 유지·id/name·엑셀 열 이름 유지',
    n === 5 && r1.blocks.main[0].url === 'https://x/{{거래처|trim}}' && r1.blocks.맞음[1].value === '{{거래처|upper}}-{{row}}' && r1.blocks.main[3].condition.var === '거래처' && r1.variables[0].id === '거래처' && r1.variables[0].source.column === '상호' && r1.variables[1].source.value === '지점-{{거래처}}',
    `${n} ${show(r1.variables)}`,
  );
  check('renameVariable: 이름이 겹치면 오류', !!attempt(() => renameVariable(base(), '상호', '비번')).error && !!attempt(() => renameVariable(base(), '상호', 'row')).error);
  const r2 = base();
  const w = wrapSteps(r2, ['s2', '#3'], { type: 'forEach', items: ROWS });
  check('wrapSteps: 이어진 스텝을 새 블록으로 옮기고 그 자리에 forEach', r2.blocks.main[1].id === w.stepId && r2.blocks.main[1].type === 'forEach' && r2.blocks.main[1].body === w.block && r2.blocks[w.block].map((s) => s.id).join() === 's2,s3' && stepNumbers(r2).get('s3') === '#2.2', show(w));
  check('wrapSteps: 이어지지 않으면 오류', /이어진/.test(attempt(() => wrapSteps(base(), ['s1', 's3'], { type: 'repeat' })).error?.message ?? ''));
  const rw = wrapSteps(r2, ['s1'], { type: 'repeat' });
  check('wrapSteps: 조건 없는 repeat 은 times 2', r2.blocks.main[0].times === 2 && r2.blocks.main[0].body === rw.block);
  const un = unwrapStep(r2, w.stepId);
  check('unwrapStep: 몸통 스텝을 제자리로, 몸통 블록 지움', un.stepIds.join() === 's2,s3' && r2.blocks.main.map((s) => s.id).slice(1, 3).join() === 's2,s3' && !(w.block in r2.blocks), show(r2.blocks.main.map((s) => s.id)));
  const rows = inputSteps(base());
  const mode = (id) => rows.find((r) => r.stepId === id);
  check(
    'inputSteps: 번호·녹화값·방식(excel/secret/mixed/fixed)',
    rows.length === 5 && mode('s2').mode === 'excel' && mode('s2').recordedValue === '가나상사' && mode('s3').mode === 'secret' && mode('s3').recordedValue === '' && mode('s8').mode === 'mixed' && mode('s10').mode === 'fixed' && mode('s10').no === '#5.1' && mode('s6').recordedValue === '1기',
    show(rows),
  );
  const r3 = base();
  const res = applyInputModes(r3, [
    { stepId: 's10', mode: 'excel', name: '검색어' },
    { stepId: 's2', mode: 'secret' },
    { stepId: '#6', mode: 'prompt', name: '기간' },
  ]);
  const v = (id) => r3.variables.find((x) => x.id === id);
  check(
    'applyInputModes: 엑셀 열·실행 때 입력(녹화값 기본)·비밀(기본값·녹화값 없음)',
    r3.blocks.반복몸통[0].value === '{{검색어}}' && v('검색어')?.source.column === '검색어' && r3.blocks.반복몸통[0].meta.recordedValue === '검색값' && v('기간')?.source.default === '1기' && /^\{\{.+\}\}$/.test(r3.blocks.main[1].value) && r3.blocks.main[1].meta.recordedValue === undefined && v(r3.blocks.main[1].value.slice(2, -2))?.source.secret === true && v(r3.blocks.main[1].value.slice(2, -2))?.source.default === undefined && res.changed.length === 3,
    `${show(res)} ${show(r3.variables)}`,
  );
  const r4 = base();
  check('applyInputModes: 녹화값 없는 비밀을 "그대로"로는 못 바꾸고 아무것도 안 바꾼다', !!attempt(() => applyInputModes(r4, [{ stepId: 's10', mode: 'excel' }, { stepId: 's3', mode: 'fixed' }])).error && r4.blocks.반복몸통[0].value === '검색값');
}

console.log('\n== 문장 (steps.js)');
{
  const texts = [
    stepText({ type: 'repeat', body: '다음쪽', while: { kind: 'exists', target: NEXT }, maxIterations: 20 }),
    stepText({ type: 'forEach', body: '행마다', items: ROWS }),
    conditionText({ kind: 'varCompare', var: '금액', op: '>=', value: '10000' }),
    conditionText({ kind: 'varContains', var: '상태', value: '폐업' }),
    conditionText({ kind: 'varEmpty', var: '비고' }),
    conditionText({ kind: 'elementText', target: tgt([css('#t')], { text: '합계' }), op: 'contains', value: '원' }),
    conditionText({ kind: 'elementCount', target: tgt([css('#t')], { text: '행' }), op: '>=', value: 1 }),
  ];
  const want = ['반복: "다음" 버튼이 있는 동안 (최대 20번) → 다음쪽 블록', '목록의 항목마다: 거래처 결과 표의 행 (최대 100개) → 행마다 블록', '{{금액}} ≥ 10000', '{{상태}} 에 "폐업" 포함', '{{비고}} 가 비어 있음', '"합계" 요소의 글자에 "원" 포함', '"행" 요소가 1개 이상'];
  check('반복·조건 문장이 계약 예시와 같다', texts.every((t, i) => t === want[i]), show(texts));
}

console.log('\n== 레시피 검사 (recipeProblems)');
{
  const B = { body: [step('sleep', { ms: 1 })] };
  const probs = (main, extra = {}) => recipeProblems(recipeOf('검사', { main, ...B, ...extra }));
  const has = (list, re) => list.some((p) => re.test(p));
  check('정상 반복·목록 레시피는 문제 없음', probs([step('repeat', { body: 'body', times: 3 }), step('repeat', { body: 'body', while: { kind: 'exists', target: NEXT } }), step('forEach', { body: '항목', items: ROWS, restore: 'back' })], { 항목: [step('click', { target: CELL(5) })] }).length === 0);
  check('몸통 블록 없음', has(probs([step('repeat', { times: 2 })]), /반복할 블록\(body\)이 없습니다/) && has(probs([step('forEach', { body: '없는블록', items: ROWS })]), /"없는블록" 이\(가\) 없습니다/));
  check('times·while·until 이 0개·2개 이상', has(probs([step('repeat', { body: 'body' })]), /반복 방법.*없습니다/) && has(probs([step('repeat', { body: 'body', times: 2, until: { kind: 'urlContains', value: 'x' } })]), /하나만/));
  check('범위 밖 상한 (times 0, maxIterations 5000, maxItems 0)', has(probs([step('repeat', { body: 'body', times: 0 })]), /반복 횟수/) && has(probs([step('repeat', { body: 'body', while: { kind: 'urlContains', value: 'x' }, maxIterations: 5000 })]), /maxIterations/) && has(probs([step('forEach', { body: 'body', items: ROWS, maxItems: 0 })]), /maxItems/));
  check('items 후보 없음', has(probs([step('forEach', { body: 'body', items: { candidates: [] } })]), /items.*후보가 없습니다/));
  check(
    'within:item 이 forEach 몸통 밖(그 블록을 부르는 분기 포함)에서 쓰임',
    has(probs([step('click', { target: CELL(2) })]), /forEach.*몸통 안에서만/) && has(probs([step('branch', { condition: { kind: 'urlContains', value: 'x' }, then: '분기' })], { 분기: [step('extract', { target: CELL(2), saveAs: 'a' })] }), /분기 블록 1번 스텝.*몸통 안에서만/),
  );
  check('모르는 조건 종류·잘못된 비교 기호·정규식', has(probs([step('wait', { condition: { kind: 'fly' } })]), /알 수 없는 조건 종류 "fly"/) && has(probs([step('assert', { condition: { kind: 'varCompare', var: '{{row}}', op: '=>', value: '1' } })]), /비교 기호/) && has(probs([step('assert', { condition: { kind: 'matches', var: 'row', pattern: '(' } })]), /정규식이 올바르지/));
  check('item·loop 토큰은 정의 안 된 변수로 보지 않는다', probs([step('forEach', { body: '항목', items: ROWS })], { 항목: [step('navigate', { url: 'https://x/{{item.cell:2}}/{{item.index}}/{{loop.index}}/{{item.text|trim}}' })] }).length === 0);
}

// ---------- 고침 1회차 (사용성 평가 round 1): 화면만으로 목록·쪽 넘기기·로그인 분기를 만들 수 있게 하는 도우미 ----------
// 녹화한 표 칸 (첫 행 금액) — 녹화기가 만드는 모양 그대로
const REC_CELL = tgt([txt('td', '12,000', 75), xp("//tr[*[1][normalize-space()='1']]//td[normalize-space()='12,000']", 68), css('#result > tbody > tr:nth-of-type(1) > td:nth-of-type(4)', 55), xp('/html/body/table/tbody/tr[1]/td[4]', 40)], { tag: 'td', text: '12,000' });
const REC_NAME = tgt([txt('td', '가나상사', 75), css('#result > tbody > tr:nth-of-type(1) > td:nth-of-type(2)', 55), xp('/html/body/table/tbody/tr[1]/td[2]', 40)], { tag: 'td', text: '가나상사' });

console.log('\n== 고침 1회차: 목록 도우미 (listFromTarget · relativeToList · sameElementSteps)');
{
  const w = listFromTarget(REC_CELL, { name: '금액' });
  check(
    'R1-02 listFromTarget: 녹화한 표 칸 → 그 칸이 있는 표의 행 전체(items) + 항목 기준 상대 대상(within:item)',
    w?.tag === 'tr' && w.col === 4 && w.items.candidates.some((c) => c.value === '#result > tbody > tr:has(> td)') && w.items.candidates.some((c) => c.value === '/html/body/table/tbody/tr[td]') && w.relative?.within === 'item' && w.relative.candidates.some((c) => c.value === ':scope > td:nth-of-type(4)') && w.relative.candidates.some((c) => c.value === './td[4]') && !w.relative.candidates.some((c) => c.kind === 'text'),
    show(w),
  );
  check('R1-02 listFromTarget: 행 안이 아닌 요소(단추 #next)는 null', listFromTarget(NEXT) === null);
  check(
    'R1-02 relativeToList: 같은 표(사용자가 쓴 "#result tbody tr"·관찰 목록 "#result > tbody > tr")면 상대 대상, 다른 목록이면 null',
    !!relativeToList(REC_CELL, tgt([css('#result tbody tr', 60)])) && !!relativeToList(REC_CELL, ROWS) && relativeToList(REC_CELL, tgt([css('#fruits > li')])) === null,
  );
  check('R1-02 looksSingle: 요소 하나(#memo·글자 후보)는 1개짜리, 표의 행 목록은 아님', looksSingle(tgt([css('#memo')])) && looksSingle(REC_CELL) && !looksSingle(ROWS) && !looksSingle(w.items));
  const bad = recipeOf('같은값', {
    main: [step('navigate', { url: 'x' }), step('forEach', { id: 'fe1', items: ROWS, body: '행마다' })],
    행마다: [step('extract', { id: 'x1', target: REC_CELL, saveAs: '금액' }), step('click', { id: 'x2', target: inItem([xp('.//a', 60)], { tag: 'a', text: '상세' }) }), step('extract', { id: 'x3', target: tgt([css('#memo-text')]), saveAs: '비고' })],
  });
  const same = sameElementSteps(bad);
  check('R1-02 sameElementSteps: 행 경로를 가리키는 값 읽기만 (항목 안 클릭 뒤 상세 화면 값 읽기는 아님)', same.length === 1 && same[0].stepId === 'x1' && same[0].definite && same[0].relative?.within === 'item' && same[0].relative.meta.label === '금액', show(same));
  const p = recipeProblems(bad);
  check('R1-02 recipeProblems: "항목마다 같은 요소를 씁니다" 를 고칠 점으로 (스텝 id 포함)', p.some((x) => /행마다 블록 1번 스텝\(x1\).*항목마다 같은 요소/.test(x)) && !p.some((x) => /\(x3\)/.test(x)), show(p));
  const early = recipeOf('앞값', { main: [step('forEach', { items: ROWS, body: 'b' })], b: [step('extract', { id: 'g1', target: tgt([css('#total')]), saveAs: '합계' })] });
  check('R1-02 recipeProblems: 화면을 바꾸기 전 반복 안의 값 읽기(항목과 상관없는 요소)도 같은 값 경고', recipeProblems(early).some((x) => /\(g1\).*같은 값을 되풀이/.test(x)));
}

console.log('\n== 고침 1회차: 쪽 넘기기 (pagingRisk · makePaging · pagingOf · unmakePaging)');
{
  const base = () =>
    recipeOf('쪽', {
      main: [step('navigate', { id: 'p1', url: 'x' }), step('repeat', { id: 'rp', while: { kind: 'exists', target: NEXT }, maxIterations: 20, body: '반복' })],
      반복: [step('forEach', { id: 'pf', items: ROWS, body: '행마다' }), step('click', { id: 'pn', target: structuredClone(NEXT) })],
      행마다: [step('extract', { target: CELL(2, '상호'), saveAs: '상호' })],
    });
  const r = base();
  check('R1-03 pagingRisk: while "다음" 있는 동안 + 몸통 끝이 "다음" 클릭 → 위험 (그 클릭 id)', pagingRisk(r, findStep(r, 'rp').step) === 'pn');
  const more = recipeOf('더보기', { main: [step('repeat', { id: 'rm', while: { kind: 'exists', target: NEXT }, body: 'b' })], b: [step('click', { target: NEXT })] });
  check('R1-03 pagingRisk: "더 보기" 만 누르는 반복(몸통 1개)은 위험 아님', pagingRisk(more, findStep(more, 'rm').step) === null);
  const res = makePaging(r, 'rp', { clickStepId: 'pn' });
  const rep = findStep(r, 'rp').step;
  const body = r.blocks[rep.body];
  check(
    'R1-03 makePaging: until "다음" 없음 · 몸통 맨 앞 "두 번째 반복부터 다음 누르기" 분기 · 그 뒤 목록',
    rep.until?.kind === 'not' && rep.until.condition?.kind === 'exists' && !rep.while && rep.maxIterations === 20 && body[0].type === 'branch' && body[0].condition.var === 'loop.index' && body[0].condition.op === '>' && r.blocks[body[0].then]?.[0]?.id === 'pn' && body[1].id === 'pf' && body.length === 2 && res.clickId === 'pn',
    show({ rep, body }),
  );
  check('R1-03 pagingOf: 쪽 넘기기 구조를 알아본다 · 위험 없음 · 검사 문제 없음', !!pagingOf(r, rep) && pagingRisk(r, rep) === null && recipeProblems(r).length === 0, show(recipeProblems(r)));
  check('R1-03 stepText: 쪽 넘기기 분기는 "두 번째 반복부터" 로 읽힌다', stepText(body[0]).startsWith('두 번째 반복부터: [다음누르기] 스텝 실행'), stepText(body[0]));
  const back = unmakePaging(r, 'rp');
  check('R1-03 unmakePaging: "다음" 클릭을 몸통 끝으로 되돌리고 분기 블록을 지운다', back?.clickId === 'pn' && r.blocks[rep.body].map((s) => s.id).join() === 'pf,pn' && !r.blocks['다음누르기'], show(r.blocks[rep.body]));
}

console.log('\n== 고침 1회차: 로그인 분기 · 문장 · 이름');
{
  const lr = recipeOf(
    '로그인',
    {
      main: [
        step('navigate', { id: 'l1', url: 'x/login.html' }),
        step('input', { id: 'l2', target: tgt([css('#uid')], { tag: 'input', label: '아이디' }), value: 'tester' }),
        step('input', { id: 'l3', target: tgt([css('#upw')], { tag: 'input', type: 'password', label: '비밀번호' }), value: '{{비밀번호}}' }),
        step('click', { id: 'l4', target: tgt([css('form button')], { tag: 'button', text: '로그인' }) }),
        step('input', { id: 'l5', target: tgt([css('#biz')], { tag: 'input', label: '사업자번호' }), value: '{{사업자번호}}' }),
      ],
    },
    { variables: [{ id: '비밀번호', name: '비밀번호', source: { kind: 'prompt', secret: true } }] },
  );
  const g = loginSteps(lr);
  check('R1-05 loginSteps: 아이디·비밀번호 입력과 바로 뒤 로그인 클릭', g?.stepIds.join() === 'l2,l3,l4' && g.first.id === 'l2', show(g));
  const w = wrapLogin(lr);
  const br = findStep(lr, w.stepId).step;
  check('R1-05 wrapLogin: "아이디 칸이 있으면" 분기(로그인 블록)로 묶고 다음 입력은 밖에 남긴다', br.type === 'branch' && br.condition.kind === 'exists' && br.condition.target.candidates[0].value === '#uid' && lr.blocks[br.then].map((s) => s.id).join() === 'l2,l3,l4' && lr.blocks.main.map((s) => s.id).join() === `l1,${br.id},l5`, show(lr.blocks));
  check('R1-05 loginSteps: 이미 분기로 묶은 레시피는 다시 권하지 않는다', loginSteps(lr) === null);
  check('R1-09 stepText(wait): "…글자가 보일 때까지 기다리기"', stepText({ type: 'wait', condition: { kind: 'textVisible', text: '조회 완료' }, timeoutMs: 15000 }) === '화면에 "조회 완료" 글자가 보일 때까지 기다리기 (최대 15초)');
  check('R1-11 stepText(branch): "만약 {{상태}}에 "폐업"이 들어 있으면 → [폐업이면] 스텝 실행"', stepText({ type: 'branch', condition: { kind: 'varContains', var: '상태', value: '폐업' }, then: '폐업이면' }) === '만약 {{상태}}에 "폐업"이 들어 있으면 → [폐업이면] 스텝 실행');
  const within = inItem([css(':scope > td:nth-of-type(4)'), xp('./td[4]', 55)], { tag: 'td', text: '12,000' });
  check('R1-04 targetName: 항목 안 대상은 견본 글자(12,000) 대신 열 이름·라벨·칸 번호', targetName(within) === '4번째 칸' && targetName({ ...within, meta: { tag: 'td', text: '12,000', col: '금액' } }) === '금액' && targetText({ ...within, meta: { tag: 'td', label: '금액' } }) === '"금액" 표 칸 · 항목 안', targetName(within));
  check('R1-05 withJosa: 받침에 맞는 조사', withJosa('"조회" 버튼', '을', '를') === '"조회" 버튼을' && withJosa('"아이디" 입력칸', '을', '를') === '"아이디" 입력칸을' && withJosa('"x" 링크', '을', '를') === '"x" 링크를');
}

console.log('\n== 고침 2회차: 문장 (R2-03 반복이 끝난 이유 · R2-05 블록 이름 대신 안의 스텝 수 · 빈 값 · 조사)');
{
  const rec = { blocks: { main: [], 폐업이면: [{ type: 'screenshot', fileName: 'a.png' }], 다음누르기: [{ type: 'click', target: NEXT }], 쪽마다: [{}, {}], 빈: [] } };
  check(
    'R2-05 stepText(…, recipe): 분기·반복·목록은 블록 이름 대신 "안의 스텝 N개" (recipe 없이 부르면 예전처럼 블록 이름 — AI 개요용)',
    stepText({ type: 'branch', condition: { kind: 'varContains', var: '상태', value: '폐업' }, then: '폐업이면' }, rec) === '만약 {{상태}}에 "폐업"이 들어 있으면 → 그러면 안의 스텝 1개 실행' &&
      stepText({ type: 'repeat', until: { kind: 'not', condition: { kind: 'exists', target: NEXT } }, maxIterations: 20, body: '쪽마다' }, rec) === '반복: "다음" 버튼이 없어질 때까지 (최대 20번) → 안의 스텝 2개' &&
      stepText({ type: 'forEach', items: ROWS, body: '빈' }, rec) === '목록의 항목마다: 거래처 결과 표의 행 (최대 100개) → 안의 스텝 없음' &&
      stepText({ type: 'branch', condition: { kind: 'varContains', var: '상태', value: '폐업' }, then: '폐업이면' }).includes('[폐업이면] 스텝 실행'),
  );
  check('R2-05 쪽 넘기기 분기: "두 번째 반복부터 "다음" 클릭 (첫 번째에는 건너뜀)"', stepText({ type: 'branch', condition: { kind: 'varCompare', var: 'loop.index', op: '>', value: '1' }, then: '다음누르기' }, rec) === '두 번째 반복부터 "다음" 클릭 (첫 번째에는 건너뜀)');
  check(
    'R2-05 빈 조건 값은 빈 따옴표 대신 "(보일 글자를 정하세요)"·"(값을 정하세요)"',
    conditionText({ kind: 'textVisible', text: '' }) === '화면에 (보일 글자를 정하세요) 글자 보임' && stepText({ type: 'branch', condition: { kind: 'textVisible', text: '' }, then: '폐업이면' }, rec).startsWith('만약 화면에 (보일 글자를 정하세요) 글자가 보이면') && conditionText({ kind: 'varContains', var: '상태', value: '' }) === '{{상태}} 에 (값을 정하세요) 포함',
  );
  check(
    'R2-03 "아님(…)" 대신 자연스러운 부정 (없음·안 보임·비어 있지 않음), 모르는 꼴만 아님(…)',
    conditionText({ kind: 'not', condition: { kind: 'exists', target: NEXT } }) === '"다음" 버튼 없음' && conditionText({ kind: 'not', condition: { kind: 'textVisible', text: '완료' } }) === '화면에 "완료" 글자 안 보임' && conditionText({ kind: 'not', condition: { kind: 'varEmpty', var: '비고' } }) === '{{비고}} 가 비어 있지 않음' && conditionText({ kind: 'not', condition: { kind: 'all', conditions: [{ kind: 'varEmpty', var: 'a' }] } }).startsWith('아님('),
  );
  check(
    'R2-03 loopEndText: 반복이 끝난 까닭을 바로 읽히게 ("다음" 버튼이 없어서 · 화면에 "완료" 글자가 보여서 · 조건이 더는 맞지 않아서)',
    loopEndText({ kind: 'not', condition: { kind: 'exists', target: NEXT } }, true) === '"다음" 버튼이 없어서' && loopEndText({ kind: 'exists', target: NEXT }, false) === '"다음" 버튼이 없어서' && loopEndText({ kind: 'textVisible', text: '완료' }, true) === '화면에 "완료" 글자가 보여서' && loopEndText({ kind: 'varCompare', var: 'n', op: '<', value: '3' }, false) === '조건({{n}} < 3)이 더는 맞지 않아서',
  );
  check('R2-05 번호 뒤 조사 (#2.1.1은 · #2.2는)', withJosa('#2.1.1', '은', '는') === '#2.1.1은' && withJosa('#2.2', '은', '는') === '#2.2는');
}

// =====================================================================
await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(OUT, { recursive: true });
const site = await startLoopSite();
const BASE = site.base;
const LIST = `${BASE}/list.html?page=1`;
console.log(`\n(점검 사이트 ${BASE})`);

try {
  console.log('\n== 조건 6종 (실제 화면)');
  {
    const ctx = await startBrowser({ profileDir: path.join(OUT, 'profile-cond'), headless: true });
    try {
      const sess = new Session({ ctx });
      await sess.init();
      await sess.work.goto(`${BASE}/cond.html`, { waitUntil: 'load' });
      const recipe = {
        variables: [
          { id: '상태', name: '상태', source: { kind: 'excel', column: '상태' } },
          { id: '금액', name: '금액', source: { kind: 'excel', column: '금액' } },
          { id: '비고', name: '비고', source: { kind: 'excel', column: '비고' } },
          { id: '날짜', name: '날짜', source: { kind: 'excel', column: '날짜' } },
        ],
        blocks: { main: [] },
      };
      const scope = new Scope({ recipe, row: { 상태: '폐업 신고', 금액: '12,000', 비고: '   ', 날짜: '2026-10-21', 기준: '10000' }, rowNumber: 3 });
      const rc = { sess, scope, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
      const cond = async (name, c, want) => {
        let got;
        try {
          got = await checkCondition(rc, c);
        } catch (e) {
          got = `오류: ${e.message}`;
        }
        check(`${name}: ${conditionText(c)} → ${want ? '참' : '거짓'}`, got === want, `실제 ${got}`);
      };
      await cond('varContains 참', { kind: 'varContains', var: '상태', value: '폐업' }, true);
      await cond('varContains 거짓', { kind: 'varContains', var: '상태', value: '정상' }, false);
      await cond('varCompare 숫자(쉼표) 참', { kind: 'varCompare', var: '금액', op: '>=', value: '{{기준}}' }, true);
      await cond('varCompare 숫자 거짓', { kind: 'varCompare', var: '금액', op: '<', value: '10000' }, false);
      await cond('varCompare 날짜 참', { kind: 'varCompare', var: '날짜', op: '<', value: '2026.11.01' }, true);
      await cond('varCompare 날짜(YYYYMMDD) 거짓', { kind: 'varCompare', var: '날짜', op: '>', value: '20261231' }, false);
      await cond('varCompare 행 번호 참', { kind: 'varCompare', var: 'row', op: '=', value: '3' }, true);
      await cond('varEmpty 참 (공백만)', { kind: 'varEmpty', var: '비고' }, true);
      await cond('varEmpty 거짓', { kind: 'varEmpty', var: '{{상태}}' }, false);
      await cond('matches 참', { kind: 'matches', var: '상태', pattern: '^폐업' }, true);
      await cond('matches 거짓', { kind: 'matches', var: '상태', pattern: '^정상', flags: 'i' }, false);
      await cond('elementText 포함 참', { kind: 'elementText', target: tgt([css('#total')], { text: '합계' }), op: 'contains', value: '원' }, true);
      await cond('elementText 같음 거짓', { kind: 'elementText', target: tgt([css('#total')], { text: '합계' }), op: 'equals', value: '합계' }, false);
      await cond('elementText 정규식 참', { kind: 'elementText', target: tgt([css('#total')], { text: '합계' }), op: 'matches', value: '^합계 [\\d,]+원$' }, true);
      await cond('elementCount 참', { kind: 'elementCount', target: tgt([css('#fruits > li'), css('li.it', 80)], { text: '과일' }), op: '>=', value: 3 }, true);
      await cond('elementCount 거짓', { kind: 'elementCount', target: tgt([css('#fruits > li')], { text: '과일' }), op: '>', value: 3 }, false);
      await cond('elementCount 없는 요소 = 0 참', { kind: 'elementCount', target: tgt([css('.none')], { text: '없음' }), op: '=', value: 0 }, true);
      await cond('정의 안 된 변수는 거짓', { kind: 'varCompare', var: '모름', op: '!=', value: 'x' }, false);
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  console.log('\n== forEach: 행마다 칸 읽기 (값 모으기·토큰)');
  {
    const r = recipeOf('행마다', {
      main: [step('navigate', { url: LIST }), step('forEach', { items: ROWS, body: '행마다' }), step('extract', { target: tgt([css('#memo')]), attr: 'value', saveAs: '마지막메모' })],
      행마다: [
        step('extract', { target: CELL(2, '상호'), saveAs: '상호' }),
        step('assert', { condition: { kind: 'varEquals', var: '상호', value: '{{item.cell:2}}' }, message: '반복 안 {{상호}} 는 마지막 값' }),
        step('assert', { condition: { kind: 'varContains', var: 'item.text', value: '{{상호}}' } }),
        step('input', { target: tgt([css('#memo')], { tag: 'input', label: '메모' }), value: '{{item.index}}|{{item.cell:2}}|{{loop.index}}' }),
        step('extract', { target: tgt([css('#memo')]), attr: 'value', saveAs: '메모' }),
      ],
    });
    const { report, row } = await run('rows', r);
    const names = COMPANIES.slice(0, 4).map((c) => c[0]);
    check('실행 성공', report.status === 'done', row.error);
    check('반복 안 extract 값이 행 결과에 줄바꿈으로 모인다 (4개)', row.values?.상호 === names.join('\n'), show(row.values?.상호));
    check('{{item.index}}·{{item.cell:2}}·{{loop.index}} 토큰', row.values?.메모 === names.map((nm, i) => `${i + 1}|${nm}|${i + 1}`).join('\n'), show(row.values?.메모));
    check('반복 밖 extract 는 그대로 (마지막 값 하나)', row.values?.마지막메모 === `4|${names[3]}|4`, show(row.values?.마지막메모));
    const csv = await fs.readFile(path.join(OUT, 'run-rows', 'rows.csv'), 'utf8').catch(() => '');
    check('결과 CSV 칸에 줄바꿈으로 이어진 값', csv.includes(`"${names.join('\n')}"`));
  }

  console.log('\n== repeat while "다음" 있는 동안 + 안쪽 forEach (3쪽 12행)');
  {
    const r = recipeOf('다음쪽', {
      main: [step('navigate', { url: LIST }), step('forEach', { items: ROWS, body: '행마다' }), step('repeat', { while: { kind: 'exists', target: NEXT }, body: '다음쪽', maxIterations: 10 })],
      다음쪽: [step('click', { target: NEXT }), step('forEach', { items: ROWS, body: '행마다' })],
      행마다: [step('extract', { target: CELL(2, '상호'), saveAs: '상호' }), step('extract', { target: CELL(4, '금액'), saveAs: '금액' })],
    });
    const { report, row, log } = await run('pages', r);
    check('실행 성공', report.status === 'done', row.error);
    check('12행 상호를 쪽 순서대로', row.values?.상호 === COMPANIES.map((c) => c[0]).join('\n'), show(row.values?.상호));
    check('12행 금액', lines(row.values?.금액).length === 12 && lines(row.values?.금액)[2] === '1,500,000', show(row.values?.금액));
    check('반복은 2번 (3쪽에서 "다음" 이 사라져 끝)', /반복 2 —/.test(log) && !/반복 3 —/.test(log) && !/최대 반복 횟수/.test(log));
  }

  console.log('\n== repeat until + 조건부 "다음" (loop.index > 1)');
  {
    const r = recipeOf('until', {
      main: [step('navigate', { url: LIST }), step('repeat', { until: { kind: 'not', condition: { kind: 'exists', target: NEXT } }, body: '쪽마다', maxIterations: 10 })],
      쪽마다: [step('branch', { condition: { kind: 'varCompare', var: 'loop.index', op: '>', value: '1' }, then: '다음누르기' }), step('forEach', { items: ROWS, body: '행마다' })],
      다음누르기: [step('click', { target: NEXT })],
      행마다: [step('extract', { target: CELL(2, '상호'), saveAs: '상호' })],
    });
    const { report, row } = await run('until', r);
    check('until 로도 12행', report.status === 'done' && lines(row.values?.상호).length === 12 && lines(row.values?.상호)[11] === COMPANIES[11][0], show(row.values?.상호 ?? row.error));
  }

  console.log('\n== within:item 상세 링크 클릭 + restore back');
  {
    const before = new Map(site.hits);
    const r = recipeOf('상세', {
      main: [step('navigate', { url: LIST }), step('forEach', { items: ROWS, body: '상세', restore: 'back' }), step('extract', { target: tgt([css('#pageno')]), saveAs: '쪽' })],
      상세: [step('click', { target: inItem([txt('a', '상세', 80), xp('.//a', 60)], { tag: 'a', text: '상세' }) }), step('extract', { target: tgt([css('#memo-text')], { tag: 'p' }), saveAs: '비고' })],
    });
    const { report, row, log } = await run('detail', r);
    const hits = [1, 2, 3, 4].map((id) => (site.hits.get(`/detail.html?id=${id}`) ?? 0) - (before.get(`/detail.html?id=${id}`) ?? 0));
    check('실행 성공', report.status === 'done', row.error);
    check('행마다 자기 상세 화면을 열었다 (상세 1~4 각 1번)', hits.every((h) => h === 1), show(hits));
    check('상세 화면 값 4개를 순서대로', row.values?.비고 === [1, 2, 3, 4].map(memoOf).join('\n'), show(row.values?.비고));
    check('뒤로 가기로 목록에 돌아와 끝난다', row.values?.쪽 === '쪽 1 / 3' && /목록 화면으로 돌아갑니다/.test(log), show(row.values?.쪽));
  }

  console.log('\n== 반복 상한·횟수·빈 목록·최대 항목 수');
  {
    const r = recipeOf('상한', {
      main: [
        step('navigate', { url: `${BASE}/cond.html` }),
        step('repeat', { times: 3, body: '세번' }),
        step('input', { target: tgt([css('#amount')], { tag: 'input' }), value: '{{loop.count}}' }),
        step('extract', { target: tgt([css('#amount')]), attr: 'value', saveAs: '반복뒤' }),
        step('repeat', { while: { kind: 'textVisible', text: '조건 확인' }, body: '쉼', maxIterations: 3 }),
        step('navigate', { url: `${BASE}/empty.html` }),
        step('forEach', { items: ROWS, body: '행마다' }),
        step('navigate', { url: LIST }),
        step('forEach', { items: ROWS, body: '행마다', maxItems: 2 }),
      ],
      세번: [step('input', { target: tgt([css('#amount')], { tag: 'input' }), value: '{{loop.index}}/{{loop.count}}' }), step('extract', { target: tgt([css('#amount')]), attr: 'value', saveAs: '세번' })],
      쉼: [step('sleep', { ms: 10 }), step('extract', { target: tgt([css('#total')]), saveAs: '합계' })],
      행마다: [step('extract', { target: CELL(2, '상호'), saveAs: '상호' })],
    });
    const { report, row, log } = await run('limits', r);
    check('상한에 닿아도 실패가 아니다 (다음 스텝으로)', report.status === 'done', row.error);
    check('경고 로그 "최대 반복 횟수 3 에 도달해 멈춥니다"', /\[warn\] 최대 반복 횟수 3 에 도달해 멈춥니다/.test(log) && lines(row.values?.합계).length === 3);
    check('times 3번 · {{loop.index}}/{{loop.count}} · 반복 뒤 {{loop.count}}', row.values?.세번 === '1/1\n2/2\n3/3' && row.values?.반복뒤 === '3', show([row.values?.세번, row.values?.반복뒤]));
    check('빈 목록은 몸통을 건너뛰고 정보 로그', /항목이 없어 \[행마다\] 블록을 건너뜁니다/.test(log));
    check('maxItems 2 → 앞의 2개만 + 경고', row.values?.상호 === COMPANIES.slice(0, 2).map((c) => c[0]).join('\n') && /앞의 2개만 처리합니다/.test(log), show(row.values?.상호));
  }

  console.log('\n== 고침 1회차: 화면에서 만든 목록·쪽 넘기기를 실제로 돌린다 · 쉬운 오류 문장 · 로그 번호');
  {
    // R1-02: 녹화한 첫 행 금액 칸에서 만든 목록(행 전체) + 항목 안 금액 → 4행이 서로 다른 값
    const w = listFromTarget(REC_CELL, { name: '금액' });
    const r1 = recipeOf('행전체', { main: [step('navigate', { url: LIST }), step('forEach', { items: w.items, body: '행마다' })], 행마다: [step('extract', { target: w.relative, saveAs: '금액' })] });
    const a = await run('rec-list', r1);
    check('R1-02 녹화 칸에서 만든 목록으로 4행 금액이 행마다 다르게 남는다', a.report.status === 'done' && a.row.values?.금액 === '12,000\n8,500\n1,500,000\n300', show(a.row.values?.금액 ?? a.row.error));
    // R1-03: 반복으로 묶은 [목록, "다음" 클릭] 을 쪽 넘기기로 바꾸면 마지막 쪽까지 12행
    const r2 = recipeOf('쪽넘기기', {
      main: [step('navigate', { url: LIST }), step('repeat', { id: 'q1', while: { kind: 'exists', target: NEXT }, maxIterations: 20, body: '반복' })],
      반복: [step('forEach', { items: ROWS, body: '행마다' }), step('click', { id: 'q2', target: structuredClone(NEXT) })],
      행마다: [step('extract', { target: CELL(2, '상호'), saveAs: '상호' })],
    });
    makePaging(r2, 'q1', { clickStepId: 'q2' });
    const b = await run('paging', r2);
    check('R1-03 쪽 넘기기로 바꾼 반복: 3쪽 12행 모두 (마지막 쪽 포함)', b.report.status === 'done' && lines(b.row.values?.상호).length === 12 && lines(b.row.values?.상호)[11] === COMPANIES[11][0], show(b.row.values?.상호 ?? b.row.error));
    // 고침 2회차 R2-03: "끝낼 조건이 맞음 — 아님(…)" 이 거꾸로 읽혀 쪽 넘기기는 끝난 까닭을 그대로 말한다
    check('R1-03·R2-03 실행 기록에 반복이 끝난 이유 ("반복 끝 (3번 실행): "다음" 버튼이 없어 마지막 쪽까지 처리했습니다.")', /반복 끝 \(3번 실행\): "다음" 버튼이 없어 마지막 쪽까지 처리했습니다\./.test(b.log) && !/아님\(/.test(b.log), b.log.split('\n').filter((l) => /반복/.test(l)).slice(-3).join(' / '));
    check('R1-13 실행 기록의 스텝 번호가 화면 번호와 같다 (#2.1 · #2.2.1 · #2.1.1)', /\s#2\.1 두 번째 반복부터/.test(b.log) && /\s#2\.2\.1 /.test(b.log) && /\s#2\.1\.1 "다음" 클릭/.test(b.log) && !/\[행마다\] 1\./.test(b.log), b.log.split('\n').filter((l) => /#2/.test(l)).slice(0, 4).join(' / '));
    // R1-05: 못 찾은 오류는 쉬운 첫 문장 + 자세히(시도한 후보)
    const r3 = recipeOf('못찾음', { main: [step('navigate', { url: LIST }), step('click', { target: tgt([css('#nope')], { tag: 'button', text: '조회' }), timeoutMs: 1500 })] });
    const c = await run('notfound', r3);
    check('R1-05 요소를 못 찾은 행 오류: 첫 줄이 쉬운 문장 ("조회" 버튼을 화면에서 찾지 못했습니다), CSS 나열 없음', c.row.status === 'failed' && c.row.error.startsWith('"조회" 버튼을 화면에서 찾지 못했습니다.') && !/css|xpath|시도한 후보/.test(c.row.error), c.row.error);
    check('R1-05 시도한 후보는 errorDetail(리포트의 자세히)과 실행 기록에 남는다', /^자세히 — 시도한 후보: css #nope → 0개/.test(c.row.errorDetail ?? '') && /시도한 후보: css #nope/.test(c.log), show(c.row.errorDetail));
    const r4 = recipeOf('로그인칸', { main: [step('navigate', { url: LIST }), step('input', { target: tgt([css('#uid')], { tag: 'input', label: '아이디' }), value: 'x', timeoutMs: 1000 })] });
    const d = await run('login-miss', r4);
    check('R1-05 로그인 칸을 못 찾으면 "이미 로그인돼 있어…" 를 알린다', /^"아이디" 입력칸을 화면에서 찾지 못했습니다\. 이미 로그인돼 있어/.test(d.row.error ?? ''), d.row.error);
    // R1-02: 목록 요소가 하나뿐이면 실행 기록에 분명히 경고
    const r5 = recipeOf('하나', { main: [step('navigate', { url: LIST }), step('forEach', { items: tgt([css('#memo')], { tag: 'input', label: '메모' }), body: '항목' })], 항목: [step('sleep', { ms: 1 })] });
    const e = await run('single', r5);
    check('R1-02 항목이 1개뿐인 목록은 실행 기록에 경고', e.report.status === 'done' && /\[warn\] 목록 "메모" 입력칸 의 항목이 1개뿐입니다/.test(e.log), e.log.split('\n').filter((l) => /항목/.test(l)).join(' / '));
  }

  console.log('\n== AI 관찰기: listTargetFor · 항목 기준 targetFor · params');
  {
    const logs = [];
    const SECRET = 'Zx9-secret-77';
    const obsRecipe = recipeOf('관찰', { main: [step('navigate', { url: LIST })] }, { startUrl: LIST });
    const obs = new Observer({ recipe: obsRecipe, profileDir: path.join(OUT, 'profile-obs'), onLog: (m) => logs.push(m) });
    let listTarget = null;
    let linkTarget = null;
    try {
      const ran = await obs.runTo(obsRecipe.blocks.main[0].id);
      const snap = await obs.snapshot();
      const cellRef = /^(f\d+e\d+) td "가나상사"/m.exec(snap)?.[1];
      const linkRef = /^(f\d+e\d+) link "상세" row="1"/m.exec(snap)?.[1];
      check('관찰 화면에 표 칸·상세 링크 참조가 있다', ran.ok && !!cellRef && !!linkRef, `${show(ran)} ${snap.slice(0, 300)}`);
      const lt = await obs.listTargetFor(cellRef);
      listTarget = lt.target;
      check('listTargetFor: 표의 행 4개를 센다', lt.count === 4 && lt.sample.length === 3 && lt.sample[0].includes('가나상사') && lt.target.candidates.length > 0 && /표의 행/.test(lt.target.meta.label), show(lt));
      linkTarget = await obs.targetFor(linkRef, { withinRef: cellRef });
      check('targetFor(withinRef): within:item 과 항목 기준 상대 후보', linkTarget.within === 'item' && linkTarget.candidates.length > 0 && linkTarget.candidates.every((c) => c.kind === 'text' || /^(:scope|\.\/|\.\/\/)|^a\[/.test(String(c.value))), show(linkTarget.candidates));
      const plain = await obs.targetFor(linkRef);
      check('targetFor(ref) 는 지금처럼 (within 없음)', !plain.within && plain.candidates.length > 0);
    } finally {
      await obs.close();
    }
    if (listTarget && linkTarget) {
      const r = recipeOf('관찰목록', {
        main: [step('navigate', { url: LIST }), step('forEach', { items: listTarget, body: '상세', restore: 'back' })],
        상세: [step('click', { target: linkTarget }), step('extract', { target: tgt([css('#name')], { tag: 'h1' }), saveAs: '상호' })],
      });
      const { report, row } = await run('observed', r);
      check('관찰로 만든 items·within 타겟으로 forEach 4행', report.status === 'done' && row.values?.상호 === COMPANIES.slice(0, 4).map((c) => c[0]).join('\n'), show(row.values?.상호 ?? row.error));
    } else check('관찰로 만든 items·within 타겟으로 forEach 4행', false, '타겟을 만들지 못함');

    const secretRecipe = recipeOf(
      '비밀',
      { main: [step('navigate', { url: `${BASE}/secret.html` }), step('input', { target: tgt([css('#pin')], { tag: 'input', label: '접속 번호' }), value: '{{비밀번호}}' })] },
      { startUrl: `${BASE}/secret.html`, variables: [{ id: '비밀번호', name: '비밀번호', source: { kind: 'prompt', secret: true } }] },
    );
    const sobs = new Observer({ recipe: secretRecipe, profileDir: path.join(OUT, 'profile-obs'), params: { 비밀번호: SECRET }, onLog: (m) => logs.push(m) });
    try {
      const ran = await sobs.runTo(secretRecipe.blocks.main[1].id);
      const snap = await sobs.snapshot();
      check('params 의 비밀값으로 입력했다 (화면: 입력됨 13자)', ran.ok && snap.includes(`입력됨 (${SECRET.length}자)`), `${show(ran)} ${snap.slice(0, 400)}`);
      check('관찰 결과 글자에 비밀값이 없다 (•••• 로 가림)', !snap.includes(SECRET) && snap.includes('••••'), snap.slice(0, 400));
      check('관찰 로그에 비밀값이 없다', logs.length > 0 && !logs.some((l) => String(l).includes(SECRET)), show(logs.slice(-5)));
    } finally {
      await sobs.close();
    }
  }
} catch (e) {
  check('시험 진행 중 오류 없음', false, e.stack);
} finally {
  await site.close();
  if (!KEEP) await fs.rm(OUT, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n반복 점검: ${passed}/${passed + failures.length} 통과`);
if (failures.length) process.exitCode = 1;
