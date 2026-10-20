// AI 도우미 대화 세션. 레시피 사본을 도구로 고치고, 결과(변경 목록 + 수정본)를 돌려준다. 저장은 사용자가 한다.

import { chat } from './openrouter.js';
import { TOOL_DEFS, RecipeTools } from './tools.js';
import { Observer, sampleRowFrom } from './observer.js';

const MAX_TOOL_ROUNDS = 30;
const OLD_TOOL_RESULT_CHARS = 600;

const SYSTEM_PROMPT = `너는 웹 업무 자동화 도구 "web-rpa"의 레시피 편집 도우미다. 사용자는 웹 작업을 녹화해 레시피 초안을 만들었고, 너는 대화로 그 레시피를 다듬는다. 한국어로 짧고 정확하게 답한다.

## 레시피 구조
- blocks: { 블록이름: 스텝[] }, entryBlock(기본 main). 엑셀 파일을 넣으면 main 블록 전체가 엑셀 행마다 반복된다. 행 실패 처리 loop.onRowError: skip(기록하고 다음 행) | stop.
- 스텝 공통: id, type, optional(대상이 없으면 2초 뒤 건너뜀), onError:"continue"(실패해도 다음 스텝), attempts(총 시도 횟수), timeoutMs(기본 10000), disabled.
- 스텝 종류:
  navigate{url} · click{target} · dblclick{target} · input{target,value} · select{target,value,label?} · check{target,checked}
  keypress{key, target?} · wait{condition,timeoutMs?} · sleep{ms} · extract{target,saveAs,attr?} (읽은 값은 변수 saveAs 와 결과 엑셀 열이 된다)
  assert{condition,message,onFail?:"warn"} · branch{condition,then:블록,else?:블록} (then/else 블록을 실행하고 다음 스텝으로 돌아온다)
  dialog{action:"accept"|"dismiss",promptText?} (바로 다음에 뜨는 알림창 처리 방침. 알림창을 띄우는 클릭 "앞"에 둔다)
  pdf{fileName,landscape?} · screenshot{fileName} · download{target,fileName?} (클릭해서 내려받기) · upload{target,path} · pause{message} (사람 확인 대기) · closeTab{}
- 조건: {kind:"exists",target} · {kind:"textVisible",text} · {kind:"urlContains",value} · {kind:"varEquals",var,value} · {kind:"dialogContains",value} (직전 동작이 띄운 알림 문구) · {kind:"not",condition} · {kind:"all"|"any",conditions:[…]}
- 값 치환: {{변수id}} · {{row}}(행 번호) · {{sys:date:YYYYMMDD}} · {{sys:month:-1}} · {{sys:quarter}} · {{값|digits}}(숫자만) · |trim · |default:x. 정의되지 않은 변수는 실행 오류다.
- 변수: {id,name,source} — source.kind: excel{column} | static{value} | prompt{default?,secret?}. 엑셀 열로 바꾸려면 값을 {{열이름}} 으로 바꾸고 excel 변수를 추가한다(id=name=column 권장).
- target(대상 요소)은 점수 붙은 후보 선택자 목록이다. 직접 만들지 말 것: 기존 스텝의 요소는 targetFromStep:"스텝id", 새 요소는 observe_page 로 화면을 본 뒤 targetRef:"f0e12" 로 지정한다. 조건 안의 target 도 같다.

## 일하는 방식
1. 먼저 get_recipe 로 현재 레시피를 본다.
2. 녹화 때 건드리지 않은 요소(결과 표의 값, 새 버튼 등)가 필요하면 observe_page(runUntilStepId=그 화면이 나오는 스텝) 로 화면을 보고 참조 번호를 고른다. 관찰은 실제 사이트에서 클릭이 일어나므로, 제출·신고·결제·삭제처럼 되돌릴 수 없는 동작 전 스텝까지만 실행한다. 관찰이 실패하면 오류와 그때 화면을 함께 받는다 — 원인 분석에 활용한다.
3. 사용자가 요청한 것만 고친다. 요청이 모호하면 고치지 말고 질문한다.
4. 화면이 늦게 바뀌는 곳은 wait(textVisible 또는 exists)로 기다리게 한다. 고정 sleep 은 최후 수단.
5. 고친 뒤 validate_recipe 를 호출해 문제를 없앤다.
6. 마지막 답변: 무엇을 바꿨는지 번호 목록으로 짧게 요약하고, 사용자가 확인하거나 직접 해야 할 일(파일 경로, 로그인, 엑셀 열 이름 등)을 적는다. 변경은 사용자가 [적용]을 눌러야 반영된다는 점을 기억한다.`;

export class AgentSession {
  constructor({ id, settings, browserTarget, canObserve, onProgress }) {
    this.id = id;
    this.settings = settings;
    this.browserTarget = browserTarget; // () => { browser, profileDir } — 설정이 바뀌어도 최신 값을 쓴다
    this.canObserve = canObserve; // () => 오류 문구 | null
    this.onProgress = onProgress;
    this.messages = [];
    this.lastChanged = false;
    this.usage = { prompt: 0, completion: 0, cost: 0 };
    this.touchedAt = Date.now();
  }

  progress(text) {
    this.onProgress?.({ sessionId: this.id, text });
  }

  /** 이전 턴의 큰 도구 결과(화면 목록 등)는 줄여서 비용을 아낀다. */
  compactHistory() {
    for (const m of this.messages) {
      if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > OLD_TOOL_RESULT_CHARS) {
        m.content = `${m.content.slice(0, OLD_TOOL_RESULT_CHARS)}\n…(이전 결과 생략 — 필요하면 다시 호출)`;
      }
    }
  }

  /**
   * @returns {Promise<{reply: string, recipe: object, changes: string[], usage: object}>}
   */
  async turn({ message, recipe, allowRisky = false, previousApplied = true }) {
    this.touchedAt = Date.now();
    const cfg = this.settings.openrouter;
    const working = structuredClone(recipe);
    let observer = null;
    const turnUsage = { prompt: 0, completion: 0, cost: 0 };

    const env = {
      observe: async (stepId, sample) => {
        const busy = this.canObserve();
        if (busy) throw new Error(busy);
        if (!observer) {
          this.progress('숨긴 브라우저를 여는 중…');
          observer = new Observer({ recipe: working, ...this.browserTarget(), sampleRow: { ...sampleRowFrom(working), ...sample }, allowRisky, onLog: (m) => this.progress(`  ${m}`) });
          await observer.open();
        } else {
          observer.recipe = working;
          observer.sampleRow = { ...sampleRowFrom(working), ...sample };
        }
        this.progress(stepId ? `화면 관찰: ${stepId} 스텝까지 실행` : '화면 관찰: 시작 주소 열기');
        const run = await observer.runTo(stepId);
        const shot = await observer.snapshot();
        const head = run.ok ? `실행 성공 (${stepId ?? '시작 주소'})` : `실행 실패${run.failedStep ? ` — 스텝 ${run.failedStep}` : ''}: ${run.error}`;
        return `${head}\n현재 화면 요소 (참조 번호를 targetRef 로 쓴다):\n${shot}`;
      },
      targetFor: async (ref) => {
        if (!observer) throw new Error('먼저 observe_page 로 화면을 관찰하세요.');
        return observer.targetFor(ref);
      },
    };
    const tools = new RecipeTools(working, env);

    this.compactHistory();
    const note = !previousApplied && this.lastChanged ? '(메모: 사용자가 직전 제안을 적용하지 않았다. 지금 레시피는 그 변경이 없는 상태다.)\n' : '';
    this.messages.push({ role: 'user', content: note + message });

    let reply = '';
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        this.progress(round === 0 ? 'AI가 생각하는 중…' : 'AI가 다음 단계를 정하는 중…');
        const { message: msg, usage } = await chat(cfg, { messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...this.messages], tools: TOOL_DEFS });
        if (usage) {
          turnUsage.prompt += usage.prompt_tokens ?? 0;
          turnUsage.completion += usage.completion_tokens ?? 0;
          turnUsage.cost += usage.cost ?? 0;
        }
        const calls = msg.tool_calls ?? [];
        this.messages.push({ role: 'assistant', content: msg.content ?? (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls } : {}) });
        if (msg.content && calls.length) this.progress(`AI: ${String(msg.content).slice(0, 200)}`);
        if (!calls.length) {
          reply = msg.content ?? '';
          break;
        }
        for (const call of calls) {
          let args = {};
          let result;
          try {
            args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
            this.progress(toolLabel(call.function.name, args));
            result = await tools.call(call.function.name, args);
          } catch (e) {
            result = { error: e.message };
            this.progress(`  ⚠ ${e.message}`);
          }
          this.messages.push({ role: 'tool', tool_call_id: call.id, content: typeof result === 'string' ? result : JSON.stringify(result) });
        }
        if (round === MAX_TOOL_ROUNDS - 1) reply = '도구 호출이 너무 많아 여기서 멈췄습니다. 지금까지의 변경을 확인해 주세요.';
      }
    } finally {
      if (observer) await observer.close().catch(() => {});
    }
    this.lastChanged = tools.changes.length > 0;
    this.usage.prompt += turnUsage.prompt;
    this.usage.completion += turnUsage.completion;
    this.usage.cost += turnUsage.cost;
    return { reply, recipe: working, changes: tools.changes, usage: { turn: turnUsage, total: this.usage, model: cfg.model } };
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
    case 'set_recipe_fields':
      return '레시피 설정 변경';
    case 'validate_recipe':
      return '레시피 검사';
    case 'observe_page':
      return `화면 관찰 요청 (${a.runUntilStepId ?? '시작 주소'})`;
    case 'describe_target':
      return `요소 ${a.ref} 확인`;
    default:
      return name;
  }
}
