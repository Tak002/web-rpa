// T7: "다음 쪽이 없을 때까지" 반복 — 12행 모두 처리되고 상한이 보여야 한다
//   사람은 [반복으로 묶기] 뒤 "반복 방법" 목록에서 과제 문구와 가장 가까운 것을 고른다(정답 경로를 미리 알지 않는다).
//   그 뒤 [확인]: 1회차처럼 "조건이 참인 동안 + 다음 있으면" 을 고른 사람에게 경고·[쪽 넘기기로 바꾸기] 가 보이는지.
import { openEditor, save, startRun, openReportFromRun, askAi, panelOf, stepHead, toastOverHead } from './app.mjs';

const names = (rep) =>
  String(rep?.rows?.[0]?.values?.상호 ?? '')
    .split('\n')
    .filter(Boolean);
const GOAL = ['다음 쪽', '없을 때까지', '쪽'];
/** 과제 문구 낱말이 가장 많이 들어간 선택지 (같으면 앞의 것) */
const closest = (opts, words) => opts.map((o, i) => ({ ...o, i, score: words.filter((w) => o.label.includes(w)).length })).sort((a, b) => b.score - a.score || a.i - b.i)[0];

async function runAndCount(t, env, label) {
  const page = t.page;
  await t.click(page.getByRole('button', { name: '▶ 실행하기' }), '[▶ 실행하기]');
  await page.getByText('2. 엑셀 데이터').waitFor();
  const rep = await startRun(t, env);
  await openReportFromRun(t);
  const n = names(rep);
  const why = String(rep?.log ?? '')
    .split('\n')
    .filter((l) => /반복 끝|최대 반복/.test(l))
    .slice(-2)
    .join(' / ');
  t.note(`[${label}] 실행 ${rep?.status} · 읽은 상호 ${n.length}개${why ? ` · 로그: ${why.replace(/^\[[^\]]+\]\s*/, '')}` : ''}`);
  return { rep, n, why };
}

export default {
  id: 'T7',
  title: '다음 쪽이 없을 때까지 반복',
  flow: '목록·"다음" 클릭을 반복으로 묶기 → 반복 방법 고르기 → 실행해 3쪽 12행 확인',
  async run(t, { env, fx, base }) {
    const page = t.page;
    await t.goto(`${base}/#/recipes`);
    await t.caption('1쪽 행마다 상호를 읽고 "다음" 을 누르는 레시피 열기');
    await openEditor(t, base, fx.t7.name);
    await t.shot('tree', { note: '시작 트리' });

    // ---------- 1차: 화면에서 ----------
    await t.caption('[1차] #2 목록·#3 다음 클릭을 골라 "반복으로 묶기"');
    await t.check(page.getByRole('checkbox', { name: '#2 스텝 고르기' }), '#2 고르기');
    await t.check(page.getByRole('checkbox', { name: '#3 스텝 고르기' }), '#3 고르기');
    await t.click(page.getByRole('button', { name: '반복으로 묶기' }), '반복으로 묶기');
    await t.pause(700, 900);
    const toast = (await page.locator('#toasts').innerText().catch(() => '')).replace(/\s+/g, ' ');
    const over = await toastOverHead(page);
    t.expect('[R2-02] 묶은 뒤 알림이 한 줄이고 머리 단추를 가리지 않는다', over.hit.length === 0 && over.lines.every((h) => h <= 56), JSON.stringify(over));
    t.note(`묶은 뒤 알림: ${toast}`);
    await t.shot('repeat-times', { note: '묶은 직후 (N번 반복) · 알림' });
    const modeSel = page.getByRole('combobox', { name: '반복 방법' });
    const opts = await modeSel.locator('option').evaluateAll((os) => os.map((o) => ({ value: o.value, label: o.textContent.trim() })));
    const pick = closest(opts, GOAL);
    t.note(`반복 방법 선택지: ${opts.map((o) => o.label).join(' | ')} → 과제 문구와 가장 가까운 "${pick.label}"`);
    await t.caption(`[1차] 반복 방법: "${pick.label}"`);
    await t.choose(modeSel, pick.value, '반복 방법');
    await t.pause(700, 900);
    if (pick.value === 'while' || pick.value === 'until') {
      const cond = page.locator('.step.open .cond').first();
      const subj = cond.getByRole('combobox', { name: '무엇이' }).first();
      const so = await subj.locator('option').allInnerTexts();
      await t.choose(subj, { label: so.find((o) => o.includes('다음')) }, '무엇이 = 다음 버튼');
      await t.choose(cond.getByRole('combobox', { name: '어떠하면' }).first(), { label: pick.value === 'while' ? '이(가) 있으면' : '이(가) 없으면' }, '어떠하면');
    }
    const summary = (await page.locator('.step.open .step-body').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    t.note(`반복 편집기 글: ${summary.slice(0, 300)}`);
    // 반복 방법 칸: 고른 글이 잘리지 않는가 (글자 폭 + 화살표 여백 ≤ 칸 폭)
    const fit = await modeSel.evaluate((el) => {
      const c = document.createElement('canvas').getContext('2d');
      const cs = getComputedStyle(el);
      c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const text = el.selectedOptions[0]?.textContent ?? '';
      return { text, need: Math.ceil(c.measureText(text).width) + 40, width: Math.round(el.clientWidth) };
    });
    t.note(`반복 방법 칸: "${fit.text}" 필요 ${fit.need}px / 칸 ${fit.width}px`);
    t.expect('[R2-06] 반복 방법 칸에서 고른 글이 잘리지 않는다', fit.need <= fit.width, JSON.stringify(fit));
    const heads = (await page.locator('.step-head').allInnerTexts()).map((x) => x.replace(/\s+/g, ' ')).join(' | ');
    t.note(`스텝 줄들: ${heads.slice(0, 400)}`);
    t.expect('[R2-05] 쪽 넘기기 문장에 블록 이름([다음누르기])이 보이지 않고 조사가 맞다', !/\[[^\]]*누르기\]|\[반복\]/.test(heads) && !/#[\d.]+ 는/.test(summary), `${heads.slice(0, 200)} / ${summary.slice(0, 120)}`);
    const maxIn = page.getByLabel(/최대 반복 횟수/).first();
    if (await maxIn.isVisible().catch(() => false)) await t.type(maxIn, '20', '최대 반복 횟수');
    else t.wander('최대 반복 횟수 칸이 보이지 않음');
    await t.shot('repeat-chosen', { note: `1차: ${pick.label}` });
    await save(t);
    const headText = await stepHead(page, '#2').innerText().catch(() => '');
    t.note(`#2 스텝 줄: ${headText.replace(/\s+/g, ' ')}`);
    t.expect('반복 상한이 스텝 목록에 보인다', /최대 \d+/.test(headText), headText);
    await t.shot('tree-after', { note: '1차 저장 뒤 트리' });
    const first = await runAndCount(t, env, `1차 ${pick.value}`);
    await t.shot('report-1', { full: true, note: '1차 결과' });
    let done = first.n.length === 12;
    if (!done) t.wander(`1차 결과 상호 ${first.n.length}개 (12개가 아님)`);
    t.expect('[화면 방법] 12행 모두 처리', done, `${first.n.length}개`);
    t.expect('[R2-03] 실행 기록의 반복 끝 까닭이 바로 읽힌다 ("아님(" 없음)', /반복 끝/.test(first.why) && !/아님\(/.test(first.why), first.why);
    t.outcome(`반복 방법 "${pick.label}" → 상호 ${first.n.length}개 (3쪽)`);
    t.outcome(`실행 기록: ${first.why.replace(/^\[[^\]]+\]\s*/, '').slice(0, 70)}`);

    // ---------- 확인: 1회차처럼 "조건이 참인 동안" 을 고르면 ----------
    await t.caption('[확인] 1회차처럼 "조건이 참인 동안 + 다음 있으면" 으로 바꿔 보기');
    await t.click(page.locator('#nav').getByRole('link', { name: '레시피', exact: true }), '메뉴 레시피');
    await openEditor(t, base, fx.t7.name);
    await t.click(stepHead(page, '#2'), '#2 펼치기');
    await t.choose(page.getByRole('combobox', { name: '반복 방법' }), 'while', '반복 방법 = 참인 동안');
    await t.pause(700, 900);
    const c2 = page.locator('.step.open .cond').first();
    const so2 = await c2.getByRole('combobox', { name: '무엇이' }).first().locator('option').allInnerTexts();
    const cur = await c2.locator('.cond-preview').innerText().catch(() => '');
    if (!/다음/.test(cur)) await t.choose(c2.getByRole('combobox', { name: '무엇이' }).first(), { label: so2.find((o) => o.includes('다음')) }, '무엇이 = 다음 버튼');
    await t.choose(c2.getByRole('combobox', { name: '어떠하면' }).first(), { label: '이(가) 있으면' }, '어떠하면 = 있으면');
    await t.pause(600, 800);
    const warnText = (await page.locator('.step.open .notice', { hasText: '마지막 쪽' }).first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    const riskBadge = await stepHead(page, '#2').locator('.badge', { hasText: '마지막 쪽 빠짐' }).isVisible().catch(() => false);
    await t.shot('while-warning', { note: '참인 동안 + 다음 있으면 — 경고·배지' });
    t.note(`경고: ${warnText.slice(0, 220) || '(없음)'} · 배지 ${riskBadge ? '있음' : '없음'}`);
    const toPages = page.getByRole('button', { name: '쪽 넘기기로 바꾸기' });
    if (await toPages.isVisible().catch(() => false)) {
      await t.click(toPages, '[쪽 넘기기로 바꾸기]');
      await t.pause(700, 900);
      await t.shot('to-pages', { note: '[쪽 넘기기로 바꾸기] 뒤' });
      await save(t);
      const fixed = await runAndCount(t, env, '확인: 쪽 넘기기로 바꾼 뒤');
      t.expect('[확인] 참인 동안 경로에 경고·배지가 뜨고 [쪽 넘기기로 바꾸기] 한 번으로 12행', !!warnText && riskBadge && fixed.n.length === 12, `${fixed.n.length}개`);
      done ||= fixed.n.length === 12;
      t.outcome(`"조건이 참인 동안" 을 고르면 "마지막 쪽 빠짐" 경고 → [쪽 넘기기로 바꾸기] → ${fixed.n.length}개`);
    } else t.expect('[확인] 참인 동안 경로에 경고·배지가 뜨고 [쪽 넘기기로 바꾸기] 한 번으로 12행', false, '단추 없음');

    // ---------- AI: 화면으로 못 했을 때만 ----------
    if (!done) {
      await t.caption('[AI] AI 에게 "다음 쪽이 없을 때까지" 요청');
      await t.click(page.locator('#nav').getByRole('link', { name: '레시피', exact: true }), '메뉴 레시피');
      await openEditor(t, base, fx.t7.name);
      const reply = await askAi(t, '다음 쪽이 없을 때까지 모든 쪽의 상호를 읽게 고쳐 줘');
      t.note(`AI 답: ${reply.slice(0, 200)}`);
      if (await panelOf(page).getByRole('button', { name: '적용', exact: true }).isVisible().catch(() => false)) {
        await t.click(panelOf(page).getByRole('button', { name: '적용', exact: true }), '[적용]');
        await save(t);
        const third = await runAndCount(t, env, 'AI');
        t.note(`[AI 방법] ${third.n.length}개`);
      }
    } else t.note('화면 방법으로 12행이 되어 AI 요청은 하지 않음');
  },
};
