// 스텝 동작: 이동·클릭·입력·선택·체크·키·값 읽기·다운로드·첨부·팝업 닫기.
// 부작용을 두 번 내지 않는다: 클릭이 이미 나갔을 수 있는 실패에는 sideEffect 표시를 붙여 재시도하지 않게 한다.

import fs from 'node:fs';
import { locate, NotFoundError } from './locate.js';
import { saveDownload } from './output.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstLine = (s) => String(s ?? '').split('\n')[0];
const clip = (s, n = 40) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const sideEffect = (e) => Object.assign(e instanceof Error ? e : new Error(String(e)), { sideEffect: true });
const digits = (s) => String(s ?? '').replace(/\D/g, '');
const compact = (s) => String(s ?? '').replace(/\s+/g, '');
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const DEFAULT_TIMEOUT = 10000;
const OPTIONAL_TIMEOUT = 2000;
const CLICK_TIMEOUT = 5000;

/** 브라우저·창이 닫혀서 난 오류 */
const isClosedError = (e) => /Target (page, context or browser )?(has been )?closed|Target closed|page has been closed|Browser has been closed/i.test(String(e?.message));
/** 찾은 뒤 요소가 다시 그려져 문서에서 떨어졌다 — 다시 찾아야 한다 */
const isDetached = (e) => /not attached to the DOM|Element is detached|element was detached/i.test(String(e?.message));
const detachedError = () => Object.assign(new Error('대상 요소가 화면에서 다시 그려졌습니다.'), { detached: true });
/** 아직 누르지 않은 실패 (준비 대기 시간 초과·가려짐·안 보임) — 다른 방법으로 다시 해도 안전하다 */
function notDispatched(e) {
  const m = String(e?.message ?? '');
  if (/action done/.test(m)) return false; // 이미 눌렀다 (뒤따른 페이지 이동 대기가 길었을 뿐)
  return e?.name === 'TimeoutError' || /not visible|not stable|intercepts pointer events|outside of the viewport|not enabled|is disabled|not editable/i.test(m);
}

/** 스텝 대상 찾기 (기본 대기, optional 짧은 대기, timeoutMs 지정). 아직 그려지는 중이면 다 그려진 뒤 한 번 더. */
export async function locateFor(rc, step, target = step.target, { allowText = true } = {}) {
  const timeout = Number(step.timeoutMs) > 0 ? Number(step.timeoutMs) : step.optional ? OPTIONAL_TIMEOUT : DEFAULT_TIMEOUT;
  const opts = { timeout, pageUrl: step.meta?.url, allowText };
  try {
    return await locate(rc.sess, target, rc.scope, opts);
  } catch (e) {
    if (!(e instanceof NotFoundError) || step.optional) throw e;
    const page = await rc.sess.livePage();
    const state = await page.evaluate(() => document.readyState).catch(() => 'loading');
    if (state === 'complete') throw e;
    rc.log('info', '화면이 아직 그려지는 중이라 다 그려진 뒤 다시 찾습니다.');
    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
    return locate(rc.sess, target, rc.scope, { ...opts, timeout: 3000 });
  }
}

/** 화면·주소·탭·알림창·다운로드 변화 감지용 표시 */
async function markChanges(frames) {
  await Promise.all(
    frames.map((f) =>
      f
        .evaluate(() => {
          if (window.__webRpaMut) window.__webRpaMut.o.disconnect();
          const st = { n: 0 };
          st.o = new MutationObserver((list) => {
            st.n += list.length;
          });
          st.o.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
          window.__webRpaMut = st;
        })
        .catch(() => {}),
    ),
  );
}

const unmarkChanges = (frames) => Promise.all(frames.map((f) => f.evaluate(() => window.__webRpaMut && window.__webRpaMut.o.disconnect()).catch(() => {})));

/** 가려졌거나 숨은 요소: 스크립트 클릭으로 누르고, 무엇이든 바뀌었는지 확인한다. */
async function scriptClick(rc, loc, double) {
  const frames = [...new Set([loc.frame, loc.page.mainFrame()])];
  try {
    return await scriptClickOnce(rc, loc, double, frames);
  } finally {
    if (!loc.page.isClosed()) await unmarkChanges(frames);
  }
}

async function scriptClickOnce(rc, loc, double, frames) {
  const { sess } = rc;
  const page = loc.page;
  const before = { url: page.url(), pages: sess.pages().length, dialogs: sess.dialogs.length, downloads: sess.downloadCount };
  if (!(await loc.handle.evaluate((el) => el.isConnected).catch(() => false))) throw detachedError();
  await markChanges(frames);
  try {
    await loc.handle.evaluate((el, dbl) => {
      el.click();
      if (dbl) {
        el.click();
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true, detail: 2, view: window }));
      }
    }, double);
  } catch (e) {
    if (page.isClosed() || isClosedError(e)) return 'closed';
    if (!/Execution context was destroyed|navigat/i.test(e.message)) throw sideEffect(e);
    return 'changed';
  }
  for (let i = 0; i < 8; i += 1) {
    await sleep(100);
    if (page.isClosed()) return 'closed';
    if (page.url() !== before.url || sess.pages().length !== before.pages || sess.dialogs.length !== before.dialogs || sess.downloadCount !== before.downloads) return 'changed';
    const muts = await Promise.all(frames.map((f) => f.evaluate(() => (window.__webRpaMut ? window.__webRpaMut.n : 1)).catch(() => 1)));
    if (muts.some((n) => n > 0)) return 'changed';
  }
  return null;
}

/** 클릭 (가려졌거나 숨은 요소는 스크립트 클릭으로 대신하되 변화를 확인한다). */
export async function clickElement(rc, loc, { double = false } = {}) {
  const page = loc.page;
  if (rc.guardClick) await rc.guardClick(loc);
  if (!loc.hidden) {
    try {
      if (double) await loc.handle.dblclick({ timeout: CLICK_TIMEOUT });
      else await loc.handle.click({ timeout: CLICK_TIMEOUT });
      return page.isClosed() ? '누른 뒤 창이 닫힘' : undefined;
    } catch (e) {
      if (page.isClosed() || isClosedError(e)) return '누른 뒤 창이 닫힘';
      if (/action done/.test(e.message)) return undefined; // 눌렀고, 뒤따른 이동이 오래 걸릴 뿐
      if (isDetached(e)) throw detachedError();
      if (!notDispatched(e)) {
        if (/Execution context was destroyed|navigat/i.test(e.message)) return undefined;
        throw sideEffect(new Error(`클릭 중 오류: ${firstLine(e.message)}`));
      }
      rc.log('warn', `일반 클릭이 되지 않아(${clickReason(e)}) 스크립트 클릭으로 대신합니다.`);
    }
  } else rc.log('info', '대상이 화면에 보이지 않아 스크립트 클릭으로 누릅니다.');
  const r = await scriptClick(rc, loc, double);
  if (r === 'closed') return '누른 뒤 창이 닫힘';
  if (!r) throw sideEffect(new Error('스크립트 클릭 뒤 화면·주소·탭·알림창에 아무 변화가 없습니다. 대상이 맞는지 확인해 주세요.'));
  return '스크립트 클릭';
}

function clickReason(e) {
  const m = String(e.message);
  const intercept = /(<[^>]{1,80}>)[^\n]*intercepts pointer events/.exec(m);
  if (intercept) return `${intercept[1]} 이(가) 가림`;
  if (/not visible/.test(m)) return '보이지 않음';
  if (/not enabled|disabled/.test(m)) return '비활성';
  if (/not stable/.test(m)) return '움직이는 중';
  return '준비 시간 초과';
}

// ---------- 입력 ----------
const readValue = (h) => h.evaluate((el) => (el.isContentEditable && !('value' in el) ? el.innerText : String(el.value ?? '')));
const setByScript = (h, value) =>
  h.evaluate((el, v) => {
    if (el.isContentEditable && !('value' in el)) {
      el.focus();
      el.textContent = v;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
      return;
    }
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);

/** 넣은 값이 반영됐는지: 같거나, 공백만 다르거나, 마스크 칸(자동 하이픈 등)이면 숫자만 같으면 된다. */
function reflected(actual, value) {
  if (actual === value || norm(actual) === norm(value)) return true;
  const d = digits(value);
  return !!d && digits(actual) === d && /^[\d\s\-().+/:]*$/.test(actual);
}

export async function doInput(rc, step) {
  const value = rc.scope.resolve(step.value ?? '');
  const secret = rc.scope.isSecret(step.value);
  const shown = (v) => (secret ? '••••' : `"${clip(v)}"`);
  const loc = await locateFor(rc, step);
  const h = loc.handle;
  const info = await h.evaluate((el) => ({ tag: el.tagName, type: (el.getAttribute('type') || '').toLowerCase(), readOnly: !!el.readOnly, disabled: !!el.disabled, editable: el.isContentEditable }));
  if (!['INPUT', 'TEXTAREA'].includes(info.tag) && !info.editable) throw new Error(`입력할 수 없는 요소입니다 (<${info.tag.toLowerCase()}>). 대상 요소를 확인해 주세요.`);
  let how = '';
  if (!loc.hidden && !info.readOnly && !info.disabled) {
    try {
      await h.fill(value, { timeout: CLICK_TIMEOUT });
    } catch (e) {
      if (isDetached(e)) throw detachedError();
      if (/Malformed value/i.test(e.message)) throw new Error(`이 칸(${info.type || 'input'})에 넣을 수 없는 형식의 값입니다: ${shown(value)}${info.type === 'date' ? ' — 날짜는 YYYY-MM-DD 형식이어야 합니다' : ''}`);
      if (!notDispatched(e)) throw e;
      await setByScript(h, value);
      how = '스크립트로 값 넣음';
    }
  } else {
    if (!(await h.evaluate((el) => el.isConnected))) throw detachedError();
    await setByScript(h, value);
    how = '숨은·읽기 전용 칸이라 스크립트로 값 넣음';
  }
  let actual = await readValue(h);
  if (reflected(actual, value)) return how || undefined;
  // 반영이 안 되면 실제 키 입력으로 다시 넣는다
  if (!info.readOnly && !info.disabled && !['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(info.type)) {
    await h.fill('', { timeout: CLICK_TIMEOUT }).catch(() => setByScript(h, ''));
    await h.focus().catch(() => {});
    await loc.page.keyboard.type(value, { delay: 20 });
    actual = await readValue(h);
    if (reflected(actual, value)) return '키 입력으로 다시 넣음';
  }
  throw new Error(`입력값이 반영되지 않았습니다: 넣은 값 ${shown(value)}, 화면 값 ${shown(actual)}`);
}

// ---------- 선택 ----------
export async function doSelect(rc, step) {
  const want = rc.scope.resolve(step.value ?? '');
  const wantLabel = step.label ? rc.scope.resolve(step.label) : '';
  const loc = await locateFor(rc, step);
  const h = loc.handle;
  const options = await h.evaluate((el) => (el.tagName === 'SELECT' ? [...el.options].map((o) => ({ value: o.value, label: (o.label || o.text).replace(/\s+/g, ' ').trim(), disabled: o.disabled })) : null));
  if (!options) throw new Error('목록(select)이 아닌 요소입니다. 대상 요소를 확인해 주세요.');
  // 값 → 보이는 글자 → 띄어쓰기 무시 비교 순으로 찾는다
  const find = (w) => {
    if (w === undefined || w === null) return null;
    const s = String(w);
    return options.find((o) => o.value === s) ?? options.find((o) => o.label === s.trim()) ?? options.find((o) => compact(o.label) === compact(s)) ?? options.find((o) => compact(o.value) === compact(s) && compact(s) !== '');
  };
  const opt = (want !== '' || !wantLabel ? find(want) : null) ?? (wantLabel ? find(wantLabel) : null);
  if (!opt) throw new Error(`목록에 "${clip(want || wantLabel)}" 항목이 없습니다. 있는 항목: ${options.map((o) => o.label || o.value).slice(0, 15).join(', ')}`);
  try {
    await h.selectOption({ value: opt.value }, { timeout: CLICK_TIMEOUT, force: loc.hidden });
  } catch (e) {
    if (isDetached(e)) throw detachedError();
    if (!notDispatched(e)) throw e;
    await setByScript(h, opt.value);
  }
  const now = await h.evaluate((el) => el.value);
  if (now !== opt.value) throw new Error(`목록 선택이 반영되지 않았습니다: "${clip(opt.label)}"`);
  return opt.label !== want ? `"${clip(opt.label)}" 선택` : undefined;
}

// ---------- 체크 ----------
export async function doCheck(rc, step) {
  const want = step.checked !== false;
  const loc = await locateFor(rc, step);
  const h = loc.handle;
  const state = await h.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    const box = el.tagName === 'INPUT' && ['checkbox', 'radio'].includes((el.type || '').toLowerCase());
    return { box, type: (el.type || '').toLowerCase(), checked: box ? !!el.checked : el.getAttribute('aria-checked') === 'true', aria: el.getAttribute('aria-checked'), tiny: r.width < 6 || r.height < 6 || Number(st.opacity) < 0.1 };
  });
  if (!state.box && state.aria === null) throw new Error('체크박스·라디오 버튼이 아닌 요소입니다.');
  if (state.checked === want) return '이미 원하는 상태라 누르지 않았습니다';
  if (state.type === 'radio' && !want) throw new Error('라디오 버튼은 체크 해제할 수 없습니다. 다른 항목을 체크해 주세요.');
  const readNow = () => h.evaluate((el) => (el.tagName === 'INPUT' ? !!el.checked : el.getAttribute('aria-checked') === 'true'));
  const ways = [];
  if (!loc.hidden && !state.tiny) ways.push('click');
  ways.push('label', 'script');
  for (const way of ways) {
    if (way === 'click') {
      try {
        await h.click({ timeout: 3000 });
      } catch (e) {
        if (isDetached(e)) throw detachedError();
        if (!notDispatched(e)) throw sideEffect(e);
        continue;
      }
    } else if (way === 'label') {
      // 화면에 거의 안 보이는 커스텀 체크박스: 연결된 라벨을 누른다
      const lh = await h.evaluateHandle((el) => (el.labels && el.labels[0]) || el.closest('label') || null);
      const label = lh.asElement();
      if (!label) continue;
      try {
        await label.click({ timeout: 3000 });
      } catch (e) {
        if (!notDispatched(e)) throw sideEffect(e);
        continue;
      }
    } else await h.evaluate((el) => el.click());
    await sleep(60);
    if ((await readNow()) === want) return way === 'click' ? undefined : way === 'label' ? '연결된 라벨을 눌러 체크' : '스크립트 클릭으로 체크';
  }
  throw sideEffect(new Error(`체크 상태를 ${want ? '체크' : '해제'}로 바꾸지 못했습니다.`));
}

// ---------- 키 ----------
const KEY_NAMES = { enter: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: ' ', backspace: 'Backspace', delete: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', ctrl: 'Control', control: 'Control', alt: 'Alt', shift: 'Shift', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown' };
export const normalizeKey = (k) =>
  String(k ?? '')
    .split('+')
    .map((p) => KEY_NAMES[p.trim().toLowerCase()] ?? (p.trim().length === 1 ? p.trim() : p.trim()))
    .join('+');

export async function doKeypress(rc, step) {
  const key = normalizeKey(rc.scope.resolve(step.key));
  if (!key) throw new Error('누를 키가 없습니다.');
  if (step.target) {
    const loc = await locateFor(rc, step);
    try {
      await loc.handle.press(key, { timeout: CLICK_TIMEOUT });
    } catch (e) {
      if (loc.page.isClosed() || isClosedError(e)) return '누른 뒤 창이 닫힘';
      if (/Execution context was destroyed|navigat/i.test(e.message)) return undefined;
      throw sideEffect(e);
    }
    return loc.page.isClosed() ? '누른 뒤 창이 닫힘' : undefined;
  }
  const page = await rc.sess.livePage();
  try {
    await page.keyboard.press(key);
  } catch (e) {
    if (page.isClosed() || isClosedError(e)) return '누른 뒤 창이 닫힘';
    throw sideEffect(e);
  }
  return undefined;
}

// ---------- 값 읽기 ----------
export async function doExtract(rc, step) {
  // 행마다 글자가 바뀌는 값이므로 보이는 글자로 넓혀 찾지 않는다
  const loc = await locateFor(rc, step, step.target, { allowText: false });
  const value = await loc.handle.evaluate(
    (el, attr) => (window.__webRpa ? window.__webRpa.valueOf(el, attr) : attr ? (el.getAttribute(attr) ?? '') : String(el.value ?? el.innerText ?? '')),
    step.attr || null,
  );
  const name = String(step.saveAs).trim();
  rc.scope.extracted[name] = String(value ?? '');
  return `{{${name}}} = "${clip(value, 60)}"`;
}

// ---------- 이동 ----------
export async function doNavigate(rc, step) {
  const url = rc.scope.resolve(step.url ?? '').trim();
  if (!url) throw new Error('이동할 주소가 비어 있습니다.');
  const page = await rc.sess.livePage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Number(step.timeoutMs) > 0 ? Number(step.timeoutMs) : 30000 });
  } catch (e) {
    if (/Download is starting|net::ERR_ABORTED/i.test(e.message)) return '주소가 파일 다운로드로 바뀜';
    throw new Error(`주소를 열지 못했습니다: ${url} (${firstLine(e.message)})`);
  }
  await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
  return undefined;
}

// ---------- 다운로드 ----------
export async function doDownload(rc, step) {
  const loc = await locateFor(rc, step);
  const clickPage = loc.page;
  const before = new Set(rc.sess.pages());
  const timeout = Math.max(60000, Number(step.timeoutMs) || 0);
  const waiter = rc.sess.waitDownload(timeout);
  try {
    await clickElement(rc, loc);
  } catch (e) {
    waiter.cancel();
    throw e.detached ? e : sideEffect(e);
  }
  const dl = await waiter.promise;
  const name = await saveDownload(rc, step, dl);
  // 다운로드 때문에 새로 열린 창(빈 창·스스로 닫히는 창)은 닫고 원래 창으로 돌아온다
  const dpage = dl.page();
  if (dpage && dpage !== clickPage && !before.has(dpage) && dpage !== rc.sess.work && !dpage.isClosed()) {
    rc.sess.quietClose = true;
    await Promise.race([dpage.close().catch(() => {}), sleep(3000)]);
    rc.sess.quietClose = false;
  }
  const cur = rc.sess.current;
  if (!clickPage.isClosed() && cur !== clickPage && (!cur || cur.isClosed() || (!before.has(cur) && cur.url() === 'about:blank'))) rc.sess.current = clickPage;
  return name;
}

// ---------- 첨부 ----------
export async function doUpload(rc, step) {
  const raw = rc.scope.resolve(step.path ?? '');
  const files = raw
    .split(/\r?\n|\|/)
    .map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  if (!files.length) throw new Error('첨부할 파일 경로가 비어 있습니다.');
  for (const f of files) if (!fs.existsSync(f)) throw new Error(`첨부할 파일이 없습니다: ${f}`);
  const loc = await locateFor(rc, step);
  const isFileInput = await loc.handle.evaluate((el) => el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'file');
  try {
    if (isFileInput) await loc.handle.setInputFiles(files);
    else {
      // 버튼을 눌러 뜨는 파일 선택창에 넣는다
      const chooser = loc.page.waitForEvent('filechooser', { timeout: 15000 });
      chooser.catch(() => {});
      await clickElement(rc, loc);
      let fc;
      try {
        fc = await chooser;
      } catch {
        throw new Error('버튼을 눌렀지만 파일 선택창이 뜨지 않았습니다.');
      }
      await fc.setFiles(files);
    }
  } catch (e) {
    throw sideEffect(e);
  }
  return files.map((f) => f.split(/[\\/]/).pop()).join(', ');
}

// ---------- 팝업 닫기 ----------
export async function doCloseTab(rc) {
  const p = rc.sess.page;
  if (!p || p === rc.sess.work || p.isClosed()) {
    rc.log('info', '닫을 팝업 창이 없어(이미 닫힘) 건너뜁니다.');
    return '이미 닫혀 건너뜀';
  }
  await p.close().catch(() => {});
  return undefined;
}
