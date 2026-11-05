'use strict';

// Все встроенные звуки синтезируются здесь же — без файлов и интернета.
let ctx = null;

function audioContext() {
  if (!ctx || ctx.state === 'closed') ctx = new AudioContext();
  return ctx;
}

// Каждая нота: частота (Гц), начало (с), длительность (с), форма волны.
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

async function playPreset(name, level) {
  const ac = audioContext();
  if (ac.state === 'suspended') await ac.resume();
  const notes = PRESETS[name] || PRESETS.chime;
  const now = ac.currentTime + 0.03;
  let end = now;

  for (const note of notes) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    const start = now + note.t;
    const peak = level * (note.gain ?? 1);
    osc.type = note.type || 'sine';
    osc.frequency.value = note.f;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + note.d);
    osc.connect(gain).connect(ac.destination);
    osc.start(start);
    osc.stop(start + note.d + 0.05);
    end = Math.max(end, start + note.d + 0.05);
  }
  return end - ac.currentTime;
}

async function playFile(dataUrl, level) {
  const audio = new Audio(dataUrl);
  audio.volume = Math.min(1, level);
  await audio.play();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'sound-player' || message.type !== 'PLAY_SOUND') return;

  const level = Math.max(0, Math.min(100, Number(message.volume) || 0)) / 100;
  const job = message.sound === 'custom' && message.dataUrl
    ? playFile(message.dataUrl, level)
    // Синтезированным звукам хватает ~40% полной амплитуды, иначе режут слух.
    : playPreset(message.sound, level * 0.4);

  job.then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: String(error && error.message || error) }));
  return true;
});
