// Optional reference art: public/textures/enemy_face.png (the Log Goon
// reference). Its face region is cropped into the enemy atlas and, if the
// image has a transparent background, it is also used as the far-LOD sprite.
// Everything falls back to procedurally painted textures when it's missing.

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function hasTransparentBackground(img) {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 16;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, 16, 16);
  const d = g.getImageData(0, 0, 16, 16).data;
  // corners
  return d[3] < 32 && d[(15) * 4 + 3] < 32 && d[(15 * 16) * 4 + 3] < 32 && d[(16 * 16 - 1) * 4 + 3] < 32;
}

// Optional pre-compressed far-LOD sprite (KTX2 / Basis, with mipmaps):
//   toktx --t2 --encode uastc --genmipmap public/textures/enemy_sprite.ktx2 enemy_sprite.png
async function tryKtx2(renderer, url) {
  try {
    const head = await fetch(url, { method: 'HEAD' });
    const type = head.headers.get('content-type') || '';
    if (!head.ok || type.includes('text/html')) return null;
    const { KTX2Loader } = await import('three/examples/jsm/loaders/KTX2Loader.js');
    // Basis transcoder (JS + WASM) is bundled locally by Vite from three/examples.
    const loader = new KTX2Loader().detectSupport(renderer);
    const tex = await loader.loadAsync(url);
    loader.dispose();
    return tex;
  } catch (e) {
    console.warn('KTX2 load failed', url, e);
    return null;
  }
}

export async function loadReferenceImage(renderer) {
  const [image, spriteTexture] = await Promise.all([
    loadImage('textures/enemy_face.png'),
    tryKtx2(renderer, 'textures/enemy_sprite.ktx2'),
  ]);
  const spriteImage = image && hasTransparentBackground(image) ? image : null;
  return { image, spriteImage, spriteTexture };
}
