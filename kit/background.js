/* Кит — фоновый service worker
   Отвечает за:
     1) ГрамФикс — запросы к Anthropic API или OpenAI API (исправить / сформулировать / перевести)
     2) VK st fix — динамическое правило declarativeNetRequest (подмена битого шарда)
     3) значения по умолчанию и миграцию настроек
     4) «Сигнал ChatGPT» — в отдельном файле gpt-signal-bg.js
*/

importScripts('gpt-signal-bg.js');

// ---------- значения по умолчанию ----------
const DEF_LOCAL = {
  apiKey: '',            // прежний ключ Anthropic, сохраняем для совместимости
  openaiApiKey: '',      // отдельный OpenAI API ключ, только локально
  modTemplates: true,    // модуль «Шаблоны ВК»
  modStealth: true,      // модуль «Невидимка»
  stealthOn: true,       // не помечать прочитанным
  onlineOn: false,       // скрывать онлайн
  typingOn: false,       // скрывать «печатает…»
  diagOn: false,         // журнал диагностики запросов ВК
  onlineRe: '',          // свои признаки запросов «онлайн»
  vkfixEnabled: true,    // модуль «VK st fix»
  vkfixFrom: '54',       // номер битого шарда: st*-54.vk.ru
  vkfixTo: 'st1-53.vk.ru'// рабочий хост, на который перенаправляем
};
const DEF_SYNC = {
  enabled: true,         // модуль «ГрамФикс»
  showDiff: true,        // уведомления о том, что исправлено
  autoFix: false,        // исправлять автоматически при уходе из поля
  autoPause: false,      // исправлять после паузы в печати
  autoDelay: 3,          // длительность паузы, секунды
  fixCount: 0,           // счётчик исправлений
  gfModel: 'claude-haiku-5-5', // модель Claude для ГрамФикса
  gfProvider: 'anthropic',    // поставщик AI: anthropic | openai
  gfOpenaiModel: 'gpt-4.1-mini' // модель OpenAI, отдельно от Claude
};

const VKFIX_RULE_ID = 1001;   // основной редирект st*-<N> → рабочий хост
const VKFIX_CORS_ID = 1002;   // CORS-пропуск для рабочего хоста
const SENTRY_MIN_ID = 2001;   // правила, добавленные сторожем (по одному на пойманный шард)

const RES_TYPES = ['main_frame', 'sub_frame', 'script', 'stylesheet', 'font',
                   'image', 'xmlhttprequest', 'media', 'websocket', 'other'];
const CORS_TYPES = ['script', 'stylesheet', 'font', 'xmlhttprequest', 'media', 'image', 'other'];
const CERT_ERRORS = ['net::ERR_CERT_COMMON_NAME_INVALID',
                     'net::ERR_CERT_AUTHORITY_INVALID',
                     'net::ERR_CERT_DATE_INVALID'];
const VK_WATCH = { urls: ['*://*.vk.ru/*', '*://*.vk.com/*', '*://*.userapi.com/*',
                          '*://*.vkuservideo.ru/*', '*://*.vkuservideo.net/*',
                          '*://*.mycdn.me/*', '*://*.vk-cdn.net/*'] };

// ---------- инициализация ----------
async function ensureDefaults() {
  const loc = await chrome.storage.local.get(Object.keys(DEF_LOCAL));
  const addLoc = {};
  for (const k in DEF_LOCAL) if (loc[k] === undefined) addLoc[k] = DEF_LOCAL[k];
  if (Object.keys(addLoc).length) await chrome.storage.local.set(addLoc);

  const syn = await chrome.storage.sync.get(Object.keys(DEF_SYNC));
  const addSyn = {};
  for (const k in DEF_SYNC) if (syn[k] === undefined) addSyn[k] = DEF_SYNC[k];
  if (Object.keys(addSyn).length) await chrome.storage.sync.set(addSyn);

  // миграция: старый ключ мог лежать в sync — переносим в local
  const cur = await chrome.storage.local.get('apiKey');
  if (!cur.apiKey) {
    const old = await chrome.storage.sync.get('apiKey');
    if (old.apiKey) {
      await chrome.storage.local.set({ apiKey: old.apiKey });
      await chrome.storage.sync.remove('apiKey');
    }
  }
}

// ---------- VK st fix: правила ----------
function buildRedirectRule(id, condition, to) {
  return {
    id,
    priority: 1,
    action: { type: 'redirect', redirect: { transform: { host: to } } },
    condition: { ...condition, resourceTypes: RES_TYPES }
  };
}

function buildMainRule(from, to) {
  return buildRedirectRule(VKFIX_RULE_ID,
    { regexFilter: '^https://st([0-9]+)-' + from + '\\.vk\\.ru/' }, to);
}

// CORS-пропуск: рабочий хост отдаёт чужие чанки, но не шлёт разрешение —
// дописываем его сами, иначе строгие webpack-загрузки (Photoview, плеер) падают.
function buildCorsRule(to) {
  return {
    id: VKFIX_CORS_ID,
    priority: 2,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'access-control-allow-origin', operation: 'set', value: 'https://vk.ru' },
        { header: 'access-control-allow-credentials', operation: 'set', value: 'true' }
      ]
    },
    condition: { requestDomains: [to], resourceTypes: CORS_TYPES }
  };
}

function vkfixValid(from, to) {
  if (!/^\d{1,4}$/.test(from)) return false;
  if (!/^[a-z0-9][a-z0-9.-]*\.vk\.(ru|com)$/i.test(to)) return false;
  // защита от петли: целевой хост не должен сам попадать под правило
  if (new RegExp('^st[0-9]+-' + from + '\\.vk\\.ru$', 'i').test(to)) return false;
  return true;
}

async function applyVkFix() {
  const s = await chrome.storage.local.get({
    vkfixEnabled: DEF_LOCAL.vkfixEnabled,
    vkfixFrom: DEF_LOCAL.vkfixFrom,
    vkfixTo: DEF_LOCAL.vkfixTo
  });
  const from = String(s.vkfixFrom || '').replace(/\D/g, '') || DEF_LOCAL.vkfixFrom;
  const to = String(s.vkfixTo || '').trim().toLowerCase();

  const old = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = old.map(r => r.id);
  const enabled = s.vkfixEnabled && vkfixValid(from, to);
  const addRules = [];

  if (enabled) {
    addRules.push(buildMainRule(from, to), buildCorsRule(to));

    // пересобираем правила сторожа под актуальный целевой хост
    const mainRe = new RegExp('^st[0-9]+-' + from + '\\.vk\\.ru$', 'i');
    const caught = new Set();
    for (const r of old) {
      if (r.id < SENTRY_MIN_ID) continue;
      for (const d of (r.condition.requestDomains || [])) caught.add(d);
    }
    let id = SENTRY_MIN_ID;
    for (const d of caught) {
      if (d === to || mainRe.test(d)) continue;
      addRules.push(buildRedirectRule(id++, { requestDomains: [d] }, to));
    }
  }

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (e) {
    console.warn('[Кит] не удалось применить правила VK st fix:', e);
  }
}

// ---------- VK st fix: журнал ----------
async function vkfixLog(entry) {
  try {
    const { vkfixEvents = [] } = await chrome.storage.local.get('vkfixEvents');
    vkfixEvents.push(entry);
    if (vkfixEvents.length > 400) vkfixEvents.splice(0, vkfixEvents.length - 400);
    await chrome.storage.local.set({ vkfixEvents });
  } catch (e) {}
}

// ---------- VK st fix: сторож ----------
// Слушает сетевые ошибки на доменах ВК. Любую пишет в журнал; при ошибке
// сертификата на очередном st*-*.vk.ru — сам добавляет правило редиректа.
chrome.webRequest.onErrorOccurred.addListener(async (d) => {
  if (d.error === 'net::ERR_ABORTED') return;
  await vkfixLog({ t: Date.now(), kind: d.error, type: d.type, url: d.url });
  if (!CERT_ERRORS.includes(d.error)) return;

  const s = await chrome.storage.local.get({
    vkfixEnabled: DEF_LOCAL.vkfixEnabled,
    vkfixFrom: DEF_LOCAL.vkfixFrom,
    vkfixTo: DEF_LOCAL.vkfixTo
  });
  if (s.vkfixEnabled === false) return;
  const from = String(s.vkfixFrom || '').replace(/\D/g, '');
  const to = String(s.vkfixTo || '').trim().toLowerCase();
  if (!vkfixValid(from, to)) return;

  let host = '';
  try { host = new URL(d.url).hostname.toLowerCase(); } catch (e) { return; }
  if (host === to) return;
  if (!/^st\d+-\d+\.vk\.ru$/.test(host)) return;
  if (new RegExp('^st\\d+-' + from + '\\.vk\\.ru$').test(host)) return; // уже покрыт основным правилом

  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  if (rules.some(r => r.id >= SENTRY_MIN_ID &&
      (r.condition.requestDomains || []).includes(host))) return;

  const id = rules.reduce((m, r) => Math.max(m, r.id), SENTRY_MIN_ID - 1) + 1;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [buildRedirectRule(id, { requestDomains: [host] }, to)]
    });
    console.log('[Кит] сторож вылечил шард:', host, '→', to);
  } catch (e) {
    console.warn('[Кит] сторож не смог добавить правило:', e);
  }
}, VK_WATCH);

chrome.webRequest.onCompleted.addListener(async (d) => {
  if (d.statusCode >= 400) {
    await vkfixLog({ t: Date.now(), kind: 'HTTP ' + d.statusCode, type: d.type, url: d.url });
  }
}, VK_WATCH);

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  await applyVkFix();
});
chrome.runtime.onStartup.addListener(applyVkFix);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.vkfixEnabled || changes.vkfixFrom || changes.vkfixTo) applyVkFix();
});

// ===================== ГрамФикс =====================

// Модели, из которых можно выбрать в попапе.
// effort 'low': правка текста простая задача, а человек ждёт ответ, поэтому
// просим модель думать поменьше (так быстрее и дешевле).
// Haiku 4.5 параметр effort не принимает, ей его не отправляем.
const DEFAULT_MODEL = 'claude-haiku-5-5';
const OPENAI_DEFAULT_MODEL = 'gpt-4.1-mini';
const OPENAI_MODELS = new Set(['gpt-4.1-mini', 'gpt-5-mini', 'gpt-4.1-nano']);
const MODELS = {
  'claude-haiku-5-5':          { effort: 'low' },
  'claude-sonnet-5-5':         { effort: 'low' },
  'claude-opus-5-5':           { effort: 'low' },
  'claude-fable-5-1':          { effort: 'low' },
  'claude-haiku-4-5-20251001': { effort: null }
};

async function currentProvider() {
  const s = await chrome.storage.sync.get({ gfProvider: 'anthropic', gfOpenaiModel: OPENAI_DEFAULT_MODEL });
  return {
    provider: s.gfProvider === 'openai' ? 'openai' : 'anthropic',
    openaiModel: OPENAI_MODELS.has(s.gfOpenaiModel) ? s.gfOpenaiModel : OPENAI_DEFAULT_MODEL
  };
}

async function currentModel() {
  try {
    const { gfModel } = await chrome.storage.sync.get({ gfModel: DEFAULT_MODEL });
    return MODELS[gfModel] ? gfModel : DEFAULT_MODEL;
  } catch (e) {
    return DEFAULT_MODEL;
  }
}

const SYSTEM_PROMPTS = {

  fix: `Ты — редактор русского текста. Исправляй ТОЛЬКО орфографические и пунктуационные ошибки.
НЕ меняй стиль, смысл, порядок слов.
ОБЯЗАТЕЛЬНО исправляй: заглавные буквы в начале предложений, имена собственные с маленькой буквы, пропущенные запятые, опечатки.
НЕ добавляй слова, НЕ удаляй слова.
Текст для исправления приходит в теге <text>. Верни ТОЛЬКО исправленную версию.
Отвечай СТРОГО в формате JSON без markdown:
{"fixed": "исправленный текст", "changes": ["краткое описание 1", "краткое описание 2"]}
Если ошибок нет — верни исходный текст и пустой массив changes.`,

  rephrase: `Ты — опытный редактор. Перефразируй текст: сделай формулировки ясными, грамотными и естественными.
ПРАВИЛА:
— Сохраняй смысл, факты, тон и язык оригинала.
— Попутно исправляй все орфографические и пунктуационные ошибки.
— НЕ добавляй новую информацию, НЕ выдумывай факты.
— Сохраняй форматирование (абзацы, переносы строк, списки, эмодзи), если оно есть.
— Не делай текст длиннее без необходимости — формулируй компактно.
Текст приходит в теге <text>.
Отвечай СТРОГО в формате JSON без markdown:
{"fixed": "улучшенный текст", "changes": ["кратко что улучшено 1", "кратко что улучшено 2"]}
Если текст уже сформулирован отлично — верни его без изменений и пустой массив changes.`,

  translate: `Ты — профессиональный переводчик. Переведи текст на английский язык.
ПРАВИЛА:
— Перевод должен быть естественным и грамотным, как у носителя языка.
— Сохраняй смысл, тон и стиль оригинала (formal остаётся formal, разговорный — casual).
— Сохраняй форматирование: абзацы, переносы строк, списки, эмодзи.
— Имена собственные транслитерируй по общепринятым правилам.
— Если текст уже полностью на английском — просто исправь в нём ошибки.
Текст приходит в теге <text>.
Отвечай СТРОГО в формате JSON без markdown:
{"fixed": "английский перевод", "changes": []}`
};

// Версия фонового скрипта. Попап сверяет её с манифестом: если после замены файлов
// не нажали ↻ в chrome://extensions, Chrome может держать старый фон, и выбор модели не действует.
const KIT_BUILD = '2.6.0';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.action === 'kitPing') {
    sendResponse({ build: KIT_BUILD });
    return;
  }
  if (msg.action === 'processText' || msg.action === 'fixText') {
    const mode = msg.mode || 'fix';
    handleAction(mode, msg.text)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true; // асинхронный ответ
  }
});

// API-ключи берутся исключительно из chrome.storage.local фонового скрипта.
// Их не отправляем из content-script в сообщениях, не размещаем в HTML страницы.
async function handleAction(mode, text) {
  if (!text || text.trim().length < 2) return { fixed: text, changes: [] };
  if (text.length > 6000) return { error: 'Слишком длинный текст (более 6000 символов)' };

  const config = await currentProvider();
  const { apiKey, openaiApiKey } = await chrome.storage.local.get({ apiKey: '', openaiApiKey: '' });
  const isOpenAI = config.provider === 'openai';
  const key = String(isOpenAI ? openaiApiKey : apiKey || '').trim();
  if (!key) return { error: 'NO_API_KEY' };

  const system = SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.fix;
  const userText = `<text>${text}</text>`;
  const model = isOpenAI ? config.openaiModel : await currentModel();

  // Форматы API различаются: OpenAI ждёт Bearer и messages[system/user],
  // Claude ждёт x-api-key, отдельное поле system и content blocks в ответе.
  const body = isOpenAI ? {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: userText }],
    response_format: { type: 'json_object' },
    max_completion_tokens: 12000,
    store: false
  } : {
    model,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: userText }]
  };
  if (!isOpenAI && MODELS[model].effort) body.output_config = { effort: MODELS[model].effort };

  try {
    const response = await fetch(isOpenAI
      ? 'https://api.openai.com/v1/chat/completions'
      : 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: isOpenAI ? {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      } : {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      let msg = `HTTP ${response.status}`;
      let errorCode = '';
      try {
        const err = await response.json();
        msg = err.error?.message || msg;
        errorCode = err.error?.code || '';
      } catch (e) {}
      if (response.status === 401) msg = 'Неверный API-ключ. Проверь ключ в настройках Кита';
      if (response.status === 404) msg = `Модель ${model} недоступна. Выбери другую в настройках Кита`;
      if (isOpenAI && response.status === 429 && (errorCode === 'insufficient_quota' || errorCode === 'credit_balance_exhausted')) {
        msg = 'На балансе OpenAI API закончились кредиты. Подписка ChatGPT не оплачивает обычный API';
      }
      throw new Error(msg);
    }

    const data = await response.json();
    let raw = '';
    if (isOpenAI) {
      const choice = data.choices?.[0];
      if (choice?.message?.refusal) return { error: 'Модель отказалась обрабатывать этот текст' };
      if (choice?.finish_reason === 'length') return { error: 'Ответ не поместился в лимит. Попробуй текст покороче' };
      raw = choice?.message?.content || '';
    } else {
      if (data.stop_reason === 'refusal') return { error: 'Модель отказалась обрабатывать этот текст. Попробуй другую в настройках Кита' };
      if (data.stop_reason === 'max_tokens') return { error: 'Ответ не поместился в лимит. Попробуй текст покороче' };
      raw = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    }
    if (typeof raw !== 'string' || !raw.trim()) return { error: 'Модель вернула пустой ответ' };
    const result = parseAiJson(raw.trim());
    if (typeof result.fixed !== 'string') return { error: 'Модель вернула ответ без исправленного текста' };
    return { fixed: result.fixed, changes: Array.isArray(result.changes) ? result.changes : [] };
  } catch (e) {
    if (e instanceof SyntaxError) return { error: 'Ошибка парсинга ответа AI' };
    return { error: e.message || 'Ошибка соединения с AI' };
  }
}

// Надёжный парсинг: как есть → без markdown-обёрток → всё между первой { и последней }
function parseAiJson(raw) {
  const attempts = [
    raw,
    raw.replace(/```json|```/g, '').trim(),
    raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
  ];
  for (const a of attempts) {
    try { return JSON.parse(a); } catch {}
  }
  throw new SyntaxError('bad json');
}
