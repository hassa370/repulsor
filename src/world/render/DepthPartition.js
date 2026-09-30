// Two depth passes sharing one depth buffer, split with gl.depthRange:
//
//   far pass  -> depth [0.5, 1]  sky, stars, distant terrain, cloud shell
//   near pass -> depth [0, 0.5]  everything within a few km (city, player, FX)
//
// Each pass gets its own near/far planes, so a 24-bit depth buffer resolves
// both a gauntlet 5 cm from the eye and a mountain 200 km away (a single
// 0.05 m .. 1000 km frustum would z-fight across the whole planet). Near
// fragments always win (smaller depth range), no mid-frame clear is needed,
// and transparent near effects still blend over the far pass.
//
// In WebXR the per-eye projections come from the runtime; only their
// near/far terms (elements 10 and 14) are rewritten per pass. The session's
// render-state depthNear/depthFar are never touched after start (changing them
// per frame would thrash updateRenderState).

function setNearFar(m, n, f) {
  const e = m.elements;
  e[10] = -(f + n) / (f - n);
  e[14] = (-2 * f * n) / (f - n);
}

export class DepthPartition {
  constructor(renderer, camera) {
    this.renderer = renderer;
    this.camera = camera;
    this.baseNear = camera.near;
    this.baseFar = camera.far;
    renderer.autoClear = false;
    renderer.xr.cameraAutoUpdate = false; // the game calls xr.updateCamera itself
    this.gl = renderer.getContext();
    this.ranges = { nearN: camera.near, nearF: camera.far, farN: 1000, farF: 1e6 };
  }

  applyProjection(n, f) {
    const r = this.renderer;
    if (r.xr.isPresenting) {
      const cam = r.xr.getCamera();
      const cams = cam.cameras;
      for (let i = 0; i < cams.length; i++) {
        setNearFar(cams[i].projectionMatrix, n, f);
        cams[i].projectionMatrixInverse.copy(cams[i].projectionMatrix).invert();
      }
      setNearFar(cam.projectionMatrix, n, f);
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    } else {
      const c = this.camera;
      c.near = n; c.far = f;
      c.updateProjectionMatrix();
    }
  }

  // between(): hook to move shared objects (the terrain batch) between scenes.
  render(farScene, nearScene, ranges, between) {
    const r = this.renderer, gl = this.gl;
    r.clear();
    gl.depthRange(0.5, 1);
    this.applyProjection(ranges.farN, ranges.farF);
    r.render(farScene, this.camera);
    if (between) between();
    gl.depthRange(0, 0.5);
    this.applyProjection(ranges.nearN, ranges.nearF);
    r.render(nearScene, this.camera);
    gl.depthRange(0, 1);
    if (!r.xr.isPresenting) {
      // Keep the user camera at its base planes (what XR render state uses).
      const c = this.camera;
      c.near = this.baseNear; c.far = this.baseFar;
      c.updateProjectionMatrix();
    }
  }
}
