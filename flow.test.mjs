import test from 'node:test';
import assert from 'node:assert/strict';
import { WIDTH, HEIGHT, EXPANSION_SECONDS, TERRAINS, createCells, createIsland, mapSizeForPlayers, planExpansion } from './flow.mjs';

const at = (x, y) => y * WIDTH + x;
const fixture = () => Array.from({ length: WIDTH * HEIGHT }, () => ({ land: false, terrain: 'water' }));

test('thirteen nations can occupy distinct territories on the largest seeded islands', () => {
  const size = mapSizeForPlayers(13);
  assert.ok(size.width > mapSizeForPlayers(9).width);
  assert.throws(() => mapSizeForPlayers(14), RangeError);
  for (const seed of [0, 8192, 0xffffffff]) {
    const island = createIsland(size, seed);
    const cells = createCells(island);
    const land = cells.flatMap((cell, index) => cell.land ? [index] : []);
    const seeds = Array.from({ length: 13 }, (_, id) => land[Math.floor((id + 0.5) * land.length / 13)]);
    const { owner, arrival, order } = planExpansion(cells, seeds, size);
    assert.equal(order.length, land.length);
    assert.equal(new Set(land.map(index => owner[index])).size, 13);
    seeds.forEach((index, id) => assert.equal(owner[index], id));
    assert.equal(arrival[order.at(-1)], EXPANSION_SECONDS);
    assert.ok(cells.every(cell => cell.building === null));
  }
});

test('every reachable land cell gets one arrival between placement and the end of expansion', () => {
  const cells = createCells();
  const seeds = [at(20, 24), at(65, 21), at(70, 42), at(29, 44)];
  const { owner, arrival, order } = planExpansion(cells, seeds);
  assert.deepEqual(seeds.map(index => arrival[index]), [0, 0, 0, 0]);
  assert.deepEqual(seeds.map(index => owner[index]), [0, 1, 2, 3]);
  assert.equal(order.length, cells.filter(cell => cell.land).length);
  assert.equal(new Set(order).size, order.length);
  assert.equal(arrival[order.at(-1)], EXPANSION_SECONDS);
  assert.ok(order.every((index, i) => !i || arrival[order[i - 1]] <= arrival[index]));
  assert.ok(cells.every((cell, i) => cell.land || (owner[i] === -1 && arrival[i] === Infinity)));
});

test('bot slot order cannot change the shape of a physical claim', () => {
  const cells = createCells();
  const seeds = [at(20, 24), at(65, 21), at(70, 42), at(29, 44)];
  const normal = planExpansion(cells, seeds);
  const reversedSeeds = seeds.toReversed();
  const reversed = planExpansion(cells, reversedSeeds);
  for (const index of normal.order) {
    assert.equal(normal.arrival[index], reversed.arrival[index]);
    assert.equal(seeds[normal.owner[index]], reversedSeeds[reversed.owner[index]]);
  }
});

test('equal-length routes run fastest on plains, then forest, then highlands', () => {
  const cells = fixture();
  const start = at(40, 30);
  cells[start] = { land: true, terrain: 'plains' };
  for (let step = 1; step <= 6; step++) {
    cells[start + step] = { land: true, terrain: 'plains' };
    cells[start - step] = { land: true, terrain: 'forest' };
    cells[start + step * WIDTH] = { land: true, terrain: 'highlands' };
  }
  const { arrival } = planExpansion(cells, [start]);
  assert.ok(arrival[start + 6] < arrival[start - 6]);
  assert.ok(arrival[start - 6] < arrival[start + 6 * WIDTH]);
  assert.ok(TERRAINS.plains.yield > TERRAINS.forest.yield && TERRAINS.forest.yield > TERRAINS.highlands.yield);
});

test('water blocks straight and diagonal shortcuts and unseeded islands stay neutral', () => {
  const cells = fixture();
  const start = at(23, 23);
  const isolated = at(24, 24);
  cells[start] = { land: true, terrain: 'forest' };
  cells[isolated] = { land: true, terrain: 'forest' };
  const { owner, arrival, order } = planExpansion(cells, [start]);
  assert.deepEqual(order, [start]);
  assert.equal(owner[isolated], -1);
  assert.equal(arrival[isolated], Infinity);
});
