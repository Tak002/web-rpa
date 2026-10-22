// OpenRouter 채팅 API (OpenAI 호환 도구 호출). 스트리밍(SSE)으로 받아 글자 조각을 바로 넘기고,
// 서버가 스트리밍 대신 JSON 으로 답해도 그대로 처리한다.

const TIMEOUT_MS = 180_000; // 응답이 이 시간 동안 한 글자도 오지 않으면 끊는다

export class OpenRouterError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
  }
}

/** Anthropic 모델이면 프롬프트 캐시를 쓸 수 있다 */
export const isAnthropicModel = (model) => /^anthropic\//i.test(String(model ?? ''));

function httpError(status, msg) {
  if (status === 401) return new OpenRouterError('OpenRouter 키가 올바르지 않습니다. 설정에서 다시 넣어 주세요.', 401);
  if (status === 402) return new OpenRouterError('OpenRouter 크레딧이 부족합니다.', 402);
  if (status === 429) return new OpenRouterError('요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요.', 429);
  return new OpenRouterError(`OpenRouter 오류: ${msg}`, status);
}

/** SSE 조각들을 하나의 assistant 메시지로 모은다 */
async function readStream(res, { onDelta, onFirst, bump }) {
  const decoder = new TextDecoder();
  const msg = { role: 'assistant', content: '' };
  const calls = [];
  let usage = null;
  let model;
  let buf = '';
  let done = false;
  const handle = (data) => {
    if (data === '[DONE]') {
      done = true;
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk.error) throw httpError(chunk.error.code, chunk.error.message || '스트리밍 중 오류');
    model ??= chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta ?? chunk.choices?.[0]?.message;
    if (!delta) return;
    if (typeof delta.content === 'string' && delta.content) {
      onFirst();
      msg.content += delta.content;
      onDelta?.(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      onFirst();
      const i = tc.index ?? calls.length;
      calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name) calls[i].function.name += tc.function.name;
      if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
    }
  };
  for await (const part of res.body) {
    bump();
    buf += decoder.decode(part, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, cut).replace(/\r$/, '');
      buf = buf.slice(cut + 1);
      if (line.startsWith('data:')) handle(line.slice(5).trim());
      if (done) break;
    }
    if (done) break;
  }
  if (!done && buf.startsWith('data:')) handle(buf.slice(5).trim());
  const toolCalls = calls.filter(Boolean);
  if (toolCalls.length) msg.tool_calls = toolCalls;
  if (!msg.content) msg.content = toolCalls.length ? null : '';
  return { message: msg, usage, model };
}

/**
 * @param {{apiKey: string, model: string, baseUrl: string}} cfg
 * @param {{messages: object[], tools?: object[], stream?: boolean, onDelta?: (text: string) => void, redact?: (json: string) => string}} req
 * @returns {Promise<{message: object, usage: object|null, model: string, firstTokenMs: number|null}>}
 */
export async function chat(cfg, { messages, tools, stream = true, onDelta, redact }) {
  if (!cfg.apiKey) throw new OpenRouterError('OpenRouter API 키가 없습니다. AI 도우미의 설정에서 키를 넣어 주세요.', 401);
  const t0 = Date.now();
  let firstTokenMs = null;
  const onFirst = () => {
    firstTokenMs ??= Date.now() - t0;
  };
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const bump = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  };
  let body = JSON.stringify({ model: cfg.model, messages, tools, tool_choice: tools?.length ? 'auto' : undefined, usage: { include: true }, ...(stream ? { stream: true } : {}) });
  if (redact) body = redact(body); // 마지막 안전망: 비밀값은 어떤 경로로도 나가지 않는다
  try {
    let res;
    try {
      res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json', 'x-title': 'web-rpa' },
        body,
      });
    } catch (e) {
      throw new OpenRouterError(e.name === 'AbortError' ? 'AI 응답이 3분 안에 오지 않았습니다.' : `OpenRouter 연결 실패: ${e.message}`, 0);
    }
    const type = String(res.headers.get('content-type') ?? '');
    if (res.ok && type.includes('text/event-stream')) {
      try {
        const r = await readStream(res, { onDelta, onFirst, bump });
        return { ...r, firstTokenMs };
      } catch (e) {
        if (e instanceof OpenRouterError) throw e;
        throw new OpenRouterError(e.name === 'AbortError' ? 'AI 응답이 3분 동안 멈춰 끊었습니다.' : `AI 응답을 받는 중 끊겼습니다: ${e.message}`, 0);
      }
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw httpError(res.status !== 200 ? res.status : data.error?.code, data.error?.message || `HTTP ${res.status}`);
    const choice = data.choices?.[0];
    if (!choice?.message) throw new OpenRouterError('AI 응답 형식이 올바르지 않습니다.', 500);
    onFirst();
    if (choice.message.content) onDelta?.(String(choice.message.content));
    return { message: choice.message, usage: data.usage ?? null, model: data.model, firstTokenMs };
  } finally {
    clearTimeout(timer);
  }
}
