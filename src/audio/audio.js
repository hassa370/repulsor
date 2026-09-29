// Lightweight Web Audio: every sound is synthesised once into an AudioBuffer
// at start-up (no files), played through a fixed pool of 16 positional voices.
// Wind and thruster are continuous loops driven by speed / grip.

const MAX_VOICES = 16;

function makeBuffer(ctx, seconds, fn) {
  const sr = ctx.sampleRate;
  const n = Math.floor(seconds * sr);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  const st = { phase: 0, phase2: 0, lp: 0, bp1: 0, bp2: 0, seed: 12345 };
  for (let i = 0; i < n; i++) d[i] = fn(i / sr, i, st, sr);
  // normalise
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak > 0) for (let i = 0; i < n; i++) d[i] *= 0.9 / peak;
  return buf;
}

function noise(st) {
  st.seed = (st.seed * 1103515245 + 12345) & 0x7fffffff;
  return (st.seed / 0x3fffffff) - 1;
}

// State-variable band-pass, returns band output.
function svf(st, x, f, q, sr, key = 'a') {
  const F = 2 * Math.sin(Math.PI * Math.min(f, sr / 6) / sr);
  const lo = st[key + 'l'] || 0, bd = st[key + 'b'] || 0;
  const l = lo + F * bd;
  const h = x - l - q * bd;
  const b = F * h + bd;
  st[key + 'l'] = l; st[key + 'b'] = b;
  return b;
}

const SOUNDS = {
  blast: [0.28, (t, i, s, sr) => {
    const f = 1400 * Math.exp(-t * 14) + 180;
    s.phase += (2 * Math.PI * f) / sr;
    const env = Math.exp(-t * 16);
    return (Math.sin(s.phase) * 0.7 + svf(s, noise(s), 2500 * Math.exp(-t * 8) + 400, 0.5, sr) * 0.6) * env;
  }],
  charged: [0.7, (t, i, s, sr) => {
    const f = 520 * Math.exp(-t * 6) + 55;
    s.phase += (2 * Math.PI * f) / sr;
    s.phase2 += (2 * Math.PI * f * 1.51) / sr;
    const env = Math.min(1, t * 80) * Math.exp(-t * 5);
    return (Math.sin(s.phase) + 0.4 * Math.sin(s.phase2) + svf(s, noise(s), 900, 0.7, sr) * 0.8) * env;
  }],
  unibeam: [1.6, (t, i, s, sr) => {
    const f = 95 + Math.sin(t * 30) * 6;
    s.phase += (2 * Math.PI * f) / sr;
    const saw = ((s.phase / (2 * Math.PI)) % 1) * 2 - 1;
    const env = Math.min(1, t * 20) * Math.min(1, (1.6 - t) * 4);
    const hiss = svf(s, noise(s), 3000 + Math.sin(t * 50) * 1500, 0.4, sr);
    return (saw * 0.6 + Math.sin(s.phase * 2) * 0.4 + hiss * 0.5) * env * (0.8 + 0.2 * Math.sin(t * 90));
  }],
  thunk: [0.22, (t, i, s, sr) => {
    s.phase += (2 * Math.PI * (160 + 90 * Math.exp(-t * 40))) / sr;
    const click = svf(s, noise(s), 700, 0.15, sr) * Math.exp(-t * 60);
    return Math.sin(s.phase) * Math.exp(-t * 22) + click * 2;
  }],
  crack: [0.45, (t, i, s, sr) => {
    const burst = (Math.sin(t * 90) > 0.2 ? 1 : 0.3) * Math.exp(-t * 9);
    const n = noise(s);
    s.phase += (2 * Math.PI * 120) / sr;
    return svf(s, n, 2200, 0.25, sr) * burst * 1.4 + Math.sin(s.phase) * Math.exp(-t * 18) * 0.8;
  }],
  whoosh: [0.45, (t, i, s, sr) => {
    const env = Math.sin(Math.PI * Math.min(1, t / 0.45));
    return svf(s, noise(s), 400 + 1600 * (t / 0.45), 0.6, sr) * env;
  }],
  land: [0.3, (t, i, s, sr) => {
    s.phase += (2 * Math.PI * (60 + 60 * Math.exp(-t * 30))) / sr;
    return Math.sin(s.phase) * Math.exp(-t * 14) + svf(s, noise(s), 300, 0.5, sr) * Math.exp(-t * 25);
  }],
  boom: [0.9, (t, i, s, sr) => {
    s.phase += (2 * Math.PI * (45 + 80 * Math.exp(-t * 10))) / sr;
    s.lp += (noise(s) - s.lp) * 0.08;
    return (Math.sin(s.phase) * 0.8 + s.lp * 3) * Math.min(1, t * 200) * Math.exp(-t * 4.5);
  }],
  hurt: [0.35, (t, i, s, sr) => {
    s.phase += (2 * Math.PI * (90 - t * 80)) / sr;
    const sq = Math.sin(s.phase) > 0 ? 1 : -1;
    return (sq * 0.5 + svf(s, noise(s), 500, 0.6, sr)) * Math.exp(-t * 9);
  }],
  taunt: [0.85, (t, i, s, sr) => {
    // "hoo-HAH!" grunt: glottal saw through two formants
    const syl2 = t > 0.32;
    const tt = syl2 ? t - 0.32 : t;
    const f0 = syl2 ? 150 - tt * 60 : 115 + tt * 20;
    s.phase += f0 / sr;
    const saw = (s.phase % 1) * 2 - 1;
    const f1 = syl2 ? 750 : 350, f2 = syl2 ? 1150 : 800;
    const v = svf(s, saw, f1, 0.18, sr, 'a') + svf(s, saw, f2, 0.2, sr, 'b') * 0.6;
    const env = syl2 ? Math.min(1, tt * 30) * Math.exp(-tt * 4.5) : Math.min(1, tt * 20) * Math.exp(-tt * 7) * 0.6;
    return v * env;
  }],
  wave: [1.2, (t, i, s, sr) => {
    const notes = [440, 554, 659, 880];
    const k = Math.min(3, Math.floor(t / 0.12));
    const tt = t - k * 0.12;
    return Math.sin(2 * Math.PI * notes[k] * t) * Math.exp(-tt * 5) * 0.8 + Math.sin(2 * Math.PI * notes[k] * 2 * t) * Math.exp(-tt * 9) * 0.2;
  }],
  pickup: [0.3, (t) => Math.sin(2 * Math.PI * (600 + t * 2400) * t) * Math.exp(-t * 10)],
};

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.buffers = {};
    this.voices = [];
    this.enabled = false;
    this._lp = [0, 0, 0];
  }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp);
    comp.connect(ctx.destination);
    for (const k in SOUNDS) this.buffers[k] = makeBuffer(ctx, SOUNDS[k][0], SOUNDS[k][1]);
    for (let i = 0; i < MAX_VOICES; i++) {
      const gain = ctx.createGain();
      const pan = ctx.createPanner();
      pan.panningModel = 'equalpower';
      pan.distanceModel = 'inverse';
      pan.refDistance = 4;
      pan.rolloffFactor = 1.1;
      pan.maxDistance = 600;
      gain.connect(pan);
      pan.connect(this.master);
      this.voices.push({ gain, pan, src: null, end: 0 });
    }
    // Loops
    const nb = makeBuffer(ctx, 2, (t, i, s) => noise(s));
    const mkLoop = (type, freq, q) => {
      const src = ctx.createBufferSource();
      src.buffer = nb; src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(f); f.connect(g); g.connect(this.master);
      src.start();
      return { src, f, g };
    };
    this.wind = mkLoop('bandpass', 500, 0.7);
    this.thrust = mkLoop('lowpass', 300, 1.5);
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth'; osc.frequency.value = 52;
    const of = ctx.createBiquadFilter(); of.type = 'lowpass'; of.frequency.value = 220;
    this.humGain = ctx.createGain(); this.humGain.gain.value = 0;
    osc.connect(of); of.connect(this.humGain); this.humGain.connect(this.master);
    osc.start();
    this.hum = osc;
    this.enabled = true;
  }

  play(name, x, y, z, vol = 1, rate = 1) {
    if (!this.enabled) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    let v = null, oldest = null;
    for (let i = 0; i < this.voices.length; i++) {
      const c = this.voices[i];
      if (c.end <= now) { v = c; break; }
      if (!oldest || c.end < oldest.end) oldest = c;
    }
    if (!v) {
      v = oldest;
      try { v.src.stop(); } catch { /* already stopped */ }
    }
    const buf = this.buffers[name];
    // AudioBufferSourceNodes are one-shot by spec; this is the only per-sound object.
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(v.gain);
    v.gain.gain.value = vol;
    const p = v.pan;
    if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; }
    else p.setPosition(x, y, z);
    src.start();
    v.src = src;
    v.end = now + buf.duration / rate;
  }

  // Non-positional one-shot (UI, player hurt) at the listener.
  playLocal(name, vol = 1) {
    if (!this.enabled) return;
    const l = this._lp;
    this.play(name, l[0], l[1], l[2], vol);
  }

  update(pos, fwd, up, speed, grip, boost) {
    if (!this.enabled) return;
    const ctx = this.ctx;
    const L = ctx.listener;
    const t = ctx.currentTime;
    if (L.positionX) {
      L.positionX.value = pos.x; L.positionY.value = pos.y; L.positionZ.value = pos.z;
      L.forwardX.value = fwd.x; L.forwardY.value = fwd.y; L.forwardZ.value = fwd.z;
      L.upX.value = up.x; L.upY.value = up.y; L.upZ.value = up.z;
    } else {
      L.setPosition(pos.x, pos.y, pos.z);
      L.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
    this._lp[0] = pos.x; this._lp[1] = pos.y; this._lp[2] = pos.z;
    const w = Math.min(1, speed / 70);
    this.wind.g.gain.setTargetAtTime(0.02 + w * w * 0.5, t, 0.1);
    this.wind.f.frequency.setTargetAtTime(300 + w * 1400, t, 0.1);
    const gk = grip * (boost ? 1.4 : 1);
    this.thrust.g.gain.setTargetAtTime(gk * 0.35, t, 0.05);
    this.thrust.f.frequency.setTargetAtTime(200 + gk * 500, t, 0.05);
    this.humGain.gain.setTargetAtTime(gk * 0.12, t, 0.05);
    this.hum.frequency.setTargetAtTime(48 + gk * 30, t, 0.08);
  }

  suspend() { if (this.ctx) this.ctx.suspend(); }
  resume() { if (this.ctx) this.ctx.resume(); }
}
