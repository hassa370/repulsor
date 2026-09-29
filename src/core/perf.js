import { RENDER } from '../config.js';

// Frame-time monitor + automatic 90 <-> 72 Hz switching on Quest.
export class Perf {
  constructor(renderer) {
    this.renderer = renderer;
    this.fps = 0;
    this.frameMs = 0; // smoothed wall-clock frame interval
    this.cpuMs = 0; // smoothed CPU time spent in update + render submit
    this._acc = 0;
    this._frames = 0;
    this._overBudget = 0;
    this._underBudget = 0;
    this.targetFps = RENDER.targetFps;
    this.downgrades = 0; // after two drops we stay at the fallback rate (no oscillation)
    this.calls = 0;
    this.tris = 0;
  }

  frame(dt, cpuMs) {
    this.frameMs += (dt * 1000 - this.frameMs) * 0.05;
    this.cpuMs += (cpuMs - this.cpuMs) * 0.05;
    this._acc += dt;
    this._frames++;
    if (this._acc >= 0.5) {
      this.fps = this._frames / this._acc;
      this._acc = 0;
      this._frames = 0;
      this._adapt();
    }
  }

  _adapt() {
    const session = this.renderer.xr.getSession && this.renderer.xr.getSession();
    if (!session || !session.updateTargetFrameRate || !session.supportedFrameRates) return;
    const budget = 1000 / this.targetFps;
    // Missing frames shows up as the display interval stretching past budget.
    if (this.frameMs > budget * 1.12) this._overBudget++;
    else this._overBudget = 0;
    if (this.targetFps !== RENDER.targetFps && this.cpuMs < (1000 / RENDER.targetFps) * 0.6 && this.frameMs < budget * 1.02) this._underBudget++;
    else this._underBudget = 0;
    if (this.targetFps === RENDER.targetFps && this._overBudget >= 4) { this.downgrades++; this.setRate(RENDER.fallbackFps); }
    else if (this.targetFps !== RENDER.targetFps && this.downgrades < 2 && this._underBudget >= 60) this.setRate(RENDER.targetFps);
  }

  setRate(hz) {
    const session = this.renderer.xr.getSession();
    if (!session || !session.supportedFrameRates) return;
    const rates = session.supportedFrameRates;
    let ok = false;
    for (let i = 0; i < rates.length; i++) if (rates[i] === hz) ok = true;
    if (!ok) return;
    this.targetFps = hz;
    this._overBudget = 0;
    this._underBudget = 0;
    session.updateTargetFrameRate(hz).catch(() => {});
  }
}
