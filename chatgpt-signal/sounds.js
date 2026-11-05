// Общий модуль звуков: подключается в offscreen-документе, в окне
// настроек и на странице ChatGPT (запасной способ воспроизведения).
// Все встроенные звуки синтезируются — файлов и интернета не нужно.
(() => {
  'use strict';
  if (globalThis.MyGptSignalSounds) return;

  // Нота: частота (Гц), начало (с), длительность (с), форма волны, громкость.
  const PRESETS = {
    chime: [
      { f: 784, t: 0, d: 0.22 },
      { f: 1046.5, t: 0.16, d: 0.38 }
    ],
    ding: [
      { f: 1318.5, t: 0, d: 0.9 },
      { f: 2637, t: 0, d: 0.5, gain: 0.25 }
    ],
    soft: [
      { f: 523.25, t: 0, d: 0.35, type: 'triangle' },
      { f: 659.25, t: 0.14, d: 0.35, type: 'triangle' },
      { f: 783.99, t: 0.28, d: 0.55, type: 'triangle' }
    ],
    triple: [
      { f: 1046.5, t: 0, d: 0.12, type: 'square', gain: 0.35 },
      { f: 1046.5, t: 0.16, d: 0.12, type: 'square', gain: 0.35 },
      { f: 1396.9, t: 0.32, d: 0.22, type: 'square', gain: 0.35 }
    ],
    coin: [
      { f: 987.77, t: 0, d: 0.09, type: 'square', gain: 0.3 },
      { f: 1318.5, t: 0.08, d: 0.45, type: 'square', gain: 0.3 }
    ]
  };

  let ctx = null;
  function audioContext() {
    if (!ctx || ctx.state === 'closed') ctx = new AudioContext();
    return ctx;
  }

  function dataUrlToArrayBuffer(dataUrl) {
    const base64 = String(dataUrl).split(',')[1] || '';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  async function playPreset(ac, name, level) {
    const notes = PRESETS[name] || PRESETS.chime;
    // Синтезированным звукам хватает ~40% полной амплитуды.
    const amp = level * 0.4;
    const now = ac.currentTime + 0.03;
    for (const note of notes) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      const start = now + note.t;
      const peak = Math.max(amp * (note.gain ?? 1), 0.0002);
      osc.type = note.type || 'sine';
      osc.frequency.value = note.f;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + note.d);
      osc.connect(gain).connect(ac.destination);
      osc.start(start);
      osc.stop(start + note.d + 0.05);
    }
  }

  async function playData(ac, dataUrl, level) {
    // decodeAudioData вместо <audio src="data:…">: так звук не блокируется
    // политикой безопасности (CSP) страницы ChatGPT.
    const buffer = await ac.decodeAudioData(dataUrlToArrayBuffer(dataUrl));
    const src = ac.createBufferSource();
    const gain = ac.createGain();
    gain.gain.value = level;
    src.buffer = buffer;
    src.connect(gain).connect(ac.destination);
    src.start();
  }

  // sound: имя встроенного звука или 'custom'; volume: 0..100.
  async function play({ sound, volume, dataUrl }) {
    const level = Math.max(0, Math.min(100, Number(volume) || 0)) / 100;
    if (level === 0) return 'muted';
    const ac = audioContext();
    if (ac.state === 'suspended') await ac.resume();
    if (ac.state !== 'running') {
      throw new Error(`браузер не разрешил звук (AudioContext: ${ac.state})`);
    }
    if (sound === 'custom' && dataUrl) {
      await playData(ac, dataUrl, level);
    } else {
      await playPreset(ac, sound, level);
    }
    return 'played';
  }

  globalThis.MyGptSignalSounds = { PRESETS, play };
})();
