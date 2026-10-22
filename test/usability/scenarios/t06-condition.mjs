// T6: "상태가 폐업이면 화면 캡처" — JSON 을 열지 않고 문장형 조건 편집기로
import { openEditor, save, startRun, openReportFromRun, stepHead } from './app.mjs';

export default {
  id: 'T6',
  title: '상태가 폐업이면 화면 캡처',
  flow: '반복 안에 화면 캡처 추가 → 조건부로 만들기 → "{{상태}}에 폐업이 들어 있으면" → 실행해 폐업 행만 캡처',
  async run(t, { env, fx, base }) {
    const page = t.page;
    await t.goto(`${base}/#/recipes`);
    await t.caption('표의 행마다 상호·상태·금액을 읽는 레시피 열기');
    await openEditor(t, base, fx.t6.name);
    await t.shot('tree', { note: '반복 트리' });
    await t.caption('반복(#2) 펼쳐서 "안에 스텝 추가"');
    await t.click(stepHead(page, '#2'), '#2 펼치기');
    const addIn = await t.find('반복 안에 스텝 넣는 단추', [
      ['＋ 안에 스텝 추가', () => page.getByRole('button', { name: '＋ 안에 스텝 추가' })],
      ['＋ 여기에 스텝 추가', () => page.getByRole('button', { name: '＋ 여기에 스텝 추가' })],
    ]);
    await t.click(addIn, '＋ 안에 스텝 추가');
    await t.pause(600, 800);
    await t.shot('add-bar', { note: '스텝 추가 막대 (블록 안)' });
    await t.caption('스텝 종류 "화면 캡처" → ＋ 추가');
    await t.choose(page.getByRole('combobox', { name: '추가할 스텝 종류' }), { label: '화면 캡처' }, '스텝 종류');
    await t.click(page.getByRole('button', { name: '＋ 추가', exact: true }), '＋ 추가');
    await t.pause(700, 900);
    const capNo = (await page.locator('.step.open > .step-head .num').innerText().catch(() => '')).trim();
    t.note(`새 화면 캡처 스텝 번호: ${capNo}`);
    await t.caption(`캡처 스텝(${capNo})을 골라 "조건부로 만들기"`);
    await t.check(page.getByRole('checkbox', { name: `${capNo} 스텝 고르기` }), `${capNo} 고르기`);
    await t.click(page.getByRole('button', { name: '조건부로 만들기' }), '조건부로 만들기');
    await t.pause(800, 1000);
    await t.shot('branch-default', { note: '조건부로 만든 직후의 처음 조건' });
    const cond = page.locator('.step.open .cond').first();
    const pre0 = await cond.locator('.cond-preview').innerText().catch(() => '');
    t.note(`처음 조건 미리보기: ${pre0}`);
    const head0 = (await page.locator('.step.open > .step-head').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    t.note(`처음 분기 스텝 줄: ${head0}`);
    t.expect('[R2-05] 빈 조건은 빈 따옴표 대신 "(보일 글자를 정하세요)"', !/""/.test(`${head0} ${pre0}`) && /정하세요/.test(`${head0} ${pre0}`), `${head0} / ${pre0}`);
    const warn0 = await page.locator('.step.open .notice.warn', { hasText: '조건을 정해 주세요' }).count();
    const capName = await page.locator('.step-kids .step-head', { hasText: '화면 캡처' }).first().innerText().catch(() => '');
    t.note(`조건 안내 ${warn0 ? '있음' : '없음'} · 캡처 스텝 줄: ${capName.replace(/\s+/g, ' ')}`);
    t.expect('[R1-11] 요소 없는 스텝을 조건부로 만들면 빈 조건 + "조건을 정해 주세요" (늘 참인 조건이 아님)', warn0 > 0 && !/표 줄/.test(pre0), pre0);
    t.expect('[R1-11] 반복 안 화면 캡처 기본 이름이 항목마다 다르다 ({{item.index}})', /item\.index/.test(capName), capName);
    await t.caption('조건: [무엇이] 상태 값');
    const subj = cond.getByRole('combobox', { name: '무엇이' }).first();
    const subjOpts = await subj.locator('option').allInnerTexts();
    t.note(`무엇이 선택지: ${subjOpts.join(' | ')}`);
    const state = subjOpts.find((o) => o.startsWith('{{상태}}'));
    if (!state) t.wander('조건의 "무엇이" 목록에서 {{상태}} 를 찾지 못함');
    await t.choose(subj, { label: state ?? subjOpts.find((o) => o.includes('item.cell')) }, '무엇이');
    await t.caption('조건: [어떠하면] "에 다음이 들어 있으면" + 폐업');
    await t.choose(cond.getByRole('combobox', { name: '어떠하면' }).first(), { label: '에 다음이 들어 있으면' }, '어떠하면');
    await t.type(cond.getByRole('textbox', { name: '비교할 값' }).first(), '폐업', '비교할 값');
    await t.pause(500, 700);
    const preview = await cond.locator('.cond-preview').innerText().catch(() => '');
    await t.shot('branch-cond', { note: '조건을 고른 뒤 미리보기' });
    t.expect('문장 미리보기가 "{{상태}} 에 "폐업" 포함"', /상태.*폐업/.test(preview), preview);
    const brHead = (await page.locator('.step.open > .step-head').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    t.note(`분기 스텝 줄: ${brHead}`);
    t.expect('[R2-05] 분기 문장에 블록 이름([조건]) 대신 "그러면 안의 스텝 N개"', !/\[조건\]/.test(brHead) && /안의 스텝 \d+개/.test(brHead), brHead);
    await save(t);
    const r = (await env.api('GET', `/api/recipes/${fx.t6.id}`)).recipe;
    const br = Object.values(r.blocks).flat().find((s) => s.type === 'branch');
    t.expect('JSON 탭을 열지 않고 조건 분기가 저장된다', br?.condition?.kind === 'varContains' && br.condition.value === '폐업' && !t.actions.some((a) => /JSON/.test(a.click ?? '')), JSON.stringify(br?.condition));
    await t.caption('실행해서 확인');
    await t.click(page.getByRole('button', { name: '▶ 실행하기' }), '[▶ 실행하기]');
    await page.getByText('2. 엑셀 데이터').waitFor();
    const rep = await startRun(t, env);
    await openReportFromRun(t);
    await t.shot('report', { full: true, note: '실행 결과 (폐업 행만 캡처)' });
    const files = rep?.files ?? [];
    t.note(`실행 ${rep?.status} · 파일 ${files.length}개: ${files.join(', ')}`);
    t.expect('폐업 행(1쪽 다라상사)만 화면 캡처가 남는다', files.length === 1, files.join(', '));
    t.outcome(`조건: ${preview.replace(/^미리보기:\s*/, '')}`);
    t.outcome(`폐업 행만 캡처 ${files.length}개 (${files.map((f) => f.replace(/^files[\\/]/, '')).join(', ')})`);
    const fileCell = (await page.locator('tbody tr').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    t.note(`리포트 행: ${fileCell.slice(0, 200)}`);
  },
};
