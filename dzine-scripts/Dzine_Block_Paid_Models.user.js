// ==UserScript==
// @name         Dzine — убрать платные модели + GPT Image 2.0 по умолчанию
// @namespace    klub-dzine
// @version      1.0
// @description  Прячет платные модели (жрут кредиты) из меню выбора модели и блокирует их выбор. При открытии Dzine всегда автоматически ставит бесплатную модель GPT Image 2.0.
// @match        *://*.dzine.ai/*
// @match        *://dzine.ai/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ============ НАСТРОЙКИ (меняй тут) ============

    // Модели, которые ПРЯЧЕМ и ЗАПРЕЩАЕМ (точное имя, как в меню).
    // Чтобы добавить ещё одну — впиши её имя в кавычках через запятую.
    const BLOCKED = [
        'Ideogram 4.5',
        'Seedream 5.0 Flash',
        'Nano Banana 2.1',
    ];

    // Какую модель ставить по умолчанию при открытии страницы.
    const DEFAULT_MODEL = 'GPT Image 2.0';

    const DEBUG = false;
    // ================================================

    const log = (...a) => { if (DEBUG) console.log('[dzine models]', ...a); };
    const norm = (s) => (s || '').replace(/ /g, ' ').trim();

    // Листовой элемент, чей текст РОВНО равен нужному (без учёта бейджей NEW/HOT).
    // Бейдж обычно отдельным узлом, но на всякий случай чистим хвост.
    function stripBadge(t) {
        return norm(t).replace(/\b(NEW|HOT|BETA|PRO)\b\s*$/i, '').trim();
    }
    function exactLeaves(name) {
        const res = [];
        const els = document.querySelectorAll('span, div, p, a, li, button');
        for (const el of els) {
            if (el.children.length > 1) continue;          // только листья
            const t = norm(el.textContent);
            if (t === name || stripBadge(t) === name) res.push(el);
        }
        return res;
    }

    // Строка-модель в выпадающем списке — ближайший предок с иконкой <img> и коротким текстом.
    function rowOf(leaf) {
        let el = leaf, guard = 0;
        while (el && guard < 6) {
            if (el.querySelector && el.querySelector('img') && norm(el.textContent).length < 48) return el;
            el = el.parentElement; guard++;
        }
        return leaf.parentElement || leaf;
    }
    // Это именно СПИСОК (а не триггер текущей модели)? У списка у родителя строки ≥3 иконок-строк.
    function isInsideList(row) {
        const p = row.parentElement;
        if (!p) return false;
        let iconRows = 0;
        for (const ch of p.children) {
            if (ch.querySelector && ch.querySelector('img') && norm(ch.textContent).length < 48) iconRows++;
        }
        return iconRows >= 3;
    }

    const HIDE = (el) => { try { el.style.setProperty('display', 'none', 'important'); } catch (e) {} };

    // ---- 1) ПРЯЧЕМ платные модели в открытом меню ----
    function hideBlocked() {
        for (const name of BLOCKED) {
            for (const leaf of exactLeaves(name)) {
                const row = rowOf(leaf);
                if (!isInsideList(row)) continue;          // не трогаем триггер текущей модели
                if (row.dataset.dzHidden) continue;
                HIDE(row);
                row.dataset.dzHidden = '1';
                log('скрыл', name);
            }
        }
    }

    // ---- 2) БЛОКИРУЕМ клик по платной модели (страховка от мигания) ----
    document.addEventListener('click', function (e) {
        const leaf = e.target.closest && e.target.closest('span, div, p, a, li, button');
        if (!leaf) return;
        const t = stripBadge(leaf.textContent);
        if (BLOCKED.indexOf(t) !== -1) {
            const row = rowOf(leaf);
            if (isInsideList(row)) {
                e.preventDefault();
                e.stopPropagation();
                log('заблокировал клик по', t);
            }
        }
    }, true);

    // ---- 3) СТАВИМ GPT Image 2.0 по умолчанию ----
    // Все известные имена моделей нужны, чтобы распознать «триггер» текущей модели.
    function clickable(el) { return el.closest('button, [role="button"], li, a, div') || el; }

    // Триггер текущей модели = короткий элемент с иконкой, НЕ внутри списка,
    // чей текст похож на имя модели (есть цифра/версия в названии — грубая эвристика).
    function findTrigger() {
        const imgs = document.querySelectorAll('img');
        for (const img of imgs) {
            let el = img.parentElement, guard = 0, host = null;
            while (el && guard < 4) {
                const t = norm(el.textContent);
                if (t && t.length < 40 && el.querySelector('img')) { host = el; break; }
                el = el.parentElement; guard++;
            }
            if (!host) continue;
            if (isInsideList(host)) continue;              // это пункт списка, не триггер
            const t = norm(host.textContent);
            // триггер модели: короткое имя, не чисто размер/качество
            if (/[A-Za-z].*\d|\d.*[A-Za-z]/.test(t) && !/^\d+K$/i.test(t)) return host;
        }
        return null;
    }

    let busy = false, lastUrl = location.href;

    function setDefault() {
        if (busy) return;
        const trigger = findTrigger();
        if (!trigger) return;
        if (stripBadge(trigger.textContent) === DEFAULT_MODEL) { log('уже стоит', DEFAULT_MODEL); return; }

        busy = true;
        clickable(trigger).click();                        // открыть выпадашку
        let tries = 0;
        const iv = setInterval(() => {
            tries++;
            // сначала спрячем платные, чтобы не мелькали
            hideBlocked();
            let picked = false;
            for (const leaf of exactLeaves(DEFAULT_MODEL)) {
                const row = rowOf(leaf);
                if (!isInsideList(row)) continue;
                try { row.scrollIntoView({ block: 'center' }); } catch (e) {}
                clickable(leaf).click();
                picked = true;
                log('поставил', DEFAULT_MODEL);
                break;
            }
            if (picked || tries > 20) {
                clearInterval(iv);
                setTimeout(() => {
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                    busy = false;
                }, 150);
            }
        }, 250);
    }

    // ---- запуск + наблюдение за динамикой ----
    function tick() { try { hideBlocked(); } catch (e) {} }

    function start() {
        if (!document.body) { setTimeout(start, 80); return; }
        tick();
        let t = null;
        new MutationObserver(() => { clearTimeout(t); t = setTimeout(tick, 120); })
            .observe(document.body, { childList: true, subtree: true });

        setTimeout(setDefault, 1200);                      // первый раз — поставить дефолт
        // повтор на всякий случай (панель грузится асинхронно)
        let n = 0;
        const boot = setInterval(() => { n++; setDefault(); if (n > 8) clearInterval(boot); }, 1500);
    }
    start();

    // при переходах внутри SPA — снова ставим дефолтную модель
    setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            setTimeout(setDefault, 1200);
        }
    }, 1000);
})();
