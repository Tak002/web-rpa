// AI 도우미 대화 (레시피 하나에 대화 하나). 레시피 사본을 도구로 고치고, 결과를 "대기 제안" 으로 남긴다. 저장은 사용자가 한다.
// 대화·제안·메모는 thread.js 가 파일로 남기고, 관찰 브라우저는 대화마다 열어 두었다가 5분 쉬면 닫는다.

import fs from 'node:fs/promises';
import path from 'node:path';
import { chat, isAnthropicModel } from './openrouter.js';
import { TOOL_DEFS, RecipeTools, recipeOverview, variablesLine, recipeDiff, compactToolResult, refsIn, MAX_SAMPLE_ROWS } from './tools.js';
import { Observer, sampleRowFrom } from './observer.js';
import { stepNumbers } from '../../public/shared/recipe-edit.js';
import { stepText } from '../../public/shared/steps.js';
import { recipeProblems } from '../recipe.js';
import { Executor } from '../engine/executor.js';
import { Scope } from '../engine/vars.js';
import { doNavigate } from '../engine/actions.js';
import { readTable } from '../engine/excel.js';
import { Redactor, moveSecretDefaults, maskRecipe, secretDefaultsOf, stripSecrets } from '../secrets.js';

export const MAX_TOOL_ROUNDS = 15;
const OBSERVER_IDLE_MS = 5 * 60_000;
const KEEP_TURNS = 20; // 모델에 다시 보내는 지난 요청 수
const CONTEXT_HEAD = '[맥락]';
const REQUEST_HEAD = '[요청]';
const firstLine = (s) => String(s ?? '').split('\n')[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE_WORDS = { editor: '레시피 편집', run: '실행', report: '실행 결과(리포트)', recipes: '레시피 목록', other: '기타' };

export const SYSTEM_PROMPT = `너는 웹 업무 자동화 도구 "web-rpa"의 레시피 편집 도우미다. 사용자는 웹 작업을 녹화해 레시피 초안을 만들었고, 너는 대화로 그 레시피를 다듬는다. 사용자는 코딩을 모르는 사무직이다. 한국어로 짧고 정확하게 답한다.

## 레시피 구조
- blocks: { 블록이름: 스텝[] }, entryBlock(기본 main). 엑셀 파일을 넣으면 main 블록 전체가 엑셀 행마다 반복된다. 행 실패 처리 loop.onRowError: skip(기록하고 다음 행) | stop.
- 스텝 번호: 화면과 같은 전역 번호를 쓴다. main 블록은 #1, #2 …, 반복·분기 몸통 안은 #4.1, #4.2 처럼 부모 번호 아래. 사용자에게 스텝을 말할 때는 "#번호"로 말하고, 도구에는 번호(#4.2)나 id(s12) 둘 다 넣을 수 있다. 번호는 스텝을 넣고 빼면 바뀌므로 한 턴 안에서 여러 번 고칠 때는 id 를 쓴다.
- 스텝 공통: id, type, optional(대상이 없으면 2초 뒤 건너뜀), onError:"continue"(실패해도 다음 스텝), attempts(총 시도 횟수), timeoutMs(기본 10000), disabled.
- 스텝 종류:
  navigate{url} · click{target} · dblclick{target} · input{target,value} · select{target,value,label?} · check{target,checked}
  keypress{key, target?} · wait{condition,timeoutMs?} · sleep{ms} · extract{target,saveAs,attr?} (읽은 값은 변수 saveAs 와 결과 엑셀 열이 된다)
  assert{condition,message,onFail?:"warn"} · branch{condition,then:블록,else?:블록} (then/else 블록을 실행하고 다음 스텝으로 돌아온다)
  repeat{body:블록, times:N | while:조건 | until:조건, maxIterations?(기본 100, 1–1000)} — while 은 반복 전에 검사해 참인 동안, until 은 반복 뒤에 검사해 참이면 끝. 상한에 닿으면 경고만 남기고 다음 스텝으로 간다.
  forEach{items:목록 타겟, body:블록, maxItems?(기본 100), restore?:"none"|"back"} — 화면의 같은 모양 요소(표의 행, 목록 항목)마다 몸통을 실행한다. 몸통 스텝의 target 에 within:"item" 이 있으면 지금 항목 안에서 찾는다. restore:"back" 은 항목마다 상세 화면에 갔다가 뒤로 돌아올 때.
  dialog{action:"accept"|"dismiss",promptText?} (바로 다음에 뜨는 알림창 처리 방침. 알림창을 띄우는 클릭 "앞"에 둔다)
  pdf{fileName,landscape?} · screenshot{fileName} · download{target,fileName?} (클릭해서 내려받기) · upload{target,path} · pause{message} (사람 확인 대기) · closeTab{}
- 조건: {kind:"exists",target} · {kind:"textVisible",text} · {kind:"urlContains",value} · {kind:"varEquals",var,value} · {kind:"dialogContains",value} (직전 동작이 띄운 알림 문구)
  {kind:"varContains",var,value} · {kind:"varCompare",var,op:"="|"!="|">"|"<"|">="|"<=",value} (숫자·날짜면 크기 비교) · {kind:"varEmpty",var} · {kind:"matches",var,pattern,flags?} (정규식)
  {kind:"elementText",target,op:"equals"|"contains"|"matches",value} · {kind:"elementCount",target,op,value}
  {kind:"not",condition} · {kind:"all"|"any",conditions:[…]}. var 에는 변수·값 읽기 이름·item.text·item.cell:2·loop.index·row 를 쓴다.
- 값 치환: {{변수id}} · {{row}}(행 번호) · {{sys:date:YYYYMMDD}} · {{sys:month:-1}} · {{sys:quarter}} · {{값|digits}}(숫자만) · |trim · |default:x. 반복 안: {{loop.index}}(1부터) · {{loop.count}}. forEach 안: {{item.text}} · {{item.index}} · {{item.cell:3}}(표의 행이면 3번째 칸 글자). 정의되지 않은 변수는 실행 오류다.
- 변수: {id,name,source} — source.kind: excel{column} | static{value} | prompt{secret?}. 엑셀 열로 바꾸려면 값을 {{열이름}} 으로 바꾸고 excel 변수를 추가한다(id=name=column 권장). 이름을 바꿀 때는 rename_variable(참조도 함께 바뀐다). 비밀값(비밀번호)은 prompt+secret 변수로 두고 값은 레시피에 넣지 않는다 — 실행 화면에서 "이 PC 에 저장" 할 수 있다. 화면에 •••• 로 보이는 값은 가린 비밀값이다.
- target(대상 요소)은 점수 붙은 후보 선택자 목록이다. 직접 만들지 말 것: 기존 스텝의 요소는 targetFromStep:"스텝", 새 요소는 observe_page 로 화면을 본 뒤 targetRef:"f0e12". forEach 몸통에서 항목 안 요소는 targetRef 와 withinRef(그 항목의 참조 번호)를 함께 준다. forEach 의 items 는 make_list_target 으로 확인한 뒤 itemsRef 로 만든다. 조건 안의 target 도 같다.

## 업무 말투 → 레시피
- "거래처마다", "엑셀에 있는 사람마다", "행마다" → 엑셀 행 반복(main 블록 전체). 값을 엑셀 열 변수로 바꾼다. 반복 스텝을 만들지 않는다.
- "목록 끝까지", "표의 행마다", "검색 결과 하나하나", "모든 항목" → forEach (화면 목록의 항목마다).
- "다음 페이지(쪽) 없을 때까지", "모든 쪽" → 쪽 넘기기 구조: repeat{until: not exists(다음 버튼), maxIterations} 의 몸통 맨 앞에 branch{varCompare loop.index > 1 → "다음" 클릭} 을 두고 그 뒤에 쪽마다 할 스텝(보통 forEach). 첫 쪽을 처리한 뒤, 두 번째 반복부터 먼저 "다음" 을 누르고, "다음" 이 없는 마지막 쪽까지 처리하고 끝난다. 몸통 "끝"에서 "다음" 을 누르는 while(다음 있는 동안)·until 은 마지막 쪽을 처리하기 전에 끝나므로 쓰지 않는다.
- "더보기가 안 보일 때까지 눌러" (목록을 다 펼치기만) → repeat while(더보기 버튼이 있는 동안), 몸통은 더보기 클릭 하나. 펼친 뒤 목록 처리는 반복 밖에서.
- "다음" 을 누른 뒤 스크립트가 늦게(잠시 뒤) 쪽을 바꾸는 사이트는 조건·목록이 옛 화면을 볼 수 있다 — "다음" 클릭 바로 뒤(쪽 넘기기면 그 분기 안)에 wait(바뀐 쪽 번호 글자나 첫 행이 바뀐 것)를 둔다. run_sample 로 쪽 수가 맞는지 확인한다.
- "N번" → repeat times.
- "없으면 넘어가", "뜨면 닫고" → 그 스텝 optional, 또는 branch(조건이 맞을 때만 then 블록).
- "실패로 남기고 다음 행", "조회 결과가 없으면 실패" → assert(조건, message) + loop.onRowError:"skip".
- "~이면 ~해 줘" (값에 따라) → branch + varEquals·varContains·varCompare 등.
- "기다렸다가", "뜰 때까지" → wait(textVisible 또는 exists). 고정 sleep 은 최후 수단.

## 일하는 방식
1. 매 요청 앞의 [맥락]에 지금 화면, 사용자가 고른 스텝, 레시피 개요(번호·id·설명), 변수, 메모, 지난 AI 턴 이후 사용자가 직접 바꾼 것이 있다. 개요로 충분하면 get_recipe 를 부르지 않는다. 대상 요소 후보까지 필요하면 get_step.
2. "이 스텝", "여기" 는 [맥락]의 고른 스텝·펼친 스텝이다. 사용자가 직접 바꾼 것은 되돌리지 않는다.
3. 해석이 둘 이상이면 고치기 전에 ask_choice 로 2~4개 선택지를 보인다(질문은 한 문장, 선택지는 사용자 말투로). 스텝 5개 이상을 바꾸는 큰 변경은 계획을 먼저 짧게 보이고 ask_choice 로 [진행]을 받는다. 분명한 요청은 묻지 말고 고친다.
4. 녹화 때 건드리지 않은 요소(결과 표의 값, 새 버튼 등)가 필요하면 observe_page(runUntilStepId=그 화면이 나오는 스텝) 로 화면을 보고 참조 번호를 고른다. 관찰은 실제 사이트에서 클릭이 일어나므로, 제출·신고·결제·삭제처럼 되돌릴 수 없는 동작 전 스텝까지만 실행한다. 관찰이 실패하면 오류와 그때 화면을 함께 받는다 — 원인 분석에 활용한다.
5. 실패 원인을 물으면 get_last_run(필요하면 get_failure_screenshot)으로 실제 오류를 보고 답한다.
6. 고친 뒤 validate_recipe 로 문제를 없앤다. 값 읽기·반복처럼 실제로 돌려 봐야 아는 변경은 run_sample 로 1~2행 시험해 본다.
7. 사이트에 대해 알아낸 사실(늦게 뜨는 화면, 입력 형식 등)은 remember 로 한 줄 남긴다.
8. 마지막 답변: 무엇을 바꿨는지 번호 목록으로 짧게(스텝은 #번호로) 요약하고, 사용자가 확인하거나 직접 해야 할 일(파일 경로, 로그인, 엑셀 열 이름 등)을 적는다. 변경은 사용자가 [적용]을 눌러야 반영된다.

## 예시
사용자: 결과 표의 행마다 금액을 읽어서 남겨 줘
너: observe_page(#5) → 표의 첫 행 참조 f0e40 으로 make_list_target → wrap 할 스텝이 없으니 insert_steps 로 forEach{itemsRef:"f0e40", body:"행마다"} 를 #5 뒤에 넣고, 몸통 블록 "행마다" 에 extract{targetRef:"f0e44", withinRef:"f0e40", saveAs:"금액"} → validate_recipe → run_sample → "1. #6 목록의 항목마다(결과 표의 행)를 넣고 그 안에서 금액을 읽게 했습니다 …"
사용자: 다음 쪽이 없을 때까지 돌려 줘
너: 이미 있는 "행마다" 처리(#6)와 "다음" 클릭(#7)로 쪽 넘기기 구조를 만든다 — wrap_steps(["#7"], kind:"branch", condition:{kind:"varCompare", var:"loop.index", op:">", value:"1"}, blockName:"다음누르기") → move_step(그 분기, afterStepId: #5) 로 #6 앞으로 → wrap_steps([분기, "#6"], kind:"repeat", until:{kind:"not", condition:{kind:"exists", targetFromStep:"#7"}}, maxIterations:50, blockName:"쪽마다") → validate_recipe → run_sample → "1. #6 을 쪽마다 반복(최대 50번)으로 묶었습니다: 각 쪽의 행을 모두 읽고, 두 번째 쪽부터 먼저 "다음" 을 누릅니다. "다음" 이 없는 마지막 쪽까지 처리합니다."
사용자: 조회 결과가 없으면 넘어가게 해 줘
너: 뜻이 둘이다 → ask_choice("결과가 없을 때 어떻게 할까요?", [{label:"그 행은 실패로 남기고 다음 행", message:"조회 결과가 없으면 그 행을 실패로 남기고 다음 행으로 가 줘"}, {label:"뒤 스텝만 건너뛰고 성공 처리", message:"조회 결과가 없으면 뒤 스텝들을 건너뛰고 그 행은 성공으로 해 줘"}])`;

/** 지난 턴의 사용자 메시지에서 [맥락] 블록을 덜어 낸다 */
function stripContext(content) {
  if (typeof content !== 'string' || !content.startsWith(CONTEXT_HEAD)) return content;
  const i = content.indexOf(`\n${REQUEST_HEAD}\n`);
  return i < 0 ? content : `(그때의 맥락은 생략)\n${content.slice(i + 1)}`;
}

export class AgentSession {
  /**
   * @param {{recipeId: string, threads: import('./thread.js').ThreadStore, store: object, secrets: import('../secrets.js').SecretStore, settings: object,
   *          browserTarget: Function, canObserve: Function, onProgress?: Function, onDelta?: Function}} o
   */
  constructor({ recipeId, threads, store, secrets, settings, browserTarget, canObserve, onProgress, onDelta }) {
    this.recipeId = recipeId;
    this.threads = threads;
    this.store = store;
    this.secrets = secrets;
    this.settings = settings;
    this.browserTarget = browserTarget; // () => { browser, profileDir } — 설정이 바뀌어도 최신 값을 쓴다
    this.canObserve = canObserve; // () => 오류 문구 | null
    this.onProgress = onProgress;
    this.onDelta = onDelta;
    this.running = false;
    this.observer = null;
    this.idleTimer = null;
    this.redactor = new Redactor();
    this.sessionId = recipeId;
  }

  get thread() {
    return this.threads.load(this.recipeId);
  }

  progress(text) {
    this.onProgress?.({ recipeId: this.recipeId, sessionId: this.sessionId, text: this.redactor.text(String(text)) });
  }

  save() {
    this.threads.save(this.thread, this.redactor);
  }

  view() {
    return this.threads.view(this.thread, { running: this.running });
  }

  // ---------- 관찰 브라우저 ----------
  closeObserver() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const o = this.observer;
    this.observer = null;
    return o ? o.close().catch(() => {}) : Promise.resolve();
  }

  idleObserver() {
    clearTimeout(this.idleTimer);
    if (!this.observer) return;
    this.idleTimer = setTimeout(() => this.closeObserver(), OBSERVER_IDLE_MS);
    this.idleTimer.unref?.();
  }

  async observerFor(working, { sample = {}, allowRisky, params }) {
    const busy = this.canObserve();
    if (busy) throw new Error(busy);
    clearTimeout(this.idleTimer);
    const sampleRow = { ...sampleRowFrom(working), ...sample };
    if (!this.observer) {
      this.progress('숨긴 브라우저를 여는 중…');
      this.observer = new Observer({ recipe: working, ...this.browserTarget(), sampleRow, allowRisky, params, onLog: (m) => this.progress(`  ${m}`) });
      await this.observer.open();
    } else {
      Object.assign(this.observer, { recipe: working, sampleRow, allowRisky: !!allowRisky, params });
    }
    return this.observer;
  }

  // ---------- 대기 제안 ----------
  markDisplay(state, from = ['pending']) {
    for (const d of this.thread.display) if (d.changeState && from.includes(d.changeState)) d.changeState = state;
  }

  /** 대기 제안 적용·버리기 (상태만 바꾼다 — 레시피 저장은 부르는 쪽) */
  settlePending(action) {
    const th = this.thread;
    const p = th.pending;
    if (!p) return null;
    if (action === 'apply') {
      this.markDisplay('applied');
      th.lastSeen = p.recipe;
    } else {
      this.markDisplay('discarded');
      th.lastSeen = p.base ?? th.lastSeen;
    }
    th.pending = null;
    this.save();
    return p;
  }

  clear() {
    this.closeObserver();
    this.threads.clear(this.recipeId);
  }

  // ---------- 지난 실행 ----------
  async runsOfRecipe() {
    return (await this.store.listRuns()).filter((r) => r.recipe?.id === this.recipeId);
  }

  async lastRun(runId) {
    const id = runId || (await this.runsOfRecipe())[0]?.runId;
    if (!id) return { error: '이 레시피의 실행 기록이 없습니다.' };
    const r = await this.store.getRun(id);
    const numbers = this.working ? stepNumbers(this.working) : new Map();
    const failed = (r.rows ?? []).filter((x) => x.status === 'failed');
    return {
      runId: r.runId,
      status: r.status,
      startedAt: r.startedAt,
      totals: r.totals,
      error: r.error ?? undefined,
      excel: r.excel ? { file: r.excel.file, headers: r.excel.headers, rowCount: r.excel.rowCount } : undefined,
      failedRows: failed.slice(0, 20).map((x) => ({
        row: x.rowNumber,
        label: x.label || undefined,
        error: x.error,
        detail: x.errorDetail ? String(x.errorDetail).slice(0, 600) : undefined,
        step: x.failure ? `${numbers.get(x.failure.stepId) ?? ''} ${x.failure.stepId} ${x.failure.desc ?? ''}`.trim() : undefined,
        screenshot: !!x.screenshot,
      })),
      okRowValues: (r.rows ?? []).filter((x) => x.status === 'ok').slice(0, 3).map((x) => ({ row: x.rowNumber, values: x.values })),
      logTail: String(r.log ?? '').split('\n').filter(Boolean).slice(-40),
    };
  }

  async failureShot(runId, row) {
    const id = runId || (await this.runsOfRecipe())[0]?.runId;
    if (!id) throw new Error('이 레시피의 실행 기록이 없습니다.');
    const r = await this.store.getRun(id);
    const x = (r.rows ?? []).find((y) => y.rowNumber === Number(row));
    if (!x) throw new Error(`${id} 실행에 ${row}행이 없습니다.`);
    if (!x.screenshot) throw new Error(`${row}행에는 실패 화면이 없습니다${x.status === 'ok' ? ' (성공한 행)' : ''}.`);
    const buf = await fs.readFile(this.store.runFile(id, x.screenshot));
    return { runId: id, row: x.rowNumber, error: x.error, dataUrl: `data:image/png;base64,${buf.toString('base64')}` };
  }

  // ---------- 시험 실행 (run_sample) ----------
  async sampleRows(rows, sampleValues, context, working) {
    const base = { ...sampleRowFrom(working), ...(context?.upload?.firstRow ?? {}) };
    const list = [];
    const perRow = Array.isArray(sampleValues) ? sampleValues : null;
    let extra = [];
    if (rows > 1 && context?.uploadId) {
      try {
        extra = (await readTable(this.store.uploadPath(context.uploadId))).rows;
      } catch {
        extra = [];
      }
    }
    if (rows > 1 && !extra.length) {
      const last = (await this.runsOfRecipe())[0];
      if (last) extra = ((await this.store.getRun(last.runId).catch(() => null))?.rows ?? []).map((x) => x.input ?? {});
    }
    for (let i = 0; i < rows; i += 1) {
      const fromFile = extra[i] ?? (i === 0 ? {} : null);
      if (!fromFile && !perRow?.[i]) break;
      list.push({ rowNumber: i + 1, values: { ...base, ...(fromFile ?? {}), ...(perRow ? perRow[i] ?? {} : sampleValues ?? {}) } });
    }
    return list;
  }

  async runSample(working, { rows, sampleValues }, { context, allowRisky, params }) {
    const obs = await this.observerFor(working, { allowRisky, params });
    const sess = obs.sess;
    const dir = path.join(this.threads.dirOf(this.recipeId), 'sample');
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(path.join(dir, 'files'), { recursive: true });
    const numbers = stepNumbers(working);
    const list = await this.sampleRows(Math.min(rows, MAX_SAMPLE_ROWS), sampleValues, context, working);
    const out = [];
    const log = [];
    for (const row of list) {
      this.progress(`시험 실행: ${row.rowNumber}행`);
      sess.aborted = false;
      await sess.resetRow();
      const values = {};
      const files = [];
      const note = (m) => {
        log.push(`${row.rowNumber}행 ${m}`);
        this.progress(`  ${m}`);
      };
      const scope = new Scope({ recipe: working, row: row.values, rowNumber: row.rowNumber, params, extracted: values, dialog: () => sess.lastDialogMessage });
      const rc = {
        sess,
        scope,
        recipe: working,
        options: { headless: true },
        runDir: dir,
        filesDir: path.join(dir, 'files'),
        log: (_l, m) => note(m),
        sleep,
        waitUser: async () => {},
        addFile: (abs) => files.push(path.relative(dir, abs).split(path.sep).join('/')),
        guardClick: (loc) => obs.guard(loc),
      };
      const executor = new Executor({
        recipe: working,
        log: (_l, m) => note(m),
        options: { headless: true },
        hooks: {
          before: (step) => {
            if (step.type === 'pause') return { skip: true, note: '시험 실행에서는 사용자 확인 대기를 건너뜁니다' };
            const risky = obs.riskyStep(step);
            if (risky) throw Object.assign(new Error(`"${risky}" 은(는) 되돌릴 수 없는 동작일 수 있어 시험 실행에서 누르지 않았습니다.`), { failure: { stepId: step.id, desc: stepText(step) } });
            return null;
          },
          step: (e) => e.status === 'start' && note(`${numbers.get(e.stepId) ?? ''} ${e.desc}`),
        },
      });
      const entry = working.blocks?.[working.entryBlock || 'main'] ?? [];
      try {
        if (entry[0]?.type !== 'navigate') {
          if (!working.startUrl) throw new Error('레시피에 시작 주소가 없습니다.');
          await doNavigate(rc, { url: working.startUrl });
        }
        await executor.runRow(rc);
        out.push({ row: row.rowNumber, status: 'ok', values, files });
      } catch (e) {
        const f = e.failure;
        out.push({ row: row.rowNumber, status: 'failed', error: String(e.message ?? '').split('\n').slice(0, 2).join(' — '), step: f ? `${numbers.get(f.stepId) ?? ''} ${f.stepId} ${f.desc ?? ''}`.trim() : undefined, values, files });
      }
    }
    if (!list.length) return { error: '시험할 행 값을 만들지 못했습니다. sampleValues 로 값을 주세요.' };
    return { rows: out, input: list.map((r) => ({ row: r.rowNumber, values: r.values })), logTail: log.slice(-40) };
  }

  // ---------- 맥락 ----------
  async contextBlock({ working, context, userChanges }) {
    const c = context && typeof context === 'object' ? context : {};
    const numbers = stepNumbers(working);
    const stepLine = (id) => {
      const f = Object.values(working.blocks ?? {})
        .flat()
        .find((s) => s?.id === id);
      return f ? `${numbers.get(id) ?? ''} ${id} ${stepText(f)}` : `${id} (지금 레시피에 없음)`;
    };
    const L = [CONTEXT_HEAD];
    L.push(`화면: ${PAGE_WORDS[c.page] ?? PAGE_WORDS.other}`);
    const sel = (Array.isArray(c.selectedStepIds) ? c.selectedStepIds : []).filter((x) => typeof x === 'string').slice(0, 30);
    if (sel.length) L.push(`사용자가 고른 스텝:\n${sel.map((id) => `- ${stepLine(id)}`).join('\n')}`);
    if (typeof c.openStepId === 'string' && c.openStepId) L.push(`펼쳐 둔 스텝: ${stepLine(c.openStepId)}`);
    if (c.upload && typeof c.upload === 'object') {
      const headers = (Array.isArray(c.upload.headers) ? c.upload.headers : []).slice(0, 40);
      const first = c.upload.firstRow && typeof c.upload.firstRow === 'object' ? c.upload.firstRow : {};
      L.push(`올린 엑셀 열: ${headers.join(', ') || '(없음)'}`);
      const cells = headers.map((h) => `${h}=${String(first[h] ?? '').slice(0, 40)}`).join(', ');
      if (cells) L.push(`엑셀 첫 행: ${cells}`);
    }
    if (c.runId || c.rowNumber) {
      try {
        const r = await this.lastRun(c.runId);
        const row = c.rowNumber ? r.failedRows?.find((x) => x.row === Number(c.rowNumber)) : null;
        L.push(`보고 있는 실행: ${r.runId ?? c.runId} (${r.status ?? '?'}${r.totals ? `, ${r.totals.rows}행 중 성공 ${r.totals.ok}·실패 ${r.totals.failed}` : ''})`);
        if (c.rowNumber) L.push(row ? `보고 있는 행: ${row.row}행 실패 — ${row.error}${row.step ? ` [스텝 ${row.step}]` : ''}` : `보고 있는 행: ${c.rowNumber}행`);
      } catch {
        /* 실행 기록이 없으면 넘어간다 */
      }
    } else {
      const last = (await this.runsOfRecipe().catch(() => []))[0];
      if (last) L.push(`마지막 실행: ${last.runId} ${last.status} — ${last.totals?.rows ?? 0}행 중 성공 ${last.totals?.ok ?? 0}·실패 ${last.totals?.failed ?? 0}${last.error ? ` (${firstLine(last.error)})` : ''} (자세히는 get_last_run)`);
    }
    const masked = maskRecipe(working);
    L.push(`레시피: ${masked.name ?? ''} · 시작 주소 ${masked.startUrl ?? '(없음)'} · 행 실패 처리 ${masked.loop?.onRowError ?? 'skip'}`);
    L.push(`스텝 (번호는 화면과 같다):\n${recipeOverview(masked).join('\n') || '(스텝 없음)'}`);
    L.push(`변수: ${variablesLine(masked)}`);
    const problems = recipeProblems(working);
    if (problems.length) L.push(`검사에서 고칠 점:\n${problems.slice(0, 10).map((p) => `- ${p}`).join('\n')}`);
    const notes = this.threads.notes(this.recipeId).trim();
    if (notes) L.push(`레시피 메모:\n${notes.slice(0, 3000)}`);
    if (userChanges?.length) L.push(`지난 AI 턴 이후 사용자가 직접 바꾼 것:\n${userChanges.map((x) => `- ${x}`).join('\n')}`);
    return L.join('\n');
  }

  // ---------- 지난 대화 정리 ----------
  compactHistory() {
    const msgs = this.thread.messages;
    // 사용자 요청 KEEP_TURNS 개만 남긴다 (도구 결과가 짝을 잃지 않게 사용자 메시지에서 자른다)
    const starts = msgs.map((m, i) => (m.role === 'user' && typeof m.content === 'string' && !m.attachment ? i : -1)).filter((i) => i >= 0);
    if (starts.length > KEEP_TURNS) msgs.splice(0, starts[starts.length - KEEP_TURNS]);
    const names = new Map();
    const refs = [];
    msgs.forEach((m, i) => {
      for (const c of m.tool_calls ?? []) {
        names.set(c.id, c.function?.name);
        try {
          refs.push([i, refsIn(JSON.parse(c.function?.arguments || '{}'))]);
        } catch {
          /* 인자가 JSON 이 아니면 무시 */
        }
      }
    });
    msgs.forEach((m, i) => {
      if (m.role === 'user') {
        if (Array.isArray(m.content)) m.content = `${m.content.map((p) => p.text ?? '').join('\n')}\n(이미지는 지난 대화라 뺐습니다)`;
        else m.content = stripContext(m.content);
      } else if (m.role === 'tool') {
        const later = new Set(refs.filter(([j]) => j > i).flatMap(([, s]) => [...s]));
        m.content = compactToolResult(names.get(m.tool_call_id), m.content, later);
      }
    });
  }

  /** 모델에 보낼 메시지 (Anthropic 모델이면 시스템·이번 요청에 캐시 표시) */
  request(model, turnStart) {
    const cache = isAnthropicModel(model);
    const system = cache ? { role: 'system', content: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }] } : { role: 'system', content: SYSTEM_PROMPT };
    const msgs = this.thread.messages.map((m, i) => {
      const out = { role: m.role, content: m.content };
      if (m.tool_calls) out.tool_calls = m.tool_calls;
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      if (cache && i === turnStart && typeof m.content === 'string') out.content = [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }];
      return out;
    });
    return [system, ...msgs];
  }

  // ---------- 한 턴 ----------
  /**
   * @param {{message: string, recipe: object, context?: object, allowRisky?: boolean, legacy?: boolean, sessionId?: string, previousApplied?: boolean}} o
   * @returns {Promise<object>} POST /api/agent/turn 응답
   */
  async turn({ message, recipe, context, allowRisky = false, legacy = false, sessionId, previousApplied = true }) {
    const t0 = Date.now();
    clearTimeout(this.idleTimer); // 이번 턴 동안은 관찰 브라우저를 닫지 않는다
    this.sessionId = legacy && sessionId ? sessionId : this.recipeId;
    const th = this.thread;
    const cfg = this.settings.openrouter;

    // 1. 대기 제안: 새 화면은 서버의 제안 위에 이어서 고친다. 옛 화면은 제안을 직접 들고 있으므로 보낸 레시피로 판단한다.
    let continuing = false;
    if (th.pending) {
      if (!legacy) continuing = true;
      else if (previousApplied === false) this.settlePending('discard');
      else if (JSON.stringify(recipe) === JSON.stringify(th.pending.recipe)) continuing = true;
      else this.settlePending('apply');
    }
    const working = structuredClone(continuing && !legacy ? th.pending.recipe : recipe);

    // 2. 비밀값: 레시피의 비밀 기본값은 저장소로 옮기고, 저장된 값은 관찰·시험 실행에만 쓴다 (AI 에는 가린다)
    const defaults = secretDefaultsOf(working);
    if (working.id === this.recipeId) await moveSecretDefaults(this.secrets, working);
    stripSecrets(working);
    const before = structuredClone(working);
    const params = { ...(await this.secrets.getAll(this.recipeId).catch(() => ({}))), ...defaults };
    this.redactor.add(params);
    this.working = working;

    // 3. 이번 요청 메시지: [맥락] + [요청]
    const userChanges = continuing ? [] : recipeDiff(th.lastSeen, working);
    const ctxText = await this.contextBlock({ working, context, userChanges });
    const text = String(message);
    this.compactHistory();
    const turnStart = th.messages.length;
    th.messages.push({ role: 'user', content: this.redactor.text(`${ctxText}\n\n${REQUEST_HEAD}\n${text}`) });
    this.threads.addDisplay(th, { role: 'user', text: this.redactor.text(text), ...(context?.page ? { context: { page: context.page, selectedStepIds: context.selectedStepIds, rowNumber: context.rowNumber } } : {}) });
    this.save();

    const tools = new RecipeTools(working, {
      observe: async (stepId, sample) => {
        const obs = await this.observerFor(working, { sample, allowRisky, params });
        this.progress(stepId ? `화면 관찰: ${stepNumbers(working).get(stepId) ?? ''} ${stepId} 스텝까지 실행` : '화면 관찰: 시작 주소 열기');
        const run = await obs.runTo(stepId);
        const shot = await obs.snapshot();
        const head = run.ok ? `실행 성공 (${stepId ?? '시작 주소'})` : `실행 실패${run.failedStep ? ` — 스텝 ${run.failedStep}` : ''}: ${run.error}`;
        return `${head}\n현재 화면 요소 (참조 번호를 targetRef 로 쓴다):\n${shot}`;
      },
      targetFor: async (ref, opts) => {
        if (!this.observer) throw new Error('먼저 observe_page 로 화면을 관찰하세요.');
        return opts ? this.observer.targetFor(ref, opts) : this.observer.targetFor(ref);
      },
      listTargetFor: async (ref) => {
        if (!this.observer) throw new Error('먼저 observe_page 로 화면을 관찰하세요.');
        return this.observer.listTargetFor(ref);
      },
      runSample: (o) => this.runSample(working, o, { context, allowRisky, params }),
      lastRun: (runId) => this.lastRun(runId),
      failureShot: (runId, row) => this.failureShot(runId, row),
      remember: (note) => {
        const notes = this.threads.appendNote(this.recipeId, this.redactor.text(String(note ?? '')));
        return { ok: true, lines: notes.split('\n').filter(Boolean).length };
      },
    });

    const turnUsage = { prompt: 0, completion: 0, cost: 0 };
    let reply = '';
    let rounds = 0;
    let firstTokenMs = null;
    let model = cfg.model;
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        rounds = round + 1;
        const left = MAX_TOOL_ROUNDS - round - 1;
        this.progress(round === 0 ? 'AI가 생각하는 중…' : `AI가 다음 단계를 정하는 중… (남은 단계 ${left})`);
        const sentAt = Date.now();
        const r = await chat(cfg, {
          messages: this.request(cfg.model, turnStart),
          tools: TOOL_DEFS,
          onDelta: (piece) => this.onDelta?.({ recipeId: this.recipeId, text: this.redactor.text(piece), round }),
          redact: (s) => this.redactor.text(s),
        });
        if (firstTokenMs === null && r.firstTokenMs !== null && r.firstTokenMs !== undefined) firstTokenMs = sentAt - t0 + r.firstTokenMs;
        if (r.model) model = r.model;
        if (r.usage) {
          turnUsage.prompt += r.usage.prompt_tokens ?? 0;
          turnUsage.completion += r.usage.completion_tokens ?? 0;
          turnUsage.cost += r.usage.cost ?? 0;
        }
        const msg = r.message;
        const calls = msg.tool_calls ?? [];
        th.messages.push({ role: 'assistant', content: msg.content ? this.redactor.text(String(msg.content)) : calls.length ? null : '', ...(calls.length ? { tool_calls: calls } : {}) });
        if (msg.content && calls.length) this.progress(`AI: ${String(msg.content).slice(0, 200)}`);
        if (!calls.length) {
          reply = msg.content ?? '';
          break;
        }
        for (const call of calls) {
          let result;
          try {
            const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
            this.progress(toolLabel(call.function.name, args));
            result = await tools.call(call.function.name, args);
          } catch (e) {
            result = { error: e.message };
            this.progress(`  ⚠ ${e.message}`);
          }
          th.messages.push({ role: 'tool', tool_call_id: call.id, content: this.redactor.text(typeof result === 'string' ? result : JSON.stringify(result)) });
        }
        if (tools.attachments.length) {
          const att = tools.attachments.splice(0);
          th.messages.push({ role: 'user', attachment: true, content: [{ type: 'text', text: att.map((a) => a.text).join('\n') }, ...att.map((a) => ({ type: 'image_url', image_url: { url: a.url } }))] });
        }
        if (tools.choice) {
          reply = [msg.content, tools.choice.question].filter(Boolean).join('\n\n');
          break;
        }
        if (round === MAX_TOOL_ROUNDS - 1) reply = `도구 호출이 ${MAX_TOOL_ROUNDS}번을 넘어 여기서 멈췄습니다. 지금까지의 변경을 확인해 주세요.`;
      }
    } catch (e) {
      // 대화가 어긋나지 않게 이번 턴의 도구 호출은 지우고 요청과 오류만 남긴다
      th.messages.splice(turnStart + 1);
      th.messages.push({ role: 'assistant', content: `(이 요청은 오류로 끝나 레시피를 바꾸지 않았다: ${firstLine(e.message)})` });
      this.threads.addDisplay(th, { role: 'error', text: this.redactor.text(e.message) });
      this.save();
      this.metric({ t0, firstTokenMs, rounds, cost: turnUsage.cost, model, error: true });
      throw e;
    } finally {
      this.idleObserver();
    }

    // 4. 결과 → 대기 제안·표시·사용량
    const problems = recipeProblems(working);
    const changed = tools.changes.length > 0;
    let changes = tools.changes;
    if (changed) {
      if (continuing && th.pending) {
        this.markDisplay('merged');
        changes = [...th.pending.changes, ...tools.changes];
        th.pending = { recipe: working, changes, problems, base: th.pending.base };
      } else th.pending = { recipe: working, changes, problems, base: before };
    }
    th.lastSeen = working;
    th.usage.prompt += turnUsage.prompt;
    th.usage.completion += turnUsage.completion;
    th.usage.cost += turnUsage.cost;
    const choices = tools.choice?.options;
    const entry = this.threads.addDisplay(th, {
      role: 'assistant',
      text: this.redactor.text(reply || '(답변 없음)'),
      usage: { cost: turnUsage.cost, model },
      ...(changed ? { changes, changeState: 'pending' } : {}),
      ...(choices ? { choices } : {}),
    });
    this.save();
    const ms = this.metric({ t0, firstTokenMs, rounds, cost: turnUsage.cost, model });
    return {
      reply: entry.text,
      recipe: working,
      changes: legacy ? tools.changes : changed ? changes : [],
      problems,
      ...(choices ? { choices } : {}),
      usage: { turn: turnUsage, total: th.usage, model, cost: turnUsage.cost },
      display: th.display,
      ms,
    };
  }

  metric({ t0, firstTokenMs, rounds, cost, model, error }) {
    const ms = Date.now() - t0;
    this.threads.metric({ at: new Date().toISOString(), recipeId: this.recipeId, ms, firstTokenMs, rounds, cost, model, ...(error ? { error: true } : {}) });
    return ms;
  }
}

function toolLabel(name, a) {
  switch (name) {
    case 'get_recipe':
      return '레시피 읽기';
    case 'get_step':
      return `스텝 ${a.stepId} 자세히 보기`;
    case 'update_step':
      return `스텝 ${a.stepId} 수정`;
    case 'insert_steps':
      return `스텝 ${a.steps?.length ?? 0}개 추가`;
    case 'delete_steps':
      return `스텝 삭제: ${(a.stepIds ?? []).join(', ')}`;
    case 'move_step':
      return `스텝 ${a.stepId} 이동`;
    case 'set_variables':
      return '변수 설정';
    case 'rename_variable':
      return `변수 이름 바꾸기: ${a.from} → ${a.to}`;
    case 'set_recipe_fields':
      return '레시피 설정 변경';
    case 'wrap_steps':
      return `스텝 ${(a.stepIds ?? []).join(', ')} 묶기 (${a.kind})`;
    case 'unwrap_step':
      return `스텝 ${a.stepId} 풀기`;
    case 'validate_recipe':
      return '레시피 검사';
    case 'observe_page':
      return `화면 관찰 요청 (${a.runUntilStepId ?? '시작 주소'})`;
    case 'describe_target':
      return `요소 ${a.ref} 확인`;
    case 'make_list_target':
      return `목록 ${a.ref} 찾기`;
    case 'get_last_run':
      return '최근 실행 결과 보기';
    case 'get_failure_screenshot':
      return `${a.row}행 실패 화면 보기`;
    case 'run_sample':
      return `시험 실행 (${a.rows ?? 1}행)`;
    case 'remember':
      return '메모 남기기';
    case 'ask_choice':
      return '선택지 묻기';
    default:
      return name;
  }
}
