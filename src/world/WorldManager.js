import { Color, DirectionalLight, HemisphereLight, Scene, Vector3 } from 'three';
import { ORIGIN, PLANET, WORLD, WORLD_BUDGET } from '../config.js';
import { FloatingOrigin, GlobalPosition } from './core/FloatingOrigin.js';
import { GenerationScheduler } from './core/GenerationScheduler.js';
import { PlanetSurface } from './planet/PlanetSurface.js';
import { MAX_TERRAIN_HEIGHT, surfaceRadius } from './planet/TerrainGenerator.js';
import { Sky } from './planet/Sky.js';
import { Clouds } from './planet/Clouds.js';
import { StarField } from './space/StarField.js';
import { FlightRegime } from './FlightRegime.js';
import { DepthPartition } from './render/DepthPartition.js';
import { U } from './shared.js';
import { WATER_LEVEL } from '../physics/collision.js';

// Orchestrates the seamless world:
//
//   WorldManager
//   ├── FloatingOrigin         local frame <-> planet-centric float64 frame
//   ├── GenerationScheduler    time-sliced procedural work (1 ms / frame)
//   ├── PlanetSurface          cube-sphere quadtree terrain (surface .. planet)
//   ├── Sky / Clouds / Stars   atmosphere, cloud deck + shell, starfield
//   ├── FlightRegime           altitude -> regime, speed / gravity scales
//   └── DepthPartition         near + far depth passes
//
// The legacy city (buildings, collision, enemies) is a local "anchor" on the
// planet. Inside the anchor bubble the local frame equals the city frame, so
// all combat systems run untouched; outside it they sleep (their state is
// kept) and the city group is placed by the floating origin like any other
// planet-attached object.

const _v = new Vector3();
const _v2 = new Vector3();
const _up = new Vector3();
const _sun = new Vector3();
const _c = new Color();
const SUN_G = new Vector3().fromArray(WORLD.sunDir).normalize(); // global == city axes

function smooth(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export class WorldManager {
  constructor({ renderer, scene, camera, sky, city, collision, lights }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.city = city;
    this.collision = collision;
    this.lights = lights;
    this.farScene = new Scene();
    this.farScene.name = 'far';
    this.origin = new FloatingOrigin(PLANET.radius);
    this.scheduler = new GenerationScheduler(WORLD_BUDGET.generationBudgetMs);
    this.planet = new PlanetSurface(this.origin, this.scheduler);
    this.sky = new Sky(sky.texture);
    this.clouds = new Clouds(this.origin);
    this.stars = new StarField();
    this.regime = new FlightRegime();
    this.partition = renderer ? new DepthPartition(renderer, camera) : null;
    this.global = new GlobalPosition();
    this.playerG = new Vector3(0, PLANET.radius, 0);
    this.camL = new Vector3();
    this.camG = new Vector3();
    this.up = new Vector3(0, 1, 0);
    this.altitude = 0;
    this.cityDrawDistance = WORLD.drawDistance;
    this.cityDistance = 0;
    this.cityNear = true;
    this.anchorListeners = [];
    this.ranges = { nearN: camera ? camera.near : 0.05, nearF: 3000, farN: 1000, farF: 1e6 };
    this.stats = { shifts: 0, genMs: 0, queue: 0 };
    this.lastPrime = 0;

    this.farScene.add(this.sky.mesh);
    this.farScene.add(this.stars.points);
    this.farScene.add(this.clouds.farMesh);
    this.farScene.add(this.clouds.shell);
    scene.add(this.clouds.nearMesh);
    // Far-pass lights mirror the near ones (built-in materials on the distant city).
    this.farSun = new DirectionalLight(0xffffff, 1);
    this.farHemi = new HemisphereLight(0xffffff, 0xffffff, 1);
    this.farScene.add(this.farSun, this.farHemi);

    // Baseline environment (sunset tuned) that altitude / sun elevation modulate.
    this.base = {
      fogColor: U.uFogColor.value.clone(),
      fogDensity: WORLD.fogDensity,
      sunColor: U.uSunColor.value.clone(),
      ambSky: U.uAmbientSky.value.clone(),
      ambGround: U.uAmbientGround.value.clone(),
      skyTop: U.uSkyTop.value.clone(),
      skyHorizon: U.uSkyHorizon.value.clone(),
      sunI: lights ? lights.sun.intensity : 1,
      hemiI: lights ? lights.hemi.intensity : 1,
    };
    this.cityGroup = city ? city.group : null;
    if (this.cityGroup) this.cityGroup.matrixAutoUpdate = false;
    if (collision) collision.groundFn = (x, z) => this.groundHeight(x, z);
    this.origin.onShift(() => { this.stats.shifts++; this.placeCity(); });
    this.toNearPass = () => {
      this.planet.setPass(true);
      this.scene.add(this.planet.mesh);
    };
  }

  get anchored() { return this.origin.anchored; }

  onAnchorChange(fn) { this.anchorListeners.push(fn); }

  // ------------------------------------------------------------- collision
  // Ground (or water) height under local (x, z). Inside the flat city zone in
  // anchored mode this is the legacy plane; everywhere else the planet.
  groundHeight(x, z) {
    const o = this.origin;
    if (o.anchored && x * x + z * z < PLANET.flatRadius * PLANET.flatRadius * 0.95) {
      return z < WORLD.coastZ ? WATER_LEVEL : 0;
    }
    _v.set(x, 0, z);
    o.localToGlobal(_v, _v);
    const r = _v.length();
    const alt = r - PLANET.radius;
    if (alt > MAX_TERRAIN_HEIGHT + 500) return -(alt - MAX_TERRAIN_HEIGHT); // cheap lower bound
    const rs = surfaceRadius(_v.x / r, _v.y / r, _v.z / r);
    return rs - r;
  }

  // ----------------------------------------------------------- floating origin
  // Called after the physics sub-steps, before anything is placed/rendered.
  afterPhysics(playerLocal) {
    const wasAnchored = this.origin.anchored;
    const shifted = this.origin.update(playerLocal, this.playerG);
    if (shifted && wasAnchored !== this.origin.anchored) this.setAnchored(this.origin.anchored);
    return shifted;
  }

  setAnchored(anchored) {
    if (this.collision) this.collision.boxesEnabled = anchored;
    for (let i = 0; i < this.anchorListeners.length; i++) this.anchorListeners[i](anchored);
  }

  // Respawn / restart: snap back to the city frame.
  resetToCity() {
    if (!this.origin.anchored) {
      this.origin.anchorToCity();
      this.setAnchored(true);
    }
    this.regime.reset();
  }

  placeCity() {
    const g = this.cityGroup;
    if (!g) return;
    const o = this.origin;
    if (o.anchored) {
      g.matrix.identity();
    } else {
      _v.set(0, 0, 0);
      o.cityToLocal(_v, _v);
      g.matrix.makeRotationFromQuaternion(o.qInv).setPosition(_v);
    }
    g.matrixWorldNeedsUpdate = true;
  }

  // Local point -> city frame (for city culling while floating).
  toCity(p, out) {
    return this.origin.anchored ? out.copy(p) : this.origin.localToCity(p, out);
  }

  // ------------------------------------------------------------------ frame
  // camLocal: head position (local); vel: player velocity; look: view dir.
  update(dt, time, camLocal, vel, look) {
    const o = this.origin;
    this.camL.copy(camLocal);
    o.localToGlobal(camLocal, this.camG);
    this.global.setFromVector(this.camG);
    const camR = this.camG.length();
    const alt = camR - PLANET.radius;
    this.altitude = alt;
    this.regime.update(alt, dt);
    _up.copy(camLocal).sub(o.planetCenterLocal).normalize();
    this.up.copy(_up);
    o.globalDirToLocal(SUN_G, _sun);
    const sunEl = _sun.dot(_up);
    this.updateEnvironment(alt, sunEl);

    // Terrain streaming: fully hazed distance for a horizontal view.
    const hazeK = Math.exp(-Math.max(0, alt) / PLANET.groundHazeHeight);
    const visDist = 2.6 / Math.max(1e-300, this.base.fogDensity * hazeK) + 1500;
    this.planet.update(camLocal, vel, look, visDist);
    this.scheduler.run();
    this.stats.genMs = this.scheduler.lastMs;
    this.stats.queue = this.scheduler.pending;

    // City: near pass when close, far pass when distant, hidden when tiny.
    if (this.cityGroup) {
      this.toCity(camLocal, _v2);
      const d = Math.sqrt(_v2.x * _v2.x + _v2.y * _v2.y + _v2.z * _v2.z);
      this.cityDistance = d;
      const near = d < 6000;
      this.cityGroup.visible = d < 60000;
      if (near !== this.cityNear || this.cityGroup.parent === null) {
        (near ? this.scene : this.farScene).add(this.cityGroup);
        this.cityNear = near;
      }
    }

    // Depth ranges.
    const pl = this.planet;
    const split = 2500;
    let nearF = Math.max(3000, Math.min(80000, pl.nearMax));
    if (this.cityGroup && this.cityNear) nearF = Math.max(nearF, this.cityDistance + 6000);
    nearF = Math.max(nearF, 8000); // legacy water plane / billboard clouds / deck split
    // Far pass starts just before the nearest far-pass object: terrain, the
    // far half of the cloud deck, the cloud shell and (when distant) the city.
    const deckSplit = Math.min(nearF, split * 2);
    let farN = pl.farMin < Infinity ? pl.farMin * 0.9 : Math.max(1, (camR - PLANET.radius - MAX_TERRAIN_HEIGHT) * 0.9);
    if (alt < 30000) farN = Math.min(farN, deckSplit * 0.9);
    if (alt > 8000) farN = Math.min(farN, Math.max(1, (alt - PLANET.cloudTop) * 0.9));
    // city extent (ground + water planes) is ~2.4 km from its centre
    if (this.cityGroup && !this.cityNear) farN = Math.min(farN, Math.max(1000, this.cityDistance - 3000));
    if (!(farN > 1)) farN = 1;
    const horizon = Math.sqrt(Math.max(0, camR * camR - PLANET.radius * PLANET.radius));
    let farF = Math.max(pl.farMax, horizon + 200000, 2 * farN + 1000);
    // Clouds: deck split at the near pass limit so distant peaks occlude it.
    this.clouds.update(time, this.camG, camLocal, alt, deckSplit, farF);
    farF = Math.max(farF, camR + PLANET.radius);
    this.ranges.nearN = this.camera ? this.camera.near : 0.05;
    this.ranges.nearF = nearF;
    this.ranges.farN = farN;
    this.ranges.farF = farF;
    // Sky + stars sit inside the far range.
    const skyR = Math.sqrt(farN * farF);
    this.sky.update(camLocal, o.planetCenterLocal, _up, _sun, alt, sunEl, skyR);
    const starVis = Math.max(smooth(12000, 45000, alt), (1 - smooth(-0.12, 0.05, sunEl)) * 0.8);
    this.stars.update(camLocal, o.qInv, skyR * 0.98, starVis);
  }

  updateEnvironment(alt, sunEl) {
    const b = this.base;
    const day = smooth(-0.14, 0.06, sunEl);
    const space = smooth(6000, 60000, alt);
    const white = this.clouds.whiteout;
    U.uSunDir.value.copy(_sun);
    U.uCamAlt.value = Math.max(0, alt);
    U.uLowCloudFade.value = 1 - smooth(900, 2600, alt);
    // Sun: sunset orange low down, white above the atmosphere.
    _c.setRGB(1.35, 1.3, 1.25);
    // The shaders were tuned for the low sunset sun: tone the sun down as it
    // climbs (day side of the planet) so clouds and ground don't blow out.
    const highSun = 1 - 0.45 * smooth(0.2, 0.8, sunEl);
    U.uSunColor.value.copy(b.sunColor).lerp(_c, space).multiplyScalar((0.15 + 0.85 * day) * highSun);
    // Ambient fades with the sky: dim in space, dark at night.
    const amb = (1 - 0.8 * space) * (0.08 + 0.92 * day);
    U.uAmbientSky.value.copy(b.ambSky).multiplyScalar(amb);
    U.uAmbientGround.value.copy(b.ambGround).multiplyScalar(amb);
    U.uSkyTop.value.copy(b.skyTop).multiplyScalar(1 - 0.9 * space);
    U.uSkyHorizon.value.copy(b.skyHorizon).multiplyScalar((1 - 0.7 * space) * (0.1 + 0.9 * day));
    // Haze: sunset fog near the ground, thin blue high up, cloud-white inside the deck.
    _c.setRGB(0.32, 0.42, 0.6);
    U.uFogColor.value.copy(b.fogColor).lerp(_c, smooth(2000, 30000, alt)).multiplyScalar(0.1 + 0.9 * day);
    if (white > 0) {
      _c.setRGB(0.78, 0.66, 0.62).multiplyScalar(0.2 + 0.8 * day);
      U.uFogColor.value.lerp(_c, white);
    }
    U.uFogDensity.value = b.fogDensity * (1 + white * 18);
    this.sky.uniforms.uExposure.value = 1;
    const fog = this.scene.fog;
    if (fog) {
      fog.color.copy(U.uFogColor.value);
      fog.density = U.uFogDensity.value * Math.exp(-Math.max(0, alt) / PLANET.groundHazeHeight);
    }
    if (this.lights) {
      const { sun, hemi } = this.lights;
      sun.position.copy(_sun).multiplyScalar(100);
      sun.intensity = b.sunI * (0.1 + 0.9 * day);
      sun.color.copy(U.uSunColor.value).multiplyScalar(1 / 1.35);
      hemi.intensity = b.hemiI * amb;
      this.farSun.position.copy(sun.position);
      this.farSun.intensity = sun.intensity;
      this.farSun.color.copy(sun.color);
      this.farHemi.color.copy(hemi.color);
      this.farHemi.groundColor.copy(hemi.groundColor);
      this.farHemi.intensity = hemi.intensity;
    }
  }

  // Generate everything the current view needs right now (start / respawn).
  prime(camLocal, vel, look) {
    const hazeK = Math.exp(-Math.max(0, this.altitude) / PLANET.groundHazeHeight);
    const visDist = 2.6 / Math.max(1e-300, this.base.fogDensity * hazeK) + 1500;
    this.planet.prime(camLocal, vel, look, visDist);
  }

  render() {
    const pl = this.planet;
    const mesh = pl.mesh;
    // far pass
    pl.setPass(false);
    this.farScene.add(mesh);
    this.partition.render(this.farScene, this.scene, this.ranges, this.toNearPass);
  }

  setQuality(p) {
    this.planet.setBudget(p.leaves, p.high, p.split);
    this.clouds.setLayers(p.clouds);
    this.stars.setCount(p.stars);
    this.cityDrawDistance = p.cityDist;
  }

  // Everything interesting for the debug overlay / automation.
  snapshot() {
    const p = this.planet.stats;
    return {
      altitude: this.altitude,
      regime: this.regime.name,
      speedScale: this.regime.speedScale,
      gravityScale: this.regime.gravityScale,
      anchored: this.origin.anchored,
      shifts: this.origin.shiftCount,
      sector: [this.global.sx, this.global.sy, this.global.sz],
      chunks: { ...p },
      genMs: this.stats.genMs,
      queue: this.stats.queue,
      ranges: { ...this.ranges },
      originDistance: ORIGIN.shiftDistance,
    };
  }
}
