// All tunables live here. Edit and reload.

// Controller / keyboard bindings. XR button indices follow the WebXR
// "xr-standard" gamepad mapping used by Quest Touch Plus controllers:
//   buttons[0] trigger, [1] squeeze (grip), [3] thumbstick click,
//   [4] A / X, [5] B / Y;  axes[2], axes[3] thumbstick x / y.
export const BINDINGS = {
  xr: {
    thrust: { hand: 'left', button: 1 }, // analog grip = main thrust
    steer: { hand: 'left', axes: [2, 3] }, // strafe / forward-back thrust
    snapTurn: { hand: 'right', axis: 2 },
    fireLeft: { hand: 'left', button: 0 },
    fireRight: { hand: 'right', button: 0 },
    boost: { hand: 'right', button: 4 }, // A
    unibeam: { hand: 'right', button: 5 }, // B
    vignette: { hand: 'left', button: 4 }, // X
    pause: { hand: 'left', button: 5 }, // Y
    menuNav: { hand: 'right', axis: 3 },
  },
  desktop: {
    forward: 'KeyW',
    back: 'KeyS',
    left: 'KeyA',
    right: 'KeyD',
    thrust: 'Space', // full thrust
    hover: 'KeyQ', // hover-level thrust (analog-grip stand-in)
    boost: 'ShiftLeft',
    unibeam: 'KeyE',
    vignette: 'KeyV',
    pause: 'Tab',
    snapLeft: 'KeyZ',
    snapRight: 'KeyC',
    // mouse: left button = right hand trigger, right button = left hand trigger
  },
};

export const FLIGHT = {
  gravity: 9.8,
  thrustMax: 32, // m/s^2 at full grip
  thrustForwardGain: 1.3, // how much the look direction tilts thrust at full grip
  thrustUpBias: 1.0, // upward bias so a light squeeze hovers
  hoverLo: 0.2, // grip where the hover plateau starts (below: gentle descent)
  hoverHi: 0.45, // grip where the plateau ends (above: more power + tilt toward look dir)
  gripCurve: 1.0, // grip response exponent (>1 = finer control at light squeeze)
  gripDeadzone: 0.06, // ignore resting finger pressure on the grip
  gripSmoothing: 7, // 1/s low-pass on grip input (higher = snappier)
  lookSmoothing: 2.5, // 1/s: how fast thrust direction follows the head (lower = calmer)
  airBrake: 1.2, // 1/s horizontal damping while hovering with the stick centred
  // Hand-thruster mode (VR default): each grip fires that hand's repulsor, which
  // pushes you AWAY from the palm (palms down = lift, palms back = forward).
  flightMode: 'hands', // 'hands' | 'gaze' (gaze = left grip thrusts toward where you look)
  thrustAxis: 'point', // 'point': push opposite to where each controller points; 'palm': opposite the palm side
  handThrustMax: 18, // m/s^2 per hand at full grip (both hands ~3.7 g)
  palmSign: 1, // flip to -1 if thrust comes out of the back of your hands
  gazeSteer: 0.6, // 1/s: how strongly your flight path bends toward where you look
  // Omni-Man mode: hit a building faster than this and you smash through it.
  smashSpeed: 24, // m/s into the wall
  smashKeep: 0.8, // fraction of speed kept per wall
  craterSpeed: 22, // m/s downward into the ground -> crater + shockwave
  craterRadius: 16, // m, enemies inside get hit
  strafeAccel: 7, // left stick lateral / forward accel (m/s^2)
  boostMult: 2.5, // total thrust while boosting (x normal)
  // Hand-flight boost split: the palms run at this much of normal thrust and the
  // boot thrusters add the rest (boostMult - boostHandMult) along the hand thrust,
  // so the total stays handThrust * boostMult (here 50% palms / 50% boots).
  boostHandMult: 1.25,
  boostDrainPerSec: 0.35, // meter units (0..1) per second
  boostRefillPerSec: 0.18,
  boostRefillDelay: 0.8, // s after release before refill starts
  dragQuadratic: 0.0065, // a = -k |v| v   -> natural top speed
  dragLinear: 0.04,
  hoverAssist: 5, // vertical velocity damping (1/s) when thrust ~ balances gravity
  hoverWindow: 4, // |net vertical accel| below this engages assist (m/s^2)
  groundFriction: 8, // 1/s horizontal damping while standing
  walkSpeed: 3.5,
  capsuleRadius: 0.35,
  capsuleHeight: 1.75,
  restitution: 0.08, // velocity reflection on building impact
  wallFriction: 0.15, // tangential velocity loss on impact
  impactHapticSpeed: 4, // m/s normal speed for a haptic thump
  bankEnabled: true,
  bankMax: 0.1, // radians (~6 deg) max camera roll into turns
  bankGain: 0.004,
  recoilQuick: 0.6, // m/s kick per quick blast
  recoilCharged: 3.0,
  snapTurnDeg: 30,
  physicsHz: 90,
  maxSubSteps: 4,
};

export const WEAPONS = {
  quickSpeed: 140,
  quickRadius: 0.3,
  quickDamage: 1,
  chargedSpeed: 70,
  chargedRadius: 0.9,
  chargedDamage: 2,
  chargedSplashRadius: 5,
  chargedSplashDamage: 1,
  chargeTime: 0.3, // hold longer than this = charged shot
  fullChargeTime: 1.0,
  fireCooldown: 0.12,
  life: 3.0,
  aimRange: 400, // controller aim ray length (m): the shot target when nothing is hit
  spawnOffset: 0.025, // blasts start this far out of the palm repulsor (m)
  minAimDist: 0.3, // closer targets than this fall back to the aim direction
  headshotMult: 2,
  assistDeg: 7, // aim assist: snap shots to a goon within this cone...
  assistRadius: 2.5, // ...or passing within this many metres of it
  assistRange: 380,
  homingQuick: 2.5, // 1/s steering of blasts toward their assisted target
  homingCharged: 4,
  unibeamCooldown: 10,
  unibeamDuration: 1.4,
  unibeamRange: 450,
  unibeamRadius: 1.6,
  unibeamDps: 12,
  unibeamBuildingDps: 14,
  buildingDamageQuick: 1, // building hit points: 4 + height*0.1 + footprint/300
  buildingDamageCharged: 5,
  buildingDamageSmash: 8,
  maxBlasts: 64,
};

export const ENEMY = {
  maxActive: 40,
  goonScale: 1.25, // overall size of regular goons (bigger = easier to spot and hit)
  hitRadiusScale: 1.7, // blast hitbox radius relative to the body
  markerAngle: 40, // deg: goons inside this cone get a marker above them, outside an edge pip
  hp: 2,
  bossHp: 30,
  bossScale: 3,
  thinkHz: 20,
  farThinkHz: 4,
  farDistance: 450,
  spotRange: 320,
  throwRange: 140,
  meleeRange: 7,
  leapMaxHoriz: 75,
  leapMaxUp: 35,
  batSpeed: 38,
  batDamage: 12,
  meleeDamage: 15,
  bossSlamDamage: 20,
  bossSlamRadius: 28,
  bossSlamKnock: 28,
  lodSilhouette: 60,
  lodSprite: 150,
  cullDistance: 900,
  debrisLife: 4,
  waveBreak: 6,
  waves: [5, 8, 12, 16, 20, 24, 28, 32, 36, 40],
};

// Player suit rig (src/player/suit.js): body under the head + boot thruster sockets.
export const SUIT = {
  height: 1.8, // m, suit scale (sockets are measured on a 1.80 m suit)
  neckBack: 0.12, // m the body sits behind the eyes
  yawFollow: 4, // 1/s: how fast the body turns to follow the head
  flightLegDeg: 20, // legs swing back this much while boosting
  bootOut: 0.01, // m below the sole where boot exhaust starts
};

export const PLAYER = {
  maxHp: 100,
  regenDelay: 5,
  regenPerSec: 6,
};

export const WORLD = {
  seed: 1337,
  citySize: 1600, // m, square centred on origin
  blockSize: 64,
  roadWidth: 16,
  chunkSize: 400,
  coastZ: -760, // water beyond this (towards the sunset)
  downtown: [0, -150],
  hashCell: 32,
  // Sun direction (towards the sun). Low over the sea for a sunset.
  sunDir: [-0.25, 0.12, -0.96],
  sunColor: 0xffb070,
  sunIntensity: 2.2,
  fogDensity: 0.00095,
  drawDistance: 1100,
};

export const RENDER = {
  foveation: 1,
  framebufferScale: 1.0,
  targetFps: 90,
  fallbackFps: 72,
  antialias: true,
};

// Where the face sits inside public/textures/enemy_face.png (normalised u0,v0,u1,v1, top-left origin).
export const FACE_CROP = [0.34, 0.06, 0.66, 0.3];
