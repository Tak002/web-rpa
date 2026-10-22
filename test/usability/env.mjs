// 평가 환경: 시험 사이트 2개(실험실·반복 표), 가짜 OpenRouter, 앱 서버(임시 작업 폴더). 포트 4960–4979.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startLab } from '../lab-server.mjs';
import { startLoopSite } from '../loop-fixture/server.mjs';
import { startFakeModel } from './fake-model.mjs';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const PORTS = { app: 4960, lab: 4961, loop: 4962, model: 4963, realApp: 4964 };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, ms = 15000, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(step);
  }
  return null;
}

export class Env {
  constructor({ workspace, real = false } = {}) {
    this.ws = workspace ?? path.join(os.tmpdir(), 'web-rpa-usability', real ? 'ws-real' : 'ws');
    this.real = real;
    this.port = real ? PORTS.realApp : PORTS.app;
    this.base = `http://127.0.0.1:${this.port}`;
    this.serverLog = '';
    this.server = null;
  }

  async start() {
    await fs.rm(this.ws, { recursive: true, force: true });
    await fs.mkdir(this.ws, { recursive: true });
    this.lab = await startLab(PORTS.lab);
    this.labBase = `http://127.0.0.1:${PORTS.lab}`;
    this.loop = await startLoopSite([PORTS.loop]);
    this.loopBase = this.loop.base;
    this.model = await startFakeModel(PORTS.model);
    await this.startServer();
  }

  async startServer() {
    const env = { ...process.env };
    if (!this.real) {
      env.OPENROUTER_BASE_URL = this.model.url;
      env.OPENROUTER_API_KEY = '';
    }
    this.server = spawn(process.execPath, ['src/server.js', '--port', String(this.port), '--workspace', this.ws], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env });
    this.server.stdout.on('data', (d) => (this.serverLog += d));
    this.server.stderr.on('data', (d) => (this.serverLog += d));
    for (let i = 0; i < 150; i += 1) {
      try {
        await fetch(`${this.base}/api/state`);
        return;
      } catch {
        await sleep(100);
      }
    }
    throw new Error(`앱 서버가 뜨지 않았습니다:\n${this.serverLog.slice(-2000)}`);
  }

  async stopServer() {
    if (!this.server || this.server.exitCode !== null) return;
    const p = this.server;
    p.kill();
    await once(p, 'exit').catch(() => {});
  }

  async restartServer() {
    await this.stopServer();
    await this.startServer();
  }

  async stop() {
    await this.stopServer();
    await new Promise((r) => this.lab?.close(() => r()));
    await this.loop?.close();
    await this.model?.close();
  }

  async api(method, url, body) {
    const res = await fetch(this.base + url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data?.error ?? ''}`);
    return data;
  }

  /** 실행을 API 로 시작하고 끝날 때까지 기다린다 → 리포트 */
  async runViaApi(recipeId, { params = {}, uploadId, saveSecrets } = {}) {
    const prev = (await this.api('GET', '/api/state')).run?.runId;
    const { runId } = await this.api('POST', '/api/runs', { recipeId, params, uploadId, options: { headless: true }, ...(saveSecrets ? { saveSecrets } : {}) });
    const st = await until(async () => {
      const s = await this.api('GET', '/api/state');
      return s.run && s.run.runId === runId && ['done', 'failed', 'stopped'].includes(s.run.status) ? s.run : null;
    }, 120000, 500);
    if (!st) throw new Error(`실행이 끝나지 않았습니다 (${runId}, 이전 ${prev})`);
    return this.api('GET', `/api/runs/${runId}`);
  }

  async waitRunDone(afterRunId, ms = 120000) {
    const st = await until(async () => {
      const s = await this.api('GET', '/api/state');
      return s.run && s.run.runId !== afterRunId && ['done', 'failed', 'stopped'].includes(s.run.status) ? s.run : null;
    }, ms, 500);
    return st ? this.api('GET', `/api/runs/${st.runId}`) : null;
  }

  async lastRunId() {
    return (await this.api('GET', '/api/state')).run?.runId ?? null;
  }

  /** 엑셀(csv) 올리기 → upload 정보 */
  async upload(file) {
    const buf = await fs.readFile(file);
    const res = await fetch(`${this.base}/api/uploads?name=${encodeURIComponent(path.basename(file))}`, { method: 'POST', body: buf });
    return res.json();
  }
}
