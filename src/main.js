import { ACESFilmicToneMapping, FogExp2, PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderer } from 'three';
import { RENDER, WORLD } from './config.js';
import { CollisionWorld } from './physics/collision.js';
import { Input } from './input/input.js';
import { makeSky } from './world/sky.js';
import { buildCity } from './world/city.js';
import { buildAtmosphere } from './world/atmosphere.js';
import { Perf } from './core/perf.js';
import { Game } from './game.js';
import { GameAudio } from './audio/audio.js';
import { buildGoonGeometries, createAtlas } from './enemy/goonModel.js';
import { loadReferenceImage } from './core/assets.js';
import { loadHandModels, loadNanoGauntlet } from './hud/hands.js';
import { loadSuitSockets } from './player/suit.js';
import { WorldManager } from './world/WorldManager.js';
import { AdaptiveQuality } from './core/quality.js';
import { applyWorldSave, serializeWorld } from './world/core/WorldSave.js';

const overlay = document.getElementById('overlay');
const vrBtn = document.getElementById('enter-vr');
const deskBtn = document.getElementById('play-desktop');
const status = document.getElementById('status');

const renderer = new WebGLRenderer({ antialias: RENDER.antialias, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.xr.setFramebufferScaleFactor(RENDER.framebufferScale);
renderer.xr.setFoveation(RENDER.foveation);
renderer.info.autoReset = false;
document.body.appendChild(renderer.domElement);

const scene = new Scene();
// far is only the base XR render-state value: WorldManager renders a near and a
// far depth pass with their own planes (see world/render/DepthPartition.js).
const camera = new PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 20000);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

let game = null;
let world = null;
let quality = null;
let started = false;
const _cam = new Vector3();
const _look = new Vector3();

async function init() {
  status.textContent = 'Building sky…';
  const sky = await makeSky(renderer);
  // No scene.background: the sky dome in the far pass draws the sky at every altitude.
  scene.environment = sky.env;
  scene.fog = new FogExp2(sky.fogColor.clone().multiplyScalar(0.92), WORLD.fogDensity);

  status.textContent = 'Building city…';
  await new Promise((r) => setTimeout(r, 0));
  const half = WORLD.citySize / 2;
  const collision = new CollisionWorld({
    minX: -half - 64, minZ: -half - 64, size: WORLD.citySize + 128, cell: WORLD.hashCell, coastZ: WORLD.coastZ,
  });
  const city = buildCity(scene, collision);
  const atmo = buildAtmosphere(scene, sky, city.group);

  status.textContent = 'Building planet…';
  await new Promise((r) => setTimeout(r, 0));
  world = new WorldManager({ renderer, scene, camera, sky, city, collision, lights: { sun: atmo.sun, hemi: atmo.hemi } });
  scene.add(world.planet.mesh);
  window.__world = world;

  status.textContent = 'Carving Log Goons…';
  const ref = await loadReferenceImage(renderer);
  if (ref.spriteTexture) console.info('Far-LOD sprite: KTX2');
  const goonAssets = {
    atlas: createAtlas(ref.image),
    parts: buildGoonGeometries(),
    spriteImage: ref.spriteImage,
    spriteTexture: ref.spriteTexture,
  };

  const [skinnedHands, nano, suitSockets] = await Promise.all([loadHandModels(), loadNanoGauntlet(), loadSuitSockets()]);
  const handModels = { ...(skinnedHands || {}), nano };
  const input = new Input(renderer, renderer.domElement);
  const perf = new Perf(renderer);
  const audio = new GameAudio();
  game = new Game({ renderer, scene, camera, input, collision, city, perf, audio, goonAssets, handModels, suitSockets, world });
  window.__game = game; // handy in the console / for automated smoke tests
  window.__stats = city.stats;
  quality = new AdaptiveQuality(perf, (preset) => {
    world.setQuality(preset);
    game.particles.spawnScale = preset.particles;
    renderer.xr.setFoveation(preset.foveation);
  });
  game.quality = quality;
  window.__quality = quality;
  // Save model hooks (only changes are stored; terrain is regenerated from seed).
  window.__save = () => serializeWorld(game);
  window.__load = (save) => applyWorldSave(game, save);

  // Stream the terrain around the start position before the first frame.
  camera.updateMatrixWorld(true);
  game.rig.updateMatrixWorld(true);
  camera.getWorldPosition(_cam);
  world.update(0, 0, _cam, game.body.vel, _look.set(0, 0, -1));
  world.prime(_cam, game.body.vel, _look);

  // Warm up: compile every shader (both depth passes) before the first real frame.
  renderer.compile(scene, camera);
  renderer.compile(world.farScene, camera);

  let last = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    if (started) game.frame(dt);
    camera.getWorldPosition(_cam);
    camera.getWorldDirection(_look);
    world.update(dt, game.time, _cam, game.body.vel, _look);
    renderer.info.reset();
    world.render();
    perf.calls = renderer.info.render.calls;
    perf.tris = renderer.info.render.triangles;
    perf.frame(dt, performance.now() - now);
    quality.update(dt, dt * 1000);
  });

  status.textContent = `${city.stats.buildings} buildings · ${city.stats.chunks} chunks · ${city.stats.tris.toLocaleString()} tris`;
  deskBtn.disabled = false;
  deskBtn.textContent = 'Play on desktop';
  if (navigator.xr && (await navigator.xr.isSessionSupported('immersive-vr').catch(() => false))) {
    vrBtn.disabled = false;
    vrBtn.textContent = 'Enter VR';
  } else {
    vrBtn.textContent = window.isSecureContext ? 'VR not available' : 'VR needs HTTPS';
  }
}

function start() {
  started = true;
  overlay.classList.add('hidden');
  if (game.onStart) game.onStart();
}

vrBtn.addEventListener('click', async () => {
  game.audio.start(); // inside the user gesture, before any await
  try {
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor'],
    });
    await renderer.xr.setSession(session);
    if (session.updateTargetFrameRate && session.supportedFrameRates) {
      game.perf.setRate(RENDER.targetFps);
    }
    session.addEventListener('end', () => {
      overlay.classList.remove('hidden');
      vrBtn.textContent = 'Enter VR';
    });
    start();
  } catch (e) {
    status.textContent = `Could not start VR: ${e.message}`;
  }
});

deskBtn.addEventListener('click', () => {
  game.audio.start();
  game.input.wantPointerLock = true;
  renderer.domElement.requestPointerLock();
  start();
});

init().catch((e) => {
  console.error(e);
  status.textContent = `Error: ${e.message}`;
});
