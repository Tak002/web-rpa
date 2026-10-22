// T9: 긴 레시피에서 스텝 찾기(검색·필터)·여러 개 선택 일괄 작업, 번호가 화면·AI 에서 같은가
import { openEditor, aiInput, sendBtn, waitTurn, lastReply } from './app.mjs';

export default {
  id: 'T9',
  title: '긴 레시피에서 스텝 찾기·일괄 작업',
  flow: '글자·번호로 스텝 찾기 → 종류로 거르기 → 모두 고르기·일괄 끄기 → AI 에게 보내 번호 확인',
  async run(t, { env, fx, base }) {
    const page = t.page;
    await t.goto(`${base}/#/recipes`);
    await openEditor(t, base, fx.t9.name);
    await t.caption('스텝 40여 개 — 처음 화면');
    await t.shot('long', { note: '긴 레시피 첫 화면' });
    const warnBadges = await page.locator('.step-head .badge.warn').allInnerTexts();
    t.note(`경고 배지: ${warnBadges.join(', ') || '없음'}`);
    t.expect('[확인] 문제없는 긴 레시피에 새 경고 배지가 붙지 않는다', !warnBadges.some((b) => /같은 요소|마지막 쪽/.test(b)), warnBadges.join(', '));
    const search = page.getByRole('searchbox', { name: '스텝 찾기' });

    await t.caption('"공급가액" 값 읽기 스텝 찾기');
    const c0 = t.clicks;
    await t.type(search, '공급가액', '찾기 칸');
    const found = page.locator('.steps.found .step-head');
    await t.click(found.first(), '찾은 스텝 펼치기');
    const ops = t.clicks - c0;
    const open = await page.locator('.step.open .step-head').innerText().catch(() => '');
    t.expect('글자로 원하는 스텝을 3번 이내 조작으로 찾는다', /공급가액/.test(open) && ops <= 3, `${ops}번 · ${open}`);
    await t.shot('search-text', { note: '글자 찾기 결과' });
    const no = (await page.locator('.step.open .step-head .num').innerText()).trim();

    await t.caption(`번호 ${no} 로 찾기`);
    await t.type(search, no, '찾기 칸 (번호)');
    const byNo = await found.first().innerText().catch(() => '');
    t.expect('번호(#n)로 찾으면 같은 스텝이 나온다', byNo.includes('공급가액'), byNo);

    await t.caption('종류 "값 읽기" 로 거르기 → 찾은 스텝 모두 고르기');
    await t.type(search, '', '찾기 칸 비우기');
    await t.choose(page.getByRole('combobox', { name: '종류로 거르기' }), { label: '값 읽기' }, '종류 = 값 읽기');
    const n = await found.count();
    await t.click(page.getByRole('button', { name: '찾은 스텝 모두 고르기' }), '찾은 스텝 모두 고르기');
    await t.pause(500, 700);
    const bar = page.getByRole('toolbar', { name: '고른 스텝 한꺼번에 바꾸기' });
    const barText = await bar.innerText().catch(() => '');
    await t.shot('filtered-selected', { note: '거르고 모두 고른 뒤 일괄 막대' });
    t.expect('거른 값 읽기 스텝을 한 번에 고른다', barText.includes(`${n}개 고름`), `${n} · ${barText.slice(0, 80)}`);
    const screenNos = (await found.locator('.num').allInnerTexts()).map((s) => s.trim());

    await t.caption('일괄 [끄기] → 꺼짐 표시 → [켜기]');
    await t.click(bar.getByRole('button', { name: '끄기', exact: true }), '[끄기]');
    const off = await page.locator('.step-head .badge', { hasText: '꺼짐' }).count();
    t.expect('일괄 끄기가 고른 스텝 모두에 적용된다', off === n, `꺼짐 ${off} / ${n}`);
    await t.shot('bulk-off', { note: '일괄 끄기 뒤' });
    const barAfter = await bar.isVisible().catch(() => false);
    if (!barAfter) t.wander('끄기 뒤 선택이 풀려 [켜기] 를 하려면 다시 골라야 함');
    else await t.click(bar.getByRole('button', { name: '켜기', exact: true }), '[켜기]');

    await t.caption('고른 스텝을 [✦ AI 에게] → 설명 요청');
    if (!(await bar.isVisible().catch(() => false))) await t.click(page.getByRole('button', { name: '찾은 스텝 모두 고르기' }), '다시 모두 고르기');
    await t.click(bar.getByRole('button', { name: '✦ AI 에게' }), '일괄 [✦ AI 에게]');
    await t.pause(600, 800);
    const draft = await aiInput(page).inputValue();
    await t.type(aiInput(page), '설명해 줘', '초안 뒤에 이어 쓰기', { clear: false });
    await t.click(sendBtn(page), '[보내기]');
    await waitTurn(page);
    await t.pause(600, 800);
    const reply = await lastReply(page);
    await t.shot('ai-numbers', { note: 'AI 가 받은 번호' });
    const aiNos = [...reply.matchAll(/(#[\d.]+)\(/g)].map((m) => m[1]);
    const draftNos = [...draft.matchAll(/#[\d.]+/g)].map((m) => m[0]);
    t.note(`화면 번호 ${screenNos.join(',')} · 초안 ${draftNos.join(',')} · AI ${aiNos.join(',')}`);
    t.expect('번호가 화면·초안·AI 에서 같다', screenNos.join() === draftNos.join() && draftNos.join() === aiNos.join(), `${screenNos} | ${draftNos} | ${aiNos}`);
    t.outcome(`"공급가액" 을 ${ops}번 조작으로 찾음 · 값 읽기 ${n}개 한꺼번에 끄고 켬`);
    t.outcome(`번호 화면 = AI: ${aiNos.join(', ')}`);
  },
};
