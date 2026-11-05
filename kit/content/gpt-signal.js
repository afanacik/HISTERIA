// Изолированный скрипт расширения на страницах ChatGPT.
// Решает, когда ответ действительно закончился, и подаёт сигнал.
// Три независимых признака, от надёжного к запасному:
//   1) сетевой поток ответа (сообщения от gpt-hook.js);
//   2) кнопка «Остановить» у поля ввода;
//   3) после отправки сообщения страница «печатала» и затихла.
// Текст сообщений и поля ввода не считывается.
(() => {
  'use strict';

  // После обновления расширения скрипт заново внедряется в открытые вкладки.
  // Старая копия теряет связь с расширением — убираем её следы.
  const previous = globalThis.__kitGptSignalInstance;
  if (previous && previous.alive()) return;
  if (previous) previous.teardown();

  const SOURCE = 'kit-gpt-signal';
  const QUIET_MS = 1500;            // тишина после потока/кнопки до сигнала
  const DOM_CHECK_THROTTLE_MS = 300;
  const SUBMIT_WINDOW_MS = 15000;   // поток в эти секунды после отправки — наш
  const ACTIVITY_GRACE_MS = 8000;   // раньше этого запасной способ не срабатывает
  const ACTIVITY_QUIET_MS = 5000;   // столько страница должна не меняться
  const SESSION_GIVE_UP_MS = 60000; // после отправки ничего не происходит — забываем

  const STOP_SELECTORS = [
    '[data-testid="stop-button"]',
    '[data-testid="stop-generating"]',
    '[data-testid="stop-generation"]',
    '[data-testid="composer-stop-button"]',
    '[data-testid*="stop-button"]',
    'button[aria-label="Stop streaming" i]',
    'button[aria-label="Stop generating" i]',
    'button[aria-label="Stop answering" i]',
    'button[aria-label="Stop response" i]',
    'button[aria-label="Остановить потоковую передачу" i]',
    'button[aria-label="Остановить генерацию" i]',
    'button[aria-label="Остановить ответ" i]',
    'button[aria-label="Остановить" i]',
    'button[aria-label="Stop" i]',
    '.result-streaming',
    '.streaming-animation'
  ].join(',');
  const COMPOSER_SELECTOR =
    'form, #composer, #prompt-textarea, [data-testid*="composer"], [data-chatgpt-composer], #thread-bottom';
  const SEND_SELECTOR =
    '[data-testid="send-button"], #composer-submit-button, button[type="submit"], ' +
    'button[aria-label*="Send" i], button[aria-label*="Отправ" i]';

  const activeStreams = new Set();
  let domBusy = false;
  let session = null;
  let lastSubmit = 0;
  let quietTimer = null;
  let activityTimer = null;
  let domCheckTimer = null;

  const cleanups = [];
  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  }
  function contextAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }
  function teardown() {
    while (cleanups.length) {
      try { cleanups.pop()(); } catch (_) { /* ignore */ }
    }
    clearTabMark();
  }
  globalThis.__kitGptSignalInstance = { alive: contextAlive, teardown };

  // ---------- Отметка на вкладке ----------
  // Когда ответ готов, а вы смотрите в другое место, значок вкладки
  // меняется на зелёный кружок с галочкой (без значка — «✅» в заголовке).
  // Всё возвращается, как только вы откроете вкладку.
  //
  // Узлы страницы не создаются и не удаляются (ChatGPT — React-приложение,
  // это может его сломать): меняются только текст заголовка и атрибут href
  // у существующих <link rel="icon">.
  const TITLE_MARK = '✅ ';
  let markIcon = null;
  let tabMarked = false;
  let headObserver = null;
  const iconOriginals = new Map();

  function drawMarkIcon() {
    if (markIcon) return markIcon;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const g = canvas.getContext('2d');
    g.fillStyle = '#141826';
    g.beginPath(); g.arc(32, 32, 31, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#22c55e';
    g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#ffffff';
    g.lineWidth = 7;
    g.lineCap = g.lineJoin = 'round';
    g.beginPath(); g.moveTo(19, 33); g.lineTo(28, 42); g.lineTo(46, 23); g.stroke();
    markIcon = canvas.toDataURL('image/png');
    return markIcon;
  }

  function titleTextNode() {
    const node = document.querySelector('head > title');
    return node && node.firstChild && node.firstChild.nodeType === Node.TEXT_NODE ? node.firstChild : null;
  }

  function iconLinks() {
    return [...document.querySelectorAll('head > link[rel~="icon"]')];
  }

  function applyTabMark() {
    const icon = drawMarkIcon();
    const links = iconLinks();
    // «✅» в заголовке — только если у страницы нет значка, чтобы не было двух галочек.
    const text = links.length ? null : titleTextNode();
    if (text && !text.nodeValue.startsWith(TITLE_MARK)) text.nodeValue = TITLE_MARK + text.nodeValue;
    for (const link of links) {
      if (link.getAttribute('href') === icon) continue;
      if (!iconOriginals.has(link)) {
        iconOriginals.set(link, { href: link.getAttribute('href'), type: link.getAttribute('type') });
      }
      link.setAttribute('href', icon);
      if (link.hasAttribute('type')) link.setAttribute('type', 'image/png');
    }
  }

  function markTab() {
    if (tabMarked || !document.head) return;
    tabMarked = true;
    applyTabMark();
    // ChatGPT может сменить значок или заголовок (название чата) — возвращаем отметку.
    headObserver = new MutationObserver(() => { if (tabMarked) applyTabMark(); });
    headObserver.observe(document.head, {
      childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href']
    });
  }

  function clearTabMark() {
    if (!tabMarked) return;
    tabMarked = false;
    if (headObserver) headObserver.disconnect();
    headObserver = null;
    const text = titleTextNode();
    if (text && text.nodeValue.startsWith(TITLE_MARK)) text.nodeValue = text.nodeValue.slice(TITLE_MARK.length);
    for (const [link, original] of iconOriginals) {
      if (link.getAttribute('href') !== markIcon) continue;
      if (typeof original.href === 'string') link.setAttribute('href', original.href);
      if (typeof original.type === 'string') link.setAttribute('type', original.type);
      else link.removeAttribute('type');
    }
    iconOriginals.clear();
  }

  function tabUnseen() {
    return document.visibilityState !== 'visible' || !document.hasFocus();
  }

  listen(document, 'visibilitychange', () => {
    if (document.visibilityState === 'visible' && document.hasFocus()) clearTabMark();
  });
  listen(window, 'focus', clearTabMark);

  // ---------- Журнал ----------

  function log(text) {
    try {
      const r = chrome.runtime.sendMessage({ type: 'gpt:log', text });
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (_) { /* расширение перезагружено */ }
  }

  // ---------- Признак «идёт ответ» ----------

  function startSession(reason) {
    if (session) return session;
    session = {
      started: Date.now(),
      sawStream: false,
      sawDom: false,
      lastStream: null,
      userStopped: false,
      activity: false,
      // Ожидание считаем от момента отправки, если она была только что.
      sentAt: lastSubmit && Date.now() - lastSubmit < SUBMIT_WINDOW_MS ? lastSubmit : 0
    };
    log(`Начался ответ (${reason})`);
    return session;
  }

  function isVisible(el) {
    if (!el || !el.isConnected || el.hidden) return false;
    if (el.getClientRects().length === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function isStopIndicator(el) {
    if (!el || !el.matches(STOP_SELECTORS) || !isVisible(el)) return false;
    if (el.matches('[data-testid*="stop"], .result-streaming, .streaming-animation')) return true;
    // Короткие подписи вроде «Stop» бывают у плеера/диктовки — только рядом с полем ввода.
    return Boolean(el.closest(COMPOSER_SELECTOR));
  }

  function stopButtonVisible() {
    for (const el of document.querySelectorAll(STOP_SELECTORS)) {
      if (isStopIndicator(el)) return true;
    }
    return false;
  }

  function isBusy() {
    return activeStreams.size > 0 || domBusy;
  }

  function clearTimer(name) {
    if (name === 'quiet' && quietTimer !== null) { clearTimeout(quietTimer); quietTimer = null; }
    if (name === 'activity' && activityTimer !== null) { clearTimeout(activityTimer); activityTimer = null; }
  }

  function finish(how) {
    const done = session;
    session = null;
    clearTimer('quiet');
    clearTimer('activity');
    if (!done) return;

    if (done.userStopped) return log('Ответ остановлен вами — без сигнала');
    if (done.sawStream && done.lastStream !== 'done' && !done.sawDom) {
      return log('Поток ответа оборван — без сигнала');
    }
    const waitedMs = Date.now() - (done.sentAt || done.started);
    log(`Ответ готов (${how}, ${Math.round(waitedMs / 1000)} с) → сигнал`);
    ring(waitedMs);
  }

  // Вызывается при каждом изменении признаков потока/кнопки.
  function update() {
    if (isBusy()) {
      clearTimer('quiet');
      return;
    }
    if (!session || quietTimer !== null) return;
    if (!session.sawStream && !session.sawDom) return; // ждём запасной способ

    quietTimer = setTimeout(() => {
      quietTimer = null;
      domBusy = stopButtonVisible();
      if (isBusy()) return update();
      finish(session && session.sawStream ? 'поток завершён' : 'кнопка «Стоп» исчезла');
    }, QUIET_MS);
  }

  // ---------- Сигнал ----------

  async function playHere(reason) {
    try {
      const settings = await chrome.storage.local.get({ gptSound: 'chime', gptVolume: 70 });
      let dataUrl = null;
      if (settings.gptSound === 'custom') {
        const { gptCustomSound: customSound } = await chrome.storage.local.get('gptCustomSound');
        dataUrl = customSound && customSound.dataUrl;
      }
      await KitGptSounds.play({ sound: settings.gptSound, volume: settings.gptVolume, dataUrl });
      log(`Звук сыгран прямо на странице (запасной способ; причина: ${reason})`);
    } catch (error) {
      log(`Не удалось сыграть звук и на странице: ${error && error.message || error}`);
    }
  }

  async function ring(waitedMs) {
    const inBackground = tabUnseen();
    // Отметка на вкладке ставится первой — она нужна, даже если звук не сыграет.
    if (inBackground) {
      try {
        const { gptEnabled: enabled, gptMarkTab: mark } = await chrome.storage.local.get({ gptEnabled: true, gptMarkTab: true });
        if (enabled && mark) markTab();
      } catch (_) { /* расширение перезагружено */ }
    }
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: 'gpt:answer', inBackground, waitedMs });
    } catch (error) {
      const text = String(error && error.message || error);
      if (/context invalidated/i.test(text)) return; // расширение обновлено — нужна F5
      return playHere(text);
    }
    if (!result) return playHere('фоновый скрипт не ответил');
    if (!result.ok) return playHere(result.error || 'ошибка фонового плеера');
  }

  // ---------- 1. Сетевой поток ----------

  listen(window, 'message', (event) => {
    if (event.source !== window) return;
    if (!contextAlive()) return teardown();
    const data = event.data;
    if (!data || data.source !== SOURCE || typeof data.type !== 'string') return;

    if (data.type === 'hook-ready') return;

    if (data.type === 'stream-start') {
      const relevant = /conversation/i.test(data.path || '') ||
        (lastSubmit && Date.now() - lastSubmit < SUBMIT_WINDOW_MS);
      log(`Поток ${relevant ? 'начался' : 'пропущен (не ответ)'}: ${data.path}`);
      if (!relevant) return;
      activeStreams.add(data.id);
      startSession('поток').sawStream = true;
      clearTimer('activity');
    } else if (data.type === 'stream-done' || data.type === 'stream-aborted') {
      if (!activeStreams.delete(data.id)) return;
      const ok = data.type === 'stream-done';
      log(ok ? 'Поток ответа завершён' : 'Поток ответа оборван');
      if (session) session.lastStream = ok ? 'done' : 'aborted';
    } else {
      return;
    }
    update();
  });

  // ---------- 2. Кнопка «Остановить» + 3. Активность страницы ----------

  function checkDom() {
    domCheckTimer = null;
    const visible = stopButtonVisible();
    if (visible === domBusy) return;
    domBusy = visible;
    log(visible ? 'Появилась кнопка «Стоп»' : 'Кнопка «Стоп» исчезла');
    if (visible) {
      startSession('кнопка «Стоп»').sawDom = true;
      clearTimer('activity');
    }
    update();
  }

  function scheduleDomCheck() {
    if (domCheckTimer === null) domCheckTimer = setTimeout(checkDom, DOM_CHECK_THROTTLE_MS);
  }

  // Запасной способ: ни потока, ни кнопки не видно, но страница после
  // отправки менялась — считаем ответ готовым, когда она затихнет.
  function activityCheck() {
    activityTimer = null;
    if (!session || session.sawStream || session.sawDom) return;
    const age = Date.now() - session.started;
    if (!session.activity) {
      if (age > SESSION_GIVE_UP_MS) {
        log('После отправки страница не менялась — ждать перестал');
        session = null;
      } else {
        activityTimer = setTimeout(activityCheck, ACTIVITY_QUIET_MS);
      }
      return;
    }
    if (age < ACTIVITY_GRACE_MS) {
      activityTimer = setTimeout(activityCheck, ACTIVITY_GRACE_MS - age);
      return;
    }
    finish('страница перестала меняться');
  }

  function noteActivity(mutations) {
    if (!session || session.sawStream || session.sawDom) return;
    const relevant = mutations.some((m) => {
      const node = m.target instanceof Element ? m.target : m.target.parentElement;
      return node && !node.closest(COMPOSER_SELECTOR);
    });
    if (!relevant) return;
    session.activity = true;
    clearTimer('activity');
    activityTimer = setTimeout(activityCheck, ACTIVITY_QUIET_MS);
  }

  const pageObserver = new MutationObserver((mutations) => {
    if (!contextAlive()) return teardown();
    scheduleDomCheck();
    noteActivity(mutations);
  });
  cleanups.push(() => pageObserver.disconnect());
  pageObserver.observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-testid', 'aria-label', 'hidden', 'disabled', 'class', 'style']
  });

  // ---------- Действия пользователя ----------

  function onSubmit(how) {
    lastSubmit = Date.now();
    log(`Вы отправили сообщение (${how})`);
    // Даём потоку/кнопке шанс проявиться; иначе включится запасной способ.
    setTimeout(() => {
      if (session || isBusy()) return;
      startSession('отправка, ждём изменений страницы');
      clearTimer('activity');
      activityTimer = setTimeout(activityCheck, ACTIVITY_QUIET_MS);
    }, 1200);
  }

  listen(document, 'keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target && target.closest('#prompt-textarea, [contenteditable="true"], textarea') &&
        target.closest(COMPOSER_SELECTOR)) {
      onSubmit('Enter');
    }
  }, true);

  listen(document, 'click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target && target.closest('button, [role="button"]');
    if (!button) return;
    if (isStopIndicator(button)) {
      if (session) session.userStopped = true;
      log('Вы нажали «Стоп»');
      return;
    }
    if (button.matches(SEND_SELECTOR) && button.closest(COMPOSER_SELECTOR)) onSubmit('кнопка');
  }, true);

  // Окно расширения спрашивает, подключена ли вкладка.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || sender.id !== chrome.runtime.id) return;
    if (message.type === 'gpt:clearMark') return clearTabMark();
    if (message.type !== 'gpt:ping') return;
    sendResponse({ ok: true, generating: isBusy() || Boolean(session) });
  });

  log('Вкладка ChatGPT подключена');
})();
