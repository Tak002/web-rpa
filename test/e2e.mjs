// 녹화 → 엑셀 연결 → 엑셀 3행 재생 → 리포트 검증 (실제 브라우저, 숨김 모드).
// 실행: node test/e2e.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { Recorder } from '../src/recorder/recorder.js';
import { Runner } from '../src/engine/runner.js';
import { autoLinkExcel, recipeProblems, excelColumnsOf } from '../src/recipe.js';
import { stepText } from '../public/shared/steps.js';
import { startFixture } from './fixture-server.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });
  const server = await startFixture();
  const base = `http://127.0.0.1:${server.address().port}`;
  const profileDir = path.join(OUT, 'profile');

  // ---------- 1. 녹화 ----------
  const rec = new Recorder({ name: '테스트 조회', startUrl: `${base}/`, profileDir, headless: true });
  await rec.start();
  const page = rec.ctx.pages()[0];
  page.on('dialog', (d) => d.accept()); // 사람 대신 확인을 누른다
  await page.waitForSelector('text=거래처 조회');

  await page.getByLabel('사업자번호').fill('1234567890');
  await page.getByLabel('상호').fill('가나상사');
  await page.getByLabel('기간').selectOption({ label: '1기 (예정+확정)' });
  await page.getByLabel('상세 포함').check();
  await page.getByRole('button', { name: '조회' }).click();
  await page.waitForSelector('text=조회결과');
  await page.getByRole('button', { name: '선택' }).nth(1).click(); // 같은 문구 버튼 중 두 번째
  await page.frameLocator('iframe[name=inner]').getByRole('button', { name: '프레임 버튼' }).click();
  const [popup] = await Promise.all([rec.ctx.waitForEvent('page'), page.getByText('상세 보기').click()]);
  await popup.waitForLoadState();
  await popup.getByRole('button', { name: '닫기' }).click();
  await sleep(300);
  // 다운로드: 링크로 바로 받기 + 새 창에서 늦게 시작되는 다운로드
  await Promise.all([page.waitForEvent('download'), page.getByText('자료 받기').click()]);
  await Promise.all([page.waitForEvent('popup').then((p) => p.waitForEvent('download')), page.getByRole('button', { name: '새 창으로 받기' }).click()]);
  await sleep(500);
  await page.getByRole('button', { name: '인쇄' }).click();
  await sleep(300);
  const recipe = await rec.stop();

  console.log('\n[녹화된 스텝]');
  recipe.blocks.main.forEach((s, i) => console.log(`${String(i + 1).padStart(2)}. ${stepText(s)}`));
  const types = recipe.blocks.main.map((s) => s.type);
  // 팝업 "닫기" 클릭은 창이 바로 닫혀 유실될 수 있다 → closeTab 이 반드시 있어야 한다.
  // 다운로드용 빈 팝업은 브라우저가 스스로 닫을 수도 있어(closeTab) 비교에서 뺀다.
  const core = types.filter((t, i) => !(t === 'click' && types[i + 1] === 'closeTab' && recipe.blocks.main[i].meta.pageId !== 1)).filter((t, i, a) => !(t === 'closeTab' && a[i - 1] === 'download'));
  assert.deepEqual(core, ['navigate', 'input', 'input', 'select', 'check', 'dialog', 'click', 'click', 'click', 'click', 'closeTab', 'download', 'download', 'click', 'pdf']);
  const dialogStep = recipe.blocks.main[5];
  assert.equal(dialogStep.action, 'accept');
  assert.equal(dialogStep.meta.triggerStepId, recipe.blocks.main[6].id, '대화상자 스텝은 원인 클릭 앞에 와야 한다');
  const bizStep = recipe.blocks.main[1];
  const best = [...bizStep.target.candidates].sort((a, b) => b.score - a.score)[0];
  assert.ok(!(typeof best.value === 'string' && /#bizno_\d+$/.test(best.value)), '매번 바뀌는 id 를 그대로 쓴 후보가 첫 순위면 안 된다');
  const frameStep = recipe.blocks.main[8];
  assert.equal(frameStep.target.framePath.length, 1, 'iframe 안 클릭은 framePath 를 가져야 한다');

  // ---------- 2. 엑셀 연결 + 값 읽기 스텝 추가 ----------
  const headers = ['사업자번호', '상호', '기간'];
  const { recipe: linked, linked: links } = autoLinkExcel(recipe, headers, { 사업자번호: '1234567890', 상호: '가나상사', 기간: '1기 (예정+확정)' });
  assert.equal(links.length, 3, `엑셀 자동 연결 3건 기대: ${JSON.stringify(links)}`);
  const resultTarget = { framePath: [], candidates: [{ kind: 'css', value: 'span[id^="result-"]', score: 50 }], meta: { tag: 'span' } };
  const clickIdx = linked.blocks.main.findIndex((s) => s.id === recipe.blocks.main[6].id);
  linked.blocks.main.splice(clickIdx + 1, 0, { id: 'x1', type: 'extract', target: resultTarget, saveAs: '조회결과' });
  linked.blocks.main.find((s) => s.type === 'pdf').fileName = '{{상호}}_{{sys:date:YYYYMMDD}}.pdf';
  assert.deepEqual(recipeProblems(linked), []);
  assert.deepEqual(excelColumnsOf(linked), ['사업자번호', '상호', '기간']);
  await fs.writeFile(path.join(OUT, 'recipe.json'), JSON.stringify(linked, null, 2));

  // ---------- 3. 엑셀 3행 (2행은 사업자번호 비움 → 알림창 → 실패 행) ----------
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('입력');
  ws.addRow(headers);
  ws.addRow(['0123456789', '다라상사', '2기 (예정+확정)']); // 앞자리 0 보존 확인
  ws.addRow(['', '빈번호상사', '1기 (예정+확정)']);
  ws.addRow(['5558887777', '마바상사', '1기(예정+확정)']); // 띄어쓰기 다른 옵션
  const excelPath = path.join(OUT, 'input.xlsx');
  await wb.xlsx.writeFile(excelPath);

  // ---------- 4. 재생 ----------
  const runDir = path.join(OUT, 'run');
  const runner = new Runner({ recipe: linked, runId: 'test', runDir, profileDir, excelPath, options: { headless: true } });
  runner.on('log', ({ line }) => console.log(line));
  const report = await runner.start();

  console.log('\n[결과]', report.status, report.totals);
  assert.equal(report.totals.rows, 3);
  assert.equal(report.totals.ok, 2, '1·3행 성공 기대');
  assert.equal(report.rows[1].status, 'failed', '2행은 사업자번호가 비어 실패해야 한다');
  assert.equal(report.status, 'failed', '실패 행이 있으면 전체 상태는 failed');
  assert.equal(report.rows[0].values['조회결과'], '조회결과: 다라상사 (0123456789) P2 상세');
  assert.equal(report.rows[2].values['조회결과'], '조회결과: 마바상사 (5558887777) P1 상세');
  const saved = await fs.readdir(path.join(runDir, 'files'));
  console.log('[저장 파일]', saved.join(', '));
  const pdfs = saved.filter((f) => f.endsWith('.pdf'));
  assert.equal(pdfs.length, 2, `PDF 2개 기대: ${pdfs}`);
  assert.equal(saved.filter((f) => /^data( \(\d+\))?\.txt$/.test(f)).length, 2, '링크 다운로드는 행마다 원래 이름으로, 겹치면 (n) 을 붙여 저장');
  assert.ok(saved.includes('report_0123456789.csv') && saved.includes('report_5558887777.csv'), '새 창에서 시작된 다운로드도 저장');
  assert.ok(pdfs.some((f) => f.startsWith('다라상사_')));
  for (const f of ['report.json', 'rows.csv', 'log.txt', 'results.xlsx', 'failures/row-2.png']) await fs.access(path.join(runDir, f));
  const okDurations = report.rows.filter((r) => r.status === 'ok').map((r) => r.durationMs);
  assert.ok(okDurations.every((d) => d < 9000), `성공 행이 9초 안에 끝나야 한다 (탭 전환 대기 없음): ${okDurations}`);
  assert.ok(!(await fs.readFile(path.join(runDir, 'log.txt'), 'utf8')).includes('다른 탭에 있어'), '팝업 닫기 후 탭 재탐색이 없어야 한다');

  server.close();
  console.log('\n✅ e2e 통과');
}

main().catch((e) => {
  console.error('\n❌ e2e 실패:', e);
  process.exit(1);
});
