// 세트 사이트 제한: 허브·세트 파일로 설치한 레시피(recipe.origin.sites)는 세트가 밝힌 사이트(origin) 밖으로
// 페이지(업무 탭·팝업 창)가 이동하지 못하게 한다. 그림·스크립트 같은 하위 자원과 iframe 은 막지 않는다. about:·data:·blob: 은 허용.
//   - 이동 요청은 Playwright 경로 가로채기(route)로 보내기 전에 막는다.
//   - 리디렉션은 route 를 거치지 않으므로 이동한 뒤 주소(framenavigated)로 한 번 더 보고, 밖이면 빈 페이지로 돌린다.

const FREE = new Set(['about:', 'data:', 'blob:']);

/** "https://a.b/c" → "https://a.b" (웹 주소가 아니면 null) */
export function normOrigin(o) {
  try {
    const u = new URL(String(o));
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

/** 주소가 허용된 사이트인지 */
export function siteAllowed(href, allowed) {
  try {
    const u = new URL(href);
    return FREE.has(u.protocol) || allowed.has(u.origin);
  } catch {
    return false;
  }
}

/**
 * 컨텍스트에 사이트 제한을 건다.
 * @param {import('playwright-core').BrowserContext} ctx
 * @param {string[]} origins 허용할 사이트
 * @param {(e: {url: string, origin: string|null, redirect: boolean}) => void} onBlock 막을 때마다 부른다
 */
export async function guardSites(ctx, origins, onBlock) {
  const allowed = new Set((origins ?? []).map(normOrigin).filter(Boolean));
  const ok = (href) => siteAllowed(href, allowed);
  await ctx.route(
    (u) => !ok(u.href),
    async (route, request) => {
      let frame = null;
      try {
        frame = request.frame();
      } catch {
        /* 서비스 워커 요청 — 페이지 이동이 아니다 */
      }
      if (!frame || frame.parentFrame() || !request.isNavigationRequest()) return route.fallback();
      onBlock({ url: request.url(), origin: normOrigin(request.url()), redirect: false });
      return route.abort('blockedbyclient');
    },
  );
  const watch = (page) =>
    page.on('framenavigated', (f) => {
      if (f !== page.mainFrame()) return;
      const url = f.url();
      if (ok(url) || url.startsWith('chrome-error:')) return; // 막은 이동은 브라우저 오류 화면으로 바뀐다
      onBlock({ url, origin: normOrigin(url), redirect: true });
      page.goto('about:blank').catch(() => {});
    });
  ctx.on('page', watch);
  for (const p of ctx.pages()) watch(p);
  return [...allowed];
}
