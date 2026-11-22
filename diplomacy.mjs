export const GIFT_COST = 15;
export const TRADE_INCOME = 1;
export const TRUCE_SECONDS = 20;

// Each threshold is the minimum opinion needed to accept that proposal.
const dispositions = [
  { name: 'Player', description: 'You decide which accords to sign.', initial: 0, gift: 12, aggression: 1 },
  { name: 'Merchant', description: 'Welcomes trade. A gift can earn an alliance.', initial: 10, trade: -12, alliance: 24, truce: -16, gift: 15, aggression: 0.88 },
  { name: 'Peacemaker', description: 'Offers alliances readily and accepts truces after a first clash.', initial: 18, trade: 6, alliance: 14, truce: -32, gift: 11, aggression: 0.72 },
  { name: 'Expansionist', description: 'Quick to attack and reluctant to sign a truce.', initial: -8, trade: 4, alliance: 48, truce: 12, gift: 12, aggression: 1.45 },
  { name: 'Broker', description: 'Values aid highly and is open to trade even after hostilities.', initial: 5, trade: -30, alliance: 30, truce: -10, gift: 21, aggression: 1.02 },
  { name: 'Isolationist', description: 'Accepts a ceasefire more readily than a trade deal or alliance.', initial: -5, trade: 24, alliance: 39, truce: -34, gift: 12, aggression: 0.8 },
  { name: 'Loyalist', description: 'Welcomes an early alliance, but takes a broken accord personally.', initial: 14, trade: 12, alliance: 12, truce: 1, gift: 10, aggression: 1.05 },
  { name: 'Pragmatist', description: 'Accepts trade and truces readily. One gift can secure an alliance.', initial: 8, trade: 4, alliance: 20, truce: -22, gift: 14, aggression: 1.10 },
  { name: 'Hardliner', description: 'Demands high trust for alliances and puts little stock in gifts.', initial: -12, trade: 6, alliance: 52, truce: 0, gift: 9, aggression: 1.32 },
  { name: 'Mediator', description: 'Favours ceasefires even through deep hostility. Alliances take more trust.', initial: 7, trade: 8, alliance: 28, truce: -53, gift: 11, aggression: 0.65 },
  { name: 'Privateer', description: 'Will trade at first contact but fights fiercely and values aid.', initial: 1, trade: -5, alliance: 36, truce: 6, gift: 17, aggression: 1.38 },
  { name: 'Sentinel', description: 'Wants a trusted ally and stays wary of trade until it receives aid.', initial: 8, trade: 22, alliance: 20, truce: -13, gift: 15, aggression: 0.96 },
  { name: 'Patron', description: 'Welcomes trade. A single early gift can secure an alliance.', initial: 11, trade: -4, alliance: 34, truce: 4, gift: 23, aggression: 1.16 },
];

const accordName = { alliance: 'alliance', trade: 'trade agreement', truce: 'truce' };
const OFFER_LIFETIME = 25;
const PAIR_COOLDOWN = 42;
const SUPPORT_COOLDOWN = 25;
const supportType = action => action === 'offense' || action === 'defense';

export class Diplomacy {
  constructor(game) {
    this.game = game;
    this.opinions = game.players.map((_, id) => game.players.map(() => dispositions[id].initial));
    this.accords = new Map();
    this.pending = [];
    this.history = [];
    this.sequence = 0;
    this.cooldowns = new Map();
    this.supportCooldowns = new Map();
    this.nextProposal = game.players.map((_, id) => id ? 4 + id * 2 : Infinity);
    this.targetCursor = game.players.map((_, id) => Math.max(0, id - 1));
  }

  get time() { return (this.game.elapsed ?? 0) + this.game.battleTime; }
  get open() { return this.game.phase === 'expansion' || this.game.phase === 'battle'; }

  log(from, to, action, outcome, message, target = null) {
    this.history.push({ id: ++this.sequence, time: this.time, from, to, action, outcome, message, target });
    if (this.history.length > 40) this.history.shift();
  }

  validPair(a, b) {
    const players = this.game.players;
    return Number.isInteger(a) && Number.isInteger(b) && a !== b && players[a]?.alive && players[b]?.alive;
  }

  key(a, b) { return Math.min(a, b) * this.game.players.length + Math.max(a, b); }

  supportWait(from, to) {
    const until = this.supportCooldowns.get(from * this.game.players.length + to) ?? 0;
    return Math.min(SUPPORT_COOLDOWN, Math.max(0, Math.ceil(until - this.time)));
  }

  status(actor, target) {
    const profile = dispositions[target];
    const pair = this.validPair(actor, target) ? this.accords.get(this.key(actor, target)) : null;
    return {
      allied: Boolean(pair?.allied), trade: Boolean(pair?.trade),
      truceSeconds: Math.ceil(Math.max(0, (pair?.truceUntil ?? 0) - this.time)),
      personality: profile?.name ?? '', description: profile?.description ?? '',
      opinion: this.opinions[target]?.[actor] ?? 0,
    };
  }

  protected(a, b) {
    if (!this.validPair(a, b)) return false;
    const pair = this.accords.get(this.key(a, b));
    return Boolean(pair && (pair.allied || pair.truceUntil > this.time));
  }

  tradeIncome(id) {
    if (this.game.phase !== 'battle' || !this.game.players[id]?.alive) return 0;
    let income = 0;
    this.game.players.forEach((player, other) => {
      if (other !== id && player.alive && this.accords.get(this.key(id, other))?.trade) income += TRADE_INCOME;
    });
    return income;
  }

  changeOpinion(observer, other, amount) {
    this.opinions[observer][other] = Math.max(-100, Math.min(100, this.opinions[observer][other] + amount));
  }

  recordAttack(attacker, defender) {
    if (!this.validPair(attacker, defender) || this.protected(attacker, defender)) return;
    const accords = this.accords.get(this.key(attacker, defender));
    const tradeBroken = Boolean(accords?.trade);
    if (accords) accords.trade = false;
    this.changeOpinion(defender, attacker, tradeBroken ? -45 : -28);
    this.changeOpinion(attacker, defender, -8);
    if (tradeBroken) {
      const { players } = this.game;
      this.log(attacker, defender, 'trade', 'broken', `${players[attacker].name} broke its trade deal with ${players[defender].name} by attacking.`);
    }
    // A change of hostilities cancels outstanding promises between these parties.
    for (const offer of [...this.pending]) {
      if (this.key(offer.from, offer.to) === this.key(attacker, defender)) this.withdraw(offer, 'withdrawn');
    }
    // A fresh front gives allied leaders a reason to confer before their next routine round.
    for (const id of [attacker, defender]) {
      if (!this.game.players[id].bot || !Number.isFinite(this.nextProposal[id])) continue;
      const allyReady = this.game.players.some((other, ally) =>
        other.alive && this.accords.get(this.key(id, ally))?.allied && !this.supportWait(id, ally));
      if (allyReady) this.nextProposal[id] = Math.min(this.nextProposal[id], this.time + 2);
    }
  }

  aggression(attacker, defender) {
    if (!this.validPair(attacker, defender) || this.protected(attacker, defender)) return 0;
    const opinion = this.opinions[attacker][defender];
    const trading = this.accords.get(this.key(attacker, defender))?.trade;
    return dispositions[attacker].aggression * (1 - opinion / 150) * (trading ? 0.5 : 1);
  }

  offerBlock(from, to, action) {
    if (!this.open || !this.validPair(from, to)) return 'Both nations must be active to negotiate.';
    const relation = this.accords.get(this.key(from, to));
    if ((action === 'alliance' && relation?.allied) || (action === 'trade' && relation?.trade)
      || (action === 'truce' && this.protected(from, to))) return 'This accord is already in effect.';
    if (action === 'trade' && this.fighting(from, to)) return 'Trade can resume when the fighting between your nations ends.';
    return '';
  }

  fighting(a, b) {
    const key = this.key(a, b);
    return this.game.attacks.some(attack => this.key(attack.attacker, attack.defender) === key);
  }

  sign(actor, target, action) {
    const key = this.key(actor, target);
    const relation = this.accords.get(key) ?? { allied: false, trade: false, truceUntil: 0 };
    if (action === 'trade') relation.trade = true;
    if (action === 'alliance') { relation.allied = true; relation.truceUntil = 0; }
    if (action === 'truce') relation.truceUntil = this.time + TRUCE_SECONDS;
    this.accords.set(key, relation);
    if (action === 'truce' || action === 'alliance') {
      for (const attack of [...this.game.attacks]) {
        if (this.key(attack.attacker, attack.defender) === key) this.game.endAttack(attack);
      }
    }
    this.game.reconcileSupport?.();
    const players = this.game.players;
    const message = `${players[target].name} accepted ${players[actor].name}ΓÇÖs ${accordName[action]}.`;
    this.log(actor, target, action, 'accepted', message);
    this.pruneOffers();
    return message;
  }

  withdraw(offer, outcome) {
    this.pending.splice(this.pending.indexOf(offer), 1);
    const label = supportType(offer.action) ? 'support request' : accordName[offer.action] + ' offer';
    this.log(offer.from, offer.to, offer.action, outcome,
      `${this.game.players[offer.from].name}ΓÇÖs ${label} was ${outcome}.`, offer.target);
  }

  pruneOffers() {
    for (const offer of [...this.pending]) {
      if (this.time >= offer.expiresAt) this.withdraw(offer, 'expired');
      else if (supportType(offer.action) ? this.supportBlock(offer) : this.offerBlock(offer.from, offer.to, offer.action)) {
        this.withdraw(offer, 'withdrawn');
      }
    }
  }

  incomingOffers() {
    this.pruneOffers();
    return this.pending.map(offer => ({ ...offer, secondsLeft: Math.ceil(offer.expiresAt - this.time) }));
  }

  respond(id, accept) {
    this.pruneOffers();
    const index = this.pending.findIndex(offer => offer.id === id);
    if (index < 0 || typeof accept !== 'boolean') {
      return { ok: false, message: 'This offer cannot be answered.' };
    }
    const [offer] = this.pending.splice(index, 1);
    if (supportType(offer.action)) return this.resolveSupport(offer, accept);
    this.cooldowns.set(this.key(offer.from, offer.to), this.time + PAIR_COOLDOWN);
    let message;
    if (accept) message = this.sign(offer.from, offer.to, offer.action);
    else {
      message = `You declined ${this.game.players[offer.from].name}ΓÇÖs ${accordName[offer.action]}.`;
      this.log(offer.from, offer.to, offer.action, 'declined', message);
    }
    this.game.message = message;
    return { ok: true, message };
  }

  act(actor, target, action, reason = '') {
    const game = this.game;
    const reply = (ok, message) => {
      if (actor === 0) game.message = message;
      return { ok, message };
    };
    if (!this.open || !this.validPair(actor, target)) {
      return reply(false, 'Both nations must be active to negotiate.');
    }
    const sender = game.players[actor];
    const other = game.players[target];
    const profile = dispositions[target];
    const key = this.key(actor, target);
    const relation = this.accords.get(key) ?? { allied: false, trade: false, truceUntil: 0 };
    if (action === 'gift') {
      if (sender.coins < GIFT_COST) return reply(false, `Aid costs ${GIFT_COST} coins.`);
      sender.coins -= GIFT_COST;
      other.coins += GIFT_COST;
      this.changeOpinion(target, actor, profile.gift);
      this.log(actor, target, action, 'sent', `${sender.name} sent ${GIFT_COST} coins to ${other.name}.`);
      return reply(true, `${other.name} received ${GIFT_COST} coins in aid.`);
    }
    const ceasefire = relation.truceUntil > this.time;
    if (action === 'end') {
      if (!relation.allied && !relation.trade && !ceasefire) return reply(false, 'There are no active accords to end.');
      this.accords.delete(key);
      this.game.reconcileSupport?.();
      this.changeOpinion(target, actor, profile.name === 'Loyalist' ? -32 : -18);
      this.cooldowns.set(key, this.time + PAIR_COOLDOWN);
      for (const offer of [...this.pending]) {
        if (this.key(offer.from, offer.to) === key) this.withdraw(offer, 'withdrawn');
      }
      const message = `${sender.name} ended its accords with ${other.name}.`;
      this.log(actor, target, action, 'ended', message);
      return reply(true, message);
    }
    if (!Object.hasOwn(accordName, action)) return reply(false, 'Unknown diplomatic action.');
    const blocked = this.offerBlock(actor, target, action);
    if (blocked) return reply(false, blocked);
    if (sender.bot) {
      this.pruneOffers();
      if ((this.cooldowns.get(key) ?? 0) > this.time) return reply(false, 'Negotiations are on hold.');
      if (!other.bot && this.pending.length >= 2) return reply(false, 'Other offers are awaiting a reply.');
      this.cooldowns.set(key, this.time + PAIR_COOLDOWN);
      if (!other.bot) {
        const offer = { id: ++this.sequence, from: actor, to: target, action, reason, expiresAt: this.time + OFFER_LIFETIME };
        this.pending.push(offer);
        const article = action === 'alliance' ? 'an' : 'a';
        const message = `${sender.name} offers you ${article} ${accordName[action]}.`;
        this.log(actor, target, action, 'offered', message);
        return reply(true, message);
      }
    }
    if (this.opinions[target][actor] < profile[action]) {
      this.log(actor, target, action, 'declined', `${other.name} declined ${sender.name}ΓÇÖs ${accordName[action]}.`);
      return reply(false, `${other.name} declined the ${accordName[action]}. Send aid to improve relations.`);
    }
    return reply(true, this.sign(actor, target, action));
  }

  supportBlock(offer) {
    const { from, to, action, target, troops, contextual } = offer;
    if (!this.open || !this.validPair(from, to) || !this.status(from, to).allied) return 'Only active allies can exchange military support.';
    if (!supportType(action)) return 'Choose an offensive or defensive order.';
    if ((action === 'offense' || target !== null) &&
        (!this.validPair(from, target) || !this.validPair(to, target))) return 'Choose a living rival outside this alliance.';
    if (contextual && !this.game.attacks.some(attack => action === 'defense'
      ? attack.attacker === target && attack.defender === from
      : attack.attacker === from && attack.defender === target)) return 'The campaign that prompted this request has ended.';
    return this.game.supportError(to, from, action, target, troops);
  }

  supportRefusal({ from, to, action, target }) {
    const profile = dispositions[to];
    const trust = this.opinions[to][from];
    const pressure = this.game.attacks.some(attack => attack.defender === to);
    const tradeAtRisk = action === 'offense' && this.status(to, target).trade;
    const sharedEnemy = target !== null && this.game.attacks.some(attack => attack.attacker === target && attack.defender === to);
    const threshold = action === 'offense'
      ? 28 + (1 - profile.aggression) * 45
      : 9 + (profile.aggression - 1) * 20 + (target === null ? 7 : -7);
    const needed = threshold + profile.alliance / 4 + (pressure ? 14 : 0)
      + (tradeAtRisk ? 30 : 0) - (sharedEnemy ? 18 : 0);
    if (trust >= needed) return '';
    if (tradeAtRisk) return 'Our trade with that nation matters more than this campaign.';
    if (pressure && !sharedEnemy) return 'We need our reserves to defend our own land.';
    if (action === 'offense' && profile.aggression < 1) return 'We need greater trust to join an offensive war.';
    return 'We need more trust before committing our people.';
  }

  resolveSupport(offer, accept, reason = '') {
    const { from, to, action, target, troops } = offer;
    const game = this.game;
    const requester = game.players[from].name;
    const helper = game.players[to].name;
    const objective = action === 'offense' ? `the attack on ${game.players[target].name}` : `the defense of ${requester}`;
    if (accept && !game.sendSupport(to, from, action, target, troops)) {
      const message = 'The requested force can no longer be deployed.';
      if (from === 0 || to === 0) game.message = message;
      return { ok: false, message };
    }
    // Trust is directional: the nation that asked remembers who came to help.
    const delta = accept ? 16 : (action === 'defense' ? -8 : -4);
    this.changeOpinion(from, to, delta);
    const message = accept ? `${helper} committed ${troops} people to ${objective}.`
      : `${helper} declined ${requester}ΓÇÖs request to join ${objective}.${reason ? ' ' + reason : ''}`;
    this.log(from, to, action, accept ? 'accepted' : 'declined', message, target);
    if ((from === 0 || to === 0) && this.open) game.message = message;
    return { ok: accept || to === 0, message };
  }

  requestSupport(from, to, action, target = null, contextual = false) {
    const game = this.game;
    const fail = message => {
      if (from === 0) game.message = message;
      return { ok: false, message };
    };
    if (!this.validPair(from, to)) return fail('Choose an active ally.');
    const offer = { from, to, action, target, contextual, troops: game.supportAmount(to) };
    const blocked = this.supportBlock(offer);
    if (blocked) return fail(blocked);
    const wait = this.supportWait(from, to);
    if (wait) return fail(`Wait ${wait}s before asking this ally for more troops.`);
    this.pruneOffers();
    if (!game.players[to].bot && (this.pending.length >= 2 || this.pending.some(item => item.from === from))) {
      return fail('An offer is already awaiting a reply.');
    }
    this.supportCooldowns.set(from * game.players.length + to, this.time + SUPPORT_COOLDOWN);
    if (game.players[to].bot) {
      const reason = this.supportRefusal(offer);
      return this.resolveSupport(offer, !reason, reason);
    }
    const requester = game.players[from].name;
    const rival = game.players[target]?.name;
    const reason = action === 'offense' ? `${requester} asks you to join its attack on ${rival}.`
      : rival ? `${rival} is attacking ${requester}. Your ally requests reinforcements.`
        : `${requester} requests a garrison for its defenses.`;
    this.pending.push({ ...offer, reason, id: ++this.sequence, expiresAt: this.time + OFFER_LIFETIME });
    this.log(from, to, action, 'offered', reason, target);
    return { ok: true, message: reason };
  }

  supportMotive(actor, helper) {
    if (!this.accords.get(this.key(actor, helper))?.allied || this.supportWait(actor, helper)) return null;
    if (helper === 0 && this.pending.some(offer => offer.from === actor)) return null;
    const profile = dispositions[actor];
    let best = null;
    for (const attack of this.game.attacks) {
      let action, rival, score;
      if (attack.defender === actor) {
        action = 'defense';
        rival = attack.attacker;
        score = 10 - profile.aggression;
      } else if (attack.attacker === actor) {
        action = 'offense';
        rival = attack.defender;
        score = 6 + profile.aggression;
        if (profile.aggression < 0.8 && attack.force > attack.initial * 0.75) continue;
      } else continue;
      if (this.supportBlock({ from: actor, to: helper, action, target: rival, troops: this.game.supportAmount(helper), contextual: true })) continue;
      // Among suitable allies on similar fronts, ask the one the requester
      // trusts most. Aid, past support decisions and betrayals change this.
      score += this.opinions[actor][helper] / 250;
      if (!best || score > best.score) best = { action, rival, score };
    }
    return best;
  }

  motive(actor, target) {
    const profile = dispositions[actor];
    const status = this.status(target, actor);
    const weaker = this.game.players[actor].population < this.game.players[target].population * 0.8;
    if (this.fighting(actor, target)) {
      if (weaker || profile.aggression <= 1 || profile.truce < 0) {
        return { action: 'truce', score: 6, reason: 'We want time to regroup along our shared border.' };
      }
      return null;
    }
    if (status.opinion >= profile.alliance - (status.trade ? 16 : 0) && !status.allied) {
      return { action: 'alliance', score: 3, reason: status.trade ? 'Our trade is flourishing. Let us secure our borders together.' : 'We want a lasting guarantee of peace between our nations.' };
    }
    if (!status.trade && status.opinion >= profile.trade - 12) {
      return { action: 'trade', score: 2, reason: 'A trade route will earn coins for both our treasuries.' };
    }
    if (weaker && !this.protected(actor, target) && profile.truce < 15) {
      return { action: 'truce', score: 1, reason: 'Your nation is stronger. We seek twenty seconds of peace.' };
    }
    return null;
  }

  update() {
    this.pruneOffers();
    if (!this.open) return;
    const players = this.game.players;
    for (let actor = 1; actor < players.length; actor++) {
      if (!players[actor].alive || this.time < this.nextProposal[actor]) continue;
      const interval = 14 + (actor * 3) % 8;
      this.nextProposal[actor] += interval * (1 + Math.floor((this.time - this.nextProposal[actor]) / interval));
      // The starting candidate rotates after a proposal. Need drives the
      // choice; otherwise equally attractive partners take turns.
      let best = null;
      for (let offset = 0; offset < players.length; offset++) {
        const target = (this.targetCursor[actor] + offset) % players.length;
        if (!this.validPair(actor, target) || (!target && this.pending.length >= 2)) continue;
        const support = this.supportMotive(actor, target);
        const negotiate = (this.cooldowns.get(this.key(actor, target)) ?? 0) <= this.time;
        const motive = support ?? (negotiate ? this.motive(actor, target) : null);
        if (!motive || (best && motive.score <= best.score)) continue;
        best = { ...motive, target };
      }
      if (!best) continue;
      this.targetCursor[actor] = (best.target + 1) % players.length;
      if (supportType(best.action)) this.requestSupport(actor, best.target, best.action, best.rival, true);
      else this.act(actor, best.target, best.action, best.reason);
    }
  }
}
