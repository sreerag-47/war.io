import test from 'node:test';
import assert from 'node:assert/strict';
import { Diplomacy, GIFT_COST, TRADE_INCOME, TRUCE_SECONDS } from './diplomacy.mjs';

function match() {
  const game = {
    phase: 'battle', battleTime: 0, attacks: [],
    players: ['Ember', 'Tide', 'Moss', 'Sol'].map((name, id) => ({ name, alive: true, coins: 25, bot: id > 0 })),
    endAttack(attack) { this.attacks.splice(this.attacks.indexOf(attack), 1); },
  };
  return { game, diplomacy: new Diplomacy(game) };
}

test('trade pays each partner, ends on aggression, and increases resentment when betrayed', () => {
  const { diplomacy } = match();
  assert.ok(diplomacy.act(0, 1, 'trade').ok);
  assert.equal(diplomacy.tradeIncome(0), TRADE_INCOME);
  assert.equal(diplomacy.tradeIncome(1), TRADE_INCOME);
  assert.equal(diplomacy.tradeIncome(2), 0);
  assert.equal(diplomacy.act(0, 1, 'trade').ok, false);
  const friendly = diplomacy.aggression(1, 0);
  diplomacy.recordAttack(0, 1);
  assert.equal(diplomacy.tradeIncome(0), 0);
  assert.equal(diplomacy.tradeIncome(1), 0);
  assert.ok(diplomacy.aggression(1, 0) > friendly);
  assert.equal(diplomacy.act(0, 1, 'trade').ok, false);
});

test('the largest match has twelve distinct bot profiles with finite attack preferences', () => {
  const { game } = match();
  game.players = Array.from({ length: 13 }, (_, id) => ({ alive: true, bot: id !== 0, coins: 0 }));
  const diplomacy = new Diplomacy(game);
  const names = new Set();
  for (let id = 1; id < game.players.length; id++) {
    const status = diplomacy.status(0, id);
    names.add(status.personality);
    assert.ok(status.description.length > 0);
    assert.ok(Number.isFinite(diplomacy.aggression(id, 0)));
  }
  assert.equal(names.size, 12);
});

test('different bots respond to the same proposal differently; a real gift changes later responses', () => {
  const { game, diplomacy } = match();
  assert.ok(diplomacy.act(0, 2, 'alliance').ok);
  assert.equal(diplomacy.act(0, 1, 'alliance').ok, false);
  const prior = diplomacy.status(0, 1).opinion;
  assert.ok(diplomacy.act(0, 1, 'gift').ok);
  assert.equal(game.players[0].coins, 25 - GIFT_COST);
  assert.equal(game.players[1].coins, 25 + GIFT_COST);
  const improved = diplomacy.status(0, 1).opinion;
  assert.ok(improved > prior);
  assert.equal(diplomacy.act(0, 1, 'gift').ok, false);
  assert.equal(diplomacy.status(0, 1).opinion, improved);
  assert.ok(diplomacy.act(0, 1, 'alliance').ok);
  assert.equal(diplomacy.protected(1, 0), true);
  assert.equal(diplomacy.aggression(1, 0), 0);
  assert.equal(diplomacy.act(0, 3, 'truce').ok, false);
});

test('a ceasefire recalls only both sides of the selected conflict and expires by battle time', () => {
  const { game, diplomacy } = match();
  game.attacks = [{ attacker: 0, defender: 1 }, { attacker: 1, defender: 0 }, { attacker: 2, defender: 1 }];
  game.battleTime = 3;
  assert.equal(diplomacy.act(0, 1, 'trade').ok, false);
  assert.ok(diplomacy.act(0, 1, 'truce').ok);
  assert.deepEqual(game.attacks, [{ attacker: 2, defender: 1 }]);
  assert.equal(diplomacy.protected(0, 1), true);
  assert.equal(diplomacy.protected(1, 0), true);
  game.battleTime += TRUCE_SECONDS - 0.1;
  assert.equal(diplomacy.status(0, 1).truceSeconds, 1);
  assert.equal(diplomacy.act(0, 1, 'truce').ok, false);
  game.battleTime = 3 + TRUCE_SECONDS;
  assert.equal(diplomacy.protected(1, 0), false);
  assert.equal(diplomacy.status(0, 1).truceSeconds, 0);
});

test('ending accords releases both sides; inactive, eliminated or invalid participants cannot earn or negotiate', () => {
  const { game, diplomacy } = match();
  assert.ok(diplomacy.act(0, 2, 'alliance').ok);
  assert.ok(diplomacy.act(0, 2, 'trade').ok);
  assert.ok(diplomacy.act(0, 2, 'end').ok);
  assert.equal(diplomacy.tradeIncome(2), 0);
  assert.equal(diplomacy.protected(2, 0), false);
  assert.equal(diplomacy.act(0, 2, 'end').ok, false);
  assert.ok(diplomacy.act(0, 1, 'trade').ok);
  game.players[1].alive = false;
  assert.equal(diplomacy.tradeIncome(0), 0);
  assert.equal(diplomacy.act(0, 1, 'gift').ok, false);
  assert.equal(diplomacy.act(0, 0, 'gift').ok, false);
  assert.equal(diplomacy.act(0, 99, 'gift').ok, false);
  game.phase = 'finished';
  assert.equal(diplomacy.act(0, 2, 'gift').ok, false);
  assert.equal(game.players[0].coins, 25);
});

test('a merchant initiates during expansion; only the human can sign its trade offer', () => {
  const { game, diplomacy } = match();
  game.phase = 'expansion';
  game.elapsed = 6;
  diplomacy.update();
  const [offer] = diplomacy.incomingOffers();
  assert.deepEqual([offer.from, offer.to, offer.action], [1, 0, 'trade']);
  assert.ok(offer.reason);
  assert.equal(diplomacy.status(0, 1).trade, false);
  assert.ok(diplomacy.respond(offer.id, true).ok);
  assert.equal(diplomacy.respond(offer.id, true).ok, false);
  assert.equal(diplomacy.status(0, 1).trade, true);
  assert.equal(diplomacy.tradeIncome(0), 0);
  game.phase = 'battle';
  game.elapsed = 30;
  assert.equal(diplomacy.tradeIncome(0), 1);
  assert.equal(diplomacy.history.at(-1).outcome, 'accepted');
});

test('bot-to-bot offers include refusal and signed deals, both visible in bounded history', () => {
  const { game, diplomacy } = match();
  game.battleTime = 10;
  diplomacy.update();
  const rejected = diplomacy.history.find(event => event.from > 0 && event.to > 0 && event.outcome === 'declined');
  const signed = diplomacy.history.find(event => event.from > 0 && event.to > 0 && event.outcome === 'accepted');
  assert.ok(rejected && signed);
  assert.equal(diplomacy.status(signed.from, signed.to).trade, true);
  assert.ok(diplomacy.tradeIncome(signed.from) >= 1 && diplomacy.tradeIncome(signed.to) >= 1);
  game.players[0].coins = GIFT_COST * 50;
  for (let i = 0; i < 50; i++) diplomacy.act(0, 2, 'gift');
  assert.equal(diplomacy.history.length, 40);
});

test('an outmatched bot asks the human for peace, and a refusal keeps the attack active', () => {
  const { game, diplomacy } = match();
  game.players[1].population = 100;
  game.players[0].population = 400;
  game.attacks = [{ attacker: 0, defender: 1 }];
  game.battleTime = 6;
  diplomacy.update();
  const [offer] = diplomacy.incomingOffers();
  assert.equal(offer.action, 'truce');
  assert.equal(diplomacy.protected(0, 1), false);
  assert.ok(diplomacy.respond(offer.id, false).ok);
  assert.equal(game.attacks.length, 1);
  assert.equal(diplomacy.act(1, 0, 'truce').ok, false);
  assert.equal(diplomacy.incomingOffers().length, 0);
  assert.equal(diplomacy.history.at(-1).outcome, 'declined');
});

test('truce acceptance during expansion returns troops; its time carries into battle', () => {
  const { game, diplomacy } = match();
  game.phase = 'expansion';
  game.elapsed = 28;
  game.attacks = [{ attacker: 0, defender: 1 }];
  assert.ok(diplomacy.act(1, 0, 'truce').ok);
  assert.ok(diplomacy.respond(diplomacy.incomingOffers()[0].id, true).ok);
  assert.equal(game.attacks.length, 0);
  game.elapsed = 30;
  game.phase = 'battle';
  game.battleTime = 2;
  assert.equal(diplomacy.status(0, 1).truceSeconds, 16);
  game.battleTime = 18;
  assert.equal(diplomacy.protected(0, 1), false);
});

test('an expired, incompatible or eliminated senderΓÇÖs offer cannot be accepted from a stale UI', () => {
  for (const cause of ['timeout', 'hostile', 'equivalent', 'eliminated', 'finished']) {
    const { game, diplomacy } = match();
    assert.ok(diplomacy.act(1, 0, 'trade').ok);
    const [offer] = diplomacy.incomingOffers();
    if (cause === 'timeout') game.battleTime = offer.expiresAt;
    if (cause === 'hostile') diplomacy.recordAttack(0, 1);
    if (cause === 'equivalent') assert.ok(diplomacy.act(0, 1, 'trade').ok);
    if (cause === 'eliminated') game.players[1].alive = false;
    if (cause === 'finished') game.phase = 'finished';
    assert.equal(diplomacy.respond(offer.id, true).ok, false);
    assert.equal(diplomacy.incomingOffers().length, 0);
  }
});

function coalition() {
  const { game, diplomacy } = match();
  game.players.forEach(player => { player.population = 400; player.coins = 200; });
  game.orders = [];
  game.supportAmount = id => Math.floor(game.players[id].population * 0.25);
  game.supportError = (id, beneficiary, type, rival, amount) => {
    if (!amount || amount > game.supportAmount(id)) return 'Too few reserves.';
    if (game.orders.some(order => order.id === id)) return 'Already deployed.';
    if (rival !== null && diplomacy.protected(id, rival)) return 'A treaty protects this nation.';
    if (type === 'defense' && rival !== null && !game.attacks.some(attack => attack.attacker === rival && attack.defender === beneficiary)) {
      return 'Threat ended.';
    }
    return null;
  };
  game.sendSupport = (id, beneficiary, type, rival, amount) => {
    if (game.supportError(id, beneficiary, type, rival, amount)) return false;
    game.players[id].population -= amount;
    game.orders.push({ id, beneficiary, type, rival, amount });
    return true;
  };
  assert.ok(diplomacy.act(0, 2, 'alliance').ok);
  diplomacy.nextProposal.fill(Infinity);
  return { game, diplomacy };
}

test('a bot ally asks for defense against a real attacker, sending no troops until its exact quote is accepted', () => {
  const { game, diplomacy } = coalition();
  game.attacks.push({ attacker: 3, defender: 2, force: 200, initial: 240 });
  diplomacy.nextProposal[2] = 0;
  diplomacy.update();
  const [ask] = diplomacy.incomingOffers();
  assert.deepEqual([ask.action, ask.from, ask.to, ask.target, ask.troops], ['defense', 2, 0, 3, 100]);
  assert.equal(game.players[0].population, 400);
  game.players[0].population += 80;
  assert.equal(diplomacy.incomingOffers()[0].troops, 100);
  assert.ok(diplomacy.respond(ask.id, true).ok);
  assert.equal(diplomacy.respond(ask.id, true).ok, false);
  assert.deepEqual(game.orders, [{ id: 0, beneficiary: 2, type: 'defense', rival: 3, amount: 100 }]);
  assert.equal(game.players[0].population, 380);
  assert.equal(diplomacy.history.at(-1).target, 3);
});

test('a struggling bot asks its ally to join its offensive; a stale or declined request cannot deploy troops', () => {
  for (const reason of ['ended', 'eliminated', 'pact', 'insufficient', 'timeout', 'finished', 'refused']) {
    const { game, diplomacy } = coalition();
    game.attacks.push({ attacker: 2, defender: 3, force: 65, initial: 200 });
    diplomacy.nextProposal[2] = 0;
    diplomacy.update();
    const [ask] = diplomacy.incomingOffers();
    assert.deepEqual([ask.action, ask.target, ask.troops], ['offense', 3, 100]);
    if (reason === 'ended') game.attacks = [];
    if (reason === 'eliminated') game.players[3].alive = false;
    if (reason === 'pact') diplomacy.act(0, 2, 'end');
    if (reason === 'insufficient') game.players[0].population = 1;
    if (reason === 'timeout') game.battleTime = ask.expiresAt;
    if (reason === 'finished') game.phase = 'finished';
    if (reason === 'refused') assert.ok(diplomacy.respond(ask.id, false).ok);
    assert.equal(diplomacy.respond(ask.id, true).ok, false);
    assert.equal(diplomacy.incomingOffers().length, 0);
    assert.deepEqual(game.orders, []);
  }
});

test('a human can request a preventive garrison, while a peaceful ally can decline a planned offensive', () => {
  const { game, diplomacy } = coalition();
  assert.equal(diplomacy.requestSupport(0, 2, 'offense', 3).ok, false);
  assert.equal(game.orders.length, 0);
  assert.ok(diplomacy.supportWait(0, 2) > 0);
  assert.equal(diplomacy.requestSupport(0, 2, 'defense', null).ok, false);
  game.battleTime += diplomacy.supportWait(0, 2);
  assert.ok(diplomacy.requestSupport(0, 2, 'defense', null).ok);
  assert.deepEqual(game.orders, [{ id: 2, beneficiary: 0, type: 'defense', rival: null, amount: 100 }]);
});

test('answering a previous call to arms and giving aid affect whether that ally will return the favour', () => {
  for (const honor of [false, true]) {
    const { diplomacy } = coalition();
    assert.ok(diplomacy.requestSupport(2, 0, 'defense', null).ok);
    assert.ok(diplomacy.respond(diplomacy.incomingOffers()[0].id, honor).ok);
    assert.ok(diplomacy.act(0, 2, 'gift').ok);
    assert.equal(diplomacy.requestSupport(0, 2, 'offense', 3).ok, honor);
  }
});

test('a trading partnerΓÇÖs interests and a protected rival can prevent allied offensive support', () => {
  for (const relation of ['none', 'trade', 'alliance']) {
    const { game, diplomacy } = coalition();
    for (let i = 0; i < 3; i++) assert.ok(diplomacy.act(0, 2, 'gift').ok);
    if (relation !== 'none') assert.ok(diplomacy.act(3, 2, relation).ok);
    const response = diplomacy.requestSupport(0, 2, 'offense', 3);
    assert.equal(response.ok, relation === 'none');
    assert.equal(game.orders.length, relation === 'none' ? 1 : 0);
  }
});

test('a bot selects the more trusted of two eligible allies even when the other is first in rotation', () => {
  for (const favored of [0, 1]) {
    const { game, diplomacy } = coalition();
    assert.ok(diplomacy.act(1, 2, 'alliance').ok);
    assert.ok(diplomacy.act(favored, 2, 'gift').ok);
    diplomacy.targetCursor[2] = 1 - favored;
    game.attacks.push({ attacker: 3, defender: 2, force: 200, initial: 240 });
    diplomacy.nextProposal[2] = 0;
    diplomacy.update();
    const request = diplomacy.history.find(event => event.from === 2 && event.action === 'defense');
    assert.equal(request.to, favored);
  }
});

test('a support dispatch that ends the match preserves the game result message', () => {
  const { game, diplomacy } = coalition();
  assert.ok(diplomacy.requestSupport(2, 0, 'offense', 3).ok);
  const [offer] = diplomacy.incomingOffers();
  game.sendSupport = () => {
    game.phase = 'finished';
    game.message = 'Allied victory.';
    return true;
  };
  assert.ok(diplomacy.respond(offer.id, true).ok);
  assert.equal(game.message, 'Allied victory.');
  assert.equal(diplomacy.history.at(-1).outcome, 'accepted');
});
