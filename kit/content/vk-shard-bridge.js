/* Кит — VK st fix: мост настроек (ISOLATED world)
   Переносит настройки модуля из chrome.storage в страницу:
   1) кэширует их в localStorage (перезаписчик читает мгновенно при старте);
   2) при изменении настроек шлёт событие — перезаписчик подхватывает на лету. */
(() => {
  const KEY = '__kit_vkfix';
  const DEF = { vkfixEnabled: true, vkfixFrom: '54', vkfixTo: 'st1-53.vk.ru' };

  const push = (cfg) => {
    const payload = JSON.stringify(cfg);
    try { localStorage.setItem(KEY, payload); } catch (e) {}
    try {
      document.documentElement.dispatchEvent(
        new CustomEvent('kit-vkfix-config', { detail: payload })
      );
    } catch (e) {}
  };

  const read = () => {
    try {
      chrome.storage.local.get(DEF, (s) => {
        if (chrome.runtime.lastError) return;
        push({
          on: s.vkfixEnabled !== false,
          from: String(s.vkfixFrom || DEF.vkfixFrom),
          to: String(s.vkfixTo || DEF.vkfixTo).toLowerCase()
        });
      });
    } catch (e) {}
  };

  read();
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && (ch.vkfixEnabled || ch.vkfixFrom || ch.vkfixTo)) read();
    });
  } catch (e) {}
})();
