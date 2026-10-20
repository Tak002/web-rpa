// 페이지 안에서 쓰는 요소 도구 — 녹화기·실행기·AI 관찰기가 같은 규칙을 쓴다.
// 문서마다 설치되며 window.__webRpa 로 노출된다: 타겟 번들 만들기(targetOf), 후보로 찾기(find·count),
// 글자 확인(hasText), 값 읽기(valueOf), 화면 요소 목록(snapshot).
(() => {
  const VERSION = 4;
  const W = window;
  if (W.__webRpa && W.__webRpa.version === VERSION) return true;

  const norm = (s) => String(s ?? '').replace(/[\s ​﻿]+/g, ' ').trim();
  const compact = (s) => norm(s).replace(/\s/g, '');
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const lower = (el) => el.tagName.toLowerCase();
  const typeOf = (el) => (el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : '');
  const cssStr = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const xq = (s) => {
    s = String(s);
    if (!s.includes("'")) return `'${s}'`;
    if (!s.includes('"')) return `"${s}"`;
    return `concat(${s.split("'").map((p) => `'${p}'`).join(`, "'", `)})`;
  };

  // ---------- 문서 + 열린 섀도 루트 ----------
  let rootsCache = { doc: null, at: 0, roots: [] };
  function allRoots() {
    const doc = document;
    const now = Date.now();
    if (rootsCache.doc === doc && now - rootsCache.at < 250) return rootsCache.roots;
    const roots = [doc];
    const walk = (root) => {
      const it = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (let n = it.nextNode(); n; n = it.nextNode()) {
        if (n.shadowRoot) {
          roots.push(n.shadowRoot);
          walk(n.shadowRoot);
        }
      }
    };
    walk(doc);
    rootsCache = { doc, at: now, roots };
    return roots;
  }
  function queryAll(sel) {
    const out = [];
    const seen = new Set();
    for (const r of allRoots()) {
      for (const el of r.querySelectorAll(sel)) {
        if (!seen.has(el)) {
          seen.add(el);
          out.push(el);
        }
      }
    }
    return out;
  }

  // ---------- 글자·이름 ----------
  function textOf(el) {
    if (!el || el.nodeType !== 1) return '';
    const t = typeOf(el);
    if (el.tagName === 'INPUT') return ['button', 'submit', 'reset'].includes(t) ? norm(el.value) : t === 'image' ? norm(el.alt) : '';
    if (el.tagName === 'IMG') return norm(el.alt);
    if (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return '';
    return norm(el.innerText ?? el.textContent);
  }
  function labelText(label) {
    const c = label.cloneNode(true);
    for (const x of c.querySelectorAll('input, select, textarea, option, script, style')) x.remove();
    return norm(c.textContent);
  }
  function labelOf(el) {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const root = el.getRootNode();
      const t = norm(
        by
          .split(/\s+/)
          .map((id) => (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id))
          .filter(Boolean)
          .map((x) => x.innerText || x.textContent)
          .join(' '),
      );
      if (t) return clip(t, 80);
    }
    const aria = norm(el.getAttribute('aria-label'));
    if (aria) return clip(aria, 80);
    if (el.labels && el.labels.length) {
      const t = labelText(el.labels[0]);
      if (t) return clip(t, 80);
    }
    for (const a of ['placeholder', 'title', 'alt']) {
      const v = norm(el.getAttribute(a));
      if (v) return clip(v, 80);
    }
    return '';
  }

  // ---------- 보임 ----------
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.visibility === 'collapse') return false;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return true;
    if (st.display === 'contents') return [...el.children].some(visible);
    return false;
  }

  // ---------- 후보로 찾기 ----------
  function find(c) {
    const v = c && c.value;
    if (!c) return [];
    if (c.kind === 'xpath') {
      const r = document.evaluate(String(v), document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const out = [];
      for (let i = 0; i < r.snapshotLength; i += 1) {
        let n = r.snapshotItem(i);
        if (n && n.nodeType !== 1) n = n.parentElement;
        if (n && !out.includes(n)) out.push(n);
      }
      return out;
    }
    if (c.kind === 'text') {
      const want = norm(v && v.text);
      if (!want) return [];
      const tag = String((v && v.tag) || '*').toLowerCase();
      return queryAll(tag).filter((el) => textOf(el) === want);
    }
    return queryAll(String(v)); // css · attr
  }
  /** 후보마다 { total, visible } */
  function count(cands) {
    return cands.map((c) => {
      try {
        const els = find(c);
        return { total: els.length, visible: els.filter(visible).length };
      } catch (e) {
        return { total: 0, visible: 0, error: String((e && e.message) || e).slice(0, 200) };
      }
    });
  }
  /** 유일한 요소 하나 (보이는 것 우선) */
  function pick(c, wantVisible) {
    const els = find(c);
    const vis = els.filter(visible);
    if (wantVisible) return vis.length === 1 ? vis[0] : null;
    return els.length === 1 ? els[0] : null;
  }

  // ---------- 바뀌는 id 판별 ----------
  function volatileToken(t) {
    if (/\d{4,}/.test(t)) return true; // 긴 숫자 덩어리 (시각·순번)
    if (/^[0-9a-f]{6,}$/i.test(t) && /\d.*\d/.test(t) && /[a-f].*[a-f]/i.test(t)) return true; // 무작위 16진수
    if (/^[0-9a-z]{16,}$/i.test(t) && /\d/.test(t) && /[a-z]/i.test(t)) return true; // 긴 해시
    return false;
  }
  function isVolatile(s) {
    s = String(s ?? '');
    if (!s) return false;
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(s)) return true; // UUID
    if (/^:r[0-9a-z]*:$|^«r[0-9a-z]*»$/i.test(s)) return true; // React useId
    return s.split(/[-_:.\s/]+/).some(volatileToken);
  }
  /** 바뀌는 부분 앞·뒤의 안정된 글자 */
  function stableParts(id) {
    const parts = id.split(/([-_:.]+)/);
    const vol = parts.map((p, i) => i % 2 === 0 && volatileToken(p));
    const first = vol.indexOf(true);
    const last = vol.lastIndexOf(true);
    if (first < 0) {
      const m = /^(\D*)\d+(\D*)$/.exec(id);
      return m ? { prefix: m[1], suffix: m[2] } : { prefix: '', suffix: '' };
    }
    let prefix = parts.slice(0, first).join('');
    let suffix = parts.slice(last + 1).join('');
    if (!prefix) prefix = (/^[^\d]*/.exec(parts[first]) || [''])[0];
    if (!suffix) suffix = (/[^\d]*$/.exec(parts[last]) || [''])[0];
    return { prefix, suffix };
  }

  // ---------- 구조 선택자 ----------
  function cssPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const id = cur.getAttribute('id');
      if (cur !== el && id && !isVolatile(id) && /^[A-Za-z][\w-]*$/.test(id)) {
        parts.unshift(`#${id}`);
        break;
      }
      let part = lower(cur);
      const parent = cur.parentElement;
      if (part === 'html') break;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      if (!parent || part === 'body') break;
      cur = parent;
    }
    return parts.join(' > ');
  }
  function absXPath(el) {
    const parts = [];
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      const parent = cur.parentElement;
      let part = lower(cur);
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += `[${same.indexOf(cur) + 1}]`;
      }
      parts.unshift(part);
    }
    return `/${parts.join('/')}`;
  }
  const isFormControl = (el) => (el.tagName === 'INPUT' && !['button', 'submit', 'reset', 'image'].includes(typeOf(el))) || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA';

  /** 표 안 요소: 같은 줄의 첫 글자 칸(열쇠)과 머리글 */
  function rowInfo(el) {
    const tr = el.closest('tr');
    if (!tr || tr === el) return null;
    const cells = [...tr.children].filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
    const own = cells.find((c) => c === el || c.contains(el)) ?? null;
    const texts = cells.map((c) => norm(c.textContent));
    const ok = (t) => t && t.length <= 40;
    const keyIdx = texts.findIndex((t, i) => ok(t) && cells[i] !== own); // 경로용 열쇠 칸 (자기 칸 제외)
    const firstIdx = texts.findIndex(ok); // 사람에게 보여 줄 줄 이름 (첫 글자 칸)
    let col = '';
    const table = tr.closest('table');
    if (own && table) {
      const head = (table.tHead && table.tHead.rows[0]) || table.rows[0];
      if (head && head !== tr) {
        const hc = [...head.children].filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
        col = norm(hc[cells.indexOf(own)]?.textContent ?? '');
      }
    }
    return {
      cells,
      own,
      key: keyIdx >= 0 ? texts[keyIdx] : '',
      keyIdx: keyIdx + 1,
      rowName: firstIdx >= 0 && cells[firstIdx] !== own ? texts[firstIdx] : '',
      col: clip(col, 30),
    };
  }
  function rowXPath(el) {
    const ri = rowInfo(el);
    if (!ri || !ri.key || el.getRootNode() !== document) return null;
    const row = `//tr[*[${ri.keyIdx}][normalize-space()=${xq(ri.key)}]]`;
    const tag = lower(el);
    const t = textOf(el);
    if (t && t.length <= 40 && !isFormControl(el)) return `${row}//${tag}[normalize-space()=${xq(t)}]`;
    if (!ri.own) return null;
    const ci = ri.cells.indexOf(ri.own) + 1;
    if (ri.own === el) return `${row}/*[${ci}]`;
    const same = [...ri.own.querySelectorAll(tag)];
    return `(${row}/*[${ci}]//${tag})[${same.indexOf(el) + 1}]`;
  }

  // ---------- 타겟 번들 ----------
  /** 요소 → { candidates, meta } (framePath 는 Node 쪽에서 붙인다) */
  function targetOf(el) {
    if (el && el.nodeType !== 1) el = el.parentElement;
    if (!el) throw new Error('요소가 없습니다.');
    const tag = lower(el);
    const type = typeOf(el);
    const inShadow = el.getRootNode() instanceof ShadowRoot;
    const cands = [];
    const seen = new Set();
    const add = (kind, value, score, { keepAmbiguous = false } = {}) => {
      if (!value) return;
      const key = `${kind}:${typeof value === 'string' ? value : JSON.stringify(value)}`;
      if (seen.has(key)) return;
      seen.add(key);
      let els;
      try {
        els = find({ kind, value });
      } catch {
        return;
      }
      if (!els.includes(el)) return; // 이 요소를 못 가리키는 후보
      if (els.length === 1) cands.push({ kind, value, score });
      else if (keepAmbiguous) cands.push({ kind, value, score: Math.max(5, 20 - els.length) });
    };
    const id = el.getAttribute('id');
    if (id) {
      const idSel = `#${CSS.escape(id)}`;
      if (!isVolatile(id)) add('css', idSel, 95);
      else {
        add('css', idSel, 30);
        const { prefix, suffix } = stableParts(id);
        if (prefix.length >= 3) add('attr', `${tag}[id^="${cssStr(prefix)}"]`, 80);
        if (suffix.length >= 3) add('attr', `${tag}[id$="${cssStr(suffix)}"]`, 76);
        if (prefix.length >= 2 && suffix.length >= 2) add('attr', `${tag}[id^="${cssStr(prefix)}"][id$="${cssStr(suffix)}"]`, 78);
      }
    }
    for (const a of ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy']) {
      const v = el.getAttribute(a);
      if (v && !isVolatile(v)) add('attr', `[${a}="${cssStr(v)}"]`, 93);
    }
    const name = el.getAttribute('name');
    if (name && !isVolatile(name)) {
      const value = el.getAttribute('value');
      if ((type === 'radio' || type === 'checkbox') && value !== null) add('attr', `${tag}[name="${cssStr(name)}"][value="${cssStr(value)}"]`, 90);
      add('attr', `${tag}[name="${cssStr(name)}"]`, 88);
    }
    const aria = el.getAttribute('aria-label');
    if (aria && !isVolatile(aria)) add('attr', `${tag}[aria-label="${cssStr(aria)}"]`, 84);
    const ph = el.getAttribute('placeholder');
    if (ph) add('attr', `${tag}[placeholder="${cssStr(ph)}"]`, 80);
    // 라벨로 찾기 (바뀌는 id 를 라벨의 for 로 잇는다)
    if (isFormControl(el) && !inShadow && el.labels && el.labels.length) {
      const lt = labelText(el.labels[0]);
      if (lt && lt.length <= 40) {
        if (id && el.labels[0].getAttribute('for') === id) add('xpath', `//${tag}[@id=//label[normalize-space()=${xq(lt)}]/@for]`, 82);
        else if (el.labels[0].contains(el)) add('xpath', `//label[normalize-space()=${xq(lt)}]//${tag}`, 81);
      }
    }
    const text = textOf(el);
    if (text && text.length <= 60 && !isFormControl(el)) add('text', { tag, text }, 75, { keepAmbiguous: true });
    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (href && !/^(#|javascript:|data:|blob:)/i.test(href) && !/[?#]/.test(href) && !isVolatile(href)) add('attr', `a[href="${cssStr(href)}"]`, 72);
    }
    for (const a of ['title', 'alt', 'part']) {
      const v = el.getAttribute(a);
      if (v && !isVolatile(v) && v.length <= 60) add('attr', `${tag}[${a}="${cssStr(v)}"]`, 70);
    }
    const rx = rowXPath(el);
    if (rx) add('xpath', rx, 68);
    add('css', cssPath(el), 55);
    if (!inShadow) add('xpath', absXPath(el), 40);
    cands.sort((a, b) => b.score - a.score);

    const meta = { tag };
    if (type) meta.type = type;
    if (text) meta.text = clip(text, 80);
    const label = labelOf(el);
    if (label) meta.label = label;
    if (name) meta.name = name;
    if (inShadow) meta.inShadow = true;
    const r = el.getBoundingClientRect();
    meta.rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    return { candidates: cands.slice(0, 8), meta };
  }

  // ---------- 값·글자 ----------
  function valueOf(el, attr) {
    if (attr) {
      if (attr === 'value' && 'value' in el) return String(el.value ?? '');
      if (attr === 'href' && el.href) return String(el.href);
      if (attr === 'checked' && 'checked' in el) return String(!!el.checked);
      return el.getAttribute(attr) ?? '';
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return String(el.value ?? '');
    return norm(el.innerText ?? el.textContent);
  }
  /** 이 문서(섀도 포함)에 그 글자가 보이는지 */
  function hasText(text, exact) {
    const want = norm(text);
    if (!want) return false;
    for (const root of allRoots()) {
      const host = root === document ? document.body : root;
      if (!host) continue;
      const blob = root === document ? norm(document.body.innerText) : norm([...root.children].map((c) => c.innerText || '').join(' '));
      if (!blob.includes(want)) continue;
      if (!exact) return true;
      for (const el of root.querySelectorAll('*')) {
        const tc = el.textContent;
        if (!tc || tc.length > want.length * 3 + 40 || !tc.includes(want.slice(0, 1))) continue;
        if (norm(el.innerText) === want && visible(el)) return true;
      }
    }
    return false;
  }

  // ---------- 화면 요소 목록 (AI 관찰) ----------
  const INTERACTIVE = 'a[href], a[onclick], button, input, select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=option], [role=switch], [role=combobox], [role=textbox], [onclick], [contenteditable=""], [contenteditable=true]';
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'IFRAME', 'FRAME', 'SVG', 'OPTION', 'BR', 'HR']);
  function roleOf(el) {
    const t = typeOf(el);
    const role = el.getAttribute('role');
    if (el.tagName === 'BUTTON' || ['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
    if (el.tagName === 'A') return 'link';
    if (t === 'checkbox' || t === 'radio') return t;
    if (t === 'file') return 'file';
    if (el.tagName === 'INPUT') return t === 'text' ? 'input' : `input[${t}]`;
    if (el.tagName === 'SELECT') return 'select';
    if (el.tagName === 'TEXTAREA') return 'textarea';
    if (role) return role;
    if (el.isContentEditable) return 'editable';
    return lower(el);
  }
  const ownText = (el) => norm([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(' '));
  const quote = (s) => `"${clip(norm(s).replace(/"/g, "'"), 80)}"`;
  function describe(el) {
    const role = roleOf(el);
    const inter = el.matches(INTERACTIVE);
    let name = inter ? labelOf(el) || textOf(el) : textOf(el);
    if (!name && el.tagName === 'INPUT') name = el.getAttribute('name') || el.id || '';
    let line = `${role} ${quote(name)}`;
    const ri = rowInfo(el);
    if (ri) {
      if (ri.rowName) line += ` row=${quote(ri.rowName)}`;
      if (ri.col) line += ` col=${quote(ri.col)}`;
    }
    const t = typeOf(el);
    if (t === 'checkbox' || t === 'radio') line += el.checked ? ' checked' : ' unchecked';
    else if (t === 'password') line += el.value ? ' value="••••"' : '';
    else if (el.tagName === 'SELECT') {
      const opt = el.selectedOptions[0];
      line += ` value=${quote(el.value)}${opt ? ` 보이는값=${quote(opt.text)}` : ''}`;
      const opts = [...el.options].slice(0, 12).map((o) => norm(o.text)).join(' | ');
      line += ` 옵션: ${clip(opts, 160)}`;
    } else if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && t !== 'file' && !['button', 'submit', 'reset', 'image'].includes(t)) {
      if (el.value) line += ` value=${quote(el.value)}`;
    }
    if (el.disabled) line += ' disabled';
    if (el.tagName === 'A' && el.getAttribute('href') && !/^javascript:/i.test(el.getAttribute('href'))) line += ` href=${quote(el.getAttribute('href'))}`;
    if (el.getRootNode() instanceof ShadowRoot) line += ' [shadow]';
    return line;
  }
  function snapshot(max = 300) {
    const refs = [];
    const lines = [];
    const listed = new Set();
    const walk = (root) => {
      const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
        acceptNode: (n) => (SKIP.has(n.tagName.toUpperCase()) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      for (let el = it.nextNode(); el; el = it.nextNode()) {
        if (refs.length >= max) return;
        const inter = el.matches(INTERACTIVE) && !(el.tagName === 'INPUT' && typeOf(el) === 'hidden');
        let take = false;
        if (inter) take = visible(el);
        else if (ownText(el)) {
          let p = el.parentElement;
          let insideListed = false;
          for (let k = 0; p && k < 6; k += 1, p = p.parentElement) if (listed.has(p) && p.matches(INTERACTIVE)) insideListed = true;
          take = !insideListed && visible(el);
        }
        if (take) {
          listed.add(el);
          refs.push(el);
          lines.push(`e${refs.length} ${describe(el)}`);
        }
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    if (document.body) walk(document.body);
    Object.defineProperty(W, '__webRpaRefs', { value: refs, configurable: true, writable: true });
    return { lines, truncated: refs.length >= max, title: document.title, url: location.href };
  }
  function targetOfRef(n) {
    const el = (W.__webRpaRefs || [])[Number(n) - 1];
    if (!el || !el.isConnected) throw new Error('참조한 요소가 화면에서 사라졌습니다. 화면을 다시 관찰해 주세요.');
    return targetOf(el);
  }

  const api = { version: VERSION, norm, compact, textOf, labelOf, visible, find, count, pick, targetOf, valueOf, hasText, snapshot, targetOfRef, isVolatile, stableParts, allRoots };
  Object.defineProperty(W, '__webRpa', { value: api, configurable: true, writable: true, enumerable: false });
  return true;
})()
