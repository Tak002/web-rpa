// T2: 로그인 비밀번호가 있는 레시피를 "이 PC 에 저장" 하며 실행 → 다시 실행 (묻지 않아야), 변수 탭·AI 요청에 비밀값 없음
import fs from 'node:fs/promises';
import path from 'node:path';
import { openRun, startRun, askAi, panelOf } from './app.mjs';
import { LAB_USER } from '../../lab-server.mjs';

async function filesWith(dir, needle) {
  const hits = [];
  const walk = async (d) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!/profile/i.test(e.name)) await walk(p);
      } else if (/\.(json|jsonl|md|txt|csv|log)$/i.test(e.name)) {
        const s = await fs.readFile(p, 'utf8').catch(() => '');
        if (s.includes(needle)) hits.push(path.relative(dir, p));
      }
    }
  };
  await walk(dir);
  return hits;
}

export default {
  id: 'T2',
  title: '비밀번호를 이 PC 에 저장하고 다시 실행',
  flow: '비밀번호 넣고 "이 PC 에 저장" → 다시 실행(묻지 않음) → 변수 탭·AI 요청에 비밀값 없음',
  async run(t, { env, fx, base }) {
    const page = t.page;
    const name = fx.t2.name;
    const PW = LAB_USER.pw;
    await t.caption('레시피 목록에서 [실행]');
    await openRun(t, base, name);
    await t.shot('run-form', { full: true, note: '첫 실행 화면: 비밀번호 칸 + 이 PC 에 저장' });
    await t.caption('비밀번호 입력 + "이 PC 에 저장" 켜기');
    const pwBox = await t.find('비밀번호 칸', [
      ['"비밀번호" 칸', () => page.getByLabel('비밀번호', { exact: true })],
      ['비밀번호 입력 칸', () => page.locator('.secret-field input[type=password]')],
    ]);
    await t.type(pwBox, PW, '비밀번호 (가림)');
    await t.check(page.getByRole('checkbox', { name: /이 PC 에 저장/ }), '이 PC 에 저장');
    const r1 = await startRun(t, env);
    t.expect('첫 실행 성공 (로그인 통과)', r1?.status === 'done', `${r1?.status} ${r1?.rows?.[0]?.error ?? ''}`);
    await t.shot('first-done', { note: '첫 실행 뒤: 저장됨 표시' });
    const saved = await page.getByText('●●●● 저장됨').isVisible().catch(() => false);
    t.expect('저장 상태 "●●●● 저장됨 · 바꾸기 · 지우기" 가 보인다', saved);

    await t.caption('다음 날 다시 실행 (새로 고침)');
    await page.reload();
    await page.getByText('2. 엑셀 데이터').waitFor();
    await t.pause(900, 1200);
    const askAgain = await page.locator('.secret-field input[type=password]').isVisible().catch(() => false);
    t.expect('두 번째 실행: 비밀번호 칸을 다시 묻지 않는다', !askAgain && (await page.getByText('●●●● 저장됨').isVisible()));
    await t.shot('second-form', { note: '두 번째 실행 화면' });
    const lastRun = await page.locator('.last-run').innerText().catch(() => '');
    const setupTop = await page.getByRole('heading', { name: '1. 레시피' }).boundingBox().catch(() => null);
    t.note(`다시 연 실행 화면: 지난 실행 줄 "${lastRun.replace(/\s+/g, ' ').slice(0, 120)}" · "1. 레시피" 위치 y=${Math.round(setupTop?.y ?? -1)}`);
    t.expect('[R1-14] 끝난 지난 실행은 한 줄로 접혀 설정이 첫 화면에 보인다', !!lastRun && setupTop && setupTop.y < 400, `y=${setupTop?.y}`);
    const r2 = await startRun(t, env);
    t.expect('두 번째 실행 성공 (저장된 값으로 로그인)', r2?.status === 'done', `${r2?.status} ${r2?.rows?.[0]?.error ?? ''}`);

    await t.caption('편집기 → 변수·엑셀 탭에서 비밀번호 변수 보기');
    await t.click(page.locator('main').getByRole('link', { name: '편집', exact: true }), '[편집]');
    await page.locator('.step-head').first().waitFor();
    await t.click(page.getByRole('button', { name: /^변수·엑셀/ }), '변수·엑셀 탭');
    await t.pause(600, 900);
    const card = page.locator('.var-item');
    const cards = await card.count();
    let plain = 0;
    for (let i = 0; i < cards; i += 1) {
      const c = card.nth(i);
      if (!(await c.innerText()).includes('비밀')) continue;
      plain += await c.locator('input[type=text]:not([aria-label="변수 이름"])').count();
    }
    const pageText = await page.locator('main').innerText();
    t.expect('변수 탭에 비밀값 평문 칸이 없다', plain === 0 && !pageText.includes(PW), `평문 칸 ${plain}개`);
    await t.shot('vars-tab', { note: '변수 탭: 비밀 변수' });
    const secretCard = await page.locator('.var-item', { hasText: '비밀' }).first().innerText().catch(() => '');
    t.note(`변수 탭 비밀 변수 설명: ${secretCard.replace(/\s+/g, ' ').slice(0, 220)}`);
    t.expect('[R1-17] 변수 탭에 "이 PC 에 저장됨" 표시가 보인다', /이 PC 에 저장됨/.test(secretCard), secretCard.slice(0, 160));

    await t.caption('AI 에게 로그인 뒤 화면 확인 요청');
    const n0 = env.model.log.length;
    const reply = await askAi(t, '로그인 뒤 화면을 확인해 줘');
    t.expect('AI 관찰이 저장된 비밀번호로 로그인 화면을 넘는다', /원장 조회 화면까지/.test(reply), reply.slice(0, 160));
    await t.shot('ai-observe', { note: 'AI 관찰 답' });
    const leaked = env.model.log.slice(n0).filter((e) => e.raw.includes(PW)).length + env.model.log.filter((e) => e.raw.includes(PW)).length;
    const files = await filesWith(env.ws, PW);
    t.expect('AI 에게 간 요청 본문에 비밀번호가 없다', leaked === 0, `요청 ${leaked}건`);
    t.expect('작업 폴더(레시피·대화·실행 기록)에 비밀번호 평문이 없다', files.length === 0, files.join(', '));
    t.outcome(`두 번째 실행: 비밀번호를 묻지 않고 로그인 (${r2?.status === 'done' ? '성공' : r2?.status})`);
    t.outcome(`AI 요청 ${env.model.log.length}건·작업 폴더에 비밀번호 ${leaked + files.length}건`);
    t.note(`가짜 모델이 받은 요청 ${env.model.log.length}건 중 비밀번호 포함 ${leaked}건`);
    void panelOf;
  },
};
