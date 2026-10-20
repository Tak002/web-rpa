// 앱 설정 (workspace/settings.json). API 키는 화면으로 돌려보내지 않는다.

import fs from 'node:fs';
import path from 'node:path';
import { BROWSERS, detectBrowsers, profileNameFor } from './browser.js';

export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5.5';
export const MODEL_CHOICES = [
  { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5 (권장 · 입력 $2/M, 출력 $10/M)' },
  { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5 (저렴 · 입력 $0.1/M, 출력 $0.5/M)' },
  { id: 'anthropic/claude-opus-5.5', label: 'Claude Opus 5.5 (고성능 · 입력 $4/M, 출력 $20/M)' },
];

export class Settings {
  constructor(root) {
    this.file = path.join(root, 'settings.json');
    this.data = {};
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  get openrouter() {
    const o = this.data.openrouter ?? {};
    return {
      apiKey: o.apiKey || process.env.OPENROUTER_API_KEY || '',
      model: o.model || DEFAULT_MODEL,
      baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1', // 테스트에서 가짜 서버로 바꾼다
      fromEnv: !o.apiKey && !!process.env.OPENROUTER_API_KEY,
    };
  }

  /** 녹화·실행·AI 관찰에 쓸 브라우저 {id, path?} */
  get browser() {
    const b = this.data.browser ?? {};
    return { id: b.id || 'auto', ...(b.id === 'custom' ? { path: b.path || '' } : {}) };
  }

  /** 화면에 보낼 공개 정보 (키는 끝 4자리만). */
  publicView() {
    const o = this.openrouter;
    const b = this.browser;
    return {
      openrouter: { hasKey: !!o.apiKey, keyHint: o.apiKey ? `…${o.apiKey.slice(-4)}` : '', fromEnv: o.fromEnv, model: o.model, models: MODEL_CHOICES },
      browser: { id: b.id, path: this.data.browser?.path ?? '', profile: profileNameFor(b.id), choices: detectBrowsers() },
    };
  }

  update(patch) {
    if (patch?.browser) {
      const id = String(patch.browser.id ?? '');
      if (!BROWSERS.some((b) => b.id === id)) throw Object.assign(new Error(`알 수 없는 브라우저: ${id}`), { status: 400 });
      const p = String(patch.browser.path ?? '').trim().replace(/^"(.*)"$/, '$1');
      if (id === 'custom' && !fs.existsSync(p)) throw Object.assign(new Error(`실행 파일이 없습니다: ${p || '(비어 있음)'}`), { status: 400 });
      this.data.browser = id === 'custom' ? { id, path: p } : { id, ...(this.data.browser?.path ? { path: this.data.browser.path } : {}) };
    }
    const o = { ...(this.data.openrouter ?? {}) };
    if (patch?.openrouter) {
      if (typeof patch.openrouter.apiKey === 'string') {
        const k = patch.openrouter.apiKey.trim();
        if (k) o.apiKey = k;
        else delete o.apiKey; // 빈 값 = 지우기
      }
      if (typeof patch.openrouter.model === 'string' && patch.openrouter.model.trim()) o.model = patch.openrouter.model.trim();
    }
    this.data.openrouter = o;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    return this.publicView();
  }
}
