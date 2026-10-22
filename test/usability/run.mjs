// web-rpa 사용성 평가 (처음 쓰는 사무직 사용자 관점): 과제 T1–T10 을 사람처럼 수행하며 녹화·캡처·기록한다.
// 실행: node test/usability/run.mjs [--round 2] [--only T1,T5] [--out <폴더>] [--prepare-only]
//   기본 출력: %TEMP%\web-rpa-usability\round-<round>\ (round 기본 3). 보고서 폴더에 남기려면 --out 으로 지정한다.
//   앱 4960 · 실험실 4961 · 반복 표 4962 · 가짜 OpenRouter 4963 (실제 모델 재평가는 앱 4964)
//   작업 폴더: %TEMP%\web-rpa-usability\ws (시작할 때 비운다). test/out* 은 쓰지 않는다.
//   산출: <out>/results.json, <out>/videos/T*.mp4, <out>/shots/*.png, <out>/model-log.json
//   OPENROUTER_API_KEY 가 있으면 T1·T5·T8 을 실제 모델로 한 번 더 한다 (<out>/real/).

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { Env, ROOT } from './env.mjs';
import { Task } from './human.mjs';
import { recordLab, recordLoop, withExcel, secretVarOf, loopRowsRecipe, pagesRecipe, longRecipe, writeCsv, oldStyleLoop } from './recipes.mjs';
import { TASKS } from './scenarios/index.mjs';

const args = process.argv.slice(2);
const argOf = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const ROUND = argOf('--round', '3');
const OUT = path.resolve(argOf('--out', path.join(os.tmpdir(), 'web-rpa-usability', `round-${ROUND}`)));
const ONLY = argOf('--only', '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

/** 과제마다 쓸 레시피·실행·엑셀 */
async function prepare(env, out = OUT) {
  const fx = { files: path.join(env.ws, 'files') };
  await fs.mkdir(fx.files, { recursive: true });
  console.log('[준비] 실험실 녹화 (로그인 → 원장 조회 → 엑셀 다운로드)');
  const lab = await recordLab(env);
  fx.labRecorded = lab;
  const save = async (r) => (await env.api('POST', '/api/recipes', r)).recipe;
  const copy = (name) => ({ ...structuredClone(lab), id: undefined, name });
  fx.t2 = await save(copy('원장 조회 — 비밀번호 저장'));
  fx.t3 = await save(copy('원장 조회 — 입력값 정리'));
  const t4 = withExcel(lab, '원장 조회 — 변수 정리');
  t4.variables.push({ id: '메모', name: '메모', source: { kind: 'excel', column: '메모' } });
  fx.t4 = await save(t4);
  fx.t1 = await save(withExcel(lab, '원장 조회 — AI 대화'));
  fx.t8 = await save(withExcel(lab, '원장 조회 — 실패 행'));
  const pw = secretVarOf(lab);
  fx.secretVar = pw;
  fx.csvGood = await writeCsv(path.join(fx.files, '거래처.csv'), [
    ['사업자번호', '기간'],
    ['1234567890', '2026년 1기 (1~6월)'],
    ['2223334445', '2026년 2기 (7~12월)'],
  ]);
  fx.csvBad = await writeCsv(path.join(fx.files, '거래처_오류.csv'), [
    ['사업자번호', '기간'],
    ['1234567890', '2026년 1기 (1~6월)'],
    ['5556667778', '2026년 3기'],
  ]);
  console.log('[준비] T1·T8 실행 기록 (API, 숨김)');
  const params = { [pw.id]: 'lab-pass-123' };
  const up1 = await env.upload(fx.csvGood);
  fx.t1Run = await env.runViaApi(fx.t1.id, { params, uploadId: up1.id });
  const up8 = await env.upload(fx.csvBad);
  fx.t8Run = await env.runViaApi(fx.t8.id, { params, uploadId: up8.id });
  console.log(`  T1 실행 ${fx.t1Run.status} (${fx.t1Run.totals.ok}/${fx.t1Run.totals.rows}) · T8 실행 ${fx.t8Run.status} (실패 ${fx.t8Run.totals.failed})`);
  console.log('[준비] 반복 표 녹화 (금액 칸 클릭 → 다음)');
  const loop = await recordLoop(env);
  fx.t5 = await save({ ...loop, name: '거래처 금액 읽기' });
  fx.t5ai = await save({ ...structuredClone(loop), name: '거래처 금액 읽기 (AI)' });
  fx.t5old = await save(oldStyleLoop(loop, '거래처 금액 읽기 (1회차 방식)'));
  fx.t6 = await save(loopRowsRecipe(env));
  fx.t7 = await save(pagesRecipe(env));
  fx.t9 = await save(longRecipe(env));
  fx.t10 = fx.t8;
  fx.t10Run = fx.t8Run;
  await fs.writeFile(path.join(out, 'fixtures.json'), JSON.stringify({ lab, loop, ids: Object.fromEntries(Object.entries(fx).filter(([, v]) => v?.id).map(([k, v]) => [k, v.id])) }, null, 2));
  return fx;
}

/** 한 바퀴: 환경을 띄우고 레시피를 준비한 뒤 과제들을 사람처럼 수행한다 */
async function pass({ real = false, out, only }) {
  await fs.mkdir(path.join(out, 'shots'), { recursive: true });
  await fs.mkdir(path.join(out, 'videos'), { recursive: true });
  const env = new Env({ real });
  await env.start();
  console.log(`앱 ${env.base} · 작업 폴더 ${env.ws}${real ? ' · 실제 OpenRouter 모델' : ' · 가짜 OpenRouter'}`);
  let browser = null;
  const results = [];
  try {
    if (!real) await env.api('PUT', '/api/settings', { openrouter: { apiKey: 'sk-or-usability-0000', model: 'anthropic/claude-sonnet-5.5' } });
    const fx = await prepare(env, out);
    if (args.includes('--prepare-only')) return results;
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    for (const t of TASKS) {
      if (only.length && !only.includes(t.id)) continue;
      console.log(`\n== ${t.id} ${t.title}${real ? ' (실제 모델)' : ''}`);
      const task = new Task(browser, { id: t.id, title: `${t.title}${real ? ' (실제 모델)' : ''}`, flow: t.flow, outDir: out, env, viewport: t.viewport, mobile: t.mobile });
      task.realModel = real;
      await task.open();
      try {
        let timer;
        await Promise.race([t.run(task, { env, fx, base: env.base, real }), new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('과제가 8분 안에 끝나지 않았습니다')), 8 * 60_000)))]).finally(() => clearTimeout(timer));
      } catch (e) {
        task.note(`과제 중단: ${String(e.message).split(/\n/)[0]}`);
        task.expect('과제를 끝까지 수행', false, e.message);
        await task.shot('stuck').catch(() => {});
      }
      await task.finale().catch(() => {}); // 끝 장면: 결과 카드 2초
      const r = await task.close();
      results.push(r);
      console.log(`  → ${r.status} · ${r.seconds}초 · 클릭 ${r.clicks} · 헤맴 ${r.wanders.length} · 콘솔 오류 ${r.consoleErrors.length}`);
      for (const c of r.checks) console.log(`     ${c.ok ? '✅' : '❌'} ${c.name}${c.ok ? '' : ` — ${c.detail}`}`);
      await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
    }
    // 가짜 모델이 받은 요청 (요약만 — 비밀값 검사는 T2 가 원문으로 했다)
    if (!real)
      await fs.writeFile(
        path.join(out, 'model-log.json'),
        JSON.stringify(env.model.log.map((e) => ({ at: e.at, request: e.request, tools: e.tools, calls: e.calls, reply: e.reply?.slice(0, 300), context: e.user.slice(0, 1500) })), null, 2),
      );
  } finally {
    await browser?.close().catch(() => {});
    await env.stop();
    await fs.rm(path.join(out, 'videos', 'raw'), { recursive: true, force: true }).catch(() => {});
  }
  const ok = results.filter((r) => r.status === '성공').length;
  console.log(`\n사용성 평가${real ? ' (실제 모델)' : ''}: 과제 성공 ${ok}/${results.length} — ${path.join(out, 'results.json')}`);
  return results;
}

async function main() {
  await pass({ out: OUT, only: ONLY });
  // 실제 모델 재평가 (키가 있을 때만): T1·T5·T8 — 말귀까지 본다
  const realOnly = ['T1', 'T5', 'T8'].filter((id) => !ONLY.length || ONLY.includes(id));
  if (!process.env.OPENROUTER_API_KEY) {
    console.log('\n실제 모델 재평가: OPENROUTER_API_KEY 가 없어 건너뜁니다 (가짜 모델 화면·연결 평가만).');
    await fs.writeFile(path.join(OUT, 'real-model.txt'), 'OPENROUTER_API_KEY 가 없어 실제 모델 재평가(T1·T5·T8)를 건너뛰었다.\n', 'utf8');
  } else if (realOnly.length && !args.includes('--prepare-only')) await pass({ real: true, out: path.join(OUT, 'real'), only: realOnly });
}

main().catch((e) => {
  console.error('\n❌ 사용성 평가 중단:', e);
  process.exit(1);
});
void ROOT;
