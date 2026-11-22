export const WIDTH = 96;
export const HEIGHT = 64;
export const EXPANSION_SECONDS = 30;
export const MAX_NATIONS = 13;
const DEFAULT_SIZE = { width: WIDTH, height: HEIGHT };

export function mapSizeForPlayers(totalPlayers = 4) {
  if (!Number.isInteger(totalPlayers) || totalPlayers < 2 || totalPlayers > MAX_NATIONS) {
    throw new RangeError(`A match supports 2 to ${MAX_NATIONS} nations.`);
  }
  const scale = Math.sqrt(totalPlayers / 4);
  return { width: Math.round(WIDTH * scale), height: Math.round(HEIGHT * scale) };
}

export const TERRAINS = {
  water: { name: 'Water', color: '#1a3943', speed: 0, yield: 0 },
  plains: { name: 'Plains', color: '#b5c995', speed: 1, yield: 0.25 },
  forest: { name: 'Forest', color: '#698b74', speed: 0.66, yield: 0.17 },
  highlands: { name: 'Highlands', color: '#ae9e82', speed: 0.4, yield: 0.10 },
};

const TURN = 2 * Math.PI;
const COAST_SAMPLES = 512;

export function createIsland(size = DEFAULT_SIZE, seed = 0) {
  // Mulberry32 runs once per match. Terrain sampling below is pure and cheap
  // enough to share between the height mesh, texture, and simulation grid.
  let state = seed >>> 0;
  function random(min, max) {
    state = (state + 0x6D2B79F5) >>> 0;
    let bits = Math.imul(state ^ (state >>> 15), state | 1);
    bits ^= bits + Math.imul(bits ^ (bits >>> 7), bits | 61);
    const value = ((bits ^ (bits >>> 14)) >>> 0) / 4294967296;
    return min + value * (max - min);
  }

  const phases = Array.from({ length: 7 }, () => random(0, TURN));
  const bay = random(0, TURN);
  const secondBay = bay + random(1.2, 4.9);
  const variance = random(0.8, 1.25);
  const coast = new Float32Array(COAST_SAMPLES);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < coast.length; i++) {
    const a = TURN * i / coast.length;
    // A single radial shoreline gives coves and peninsulas continuous paths
    // to the interior. Each bay falls off with its angular distance.
    const coves = 0.35 * Math.exp(6 * (Math.cos(a - bay) - 1))
      + 0.25 * Math.exp(12 * (Math.cos(a - secondBay) - 1));
    const folds = 0.15 * Math.sin(2 * a + phases[0]) + 0.12 * Math.cos(3 * a + phases[1])
      + 0.09 * Math.cos(5 * a + phases[2]) + 0.04 * Math.sin(8 * a + phases[3])
      + 0.023 * Math.cos(13 * a + phases[4]);
    coast[i] = Math.max(0.38, 1.02 + variance * folds - coves);
    const x = coast[i] * Math.cos(a);
    const y = coast[i] * Math.sin(a);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  // Fit the outline inside a sea margin in canonical map coordinates.
  const scaleX = (WIDTH - 10) / (maxX - minX);
  const scaleY = (HEIGHT - 8) / (maxY - minY);
  const centerX = 5 - minX * scaleX;
  const centerY = 4 - minY * scaleY;
  const angle = random(0, Math.PI);
  const ridge = {
    x: centerX + random(-8, 8), y: centerY + random(-5, 5),
    cos: Math.cos(angle), sin: Math.sin(angle), length: random(14, 25),
    width: random(3.8, 6.8), bend: random(2.2, 5.5), phase: phases[5],
  };
  const hillAngle = random(0, TURN);
  const hill = { x: centerX + 16 * Math.cos(hillAngle), y: centerY + 10 * Math.sin(hillAngle) };
  const woodsAngle = random(0, TURN);
  const forest = {
    cos: Math.cos(woodsAngle), sin: Math.sin(woodsAngle),
    phase: phases[6], frequency: random(0.14, 0.24),
  };
  return {
    width: size.width, height: size.height, seed: seed >>> 0,
    coast, centerX, centerY, scaleX, scaleY, ridge, hill, forest,
  };
}

function islandHeight(x, y, island) {
  const nx = (x - island.centerX) / island.scaleX;
  const ny = (y - island.centerY) / island.scaleY;
  const sample = Math.atan2(ny, nx) * (COAST_SAMPLES / TURN) + COAST_SAMPLES;
  const index = Math.floor(sample);
  const fraction = sample - index;
  const shore = island.coast[index % COAST_SAMPLES] * (1 - fraction)
    + island.coast[(index + 1) % COAST_SAMPLES] * fraction;
  const inland = 1 - Math.hypot(nx, ny) / shore;
  if (inland <= 0) return inland;
  const { ridge, hill } = island;
  const dx = x - ridge.x, dy = y - ridge.y;
  const along = dx * ridge.cos + dy * ridge.sin;
  const across = dy * ridge.cos - dx * ridge.sin - ridge.bend * Math.sin(along * 0.13 + ridge.phase);
  const peak = Math.exp(-((along / ridge.length) ** 2 + (across / ridge.width) ** 2));
  const knoll = Math.exp(-(((x - hill.x) / 8) ** 2 + ((y - hill.y) / 6) ** 2));
  const rise = Math.min(1, inland * 4);
  return 0.26 * inland + rise * (0.76 * peak + 0.54 * knoll + 0.035 * (1 + Math.sin(0.39 * across + along * 0.19)));
}

// Continuous height field shared by the mesh, the land mask, and biome selection.
export function elevation(x, y, size = DEFAULT_SIZE) {
  x *= WIDTH / size.width;
  y *= HEIGHT / size.height;
  if (size.coast) return islandHeight(x, y, size);
  const nx = (x - 47.5) / 42;
  const ny = (y - 31.5) / 25;
  const angle = Math.atan2(ny, nx);
  const shore = 0.96 + 0.10 * Math.sin(3 * angle + 0.7)
    + 0.07 * Math.sin(5 * angle - 0.2) + 0.05 * Math.cos(8 * angle)
    + 0.026 * Math.sin(0.48 * x + 0.32 * y);
  const inland = shore - Math.hypot(nx, ny);
  if (inland <= 0) return inland;

  const ridgeY = y - (21 + 0.22 * x + 4.5 * Math.sin(x * 0.13));
  const ridge = Math.exp(-(((x - 51) / 23) ** 2 + (ridgeY / 5.5) ** 2));
  const hill = Math.exp(-(((x - 24) / 9) ** 2 + ((y - 21) / 6) ** 2));
  const slope = Math.min(1, inland * 5);
  return 0.30 * inland + slope * (0.70 * ridge + 0.49 * hill + 0.035 * (1 + Math.sin(x * 0.41 + y * 0.23)));
}

export function terrainAt(x, y, size = DEFAULT_SIZE) {
  const height = elevation(x + 0.5, y + 0.5, size);
  if (height <= 0) return 'water';
  if (height >= 0.56) return 'highlands';
  x = (x + 0.5) * (WIDTH / size.width) - 0.5;
  y = (y + 0.5) * (HEIGHT / size.height) - 0.5;
  if (size.forest) {
    const forest = size.forest;
    const u = x * forest.cos + y * forest.sin;
    const v = y * forest.cos - x * forest.sin;
    const woods = Math.sin(u * forest.frequency + forest.phase) + 0.78 * Math.cos(v * 0.26 + u * 0.045)
      + 0.32 * Math.sin(u * 0.24 - v * 0.32 + forest.phase);
    return height > 0.06 && woods > 0.20 ? 'forest' : 'plains';
  }
  const woodland = Math.sin(x * 0.17 + y * 0.09) + 0.64 * Math.cos(y * 0.29 - x * 0.08)
    + 0.34 * Math.sin((x - y) * 0.43);
  if (height > 0.07 && woodland > 0.25) return 'forest';
  return 'plains';
}

export function createCells(size = DEFAULT_SIZE) {
  return Array.from({ length: size.width * size.height }, (_, index) => {
    const terrain = terrainAt(index % size.width, Math.floor(index / size.width), size);
    return { owner: -1, terrain, land: terrain !== 'water', yield: TERRAINS[terrain].yield, building: null };
  });
}

// The lowest arrival time is processed first. Obsolete candidates are discarded
// when popped, so each cell's final owner alone can expand through it.
class ArrivalQueue {
  items = [];

  push(item) {
    let i = this.items.length;
    this.items.push(item);
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (this.items[parent].time <= item.time) break;
      this.items[i] = this.items[parent];
      i = parent;
    }
    this.items[i] = item;
  }

  pop() {
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length === 0) return first;
    let i = 0;
    while (2 * i + 1 < this.items.length) {
      let child = 2 * i + 1;
      if (child + 1 < this.items.length && this.items[child + 1].time < this.items[child].time) child++;
      if (this.items[child].time >= last.time) break;
      this.items[i] = this.items[child];
      i = child;
    }
    this.items[i] = last;
    return first;
  }
}

const directions = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
  [-1, -1], [1, -1], [-1, 1], [1, 1],
];

export function planExpansion(cells, seeds, size = DEFAULT_SIZE) {
  const { width, height } = size;
  const arrival = new Float64Array(cells.length).fill(Infinity);
  const owner = new Int16Array(cells.length).fill(-1);
  const resistance = Float64Array.from(cells, (cell, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    const terrain = TERRAINS[cell.terrain ?? terrainAt(x, y, size)];
    if (cell.land === false || terrain.speed === 0) return Infinity;
    const variation = 1 + 0.085 * Math.sin(x * 0.27 + y * 0.19) + 0.065 * Math.cos(y * 0.33 - x * 0.07);
    return variation / terrain.speed;
  });
  const queue = new ArrivalQueue();
  const order = [];
  seeds.forEach((index, nation) => {
    if (!Number.isFinite(resistance[index]) || owner[index] >= 0) return;
    arrival[index] = 0;
    owner[index] = nation;
    queue.push({ index, time: 0, nation });
  });

  while (queue.items.length) {
    const { index, time, nation } = queue.pop();
    if (time !== arrival[index] || nation !== owner[index]) continue;
    order.push(index);
    const x = index % width;
    const y = Math.floor(index / width);
    for (const [dx, dy] of directions) {
      const nextX = x + dx;
      const nextY = y + dy;
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
      const next = nextY * width + nextX;
      if (!Number.isFinite(resistance[next])) continue;
      const diagonal = dx !== 0 && dy !== 0;
      if (diagonal && (!Number.isFinite(resistance[index + dx]) || !Number.isFinite(resistance[index + dy * width]))) continue;
      const distance = diagonal ? Math.SQRT2 : 1;
      const nextTime = time + distance * (resistance[index] + resistance[next]) / 2;
      if (nextTime > arrival[next]) continue;
      // Resolve exact spatial ties independently of the player iteration order.
      if (nextTime === arrival[next] && seeds[owner[next]] <= seeds[nation]) continue;
      arrival[next] = nextTime;
      owner[next] = nation;
      queue.push({ index: next, time: nextTime, nation });
    }
  }

  // Keep each match's opening exactly 30 seconds while preserving relative
  // travel costs between routes. Water and disconnected land stay unreachable.
  const last = order.at(-1);
  const duration = arrival[last];
  if (duration > 0) {
    for (const index of order) arrival[index] = EXPANSION_SECONDS * (arrival[index] / duration);
  }
  return { owner, arrival, order };
}
