import { GRAVITY_CURVE, REGIMES, SPEED_CURVE, SPEED_SCALE_SMOOTHING } from '../config.js';

export const REGIME = { SURFACE: 0, LOW_ATMOSPHERE: 1, HIGH_ATMOSPHERE: 2, ORBIT: 3, SPACE: 4 };
export const REGIME_NAMES = ['SURFACE', 'LOW ATMOSPHERE', 'HIGH ATMOSPHERE', 'ORBIT', 'SPACE'];
const BOUNDS = [REGIMES.SURFACE, REGIMES.LOW_ATMOSPHERE, REGIMES.HIGH_ATMOSPHERE, REGIMES.ORBIT];

// Piecewise curve through [x, y] keys, smoothstep between keys, in log space
// for y (multipliers) when `log` is set. Continuous and monotone between keys.
export function sampleCurve(keys, x, log) {
  if (x <= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i];
    if (x > b[0]) continue;
    const a = keys[i - 1];
    let t = (x - a[0]) / (b[0] - a[0]);
    t = t * t * (3 - 2 * t);
    if (log && a[1] > 0 && b[1] > 0) return Math.exp(Math.log(a[1]) + (Math.log(b[1]) - Math.log(a[1])) * t);
    return a[1] + (b[1] - a[1]) * t;
  }
  return last[1];
}

// Altitude -> regime label (with hysteresis) + continuous flight scales.
export class FlightRegime {
  constructor() {
    this.regime = REGIME.SURFACE;
    this.altitude = 0;
    this.speedScale = 1;
    this.gravityScale = 1;
    this.targetSpeedScale = 1;
    // 0..1 blend factors other systems read
    this.airDensity = 1; // relative to sea level (audio wind, drag feel)
  }

  get name() { return REGIME_NAMES[this.regime]; }

  update(altitude, dt) {
    this.altitude = altitude;
    // Label with a fractional hysteresis band around each boundary.
    const h = REGIMES.hysteresis;
    let r = this.regime;
    while (r < BOUNDS.length && altitude > BOUNDS[r] * (1 + h)) r++;
    while (r > 0 && altitude < BOUNDS[r - 1] * (1 - h)) r--;
    this.regime = r;
    this.targetSpeedScale = sampleCurve(SPEED_CURVE, altitude, true);
    // Low-pass, but never lag behind a *descent* so badly the player overshoots
    // into the ground at orbital speed: falling scales converge 4x faster.
    const rate = this.targetSpeedScale < this.speedScale ? SPEED_SCALE_SMOOTHING * 4 : SPEED_SCALE_SMOOTHING;
    const k = 1 - Math.exp(-rate * dt);
    this.speedScale += (this.targetSpeedScale - this.speedScale) * k;
    this.gravityScale = sampleCurve(GRAVITY_CURVE, altitude, false);
    this.airDensity = Math.exp(-Math.max(0, altitude) / 8000);
  }

  reset() {
    this.regime = REGIME.SURFACE;
    this.speedScale = this.targetSpeedScale = 1;
    this.gravityScale = 1;
  }
}
