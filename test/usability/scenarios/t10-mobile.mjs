// T10: 휴대폰 폭(390×844)에서 편집기·실행·리포트·AI 패널 — 가로 스크롤 없음, 단추를 누를 수 있음
import { scrollWidth, panelOf, stepHead } from './app.mjs';

/** 화면 안 보이는 단추 중 너무 작거나(가로·세로 < 28px) 화면 밖으로 나간 것 */
async function tapIssues(page) {
  return page.evaluate(() => {
    const out = { small: [], outside: [] };
    const W = document.documentElement.clientWidth;
    for (const el of document.querySelectorAll('button, a.btn, select, input[type=checkbox], input[type=radio]')) {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (!r.width || !r.height || st.visibility === 'hidden' || el.closest('[hidden]')) continue;
      const label = (el.innerText || el.getAttribute('aria-label') || el.title || el.tagName).trim().slice(0, 24);
      const hit = el.type === 'checkbox' || el.type === 'radio' ? el.closest('label')?.getBoundingClientRect() ?? r : r;
      if (hit.height < 28 || hit.width < 28) out.small.push(`${label}(${Math.round(hit.width)}×${Math.round(hit.height)})`);
      if (r.right > W + 1 || r.left < -1) out.outside.push(`${label}(${Math.round(r.left)}~${Math.round(r.right)})`);
    }
    return out;
  });
}

export default {
  id: 'T10',
  title: '휴대폰 폭에서 편집기·실행·리포트·AI',
  flow: '390px 휴대폰 폭: 편집기·일괄 막대·AI 패널 → 실행 화면 → 리포트 실패 카드',
  viewport: { width: 390, height: 844 },
  mobile: true,
  async run(t, { fx, base }) {
    const page = t.page;
    const report = [];
    const look = async (name, note) => {
      await t.pause(700, 900);
      const sw = await scrollWidth(page);
      const tap = await tapIssues(page);
      report.push({ name, sw, ...tap });
      t.note(`${name}: 가로 ${sw}px · 작은 단추 ${tap.small.length}개 ${tap.small.slice(0, 8).join(', ')} · 화면 밖 ${tap.outside.join(', ') || '없음'}`);
      await t.shot(name, { note });
      return sw;
    };
    await t.caption('편집기');
    await t.goto(`${base}/#/recipe/${fx.t10.id}`);
    await page.locator('.step-head').first().waitFor();
    await look('editor', '편집기 첫 화면');
    await t.caption('스텝 펼치기');
    await t.click(stepHead(page, '#5'), '#5 펼치기');
    await look('editor-step', '펼친 스텝');
    await t.caption('스텝 두 개 고르기 → 일괄 막대');
    await t.check(page.getByRole('checkbox', { name: '#2 스텝 고르기' }), '#2 고르기');
    await t.check(page.getByRole('checkbox', { name: '#3 스텝 고르기' }), '#3 고르기');
    await look('editor-bulk', '일괄 막대');
    const bar = page.getByRole('toolbar', { name: '고른 스텝 한꺼번에 바꾸기' });
    const bb = await bar.boundingBox().catch(() => null);
    const barBtns = await bar.getByRole('button').evaluateAll((bs) => bs.filter((b) => b.offsetParent !== null).map((b) => b.textContent.trim()));
    t.note(`일괄 막대 높이 ${Math.round(bb?.height ?? 0)}px · 보이는 단추: ${barBtns.join(', ')}`);
    t.expect('[R1-15] 휴대폰 일괄 막대가 화면 아래를 크게 덮지 않는다 (≤ 120px)', bb && bb.height <= 120, `${bb?.height}`);
    const more = bar.getByRole('button', { name: /더보기/ });
    if (await more.isVisible().catch(() => false)) {
      await t.click(more, '[더보기 …]');
      await look('editor-bulk-more', '일괄 막대 더보기');
      await t.click(bar.getByRole('button', { name: '접기' }), '[접기]');
    }
    await t.caption('위쪽 ✦ AI 로 패널 열기');
    await t.click(page.locator('header').getByRole('button', { name: /✦ AI/ }), '✦ AI');
    await panelOf(page).waitFor({ state: 'visible' });
    await look('ai-panel', 'AI 패널 (휴대폰)');
    const ph = await panelOf(page).getByRole('textbox', { name: 'AI 에게 보낼 요청' }).getAttribute('placeholder');
    t.expect('[R1-15] 휴대폰 입력창 안내에 Ctrl+Enter 가 없다', !/Ctrl/.test(ph ?? ''), ph);
    const send = panelOf(page).getByRole('button', { name: '보내기' });
    const sb = await send.boundingBox();
    t.expect('AI 패널의 [보내기] 단추가 화면 안에 있다', sb && sb.x >= 0 && sb.x + sb.width <= 391 && sb.y + sb.height <= 845, JSON.stringify(sb));
    await t.click(panelOf(page).locator('.ai-head').getByRole('button', { name: '✕' }), '패널 닫기');

    await t.caption('로그인이 있는 레시피 편집기 (안내)');
    await t.goto(`${base}/#/recipe/${fx.t2.id}`);
    await page.locator('.step-head').first().waitFor();
    await page.evaluate(() => window.scrollTo(0, 0));
    await look('editor-login', '로그인 안내가 있는 편집기 (휴대폰)');
    const firstView = await page.evaluate(() => [...document.querySelectorAll('.step-head')].filter((h) => h.getBoundingClientRect().bottom <= window.innerHeight).length);
    const hintH = await page.locator('.login-hint').evaluate((e) => Math.round(e.getBoundingClientRect().height)).catch(() => 0);
    t.note(`휴대폰 로그인 안내 높이 ${hintH}px · 첫 화면에 보이는 스텝 ${firstView}개`);
    t.expect('[R2-07] 휴대폰 첫 화면에 로그인 안내와 함께 스텝이 2개 이상 보인다', firstView >= 2, `${firstView}개 · 안내 ${hintH}px`);
    await t.caption('실행 화면');
    await t.goto(`${base}/#/run?recipe=${fx.t10.id}`);
    await page.getByText('2. 엑셀 데이터').waitFor();
    await look('run', '실행 화면 위쪽');
    const start = page.getByRole('button', { name: '▶ 실행 시작' });
    await start.scrollIntoViewIfNeeded();
    await look('run-bottom', '실행 화면 아래 (실행 시작 단추)');

    await t.caption('리포트 화면');
    await t.goto(`${base}/#/report/${fx.t10Run.runId}`);
    await page.locator('.statline').waitFor();
    await look('report', '리포트 위쪽');
    const ask = page.locator('main').getByRole('button', { name: '✦ AI 에게' }).first();
    await ask.scrollIntoViewIfNeeded().catch(() => {});
    const ab = await ask.boundingBox().catch(() => null);
    await look('report-row', '실패 행 [✦ AI 에게] 근처');
    t.expect('리포트 실패 행의 [✦ AI 에게] 를 화면 안에서 누를 수 있다', ab && ab.x >= 0 && ab.x + ab.width <= 391, JSON.stringify(ab));
    if (ab) {
      await t.click(ask, '[✦ AI 에게]');
      await look('report-ai', '리포트에서 연 AI 패널');
    }
    const wide = report.filter((r) => r.sw > 392);
    t.expect('네 화면 모두 가로 스크롤 없음 (≤ 392px)', !wide.length, wide.map((r) => `${r.name}=${r.sw}`).join(', '));
    t.expect('화면 밖으로 나간 단추 없음', report.every((r) => !r.outside.length), report.filter((r) => r.outside.length).map((r) => `${r.name}: ${r.outside.join(', ')}`).join(' / '));
    const small = report.reduce((n, r) => n + r.small.length, 0);
    t.outcome(`${report.length}개 화면 가로 폭 최대 ${Math.max(...report.map((r) => r.sw))}px · 작은 단추 ${small}개`);
    t.outcome('리포트 실패 카드에서 오류와 [✦ AI 에게] 가 바로 보임');
  },
};
