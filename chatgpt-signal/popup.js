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
  tabStatus: $('tabStatus')
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
    els.status.textContent = result && result.ok
      ? 'Сигнал отправлен. Не слышно? Проверьте громкость системы и браузера.'
      : `Не получилось воспроизвести звук${result && result.error ? `: ${result.error}` : '.'}`;
  } catch (error) {
    els.status.textContent = `Не получилось воспроизвести звук: ${error.message || error}`;
  } finally {
    els.test.disabled = false;
  }
});

initialize().catch(() => { els.status.textContent = 'Не удалось загрузить настройки.'; });
checkCurrentTab();
