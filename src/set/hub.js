// 공개 허브 읽기: 허브 목록(index.json)을 받아 세트 목록을 만들고, 세트를 내려받아 목록의 sha256 으로 확인한다.
// 목록 안 url·readme 는 목록 주소 기준 상대 경로다. 목록 서명은 나중 단계 — 지금은 https 와 sha256 으로만 확인한다.

import { satisfies, cmpSemver, isSemver, MAX_SET_BYTES } from './core.mjs';
import { ENGINE_VERSION, engineMessage, sha256 } from './index.js';

export const HUB_FORMAT = 'web-rpa-hub-index';
export const HUB_FORMAT_VERSION = 1;
const CACHE_MS = 60_000;
const INDEX_MAX = 5 * 1024 * 1024;
const README_MAX = 300 * 1024;
const SET_ID = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const cache = new Map(); // 목록 주소 → { at, index }

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const str = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strs = (v, max = 50) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.slice(0, 200)).slice(0, max) : []);

/** 허브 주소 검사: https 만 (이 PC 안의 시험용 주소는 http 도 허용) */
export function checkHubUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    throw httpError(400, `허브 주소가 올바르지 않습니다: ${raw}`);
  }
  const loopback = u.hostname === 'localhost' || u.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(u.hostname);
  if (u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) return u.href;
  throw httpError(400, `허브 주소는 https:// 로 시작해야 합니다 (이 PC 안의 시험용 주소만 http 허용): ${raw}`);
}

/** 주소를 받아 바이트로 (크기 상한·시간 제한) */
async function fetchLimited(url, limit, what) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': `web-rpa/${ENGINE_VERSION}` } });
  } catch (e) {
    throw httpError(502, `${what}을(를) 받지 못했습니다: ${e.cause?.code ?? e.cause?.message ?? e.message}`);
  }
  if (!res.ok) throw httpError(502, `${what}을(를) 받지 못했습니다: HTTP ${res.status}`);
  if (Number(res.headers.get('content-length')) > limit) throw httpError(502, `${what}이(가) 너무 큽니다.`);
  const chunks = [];
  let size = 0;
  for await (const c of res.body ?? []) {
    size += c.length;
    if (size > limit) throw httpError(502, `${what}이(가) 너무 큽니다.`);
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

/** 받은 목록을 검사·정리한다 (모르는 칸은 버리고, 주소는 절대 주소로). */
export function normalizeIndex(raw, indexUrl) {
  if (!raw || typeof raw !== 'object' || raw.format !== HUB_FORMAT) throw httpError(502, '허브 목록 형식이 아닙니다 (format 이 web-rpa-hub-index 가 아님).');
  if (raw.formatVersion !== HUB_FORMAT_VERSION) throw httpError(502, `허브 목록 형식 버전 ${raw.formatVersion} 은(는) 지원하지 않습니다. web-rpa 를 업데이트해 주세요.`);
  if (!Array.isArray(raw.sets)) throw httpError(502, '허브 목록에 sets 가 없습니다.');
  const abs = (rel) => {
    try {
      const u = new URL(String(rel), indexUrl);
      return /^https?:$/.test(u.protocol) ? u.href : null;
    } catch {
      return null;
    }
  };
  const sets = [];
  for (const s of raw.sets) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !SET_ID.test(s.id)) continue;
    const versions = (Array.isArray(s.versions) ? s.versions : [])
      .filter((v) => v && isSemver(v.version) && typeof v.url === 'string' && abs(v.url))
      .map((v) => ({
        version: v.version,
        engine: str(v.engine, 60),
        url: abs(v.url),
        sha256: str(v.sha256, 64).toLowerCase(),
        size: Number(v.size) > 0 ? Number(v.size) : null,
        publishedAt: str(v.publishedAt, 40) || null,
        risk: strs(v.risk),
        sites: strs(v.sites),
        columns: strs(v.columns),
        verified: v.verified && typeof v.verified === 'object' ? { at: str(v.verified.at, 40), result: str(v.verified.result, 40) } : null,
        compatible: !!str(v.engine) && satisfies(ENGINE_VERSION, str(v.engine, 60)),
      }))
      .sort((a, b) => cmpSemver(b.version, a.version));
    if (!versions.length) continue;
    sets.push({
      id: s.id,
      name: str(s.name, 120) || s.id,
      summary: str(s.summary, 500),
      author: { name: str(s.author?.name, 80), github: str(s.author?.github, 40) },
      license: str(s.license, 60),
      tags: strs(s.tags, 20),
      latest: isSemver(s.latest) && versions.some((v) => v.version === s.latest) ? s.latest : versions[0].version,
      versions,
      readme: typeof s.readme === 'string' ? abs(s.readme) : null,
    });
  }
  return {
    hub: { name: str(raw.hub?.name, 120), url: str(raw.hub?.url, 300), repo: str(raw.hub?.repo, 300) },
    generatedAt: str(raw.generatedAt, 40) || null,
    sets,
  };
}

/** 허브 목록 (1분 동안 기억해 둔다) */
export async function fetchIndex(src, { refresh = false } = {}) {
  const url = checkHubUrl(src.url);
  const hit = cache.get(url);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.index;
  const buf = await fetchLimited(url, INDEX_MAX, '허브 목록');
  let raw;
  try {
    raw = JSON.parse(buf.toString('utf8').replace(/^﻿/, ''));
  } catch {
    throw httpError(502, '허브 목록이 JSON 이 아닙니다.');
  }
  const index = normalizeIndex(raw, url);
  cache.set(url, { at: Date.now(), index });
  return index;
}

/** 버전 고르기: 지정한 버전, 아니면 이 web-rpa 에서 도는 가장 새 버전, 그것도 없으면 latest */
export function pickVersion(set, version) {
  if (version) {
    const v = set.versions.find((x) => x.version === version);
    if (!v) throw httpError(404, `허브에 ${set.id} 의 ${version} 버전이 없습니다 (있는 버전: ${set.versions.map((x) => x.version).join(', ')}).`);
    return v;
  }
  return set.versions.find((x) => x.compatible) ?? set.versions.find((x) => x.version === set.latest) ?? set.versions[0];
}

/**
 * 모든 허브의 세트 목록 + 설치·업데이트 표시.
 * @param {{name: string, url: string}[]} sources
 * @param {object} installed installedSets() 결과
 */
export async function hubList(sources, installed = {}, { refresh = false } = {}) {
  const results = await Promise.all(
    sources.map(async (src) => {
      try {
        return { src, index: await fetchIndex(src, { refresh }) };
      } catch (e) {
        return { src, error: e.message };
      }
    }),
  );
  const out = { engineVersion: ENGINE_VERSION, sources: [], sets: [] };
  for (const r of results) {
    out.sources.push({ name: r.src.name, url: r.src.url, ok: !r.error, error: r.error ?? null, hub: r.index?.hub ?? null, generatedAt: r.index?.generatedAt ?? null, count: r.index?.sets.length ?? 0 });
    for (const s of r.index?.sets ?? []) {
      const entry = pickVersion(s);
      const inst = installed[s.id];
      out.sets.push({
        ...s,
        source: r.src.url,
        sourceName: r.src.name,
        entry,
        installed: inst ? { version: inst.version, recipeId: inst.recipeId, uploadId: inst.uploadId, sha256: inst.sha256 } : null,
        update: !!inst && cmpSemver(entry.version, inst.version) > 0,
      });
    }
  }
  return out;
}

/** 설정에 있는 허브만 쓴다 (주소나 이름으로 고른다) */
export function findSource(sources, source) {
  const src = sources.find((s) => s.url === source || s.name === source);
  if (!src) throw httpError(400, `설정에 없는 허브입니다: ${source}`);
  return src;
}

/** 허브에서 세트 하나 찾기. source 가 없으면 모든 허브에서 찾는다. */
export async function resolveHubSet(sources, { source, id, version } = {}) {
  if (!id || !SET_ID.test(String(id))) throw httpError(400, '세트 id 는 "게시자/이름" 형식이어야 합니다.');
  const list = source ? [findSource(sources, source)] : sources;
  let lastError = null;
  for (const src of list) {
    try {
      const index = await fetchIndex(src);
      const set = index.sets.find((s) => s.id === id);
      if (set) return { src, set, entry: pickVersion(set, version) };
    } catch (e) {
      if (e.status === 404) throw e;
      lastError = e;
    }
  }
  if (lastError && list.length === 1) throw lastError;
  throw httpError(404, `허브에 ${id} 세트가 없습니다.`);
}

/** 세트 내려받기: 엔진 범위 확인 → 내려받기 → 목록의 sha256 과 대조 */
export async function downloadHubSet(entry) {
  if (!entry.engine || !satisfies(ENGINE_VERSION, entry.engine)) throw httpError(400, engineMessage(entry.engine || '(범위 없음)'), { code: 'engine' });
  if (!/^[0-9a-f]{64}$/.test(entry.sha256)) throw httpError(400, '허브 목록에 이 버전의 sha256 이 없어 내려받은 파일을 확인할 수 없습니다. 설치하지 않습니다.', { code: 'sha256' });
  const buf = await fetchLimited(entry.url, MAX_SET_BYTES, '세트 파일');
  const got = sha256(buf);
  if (got !== entry.sha256) {
    throw httpError(400, `내려받은 세트의 sha256 이 허브 목록과 다릅니다 — 중간에 바뀌었거나 손상된 파일일 수 있어 설치하지 않습니다. (목록 ${entry.sha256.slice(0, 12)}…, 받은 파일 ${got.slice(0, 12)}…)`, { code: 'sha256' });
  }
  return buf;
}

/** 세트 설명(README.md) 글자 */
export async function hubReadme(sources, { source, id }) {
  const { set } = await resolveHubSet(sources, { source, id });
  if (!set.readme) return '';
  return (await fetchLimited(set.readme, README_MAX, '세트 설명')).toString('utf8');
}

/** 시험용: 기억해 둔 목록 비우기 */
export const clearHubCache = () => cache.clear();
