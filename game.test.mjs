import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, BUILDINGS, MIN_BOTS, MAX_BOTS, DEFAULT_BOTS, COINS_PER_SECOND, STARTING_COINS, EXPANSION_SECONDS } from './game.mjs';

const TEST_SEED = 147;
const sum = values => values.reduce((a, b) => a + b, 0);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} vs ${expected}`);

function foundingCell(game) {
  const { width, height } = game.size;
  const center = Math.floor(height * 0.47) * width + Math.floor(width * 0.45);
  return game.cells[center].land ? center : game.cells.findIndex(cell => cell.land);
}

function newRound(botCount = DEFAULT_BOTS, seed = TEST_SEED) {
  const game = new Game(botCount, seed);
  game.place(foundingCell(game));
  // These fixtures isolate one rule. Explicitly opt a bot back in when its
  // decisions are the behavior under test.
  game.players.forEach(player => { player.nextOpeningOrder = Infinity; });
  game.diplomacy.nextProposal.fill(Infinity);
  return game;
}

function battlefield(botCount = DEFAULT_BOTS) {
  const game = newRound(botCount);
  game.update(EXPANSION_SECONDS);
  const rival = game.players.findIndex((_, id) => id > 0 && game.frontier(0, id).length);
  assert.ok(rival > 0);
  const target = game.frontier(0, rival)[0];
  game.players.forEach(player => { player.nextDecision = Infinity; });
  return { game, rival, target };
}

test('one land click places only the human by hand, seeds three distinct bots, and starts the flow', () => {
  const game = new Game(DEFAULT_BOTS, TEST_SEED);
  game.place(game.cells.findIndex(cell => !cell.land));
  assert.equal(game.phase, 'placement');
  const start = foundingCell(game);
  game.place(start);
  assert.equal(game.phase, 'expansion');
  assert.equal(game.players.filter(player => player.bot).length, 3);
  const seeds = game.players.map(player => player.seed);
  assert.equal(new Set(seeds).size, 4);
  assert.equal(seeds[0], start);
  seeds.forEach((seed, id) => assert.equal(game.cells[seed].owner, id));
  game.place(start + 1);
  assert.deepEqual(game.players.map(player => player.seed), seeds);
});

test('growth follows exact terrain arrival times, excludes water, and reaches battle at 30 seconds', () => {
  const game = newRound();
  const reachable = game.flow.order;
  const areas = [];
  for (const dt of [0.3, 3.8, 5.2, 12.2, 8.4]) {
    game.update(dt);
    assert.equal(game.phase, 'expansion');
    assert.equal(sum(game.players.map((_, id) => game.area(id))),
      reachable.filter(index => game.flow.arrival[index] <= game.elapsed).length);
    areas.push(sum(game.players.map((_, id) => game.area(id))));
  }
  assert.ok(areas.every((area, index) => !index || areas[index - 1] < area));
  assert.ok(game.cells.every(cell => cell.owner === -1 || cell.land));
  game.update(30 - game.elapsed);
  assert.equal(game.phase, 'battle');
  assert.equal(game.elapsed, 30);
  assert.ok(game.players.every((_, id) => game.players.some((_, other) => id !== other && game.frontier(id, other).length)));
});

test('a frame crossing the deadline credits only its remaining time to population and coins', () => {
  const game = newRound();
  game.update(31);
  assert.equal(game.phase, 'battle');
  close(game.battleTime, 1);
  game.players.forEach((player, id) => close(player.population, game.area(id) * 4 + game.rate(id)));
  close(sum(game.players.map(player => player.coins - STARTING_COINS)), COINS_PER_SECOND);
});

test('economy distributes the coin pool in proportion to the living population including deployed forces', () => {
  const { game, rival, target } = battlefield();
  game.players.forEach(player => { player.population = 100; });
  game.players[0].population = 1000;
  game.players[rival].population = 400;
  close(game.coinRate(0), COINS_PER_SECOND * 1000 / 1600);
  assert.ok(game.attack(target, 0.3));
  close(game.totalPopulation(0), 1000);
  close(game.coinRate(0), COINS_PER_SECOND * 1000 / 1600);
  game.update(0.25);
  close(sum(game.players.map(player => player.coins - STARTING_COINS)), 0.25 * COINS_PER_SECOND);
  assert.ok(game.players.every(player => player.coins > STARTING_COINS));
});

test('300 sent against 400 enters combat and capture speed drops at exactly 150 remaining', () => {
  const { game, rival, target } = battlefield();
  game.players[0].population = 1000;
  game.players[rival].population = 400;
  assert.ok(game.attack(target, 0.3));
  assert.equal(game.phase, 'battle');
  assert.equal(game.players[0].population, 700);
  const battle = game.attacks[0];
  assert.equal(battle.initial, 300);
  assert.equal(game.attack(target, 0.3), false);
  const dt = 0.01;
  game.updateAttack(battle, dt);
  close(battle.progress, dt * (300 / 400) * 6);
  battle.force = 150;
  battle.progress = 0;
  game.players[rival].population = 400;
  game.updateAttack(battle, dt);
  close(battle.progress, dt * (150 / 400) * 6 * 0.35);
});

test('2:1 committed at launch eliminates only that rival and preserves the remaining match', () => {
  const { game, rival, target } = battlefield();
  game.players[0].population = 1000;
  game.players[rival].population = 400;
  game.attack(target, 0.8);
  assert.equal(game.players[rival].alive, false);
  assert.equal(game.area(rival), 0);
  assert.equal(game.totalPopulation(rival), 0);
  assert.equal(game.coinRate(rival), 0);
  assert.equal(game.area(0) > 0, true);
  assert.equal(game.phase, 'battle');
  assert.equal(game.players[0].population, 1000);
});

test('bots issue orders of their own, and a bot deployment does not reserve the human attack slot', () => {
  const { game, rival, target } = battlefield();
  const bot = game.players.findIndex((_, id) => id > 0 && (game.frontier(id, 0).length || game.frontier(id, rival).length));
  game.players.forEach(player => { player.population = 500; });
  game.players[bot].nextDecision = 0;
  game.update(0.1);
  assert.ok(game.attacks.some(battle => battle.attacker === bot));
  assert.ok(game.attack(target, 0.4));
  assert.ok(game.attacks.some(battle => battle.attacker === 0));
});

test('elimination ends outgoing attacks and returns surviving forces of other nations targeting the loser', () => {
  const { game } = battlefield();
  const rival = game.players.findIndex((_, id) => id > 0 && game.frontier(0, id).length
    && game.players.some((__, other) => other > 0 && other !== id && game.frontier(other, id).length));
  const target = game.frontier(0, rival)[0];
  game.players[0].population = 400;
  game.players[rival].population = 400;
  const humanBorder = game.frontier(rival, 0)[0];
  assert.ok(game.launchAttack(rival, humanBorder, 0.5));
  const third = game.players.findIndex((_, id) => id !== rival && id > 0 && game.frontier(id, rival).length);
  game.players[third].population = 200;
  assert.ok(game.launchAttack(third, game.frontier(third, rival)[0], 0.5));
  assert.equal(game.players[third].population, 100);
  assert.ok(game.attack(target, 1));
  assert.equal(game.attacks.length, 0);
  assert.equal(game.players[third].population, 200);
  assert.equal(game.totalPopulation(rival), 0);
  assert.equal(game.players[rival].alive, false);
});

test('capturing the human ends the solo match and a new instance starts clean', () => {
  const { game, rival } = battlefield();
  game.players[0].population = 100;
  game.players[rival].population = 300;
  const humanBorder = game.frontier(rival, 0)[0];
  assert.ok(game.launchAttack(rival, humanBorder, 1));
  assert.equal(game.result, 'defeat');
  assert.equal(game.phase, 'finished');
  assert.equal(game.winner, rival);
  const reset = new Game();
  assert.ok(reset.players.every(player => player.alive && !player.coins && !player.population && player.seed === null));
  assert.equal(reset.phase, 'placement');
});

test('only the last rival capture wins across small, default and large islands', () => {
  for (const count of [MIN_BOTS, DEFAULT_BOTS, MAX_BOTS]) {
    const { game } = battlefield(count);
    for (let remaining = count; remaining > 0; remaining--) {
      const rival = game.players.findIndex((player, id) => id > 0 && player.alive && game.frontier(0, id).length);
      game.players[rival].population = 10;
      assert.ok(game.attack(game.frontier(0, rival)[0], 1));
      assert.equal(game.phase, remaining === 1 ? 'finished' : 'battle');
    }
    assert.equal(game.result, 'victory');
    assert.equal(game.winner, 0);
    assert.equal(game.area(0), game.cells.filter(cell => cell.land).length);
  }
});

test('each opponent count has a larger playable island and distinct capitals, names and colors', () => {
  for (const invalid of [0, -1, MAX_BOTS + 1, 2.2, NaN, '4']) assert.throws(() => new Game(invalid), RangeError);
  let previousLand = 0;
  for (let count = MIN_BOTS; count <= MAX_BOTS; count++) {
    const game = newRound(count);
    const { width, height } = game.size;
    const land = game.cells.filter(cell => cell.land).length;
    assert.equal(game.cells.length, width * height);
    assert.ok(land > previousLand);
    previousLand = land;
    assert.equal(game.players.length, count + 1);
    for (const key of ['color', 'name', 'seed']) {
      assert.equal(new Set(game.players.map(player => player[key])).size, count + 1);
    }
    assert.ok(game.players.every((player, id) => player.bot === (id > 0) && game.cells[player.seed].owner === id));
    game.update(29);
    assert.equal(game.phase, 'expansion');
    game.update(1);
    assert.equal(game.phase, 'battle');
    assert.equal(sum(game.players.map(player => player.area)), land);
    game.update(1);
    close(sum(game.players.map(player => player.coins - STARTING_COINS)), COINS_PER_SECOND);
    assert.ok(game.players.every(player => player.coins > STARTING_COINS));
  }
});

test('matches of different sizes keep independent neighbors, progress and battlefronts', () => {
  const small = newRound(MIN_BOTS);
  const large = newRound(MAX_BOTS);
  const smallWidth = small.size.width;
  const largeWidth = large.size.width;
  assert.ok(largeWidth > smallWidth);
  assert.deepEqual(small.neighbors(smallWidth - 1), [smallWidth - 2, 2 * smallWidth - 1]);
  assert.deepEqual(large.neighbors(largeWidth - 1), [largeWidth - 2, 2 * largeWidth - 1]);
  small.update(30);
  assert.equal(large.elapsed, 0);
  large.update(30);
  const frontier = large.frontier(0, large.players.findIndex((_, id) => id > 0 && large.frontier(0, id).length));
  const target = frontier[0];
  const defender = large.cells[target].owner;
  const before = large.area(0);
  large.players[0].population = 1000;
  large.players[defender].population = 400;
  assert.ok(large.attack(target, 0.3));
  large.update(0.5);
  assert.ok(large.area(0) > before);
  assert.equal(large.cells[target].owner, 0);
  assert.equal(small.battleTime, 0);
  assert.equal(small.attacks.length, 0);
});

test('new matches draw a fresh seed, and reusing a seed reproduces the map and territory flow', t => {
  let draw = 0;
  const seeds = [0, 0xffffffff];
  t.mock.method(globalThis.crypto, 'getRandomValues', buffer => {
    buffer[0] = seeds[draw++];
    return buffer;
  });
  const first = new Game();
  const second = new Game();
  const replay = new Game(DEFAULT_BOTS, first.seed);
  assert.equal(draw, 2);
  assert.equal(first.seed, seeds[0]);
  assert.equal(second.seed, seeds[1]);
  assert.deepEqual(first.size, second.size);
  assert.deepEqual(first.cells, replay.cells);
  assert.ok(first.cells.some((cell, i) => cell.land !== second.cells[i].land));
  assert.ok(first.cells.some((cell, i) => cell.land && second.cells[i].land && cell.terrain !== second.cells[i].terrain));
  first.place(foundingCell(first));
  replay.place(foundingCell(replay));
  assert.deepEqual(first.flow.owner, replay.flow.owner);
  assert.deepEqual(first.flow.arrival, replay.flow.arrival);
  first.update(EXPANSION_SECONDS);
  assert.equal(first.area(0) > replay.area(0), true);
});

test('upgrades charge the next tier exactly once, preserve fractional balances and stop at level three', () => {
  const { game } = battlefield();
  const player = game.players[0];
  player.coins = 19.9;
  assert.equal(game.buyUpgrade(0, 'growth'), false);
  assert.equal(player.coins, 19.9);
  assert.equal(player.upgrades.growth, 0);
  player.coins = 140.5;
  for (const [level, price] of [20, 40, 80].entries()) {
    assert.equal(game.upgradeCost(0, 'growth'), price);
    const before = player.coins;
    assert.ok(game.buyUpgrade(0, 'growth'));
    close(player.coins, before - price);
    assert.equal(player.upgrades.growth, level + 1);
    assert.equal(game.upgradeCost(0, 'defense'), 20);
  }
  player.coins += 200;
  assert.equal(game.upgradeCost(0, 'growth'), null);
  assert.equal(game.buyUpgrade(0, 'growth'), false);
  assert.equal(game.buyUpgrade(0, 'unknown'), false);
  close(player.coins, 200.5);
});

test('only living nations can buy in battle, and a fresh match starts with empty treasuries and no upgrades', () => {
  const game = new Game(DEFAULT_BOTS, TEST_SEED);
  game.players[0].coins = 80;
  assert.equal(game.buyUpgrade(0, 'defense'), false);
  game.place(foundingCell(game));
  game.players.forEach(player => { player.nextOpeningOrder = Infinity; });
  game.diplomacy.nextProposal.fill(Infinity);
  assert.equal(game.buyUpgrade(0, 'defense'), false);
  game.update(EXPANSION_SECONDS);
  assert.ok(game.buyUpgrade(0, 'defense'));
  close(game.players[0].coins, 60 + STARTING_COINS);
  const enemy = game.players.findIndex((_, id) => id > 0 && game.frontier(0, id).length);
  game.players[enemy].coins = 100;
  game.conquer(0, enemy);
  assert.equal(game.buyUpgrade(enemy, 'defense'), false);
  close(game.players[enemy].coins, 100);
  game.players.forEach((player, id) => { if (id && player.alive) game.conquer(0, id); });
  assert.equal(game.buyUpgrade(0, 'defense'), false);
  assert.deepEqual(game.players[0].upgrades, { growth: 0, defense: 1 });
  for (const player of new Game().players) {
    assert.deepEqual(player.upgrades, { growth: 0, defense: 0 });
    assert.equal(player.coins, 0);
  }
});

test('growth multiplies current terrain production, including later captures, without raising capacity', () => {
  const { game, target } = battlefield();
  const player = game.players[0];
  player.coins = 60;
  const base = game.rate(0);
  const capacity = game.capacity(0);
  assert.ok(game.buyUpgrade(0, 'growth'));
  assert.ok(game.buyUpgrade(0, 'growth'));
  close(game.rate(0), base * 1.5);
  close(game.capacity(0), capacity);
  game.claim(target, 0);
  const rate = (base + game.cells[target].yield) * 1.5;
  close(game.rate(0), rate);
  const before = player.population;
  game.update(0.25);
  close(player.population, before + rate * 0.25);
  player.population = game.capacity(0) - 1;
  game.update(0.25);
  close(player.population, game.capacity(0));
});

test('defense bought during combat reduces captures and casualties, including when 150 of 300 attackers remain', () => {
  const { game, rival, target } = battlefield();
  const defender = game.players[rival];
  game.players[0].population = 1000;
  defender.population = 400;
  defender.coins = 60;
  assert.ok(game.attack(target, 0.3));
  const attack = game.attacks[0];
  assert.ok(game.buyUpgrade(rival, 'defense'));
  assert.ok(game.buyUpgrade(rival, 'defense'));
  for (const [force, slowdown] of [[300, 1], [150, 0.35]]) {
    attack.force = force;
    attack.progress = 0;
    defender.population = 400;
    game.updateAttack(attack, 0.01);
    close(attack.progress, 0.01 * 6 * (force / 400) * 0.70 * slowdown);
    close(400 - defender.population, 0.01 * force * 0.045 * 0.70);
  }
});

test('maximum defense preserves instant conquest when 800 are committed against 400', () => {
  const { game, rival, target } = battlefield();
  game.players[rival].coins = 140;
  for (let level = 0; level < 3; level++) assert.ok(game.buyUpgrade(rival, 'defense'));
  game.players[rival].population = 400;
  game.players[0].population = 1000;
  assert.ok(game.attack(target, 0.8));
  assert.equal(game.players[rival].alive, false);
  assert.equal(game.attacks.length, 0);
});

test('a deployed bot buys growth at peace and defense under attack using its own coins', () => {
  const { game, rival, target } = battlefield();
  const bot = game.players[rival];
  game.players[0].population = 400;
  bot.population = 800;
  assert.ok(game.launchAttack(rival, game.frontier(rival, 0)[0], 0.25));
  bot.coins = 40.75;
  game.botDecision(rival);
  assert.deepEqual(bot.upgrades, { growth: 1, defense: 0 });
  close(bot.coins, 20.75);
  assert.ok(game.attack(target, 0.5));
  game.botDecision(rival);
  assert.deepEqual(bot.upgrades, { growth: 1, defense: 1 });
  close(bot.coins, 0.75);
  game.botDecision(rival);
  assert.deepEqual(bot.upgrades, { growth: 1, defense: 1 });
  close(bot.coins, 0.75);
  assert.equal(game.attacks.length, 2);
});

test('construction requires a funded, empty, owned site and a coastal port; benefits follow ownership', () => {
  const { game, rival } = battlefield(1);
  const player = game.players[0];
  const inland = game.cells.findIndex((cell, i) => cell.owner === 0 && game.neighbors(i).every(n => game.cells[n].land));
  const coast = game.cells.findIndex((cell, i) => cell.owner === 0 && game.neighbors(i).some(n => !game.cells[n].land));
  const workshop = game.cells.findIndex((cell, i) => cell.owner === 0 && i !== inland && i !== coast);
  const enemy = game.players[rival].seed;
  assert.ok(inland >= 0 && coast >= 0 && workshop >= 0);
  player.coins = BUILDINGS.port.cost - 0.1;
  assert.equal(game.build(0, 'port', coast), false);
  player.coins = 100;
  assert.equal(game.build(0, 'port', inland), false);
  assert.equal(game.build(0, 'city', enemy), false);
  const growth = game.rate(0);
  const capacity = game.capacity(0);
  const income = game.coinRate(0);
  assert.ok(game.build(0, 'city', inland));
  assert.equal(game.build(0, 'fort', inland), false);
  close(game.rate(0) - growth, 3);
  close(game.capacity(0) - capacity, 300);
  assert.ok(game.build(0, 'factory', workshop));
  assert.ok(game.build(0, 'port', coast));
  assert.equal(player.coins, 10);
  close(game.coinRate(0) - income, 1.5);
  assert.ok(game.diplomacy.act(0, rival, 'trade').ok);
  close(game.coinRate(0) - income, 2.75);
  const oldRivalIncome = game.coinRate(rival);
  game.claim(coast, rival);
  assert.equal(game.players[rival].buildings.port, 1);
  assert.equal(player.buildings.port, 0);
  assert.equal(game.cells[coast].building, 'port');
  assert.ok(game.buildingCells.has(coast));
  close(game.coinRate(0) - income, 2);
  close(game.coinRate(rival) - oldRivalIncome, 0.75);
});

test('a fort doubles border capture cost until captured and then protects its new owner', () => {
  const { game, rival, target } = battlefield();
  game.players[rival].coins = BUILDINGS.fort.cost;
  game.players[0].population = 1000;
  game.players[rival].population = 400;
  assert.ok(game.build(rival, 'fort', target));
  assert.ok(game.attack(target, 0.3));
  const battle = game.attacks[0];
  battle.progress = 1;
  game.updateAttack(battle, 0);
  assert.equal(game.cells[target].owner, rival);
  battle.progress = 2;
  game.updateAttack(battle, 0);
  assert.equal(game.cells[target].owner, 0);
  assert.equal(game.players[rival].buildings.fort, 0);
  assert.equal(game.players[0].buildings.fort, 1);
  assert.ok(game.fortified(target));
});

test('bot and human combat respect active truces, and accepted attacks change relations and end trade', () => {
  const { game, rival, target } = battlefield(1);
  assert.ok(game.diplomacy.act(0, rival, 'trade').ok);
  assert.ok(game.diplomacy.act(0, rival, 'truce').ok);
  const before = game.diplomacy.status(0, rival);
  const population = game.players[0].population;
  assert.equal(game.attack(target, 1), false);
  assert.equal(game.players[0].population, population);
  game.botDecision(rival);
  assert.equal(game.attacks.length, 0);
  assert.equal(game.diplomacy.status(0, rival).opinion, before.opinion);
  game.battleTime += before.truceSeconds;
  game.players[0].population = 1000;
  game.players[rival].population = 400;
  assert.ok(game.attack(target, 0.3));
  const after = game.diplomacy.status(0, rival);
  assert.equal(after.trade, false);
  assert.ok(after.opinion < before.opinion);
});

test('bots build on their own land using their own treasury during ordinary decisions', () => {
  const { game, rival } = battlefield(1);
  game.players[rival].population = 200;
  game.players[0].population = 1000;
  game.players[rival].coins = BUILDINGS.factory.cost;
  game.battleTime = game.players[rival].nextBuild;
  game.botDecision(rival);
  assert.equal(game.players[rival].buildings.factory, 1);
  assert.equal(game.players[rival].coins, 0);
  assert.equal(game.players[0].coins, STARTING_COINS);
  const [site] = game.buildingCells;
  assert.equal(game.cells[site].owner, rival);
});

test('a merchant holds at equal strength with a trading partner, then reassesses after betrayal', () => {
  const { game, rival, target } = battlefield(1);
  game.players[0].population = 400;
  game.players[rival].population = 400;
  assert.ok(game.diplomacy.act(0, rival, 'trade').ok);
  game.botDecision(rival);
  assert.equal(game.attacks.length, 0);
  assert.ok(game.diplomacy.status(0, rival).trade);
  const friendlyOpinion = game.diplomacy.status(0, rival).opinion;
  assert.ok(game.attack(target, 0.25));
  game.endAttack(game.attacks[0]);
  assert.equal(game.players[0].population, game.players[rival].population);
  assert.ok(game.diplomacy.status(0, rival).opinion < friendlyOpinion);
  assert.equal(game.diplomacy.status(0, rival).trade, false);
  game.players[0].population = 1600;
  game.botDecision(rival);
  assert.equal(game.attacks.length, 0);
  game.players[0].population = 400;
  game.botDecision(rival);
  assert.equal(game.attacks[0]?.attacker, rival);
});

test('allied victory requires an alliance with every surviving rival and an explicit claim', () => {
  const { game } = battlefield();
  game.players[0].coins = 200;
  assert.ok(game.diplomacy.act(0, 1, 'trade').ok);
  assert.ok(game.diplomacy.act(0, 1, 'truce').ok);
  assert.ok(game.diplomacy.act(0, 2, 'alliance').ok);
  game.conquer(0, 3);
  assert.equal(game.canClaimAlliedVictory(), false);
  assert.equal(game.claimAlliedVictory(), false);
  assert.ok(game.diplomacy.act(0, 1, 'gift').ok);
  assert.ok(game.diplomacy.act(0, 1, 'alliance').ok);
  assert.equal(game.canClaimAlliedVictory(), true);
  game.update(1);
  assert.equal(game.phase, 'battle');
  assert.equal(game.winner, null);
  assert.ok(game.claimAlliedVictory());
  assert.equal(game.phase, 'finished');
  assert.equal(game.result, 'victory');
  assert.equal(game.winner, 0);
  assert.equal(game.players[1].alive, true);
  assert.equal(game.claimAlliedVictory(), false);
});

test('settlers can deploy on contact and an expedition and its casualties survive the battle transition', () => {
  const game = newRound(1);
  const human = game.players[0];
  const rival = game.players[1];
  assert.equal(human.population, 4);
  assert.equal(game.attack(rival.seed, 1), false);
  assert.equal(human.population, 4);
  game.update(28);
  const target = game.frontier(0, 1)[0];
  assert.ok(Number.isInteger(target));
  assert.equal(human.population, game.area(0) * 4);
  assert.equal(human.coins, 0);
  human.population = 1000;
  rival.population = 400;
  const originallyNeutral = game.cells.map(cell => cell.owner < 0);
  assert.ok(game.attack(target, 0.3));
  const force = game.attacks[0];
  assert.equal(force.initial, 300);
  assert.equal(human.population, 700);
  game.update(1);
  assert.equal(game.phase, 'expansion');
  assert.ok(force.force < 300 && force.force > 0);
  assert.equal(game.cells[target].owner, 0);
  assert.equal(human.coins, 0);
  assert.equal(game.buyUpgrade(0, 'growth'), false);
  game.update(1);
  const newSettlements = game.cells.filter((cell, i) => originallyNeutral[i] && cell.owner === 0 && game.flow.owner[i] === 0);
  assert.equal(human.population, 700 + 4 * newSettlements.length);
  assert.equal(game.phase, 'battle');
  assert.equal(game.battleTime, 0);
  assert.equal(human.coins, STARTING_COINS);
  assert.equal(game.attacks[0], force);
  assert.equal(game.cells[target].owner, 0);
  assert.ok(force.force > 0 && force.force < 300);
});

test('early conquest reroutes only future settlements, leaves no ghost nation, and grants no treasury to the loser', () => {
  const game = newRound();
  game.update(23);
  const rival = game.players.findIndex((p, id) => id > 0 && game.frontier(0, id).length);
  const target = game.frontier(0, rival)[0];
  const unused = game.flow.order.filter(index => game.flow.owner[index] === rival && game.cells[index].owner === -1);
  assert.ok(unused.length > 0);
  game.players[0].population = 800;
  game.players[rival].population = 400;
  assert.ok(game.attack(target, 1));
  assert.equal(game.phase, 'expansion');
  assert.equal(game.area(rival), 0);
  assert.equal(game.players[0].population, 800);
  assert.ok(unused.every(index => game.cells[index].owner === -1));
  assert.ok(game.combatRevision > 0);
  game.update(7);
  assert.ok(unused.every(index => game.players[game.cells[index].owner]?.alive));
  assert.equal(game.blockedFlowCells.size, 0);
  assert.equal(game.cells[target].owner, 0);
  assert.equal(game.area(rival), 0);
  assert.equal(game.totalPopulation(rival), 0);
  assert.equal(game.players[rival].coins, 0);
  assert.equal(game.phase, 'battle');
});

test('winning or losing to the last opponent during expansion stops the wave and economy', () => {
  for (const attacker of [0, 1]) {
    const game = newRound(1);
    game.update(20);
    const defender = 1 - attacker;
    const target = game.frontier(attacker, defender)[0];
    game.players[attacker].population = 800;
    game.players[defender].population = 400;
    assert.ok(game.launchAttack(attacker, target, 1));
    assert.equal(game.result, attacker === 0 ? 'victory' : 'defeat');
    const area = game.area(attacker);
    game.update(30);
    assert.equal(game.elapsed, 20);
    assert.equal(game.area(attacker), area);
    assert.equal(game.players[attacker].coins, 0);
    assert.equal(game.players[defender].alive, false);
  }
});

test('bots can open a battle after fronts touch in the second half of expansion', () => {
  const game = new Game(3, TEST_SEED);
  game.place(foundingCell(game));
  game.diplomacy.nextProposal.fill(Infinity);
  game.update(15);
  assert.equal(game.attacks.length, 0);
  while (!game.attacks.length && game.elapsed < 29.75) game.update(0.25);
  assert.equal(game.phase, 'expansion');
  assert.ok(game.attacks.some(attack => attack.attacker > 0 && attack.initial > 0));
});

function coalition(time = 30) {
  const game = newRound(3);
  game.update(time);
  game.players.forEach(player => {
    player.nextDecision = Infinity;
    player.population = 400;
  });
  assert.ok(game.diplomacy.act(0, 2, 'alliance').ok);
  return game;
}

test('allies can stage a real offensive in either phase without committing the requester', () => {
  for (const time of [23, 30]) {
    const game = coalition(time);
    const quote = game.supportAmount(2);
    const before = game.area(2);
    assert.equal(quote, 100);
    assert.equal(game.sendSupport(2, 0, 'offense', 1, quote), false); // no shared border
    assert.ok(game.sendSupport(2, 0, 'offense', 3, quote));
    const [attack] = game.attacks;
    assert.equal(attack.initial, quote);
    assert.equal(attack.attacker, 2);
    assert.equal(attack.defender, 3);
    assert.equal(attack.supportedNation, 0);
    assert.equal(game.players[0].population, 400);
    assert.equal(game.players[2].population, 300);
    assert.equal(game.totalPopulation(2), 400);
    assert.equal(game.sendSupport(2, 0, 'defense'), false);
    game.updateAttack(attack, 1);
    assert.ok(game.area(2) > before && attack.force < quote);
    const survivors = attack.force;
    game.diplomacy.act(0, 2, 'end');
    assert.equal(game.attacks.length, 0);
    close(game.players[2].population, 300 + survivors);
    game.reconcileSupport();
    close(game.players[2].population, 300 + survivors);
  }
});

test('a request cannot exceed reserves or sidestep the requester or helper treaty', () => {
  const game = coalition();
  const quote = game.supportAmount(2);
  game.players[2].population = 320;
  assert.equal(game.sendSupport(2, 0, 'offense', 3, quote), false);
  game.players[2].population = 500;
  game.diplomacy.sign(0, 3, 'truce');
  assert.equal(game.sendSupport(2, 0, 'offense', 3, quote), false);
  game.diplomacy.act(0, 3, 'end');
  game.diplomacy.sign(2, 3, 'truce');
  assert.equal(game.sendSupport(2, 0, 'offense', 3, quote), false);
  game.diplomacy.act(2, 3, 'end');
  assert.ok(game.sendSupport(2, 0, 'offense', 3, quote));
  assert.equal(game.attacks[0].initial, 100); // accept the displayed quote even if reserves grew
  game.diplomacy.sign(0, 3, 'alliance');
  assert.equal(game.attacks.length, 0);
  assert.equal(game.players[2].population, 500);
});

test('preventative garrisons supply real defense, take proportionate losses and earn income for their origin', () => {
  const game = coalition();
  game.players[3].population = 1000;
  const rate = game.coinRate(2);
  assert.ok(game.sendSupport(2, 0, 'defense'));
  assert.equal(game.totalPopulation(0), 400);
  assert.equal(game.totalPopulation(2), 400);
  close(game.coinRate(2), rate);
  assert.equal(game.launchAttack(2, game.frontier(2, 3)[0], 0.5), false);
  assert.ok(game.launchAttack(3, game.frontier(3, 0)[0], 0.8));
  const attack = game.attacks[0]; // 800 vs 400 home + 100 auxiliaries now fights
  game.updateAttack(attack, 0.01);
  close(attack.progress, 0.01 * 6 * 800 / 500);
  const survival = 1 - (800 * 0.045 * 0.01) / 500;
  close(game.players[0].population, 400 * survival);
  close(game.auxiliaries[0].force, 100 * survival);
  game.diplomacy.act(0, 2, 'end');
  assert.equal(game.auxiliaries.length, 0);
  close(game.players[2].population, 300 + 100 * survival);
});

test('garrisons respect origin treaties, named threats and deployment expiry', () => {
  const game = coalition(26);
  const target = game.frontier(3, 0)[0];
  assert.equal(game.sendSupport(2, 0, 'defense', 3), false);
  assert.ok(game.launchAttack(3, target, 0.5));
  const [attack] = game.attacks;
  assert.ok(game.sendSupport(2, 0, 'defense', 3));
  game.endAttack(attack);
  assert.equal(game.auxiliaries.length, 0);
  assert.equal(game.players[2].population, 400);
  assert.ok(game.sendSupport(2, 0, 'defense'));
  game.diplomacy.sign(2, 3, 'truce');
  assert.ok(game.launchAttack(3, target, 0.5));
  const enemy = game.attacks[0];
  game.updateAttack(enemy, 0.01);
  close(enemy.progress, 0.01 * 6 * 200 / 400); // ally refuses to fight its treaty partner
  assert.equal(game.auxiliaries[0].force, 100);
  game.endAttack(enemy);
  assert.equal(game.auxiliaries.length, 1); // general defense remains
  game.update(19.5);
  assert.equal(game.auxiliaries.length, 1);
  game.update(0.5);
  assert.equal(game.auxiliaries.length, 0);
});

test('an eliminated host releases defenders and an eliminated origin cannot be revived on return', () => {
  for (const loser of [0, 2]) {
    const game = coalition();
    assert.ok(game.sendSupport(2, 0, 'defense'));
    game.conquer(3, loser);
    game.reconcileSupport();
    assert.equal(game.auxiliaries.length, 0);
    assert.equal(game.totalPopulation(loser), 0);
    if (loser === 0) assert.equal(game.players[2].population, 400);
  }
});

test('deployed garrisons still occupy capacity at home when the donor loses land', () => {
  const game = coalition();
  const origin = game.players[2];
  origin.population = game.capacity(2);
  assert.ok(game.sendSupport(2, 0, 'defense'));
  const reserves = origin.population;
  game.growEconomy(1);
  close(origin.population, reserves);
  const target = game.frontier(3, 2)[0];
  const invader = game.players[3];
  invader.population = origin.population;
  assert.ok(game.launchAttack(3, target, 0.5));
  const [attack] = game.attacks;
  attack.progress = 1;
  game.updateAttack(attack, 0);
  assert.equal(game.cells[target].owner, 3);
  close(game.totalPopulation(2), game.capacity(2));
  game.diplomacy.act(0, 2, 'end');
  close(origin.population, game.capacity(2));
});

