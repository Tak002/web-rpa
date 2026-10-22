// 페이지 안에서 쓰는 요소 도구 — 녹화기·실행기·AI 관찰기가 같은 규칙을 쓴다.
// 문서마다 설치되며 window.__webRpa 로 노출된다: 타겟 번들 만들기(targetOf), 후보로 찾기(find·count),
// 글자 확인(hasText), 값 읽기(valueOf), 화면 요소 목록(snapshot), 목록 항목 도구(countIn·pickIn·itemInfo·listTargetOf·relativeTargetOf).
(() => {
  const VERSION = 6;
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
  function refEl(n) {
    const el = (W.__webRpaRefs || [])[Number(n) - 1];
    if (!el || !el.isConnected) throw new Error('참조한 요소가 화면에서 사라졌습니다. 화면을 다시 관찰해 주세요.');
    return el;
  }
  function targetOfRef(n) {
    return targetOf(refEl(n));
  }

  // ---------- 목록 항목 (forEach) ----------
  /** root 안에서 후보로 찾기 — 항목 기준 상대 선택자(css td:nth-child(3), :scope > td, xpath .//a, 글자). root 자신도 맞으면 넣는다. */
  function findIn(root, c) {
    if (!root || !c) return [];
    const v = c.value;
    if (c.kind === 'xpath') {
      const r = document.evaluate(String(v), root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
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
      const all = [...(root.matches(tag) ? [root] : []), ...root.querySelectorAll(tag)];
      return all.filter((el) => textOf(el) === want);
    }
    const sel = String(v);
    return [...(root.matches(sel) ? [root] : []), ...root.querySelectorAll(sel)];
  }
  /** 항목 사슬 [{ c, i }] → 지금 항목 요소. 바깥 항목부터, 단계마다 보이는 요소 중 i 번째(0부터). */
  function itemRoot(chain) {
    let root = null;
    for (const link of chain || []) {
      const els = (root ? findIn(root, link.c) : find(link.c)).filter(visible);
      root = els[link.i] || null;
      if (!root) return null;
    }
    return root;
  }
  /** 항목 안에서 후보마다 { total, visible }. 항목이 없으면 { missing: true } */
  function countIn(chain, cands) {
    const root = itemRoot(chain);
    if (!root) return { missing: true };
    return {
      counts: cands.map((c) => {
        try {
          const els = findIn(root, c);
          return { total: els.length, visible: els.filter(visible).length };
        } catch (e) {
          return { total: 0, visible: 0, error: String((e && e.message) || e).slice(0, 200) };
        }
      }),
    };
  }
  /** 항목 안의 유일한 요소 하나 */
  function pickIn(chain, c, wantVisible) {
    const root = itemRoot(chain);
    if (!root) return null;
    const els = findIn(root, c);
    const vis = els.filter(visible);
    if (wantVisible) return vis.length === 1 ? vis[0] : null;
    return els.length === 1 ? els[0] : null;
  }
  /** 항목의 글자({{item.text}})와 표의 칸 글자({{item.cell:N}} — 행이 아니면 null) */
  function itemInfo(chain) {
    const root = itemRoot(chain);
    if (!root) return null;
    const tr = root.tagName === 'TR' ? root : root.closest('tr');
    const cells = tr ? [...tr.children].filter((c) => c.tagName === 'TD' || c.tagName === 'TH').map((c) => clip(norm(c.innerText ?? c.textContent), 2000)) : null;
    return { text: clip(norm(root.innerText ?? root.textContent), 2000), cells, tag: lower(root) };
  }

  const isDataRow = (tr) => [...tr.children].some((c) => c.tagName === 'TD');
  const classKey = (el) =>
    [...el.classList]
      .filter((c) => !isVolatile(c))
      .sort()
      .join('.');
  /** 같은 부모 아래 같은 태그·같은 클래스의 형제들 */
  function siblingsLike(el) {
    const p = el.parentElement;
    if (!p) return [el];
    const key = classKey(el);
    return [...p.children].filter((c) => c.tagName === el.tagName && classKey(c) === key);
  }
  /** 요소가 들어 있는 목록 항목: 표의 행 → 목록 항목(li) → 같은 모양 형제가 둘 이상인 가장 가까운 조상 */
  function itemOf(el) {
    if (el && el.nodeType !== 1) el = el.parentElement;
    if (!el) return null;
    const tr = el.closest('tr');
    if (tr && tr.parentElement && isDataRow(tr)) return tr;
    const li = el.closest('li');
    if (li && li.parentElement) return li;
    for (let cur = el; cur && cur.parentElement && cur !== document.body; cur = cur.parentElement) if (siblingsLike(cur).length >= 2) return cur;
    return null;
  }
  /** 항목과 같은 모양의 형제들 (표는 같은 tbody 의 데이터 행) */
  function groupOf(item) {
    if (item.tagName === 'TR') return [...item.parentElement.children].filter((c) => c.tagName === 'TR' && isDataRow(c));
    if (item.tagName === 'LI') return [...item.parentElement.children].filter((c) => c.tagName === 'LI');
    return siblingsLike(item);
  }
  function tableName(table) {
    if (!table) return '';
    const cap = table.caption && norm(table.caption.innerText);
    if (cap) return clip(cap, 30);
    for (const a of ['aria-label', 'summary', 'title']) {
      const v = norm(table.getAttribute(a));
      if (v) return clip(v, 30);
    }
    let p = table.previousElementSibling;
    for (let k = 0; p && k < 3; k += 1, p = p.previousElementSibling) if (/^H[1-6]$/.test(p.tagName) && norm(p.innerText)) return clip(norm(p.innerText), 30);
    return '';
  }

  /** 참조한 요소가 들어 있는 목록(같은 모양의 형제들)에 맞는 items 타겟 → { candidates, meta, count, sample } */
  function listTargetOf(n) {
    const el = refEl(n);
    const item = itemOf(el);
    if (!item) throw new Error('이 요소에서 같은 모양으로 되풀이되는 목록(표의 행·목록 항목·카드)을 찾지 못했습니다.');
    const group = groupOf(item).filter(visible);
    const parent = item.parentElement;
    const tag = lower(item);
    const key = classKey(item);
    const cls = key ? `.${key.split('.').map((c) => CSS.escape(c)).join('.')}` : '';
    const rowFilter = tag === 'tr' && [...parent.children].some((c) => c.tagName === 'TR' && !isDataRow(c)) ? ':has(> td)' : '';
    const same = (els) => {
      const vis = els.filter(visible);
      return vis.length === group.length && group.every((g) => vis.includes(g));
    };
    const cands = [];
    const seen = new Set();
    const add = (kind, value, score) => {
      if (!value || seen.has(`${kind}:${value}`)) return;
      seen.add(`${kind}:${value}`);
      try {
        if (same(find({ kind, value }))) cands.push({ kind, value, score });
      } catch {
        /* 이 브라우저가 모르는 선택자 */
      }
    };
    const pPath = cssPath(parent);
    if (cls) add('css', `${pPath} > ${tag}${cls}${rowFilter}`, pPath.startsWith('#') ? 88 : 72);
    add('css', `${pPath} > ${tag}${rowFilter}`, pPath.startsWith('#') ? 86 : 70);
    if (cls) add('css', `${tag}${cls}`, 80);
    if (tag === 'tr') {
      const table = item.closest('table');
      const tcls = table ? classKey(table) : '';
      if (tcls) add('css', `table.${tcls.split('.').map((c) => CSS.escape(c)).join('.')} > ${lower(parent)} > tr${rowFilter}`, 78);
      add('xpath', `${absXPath(parent)}/tr[td]`, 45);
    } else add('xpath', `${absXPath(parent)}/${tag}`, 45);
    cands.sort((a, b) => b.score - a.score);
    const meta = { tag };
    if (tag === 'tr') {
      const name = tableName(item.closest('table'));
      meta.label = name ? `${name} 표의 행` : '표의 행';
    } else meta.label = tag === 'li' ? '목록의 항목' : `같은 모양의 ${tag}${cls ? cls.split('.').slice(0, 2).join('.') : ''} 항목`;
    const sample = group.slice(0, 3).map((g) => clip(norm(g.innerText ?? g.textContent), 60));
    if (sample[0]) meta.text = sample[0];
    meta.count = group.length;
    return { candidates: cands.slice(0, 6), meta, count: group.length, sample };
  }

  /** root → el 구조 경로 (:scope > td:nth-of-type(3) > a) */
  function relPath(root, el, xpath) {
    const parts = [];
    for (let cur = el; cur && cur !== root; cur = cur.parentElement) {
      const parent = cur.parentElement;
      if (!parent) return '';
      const tag = lower(cur);
      const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
      const k = same.indexOf(cur) + 1;
      parts.unshift(xpath ? `${tag}${same.length > 1 ? `[${k}]` : ''}` : `${tag}${same.length > 1 ? `:nth-of-type(${k})` : ''}`);
    }
    return xpath ? `./${parts.join('/')}` : `:scope > ${parts.join(' > ')}`;
  }

  /** 항목(itemN 참조가 든 목록 항목) 기준 상대 후보만 담은 타겟 → { candidates, meta } (within: 'item' 은 Node 쪽에서 붙인다) */
  function relativeTargetOf(n, itemN) {
    const el = refEl(n);
    const root = itemOf(refEl(itemN));
    if (!root) throw new Error('항목(표의 행·목록 항목·카드)을 찾지 못했습니다.');
    if (!root.contains(el)) throw new Error('대상 요소가 그 항목 안에 있지 않습니다. 같은 행(항목) 안의 요소를 고르세요.');
    const others = groupOf(root).filter((g) => g !== root && visible(g));
    const tag = lower(el);
    const cands = [];
    const seen = new Set();
    // 다른 항목에서도 하나씩 맞는 후보일수록 점수를 그대로 두고, 이 항목에서만 맞으면 낮춘다 (행마다 바뀌는 글자 등)
    const add = (kind, value, score) => {
      const key = `${kind}:${typeof value === 'string' ? value : JSON.stringify(value)}`;
      if (!value || seen.has(key)) return;
      seen.add(key);
      let els;
      try {
        els = findIn(root, { kind, value });
      } catch {
        return;
      }
      if (els.length !== 1 || els[0] !== el) return;
      const hits = others.filter((g) => {
        try {
          return findIn(g, { kind, value }).length === 1;
        } catch {
          return false;
        }
      }).length;
      const stable = !others.length || hits * 2 >= others.length;
      cands.push({ kind, value, score: stable ? score : Math.min(score, 30) });
    };
    if (el === root) add('css', ':scope', 92);
    for (const a of ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'name', 'aria-label', 'title', 'alt', 'placeholder']) {
      const v = el.getAttribute(a);
      if (v && !isVolatile(v) && v.length <= 60) add('attr', `${tag}[${a}="${cssStr(v)}"]`, a.startsWith('data-') ? 90 : 82);
    }
    const t = textOf(el);
    if (t && t.length <= 60 && !isFormControl(el)) {
      add('text', { tag, text: t }, 78);
      add('xpath', `.//${tag}[normalize-space()=${xq(t)}]`, 64);
    }
    if (el !== root) {
      add('css', relPath(root, el, false), 70);
      add('xpath', relPath(root, el, true), 50);
    }
    cands.sort((a, b) => b.score - a.score);
    // 이름은 견본 행의 글자 대신 열 이름(표 머리)으로 — 행마다 값이 다르다
    const meta = { ...targetOf(el).meta };
    const ri = rowInfo(el);
    if (ri?.col) {
      meta.col = ri.col;
      meta.label ||= ri.col;
    }
    if (ri?.own) meta.colIndex = ri.cells.indexOf(ri.own) + 1;
    return { candidates: cands.slice(0, 8), meta };
  }

  const api = { version: VERSION, norm, compact, textOf, labelOf, visible, find, count, pick, targetOf, valueOf, hasText, snapshot, targetOfRef, isVolatile, stableParts, allRoots, findIn, countIn, pickIn, itemInfo, listTargetOf, relativeTargetOf };
  Object.defineProperty(W, '__webRpa', { value: api, configurable: true, writable: true, enumerable: false });
  return true;
})()
