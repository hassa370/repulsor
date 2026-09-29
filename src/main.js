import { ACESFilmicToneMapping, FogExp2, PerspectiveCamera, Scene, SRGBColorSpace, WebGLRenderer } from 'three';
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
import { loadHandModels } from './hud/hands.js';

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
const camera = new PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 3000);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

let game = null;
let started = false;

async function init() {
  status.textContent = 'Building sky…';
  const sky = await makeSky(renderer);
  scene.background = sky.texture;
  scene.environment = sky.env;
  scene.fog = new FogExp2(sky.fogColor.clone().multiplyScalar(0.92), WORLD.fogDensity);

  status.textContent = 'Building city…';
  await new Promise((r) => setTimeout(r, 0));
  const half = WORLD.citySize / 2;
  const collision = new CollisionWorld({
    minX: -half - 64, minZ: -half - 64, size: WORLD.citySize + 128, cell: WORLD.hashCell, coastZ: WORLD.coastZ,
  });
  const city = buildCity(scene, collision);
  buildAtmosphere(scene, sky);

  status.textContent = 'Carving Log Goons…';
  const ref = await loadReferenceImage(renderer);
  if (ref.spriteTexture) console.info('Far-LOD sprite: KTX2');
  const goonAssets = {
    atlas: createAtlas(ref.image),
    parts: buildGoonGeometries(),
    spriteImage: ref.spriteImage,
    spriteTexture: ref.spriteTexture,
  };

  const handModels = await loadHandModels();
  const input = new Input(renderer, renderer.domElement);
  const perf = new Perf(renderer);
  const audio = new GameAudio();
  game = new Game({ renderer, scene, camera, input, collision, city, perf, audio, goonAssets, handModels });
  window.__game = game; // handy in the console / for automated smoke tests
  window.__stats = city.stats;

  // Warm up: compile every shader before the first real frame to avoid hitches.
  renderer.compile(scene, camera);

  let last = performance.now();
  renderer.setAnimationLoop((t) => {
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    if (started) game.frame(dt);
    renderer.info.reset();
    renderer.render(scene, camera);
    perf.calls = renderer.info.render.calls;
    perf.tris = renderer.info.render.triangles;
    perf.frame(dt, performance.now() - now);
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
