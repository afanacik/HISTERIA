'use strict';

// Скрытый документ расширения, который умеет играть звук, даже когда
// вкладка ChatGPT в фоне. Сами звуки — в sounds.js.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'sound-player' || message.type !== 'PLAY_SOUND') return;

  MyGptSignalSounds.play(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: String(error && error.message || error) }));
  return true;
});
