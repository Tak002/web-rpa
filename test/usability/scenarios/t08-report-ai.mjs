// T8: 리포트의 실패 행에서 [✦ AI 에게] → 맥락에 그 행·오류, 입력창에 초안 → 보내고 제안 고르기
import { nav, aiInput, sendBtn, waitTurn, panelOf, lastReply } from './app.mjs';

export default {
  id: 'T8',
  title: '리포트 실패 행에서 AI 에게 묻기',
  flow: '리포트 실패 행의 [✦ AI 에게] → 초안 그대로 보내기 → 선택지 고르기 → 적용하고 저장 → 다시 실행',
  async run(t, { env, fx, base }) {
    const page = t.page;
    await t.goto(`${base}/#/recipes`);
    await t.caption('위 메뉴 [리포트] → 실패가 있는 실행 열기');
    await nav(t, '리포트');
    await t.click(page.locator('tbody tr', { hasText: fx.t8.name }).first(), '리포트 줄');
    await page.locator('.statline').waitFor();
    await t.pause(800, 1000);
    await t.shot('report', { full: true, note: '실패 행이 있는 리포트' });
    await t.caption('실패 행의 [✦ AI 에게]');
    const ask = await t.find('실패 행의 AI 단추', [
      ['✦ AI 에게', () => page.locator('main').getByRole('button', { name: '✦ AI 에게' })],
      ['위쪽 ✦ AI', () => page.locator('header').getByRole('button', { name: /✦ AI/ })],
    ]);
    await t.click(ask, '[✦ AI 에게]');
    await panelOf(page).waitFor({ state: 'visible' });
    await t.pause(700, 900);
    const draft = await aiInput(page).inputValue();
    const ctx = await page.locator('.ai-ctx').innerText().catch(() => '');
    await t.shot('draft', { note: '초안과 맥락 줄' });
    t.expect('입력창에 그 행의 초안이 들어 있다 (바로 보내지 않음)', /^2행이 실패했습니다/.test(draft) && env.model.log.every((e) => !e.request.includes('2행이 실패했습니다')), draft.slice(0, 160));
    t.expect('맥락 줄에 리포트·2행이 보인다', /리포트/.test(ctx) && /2행/.test(ctx), ctx);
    t.note(`초안: ${draft} · 맥락 줄: ${ctx}`);
    t.expect('[R1-10] 초안에 XPath·CSS·후보 목록이 없다', !/xpath|css |시도한 후보|normalize-space/.test(draft), draft);
    t.expect('[R2-04] 초안이 번호로 가리키고 따옴표가 겹치지 않는다 ("" · ".)" 없음)', /^2행이 실패했습니다 — #\d/.test(draft) && !/""/.test(draft) && !/\.\)/.test(draft), draft);
    t.expect('[R1-09] 맥락 줄에 실행 id 대신 시각', !/\d{8}-\d{6}/.test(ctx), ctx);
    await t.caption('초안 그대로 [보내기]');
    await t.click(sendBtn(page), '[보내기]');
    await waitTurn(page);
    await t.pause(700, 900);
    const reply = await lastReply(page);
    const req = env.model.log.filter((e) => e.request.includes('2행이 실패했습니다')).at(-1);
    t.expect('AI 맥락(요청 본문)에 그 실행·행·오류가 들어간다', !!req && /보고 있는 행: 2행 실패 — /.test(req.user) && /보고 있는 실행: /.test(req.user), req?.user?.match(/보고 있는[^\n]*/g)?.join(' / '));
    await t.shot('reply', { note: 'AI 답과 선택지 단추' });
    t.note(`AI 답: ${reply.slice(0, 200)}`);
    const choice = page.locator('.ai-choices button').first();
    if (await choice.isVisible().catch(() => false)) {
      await t.caption(`선택지 "${(await choice.innerText()).slice(0, 30)}" 누르기`);
      await t.click(choice, '선택지');
      await waitTurn(page);
      await t.pause(700, 900);
      await t.shot('pending', { note: '선택 뒤 제안 카드 (리포트 화면)' });
      const card = (await page.locator('.ai-changes').innerText().catch(() => '')).replace(/\s+/g, ' ');
      t.note(`제안 카드: ${card.slice(0, 300)}`);
      t.expect('[R1-09] 제안 카드에 내부 id·블록 이름이 없다', card && !/\bs\d+\b|\(main\)/.test(card), card.slice(0, 200));
      const save = panelOf(page).getByRole('button', { name: '적용하고 저장' });
      if (await save.isVisible().catch(() => false)) {
        t.answer(true);
        await t.click(save, '[적용하고 저장]');
        await t.pause(900, 1200);
        await t.shot('applied', { note: '적용하고 저장 뒤' });
        const r = (await env.api('GET', `/api/recipes/${fx.t8.id}`)).recipe;
        t.expect('리포트 화면에서 고친 레시피가 저장된다', Object.values(r.blocks).flat().some((s) => s.type === 'branch'), JSON.stringify(r.blocks.main.map((s) => s.type)));
        // 고친 뒤 다시 실행 (R1-07): 알림이나 리포트 머리의 [▶ 다시 실행]
        const again = await t.find('다시 실행하는 길', [
          ['알림·머리의 [▶ 다시 실행]', () => page.getByRole('link', { name: /다시 실행/ })],
          ['위 메뉴 [실행]', () => page.locator('#nav').getByRole('link', { name: '실행', exact: true })],
        ]);
        if (again) {
          await t.click(again, '[▶ 다시 실행]');
          await page.getByText('2. 엑셀 데이터').waitFor();
          await t.pause(600, 800);
          const sel = await page.locator('main select').first().inputValue().catch(() => '');
          t.expect('[R1-07] 다시 실행이 그 레시피를 고른 실행 화면으로 간다', sel === fx.t8.id, sel);
          t.outcome('AI 가 실패 까닭(이미 로그인됨)을 짚고 "로그인 화면일 때만" 으로 고쳐 저장');
          t.outcome('[▶ 다시 실행] → 그 레시피가 골라진 실행 화면');
          await t.shot('rerun-form', { full: true, note: '다시 실행 화면' });
        }
      }
    } else t.wander('답에 선택지 단추가 없음');
  },
};
