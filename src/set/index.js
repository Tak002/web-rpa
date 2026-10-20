// 진행 세트(.wrset): 레시피를 세트로 묶기, 세트 검사(미리보기), 작업 폴더에 설치.
// 규칙(정리·위험·개인정보·manifest·세트 검사)은 core.mjs, 압축은 zip.mjs — 둘 다 허브 저장소 CI 와 같은 파일이다.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { scrubRecipe, applyDecisions, collectOrigins, detectRisks, manifestDraft, lintSet, xlsxDangers, parseCsv, toCsv, satisfies, stepsOf, DEFAULT_LICENSE, DEFAULT_PACING, MAX_SET_BYTES } from './core.mjs';
import { readZip } from './zip.mjs';
import { packFiles } from './folder.mjs';
import { recipeProblems, excelColumnsOf, promptVariablesOf } from '../recipe.js';

export const ENGINE_VERSION = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')).version;

/** 위험 표시 → 화면 이름 */
export const RISK_LABELS = { submit: '제출·결제', download: '파일 저장', upload: '파일 첨부', login: '로그인', 'insecure-http': '암호화 안 된 사이트', 'var-in-url': '주소에 변수' };
const RISK_SENTENCES = {
  submit: '되돌릴 수 없는 버튼(제출·신청·결제·삭제 등)을 누릅니다.',
  download: '파일을 저장합니다.',
  upload: 'PC 의 파일을 사이트에 올립니다.',
  login: '로그인하거나 실행 중에 사람이 확인해야 합니다.',
  'insecure-http': '암호화하지 않은(http) 사이트에 접속합니다.',
  'var-in-url': '엑셀·입력 값을 주소에 넣어 이동합니다.',
};
const RISK_ORDER = ['submit', 'upload', 'download', 'login', 'insecure-http', 'var-in-url'];

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
/** 내려받을 파일 이름: tak002/dart-latest + 1.0.0 → tak002-dart-latest-1.0.0.wrset */
export const setFileName = (id, version) => `${String(id).replace(/[^a-z0-9-]+/gi, '-')}-${version}.wrset`;
const hostOf = (origin) => {
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' ? u.origin : u.host;
  } catch {
    return String(origin);
  }
};
const clampInt = (v, min, max, def) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
};

/** 세트의 행 간격·행 수 상한 (지나친 값은 잘라 둔다) */
export function normPacing(p) {
  return {
    minRowIntervalMs: clampInt(p?.minRowIntervalMs, 0, 600_000, DEFAULT_PACING.minRowIntervalMs),
    maxRowsPerRun: clampInt(p?.maxRowsPerRun, 1, 100_000, DEFAULT_PACING.maxRowsPerRun),
  };
}

/** 세트 검사에 쓰는 레시피 검사. 공유하며 비운 첨부 파일 경로는 설치한 사람이 채우므로 문제로 보지 않는다. */
export const setRecipeProblems = (r) => recipeProblems(r).filter((p) => !p.includes('첨부할 파일 경로가 비어'));

export function engineMessage(range) {
  return `이 세트는 web-rpa ${range} 에서 동작합니다. 지금 web-rpa 는 ${ENGINE_VERSION} 입니다 — web-rpa 를 업데이트하거나 맞는 버전의 세트를 고르세요.`;
}

/** 사람이 읽는 요약 문장: "이 세트는 dart.fss.or.kr 에만 접속합니다." "파일을 저장합니다." … */
export function riskSummary({ sites = [], flags = [], pacing } = {}) {
  const out = [];
  const hosts = sites.map((s) => hostOf(typeof s === 'string' ? s : s.origin)).filter(Boolean);
  if (hosts.length) out.push(`이 세트는 ${hosts.join(', ')} 에만 접속합니다.`);
  for (const f of RISK_ORDER) if (flags.includes(f)) out.push(RISK_SENTENCES[f]);
  if (pacing) out.push(`행 사이에 ${Math.round(pacing.minRowIntervalMs / 100) / 10}초 이상 쉬고, 한 번에 최대 ${pacing.maxRowsPerRun}행까지 실행합니다.`);
  return out;
}

// ---------------------------------------------------------------- 내보내기 (레시피 → 세트)

/** 값 모양으로 만든 정규식 (실제 값은 넣지 않는다) */
const shapeOf = (v) => {
  const s = String(v ?? '').trim();
  if (/^-?[\d,]+(\.\d+)?$/.test(s)) return '^-?[\\d,.]+$';
  if (/^-?[\d,]+(\.\d+)?\s*원$/.test(s)) return '^-?[\\d,.]+\\s*원$';
  if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(s)) return '^\\d{4}[-./]\\d{1,2}[-./]\\d{1,2}$';
  return '\\S';
};

/**
 * 기대 결과 초안: 지난 실행의 성공 행에서 값 이름·값 모양·파일 종류만 가져온다(실제 값은 넣지 않는다).
 * 실행 기록이 없으면 레시피의 값 읽기·저장 스텝으로 만든다.
 */
export function expectedDraft(recipe, report) {
  const values = {};
  const files = [];
  const addFile = (ext) => ext && !files.some((f) => f.type === ext) && files.push({ glob: `*.${ext}`, type: ext });
  const okRow = report?.rows?.find((r) => r.status === 'ok');
  if (okRow) {
    for (const [k, v] of Object.entries(okRow.values ?? {})) values[k] = { regex: shapeOf(v) };
    for (const f of okRow.files ?? []) addFile(path.extname(f).slice(1).toLowerCase());
  } else {
    for (const s of stepsOf(recipe)) {
      const st = s.step ?? {};
      if (st.disabled) continue;
      if (st.type === 'extract' && st.saveAs) values[st.saveAs] = { regex: '\\S' };
      if (st.type === 'pdf') addFile('pdf');
      if (st.type === 'screenshot') addFile('png');
    }
  }
  if (!Object.keys(values).length && !files.length) return null;
  return { rows: { '*': { status: 'ok', ...(Object.keys(values).length ? { values } : {}), ...(files.length ? { files } : {}) } } };
}

/** 내보내기 마법사 첫 화면: manifest 초안 + 정리 미리보기 */
export function setDraft(recipe, { runReport } = {}) {
  const { recipe: clean, removed, remaining } = scrubRecipe(recipe);
  const columns = excelColumnsOf(recipe);
  const prompts = promptVariablesOf(recipe);
  const manifest = manifestDraft(clean, { engineVersion: ENGINE_VERSION, columns, prompts });
  const risks = detectRisks(clean);
  return {
    engineVersion: ENGINE_VERSION,
    manifest,
    removed,
    remaining,
    risks,
    origins: collectOrigins(clean),
    columns,
    prompts: manifest.prompts,
    problems: setRecipeProblems(recipe),
    expected: expectedDraft(clean, runReport),
    expectedFrom: runReport?.rows?.some((r) => r.status === 'ok') ? runReport.runId : null,
  };
}

const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);

/** 세트 README (manifest 로 만든다 — 녹화값·실행 결과는 넣지 않는다) */
export function makeReadme(m, { description = '', risks = [] } = {}) {
  const L = [`# ${m.name}`, '', m.summary, ''];
  if (description.trim()) L.push(description.trim(), '');
  L.push('## 접속하는 사이트', '');
  for (const s of m.sites) L.push(`- ${s.origin} — ${s.purpose}${s.login === 'required' ? ' (로그인 필요)' : s.login === 'optional' ? ' (로그인하면 더 많은 기능)' : ''}`);
  L.push('');
  if (m.columns.length) {
    L.push('## 엑셀 열', '');
    for (const c of m.columns) L.push(`- **${c.name}**${c.help ? ` — ${c.help}` : ''}${c.example ? ` (예: ${c.example})` : ''}`);
    L.push('');
  } else L.push('## 엑셀 열', '', '엑셀 없이 한 번 실행합니다. 예시 입력의 "메모" 열은 실행 횟수만 정합니다.', '');
  if (m.prompts.length) {
    L.push('## 실행할 때 넣는 값', '');
    for (const p of m.prompts) L.push(`- ${p.name}${p.secret ? ' (비밀값 — 저장하지 않습니다)' : ''}`);
    L.push('');
  }
  if (m.attachments.length) {
    L.push('## 첨부할 파일', '', '설치한 뒤 편집 화면에서 첨부 스텝의 파일 경로를 정해야 실행할 수 있습니다.', '');
    for (const a of m.attachments) L.push(`- ${a.where}${a.help ? ` — ${a.help}` : ''}`);
    L.push('');
  }
  if (m.outputs?.values?.length) L.push('## 결과', '', `결과 엑셀에 남는 값: ${m.outputs.values.join(', ')}`, '');
  if (risks.length) {
    L.push('## 주의할 동작', '');
    for (const r of risks) L.push(`- ${RISK_LABELS[r.flag] ?? r.flag}: ${r.detail}${r.where ? ` (${r.where})` : ''}`);
    L.push('');
  }
  L.push(
    '## 쓰는 법',
    '',
    '1. web-rpa 의 **허브** 화면에서 이 세트를 가져오거나, 세트 파일(.wrset)을 [세트 파일 가져오기]로 설치합니다.',
    '2. [예시로 실행]으로 들어 있는 예시 입력을 실행해 결과를 확인합니다.',
    '3. 같은 열 이름의 엑셀에 처리할 행을 채워 실행합니다.',
    '',
    `행 사이에 ${m.pacing.minRowIntervalMs / 1000}초 이상 쉬고, 한 번에 최대 ${m.pacing.maxRowsPerRun}행까지 실행합니다. 자동화하려는 사이트의 이용약관을 지켜 주세요.`,
    '',
    `라이선스: ${m.license}`,
    '',
  );
  return L.join('\n');
}

/**
 * 레시피 → 세트 파일.
 * @param {object} recipe 저장된 레시피
 * @param {{manifest?: object, decisions?: object, sampleRows?: object[], expected?: object|null, description?: string, extraSites?: string[]}} input 마법사에서 받은 값
 * @returns {{ files: Map<string, Buffer>, buffer: Buffer, sha256: string, fileName: string, manifest: object, lint: object, summary: string[] }}
 */
export function buildSet(recipe, input = {}) {
  const { manifest: edits = {}, decisions = {}, sampleRows = [], expected = null, description = '', extraSites = [] } = input;
  const { recipe: scrubbed, remaining } = scrubRecipe(recipe);
  const undecided = remaining.filter((r) => decisions[r.id] !== 'keep' && decisions[r.id] !== 'clear');
  if (undecided.length) throw httpError(400, `남은 값 ${undecided.length}개를 "그대로 둠" 또는 "지우기"로 정해 주세요: ${undecided.map((r) => `${r.where} ${r.label}`).join(', ')}`);
  const clean = applyDecisions(scrubbed, decisions);
  const columns = excelColumnsOf(recipe);
  const prompts = promptVariablesOf(recipe);
  const author = { name: str(edits.author?.name, 80), ...(str(edits.author?.github, 40) ? { github: str(edits.author.github, 40) } : {}) };
  const draft = manifestDraft(clean, { engineVersion: ENGINE_VERSION, author, columns, prompts });

  // 사이트: 레시피가 쓰는 곳 + 작성자가 더한 곳(다운로드만 하는 다른 주소 등). 하는 일은 작성자가 적는다.
  const origins = [...new Set([...draft.sites.map((s) => s.origin), ...(Array.isArray(extraSites) ? extraSites : []).map((o) => { try { return new URL(String(o).trim()).origin; } catch { return null; } }).filter((o) => o && /^https?:/.test(o))])];
  const siteEdit = (o) => (Array.isArray(edits.sites) ? edits.sites.find((s) => s?.origin === o) : null) ?? {};
  const colEdit = (n) => (Array.isArray(edits.columns) ? edits.columns.find((c) => c?.name === n) : null) ?? {};
  const m = {
    ...draft,
    id: str(edits.id || draft.id, 120).toLowerCase(),
    name: str(edits.name || draft.name, 120),
    version: str(edits.version || '1.0.0', 20),
    summary: str(edits.summary, 300),
    author,
    license: str(edits.license, 60) || DEFAULT_LICENSE,
    tags: [...new Set((Array.isArray(edits.tags) ? edits.tags : String(edits.tags ?? '').split(',')).map((t) => str(t, 30)).filter(Boolean))].slice(0, 10),
    sites: origins.map((origin) => {
      const d = draft.sites.find((s) => s.origin === origin);
      const e = siteEdit(origin);
      return { origin, purpose: str(e.purpose, 200), login: ['none', 'required', 'optional'].includes(e.login) ? e.login : (d?.login ?? 'none') };
    }),
    columns: draft.columns.map((c) => {
      const e = colEdit(c.name);
      return { ...c, required: e.required !== false, example: str(e.example, 200), help: str(e.help, 300), personal: !!e.personal };
    }),
    attachments: draft.attachments.map((a, i) => ({ ...a, help: str(edits.attachments?.[i]?.help, 300) })),
    pacing: normPacing({ ...DEFAULT_PACING, ...(edits.pacing ?? {}) }),
  };
  clean.name = m.name;
  if (!clean.schemaVersion) clean.schemaVersion = 1;

  // 예시 입력: 엑셀 열이 없으면 "메모" 열 하나로 한 번 실행한다
  const headers = columns.length ? columns : ['메모'];
  const rows = (Array.isArray(sampleRows) ? sampleRows : [])
    .map((r) => Object.fromEntries(headers.map((c) => [c, str(r?.[c], 500)])))
    .filter((r) => Object.values(r).some((v) => v !== ''));
  if (!columns.length && !rows.length) rows.push({ 메모: '예시' });

  if (expected !== null && expected !== undefined && expected !== '') {
    if (typeof expected !== 'object' || Array.isArray(expected) || (expected.rows !== undefined && (typeof expected.rows !== 'object' || Array.isArray(expected.rows)))) throw httpError(400, '기대 결과는 { "rows": { "*": { … } } } 모양의 JSON 이어야 합니다.');
  }

  const risks = detectRisks(clean);
  const files = new Map();
  files.set('manifest.json', Buffer.from(`${JSON.stringify(m, null, 2)}\n`));
  files.set('recipe.json', Buffer.from(`${JSON.stringify(clean, null, 2)}\n`));
  files.set('README.md', Buffer.from(makeReadme(m, { description: str(description, 5000), risks })));
  files.set('input/sample.csv', Buffer.from(toCsv(headers, rows), 'utf8'));
  if (expected && typeof expected === 'object') files.set('expected.json', Buffer.from(`${JSON.stringify(expected, null, 2)}\n`));
  const lint = lintSet(files, { recipeProblems: setRecipeProblems });
  const buffer = packFiles(files);
  return { files, buffer, sha256: sha256(buffer), fileName: setFileName(m.id, m.version), manifest: m, lint, summary: riskSummary({ sites: m.sites, flags: m.risk, pacing: m.pacing }) };
}

// ---------------------------------------------------------------- 가져오기 (세트 → 미리보기)

/** .wrset 바이트 → 파일 목록 (크기·형식이 이상하면 400) */
export function readSet(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw httpError(400, '세트 파일이 비어 있습니다.');
  if (buf.length > MAX_SET_BYTES) throw httpError(400, `세트 파일이 2MB 를 넘습니다 (${(buf.length / 1024 / 1024).toFixed(1)}MB).`);
  try {
    return readZip(buf, { maxEntries: 100, maxTotal: MAX_SET_BYTES * 2 });
  } catch (e) {
    throw httpError(400, `세트 파일(.wrset)을 읽지 못했습니다: ${e.message}`);
  }
}

/**
 * 세트 검사 + 화면용 미리보기.
 * @param {Map<string, Buffer>} files
 * @param {Buffer} [buf] 원래 .wrset 바이트 (sha256 계산용)
 */
export function inspectFiles(files, buf) {
  const lint = lintSet(files, { recipeProblems: setRecipeProblems });
  const errors = [...lint.errors];
  const warnings = [...lint.warnings];
  const m = lint.manifest && typeof lint.manifest === 'object' ? lint.manifest : {};
  const text = (name) => (files.has(name) ? files.get(name).toString('utf8') : '');
  if (files.has('input/template.xlsx')) {
    try {
      const bad = xlsxDangers(readZip(files.get('input/template.xlsx')));
      if (bad.length) errors.push(`input/template.xlsx 에 ${bad.join(', ')} 이(가) 들어 있어 설치할 수 없습니다.`);
    } catch {
      errors.push('input/template.xlsx 를 엑셀 파일로 열 수 없습니다.');
    }
  }
  const range = m.engine?.webRpa ?? '';
  const engineOk = !!range && satisfies(ENGINE_VERSION, range);
  if (range && !engineOk) errors.push(engineMessage(range));
  let expected = null;
  if (files.has('expected.json')) {
    try {
      expected = JSON.parse(text('expected.json'));
    } catch {
      /* lintSet 이 이미 오류로 알린다 */
    }
  }
  const sites = (Array.isArray(m.sites) ? m.sites : []).map((s) => ({ origin: String(s?.origin ?? ''), purpose: String(s?.purpose ?? ''), login: String(s?.login ?? 'none'), used: lint.computed.origins.includes(s?.origin) }));
  const pacing = normPacing(m.pacing);
  return {
    manifest: lint.manifest,
    id: m.id ?? null,
    name: m.name ?? '',
    version: m.version ?? '',
    readme: text('README.md'),
    changelog: text('CHANGELOG.md'),
    errors: [...new Set(errors)],
    warnings,
    risks: lint.computed.risks,
    flags: lint.computed.flags,
    declaredRisk: Array.isArray(m.risk) ? m.risk : [],
    sites,
    origins: lint.computed.origins,
    columns: Array.isArray(m.columns) ? m.columns : [],
    prompts: Array.isArray(m.prompts) ? m.prompts : [],
    attachments: Array.isArray(m.attachments) ? m.attachments : [],
    outputs: m.outputs ?? {},
    pacing,
    sample: files.has('input/sample.csv') ? parseCsv(text('input/sample.csv')) : { headers: [], rows: [] },
    expected,
    engine: { required: range, current: ENGINE_VERSION, ok: engineOk },
    sha256: buf ? sha256(buf) : null,
    size: buf?.length ?? null,
    files: [...files.keys()].sort(),
    summary: riskSummary({ sites, flags: [...new Set([...lint.computed.flags, ...(Array.isArray(m.risk) ? m.risk : [])])], pacing }),
    recipe: lint.recipe,
  };
}

/** .wrset 바이트 → 미리보기 (recipe 는 빼고 화면에 보낸다) */
export function inspectSet(buf) {
  return inspectFiles(readSet(buf), buf);
}

/** 화면에 보낼 미리보기 (레시피 본문 제외) */
export function publicPreview(p) {
  const { recipe, ...rest } = p;
  return { ...rest, steps: [...stepsOf(recipe ?? {})].length };
}

// ---------------------------------------------------------------- 설치

const setsDir = (store) => path.join(store.root, 'sets');
const registryFile = (store) => path.join(setsDir(store), 'installed.json');

async function readRegistry(store) {
  try {
    const r = JSON.parse(await fsp.readFile(registryFile(store), 'utf8'));
    return { formatVersion: 1, sets: r?.sets && typeof r.sets === 'object' ? r.sets : {} };
  } catch {
    return { formatVersion: 1, sets: {} };
  }
}

async function writeRegistry(store, reg) {
  await fsp.mkdir(setsDir(store), { recursive: true });
  const file = registryFile(store);
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(reg, null, 2));
  await fsp.rename(tmp, file);
}

/** 설치한 세트: { [세트 id]: { version, sha256, source, recipeId, uploadId, installedAt, name } } — 레시피를 지웠으면 뺀다 */
export async function installedSets(store) {
  const reg = await readRegistry(store);
  const out = {};
  for (const [id, e] of Object.entries(reg.sets)) {
    if (e?.recipeId && fs.existsSync(path.join(store.dirs.recipes, `${e.recipeId}.json`))) out[id] = e;
  }
  return out;
}

/**
 * 세트를 작업 폴더에 설치한다: 레시피(사이트 제한·실행 간격 포함) + 예시 입력(올린 파일) + 원본 세트 보관.
 * 같은 세트가 이미 있으면 그 레시피를 새 버전으로 바꾼다(이전 레시피는 trash 에 보관).
 * @param {import('../store.js').Store} store
 * @param {Buffer} buf .wrset 바이트
 * @param {{source?: string}} [o] 허브 목록 주소 또는 'file'
 */
export async function installSet(store, buf, { source = 'file' } = {}) {
  const files = readSet(buf);
  const p = inspectFiles(files, buf);
  if (p.errors.length) throw httpError(400, `설치할 수 없는 세트입니다:\n- ${p.errors.join('\n- ')}`, { errors: p.errors });
  const m = p.manifest;
  const reg = await readRegistry(store);
  const prev = reg.sets[m.id];
  const recipe = structuredClone(p.recipe);
  delete recipe.id;
  delete recipe.createdAt;
  delete recipe.updatedAt;
  recipe.name = m.name;
  const installedAt = new Date().toISOString();
  recipe.origin = { set: m.id, version: m.version, sha256: p.sha256, source, installedAt, sites: p.sites.map((s) => s.origin), pacing: p.pacing };

  let updated = false;
  const prevFile = prev?.recipeId ? path.join(store.dirs.recipes, `${prev.recipeId}.json`) : null;
  if (prevFile && fs.existsSync(prevFile)) {
    // 새 버전으로 바꾼다. 이전 레시피는 지우지 않고 trash 에 둔다 (편집해 둔 첨부 경로 등을 되찾을 수 있게)
    const old = JSON.parse(await fsp.readFile(prevFile, 'utf8'));
    await fsp.copyFile(prevFile, path.join(store.dirs.trash, `${prev.recipeId}-${Date.now()}.json`));
    recipe.id = prev.recipeId;
    recipe.createdAt = old.createdAt;
    updated = true;
  }
  const saved = await store.saveRecipe(recipe);
  const uploadId = await store.saveUpload(`${m.name}_예시.csv`, files.get('input/sample.csv'));
  const pkgDir = path.join(setsDir(store), 'packages');
  await fsp.mkdir(pkgDir, { recursive: true });
  const pkg = setFileName(m.id, m.version);
  await fsp.writeFile(path.join(pkgDir, pkg), buf);
  reg.sets[m.id] = { name: m.name, version: m.version, sha256: p.sha256, source, recipeId: saved.id, uploadId, installedAt, package: pkg };
  await writeRegistry(store, reg);
  return { id: m.id, name: m.name, version: m.version, recipeId: saved.id, uploadId, updated, previousVersion: updated ? prev.version : null, summary: p.summary, warnings: p.warnings };
}
