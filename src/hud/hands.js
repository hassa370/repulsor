import { BoxGeometry, CylinderGeometry, Mesh, MeshBasicMaterial, MeshStandardMaterial, Group } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Simple armoured gauntlets on the grip spaces (one draw call each + emitter).
export function makeGauntlet(side) {
  const g = new Group();
  const armour = mergeGeometries([
    new BoxGeometry(0.075, 0.05, 0.11).translate(0, 0, 0.01),
    new BoxGeometry(0.06, 0.055, 0.1).translate(0, -0.005, 0.1), // forearm cuff
    new BoxGeometry(0.02, 0.03, 0.05).translate(side * 0.045, 0.01, -0.02), // thumb
  ].map((x) => x.toNonIndexed()));
  const mat = new MeshStandardMaterial({ color: 0x9a1b16, metalness: 0.85, roughness: 0.32, envMapIntensity: 1.2 });
  const m = new Mesh(armour, mat);
  g.add(m);
  const emitter = new Mesh(
    new CylinderGeometry(0.018, 0.018, 0.006, 12).rotateX(Math.PI / 2).translate(0, 0, -0.045),
    new MeshBasicMaterial({ color: 0xbfe8ff, toneMapped: false }),
  );
  g.add(emitter);
  return g;
}
