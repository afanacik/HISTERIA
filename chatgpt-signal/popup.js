'use strict';

const DEFAULTS = { enabled: true, backgroundOnly: false, notify: false, sound: 'chime', volume: 70 };
const MAX_FILE_BYTES = 3 * 1024 * 1024;

const $ = (id) => document.getElementById(id);
const els = {
  enabled: $('enabled'),
  backgroundOnly: $('backgroundOnly'),
  notify: $('notify'),
  sound: $('sound'),
  volume: $('volume'),
  volumeValue: $('volumeValue'),
  customBox: $('customBox'),
  customFile: $('customFile'),
  customName: $('customName'),
  test: $('testSound'),
  status: $('status'),
  tabStatus: $('tabStatus'),
  journal: $('journal'),
  logList: $('logList'),
  copyLog: $('copyLog'),
  clearLog: $('clearLog'),
  version: $('version')
};

function save(patch) {
  return chrome.storage.local.set(patch);
}

function showCustomBox() {
  els.customBox.hidden = els.sound.value !== 'custom';
}

async function initialize() {
  const settings = await chrome.storage.local.get(DEFAULTS);
  els.enabled.checked = Boolean(settings.enabled);
  els.backgroundOnly.checked = Boolean(settings.backgroundOnly);
  els.notify.checked = Boolean(settings.notify);
  els.sound.value = settings.sound;
  els.volume.value = settings.volume;
  els.volumeValue.textContent = `${els.volume.value}%`;
  showCustomBox();

  const { customSound } = await chrome.storage.local.get('customSound');
  if (customSound && customSound.name) els.customName.textContent = `Выбран: ${customSound.name}`;
}

async function checkCurrentTab() {
  const box = els.tabStatus;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || typeof tab.id !== 'number') throw new Error('no tab');
    // Адрес вкладки виден только для сайтов расширения (ChatGPT);
    // для остальных он пустой.
    const host = tab.url ? new URL(tab.url).hostname : '';
    if (host !== 'chatgpt.com' && host !== 'chat.openai.com') {
      box.className = 'tab-status';
      box.textContent = 'Откройте это окно на вкладке chatgpt.com, чтобы проверить подключение. Сигнал работает и без этого.';
      return;
    }
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'PING_TAB' });
    if (!result || !result.ok) throw new Error('no answer');
    box.className = 'tab-status ok';
    box.textContent = result.generating
      ? '✓ Вкладка подключена. Сейчас идёт ответ — сигнал прозвучит в конце.'
      : '✓ Вкладка ChatGPT подключена. Всё готово.';
  } catch (_) {
    box.className = 'tab-status warn';
    box.textContent = 'Вкладка ChatGPT ещё не подключена — обновите её (F5) после установки расширения.';
  }
}

els.enabled.addEventListener('change', () => save({ enabled: els.enabled.checked }));
els.backgroundOnly.addEventListener('change', () => save({ backgroundOnly: els.backgroundOnly.checked }));
els.notify.addEventListener('change', () => save({ notify: els.notify.checked }));
els.sound.addEventListener('change', () => {
  showCustomBox();
  save({ sound: els.sound.value });
});
els.volume.addEventListener('input', () => {
  els.volumeValue.textContent = `${els.volume.value}%`;
  save({ volume: Number(els.volume.value) });
});

els.customFile.addEventListener('change', () => {
  const file = els.customFile.files && els.customFile.files[0];
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) {
    els.status.textContent = 'Файл больше 3 МБ — выберите покороче.';
    els.customFile.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      await save({ customSound: { name: file.name, dataUrl: reader.result }, sound: 'custom' });
      els.customName.textContent = `Выбран: ${file.name}`;
      els.status.textContent = 'Файл сохранён. Нажмите «Проверить звук».';
    } catch (_) {
      els.status.textContent = 'Не удалось сохранить файл.';
    }
  };
  reader.onerror = () => { els.status.textContent = 'Не удалось прочитать файл.'; };
  reader.readAsDataURL(file);
});

async function playInPopup(reason) {
  let dataUrl = null;
  if (els.sound.value === 'custom') {
    const { customSound } = await chrome.storage.local.get('customSound');
    dataUrl = customSound && customSound.dataUrl;
  }
  await MyGptSignalSounds.play({ sound: els.sound.value, volume: Number(els.volume.value), dataUrl });
  els.status.textContent = `Сыграно прямо в этом окне. Фоновый плеер не сработал (${reason}) — ` +
    'сигнал после ответа будет играть на странице ChatGPT.';
}

els.test.addEventListener('click', async () => {
  if (Number(els.volume.value) === 0) {
    els.status.textContent = 'Громкость на нуле — прибавьте её.';
    return;
  }
  els.test.disabled = true;
  els.status.textContent = 'Играю…';
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'TEST_SOUND',
      preview: { sound: els.sound.value, volume: Number(els.volume.value) },
      withNotification: els.notify.checked
    });
    if (result && result.ok) {
      els.status.textContent = 'Сигнал отправлен. Не слышно? Проверьте громкость системы и браузера.';
    } else {
      await playInPopup(result && result.error || 'нет ответа');
    }
  } catch (error) {
    try {
      await playInPopup(error.message || String(error));
    } catch (error2) {
      els.status.textContent = `Не получилось воспроизвести звук: ${error2.message || error2}`;
    }
  } finally {
    els.test.disabled = false;
  }
});

function renderLog(lines) {
  els.logList.replaceChildren(...(lines || []).slice().reverse().map((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    return li;
  }));
}

async function loadLog() {
  const { log } = await chrome.storage.session.get('log');
  renderLog(log);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.log) renderLog(changes.log.newValue);
});

els.copyLog.addEventListener('click', async () => {
  const { log = [] } = await chrome.storage.session.get('log');
  const text = `Мой сигнал v${chrome.runtime.getManifest().version}, ${navigator.userAgent}\n` + log.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    els.status.textContent = 'Журнал скопирован — вставьте его в чат.';
  } catch (_) {
    els.status.textContent = 'Не удалось скопировать — сделайте скриншот журнала.';
  }
});

els.clearLog.addEventListener('click', async () => {
  await chrome.storage.session.set({ log: [] });
});

els.journal.addEventListener('toggle', () => {
  try { localStorage.setItem('journalOpen', els.journal.open ? '1' : ''); } catch (_) {}
});
try { if (localStorage.getItem('journalOpen')) els.journal.open = true; } catch (_) {}

els.version.textContent = `v${chrome.runtime.getManifest().version}`;
loadLog();

initialize().catch(() => { els.status.textContent = 'Не удалось загрузить настройки.'; });
checkCurrentTab();
