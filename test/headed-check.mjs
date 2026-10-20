// 화면 표시 모드 점검: 실제 사용과 같은 headed Edge 로 짧게 녹화하고, headed 로 1행 실행해 화면 캡처 기반 PDF 를 확인한다.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Recorder } from '../src/recorder/recorder.js';
import { Runner } from '../src/engine/runner.js';
import { startFixture } from './fixture-server.mjs';

const OUT = path.join(import.meta.dirname, 'out', 'headed');
await fs.rm(OUT, { recursive: true, force: true });
const fixture = await startFixture();
const url = `http://127.0.0.1:${fixture.address().port}/`;
const profileDir = path.join(OUT, 'profile');

const rec = new Recorder({ name: '화면 점검', startUrl: url, profileDir });
await rec.start();
const page = rec.ctx.pages()[0];
page.on('dialog', (d) => d.accept());
await page.getByLabel('상호').fill('가나상사');
await page.getByRole('button', { name: '선택' }).first().click();
await page.getByRole('button', { name: '인쇄' }).click();
await new Promise((r) => setTimeout(r, 300));
const recipe = await rec.stop();
console.log('녹화 스텝:', recipe.blocks.main.map((s) => s.type).join(', '));
assert.deepEqual(recipe.blocks.main.map((s) => s.type), ['navigate', 'input', 'click', 'click', 'pdf']);

const runner = new Runner({ recipe, runId: 'headed', runDir: path.join(OUT, 'run'), profileDir, options: { headless: false } });
runner.on('log', ({ line }) => console.log(line));
const report = await runner.start();
assert.equal(report.status, 'done');
const pdf = (await fs.readdir(path.join(OUT, 'run', 'files'))).find((f) => f.endsWith('.pdf'));
assert.ok(pdf, '화면 표시 모드에서도 PDF 가 저장돼야 한다');
fixture.close();
console.log('✅ 화면 표시 모드 점검 통과:', pdf);
