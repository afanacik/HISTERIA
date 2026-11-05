/* Кит · мост для модуля «Невидимка»
   Скрипт невидимки работает в MAIN-мире и не имеет доступа к chrome.storage.
   Мост живёт в изолированном мире и переносит настройки из попапа на страницу
   через data-атрибуты на <html>:
       data-ak-stealth-mod = on|off   — модуль включён
       data-ak-stealth     = on|off   — не помечать прочитанным
       data-ak-online      = on|off   — скрывать онлайн
       data-ak-typing      = on|off   — скрывать «печатает…»
       data-ak-diag        = on|off   — журнал диагностики
       data-ak-online-re   = строка   — свои шаблоны для «онлайн» (через запятую)

   То же дублируется в localStorage: на старте страницы MAIN-скрипт выполняется
   раньше моста и читает состояние оттуда. */

(function () {
  'use strict';

  const root = document.documentElement;
  const DEF = { modStealth: true, stealthOn: true, onlineOn: false, typingOn: false, diagOn: false, onlineRe: '' };

  function apply(s) {
    const read   = (s.stealthOn !== false);
    const online = (s.onlineOn === true);
    const typing = (s.typingOn === true);
    const diag   = (s.diagOn === true);
    const re     = String(s.onlineRe || '');
    root.dataset.akStealthMod = (s.modStealth === false) ? 'off' : 'on';
    root.dataset.akStealth    = read   ? 'on' : 'off';
    root.dataset.akOnline     = online ? 'on' : 'off';
    root.dataset.akTyping     = typing ? 'on' : 'off';
    root.dataset.akDiag       = diag   ? 'on' : 'off';
    root.dataset.akOnlineRe   = re;
    try {
      localStorage.setItem('vk_stealth_read',      read   ? '1' : '0');
      localStorage.setItem('vk_stealth_online',    online ? '1' : '0');
      localStorage.setItem('vk_stealth_typing',    typing ? '1' : '0');
      localStorage.setItem('vk_stealth_diag',      diag   ? '1' : '0');
      localStorage.setItem('vk_stealth_online_re', re);
      if (!diag) localStorage.removeItem('kit_diag');
    } catch (e) {}
  }

  // Сначала мгновенно ставим то, что запомнили в прошлый раз (localStorage синхронный),
  // потом подтягиваем актуальное из chrome.storage.
  try {
    const ls = (k) => localStorage.getItem(k);
    if (ls('vk_stealth_read') !== null) {
      apply({ modStealth: true, stealthOn: ls('vk_stealth_read') !== '0', onlineOn: ls('vk_stealth_online') === '1', typingOn: ls('vk_stealth_typing') === '1',
              diagOn: ls('vk_stealth_diag') === '1', onlineRe: ls('vk_stealth_online_re') || '' });
    }
  } catch (e) {}
  function pull() { try { chrome.storage.local.get(DEF, apply); } catch (e) {} }
  pull();

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.modStealth || changes.stealthOn || changes.onlineOn || changes.typingOn || changes.diagOn || changes.onlineRe) pull();
    });
  } catch (e) {}
})();
