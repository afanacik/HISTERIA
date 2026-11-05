/* Кит · модуль «Шаблоны ВК» (бывшее расширение VK Шаблоны v2.0)
   Аналог встроенных шаблонов ВКонтакте: список текстовых шаблонов
   с переменными, которые подставляются при вставке в открытый диалог.

   v2.0: группы больше не зашиты в код — их можно создавать, переименовывать,
   удалять, менять цвет и порядок прямо из панели (кнопки «+» и «✎» в строке
   вкладок). Шаблоны создаются в активной группе, в редакторе можно
   перекинуть шаблон в другую группу.

   v2.3: к шаблону можно прикрепить фото и PDF. Файлы хранятся в chrome.storage.local
   по ключам tplFile:<id> (base64), в шаблоне только метаданные it.files = [{id,name,type,size}].
   При вставке шаблона файлы передаются в поле ввода ВК как при Ctrl+V (или перетаскиванием /
   через поле выбора файла, способ выбирается в настройках), и ВК сам загружает их как вложения.

   Поддерживаемые переменные (как у ВК):
     {Имя собеседника}, {Фамилия собеседника},
     {Ваше имя}, {Ваша фамилия}, {Название сообщества},
     {Приветствие} (зависит от времени суток), {Прощание}
*/

(function () {
  'use strict';

  // Список переменных для кнопок в редакторе (как у ВК)
  const VARS = [
    'Имя собеседника', 'Фамилия собеседника',
    'Ваше имя', 'Ваша фамилия',
    'Название сообщества', 'Приветствие', 'Прощание'
  ];

  // Палитра для новых групп (цвет можно поменять в управлении группами)
  const PALETTE = ['#2787f5', '#2e9e44', '#e64646', '#a558c8', '#e8a33d', '#12aab5', '#000000'];

  let GROUPS = [];      // группы: {id, name, color}
  let ITEMS = [];       // шаблоны: {id, name, text, gid}
  let SETTINGS = {      // личные данные для переменных
    firstName: '', lastName: '', community: '',
    farewell: 'Хорошего дня!',
    peerSelector: '',   // необязательный CSS-селектор имени собеседника
    attachMode: 'paste' // как передавать файлы в ВК: paste | drop | input
  };
  const FILE_MAX = 20 * 1024 * 1024;   // лимит на один файл
  const FILE_KEY = (id) => 'tplFile:' + id;
  let editFiles = [];                  // вложения в редакторе: {id,name,type,size,data?,fresh?}
  let editFilesFor = null;             // id шаблона, для которого набран editFiles
  let activeGid = null; // id активной группы

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function hexToRgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  // Чёрный или белый текст в зависимости от яркости фона
  function textOn(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    return lum > 160 ? '#000' : '#fff';
  }
  // Инлайн-стиль вкладки с учётом её цвета и активности
  function tabInline(g, active) {
    const c = g.color || '#2787f5';
    const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (active) {
      const n = parseInt(c.slice(1), 16);
      const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
      const outline = (dark && lum < 40) ? 'box-shadow:inset 0 0 0 1px rgba(255,255,255,.25);' : '';
      return `background:${c};color:${textOn(c)};${outline}`;
    }
    const n = parseInt(c.slice(1), 16);
    const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    const text = (dark && lum < 60) ? '#cfd2d6' : c;
    const bg   = dark ? 'rgba(255,255,255,.07)' : hexToRgba(c, 0.1);
    return `background:${bg};color:${text};`;
  }

  function persist(done) {
    try {
      chrome.storage.local.set({ items: ITEMS, groups: GROUPS, settings: SETTINGS }, () => {
        if (chrome.runtime && chrome.runtime.lastError) {
          notify('Не удалось сохранить — обнови страницу VK (Ctrl+F5)', true);
        } else if (typeof done === 'function') {
          done();
        }
      });
    } catch (e) {
      // "Extension context invalidated" — расширение обновили/выключили,
      // а вкладка осталась старой
      notify('Расширение обновилось. Обнови страницу VK (Ctrl+F5)', true);
    }
  }

  // Небольшое всплывающее уведомление
  function notify(msg, isError) {
    let t = document.getElementById('vk-tpl-toast');
    if (!t) { t = document.createElement('div'); t.id = 'vk-tpl-toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.style.background = isError ? '#e64646' : '#2787f5';
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), isError ? 3500 : 1600);
  }

  // ---------- Нормализация и миграция данных ----------
  function normalizeItem(it) {
    const o = Object.assign({}, it);
    o.id = String(o.id != null ? o.id : uid());
    if (o.gid != null) o.gid = String(o.gid);
    return o;
  }
  function normalizeGroup(g, i) {
    return {
      id: String(g.id != null ? g.id : uid()),
      name: (g.name || 'Группа ' + (i + 1)).toString(),
      color: /^#[0-9a-fA-F]{6}$/.test(g.color || '') ? g.color : PALETTE[i % PALETTE.length]
    };
  }
  // Старый формат: у шаблонов было поле tab (номер вкладки), групп не было.
  // Создаём «Группа 1..N» по фактически использованным вкладкам.
  function migrateFromTabs(items) {
    const used = [...new Set(items.map(it => (typeof it.tab === 'number' ? it.tab : 0)))].sort((a, b) => a - b);
    if (!used.length) {
      return [{ id: uid(), name: 'Мои шаблоны', color: PALETTE[0] }];
    }
    const groups = used.map((t, i) => ({ id: uid(), name: 'Группа ' + (i + 1), color: PALETTE[i % PALETTE.length] }));
    items.forEach(it => {
      const idx = used.indexOf(typeof it.tab === 'number' ? it.tab : 0);
      it.gid = groups[idx === -1 ? 0 : idx].id;
      delete it.tab;
    });
    return groups;
  }
  // Гарантирует: есть хотя бы одна группа, у каждого шаблона валидный gid,
  // активная группа существует.
  function ensureIntegrity() {
    if (!GROUPS.length) GROUPS = [{ id: uid(), name: 'Мои шаблоны', color: PALETTE[0] }];
    const ids = new Set(GROUPS.map(g => g.id));
    ITEMS.forEach(it => { if (!ids.has(it.gid)) it.gid = GROUPS[0].id; });
    if (!ids.has(activeGid)) activeGid = GROUPS[0].id;
  }

  // ---------- Переменные ----------
  // Час по Москве, независимо от часового пояса и перевода часов на компьютере.
  function mskHour() {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Moscow', hour: '2-digit', hourCycle: 'h23'
      }).formatToParts(new Date());
      const h = parseInt((parts.find(p => p.type === 'hour') || {}).value, 10);
      if (!isNaN(h)) return h % 24;
    } catch (e) {}
    return (new Date().getUTCHours() + 3) % 24;   // запасной вариант: МСК = UTC+3
  }

  // {Приветствие} по московскому времени. Утро начинается в 3:00.
  function greeting() {
    const h = mskHour();
    if (h >= 3  && h < 12) return 'Доброе утро';
    if (h >= 12 && h < 18) return 'Добрый день';
    if (h >= 18 && h < 23) return 'Добрый вечер';
    return 'Доброй ночи';
  }

  // Имя собеседника из шапки диалога (эвристика + ручной селектор)
  function getPeerName() {
    const sels = [];
    if (SETTINGS.peerSelector) sels.push(SETTINGS.peerSelector);
    sels.push(
      '[class*="ConvoTitle"]',
      '[class*="PeerTitle"]',
      '[class*="im-page--title"]',
      '[class*="Title__primary"]',
      '[class*="dialog_title"]'
    );
    for (const s of sels) {
      try {
        const el = document.querySelector(s);
        if (el && el.textContent.trim()) return el.textContent.trim();
      } catch (e) {}
    }
    return '';
  }

  function resolve(text) {
    const full  = getPeerName();
    const parts = full.split(/\s+/).filter(Boolean);
    const pFirst = parts[0] || '';
    const pLast  = parts.slice(1).join(' ');
    const map = {
      '{Имя собеседника}':    pFirst,
      '{Фамилия собеседника}': pLast,
      '{Ваше имя}':           SETTINGS.firstName || '',
      '{Ваша фамилия}':       SETTINGS.lastName  || '',
      '{Название сообщества}': SETTINGS.community || '',
      '{Приветствие}':        greeting(),
      '{Прощание}':           SETTINGS.farewell  || ''
    };
    let out = text;
    for (const k in map) out = out.split(k).join(map[k]);
    return out;
  }

  // ---------- Файлы шаблона ----------
  function fmtSize(n) {
    if (n < 1024) return n + ' Б';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' КБ';
    return (n / 1024 / 1024).toFixed(1) + ' МБ';
  }
  function fileIcon(type) { return /^image\//.test(type || '') ? '🖼' : '📄'; }

  function dataUrlToFile(dataUrl, name, type) {
    const i = dataUrl.indexOf(',');
    const b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
    return new File([u8], name || 'file', { type: type || 'application/octet-stream' });
  }
  function readFileAsDataUrl(f) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(f);
    });
  }
  // Достаёт байты файлов шаблона из storage → массив File
  function loadTemplateFiles(item) {
    const meta = Array.isArray(item.files) ? item.files : [];
    if (!meta.length) return Promise.resolve([]);
    return new Promise((res) => {
      try {
        chrome.storage.local.get(meta.map(m => FILE_KEY(m.id)), (r) => {
          const out = [];
          meta.forEach(m => {
            const rec = r[FILE_KEY(m.id)];
            if (rec && rec.data) { try { out.push(dataUrlToFile(rec.data, m.name, m.type)); } catch (e) {} }
          });
          res(out);
        });
      } catch (e) { res([]); }
    });
  }
  function removeFileKeys(ids, done) {
    if (!ids.length) { if (done) done(); return; }
    try { chrome.storage.local.remove(ids.map(FILE_KEY), () => { if (done) done(); }); }
    catch (e) { if (done) done(); }
  }
  function filesOf(items) {
    const ids = [];
    items.forEach(it => (it.files || []).forEach(f => ids.push(f.id)));
    return ids;
  }

  // Поле выбора файла ВК рядом с полем ввода (для режима input)
  function findFileInputs(composer) {
    const all = [...document.querySelectorAll('input[type="file"]')];
    if (!all.length) return [];
    let anc = composer, inside = [];
    for (let lvl = 0; lvl < 10 && anc; lvl++, anc = anc.parentElement) {
      inside = all.filter(i => anc.contains(i));
      if (inside.length) break;
    }
    return inside.length ? inside : all;
  }
  function pickInput(inputs, file) {
    const isImg = /^image\//.test(file.type);
    const acc = i => (i.getAttribute('accept') || '').toLowerCase();
    if (isImg) return inputs.find(i => acc(i).includes('image')) || inputs.find(i => !acc(i) || acc(i).includes('*')) || inputs[0];
    return inputs.find(i => !acc(i) || acc(i).includes('*') || acc(i).includes('pdf') || acc(i).includes('application')) ||
           inputs.find(i => !acc(i).includes('image')) || inputs[0];
  }

  // Передача файлов в ВК: как при Ctrl+V / перетаскивании / через поле выбора файла
  function attachFiles(el, files, mode) {
    if (!files.length) return 'none';
    const makeDT = (list) => { const dt = new DataTransfer(); list.forEach(f => dt.items.add(f)); return dt; };

    if (mode === 'input') {
      const inputs = findFileInputs(el);
      if (inputs.length) {
        const byInput = new Map();
        files.forEach(f => { const inp = pickInput(inputs, f); if (!byInput.has(inp)) byInput.set(inp, []); byInput.get(inp).push(f); });
        let ok = false;
        byInput.forEach((list, inp) => {
          try {
            inp.files = makeDT(list).files;
            inp.dispatchEvent(new Event('input',  { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            ok = true;
          } catch (e) {}
        });
        if (ok) return 'input';
      }
      mode = 'paste';
    }
    if (mode === 'drop') {
      const dt = makeDT(files);
      const opts = { bubbles: true, cancelable: true, dataTransfer: dt };
      try {
        el.dispatchEvent(new DragEvent('dragenter', opts));
        el.dispatchEvent(new DragEvent('dragover',  opts));
        el.dispatchEvent(new DragEvent('drop',      opts));
        return 'drop';
      } catch (e) { mode = 'paste'; }
    }
    const dt = makeDT(files);
    el.focus();
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    return 'paste';
  }

  // ---------- Поле ввода и вставка текста ----------
  function findComposer() {
    const eds = [...document.querySelectorAll('[contenteditable="true"]')]
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 60 && r.height > 5 &&
               r.top < window.innerHeight && r.bottom > 0;
      });
    if (!eds.length) return null;
    eds.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    return eds[0];
  }

  function insertText(el, text) {
    if (!text) return;
    el.focus();
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (e) {}
    if (!ok) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  }

  function applyTemplate(item) {
    const el = findComposer();
    if (!el) { alert('Не нашёл поле ввода. Открой диалог и попробуй снова.'); return; }
    insertText(el, resolve(item.text || ''));
    closePanel();
    const meta = Array.isArray(item.files) ? item.files : [];
    if (!meta.length) return;
    loadTemplateFiles(item).then(files => {
      if (!files.length) { notify('Файлы шаблона не найдены в хранилище', true); return; }
      // небольшая пауза, чтобы ВК успел обработать вставленный текст
      setTimeout(() => {
        const how = attachFiles(el, files, SETTINGS.attachMode || 'paste');
        const n = files.length;
        notify(`Прикрепляю ${n} ${n === 1 ? 'файл' : (n < 5 ? 'файла' : 'файлов')}…`);
        if (how === 'paste' && (SETTINGS.attachMode || 'paste') !== 'paste') {
          setTimeout(() => notify('Поле выбора файла не найдено, вставил как Ctrl+V', true), 1800);
        }
      }, 150);
    });
  }

  // Перемещение шаблона относительно целевого (после/до него) в массиве ITEMS
  function moveItem(srcId, targetId, after) {
    const from = ITEMS.findIndex(x => x.id === srcId);
    if (from < 0) return;
    const [it] = ITEMS.splice(from, 1);
    let to = ITEMS.findIndex(x => x.id === targetId);
    if (to < 0) ITEMS.push(it);
    else ITEMS.splice(after ? to + 1 : to, 0, it);
    persist();
    render();
  }

  // То же самое для групп
  function moveGroup(srcId, targetId, after) {
    const from = GROUPS.findIndex(x => x.id === srcId);
    if (from < 0) return;
    const [g] = GROUPS.splice(from, 1);
    let to = GROUPS.findIndex(x => x.id === targetId);
    if (to < 0) GROUPS.push(g);
    else GROUPS.splice(after ? to + 1 : to, 0, g);
    persist();
    render();
  }

  // ======================= ИНТЕРФЕЙС =======================
  let panel = null, editingId = null, showSettings = false, showGroups = false,
      btn = null, dragSrcId = null, dragGrpId = null;

  function injectStyle() {
    if (document.getElementById('vk-tpl-style')) return;
    const s = document.createElement('style');
    s.id = 'vk-tpl-style';
    s.textContent = `
      #vk-tpl-btn{position:fixed;right:20px;bottom:96px;z-index:2147483000;
        width:46px;height:46px;border-radius:50%;border:none;cursor:grab;
        user-select:none;touch-action:none;
        background:#2787f5;color:#fff;font-size:20px;box-shadow:0 4px 14px rgba(0,0,0,.25)}
      #vk-tpl-btn.dragging{cursor:grabbing;opacity:.85}
      #vk-tpl-toast{position:fixed;left:50%;bottom:24px;z-index:2147483001;color:#fff;
        padding:10px 16px;border-radius:10px;font:13px/1.3 -apple-system,Segoe UI,Roboto,Arial,sans-serif;
        box-shadow:0 6px 20px rgba(0,0,0,.3);opacity:0;pointer-events:none;
        transform:translateX(-50%) translateY(20px);transition:opacity .2s,transform .2s}
      #vk-tpl-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
      #vk-tpl-btn:hover{background:#3c8df6}
      #vk-tpl-panel{position:fixed;right:20px;bottom:150px;z-index:2147483000;
        width:360px;max-height:74vh;overflow:auto;background:#fff;color:#000;
        border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.3);
        font:14px/1.4 -apple-system,Segoe UI,Roboto,Arial,sans-serif;display:none}
      @media (prefers-color-scheme: dark){
        #vk-tpl-panel{background:#19191a;color:#e1e3e6}
        .vk-tpl-item,.vk-grp{border-color:#2a2a2b!important}
        .vk-tpl-input,.vk-tpl-text,select.vk-tpl-input{background:#0f0f10!important;color:#e1e3e6!important;border-color:#2a2a2b!important}
        .vk-var{background:#23272e!important;color:#9cc2ff!important}
        .vk-tab-svc{background:rgba(255,255,255,.07)!important;color:#cfd2d6!important}
      }
      #vk-tpl-panel header{display:flex;justify-content:space-between;align-items:center;
        padding:12px 14px;font-weight:600;position:sticky;top:0;background:inherit;z-index:1}
      #vk-tpl-panel header .ic{cursor:pointer;font-size:16px;opacity:.6;margin-left:10px}
      .vk-tpl-list{padding:0 12px 12px}
      .vk-tabs{display:flex;flex-wrap:wrap;gap:4px;padding:2px 12px 10px}
      .vk-tab{flex:1 1 auto;min-width:56px;border:none;border-radius:8px;
        padding:8px 4px;cursor:pointer;font-size:12px;font-weight:600;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
      .vk-tab-svc{flex:0 0 auto;min-width:30px;width:30px;background:#eef1f5;color:#555}
      .vk-tpl-item{display:flex;gap:10px;align-items:center;padding:8px;
        border:1px solid #e7e8ec;border-radius:10px;margin-bottom:8px}
      .vk-drag{cursor:grab;opacity:.4;font-size:16px;line-height:1;flex:0 0 auto;
        user-select:none;letter-spacing:-2px}
      .vk-tpl-item.dragging,.vk-grp.dragging{opacity:.45}
      .vk-tpl-item.over-top,.vk-grp.over-top{box-shadow:inset 0 3px 0 #2787f5}
      .vk-tpl-item.over-bottom,.vk-grp.over-bottom{box-shadow:inset 0 -3px 0 #2787f5}
      .vk-tpl-item .nm{font-weight:600;font-size:13px}
      .vk-tpl-item .tx{font-size:12px;opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px}
      .vk-tpl-item .acts{margin-left:auto;display:flex;gap:6px}
      .vk-tpl-item button,.vk-grp button{border:none;border-radius:6px;padding:5px 8px;cursor:pointer;font-size:12px}
      .b-use{background:#2787f5;color:#fff}
      .b-del{background:#ffe0e0;color:#c00}
      .b-edit{background:#eef1f5;color:#444}
      .vk-tpl-input,.vk-tpl-text{width:100%;box-sizing:border-box;padding:8px 10px;
        border:1px solid #d3d6db;border-radius:8px;margin-bottom:8px;font:inherit}
      select.vk-tpl-input{cursor:pointer}
      .vk-tpl-text{resize:vertical;min-height:72px}
      .vk-vars{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
      .vk-var{background:#eef1f5;color:#2a5885;border:none;border-radius:14px;
        padding:5px 10px;font-size:12px;cursor:pointer}
      .vk-var:hover{filter:brightness(.95)}
      .vk-tpl-save{background:#2787f5;color:#fff;border:none;border-radius:8px;
        padding:9px 14px;cursor:pointer;width:100%;font-weight:600}
      .vk-sec-title{font-weight:600;margin:0 0 8px}
      .vk-hint{font-size:11px;opacity:.6;margin:-4px 0 10px}
      .vk-small-btn{background:#eef1f5;color:#444;border:none;border-radius:8px;padding:8px;cursor:pointer;font-size:12px;flex:1}
      .vk-grp{display:flex;gap:8px;align-items:center;padding:8px;
        border:1px solid #e7e8ec;border-radius:10px;margin-bottom:8px}
      .vk-grp .g-name{margin:0;flex:1;min-width:0}
      .vk-grp .g-color{width:30px;height:30px;padding:0;border:none;border-radius:6px;
        background:none;cursor:pointer;flex:0 0 auto}
      .vk-grp .g-count{font-size:11px;opacity:.55;flex:0 0 auto;min-width:20px;text-align:center}
      .vk-clip{font-size:11px;font-weight:600;opacity:.75;margin-left:4px;white-space:nowrap}
      .vk-files{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
      .vk-files:empty{display:none}
      .vk-file{display:flex;align-items:center;gap:6px;max-width:100%;padding:4px 6px 4px 4px;
        border:1px solid #e7e8ec;border-radius:8px;font-size:12px;background:#f7f8fa}
      .vk-file img{width:34px;height:34px;object-fit:cover;border-radius:5px;flex:0 0 auto}
      .vk-file .fi{width:34px;height:34px;display:flex;align-items:center;justify-content:center;font-size:18px;flex:0 0 auto}
      .vk-file .fn{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .vk-file .fs{opacity:.55;font-size:11px}
      .vk-file .fx{border:none;background:none;cursor:pointer;color:#c00;font-size:14px;padding:0 4px}
      @media (prefers-color-scheme: dark){ .vk-file{background:#232324;border-color:#2a2a2b} }
    `;
    document.documentElement.appendChild(s);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function render() {
    if (!panel) return;
    const sub = showSettings ? ' · настройки' : (showGroups ? ' · группы' : '');
    panel.innerHTML = `
      <header>
        <span>Шаблоны${sub}</span>
        <span>
          <span class="ic" id="vk-tpl-gear" title="Настройки">⚙</span>
          <span class="ic" id="vk-tpl-close" title="Закрыть">✕</span>
        </span>
      </header>
      ${showSettings ? renderSettings() : (showGroups ? renderGroups() : renderMain())}
    `;
    if (showSettings) bindSettings();
    else if (showGroups) bindGroups();
    else bindMain();
  }

  function renderMain() {
    return `
      <div class="vk-tabs">
        ${GROUPS.map(g => `<button class="vk-tab" data-gid="${escapeHtml(g.id)}" title="${escapeHtml(g.name)}" style="${tabInline(g, g.id === activeGid)}">${escapeHtml(g.name)}</button>`).join('')}
        <button class="vk-tab vk-tab-svc" id="vk-tab-add" title="Добавить группу">+</button>
        <button class="vk-tab vk-tab-svc" id="vk-tab-manage" title="Управление группами (переименовать, цвет, порядок, удалить)">✎</button>
      </div>
      <div class="vk-tpl-list">
        ${ITEMS.filter(it => it.gid === activeGid).map(it => `
          <div class="vk-tpl-item" data-id="${escapeHtml(it.id)}" draggable="true">
            <span class="vk-drag" title="Перетащите, чтобы изменить порядок">⠿</span>
            <div style="min-width:0">
              <div class="nm">${escapeHtml(it.name || 'Без названия')}${(it.files && it.files.length) ? ` <span class="vk-clip" title="${escapeHtml(it.files.map(f => f.name).join(', '))}">📎${it.files.length}</span>` : ''}</div>
              <div class="tx">${escapeHtml(it.text || '')}</div>
            </div>
            <div class="acts">
              <button class="b-use">Вставить</button>
              <button class="b-edit">✎</button>
              <button class="b-del">✕</button>
            </div>
          </div>`).join('') || '<div style="opacity:.6;padding:8px 0">В этой группе пока нет шаблонов.</div>'}
      </div>
      <div class="vk-tpl-list" style="border-top:1px solid #e7e8ec;padding-top:12px">
        <p class="vk-sec-title">${editingId ? 'Редактирование' : 'Новый шаблон'}</p>
        <input class="vk-tpl-input" id="vk-tpl-name" placeholder="Название">
        <textarea class="vk-tpl-text" id="vk-tpl-text" placeholder="Текст шаблона"></textarea>
        <select class="vk-tpl-input" id="vk-tpl-group" title="Группа шаблона">
          ${GROUPS.map(g => `<option value="${escapeHtml(g.id)}" ${g.id === activeGid ? 'selected' : ''}>Группа: ${escapeHtml(g.name)}</option>`).join('')}
        </select>
        <div class="vk-vars">
          ${VARS.map(v => `<button class="vk-var" data-v="{${v}}">${v}</button>`).join('')}
        </div>
        <div class="vk-files" id="vk-tpl-files"></div>
        <button class="vk-small-btn" id="vk-tpl-attach" style="width:100%;margin-bottom:8px">📎 Прикрепить фото или PDF</button>
        <input type="file" id="vk-tpl-file" accept="image/*,application/pdf,.pdf" multiple style="display:none">
        <button class="vk-tpl-save" id="vk-tpl-save">${editingId ? 'Сохранить' : 'Создать шаблон'}</button>
      </div>
    `;
  }

  function renderGroups() {
    return `
      <div class="vk-tpl-list">
        <p class="vk-sec-title">Группы</p>
        <p class="vk-hint">Название и цвет сохраняются сами. Порядок — перетаскиванием за ⠿. Цифра — сколько шаблонов в группе.</p>
        ${GROUPS.map(g => `
          <div class="vk-grp" data-gid="${escapeHtml(g.id)}">
            <span class="vk-drag" title="Перетащите, чтобы изменить порядок">⠿</span>
            <input type="color" class="g-color" value="${escapeHtml(g.color)}" title="Цвет группы">
            <input class="vk-tpl-input g-name" value="${escapeHtml(g.name)}" placeholder="Название группы">
            <span class="g-count">${ITEMS.filter(it => it.gid === g.id).length}</span>
            <button class="b-del g-del" title="Удалить группу">✕</button>
          </div>`).join('')}
        <button class="vk-small-btn" id="g-add" style="width:100%;margin-top:2px">+ Добавить группу</button>
        <button class="vk-tpl-save" id="g-done" style="margin-top:10px">Готово</button>
      </div>
    `;
  }

  function renderSettings() {
    return `
      <div class="vk-tpl-list">
        <p class="vk-hint">Эти значения подставляются вместо переменных.</p>
        <input class="vk-tpl-input" id="s-first" placeholder="Ваше имя" value="${escapeHtml(SETTINGS.firstName)}">
        <input class="vk-tpl-input" id="s-last" placeholder="Ваша фамилия" value="${escapeHtml(SETTINGS.lastName)}">
        <input class="vk-tpl-input" id="s-comm" placeholder="Название сообщества" value="${escapeHtml(SETTINGS.community)}">
        <input class="vk-tpl-input" id="s-bye" placeholder="Прощание" value="${escapeHtml(SETTINGS.farewell)}">
        <input class="vk-tpl-input" id="s-peer" placeholder="CSS-селектор имени собеседника (необязательно)" value="${escapeHtml(SETTINGS.peerSelector)}">
        <p class="vk-hint">Селектор нужен, только если {Имя собеседника} не подставляется автоматически.</p>
        <select class="vk-tpl-input" id="s-attach" title="Как передавать файлы шаблона в ВК">
          <option value="paste" ${(SETTINGS.attachMode || 'paste') === 'paste' ? 'selected' : ''}>Файлы: вставка как Ctrl+V (по умолчанию)</option>
          <option value="drop" ${SETTINGS.attachMode === 'drop' ? 'selected' : ''}>Файлы: как перетаскивание в диалог</option>
          <option value="input" ${SETTINGS.attachMode === 'input' ? 'selected' : ''}>Файлы: через поле выбора файла ВК</option>
        </select>
        <p class="vk-hint">Если вложения из шаблона не появляются в сообщении, попробуй другой способ.</p>
        <button class="vk-tpl-save" id="s-save">Сохранить настройки</button>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="vk-small-btn" id="s-export">Экспорт шаблонов</button>
          <button class="vk-small-btn" id="s-import">Импорт</button>
        </div>
        <input type="file" id="s-import-file" accept="application/json" style="display:none">
      </div>
    `;
  }

  function bindMain() {
    panel.querySelector('#vk-tpl-close').onclick = closePanel;
    panel.querySelector('#vk-tpl-gear').onclick  = () => { showSettings = true; showGroups = false; render(); };

    panel.querySelectorAll('.vk-tab[data-gid]').forEach(t => {
      t.onclick = () => { activeGid = t.dataset.gid; editingId = null; editFiles = []; editFilesFor = null; render(); };
    });

    // Быстрое добавление группы
    panel.querySelector('#vk-tab-add').onclick = () => {
      const name = (prompt('Название новой группы:') || '').trim();
      if (!name) return;
      const g = { id: uid(), name, color: PALETTE[GROUPS.length % PALETTE.length] };
      GROUPS.push(g);
      activeGid = g.id;
      persist(() => notify('Группа добавлена ✓'));
      render();
    };
    // Управление группами
    panel.querySelector('#vk-tab-manage').onclick = () => { showGroups = true; render(); };

    panel.querySelectorAll('.vk-tpl-item').forEach(row => {
      const id = row.dataset.id;
      const it = ITEMS.find(x => x.id === id);
      row.querySelector('.b-use').onclick  = () => applyTemplate(it);
      row.querySelector('.b-edit').onclick = () => { editingId = id; render(); scrollToEditor(); };
      row.querySelector('.b-del').onclick  = () => {
        if (!confirm('Удалить шаблон?')) return;
        removeFileKeys(filesOf(ITEMS.filter(x => x.id === id)));
        ITEMS = ITEMS.filter(x => x.id !== id);
        if (editingId === id) { editingId = null; editFiles = []; editFilesFor = null; }
        persist(); render();
      };

      // --- сортировка перетаскиванием ---
      row.addEventListener('dragstart', (e) => {
        dragSrcId = id;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(id)); } catch (ex) {}
      });
      row.addEventListener('dragover', (e) => {
        if (dragSrcId == null || dragSrcId === id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const r = row.getBoundingClientRect();
        const after = (e.clientY - r.top) > r.height / 2;
        row.classList.toggle('over-bottom', after);
        row.classList.toggle('over-top', !after);
      });
      row.addEventListener('dragleave', () => {
        row.classList.remove('over-top', 'over-bottom');
      });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('over-top', 'over-bottom');
        if (dragSrcId == null || dragSrcId === id) return;
        const r = row.getBoundingClientRect();
        const after = (e.clientY - r.top) > r.height / 2;
        moveItem(dragSrcId, id, after);
        dragSrcId = null;
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging', 'over-top', 'over-bottom');
        dragSrcId = null;
      });
    });

    const ta = panel.querySelector('#vk-tpl-text');
    const sel = panel.querySelector('#vk-tpl-group');
    if (editingId) {
      const it = ITEMS.find(x => x.id === editingId);
      if (it) {
        panel.querySelector('#vk-tpl-name').value = it.name || '';
        ta.value = it.text || '';
        sel.value = it.gid;
        if (editFilesFor !== editingId) { editFiles = (it.files || []).map(f => Object.assign({}, f)); editFilesFor = editingId; }
      }
    } else if (editFilesFor !== null) { editFiles = []; editFilesFor = null; }

    // --- вложения ---
    const filesBox = panel.querySelector('#vk-tpl-files');
    const fileInp  = panel.querySelector('#vk-tpl-file');
    function renderFiles() {
      filesBox.innerHTML = editFiles.map((f, i) => `
        <div class="vk-file" title="${escapeHtml(f.name)}">
          ${(f.data && /^image\//.test(f.type) && /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+\/=]+$/i.test(f.data)) ? `<img src="${f.data}" alt="">` : `<span class="fi">${fileIcon(f.type)}</span>`}
          <span><div class="fn">${escapeHtml(f.name)}</div><div class="fs">${fmtSize(f.size || 0)}</div></span>
          <button class="fx" data-i="${i}" title="Убрать">✕</button>
        </div>`).join('');
      filesBox.querySelectorAll('.fx').forEach(b => {
        b.onclick = () => { editFiles.splice(+b.dataset.i, 1); renderFiles(); };
      });
    }
    renderFiles();
    panel.querySelector('#vk-tpl-attach').onclick = () => fileInp.click();
    fileInp.onchange = async () => {
      const list = [...fileInp.files];
      fileInp.value = '';
      for (const f of list) {
        if (!/^image\//.test(f.type) && f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) {
          notify(`«${f.name}»: только фото и PDF`, true); continue;
        }
        if (f.size > FILE_MAX) { notify(`«${f.name}» больше 20 МБ`, true); continue; }
        try {
          const data = await readFileAsDataUrl(f);
          editFiles.push({ id: uid(), name: f.name, type: f.type || (/\.pdf$/i.test(f.name) ? 'application/pdf' : ''), size: f.size, data, fresh: true });
        } catch (e) { notify(`Не удалось прочитать «${f.name}»`, true); }
      }
      renderFiles();
    };

    // кнопки переменных вставляют токен в позицию курсора
    panel.querySelectorAll('.vk-var').forEach(b => {
      b.onclick = () => {
        const token = b.dataset.v;
        const start = ta.selectionStart ?? ta.value.length;
        const end   = ta.selectionEnd   ?? ta.value.length;
        ta.value = ta.value.slice(0, start) + token + ta.value.slice(end);
        ta.selectionStart = ta.selectionEnd = start + token.length;
        ta.focus();
      };
    });

    panel.querySelector('#vk-tpl-save').onclick = () => {
      const name = panel.querySelector('#vk-tpl-name').value.trim();
      const text = ta.value;
      const gid  = sel.value || activeGid;
      if (!name && !text && !editFiles.length) { alert('Заполни название или текст.'); return; }
      const meta = editFiles.map(f => ({ id: f.id, name: f.name, type: f.type, size: f.size }));
      const toWrite = {};
      editFiles.filter(f => f.fresh && f.data).forEach(f => { toWrite[FILE_KEY(f.id)] = { name: f.name, type: f.type, size: f.size, data: f.data }; });
      let toRemove = [];
      if (editingId) {
        const it = ITEMS.find(x => x.id === editingId);
        if (it) {
          const keep = new Set(meta.map(m => m.id));
          toRemove = (it.files || []).filter(f => !keep.has(f.id)).map(f => f.id);
          it.name = name; it.text = text; it.gid = gid; it.files = meta;
        }
      } else {
        ITEMS.push({ id: uid(), name, text, gid, files: meta });
      }
      const finish = () => {
        removeFileKeys(toRemove);
        persist(() => notify('Сохранено ✓'));
        editingId = null; editFiles = []; editFilesFor = null;
        activeGid = gid;   // показываем группу, куда сохранили
        render();
      };
      if (Object.keys(toWrite).length) {
        try {
          chrome.storage.local.set(toWrite, () => {
            if (chrome.runtime && chrome.runtime.lastError) { notify('Не удалось сохранить файлы: ' + chrome.runtime.lastError.message, true); return; }
            finish();
          });
        } catch (e) { notify('Расширение обновилось. Обнови страницу VK (Ctrl+F5)', true); }
      } else finish();
    };
  }

  function bindGroups() {
    panel.querySelector('#vk-tpl-close').onclick = closePanel;
    panel.querySelector('#vk-tpl-gear').onclick  = () => { showSettings = true; showGroups = false; render(); };
    panel.querySelector('#g-done').onclick = () => { showGroups = false; render(); };

    panel.querySelector('#g-add').onclick = () => {
      GROUPS.push({ id: uid(), name: 'Новая группа', color: PALETTE[GROUPS.length % PALETTE.length] });
      persist();
      render();
      // сразу ставим курсор в название новой группы
      requestAnimationFrame(() => {
        const rows = panel.querySelectorAll('.vk-grp .g-name');
        const last = rows[rows.length - 1];
        if (last) { last.focus(); last.select(); }
      });
    };

    panel.querySelectorAll('.vk-grp').forEach(row => {
      const gid = row.dataset.gid;
      const g = GROUPS.find(x => x.id === gid);
      if (!g) return;

      const nameInp = row.querySelector('.g-name');
      nameInp.onchange = () => {
        const v = nameInp.value.trim();
        if (!v) { nameInp.value = g.name; return; }
        g.name = v;
        persist(() => notify('Сохранено ✓'));
      };
      nameInp.onkeydown = (e) => { if (e.key === 'Enter') nameInp.blur(); };

      row.querySelector('.g-color').onchange = (e) => {
        g.color = e.target.value;
        persist(() => notify('Сохранено ✓'));
      };

      row.querySelector('.g-del').onclick = () => {
        if (GROUPS.length === 1) { notify('Нельзя удалить последнюю группу', true); return; }
        const cnt = ITEMS.filter(it => it.gid === gid).length;
        const q = cnt
          ? `Удалить группу «${g.name}» и все её шаблоны (${cnt} шт.)?`
          : `Удалить группу «${g.name}»?`;
        if (!confirm(q)) return;
        GROUPS = GROUPS.filter(x => x.id !== gid);
        removeFileKeys(filesOf(ITEMS.filter(it => it.gid === gid)));
        ITEMS  = ITEMS.filter(it => it.gid !== gid);
        if (activeGid === gid) activeGid = GROUPS[0].id;
        persist(() => notify('Группа удалена'));
        render();
      };

      // --- сортировка групп перетаскиванием (только за ручку ⠿,
      //     чтобы не мешать выделению текста в поле названия) ---
      const handle = row.querySelector('.vk-drag');
      handle.addEventListener('mousedown', () => {
        row.draggable = true;
        document.addEventListener('mouseup', () => { row.draggable = false; }, { once: true });
      });
      row.addEventListener('dragstart', (e) => {
        dragGrpId = gid;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', gid); } catch (ex) {}
      });
      row.addEventListener('dragover', (e) => {
        if (dragGrpId == null || dragGrpId === gid) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const r = row.getBoundingClientRect();
        const after = (e.clientY - r.top) > r.height / 2;
        row.classList.toggle('over-bottom', after);
        row.classList.toggle('over-top', !after);
      });
      row.addEventListener('dragleave', () => {
        row.classList.remove('over-top', 'over-bottom');
      });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('over-top', 'over-bottom');
        if (dragGrpId == null || dragGrpId === gid) return;
        const r = row.getBoundingClientRect();
        const after = (e.clientY - r.top) > r.height / 2;
        moveGroup(dragGrpId, gid, after);
        dragGrpId = null;
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging', 'over-top', 'over-bottom');
        row.draggable = false;
        dragGrpId = null;
      });
    });
  }

  function bindSettings() {
    panel.querySelector('#vk-tpl-close').onclick = closePanel;
    panel.querySelector('#vk-tpl-gear').onclick  = () => { showSettings = false; render(); };

    panel.querySelector('#s-save').onclick = () => {
      SETTINGS.firstName    = panel.querySelector('#s-first').value.trim();
      SETTINGS.lastName     = panel.querySelector('#s-last').value.trim();
      SETTINGS.community    = panel.querySelector('#s-comm').value.trim();
      SETTINGS.farewell     = panel.querySelector('#s-bye').value;
      SETTINGS.peerSelector = panel.querySelector('#s-peer').value.trim();
      SETTINGS.attachMode   = panel.querySelector('#s-attach').value || 'paste';
      persist();
      showSettings = false; render();
    };

    panel.querySelector('#s-export').onclick = () => {
      const ids = filesOf(ITEMS);
      const dump = (files) => {
        const data = JSON.stringify({ groups: GROUPS, items: ITEMS, settings: SETTINGS, files }, null, 2);
        const url  = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url; a.download = 'vk-templates.json'; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      if (!ids.length) { dump({}); return; }
      try { chrome.storage.local.get(ids.map(FILE_KEY), (r) => dump(r || {})); }
      catch (e) { dump({}); }
    };

    const fi = panel.querySelector('#s-import-file');
    panel.querySelector('#s-import').onclick = () => fi.click();
    fi.onchange = () => {
      const f = fi.files[0];
      if (!f) return;
      const fr = new FileReader();
      fr.onload = () => {
        try {
          const obj = JSON.parse(fr.result);
          const items = Array.isArray(obj.items) ? obj.items.map(normalizeItem) : [];
          let groups;
          if (Array.isArray(obj.groups) && obj.groups.length) {
            groups = obj.groups.map(normalizeGroup);
            const ids = new Set(groups.map(g => g.id));
            items.forEach(it => { if (!ids.has(it.gid)) it.gid = groups[0].id; });
          } else {
            // старый формат экспорта (вкладки-номера) — мигрируем
            groups = migrateFromTabs(items);
          }
          ITEMS = items; GROUPS = groups;
          if (obj.settings) SETTINGS = Object.assign(SETTINGS, obj.settings);
          activeGid = GROUPS[0] ? GROUPS[0].id : null;
          ensureIntegrity();
          const files = (obj.files && typeof obj.files === 'object') ? obj.files : {};
          const known = new Set(filesOf(ITEMS).map(FILE_KEY));
          const put = {};
          Object.keys(files).forEach(k => { if (known.has(k) && files[k] && files[k].data) put[k] = files[k]; });
          // у шаблонов, чьих файлов в бэкапе нет, вложения снимаем
          ITEMS.forEach(it => { if (it.files) it.files = it.files.filter(f => put[FILE_KEY(f.id)]); });
          const after = () => {
            persist(); render();
            alert('Импортировано: групп — ' + GROUPS.length + ', шаблонов — ' + ITEMS.length + ', файлов — ' + Object.keys(put).length);
          };
          if (Object.keys(put).length) chrome.storage.local.set(put, after); else after();
        } catch (e) { alert('Не удалось прочитать файл.'); }
      };
      fr.readAsText(f);
    };
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  // Панель появляется рядом с кнопкой (над ней, если есть место, иначе под)
  function positionPanel() {
    if (!panel || !btn) return;
    const r  = btn.getBoundingClientRect();
    const pw = panel.offsetWidth  || 360;
    const ph = panel.offsetHeight || 420;
    const left = clamp(r.right - pw, 8, window.innerWidth - pw - 8);
    let top = (r.top > ph + 16) ? r.top - ph - 10 : r.bottom + 10;
    top = clamp(top, 8, window.innerHeight - ph - 8);
    panel.style.left = left + 'px';
    panel.style.top  = top + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function togglePanel() {
    if (!panel) { panel = document.createElement('div'); panel.id = 'vk-tpl-panel'; document.body.appendChild(panel); }
    (panel.style.display === 'block') ? closePanel() : openPanel();
  }

  function openPanel()  { if (panel) { panel.style.display = 'block'; render(); positionPanel(); } }
  function closePanel() { if (panel) panel.style.display = 'none'; editingId = null; editFiles = []; editFilesFor = null; showSettings = false; showGroups = false; }

  // Плавно прокручивает панель к редактору и ставит курсор в поле названия
  function scrollToEditor() {
    requestAnimationFrame(() => {
      if (!panel) return;
      panel.scrollTo({ top: panel.scrollHeight, behavior: 'smooth' });
      const n = panel.querySelector('#vk-tpl-name');
      if (n) n.focus({ preventScroll: true });
    });
  }

  // ---------- Перетаскивание кнопки ----------
  let drag = null;
  function pointer(e) { return e.touches ? e.touches[0] : e; }

  function onDown(e) {
    const p = pointer(e);
    const r = btn.getBoundingClientRect();
    drag = { dx: p.clientX - r.left, dy: p.clientY - r.top, sx: p.clientX, sy: p.clientY, moved: false };
    btn.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
  }
  function onMove(e) {
    if (!drag) return;
    const p = pointer(e);
    if (Math.abs(p.clientX - drag.sx) + Math.abs(p.clientY - drag.sy) > 5) drag.moved = true;
    if (e.cancelable) e.preventDefault();
    const left = clamp(p.clientX - drag.dx, 0, window.innerWidth  - btn.offsetWidth);
    const top  = clamp(p.clientY - drag.dy, 0, window.innerHeight - btn.offsetHeight);
    btn.style.left = left + 'px'; btn.style.top = top + 'px';
    btn.style.right = 'auto'; btn.style.bottom = 'auto';
    if (panel && panel.style.display === 'block') positionPanel();
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onUp);
    btn.classList.remove('dragging');
    if (!drag) return;
    if (drag.moved) {
      const r = btn.getBoundingClientRect();
      SETTINGS.btnPos = { left: Math.round(r.left), top: Math.round(r.top) };
      persist();
    } else {
      togglePanel();   // не было перемещения → это клик
    }
    drag = null;
  }

  // ---------- Монтирование / размонтирование модуля ----------
  // Модуль можно выключить из попапа расширения (ключ modTemplates).
  let mounted = false;

  function mount() {
    if (mounted) return;
    mounted = true;
    if (document.body) init();
    else window.addEventListener('DOMContentLoaded', init, { once: true });
  }

  function unmount() {
    mounted = false;
    if (panel) { panel.remove(); panel = null; }
    if (btn) { btn.remove(); btn = null; }
    editingId = null; showSettings = false; showGroups = false;
  }

  function init() {
    if (!mounted) return;      // модуль успели выключить, пока ждали DOM
    if (btn) return;           // уже смонтировано
    injectStyle();
    btn = document.createElement('button');
    btn.id = 'vk-tpl-btn';
    btn.textContent = '📝';
    btn.title = 'Шаблоны (зажми и тащи, чтобы передвинуть)';
    if (SETTINGS.btnPos) {
      btn.style.left = clamp(SETTINGS.btnPos.left, 0, window.innerWidth  - 46) + 'px';
      btn.style.top  = clamp(SETTINGS.btnPos.top,  0, window.innerHeight - 46) + 'px';
      btn.style.right = 'auto'; btn.style.bottom = 'auto';
    }
    btn.addEventListener('mousedown', onDown);
    btn.addEventListener('touchstart', onDown, { passive: true });
    document.body.appendChild(btn);
  }

  chrome.storage.local.get(['items', 'groups', 'settings', 'modTemplates'], (res) => {
    ITEMS = (res.items || []).map(normalizeItem);
    if (Array.isArray(res.groups) && res.groups.length) {
      GROUPS = res.groups.map(normalizeGroup);
    } else {
      // первый запуск v2.0 (или чистая установка) — создаём группы
      // из старых вкладок-номеров, чтобы ничего не потерялось
      GROUPS = migrateFromTabs(ITEMS);
    }
    if (res.settings) SETTINGS = Object.assign(SETTINGS, res.settings);
    activeGid = GROUPS[0] ? GROUPS[0].id : null;
    ensureIntegrity();
    persist(); // фиксируем миграцию/нормализацию в storage
    if (res.modTemplates !== false) mount();
  });

  // Синхронизация между вкладками: если данные изменились в другой вкладке —
  // подхватываем их здесь, чтобы не перезаписать чужие изменения старой копией.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      // переключатель модуля из попапа — включаем/выключаем на лету
      if (changes.modTemplates) {
        if (changes.modTemplates.newValue === false) unmount();
        else mount();
      }
      if (changes.items)  ITEMS  = (changes.items.newValue  || []).map(normalizeItem);
      if (changes.groups) GROUPS = (changes.groups.newValue || []).map(normalizeGroup);
      if (changes.settings) SETTINGS = Object.assign(SETTINGS, changes.settings.newValue || {});
      ensureIntegrity();
      // не перерисовываем, пока пользователь печатает в поле
      const ae = document.activeElement;
      const typing = panel && panel.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae ? ae.tagName : '');
      if (panel && panel.style.display === 'block' && !typing) render();
    });
  } catch (e) {}
})();
