// 작업 폴더: recipes/ (레시피 JSON), runs/ (실행 결과), uploads/ (엑셀), profiles/ (브라우저 프로필), trash/

import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { excelColumnsOf } from './recipe.js';
import { safeFileName } from './engine/naming.js';

const SAFE_ID = /^[\w-]{1,80}$/;

export class Store {
  constructor(root) {
    this.root = root;
    this.dirs = {
      recipes: path.join(root, 'recipes'),
      runs: path.join(root, 'runs'),
      uploads: path.join(root, 'uploads'),
      trash: path.join(root, 'trash'),
      profile: path.join(root, 'profiles', 'default'),
    };
    for (const d of Object.values(this.dirs)) fssync.mkdirSync(d, { recursive: true });
  }

  checkId(id) {
    if (!SAFE_ID.test(String(id))) throw Object.assign(new Error('잘못된 id 입니다.'), { status: 400 });
    return id;
  }

  async listRecipes() {
    const out = [];
    for (const f of await fs.readdir(this.dirs.recipes)) {
      if (!f.endsWith('.json')) continue;
      try {
        const r = JSON.parse(await fs.readFile(path.join(this.dirs.recipes, f), 'utf8'));
        out.push({
          id: r.id,
          name: r.name,
          startUrl: r.startUrl,
          steps: Object.values(r.blocks ?? {}).reduce((n, s) => n + s.length, 0),
          excelColumns: excelColumnsOf(r),
          updatedAt: r.updatedAt,
        });
      } catch {
        /* 깨진 파일은 목록에서 뺀다 */
      }
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async getRecipe(id) {
    this.checkId(id);
    try {
      return JSON.parse(await fs.readFile(path.join(this.dirs.recipes, `${id}.json`), 'utf8'));
    } catch {
      throw Object.assign(new Error('레시피를 찾을 수 없습니다.'), { status: 404 });
    }
  }

  async saveRecipe(recipe) {
    if (!recipe.id) recipe.id = crypto.randomUUID();
    this.checkId(recipe.id);
    recipe.updatedAt = new Date().toISOString();
    recipe.createdAt ??= recipe.updatedAt;
    const file = path.join(this.dirs.recipes, `${recipe.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(recipe, null, 2));
    await fs.rename(tmp, file); // 원자적 교체
    return recipe;
  }

  async deleteRecipe(id) {
    this.checkId(id);
    const file = path.join(this.dirs.recipes, `${id}.json`);
    await fs.rename(file, path.join(this.dirs.trash, `${id}-${Date.now()}.json`)); // 바로 지우지 않고 trash 로
  }

  newRunId(recipeName) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
  }

  runDir(runId) {
    this.checkId(runId);
    return path.join(this.dirs.runs, runId);
  }

  async listRuns() {
    const out = [];
    for (const id of await fs.readdir(this.dirs.runs)) {
      try {
        const r = JSON.parse(await fs.readFile(path.join(this.dirs.runs, id, 'report.json'), 'utf8'));
        out.push({ runId: r.runId, recipe: r.recipe, status: r.status, startedAt: r.startedAt, durationMs: r.durationMs, totals: r.totals, error: r.error });
      } catch {
        /* 진행 중이거나 깨진 기록 */
      }
    }
    return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  }

  async getRun(runId) {
    const dir = this.runDir(runId);
    try {
      const report = JSON.parse(await fs.readFile(path.join(dir, 'report.json'), 'utf8'));
      const log = await fs.readFile(path.join(dir, 'log.txt'), 'utf8').catch(() => '');
      // 실행 화면 영상 (탭마다 하나, 열린 순서)
      const names = (await fs.readdir(path.join(dir, 'video')).catch(() => [])).filter((f) => f.endsWith('.webm'));
      const stats = await Promise.all(names.map((f) => fs.stat(path.join(dir, 'video', f))));
      const videos = names.map((f, i) => ({ path: `video/${f}`, at: stats[i].birthtimeMs, size: stats[i].size })).sort((a, b) => a.at - b.at).map(({ path: p, size }) => ({ path: p, size }));
      return { ...report, log, videos };
    } catch {
      throw Object.assign(new Error('실행 기록을 찾을 수 없습니다.'), { status: 404 });
    }
  }

  /** 실행 폴더 안의 파일만 돌려준다 (경로 탈출 차단). */
  runFile(runId, rel) {
    const dir = this.runDir(runId);
    const full = path.resolve(dir, String(rel));
    if (!full.startsWith(dir + path.sep)) throw Object.assign(new Error('잘못된 경로입니다.'), { status: 400 });
    return full;
  }

  async deleteRun(runId) {
    await fs.rm(this.runDir(runId), { recursive: true, force: true });
  }

  async saveUpload(name, buf) {
    const ext = path.extname(name).toLowerCase();
    if (!['.xlsx', '.csv', '.xls'].includes(ext)) throw Object.assign(new Error('xlsx 또는 csv 파일만 올릴 수 있습니다.'), { status: 400 });
    const id = `${Date.now()}-${safeFileName(path.basename(name))}`.replace(/[^\w.\-가-힣() ]/g, '_');
    await fs.writeFile(path.join(this.dirs.uploads, id), buf);
    return id;
  }

  uploadPath(id) {
    const full = path.resolve(this.dirs.uploads, String(id));
    if (!full.startsWith(this.dirs.uploads + path.sep) || !fssync.existsSync(full)) throw Object.assign(new Error('올린 파일을 찾을 수 없습니다.'), { status: 404 });
    return full;
  }
}
