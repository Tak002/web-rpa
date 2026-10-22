// 비밀값 저장소 (workspace/secrets.json): Windows DPAPI(현재 사용자 범위)로 암호화해 레시피 밖에 둔다.
// 값은 PowerShell 의 표준 입력으로만 넘긴다(명령줄에 비밀값을 두지 않는다). Windows 가 아니면 저장 기능만 끈다.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { TOKEN_RE, parseToken } from './engine/vars.js';

const SAFE_ID = /^[\w-]{1,80}$/;
const MAX_VALUE = 4096;

// 표준 입력 { op, items: [base64] } → 표준 출력 JSON [base64]
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$req = [Console]::In.ReadToEnd() | ConvertFrom-Json
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
$out = foreach ($x in @($req.items)) {
  $b = [Convert]::FromBase64String($x)
  if ($req.op -eq 'protect') { $r = [System.Security.Cryptography.ProtectedData]::Protect($b, $null, $scope) }
  else { $r = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, $scope) }
  [Convert]::ToBase64String($r)
}
[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @($out)))
`;
const ENCODED = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');

const err = (message, status = 400) => Object.assign(new Error(message), { status });

/** DPAPI 일괄 처리 (한 번의 PowerShell 호출) */
function dpapi(op, items) {
  if (!items.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const exe = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
    const p = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let errText = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (errText += d));
    p.on('error', (e) => reject(err(`비밀값 암호화 도구(PowerShell)를 실행하지 못했습니다: ${e.message}`, 500)));
    p.on('close', (code) => {
      if (code !== 0) return reject(err(`비밀값을 ${op === 'protect' ? '암호화' : '풀'}하지 못했습니다. 다른 Windows 계정·PC 에서 저장한 값이면 다시 입력해 주세요.`, 500));
      try {
        const list = JSON.parse(out || '[]');
        resolve(Array.isArray(list) ? list : [list]);
      } catch {
        reject(err('비밀값 암호화 결과를 읽지 못했습니다.', 500));
      }
    });
    p.stdin.end(JSON.stringify({ op, items }));
  });
}

export class SecretStore {
  constructor(root, { platform = process.platform } = {}) {
    this.file = path.join(root, 'secrets.json');
    this.available = platform === 'win32';
    this.cache = new Map(); // "recipeId/varId" → 평문 (서버 메모리에만)
  }

  get unavailableReason() {
    return this.available ? null : '비밀값 저장은 Windows 에서만 됩니다 (Windows 계정으로 암호화합니다). 실행할 때마다 입력해 주세요.';
  }

  read() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return d && typeof d.items === 'object' && d.items ? { version: 1, items: d.items } : { version: 1, items: {} };
    } catch {
      return { version: 1, items: {} };
    }
  }

  write(data) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  key(recipeId, varId) {
    if (!SAFE_ID.test(String(recipeId))) throw err('잘못된 레시피 id 입니다.');
    const v = String(varId ?? '').trim();
    if (!v || v.length > 80 || v.includes('/')) throw err('잘못된 변수 이름입니다.');
    return `${recipeId}/${v}`;
  }

  /** { varId: savedAt } */
  savedOf(recipeId) {
    const out = {};
    const prefix = `${recipeId}/`;
    for (const [k, v] of Object.entries(this.read().items)) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v?.savedAt ?? null;
    return out;
  }

  /** 여러 값을 한 번에 저장한다 { varId: 값 } */
  async setMany(recipeId, values) {
    const entries = Object.entries(values ?? {}).filter(([, v]) => typeof v === 'string' && v !== '');
    if (!entries.length) return 0;
    if (!this.available) throw err(this.unavailableReason);
    for (const [, v] of entries) if (v.length > MAX_VALUE) throw err('비밀값이 너무 깁니다.');
    const keys = entries.map(([id]) => this.key(recipeId, id));
    const enc = await dpapi('protect', entries.map(([, v]) => Buffer.from(v, 'utf8').toString('base64')));
    const data = this.read();
    const now = new Date().toISOString();
    keys.forEach((k, i) => {
      data.items[k] = { data: enc[i], savedAt: now };
      this.cache.set(k, entries[i][1]);
    });
    this.write(data);
    return entries.length;
  }

  set(recipeId, varId, value) {
    if (typeof value !== 'string' || value === '') throw err('저장할 값이 비어 있습니다.');
    return this.setMany(recipeId, { [varId]: value });
  }

  delete(recipeId, varId) {
    const k = this.key(recipeId, varId);
    const data = this.read();
    this.cache.delete(k);
    if (!data.items[k]) return false;
    delete data.items[k];
    this.write(data);
    return true;
  }

  /** 레시피의 저장된 값 전부 { varId: 평문 } — 복호화는 한 번에, 결과는 메모리에 둔다 */
  async getAll(recipeId) {
    if (!this.available || !SAFE_ID.test(String(recipeId))) return {};
    const prefix = `${recipeId}/`;
    const out = {};
    const todo = [];
    for (const [k, v] of Object.entries(this.read().items)) {
      if (!k.startsWith(prefix) || typeof v?.data !== 'string') continue;
      if (this.cache.has(k)) out[k.slice(prefix.length)] = this.cache.get(k);
      else todo.push([k, v.data]);
    }
    if (todo.length) {
      const plain = await dpapi('unprotect', todo.map(([, d]) => d));
      todo.forEach(([k], i) => {
        const v = Buffer.from(String(plain[i] ?? ''), 'base64').toString('utf8');
        this.cache.set(k, v);
        out[k.slice(prefix.length)] = v;
      });
    }
    return out;
  }
}

export const MASK = '••••';
const MIN_SECRET = 3; // 이보다 짧은 값은 글자 치환으로 가리지 않는다 (흔한 글자까지 지워진다) — 구조로 가린다

/** 알려진 비밀값을 글자에서 •••• 로 바꾼다. JSON 으로 이스케이프된 모양도 찾는다. */
export class Redactor {
  constructor(values = []) {
    this.values = new Set();
    this.add(values);
  }

  add(values) {
    for (const v of Array.isArray(values) ? values : Object.values(values ?? {})) {
      const s = String(v ?? '');
      if (s.length < MIN_SECRET) continue;
      this.values.add(s);
      const escaped = JSON.stringify(s).slice(1, -1);
      if (escaped !== s) this.values.add(escaped);
    }
    this.list = [...this.values].sort((a, b) => b.length - a.length);
    return this;
  }

  text(s) {
    if (typeof s !== 'string' || !this.list.length) return s;
    let out = s;
    for (const v of this.list) if (out.includes(v)) out = out.split(v).join(MASK);
    return out;
  }

  /** 객체 안의 모든 문자열 */
  deep(value) {
    if (!this.list.length) return value;
    if (typeof value === 'string') return this.text(value);
    if (Array.isArray(value)) return value.map((v) => this.deep(v));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.deep(v)]));
    return value;
  }
}

/** 레시피의 비밀 변수 (prompt + secret) */
export const secretVariablesOf = (recipe) => (recipe?.variables ?? []).filter((v) => v?.id && v.source?.kind === 'prompt' && v.source.secret);

/** 비밀 변수를 쓰는(또는 비밀번호 칸의) 스텝인지 */
function secretStep(step, names) {
  if (step?.target?.meta?.type === 'password') return true;
  for (const k of ['value', 'label', 'promptText']) {
    const s = step?.[k];
    if (typeof s !== 'string' || !s.includes('{{')) continue;
    for (const m of s.matchAll(TOKEN_RE)) if (names.has(parseToken(m[1]).name)) return true;
  }
  return false;
}

/** 레시피의 각 스텝을 돌며 비밀 스텝이면 fn(step) */
function forSecretSteps(recipe, fn) {
  const names = new Set(secretVariablesOf(recipe).flatMap((v) => [v.id, v.name].filter(Boolean)));
  for (const steps of Object.values(recipe?.blocks ?? {})) for (const s of Array.isArray(steps) ? steps : []) if (s && secretStep(s, names)) fn(s);
}

/**
 * AI 에게 보여 줄 사본: 비밀 변수의 기본값과, 비밀 스텝의 녹화값을 •••• 로 가린다. 원본은 건드리지 않는다.
 */
export function maskRecipe(recipe) {
  const copy = structuredClone(recipe ?? {});
  for (const v of secretVariablesOf(copy)) if (v.source.default !== undefined && v.source.default !== '') v.source.default = MASK;
  forSecretSteps(copy, (s) => {
    if (s.meta?.recordedValue !== undefined) s.meta.recordedValue = MASK;
  });
  return copy;
}

/** 비밀 변수의 기본값 { varId: 값 } (빈 값 제외) */
export function secretDefaultsOf(recipe) {
  const out = {};
  for (const v of secretVariablesOf(recipe)) if (v.source.default !== undefined && v.source.default !== null && String(v.source.default) !== '') out[v.id] = String(v.source.default);
  return out;
}

/**
 * 레시피에서 비밀값을 지운다 (직접 고친다): 비밀 스텝의 녹화값, 그리고 keepDefaults 가 아니면 비밀 변수의 기본값. 바꿨으면 true.
 */
export function stripSecrets(recipe, { keepDefaults = false } = {}) {
  let changed = false;
  forSecretSteps(recipe, (s) => {
    if (s.meta?.recordedValue === undefined) return;
    delete s.meta.recordedValue;
    changed = true;
  });
  if (!keepDefaults) {
    for (const v of secretVariablesOf(recipe)) {
      if (v.source.default === undefined) continue;
      delete v.source.default;
      changed = true;
    }
  }
  return changed;
}

/**
 * 비밀 변수의 기본값을 저장소로 옮기고 레시피에서 비밀값을 지운다 (레시피를 직접 고친다). 바꿨으면 true.
 * 저장소가 없으면(Windows 가 아님) 기본값은 그대로 두고 녹화값만 지운다. 암호화에 실패하면 평문으로 남기지 않고 지운다.
 */
export async function moveSecretDefaults(secrets, recipe) {
  if (!secretVariablesOf(recipe).length) return false;
  if (!secrets?.available || !recipe?.id) return stripSecrets(recipe, { keepDefaults: true });
  const values = secretDefaultsOf(recipe);
  try {
    if (Object.keys(values).length) await secrets.setMany(recipe.id, values);
  } catch (e) {
    console.warn(`비밀 기본값을 저장소로 옮기지 못해 지웠습니다 (${recipe.id}): ${e.message}`);
  }
  return stripSecrets(recipe);
}
