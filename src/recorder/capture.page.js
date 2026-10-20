// 녹화 캡처: 사람이 한 동작(신뢰 이벤트)을 잡아 Node 로 보낸다. dom.page.js 다음에 문서마다 설치된다.
// window.open 으로 열린 창은 빈 문서의 window 를 그대로 쓰므로, 설치 표시는 document 에, 공용 상태는 window 에 둔다.
// 돌려주는 값: { binding: Node 연결 함수가 있는지, queued: 연결이 없어 쌓아 둔 이벤트 }
(() => {
  const W = window;
  const doc = document;
  const lib = W.__webRpa;
  if (!lib) return { binding: false, queued: [] };
  const S = W.__webRpaRec || (W.__webRpaRec = { seq: 0, tag: Math.random().toString(36).slice(2, 7), last: null, enterAt: 0, queue: [], uids: new WeakMap(), roots: new WeakSet() });
  const hasBinding = () => typeof W.__webRpaEmit === 'function';
  const drain = () => S.queue.splice(0);
  if (doc.__webRpaCapture) return { binding: hasBinding(), queued: drain() };
  Object.defineProperty(doc, '__webRpaCapture', { value: true });

  function topHref() {
    try {
      return W.top.location.href;
    } catch {
      return '';
    }
  }
  function send(evt) {
    evt.ts = evt.ts || Date.now();
    evt.href = location.href;
    evt.top = topHref();
    if (hasBinding()) {
      try {
        W.__webRpaEmit(evt);
        return;
      } catch {
        /* 연결이 끊겼으면 쌓아 둔다 */
      }
    }
    S.queue.push(evt);
  }
  S.send = send;
  const uid = (el) => {
    let u = S.uids.get(el);
    if (!u) {
      u = `${S.tag}.${(S.seq += 1)}`;
      S.uids.set(el, u);
    }
    return u;
  };
  const newEid = () => `${S.tag}#${(S.seq += 1)}`;
  const setLast = (eid) => {
    S.last = { eid, ts: Date.now() };
  };

  const typeOf = (el) => (el && el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : '');
  /** 이벤트의 실제 대상 (섀도 DOM 안까지) */
  function realTarget(e) {
    const path = e.composedPath ? e.composedPath() : [];
    let t = path[0] || e.target;
    if (t && t.nodeType === 3) t = t.parentElement;
    return t && t.nodeType === 1 ? t : null;
  }
  /** 신뢰 이벤트가 아니어도, 페이지 스크립트가 아닌 자동화 도구가 일으킨 값 변경은 사람의 동작으로 본다. */
  function byPageScript() {
    const lim = Error.stackTraceLimit;
    try {
      Error.stackTraceLimit = 40;
      return /(?:https?|file|blob|chrome-extension|extension):\/\//.test(String(new Error().stack));
    } catch {
      return true;
    } finally {
      Error.stackTraceLimit = lim;
    }
  }
  const human = (e) => e.isTrusted || !byPageScript();

  const NO_TEXT_TYPES = ['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image', 'hidden'];
  /** 값 입력 칸 (input·textarea·contenteditable) */
  function fieldOf(t) {
    if (!t) return null;
    if (t.tagName === 'INPUT') return NO_TEXT_TYPES.includes(typeOf(t)) ? null : t;
    if (t.tagName === 'TEXTAREA') return t;
    if (t.isContentEditable) {
      let host = t;
      while (host.parentElement && host.parentElement.isContentEditable) host = host.parentElement;
      return host;
    }
    return null;
  }

  // ---------- 입력값: 칸마다 마지막 값만 ----------
  const pending = new Map();
  const sent = new WeakMap();
  const targets = new WeakMap();
  let timer = 0;
  function targetCached(el) {
    const c = targets.get(el);
    if (c && Date.now() - c.at < 3000) return c.target;
    const target = lib.targetOf(el);
    targets.set(el, { at: Date.now(), target });
    return target;
  }
  function flushField(el) {
    pending.delete(el);
    if (!el.isConnected && sent.has(el)) return;
    const pw = typeOf(el) === 'password';
    const value = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? String(el.value ?? '') : lib.norm(el.innerText);
    const mark = pw ? '\u0000비밀' : value;
    if (sent.get(el) === mark) return;
    sent.set(el, mark);
    const evt = { kind: 'input', uid: uid(el), eid: newEid(), password: pw, target: targetCached(el) };
    if (!pw) evt.value = value;
    send(evt);
  }
  function flushAll() {
    clearTimeout(timer);
    for (const el of [...pending.keys()]) flushField(el);
  }
  function hookRoot(root) {
    if (!root || S.roots.has(root)) return;
    S.roots.add(root);
    root.addEventListener('change', onChange, true); // change 는 섀도 경계를 넘지 않는다
  }
  S.hookRoot = hookRoot;
  const watchShadow = (t) => {
    const r = t && t.getRootNode && t.getRootNode();
    if (r && r !== doc && r.host) hookRoot(r);
  };

  // ---------- 클릭 ----------
  const STRONG = 'a, button, input, select, textarea, label, summary, option, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=radio], [role=switch], [role=treeitem]';
  function clickTarget(t) {
    const strong = t.closest(STRONG);
    if (strong) return strong;
    let p = t;
    for (let k = 0; p && k < 3; k += 1, p = p.parentElement) if (p.hasAttribute('onclick')) return p;
    return t;
  }
  /** 이 클릭은 다른 이벤트(변경·입력)가 대신 기록한다 */
  function handledElsewhere(el) {
    const tag = el.tagName;
    if (tag === 'HTML' || tag === 'BODY') return true;
    if (tag === 'SELECT' || tag === 'OPTION') return true;
    if (tag === 'INPUT' && ['checkbox', 'radio', 'file'].includes(typeOf(el))) return true;
    if (tag === 'LABEL' && el.control) return true;
    const f = fieldOf(el);
    if (f && !f.readOnly && !f.disabled) return true; // 입력칸을 눌러 커서만 옮긴 것
    return false;
  }
  doc.addEventListener(
    'click',
    (e) => {
      const t = realTarget(e);
      if (!t) return;
      if (!e.isTrusted) {
        // 버튼이 숨은 파일 칸을 대신 눌러 파일 선택창을 연 경우
        if (t.tagName === 'INPUT' && typeOf(t) === 'file' && S.last && Date.now() - S.last.ts < 3000) send({ kind: 'chooser', of: S.last.eid, uid: uid(t) });
        return;
      }
      watchShadow(t);
      const el = clickTarget(t);
      if (e.detail === 0 && Date.now() - S.enterAt < 1000) return; // Enter 로 생긴 제출·버튼 누름은 keypress 가 대신한다
      if (handledElsewhere(el)) {
        const ctl = el.tagName === 'LABEL' ? el.control : el;
        if (ctl && ctl.tagName === 'INPUT' && ['checkbox', 'radio'].includes(typeOf(ctl))) {
          S.checkEid = newEid(); // 뒤따르는 change 가 이 번호를 쓴다 (알림창 원인 연결용)
          setLast(S.checkEid);
        }
        return;
      }
      flushAll();
      const eid = newEid();
      setLast(eid);
      send({ kind: 'click', uid: uid(el), eid, detail: e.detail, target: lib.targetOf(el) });
    },
    true,
  );
  doc.addEventListener(
    'dblclick',
    (e) => {
      if (!e.isTrusted) return;
      const t = realTarget(e);
      if (!t) return;
      const el = clickTarget(t);
      if (handledElsewhere(el)) return;
      const eid = newEid();
      setLast(eid);
      send({ kind: 'dblclick', uid: uid(el), eid, target: lib.targetOf(el) });
    },
    true,
  );

  // ---------- 키 (Enter·Escape 만) ----------
  doc.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted || e.isComposing || (e.key !== 'Enter' && e.key !== 'Escape')) return;
      const t = realTarget(e);
      if (e.key === 'Enter' && t && (t.tagName === 'TEXTAREA' || t.isContentEditable) && !e.ctrlKey) return; // 줄바꿈
      flushAll();
      const mods = `${e.ctrlKey ? 'Control+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.metaKey ? 'Meta+' : ''}`;
      const el = t && t !== doc.body && t !== doc.documentElement ? t : null;
      const eid = newEid();
      if (e.key === 'Enter') S.enterAt = Date.now();
      setLast(eid);
      const evt = { kind: 'key', key: mods + e.key, eid };
      if (el) {
        evt.uid = uid(el);
        evt.target = lib.targetOf(el);
      }
      send(evt);
    },
    true,
  );

  // ---------- 입력·변경 ----------
  doc.addEventListener(
    'input',
    (e) => {
      const t = realTarget(e);
      const el = fieldOf(t);
      if (!el || !human(e)) return;
      watchShadow(el);
      for (const other of [...pending.keys()]) if (other !== el) flushField(other);
      pending.set(el, true);
      clearTimeout(timer);
      timer = setTimeout(flushAll, 300);
    },
    true,
  );
  function onChange(e) {
    const t = realTarget(e);
    if (!t || e.__webRpaSeen) return;
    e.__webRpaSeen = true;
    if (t.tagName === 'INPUT' && typeOf(t) === 'file') {
      flushAll();
      const eid = newEid();
      setLast(eid);
      send({ kind: 'file', uid: uid(t), eid, fileNames: [...(t.files || [])].map((f) => f.name), target: lib.targetOf(t) });
      return;
    }
    if (!human(e)) return;
    if (t.tagName === 'SELECT') {
      flushAll();
      const opt = t.selectedOptions[0];
      const eid = newEid();
      setLast(eid);
      send({ kind: 'select', uid: uid(t), eid, value: t.value, label: opt ? lib.norm(opt.label || opt.text) : '', target: lib.targetOf(t) });
      return;
    }
    if (t.tagName === 'INPUT' && ['checkbox', 'radio'].includes(typeOf(t))) {
      flushAll();
      const eid = S.checkEid && S.last && S.last.eid === S.checkEid ? S.checkEid : newEid();
      S.checkEid = null;
      setLast(eid);
      send({ kind: 'check', uid: uid(t), eid, checked: t.checked, target: lib.targetOf(t) });
      return;
    }
    const el = fieldOf(t);
    if (el) flushField(el);
  }
  doc.addEventListener('change', onChange, true);
  doc.addEventListener(
    'focusout',
    (e) => {
      const el = fieldOf(realTarget(e));
      if (el && pending.has(el)) flushField(el);
    },
    true,
  );
  for (const r of lib.allRoots()) if (r !== doc) hookRoot(r);

  // ---------- 창 단위 갈고리 (window 가 재사용돼도 한 번만) ----------
  if (!W.__webRpaHooks) {
    Object.defineProperty(W, '__webRpaHooks', { value: true });
    // 알림창: 사람이 고른 응답을 기록한다. 원인은 직전 동작.
    for (const kind of ['alert', 'confirm', 'prompt']) {
      const orig = W[kind];
      if (typeof orig !== 'function') continue;
      W[kind] = function (...args) {
        const trigger = S.last && Date.now() - S.last.ts < 60000 ? S.last.eid : null;
        const result = orig.apply(W, args);
        const evt = { kind: 'dialog', dialogType: kind, message: String(args[0] ?? ''), trigger };
        evt.accepted = kind === 'alert' ? true : kind === 'confirm' ? !!result : result !== null;
        if (kind === 'prompt' && result !== null) evt.promptText = String(result);
        (S.send || send)(evt);
        return result;
      };
    }
    // 인쇄: 실제 인쇄창 대신 PDF 저장 스텝으로 남긴다
    W.print = function () {
      (S.send || send)({ kind: 'print', trigger: S.last ? S.last.eid : null });
    };
    // 나중에 생기는 열린 섀도 루트에도 change 감시를 단다
    const proto = W.Element && W.Element.prototype;
    if (proto && proto.attachShadow && !proto.attachShadow.__webRpa) {
      const origAttach = proto.attachShadow;
      const patched = function (init) {
        const root = origAttach.call(this, init);
        if (init && init.mode === 'open') queueMicrotask(() => S.hookRoot && S.hookRoot(root));
        return root;
      };
      patched.__webRpa = true;
      proto.attachShadow = patched;
    }
  }

  W.__webRpaFlush = () => {
    flushAll();
    return drain();
  };
  return { binding: hasBinding(), queued: drain() };
})()
