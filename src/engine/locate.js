// 요소 찾기: 후보를 점수 순서로 시도해 정확히 하나만 맞는 후보를 쓴다. 보이는 요소를 우선하고,
// 프레임 경로를 따라가되 깨졌으면 모든 프레임 합계로 유일성을 본다. 지금 탭에 없으면 다른 탭도 본다.
// within: 'item' 대상은 지금 목록 항목(forEach) 안에서만 찾고, 목록(items)은 보이는 요소가 1개 이상 맞는 첫 후보로 센다.

import { resolveFramePath, framePathOf } from '../browser.js';
import { targetText, withJosa } from '../../public/shared/steps.js';

const POLL_MS = 200;
const HIDDEN_GRACE_MS = 2500; // 숨은 요소는 이만큼 기다려도 보이는 것이 없을 때만 쓴다
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.notFound = true;
  }
}

const xq = (s) => {
  s = String(s);
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `concat(${s.split("'").map((p) => `'${p}'`).join(`, "'", `)})`;
};
const cssStr = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** 녹화 후보 말고 실행 때 덧붙이는 후보: 바뀌는 id 의 안정된 앞부분, 라벨로 만든 선택자, 보이는 글자. */
function extraCandidates(target, { allowText }) {
  const out = [];
  const meta = target.meta ?? {};
  const tag = /^[a-z][a-z0-9-]*$/i.test(meta.tag ?? '') ? meta.tag : '*';
  for (const c of target.candidates) {
    if ((c.kind !== 'css' && c.kind !== 'attr') || typeof c.value !== 'string') continue;
    const m = /^(?:[a-z0-9-]+)?#([A-Za-z_][\w-]*)$/i.exec(c.value);
    if (!m) continue;
    const d = /^(.*?[-_:.]?)\d{4,}/.exec(m[1]);
    if (d && d[1].length >= 3) out.push({ kind: 'attr', value: `${tag}[id^="${cssStr(d[1])}"]` });
  }
  const label = String(meta.label ?? '').trim();
  if (label && label.length <= 40 && ['input', 'select', 'textarea'].includes(meta.tag)) {
    out.push({ kind: 'xpath', value: `//${meta.tag}[@id=//label[normalize-space()=${xq(label)}]/@for]` });
    out.push({ kind: 'xpath', value: `//label[normalize-space()=${xq(label)}]//${meta.tag}` });
    out.push({ kind: 'attr', value: `${meta.tag}[aria-label="${cssStr(label)}"]` });
    out.push({ kind: 'attr', value: `${meta.tag}[placeholder="${cssStr(label)}"]` });
  }
  const text = String(meta.text ?? '').trim();
  if (allowText && text && text.length <= 60 && !text.endsWith('…') && !target.candidates.some((c) => c.kind === 'text') && !['input', 'select', 'textarea'].includes(meta.tag)) {
    out.push({ kind: 'text', value: { tag, text } });
  }
  return out;
}

/** 후보 값의 {{변수}} 를 치환하고 점수 순으로 줄 세운다. */
export function prepareCandidates(target, scope, { extras = true, allowText = true } = {}) {
  const list = (target.candidates ?? [])
    .map((c, i) => ({
      kind: c.kind,
      score: Number(c.score) || 0,
      order: i,
      value: c.kind === 'text' ? { tag: c.value?.tag || '*', text: scope.resolve(c.value?.text ?? '') } : scope.resolve(String(c.value ?? '')),
    }))
    .filter((c) => (c.kind === 'text' ? c.value.text : c.value))
    .sort((a, b) => b.score - a.score || a.order - b.order);
  if (!extras) return list;
  const low = Math.min(0, ...list.map((c) => c.score));
  const seen = new Set(list.map((c) => `${c.kind}:${JSON.stringify(c.value)}`));
  for (const [i, c] of extraCandidates({ ...target, candidates: list }, { allowText }).entries()) {
    const key = `${c.kind}:${JSON.stringify(c.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ ...c, score: low - 1 - i, extra: true });
  }
  return list;
}

const sameDoc = (a, b) => String(a ?? '').split('#')[0] === String(b ?? '').split('#')[0];
const samePath = (a, b) => {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch {
    return false;
  }
};

async function scanFrames(sess, frames, cands) {
  const per = await Promise.all(frames.map((f) => sess.callLib(f, 'count', cands).catch(() => null)));
  const counts = cands.map((_, i) => {
    let total = 0;
    let visible = 0;
    let error;
    for (const r of per) {
      if (!r?.[i]) continue;
      total += r[i].total;
      visible += r[i].visible;
      error ??= r[i].error;
    }
    return { total, visible, error };
  });
  for (let i = 0; i < cands.length; i += 1) {
    if (counts[i].visible !== 1) continue;
    const j = per.findIndex((r) => r?.[i]?.visible === 1);
    return { hit: { frame: frames[j], cand: cands[i], hidden: false }, counts };
  }
  for (let i = 0; i < cands.length; i += 1) {
    if (counts[i].total !== 1) continue;
    const j = per.findIndex((r) => r?.[i]?.total === 1);
    return { hidden: { frame: frames[j], cand: cands[i], hidden: true }, counts };
  }
  return { counts };
}

async function scanPage(sess, page, framePath, cands) {
  const resolved = framePath?.length ? resolveFramePath(page, framePath) : page.mainFrame();
  const frames = resolved ? [resolved] : page.frames();
  let r = await scanFrames(sess, frames, cands);
  if (!r.hit && !r.hidden && resolved && page.frames().length > 1) {
    // 프레임 경로는 맞는데 그 안에 없으면 모든 프레임 합계로 다시 본다
    const all = await scanFrames(sess, page.frames(), cands);
    if (all.hit || all.hidden) r = all;
  }
  return r;
}

async function handleOf(page, hit) {
  try {
    const h = await hit.frame.evaluateHandle(([c, vis]) => window.__webRpa && window.__webRpa.pick(c, vis), [hit.cand, !hit.hidden]);
    const el = h.asElement();
    if (!el) {
      await h.dispose();
      return null;
    }
    return { page, frame: hit.frame, handle: el, cand: hit.cand, hidden: hit.hidden };
  } catch {
    return null;
  }
}

/** 다른 탭에서 보이는 유일한 대상 */
async function searchOtherTabs(sess, current, target, cands, filter) {
  const found = [];
  for (const p of sess.pages()) {
    if (p === current || (filter && !filter(p))) continue;
    const r = await scanPage(sess, p, target.framePath, cands).catch(() => ({}));
    if (r.hit) found.push({ page: p, hit: r.hit });
  }
  return found.length === 1 ? found[0] : null;
}

/** 로그인 칸처럼 보이는 대상 (못 찾으면 "이미 로그인돼 있을 수 있다" 고 알린다) */
const loginLike = (t) => t?.meta?.type === 'password' || /아이디|비밀번호|패스워드|password|login|로그인|user ?id|\bid\b/i.test(`${t?.meta?.label ?? ''} ${t?.meta?.name ?? ''} ${t?.meta?.placeholder ?? ''}`);

/**
 * 못 찾은 오류 문장: 첫 줄은 쉬운 문장("조회" 버튼을 화면에서 찾지 못했습니다), 둘째 줄부터 자세히(시도한 후보와 개수).
 * 리포트는 첫 줄을 보이고 나머지는 [자세히] 에 접어 둔다.
 */
function describeMiss(target, cands, counts, where = '') {
  const parts = cands.slice(0, 6).map((c, i) => {
    const v = c.kind === 'text' ? `<${c.value.tag}>"${c.value.text}"` : c.value;
    const n = counts?.[i];
    const cnt = !n ? '?' : n.error ? '선택자 오류' : n.total === n.visible ? `${n.total}개` : `${n.total}개(보이는 것 ${n.visible})`;
    return `${c.kind} ${String(v).slice(0, 80)} → ${cnt}`;
  });
  const many = counts?.some((n) => n && !n.error && n.visible > 1);
  const why = loginLike(target)
    ? ' 이미 로그인돼 있어 로그인 화면이 나오지 않았을 수 있습니다.'
    : many
      ? ' 같은 모양의 요소가 여러 개라 하나로 정하지 못했습니다.'
      : ' 화면이 바뀌었거나 아직 뜨지 않았을 수 있습니다.';
  return `${withJosa(targetText(target), '을', '를')} 화면에서 찾지 못했습니다${where ? ` (${where})` : ''}.${why}\n자세히 — 시도한 후보: ${parts.join(' · ')}`;
}

/** 목록 항목 문맥의 프레임 (화면이 다시 그려지거나 뒤로 가도 다시 찾는다) */
export function itemFrame(item) {
  if (!item?.page || item.page.isClosed()) return null;
  return item.framePath?.length ? resolveFramePath(item.page, item.framePath) : item.page.mainFrame();
}

async function handleInItem(page, frame, chain, cand, hidden) {
  try {
    const h = await frame.evaluateHandle(([ch, c, vis]) => window.__webRpa && window.__webRpa.pickIn(ch, c, vis), [chain, cand, !hidden]);
    const el = h.asElement();
    if (!el) {
      await h.dispose();
      return null;
    }
    return { page, frame, handle: el, cand, hidden };
  } catch {
    return null;
  }
}

/** within: 'item' 대상 — 지금 목록 항목(forEach) 요소 안에서만 찾는다. 후보는 항목 기준 상대 선택자다. */
async function locateInItem(sess, target, scope, { timeout, purpose, extras, allowText }) {
  const item = scope.currentItem?.();
  if (!item) throw new Error(`"항목 안에서 찾기" 대상은 목록의 항목마다(forEach) 몸통 안에서만 쓸 수 있습니다: ${targetText(target)}`);
  // 덧붙이는 후보 중 문서 전체를 보는 XPath(라벨로 찾기)는 항목 밖을 가리킬 수 있어 뺀다
  const cands = prepareCandidates(target, scope, { extras: extras && purpose !== 'exists', allowText }).filter((c) => !(c.extra && c.kind === 'xpath'));
  if (!cands.length) throw new Error('대상 요소의 후보 선택자가 모두 비어 있습니다.');
  const deadline = Date.now() + Math.max(0, timeout);
  let hiddenSince = null;
  let counts = null;
  for (;;) {
    sess.checkAbort();
    if (item.page.isClosed()) throw new Error('목록이 있던 창이 닫혀 항목 안의 요소를 찾을 수 없습니다.');
    const frame = itemFrame(item);
    const r = frame ? await sess.callLib(frame, 'countIn', item.chain, cands).catch(() => null) : null;
    if (r?.counts) {
      counts = r.counts;
      const vi = counts.findIndex((n) => n.visible === 1);
      if (vi >= 0) {
        const got = await handleInItem(item.page, frame, item.chain, cands[vi], false);
        if (got) return got;
      }
      const hi = vi >= 0 ? -1 : counts.findIndex((n) => n.total === 1);
      if (hi >= 0) {
        hiddenSince ??= Date.now();
        if (Date.now() - hiddenSince >= HIDDEN_GRACE_MS || Date.now() >= deadline) {
          const got = await handleInItem(item.page, frame, item.chain, cands[hi], true);
          if (got) return got;
        }
      } else hiddenSince = null;
    }
    if (Date.now() >= deadline) {
      const where = r?.missing || !r ? `목록의 ${item.index}번째 항목이 화면에 없습니다` : `목록의 ${item.index}번째 항목 안에서`;
      throw new NotFoundError(describeMiss(target, cands, counts, where));
    }
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

/**
 * 대상 요소를 찾는다. target.within === 'item' 이면 지금 목록 항목 안에서만 찾는다.
 * @returns {Promise<{page, frame, handle, cand, hidden: boolean}>}
 */
export async function locate(sess, target, scope, { timeout = 10000, purpose = 'act', pageUrl, extras = true, allowText = true } = {}) {
  if (!target || !Array.isArray(target.candidates) || !target.candidates.length) throw new Error('대상 요소 정보(후보 선택자)가 없습니다.');
  if (target.within === 'item') return locateInItem(sess, target, scope, { timeout, purpose, extras, allowText });
  const cands = prepareCandidates(target, scope, { extras: extras && purpose !== 'exists', allowText });
  if (!cands.length) throw new Error('대상 요소의 후보 선택자가 모두 비어 있습니다.');
  const deadline = Date.now() + Math.max(0, timeout);
  let hiddenSince = null;
  let counts = null;
  let triedTabs = false;
  for (;;) {
    sess.checkAbort();
    const page = await sess.livePage();
    const r = await scanPage(sess, page, target.framePath, cands).catch(() => ({}));
    counts = r.counts ?? counts;
    if (r.hit) {
      const got = await handleOf(page, r.hit);
      if (got) return got;
    }
    if (r.hidden) {
      hiddenSince ??= Date.now();
      if (Date.now() - hiddenSince >= HIDDEN_GRACE_MS || Date.now() >= deadline) {
        const got = await handleOf(page, r.hidden);
        if (got) return got;
      }
    } else hiddenSince = null;
    if (purpose !== 'exists' && !r.hit) {
      // 녹화 당시 주소(meta.url)와 같은 다른 탭에 유일하게 보이면 그 탭으로 옮긴다
      if (!triedTabs && pageUrl && sess.pages().length > 1 && !sameDoc(page.url(), pageUrl)) {
        triedTabs = true;
        const other =
          (await searchOtherTabs(sess, page, target, cands, (p) => sameDoc(p.url(), pageUrl))) ??
          (await searchOtherTabs(sess, page, target, cands, (p) => samePath(p.url(), pageUrl)));
        if (other) {
          sess.switchTo(other.page, '대상이 다른 탭에 있어');
          const got = await handleOf(other.page, other.hit);
          if (got) return got;
        }
      }
    }
    if (Date.now() >= deadline) {
      if (purpose !== 'exists' && sess.pages().length > 1) {
        // 못 찾았을 때 대상이 보이는 다른 탭이 있으면 옮겨 다시 시도
        const other = await searchOtherTabs(sess, page, target, cands);
        if (other) {
          sess.switchTo(other.page, '대상이 다른 탭에 있어');
          const got = await handleOf(other.page, other.hit);
          if (got) return got;
        }
      }
      throw new NotFoundError(describeMiss(target, cands, counts));
    }
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

/**
 * 여러 요소의 목록을 찾는다 (forEach 의 items · elementCount). 후보를 점수 순으로 보고, 보이는 요소가 1개 이상 맞는 첫 후보를 쓴다.
 * target.within === 'item' 이면 바깥 목록 항목(outer) 안에서 센다.
 * @returns {Promise<{count: number, cand?: object, page?: object, framePath?: object[], chain?: object[]}>}
 */
export async function findList(sess, target, scope, { outer } = {}) {
  if (!target || !Array.isArray(target.candidates) || !target.candidates.length) throw new Error('목록 요소 정보(후보 선택자)가 없습니다.');
  const cands = prepareCandidates(target, scope, { extras: false });
  if (!cands.length) throw new Error('목록 요소의 후보 선택자가 모두 비어 있습니다.');
  if (target.within === 'item') {
    if (!outer) throw new Error(`"항목 안에서 찾기" 목록은 다른 목록의 항목마다(forEach) 몸통 안에서만 쓸 수 있습니다: ${targetText(target)}`);
    const frame = itemFrame(outer);
    const r = frame ? await sess.callLib(frame, 'countIn', outer.chain, cands).catch(() => null) : null;
    const i = r?.counts ? r.counts.findIndex((n) => n.visible >= 1) : -1;
    if (i < 0) return { count: 0 };
    return { count: r.counts[i].visible, cand: cands[i], page: outer.page, framePath: outer.framePath ?? [], chain: outer.chain };
  }
  const page = await sess.livePage();
  const resolved = target.framePath?.length ? resolveFramePath(page, target.framePath) : null;
  const frames = resolved ? [resolved] : page.frames();
  const per = await Promise.all(frames.map((f) => sess.callLib(f, 'count', cands).catch(() => null)));
  for (let i = 0; i < cands.length; i += 1) {
    let best = -1;
    let n = 0;
    per.forEach((r, j) => {
      const v = r?.[i]?.visible ?? 0;
      if (v > n) {
        n = v;
        best = j;
      }
    });
    if (best >= 0) return { count: n, cand: cands[i], page, framePath: framePathOf(frames[best]), chain: [] };
  }
  return { count: 0 };
}
