import { ENEMY } from '../config.js';

// Wave director: 5 -> 8 -> 12 ... with a break between waves; every 5th wave
// adds a BOSS. Spawns trickle in (max ENEMY.maxActive alive at once).
export class Waves {
  constructor(game) {
    this.game = game;
    this.reset();
  }

  reset() {
    this.wave = 0;
    this.state = 'break';
    this.timer = 3;
    this.remaining = 0;
    this.bossPending = false;
    this.spawnTimer = 0;
  }

  countFor(n) {
    const w = ENEMY.waves;
    return n <= w.length ? w[n - 1] : w[w.length - 1] + (n - w.length) * 4;
  }

  startWave(n) {
    const g = this.game;
    this.wave = n;
    g.wave = n;
    const boss = n % 5 === 0;
    const count = this.countFor(n);
    this.remaining = boss ? Math.ceil(count * 0.5) : count;
    this.bossPending = boss;
    this.state = 'active';
    this.spawnTimer = 0.5;
    g.hud.showMessage(`WAVE ${n}`, boss ? 'BOSS LOG GOON INCOMING' : `${count} Log Goons`, 3.5);
    g.audio.playLocal('wave', 0.8);
  }

  pickRoof(minD, maxD, minHalf, maxY) {
    const roofs = this.game.city.roofs;
    const p = this.game.body.pos;
    for (let tries = 0; tries < 40; tries++) {
      const r = roofs[Math.floor(Math.random() * roofs.length)];
      if (r.y < 8 || r.y > maxY || r.hx < minHalf || r.hz < minHalf) continue;
      const d = Math.hypot(r.x - p.x, r.z - p.z);
      if (d < minD || d > maxD) continue;
      if (this.game.collision.pointInside(r.x, r.y + 1, r.z) !== -1) continue;
      return r;
    }
    return null;
  }

  fixed(dt) {
    const g = this.game;
    if (this.state === 'break') {
      this.timer -= dt;
      if (this.timer <= 0) this.startWave(this.wave + 1);
      return;
    }
    if (this.state !== 'active') return;
    const en = g.enemies;
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && en.activeCount < ENEMY.maxActive) {
      if (this.bossPending) {
        const r = this.pickRoof(120, 320, 9, 60);
        if (r && en.spawn(r, true, false)) {
          this.bossPending = false;
          g.hud.showMessage('BOSS', 'Big Log Goon has entered the city', 3);
          g.audio.play('taunt', r.x, r.y, r.z, 1, 0.5);
        }
        this.spawnTimer = 1.5;
      } else if (this.remaining > 0) {
        const climber = Math.random() < 0.3;
        const r = this.pickRoof(90, 380, 4, climber ? 45 : 75);
        if (r && en.spawn(r, false, climber)) this.remaining--;
        this.spawnTimer = 0.6 + Math.random() * 0.5;
      }
    }
    if (this.remaining === 0 && !this.bossPending && en.activeCount === 0) {
      this.state = 'break';
      this.timer = ENEMY.waveBreak;
      g.addScore(250 * this.wave, false);
      g.hud.showMessage(`WAVE ${this.wave} CLEAR`, `+${250 * this.wave} bonus`, 3);
    }
  }
}
