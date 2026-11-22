import {
  Game, MIN_BOTS, MAX_BOTS, DEFAULT_BOTS, EXPANSION_SECONDS,
  UPGRADE_COSTS, GROWTH_BONUS, DEFENSE_REDUCTION, BUILDINGS,
} from './game.mjs';
import { TERRAINS } from './flow.mjs';
import { GIFT_COST, TRUCE_SECONDS, TRADE_INCOME } from './diplomacy.mjs';
import { createMapView } from './map-view.js';

const element = id => document.getElementById(id);
const commit = element('commit');
const botCount = element('bot-count');
const seedForm = element('seed-form');
const seedInput = element('seed-input');
const seedError = element('seed-error');
for (let count = MIN_BOTS; count <= MAX_BOTS; count++) {
  botCount.add(new Option(String(count), String(count)));
}
botCount.value = String(DEFAULT_BOTS);
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
let game = new Game();
let inspected = -1;
let activePanel = 'match';
let selectedBuilding = null;
let displayedOffer = null;
let lastHistoryId = null;
let lastMessage = '';
let feedbackUntil = 0;
const partner = element('partner');
const helpRival = element('help-rival');
let helpPartner = null;
let helpRivalsKey = '';
const supportReplies = new Map();
const tabs = Array.from(document.querySelectorAll('[role="tab"]'));

function showControls(open) {
  const toggle = element('toggle-controls');
  element('command-body').hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.title = open ? 'Hide controls' : 'Show controls';
  toggle.setAttribute('aria-label', toggle.title);
}
element('toggle-controls').addEventListener('click', () => showControls(element('command-body').hidden));

function openPanel(name, expanded = true) {
  activePanel = name;
  selectedBuilding = null;
  showControls(expanded);
  element('command-body').scrollTop = 0;
  for (const tab of tabs) {
    const selected = tab.id === 'tab-' + name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    element(tab.getAttribute('aria-controls')).hidden = !selected;
  }
}

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => {
    openPanel(tab.id.slice(4));
    renderPanel();
  });
  tab.addEventListener('keydown', event => {
    const destinations = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: tabs.length - 1 };
    if (!Object.hasOwn(destinations, event.key)) return;
    event.preventDefault();
    const next = tabs[(destinations[event.key] + tabs.length) % tabs.length];
    next.focus();
    next.click();
  });
});

function showInspection(index) {
  inspected = index;
  const cell = game.cells[index];
  const owner = cell && cell.owner >= 0 ? game.players[cell.owner].name : '';
  const labels = cell ? [TERRAINS[cell.terrain].name, owner, BUILDINGS[cell.building]?.name] : [];
  if (cell && activePanel === 'build' && selectedBuilding && game.phase === 'battle') {
    labels.push(game.buildError(0, selectedBuilding, index) || 'Build here');
  }
  element('inspection').textContent = labels.filter(Boolean).join(' ┬╖ ');
  element('inspection').hidden = !cell;
}

const viewport = element('viewport');
let map;
function pick(index) {
  if (game.phase === 'placement') {
    // A new seed can move the coast. Preview it before interpreting a map click.
    const draft = seedInput.value.trim();
    if (draft && draft !== String(game.seed)) {
      openPanel('match');
      loadSeed();
      return;
    }
    game.place(index);
    if (game.phase === 'expansion') openPanel('orders', false);
    lastTime = performance.now();
  } else if (game.phase === 'expansion' || game.phase === 'battle') {
    if (activePanel === 'orders') {
      game.attack(index, Number(commit.value) / 100);
    } else if (activePanel === 'build' && selectedBuilding && game.phase === 'battle') {
      if (game.build(0, selectedBuilding, index)) selectedBuilding = null;
    } else if (activePanel === 'diplomacy') {
      const id = game.cells[index]?.owner;
      if (id > 0 && game.players[id].alive) partner.value = String(id);
    }
  }
  renderPanel();
}
try {
  map = createMapView(viewport, pick, showInspection);
} catch (error) {
  viewport.textContent = 'The 3D map could not start. Enable browser hardware acceleration and reload.';
  throw error;
}

for (const key of ['plains', 'forest', 'highlands', 'water']) {
  const terrain = TERRAINS[key];
  const label = document.createElement('span');
  label.className = 'key-item';
  label.style.setProperty('--color', terrain.color);
  label.append(document.createElement('i'), terrain.name + ' ' + (terrain.speed ? terrain.speed + '├ù' : '┬╖ blocked'));
  element('terrain-key').append(label);
}

function createNationRow(player, index) {
  const row = element('players').insertRow();
  const identity = document.createElement('span');
  identity.className = 'identity';
  identity.style.setProperty('--color', player.color);
  const role = document.createElement('small');
  const name = document.createElement('span');
  name.textContent = player.name;
  identity.append(document.createElement('i'), name, role);
  const identityCell = row.insertCell();
  const upgrades = document.createElement('small');
  upgrades.className = 'nation-upgrades';
  identityCell.append(identity, upgrades);
  const people = row.insertCell();
  const coins = row.insertCell();
  return { row, role, people, coins, upgrades, human: index === 0 };
}

let rows;
function showMatchSetup() {
  const opponents = game.players.length - 1;
  const land = game.cells.reduce((total, cell) => total + Number(cell.land), 0);
  element('current-seed').textContent = String(game.seed);
  element('map-size').textContent = game.size.width + ' ├ù ' + game.size.height + ' grid ┬╖ ' + number.format(land) + ' land cells';
  element('match-description').textContent = opponents + (opponents === 1 ? ' bot opponent' : ' bot opponents');
  element('players').replaceChildren();
  rows = game.players.map(createNationRow);
  partner.replaceChildren(...game.players.slice(1).map((player, index) => new Option(player.name, String(index + 1))));
}

const shop = [
  { type: 'growth', name: 'Population growth', detail: 'Faster population growth', step: GROWTH_BONUS },
  { type: 'defense', name: 'Defense', detail: 'Fewer defender losses and slower enemy captures', step: DEFENSE_REDUCTION },
].map(upgrade => {
  const item = document.createElement('div');
  item.className = 'shop-item';
  const title = document.createElement('strong');
  title.textContent = upgrade.name;
  const level = document.createElement('small');
  const effect = document.createElement('p');
  effect.id = upgrade.type + '-effect';
  const buy = document.createElement('button');
  buy.type = 'button';
  buy.setAttribute('aria-describedby', effect.id);
  buy.addEventListener('click', () => {
    game.buyUpgrade(0, upgrade.type);
    renderPanel();
  });
  item.append(title, level, effect, buy);
  element('shop-items').append(item);
  return { ...upgrade, level, effect, buy };
});

function count(value) {
  return number.format(Math.floor(value));
}

const buildings = Object.entries(BUILDINGS).map(([type, building]) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'build-option';
  const name = document.createElement('strong');
  const price = document.createElement('span');
  price.textContent = building.cost + ' coins';
  const description = document.createElement('small');
  description.textContent = building.description;
  button.append(name, price, description);
  button.addEventListener('click', () => {
    selectedBuilding = selectedBuilding === type ? null : type;
    renderPanel();
  });
  element('build-options').append(button);
  return { type, building, button, name };
});

function renderBuildings(fighting) {
  const human = game.players[0];
  for (const { type, building, button, name } of buildings) {
    button.disabled = !fighting || !human.alive || human.coins < building.cost;
    if (button.disabled && selectedBuilding === type) selectedBuilding = null;
    name.textContent = building.name + (human.buildings[type] ? ' ┬╖ ' + human.buildings[type] + ' owned' : '');
    button.setAttribute('aria-pressed', String(type === selectedBuilding));
  }
  const chosen = BUILDINGS[selectedBuilding];
  element('build-help').textContent = !fighting ? (game.phase === 'finished' ? 'Construction has ended.' : 'Construction opens after expansion.') :
    chosen ? 'Placing ' + chosen.name.toLowerCase() + '. Click a vacant ' + (selectedBuilding === 'port' ? 'coastal ' : '') + 'tile you own.' :
    'Choose a building, then click a vacant tile you own.';
}

const diplomaticActions = [
  ['trade', 'Offer trade', 'Each partner earns ' + TRADE_INCOME + ' extra coin per second, plus any port bonus.'],
  ['alliance', 'Propose alliance', 'An alliance prevents attacks between the two nations.'],
  ['gift', 'Send aid ┬╖ ' + GIFT_COST + ' coins', 'Transfer coins to improve this nationΓÇÖs opinion of you.'],
  ['truce', 'Request truce', 'Stop fighting and protect both borders for ' + TRUCE_SECONDS + ' seconds.'],
  ['end', 'End agreements', 'Break your current agreements with this nation.'],
].map(([action, label, detail]) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.title = detail;
  button.addEventListener('click', () => {
    game.diplomacy.act(0, Number(partner.value), action);
    renderPanel();
  });
  element('diplomatic-actions').append(button);
  return { action, button };
});
partner.addEventListener('change', () => renderPanel());
helpRival.addEventListener('change', () => renderPanel());

function requestMilitaryHelp(type) {
  const ally = Number(partner.value);
  const rival = type === 'offense' ? Number(helpRival.value) : null;
  const reply = game.diplomacy.requestSupport(0, ally, type, rival);
  supportReplies.set(ally, reply.message);
  renderPanel();
}
element('ask-attack').addEventListener('click', () => requestMilitaryHelp('offense'));
element('ask-defense').addEventListener('click', () => requestMilitaryHelp('defense'));

function renderMilitaryHelp(ally) {
  const rivals = game.players.map((_, id) => id).filter(id =>
    id > 0 && id !== ally && game.players[id].alive &&
    !game.diplomacy.protected(0, id) && !game.diplomacy.protected(ally, id));
  const key = rivals.join(',');
  if (helpPartner !== ally || helpRivalsKey !== key) {
    const previous = helpPartner === ally ? Number(helpRival.value) : -1;
    helpRival.replaceChildren(...rivals.map(id => new Option(game.players[id].name, String(id))));
    if (rivals.length) {
      const choice = rivals.includes(previous) ? previous :
        rivals.find(id => !game.supportError(ally, 0, 'offense', id)) ?? rivals[0];
      helpRival.value = String(choice);
    } else {
      helpRival.add(new Option('No eligible rivals', ''));
    }
    helpPartner = ally;
    helpRivalsKey = key;
  }
  const troops = count(game.supportAmount(ally));
  const nation = game.players[ally].name;
  element('help-strength').textContent = 'A request calls for ' + troops + ' troops, 25% of ' + nation + 'ΓÇÖs home force.';
  const wait = game.diplomacy.supportWait(0, ally);
  const attackError = rivals.length ? game.supportError(ally, 0, 'offense', Number(helpRival.value)) : 'No living rival is outside both nationsΓÇÖ treaties.';
  const defenseError = game.supportError(ally, 0, 'defense', null);
  helpRival.disabled = !rivals.length;
  const attack = element('ask-attack');
  const defense = element('ask-defense');
  attack.disabled = !!(attackError || wait);
  defense.disabled = !!(defenseError || wait);
  attack.title = attackError || 'Ask ' + nation + ' to attack the selected rival.';
  defense.title = defenseError || 'Ask ' + nation + ' to station troops in Ember for up to 20 seconds.';
  const messages = [];
  if (wait) messages.push('You can ask ' + nation + ' again in ' + wait + 's.');
  else if (attackError && attackError === defenseError) messages.push(attackError);
  else {
    if (attackError) messages.push('Attack unavailable. ' + attackError);
    if (defenseError) messages.push('Defense unavailable. ' + defenseError);
  }
  element('help-availability').textContent = messages.join(' ');
  const reply = supportReplies.get(ally) || '';
  if (element('help-reply').textContent !== reply) element('help-reply').textContent = reply;
}

function renderDiplomacy(canNegotiate) {
  element('claim-victory').hidden = !game.canClaimAlliedVictory();
  for (const option of partner.options) option.disabled = !game.players[Number(option.value)].alive;
  if (!game.players[Number(partner.value)]?.alive) {
    partner.value = Array.from(partner.options).find(option => !option.disabled)?.value ?? '';
  }
  const target = Number(partner.value);
  const hasPartner = target > 0 && game.players[target]?.alive;
  partner.disabled = !hasPartner;
  element('embassy').hidden = !hasPartner;
  element('diplomatic-actions').hidden = !hasPartner;
  const militaryHelp = element('military-help');
  if (!hasPartner) {
    militaryHelp.hidden = true;
    return;
  }
  const relation = game.diplomacy.status(0, target);
  militaryHelp.hidden = !canNegotiate || !relation.allied;
  if (!militaryHelp.hidden) renderMilitaryHelp(target);
  element('embassy').style.setProperty('--envoy', game.players[target].color);
  element('personality').textContent = relation.personality;
  element('opinion').textContent = 'Opinion ' + (relation.opinion > 0 ? '+' : '') + relation.opinion;
  element('partner-description').textContent = relation.description;
  const treaties = [];
  if (relation.allied) treaties.push('Alliance');
  if (relation.trade) treaties.push('Trade agreement');
  if (relation.truceSeconds) treaties.push('Truce ┬╖ ' + relation.truceSeconds + 's');
  element('treaties').textContent = treaties.join(' / ') || (game.phase === 'placement' ? 'Place your capital to begin negotiating.' : 'No agreements');
  const unavailable = {
    alliance: relation.allied,
    trade: relation.trade,
    truce: relation.allied || relation.truceSeconds > 0,
    gift: game.players[0].coins < GIFT_COST,
    end: !treaties.length,
  };
  for (const {action, button} of diplomaticActions) button.disabled = !canNegotiate || !!unavailable[action];
}

element('claim-victory').addEventListener('click', () => {
  game.claimAlliedVictory();
  renderPanel();
});

const agreements = {
  trade: { name: 'trade', terms: 'Each nation earns +' + TRADE_INCOME + ' coin/s after expansion.' },
  alliance: { name: 'an alliance', terms: 'Both nations recall their forces and protect their shared border.' },
  truce: { name: 'a truce', terms: 'Both nations recall their forces and cease fire for ' + TRUCE_SECONDS + ' seconds.' },
};

function renderOffers(preferredId = displayedOffer) {
  const offers = game.diplomacy.incomingOffers();
  const current = offers.find(offer => offer.id === preferredId) ?? offers[0];
  element('offers').hidden = !current;
  if (!current) {
    displayedOffer = null;
    return;
  }
  if (displayedOffer !== current.id) {
    const sender = game.players[current.from].name;
    const military = current.action === 'offense' || current.action === 'defense';
    let title, terms;
    if (military) {
      const target = game.players[current.target]?.name;
      const troops = count(current.troops);
      if (current.action === 'offense') {
        title = sender + ' requests an attack on ' + target;
        terms = 'Send ' + troops + ' of your troops against ' + target + '. Ember keeps any land they capture.';
      } else {
        title = sender + ' requests reinforcements';
        terms = 'Send ' + troops + ' of your troops to defend ' + sender + (target ? ' against ' + target : '') + ' for up to 20 seconds. Survivors return home.';
      }
    } else {
      title = sender + ' offers ' + agreements[current.action].name;
      terms = agreements[current.action].terms;
    }
    element('offer-title').textContent = title;
    element('offer-terms').textContent = terms;
    element('offer-accept').textContent = military ? 'Accept and send' : 'Accept';
    if (military) {
      const ally = game.diplomacy.status(0, current.from);
      element('offer-reason').textContent = ally.personality + ' ┬╖ Your answer affects ' + sender + 'ΓÇÖs opinion of Ember.';
    } else {
      element('offer-reason').textContent = current.reason;
    }
    displayedOffer = current.id;
  }
  element('offer-time').textContent = current.secondsLeft + 's left';
  element('offer-count').textContent = String(offers.length);
  element('offer-next').hidden = offers.length < 2 || element('offer-body').hidden;
}

function showOfferBody(show) {
  element('offer-body').hidden = !show;
  element('toggle-offers').setAttribute('aria-expanded', String(show));
}
element('toggle-offers').addEventListener('click', () => {
  showOfferBody(element('offer-body').hidden);
  renderOffers();
});
element('offer-next').addEventListener('click', () => {
  const offers = game.diplomacy.incomingOffers();
  if (offers.length < 2) return;
  const index = offers.findIndex(offer => offer.id === displayedOffer);
  const next = offers[(index + 1) % offers.length];
  renderOffers(next.id);
});

for (const [id, accept] of [['offer-accept', true], ['offer-reject', false]]) {
  const button = element(id);
  let pressedOffer = null;
  const rememberOffer = () => { pressedOffer = displayedOffer; };
  button.addEventListener('pointerdown', rememberOffer);
  button.addEventListener('pointercancel', () => { pressedOffer = null; });
  button.addEventListener('keydown', event => {
    if (!event.repeat && (event.key === 'Enter' || event.key === ' ')) rememberOffer();
  });
  button.addEventListener('click', event => {
    const intended = pressedOffer ?? displayedOffer;
    pressedOffer = null;
    if (intended === null || event.detail > 1) return;
    const reply = game.diplomacy.respond(intended, accept);
    if (!reply.ok && game.phase !== 'finished') game.message = reply.message;
    renderPanel();
  });
}

function renderHistory() {
  if (!element('report-details').open) return;
  const history = game.diplomacy.history;
  const latest = history.at(-1)?.id ?? -1;
  if (lastHistoryId === latest) return;
  lastHistoryId = latest;
  const messages = history.length ? history.slice().reverse().map(event => event.message) : ['No diplomatic activity yet.'];
  element('diplomatic-history').replaceChildren(...messages.map(message => {
    const entry = document.createElement('li');
    entry.textContent = message;
    return entry;
  }));
}
element('report-details').addEventListener('toggle', renderHistory);

function renderAlliedDeployments() {
  const lines = [];
  for (const force of game.auxiliaries) {
    if (force.beneficiary !== 0) continue;
    const remaining = Math.max(0, Math.ceil(force.expiresAt - game.diplomacy.time));
    lines.push(game.players[force.supporter].name + ' defending ' + game.players[force.beneficiary].name +
      ' ┬╖ ' + count(Math.ceil(force.force)) + ' troops ┬╖ ' + remaining + 's left');
  }
  for (const attack of game.attacks) {
    if (attack.supportedNation === 0) {
      lines.push(game.players[attack.attacker].name + ' attacking ' + game.players[attack.defender].name +
        ' for Ember ┬╖ ' + count(Math.ceil(attack.force)) + ' troops');
    }
  }
  const list = element('allied-forces');
  list.hidden = !lines.length || game.phase === 'finished';
  if (!list.hidden && list.textContent !== lines.join('')) {
    list.replaceChildren(...lines.map(line => {
      const item = document.createElement('li');
      item.textContent = line;
      return item;
    }));
  }
}

function renderPanel() {
  const human = game.players[0];
  const fighting = game.phase === 'battle';
  const finished = game.phase === 'finished';
  const expanding = game.phase === 'expansion';
  const canGiveOrders = fighting || expanding;
  element('balances').hidden = game.phase === 'placement';
  botCount.disabled = game.phase !== 'placement';
  seedForm.hidden = game.phase !== 'placement';
  const phaseLabels = { placement: 'Placement', expansion: 'Expansion', battle: 'Combat', finished: 'Match over' };
  element('phase').textContent = phaseLabels[game.phase];
  let status = 'Choose land';
  if (game.phase === 'expansion') status = Math.ceil(Math.max(0, EXPANSION_SECONDS - game.elapsed)) + 's left';
  if (fighting) status = Math.floor(game.battleTime / 60) + 'm ' + String(Math.floor(game.battleTime % 60)).padStart(2, '0') + 's';
  if (finished) status = game.result === 'victory' ? 'Victory' : 'Defeat';
  element('timer').textContent = status;
  element('population').textContent = count(human.population);
  element('coins').textContent = count(human.coins);
  element('capacity-meter').style.width = Math.min(100, 100 * game.totalPopulation(0) / Math.max(1, game.capacity(0))) + '%';
  const growing = fighting && game.totalPopulation(0) < game.capacity(0);
  element('growth-rate').textContent = expanding ? '+4 per tile' : '+' + (growing ? game.rate(0).toFixed(1) : '0') + ' people/s';
  element('coin-rate').textContent = '+' + (fighting ? game.coinRate(0).toFixed(2) : '0') + ' coins/s';
  element('shop-state').textContent = fighting ? count(human.coins) + ' coins available' : finished ? 'Match over' : 'Opens after expansion';
  for (const item of shop) {
    const owned = human.upgrades[item.type];
    const cost = game.upgradeCost(0, item.type);
    const current = Math.round(100 * item.step * owned);
    const next = Math.round(100 * item.step * (owned + 1));
    item.level.textContent = 'Lv ' + owned + '/' + UPGRADE_COSTS.length;
    item.effect.textContent = item.detail + ' ┬╖ ' + current + '%' + (cost === null ? '' : ' ΓåÆ ' + next + '%');
    item.buy.textContent = cost === null ? 'Max level' : 'Buy ┬╖ ' + cost + ' coins';
    item.buy.setAttribute('aria-label', cost === null ? item.name + ' at maximum level' : 'Buy ' + item.name + ' for ' + cost + ' coins');
    item.buy.disabled = !fighting || !human.alive || cost === null || human.coins < cost;
  }
  const alive = game.players.filter(nation => nation.alive).length;
  element('survivors').textContent = alive + (alive === 1 ? ' nation left' : ' in play');
  game.players.forEach((nation, index) => {
    const { row, role, people, coins, upgrades, human } = rows[index];
    row.classList.toggle('eliminated', !nation.alive);
    role.textContent = !nation.alive ? 'Out' : human ? 'You' : 'Bot';
    people.textContent = count(game.totalPopulation(index));
    coins.textContent = count(nation.coins);
    const { growth, defense } = nation.upgrades;
    upgrades.textContent = growth || defense ? 'Growth ' + growth + ' ┬╖ Defense ' + defense : '';
  });

  const ourGarrison = game.auxiliaries.find(force => force.supporter === 0);
  commit.disabled = !canGiveOrders || !!ourGarrison;
  element('commit-label').textContent = commit.value + '%';
  const attack = game.attacks.find(order => order.attacker === 0);
  const incoming = game.attacks.filter(order => order.defender === 0);
  let order = 'Place your capital to begin.';
  if (canGiveOrders) {
    order = 'Click a rival you border to send ' + count(human.population * Number(commit.value) / 100) + ' people.';
  }
  if (attack) {
    const speed = attack.force <= attack.initial / 2 ? ' ┬╖ Slowed to 35%' : '';
    const assisting = attack.supportedNation != null ? ' for ' + game.players[attack.supportedNation].name : '';
    order = 'Attacking ' + game.players[attack.defender].name + assisting + ' ┬╖ ' + Math.ceil(attack.force) + '/' + attack.initial + speed;
  } else if (ourGarrison) {
    const remaining = Math.max(0, Math.ceil(ourGarrison.expiresAt - game.diplomacy.time));
    order = 'Defending ' + game.players[ourGarrison.beneficiary].name + ' ┬╖ ' +
      count(Math.ceil(ourGarrison.force)) + ' troops ┬╖ up to ' + remaining + 's left.';
  }
  if (incoming.length) order += ' Under attack from ' + incoming.map(order => game.players[order.attacker].name).join(', ') + '.';
  if (finished) order = 'Open Match to start a new island.';
  element('attack-status').textContent = order;
  if (activePanel === 'orders') renderAlliedDeployments();
  if (activePanel === 'build') renderBuildings(fighting);
  if (activePanel === 'diplomacy') {
    renderDiplomacy(canGiveOrders);
    renderHistory();
  }
  renderOffers();
  const mapOrders = {
    match: 'Choose Orders, Build or Diplomacy to act.',
    orders: attack || ourGarrison || incoming.length ? order : 'Attack ┬╖ ' + commit.value + '% of your people. Click a rival you border.',
    build: expanding ? 'Construction opens when expansion ends.' : selectedBuilding ? 'Click your ' + (selectedBuilding === 'port' ? 'coast' : 'land') + ' to place a ' + BUILDINGS[selectedBuilding].name.toLowerCase() + '.' : 'Choose a building in the command panel.',
    diplomacy: 'Click a rivalΓÇÖs land or choose its name in the panel to negotiate.',
  };
  element('map-order').textContent = finished ? game.message : canGiveOrders ? mapOrders[activePanel] : 'Click land to place your capital.';
  if (lastMessage !== game.message) {
    lastMessage = game.message;
    feedbackUntil = performance.now() + 4500;
    element('message').textContent = game.message;
  }
  const showFeedback = !finished && game.message && performance.now() < feedbackUntil;
  element('message').hidden = !showFeedback;
  element('map-order').hidden = !!showFeedback;
  showInspection(inspected);
}

function newMatch(seed) {
  game = new Game(Number(botCount.value), seed);
  helpPartner = null;
  helpRivalsKey = '';
  supportReplies.clear();
  displayedOffer = null;
  lastHistoryId = null;
  lastMessage = '';
  showOfferBody(true);
  openPanel('match');
  showMatchSetup();
  commit.value = '50';
  lastTime = performance.now();
  map.reset();
  showInspection(-1);
  renderPanel();
  map.draw(game);
}
function clearSeedError() {
  seedInput.removeAttribute('aria-invalid');
  seedError.textContent = '';
}

function loadSeed() {
  if (game.phase !== 'placement') return;
  const text = seedInput.value.trim();
  const seed = Number(text);
  if (!/^\d+$/.test(text) || seed > 0xffffffff) {
    seedError.textContent = 'Enter a whole number from 0 to 4294967295.';
    seedInput.setAttribute('aria-invalid', 'true');
    seedInput.focus();
    return;
  }
  clearSeedError();
  seedInput.value = '';
  if (seed !== game.seed) newMatch(seed);
  game.message = 'Loaded seed ' + seed + '. Click land to place Ember.';
  renderPanel();
}

seedForm.addEventListener('submit', event => {
  event.preventDefault();
  loadSeed();
});
seedInput.addEventListener('input', clearSeedError);
element('reset').addEventListener('click', () => {
  seedInput.value = '';
  clearSeedError();
  newMatch();
});
botCount.addEventListener('change', () => {
  if (game.phase === 'placement') newMatch(game.seed);
});
commit.addEventListener('input', renderPanel);
let lastTime = performance.now();
let lastPanel = -Infinity;
function frame() {
  const now = performance.now();
  const dt = Math.max(0, (now - lastTime) / 1000);
  lastTime = now;
  game.update(dt);
  map.draw(game);
  if (now - lastPanel >= 100) {
    renderPanel();
    lastPanel = now;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
showMatchSetup();
renderPanel();
