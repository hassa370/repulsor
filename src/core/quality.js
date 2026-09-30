import { QUALITY } from '../config.js';

// Adaptive quality: watches a rolling (EMA, ~1 s) frame time against the
// current refresh budget. Only a *sustained* overrun steps quality down one
// level; only a long stretch of headroom steps it back up. Separate
// thresholds + dwell times + a cooldown after every change = hysteresis, so it
// never oscillates. Capability based (measured frame time), never user agent.
export class AdaptiveQuality {
  constructor(perf, apply) {
    this.perf = perf;
    this.apply = apply; // (preset, level) => void
    this.level = 0;
    this.avgMs = 0;
    this.over = 0;
    this.under = 0;
    this.cooldown = 2; // ignore start-up hitches
    this.locked = -1;
    this.changes = 0;
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('quality') : null;
    if (q !== null) {
      const i = QUALITY.levels.indexOf(q.toUpperCase());
      if (i >= 0) this.lock(i);
    }
  }

  get name() { return QUALITY.levels[this.level]; }

  lock(level) {
    this.locked = level;
    this.set(level);
  }

  set(level) {
    this.level = Math.max(0, Math.min(QUALITY.presets.length - 1, level));
    this.apply(QUALITY.presets[this.level], this.level);
    this.over = this.under = 0;
    this.cooldown = 5;
    this.changes++;
  }

  update(dt, frameMs) {
    if (!(dt > 0)) return;
    const k = 1 - Math.exp(-dt);
    this.avgMs += (frameMs - this.avgMs) * k;
    if (this.locked >= 0) return;
    if (this.cooldown > 0) { this.cooldown -= dt; return; }
    const budget = 1000 / this.perf.targetFps;
    if (this.avgMs > budget * QUALITY.degradeAbove) this.over += dt; else this.over = Math.max(0, this.over - dt * 2);
    if (this.avgMs < budget * QUALITY.restoreBelow) this.under += dt; else this.under = 0;
    if (this.over > QUALITY.degradeSeconds && this.level < QUALITY.presets.length - 1) this.set(this.level + 1);
    else if (this.under > QUALITY.restoreSeconds && this.level > 0) this.set(this.level - 1);
  }
}
