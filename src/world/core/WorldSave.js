import { PLANET } from '../../config.js';
import { GlobalPosition } from './FloatingOrigin.js';

// Save model: the world is regenerated from seeds, so only *changes* are
// stored. A save is a few hundred bytes however far you have travelled:
//
//   {
//     version, worldSeed,
//     globalPlayerPosition: { sx, sy, sz, x, y, z },   // sector + offset
//     modifiedChunks: {
//       "earth/city/chunk_1_2": { destroyedBuildings: [ids] },
//     },
//   }
//
// Terrain chunks are never saved (they are a pure function of the seed).
export const SAVE_VERSION = 1;

export function serializeWorld(game) {
  const world = game.world;
  const gp = new GlobalPosition();
  if (world) gp.setFromVector(world.origin.localToGlobal(game.body.pos, game.body.pos.clone()));
  const modified = {};
  for (const b of game.city.buildings) {
    if (b.state === 0) continue;
    const mesh = game.city.chunkByBuilder[b.builder];
    const key = `earth/city/${mesh ? mesh.name : 'chunk'}`;
    (modified[key] || (modified[key] = { destroyedBuildings: [] })).destroyedBuildings.push(b.id);
  }
  return {
    version: SAVE_VERSION,
    worldSeed: PLANET.seed,
    globalPlayerPosition: { sx: gp.sx, sy: gp.sy, sz: gp.sz, x: gp.x, y: gp.y, z: gp.z },
    modifiedChunks: modified,
  };
}

// Re-applies saved changes to a freshly generated world (after restart()).
export function applyWorldSave(game, save) {
  if (!save || save.version !== SAVE_VERSION || save.worldSeed !== PLANET.seed) return false;
  const d = game.destruction;
  for (const key in save.modifiedChunks) {
    const ids = save.modifiedChunks[key].destroyedBuildings || [];
    for (const id of ids) {
      const b = game.city.buildings[id];
      if (b && b.state === 0) d.collapse(b, true);
    }
  }
  return true;
}
