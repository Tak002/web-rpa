// T1: 편집기에서 AI 에게 요청 → 실행 화면 → 리포트 → 편집기, 서버 재시작 뒤 다시 열기
import { openEditor, openAi, closeAi, askAi, nav, panelOf, aiInput } from './app.mjs';

export default {
  id: 'T1',
  title: 'AI 대화가 화면을 옮겨도 이어지나',
  flow: '편집기에서 AI 에게 요청 → 실행·리포트 화면으로 옮겨도 대화 유지 → 서버 재시작 뒤 확인',
  async run(t, { env, fx, base }) {
    const page = t.page;
    const name = fx.t1.name;
    const DRAFT = '결과 표의 합계 금액도 읽어 줘';
    await t.goto(`${base}/#/recipes`);
    await t.caption('레시피 목록에서 편집기 열기');
    await openEditor(t, base, name);
    await t.caption('편집기에서 ✦ AI 도우미 열기');
    await openAi(t);
    await t.shot('editor-panel-empty', { note: '처음 연 AI 패널 (빈 대화)' });
    await t.caption('AI 에게 설명 요청');
    const r1 = await askAi(t, '이 레시피가 하는 일을 순서대로 설명해 줘');
    t.expect('설명 답이 보인다', /스텝/.test(r1), r1.slice(0, 120));
    await t.caption('AI 에게 수정 요청 (조회 뒤 기다리기)');
    await askAi(t, '조회를 누른 뒤 결과가 뜰 때까지 기다리는 스텝을 넣어 줘');
    const card = await page.locator('.ai-changes').innerText().catch(() => '');
    t.expect('대기 제안 카드가 생긴다', /제안된 변경 1건/.test(card), card);
    await t.shot('editor-pending', { note: '편집기: 대기 제안 카드' });
    await t.caption('보내지 않은 글을 써 둔 채 화면 옮기기');
    await t.type(aiInput(page), DRAFT, '입력 중 글');

    const kept = async (where, applyLabel) => {
      const open = await panelOf(page).isVisible();
      const draft = await aiInput(page).inputValue().catch(() => '');
      const c = await page.locator('.ai-changes').innerText().catch(() => '');
      const talk = (await page.locator('.ai-msg.user').allInnerTexts()).some((x) => x.includes('하는 일'));
      const applyBtn = await panelOf(page).getByRole('button', { name: applyLabel, exact: true }).isVisible().catch(() => false);
      return t.expect(`${where}: 패널·대화·대기 제안·입력 중 글 유지`, open && draft === DRAFT && /제안된 변경 1건/.test(c) && talk && applyBtn, JSON.stringify({ open, draft, card: c.slice(0, 40), talk, applyBtn }));
    };

    await t.caption('위 메뉴 [실행] 으로 이동');
    await nav(t, '실행');
    await page.getByText('2. 엑셀 데이터').waitFor();
    await t.pause(700, 900);
    const same = await kept('실행 화면 (위 메뉴로 옴)', '적용하고 저장');
    await t.shot('run-panel', { note: '위 메뉴 [실행] 으로 온 실행 화면의 AI 패널' });
    if (!same) {
      const shown = await page.locator('main select').first().inputValue().catch(() => '');
      t.wander(`위 메뉴 [실행] 으로 오니 다른 레시피(${shown === fx.t1.id ? '같은 레시피' : '다른 레시피'})가 골라져 있고 AI 대화가 비어 보임 → "1. 레시피" 에서 다시 고름`);
      await t.caption('대화가 사라진 줄 알고 "1. 레시피" 에서 원래 레시피를 다시 고름');
      await t.choose(page.locator('main select').first(), fx.t1.id, '1. 레시피');
      await t.pause(900, 1200);
      await kept('실행 화면 (레시피를 다시 고른 뒤)', '적용하고 저장');
      await t.shot('run-panel-picked', { note: '레시피를 다시 고른 뒤' });
    }
    // 실행 화면에서 다른 레시피를 고르면 대화가 바뀐다 — 그때 안내가 알아보기 쉬운지, 돌아갈 수 있는지
    await t.caption('실행 화면에서 다른 레시피를 잠깐 골라 보기');
    const runSel = page.locator('main select').first();
    const other = (await runSel.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent })))).find((o) => o.v !== fx.t1.id);
    if (other) {
      await t.choose(runSel, other.v, '1. 레시피 = 다른 레시피');
      await t.pause(900, 1100);
      const note = await panelOf(page).locator('.ai-switched').innerText().catch(() => '');
      await t.shot('run-switched', { note: '다른 레시피를 고른 뒤 AI 패널의 안내' });
      t.note(`레시피를 바꾼 뒤 패널 안내: ${note.replace(/\s+/g, ' ').slice(0, 200) || '(없음)'}`);
      const back = panelOf(page).getByRole('button', { name: /대화로 돌아가기/ });
      t.expect('[확인] 화면이 대화를 바꾸면 안내와 [돌아가기] 가 보인다', (await back.isVisible().catch(() => false)) && note.includes(name), note.slice(0, 160));
      if (await back.isVisible().catch(() => false)) {
        await t.click(back, '[대화로 돌아가기]');
        await t.pause(900, 1100);
        await kept('[확인] 실행 화면 ([돌아가기] 뒤)', '적용하고 저장');
        t.expect('[확인] [돌아가기] 는 실행 화면의 레시피도 되돌린다', (await runSel.inputValue()) === fx.t1.id, await runSel.inputValue());
      } else await t.choose(runSel, fx.t1.id, '1. 레시피 = 원래 레시피');
    }
    await t.caption('실행 화면에서 패널을 닫았다가 다시 열기');
    await closeAi(t);
    await t.pause(600, 800);
    await t.shot('run-closed', { note: '패널 닫힌 실행 화면 — AI 를 다시 여는 단추' });
    const runHeadAi = await page.locator('main').getByRole('button', { name: '✦ AI 도우미' }).isVisible().catch(() => false);
    const w0 = t.wanders.length;
    await openAi(t);
    t.expect('[R2-08] 실행 화면에서도 편집기와 같은 "✦ AI 도우미" 로 AI 를 연다 (헤맴 없음)', runHeadAi && t.wanders.length === w0, `머리 단추 ${runHeadAi}`);
    t.expect('실행 화면에서 AI 를 다시 열 수 있다', await panelOf(page).isVisible());

    await t.caption('위 메뉴 [리포트] → 이 레시피의 실행 기록');
    await nav(t, '리포트');
    await t.click(page.locator('tbody tr', { hasText: name }).first(), '리포트 줄');
    await page.locator('.statline').waitFor();
    await t.pause(800, 1000);
    const scope = await page.locator('.ai-scope').innerText().catch(() => '');
    t.expect('리포트 화면: 그 레시피의 대화가 열린다', scope.includes(name), scope);
    await kept('리포트', '적용하고 저장');
    await t.shot('report-panel', { note: '리포트에서 같은 대화' });

    await t.caption('리포트에서 편집기로 돌아가기');
    const toEditor = await t.find('리포트 → 편집기 가는 길', [
      ['리포트 머리의 [편집] 링크', () => page.locator('main').getByRole('link', { name: /편집/ })],
      ['레시피 이름 링크', () => page.locator('main .page-head').getByRole('link', { name })],
      ['위 메뉴 [레시피]', () => page.locator('#nav').getByRole('link', { name: '레시피', exact: true })],
    ]);
    await t.click(toEditor, '편집기로');
    if (!(await page.locator('.step-head').first().isVisible().catch(() => false))) await openEditor(t, base, name);
    await kept('편집기', '적용');

    await t.caption('서버를 껐다 켠 뒤 새로 고침');
    await page.goto('about:blank');
    await env.restartServer();
    await t.goto(`${base}/#/recipe/${fx.t1.id}`);
    await page.locator('.step-head').first().waitFor();
    await t.pause(1500, 1800);
    await kept('서버 재시작 뒤', '적용');
    await t.shot('after-restart', { note: '서버 재시작 + 새로 고침 뒤' });
    await t.caption('제안 [적용] → [저장]');
    await t.click(panelOf(page).getByRole('button', { name: '적용', exact: true }), '[적용]');
    await t.pause(600, 800);
    await t.shot('applied', { note: '적용 직후 편집기' });
    const keptAll = t.checks.filter((c) => /유지/.test(c.name) && c.core).every((c) => c.ok);
    t.outcome(keptAll ? '실행·리포트·서버 재시작 뒤에도 대화·대기 제안·입력 중 글 그대로' : '화면을 옮기며 대화가 끊긴 곳이 있음');
    t.outcome('대기 제안 [적용] → 편집기에 반영');
  },
};
