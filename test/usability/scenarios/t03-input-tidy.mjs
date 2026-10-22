// T3: 녹화된 입력 여러 개를 [입력값 정리] 에서 엑셀 열·비밀로 한 번에 바꾸고 실행
import path from 'node:path';
import { openEditor, save, startRun, openReportFromRun, pickExcel } from './app.mjs';
import { writeCsv } from '../recipes.mjs';
import { LAB_USER } from '../../lab-server.mjs';

export default {
  id: 'T3',
  title: '입력값 정리 — 엑셀 열로 바꾸기',
  flow: '입력값 정리에서 사업자번호·기간을 엑셀 열로 → 엑셀 올려 실행 → 리포트에서 확인',
  async run(t, { env, fx, base }) {
    const page = t.page;
    await t.goto(`${base}/#/recipes`);
    await t.caption('편집기 열기');
    await openEditor(t, base, fx.t3.name);
    await t.shot('editor', { note: '녹화 직후 편집기' });
    // 로그인 안내(R1-05)가 첫 화면에서 눈에 띄는지만 본다 — 김 대리는 과제(입력값 정리)부터 한다
    const hint = page.locator('.login-hint');
    const hintBox = await hint.boundingBox().catch(() => null);
    t.note(`로그인 안내: ${hintBox ? `첫 화면 y=${Math.round(hintBox.y)} · "${(await hint.innerText()).replace(/\s+/g, ' ').slice(0, 160)}"` : '보이지 않음'}`);
    await t.caption('입력값 정리 단추 찾기');
    const btn = await t.find('[입력값 정리]', [
      ['스텝 탭의 [입력값 정리]', () => page.getByRole('button', { name: '입력값 정리' })],
      ['변수·엑셀 탭', () => page.getByRole('button', { name: /^변수·엑셀/ })],
    ]);
    await t.click(btn, '[입력값 정리]');
    const dlg = page.getByRole('dialog', { name: '입력값 정리' });
    await dlg.waitFor();
    await t.pause(800, 1000);
    await t.shot('tidy-open', { note: '입력값 정리 창 첫 화면' });
    const rowOf = (label) => dlg.locator('.tidy-row', { hasText: label });
    const rows = await dlg.locator('.tidy-row').count();
    t.note(`입력값 정리 표: ${rows}줄 — ${(await dlg.locator('.tidy-row .tidy-label').allInnerTexts()).join(' / ')}`);
    await t.caption('사업자번호 → 엑셀 열');
    await t.click(rowOf('사업자번호').getByText('엑셀 열', { exact: true }), '사업자번호: 엑셀 열');
    await t.caption('기간 → 엑셀 열');
    await t.click(rowOf('기간').getByText('엑셀 열', { exact: true }), '기간: 엑셀 열');
    const periodRow = (await rowOf('기간').innerText()).replace(/\s+/g, ' ');
    t.note(`기간 줄: ${periodRow.slice(0, 220)}`);
    t.expect('[R1-12] 목록 선택 칸은 보이는 글자로 보이고, 엑셀에 적을 글자를 안내한다', /지금 값 2026년 1기/.test(periodRow) && /엑셀에는 목록에 보이는 글자/.test(periodRow), periodRow.slice(0, 200));
    const pwSecret = await rowOf('비밀번호').getByRole('radio', { name: '비밀' }).isChecked().catch(() => false);
    t.expect('비밀번호 칸은 처음부터 "비밀" 로 골라져 있다', pwSecret);
    await t.shot('tidy-chosen', { note: '고른 뒤 (이름 칸 포함)' });
    await t.caption('[모두 적용]');
    await t.click(dlg.getByRole('button', { name: '모두 적용' }), '[모두 적용]');
    await t.pause(700, 900);
    await t.shot('applied', { note: '적용 뒤 토스트·스텝 목록' });
    await save(t);
    const r = (await env.api('GET', `/api/recipes/${fx.t3.id}`)).recipe;
    const cols = (r.variables ?? []).filter((v) => v.source?.kind === 'excel').map((v) => v.source.column || v.name);
    t.expect('한 화면에서 엑셀 열 2개가 생겼다 (확인창·입력창 없이)', cols.includes('사업자번호') && cols.includes('기간') && !t.dialogs.some((d) => d.type === 'prompt'), cols.join(','));

    await t.caption('[▶ 실행하기] → 엑셀 올리기');
    await t.click(page.getByRole('button', { name: '▶ 실행하기' }), '[▶ 실행하기]');
    await page.getByText('2. 엑셀 데이터').waitFor();
    await t.pause(700, 900);
    const csv = await writeCsv(path.join(env.ws, 'files', '원장_입력.csv'), [
      ['사업자번호', '기간'],
      ['9876543210', '2026년 2기 (7~12월)'],
      ['2223334445', '2026년 1기 (1~6월)'],
    ]);
    await pickExcel(t, csv);
    await t.caption('비밀번호는 이번 실행에만 입력');
    await t.type(page.getByLabel('비밀번호', { exact: true }), LAB_USER.pw, '비밀번호 (가림)');
    await t.shot('run-ready', { full: true, note: '엑셀을 올린 실행 화면' });
    const events0 = (await (await fetch(`${env.labBase}/api/events`)).json()).events.length;
    const rep = await startRun(t, env);
    await openReportFromRun(t);
    await t.shot('report', { full: true, note: '실행 결과' });
    const ev = (await (await fetch(`${env.labBase}/api/events`)).json()).events.slice(events0).filter((e) => e.type === 'export');
    t.expect('실행하면 엑셀 값이 들어간다 (1행: 9876543210 · 2기)', ev.some((e) => e.biz === '9876543210' && e.period === 'H2'), JSON.stringify(ev));
    t.outcome(`입력값 정리 한 창에서 엑셀 열 2개 · 1행에 엑셀 값(9876543210·2기)`);
    t.note(`실행 결과: ${rep?.status} — ${rep?.rows?.map((x) => `${x.rowNumber}행 ${x.status}${x.error ? ` (${x.error.slice(0, 90)})` : ''}`).join(' / ')}`);
    const failed = rep?.rows?.find((x) => x.status !== 'ok');
    if (failed) {
      // 2행이 실패하면: 리포트의 오류를 읽고, 편집기로 가서 해결한다 (R1-05·R1-07)
      const errCell = (await page.locator('tbody tr', { hasText: '실패' }).first().innerText().catch(() => '')).replace(/\s+/g, ' ');
      t.note(`리포트 실패 행 글: ${errCell.slice(0, 240)}`);
      t.expect('[R1-05] 리포트 오류 첫 문장이 쉬운 말이다 (CSS·XPath 가 바로 보이지 않음)', !/xpath|css #|시도한 후보/.test(errCell.replace(/자세히.*$/, '')) && /이미 로그인/.test(errCell), errCell.slice(0, 200));
      t.wander(`${failed.rowNumber}행 실패 — 오류를 읽고 편집기로 돌아가 로그인 스텝을 고침`);
      await t.caption('2행 실패 → 리포트에서 편집기로');
      const toEd = await t.find('리포트 → 편집기', [
        ['리포트 머리의 [편집]', () => page.locator('main .page-head').getByRole('link', { name: '편집', exact: true })],
        ['위 메뉴 [레시피]', () => page.locator('#nav').getByRole('link', { name: '레시피', exact: true })],
      ]);
      await t.click(toEd, '편집기로');
      if (!(await page.locator('.step-head').first().isVisible().catch(() => false))) await openEditor(t, base, fx.t3.name);
      await t.pause(700, 900);
      const fix = await t.find('로그인 스텝 고치는 단추', [
        ['편집기 위 안내의 [로그인 화면일 때만 하도록 묶기]', () => page.getByRole('button', { name: /로그인 화면일 때만/ })],
        ['✦ AI 도우미', () => page.getByRole('button', { name: '✦ AI 도우미' })],
      ]);
      if (fix && /로그인 화면일 때만/.test(await fix.innerText())) {
        await t.click(fix, '[로그인 화면일 때만 하도록 묶기]');
        await t.shot('login-wrapped', { note: '로그인 스텝을 묶은 뒤 트리' });
        await save(t);
        await t.click(page.getByRole('button', { name: '▶ 실행하기' }), '[▶ 실행하기]');
        await page.getByText('2. 엑셀 데이터').waitFor();
        await pickExcel(t, csv);
        await t.type(page.getByLabel('비밀번호', { exact: true }), LAB_USER.pw, '비밀번호 (가림)');
        const rep2 = await startRun(t, env);
        await openReportFromRun(t);
        await t.shot('report-2', { full: true, note: '로그인을 묶은 뒤 다시 실행' });
        t.note(`다시 실행: ${rep2?.status} — ${rep2?.rows?.map((x) => `${x.rowNumber}행 ${x.status}`).join(' / ')}`);
        t.expect('[R1-05] 로그인을 묶은 뒤 2행까지 성공', rep2?.rows?.length === 2 && rep2.rows.every((x) => x.status === 'ok'), JSON.stringify(rep2?.rows?.map((x) => x.error)));
        t.outcome(`로그인을 "로그인 화면일 때만" 으로 묶은 뒤: ${rep2?.rows?.filter((x) => x.status === 'ok').length}/${rep2?.rows?.length}행 성공`);
      } else t.expect('[R1-05] 로그인을 묶은 뒤 2행까지 성공', false, '고치는 단추를 찾지 못함');
    }
  },
};
