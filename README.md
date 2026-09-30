# Repulsor

A WebXR flying action game for Meta Quest 3. Fly like Iron Man over a procedural sunset city and blast waves of wooden, log-headed **Log Goons** off the rooftops.

- Three.js **0.186.1** (pinned), vanilla JS, Vite 8. There are no CDNs, remote APIs or keys, and the game runs offline once loaded.
- Uses WebXR `immersive-vr` with a `local-floor` reference space and a desktop fallback for testing.
- Physics is a small custom module: a fixed 90 Hz step with render interpolation, capsule-vs-AABB collision on a spatial hash, and pooled "ragdoll-lite" debris.
- All geometry and textures are generated at startup. A few optional asset slots (see [Optional assets](#optional-assets)) let you drop in real art.

## Run

```bash
git clone https://github.com/hassa370/repulsor.git
cd repulsor
npm install
npm run dev        # HTTPS dev server on https://<your-LAN-ip>:5173 (self-signed cert)
npm test           # physics + model-budget unit tests (node --test)
npm run build      # static site in dist/
npm run preview    # serve dist/ over HTTPS to double-check the build
```

### Open it on a Quest 3

1. Put the PC and the Quest on the same Wi-Fi network.
2. Run `npm run dev` and note the **Network** URL it prints, for example `https://192.168.1.23:5173`.
3. In the Quest Browser, open that URL. The certificate is self-signed, so choose **Advanced → Proceed**. WebXR requires HTTPS, which is why the dev server uses `@vitejs/plugin-basic-ssl`.
4. Press **Enter VR**. You start standing on a rooftop helipad, and wave 1 arrives a few seconds later.

### Deploy

`npm run build` writes a fully static `dist/` with relative paths (`base: './'`), so you can host it anywhere:

- **GitHub Pages**: push `dist/` to a `gh-pages` branch, or upload it with the `actions/upload-pages-artifact` action.
- **Netlify**: drag and drop `dist/`, or set the build command to `npm run build` and the publish directory to `dist`.

## Controls

All bindings live in one object, `BINDINGS` in `src/config.js`.

| Action | Quest 3 Touch Plus | Desktop |
|---|---|---|
| Palm thrusters (analog) | **Left / right grip** fires that hand's repulsor. It pushes you away from the palm: palms down = lift, palms back = forward, one hand = boost in that direction | `Space` = full, `Q` = hover level |
| Steer / strafe | **Left thumbstick** | `W A S D` |
| Snap turn 30° | **Right thumbstick** left/right | `Z` / `C` (mouse = free look) |
| Fire left / right repulsor | **Left / right trigger**: tap = quick shot, hold = charged shot (fires on release) | Right / left mouse button (hold to charge) |
| Boost ×2.5 (drains a meter) | **A** while squeezing a grip: the palms burn harder and both boot thrusters light, pushing along your hand thrust (half the boost from the palms, half from the boots) | `Shift` |
| Unibeam (10 s cooldown) | **B** | `E` |
| Comfort vignette on/off | **X** | `V` |
| Pause menu (debug overlay lives here) | **Y** | `Tab` / `P` |
| Menu navigate / choose | Right stick up/down, **A** or right trigger | Arrow keys, `Enter` / click |

**Flight (VR, default "HANDS" mode).** Each controller is a thruster nozzle. Squeeze its **grip** and its repulsor fires out of the palm, along where that controller points, pushing you the opposite way:

- **Lift:** point both hands down.
- **Fly forward:** point your hands backward, Iron Man style.
- **Brake / fly backward:** point your hands forward.
- **Boost in one direction:** squeeze just one hand.
- **Steer with your eyes:** where you look gently bends your flight path (`FLIGHT.gazeSteer`).

The gauntlet sits on the controller with its palm facing where the controller points, so the fire from the palm shows exactly where the thrust comes from.

**Fireballs.** Tap a trigger for a fireball, or hold it to grow a big one in your palm and release to throw it. Fireballs leave a trail of embers and smoke and explode on impact. Charged fireballs splash nearby goons and buildings.

**Destructible buildings.** Fireballs, charged fireballs, the unibeam and smashing through all damage the building they hit, leaving scorch holes and debris. Health is `4 + height x 0.1 + footprint / 300`, so a mid-size building takes about 13 quick fireballs or 3 charged ones. At zero health the building collapses into the ground in a dust cloud: goons on its roof fall, and a rubble slab remains. Restarting the game rebuilds the city.

**Smash through buildings (Omni-Man style).** Hit a wall faster than `FLIGHT.smashSpeed` (24 m/s) and you punch straight through:

- concrete chunks and dust fly out, and a hole with a molten edge stays on each face, in and out;
- you keep `smashKeep` (80 %) of your speed per wall;
- slam into the ground or a roof faster than `craterSpeed` (22 m/s) for a crater, a shockwave, and damage to every goon within `craterRadius`.

**Finding and hitting goons**
- Every goon has a glowing marker above it, drawn through walls.
- Goons outside your view show as red pips at the edge of your vision, pointing the way.
- With a finger on a trigger, a laser sight comes out of that hand, and a red lock-on appears on the goon aim assist will hit.
- Shots bend slightly toward a goon near your aim (`WEAPONS.assistDeg`, `assistRadius`, `homingQuick`, `homingCharged`).

## Tuning flight

Every constant is in `src/config.js` under `FLIGHT`. The most useful ones:

| Constant | Effect |
|---|---|
| `thrustMax` | Acceleration at full grip (m/s²). |
| `hoverLo`, `hoverHi` | The grip range that holds a steady hover (default 0.2–0.45). |
| `gripSmoothing`, `gripDeadzone`, `lookSmoothing` | Input smoothing. Lower `lookSmoothing` makes the thrust direction calmer when you look around. |
| `airBrake` | How quickly horizontal drift stops while hovering with the stick centred. |
| `flightMode`, `handThrustMax`, `palmSign`, `gazeSteer` | Palm-thruster flight: thrust per hand, which side of the hand fires (set `palmSign: -1` if it's backwards on your controllers), and how strongly the path follows your gaze. |
| `smashSpeed`, `smashKeep`, `craterSpeed`, `craterRadius` | Smashing through buildings and superhero landings. |
| `thrustForwardGain`, `thrustUpBias` | How quickly the thrust vector tilts from "up" toward "look direction" as grip increases. |
| `dragQuadratic`, `dragLinear` | Natural top speed. The defaults give ≈ 60 m/s at full thrust and ≈ 100 m/s when boosting. |
| `hoverAssist`, `hoverWindow` | How strongly vertical speed is damped when thrust roughly cancels gravity. |
| `strafeAccel` | Left-stick authority. |
| `restitution`, `wallFriction`, `impactHapticSpeed` | How building impacts feel. |
| `bankEnabled`, `bankMax`, `bankGain` | Camera roll into turns (clamped to about 6°; also togglable in the pause menu). |
| `recoilQuick`, `recoilCharged` | Push-back from firing. |
| `physicsHz`, `maxSubSteps` | Fixed-step rate. |

`npm test` checks the thrust math: pure lift at light grip, the hover plateau, full grip climbs forward, a look-down dive, a drag-limited top speed, roof landings and wall reflection.

Enemies, waves and weapons have their own tables in the same file (`ENEMY`, `WEAPONS`, `PLAYER`), as do the city and fog (`WORLD`) and rendering (`RENDER`).

## Optional assets

| File | Used for | If missing |
|---|---|---|
| `public/textures/enemy_face.png` | The Log Goon reference. The face region (`FACE_CROP` in `config.js`, normalised `u0,v0,u1,v1`) is cropped into the enemy atlas. If the image has a transparent background it also becomes the far-LOD sprite. | A carved face and sprite are painted procedurally. |
| `public/hdri/sunset_1k.hdr` | A 1K CC0 sunset HDRI from [Poly Haven](https://polyhaven.com/hdris) (any sunset works, for example "The Sky is On Fire"). It becomes the background and the precomputed PMREM environment, and the fog colour is sampled from its horizon. Set `WORLD.sunDir` so the sun direction matches the HDRI. | A procedural sunset sky with streaky clouds is painted once at startup. |
| `public/models/nano-gauntlet.bin` | The Nano Gauntlet model you supplied ("Nano Gauntlet" by DamaskProps), reduced from 1.07M to about 18k triangles and stored in a compact binary. When loaded, parts are painted automatically: red armour, gold hinges and wrist bands, glowing Infinity-Stone gems. A palm repulsor is added, and the left hand is a mirror of the right. Adjust the fit with `NANO_FIT` in `src/hud/hands.js`. Delete the file to fall back to the skinned hands below. | Skinned armoured hands. |
| `public/models/hand-left.glb`, `hand-right.glb` | Skinned hand models from the WebXR `generic-hand` profile (MIT, see `public/models/LICENSE-hands.md`). They're painted as Iron Man-style gauntlets in code: red plates, gold knuckles, a gunmetal palm, joint seams, a wrist cuff and forearm, and a glowing palm repulsor. Fingers relax at rest and open flat when you thrust or fire. Adjust the fit on the controller with `HAND_FIT` in `src/hud/hands.js`. | A simple armoured block. |
| `public/textures/enemy_sprite.ktx2` | A pre-compressed far-LOD sprite in KTX2 / Basis with mipmaps. Loaded with `KTX2Loader`; the transcoder is served from `public/basis/`. Create it with `toktx --t2 --encode uastc --genmipmap enemy_sprite.ktx2 enemy_sprite.png` | Falls back to the PNG or the painted sprite. |

> **Note:** the HDRI and the reference PNG are not in the repo. The environment used to build this could not reach polyhaven.com, and `enemy_face.png` was not present. Drop them into the paths above; no code changes are needed.

## 3D asset pipeline

Raw downloads live in `public/models/source/` (never copied into `dist/`). `npm run assets` turns them into
small GLBs in `public/models/` and prints a before/after report (also saved as `public/models/assets-report.json`):

| Step | What it does |
| --- | --- |
| Clean-up | dedup, weld, prune; drops normal/roughness/AO maps, tangents, unused morph targets |
| Geometry | meshopt reorder + `EXT_meshopt_compression` |
| Textures | KTX2 / Basis ETC1S with mipmaps, max 1024 px (512 px for Tung, the AK and cars) |
| Scale / pivot | metres, pivot centred at the feet (the AK is centred, 0.9 m long) |
| FBX | the office tower is converted with FBX2glTF (npm `fbx2gltf`) |

Outputs:

| File | Notes |
| --- | --- |
| `ironman.glb` | 1.80 m tall, faces +Z, one mesh and one material |
| `tung.glb` | nodes `lod0` (~3k tris) and `lod1` (~800 tris), 1.80 m tall, faces +Z |
| `ak47.glb` | skinned, with clips `idle`, `draw`, `reload`, `run`, `shoot` and `walk` |
| `ak47_static.glb` | bind pose baked, with the spare magazine and casings removed (for instancing) |
| `cars/<type>.glb` | 10 types; body, wheels, glass and lights merged into one mesh with one 512 px atlas material. Nodes `lod0`/`lod1` (~25%). Faces -Z; `scene.extras.size` = w, h, l |
| `office.glb` | 9 storeys; frame, interior and glass materials; ~630k tris of chairs dropped. `scene.extras.levels` holds the floor heights, and the glass faces +Z |

At runtime, `src/core/gltf.js` loads them with `GLTFLoader` + `MeshoptDecoder` + `KTX2Loader`. The Basis
transcoder is in `public/basis/`. To inspect any output (size, tris, draws, texture MB, clips), run
`npm run dev` and open `/viewer.html`; it works in the Quest browser too. `npm test` checks the budgets.

## Performance

Performance is the top priority. The budget is a locked 72 fps minimum on Quest 3, with 90 fps as the target.

### How the rules are enforced

- **Draw calls.** The whole city is at most 16 chunk meshes sharing one facade shader, plus a few instanced prop meshes. Goons use one `InstancedMesh` per part type (7), plus one silhouette LOD and one sprite LOD. All glow FX (blasts, trails, muzzle flashes, charge orbs, impacts, shockwave rings, beam halo) share one additive batch. Splinters and sparks are GPU particle systems (one draw each).
- **No dynamic lights for FX.** The whole scene has exactly one `DirectionalLight` and one `HemisphereLight`. There are no shadows and no post-processing.
- **Culling.** Three.js frustum-culls each city chunk, and a distance cull (`WORLD.drawDistance`) is applied per chunk. Goons get a view-cone and distance cull (`ENEMY.cullDistance`). LODs switch at 60 m (full parts → silhouette) and 150 m (sprite); the boss uses 2.5× those distances.
- **AI cost.** The goon state machine thinks at 20 Hz with staggered timers, and at 4 Hz beyond `ENEMY.farDistance`.
- **Allocations.** Enemies, bats, blasts, debris, particles, flashes and sound voices are all pooled. Hot loops reuse module-level `Vector3`/`Matrix4` temps and have no closures and no array resizing. The only per-event objects are Web Audio `AudioBufferSourceNode`s (one-shot by spec) and HUD text strings, which are redrawn at most 10×/s and only when a value changes.
- **XR settings.** `renderer.xr.setFoveation(1)` and `setFramebufferScaleFactor(RENDER.framebufferScale)` are applied. The game requests 90 Hz. If the display interval stays about 12% over budget for 2 s it drops to 72 Hz, and it comes back only after 30 s of headroom (at most once, so it can't oscillate). See `src/core/perf.js`.
- **Shimmer control.** Facade windows use box-filtered patterns and fade to their average once a window cell covers only a few pixels. Water normals flatten with distance. Both reduce aliasing at 90 Hz.

### Texture memory (estimate, well under 64 MB)

| Texture | Size |
|---|---|
| Enemy atlas (512² RGBA + mips) | ~1.4 MB |
| Sky (512×256 + mips; background cube conversion) | ~1.5 MB |
| PMREM environment (half-float) | ~3–6 MB |
| Water normal map (256² + mips) | 0.35 MB |
| HUD canvases (wrist, message, menu, debug) | ~2.7 MB |
| Helipad and sprite | < 0.2 MB |

That comes to roughly **10–12 MB**.

### Numbers from the debug overlay

These were measured in headless Chromium with software GL on desktop, which renders one view. Draw calls and triangles do not depend on the hardware, but fps does, so measure fps on the headset.

| Scene | Draw calls (1 view) | Triangles (1 view) |
|---|---|---|
| Start rooftop, wave 1 | 22–25 | ~105–120k |
| Worst case: 33 goons alive + 46 debris pieces + ~650 particles, looking over downtown | 35 | ~125k |

In VR, WebGLRenderer draws each eye separately (no multiview in three.js's WebGL path), so the numbers roughly double. After the city and traffic upgrade, the emulated Quest 3 view measured **58–62 draw calls** and **275–290k triangles**. Both are inside the budgets of 100 draw calls and 500k triangles.

Simulation CPU cost (physics, AI, animation and instance packing, without GL) was about 0.08 ms per frame on wave 1 and about 0.2 ms per frame in the worst case above, both measured on desktop.

### Profiling on the Quest itself (OVR Metrics Tool)

1. Install **OVR Metrics Tool** from the Meta Horizon Store (it is free), or sideload it with `adb install`.
2. Open it on the headset and enable the **Performance HUD** overlay. The basic preset shows FPS, GPU/CPU level and GPU utilisation; the advanced preset adds app GPU time and stale frames.
3. Launch Repulsor in the Quest Browser and enter VR.
4. Watch **FPS**: it should sit at 90, or at 72 after an automatic fallback. **Stale frames** should be near 0 and **GPU utilisation** should stay below ~90%.
5. Compare against the in-game **debug overlay** (Y → Debug overlay: fps, frame time, CPU ms, draw calls, triangles, active/visible enemies, particles).
6. If GPU-bound, the cheapest levers are `RENDER.framebufferScale` (try 0.9), `WORLD.drawDistance`, `WORLD.fogDensity` (more fog hides more) and `ENEMY.lodSilhouette`.

## Code map

```
src/
  config.js            all bindings + tunables
  main.js              renderer / XR session / boot
  game.js              player rig, fixed-step loop, game rules, menu, death
  input/input.js       Quest controllers + keyboard/mouse -> one input state
  physics/collision.js AABB spatial hash: capsule push-out, raycast (DDA), point tests
  physics/player.js    thrust model, drag, hover assist, walking
  world/sky.js         HDRI or procedural sunset, PMREM, fog colour
  world/city.js        seeded road grid, towers + setbacks, facade shader, props, streetlights
  world/atmosphere.js  water shader, horizon hills, cloud billboards, the two lights
  enemy/goonModel.js   512px atlas + primitive part geometry (460 tris per goon, baked shading, ember eyes)
  enemy/pose.js        procedural animation -> per-part matrices
  enemy/goonRenderer.js instanced parts, silhouette + sprite LODs, one shared material
  enemy/enemies.js     pool, 20 Hz state machine, leaps/climb/throw/lunge/slam
  enemy/bats.js        spinning bat projectiles (shootable), boss fire bats
  enemy/debris.js      ragdoll-lite pieces
  enemy/waves.js       wave director + boss waves
  weapons/weapons.js   quick/charged repulsors, splash, unibeam, crosshairs
  fx/sprites.js        additive glow-capsule batch
  fx/particles.js      GPU-simulated splinters + sparks
  hud/hud.js           wrist display, vignette/damage ring, messages, menu, debug
  audio/audio.js       synthesised sounds, 16 pooled voices, wind + thruster loops
```
