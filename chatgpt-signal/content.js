// Изолированный скрипт расширения на страницах ChatGPT.
// Решает, когда ответ действительно закончился, и просит фоновый
// скрипт подать сигнал. Использует два независимых признака:
//   1) сетевой поток ответа (сообщения от page-hook.js) — основной;
//   2) кнопка «Остановить» у поля ввода — запасной, если ChatGPT
//      поменяет способ доставки ответа.
// Текст сообщений и поля ввода не считывается.
(() => {
  'use strict';

  const SOURCE = 'my-gpt-signal';
  // Сколько ответ должен «молчать», прежде чем считать его законченным.
  // Защищает от двойных сигналов, когда ChatGPT переподключает поток.
  const QUIET_MS = 1500;
  const DOM_CHECK_THROTTLE_MS = 300;

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
    'button[aria-label="Stop" i]'
  ].join(',');
  const COMPOSER_SELECTOR =
    'form, #composer, [data-testid*="composer"], [data-chatgpt-composer], #thread-bottom';

  const activeStreams = new Set();
  let domBusy = false;
  let session = null;          // текущий «ответ» от начала до конца
  let quietTimer = null;
  let domCheckTimer = null;

  function newSession() {
    return { sawStream: false, lastStream: null, userStopped: false };
  }

  function isVisible(el) {
    if (!el || !el.isConnected || el.hidden) return false;
    if (el.getClientRects().length === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function isStopButton(el) {
    if (!el || !el.matches(STOP_SELECTORS) || !isVisible(el)) return false;
    // Короткие подписи вроде «Stop» бывают у плеера/диктовки — принимаем
    // их только рядом с полем ввода.
    if (el.matches('[data-testid*="stop"]')) return true;
    return Boolean(el.closest(COMPOSER_SELECTOR));
  }

  function stopButtonVisible() {
    for (const el of document.querySelectorAll(STOP_SELECTORS)) {
      if (isStopButton(el)) return true;
    }
    return false;
  }

  function isBusy() {
    return activeStreams.size > 0 || domBusy;
  }

  function update() {
    if (isBusy()) {
      if (!session) session = newSession();
      if (quietTimer !== null) {
        clearTimeout(quietTimer);
        quietTimer = null;
      }
      return;
    }
    if (!session || quietTimer !== null) return;

    quietTimer = setTimeout(() => {
      quietTimer = null;
      domBusy = stopButtonVisible();
      if (isBusy() || !session) return update();

      const finished = session;
      session = null;
      const completed = !finished.userStopped &&
        (!finished.sawStream || finished.lastStream === 'done');
      if (completed) notifyFinished();
    }, QUIET_MS);
  }

  function notifyFinished() {
    const inBackground = document.visibilityState === 'hidden' || !document.hasFocus();
    try {
      const result = chrome.runtime.sendMessage({ type: 'ANSWER_FINISHED', inBackground });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (_) {
      // Расширение перезагрузили, пока вкладка была открыта — нужно обновить страницу.
    }
  }

  // --- 1. Сетевой поток (от page-hook.js) ---
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE || typeof data.type !== 'string') return;

    if (data.type === 'stream-start') {
      activeStreams.add(data.id);
      if (!session) session = newSession();
      session.sawStream = true;
    } else if (data.type === 'stream-done' || data.type === 'stream-aborted') {
      activeStreams.delete(data.id);
      if (session) session.lastStream = data.type === 'stream-done' ? 'done' : 'aborted';
    } else {
      return;
    }
    update();
  });

  // --- 2. Кнопка «Остановить» ---
  function checkDom() {
    domCheckTimer = null;
    const visible = stopButtonVisible();
    if (visible !== domBusy) {
      domBusy = visible;
      update();
    }
  }

  function scheduleDomCheck() {
    if (domCheckTimer === null) domCheckTimer = setTimeout(checkDom, DOM_CHECK_THROTTLE_MS);
  }

  new MutationObserver(scheduleDomCheck).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-testid', 'aria-label', 'hidden', 'disabled', 'class', 'style']
  });

  // Пользователь сам остановил ответ — сигнал не нужен.
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target && target.closest('button, [role="button"]');
    if (button && isStopButton(button) && session) session.userStopped = true;
  }, true);

  // Окно расширения спрашивает, подключена ли вкладка.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'PING_TAB' || sender.id !== chrome.runtime.id) return;
    sendResponse({ ok: true, generating: isBusy() });
  });
})();
