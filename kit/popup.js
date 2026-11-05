/* Кит — логика попапа */

const $ = (id) => document.getElementById(id);

const DEF_LOCAL = {
  apiKey: '',
  openaiApiKey: '',
  modTemplates: true,
  modStealth: true,
  stealthOn: true,
  onlineOn: false,
  typingOn: false,
  diagOn: false,
  onlineRe: '',
  vkfixEnabled: true,
  vkfixFrom: '54',
  vkfixTo: 'st1-53.vk.ru',
  items: [], groups: [], settings: {}
};
const DEF_SYNC = { enabled: true, showDiff: true, autoFix: false, autoPause: false, autoDelay: 3, fixCount: 0,
                   gfModel: 'claude-haiku-5-5', gfProvider: 'anthropic', gfOpenaiModel: 'gpt-4.1-mini' };

const VER = chrome.runtime.getManifest().version;

// модели ГрамФикса: имя для диагностики и цена за 1 млн токенов для подсказки
const DEFAULT_MODEL = 'claude-haiku-5-5';
const MODEL_INFO = {
  'claude-haiku-5-5':          { name: 'Haiku 5.5',  price: '$0,10 на входе, $0,50 на выходе' },
  'claude-sonnet-5-5':         { name: 'Sonnet 5.5', price: '$2 на входе, $10 на выходе' },
  'claude-opus-5-5':           { name: 'Opus 5.5',   price: '$4 на входе, $20 на выходе' },
  'claude-fable-5-1':          { name: 'Fable 5.1',  price: '$10 на входе, $50 на выходе' },
  'claude-haiku-4-5-20251001': { name: 'Haiku 4.5',  price: '$1 на входе, $5 на выходе' }
};
const modelId = (v) => (MODEL_INFO[v] ? v : DEFAULT_MODEL);
const OPENAI_MODEL_INFO = {
  'gpt-4.1-mini': 'GPT-4.1 mini',
  'gpt-5-mini': 'GPT-5 mini',
  'gpt-4.1-nano': 'GPT-4.1 nano'
};
const openaiModelId = (v) => (OPENAI_MODEL_INFO[v] ? v : 'gpt-4.1-mini');
const providerId = (v) => v === 'openai' ? 'openai' : 'anthropic';

// ---------- вкладки ----------
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('on'));
    document.querySelectorAll('.pane').forEach(x => x.classList.remove('on'));
    t.classList.add('on');
    $('pane-' + t.dataset.pane).classList.add('on');
  });
});

function setStatus(el, type, msg) {
  const colors = { ok: '#4ade80', err: '#f87171', warn: '#fbbf24' };
  el.innerHTML = '';
  const dot = document.createElement('div');
  dot.className = 'dot ' + type;
  const span = document.createElement('span');
  span.style.color = colors[type] || '#9090cc';
  span.textContent = msg;
  el.append(dot, span);
}

// ---------- загрузка состояния ----------
let LOCAL = {}, SYNC = {};

async function load() {
  LOCAL = await chrome.storage.local.get(DEF_LOCAL);
  SYNC  = await chrome.storage.sync.get(DEF_SYNC);

  // ГрамФикс
  $('gfOn').checked   = SYNC.enabled !== false;
  $('gfDiff').checked = SYNC.showDiff !== false;
  $('gfAuto').checked  = SYNC.autoFix === true;
  $('gfPause').checked = SYNC.autoPause === true;
  $('gfDelay').value   = Math.min(15, Math.max(1, Number(SYNC.autoDelay) || 3));
  paintDelay();
  $('fixCount').textContent = SYNC.fixCount || 0;
  $('apiKey').value = LOCAL.apiKey || '';
  $('openaiApiKey').value = LOCAL.openaiApiKey || '';
  setStatus($('apiStatus'), LOCAL.apiKey ? 'ok' : 'warn', LOCAL.apiKey ? 'Ключ Claude сохранён' : 'Ключ Claude пока не задан');
  setStatus($('openaiStatus'), LOCAL.openaiApiKey ? 'ok' : 'warn', LOCAL.openaiApiKey ? 'Ключ OpenAI сохранён' : 'Ключ OpenAI пока не задан');
  $('gfProvider').value = providerId(SYNC.gfProvider);
  $('gfModel').value = modelId(SYNC.gfModel);
  $('gfOpenaiModel').value = openaiModelId(SYNC.gfOpenaiModel);
  paintProvider();

  // Шаблоны
  $('tplOn').checked = LOCAL.modTemplates !== false;
  const nI = (LOCAL.items || []).length, nG = (LOCAL.groups || []).length;
  $('tplStat').textContent = nI || nG
    ? `шаблонов — ${nI}, групп — ${nG}`
    : 'пока пусто — добавь первый шаблон на vk.com';

  // Невидимка
  $('stMod').checked   = LOCAL.modStealth !== false;
  $('stOn').checked    = LOCAL.stealthOn !== false;
  $('stOnline').checked = LOCAL.onlineOn === true;
  $('stTyping').checked = LOCAL.typingOn === true;
  $('stDiag').checked   = LOCAL.diagOn === true;
  $('stRe').value       = LOCAL.onlineRe || '';
  await showStealthStatus();

  // st fix
  $('fixOn').checked  = LOCAL.vkfixEnabled !== false;
  $('fixFrom').value  = LOCAL.vkfixFrom || '54';
  $('fixTo').value    = LOCAL.vkfixTo || 'st1-53.vk.ru';
  await showFixStatus();

  // Сигнал ChatGPT
  await loadGpt();

  markTabs();
}

// красная точка на вкладке выключенного модуля
function markTabs() {
  const state = {
    gf:  $('gfOn').checked,
    tpl: $('tplOn').checked,
    st:  $('stMod').checked,
    fix: $('fixOn').checked,
    gpt: $('gptOn').checked
  };
  document.querySelectorAll('.tab').forEach(t => {
    t.querySelector('.dot-off')?.remove();
    if (!state[t.dataset.pane]) {
      const d = document.createElement('i');
      d.className = 'dot-off';
      t.appendChild(d);
    }
  });
}

async function showFixStatus() {
  try {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    const main = rules.find(r => r.id === 1001);
    const sentry = rules.filter(r => r.id >= 2001)
                        .flatMap(r => r.condition.requestDomains || []);
    if (!main) {
      setStatus($('fixStatus'), 'warn', 'Правило не активно');
    } else {
      const from = (main.condition.regexFilter.match(/-(\d+)\\\./) || [])[1] || '?';
      setStatus($('fixStatus'), 'ok',
        `Активно: st*-${from}.vk.ru → ${main.action.redirect.transform.host} · CORS-пропуск включён`);
    }
    const st = $('sentryStat');
    if (st) st.textContent = sentry.length
      ? 'вылечено: ' + sentry.join(', ')
      : 'новых битых шардов не поймано';
  } catch (e) {
    setStatus($('fixStatus'), 'err', 'Не удалось прочитать правила: ' + e.message);
  }
}

// ---------- ГрамФикс ----------
$('gfOn').addEventListener('change', () => {
  chrome.storage.sync.set({ enabled: $('gfOn').checked });
  markTabs();
});
$('gfDiff').addEventListener('change', () => {
  chrome.storage.sync.set({ showDiff: $('gfDiff').checked });
});
$('gfAuto').addEventListener('change', () => {
  chrome.storage.sync.set({ autoFix: $('gfAuto').checked });
});

function paintDelay() {
  $('gfDelayVal').textContent = $('gfDelay').value + ' с';
  $('delayRow').className = $('gfPause').checked ? 'range-row' : 'range-row off';
}
$('gfPause').addEventListener('change', () => {
  chrome.storage.sync.set({ autoPause: $('gfPause').checked });
  paintDelay();
});
$('gfDelay').addEventListener('input', paintDelay);
$('gfDelay').addEventListener('change', () => {
  chrome.storage.sync.set({ autoDelay: Number($('gfDelay').value) });
});
function paintProvider() {
  const openai = $('gfProvider').value === 'openai';
  $('claudeSettings').style.display = openai ? 'none' : '';
  $('openaiSettings').style.display = openai ? '' : 'none';
  $('fixPage').disabled = openai ? !LOCAL.openaiApiKey : !LOCAL.apiKey;
  paintModel();
}
function paintModel() {
  if ($('gfProvider').value === 'openai') {
    $('gfModelHint').textContent = 'OpenAI API оплачивается отдельно. Модель переключается сразу.';
  } else {
    const info = MODEL_INFO[modelId($('gfModel').value)];
    $('gfModelHint').textContent = 'Цена за 1 млн токенов: ' + info.price + '. Выбор сохраняется сразу.';
  }
}
$('gfProvider').addEventListener('change', async () => {
  await chrome.storage.sync.set({ gfProvider: providerId($('gfProvider').value) });
  paintProvider();
});
$('gfModel').addEventListener('change', () => {
  chrome.storage.sync.set({ gfModel: modelId($('gfModel').value) });
  paintModel();
});
$('gfOpenaiModel').addEventListener('change', () => {
  chrome.storage.sync.set({ gfOpenaiModel: openaiModelId($('gfOpenaiModel').value) });
  paintModel();
});

// Фоновая часть могла остаться старой, если после замены файлов не нажали ↻:
// тогда выбор модели ни на что не влияет. Предупреждаем прямо под списком.
function checkBackground() {
  chrome.runtime.sendMessage({ action: 'kitPing' }, (r) => {
    void chrome.runtime.lastError;
    if (!r || r.build !== VER) {
      setStatus($('modelStatus'), 'warn',
        'Фон Кита не обновился, модель пока прежняя. Открой chrome://extensions и нажми ↻ на карточке «Кит»');
    } else {
      $('modelStatus').innerHTML = '';
    }
  });
}

$('saveKey').addEventListener('click', async () => {
  const key = $('apiKey').value.trim();
  if (!key.startsWith('sk-ant-')) { setStatus($('apiStatus'), 'err', 'Ключ Claude должен начинаться с sk-ant-'); return; }
  try {
    await chrome.storage.local.set({ apiKey: key });
    LOCAL.apiKey = key;
    setStatus($('apiStatus'), 'ok', 'Ключ Claude сохранён');
    paintProvider();
  } catch (e) { setStatus($('apiStatus'), 'err', 'Не удалось сохранить ключ: ' + e.message); }
});
$('saveOpenaiKey').addEventListener('click', async () => {
  const key = $('openaiApiKey').value.trim();
  if (!key.startsWith('sk-') || key.length < 15) {
    setStatus($('openaiStatus'), 'err', 'Нужен OpenAI API ключ, начинающийся с sk-'); return;
  }
  try {
    await chrome.storage.local.set({ openaiApiKey: key });
    LOCAL.openaiApiKey = key;
    setStatus($('openaiStatus'), 'ok', 'Ключ OpenAI сохранён');
    paintProvider();
  } catch (e) { setStatus($('openaiStatus'), 'err', 'Не удалось сохранить ключ: ' + e.message); }
});
$('fixPage').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { action: 'fixPage' }, () => void chrome.runtime.lastError);
    const btn = $('fixPage');
    btn.innerHTML = '<span>⏳</span><span>Исправляю…</span>';
    btn.disabled = true;
    setTimeout(() => {
      btn.innerHTML = '<span>⚡</span><span>Исправить все поля на странице</span>';
      btn.disabled = false;
      chrome.storage.sync.get({ fixCount: 0 }, (d) => { $('fixCount').textContent = d.fixCount; });
    }, 3000);
  });
});

$('resetPos').addEventListener('click', async () => {
  await chrome.storage.local.remove('gfPos');
  const b = $('resetPos');
  b.innerHTML = '<span>✅</span><span>Значок снова у поля ввода</span>';
  setTimeout(() => {
    b.innerHTML = '<span>📍</span><span>Вернуть значок к полю ввода</span>';
  }, 2000);
});

// ---------- Диагностика ----------
const EDITABLE_SEL = 'textarea, input[type="text"], input[type="search"], input[type="email"], ' +
                     'input[type="url"], input:not([type]), [contenteditable="true"], ' +
                     '[contenteditable=""], [contenteditable="plaintext-only"]';

$('diagBtn').addEventListener('click', async () => {
  const out = $('diagOut');
  out.className = 'on';
  out.textContent = 'Проверяю…';

  const line = (cls, head, url) => {
    const d = document.createElement('div');
    d.className = 'diag-line';
    const b = document.createElement('b');
    b.className = cls;
    b.textContent = head;
    d.appendChild(b);
    if (url) {
      const u = document.createElement('span');
      u.className = 'diag-url';
      u.textContent = url.length > 70 ? url.slice(0, 70) + '…' : url;
      d.appendChild(u);
    }
    return d;
  };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { out.textContent = 'Нет активной вкладки'; return; }

  out.textContent = '';
  const loc = await chrome.storage.local.get({ apiKey: '', openaiApiKey: '' });
  const syn = await chrome.storage.sync.get({ enabled: true, gfProvider: 'anthropic', gfModel: DEFAULT_MODEL, gfOpenaiModel: 'gpt-4.1-mini' });
  const isOpenAI = syn.gfProvider === 'openai';
  const hasKey = !!(isOpenAI ? loc.openaiApiKey : loc.apiKey);
  out.appendChild(line(hasKey ? 'diag-ok' : 'diag-err',
    (hasKey ? '✅' : '❌') + ' ' + (isOpenAI ? 'OpenAI' : 'Claude') + ' API ключ: ' + (hasKey ? 'сохранён' : 'НЕ задан — модуль молчит')));
  out.appendChild(line('diag-ok', '🧠 Модель: ' + (isOpenAI ? OPENAI_MODEL_INFO[openaiModelId(syn.gfOpenaiModel)] : MODEL_INFO[modelId(syn.gfModel)].name)));
  out.appendChild(line(syn.enabled !== false ? 'diag-ok' : 'diag-err',
    (syn.enabled !== false ? '✅' : '❌') + ' Модуль ГрамФикс: ' + (syn.enabled !== false ? 'включён' : 'выключен')));

  let frames;
  try {
    frames = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      args: [EDITABLE_SEL],
      func: (sel) => ({
        url: location.href,
        loaded: !!window.__kitGramfix,
        menu: !!document.getElementById('gf-wrap'),
        fields: document.querySelectorAll(sel).length
      })
    });
  } catch (e) {
    out.appendChild(line('diag-err', '❌ Не могу выполнить проверку: ' + e.message,
      'На служебных страницах (chrome://, интернет-магазин расширений) скрипты не работают'));
    return;
  }

  frames
    .map(f => f.result)
    .filter(Boolean)
    .sort((a, b) => b.fields - a.fields)
    .slice(0, 6)
    .forEach(r => {
      if (!r.loaded) {
        out.appendChild(line('diag-err', '❌ Скрипт НЕ загружен в этот фрейм', r.url));
      } else if (!r.fields) {
        out.appendChild(line('diag-warn', '⚠️ Скрипт загружен, полей ввода не найдено', r.url));
      } else {
        out.appendChild(line('diag-ok',
          `✅ Скрипт работает · полей: ${r.fields}` + (r.menu ? ' · меню на экране' : ''), r.url));
      }
    });
});

// ---------- Шаблоны ----------
$('tplOn').addEventListener('change', () => {
  chrome.storage.local.set({ modTemplates: $('tplOn').checked });
  markTabs();
});

// ---------- Невидимка ----------
async function vkTabEval(func) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { err: 'Нет активной вкладки' };
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func });
    return { r: res[0] && res[0].result };
  } catch (e) { return { err: 'Открой вкладку ВК, чтобы увидеть статус' }; }
}

async function showStealthStatus() {
  const el = $('stStatus');
  const { r, err } = await vkTabEval(() => {
    const d = document.documentElement.dataset;
    return {
      vk: /(^|\.)vk\.(com|ru)$/.test(location.hostname),
      mod: d.akStealthMod !== 'off',
      read: d.akStealth === 'on',
      online: d.akOnline === 'on',
      typing: d.akTyping === 'on',
      bRead: parseInt(d.akStealthBlocked || '0', 10),
      bOnline: parseInt(d.akOnlineBlocked || '0', 10),
      bTyping: parseInt(d.akTypingBlocked || '0', 10)
    };
  });
  if (err) { setStatus(el, 'warn', err); return; }
  if (!r) { setStatus(el, 'warn', 'Статус недоступен'); return; }
  if (!r.vk) { setStatus(el, 'warn', 'Активная вкладка не ВК'); return; }
  if (!r.mod || (!r.read && !r.online && !r.typing)) { setStatus(el, 'err', 'На этой вкладке невидимка выключена'); return; }
  const parts = [];
  if (r.read)   parts.push(`прочитано: ${r.bRead}`);
  if (r.online) parts.push(`онлайн: ${r.bOnline}`);
  if (r.typing) parts.push(`печатает: ${r.bTyping}`);
  setStatus(el, 'ok', 'Работает · перехвачено ' + parts.join(', '));
}

$('stMod').addEventListener('change', async () => {
  await chrome.storage.local.set({ modStealth: $('stMod').checked });
  markTabs();
  setTimeout(showStealthStatus, 200);
});
$('stOn').addEventListener('change', async () => {
  await chrome.storage.local.set({ stealthOn: $('stOn').checked });
  setTimeout(showStealthStatus, 200);
});
$('stOnline').addEventListener('change', async () => {
  await chrome.storage.local.set({ onlineOn: $('stOnline').checked });
  setTimeout(showStealthStatus, 200);
});
$('stTyping').addEventListener('change', async () => {
  await chrome.storage.local.set({ typingOn: $('stTyping').checked });
  setTimeout(showStealthStatus, 200);
});
$('stDiag').addEventListener('change', async () => {
  await chrome.storage.local.set({ diagOn: $('stDiag').checked });
});
async function saveRe() {
  await chrome.storage.local.set({ onlineRe: $('stRe').value.trim() });
}
$('stRe').addEventListener('change', saveRe);
$('stRe').addEventListener('keydown', e => { if (e.key === 'Enter') { saveRe(); e.target.blur(); } });

$('stCopyLog').addEventListener('click', async () => {
  const btn = $('stCopyLog');
  const { r, err } = await vkTabEval(() => {
    try { return localStorage.getItem('kit_diag') || ''; } catch (e) { return ''; }
  });
  const label = btn.querySelector('span:last-child');
  const orig = label.textContent;
  const flash = (t) => { label.textContent = t; setTimeout(() => label.textContent = orig, 1800); };
  if (err) return flash(err);
  if (!r) return flash('Журнал пуст: включи диагностику и подожди');
  let text = r;
  try {
    const j = JSON.parse(r);
    text = 'Кит · журнал запросов ВК · ' + new Date(j.t).toLocaleString() + ' · ' + j.page + '\n' + j.lines.join('\n');
  } catch (e) {}
  try { await navigator.clipboard.writeText(text); flash('Скопировано'); }
  catch (e) { flash('Не удалось скопировать'); }
});

// ---------- VK st fix ----------
$('fixOn').addEventListener('change', async () => {
  await chrome.storage.local.set({ vkfixEnabled: $('fixOn').checked });
  markTabs();
  setTimeout(showFixStatus, 250);
});
$('saveFix').addEventListener('click', async () => {
  const from = $('fixFrom').value.replace(/\D/g, '');
  const to   = $('fixTo').value.trim().toLowerCase();
  if (!/^\d{1,4}$/.test(from)) { setStatus($('fixStatus'), 'err', 'Номер шарда — только цифры'); return; }
  if (!/^[a-z0-9][a-z0-9.-]*\.vk\.(ru|com)$/i.test(to)) {
    setStatus($('fixStatus'), 'err', 'Хост должен быть вида st1-53.vk.ru'); return;
  }
  if (new RegExp('^st[0-9]+-' + from + '\\.vk\\.ru$', 'i').test(to)) {
    setStatus($('fixStatus'), 'err', 'Целевой хост попадает под то же правило — будет петля'); return;
  }
  await chrome.storage.local.set({ vkfixFrom: from, vkfixTo: to });
  $('fixFrom').value = from; $('fixTo').value = to;
  setTimeout(showFixStatus, 250);
});

// ---------- VK st fix: отчёт и журнал ----------
$('fixReport').addEventListener('click', async () => {
  const { vkfixEvents = [] } = await chrome.storage.local.get('vkfixEvents');
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const main = rules.find(r => r.id === 1001);
  const sentry = rules.filter(r => r.id >= 2001).flatMap(r => r.condition.requestDomains || []);

  let out = 'Кит v' + VER + ' — отчёт VK st fix · ' + new Date().toLocaleString() + '\n';
  out += main
    ? 'Правило: ' + main.condition.regexFilter + ' → ' + main.action.redirect.transform.host + ' (+ CORS)\n'
    : 'Основное правило выключено\n';
  out += 'Сторож вылечил: ' + (sentry.length ? sentry.join(', ') : 'нет') + '\n';
  out += 'Событий в журнале: ' + vkfixEvents.length + '\n\n';

  const g = {};
  for (const e of vkfixEvents) {
    let host = '';
    try { host = new URL(e.url).hostname; } catch {}
    const k = e.kind + ' | ' + host + ' | ' + e.type;
    if (!g[k]) g[k] = { n: 0, ex: e.url };
    g[k].n++;
  }
  const keys = Object.keys(g).sort((a, b) => g[b].n - g[a].n);
  for (const k of keys) out += g[k].n + ' шт — ' + k + '\n   пример: ' + g[k].ex + '\n';
  if (!keys.length) out += 'Ошибок не зафиксировано.\n';

  try { await navigator.clipboard.writeText(out); } catch (e) {}
  const b = $('fixReport');
  b.innerHTML = '<span>✅</span><span>Скопировано</span>';
  setTimeout(() => { b.innerHTML = '<span>📋</span><span>Скопировать отчёт</span>'; }, 2000);
});

$('fixClear').addEventListener('click', async () => {
  await chrome.storage.local.set({ vkfixEvents: [] });
  const b = $('fixClear');
  b.innerHTML = '<span>✅</span><span>Журнал пуст</span>';
  setTimeout(() => { b.innerHTML = '<span>🧹</span><span>Очистить журнал</span>'; }, 1500);
});

// ---------- Сигнал ChatGPT ----------
const GPT_DEF = { gptEnabled: true, gptBackgroundOnly: false, gptNotify: false, gptMarkTab: true,
                  gptSound: 'chime', gptVolume: 70 };
const GPT_EMPTY_STATS = { dings: 0, totalWaitMs: 0, longestMs: 0, day: '', today: 0 };
const GPT_MAX_FILE = 3 * 1024 * 1024;

async function loadGpt() {
  const g = await chrome.storage.local.get(GPT_DEF);
  $('gptOn').checked = g.gptEnabled !== false;
  $('gptBg').checked = g.gptBackgroundOnly === true;
  $('gptMark').checked = g.gptMarkTab !== false;
  $('gptNotify').checked = g.gptNotify === true;
  $('gptSound').value = g.gptSound;
  $('gptVolume').value = g.gptVolume;
  $('gptVolumeVal').textContent = g.gptVolume + '%';
  $('gptCustomBox').hidden = g.gptSound !== 'custom';
  const { gptCustomSound } = await chrome.storage.local.get('gptCustomSound');
  if (gptCustomSound && gptCustomSound.name) $('gptCustomName').textContent = 'Выбран: ' + gptCustomSound.name;
  const { gptStats } = await chrome.storage.local.get({ gptStats: GPT_EMPTY_STATS });
  renderGptStats(gptStats);
  const { gptLog } = await chrome.storage.session.get({ gptLog: [] });
  renderGptLog(gptLog);
  await gptTabStatus();
}

async function gptTabStatus() {
  const el = $('gptTab');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const host = tab && tab.url ? new URL(tab.url).hostname : '';
    if (host !== 'chatgpt.com' && host !== 'chat.openai.com') { el.innerHTML = ''; return; }
    // Окно открыли на ChatGPT — сразу показываем вкладку «Сигнал».
    document.querySelector('.tab[data-pane="gpt"]').click();
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'gpt:ping' });
    if (!r || !r.ok) throw new Error('нет ответа');
    setStatus(el, 'ok', r.generating ? 'Вкладка подключена · идёт ответ' : 'Вкладка ChatGPT подключена');
  } catch (e) {
    setStatus(el, 'warn', 'Вкладка ChatGPT не подключена — обнови её (F5)');
  }
}

function gptDuration(ms) {
  if (ms < 60000) return Math.round(ms / 1000) + ' с';
  const m = Math.round(ms / 60000);
  return m < 60 ? m + ' мин' : Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин';
}
function gptDay() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
function renderGptStats(stats) {
  const s = { ...GPT_EMPTY_STATS, ...(stats || {}) };
  $('gptToday').textContent = s.day === gptDay() ? s.today : 0;
  $('gptDings').textContent = s.dings;
  $('gptWait').textContent = s.totalWaitMs ? gptDuration(s.totalWaitMs) : '0 мин';
  $('gptLongest').textContent = s.longestMs ? gptDuration(s.longestMs) : '—';
}
function renderGptLog(lines) {
  $('gptLog').replaceChildren(...(lines || []).slice().reverse().map((t) => {
    const li = document.createElement('li');
    li.textContent = t;
    return li;
  }));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.gptStats) renderGptStats(changes.gptStats.newValue);
  if (area === 'session' && changes.gptLog) renderGptLog(changes.gptLog.newValue);
});

$('gptOn').addEventListener('change', () => {
  chrome.storage.local.set({ gptEnabled: $('gptOn').checked });
  markTabs();
});
$('gptBg').addEventListener('change', () => chrome.storage.local.set({ gptBackgroundOnly: $('gptBg').checked }));
$('gptMark').addEventListener('change', () => chrome.storage.local.set({ gptMarkTab: $('gptMark').checked }));
$('gptNotify').addEventListener('change', () => chrome.storage.local.set({ gptNotify: $('gptNotify').checked }));
$('gptSound').addEventListener('change', () => {
  $('gptCustomBox').hidden = $('gptSound').value !== 'custom';
  chrome.storage.local.set({ gptSound: $('gptSound').value });
});
$('gptVolume').addEventListener('input', () => {
  $('gptVolumeVal').textContent = $('gptVolume').value + '%';
  chrome.storage.local.set({ gptVolume: Number($('gptVolume').value) });
});

$('gptCustomFile').addEventListener('change', () => {
  const f = $('gptCustomFile').files[0];
  if (!f) return;
  if (f.size > GPT_MAX_FILE) {
    setStatus($('gptStatus'), 'err', 'Файл больше 3 МБ — выбери покороче');
    $('gptCustomFile').value = '';
    return;
  }
  const fr = new FileReader();
  fr.onload = async () => {
    try {
      await chrome.storage.local.set({ gptCustomSound: { name: f.name, dataUrl: fr.result }, gptSound: 'custom' });
      $('gptCustomName').textContent = 'Выбран: ' + f.name;
      setStatus($('gptStatus'), 'ok', 'Файл сохранён — нажми «Проверить звук»');
    } catch (e) { setStatus($('gptStatus'), 'err', 'Не удалось сохранить файл'); }
  };
  fr.onerror = () => setStatus($('gptStatus'), 'err', 'Не удалось прочитать файл');
  fr.readAsDataURL(f);
});

async function gptPlayInPopup(reason) {
  let dataUrl = null;
  if ($('gptSound').value === 'custom') {
    const { gptCustomSound } = await chrome.storage.local.get('gptCustomSound');
    dataUrl = gptCustomSound && gptCustomSound.dataUrl;
  }
  await KitGptSounds.play({ sound: $('gptSound').value, volume: Number($('gptVolume').value), dataUrl });
  setStatus($('gptStatus'), 'warn', 'Сыграно прямо в окне. Фоновый плеер не сработал (' + reason +
    ') — после ответа звук сыграет на странице ChatGPT');
}

$('gptTest').addEventListener('click', async () => {
  if (Number($('gptVolume').value) === 0) { setStatus($('gptStatus'), 'warn', 'Громкость на нуле'); return; }
  const btn = $('gptTest');
  btn.disabled = true;
  try {
    const r = await chrome.runtime.sendMessage({
      type: 'gpt:test',
      preview: { gptSound: $('gptSound').value, gptVolume: Number($('gptVolume').value) },
      withNotification: $('gptNotify').checked
    });
    if (r && r.ok) setStatus($('gptStatus'), 'ok', 'Сигнал отправлен. Не слышно — проверь громкость Windows');
    else await gptPlayInPopup(r && r.error || 'нет ответа');
  } catch (e) {
    try { await gptPlayInPopup(e.message || String(e)); }
    catch (e2) { setStatus($('gptStatus'), 'err', 'Не получилось воспроизвести: ' + (e2.message || e2)); }
  } finally {
    btn.disabled = false;
  }
});

$('gptResetStats').addEventListener('click', () => {
  if (confirm('Обнулить статистику сигнала?')) chrome.storage.local.set({ gptStats: GPT_EMPTY_STATS });
});
$('gptCopyLog').addEventListener('click', async () => {
  const { gptLog = [] } = await chrome.storage.session.get('gptLog');
  const btn = $('gptCopyLog');
  try {
    await navigator.clipboard.writeText('Кит v' + VER + ' · журнал сигнала ChatGPT\n' + gptLog.join('\n'));
    btn.textContent = '✅ Скопировано';
  } catch (e) { btn.textContent = 'Не удалось'; }
  setTimeout(() => { btn.textContent = '📋 Скопировать'; }, 1600);
});
$('gptClearLog').addEventListener('click', () => chrome.storage.session.set({ gptLog: [] }));

// ---------- Бэкап ----------
$('expBtn').addEventListener('click', async () => {
  const loc = await chrome.storage.local.get(DEF_LOCAL);
  const syn = await chrome.storage.sync.get(DEF_SYNC);
  // файлы шаблонов (фото, PDF) лежат по ключам tplFile:<id>
  const all = await chrome.storage.local.get(null);
  const files = {};
  Object.keys(all).forEach(k => { if (k.startsWith('tplFile:')) files[k] = all[k]; });
  const data = {
    kit: VER,
    files,
    groups: loc.groups || [],
    items: loc.items || [],
    settings: loc.settings || {},
    gramfix: { enabled: syn.enabled, showDiff: syn.showDiff, autoFix: syn.autoFix,
               autoPause: syn.autoPause, autoDelay: syn.autoDelay, fixCount: syn.fixCount,
               gfModel: syn.gfModel, gfProvider: syn.gfProvider, gfOpenaiModel: syn.gfOpenaiModel },
    gpt: await chrome.storage.local.get({ ...GPT_DEF, gptCustomSound: null, gptStats: GPT_EMPTY_STATS }),
    modules: {
      modTemplates: loc.modTemplates, modStealth: loc.modStealth,
      stealthOn: loc.stealthOn, onlineOn: loc.onlineOn, typingOn: loc.typingOn, onlineRe: loc.onlineRe,
      vkfixEnabled: loc.vkfixEnabled, vkfixFrom: loc.vkfixFrom, vkfixTo: loc.vkfixTo
    }
    // API ключ намеренно не выгружаем
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'kit-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
});

$('impBtn').addEventListener('click', () => $('impFile').click());
$('impFile').addEventListener('change', () => {
  const f = $('impFile').files[0];
  if (!f) return;
  const fr = new FileReader();
  fr.onload = async () => {
    let obj;
    try { obj = JSON.parse(fr.result); }
    catch (e) { alert('Не удалось прочитать файл — это не JSON.'); return; }

    const upd = {};
    if (Array.isArray(obj.items))  upd.items  = obj.items;
    if (Array.isArray(obj.groups)) upd.groups = obj.groups;
    if (obj.settings && typeof obj.settings === 'object') upd.settings = obj.settings;
    if (obj.modules && typeof obj.modules === 'object') Object.assign(upd, obj.modules);
    if (obj.gpt && typeof obj.gpt === 'object') {
      Object.keys(obj.gpt).forEach(k => { if (k.startsWith('gpt') && obj.gpt[k] !== null) upd[k] = obj.gpt[k]; });
    }
    if (obj.files && typeof obj.files === 'object') {
      Object.keys(obj.files).forEach(k => { if (k.startsWith('tplFile:') && obj.files[k] && obj.files[k].data) upd[k] = obj.files[k]; });
    }

    if (!Object.keys(upd).length) { alert('В файле нет знакомых данных.'); return; }

    await chrome.storage.local.set(upd);
    if (obj.gramfix && typeof obj.gramfix === 'object') await chrome.storage.sync.set(obj.gramfix);

    await load();
    alert('Импортировано: шаблонов — ' + (upd.items ? upd.items.length : 0) +
          ', групп — ' + (upd.groups ? upd.groups.length : 0) +
          '.\nОткрытые вкладки ВК обнови (F5).');
  };
  fr.readAsText(f);
  $('impFile').value = '';
});

$('ver').textContent = 'Кит v' + VER;
load();
checkBackground();
