/* Кит · модуль «Невидимка» (MAIN-мир страницы vk.com / vk.ru)

   Три независимых режима:
     1) «Не помечать прочитанным»: перехватываются запросы VK на отметку сообщений
        прочитанными (messages.markAsRead, act=a_mark_read и т.п.).
     2) «Скрывать онлайн» (как невидимка в Kate Mobile): веб-клиент VK шлёт
        account.setOnline внутри пачки batch.call вместе с другими методами.
        Расширение разбирает пачку, вырезает из неё только setOnline и отправляет
        остальное как есть. Отдельные запросы «онлайн» блокируются целиком.
        Лонгполл (a_check, queue) и отправка сообщений не трогаются.
     3) «Скрывать печатает…»: перехватывается messages.setActivity (отдельно и внутри
        пачки), собеседник не видит «печатает…», пока ты набираешь текст.

   Диагностика: журнал запросов (хост, путь, act/method, вложенные методы batch.call).

   Интерфейса на странице нет. Состояние приходит из data-атрибутов на <html>
   (их ставит vk-stealth-bridge.js), запасной вариант читается из localStorage.

   Наружу:
       data-ak-stealth-blocked  — счётчик перехваченных отметок «прочитано»
       data-ak-online-blocked   — счётчик вырезанных пингов «онлайн»
       data-ak-typing-blocked   — счётчик перехваченных «печатает…»
       localStorage.kit_diag    — журнал диагностики (JSON) */

(function () {
  'use strict';

  const LS_READ = 'vk_stealth_read', LS_ONLINE = 'vk_stealth_online', LS_TYPING = 'vk_stealth_typing',
        LS_DIAG = 'vk_stealth_diag', LS_RE = 'vk_stealth_online_re', LS_LOG = 'kit_diag';
  const root = document.documentElement;
  let blockedRead = 0, blockedOnline = 0, blockedTyping = 0;

  // ---- Состояние ----
  function flag(dataKey, lsKey, def) {
    const d = root.dataset[dataKey];
    if (d === 'on')  return true;
    if (d === 'off') return false;
    try { const v = localStorage.getItem(lsKey); return v === null ? def : v !== '0'; }
    catch (e) { return def; }
  }
  const modOn    = () => root.dataset.akStealthMod !== 'off';
  const readOn   = () => modOn() && flag('akStealth', LS_READ, true);
  const onlineOn = () => modOn() && flag('akOnline', LS_ONLINE, false);
  const typingOn = () => modOn() && flag('akTyping', LS_TYPING, false);
  const diagOn   = () => modOn() && flag('akDiag', LS_DIAG, false);
  // Мост ещё не проставил атрибуты? (первые миллисекунды загрузки страницы)
  const bridged = () => root.dataset.akStealthMod !== undefined;
  let readyP = null;
  function ready() {
    if (bridged()) return Promise.resolve();
    if (readyP) return readyP;
    readyP = new Promise(resolve => {
      const mo = new MutationObserver(() => { if (bridged()) { mo.disconnect(); resolve(); } });
      mo.observe(root, { attributes: true });
      setTimeout(() => { mo.disconnect(); resolve(); }, 2000);
    });
    return readyP;
  }
  const RE_CANDIDATE = /setOnline|markAsRead|setActivity|a_online|a_ping|mark_read|a_activity|a_typing/i;

  function countRead()   { blockedRead++;   try { root.dataset.akStealthBlocked = String(blockedRead); } catch (e) {} }
  function countOnline() { blockedOnline++; try { root.dataset.akOnlineBlocked  = String(blockedOnline); } catch (e) {} }
  function countTyping() { blockedTyping++; try { root.dataset.akTypingBlocked  = String(blockedTyping); } catch (e) {} }

  // ---- Признаки ----
  // сравниваются с именем метода API / значением act / вложенными методами batch.call
  const RE_READ_DEF   = /^(messages\.markAsRead|messages\.markAsReadMulti|a_mark_read|a_mark_as_read|mark_as_read|a_read)$/i;
  const RE_READ_LOOSE = /markasread|mark_read/i;           // только для URL, не для тела
  const RE_ONLINE_DEF = /setOnline|a_online|onlines|online_ping|a_ping|heartbeat|a_stat_online/i;
  const RE_TYPING_DEF = /^(messages\.setActivity|a_activity|a_typing|setActivity)$/i;
  const RE_NEVER      = /a_check|longpoll|queue\.|a_send|messages\.send|a_start/i;

  function reOnline() {
    let src = root.dataset.akOnlineRe;
    if (src === undefined) { try { src = localStorage.getItem(LS_RE) || ''; } catch (e) { src = ''; } }
    src = (src || '').trim();
    if (!src) return RE_ONLINE_DEF;
    try {
      const parts = src.split(',').map(s => s.trim()).filter(Boolean)
        .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      return parts.length ? new RegExp(parts.join('|'), 'i') : RE_ONLINE_DEF;
    } catch (e) { return RE_ONLINE_DEF; }
  }

  // ---- Разбор тела запроса ----
  const RE_METHOD_NAME = /^[a-zA-Z]+\.[a-zA-Z]+$/;
  function isJsonText(v) { return typeof v === 'string' && v.length > 1 && (v[0] === '{' || v[0] === '['); }

  function parseBody(body) {
    const out = { type: 'none', pairs: [], raw: '' };
    if (!body) return out;
    try {
      if (typeof body === 'string') {
        out.raw = body;
        if (isJsonText(body)) { out.type = 'json'; }
        else { out.type = 'string'; out.pairs = [...new URLSearchParams(body).entries()]; }
      } else if (body instanceof URLSearchParams) {
        out.type = 'usp'; out.pairs = [...body.entries()]; out.raw = body.toString();
      } else if (typeof FormData !== 'undefined' && body instanceof FormData) {
        out.type = 'fd'; out.pairs = [...body.entries()];
        out.raw = out.pairs.map(([k, v]) => k + '=' + v).join('&');
      } else out.type = 'other';
    } catch (e) { out.type = 'other'; }
    return out;
  }
  function rebuild(type, pairs, rawJson) {
    if (type === 'json')   return rawJson;
    if (type === 'string') return new URLSearchParams(pairs).toString();
    if (type === 'usp')    return new URLSearchParams(pairs);
    const fd = new FormData();
    for (const [k, v] of pairs) fd.append(k, v);
    return fd;
  }

  // Все строки вида «xxx.yyy» внутри JSON: список вложенных методов
  function collectMethods(node, acc, depth) {
    if (depth > 6 || acc.length > 60) return acc;
    if (typeof node === 'string') { if (RE_METHOD_NAME.test(node)) acc.push(node); return acc; }
    if (Array.isArray(node)) { for (const x of node) collectMethods(x, acc, depth + 1); return acc; }
    if (node && typeof node === 'object') { for (const k in node) collectMethods(node[k], acc, depth + 1); }
    return acc;
  }
  // Есть ли в элементе (объект/строка/массив) имя метода, подходящее под re (не глубже 2 уровней)
  function elementMatches(el, re, depth) {
    if (typeof el === 'string') return RE_METHOD_NAME.test(el) && re.test(el);
    if (depth > 2 || !el || typeof el !== 'object') return false;
    if (Array.isArray(el)) return el.some(x => typeof x === 'string' ? (RE_METHOD_NAME.test(x) && re.test(x)) : false);
    for (const k in el) {
      const v = el[k];
      if (typeof v === 'string' && RE_METHOD_NAME.test(v) && re.test(v)) return true;
    }
    return false;
  }
  // Вырезает из любых массивов внутри JSON элементы, чей метод подходит под re. Возвращает число вырезанных.
  function prune(node, re, depth) {
    if (depth > 6 || !node || typeof node !== 'object') return 0;
    let removed = 0;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        if (elementMatches(node[i], re, 0)) { node.splice(i, 1); removed++; }
        else removed += prune(node[i], re, depth + 1);
      }
    } else {
      for (const k in node) removed += prune(node[k], re, depth + 1);
    }
    return removed;
  }

  function inspect(url, body) {
    const info = { url: url || '', method: '', act: '', pairs: [], type: 'none', raw: '', json: [] };
    try {
      const u = new URL(url || '', location.href);
      info.host = u.hostname; info.path = u.pathname;
      info.method = (u.pathname.match(/\/method\/([\w.]+)/) || [])[1] || '';
      info.act = u.searchParams.get('act') || '';
      const pb = parseBody(body);
      info.type = pb.type; info.pairs = pb.pairs; info.raw = pb.raw;
      if (pb.type === 'json') {
        try { info.json.push({ key: null, obj: JSON.parse(pb.raw) }); } catch (e) {}
      }
      for (const [k, v] of pb.pairs) {
        if (k === 'act' && !info.act) info.act = String(v);
        if (k === 'method' && !info.method) info.method = String(v);
        if (isJsonText(v)) { try { info.json.push({ key: k, obj: JSON.parse(v) }); } catch (e) {} }
      }
      info.inner = [];
      for (const j of info.json) collectMethods(j.obj, info.inner, 0);
    } catch (e) {}
    return info;
  }

  // Вырезать из тела вызовы под re; вернуть {body, removed} или null
  function cut(i, re) {
    let removed = 0;
    for (const j of i.json) removed += prune(j.obj, re, 0);
    if (!removed) return null;
    const total = i.inner.length;
    const left = [];
    for (const j of i.json) collectMethods(j.obj, left, 0);
    if (!left.length && total) return { removed, all: true };
    let body;
    if (i.type === 'json') body = JSON.stringify(i.json[0].obj);
    else {
      const map = new Map(i.json.map(j => [j.key, JSON.stringify(j.obj)]));
      body = rebuild(i.type, i.pairs.map(([k, v]) => map.has(k) ? [k, map.get(k)] : [k, v]));
    }
    return { removed, body };
  }

  /* Решение по запросу:
       null                          — пропустить
       { kind }                      — заблокировать целиком
       { kind, body, removed }       — переписать тело */
  function decide(url, body) {
    const i = inspect(url, body);
    const keys = [i.method, i.act].filter(Boolean);
    if (keys.some(k => RE_NEVER.test(k))) return null;

    if (readOn()) {
      if (keys.some(k => RE_READ_DEF.test(k)) || RE_READ_LOOSE.test(i.url)) return { kind: 'read' };
    }
    if (onlineOn()) {
      const re = reOnline();
      if (keys.some(k => re.test(k))) return { kind: 'online' };
      const c = cut(i, re);
      if (c) return c.all ? { kind: 'online' } : { kind: 'online', body: c.body, removed: c.removed };
    }
    if (readOn()) {
      const c = cut(i, RE_READ_DEF);
      if (c) return c.all ? { kind: 'read' } : { kind: 'read', body: c.body, removed: c.removed };
    }
    if (typingOn()) {
      if (keys.some(k => RE_TYPING_DEF.test(k))) return { kind: 'typing' };
      const c = cut(i, RE_TYPING_DEF);
      if (c) return c.all ? { kind: 'typing' } : { kind: 'typing', body: c.body, removed: c.removed };
    }
    return null;
  }

  // ---- Диагностика ----
  const diag = new Map();
  const samples = new Map();
  let diagTimer = null;
  function logDiag(kind, url, body, verdict) {
    if (!diagOn()) return;
    try {
      const i = inspect(url, body);
      if (!/vk\.(com|ru)$|userapi\.com$/.test(i.host || '')) return;
      let s = kind + ' ' + i.host + i.path + (i.act ? ' act=' + i.act : '') + (i.method ? ' method=' + i.method : '');
      if (i.inner && i.inner.length) s += ' [' + i.inner.slice(0, 20).join(', ') + ']';
      if (/batch\.call|execute/i.test(i.method) && i.raw && !samples.has(i.method + (verdict ? '+' : '-')))
        samples.set(i.method + (verdict ? '+' : '-'), i.raw.slice(0, 700));
      if (verdict) s += '  [' + (verdict.body ? 'вырезано ' + verdict.removed + ': ' : 'перехвачено: ') + verdict.kind + ']';
      else if (i.inner && i.inner.some(m => /setActivity/i.test(m)) && typingOn()) s += '  [ПРОПУЩЕН setActivity]';
      else if (i.inner && i.inner.some(m => /setOnline/i.test(m))) s += '  [ПРОПУЩЕН setOnline: онлайн=' + (onlineOn() ? 'on' : 'off') + ', мост=' + (bridged() ? 'да' : 'нет') + ']';
      diag.set(s, (diag.get(s) || 0) + 1);
      if (diag.size > 400) diag.delete(diag.keys().next().value);
      if (!diagTimer) diagTimer = setTimeout(flushDiag, 1500);
    } catch (e) {}
  }
  function flushDiag() {
    diagTimer = null;
    try {
      const arr = [...diag.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => n + '× ' + k);
      const st = 'состояние: мост=' + (bridged() ? 'да' : 'нет') + ', модуль=' + (modOn() ? 'on' : 'off') +
        ', прочитано=' + (readOn() ? 'on' : 'off') + ', онлайн=' + (onlineOn() ? 'on' : 'off') + ', печатает=' + (typingOn() ? 'on' : 'off') +
        ', attr=' + root.dataset.akOnline + ', ls=' + (function () { try { return localStorage.getItem(LS_ONLINE); } catch (e) { return '?'; } })();
      arr.unshift(st);
      const smp = [...samples.entries()].map(([k, v]) => '--- образец ' + k + ' ---\n' + v);
      localStorage.setItem(LS_LOG, JSON.stringify({ t: Date.now(), page: location.pathname, lines: arr.concat(smp) }));
    } catch (e) {}
  }
  const fake = () => new Response('{"response":1}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  const bump = (kind) => kind === 'read' ? countRead() : kind === 'typing' ? countTyping() : countOnline();

  // ---- fetch ----
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      const self = this, args = arguments;
      const run = () => {
        try {
          const isReq = input && typeof input === 'object' && typeof input.url === 'string';
          const url  = isReq ? input.url : String(input);
          const body = (init && init.body !== undefined) ? init.body : (isReq ? input.body : '');
          const v = decide(url, body);
          logDiag('fetch', url, body, v);
          if (v && !v.body) { bump(v.kind); return Promise.resolve(fake()); }
          if (v && v.body) {
            bump(v.kind);
            if (init && init.body !== undefined) return origFetch.call(self, input, Object.assign({}, init, { body: v.body }));
            if (isReq) return origFetch.call(self, new Request(input, { body: v.body }));
          }
        } catch (e) {}
        return origFetch.apply(self, args);
      };
      try {
        if (!bridged()) {
          const b = (init && init.body !== undefined) ? init.body : '';
          const txt = typeof b === 'string' ? b : (b instanceof URLSearchParams ? b.toString() : '');
          if (RE_CANDIDATE.test(String(input && input.url || input) + ' ' + txt)) return ready().then(run);
        }
      } catch (e) {}
      return run();
    };
  }

  // ---- XMLHttpRequest ----
  const xOpen = XMLHttpRequest.prototype.open;
  const xSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__vkUrl = url;
    return xOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      const v = decide(this.__vkUrl, body);
      logDiag('xhr', this.__vkUrl, body, v);
      if (v && v.body) { bump(v.kind); return xSend.call(this, v.body); }
      if (v) {
        bump(v.kind);
        const xhr = this;
        setTimeout(function () {
          try {
            Object.defineProperty(xhr, 'readyState',   { value: 4, configurable: true });
            Object.defineProperty(xhr, 'status',       { value: 200, configurable: true });
            Object.defineProperty(xhr, 'responseText', { value: '{"response":1}', configurable: true });
            Object.defineProperty(xhr, 'response',     { value: '{"response":1}', configurable: true });
            if (typeof xhr.onreadystatechange === 'function') xhr.onreadystatechange();
            xhr.dispatchEvent(new Event('readystatechange'));
            xhr.dispatchEvent(new Event('load'));
            xhr.dispatchEvent(new Event('loadend'));
          } catch (e) {}
        }, 0);
        return;
      }
    } catch (e) {}
    return xSend.apply(this, arguments);
  };

  // ---- sendBeacon ----
  if (navigator.sendBeacon) {
    const beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      try {
        const v = decide(url, data);
        logDiag('beacon', url, data, v);
        if (v && !v.body) { bump(v.kind); return true; }
        if (v && v.body)  { bump(v.kind); return beacon(url, v.body); }
      } catch (e) {}
      return beacon(url, data);
    };
  }

  function dropOldBadge() { document.getElementById('vk-stealth-badge')?.remove(); }
  if (document.body) dropOldBadge();
  else document.addEventListener('DOMContentLoaded', dropOldBadge, { once: true });
})();
