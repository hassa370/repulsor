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

## Seamless world: surface ↔ orbit

The city is no longer the whole world. It is a small anchored region on a procedurally generated, scaled planet (`PLANET.radius` = 500 km). You can fly out of it, climb through the cloud deck, see the curvature, reach orbit and deep space, turn around, and land again, with no loading screens and no world boundary. Only a small bubble around the player exists at any moment. Everything else is either a coarse chunk of the same terrain quadtree or pure math (seeded noise).

```
WorldManager (src/world/WorldManager.js)
├── FloatingOrigin        core/FloatingOrigin.js   local frame <-> planet-centric float64 frame, sectors
├── GenerationScheduler   core/GenerationScheduler.js   time-sliced procedural work (1 ms / frame)
├── PlanetSurface         planet/PlanetSurface.js  cube-sphere quadtree terrain, BatchedMesh pool
│   ├── CubeSphere        planet/CubeSphere.js     face bases, node keys, chunk topology + skirts
│   └── TerrainGenerator  planet/TerrainGenerator.js  deterministic height/colour, city flat zone
├── Sky                   planet/Sky.js            one-pass sky dome: sunset texture + analytic scattering
├── Clouds                planet/Clouds.js         3-sheet cloud deck, whiteout, orbit cloud shell
├── StarField             space/StarField.js       one THREE.Points draw call
├── FlightRegime          FlightRegime.js          altitude -> regime, speed / gravity scale
├── DepthPartition        render/DepthPartition.js near + far depth passes
└── WorldSave             core/WorldSave.js        seed + position + changes only
AdaptiveQuality           src/core/quality.js      HIGH / MEDIUM / LOW with hysteresis
```

### Coordinates and the floating origin

- **G** is the planet-centric frame (float64 on the CPU, unbounded). **C** is the city frame, which is G shifted up by one radius because the city sits on the +Y pole. **L** is the local render/simulation frame: `p_G = O + Q · p_L`.
- **Anchored mode** applies inside `ORIGIN.anchorRadius` (3 km) and below `ORIGIN.anchorAltitude` (3 km). Here L equals C exactly, so the destructible AABB buildings, the spatial hash, enemies, waves and every legacy system run unchanged. float32 error inside the bubble is ≤ 0.5 mm.
- **Floating mode** applies everywhere else. When the player gets more than `ORIGIN.shiftDistance` (1000 m) from the origin, the origin jumps to the player. `Q` is parallel-transported so local +Y is the planet's up there, and gravity stays −Y. A shift maps every stored point `p → M p + t` and every direction `d → M d`, and each system applies it in place: player body, blasts, GPU particle ring buffers, flashes, shockwaves, terrain chunk matrices and the city group. It costs O(active objects) and allocates nothing.
- **View re-levelling.** The rig keeps a pure yaw because local-floor must stay level. The tiny tilt left by re-levelling (≤ 0.12° per shift) goes into `game.levelQ` and eases out over about a second, so the horizon never pops.
- **Returning.** Re-entering the bubble (with 400 m hysteresis) snaps the frame back to exactly the city frame and wakes combat.
- **Global position.** `GlobalPosition` stores integer sectors (1000 km) plus an offset, for the HUD and future space sectors.

### Streaming terrain (one draw call per pass)

- The planet is a **cube-sphere quadtree** (equal-angle warp). Every chunk is 17×17 vertices plus skirts (512 + 128 triangles), so LOD comes from chunk size alone: from 785 km root faces down to 770 m chunks with 48 m spacing at `TERRAIN.maxLevel` 10. The finest noise octave is 520 m, so finer meshes would add no information.
- **Budgeted best-first selection.** Chunks split while `distance < splitFactor × size`, most urgent first, stopping at the budgets. Urgency is size over distance, using the nearer of the camera and the velocity-predicted camera (`TERRAIN.lookaheadSeconds`), with a boost for chunks in view. Chunks beyond the ocean horizon or fully lost in haze are neither drawn nor split, so they cost nothing.
- **Pool.** There are `WORLD_BUDGET.maxSurfaceChunks` (64) slots in one `BatchedMesh`, regenerated in place with LRU eviction. No Mesh or geometry is created while flying. Missing chunks fall back to the nearest ready ancestor (coverage never has holes), and skirts hide LOD cracks.
- **Generation** is time-sliced, coarse-gap-first then nearest-first. It takes about 0.28 ms per chunk on desktop. The wish list is rebuilt every frame, so work for places you already passed simply disappears.
- **Collision** is analytic (the same height function), so there are no terrain collision bodies at all. City boxes exist only in anchored mode.
- **The city.** Inside `PLANET.flatRadius` (2.4 km) the terrain *is* the city's y = 0 plane (and the sea south of the coast), so the city ground, water plane and legacy collision line up with it to the millimetre. Beyond that it relaxes into hills and mountains by 7 km.
- **Determinism.** Height is a pure function of `(PLANET.seed, direction)`. The same coordinate always produces the same terrain at any LOD or chunk layout. Nothing generated is ever saved.

**Surface → orbit.** As you climb, the selected leaves get coarser and fewer: 11 high-detail chunks on the ground, 0 above ~10 km, and about 24 coarse chunks in orbit. The same system that was the ground under your feet becomes the planet sphere, and by orbit the surface cost is a handful of chunks. On the way back down, the velocity-predicted camera prefetches the chunks below you, and generation (coarse gaps first) refines them within a few hundred milliseconds.

### Depth: near + far passes

A single 0.05 m … 1000 km frustum would z-fight everywhere. `DepthPartition` renders two passes into one depth buffer, split with `gl.depthRange`:

- The **far pass** writes depth [0.5, 1]. It has the sky dome, stars, terrain chunks more than 2.5 km away, the far half of the cloud deck, the cloud shell, and the distant city.
- The **near pass** writes depth [0, 0.5]. It has everything else.

Each pass gets its own near/far planes, recomputed per frame from what is in it. In WebXR, only elements 10/14 of the runtime's per-eye projections are rewritten, and the session render state is never touched. There is no mid-frame clear, and transparent near FX still blend over the far pass.

### Atmosphere, clouds, stars

- **Sky dome.** This is one pass, drawn first in the far pass. Near the ground at the city it shows the original painted/HDRI sunset (one texture sample), rotated to keep its horizon level and its sun on the real sun. It crossfades to an analytic single-scattering approximation: 3-sample optical depth, Rayleigh-ish colour, sun-path extinction for the sunset tints, and a Mie glow. The sky goes blue, then dark blue, then black, and from orbit it becomes a thin glowing rim. The sun disk is drawn at every altitude.
- **Haze.** `applyFog` is now an exponential **height** fog integrated along the ray, with scale height `PLANET.groundHazeHeight`. At street level it equals the old exp² fog; from altitude the ground stays visible through thin haze.
- **Cloud deck.** Three stacked sheets make one draw call on a 30 km disc that follows you, bent to the exact curvature in the vertex shader. Coverage comes from one tileable noise texture, addressed by planet-fixed cube-face coordinates plus a low-frequency weather field. Inside the deck, fog thickens into a whiteout driven from the CPU. From about 8 km a low-poly cloud shell fades in and the deck fades out by 30 km.
- **Stars.** There are 2400 `THREE.Points` in the planet frame, centred on the camera inside the far pass. They are stable through every origin shift.
- **Lighting.** There are still exactly one directional sun and one hemisphere light (mirrored into the far pass for the distant city). The sun direction is fixed in the planet frame, so the terrain shows a real day/night terminator, with ambient light fading on the night side and in space.

### Flight regimes and speed

`FlightRegime` labels the altitude with hysteresis: SURFACE < 4 km < LOW_ATMOSPHERE < 15 km < HIGH_ATMOSPHERE < 60 km < ORBIT < 1500 km < SPACE. It also produces two scales, both 1 at the surface so city combat is unchanged:

- **`speedScale`** is a log-space smoothstep curve (`SPEED_CURVE`), low-passed. Thrust scales ×s and quadratic drag ×1/s, so top speed scales by about s while acceleration time stays the same. That is 60 m/s at the city, ~250 m/s at 6 km, ~8 km/s at 80 km and ~20 km/s at 200 km.
- **`gravityScale`** (`GRAVITY_CURVE`) fades to 0 in orbit.

Drag is integrated implicitly, so diving from orbital speed into thick air decelerates hard but can never reverse or explode. Wind audio fades with air density.

### Combat outside the anchor

Goons, bats and debris **sleep** outside the anchor bubble: no AI, physics, rendering or hit tests. Their state is kept as metadata and they resume on return. Waves pause, collapses pause, and decals are off (they live in the city group).

### Save model

`window.__save()` returns `{ version, worldSeed, globalPlayerPosition (sector + offset), modifiedChunks: { "earth/city/chunk_i_j": { destroyedBuildings } } }`. `window.__load(save)` re-applies it quietly. Terrain is never saved.

### Hard caps (`WORLD_BUDGET` in `src/config.js`)

| Cap | Value |
|---|---|
| Loaded terrain chunks (pool) | 64 |
| Displayed terrain chunks | 48 (38 / 28 on MEDIUM / LOW) |
| High-detail chunks (two finest levels) | 12 (8 / 6) |
| Detailed city chunk meshes | 16, distance culled; far-LOD boxes (1 draw) beyond |
| Active enemies / debris / physics capsules | 40 / 60 / 101 |
| Blasts | 64 |
| Particles (GPU ring buffers, oldest recycled) | 800; bursts ×0.7 / ×0.45 on MEDIUM / LOW |
| Explosions (shockwave rings) / flashes | 4 / 24 |
| Dynamic lights | 1 sun + 1 hemisphere, no FX lights, no shadows |
| Stars | 2400 (1600 / 1000) |
| Cloud sheets | 3 (2 / 1) |
| Procedural generation | 1.0 ms / frame |

### Measurements (not yet on a Quest)

These numbers come from headless Chromium with SwiftShader (software GL, one 480×300 view). They are **not Quest 3 numbers**: fps there was 5–15 because of software rasterisation. Draw calls, triangles, chunk counts and memory do not depend on the hardware, so they are the numbers below. In VR, draw calls and triangles roughly double (one render per eye). Profile fps on the headset with OVR Metrics Tool (see below).

| Phase | Altitude | Draw calls (1 view) | Triangles (1 view) | Chunks loaded / drawn / high | JS heap |
|---|---|---|---|---|---|
| Rooftop start / city flight | 45 m | 29–30 | 185k | 55 / 31 / 11 | 27–30 MB |
| 250 m/s flight out of the city (4 origin shifts) | 54 m | 28 | 180k | 64 / 30 / 11 | 27 MB |
| Climbing through the cloud deck | 1.5–2.6 km | 11 | 61k | 64 / 48 / 8→0 | 27 MB |
| High atmosphere | 50 km | 12 | 64k | 64 / 46 / 0 | 27 MB |
| Orbit | 205 km | 7–10 | 25–39k | 64 / 32–39 / 0 | 28 MB |
| Space | 1650 km | 7–8 | 15–36k | 64 / 5 / 0 | 28 MB |
| Re-entry → back on a city roof | 70 m | 29–30 | 170–178k | 64 / 32 / 11 | 27 MB |
| 3 more full ground ↔ 310 km loops | – | 26–31 | 167–180k | 64 / 24–33 / 0–11 | 26.6–27.9 MB (flat) |

Across 2285 origin shifts and about 2000 generated chunks, the chunk pool, node cache (≤ 260), scene object count (29) and heap all stayed flat. The local player position never exceeded ~1 km in floating mode once shifts ran per physics sub-step.

World update + streaming CPU cost was measured on desktop (Node, 6000 frames: surface flight → orbit → re-entry). The median is 0.03 ms per frame and p99 is 0.47 ms. 13 frames exceeded 2 ms (worst 6.4 ms, consistent with GC/JIT). Generating one chunk takes about 0.28 ms on desktop; expect roughly 3–4× that on a Quest 3, which is why generation is capped at 1 ms/frame.

**Adaptive quality** (`src/core/quality.js`) watches a 1 s rolling frame time against the current refresh budget:

- It steps down after 3 s at more than 108% of budget.
- It steps back up only after 20 s at less than 80% of budget.
- It waits 5 s after every change.

It is capability based, never user-agent based. Force a level with `?quality=high|medium|low`.

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
  world/city.js        seeded road grid, towers + setbacks, facade shader, props, streetlights, far-LOD boxes
  world/atmosphere.js  water shader, low cloud billboards, the two lights
  world/WorldManager.js  seamless planet: origin, streaming, sky, clouds, stars, depth passes
  world/core/          FloatingOrigin, GenerationScheduler, WorldSave
  world/planet/        CubeSphere, TerrainGenerator, PlanetSurface, Sky, Clouds
  world/space/         StarField
  world/render/        DepthPartition (near/far depth passes)
  world/FlightRegime.js  altitude regimes, speed + gravity scaling
  core/quality.js      adaptive quality (hysteresis)
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
