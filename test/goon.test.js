import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGoonGeometries, triangleCounts } from '../src/enemy/goonModel.js';

test('Log Goon stays under 500 triangles', () => {
  const parts = buildGoonGeometries();
  const t = triangleCounts(parts);
  console.log(JSON.stringify(t));
  assert.ok(t.total < 500, `total ${t.total}`);
  assert.ok(t.silhouette < 150);
  for (const k in parts) {
    assert.ok(parts[k].attributes.uv, `${k} uv`);
    assert.equal(parts[k].index, null);
  }
});
