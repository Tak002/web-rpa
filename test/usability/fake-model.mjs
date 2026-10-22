// 사용성 평가용 시나리오 가짜 OpenRouter (스트리밍 SSE · JSON 둘 다).
// 마지막 [요청] 글의 낱말로 과제를 고르고, 그 뒤에 부른 도구와 결과를 보고 다음 도구를 정한다.
// 모델의 말귀를 재는 것이 아니라 화면·연결(도구 → 제안 카드 → 적용 → 실행)을 재는 대본이다.

import http from 'node:http';

const textOf = (c) => (Array.isArray(c) ? c.map((p) => p?.text ?? '').join('\n') : String(c ?? ''));
let callNo = 0;
const call = (name, args) => ({ id: `call_${(callNo += 1)}_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const say = (content) => ({ role: 'assistant', content });
const use = (content, ...calls) => ({ role: 'assistant', content, tool_calls: calls });

/** [맥락] 의 스텝 개요 한 줄 → { no, id, label, text, depth } */
function overview(user) {
  const out = [];
  const at = user.indexOf('스텝 (번호는 화면과 같다):');
  if (at < 0) return out;
  for (const line of user.slice(at).split('\n').slice(1)) {
    const m = /^(\s*)(#[\d.-]+) (\S+) ([^:]+): (.*)$/.exec(line);
    if (!m) break;
    out.push({ depth: m[1].length / 2, no: m[2], id: m[3], label: m[4], text: m[5] });
  }
  return out;
}

/** 관찰 결과에서 금액 칸·다음 단추 참조 */
function refsFrom(obs) {
  const lines = String(obs).split('\n');
  const amount = lines.map((l) => /^(f\d+e\d+) .*col="금액"/.exec(l)?.[1]).filter(Boolean);
  const next = lines.map((l) => /^(f\d+e\d+) button "다음"/.exec(l)?.[1]).find(Boolean);
  return { amount, next };
}

/** 과제 대본: (요청 글, [맥락], 이번 턴에 부른 도구 [{name,args,result}]) → 다음 assistant 메시지 */
export function scriptFor(request, user, done) {
  const steps = overview(user);
  const called = (n) => done.filter((d) => d.name === n);
  const has = (...words) => words.every((w) => request.includes(w));

  // ---- T1: 설명 ----
  if (has('하는 일')) {
    const lines = steps.map((s) => `${s.no} ${s.label}: ${s.text}`).slice(0, 8);
    return say(`이 레시피는 스텝 ${steps.length}개로 되어 있습니다.\n${lines.join('\n')}\n원하시면 조회 뒤 기다리기, 값 읽기 같은 스텝을 더해 드릴게요.`);
  }
  // ---- T1: 조회 뒤 기다리기 넣기 ----
  if (has('기다리')) {
    const click = steps.find((s) => s.label === '클릭' && s.text.includes('조회')) ?? steps.at(-1);
    if (!called('insert_steps').length) return use('조회 단추 뒤에 결과가 뜰 때까지 기다리는 스텝을 넣겠습니다.', call('insert_steps', { afterStepId: click.no, steps: [{ type: 'wait', condition: { kind: 'textVisible', text: '조회 완료' }, timeoutMs: 15000 }] }));
    if (!called('validate_recipe').length) return use(null, call('validate_recipe', {}));
    return say(`${click.no} 조회 클릭 뒤에 "조회 완료" 글자가 보일 때까지 기다리는 스텝을 넣었습니다. [적용] 을 눌러 반영하세요.`);
  }
  // ---- T2: 로그인 뒤 화면 관찰 (저장된 비밀값으로 로그인) ----
  if (has('로그인 뒤')) {
    const login = steps.find((s) => s.label === '클릭' && s.text.includes('로그인')) ?? steps.at(-1);
    if (!called('observe_page').length) return use('로그인까지 실행해 화면을 보겠습니다.', call('observe_page', { runUntilStepId: login.no }));
    const obs = String(called('observe_page')[0].result);
    const head = obs.split('\n').slice(0, 2).join(' / ');
    const ok = /원장|ledger/.test(obs);
    return say(`관찰 결과: ${head}\n${ok ? '저장된 비밀번호로 로그인해 원장 조회 화면까지 들어갔습니다. "조회" 단추가 보입니다.' : '로그인 화면을 넘지 못했습니다.'}`);
  }
  // ---- T7: 다음 쪽이 없을 때까지 ----
  if (has('다음 쪽')) {
    const rep = steps.find((s) => s.label === '반복' && s.depth === 0);
    if (rep && !called('unwrap_step').length) return use('지금 반복은 마지막 쪽을 읽기 전에 끝납니다. 구조를 다시 잡겠습니다.', call('unwrap_step', { stepId: rep.id }));
    const loop = steps.find((s) => s.label === '목록의 항목마다');
    const next = steps.find((s) => s.label === '클릭' && s.text.includes('다음'));
    if (!loop || !next) return say('목록 반복과 "다음" 클릭 스텝을 찾지 못했습니다.');
    if (!called('wrap_steps').length)
      return use('"다음" 클릭은 두 번째 쪽부터 누르게 하겠습니다.', call('wrap_steps', { stepIds: [next.id], kind: 'branch', condition: { kind: 'varCompare', var: 'loop.index', op: '>', value: '1' }, blockName: '다음누르기' }));
    if (!called('move_step').length) {
      const br = JSON.parse(String(called('wrap_steps')[0].result));
      return use(null, call('move_step', { stepId: br.stepId, afterStepId: steps.find((s) => s.label === '주소 이동')?.id ?? null }));
    }
    if (called('wrap_steps').length === 1) {
      const br = JSON.parse(String(called('wrap_steps')[0].result));
      return use('쪽마다 반복으로 묶고, "다음" 이 없으면 끝나게 하겠습니다.', call('wrap_steps', { stepIds: [br.stepId, loop.id], kind: 'repeat', until: { kind: 'not', condition: { kind: 'exists', targetFromStep: next.id } }, maxIterations: 20, blockName: '쪽마다' }));
    }
    if (!called('validate_recipe').length) return use(null, call('validate_recipe', {}));
    return say('쪽마다 반복(최대 20번)으로 바꿨습니다: 각 쪽에서 표의 행을 모두 읽고, 두 번째 쪽부터는 먼저 "다음" 을 누릅니다. "다음" 단추가 없는 쪽을 읽고 나면 끝납니다.');
  }
  // ---- T5: 결과 표의 행마다 금액 읽기 ----
  if (has('금액') && (has('행마다') || has('목록'))) {
    const nav = steps.find((s) => s.label === '주소 이동') ?? steps[0];
    if (!called('observe_page').length) return use('목록 화면을 열어 표를 보겠습니다.', call('observe_page', { runUntilStepId: nav.no }));
    const obs = String(called('observe_page')[0].result);
    const { amount } = refsFrom(obs);
    if (!amount.length) return say('화면에서 금액 칸을 찾지 못했습니다.');
    const ref = amount[0];
    if (!called('make_list_target').length) return use(`첫 행의 금액 칸(${ref})으로 표의 행 목록을 확인하겠습니다.`, call('make_list_target', { ref }));
    const loop = steps.find((s) => s.label === '목록의 항목마다');
    const ext = steps.find((s) => s.label === '값 읽기');
    if (!called('update_step').length && !called('wrap_steps').length && !called('insert_steps').length) {
      if (loop && ext) return use('목록 요소와 금액 읽기 대상을 고치겠습니다.', call('update_step', { stepId: loop.id, changes: { itemsRef: ref } }), call('update_step', { stepId: ext.id, changes: { targetRef: ref, withinRef: ref, saveAs: '금액' } }));
      if (ext) return use('금액 읽기를 목록의 항목마다로 묶겠습니다.', call('wrap_steps', { stepIds: [ext.id], kind: 'forEach', itemsRef: ref, maxItems: 100 }), call('update_step', { stepId: ext.id, changes: { targetRef: ref, withinRef: ref, saveAs: '금액' } }));
      return use('금액 읽기 스텝을 넣고 묶겠습니다.', call('insert_steps', { afterStepId: nav.id, steps: [{ type: 'extract', targetRef: ref, saveAs: '금액' }] }));
    }
    if (called('insert_steps').length && !called('wrap_steps').length) {
      const id = JSON.parse(called('insert_steps')[0].result).ids?.[0];
      return use(null, call('wrap_steps', { stepIds: [id], kind: 'forEach', itemsRef: ref }), call('update_step', { stepId: id, changes: { targetRef: ref, withinRef: ref } }));
    }
    if (!called('validate_recipe').length) return use(null, call('validate_recipe', {}));
    const lt = JSON.parse(String(called('make_list_target')[0].result));
    return say(`결과 표의 행 ${lt.count}개마다 금액을 읽도록 고쳤습니다 (첫 행: ${lt.sample?.[0] ?? ''}). 결과 엑셀의 "금액" 칸에 행마다 줄바꿈으로 남습니다. [적용] 후 저장하세요.`);
  }
  // ---- T8: 리포트 실패 행 ----
  if (has('실패했습니다')) {
    if (!called('get_last_run').length) return use('실행 기록을 보겠습니다.', call('get_last_run', {}));
    const lr = (() => {
      try {
        return JSON.parse(String(called('get_last_run')[0].result));
      } catch {
        return {};
      }
    })();
    const row = /보고 있는 행: (\d+)행 실패 — ([^\n[]+)/.exec(user);
    const f = lr.failedRows?.find((x) => String(x.row) === row?.[1]) ?? lr.failedRows?.[0];
    const err = (row?.[2] ?? f?.error ?? '').trim();
    const login = /아이디|로그인/.test(err);
    if (!called('ask_choice').length)
      return use(
        login
          ? `${row?.[1] ?? f?.row ?? '?'}행에서는 "${err.slice(0, 60)}" 오류가 났습니다. 1행에서 이미 로그인해 2행부터는 로그인 화면이 나오지 않기 때문입니다.`
          : `${row?.[1] ?? f?.row ?? '?'}행은 "${err.slice(0, 80)}" 오류로 멈췄습니다.`,
        call('ask_choice', {
          question: '어떻게 할까요?',
          options: login
            ? [
                { label: '로그인 화면일 때만 로그인하기', message: '로그인 화면이 나올 때만 로그인 스텝을 하게 고쳐 줘' },
                { label: '그대로 두기', message: '레시피는 그대로 둘게' },
              ]
            : [
                { label: '그 행만 실패로 남기고 계속', message: '이런 행은 실패로 남기고 다음 행으로 가 줘' },
                { label: '그대로 두기', message: '레시피는 그대로 둘게' },
              ],
        }),
      );
    return say('알겠습니다.');
  }
  if (has('로그인 화면이 나올 때만')) {
    const uid = steps.find((s) => s.label === '입력' && s.text.includes('아이디'));
    const pw = steps.find((s) => s.label === '입력' && s.text.includes('비밀번호'));
    const go = steps.find((s) => s.label === '클릭' && s.text.includes('로그인'));
    if (!uid || !go) return say('로그인 스텝을 찾지 못했습니다.');
    if (!called('wrap_steps').length)
      return use('아이디·비밀번호 입력과 로그인 클릭을 "아이디 칸이 있으면" 조건으로 묶겠습니다.', call('wrap_steps', { stepIds: [uid.id, pw?.id, go.id].filter(Boolean), kind: 'branch', condition: { kind: 'exists', targetFromStep: uid.id }, blockName: '로그인' }));
    if (!called('validate_recipe').length) return use(null, call('validate_recipe', {}));
    return say('로그인 화면(아이디 칸)이 있을 때만 로그인하도록 바꿨습니다. 이제 2행부터는 로그인 스텝을 건너뜁니다.');
  }
  // ---- T9: 고른 스텝 번호 되말하기 ----
  if (has('스텝을') && /#\d/.test(request)) {
    const sel = /사용자가 고른 스텝:\n((?:- .*\n?)+)/.exec(user)?.[1] ?? '';
    const nos = [...sel.matchAll(/^- (#[\d.]+) (\S+)/gm)].map((m) => `${m[1]}(${m[2]})`);
    return say(`고르신 스텝은 ${nos.join(', ') || '(없음)'} 입니다. 모두 값 읽기 스텝이고, 지금은 꺼 두지 않았습니다.`);
  }
  return say('알겠습니다. 무엇을 바꿀지 조금 더 알려 주세요.');
}

function writeSse(res, model, message, usage) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  res.write(': OPENROUTER PROCESSING\n\n');
  const chunk = (delta, extra = {}) => `data: ${JSON.stringify({ id: 'gen-usab', model, choices: [{ index: 0, delta, ...extra }] })}\n\n`;
  const out = [];
  for (const p of message.content ? message.content.match(/[\s\S]{1,8}/g) : []) out.push(chunk({ content: p }));
  (message.tool_calls ?? []).forEach((tc, i) => {
    out.push(chunk({ tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] }));
    out.push(chunk({ tool_calls: [{ index: i, function: { arguments: tc.function.arguments } }] }));
  });
  out.push(`data: ${JSON.stringify({ id: 'gen-usab', model, choices: [{ index: 0, delta: {}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage })}\n\n`, 'data: [DONE]\n\n');
  let i = 0;
  const next = () => {
    if (i >= out.length) return res.end();
    res.write(out[i]);
    i += 1;
    setTimeout(next, i === 1 ? 400 : 35); // 첫 글자까지 조금 기다린다 (사람이 스트리밍을 보게)
  };
  next();
}

/** @returns {Promise<{ server: http.Server, log: object[], url: string, close: () => Promise<void> }>} */
export function startFakeModel(port) {
  const log = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* 빈 본문 */
    }
    const msgs = body.messages ?? [];
    let at = -1;
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i].role === 'user' && textOf(msgs[i].content).includes('[요청]')) {
        at = i;
        break;
      }
    }
    const user = at >= 0 ? textOf(msgs[at].content) : '';
    const request = user.slice(user.lastIndexOf('[요청]') + 4).trim();
    // 이번 턴에 부른 도구와 그 결과
    const done = [];
    for (const m of msgs.slice(at + 1)) {
      if (m.role === 'assistant') for (const tc of m.tool_calls ?? []) done.push({ id: tc.id, name: tc.function?.name, args: tc.function?.arguments, result: null });
      if (m.role === 'tool') {
        const d = done.find((x) => x.id === m.tool_call_id);
        if (d) d.result = textOf(m.content);
      }
    }
    let message;
    try {
      message = scriptFor(request, user, done);
    } catch (e) {
      message = say(`(가짜 모델 대본 오류: ${e.message})`);
    }
    log.push({ at: new Date().toISOString(), request, user, raw, tools: done.map((d) => d.name), reply: message.content, calls: (message.tool_calls ?? []).map((c) => c.function.name) });
    const usage = { prompt_tokens: 1500, completion_tokens: 60, cost: 0.0042 };
    if (body.stream) return writeSse(res, body.model, message, usage);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: body.model, choices: [{ message }], usage }));
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve({ server, log, url: `http://127.0.0.1:${port}/api/v1`, close: () => new Promise((r) => server.close(() => r())) })),
  );
}
