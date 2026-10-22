// T5: "결과 표의 행마다 금액 읽기" — 화면(값 읽기 추가 → 목록의 항목마다로 묶기)과 AI 요청 두 방법
//   + 확인: 1회차 화면 방법으로 만들어 둔 레시피(목록은 CSS, 몸통은 녹화 칸 그대로)를 열면 알아보고 고칠 수 있나
import { openEditor, save, startRun, openReportFromRun, askAi, panelOf, stepHead, toastOverHead } from './app.mjs';

const amounts = (rep) =>
  String(rep?.rows?.[0]?.values?.금액 ?? '')
    .split('\n')
    .filter(Boolean);
const RIGHT = '12,000,8,500,1,500,000,300';

async function runIt(t, env, label) {
  const page = t.page;
  await t.click(page.getByRole('button', { name: '▶ 실행하기' }), '[▶ 실행하기]');
  await page.getByText('2. 엑셀 데이터').waitFor();
  const rep = await startRun(t, env);
  await openReportFromRun(t);
  const a = amounts(rep);
  t.note(`[${label}] 결과 금액: ${JSON.stringify(a)} (상태 ${rep?.status}${rep?.error ? ` · ${rep.error}` : ''})`);
  return a;
}

export default {
  id: 'T5',
  title: '결과 표의 행마다 금액 읽기',
  flow: '값 읽기 추가 → 목록의 항목마다로 묶기 → 실행 → 리포트에서 4행 금액 확인 → AI 로도 한 번',
  async run(t, { env, fx, base }) {
    const page = t.page;
    await t.goto(`${base}/#/recipes`);
    await t.caption('녹화한 레시피 열기 (금액 칸 클릭 · 다음 클릭)');
    await openEditor(t, base, fx.t5.name);
    await t.shot('editor', { note: '녹화 직후 스텝' });

    // ---------- 1) 화면으로 ----------
    await t.caption('[화면] #2 금액 칸 클릭 스텝 펼치기');
    await t.click(stepHead(page, '#2'), '#2 펼치기');
    await t.caption('[화면] "이 요소의 글자 읽기 추가" → 이름 "금액"');
    t.answer('금액');
    await t.click(page.getByRole('button', { name: '이 요소의 글자 읽기 추가' }), '이 요소의 글자 읽기 추가');
    await t.pause(600, 800);
    await t.caption('[화면] 새 값 읽기(#3)를 골라 "목록의 항목마다로 묶기"');
    await t.check(page.getByRole('checkbox', { name: '#3 스텝 고르기' }), '#3 고르기');
    await t.shot('bulk-bar', { note: '일괄 막대' });
    await t.click(page.getByRole('button', { name: '목록의 항목마다로 묶기' }), '목록의 항목마다로 묶기');
    await t.pause(700, 900);
    const toastText = await page.locator('#toasts').innerText().catch(() => '');
    const over = await toastOverHead(page);
    t.note(`알림 높이 ${over.lines.join(',')}px · pointer-events ${over.pointer} · 가린 머리 단추: ${over.hit.join(', ') || '없음'}`);
    t.expect('[R2-02] 묶은 뒤 알림이 한 줄이고 머리 단추를 가리지 않는다', over.hit.length === 0 && over.lines.every((h) => h <= 56), JSON.stringify(over));
    t.note(`묶은 뒤 알림: ${toastText.replace(/\s+/g, ' ').slice(0, 200)}`);
    await t.shot('foreach-made', { note: '묶은 직후 — 목록 요약·몸통 스텝' });
    const sum = (await page.locator('.foreach-sum').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    t.note(`목록 요약: ${sum.slice(0, 200)}`);
    // 사람은 요약을 읽고 목록이 없다고 하면 고른다 (있으면 그대로 저장)
    if (/아직 목록 요소가 없습니다/.test(sum)) {
      t.wander('묶은 뒤에도 목록이 비어 있어 "목록 요소 고르기" 에서 고름');
      const pick = page.getByRole('combobox', { name: '기존 스텝 요소에서 고르기' });
      const opts = await pick.locator('option').allInnerTexts();
      t.note(`목록 요소 고르기 선택지: ${opts.join(' | ')}`);
      await t.choose(pick, { label: opts.find((o) => /12,000/.test(o)) ?? opts[1] }, '목록 요소');
      await t.shot('foreach-picked', { note: '목록 요소를 고른 뒤' });
    } else {
      const opts = await page.getByRole('combobox', { name: '기존 스텝 요소에서 고르기' }).locator('option').allInnerTexts().catch(() => []);
      t.note(`(고르지 않음) 목록 요소 고르기 선택지: ${opts.join(' | ')}`);
    }
    const bodyHead = (await page.locator('.step-kids .step-head').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    t.note(`몸통 스텝 줄: ${bodyHead}`);
    await save(t);
    await t.caption('[화면] 실행해 보기');
    const a1 = await runIt(t, env, '화면');
    await t.shot('report-screen', { full: true, note: '화면으로 만든 반복의 실행 결과' });
    t.expect('[화면 방법] 실행 결과에 행마다 금액이 남는다 (1쪽 4행, 서로 다른 값)', a1.join(',') === RIGHT, JSON.stringify(a1));
    t.outcome(`화면으로: 4행 금액 ${a1.join(' · ') || '(없음)'}`);

    // ---------- 2) AI 로 (녹화 그대로인 사본에서) ----------
    await t.caption('[AI] 녹화 그대로인 사본을 열어 AI 에게 요청');
    await t.click(page.locator('#nav').getByRole('link', { name: '레시피', exact: true }), '메뉴 레시피');
    await openEditor(t, base, fx.t5ai.name);
    const reply = await askAi(t, '결과 표의 행마다 금액을 읽게 고쳐 줘');
    await t.shot('ai-pending', { note: 'AI 제안 카드' });
    t.note(`AI 답: ${reply.slice(0, 200)}`);
    const card = await page.locator('.ai-changes').innerText().catch(() => '');
    t.note(`제안 카드: ${card.replace(/\s+/g, ' ').slice(0, 400)}`);
    t.expect('[AI 방법] 제안 카드가 생긴다', /제안된 변경/.test(card), card.slice(0, 200));
    t.expect('[R1-04] 제안 카드에 내부 id(s4 등)·견본 글자 대상이 없고 바뀐 대상이 보인다', !/\bs\d+\b/.test(card) && !/"12,000"의 글자 읽어/.test(card.split('→').pop() ?? ''), card.slice(0, 300));
    await t.click(panelOf(page).getByRole('button', { name: '적용', exact: true }), '[적용]');
    await save(t);
    await t.shot('ai-applied', { note: 'AI 제안 적용 뒤 트리' });
    const tree = (await page.locator('.steps').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    t.note(`AI 적용 뒤 트리: ${tree.slice(0, 300)}`);
    const a2 = await runIt(t, env, 'AI');
    await t.shot('report-ai', { full: true, note: 'AI 로 고친 반복의 실행 결과' });
    t.expect('[AI 방법] 실행 결과에 행마다 금액이 남는다 (1쪽 4행)', a2.join(',') === RIGHT, JSON.stringify(a2));
    t.outcome(`AI 로: 4행 금액 ${a2.join(' · ') || '(없음)'}`);

    // ---------- 3) 확인: 1회차 방식 레시피 ----------
    await t.caption('[확인] 1회차 방식으로 만든 레시피 열기 (몸통이 녹화 칸 그대로)');
    await t.click(page.locator('#nav').getByRole('link', { name: '레시피', exact: true }), '메뉴 레시피');
    await openEditor(t, base, fx.t5old.name);
    await t.pause(600, 800);
    await t.shot('old-open', { note: '1회차 방식 레시피를 연 첫 화면 (고칠 점·배지)' });
    // 회귀 확인: 편집기에서 다른 레시피를 일부러 열었을 때도 "대화가 바뀌었습니다" 안내가 뜨는가, [돌아가기] 를 누르면?
    const sw = panelOf(page).locator('.ai-switched');
    const swText = (await sw.innerText().catch(() => '')).replace(/\s+/g, ' ');
    if (swText) {
      t.note(`편집기에서 레시피를 연 뒤 패널 안내: ${swText.slice(0, 200)}`);
      await t.caption('[확인] 편집기에 뜬 "대화로 돌아가기" 를 눌러 보면');
      await t.click(sw.getByRole('button', { name: /대화로 돌아가기/ }), '[대화로 돌아가기]');
      await t.pause(900, 1100);
      const aiName = (await panelOf(page).locator('.ai-scope .ai-recipe').innerText().catch(() => '')).trim();
      const edName = await page.getByRole('textbox', { name: '레시피 이름' }).inputValue().catch(async () => page.locator('.editor input[type=text]').first().inputValue());
      await t.shot('editor-switch-back', { note: '편집기에서 [대화로 돌아가기] 를 누른 뒤 — 편집기와 AI 패널의 레시피' });
      t.note(`[돌아가기] 뒤: 편집기 "${edName}" · AI 패널 "${aiName}"`);
      t.expect('[확인] 편집기에서 [돌아가기] 를 눌러도 AI 대화가 편집기의 레시피와 맞다', aiName === edName, `편집기 ${edName} / AI ${aiName}`);
      // 사람은 레시피 목록에서 다시 열어 맞춘다
      await t.click(page.locator('#nav').getByRole('link', { name: '레시피', exact: true }), '메뉴 레시피');
      await openEditor(t, base, fx.t5old.name);
      const close = sw.getByRole('button', { name: '닫기' });
      if (await close.isVisible().catch(() => false)) await t.click(close, '안내 [닫기]');
    } else t.note('편집기에서 레시피를 연 뒤 패널 안내 없음');
    {
      const aiName = (await panelOf(page).locator('.ai-scope .ai-recipe').innerText().catch(() => '')).trim();
      const edName = await page.getByRole('textbox', { name: '레시피 이름' }).inputValue().catch(() => '');
      const mism = await panelOf(page).locator('.ai-mismatch').isVisible().catch(() => false);
      t.note(`다른 레시피를 편집기로 연 뒤: 편집기 "${edName}" · AI 패널 "${aiName}" · 안내 ${swText ? '있음' : '없음'} · 어긋남 경고 ${mism ? '있음' : '없음'}`);
      t.expect('[R2-01] 편집기에서 다른 레시피를 열면 안내 없이 AI 패널도 그 레시피 대화', !swText && aiName === edName && !mism, `안내 "${swText.slice(0, 60)}" · 편집기 ${edName} / AI ${aiName}`);
    }
    const probs = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    const badge = await page.locator('.step-head .badge', { hasText: '항목마다 같은 요소' }).count();
    t.note(`1회차 방식: 배지 ${badge}개 · 고칠 점 문구 ${/항목마다 같은 요소를 씁니다/.test(probs) ? '있음' : '없음'}`);
    const conv = page.getByRole('button', { name: '항목 안에서 찾기로 바꾸기' });
    if (!(await conv.isVisible().catch(() => false))) {
      // 사람은 고칠 점 줄이나 배지가 붙은 스텝을 눌러 펼친다
      const flagged = page.locator('.step-head', { has: page.locator('.badge', { hasText: '항목마다 같은 요소' }) }).first();
      if (await flagged.isVisible().catch(() => false)) await t.click(flagged, '배지 붙은 스텝 펼치기');
      else t.wander('1회차 방식 레시피: 같은 값 배지가 붙은 스텝을 찾지 못함');
    }
    if (await conv.isVisible().catch(() => false)) {
      await t.shot('old-warning', { note: '펼친 스텝의 경고와 [항목 안에서 찾기로 바꾸기]' });
      await t.click(conv, '[항목 안에서 찾기로 바꾸기]');
      await save(t);
      const a3 = await runIt(t, env, '1회차 방식 → 고침');
      await t.shot('report-old-fixed', { full: true, note: '고친 뒤 실행 결과' });
      t.expect('[확인] 같은 칸을 읽던 레시피를 화면에서 알아보고 고쳐 4행 값이 맞다', badge > 0 && a3.join(',') === RIGHT, `배지 ${badge} · ${JSON.stringify(a3)}`);
      t.outcome(`예전 방식 레시피: [항목 안에서 찾기로 바꾸기] 한 번 → ${a3.length}행 금액`);
    } else t.expect('[확인] 같은 칸을 읽던 레시피를 화면에서 알아보고 고쳐 4행 값이 맞다', false, `배지 ${badge}, 고치는 단추 없음`);
  },
};
