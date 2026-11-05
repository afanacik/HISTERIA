/* Кит — VK st fix: перезаписчик URL (MAIN world, document_start)
   Подменяет адреса битого шарда статики на рабочий хост ЕЩЁ ДО создания запроса —
   динамические webpack-чанки (Photoview, видеоплеер и т.п.) уходят на здоровый
   шард обычным путём, без редиректа, поэтому CORS-цепочка не рвётся.
   Конфиг: localStorage['__kit_vkfix'] (кэш) + событие kit-vkfix-config (живое обновление). */
(() => {
  if (window.__kitShardFix) return;
  window.__kitShardFix = true;

  const KEY = '__kit_vkfix';
  let cfg = { on: true, from: '54', to: 'st1-53.vk.ru' };
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (c && c.to) cfg = c;
  } catch (e) {}

  let RE = null;
  let count = 0;

  const compile = () => {
    const okFrom = /^\d{1,4}$/.test(cfg.from);
    const okTo = /^[a-z0-9][a-z0-9.-]*\.vk\.(ru|com)$/i.test(cfg.to) &&
      !(new RegExp('^st\\d+-' + cfg.from + '\\.vk\\.ru$', 'i')).test(cfg.to);
    RE = (cfg.on && okFrom && okTo)
      ? new RegExp('^https://st\\d+-' + cfg.from + '\\.vk\\.ru/')
      : null;
  };
  compile();

  try {
    document.documentElement.addEventListener('kit-vkfix-config', (e) => {
      try { cfg = JSON.parse(e.detail); } catch (err) { return; }
      compile();
    });
  } catch (e) {}

  const fix = (u) => {
    if (!RE || typeof u !== 'string' || !RE.test(u)) return u;
    count++;
    try { document.documentElement.dataset.kitShardRewrites = String(count); } catch (e) {}
    return u.replace(RE, 'https://' + cfg.to + '/');
  };

  const hookProp = (proto, prop) => {
    try {
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.set) return;
      Object.defineProperty(proto, prop, { ...d, set(v) { d.set.call(this, fix(v)); } });
    } catch (e) {}
  };
  hookProp(HTMLScriptElement.prototype, 'src');
  hookProp(HTMLLinkElement.prototype, 'href');
  hookProp(HTMLImageElement.prototype, 'src');
  hookProp(HTMLMediaElement.prototype, 'src');
  hookProp(HTMLSourceElement.prototype, 'src');

  try {
    const sa = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (n, v) {
      if ((n === 'src' || n === 'href') && typeof v === 'string') v = fix(v);
      return sa.call(this, n, v);
    };
  } catch (e) {}

  try {
    const of = window.fetch;
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string' || input instanceof URL) input = fix(String(input));
        else if (input instanceof Request && RE && RE.test(input.url)) input = new Request(fix(input.url), input);
      } catch (e) {}
      return of.call(this, input, init);
    };
  } catch (e) {}

  try {
    const oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, url, ...rest) {
      return oo.call(this, m, typeof url === 'string' ? fix(url) : url, ...rest);
    };
  } catch (e) {}

  try {
    const OW = window.Worker;
    window.Worker = function (url, opts) { return new OW(fix(String(url)), opts); };
    window.Worker.prototype = OW.prototype;
  } catch (e) {}

  console.log('[Кит] VK st fix: перезаписчик активен');
})();
