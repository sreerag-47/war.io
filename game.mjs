import { WIDTH, HEIGHT, MAX_NATIONS, EXPANSION_SECONDS, createCells, createIsland, elevation, mapSizeForPlayers, planExpansion } from './flow.mjs';
import { Diplomacy } from './diplomacy.mjs';

export { WIDTH, HEIGHT, EXPANSION_SECONDS, elevation };
export const MIN_BOTS = 1;
export const MAX_BOTS = MAX_NATIONS - 1;
export const DEFAULT_BOTS = 3;
export const COINS_PER_SECOND = 10;
export const STARTING_COINS = 35;
export const SUPPORT_FRACTION = 0.25;
export const GARRISON_SECONDS = 20;
export const UPGRADE_COSTS = [20, 40, 80];
export const GROWTH_BONUS = 0.25;
export const DEFENSE_REDUCTION = 0.15;
export const BUILDINGS = {
  city: { name: 'City', cost: 25, description: '+300 population capacity and +3 people per second before growth upgrades.' },
  factory: { name: 'Factory', cost: 35, description: '+1 coin per second.' },
  fort: { name: 'Fort', cost: 30, description: 'Halves capture speed on friendly land within 3 cells.' },
  port: { name: 'Port', cost: 30, description: 'Coastal land only. +0.5 coins per second and +25% trade income for each of the first four ports.' },
};

const NATIONS = [
  ['Ember', '#f48b64'],
  ['Tide', '#70cddd'],
  ['Moss', '#b4ce74'],
  ['Sol', '#c794ee'],
  ['Saffron', '#f3c65f'],
  ['Cobalt', '#829ce9'],
  ['Rose', '#ed83ad'],
  ['Jade', '#54bd96'],
  ['Pearl', '#e7e4d4'],
  ['Cinder', '#bb5d48'],
  ['Indigo', '#8876c4'],
  ['Copper', '#bb965e'],
  ['Glacier', '#82b8f5'],
];

function distanceSquared(a, b, width) {
  return (a % width - b % width) ** 2 + (Math.floor(a / width) - Math.floor(b / width)) ** 2;
}

export class Game {
  constructor(botCount = DEFAULT_BOTS, seed = globalThis.crypto.getRandomValues(new Uint32Array(1))[0]) {
    if (!Number.isInteger(botCount) || botCount < MIN_BOTS || botCount > MAX_BOTS) {
      throw new RangeError(`Choose between ${MIN_BOTS} and ${MAX_BOTS} bots.`);
    }
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
      throw new RangeError('Island seed must be an unsigned 32-bit integer.');
    }
    this.players = NATIONS.slice(0, botCount + 1).map(([name, color], id) => ({
      name, color, bot: id !== 0, alive: true, seed: null,
      population: 0, coins: 0, area: 0, growth: 0, nextDecision: 5 + id * 2,
      upgrades: { growth: 0, defense: 0 },
      buildings: { city: 0, factory: 0, fort: 0, port: 0 },
      nextBuild: 5 + id * 2,
      nextOpeningOrder: 16 + id % 6,
    }));
    this.size = mapSizeForPlayers(this.players.length);
    this.seed = seed;
    this.island = createIsland(this.size, seed);
    this.cells = createCells(this.island);
    const { width } = this.size;
    this.adjacent = this.cells.map((_, index) => {
      const neighbors = [];
      if (index % width > 0) neighbors.push(index - 1);
      if (index % width < width - 1) neighbors.push(index + 1);
      if (index >= width) neighbors.push(index - width);
      if (index + width < this.cells.length) neighbors.push(index + width);
      return neighbors;
    });
    this.phase = 'placement';
    this.active = 0;
    this.elapsed = 0;
    this.battleTime = 0;
    this.flow = null;
    this.nextClaim = 0;
    this.attacks = [];
    this.auxiliaries = [];
    this.result = null;
    this.winner = null;
    this.message = 'Click land to found Ember and start the 30-second expansion.';
    this.revision = 0;
    this.borderWitnesses = new Map();
    this.combatRevision = 0;
    this.blockedFlowCells = new Set();
    this.buildingCells = new Set();
    this.buildingRevision = 0;
    this.diplomacy = new Diplomacy(this);
  }

  neighbors(index) { return this.adjacent[index]; }
  area(id) { return this.players[id].area; }
  capacity(id) { return this.area(id) * 20 + this.players[id].buildings.city * 300; }
  rate(id) {
    const player = this.players[id];
    return (player.growth + player.buildings.city * 3) * (1 + GROWTH_BONUS * player.upgrades.growth);
  }

  buildError(id, type, index) {
    if (this.phase !== 'battle' || !this.players[id]?.alive) return 'Construction opens after expansion.';
    if (!Object.hasOwn(BUILDINGS, type)) return 'Choose a building.';
    const cell = this.cells[index];
    if (!Number.isInteger(index) || !cell?.land || cell.owner !== id) return 'Choose land owned by your nation.';
    if (cell.building) return 'That site already has a building.';
    if (type === 'port' && !this.neighbors(index).some(next => !this.cells[next].land)) return 'Ports need a cell beside the water.';
    if (this.players[id].coins < BUILDINGS[type].cost) return `A ${type} costs ${BUILDINGS[type].cost} coins.`;
    return null;
  }

  build(id, type, index) {
    const error = this.buildError(id, type, index);
    if (error) {
      if (id === 0) this.message = error;
      return false;
    }
    const player = this.players[id];
    player.coins -= BUILDINGS[type].cost;
    player.buildings[type]++;
    this.cells[index].building = type;
    this.buildingCells.add(index);
    this.buildingRevision++;
    this.revision++;
    if (id === 0) this.message = `${BUILDINGS[type].name} built for ${BUILDINGS[type].cost} coins.`;
    return true;
  }

  fortified(index) {
    const owner = this.cells[index].owner;
    if (owner < 0 || !this.players[owner].buildings.fort) return false;
    const { width, height } = this.size;
    const x = index % width;
    const y = Math.floor(index / width);
    for (let row = Math.max(0, y - 3); row <= Math.min(height - 1, y + 3); row++) {
      for (let col = Math.max(0, x - 3); col <= Math.min(width - 1, x + 3); col++) {
        const nearby = this.cells[row * width + col];
        if ((row - y) ** 2 + (col - x) ** 2 <= 9 && nearby.owner === owner && nearby.building === 'fort') return true;
      }
    }
    return false;
  }

  upgradeCost(id, type) {
    const player = this.players[id];
    if (!Number.isInteger(id) || !player || (type !== 'growth' && type !== 'defense')) return null;
    return UPGRADE_COSTS[player.upgrades[type]] ?? null;
  }

  buyUpgrade(id, type) {
    const cost = this.upgradeCost(id, type);
    const player = this.players[id];
    if (this.phase !== 'battle' || cost === null || !player.alive || player.coins < cost) return false;
    player.coins -= cost;
    player.upgrades[type]++;
    if (id === 0) {
      const name = type === 'growth' ? 'Population growth' : 'Defense';
      this.message = `${name} upgraded to level ${player.upgrades[type]}.`;
    }
    return true;
  }

  totalPopulation(id) {
    if (!this.players[id].alive) return 0;
    const away = this.attacks.find(attack => attack.attacker === id);
    const garrison = this.auxiliaries.find(unit => unit.supporter === id);
    return this.players[id].population + (away?.force ?? 0) + (garrison?.force ?? 0);
  }

  coinRate(id) {
    if (this.phase !== 'battle' || !this.players[id]?.alive) return 0;
    const total = this.players.reduce((sum, _, player) => sum + this.totalPopulation(player), 0);
    return (total ? COINS_PER_SECOND * this.totalPopulation(id) / total : 0) + this.industryIncome(id);
  }

  industryIncome(id) {
    const { factory, port } = this.players[id].buildings;
    return factory + 0.5 * port + this.diplomacy.tradeIncome(id) * (1 + 0.25 * Math.min(4, port));
  }

  // Keep ownership, carrying capacity and production in sync when either growth or combat captures a cell.
  claim(index, owner) {
    const cell = this.cells[index];
    if (!cell.land || cell.owner === owner) return;
    if (cell.owner >= 0) {
      this.combatRevision++;
      const previous = this.players[cell.owner];
      previous.area--;
      previous.growth -= cell.yield;
      if (cell.building) previous.buildings[cell.building]--;
    }
    cell.owner = owner;
    this.players[owner].area++;
    this.players[owner].growth += cell.yield;
    if (cell.building) {
      this.players[owner].buildings[cell.building]++;
      this.buildingRevision++;
    }
    this.revision++;
  }

  place(index) {
    if (this.phase !== 'placement') return;
    if (!this.cells[index]?.land) {
      this.message = 'Choose a starting point on land.';
      return;
    }
    const seeds = [index];
    const { width } = this.size;
    // Place bots away from existing capitals and give them some room at the coast.
    while (seeds.length < this.players.length) {
      let choice = -1;
      let bestScore = -Infinity;
      this.cells.forEach((cell, candidate) => {
        if (!cell.land || seeds.includes(candidate)) return;
        const spacing = Math.min(...seeds.map(seed => distanceSquared(seed, candidate, width)));
        const inland = elevation(candidate % width, Math.floor(candidate / width), this.island);
        const score = spacing * (0.45 + Math.min(0.55, Math.max(0, inland)));
        if (score > bestScore) { bestScore = score; choice = candidate; }
      });
      seeds.push(choice);
    }
    this.players.forEach((player, id) => { player.seed = seeds[id]; });
    this.flow = planExpansion(this.cells, seeds, this.island);
    this.phase = 'expansion';
    this.advanceFlow(0);
    this.message = 'Your border is spreading. Send a force once it touches a rival.';
  }

  advanceFlow(time) {
    this.elapsed = time;
    const { order, owner, arrival } = this.flow;
    while (this.nextClaim < order.length && arrival[order[this.nextClaim]] <= time) {
      const index = order[this.nextClaim++];
      if (this.cells[index].owner !== -1) continue;
      const planned = owner[index];
      const nation = this.combatRevision ? this.settlerAt(index, planned) : planned;
      if (nation !== planned) this.combatRevision++;
      if (nation < 0) {
        this.blockedFlowCells.add(index);
        continue;
      }
      this.claim(index, nation);
      this.players[nation].population += 4;
    }
  }

  // Combat may have cut off the original route. Let land settle only from a
  // touching live front, using the same diagonal water barriers as the flow.
  settlerAt(index, planned) {
    const { width, height } = this.size;
    const x = index % width;
    const y = Math.floor(index / width);
    let fallback = -1;
    let earliest = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
        if (dx && dy && (!this.cells[index + dx].land || !this.cells[index + dy * width].land)) continue;
        const neighbor = index + dx + dy * width;
        const owner = this.cells[neighbor].owner;
        if (owner < 0 || !this.players[owner].alive) continue;
        if (owner === planned) return owner;
        if (this.flow.arrival[neighbor] < earliest) {
          earliest = this.flow.arrival[neighbor];
          fallback = owner;
        }
      }
    }
    return fallback;
  }

  frontier(attacker, defender) {
    const result = [];
    this.cells.forEach((cell, index) => {
      if (cell.owner === defender && this.adjacent[index].some(next => this.cells[next].owner === attacker)) {
        result.push(index);
      }
    });
    return result;
  }

  // A pending support request only needs one legal crossing, even if its
  // approval stays on screen for several seconds while the map changes.
  borderCell(attacker, defender) {
    const key = attacker * this.players.length + defender;
    const cached = this.borderWitnesses.get(key);
    const matches = index => this.cells[index].owner === defender &&
      this.adjacent[index].some(next => this.cells[next].owner === attacker);
    if (cached && (cached.revision === this.revision || (cached.index >= 0 && matches(cached.index)))) return cached.index;
    const index = this.cells.findIndex((_, i) => matches(i));
    this.borderWitnesses.set(key, { index, revision: this.revision });
    return index;
  }

  attack(target, fraction) {
    return this.launchAttack(0, target, fraction);
  }

  hasDeployment(id) {
    return this.attacks.some(order => order.attacker === id) || this.auxiliaries.some(order => order.supporter === id);
  }

  supportAmount(id) {
    return Math.floor((this.players[id]?.population ?? 0) * SUPPORT_FRACTION);
  }

  supportError(helper, beneficiary, type, target = null, amount = this.supportAmount(helper)) {
    if (!['expansion', 'battle'].includes(this.phase)) return 'Military support requires an active match.';
    if (helper === beneficiary || !this.players[helper]?.alive || !this.players[beneficiary]?.alive
      || !this.diplomacy.status(helper, beneficiary).allied) return 'Military support requires two living allies.';
    if (type !== 'offense' && type !== 'defense') return 'Choose attack support or a defensive garrison.';
    if (this.hasDeployment(helper)) return `${this.players[helper].name} already has a force deployed.`;
    if (!Number.isInteger(amount) || amount < 1 || amount > this.supportAmount(helper)) return 'The promised force exceeds the available support reserves.';
    if (type === 'defense' && target === null) return null;
    if (!Number.isInteger(target) || !this.players[target]?.alive || target === helper || target === beneficiary) return 'Select a living third nation.';
    if (this.diplomacy.protected(helper, target) || this.diplomacy.protected(beneficiary, target)) return 'An alliance or truce protects the target.';
    if (type === 'offense' && this.borderCell(helper, target) < 0) return 'The supporting nation must share a border with the target.';
    if (type === 'defense' && !this.attacks.some(attack => attack.attacker === target && attack.defender === beneficiary)) return 'That attack has already ended.';
    return null;
  }

  sendSupport(helper, beneficiary, type, target = null, amount = this.supportAmount(helper)) {
    if (this.supportError(helper, beneficiary, type, target, amount)) return false;
    if (type === 'offense') {
      const objective = this.borderCell(helper, target);
      return this.deployAttack(helper, objective, target, amount, beneficiary);
    }
    const battle = this.attacks.find(attack => attack.attacker === target && attack.defender === beneficiary);
    this.players[helper].population -= amount;
    this.auxiliaries.push({
      supporter: helper, beneficiary, target, battle, initial: amount, force: amount,
      expiresAt: this.elapsed + this.battleTime + GARRISON_SECONDS,
    });
    return true;
  }

  defendingGarrisons(host, enemy, attack) {
    return this.auxiliaries.filter(unit => unit.beneficiary === host && unit.supporter !== enemy
      && (unit.target === null || (unit.target === enemy && unit.battle === attack))
      && !this.diplomacy.protected(unit.supporter, enemy));
  }

  returnForce(id, force) {
    const player = this.players[id];
    if (player.alive) player.population = Math.min(this.capacity(id), player.population + force);
  }

  enforceCapacity(id) {
    const excess = this.totalPopulation(id) - this.capacity(id);
    if (excess <= 0) return;
    const player = this.players[id];
    const displaced = Math.min(excess, player.population);
    player.population -= displaced;
    if (displaced === excess) return;
    const away = this.attacks.find(order => order.attacker === id) ??
      this.auxiliaries.find(order => order.supporter === id);
    if (away) away.force = Math.max(0, away.force - (excess - displaced));
  }

  reconcileSupport() {
    const active = this.phase === 'expansion' || this.phase === 'battle';
    const now = this.elapsed + this.battleTime;
    for (const attack of [...this.attacks]) {
      if (attack.supportedNation == null) continue;
      const { attacker, defender, supportedNation } = attack;
      const allied = active && this.players[attacker].alive && this.players[defender].alive &&
        this.players[supportedNation].alive && this.diplomacy.status(attacker, supportedNation).allied;
      if (allied && !this.diplomacy.protected(attacker, defender) && !this.diplomacy.protected(supportedNation, defender)) {
        if (this.borderCell(attacker, defender) >= 0) continue;
      }
      this.recallAttack(attack);
    }
    for (let i = this.auxiliaries.length - 1; i >= 0; i--) {
      const unit = this.auxiliaries[i];
      const allied = active && this.players[unit.supporter].alive && this.players[unit.beneficiary].alive
        && this.diplomacy.status(unit.supporter, unit.beneficiary).allied;
      const threatActive = unit.target === null || (this.attacks.includes(unit.battle)
        && !this.diplomacy.protected(unit.supporter, unit.target));
      if (allied && threatActive && unit.force >= 1 && now < unit.expiresAt) continue;
      this.auxiliaries.splice(i, 1);
      this.returnForce(unit.supporter, unit.force);
    }
  }

  canClaimAlliedVictory() {
    if (this.phase !== 'battle' || !this.players[0].alive) return false;
    const hasRivals = this.players.some((player, id) => id !== 0 && player.alive);
    return hasRivals && this.players.every((player, id) =>
      id === 0 || !player.alive || this.diplomacy.status(0, id).allied);
  }

  claimAlliedVictory() {
    if (!this.canClaimAlliedVictory()) return false;
    this.result = 'victory';
    this.winner = 0;
    this.phase = 'finished';
    this.message = 'Allied victory. Every surviving nation has joined Ember in alliance.';
    this.reconcileSupport();
    this.diplomacy.update();
    return true;
  }

  launchAttack(attacker, target, fraction) {
    if (!['expansion', 'battle'].includes(this.phase) || !this.players[attacker]?.alive || !Number.isFinite(fraction)) return false;
    const defender = this.cells[target]?.owner;
    let error;
    if (!(defender >= 0) || defender === attacker) error = 'Click a rival nation on the map.';
    else if (this.diplomacy.protected(attacker, defender)) error = 'A treaty protects this border. End the agreement before attacking.';
    else if (this.hasDeployment(attacker)) error = 'Your force is already in the field.';
    else if (this.borderCell(attacker, defender) < 0) error = 'Your nations must share a border to attack.';
    const player = this.players[attacker];
    const force = Math.floor(player.population * Math.max(0.1, Math.min(1, fraction)));
    if (force < 1) error = 'Wait for your population to grow.';
    if (error) {
      if (attacker === 0) this.message = error;
      return false;
    }
    return this.deployAttack(attacker, target, defender, force);
  }

  deployAttack(attacker, target, defender, force, supportedNation = null) {
    const player = this.players[attacker];
    player.population -= force;
    this.diplomacy.recordAttack(attacker, defender);
    const rival = this.players[defender];
    const garrisons = this.defendingGarrisons(defender, attacker);
    const strength = garrisons.reduce((total, unit) => total + unit.force, rival.population);
    if (force >= 2 * strength) {
      player.population += force;
      this.conquer(attacker, defender);
    } else {
      this.attacks.push({ attacker, defender, force, initial: force, target, progress: 0, supportedNation });
      if (attacker === 0 || defender === 0) this.message = `${player.name} sent ${force} to attack ${rival.name}.`;
    }
    return true;
  }

  endAttack(attack) {
    this.recallAttack(attack);
    this.reconcileSupport();
  }

  recallAttack(attack) {
    const index = this.attacks.indexOf(attack);
    if (index < 0) return;
    this.attacks.splice(index, 1);
    this.returnForce(attack.attacker, attack.force);
  }

  conquer(attacker, defender) {
    this.cells.forEach((cell, index) => {
      if (cell.owner === defender) this.claim(index, attacker);
    });
    this.players[defender].alive = false;
    this.players[defender].population = 0;
    for (const battle of [...this.attacks]) {
      if (battle.attacker === defender || battle.defender === defender) this.endAttack(battle);
    }
    this.message = `${this.players[attacker].name} conquered ${this.players[defender].name}.`;
    if (defender === 0 || this.players.filter(player => player.alive).length === 1) {
      this.result = defender === 0 ? 'defeat' : 'victory';
      this.winner = attacker;
      this.phase = 'finished';
      this.message = defender === 0 ? `${this.players[attacker].name} conquered Ember.` : 'Ember is the last nation standing. Victory!';
      this.diplomacy.update();
    }
    this.reconcileSupport();
  }

  updateAttack(attack, dt) {
    const { attacker, defender } = attack;
    const defense = this.players[defender];
    const garrisons = this.defendingGarrisons(defender, attacker, attack);
    const strength = garrisons.reduce((total, unit) => total + unit.force, defense.population);
    const ratio = attack.force / Math.max(1, strength);
    const slowdown = attack.force <= attack.initial / 2 ? 0.35 : 1;
    const defenseMultiplier = 1 - DEFENSE_REDUCTION * defense.upgrades.defense;
    attack.progress += dt * Math.min(12, ratio * 6) * slowdown * defenseMultiplier;
    const loss = Math.min(attack.force, Math.max(1, strength * 0.035) * dt);
    const defenseLoss = Math.min(strength, attack.force * 0.045 * dt * defenseMultiplier);
    const survival = strength > 0 ? 1 - defenseLoss / strength : 0;
    defense.population *= survival;
    for (const unit of garrisons) unit.force *= survival;
    attack.force -= loss;
    if (attack.force < 1) {
      this.endAttack(attack);
      return;
    }
    if (attack.progress >= 1) {
      const border = this.frontier(attacker, defender);
      if (!border.length) {
        this.endAttack(attack);
        return;
      }
      const { width } = this.size;
      border.sort((a, b) => distanceSquared(a, attack.target, width) - distanceSquared(b, attack.target, width) || a - b);
      for (const index of border) {
        const captureCost = this.fortified(index) ? 2 : 1;
        if (attack.progress < captureCost) break;
        this.claim(index, attacker);
        attack.progress -= captureCost;
      }
      this.enforceCapacity(defender);
    }
    const survivors = garrisons.reduce((total, unit) => total + unit.force, defense.population);
    if (survivors < 1 || this.area(defender) === 0) this.conquer(attacker, defender);
  }

  botDecision(id) {
    const player = this.players[id];
    const underAttack = this.attacks.some(attack => attack.defender === id);
    if (this.battleTime >= player.nextBuild) {
      this.botBuild(id, underAttack);
      player.nextBuild = this.battleTime + 16;
    }
    const priorities = underAttack ? ['defense', 'growth'] : ['growth', 'defense'];
    for (const type of priorities) {
      if (this.buyUpgrade(id, type)) break;
    }
    this.considerAttack(id);
  }

  considerAttack(id) {
    const player = this.players[id];
    if (this.hasDeployment(id)) return;
    let bestScore = 0;
    let target = -1;
    this.players.forEach((rival, rivalId) => {
      if (id === rivalId || !rival.alive || this.diplomacy.protected(id, rivalId)) return;
      // A nation can hold its border when its garrison and diplomatic motives
      // do not justify starting a war, even if it has only one neighbour.
      const strengthRatio = player.population / Math.max(1, rival.population);
      const score = this.diplomacy.aggression(id, rivalId) * strengthRatio;
      if (score < 0.8 || score <= bestScore) return;
      const border = this.frontier(id, rivalId);
      if (border.length) {
        bestScore = score;
        target = border[Math.floor(border.length / 2)];
      }
    });
    if (target >= 0) {
      const aggression = this.diplomacy.aggression(id, this.cells[target].owner);
      const ceiling = this.phase === 'expansion' ? 0.4 : 0.85;
      const commitment = Math.min(ceiling, Math.max(0.3, 0.66 * aggression));
      this.launchAttack(id, target, commitment);
    }
  }

  botBuild(id, underAttack) {
    const player = this.players[id];
    const priorities = underAttack ? ['fort', 'city', 'factory', 'port'] : ['factory', 'city', 'port', 'fort'];
    priorities.sort((a, b) => player.buildings[a] - player.buildings[b]);
    for (const type of priorities) {
      if (player.coins < BUILDINGS[type].cost) continue;
      for (let offset = 0; offset < this.cells.length; offset++) {
        const index = (player.seed + player.buildings[type] * 257 + offset) % this.cells.length;
        const cell = this.cells[index];
        if (cell.owner !== id || cell.building) continue;
        if (type === 'fort' && !this.neighbors(index).some(next => this.cells[next].owner >= 0 && this.cells[next].owner !== id)) continue;
        if (this.build(id, type, index)) return;
      }
    }
  }

  growEconomy(dt) {
    this.players.forEach((player, id) => {
      if (!player.alive) return;
      const space = this.capacity(id) - this.totalPopulation(id);
      player.population += Math.min(Math.max(0, space), this.rate(id) * dt);
    });
    const population = this.players.map((_, id) => this.totalPopulation(id));
    const total = population.reduce((a, b) => a + b, 0);
    this.players.forEach((player, id) => {
      if (!player.alive) return;
      const share = total ? COINS_PER_SECOND * population[id] / total : 0;
      player.coins += dt * (share + this.industryIncome(id));
    });
  }

  updateCombat(dt) {
    for (const battle of [...this.attacks]) {
      if (this.phase === 'finished') return;
      if (this.attacks.includes(battle)) this.updateAttack(battle, dt);
    }
    for (let id = 1; id < this.players.length && this.phase !== 'finished'; id++) {
      const player = this.players[id];
      if (!player.alive) continue;
      if (this.phase === 'expansion' && this.elapsed >= player.nextOpeningOrder) {
        player.nextOpeningOrder = this.elapsed + 5;
        this.considerAttack(id);
      } else if (this.phase === 'battle' && this.battleTime >= player.nextDecision) {
        player.nextDecision = this.battleTime + 8 + id;
        this.botDecision(id);
      }
    }
  }

  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    // Split at the end of expansion as well as between combat ticks, so a
    // delayed frame cannot skip casualties or pay for time before the opening.
    while ((this.phase === 'expansion' || this.phase === 'battle') && dt > 0) {
      let step = Math.min(dt, 0.25);
      if (this.phase === 'expansion') {
        step = Math.min(step, EXPANSION_SECONDS - this.elapsed);
        this.advanceFlow(this.elapsed + step);
      } else {
        this.battleTime += step;
        this.growEconomy(step);
      }
      this.updateCombat(step);
      if (this.phase === 'expansion' && this.elapsed >= EXPANSION_SECONDS) {
        this.phase = 'battle';
        for (const player of this.players) if (player.alive) player.coins += STARTING_COINS;
        this.message = 'Expansion has ended. Construction and population income are open.';
      }
      this.diplomacy.update();
      this.reconcileSupport();
      dt -= step;
    }
  }
}

