// 과제에서 함께 쓰는 화면 동작 (보이는 단추 이름으로 찾는다)

import { sleep, until } from '../env.mjs';

export const panelOf = (page) => page.locator('aside.ai-panel');
export const aiInput = (page) => page.getByRole('textbox', { name: 'AI 에게 보낼 요청' });
export const sendBtn = (page) => panelOf(page).getByRole('button', { name: /^(보내기|작업 중…)$/ });

/** 레시피 목록에서 이름을 눌러 편집기를 연다 */
export async function openEditor(t, base, name) {
  const page = t.page;
  if (!page.url().includes('#/recipes')) await t.goto(`${base}/#/recipes`);
  await page.locator('table').waitFor();
  await t.click(page.getByRole('link', { name, exact: true }), `레시피 "${name}"`);
  await page.locator('.step-head').first().waitFor();
  await t.pause(500, 700);
}

/** 레시피 목록의 그 줄에서 [실행] */
export async function openRun(t, base, name) {
  const page = t.page;
  await t.goto(`${base}/#/recipes`);
  const row = page.locator('tr', { has: page.getByRole('link', { name, exact: true }) });
  await t.click(row.getByRole('link', { name: '실행', exact: true }), '[실행]');
  await page.getByText('2. 엑셀 데이터').waitFor();
  await t.pause(600, 800);
}

/** 위쪽 메뉴 */
export async function nav(t, label) {
  await t.click(t.page.locator('#nav').getByRole('link', { name: label, exact: true }), `메뉴 ${label}`);
  await t.pause(500, 700);
}

/** AI 패널 열기 (닫혀 있으면). 편집기면 머리 단추, 아니면 위쪽 막대 단추를 찾는다 */
export async function openAi(t) {
  const page = t.page;
  if (await panelOf(page).isVisible()) return;
  const btn = await t.find('AI 패널 여는 단추', [
    ['✦ AI 도우미', () => page.getByRole('button', { name: '✦ AI 도우미' })],
    ['위쪽 막대 ✦ AI', () => page.locator('header').getByRole('button', { name: /✦ AI/ })],
  ]);
  if (!btn) throw new Error('AI 패널을 여는 단추를 찾지 못했습니다');
  await t.click(btn, 'AI 패널 열기');
  await panelOf(page).waitFor({ state: 'visible' });
  await t.pause(500, 800);
}

export async function closeAi(t) {
  const page = t.page;
  if (!(await panelOf(page).isVisible())) return;
  await t.click(panelOf(page).locator('.ai-head').getByRole('button', { name: '✕' }), 'AI 패널 닫기');
}

/** 답이 끝날 때까지 */
export async function waitTurn(page, ms = 90000) {
  await sleep(300);
  return until(async () => (await sendBtn(page).innerText()) === '보내기' && (await page.locator('.ai-msg.streaming').count()) === 0, ms, 200);
}

/** 입력창에 쓰고 [보내기] → 마지막 답 글 */
export async function askAi(t, text, { append = false } = {}) {
  const page = t.page;
  await openAi(t);
  await t.type(aiInput(page), text, `AI 요청: ${text}`, { clear: !append, delay: 15 });
  await t.click(sendBtn(page), '[보내기]');
  const ok = await waitTurn(page);
  if (!ok) t.note(`AI 답이 끝나지 않음: ${text}`);
  await t.pause(600, 900);
  return lastReply(page);
}

export const lastReply = async (page) => (await page.locator('.ai-msg.assistant .ai-text').last().innerText().catch(() => '')) ?? '';

/** 실행 화면: [▶ 실행 시작] → 끝날 때까지 → 리포트 (API) */
export async function startRun(t, env, { hidden = true } = {}) {
  const page = t.page;
  const before = await env.lastRunId();
  if (hidden) {
    const box = page.getByRole('checkbox', { name: /브라우저 창 숨기고/ });
    if (!(await box.isChecked())) await t.check(box, '브라우저 창 숨기고 실행');
  }
  await t.click(page.getByRole('button', { name: '▶ 실행 시작' }), '[▶ 실행 시작]');
  await t.caption('실행이 끝나기를 기다림');
  const report = await env.waitRunDone(before);
  await t.pause(800, 1000);
  return report;
}

/** 실행이 끝난 뒤 [리포트 보기] */
export async function openReportFromRun(t) {
  const page = t.page;
  await t.click(page.getByRole('link', { name: '리포트 보기' }), '[리포트 보기]');
  await page.locator('.statline').waitFor();
  await t.pause(600, 900);
}

/** 편집기 [저장 *] */
export async function save(t) {
  const page = t.page;
  await t.click(page.getByRole('button', { name: /^저장/ }), '[저장]');
  await page.getByText(/저장했습니다/).first().waitFor({ timeout: 8000 });
  await t.pause(500, 700);
}

/** 스텝 머리 (번호로) */
export const stepHead = (page, no) => page.locator('.step-head', { has: page.locator('.num', { hasText: new RegExp(`^${no.replace(/[.#]/g, (c) => `\\${c}`)}$`) }) });

/** 화면 가로 넘침 */
export const scrollWidth = (page) => page.evaluate(() => document.documentElement.scrollWidth);

/** 엑셀 파일 선택 단추 → 파일 고르기 창 */
export async function pickExcel(t, file) {
  const page = t.page;
  const btn = page.getByRole('button', { name: /엑셀 파일 선택|다른 파일 선택/ });
  await t.ready(btn);
  await t.pause();
  await t.mark(btn);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), btn.click()]);
  t.clicks += 1;
  await chooser.setFiles(file);
  await page.getByText(/· \d+행/).first().waitFor();
  await t.pause(600, 900);
}

/** 지금 떠 있는 알림이 화면 머리 줄 단추를 가리는지 → 가려진 단추 이름 목록 */
export const toastOverHead = (page) =>
  page.evaluate(() => {
    const ts = [...document.querySelectorAll('#toasts .toast')].map((t) => t.getBoundingClientRect()).filter((r) => r.width && r.height);
    const hit = [];
    for (const b of document.querySelectorAll('.page-head button, .page-head a.btn')) {
      const r = b.getBoundingClientRect();
      if (!r.width) continue;
      if (ts.some((t) => t.left < r.right && t.right > r.left && t.top < r.bottom && t.bottom > r.top)) hit.push(b.textContent.trim());
    }
    const style = document.querySelector('#toasts .toast') ? getComputedStyle(document.querySelector('#toasts .toast')).pointerEvents : '';
    return { hit, pointer: style, lines: [...document.querySelectorAll('#toasts .toast')].map((t) => Math.round(t.getBoundingClientRect().height)) };
  });
