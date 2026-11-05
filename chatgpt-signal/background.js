'use strict';

const DEFAULTS = {
  enabled: true,
  backgroundOnly: false,
  notify: false,
  sound: 'chime',
  volume: 70
};
const CHAT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
let creatingOffscreen = null;

// ---------- Звук через offscreen-документ ----------

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL('offscreen.html');
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url]
  });
  if (existing.length) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Короткий звуковой сигнал о том, что ChatGPT закончил отвечать.'
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendToPlayer(payload) {
  // Только что созданный документ может ещё не успеть подписаться
  // на сообщения — несколько коротких повторов решают это.
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const result = await chrome.runtime.sendMessage({ target: 'sound-player', ...payload });
      if (result && result.ok) return result;
      lastError = new Error((result && result.error) || 'Нет ответа от плеера');
    } catch (error) {
      lastError = error;
    }
    await delay(100 * (attempt + 1));
  }
  throw lastError;
}

async function playSound(settings) {
  const volume = Math.max(0, Math.min(100, Number(settings.volume) || 0));
  if (volume === 0) return;

  let customSound = null;
  if (settings.sound === 'custom') {
    const stored = await chrome.storage.local.get('customSound');
    customSound = stored.customSound && stored.customSound.dataUrl;
  }

  await ensureOffscreenDocument();
  await sendToPlayer({
    type: 'PLAY_SOUND',
    sound: customSound ? 'custom' : (settings.sound === 'custom' ? 'chime' : settings.sound),
    dataUrl: customSound,
    volume
  });
}

// ---------- Системное уведомление ----------

async function showNotification(tab) {
  const id = `answer-${Date.now()}`;
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
}

chrome.notifications.onClicked.addListener(async (id) => {
  const stored = await chrome.storage.session.get(id);
  const target = stored[id];
  chrome.notifications.clear(id);
  chrome.storage.session.remove(id);
  if (!target) return;
  try {
    await chrome.tabs.update(target.tabId, { active: true });
    await chrome.windows.update(target.windowId, { focused: true });
  } catch (_) {
    // Вкладку уже закрыли.
  }
});

chrome.notifications.onClosed.addListener((id) => {
  chrome.storage.session.remove(id);
});

// ---------- Сообщения ----------

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
  return sender.id === chrome.runtime.id &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(chrome.runtime.getURL('popup.html'));
}

async function handleAnswerFinished(message, sender) {
  const settings = await chrome.storage.local.get(DEFAULTS);
  if (!settings.enabled) return { ok: true, skipped: 'disabled' };
  if (settings.backgroundOnly && !message.inBackground) return { ok: true, skipped: 'foreground' };

  const tasks = [playSound(settings)];
  if (settings.notify) tasks.push(showNotification(sender.tab));
  const results = await Promise.allSettled(tasks);
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
  return { ok: true };
}

async function handleTest(message) {
  const settings = { ...(await chrome.storage.local.get(DEFAULTS)), ...(message.preview || {}) };
  await playSound(settings);
  if (message.withNotification) await showNotification(null);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;

  let job;
  if (message.type === 'ANSWER_FINISHED' && fromChatPage(sender)) {
    job = handleAnswerFinished(message, sender);
  } else if (message.type === 'TEST_SOUND' && fromPopup(sender)) {
    job = handleTest(message);
  } else {
    return;
  }

  job.then(sendResponse).catch((error) => {
    console.warn('[Мой сигнал]', error);
    sendResponse({ ok: false, error: String(error && error.message || error) });
  });
  return true;
});
