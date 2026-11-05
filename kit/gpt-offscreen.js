'use strict';

// Скрытый документ Кита: играет сигнал ChatGPT, даже когда вкладка в фоне.
// Сами звуки — в content/gpt-sounds.js.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'kit-gpt-player' || message.type !== 'PLAY_SOUND') return;

  KitGptSounds.play(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: String(error && error.message || error) }));
  return true;
});
