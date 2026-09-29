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

export async function loadReferenceImage() {
  const image = await loadImage('textures/enemy_face.png');
  if (!image) return { image: null, spriteImage: null };
  return { image, spriteImage: hasTransparentBackground(image) ? image : null };
}
