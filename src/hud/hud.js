import {
  CanvasTexture, CircleGeometry, Mesh, MeshBasicMaterial, PlaneGeometry, RingGeometry, ShaderMaterial,
  SRGBColorSpace,
} from 'three';
import { PLAYER, WEAPONS } from '../config.js';

// Canvas-texture HUD panels (redrawn at most 10x per second, only on change),
// plus a peripheral ring mesh for the comfort vignette + damage flash.

function panel(w, h, mw, mh) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  const mat = new MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
  const mesh = new Mesh(new PlaneGeometry(mw, mh), mat);
  mesh.renderOrder = 1001;
  mesh.frustumCulled = false;
  return { canvas: c, g: c.getContext('2d'), tex, mesh };
}

const RING_VS = /* glsl */ `
varying vec2 vP;
void main() {
  vP = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const RING_FS = /* glsl */ `
uniform float uVig;
uniform float uDamage;
uniform float uFade;
varying vec2 vP;
void main() {
  float ang = atan(length(vP) / 0.1);
  float vig = uVig > 0.001 ? smoothstep(mix(1.15, 0.42, uVig), mix(1.25, 0.72, uVig), ang) : 0.0;
  float dmg = smoothstep(0.38, 0.95, ang) * uDamage;
  float a = max(vig, dmg * 0.85);
  vec3 col = dmg > vig ? vec3(0.75, 0.04, 0.02) : vec3(0.0);
  a = max(a, uFade);
  col = mix(col, vec3(0.0), uFade);
  gl_FragColor = vec4(col, a);
}
`;

const MENU_ITEMS = ['Resume', 'Flight', 'Comfort vignette', 'Camera banking', 'Debug overlay', 'Restart game'];

export class Hud {
  constructor(game) {
    this.game = game;
    const cam = game.camera;
    // Wrist display
    this.wrist = panel(256, 176, 0.13, 0.0894);
    this.wristCache = new Int32Array(8).fill(-999);
    this.wristVals = new Int32Array(8);
    this.wristTimer = 0;
    this.wristParent = null;

    // Screen ring (vignette + damage). Only the periphery is drawn.
    this.ringMat = new ShaderMaterial({
      uniforms: { uVig: { value: 0 }, uDamage: { value: 0 }, uFade: { value: 0 } },
      vertexShader: RING_VS, fragmentShader: RING_FS,
      transparent: true, depthTest: false, depthWrite: false,
    });
    this.ring = new Mesh(new RingGeometry(0.034, 0.6, 48, 1), this.ringMat);
    this.ring.position.z = -0.1;
    this.ring.renderOrder = 1000;
    this.ring.frustumCulled = false;
    cam.add(this.ring);
    this.fadeDisc = new Mesh(new CircleGeometry(0.035, 24), this.ringMat);
    this.fadeDisc.position.z = -0.1;
    this.fadeDisc.renderOrder = 1000;
    this.fadeDisc.frustumCulled = false;
    cam.add(this.fadeDisc);
    this.vignette = 0;
    this.damage = 0;
    this.fade = 0;

    // Centre message
    this.msg = panel(1024, 256, 1.6, 0.4);
    this.msg.mesh.position.set(0, 0.15, -2.2);
    cam.add(this.msg.mesh);
    this.msgTime = 0;

    // Pause menu
    this.menu = panel(512, 512, 0.9, 0.9);
    this.menu.mesh.position.set(0, 0, -1.4);
    cam.add(this.menu.mesh);
    this.menu.mesh.visible = false;
    this.menuIndex = 0;

    // Debug overlay
    this.debug = panel(512, 512, 0.5, 0.5);
    this.debug.mesh.position.set(0, -0.2, -1.1);
    this.debug.mesh.rotation.x = 0.35;
    cam.add(this.debug.mesh);
    this.debug.mesh.visible = false;
    this.debugTimer = 0;

    this.hitMarkerTime = 0;
    this.hitMarkerKill = false;
  }

  attachWrist() {
    const g = this.game;
    const input = g.input;
    const grip = input.xr ? input.gripObject('left') : null;
    const parent = grip || g.camera;
    if (parent === this.wristParent) return;
    this.wristParent = parent;
    const m = this.wrist.mesh;
    parent.add(m);
    if (grip) {
      m.position.set(0.0, 0.035, 0.11);
      m.rotation.set(-Math.PI / 2 + 0.55, 0, 0);
      m.scale.setScalar(1);
    } else {
      m.position.set(-0.19, -0.13, -0.3);
      m.rotation.set(0.25, 0.3, 0);
      m.scale.setScalar(0.9);
    }
  }

  showMessage(title, sub = '', seconds = 3) {
    const { g, canvas, tex } = this.msg;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.textAlign = 'center';
    g.shadowColor = 'rgba(255,120,30,0.9)';
    g.shadowBlur = 18;
    g.fillStyle = '#ffd9a0';
    g.font = '800 104px system-ui, sans-serif';
    g.fillText(title, 512, 118);
    if (sub) {
      g.shadowBlur = 8;
      g.font = '600 44px system-ui, sans-serif';
      g.fillStyle = '#fff2e0';
      g.fillText(sub, 512, 200);
    }
    tex.needsUpdate = true;
    this.msgTime = seconds;
    this.msg.mesh.visible = true;
  }

  drawMenu() {
    const { g, canvas, tex } = this.menu;
    const o = this.game.options;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = 'rgba(20,12,18,0.88)';
    roundRect(g, 8, 8, 496, 496, 28); g.fill();
    g.strokeStyle = '#ff9a40'; g.lineWidth = 4; g.stroke();
    g.fillStyle = '#ffcf8a';
    g.font = '800 54px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('PAUSED', 256, 84);
    const vals = [null, o.flightMode, o.vignette, o.bank, o.debug, null];
    g.font = '600 32px system-ui, sans-serif';
    for (let i = 0; i < MENU_ITEMS.length; i++) {
      const y = 140 + i * 54;
      if (i === this.menuIndex) {
        g.fillStyle = 'rgba(255,143,58,0.3)';
        roundRect(g, 40, y - 40, 432, 56, 12); g.fill();
      }
      g.fillStyle = i === this.menuIndex ? '#fff' : '#e8d8c4';
      g.textAlign = 'left';
      g.fillText(MENU_ITEMS[i], 60, y);
      if (vals[i] !== null) {
        g.textAlign = 'right';
        if (typeof vals[i] === 'string') {
          g.fillStyle = '#9fdcff';
          g.fillText(vals[i] === 'hands' ? 'HANDS' : 'GAZE', 452, y);
        } else {
          g.fillStyle = vals[i] ? '#9dff9d' : '#ff9d9d';
          g.fillText(vals[i] ? 'ON' : 'OFF', 452, y);
        }
      }
    }
    g.textAlign = 'center';
    g.font = '400 18px system-ui, sans-serif';
    g.fillStyle = '#bba';
    g.fillText('Right stick / arrows: select', 256, 462);
    g.fillText('A / trigger / Enter: choose  ·  Y / Tab: resume', 256, 486);
    tex.needsUpdate = true;
  }

  setMenu(open) {
    this.menu.mesh.visible = open;
    if (open) { this.msg.mesh.visible = false; this.msgTime = 0; }
    if (open) this.drawMenu();
  }

  menuItemCount() { return MENU_ITEMS.length; }

  drawWrist() {
    const game = this.game;
    const b = game.body;
    const vms = b.vel.length();
    // km/h at flight speeds, km/s once you're going orbital
    const speed = vms >= 2000 ? Math.round(vms / 100) / 10 : Math.round(vms * 3.6);
    const altM = game.altitude;
    const alt = altM >= 10000 ? Math.round(altM / 1000) : Math.round(altM);
    const boost = Math.round(game.boostMeter * 100);
    const hp = Math.round(Math.max(0, game.hp));
    const uni = Math.round(game.weapons.unibeamCd * 10);
    const c = this.wristCache;
    const vals = this.wristVals;
    vals[0] = speed; vals[1] = alt; vals[2] = boost; vals[3] = hp;
    vals[4] = game.wave; vals[5] = game.score; vals[6] = uni; vals[7] = game.enemies.activeCount + game.waves.remaining;
    let changed = false;
    for (let i = 0; i < vals.length; i++) if (c[i] !== vals[i]) { c[i] = vals[i]; changed = true; }
    if (!changed) return;
    const { g, canvas, tex } = this.wrist;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = 'rgba(10,14,22,0.82)';
    roundRect(g, 2, 2, 252, 172, 16); g.fill();
    g.strokeStyle = 'rgba(120,200,255,0.8)'; g.lineWidth = 2; g.stroke();
    g.textAlign = 'left';
    g.fillStyle = '#9fdcff';
    g.font = '700 30px system-ui, sans-serif';
    const sp = `${speed}`;
    g.fillText(sp, 14, 38);
    const spw = g.measureText(sp).width;
    g.font = '500 14px system-ui, sans-serif';
    g.fillText(vms >= 2000 ? 'KM/S' : 'KM/H', 14 + spw + 6, 38);
    g.textAlign = 'right';
    g.font = '700 30px system-ui, sans-serif';
    g.fillText(`${alt}`, 206, 38);
    g.font = '500 14px system-ui, sans-serif';
    g.fillText(altM >= 10000 ? 'KM ALT' : 'M ALT', 250, 38);
    bar(g, 14, 54, 228, 14, hp / PLAYER.maxHp, hp < 30 ? '#ff5040' : '#6dff8a', 'HP');
    bar(g, 14, 78, 228, 14, boost / 100, '#ffb040', 'BOOST');
    const uniK = 1 - game.weapons.unibeamCd / WEAPONS.unibeamCooldown;
    bar(g, 14, 102, 228, 14, uniK, uniK >= 1 ? '#80e0ff' : '#4a7ea0', uniK >= 1 ? 'UNIBEAM READY' : 'UNIBEAM');
    g.textAlign = 'left';
    g.fillStyle = '#ffe2b8';
    g.font = '700 20px system-ui, sans-serif';
    g.fillText(`WAVE ${game.wave}`, 14, 150);
    g.textAlign = 'right';
    g.fillText(`${game.score}`, 242, 150);
    g.font = '500 13px system-ui, sans-serif';
    g.fillStyle = '#c9b';
    g.textAlign = 'left';
    g.fillText(`GOONS LEFT ${vals[7]}`, 14, 167);
    tex.needsUpdate = true;
  }

  drawDebug() {
    const game = this.game;
    const p = game.perf;
    const { g, canvas, tex } = this.debug;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = 'rgba(0,0,0,0.75)';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.font = '600 26px ui-monospace, monospace';
    g.fillStyle = p.fps >= p.targetFps * 0.97 ? '#8f8' : p.fps >= 70 ? '#ff8' : '#f88';
    g.textAlign = 'left';
    const lines = [
      `FPS ${p.fps.toFixed(1)} / ${p.targetFps}Hz  frame ${p.frameMs.toFixed(2)}ms`,
      `CPU ${p.cpuMs.toFixed(2)}ms  worst ${p.worstMs.toFixed(1)}ms`,
      `draw calls ${p.calls}  tris ${(p.tris / 1000).toFixed(1)}k`,
      `enemies ${game.enemies.activeCount} (vis ${game.enemies.visibleCount})  debris ${game.debris.activeCount}`,
      `blasts ${game.weapons.activeCount}  particles ${game.particles.aliveCount()}`,
      `physics ${1 + game.enemies.activeCount + game.debris.activeCount}  sprites ${game.sprites.count}`,
    ];
    const w = game.world;
    if (w) {
      const c = w.planet.stats, r = w.ranges;
      const alt = w.altitude;
      lines.push(
        `alt ${alt < 10000 ? `${alt.toFixed(0)} m` : `${(alt / 1000).toFixed(1)} km`}  ${w.regime.name}`,
        `speed x${w.regime.speedScale.toFixed(1)}  g x${w.regime.gravityScale.toFixed(2)}  ${w.anchored ? 'ANCHORED' : 'FLOATING'}`,
        `chunks ${c.loaded} load  ${c.rendered} draw  ${c.high} high  q ${w.stats.queue}`,
        `gen ${w.stats.genMs.toFixed(2)}ms  shifts ${w.origin.shiftCount}  Q ${game.quality ? game.quality.name : '-'}`,
        `sector ${w.global.sx},${w.global.sy},${w.global.sz}  near ${(r.nearF / 1000).toFixed(0)}k far ${(r.farN / 1000).toFixed(1)}-${(r.farF / 1000).toFixed(0)}k`,
      );
    }
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) g.fillStyle = '#e0e0e0';
      g.fillText(lines[i], 14, 30 + i * 38);
    }
    tex.needsUpdate = true;
  }

  frame(dt) {
    const game = this.game;
    this.attachWrist();
    this.wristTimer -= dt;
    if (this.wristTimer <= 0) {
      this.wristTimer = 0.1;
      this.drawWrist();
    }
    if (this.debug.mesh.visible !== game.options.debug) this.debug.mesh.visible = game.options.debug;
    if (game.options.debug) {
      this.debugTimer -= dt;
      if (this.debugTimer <= 0) { this.debugTimer = 0.25; this.drawDebug(); }
    }
    if (this.msgTime > 0) {
      this.msgTime -= dt;
      if (this.msgTime <= 0) this.msg.mesh.visible = false;
    }
    this.damage = Math.max(0, this.damage - dt * 2.2);
    const u = this.ringMat.uniforms;
    u.uVig.value = game.options.vignette ? this.vignette : 0;
    u.uDamage.value = this.damage;
    u.uFade.value = this.fade;
    this.ring.visible = u.uVig.value > 0.01 || this.damage > 0.01 || this.fade > 0.01;
    this.fadeDisc.visible = this.fade > 0.01;
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function bar(g, x, y, w, h, k, color, label) {
  g.fillStyle = 'rgba(255,255,255,0.12)';
  g.fillRect(x, y, w, h);
  g.fillStyle = color;
  g.fillRect(x, y, w * Math.max(0, Math.min(1, k)), h);
  g.fillStyle = '#0b0f16';
  g.font = '700 11px system-ui, sans-serif';
  g.textAlign = 'left';
  g.fillText(label, x + 4, y + h - 3);
}
