// ==UserScript==
// @name         Dzine — запрет платных моделей + GPT Image 2.0 по умолчанию
// @namespace    klub-dzine
// @version      1.2
// @description  Если выбрана платная модель (Ideogram 4.5, Seedream 5.0 Flash, Nano Banana 2.1) — генерация не запускается, и скрипт сам переключает на GPT Image 2.0. При открытии Dzine сразу ставит GPT Image 2.0.
// @match        *://*.dzine.ai/*
// @match        *://dzine.ai/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ============ НАСТРОЙКИ ============
    const BLOCKED = [            // точные названия платных моделей
        'Ideogram 4.5',
        'Seedream 5.0 Flash',
        'Nano Banana 2.1',
    ];
    const DEFAULT_MODEL = 'GPT Image 2.0';
    const DEBUG = true;          // логи в консоли с меткой [dzine models]
    // ===================================

    const log = (...a) => { if (DEBUG) console.log('[dzine models]', ...a); };
    const norm = (s) => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

    // Кнопка выбора модели (точный селектор из dzine_menu.txt)
    const WRAP = '#chat-editor-chat-model-option-wrapper';
    const getTrigger = () => document.querySelector(WRAP + ' button.option-btn');
    const currentModel = () => {
        const l = document.querySelector(WRAP + ' .option-label');
        return l ? norm(l.textContent) : null;
    };
    const isBlocked = () => BLOCKED.includes(currentModel());

    // ---------- уведомление ----------
    function toast(msg) {
        let b = document.getElementById('dz-model-toast');
        if (!b) {
            b = document.createElement('div');
            b.id = 'dz-model-toast';
            b.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
                'background:#ffd400;color:#000;font:600 15px Arial,sans-serif;padding:12px 20px;border-radius:12px;' +
                'box-shadow:0 8px 30px rgba(0,0,0,.5);pointer-events:none;';
            document.body.appendChild(b);
        }
        b.textContent = msg;
        b.style.display = 'block';
        clearTimeout(b._t);
        b._t = setTimeout(() => { b.style.display = 'none'; }, 3500);
    }

    // ---------- 1) ЗАПРЕТ ГЕНЕРАЦИИ на платной модели ----------
    // Кнопка «↑» (генерация) — справа внизу редактора, вне левой панели с параметрами.
    function isGenerateClick(target) {
        const footer = target.closest && target.closest('.chat-editor-footer');
        if (!footer) return false;
        if (target.closest('.footer-left')) return false;           // параметры/модель — не трогаем
        return !!target.closest('button, [role="button"]');
    }
    document.addEventListener('click', (e) => {
        if (isBlocked() && isGenerateClick(e.target)) {
            e.preventDefault(); e.stopImmediatePropagation();
            toast('⛔ Модель «' + currentModel() + '» платная. Переключаю на ' + DEFAULT_MODEL);
            log('заблокировал генерацию на', currentModel());
            selectDefault('попытка генерации на платной');
        }
    }, true);
    // Enter в поле ввода тоже запускает генерацию
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && isBlocked() &&
            e.target.closest && e.target.closest('.chat-editor, [contenteditable="true"], textarea')) {
            e.preventDefault(); e.stopImmediatePropagation();
            toast('⛔ Модель «' + currentModel() + '» платная. Переключаю на ' + DEFAULT_MODEL);
            selectDefault('Enter на платной');
        }
    }, true);

    // ---------- 2) АВТОВЫБОР GPT Image 2.0 ----------
    function ownText(el) {
        let s = '';
        for (const n of el.childNodes) if (n.nodeType === 3) s += n.nodeValue;
        return norm(s);
    }
    // пункт в открытом меню с точным названием (не сама кнопка модели)
    function findOption(name) {
        for (const el of document.querySelectorAll('div, span, p, li, a, button')) {
            if (ownText(el) === name && !el.closest(WRAP + ' > .c-tip > button')) return el;
        }
        return null;
    }

    let busy = false, lastSwitch = 0;
    function selectDefault(reason) {
        if (busy || Date.now() - lastSwitch < 3000) return;
        const trigger = getTrigger();
        if (!trigger || currentModel() === DEFAULT_MODEL) return;

        busy = true; lastSwitch = Date.now();
        log('переключаю на', DEFAULT_MODEL, '—', reason, '(было:', currentModel() + ')');

        if (!findOption(DEFAULT_MODEL)) trigger.click();             // открыть меню, если закрыто
        let tries = 0;
        const iv = setInterval(() => {
            tries++;
            const opt = findOption(DEFAULT_MODEL);
            if (opt) {
                clearInterval(iv);
                opt.click();
                log('поставил', DEFAULT_MODEL);
                setTimeout(() => { busy = false; }, 400);
            } else if (tries > 16) {                                   // ~4 сек — сдаёмся
                clearInterval(iv);
                busy = false;
                log('не нашёл', DEFAULT_MODEL, 'в меню');
            }
        }, 250);
    }

    // ---------- запуск ----------
    let pageDone = false, lastUrl = location.href, prev = null;

    function tick() {
        const cur = currentModel();
        if (!cur) return;
        if (!pageDone) {                       // открытие страницы → GPT Image 2.0
            pageDone = true; prev = cur;
            if (cur !== DEFAULT_MODEL) selectDefault('открытие страницы');
            return;
        }
        if (cur !== prev) {                    // пользователь сменил модель
            prev = cur;
            if (BLOCKED.includes(cur)) {
                toast('⛔ «' + cur + '» тратит кредиты — возвращаю ' + DEFAULT_MODEL);
                setTimeout(() => selectDefault('выбрана платная модель'), 600);
            }
        }
    }

    function start() {
        if (!document.body) { setTimeout(start, 80); return; }
        setInterval(tick, 700);
        setInterval(() => {
            if (location.href !== lastUrl) { lastUrl = location.href; pageDone = false; }
        }, 700);
    }
    start();
})();
