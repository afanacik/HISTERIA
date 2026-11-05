// Работает в контексте самой страницы ChatGPT (world: MAIN) и запускается
// раньше её собственных скриптов. Задача одна: заметить, когда начинается
// и заканчивается потоковый ответ ChatGPT (запрос .../backend-api/.../conversation
// с типом text/event-stream).
//
// Содержимое ответа НЕ читается и никуда не передаётся: мы читаем копию
// потока только для того, чтобы узнать момент его окончания, а сами
// данные сразу отбрасываются.
(() => {
  'use strict';
  if (window.__myGptSignalHooked) return;
  Object.defineProperty(window, '__myGptSignalHooked', { value: true });

  const SOURCE = 'my-gpt-signal';
  const originalFetch = window.fetch;
  let nextId = 1;

  function emit(type, id) {
    window.postMessage({ source: SOURCE, type, id }, location.origin);
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

  function isConversationRequest(input) {
    try {
      const url = new URL(requestUrl(input), location.href);
      return url.origin === location.origin &&
        url.pathname.includes('/backend-api/') &&
        url.pathname.includes('conversation');
    } catch (_) {
      return false;
    }
  }

  function watchStream(response) {
    const type = response.headers.get('content-type') || '';
    if (!type.includes('text/event-stream') || !response.body) return;

    let reader;
    try {
      reader = response.clone().body.getReader();
    } catch (_) {
      return;
    }

    const id = nextId++;
    emit('stream-start', id);
    (async () => {
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
        emit('stream-done', id);
      } catch (_) {
        // Поток оборван: пользователь нажал «Стоп», ушёл в другой чат или
        // пропала сеть. Это не «готовый ответ».
        emit('stream-aborted', id);
      }
    })();
  }

  function patchedFetch(input, init) {
    const promise = originalFetch.apply(this, arguments);
    if (isConversationRequest(input)) {
      promise.then(watchStream, () => {});
    }
    return promise;
  }

  // Сохраняем «нативный» вид функции, чтобы не сломать код страницы,
  // который может проверять fetch.toString().
  Object.defineProperty(patchedFetch, 'name', { value: 'fetch' });
  patchedFetch.toString = () => originalFetch.toString();
  window.fetch = patchedFetch;
})();
