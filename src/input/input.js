import { Object3D } from 'three';
import { BINDINGS } from '../config.js';

// Unified input for Quest Touch controllers and desktop keyboard/mouse.
// Everything the game needs is copied into plain numeric / boolean fields
// once per frame; edge-triggered actions are exposed as *Pressed flags.
export class Input {
  constructor(renderer, dom) {
    this.renderer = renderer;
    this.dom = dom;
    this.xr = false;

    this.grip = 0;
    this.gripL = 0; // per-hand grips (hand-thruster flight)
    this.gripR = 0;
    this.stickX = 0;
    this.stickY = 0;
    this.turnX = 0;
    this.menuY = 0;
    this.trigL = 0;
    this.trigR = 0;
    this.boost = false;
    this.unibeamPressed = false;
    this.vignettePressed = false;
    this.pausePressed = false;
    this.confirmPressed = false;
    this.snapTurn = 0; // -1 / 0 / +1 edge
    this.menuStep = 0; // -1 / 0 / +1 edge
    this.lookDX = 0; // desktop mouse deltas (radians), consumed each frame
    this.lookDY = 0;

    this._prev = new Uint8Array(16);
    this._turnLatched = false;
    this._menuLatched = false;

    // XR: target-ray spaces (aim) and grip spaces, indexed 0/1 as three.js gives them.
    this.controllers = [renderer.xr.getController(0), renderer.xr.getController(1)];
    this.grips = [renderer.xr.getControllerGrip(0), renderer.xr.getControllerGrip(1)];
    this.handedness = ['', ''];
    this.gamepads = [null, null];
    this.sources = [null, null];
    for (let i = 0; i < 2; i++) {
      const c = this.controllers[i];
      c.addEventListener('connected', (e) => {
        this.handedness[i] = e.data.handedness;
        this.sources[i] = e.data;
        this.gamepads[i] = e.data.gamepad || null;
      });
      c.addEventListener('disconnected', () => {
        this.handedness[i] = '';
        this.sources[i] = null;
        this.gamepads[i] = null;
      });
    }

    // Desktop stand-ins for hands, parented to the camera by the game.
    this.deskAimL = new Object3D();
    this.deskAimR = new Object3D();
    this.deskAimL.position.set(-0.22, -0.2, -0.35);
    this.deskAimR.position.set(0.22, -0.2, -0.35);

    this.keys = new Set();
    this.mouse = [false, false, false];
    this.pointerLocked = false;
    addEventListener('keydown', (e) => {
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    dom.addEventListener('mousedown', (e) => {
      if (!this.xr && !this.pointerLocked && this.wantPointerLock) dom.requestPointerLock();
      this.mouse[e.button] = true;
    });
    addEventListener('mouseup', (e) => { this.mouse[e.button] = false; });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === dom;
    });
    addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      this.lookDX -= e.movementX * 0.0022;
      this.lookDY -= e.movementY * 0.0022;
    });
    this.wantPointerLock = false;
  }

  hand(name) {
    if (this.handedness[0] === name) return 0;
    if (this.handedness[1] === name) return 1;
    return -1;
  }

  aimObject(name) {
    if (!this.xr) return name === 'left' ? this.deskAimL : this.deskAimR;
    const i = this.hand(name);
    return i < 0 ? (name === 'left' ? this.deskAimL : this.deskAimR) : this.controllers[i];
  }

  gripObject(name) {
    const i = this.hand(name);
    return i < 0 ? null : this.grips[i];
  }

  _btn(hand, index) {
    const i = this.hand(hand);
    const gp = i < 0 ? null : this.gamepads[i];
    if (!gp || index >= gp.buttons.length) return 0;
    return gp.buttons[index].value || (gp.buttons[index].pressed ? 1 : 0);
  }

  _axis(hand, index) {
    const i = this.hand(hand);
    const gp = i < 0 ? null : this.gamepads[i];
    if (!gp || index >= gp.axes.length) return 0;
    const v = gp.axes[index];
    return Math.abs(v) < 0.12 ? 0 : v;
  }

  _edge(slot, down) {
    const was = this._prev[slot];
    this._prev[slot] = down ? 1 : 0;
    return down && !was;
  }

  update() {
    this.xr = this.renderer.xr.isPresenting;
    const b = BINDINGS;
    if (this.xr) {
      const x = b.xr;
      this.grip = this._btn(x.thrust.hand, x.thrust.button);
      this.gripL = this._btn('left', 1);
      this.gripR = this._btn('right', 1);
      this.stickX = this._axis(x.steer.hand, x.steer.axes[0]);
      this.stickY = -this._axis(x.steer.hand, x.steer.axes[1]);
      this.turnX = this._axis(x.snapTurn.hand, x.snapTurn.axis);
      this.menuY = -this._axis(x.menuNav.hand, x.menuNav.axis);
      this.trigL = this._btn(x.fireLeft.hand, x.fireLeft.button);
      this.trigR = this._btn(x.fireRight.hand, x.fireRight.button);
      this.boost = this._btn(x.boost.hand, x.boost.button) > 0.5;
      this.unibeamPressed = this._edge(0, this._btn(x.unibeam.hand, x.unibeam.button) > 0.5);
      this.vignettePressed = this._edge(1, this._btn(x.vignette.hand, x.vignette.button) > 0.5);
      this.pausePressed = this._edge(2, this._btn(x.pause.hand, x.pause.button) > 0.5);
      this.confirmPressed = this._edge(3, this.boost || this.trigR > 0.6);
    } else {
      const d = b.desktop;
      const k = this.keys;
      this.grip = k.has(d.thrust) ? 1 : k.has(d.hover) ? 0.33 : 0;
      this.gripL = this.gripR = this.grip;
      this.stickX = (k.has(d.right) ? 1 : 0) - (k.has(d.left) ? 1 : 0);
      this.stickY = (k.has(d.forward) ? 1 : 0) - (k.has(d.back) ? 1 : 0);
      this.turnX = (k.has(d.snapRight) ? 1 : 0) - (k.has(d.snapLeft) ? 1 : 0);
      this.menuY = (k.has('ArrowUp') ? 1 : 0) - (k.has('ArrowDown') ? 1 : 0);
      this.trigR = this.mouse[0] ? 1 : 0;
      this.trigL = this.mouse[2] ? 1 : 0;
      this.boost = k.has(d.boost) || k.has('ShiftRight');
      this.unibeamPressed = this._edge(0, k.has(d.unibeam));
      this.vignettePressed = this._edge(1, k.has(d.vignette));
      this.pausePressed = this._edge(2, k.has(d.pause) || k.has('KeyP'));
      this.confirmPressed = this._edge(3, k.has('Enter') || this.mouse[0]);
    }
    // Snap turn / menu nav: latch until the stick returns to centre.
    if (Math.abs(this.turnX) > 0.6) {
      this.snapTurn = this._turnLatched ? 0 : Math.sign(this.turnX);
      this._turnLatched = true;
    } else {
      this.snapTurn = 0;
      if (Math.abs(this.turnX) < 0.3) this._turnLatched = false;
    }
    if (Math.abs(this.menuY) > 0.6) {
      this.menuStep = this._menuLatched ? 0 : -Math.sign(this.menuY);
      this._menuLatched = true;
    } else {
      this.menuStep = 0;
      if (Math.abs(this.menuY) < 0.3) this._menuLatched = false;
    }
  }

  haptic(hand, intensity, ms) {
    if (!this.xr) return;
    const i = hand === 'both' ? -1 : this.hand(hand);
    for (let j = 0; j < 2; j++) {
      if (i >= 0 && j !== i) continue;
      const gp = this.gamepads[j];
      const act = gp && gp.hapticActuators && gp.hapticActuators[0];
      if (act && act.pulse) act.pulse(intensity, ms);
      else if (gp && gp.vibrationActuator && gp.vibrationActuator.playEffect) {
        gp.vibrationActuator.playEffect('dual-rumble', { duration: ms, strongMagnitude: intensity, weakMagnitude: intensity });
      }
    }
  }
}
