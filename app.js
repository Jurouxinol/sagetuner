'use strict';

/* ---------- Config ---------- */

const TUNINGS = {
  guitar: [
    { name: 'Standard', notes: [40, 45, 50, 55, 59, 64] },
    { name: 'Drop D', notes: [38, 45, 50, 55, 59, 64] },
    { name: 'Half step down', notes: [39, 44, 49, 54, 58, 63] },
    { name: 'DADGAD', notes: [38, 45, 50, 55, 57, 62] },
    { name: 'Open G', notes: [38, 43, 50, 55, 59, 62] },
    { name: 'Open D', notes: [38, 45, 50, 54, 57, 62] },
  ],
  bass: [
    { name: 'Standard', notes: [28, 33, 38, 43] },
    { name: 'Drop D', notes: [26, 33, 38, 43] },
    { name: 'Five string', notes: [23, 28, 33, 38, 43] },
    { name: 'Half step down', notes: [27, 32, 37, 42] },
  ],
  ukulele: [
    { name: 'Standard', notes: [67, 60, 64, 69] },
    { name: 'Low G', notes: [55, 60, 64, 69] },
    { name: 'Baritone', notes: [50, 55, 59, 64] },
  ],
  chromatic: [],
};
const INSTRUMENTS = { guitar: 'Guitar', bass: 'Bass', ukulele: 'Ukulele', chromatic: 'Chromatic' };
const RANGE = { guitar: [60, 1400], bass: [28, 600], ukulele: [120, 1600], chromatic: [28, 2000] };
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const HOLD_MS = 1200;     // a note stays "live" this long after the sound drops

/* ---------- State ---------- */

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : fallback;
}
const saved = (() => {
  try { return JSON.parse(localStorage.getItem('tuner') || '{}'); } catch { return {}; }
})();
const state = {
  mode: TUNINGS[saved.mode] ? saved.mode : 'guitar',
  tuning: { guitar: 0, bass: 0, ukulele: 0, ...(saved.tuning || {}) },
  a4: Number(saved.a4) || 440,
  tol: [3, 5, 8].includes(saved.tol) ? saved.tol : 5,
  awake: saved.awake !== false,
  wantMic: saved.wantMic === true,   // the user turned the mic on and hasn't turned it off
  theme: ['light', 'dark'].includes(saved.theme) ? saved.theme : 'system',
  view: saved.view === 'metronome' ? 'metronome' : 'tuner',
  bpm: clampInt(saved.bpm, 30, 250, 100),
  beats: [2, 3, 4, 5, 6].includes(saved.beats) ? saved.beats : 4,
  listening: false,
  note: null,              // { freq, target, cents }
  lastHeard: 0,
  cents: 0,                // smoothed
  level: 0,
};
function persist() {
  try {
    localStorage.setItem('tuner', JSON.stringify({
      mode: state.mode, tuning: state.tuning, a4: state.a4, tol: state.tol, awake: state.awake, wantMic: state.wantMic, theme: state.theme, view: state.view, bpm: state.bpm, beats: state.beats,
    }));
  } catch {}
}

const $ = (s) => document.querySelector(s);
const el = {
  title: $('#title'), subtitle: $('#subtitle'), instrumentSelect: $('#instrumentSelect'), tuningSelect: $('#tuningSelect'), tuningPick: $('#tuningPick'),
  listen: $('#listenBtn'), listenLabel: $('#listenLabel'), field: $('#field'), focal: $('#focal'),
  note: $('#note'), letter: $('#letter'), oct: $('#oct'), hz: $('#hz'), cents: $('#cents'), status: $('#status'),
  scale: $('#scale'), ticks: $('#ticks'), needle: $('#needle'), stringRow: $('#stringRow'),
  settings: $('#settings'), installBtn: $('#installBtn'), installSetting: $('#installSetting'),
  refHz: $('#refHz'), tolerance: $('#tolerance'), awake: $('#awake'), theme: $('#theme'),
  viewBtn: $('#viewBtn'), play: $('#playBtn'), bpm: $('#bpm'), bpmSlider: $('#bpmSlider'), tempoName: $('#tempoName'),
  beatDots: $('#beatDots'), beatsSeg: $('#beatsSeg'),
};

const currentTuning = () => TUNINGS[state.mode][state.tuning[state.mode]];
const strings = () => (state.mode === 'chromatic' ? null : currentTuning().notes);
const midiToHz = (m) => state.a4 * 2 ** ((m - 69) / 12);
const pc = (m) => NAMES[((m % 12) + 12) % 12];
const octave = (m) => Math.floor(m / 12) - 1;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

/* ---------- Pitch detection (McLeod Pitch Method) ---------- */

let dec = new Float32Array(2048), nsdf = new Float32Array(2048);

function detectPitch(buf, sampleRate, minHz, maxHz, gate = 0.006) {
  // Decimate by 2 — plenty of resolution for instruments, 4x less work.
  const n = buf.length >> 1;
  if (dec.length !== n) { dec = new Float32Array(n); nsdf = new Float32Array(n); }
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = (buf[2 * i] + buf[2 * i + 1]) * 0.5;
    dec[i] = v; sum += v * v;
  }
  const rms = Math.sqrt(sum / n);
  if (rms < gate) return { rms, freq: 0 };

  const sr = sampleRate / 2;
  const tauMin = Math.max(2, Math.floor(sr / maxHz));
  const tauMax = Math.min(Math.ceil(sr / minHz), n >> 1);
  const W = n - tauMax;

  for (let tau = 0; tau <= tauMax; tau++) {
    let acf = 0, m = 0;
    for (let i = 0; i < W; i++) {
      const a = dec[i], b = dec[i + tau];
      acf += a * b; m += a * a + b * b;
    }
    nsdf[tau] = m > 0 ? (2 * acf) / m : 0;
  }

  // Max of each positive lobe after the first negative dip
  const peaks = [];
  let tau = 1;
  while (tau < tauMax && nsdf[tau] > 0) tau++;
  let best = -1, bestTau = 0;
  for (; tau < tauMax; tau++) {
    if (nsdf[tau] > 0) {
      if (nsdf[tau] > best) { best = nsdf[tau]; bestTau = tau; }
    } else if (best > 0) {
      peaks.push(bestTau); best = -1;
    }
  }
  if (best > 0) peaks.push(bestTau);
  if (!peaks.length) return { rms, freq: 0 };

  let max = 0;
  for (const p of peaks) if (nsdf[p] > max) max = nsdf[p];
  const pick = peaks.find((p) => p >= tauMin && nsdf[p] >= 0.9 * max);
  if (!pick || nsdf[pick] < 0.6) return { rms, freq: 0 };

  const a = nsdf[pick - 1], b = nsdf[pick], c = nsdf[pick + 1];
  const den = a - 2 * b + c;
  const shift = den ? (a - c) / (2 * den) : 0;
  return { rms, freq: sr / (pick + shift), clarity: b };
}

/* ---------- Audio ---------- */

let ac = null, stream = null, analyser = null, source = null, timeBuf = null, wakeLock = null;
const recent = [];

function ensureContext() {
  if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
  return ac;
}
function setAudioSession(type) {
  try { if (navigator.audioSession) navigator.audioSession.type = type; } catch {}
}

let starting = false;
async function start() {
  if (starting || state.listening) return;
  starting = true;
  // Opening the mic takes a moment (and longer with a permission prompt): show it
  el.listen.classList.add('busy');
  el.listen.setAttribute('aria-busy', 'true');
  el.listenLabel.textContent = 'starting…';
  showHint('starting the microphone…');
  try { await openMic(); } finally {
    starting = false;
    el.listen.classList.remove('busy');
    el.listen.removeAttribute('aria-busy');
    if (!state.listening) el.listenLabel.textContent = 'mic off';
    if (hint === 'starting the microphone…') showHint(null);
  }
}

function setWantMic(on) {
  state.wantMic = on;
  lastReading = '';
  persist();
}

// iOS keeps audio suspended until a touch when the mic starts on its own (on launch or
// on return from the background), so resume on the first tap anywhere.
function resumeAudioOnTouch() {
  if (!ac || ac.state === 'running') return;
  const go = () => { ac.resume().catch(() => {}); };
  document.addEventListener('pointerdown', go, { once: true, capture: true });
}

// iOS can hand a reused AudioContext back silent after an interruption (leaving the app)
// or after the metronome switched the audio session to playback, so every mic session
// gets a new one, created once the session is in record mode.
function freshContext() {
  if (ac && ac.state !== 'closed') ac.close().catch(() => {});
  ac = new (window.AudioContext || window.webkitAudioContext)();
  return ac;
}

async function openMic() {
  if (!navigator.mediaDevices?.getUserMedia) return showHint('The microphone needs a secure (https) connection.');
  setAudioSession('play-and-record');
  // Create it now, while the tap still counts as a user gesture (a permission prompt can use it up)
  freshContext();
  ac.resume().catch(() => {});
  const asked = performance.now();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
    setAudioSession('playback');
    if (e.name !== 'NotAllowedError') return showHint('Couldn’t open the microphone.');
    setWantMic(false);
    // A dismissed prompt isn't permanent (Safari just asks again), so only send people to
    // settings when the browser refused without asking: an instant rejection or a "denied" state.
    const instant = performance.now() - asked < 400;
    const denied = await navigator.permissions?.query({ name: 'microphone' })
      .then((p) => p.state === 'denied').catch(() => false);
    return showHint(instant || denied ? micBlockedHint() : 'Microphone access was declined — tap the gradient to try again.');
  }
  // iOS may end the stream itself (a call, Siri, another app taking the mic): start over
  stream.getAudioTracks()[0]?.addEventListener('ended', () => {
    if (state.listening && !document.hidden) restartMic();
  });
  // Don't wait on resume: without a recent tap it may never settle
  ac.resume().catch(() => {});
  setTimeout(resumeAudioOnTouch, 300);
  source = ac.createMediaStreamSource(stream);
  analyser = ac.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  timeBuf = new Float32Array(analyser.fftSize);

  state.listening = true;
  state.note = null;
  recent.length = 0;
  el.listen.setAttribute('aria-pressed', 'true');
  el.listenLabel.textContent = 'mic on';
  el.field.setAttribute('aria-label', 'Stop listening');
  hint = null;
  input.deadSince = null;
  setWantMic(true);
  syncWakeLock();
}

async function restartMic() {
  stop();
  await start();
}

// Watchdog: a working mic always carries a little noise, so input that is exactly silent
// (or an audio engine that isn't running) means the mic is dead even though it looks on.
// Try waking it, then restart it; if iOS wants a tap first, ask for one.
const WAKE_HINT = 'Tap anywhere to wake the microphone.';
const input = { deadSince: null, lastRestart: -Infinity };
function checkInput(now, rms) {
  const dead = rms === 0 || ac.state !== 'running';
  if (!dead) {
    input.deadSince = null;
    if (hint === WAKE_HINT) showHint(null);
    return;
  }
  if (input.deadSince === null) {
    input.deadSince = now;
    ac.resume().catch(() => {});
    return;
  }
  if (now - input.deadSince < 2500) return;
  input.deadSince = now;
  if (ac.state !== 'running') {
    if (hint !== WAKE_HINT) showHint(WAKE_HINT);
    resumeAudioOnTouch();
  } else if (now - input.lastRestart > 8000) {
    input.lastRestart = now;
    restartMic();
  }
}

// Hold the screen on only while listening with the setting on. The system drops the
// lock whenever the page is hidden, so the release handler just forgets it.
async function syncWakeLock() {
  const want = (state.listening || metro.playing) && state.awake;
  if (want && !wakeLock && navigator.wakeLock) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch {}
  } else if (!want && wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

function stop() {
  stream?.getTracks().forEach((t) => t.stop());
  source?.disconnect();
  stream = source = analyser = null;
  state.listening = false;
  state.note = null;
  state.level = 0;
  el.listen.setAttribute('aria-pressed', 'false');
  el.listenLabel.textContent = 'mic off';
  el.field.setAttribute('aria-label', 'Start listening');
  syncWakeLock();
  setAudioSession('playback');
}

let hint = null;
function showHint(msg) { hint = msg; lastReading = ''; }

function playTone(m, btn) {
  const ctx = ensureContext();
  if (!state.listening) setAudioSession('playback');
  ctx.resume();
  const f = midiToHz(m);
  const t = ctx.currentTime;
  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, t);
  out.gain.exponentialRampToValueAtTime(0.32, t + 0.012);
  out.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
  out.connect(ctx.destination);
  [[f, 'triangle', 1], [f * 2, 'sine', 0.25], [f * 3, 'sine', 0.08]].forEach(([freq, type, g]) => {
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.type = type; o.frequency.value = freq; og.gain.value = g;
    o.connect(og).connect(out);
    o.start(t); o.stop(t + 2.5);
  });
  if (btn) {
    btn.classList.add('playing');
    setTimeout(() => btn.classList.remove('playing'), 2000);
  }
}

/* ---------- Analysis ---------- */

// The volume gate follows the room: it sits a little above the background noise measured
// between notes. Thin strings (high E) are quiet and fade fast, so a fixed gate cut them off.
const room = { floor: 0.001 };

function analyse(now) {
  analyser.getFloatTimeDomainData(timeBuf);
  const [minHz, maxHz] = RANGE[state.mode];
  const gate = clamp(room.floor * 2.5, 0.0008, 0.02);
  const r = detectPitch(timeBuf, ac.sampleRate, minHz, maxHz, gate);
  checkInput(now, r.rms);
  state.level += (Math.min(1, r.rms * 9) - state.level) * 0.3;
  if (!r.freq || r.clarity < 0.8) {
    room.floor += (r.rms - room.floor) * 0.02;   // only learn the floor while no note is sounding
    return;
  }

  recent.push(r.freq);
  if (recent.length > 5) recent.shift();
  const sorted = [...recent].sort((a, b) => a - b);
  // Chords and strums make the reading jump around; wait until it holds steady
  const spread = 1200 * Math.log2(sorted[sorted.length - 1] / sorted[0]);
  if (recent.length < 3 || spread > 35) return;
  let freq = sorted[sorted.length >> 1];
  let midi = 69 + 12 * Math.log2(freq / state.a4);
  const s = strings();
  // A reading exactly an octave off a string (a strong overtone or a weak fundamental) is
  // that string; fold it back rather than discarding it
  if (s) {
    const away = (m) => Math.min(...s.map((x) => Math.abs(x - m)));
    if (away(midi) > 3) {
      for (const k of [-12, 12]) {
        if (away(midi + k) <= 1) { midi += k; freq *= 2 ** (k / 12); break; }
      }
    }
  }
  const target = s
    ? s.reduce((a, b) => (Math.abs(b - midi) < Math.abs(a - midi) ? b : a))
    : Math.round(midi);
  // Overtones and room noise can land far outside the instrument; don't force them onto a string
  if (s && Math.abs(midi - target) > 3) return;

  const cents = (midi - target) * 100;
  if (!state.note || state.note.target !== target) state.cents = cents;
  state.note = { freq, target, cents };
  state.lastHeard = now;
}

/* ---------- Field & scale ---------- */

// Dusty colour fields. Each one is placed from the sprung pitch value:
//   fx   focal x in px (the glow sits here)
//   s    lean, -1 flat … +1 sharp (saturates around ±20 cents)
//   k    centredness, 1 when balanced, 0 when leaning hard
// Flat pushes the glow left with charcoal filling the right; sharp mirrors it; in tune
// is a symmetric arch: green centre, coral at both lower edges, charcoal in the corners.
const BLOBS = [
  ['.blob.halo', 0.95, 1.0, (fx, s, k, w) => [fx, 0.5, 0.9]],
  ['.blob.ember-l', 0.78, 0.62, (fx, s, k, w) => [0.06 * w, 0.58, 0.6 + 0.4 * k]],
  ['.blob.ember-r', 0.78, 0.62, (fx, s, k, w) => [0.94 * w, 0.58, 0.6 + 0.4 * k]],
  ['.blob.dark-b', 1.2, 0.5, (fx, s, k, w) => [0.5 * w, 1.04, 0.55 + 0.35 * k]],
  ['.blob.dark-l', 0.72, 0.95, (fx, s, k, w) => [(0.0 + 0.16 * Math.max(0, s)) * w, 0.04 + 0.3 * Math.max(0, s), clamp(0.6 + 0.4 * s, 0.05, 1)]],
  ['.blob.dark-r', 0.72, 0.95, (fx, s, k, w) => [(1.0 - 0.16 * Math.max(0, -s)) * w, 0.04 + 0.3 * Math.max(0, -s), clamp(0.6 - 0.4 * s, 0.05, 1)]],
  ['.blob.glow', 0.56, 0.82, (fx, s, k, w) => [fx, 0.5, 1]],
].map(([sel, w, h, place], i) => ({ el: el.field.querySelector(sel), w, h, place, ph: i * 1.7, f: 0.45 + i * 0.09 }));
const glowEl = el.field.querySelector('.blob.glow');

// Glow colour by distance from the target: sage green → warm peach → coral red
const GREEN = [156, 206, 174], PEACH = [240, 166, 132], CORAL = [242, 88, 76], NEUTRAL = [232, 206, 186];
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
function glowColour(cents, presence) {
  const d = Math.abs(cents);
  const col = mix(mix(GREEN, PEACH, smooth(3, 9, d)), CORAL, smooth(8, 20, d));
  return mix(NEUTRAL, col, presence).map(Math.round).join(', ');
}

const fieldSize = { w: 0, h: 0 };
function resize() {
  const { width: w, height: h } = el.field.getBoundingClientRect();
  Object.assign(fieldSize, { w, h });
  for (const b of BLOBS) {
    b.el.style.width = `${b.w * w}px`;
    b.el.style.height = `${b.h * h}px`;
  }
}

(function buildTicks() {
  for (let i = 0; i <= 20; i++) {   // every 5 cents
    const s = document.createElement('span');
    if (i === 10) s.className = 'zero';
    else if (i % 5 === 0) s.className = 'major';
    el.ticks.append(s);
  }
})();

let stringKey = '';
function renderStrings(centre) {
  const s = strings();
  const notes = s || [centre - 1, centre, centre + 1];
  const key = notes.join(',');
  if (key === stringKey) return;
  stringKey = key;
  el.stringRow.innerHTML = '';
  notes.forEach((m) => {
    const b = document.createElement('button');
    b.dataset.m = m;
    b.textContent = pc(m);
    b.setAttribute('aria-label', `Play ${pc(m)}${octave(m)}`);
    b.onclick = () => playTone(m, b);
    el.stringRow.append(b);
  });
}

/* ---------- Frame ---------- */

// One sprung value drives both the field and the needle, so they never disagree.
// A soft spring with a touch of overshoot reads like an analog meter.
const meter = { p: 0, v: 0, amp: 0.03, presence: 0 };
let lastT = 0;
function draw(now) {
  const t = now / 1000;
  const steps = clamp(Math.round((lastT ? t - lastT : 0.016) * 60), 1, 4);
  lastT = t;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const live = state.note && now - state.lastHeard < HOLD_MS;
  if (live) state.cents += (state.note.cents - state.cents) * 0.25;
  const c = state.cents;
  const inTune = live && Math.abs(c) <= state.tol;

  const target = live ? clamp(c / 50, -1, 1) : Math.sin(t * 0.35) * 0.06;
  if (reduce) { meter.p = target; meter.v = 0; } else {
    for (let i = 0; i < steps; i++) { meter.v = meter.v * 0.8 + (target - meter.p) * 0.06; meter.p += meter.v; }
  }
  // Calm when in tune, restless the further off it is, a slow breath when idle
  const amp = !live ? 0.035 : inTune ? 0.012 : 0.03 + 0.07 * clamp(Math.abs(c) / 50, 0, 1);
  meter.amp = lerp(meter.amp, reduce ? 0 : amp, 0.05);
  meter.presence = lerp(meter.presence, live ? 1 : 0, 0.05);

  const { w, h } = fieldSize;
  const fx = w * (0.05 + 0.9 * (meter.p + 1) / 2);
  const lean = clamp(meter.p * 2.5, -1, 1);
  const centred = 1 - Math.abs(lean);
  for (const b of BLOBS) {
    const [cx, cy, op] = b.place(fx, lean, centred, w);
    const sc = 1 + Math.sin(t * b.f + b.ph) * meter.amp * 1.6;
    const wy = Math.cos(t * b.f * 0.8 + b.ph) * meter.amp * h * 0.5;
    const wx = Math.sin(t * b.f * 0.6 + b.ph * 2) * meter.amp * w * 0.25;
    const x = cx + wx - (b.w * w) / 2;
    const y = cy * h + wy - (b.h * h) / 2;
    b.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${sc.toFixed(3)})`;
    b.el.style.opacity = op.toFixed(3);
  }
  glowEl.style.setProperty("--c", glowColour(meter.p * 50, meter.presence));
  el.focal.style.transform = `translateX(${fx.toFixed(1)}px)`;
  el.needle.style.transform = `translateX(${(((meter.p + 1) / 2) * el.ticks.clientWidth).toFixed(1)}px)`;

  updateReading(live, inTune, c);
}

/* ---------- Reading ---------- */

let lastReading = '';
function updateReading(live, inTune, c) {
  const rc = Math.round(c);
  const note = state.note;
  const key = `${live}|${inTune}|${rc}|${note?.target}|${note?.freq.toFixed(1)}|${state.listening}|${hint}|${state.mode}`;
  if (key === lastReading) return;
  lastReading = key;

  const s = strings();
  el.field.classList.toggle('idle', !live);
  el.field.classList.toggle('tuned', !!inTune);
  el.scale.classList.toggle('live', !!live);
  el.scale.classList.toggle('ok', !!inTune);
  el.note.classList.toggle('held', !!note && !live);
  el.note.classList.toggle('idle', !note);

  if (note) {
    el.letter.textContent = pc(note.target);
    el.oct.textContent = octave(note.target);
    el.hz.textContent = `${note.freq.toFixed(1)} Hz`;
  } else {
    el.letter.textContent = s ? pc(s[0]) : 'A';
    el.oct.textContent = '';
    el.hz.textContent = '— Hz';
  }

  el.cents.textContent = live ? `${rc > 0 ? '+' : rc < 0 ? '−' : ''}${Math.abs(rc)}¢` : '—';
  el.cents.classList.toggle('dim', !live);
  el.cents.classList.toggle('ok', !!inTune);
  el.status.textContent = hint || (live
    ? (inTune ? 'in tune' : rc < 0 ? 'tune up' : 'tune down')
    : state.listening ? (s ? 'play a string' : 'play a note')
    : state.wantMic ? 'tap to turn the mic back on' : 'tap the gradient to listen');
  el.status.classList.toggle('ok', !!inTune);

  renderStrings(note ? note.target : 69);
  for (const b of el.stringRow.children) {
    const on = !!live && Number(b.dataset.m) === note.target;
    b.classList.toggle('on', on && !inTune);
    b.classList.toggle('ok', on && !!inTune);
  }
}

/* ---------- Settings ---------- */

function renderHeader() {
  el.title.textContent = INSTRUMENTS[state.mode].toLowerCase();
  const list = TUNINGS[state.mode];
  el.tuningPick.hidden = !list.length;
  if (list.length) {
    const tn = currentTuning();
    el.subtitle.textContent = tn.name === 'Standard' ? `standard ${pc(tn.notes[0]).toLowerCase()}` : tn.name.toLowerCase();
  }
  // Native <select>s open the phone's own picker
  el.instrumentSelect.innerHTML = Object.entries(INSTRUMENTS)
    .map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
  el.instrumentSelect.value = state.mode;
  el.tuningSelect.innerHTML = list
    .map((tn, i) => `<option value="${i}">${tn.name} · ${tn.notes.map(pc).join(' ')}</option>`).join('');
  el.tuningSelect.value = String(state.tuning[state.mode] ?? 0);
  lastReading = '';
}

function options(container, items, isOn, onPick, big) {
  container.innerHTML = '';
  container.classList.toggle('big', !!big);
  items.forEach((item) => {
    const b = document.createElement('button');
    b.textContent = item.label;
    b.classList.toggle('on', isOn(item));
    b.onclick = () => onPick(item, b);
    container.append(b);
  });
}

function renderSettings() {
  el.refHz.textContent = state.a4;

  options(el.tolerance, [3, 5, 8].map((v) => ({ v, label: `±${v}¢` })),
    (o) => o.v === state.tol,
    (o) => { state.tol = o.v; persist(); renderSettings(); });

  options(el.awake, [{ v: true, label: 'On' }, { v: false, label: 'Off' }],
    (o) => o.v === state.awake,
    (o) => { state.awake = o.v; persist(); syncWakeLock(); renderSettings(); });

  options(el.theme, [{ v: 'system', label: 'System' }, { v: 'light', label: 'Light' }, { v: 'dark', label: 'Dark' }],
    (o) => o.v === state.theme,
    (o) => { state.theme = o.v; persist(); applyTheme(); renderSettings(); });
}

// "system" leaves it to prefers-color-scheme; light/dark pin it via data-theme.
// The browser chrome colour (theme-color) follows whichever is showing.
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const root = document.documentElement;
  if (state.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = state.theme;
  $('#themeColor').content = getComputedStyle(root).getPropertyValue('--panel').trim();
}
darkQuery.addEventListener?.('change', applyTheme);

function setMode(mode) {
  state.mode = mode;
  state.note = null;
  recent.length = 0;
  lastReading = '';
  renderHeader();
  persist();
}

function setA4(hz) {
  state.a4 = clamp(hz, 400, 480);
  recent.length = 0;
  persist();
  renderHeader();
  renderSettings();
}

function openSettings() {
  renderSettings();
  el.settings.hidden = false;
  requestAnimationFrame(() => el.settings.classList.add('open'));
}
function closeSettings() {
  el.settings.classList.remove('open');
  setTimeout(() => { el.settings.hidden = true; }, 350);
}

/* ---------- Analytics ---------- */

// Umami Cloud website ID (cookieless, no personal data). Empty keeps analytics off
// entirely: no script is loaded and track() does nothing. Audio never leaves the device.
const ANALYTICS_ID = '';
const pending = [];
function track(name, data) {
  if (!ANALYTICS_ID) return;
  if (!window.umami) { pending.push([name, data]); return; }
  try { window.umami.track(name, data); } catch {}
}
if (ANALYTICS_ID) {
  const s = document.createElement('script');
  s.defer = true;
  s.src = 'https://cloud.umami.is/script.js';
  s.dataset.websiteId = ANALYTICS_ID;
  s.onload = () => pending.splice(0).forEach(([n, d]) => track(n, d));
  document.head.append(s);
}

/* ---------- Install ---------- */

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// Which browser is this? Install steps and mic help differ per browser, and in-app
// browsers (Instagram, Facebook, TikTok…) can't install or reliably use the mic at all.
const UA = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(UA);
const BROWSER = (() => {
  if (/FBAN|FBAV|FB_IAB|Instagram|Line\/|TikTok|musical_ly|Bytedance|Snapchat|LinkedInApp|Twitter|Pinterest|GSA\//.test(UA)
    || (isAndroid && /; wv\)/.test(UA))) return 'inapp';
  if (isIOS) return /CriOS/.test(UA) ? 'chrome' : /FxiOS/.test(UA) ? 'firefox' : /EdgiOS/.test(UA) ? 'edge' : 'safari';
  if (/Firefox/.test(UA)) return 'firefox';
  if (/EdgA?\//.test(UA)) return 'edge';
  if (/SamsungBrowser/.test(UA)) return 'samsung';
  if (/Chrome/.test(UA)) return 'chrome';
  return 'other';
})();

const SHARE = '<svg class="share" viewBox="0 0 24 24" aria-label="Share"><path d="M12 3v12M8 7l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 11H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const DOTS = '<span class="glyph" aria-label="menu">•••</span>';
const KEBAB = '<span class="glyph" aria-label="menu">⋮</span>';
const ADD = ['Choose <b>Add to Home Screen</b>', 'Tap <b>Add</b>'];

// Step lists per browser, shown in the install sheet
const INSTALL_GUIDES = {
  'ios-safari': [`Tap <b>Share</b> ${SHARE}<small>On iOS 26 it’s inside ${DOTS} in the browser bar</small>`, ...ADD],
  'ios-chrome': [`Tap <b>Share</b> ${SHARE} in the address bar<small>Or ${DOTS} → <b>Share</b></small>`, ...ADD],
  'ios-edge': [`Tap ${DOTS} at the bottom, then <b>Share</b> ${SHARE}`, ...ADD],
  'ios-firefox': [`Tap the menu <span class="glyph">☰</span>, then <b>Share</b> ${SHARE}`, ...ADD],
  'android-firefox': [`Tap ${KEBAB} in the toolbar`, 'Choose <b>Add app to Home screen</b> (or <b>Install</b>)', 'Tap <b>Add</b>'],
  'android-other': [`Tap ${KEBAB} in the browser menu`, 'Choose <b>Install app</b> or <b>Add to Home screen</b>', 'Confirm with <b>Install</b>'],
};
const INAPP_GUIDE = isIOS
  ? [`Tap ${DOTS} (top right)`, 'Choose <b>Open in Safari</b> or <b>Open in browser</b>', 'Add it to your home screen from there']
  : [`Tap ${KEBAB} (top right)`, 'Choose <b>Open in Chrome</b> or <b>Open in browser</b>', 'Add it to your home screen from there'];

function installGuide() {
  if (BROWSER === 'inapp') return 'inapp';
  if (isIOS) return `ios-${BROWSER}`;
  if (isAndroid) return BROWSER === 'firefox' ? 'android-firefox' : 'android-other';
  return null;   // desktop: only Chrome/Edge's own prompt
}

// Where to re-enable a blocked microphone, in this browser's words
function micBlockedHint() {
  if (BROWSER === 'inapp') return 'The mic doesn’t work in this in-app browser — open the page in your browser.';
  if (isIOS) {
    return BROWSER === 'safari'
      ? 'Microphone blocked — tap aA (or •••) › Website Settings › Microphone › Allow.'
      : `Microphone blocked — open the Settings app › ${{ chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox' }[BROWSER]} › Microphone.`;
  }
  if (BROWSER === 'firefox') return 'Microphone blocked — tap the lock in the address bar › Microphone › Allow.';
  if (isAndroid) return 'Microphone blocked — tap the icon left of the address › Permissions › Microphone.';
  return 'Microphone blocked — click the icon next to the address and allow the microphone.';
}

let installPrompt = null;   // Chrome/Edge/Samsung's deferred beforeinstallprompt event
const canInstall = () => !isStandalone() && (!!installPrompt || (!!installGuide() && matchMedia('(pointer: coarse)').matches));

function refreshInstall() {
  const show = canInstall();
  const wasHidden = el.installBtn.hidden;
  el.installBtn.hidden = !show;
  el.installSetting.hidden = !show;
  if (show && wasHidden) track('install-button-shown', { browser: BROWSER });
}

// Bottom drawers follow the finger and close on a pull or a flick, like native sheets.
// Dragging only starts from the top of the content so inner scrolling still works.
function makeDraggable(overlay, close) {
  const sheet = overlay.querySelector('.sheet');
  let startY = 0, dy = 0, t0 = 0, tracking = false, dragging = false;
  const end = () => {
    if (!dragging) { tracking = false; return; }
    const velocity = dy / Math.max(1, performance.now() - t0);
    sheet.style.transition = '';
    if (dy > Math.min(140, sheet.offsetHeight * 0.3) || velocity > 0.6) {
      sheet.style.transform = 'translateY(100%)';
      close();
      setTimeout(() => { sheet.style.transform = ''; }, 400);
    } else {
      sheet.style.transform = '';
    }
    tracking = dragging = false;
  };
  sheet.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    tracking = sheet.scrollTop <= 0;
    dragging = false;
    startY = e.touches[0].clientY;
    t0 = performance.now();
    dy = 0;
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    dy = e.touches[0].clientY - startY;
    if (!dragging) {
      if (dy < -6) { tracking = false; return; }   // scrolling up: leave it to the browser
      if (dy < 6) return;
      dragging = true;
      sheet.style.transition = 'none';
    }
    e.preventDefault();
    sheet.style.transform = `translateY(${Math.max(0, dy)}px)`;
  }, { passive: false });
  sheet.addEventListener('touchend', end);
  sheet.addEventListener('touchcancel', end);
}

function openSheet(sheet) {
  sheet.hidden = false;
  requestAnimationFrame(() => sheet.classList.add('open'));
}
function closeSheet(sheet) {
  sheet.classList.remove('open');
  setTimeout(() => { sheet.hidden = true; }, 350);
}

function showInstallGuide(key) {
  const inapp = key === 'inapp';
  $('#installTitle').textContent = inapp ? 'Open in your browser' : 'Add to home screen';
  $('#installSub').textContent = inapp
    ? 'This app’s built-in browser can’t install the tuner or use the mic reliably.'
    : 'Opens full screen, works offline.';
  $('#installSteps').innerHTML = (inapp ? INAPP_GUIDE : INSTALL_GUIDES[key])
    .map((step, i) => `<li><span>${i + 1}</span><p>${step}</p></li>`).join('');
  openSheet($('#installSheet'));
  track('install-instructions-shown', { guide: key });
}

async function addToHomeScreen(source) {
  track('install-tap', { source, browser: BROWSER });
  if (installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => ({}));
    installPrompt = null;
    refreshInstall();
  } else if (installGuide()) {
    showInstallGuide(installGuide());
  }
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  refreshInstall();
});
window.addEventListener('appinstalled', () => {
  track('installed', { browser: BROWSER });
  installPrompt = null;
  refreshInstall();
});
el.installBtn.addEventListener('click', () => addToHomeScreen('dock'));
el.installSetting.addEventListener('click', () => { closeSettings(); setTimeout(() => addToHomeScreen('settings'), 250); });
$('#installDone').addEventListener('click', () => closeSheet($('#installSheet')));
$('#installSheet').addEventListener('click', (e) => { if (e.target.id === 'installSheet') closeSheet($('#installSheet')); });

makeDraggable(el.settings, closeSettings);
makeDraggable($('#installSheet'), () => closeSheet($('#installSheet')));

track('open', { mode: isStandalone() ? 'standalone' : 'browser', browser: BROWSER });
refreshInstall();
// In-app browsers: say so right away, since nothing else will work well there
if (BROWSER === 'inapp') setTimeout(() => showInstallGuide('inapp'), 800);

/* ---------- Metronome ---------- */

// Clicks are scheduled slightly ahead on the audio clock (a short timer tops up the
// queue), so timing stays tight even when the main thread stutters. The beat dots are
// drawn from the same schedule in the animation frame.
const metro = { playing: false, next: 0, beat: 0, timer: 0, queue: [], taps: [] };
const LOOKAHEAD = 0.12;   // seconds of clicks scheduled in advance
const TEMPO_NAMES = [[45, 'grave'], [60, 'largo'], [66, 'larghetto'], [76, 'adagio'], [108, 'andante'],
  [120, 'moderato'], [156, 'allegro'], [176, 'vivace'], [200, 'presto'], [Infinity, 'prestissimo']];

function click(time, accent) {
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = 'triangle';
  o.frequency.value = accent ? 1760 : 1175;
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(accent ? 0.9 : 0.55, time + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.06);
  o.connect(g).connect(ac.destination);
  o.start(time);
  o.stop(time + 0.07);
}

function schedule() {
  // After a suspension (screen locked, app switched) skip ahead instead of firing a burst
  if (metro.next < ac.currentTime - 0.1) { metro.next = ac.currentTime + 0.05; metro.queue = []; }
  while (metro.next < ac.currentTime + LOOKAHEAD) {
    click(metro.next, metro.beat === 0);
    metro.queue.push({ beat: metro.beat, time: metro.next });
    metro.next += 60 / state.bpm;
    metro.beat = (metro.beat + 1) % state.beats;
  }
}

function startMetronome() {
  ensureContext();
  setAudioSession('playback');   // iOS: play through the silent switch
  ac.resume();
  metro.playing = true;
  metro.beat = 0;
  metro.queue = [];
  metro.next = ac.currentTime + 0.06;
  schedule();
  metro.timer = setInterval(schedule, 25);
  el.play.setAttribute('aria-pressed', 'true');
  el.play.setAttribute('aria-label', 'Stop metronome');
  syncWakeLock();
  track('metronome-start', { bpm: state.bpm, beats: state.beats });
}

function stopMetronome() {
  clearInterval(metro.timer);
  metro.playing = false;
  metro.queue = [];
  for (const d of el.beatDots.children) d.classList.remove('hit');
  el.play.setAttribute('aria-pressed', 'false');
  el.play.setAttribute('aria-label', 'Start metronome');
  syncWakeLock();
}

function drawMetronome() {
  if (!metro.playing) return;
  let hit = null;
  while (metro.queue.length && metro.queue[0].time <= ac.currentTime) hit = metro.queue.shift();
  if (!hit) return;
  [...el.beatDots.children].forEach((d, i) => d.classList.toggle('hit', i === hit.beat));
  // Let the dot fade back out shortly after the click
  clearTimeout(drawMetronome.fade);
  drawMetronome.fade = setTimeout(() => el.beatDots.children[hit.beat]?.classList.remove('hit'), 120);
}

function setBpm(bpm) {
  state.bpm = clamp(Math.round(bpm), 30, 250);
  el.bpm.textContent = state.bpm;
  el.bpmSlider.value = state.bpm;
  el.tempoName.textContent = TEMPO_NAMES.find(([max]) => state.bpm < max)[1];
  persist();
}

function renderBeats() {
  el.beatDots.innerHTML = Array.from({ length: state.beats }, (_, i) => `<i class="${i ? '' : 'accent'}"></i>`).join('');
  options(el.beatsSeg, [2, 3, 4, 5, 6].map((v) => ({ v, label: String(v) })),
    (o) => o.v === state.beats,
    (o) => { state.beats = o.v; metro.beat %= o.v; persist(); renderBeats(); });
}

// Tap tempo: average the last few intervals; a pause of 2s starts over
function tapTempo() {
  const now = performance.now();
  if (metro.taps.length && now - metro.taps[metro.taps.length - 1] > 2000) metro.taps = [];
  metro.taps.push(now);
  if (metro.taps.length > 5) metro.taps.shift();
  if (metro.taps.length < 2) return;
  const gaps = metro.taps.slice(1).map((t, i) => t - metro.taps[i]);
  setBpm(60000 / (gaps.reduce((a, b) => a + b) / gaps.length));
}

// −/+ step once on press and repeat while held
function holdToRepeat(btn, delta) {
  let timer = 0;
  const stopRepeat = () => clearTimeout(timer);
  btn.addEventListener('pointerdown', () => {
    setBpm(state.bpm + delta);
    const go = (wait) => { timer = setTimeout(() => { setBpm(state.bpm + delta); go(60); }, wait); };
    go(400);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, stopRepeat));
}

/* ---------- Views ---------- */

// Tuner and metronome share the screen. The mic pauses in metronome mode (it would hear
// the clicks) and comes back on return if the user had it on.
function setView(view) {
  state.view = view;
  document.documentElement.dataset.view = view;
  el.viewBtn.setAttribute('aria-label', view === 'metronome' ? 'Back to tuner' : 'Metronome');
  persist();
  if (view === 'metronome') {
    if (state.listening) stop();
  } else {
    if (metro.playing) stopMetronome();
    if (state.wantMic) start();
  }
}

/* ---------- Loop & wiring ---------- */

function frame(now) {
  if (state.listening && analyser) analyse(now);
  drawMetronome();
  draw(now);
  requestAnimationFrame(frame);
}

// A tap on the mic or the gradient is an explicit choice, so it is remembered
const toggle = () => {
  if (state.listening) { stop(); setWantMic(false); } else start();
};
el.listen.addEventListener('click', toggle);
el.field.addEventListener('click', toggle);
$('#openSettings').addEventListener('click', openSettings);
el.instrumentSelect.addEventListener('change', () => setMode(el.instrumentSelect.value));
el.tuningSelect.addEventListener('change', () => {
  state.tuning[state.mode] = Number(el.tuningSelect.value);
  recent.length = 0;
  persist();
  renderHeader();
});
$('#closeSettings').addEventListener('click', closeSettings);
el.settings.addEventListener('click', (e) => { if (e.target === el.settings) closeSettings(); });
document.querySelectorAll('.step').forEach((b) => b.addEventListener('click', () => setA4(state.a4 + Number(b.dataset.step))));
$('#refReset').addEventListener('click', () => setA4(440));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!el.settings.hidden) closeSettings();
  if (!$('#installSheet').hidden) closeSheet($('#installSheet'));
});

// Release the mic when the app is backgrounded (iOS suspends it anyway)
// The mic is released while the app is in the background (iOS suspends it anyway) and
// comes straight back when it returns, if the user had it on.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (state.listening) stop(); } else if (state.wantMic && state.view === 'tuner') restartMic();
});
// Coming back through the back/forward cache skips visibilitychange on some browsers
window.addEventListener('pageshow', (e) => {
  if (e.persisted && state.wantMic && state.view === 'tuner') restartMic();
});

new ResizeObserver(resize).observe(el.field);
applyTheme();
el.viewBtn.addEventListener('click', () => setView(state.view === 'metronome' ? 'tuner' : 'metronome'));
el.play.addEventListener('click', () => (metro.playing ? stopMetronome() : startMetronome()));
$('#tapBtn').addEventListener('pointerdown', tapTempo);
el.bpmSlider.addEventListener('input', () => setBpm(Number(el.bpmSlider.value)));
holdToRepeat($('#bpmDown'), -1);
holdToRepeat($('#bpmUp'), 1);
setBpm(state.bpm);
renderBeats();
document.documentElement.dataset.view = state.view;
el.viewBtn.setAttribute('aria-label', state.view === 'metronome' ? 'Back to tuner' : 'Metronome');
setMode(state.mode);
if (state.wantMic && state.view === 'tuner') {
  // Only open it silently when the browser already has permission; otherwise wait
  // for any tap so a permission prompt never appears out of nowhere.
  const onTap = (e) => {
    if (state.listening || !state.wantMic || state.view !== 'tuner') { document.removeEventListener('pointerdown', onTap); return; }
    // Controls do their own thing (the mic and gradient already toggle listening)
    if (e.target.closest('button, select, label, #settings, #installSheet')) return;
    document.removeEventListener('pointerdown', onTap);
    start();
  };
  const viaTap = () => document.addEventListener('pointerdown', onTap);
  navigator.permissions?.query({ name: 'microphone' })
    .then((p) => (p.state === 'granted' ? start() : viaTap()))
    .catch(viaTap) ?? viaTap();
}
resize();
requestAnimationFrame(frame);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
