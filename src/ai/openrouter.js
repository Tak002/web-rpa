// OpenRouter 채팅 API (OpenAI 호환 도구 호출).

const TIMEOUT_MS = 180_000;

export class OpenRouterError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
  }
}

/**
 * @param {{apiKey: string, model: string, baseUrl: string}} cfg
 * @param {{messages: object[], tools?: object[]}} req
 */
export async function chat(cfg, { messages, tools }) {
  if (!cfg.apiKey) throw new OpenRouterError('OpenRouter API 키가 없습니다. AI 도우미의 설정에서 키를 넣어 주세요.', 401);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        'content-type': 'application/json',
        'x-title': 'web-rpa',
      },
      body: JSON.stringify({ model: cfg.model, messages, tools, tool_choice: tools?.length ? 'auto' : undefined, usage: { include: true } }),
    });
  } catch (e) {
    throw new OpenRouterError(e.name === 'AbortError' ? 'AI 응답이 3분 안에 오지 않았습니다.' : `OpenRouter 연결 실패: ${e.message}`, 0);
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const msg = body.error?.message || `HTTP ${res.status}`;
    const status = res.status || body.error?.code;
    if (status === 401) throw new OpenRouterError('OpenRouter 키가 올바르지 않습니다. 설정에서 다시 넣어 주세요.', 401);
    if (status === 402) throw new OpenRouterError('OpenRouter 크레딧이 부족합니다.', 402);
    if (status === 429) throw new OpenRouterError('요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요.', 429);
    throw new OpenRouterError(`OpenRouter 오류: ${msg}`, status);
  }
  const choice = body.choices?.[0];
  if (!choice?.message) throw new OpenRouterError('AI 응답 형식이 올바르지 않습니다.', 500);
  return { message: choice.message, usage: body.usage ?? null, model: body.model };
}
