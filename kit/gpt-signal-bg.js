/* Кит — модуль «Сигнал ChatGPT», фоновая часть.
   Подключается из background.js через importScripts.
   Отвечает за:
     1) звук через offscreen-документ (gpt-offscreen.html), когда ChatGPT ответил;
     2) системное уведомление (по желанию) с переходом на вкладку;
     3) статистику и журнал событий (только локально);
     4) подключение к уже открытым вкладкам ChatGPT после установки/обновления.
   Всё обёрнуто в объект self.kitGpt, чтобы не пересекаться с именами других модулей.
*/
(() => {
  'use strict';

  const G = self.kitGpt = {};

  G.DEFAULTS = {
    gptEnabled: true,        // модуль «Сигнал»
    gptBackgroundOnly: false,// молчать, если вкладка ChatGPT перед глазами
    gptNotify: false,        // системное уведомление
    gptMarkTab: true,        // зелёная галочка на вкладке
    gptSound: 'chime',       // chime | ding | soft | triple | coin | custom
    gptVolume: 70
  };
  G.EMPTY_STATS = { dings: 0, totalWaitMs: 0, longestMs: 0, day: '', today: 0 };

  const CHAT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
  const CHAT_URLS = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
  const OFFSCREEN = 'gpt-offscreen.html';
  const LOG_LIMIT = 40;
  let creatingOffscreen = null;
  let logChain = Promise.resolve();
  let statsChain = Promise.resolve();

  const errorText = (e) => String(e && e.message || e);
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- журнал (chrome.storage.session, ключ gptLog) ----------
  G.addLog = (text) => {
    const time = new Date().toLocaleTimeString('ru-RU');
    logChain = logChain.then(async () => {
      const { gptLog = [] } = await chrome.storage.session.get('gptLog');
      gptLog.push(`${time}  ${text}`);
      await chrome.storage.session.set({ gptLog: gptLog.slice(-LOG_LIMIT) });
    }).catch(() => {});
    return logChain;
  };

  // ---------- звук ----------
  G.ensureOffscreenDocument = async () => {
    const url = chrome.runtime.getURL(OFFSCREEN);
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [url]
    });
    if (existing.length) return;
    if (!creatingOffscreen) {
      creatingOffscreen = chrome.offscreen.createDocument({
        url: OFFSCREEN,
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Короткий звуковой сигнал о том, что ChatGPT закончил отвечать.'
      }).finally(() => { creatingOffscreen = null; });
    }
    await creatingOffscreen;
  };

  G.sendToPlayer = async (payload) => {
    // Только что созданный документ может не успеть подписаться на сообщения.
    let lastError;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const result = await chrome.runtime.sendMessage({ target: 'kit-gpt-player', ...payload });
        if (result && result.ok) return result;
        lastError = new Error((result && result.error) || 'Нет ответа от плеера');
      } catch (error) {
        lastError = error;
      }
      await delay(100 * (attempt + 1));
    }
    throw lastError;
  };

  G.playSound = async (settings) => {
    const volume = Math.max(0, Math.min(100, Number(settings.gptVolume) || 0));
    if (volume === 0) return { ok: true, result: 'muted' };
    let dataUrl = null;
    if (settings.gptSound === 'custom') {
      const { gptCustomSound } = await chrome.storage.local.get('gptCustomSound');
      dataUrl = gptCustomSound && gptCustomSound.dataUrl;
    }
    await G.ensureOffscreenDocument();
    return G.sendToPlayer({
      type: 'PLAY_SOUND',
      sound: dataUrl ? 'custom' : (settings.gptSound === 'custom' ? 'chime' : settings.gptSound),
      dataUrl,
      volume
    });
  };

  // ---------- уведомление ----------
  G.showNotification = async (tab) => {
    const id = `kit-gpt-${Date.now()}`;
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'ChatGPT ответил',
      message: 'Ответ готов. Нажмите, чтобы открыть вкладку.',
      silent: true,
      priority: 1
    });
    if (tab && typeof tab.id === 'number') {
      await chrome.storage.session.set({ [id]: { tabId: tab.id, windowId: tab.windowId } });
    }
  };

  chrome.notifications.onClicked.addListener(async (id) => {
    if (!id.startsWith('kit-gpt-')) return;
    const stored = await chrome.storage.session.get(id);
    const target = stored[id];
    chrome.notifications.clear(id);
    chrome.storage.session.remove(id);
    if (!target) return;
    try {
      await chrome.tabs.update(target.tabId, { active: true });
      await chrome.windows.update(target.windowId, { focused: true });
    } catch (_) { /* вкладку уже закрыли */ }
  });
  chrome.notifications.onClosed.addListener((id) => {
    if (id.startsWith('kit-gpt-')) chrome.storage.session.remove(id);
  });

  // ---------- статистика (chrome.storage.local, ключ gptStats) ----------
  G.localDay = () => {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  };

  G.recordStats = (waitedMs) => {
    const wait = Math.max(0, Math.min(Number(waitedMs) || 0, 6 * 60 * 60 * 1000));
    statsChain = statsChain.then(async () => {
      const { gptStats } = await chrome.storage.local.get({ gptStats: G.EMPTY_STATS });
      const s = { ...G.EMPTY_STATS, ...gptStats };
      const day = G.localDay();
      await chrome.storage.local.set({ gptStats: {
        dings: s.dings + 1,
        totalWaitMs: s.totalWaitMs + wait,
        longestMs: Math.max(s.longestMs, wait),
        day,
        today: s.day === day ? s.today + 1 : 1
      } });
    }).catch(() => {});
    return statsChain;
  };

  // ---------- подключение к открытым вкладкам ----------
  G.injectIntoOpenTabs = async () => {
    const tabs = await chrome.tabs.query({ url: CHAT_URLS });
    let connected = 0;
    for (const tab of tabs) {
      if (typeof tab.id !== 'number' || tab.discarded) continue;
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/gpt-hook.js'], world: 'MAIN' });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/gpt-sounds.js', 'content/gpt-signal.js'] });
        connected++;
      } catch (_) { /* вкладка грузится или закрыта — подключится сама */ }
    }
    return connected;
  };

  chrome.runtime.onInstalled.addListener(async () => {
    G.addLog(`Кит v${chrome.runtime.getManifest().version}: модуль «Сигнал» готов`);
    const n = await G.injectIntoOpenTabs().catch(() => 0);
    if (n) G.addLog(`Подключено к открытым вкладкам ChatGPT: ${n} (обновлять не нужно)`);
  });

  // ---------- сообщения ----------
  function fromChatPage(sender) {
    try {
      const url = new URL(sender.url);
      return sender.id === chrome.runtime.id && Boolean(sender.tab) &&
        url.protocol === 'https:' && CHAT_HOSTS.has(url.hostname);
    } catch (_) {
      return false;
    }
  }

  function fromPopup(sender) {
    return sender.id === chrome.runtime.id && typeof sender.url === 'string' &&
      sender.url.startsWith(chrome.runtime.getURL('popup.html'));
  }

  G.handleAnswerFinished = async (message, sender) => {
    const settings = await chrome.storage.local.get(G.DEFAULTS);
    if (!settings.gptEnabled) {
      G.addLog('Модуль «Сигнал» выключен — молчу');
      return { ok: true, skipped: 'disabled' };
    }
    if (settings.gptBackgroundOnly && !message.inBackground) {
      G.addLog('Вы смотрите на вкладку, а включено «Только в фоне» — молчу');
      return { ok: true, skipped: 'foreground' };
    }
    G.recordStats(message.waitedMs);
    if (settings.gptNotify && message.inBackground) {
      G.showNotification(sender.tab).catch((e) => G.addLog(`Уведомление не показано: ${errorText(e)}`));
    }
    try {
      const result = await G.playSound(settings);
      G.addLog(result && result.result === 'muted' ? 'Громкость 0 — звук не слышен' : 'Звук сыгран ✓');
      return { ok: true };
    } catch (error) {
      G.addLog(`Фоновый плеер не сработал: ${errorText(error)}`);
      throw error;
    }
  };

  G.handleTest = async (message) => {
    const settings = { ...(await chrome.storage.local.get(G.DEFAULTS)), ...(message.preview || {}) };
    try {
      await G.playSound(settings);
    } catch (error) {
      G.addLog(`Проверка звука: фоновый плеер не сработал: ${errorText(error)}`);
      throw error;
    }
    G.addLog('Проверка звука: сыгран ✓');
    if (message.withNotification) {
      await G.showNotification(null).catch((e) => G.addLog(`Уведомление не показано: ${errorText(e)}`));
    }
    return { ok: true };
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string' || !message.type.startsWith('gpt:')) return;

    if (message.type === 'gpt:log' && fromChatPage(sender) && typeof message.text === 'string') {
      G.addLog(message.text.slice(0, 200));
      return;
    }

    let job;
    if (message.type === 'gpt:answer' && fromChatPage(sender)) job = G.handleAnswerFinished(message, sender);
    else if (message.type === 'gpt:test' && fromPopup(sender)) job = G.handleTest(message);
    else return;

    job.then(sendResponse).catch((error) => {
      console.warn('[Кит · Сигнал]', error);
      sendResponse({ ok: false, error: errorText(error) });
    });
    return true;
  });
})();
