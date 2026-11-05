// Работает в контексте самой страницы ChatGPT (world: MAIN) и запускается
// раньше её собственных скриптов. Замечает, когда начинается и
// заканчивается потоковый ответ (text/event-stream с chatgpt.com/backend-api).
//
// Содержимое ответа НЕ читается и никуда не передаётся: копия потока
// читается только ради момента его окончания, данные сразу отбрасываются.
(() => {
  'use strict';
  if (window.__kitGptHooked) return;
  Object.defineProperty(window, '__kitGptHooked', { value: true });

  const SOURCE = 'kit-gpt-signal';
  const originalFetch = window.fetch;
  let nextId = 1;

  function emit(type, id, path) {
    window.postMessage({ source: SOURCE, type, id, path }, location.origin);
  }

  function requestUrl(input) {
    try {
      if (input instanceof Request) return input.url;
      if (input instanceof URL) return input.href;
      return String(input);
    } catch (_) {
      return '';
    }
  }

  // Путь без идентификаторов чатов — только для журнала диагностики.
  function shortPath(pathname) {
    return pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{20,}|[0-9a-f]{16,}/gi, ':id');
  }

  function backendPath(input) {
    try {
      const url = new URL(requestUrl(input), location.href);
      if (url.origin !== location.origin || !url.pathname.includes('/backend-')) return null;
      return shortPath(url.pathname);
    } catch (_) {
      return null;
    }
  }

  function watchStream(response, path) {
    const type = response.headers.get('content-type') || '';
    if (!type.includes('text/event-stream') || !response.body) return;

    let reader;
    try {
      reader = response.clone().body.getReader();
    } catch (_) {
      return;
    }

    const id = nextId++;
    emit('stream-start', id, path);
    (async () => {
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
        emit('stream-done', id, path);
      } catch (_) {
        // Поток оборван: «Стоп», переход в другой чат, обрыв сети.
        emit('stream-aborted', id, path);
      }
    })();
  }

  function patchedFetch(input, init) {
    const promise = originalFetch.apply(window, arguments);
    const path = backendPath(input);
    if (path) promise.then((response) => watchStream(response, path), () => {});
    return promise;
  }

  Object.defineProperty(patchedFetch, 'name', { value: 'fetch' });
  patchedFetch.toString = () => originalFetch.toString();
  window.fetch = patchedFetch;
  emit('hook-ready', 0, '');
})();
