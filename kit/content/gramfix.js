// Кит · модуль ГрамФикс — Content Script (на всех сайтах)
// Исправление + Формулировка + Перевод на английский
// Меню действий появляется при печати, раскрывается при наведении
// Вкл/выкл модуля — ключ `enabled` в chrome.storage.sync (переключатель в попапе)

(function () {
  'use strict';

  // Флаг для диагностики из попапа (executeScript видит тот же изолированный мир)
  try { window.__kitGramfix = { loaded: true, at: Date.now() }; } catch (e) {}

  // Фреймы без обычной HTML-страницы (XML, SVG и т.п.) пропускаем:
  // полей ввода там нет, а стили вставить некуда.
  if (!document.head) return;

  // ===== РЕЖИМЫ =====
  const MODES = {
    fix:       { icon: '✏️', label: 'Исправить',       loading: 'Исправляю…',  hotkey: 'Ctrl+Shift+F' },
    rephrase:  { icon: '🪄', label: 'Сформулировать',  loading: 'Формулирую…', hotkey: 'Ctrl+Shift+S' },
    translate: { icon: '🌐', label: 'На английский',   loading: 'Перевожу…',   hotkey: 'Ctrl+Shift+E' }
  };

  // Какие режимы показывать кнопками в меню у поля ввода.
  // Остальные остаются доступны по горячим клавишам, но экран не загромождают.
  const MENU_MODES = ['fix'];

  // Минимальная длина текста, при которой срабатывает автоисправление на выходе
  const AUTOFIX_MIN = 10;

  let settings = {
    enabled: true,
    hasClaudeKey: false,
    hasOpenaiKey: false,
    gfProvider: 'anthropic',
    showDiff: true,
    autoFix: false,      // исправлять при уходе из поля
    autoPause: false,    // исправлять после паузы в печати
    autoDelay: 3,        // длительность паузы, секунды
    fixCount: 0
  };

  // Настройки из sync, ключ из local
  chrome.storage.sync.get(
    { enabled: true, showDiff: true, autoFix: false, autoPause: false, autoDelay: 3, fixCount: 0, gfProvider: 'anthropic' },
    (data) => { settings = { ...settings, ...data }; }
  );
  chrome.storage.local.get({ apiKey: '', openaiApiKey: '', gfPos: null }, (data) => {
    // В content-script держим только факт наличия ключа, не сам секрет.
    settings.hasClaudeKey = !!data.apiKey;
    settings.hasOpenaiKey = !!data.openaiApiKey;
    settings.gfPos = data.gfPos || null;
  });
  const hasActiveKey = () => settings.gfProvider === 'openai' ? settings.hasOpenaiKey : settings.hasClaudeKey;

  // Слушать изменения в обоих хранилищах (ключи не сохраняем в переменные страницы)
  const OWN_KEYS = ['enabled', 'showDiff', 'autoFix', 'autoPause', 'autoDelay', 'fixCount', 'gfProvider', 'gfPos'];
  chrome.storage.onChanged.addListener((changes, area) => {
    for (const key in changes) {
      if (OWN_KEYS.includes(key)) settings[key] = changes[key].newValue;
    }
    if (area === 'local') {
      if (changes.apiKey) settings.hasClaudeKey = !!changes.apiKey.newValue;
      if (changes.openaiApiKey) settings.hasOpenaiKey = !!changes.openaiApiKey.newValue;
    }
    // положение сбросили из попапа — сразу возвращаем значок к полю
    if (changes.gfPos && !changes.gfPos.newValue && wrap && activeEl) placeWrap(wrap, activeEl);
  });

  // ===== СТИЛИ =====
  const style = document.createElement('style');
  style.textContent = `
    #gf-toast {
      position: fixed !important; bottom: 24px !important; right: 24px !important;
      background: #0f0f1e !important; color: #e0e0ff !important;
      padding: 14px 18px !important; border-radius: 14px !important;
      font-family: 'Segoe UI', system-ui, sans-serif !important; font-size: 13px !important;
      z-index: 2147483647 !important; box-shadow: 0 8px 32px rgba(0,0,0,0.5) !important;
      border: 1px solid #3a3a6e !important; max-width: 300px !important; min-width: 220px !important;
      animation: gfIn 0.35s cubic-bezier(0.34,1.56,0.64,1) !important;
      pointer-events: none !important; line-height: 1.4 !important;
    }
    @keyframes gfIn {
      from { transform: translateY(30px) scale(0.9); opacity: 0; }
      to   { transform: translateY(0) scale(1); opacity: 1; }
    }
    #gf-wrap {
      position: fixed !important; z-index: 2147483646 !important;
      display: flex !important; align-items: center !important;
      justify-content: flex-end !important; gap: 6px !important;
      flex-wrap: wrap !important;
      max-width: calc(100vw - 16px) !important;
      pointer-events: all !important;
      animation: gfPop 0.25s cubic-bezier(0.34,1.56,0.64,1) !important;
    }
    @keyframes gfPop {
      from { transform: scale(0); opacity: 0; }
      to   { transform: scale(1); opacity: 1; }
    }
    .gf-chip {
      height: 32px !important; border: none !important; cursor: pointer !important;
      display: flex !important; align-items: center !important; justify-content: center !important;
      gap: 5px !important; padding: 0 12px !important; border-radius: 16px !important;
      color: white !important; font-family: 'Segoe UI', system-ui, sans-serif !important;
      font-size: 11px !important; font-weight: 600 !important; white-space: nowrap !important;
      backdrop-filter: blur(8px) !important;
      transition: transform 0.18s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.18s !important;
      overflow: hidden !important;
    }
    .gf-chip:hover { transform: scale(1.07) !important; }
    .gf-chip.gf-round {
      width: 32px !important; padding: 0 !important;
      border-radius: 50% !important; font-size: 15px !important;
    }
    .gf-fix, .gf-round {
      background: rgba(108,99,255,0.92) !important;
      box-shadow: 0 2px 10px rgba(108,99,255,0.5) !important;
    }
    .gf-fix:hover, .gf-round:hover { box-shadow: 0 4px 16px rgba(108,99,255,0.7) !important; }
    .gf-rephrase {
      background: rgba(13,148,136,0.92) !important;
      box-shadow: 0 2px 10px rgba(13,148,136,0.5) !important;
    }
    .gf-rephrase:hover { box-shadow: 0 4px 16px rgba(13,148,136,0.7) !important; }
    .gf-translate {
      background: rgba(37,99,235,0.92) !important;
      box-shadow: 0 2px 10px rgba(37,99,235,0.5) !important;
    }
    .gf-translate:hover { box-shadow: 0 4px 16px rgba(37,99,235,0.7) !important; }
    .gf-chip.gf-loading-chip {
      background: rgba(74,69,128,0.92) !important; cursor: wait !important;
    }
    .gf-chip.gf-loading-chip:hover { transform: none !important; }
    #gf-spinner {
      width: 10px; height: 10px; flex-shrink: 0;
      border: 2px solid rgba(255,255,255,0.3); border-top-color: white;
      border-radius: 50%; animation: gfSpin 0.7s linear infinite;
    }
    @keyframes gfSpin { to { transform: rotate(360deg); } }

    /* ---- Обратный отсчёт до автоисправления ---- */
    .gf-chip.gf-count {
      position: relative !important;
      font-size: 12px !important; font-weight: 700 !important;
      cursor: pointer !important;
    }
    .gf-chip.gf-count .gf-num {
      position: relative !important; z-index: 1 !important;
      font-family: 'Segoe UI', system-ui, sans-serif !important;
      line-height: 1 !important;
    }
    .gf-ring {
      position: absolute !important; top: 0 !important; left: 0 !important;
      width: 32px !important; height: 32px !important;
      transform: rotate(-90deg) !important; pointer-events: none !important;
    }
    .gf-ring circle { fill: none !important; stroke-width: 3 !important; }
    .gf-ring .bg { stroke: rgba(255,255,255,0.22) !important; }
    .gf-ring .fg {
      stroke: #fff !important; stroke-linecap: round !important;
      stroke-dasharray: 100.5 !important; stroke-dashoffset: 0 !important;
      animation: gfRing var(--gf-dur, 3000ms) linear forwards !important;
    }
    @keyframes gfRing { from { stroke-dashoffset: 0; } to { stroke-dashoffset: 100.5; } }

    /* ---- Перетаскивание ---- */
    #gf-wrap.gf-dragging { animation: none !important; opacity: 0.92 !important; }
    #gf-wrap.gf-dragging .gf-chip {
      cursor: grabbing !important;
      transform: scale(1.1) !important;
      box-shadow: 0 6px 20px rgba(0,0,0,0.35) !important;
    }
  `;
  document.head.appendChild(style);

  // ===== УТИЛИТЫ =====
  function isEditable(el) {
    if (!el || el.closest?.('#gf-wrap')) return false;
    const tag = el.tagName?.toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'input') {
      return ['text','search','email','url',''].includes((el.type||'text').toLowerCase());
    }
    if (el.isContentEditable) return true;
    let p = el.parentElement, d = 0;
    while (p && d++ < 5) { if (p.isContentEditable) return true; p = p.parentElement; }
    return false;
  }

  function getRoot(el) {
    if (!el) return null;
    const tag = el.tagName?.toLowerCase();
    if (tag === 'textarea' || tag === 'input') return el;
    if (el.isContentEditable) return el;
    let p = el.parentElement, d = 0;
    while (p && d++ < 5) { if (p.isContentEditable) return p; p = p.parentElement; }
    return null;
  }

  function getText(el) {
    if (!el) return '';
    return el.isContentEditable ? el.innerText.trim() : (el.value || '');
  }

  function setText(el, text) {
    if (!el) return;
    if (el.isContentEditable) {
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      if (!document.execCommand('insertText', false, text)) el.innerText = text;
    } else {
      // execCommand сохраняет историю undo (Ctrl+Z вернёт исходник)
      el.focus();
      let ok = false;
      try {
        el.select();
        ok = document.execCommand('insertText', false, text);
      } catch {}
      if (!ok) el.value = text;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ===== ТОСТ =====
  function plural(n, forms) {
    const m10 = n % 10, m100 = n % 100;
    return (m10===1&&m100!==11)?forms[0]:([2,3,4].includes(m10)&&![12,13,14].includes(m100))?forms[1]:forms[2];
  }

  function toast(html, ttl = 3000) {
    document.getElementById('gf-toast')?.remove();
    const t = document.createElement('div');
    t.id = 'gf-toast';
    t.innerHTML = html;
    (document.body || document.documentElement).appendChild(t);
    setTimeout(() => {
      if (!t.parentNode) return;
      t.style.transition = 'opacity .4s,transform .4s';
      t.style.opacity = '0'; t.style.transform = 'translateY(10px)';
      setTimeout(() => t.remove(), 400);
    }, ttl);
  }

  function toastError(msg) {
    toast(`<div style="display:flex;gap:8px;align-items:center;"><span style="font-size:16px">⚠️</span><div><b style="color:#fca5a5">Ошибка ГрамФикс</b><div style="color:#9090bb;font-size:11px;margin-top:2px">${msg}</div></div></div>`, 2500);
  }

  function toastChangesList(changes) {
    const list = changes.slice(0,4).map(c=>`<div style="color:#9090cc;font-size:11px;margin-top:3px">• ${c}</div>`).join('');
    const more = changes.length>4 ? `<div style="color:#6060aa;font-size:11px;margin-top:2px">ещё ${changes.length-4}...</div>` : '';
    return list + more;
  }

  function toastResult(mode, changes, changed) {
    if (mode === 'fix') {
      if (!changed || !changes.length) {
        toast(`<div style="display:flex;gap:8px;align-items:center;"><span style="font-size:16px">✅</span><span style="color:#a0a0cc">Ошибок не найдено</span></div>`, 2000);
      } else {
        const n = changes.length;
        const word = plural(n, ['ошибка','ошибки','ошибок']);
        toast(`<div style="display:flex;gap:8px;align-items:flex-start;"><span style="font-size:16px;flex-shrink:0">✏️</span><div><b style="margin-bottom:2px;display:block">Исправлено ${n} ${word}</b>${toastChangesList(changes)}</div></div>`, 4000);
      }
    } else if (mode === 'rephrase') {
      if (!changed) {
        toast(`<div style="display:flex;gap:8px;align-items:center;"><span style="font-size:16px">👌</span><span style="color:#a0a0cc">Текст уже хорошо сформулирован</span></div>`, 2000);
      } else {
        const body = changes.length ? toastChangesList(changes) : '';
        toast(`<div style="display:flex;gap:8px;align-items:flex-start;"><span style="font-size:16px;flex-shrink:0">🪄</span><div><b style="margin-bottom:2px;display:block">Текст переформулирован</b>${body}</div></div>`, 4000);
      }
    } else if (mode === 'translate') {
      if (!changed) {
        toast(`<div style="display:flex;gap:8px;align-items:center;"><span style="font-size:16px">🇬🇧</span><span style="color:#a0a0cc">Текст уже на английском</span></div>`, 2000);
      } else {
        toast(`<div style="display:flex;gap:8px;align-items:center;"><span style="font-size:16px">🌐</span><b>Переведено на английский</b></div>`, 2500);
      }
    }
  }

  // ===== МЕНЮ ДЕЙСТВИЙ =====
  let wrap = null;
  let activeEl = null;
  let isBusy = false;

  function clamp(v, min, max) { return Math.max(min, Math.min(v, max)); }

  // Значок перетащили — он стоит там, где его оставили, и к полю больше не привязан
  function placePinned(w) {
    const p = settings.gfPos;
    if (!p) return false;
    const ww = w.offsetWidth || 32, wh = w.offsetHeight || 32;
    w.style.left = clamp(p.left, 8, Math.max(8, window.innerWidth - ww - 8)) + 'px';
    w.style.top  = clamp(p.top,  8, Math.max(8, window.innerHeight - wh - 8)) + 'px';
    w.style.right = 'auto';
    return true;
  }

  function placeWrap(w, root) {
    if (placePinned(w)) return;
    const r = root.getBoundingClientRect();
    const h = 32, margin = 6;
    // position:fixed = координаты вьюпорта, scrollY НЕ добавляем
    let top;
    if (r.height >= h + margin * 2) {
      top = r.bottom - h - margin;          // поле высокое — меню внутри, у нижнего края
    } else if (r.top > h + margin + 8) {
      top = r.top - h - margin;             // узкое поле, сверху есть место — меню НАД полем
    } else {                                // (чат-композер прижат к низу экрана — снизу места нет)
      top = r.bottom + margin;              // сверху места нет — под полем
    }
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    // Якорим по правому краю — меню раскрывается влево
    let right = window.innerWidth - r.right + margin;
    right = Math.max(8, Math.min(right, window.innerWidth - h - 8));
    w.style.top = `${top}px`;
    w.style.right = `${right}px`;
    w.style.left = 'auto';
  }

  function renderCollapsed(w) {
    if (!w) return;
    w.innerHTML = `<button class="gf-chip gf-round" data-mode="fix" title="ГрамФикс: исправить орфографию и пунктуацию (${MODES.fix.hotkey}) · зажми и тащи, чтобы передвинуть">✨</button>`;
  }

  function renderExpanded(w) {
    if (!w) return;
    w.innerHTML = MENU_MODES.map((mode) => {
      const m = MODES[mode];
      if (!m) return '';
      return `<button class="gf-chip gf-${mode}" data-mode="${mode}" title="${m.label} (${m.hotkey})"><span>${m.icon}</span><span>${m.label}</span></button>`;
    }).join('');
  }

  function renderCounting(w, ms) {
    if (!w) return;
    w.innerHTML =
      `<button class="gf-chip gf-round gf-count" data-mode="fix" ` +
      `title="Автоисправление через ${Math.round(ms / 100) / 10} с · клик — исправить сразу, Esc — отменить">` +
        `<svg class="gf-ring" viewBox="0 0 36 36" style="--gf-dur:${ms}ms">` +
          `<circle class="bg" cx="18" cy="18" r="16"></circle>` +
          `<circle class="fg" cx="18" cy="18" r="16"></circle>` +
        `</svg>` +
        `<span class="gf-num">${Math.ceil(ms / 1000)}</span>` +
      `</button>`;
  }

  function renderLoading(w, mode) {
    if (!w) return;
    const m = MODES[mode] || MODES.fix;
    w.innerHTML = `<button class="gf-chip gf-loading-chip"><div id="gf-spinner"></div><span>${m.loading}</span></button>`;
  }

  function showMenu(el) {
    // ключ здесь НЕ проверяем: значок должен появляться всегда, когда модуль включён,
    // иначе без ключа модуль выглядит как «сломанный». Про ключ скажет тост по клику.
    if (!settings.enabled) return;
    const root = getRoot(el);
    if (!root) return;
    if (wrap && activeEl === root) return;
    removeMenu();
    activeEl = root;
    const r = root.getBoundingClientRect();
    if (r.width < 40) return;

    const w = document.createElement('div');
    w.id = 'gf-wrap';
    renderCollapsed(w);
    placeWrap(w, root);

    w.addEventListener('mouseenter', () => { if (!isBusy && !autoTimer && !drag) renderExpanded(w); });
    w.addEventListener('mouseleave', () => { if (!isBusy && !autoTimer && !drag) renderCollapsed(w); });

    w.addEventListener('mousedown', (e) => { onGrab(e, w); });
    w.addEventListener('touchstart', (e) => { onGrab(e, w); }, { passive: false });

    (document.body || document.documentElement).appendChild(w);
    wrap = w;
    placeWrap(w, root);   // повторно: теперь известны реальные размеры значка
  }

  // ===== ПЕРЕТАСКИВАНИЕ ЗНАЧКА =====
  let drag = null;

  function pt(e) { return e.touches ? e.touches[0] : e; }

  function onGrab(e, w) {
    const chip = e.target.closest?.('.gf-chip');
    // preventDefault на mousedown не даёт полю потерять фокус
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    if (!chip || isBusy) return;

    const p = pt(e);
    const r = w.getBoundingClientRect();
    drag = {
      mode: chip.dataset.mode || 'fix',
      dx: p.clientX - r.left, dy: p.clientY - r.top,
      sx: p.clientX, sy: p.clientY,
      moved: false
    };
    document.addEventListener('mousemove', onDragMove, true);
    document.addEventListener('mouseup', onDrop, true);
    document.addEventListener('touchmove', onDragMove, { capture: true, passive: false });
    document.addEventListener('touchend', onDrop, true);
  }

  function onDragMove(e) {
    if (!drag || !wrap) return;
    const p = pt(e);
    if (Math.abs(p.clientX - drag.sx) + Math.abs(p.clientY - drag.sy) > 4) {
      if (!drag.moved) wrap.classList.add('gf-dragging');
      drag.moved = true;
    }
    if (!drag.moved) return;
    if (e.cancelable) e.preventDefault();
    const ww = wrap.offsetWidth || 32, wh = wrap.offsetHeight || 32;
    wrap.style.left = clamp(p.clientX - drag.dx, 8, Math.max(8, window.innerWidth  - ww - 8)) + 'px';
    wrap.style.top  = clamp(p.clientY - drag.dy, 8, Math.max(8, window.innerHeight - wh - 8)) + 'px';
    wrap.style.right = 'auto';
  }

  function onDrop() {
    document.removeEventListener('mousemove', onDragMove, true);
    document.removeEventListener('mouseup', onDrop, true);
    document.removeEventListener('touchmove', onDragMove, { capture: true });
    document.removeEventListener('touchend', onDrop, true);
    const d = drag;
    drag = null;
    wrap?.classList.remove('gf-dragging');
    if (!d) return;

    if (d.moved) {
      // запоминаем место — значок останется здесь на всех сайтах
      if (wrap) {
        const r = wrap.getBoundingClientRect();
        const pos = { left: Math.round(r.left), top: Math.round(r.top) };
        settings.gfPos = pos;
        try { chrome.storage.local.set({ gfPos: pos }); } catch (e) {}
      }
      return;
    }

    // не двигали — это обычный клик
    cancelAuto(false);   // клик во время отсчёта — исправляем немедленно
    doAction(activeEl, d.mode);
  }

  function removeMenu() {
    cancelAuto(false);
    wrap?.remove(); wrap = null; activeEl = null;
  }

  // ===== ОБРАТНЫЙ ОТСЧЁТ ДО АВТОИСПРАВЛЕНИЯ =====
  let autoTimer = null;      // основной таймер
  let autoTick = null;       // обновление цифры на значке
  let autoEl = null;         // поле, для которого идёт отсчёт
  let autoDone = '';         // текст, который уже прогоняли — чтобы не гонять по кругу
  let autoOff = false;       // Esc отключил автоправку для текущего поля

  function cancelAuto(rerender = true) {
    if (autoTimer) clearTimeout(autoTimer);
    if (autoTick) clearInterval(autoTick);
    autoTimer = autoTick = null;
    autoEl = null;
    if (rerender && wrap && !isBusy) renderCollapsed(wrap);
  }

  function armAuto(root) {
    if (!settings.autoPause || !settings.enabled || !hasActiveKey()) return;
    if (!root || !wrap || isBusy || autoOff) return;

    const txt = getText(root).trim();
    // короткий текст или уже проверенный — отсчёт не нужен
    if (txt.length < AUTOFIX_MIN || txt === autoDone) { cancelAuto(); return; }

    cancelAuto(false);
    autoEl = root;

    const ms = Math.min(30, Math.max(1, Number(settings.autoDelay) || 3)) * 1000;
    const until = Date.now() + ms;
    renderCounting(wrap, ms);

    autoTick = setInterval(() => {
      const n = wrap?.querySelector('.gf-num');
      if (n) n.textContent = String(Math.max(0, Math.ceil((until - Date.now()) / 1000)));
    }, 200);

    autoTimer = setTimeout(() => {
      const el = autoEl;
      cancelAuto(false);
      if (el) doAction(el, 'fix', { keepFocus: true, guardText: true, auto: true });
    }, ms);
  }

  // ===== ОСНОВНАЯ ФУНКЦИЯ =====
  // opts.keepFocus — вернуть фокус туда, где он был (для автоисправления на выходе)
  // opts.guardText — не применять результат, если текст в поле успел смениться
  //                  (например, сообщение уже отправили и поле очистилось)
  // opts.auto      — запуск автоматический: запомнить результат, чтобы не повторяться
  async function doAction(el, mode, opts = {}) {
    if (!el || isBusy) return;
    const text = getText(el);
    if (!text || text.trim().length < 2) return;

    isBusy = true;
    renderLoading(wrap, mode);

    try {
      const result = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: 'processText', mode, text },
          (r) => resolve(r || { error: 'Нет ответа от расширения' })
        );
      });

      if (result?.error) {
        toastError(result.error === 'NO_API_KEY' ? 'Добавь API ключ в настройках расширения' : result.error);
        return;
      }

      const out = result?.fixed;
      const changed = !!(out && out.trim() !== text.trim());

      // помечаем текст как проверенный — иначе после автоправки отсчёт
      // запустится снова и уйдёт лишний запрос к API
      if (opts.auto) autoDone = (changed ? out : text).trim();

      if (changed) {
        // поле уже не то, что мы отправляли — молча выходим, чтобы не воскресить текст
        if (opts.guardText && getText(el).trim() !== text.trim()) return;

        const focusBefore = opts.keepFocus ? document.activeElement : null;
        setText(el, out);
        if (focusBefore && focusBefore !== el && typeof focusBefore.focus === 'function') {
          try { focusBefore.focus({ preventScroll: true }); } catch (e) {}
        }
        if (mode === 'fix') {
          const newCount = (settings.fixCount || 0) + (result.changes?.length || 1);
          chrome.storage.sync.set({ fixCount: newCount });
          settings.fixCount = newCount;
        }
      }
      if (settings.showDiff || !changed) toastResult(mode, result.changes || [], changed);
    } catch (e) {
      toastError('Ошибка: ' + e.message);
    } finally {
      isBusy = false;
      if (wrap?.parentNode) renderCollapsed(wrap);
    }
  }

  // ===== ПОКАЗАТЬ МЕНЮ ПРИ ПЕЧАТИ =====
  function onTyping(el) {
    if (!settings.enabled) return;
    showMenu(el);
    armAuto(getRoot(el));   // каждое нажатие перезапускает отсчёт
  }

  // ===== СОБЫТИЯ =====

  // Текст поля на момент входа в него — чтобы понять, правил ли пользователь
  let textOnFocus = '';

  // Фокус — сохранить активный элемент и исходный текст
  document.addEventListener('focusin', (e) => {
    if (isEditable(e.target)) {
      activeEl = getRoot(e.target) || e.target;
      textOnFocus = getText(activeEl);
      autoOff = false;   // новое поле — автоправка снова разрешена
    }
  }, true);

  // Клик — только сохранить активный элемент
  document.addEventListener('click', (e) => {
    if (e.target?.closest?.('#gf-wrap')) return;
    if (isEditable(e.target)) { activeEl = getRoot(e.target) || e.target; }
  }, true);

  // Печать — показать меню
  document.addEventListener('input', (e) => {
    if (isEditable(e.target)) onTyping(e.target);
  }, true);

  document.addEventListener('keyup', (e) => {
    if (!['Shift','Control','Alt','Meta','CapsLock','Tab','Escape'].includes(e.key)) {
      if (isEditable(e.target)) onTyping(e.target);
    }
  }, true);

  // Потеря фокуса — скрыть меню и, если включено, автоматически исправить текст
  document.addEventListener('focusout', (e) => {
    if (!isEditable(e.target)) return;
    const el = getRoot(e.target) || e.target;
    const textAtBlur = getText(el);
    const edited = textAtBlur.trim() !== (textOnFocus || '').trim();
    const wasCounting = !!autoTimer;
    cancelAuto(false);   // отсчёт не должен сработать вдогонку по покинутому полю

    setTimeout(() => {
      const inMenu = !!document.activeElement?.closest?.('#gf-wrap');
      if (!inMenu) removeMenu();

      // Автоисправление: только если пользователь реально что-то напечатал
      // и не ушёл в само меню ГрамФикса
      if (settings.autoFix && settings.enabled && hasActiveKey() &&
          !inMenu && !isBusy && edited &&
          textAtBlur.trim().length >= AUTOFIX_MIN) {
        doAction(el, 'fix', { keepFocus: true, guardText: true, auto: true });
      }
      // отсчёт шёл, но автоправка на выходе выключена — просто гасим значок
      else if (wasCounting && !inMenu && wrap && !isBusy) renderCollapsed(wrap);
    }, 200);
  }, true);

  // Escape — отменить отсчёт и не запускать его в этом поле, пока не перейдём в другое
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && autoTimer) {
      autoOff = true;
      cancelAuto();
    }
  }, true);

  // Горячие клавиши: Ctrl+Shift+F / S / E
  document.addEventListener('keydown', async (e) => {
    if (!e.ctrlKey || !e.shiftKey || e.altKey) return;
    let mode = null;
    if (e.code === 'KeyF') mode = 'fix';
    else if (e.code === 'KeyS') mode = 'rephrase';
    else if (e.code === 'KeyE') mode = 'translate';
    if (!mode) return;

    e.preventDefault();
    const root = getRoot(document.activeElement);
    if (root && hasActiveKey()) await doAction(root, mode);
    else if (!hasActiveKey()) toastError('Добавь API ключ в настройках ГрамФикс');
  }, true);

  // Скролл — обновлять позицию меню
  document.addEventListener('scroll', () => {
    if (wrap && activeEl) placeWrap(wrap, activeEl);
  }, { passive: true });

  window.addEventListener('resize', removeMenu);

  // Команды из popup
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'fixPage') {
      const sel = 'textarea, input[type="text"], input[type="search"], input[type="email"], [contenteditable="true"], [contenteditable=""]';
      let delay = 0;
      [...document.querySelectorAll(sel)].forEach((el) => {
        const text = getText(el);
        if (text && text.trim().length >= 2) { setTimeout(() => doAction(el, 'fix'), delay); delay += 700; }
      });
    }
  });

  // MutationObserver для SPA.
  // В некоторых фреймах (реклама, плееры) в момент запуска ещё нет <body>:
  // раньше здесь падало «parameter 1 is not of type 'Node'». Теперь ждём,
  // пока body появится, и только тогда начинаем следить.
  const spaObserver = new MutationObserver((muts) => {
    for (const m of muts) for (const node of m.addedNodes) {
      if (node.nodeType !== 1 || node.id === 'gf-wrap' || node.id === 'gf-toast') continue;
      if (isEditable(node) && document.activeElement === node) showMenu(node);
    }
  });
  function watchBody() {
    if (!document.body) return false;
    spaObserver.observe(document.body, { childList: true, subtree: true });
    return true;
  }
  if (!watchBody() && document.documentElement) {
    const waitBody = new MutationObserver(() => { if (watchBody()) waitBody.disconnect(); });
    waitBody.observe(document.documentElement, { childList: true });
  }

})();
