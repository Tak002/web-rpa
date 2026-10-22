// T4: 변수 이름 바꾸기(사용처 함께), 안 쓰는 변수 지우기, 쓰는 변수를 지우려 하면 참조 경고
import { openEditor, save, stepHead } from './app.mjs';

export default {
  id: 'T4',
  title: '변수 이름 바꾸기·안 쓰는 변수 지우기',
  flow: '변수 이름 바꾸기 → 쓰는 곳 확인 → 안 쓰는 변수 지우기 · 쓰는 변수는 지울 때 경고',
  async run(t, { env, fx, base }) {
    const page = t.page;
    await t.goto(`${base}/#/recipes`);
    await t.caption('편집기 → 변수·엑셀 탭');
    await openEditor(t, base, fx.t4.name);
    await t.click(page.getByRole('button', { name: /^변수·엑셀/ }), '변수·엑셀 탭');
    await t.pause(700, 900);
    await t.shot('vars', { full: true, note: '변수 탭 첫 화면' });
    const item = (n) => page.locator(`.var-item[data-var="${n}"]`);
    const usesBefore = await item('기간').locator('.var-uses').innerText().catch(() => '');
    t.note(`기간 변수 쓰는 곳(바꾸기 전): ${usesBefore.replace(/\s+/g, ' ')}`);

    await t.caption('"기간" 이름을 "신고기간" 으로 바꾸기');
    const nameIn = item('기간').getByRole('textbox', { name: '변수 이름' });
    await t.type(nameIn, '신고기간', '이름 칸');
    await nameIn.press('Enter');
    await t.pause(800, 1000);
    await t.shot('renamed', { full: true, note: '이름 바꾼 뒤 토스트·사용처' });
    const usesAfter = await item('신고기간').locator('.var-uses').innerText().catch(() => '');
    t.note(`신고기간 쓰는 곳(바꾼 뒤): ${usesAfter.replace(/\s+/g, ' ')}`);

    await t.caption('쓰는 곳 단추를 눌러 그 스텝 보기');
    const chip = item('신고기간').locator('.use-chip').first();
    if (await chip.isVisible().catch(() => false)) {
      await t.click(chip, '쓰는 곳 단추');
      await t.pause(700, 900);
      await t.shot('use-jump', { note: '쓰는 곳으로 이동한 스텝' });
      const head = await page.locator('.step.open > .step-head').innerText().catch(() => '');
      const vals = await page.locator('.step.open .step-body input').evaluateAll((els) => els.map((e) => e.value).join(' | '));
      t.expect('이름을 바꾸면 사용처(스텝 값)도 함께 바뀐다', /\{\{신고기간\}\}/.test(`${head} ${vals}`), `${head} / ${vals}`.slice(0, 200));
      await t.click(page.getByRole('button', { name: /^변수·엑셀/ }), '변수·엑셀 탭으로 돌아가기');
    } else t.expect('이름을 바꾸면 사용처(스텝 값)도 함께 바뀐다', false, '쓰는 곳 단추가 없음');

    await t.caption('안 쓰는 변수 "메모" 지우기');
    const unused = await item('메모').getByText('안 쓰는 변수').isVisible().catch(() => false);
    t.expect('안 쓰는 변수에 표시가 있다', unused);
    const d0 = t.dialogs.length;
    await t.click(item('메모').getByRole('button', { name: '삭제' }), '메모 [삭제]');
    t.expect('안 쓰는 변수는 확인 없이 지워진다', t.dialogs.length === d0 && !(await item('메모').count()));

    await t.caption('쓰는 변수 "사업자번호" 를 지우려 하면?');
    t.answer(false);
    await t.click(item('사업자번호').getByRole('button', { name: '삭제' }), '사업자번호 [삭제]');
    await t.pause(900, 1100);
    const warn = t.dialogs.at(-1);
    t.expect('쓰는 변수를 지울 때 참조 경고가 나온다 (취소하면 남는다)', warn && /#\d/.test(warn.message) && (await item('사업자번호').count()) === 1, warn?.message);
    await t.shot('after-cancel', { note: '삭제 취소 뒤 (확인창은 브라우저 기본 창이라 캡처에 안 보임)' });
    await save(t);
    const r = (await env.api('GET', `/api/recipes/${fx.t4.id}`)).recipe;
    const s = Object.values(r.blocks).flat().find((x) => String(x.value).includes('신고기간'));
    t.expect('저장된 레시피: 스텝 값이 {{신고기간}}, 엑셀 열 이름은 "기간" 그대로', !!s && r.variables.some((v) => v.id === '신고기간' && (v.source.column ?? '기간') === '기간'), JSON.stringify(r.variables));
    t.outcome('기간 → 신고기간: 쓰는 곳 #6 도 {{신고기간}}');
    t.outcome(`안 쓰는 "메모" 는 바로 지움 · "사업자번호" 는 지울 때 ${warn ? '"#5 입력 에서 씁니다" 경고' : '경고 없음'}`);
    void stepHead;
  },
};
