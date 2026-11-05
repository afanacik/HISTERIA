// Изолированный скрипт расширения на страницах ChatGPT.
// Решает, когда ответ действительно закончился, и подаёт сигнал.
// Три независимых признака, от надёжного к запасному:
//   1) сетевой поток ответа (сообщения от page-hook.js);
//   2) кнопка «Остановить» у поля ввода;
//   3) после отправки сообщения страница «печатала» и затихла.
// Текст сообщений и поля ввода не считывается.
(() => {
  'use strict';

  const SOURCE = 'my-gpt-signal';
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

  // ---------- Журнал ----------

  function log(text) {
    try {
      const r = chrome.runtime.sendMessage({ type: 'LOG', text });
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
      activity: false
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
    log(`Ответ готов (${how}) → сигнал`);
    ring();
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
      const settings = await chrome.storage.local.get({ sound: 'chime', volume: 70 });
      let dataUrl = null;
      if (settings.sound === 'custom') {
        const { customSound } = await chrome.storage.local.get('customSound');
        dataUrl = customSound && customSound.dataUrl;
      }
      await MyGptSignalSounds.play({ sound: settings.sound, volume: settings.volume, dataUrl });
      log(`Звук сыгран прямо на странице (запасной способ; причина: ${reason})`);
    } catch (error) {
      log(`Не удалось сыграть звук и на странице: ${error && error.message || error}`);
    }
  }

  async function ring() {
    const inBackground = document.visibilityState === 'hidden' || !document.hasFocus();
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: 'ANSWER_FINISHED', inBackground });
    } catch (error) {
      const text = String(error && error.message || error);
      if (/context invalidated/i.test(text)) return; // расширение обновлено — нужна F5
      return playHere(text);
    }
    if (!result) return playHere('фоновый скрипт не ответил');
    if (!result.ok) return playHere(result.error || 'ошибка фонового плеера');
  }

  // ---------- 1. Сетевой поток ----------

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
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

  new MutationObserver((mutations) => {
    scheduleDomCheck();
    noteActivity(mutations);
  }).observe(document, {
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

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target && target.closest('#prompt-textarea, [contenteditable="true"], textarea') &&
        target.closest(COMPOSER_SELECTOR)) {
      onSubmit('Enter');
    }
  }, true);

  document.addEventListener('click', (event) => {
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
    if (!message || message.type !== 'PING_TAB' || sender.id !== chrome.runtime.id) return;
    sendResponse({ ok: true, generating: isBusy() || Boolean(session) });
  });

  log('Вкладка ChatGPT подключена');
})();
