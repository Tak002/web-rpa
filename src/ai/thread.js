// AI 대화 저장 (레시피 단위): <작업폴더>/ai/<recipeId>/thread.json (모델 대화·화면 표시·대기 제안·지난 AI 턴의 레시피),
// notes.md (레시피 메모 — 사람이 보고 고친다), <작업폴더>/ai/metrics.jsonl (턴마다 시간·비용).
// 비밀값은 저장 전에 가린다. 30일 넘게 쓰지 않은 대화는 서버 시작 때 지운다(메모는 남긴다).

import fs from 'node:fs';
import path from 'node:path';

export const KEEP_DAYS = 30;
const MAX_DISPLAY = 300;
const MAX_NOTES = 20_000;
const SAFE_ID = /^[\w-]{1,80}$/;

const now = () => new Date().toISOString();
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

export function emptyThread(recipeId) {
  const at = now();
  return { version: 1, recipeId, createdAt: at, updatedAt: at, seq: 0, messages: [], display: [], pending: null, lastSeen: null, usage: { prompt: 0, completion: 0, cost: 0 } };
}

/** 이미지(실패 화면)는 파일에 남기지 않는다 */
function withoutImages(messages) {
  return messages.map((m) =>
    Array.isArray(m.content) && m.content.some((p) => p?.type === 'image_url')
      ? { ...m, content: m.content.filter((p) => p?.type !== 'image_url').map((p) => p.text ?? '').join('\n') + '\n(첨부 이미지는 저장하지 않았습니다)' }
      : m,
  );
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export class ThreadStore {
  constructor(root) {
    this.dir = path.join(root, 'ai');
    fs.mkdirSync(this.dir, { recursive: true });
    this.cache = new Map(); // recipeId → thread
  }

  checkId(recipeId) {
    if (!SAFE_ID.test(String(recipeId ?? ''))) throw bad('잘못된 레시피 id 입니다.');
    return String(recipeId);
  }

  dirOf(recipeId) {
    return path.join(this.dir, this.checkId(recipeId));
  }

  load(recipeId) {
    const id = this.checkId(recipeId);
    if (this.cache.has(id)) return this.cache.get(id);
    let t;
    try {
      t = JSON.parse(fs.readFileSync(path.join(this.dirOf(id), 'thread.json'), 'utf8'));
      if (!t || !Array.isArray(t.messages) || !Array.isArray(t.display)) t = null;
    } catch {
      t = null;
    }
    const thread = t ? { ...emptyThread(id), ...t, recipeId: id } : emptyThread(id);
    this.cache.set(id, thread);
    return thread;
  }

  /** @param {{text: (s: string) => string}} [redactor] */
  save(thread, redactor) {
    thread.updatedAt = now();
    if (thread.display.length > MAX_DISPLAY) thread.display.splice(0, thread.display.length - MAX_DISPLAY);
    let text = JSON.stringify({ ...thread, messages: withoutImages(thread.messages) }, null, 1);
    if (redactor) text = redactor.text(text);
    writeAtomic(path.join(this.dirOf(thread.recipeId), 'thread.json'), text);
  }

  /** 대화·대기 제안(과 시험 실행 파일)을 지운다 (메모는 남긴다) */
  clear(recipeId) {
    const id = this.checkId(recipeId);
    this.cache.delete(id);
    fs.rmSync(path.join(this.dirOf(id), 'thread.json'), { force: true });
    fs.rmSync(path.join(this.dirOf(id), 'sample'), { recursive: true, force: true });
  }

  exists(recipeId) {
    try {
      return this.cache.has(this.checkId(recipeId)) || fs.existsSync(path.join(this.dirOf(recipeId), 'thread.json'));
    } catch {
      return false;
    }
  }

  addDisplay(thread, entry) {
    thread.seq = (thread.seq ?? 0) + 1;
    const e = { id: `m${thread.seq}`, at: now(), ...entry };
    thread.display.push(e);
    return e;
  }

  // ---------- 메모 ----------
  notes(recipeId) {
    try {
      return fs.readFileSync(path.join(this.dirOf(recipeId), 'notes.md'), 'utf8');
    } catch {
      return '';
    }
  }

  setNotes(recipeId, text) {
    const t = String(text ?? '').replace(/\r\n/g, '\n');
    if (t.length > MAX_NOTES) throw bad(`메모가 너무 깁니다 (${MAX_NOTES}자까지).`);
    writeAtomic(path.join(this.dirOf(recipeId), 'notes.md'), t);
    return t;
  }

  /** 한 줄을 덧붙인다 (AI 의 remember) */
  appendNote(recipeId, line) {
    const one = String(line ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!one) throw bad('남길 메모가 비어 있습니다.');
    const cur = this.notes(recipeId);
    if (cur.split('\n').some((l) => l.replace(/^-\s*/, '').trim() === one)) return cur;
    return this.setNotes(recipeId, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}- ${one}\n`);
  }

  // ---------- 지표 ----------
  metric(entry) {
    try {
      fs.appendFileSync(path.join(this.dir, 'metrics.jsonl'), `${JSON.stringify(entry)}\n`);
    } catch {
      /* 지표 실패는 무시 */
    }
  }

  /** 오래된 대화 정리. 지운 수를 돌려준다. */
  cleanup(days = KEEP_DAYS) {
    const limit = Date.now() - days * 86400_000;
    let n = 0;
    for (const id of fs.readdirSync(this.dir)) {
      const file = path.join(this.dir, id, 'thread.json');
      try {
        const t = JSON.parse(fs.readFileSync(file, 'utf8'));
        const at = Date.parse(t.updatedAt) || fs.statSync(file).mtimeMs;
        if (at < limit) {
          this.clear(id);
          n += 1;
        }
      } catch {
        /* 폴더가 아니거나 thread 가 없다 */
      }
    }
    return n;
  }

  /** GET /api/agent/thread 응답 */
  view(thread, { running = false } = {}) {
    const p = thread.pending;
    return {
      recipeId: thread.recipeId,
      running,
      display: thread.display,
      pending: p ? { recipe: p.recipe, changes: p.changes, problems: p.problems ?? [] } : null,
      notes: this.notes(thread.recipeId),
      usage: thread.usage,
    };
  }
}
