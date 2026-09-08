import { randomInt } from 'node:crypto';
import { bestHigh, bestLow, compareHigh, compareLow } from './evaluator.js';

const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const SUITS = ['s','h','d','c'];
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const moneyValue = n => round2(Number(n) || 0);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const MAX_CHIPS = 1e12;

export const DEFAULT_CONFIG = {
  name: 'Custom Home Game', maxPlayers: 8, startingStack: 1000,
  construction: 'omaha', holeCards: 4, boards: 1,
  betting: 'pot-limit', smallBlind: 5, bigBlind: 10, ante: 0,
  hiLow: false,
  bombPotEnabled: false, bombPotAmount: 20, bombPotEvery: 5, bombPotSkipPreflop: true,
  sevenTwoEnabled: false, sevenTwoPayment: 1, antiNitEnabled: false,
  actionTimerSeconds: 20, nextHandTimerSeconds: 10
};

export function sanitizeConfig(input = {}) {
  const c = { ...DEFAULT_CONFIG, ...input };
  c.name = String(c.name || DEFAULT_CONFIG.name).slice(0, 48);
  c.maxPlayers = clamp(Math.trunc(Number(c.maxPlayers) || 8), 2, 10);
  c.startingStack = clamp(round2(Number(c.startingStack) || 1000), 0.01, MAX_CHIPS);
  c.construction = c.construction === 'holdem' ? 'holdem' : 'omaha';
  c.holeCards = clamp(Math.trunc(Number(c.holeCards) || 4), c.construction === 'holdem' ? 2 : 4, 8);
  c.boards = clamp(Math.trunc(Number(c.boards) || 1), 1, 4);
  c.betting = c.betting === 'no-limit' ? 'no-limit' : 'pot-limit';
  c.smallBlind = clamp(round2(Number(c.smallBlind) || 0), 0, MAX_CHIPS);
  c.bigBlind = clamp(round2(Number(c.bigBlind) || 0.01), Math.max(c.smallBlind, 0.01), MAX_CHIPS);
  c.ante = clamp(round2(Number(c.ante) || 0), 0, MAX_CHIPS);
  c.hiLow = Boolean(c.hiLow);
  c.bombPotEnabled = Boolean(c.bombPotEnabled);
  c.bombPotAmount = clamp(round2(Number(c.bombPotAmount) || 0), 0, MAX_CHIPS);
  c.bombPotEvery = clamp(Math.trunc(Number(c.bombPotEvery) || 5), 1, 100);
  c.bombPotSkipPreflop = Boolean(c.bombPotSkipPreflop);
  c.sevenTwoEnabled = Boolean(c.sevenTwoEnabled);
  c.sevenTwoPayment = clamp(round2(Number(c.sevenTwoPayment) || 0), 0, MAX_CHIPS);
  c.antiNitEnabled = Boolean(c.antiNitEnabled);
  c.actionTimerSeconds = clamp(Math.trunc(Number(c.actionTimerSeconds) || 20), 10, 30);
  c.nextHandTimerSeconds = clamp(Math.trunc(Number(c.nextHandTimerSeconds) || 10), 10, 30);
  return c;
}

function deck() { return SUITS.flatMap(suit => RANKS.map(rank => ({ rank, suit }))); }
function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function nextSeatIndex(seats, from, predicate = p => p) {
  for (let i = 1; i <= seats.length; i++) { const idx = (from + i) % seats.length; if (predicate(seats[idx])) return idx; }
  return -1;
}
function activeForHand(p) { return p && p.inHand && !p.folded; }
function canAct(p) { return activeForHand(p) && !p.allIn; }
function isBetweenHands(phase) { return phase === 'waiting' || phase === 'complete'; }

export class PokerTable {
  constructor(config = {}) {
    this.config = sanitizeConfig(config);
    this.seats = Array(this.config.maxPlayers).fill(null);
    this.hostPlayerId = null;
    this.handNumber = 0;
    this.dealerIndex = -1;
    this.phase = 'waiting';
    this.street = 'waiting';
    this.boards = [];
    this.boardMeta = [];
    this.baseBoardCount = this.config.boards;
    this.runCount = 1;
    this.deck = [];
    this.currentBet = 0;
    this.minRaise = this.config.bigBlind;
    this.actorIndex = -1;
    this.needsAction = new Set();
    this.log = [];
    this.debugLog = [];
    this.debugSeq = 0;
    this.debugStartedAt = Date.now();
    this.lastResult = null;
    this.bombPot = false;
    this.forceBombPotNext = false;
    this.runoutVote = null;
    this.declarations = new Map();
    this.actionDeadline = null;
    this.nextHandAt = null;
    this.allInReveal = null;
    this.runoutDeclarationBoardIndex = null;
    this.buyInRequests = [];
    this.requestSeq = 0;
    this.paused = false;
    this.gameEnded = false;
    this.ledger = new Map();
    this.ledgerEvents = [];
    this.sessionStartedAt = Date.now();
    this.nitCoins = new Map();
    this.nitCycleHands = 0;
    this.deckError = null;
    this.burnedCards = [];
    this.testBotSeq = 0;
    this.actionDeadline = null;
    this.nextHandAt = null;
    this.allInReveal = null;
    this.runoutDeclarationBoardIndex = null;
  }

  debug(type, details = {}) {
    const entry = { seq: ++this.debugSeq, at: Date.now(), hand: this.handNumber, phase: this.phase, street: this.street, type: String(type || 'EVENT'), details };
    this.debugLog.push(entry);
    if (this.debugLog.length > 5000) this.debugLog.shift();
    return entry;
  }

  debugSnapshot() {
    return {
      version: 'hosted-beta-1.0.0',
      startedAt: this.debugStartedAt,
      generatedAt: Date.now(),
      handNumber: this.handNumber,
      phase: this.phase,
      street: this.street,
      config: { ...this.config },
      eventCount: this.debugLog.length,
      events: this.debugLog.map(e => ({ ...e }))
    };
  }

  addLog(text) {
    const entry = { at: Date.now(), text };
    this.log.push(entry);
    if (this.log.length > 160) this.log.shift();
    this.debug('HAND_LOG', { text });
  }

  ledgerEntry(playerId, name = 'Player') {
    if (!this.ledger.has(playerId)) this.ledger.set(playerId, { playerId, name, totalBuyIn: 0, totalCashOut: 0, status: 'spectating', firstJoinedAt: Date.now(), lastUpdatedAt: Date.now() });
    const e = this.ledger.get(playerId); e.name = name || e.name; e.lastUpdatedAt = Date.now(); return e;
  }

  ledgerEvent(playerId, type, amount = 0, note = '') {
    const p = this.seats.find(x => x?.id === playerId);
    const e = this.ledgerEntry(playerId, p?.name || this.ledger.get(playerId)?.name || 'Player');
    this.ledgerEvents.push({ at: Date.now(), playerId, name: e.name, type, amount: round2(amount), note });
    if (this.ledgerEvents.length > 500) this.ledgerEvents.shift();
    e.lastUpdatedAt = Date.now();
  }

  recordBuyIn(player, amount, type = 'buy-in') {
    const e = this.ledgerEntry(player.id, player.name); e.totalBuyIn = round2(e.totalBuyIn + amount); e.status = 'seated'; this.ledgerEvent(player.id, type, amount);
  }

  recordCashOut(player, amount, type = 'cash-out') {
    const e = this.ledgerEntry(player.id, player.name); e.totalCashOut = round2(e.totalCashOut + amount); e.status = 'cashed-out'; this.ledgerEvent(player.id, type, amount);
  }

  ledgerSnapshot() {
    return [...this.ledger.values()].map(e => {
      const seated = this.seats.find(p => p?.id === e.playerId);
      const currentStack = seated && !this.gameEnded ? round2(seated.stack) : 0;
      return { ...e, currentStack, net: round2(e.totalCashOut + currentStack - e.totalBuyIn), away: Boolean(seated?.away), seated: Boolean(seated) };
    }).sort((a,b) => b.net - a.net || a.name.localeCompare(b.name));
  }

  seatPlayer(player, seatIndex) {
    if (!isBetweenHands(this.phase)) throw new Error('Wait for the hand to finish before taking a seat.');
    if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= this.seats.length) throw new Error('Invalid seat.');
    if (this.seats[seatIndex]) throw new Error('Seat is occupied.');
    if (this.seats.some(p => p?.id === player.id)) throw new Error('You are already seated.');
    this.seats[seatIndex] = {
      id: player.id, name: player.name, stack: this.config.startingStack, connected: true,
      inHand: false, folded: false, allIn: false, hole: [], streetBet: 0, contributed: 0, revealedCards: [],
      away: false, pendingLeave: false
    };
    if (!this.hostPlayerId) this.hostPlayerId = player.id;
    this.nitCoins.set(player.id, this.nitCoins.get(player.id) || 0);
    this.recordBuyIn(this.seats[seatIndex], this.config.startingStack, 'initial buy-in');
    this.addLog(`${player.name} sat down.`);
  }

  setConnected(playerId, connected) { const p = this.seats.find(x => x?.id === playerId); if (p) p.connected = connected; }

  addTestBot(playerId) {
    if (playerId !== this.hostPlayerId) throw new Error('Only the host can add testing bots.');
    if (!isBetweenHands(this.phase)) throw new Error('Add testing bots between hands.');
    const seatIndex = this.seats.findIndex(p => !p);
    if (seatIndex < 0) throw new Error('There are no open seats for a testing bot.');
    this.testBotSeq += 1;
    const bot = {
      id: `testbot-${this.testBotSeq}`, name: `Test Bot ${this.testBotSeq}`, stack: this.config.startingStack, connected: true,
      inHand: false, folded: false, allIn: false, hole: [], streetBet: 0, contributed: 0, revealedCards: [],
      away: false, pendingLeave: false, isTestBot: true
    };
    this.seats[seatIndex] = bot;
    this.nitCoins.set(bot.id, 0);
    this.recordBuyIn(bot, this.config.startingStack, 'testing bot buy-in');
    this.addLog(`${bot.name} added by host (AUTO CHECK/CALL · RUN ONCE).`);
    this.debug('TEST_BOT_ADDED', { botId:bot.id, botName:bot.name, seatIndex, stack:bot.stack });
    return bot;
  }

  removeTestBot(playerId, botId) {
    if (playerId !== this.hostPlayerId) throw new Error('Only the host can remove testing bots.');
    if (!isBetweenHands(this.phase)) throw new Error('Remove testing bots between hands.');
    const i = this.seats.findIndex(p => p?.id === botId && p.isTestBot);
    if (i < 0) throw new Error('Testing bot not found.');
    const bot = this.seats[i];
    this.recordCashOut(bot, bot.stack, 'testing bot removed');
    this.seats[i] = null;
    this.nitCoins.delete(bot.id);
    this.addLog(`${bot.name} removed by host.`);
    this.debug('TEST_BOT_REMOVED', { botId:bot.id, botName:bot.name, seatIndex:i, stack:bot.stack });
  }

  processTestBots() {
    // Testing bots are intentionally simple and deterministic. They never bet or raise:
    // check when possible, otherwise call. They vote for one run and auto-declare BOTH
    // solely so automated test hands cannot stall in declaration games.
    if (this.phase === 'runout-vote' && this.runoutVote) {
      const botId = this.runoutVote.voterIds.find(id => {
        const p = this.seats.find(x => x?.id === id);
        return p?.isTestBot && !this.runoutVote.votes.has(id);
      });
      if (botId) {
        this.debug('TEST_BOT_DECISION', { botId, phase:this.phase, decision:'run-once' });
        this.voteRunout(botId, 1);
        return true;
      }
    }
    if (this.phase === 'declare') {
      const bot = this.seats.find(p => p?.isTestBot && activeForHand(p) && !this.declarations.has(p.id));
      if (bot) {
        const choices = Array(this.boards.length).fill('both');
        this.debug('TEST_BOT_DECISION', { botId:bot.id, phase:this.phase, decision:'declare-both', choices });
        this.declare(bot.id, choices);
        return true;
      }
    }
    if (this.phase === 'declare-runout' && this.runoutDeclarationBoardIndex != null) {
      const bi = this.runoutDeclarationBoardIndex;
      const bot = this.seats.find(p => p?.isTestBot && activeForHand(p) && !this.declarations.get(p.id)?.[bi]);
      if (bot) {
        this.debug('TEST_BOT_DECISION', { botId:bot.id, phase:this.phase, boardIndex:bi, decision:'declare-both' });
        this.declare(bot.id, ['both']);
        return true;
      }
    }
    if (this.actorIndex >= 0) {
      const bot = this.seats[this.actorIndex];
      if (bot?.isTestBot && canAct(bot)) {
        const valid = this.validActions(bot.id);
        if (!valid) return false;
        const decision = valid.canCheck ? 'check' : valid.canCall ? 'call' : 'fold';
        this.debug('TEST_BOT_DECISION', { botId:bot.id, phase:this.phase, street:this.street, decision, toCall:valid.toCall });
        this.act(bot.id, decision);
        return true;
      }
    }
    return false;
  }

  removeSeatAndCashOut(playerId, reason = 'cash-out') {
    const i = this.seats.findIndex(p => p?.id === playerId); if (i < 0) return;
    const p = this.seats[i]; const wasHost = this.hostPlayerId === playerId;
    this.recordCashOut(p, p.stack, reason);
    this.seats[i] = null;
    this.buyInRequests = this.buyInRequests.filter(r => r.playerId !== playerId || r.status !== 'pending');
    this.addLog(`${p.name} left the table and cashed out ${p.stack}.`);
    if (wasHost) this.hostPlayerId = this.seats.find(Boolean)?.id || null;
  }

  leave(playerId) {
    const i = this.seats.findIndex(p => p?.id === playerId); if (i < 0) return;
    const p = this.seats[i];
    if (isBetweenHands(this.phase)) { this.removeSeatAndCashOut(playerId); return; }
    p.pendingLeave = true; p.away = true;
    if (p.inHand && !p.folded && !p.allIn && !['allin-reveal','runout-vote','declare','declare-runout','showdown'].includes(this.phase)) {
      p.folded = true; this.needsAction.delete(p.id); this.addLog(`${p.name} leaves the table and folds; cash-out will complete after the hand.`);
      if (this.actorIndex === i) { this.actionDeadline = null; this.afterAction(i); }
      else if (this.seats.filter(activeForHand).length === 1) this.awardUncontested(this.seats.find(activeForHand));
    } else this.addLog(`${p.name} will leave and cash out after the hand.`);
  }

  toggleAway(playerId, away) {
    const p = this.seats.find(x => x?.id === playerId); if (!p) throw new Error('Sit at the table first.');
    p.away = Boolean(away);
    this.ledgerEntry(p.id, p.name).status = p.away ? 'away' : 'seated';
    this.addLog(`${p.name} is ${p.away ? 'away and will be dealt out' : 'back at the table'}.`);
  }

  pauseGame(playerId) {
    if (playerId !== this.hostPlayerId) throw new Error('Only the host can pause the game.');
    if (this.phase !== 'complete' && this.phase !== 'waiting') throw new Error('Pause the game after the current hand finishes.');
    this.paused = true; this.nextHandAt = null; this.addLog('Host paused the game.');
  }

  resumeGame(playerId) {
    if (playerId !== this.hostPlayerId) throw new Error('Only the host can resume the game.');
    if (this.gameEnded) throw new Error('This game has ended.');
    this.paused = false;
    if (this.phase === 'complete') this.nextHandAt = Date.now() + this.config.nextHandTimerSeconds * 1000;
    this.addLog('Host resumed the game.');
  }

  endGame(playerId) {
    if (playerId !== this.hostPlayerId) throw new Error('Only the host can end the game.');
    if (!isBetweenHands(this.phase)) throw new Error('End the game after the current hand finishes.');
    for (const p of this.seats.filter(Boolean)) {
      if (p.stack > 0) this.recordCashOut(p, p.stack, 'final cash-out');
      p.stack = 0; p.inHand = false; p.allIn = false; p.streetBet = 0; p.contributed = 0;
      this.ledgerEntry(p.id, p.name).status = 'finished';
    }
    this.gameEnded = true; this.paused = true; this.phase = 'ended'; this.street = 'ended'; this.nextHandAt = null; this.actorIndex = -1; this.actionDeadline = null;
    this.addLog('Host ended the game. Final ledger locked.');
  }

  updateConfig(playerId, patch) {
    if (playerId !== this.hostPlayerId) throw new Error('Only the host can change game rules.');
    if (!isBetweenHands(this.phase)) throw new Error('Rules can only change between hands.');
    const next = sanitizeConfig({ ...this.config, ...patch });
    if (next.maxPlayers !== this.config.maxPlayers) {
      const occupied = this.seats.filter(Boolean).length;
      if (next.maxPlayers < occupied) throw new Error('New seat count is smaller than the number of seated players.');
      if (next.maxPlayers < this.seats.length && this.seats.slice(next.maxPlayers).some(Boolean)) throw new Error('Move players out of the seats being removed first.');
      this.seats.length = next.maxPlayers; while (this.seats.length < next.maxPlayers) this.seats.push(null);
    }
    if (next.sevenTwoEnabled && !(next.construction === 'holdem' && next.holeCards === 2)) throw new Error('The 7-2 game requires 2-card Hold’em.');
    const activeCount = this.seats.filter(p => p && p.stack > 0 && !p.away && !p.pendingLeave).length;
    if (activeCount >= 2) {
      const advice = this.capacityAdvice(activeCount, next);
      if (!advice.baseSetupFits) throw new Error(advice.message);
    }
    this.config = next;
    this.debug('CONFIG_UPDATED', { by:playerId, config:{...this.config}, activeCount });
    this.addLog('Host updated the game rules.');
  }

  commit(p, amount) {
    const before = { stack: moneyValue(p.stack), streetBet: moneyValue(p.streetBet), contributed: moneyValue(p.contributed) };
    const pay = moneyValue(Math.min(p.stack, Math.max(0, Number(amount) || 0)));
    p.stack = moneyValue(p.stack - pay);
    p.streetBet = moneyValue(p.streetBet + pay);
    p.contributed = moneyValue(p.contributed + pay);
    if (p.stack <= 0) p.allIn = true;
    this.debug('CHIPS_COMMIT', { playerId: p.id, player: p.name, requested: moneyValue(amount), paid: pay, before, after: { stack:p.stack, streetBet:p.streetBet, contributed:p.contributed }, allIn:p.allIn });
    return pay;
  }

  setStack(playerId, targetPlayerId, amount) {
    if (playerId !== this.hostPlayerId) throw new Error('Only the host can edit stacks.');
    if (!isBetweenHands(this.phase)) throw new Error('Stacks can only be edited between hands.');
    const p = this.seats.find(x => x?.id === targetPlayerId); if (!p) throw new Error('Player not found.');
    const next = round2(Number(amount)); if (!Number.isFinite(next) || next < 0 || next > MAX_CHIPS) throw new Error('Invalid stack.');
    const delta = round2(next - p.stack);
    if (delta > 0) this.recordBuyIn(p, delta, 'host stack increase');
    else if (delta < 0) this.recordCashOut(p, -delta, 'host stack decrease');
    p.stack = next; this.addLog(`Host set ${p.name}'s stack to ${next}.`);
  }

  requestBuyIn(playerId, amount) {
    if (!isBetweenHands(this.phase)) throw new Error('Buy-ins can only be requested between hands.');
    const p = this.seats.find(x => x?.id === playerId); if (!p) throw new Error('Sit at the table before requesting a buy-in.');
    if (p.stack > 0) throw new Error('Buy-back requests are available after your stack reaches 0.');
    const value = round2(Number(amount));
    if (!Number.isFinite(value) || value < 0 || value > MAX_CHIPS) throw new Error('Invalid buy-in amount.');
    if (this.buyInRequests.some(r => r.playerId === playerId && r.status === 'pending')) throw new Error('You already have a pending buy-in request.');
    const request = { id: `buyin-${++this.requestSeq}`, playerId, playerName: p.name, amount: value, status: 'pending', createdAt: Date.now() };
    this.buyInRequests.push(request);
    this.addLog(`${p.name} requested a buy-in of ${value}.`);
    return request;
  }

  decideBuyIn(hostId, requestId, approve) {
    if (hostId !== this.hostPlayerId) throw new Error('Only the host can approve buy-ins.');
    if (!isBetweenHands(this.phase)) throw new Error('Buy-ins can only be handled between hands.');
    const req = this.buyInRequests.find(r => r.id === requestId && r.status === 'pending');
    if (!req) throw new Error('Buy-in request not found.');
    const p = this.seats.find(x => x?.id === req.playerId);
    if (!p) { req.status = 'declined'; throw new Error('Player is no longer seated.'); }
    if (approve) {
      p.stack = moneyValue(p.stack + req.amount);
      this.recordBuyIn(p, req.amount, 'rebuy');
      req.status = 'approved';
      this.addLog(`Host approved ${p.name}'s buy-in of ${req.amount}.`);
    } else {
      req.status = 'declined';
      this.addLog(`Host declined ${p.name}'s buy-in of ${req.amount}.`);
    }
  }

  forceBombPot(playerId) {
    if (playerId !== this.hostPlayerId) throw new Error('Only the host can force a bomb pot.');
    if (!isBetweenHands(this.phase)) throw new Error('Queue bomb pots between hands.');
    this.forceBombPotNext = true; this.addLog('Host queued a bomb pot for the next hand.');
  }

  cardsPerFreshBoard() { return 8; } // 5 community cards + 3 burns.

  futureCardsPerBoard(boardLength = 0) {
    if (boardLength <= 0) return 8; // burn + flop, burn + turn, burn + river
    if (boardLength === 3) return 4; // burn+turn, burn+river
    if (boardLength === 4) return 2; // burn+river
    return 0;
  }

  capacityAdvice(playerCount, config = this.config) {
    const players = Math.max(0, Number(playerCount) || 0);
    const hole = config.holeCards;
    const boards = config.boards;
    const holeUse = players * hole;
    const freshBoardUse = boards * this.cardsPerFreshBoard();
    const needed = holeUse + freshBoardUse;
    const maxBoards = Math.max(0, Math.min(4, Math.floor((52 - holeUse) / this.cardsPerFreshBoard())));
    const maxHoleCards = players > 0 ? Math.max(0, Math.min(8, Math.floor((52 - freshBoardUse) / players))) : 8;
    const maxRunsPreflop = boards > 0 ? Math.max(0, Math.min(4, Math.floor((52 - holeUse) / freshBoardUse))) : 0;
    const baseSetupFits = needed <= 52;
    return {
      playerCount: players, holeCards: hole, boards, needed, baseSetupFits, maxBoards, maxHoleCards, maxRunsPreflop,
      message: baseSetupFits
        ? `${players} players × ${hole} hole cards with ${boards} board${boards===1?'':'s'} uses ${needed}/52 cards including burns. Preflop all-ins can run at most ${maxRunsPreflop || 1} time${maxRunsPreflop===1?'':'s'}.`
        : `Not enough cards: ${players} players × ${hole} hole cards + ${boards} board${boards===1?'':'s'} (8 cards each including burns) needs ${needed}/52. With ${players} players, use at most ${maxHoleCards} hole cards at ${boards} board${boards===1?'':'s'}, or at most ${maxBoards} board${maxBoards===1?'':'s'} at ${hole} hole cards.`
    };
  }

  burnCard() {
    if (!this.deck.length) return this.failDeckCapacity('burn card');
    const c = this.deck.pop(); this.burnedCards.push(c); return c;
  }

  drawCard(context = 'community card') {
    if (!this.deck.length) return this.failDeckCapacity(context);
    return this.deck.pop();
  }

  failDeckCapacity(context) {
    const activeCount = this.seats.filter(activeForHand).length || this.seats.filter(p=>p&&p.stack>0&&!p.away).length;
    const advice = this.capacityAdvice(activeCount, this.config);
    this.deckError = { context, ...advice };
    this.debug('DECK_CAPACITY_FAILURE', { context, activeCount, advice, deckRemaining:this.deck.length, burnedCards:this.burnedCards.length });
    // Fail safe: refund every chip committed to the interrupted hand, pause, and return to a safe between-hands state.
    for (const p of this.seats.filter(Boolean)) {
      p.stack = moneyValue(p.stack + (p.contributed || 0)); p.contributed = 0; p.streetBet = 0; p.inHand = false; p.folded = false; p.allIn = false;
    }
    this.paused = true; this.phase = 'waiting'; this.street = 'waiting'; this.actorIndex = -1; this.actionDeadline = null; this.nextHandAt = null;
    this.addLog(`Game paused and interrupted-hand chips refunded: deck ran out while dealing ${context}. ${advice.message}`);
    return null;
  }

  startHand(playerId) {
    if (playerId !== this.hostPlayerId) throw new Error('Only the host can start a hand.');
    if (this.gameEnded) throw new Error('This game has ended.');
    if (this.paused) throw new Error('The game is paused.');
    if (!isBetweenHands(this.phase)) throw new Error('A hand is already running.');
    const eligible = this.seats.filter(p => p && p.stack > 0 && !p.away && !p.pendingLeave);
    if (eligible.length < 2) throw new Error('At least two players with chips are required.');
    const advice = this.capacityAdvice(eligible.length, this.config);
    if (!advice.baseSetupFits) throw new Error(advice.message);
    this.deckError = null;
    this.debug('START_HAND_REQUEST', { requestedBy: playerId, eligible: eligible.map(p=>({id:p.id,name:p.name,stack:moneyValue(p.stack)})), capacity: advice, config:{...this.config} });

    this.handNumber++;
    this.lastResult = null;
    this.bombPot = this.forceBombPotNext || (this.config.bombPotEnabled && this.handNumber % this.config.bombPotEvery === 0);
    this.forceBombPotNext = false;
    this.deck = shuffle(deck());
    this.burnedCards = [];
    this.baseBoardCount = this.config.boards;
    this.runCount = 1;
    this.boards = Array.from({ length: this.baseBoardCount }, () => []);
    this.boardMeta = Array.from({ length: this.baseBoardCount }, (_, i) => ({ baseBoard: i + 1, run: 1 }));
    this.currentBet = 0;
    this.minRaise = this.config.bigBlind;
    this.runoutVote = null;
    this.declarations = new Map();
    this.actionDeadline = null;
    this.nextHandAt = null;
    this.allInReveal = null;
    this.runoutDeclarationBoardIndex = null;

    for (const p of this.seats.filter(Boolean)) {
      p.inHand = p.stack > 0 && !p.away && !p.pendingLeave; p.folded = false; p.allIn = false; p.hole = [];
      p.streetBet = 0; p.contributed = 0; p.revealedCards = [];
    }

    this.dealerIndex = nextSeatIndex(this.seats, this.dealerIndex, p => p && p.inHand);
    const dealCount = this.seats.filter(p => p?.inHand).length;
    for (let c = 0; c < this.config.holeCards; c++) {
      let idx = this.dealerIndex;
      for (let n = 0; n < dealCount; n++) {
        idx = nextSeatIndex(this.seats, idx, p => p && p.inHand); if (idx < 0) break;
        this.seats[idx].hole.push(this.drawCard('hole card'));
      }
    }
    for (const p of this.seats.filter(p => p?.inHand)) if (this.config.ante > 0) this.commit(p, this.config.ante);

    this.phase = 'preflop'; this.street = 'preflop';
    if (this.bombPot) {
      const denom = Math.max(1, this.nitCycleHands || Math.max(1, this.config.bombPotEvery - 1));
      for (const p of this.seats.filter(p => p?.inHand)) {
        const wins = this.nitCoins.get(p.id) || 0;
        const discount = this.config.antiNitEnabled ? clamp(wins / denom, 0, 1) : 0;
        const rawDue = this.config.bombPotAmount * (1 - discount);
        const due = moneyValue(rawDue);
        this.debug('ANTI_NIT_BOMB_DISCOUNT', { playerId:p.id, player:p.name, wins, denominator:denom, discountRate:discount, bombAmount:moneyValue(this.config.bombPotAmount), rawDue, chargedDue:due });
        this.commit(p, due);
        p.antiNitDiscount = discount;
      }
      const discountText = this.config.antiNitEnabled ? ' Anti-nit coins were cashed in for bomb-pot discounts.' : '';
      this.addLog(`Bomb pot hand #${this.handNumber}: base ${this.config.bombPotAmount} per player.${discountText}`);
      const bombPotTotal = this.potTotal();
      if (bombPotTotal <= 0) {
        // This should not occur with normal anti-nit accounting because at most
        // one player can earn a full-cycle discount. Keep a hard guard anyway
        // so corrupted/admin-edited state can never produce a winnerless $0
        // showdown.
        this.paused = true;
        this.phase = 'waiting'; this.street = 'waiting'; this.actorIndex = -1;
        this.actionDeadline = null; this.nextHandAt = null;
        for (const p of this.seats.filter(Boolean)) {
          p.inHand = false; p.folded = false; p.allIn = false; p.hole = [];
          p.streetBet = 0; p.contributed = 0;
        }
        this.debug('ZERO_POT_BOMB_CANCELLED', {
          handNumber: this.handNumber,
          reason: 'all bomb-pot contributions were discounted to zero',
          paused: true
        });
        this.addLog('Bomb pot cancelled because all contributions were $0. The game was paused for the host to review the rules.');
        return;
      }
      this.nitCoins = new Map([...this.nitCoins.keys()].map(id => [id, 0]));
      this.nitCycleHands = 0;
    }
    if (this.bombPot && this.config.bombPotSkipPreflop) {
      for (const p of this.seats.filter(Boolean)) p.streetBet = 0;
      this.currentBet = 0;
      this.dealNextStreet();
      return;
    }

    const inCount = this.seats.filter(p => p?.inHand).length;
    const sbIndex = inCount === 2 ? this.dealerIndex : nextSeatIndex(this.seats, this.dealerIndex, p => p && p.inHand);
    const bbIndex = nextSeatIndex(this.seats, sbIndex, p => p && p.inHand);
    this.commit(this.seats[sbIndex], this.config.smallBlind);
    this.commit(this.seats[bbIndex], this.config.bigBlind);
    this.currentBet = Math.max(this.seats[sbIndex].streetBet, this.seats[bbIndex].streetBet);
    this.minRaise = this.config.bigBlind;
    this.beginBettingRound(bbIndex);
    this.addLog(`Hand #${this.handNumber} started.`);
    this.debug('HAND_STARTED', { handNumber:this.handNumber, dealerIndex:this.dealerIndex, bombPot:this.bombPot, participants:this.seats.filter(p=>p?.inHand).map(p=>({id:p.id,name:p.name,stack:p.stack,holeCount:p.hole.length})), pot:this.potTotal() });
  }

  beginBettingRound(actionStartsAfterIndex) {
    this.needsAction = new Set(this.seats.filter(canAct).map(p => p.id));
    this.actorIndex = nextSeatIndex(this.seats, actionStartsAfterIndex, canAct);
    if (this.actorIndex < 0 || this.needsAction.size === 0) this.finishBettingRound();
    else this.armActionTimer();
  }

  armActionTimer(now = Date.now()) {
    this.actionDeadline = this.actorIndex >= 0 ? now + this.config.actionTimerSeconds * 1000 : null;
  }

  timeoutCurrentAction(now = Date.now()) {
    if (!this.actionDeadline || now < this.actionDeadline || this.actorIndex < 0) return false;
    const p = this.seats[this.actorIndex];
    if (!canAct(p)) { this.actionDeadline = null; return false; }
    const valid = this.validActions(p.id);
    if (!valid) { this.actionDeadline = null; return false; }
    this.actionDeadline = null;
    this.debug('ACTION_TIMER_EXPIRED', { playerId:p.id, player:p.name, canCheck:valid.canCheck, toCall:valid.toCall, deadline:this.actionDeadline, now });
    if (valid.canCheck) {
      this.needsAction.delete(p.id);
      this.addLog(`${p.name} checks (timer).`);
    } else {
      p.folded = true;
      this.needsAction.delete(p.id);
      this.addLog(`${p.name} folds (timer).`);
    }
    this.afterAction(this.actorIndex);
    return true;
  }

  validActions(playerId) {
    if (['runout-vote','declare','declare-runout','allin-reveal','showdown','complete','waiting'].includes(this.phase)) return null;
    const idx = this.seats.findIndex(p => p?.id === playerId), p = this.seats[idx];
    if (idx !== this.actorIndex || !canAct(p)) return null;
    const toCall = round2(Math.max(0, this.currentBet - p.streetBet));
    const pot = this.potTotal();
    const maxTarget = this.config.betting === 'no-limit'
      ? round2(p.streetBet + p.stack)
      : round2(Math.min(p.streetBet + p.stack, this.currentBet + pot + toCall));
    const minTarget = this.currentBet === 0
      ? Math.min(maxTarget, this.config.bigBlind)
      : Math.min(maxTarget, round2(this.currentBet + this.minRaise));
    const allInTarget = round2(p.streetBet + p.stack);
    const canAllIn = allInTarget <= maxTarget;
    return { toCall, canCheck: toCall === 0, canCall: toCall > 0, canFold: true, canBetOrRaise: maxTarget > this.currentBet && p.stack > toCall, minTarget, maxTarget, canAllIn, allInTarget };
  }

  act(playerId, action, amount) {
    this.debug('PLAYER_ACTION_REQUEST', { playerId, action, amount: amount == null ? null : moneyValue(amount), pot:this.potTotal(), currentBet:this.currentBet, actorIndex:this.actorIndex });
    const idx = this.seats.findIndex(p => p?.id === playerId), p = this.seats[idx]; if (idx < 0) throw new Error('Not seated.');
    const valid = this.validActions(playerId); if (!valid) throw new Error('It is not your turn.');
    const oldCurrent = this.currentBet;
    if (action === 'fold') { p.folded = true; this.needsAction.delete(p.id); this.addLog(`${p.name} folds.`); }
    else if (action === 'check') { if (!valid.canCheck) throw new Error('Cannot check facing a bet.'); this.needsAction.delete(p.id); this.addLog(`${p.name} checks.`); }
    else if (action === 'call') {
      if (!valid.canCall) throw new Error('Nothing to call.');
      const paid = this.commit(p, valid.toCall); this.needsAction.delete(p.id); this.addLog(`${p.name} calls ${paid}.`);
    } else if (action === 'bet' || action === 'raise' || action === 'allin') {
      let target = action === 'allin' ? round2(p.streetBet + p.stack) : round2(Number(amount));
      if (!Number.isFinite(target)) throw new Error('Invalid bet amount.');
      if (action === 'allin' && !valid.canAllIn) throw new Error('All-in exceeds the pot-limit maximum.');
      target = Math.min(target, valid.maxTarget);
      if (target <= this.currentBet && target < p.streetBet + p.stack) throw new Error('Raise must exceed the current bet.');
      if (target < valid.minTarget && target !== round2(p.streetBet + p.stack)) throw new Error(`Minimum total bet is ${valid.minTarget}.`);
      this.commit(p, target - p.streetBet);
      const raiseBy = round2(p.streetBet - oldCurrent);
      if (p.streetBet > oldCurrent) {
        this.currentBet = p.streetBet;
        if (raiseBy >= this.minRaise) this.minRaise = raiseBy;
        this.needsAction = new Set(this.seats.filter(x => canAct(x) && x.id !== p.id).map(x => x.id));
      } else this.needsAction.delete(p.id);
      this.addLog(`${p.name} ${oldCurrent === 0 ? 'bets' : 'raises to'} ${p.streetBet}${p.allIn ? ' (all-in)' : ''}.`);
    } else throw new Error('Unknown action.');
    this.debug('PLAYER_ACTION_APPLIED', { playerId:p.id, player:p.name, action, stack:p.stack, streetBet:p.streetBet, contributed:p.contributed, currentBet:this.currentBet, pot:this.potTotal(), folded:p.folded, allIn:p.allIn });
    this.actionDeadline = null;
    this.afterAction(idx);
  }

  afterAction(lastIndex) {
    const alive = this.seats.filter(activeForHand);
    if (alive.length === 1) { this.awardUncontested(alive[0]); return; }
    for (const id of [...this.needsAction]) { const p = this.seats.find(x => x?.id === id); if (!canAct(p)) this.needsAction.delete(id); }
    const outstanding = this.seats.filter(canAct).some(p => p.streetBet !== this.currentBet);
    if (this.needsAction.size === 0 && !outstanding) { this.finishBettingRound(); return; }
    let next = nextSeatIndex(this.seats, lastIndex, p => canAct(p) && this.needsAction.has(p.id));
    if (next < 0 && outstanding) next = nextSeatIndex(this.seats, lastIndex, p => canAct(p) && p.streetBet !== this.currentBet);
    this.actorIndex = next;
    if (next < 0) this.finishBettingRound();
    else this.armActionTimer();
  }

  finishBettingRound() {
    this.debug('BETTING_ROUND_COMPLETE', { street:this.street, pot:this.potTotal(), livePlayers:this.seats.filter(activeForHand).map(p=>p.name) });
    for (const p of this.seats.filter(Boolean)) p.streetBet = 0;
    this.currentBet = 0; this.minRaise = this.config.bigBlind; this.actorIndex = -1; this.needsAction.clear(); this.actionDeadline = null;
    if (this.street === 'river') { this.beginDeclarationsOrShowdown(); return; }
    if (this.shouldOfferRunoutVote()) { this.beginRunoutVote(); return; }
    this.dealNextStreet();
  }

  shouldOfferRunoutVote() {
    const live = this.seats.filter(activeForHand);
    if (live.length < 2 || this.street === 'river') return false;
    return live.filter(canAct).length <= 1;
  }

  remainingCardsPerBoard() {
    return this.futureCardsPerBoard(this.boards[0]?.length || 0);
  }

  maxAvailableRuns() {
    const remainingUse = this.remainingCardsPerBoard();
    if (remainingUse <= 0) return 1;
    return clamp(Math.floor(this.deck.length / (this.baseBoardCount * remainingUse)), 1, 4);
  }

  beginRunoutVote() {
    const voters = this.seats.filter(activeForHand).map(p => p.id);
    const maxRuns = this.maxAvailableRuns();
    if (maxRuns <= 1) { this.runCount = 1; this.addLog('Deck capacity allows only one runout, so the vote is skipped.'); this.finishAllInRunout(); return; }
    this.phase = 'runout-vote';
    this.actorIndex = -1;
    this.runoutVote = { voterIds: voters, votes: new Map(), maxRuns };
    this.debug('RUNOUT_VOTE_OPENED', { voters:[...voters], maxRuns, deckRemaining:this.deck.length, boards:this.baseBoardCount, street:this.street });
    this.addLog(`All-in runout vote started. Choose 1–${maxRuns} run${maxRuns === 1 ? '' : 's'}.`);
  }

  voteRunout(playerId, runs) {
    if (this.phase !== 'runout-vote' || !this.runoutVote) throw new Error('There is no active runout vote.');
    if (!this.runoutVote.voterIds.includes(playerId)) throw new Error('Only players still in the hand can vote.');
    const n = Math.trunc(Number(runs));
    if (!Number.isInteger(n) || n < 1 || n > this.runoutVote.maxRuns) throw new Error(`Choose between 1 and ${this.runoutVote.maxRuns} runs.`);
    this.runoutVote.votes.set(playerId, n);
    this.debug('RUNOUT_VOTE_CAST', { playerId, runs:n, received:this.runoutVote.votes.size, required:this.runoutVote.voterIds.length });
    if (this.runoutVote.votes.size === this.runoutVote.voterIds.length) this.resolveRunoutVote();
  }

  resolveRunoutVote() {
    const votes = [...this.runoutVote.votes.values()];
    const counts = new Map();
    for (const v of votes) counts.set(v, (counts.get(v) || 0) + 1);
    let choice = null;
    for (const [run, count] of counts) if (count > votes.length / 2) choice = run;
    if (choice == null) choice = Math.min(...votes); // tie/no-majority priority: 1, then 2, then 3, then 4.
    this.runCount = choice;
    this.debug('RUNOUT_VOTE_RESOLVED', { votes, counts:Object.fromEntries(counts), choice });
    this.addLog(`Runout vote complete: running it ${choice} time${choice === 1 ? '' : 's'}.`);
    this.finishAllInRunout();
  }

  expandBoardsForRuns() {
    if (this.runCount <= 1) return;
    const originals = this.boards.map(b => [...b]);
    const boards = [];
    const meta = [];
    originals.forEach((board, baseIndex) => {
      for (let run = 1; run <= this.runCount; run++) {
        boards.push([...board]);
        meta.push({ baseBoard: baseIndex + 1, run });
      }
    });
    this.boards = boards;
    this.boardMeta = meta;
  }

  finishAllInRunout() {
    this.runoutVote = null;
    this.expandBoardsForRuns();
    this.beginAllInReveal();
  }

  beginAllInReveal(now = Date.now()) {
    this.phase = 'allin-reveal';
    this.actorIndex = -1;
    this.actionDeadline = null;
    this.runoutDeclarationBoardIndex = null;
    this.allInReveal = {
      boardIndex: 0,
      nextAt: now + 5000,
      boardResult: null,
      leaders: this.currentLeadersForBoard(0),
      completeBoards: []
    };
    this.addLog('All-in reveal sequence started.');
    this.debug('ALLIN_REVEAL_STARTED', { runCount:this.runCount, boardCount:this.boards.length, deckRemaining:this.deck.length, boardMeta:this.boardMeta });
  }

  currentLeadersForBoard(boardIndex) {
    const board = this.boards[boardIndex];
    if (!board) return null;
    const players = this.seats.filter(activeForHand);
    const evals = players.map(p => ({ p, high: bestHigh(p.hole, board, this.config.construction), low: this.config.hiLow ? bestLow(p.hole, board, this.config.construction) : null }));
    const validHigh = evals.filter(e => e.high);
    const validLow = evals.filter(e => e.low);
    const highW = validHigh.length ? this.bestHighWinners(validHigh) : [];
    const lowW = this.config.hiLow && validLow.length ? this.bestLowWinners(validLow) : [];
    return {
      players: evals.map(e => ({ playerId:e.p.id, name:e.p.name, high:e.high?this.describeHigh(e.high):'Not enough cards', low:e.low?this.describeLow(e.low):null, highLeader:highW.some(w=>w.p.id===e.p.id), lowLeader:lowW.some(w=>w.p.id===e.p.id) })),
      highLeaders: highW.map(e=>e.p.name), lowLeaders: lowW.map(e=>e.p.name)
    };
  }

  previewBoardResult(boardIndex) {
    const board = this.boards[boardIndex];
    const evals = this.seats.filter(activeForHand).map(p => ({
      p,
      high: bestHigh(p.hole, board, this.config.construction),
      low: this.config.hiLow ? bestLow(p.hole, board, this.config.construction) : null
    }));
    let highW = [], lowW = [];
    if (this.config.hiLow) {
      const d = this.declaredWinners(evals, boardIndex);
      highW = d.highW; lowW = d.lowW;
    } else highW = this.bestHighWinners(evals);
    const meta = this.boardMeta[boardIndex] || { baseBoard: boardIndex + 1, run: 1 };
    return {
      boardIndex,
      baseBoard: meta.baseBoard,
      run: meta.run,
      high: highW.length ? { names: highW.map(x => x.p.name), hand: highW[0].high.name } : null,
      low: lowW.length ? { names: lowW.map(x => x.p.name), hand: lowW[0].low ? this.describeLow(lowW[0].low) : 'Low' } : null
    };
  }

  advanceAllInReveal(now = Date.now()) {
    if (this.phase !== 'allin-reveal' || !this.allInReveal || now < this.allInReveal.nextAt) return false;
    const r = this.allInReveal;
    const board = this.boards[r.boardIndex];
    if (!board) { this.finishAllInReveal(); return true; }

    // After a board result has been displayed for three seconds, move to the next board instance.
    if (r.boardResult) {
      r.completeBoards.push(r.boardIndex);
      r.boardIndex += 1;
      r.boardResult = null;
      if (r.boardIndex >= this.boards.length) { this.finishAllInReveal(); return true; }
      r.leaders = this.currentLeadersForBoard(r.boardIndex);
      r.nextAt = now + 5000;
      return true;
    }

    const before = board.length;
    if (before < 5) {
      const count = before === 0 ? 3 : 1;
      if (!this.burnCard()) return true;
      for (let i = 0; i < count; i++) { const c=this.drawCard('all-in runout'); if(!c)return true; board.push(c); }
      const label = before === 0 ? 'Flop' : before === 3 ? 'Turn' : 'River';
      this.street = label.toLowerCase();
      const meta = this.boardMeta[r.boardIndex] || { baseBoard: r.boardIndex + 1, run: 1 };
      this.addLog(`${label} revealed on Board ${meta.baseBoard}${this.runCount > 1 ? ` Run ${meta.run}` : ''}.`);
      this.debug('COMMUNITY_REVEAL', { boardIndex:r.boardIndex, baseBoard:meta.baseBoard, run:meta.run, street:label.toLowerCase(), board:[...board], leaders:this.currentLeadersForBoard(r.boardIndex), deckRemaining:this.deck.length });
      r.leaders = this.currentLeadersForBoard(r.boardIndex);
      if (board.length < 5) {
        r.nextAt = now + 5000;
        return true;
      }
    }

    // Board is complete. Declaration games pause here so choices remain hidden and board-specific.
    if (this.config.hiLow && this.seats.filter(activeForHand).length > 1) {
      this.phase = 'declare-runout';
      this.runoutDeclarationBoardIndex = r.boardIndex;
      this.addLog(`Board ${this.boardMeta[r.boardIndex]?.baseBoard || r.boardIndex + 1}${this.runCount > 1 ? ` Run ${this.boardMeta[r.boardIndex]?.run || 1}` : ''}: declare High, Low, or Both.`);
      return true;
    }

    r.boardResult = this.previewBoardResult(r.boardIndex);
    r.nextAt = now + 5000;
    return true;
  }

  finishAllInReveal() {
    this.street = 'river';
    this.allInReveal = null;
    this.runoutDeclarationBoardIndex = null;
    this.showdown();
  }

  dealNextStreet() {
    const next = { preflop: 'flop', flop: 'turn', turn: 'river' }[this.street] || 'flop';
    this.phase = next; this.street = next;
    const count = next === 'flop' ? 3 : 1;
    for (const board of this.boards) { if(!this.burnCard()) return; for (let i = 0; i < count; i++) { const c=this.drawCard(`${next} card`); if(!c)return; board.push(c); } }
    this.addLog(`${next[0].toUpperCase() + next.slice(1)} dealt${this.boards.length > 1 ? ' on all boards' : ''}.`);
    this.debug('STREET_DEALT', { street:next, boards:this.boards.map((b,i)=>({boardIndex:i,meta:this.boardMeta[i],cards:[...b]})), pot:this.potTotal(), deckRemaining:this.deck.length });
    const actors = this.seats.filter(canAct);
    if (actors.length <= 1) {
      if (next === 'river') this.beginDeclarationsOrShowdown();
      else if (this.shouldOfferRunoutVote()) this.beginRunoutVote();
      else this.dealNextStreet();
      return;
    }
    this.beginBettingRound(this.dealerIndex);
  }

  beginDeclarationsOrShowdown() {
    if (this.config.hiLow && this.seats.filter(activeForHand).length > 1) {
      this.phase = 'declare';
      this.actorIndex = -1;
      this.declarations = new Map();
      this.addLog(`Declaration opened: choose High, Low, or Both for each board${this.boards.length > 1 ? ' instance' : ''}.`);
    } else this.showdown();
  }

  declare(playerId, choices) {
    this.debug('DECLARATION_REQUEST', { playerId, choices });
    if (!['declare','declare-runout'].includes(this.phase)) throw new Error('Declarations are not open.');
    if (!this.seats.some(p => p?.id === playerId && activeForHand(p))) throw new Error('Only players still in the hand can declare.');

    if (this.phase === 'declare-runout') {
      const boardIndex = this.runoutDeclarationBoardIndex;
      const raw = Array.isArray(choices) ? choices[0] : choices;
      const choice = String(raw || '').toLowerCase();
      if (!['high','low','both'].includes(choice)) throw new Error('Choose High, Low, or Both.');
      const existing = this.declarations.get(playerId) || Array(this.boards.length).fill(null);
      existing[boardIndex] = choice;
      this.declarations.set(playerId, existing);
      this.debug('DECLARATION_SUBMITTED', { playerId, boardIndex, choice, submittedForBoard:this.seats.filter(activeForHand).filter(p=>this.declarations.get(p.id)?.[boardIndex]).length });
      const liveIds = this.seats.filter(activeForHand).map(p => p.id);
      if (liveIds.every(id => this.declarations.get(id)?.[boardIndex])) {
        this.phase = 'allin-reveal';
        this.allInReveal.boardResult = this.previewBoardResult(boardIndex);
        this.allInReveal.nextAt = Date.now() + 5000;
        this.runoutDeclarationBoardIndex = null;
        this.addLog('Declarations locked and revealed for the completed board.');
      }
      return;
    }

    if (!Array.isArray(choices) || choices.length !== this.boards.length) throw new Error(`Choose High, Low, or Both for all ${this.boards.length} board instances.`);
    const normalized = choices.map(x => String(x).toLowerCase());
    if (normalized.some(x => !['high','low','both'].includes(x))) throw new Error('Declaration choices must be High, Low, or Both.');
    this.declarations.set(playerId, normalized);
    this.debug('DECLARATION_SUBMITTED', { playerId, choices:normalized, submitted:this.declarations.size });
    const liveIds = this.seats.filter(activeForHand).map(p => p.id);
    if (liveIds.every(id => this.declarations.has(id))) this.showdown();
  }

  potTotal() { return round2(this.seats.filter(Boolean).reduce((s, p) => s + p.contributed, 0)); }

  hasSevenTwoOffsuit(p) {
    if (!this.config.sevenTwoEnabled || this.config.construction !== 'holdem' || this.config.holeCards !== 2 || !p?.hole || p.hole.length !== 2) return false;
    const ranks = p.hole.map(c=>c.rank).sort().join('');
    return ranks === '27' && p.hole[0].suit !== p.hole[1].suit;
  }

  applySevenTwoBonus(winners) {
    if (!this.config.sevenTwoEnabled || this.config.sevenTwoPayment <= 0) return;
    const unique = [...new Map(winners.map(p=>[p.id,p])).values()].filter(p=>this.hasSevenTwoOffsuit(p));
    for (const winner of unique) {
      let total = 0;
      for (const payer of this.seats.filter(p=>p && p.id!==winner.id && !p.away)) {
        const paid = moneyValue(Math.min(payer.stack, this.config.sevenTwoPayment));
        payer.stack = moneyValue(payer.stack - paid); total = moneyValue(total + paid);
        this.debug('SEVEN_TWO_PAYMENT', { winnerId:winner.id, winner:winner.name, payerId:payer.id, payer:payer.name, paid, payerStack:payer.stack });
      }
      winner.stack = moneyValue(winner.stack + total);
      this.addLog(`${winner.name} wins the 7-2 offsuit bonus: ${total}.`);
    }
  }

  recordNitWinners(winners) {
    if (!this.config.antiNitEnabled || this.bombPot) return;
    // Every completed non-bomb hand counts toward the cycle denominator, but a
    // nit coin is awarded only when exactly one player owns every awarded share
    // of the hand. If different players win different boards/sides, or any
    // board is tied between players, the hand is considered chopped and nobody
    // receives a coin.
    this.nitCycleHands += 1;
    const uniquePlayers = [...new Map((winners || []).map(p => [p.id, p])).values()];
    if (uniquePlayers.length !== 1) {
      this.debug('ANTI_NIT_NO_COIN_CHOP', {
        denominator: this.nitCycleHands,
        winnerIds: uniquePlayers.map(p => p.id),
        winners: uniquePlayers.map(p => p.name),
        reason: uniquePlayers.length === 0 ? 'no-awarded-winner' : 'hand-chopped-between-players'
      });
      return;
    }
    const winner = uniquePlayers[0];
    this.nitCoins.set(winner.id, (this.nitCoins.get(winner.id) || 0) + 1);
    this.debug('ANTI_NIT_COIN_AWARDED', {
      playerId: winner.id,
      player: winner.name,
      coins: this.nitCoins.get(winner.id),
      denominator: this.nitCycleHands
    });
  }

  awardUncontested(winner) {
    const pot = this.potTotal(); winner.stack = moneyValue(winner.stack + pot);
    this.debug('UNCONTESTED_AWARD', { winnerId:winner.id, winner:winner.name, amount:pot, resultingStack:winner.stack });
    this.lastResult = { pot, summary: `${winner.name} wins ${pot} uncontested.`, boards: [] };
    this.addLog(this.lastResult.summary); this.applySevenTwoBonus([winner]); this.recordNitWinners([winner]); this.completeHand();
  }

  buildSidePots() {
    const contributors = this.seats.filter(p => p && p.contributed > 0);
    const levels = [...new Set(contributors.map(p => p.contributed))].sort((a, b) => a - b);
    let prev = 0; const pots = [];
    for (const level of levels) {
      const involved = contributors.filter(p => p.contributed >= level);
      const amount = round2((level - prev) * involved.length);
      const eligible = involved.filter(p => !p.folded && p.inHand);
      if (amount > 0) pots.push({ amount:moneyValue(amount), eligible });
      prev = level;
    }
    this.debug('SIDE_POTS_BUILT', { pots:pots.map((p,i)=>({index:i+1,amount:p.amount,eligible:p.eligible.map(x=>({id:x.id,name:x.name}))})) });
    return pots;
  }

  splitAmount(amount, winners) {
    amount = moneyValue(amount);
    if (!winners.length || amount <= 0) return;
    const share = moneyValue(amount / winners.length); let used = 0;
    winners.forEach((p, i) => {
      const v = i === winners.length - 1 ? moneyValue(amount - used) : share;
      p.stack = moneyValue(p.stack + v); used = moneyValue(used + v);
    });
    this.debug('PAYOUT_SPLIT', { amount, winners:winners.map(p=>({id:p.id,name:p.name,stack:p.stack})) });
  }

  bestHighWinners(evals) {
    if (!evals.length) return [];
    const best = evals.reduce((b, e) => !b || compareHigh(e.high, b.high) > 0 ? e : b, null);
    return evals.filter(e => compareHigh(e.high, best.high) === 0);
  }

  bestLowWinners(evals) {
    const lows = evals.filter(e => e.low);
    if (!lows.length) return [];
    const best = lows.reduce((b, e) => !b || compareLow(e.low, b.low) < 0 ? e : b, null);
    return lows.filter(e => compareLow(e.low, best.low) === 0);
  }

  declaredWinners(evals, boardIndex) {
    const withChoice = evals.map(e => ({ ...e, choice: this.declarations.get(e.p.id)?.[boardIndex] || 'high' }));
    const highContest = withChoice.filter(e => e.choice === 'high' || e.choice === 'both');
    const lowContest = withChoice.filter(e => (e.choice === 'low' || e.choice === 'both') && e.low);
    const preliminaryHigh = this.bestHighWinners(highContest);
    const preliminaryLow = this.bestLowWinners(lowContest);
    const highWinnerIds = new Set(preliminaryHigh.map(e => e.p.id));
    const lowWinnerIds = new Set(preliminaryLow.map(e => e.p.id));
    const successfulBoth = new Set(withChoice.filter(e => e.choice === 'both' && e.low && highWinnerIds.has(e.p.id) && lowWinnerIds.has(e.p.id)).map(e => e.p.id));

    // A BOTH declaration is all-or-nothing. If it does not win/tie BOTH halves, it is removed from both contests.
    const highEligible = withChoice.filter(e => e.choice === 'high' || (e.choice === 'both' && successfulBoth.has(e.p.id)));
    const lowEligible = withChoice.filter(e => (e.choice === 'low' && e.low) || (e.choice === 'both' && successfulBoth.has(e.p.id) && e.low));
    let highW = this.bestHighWinners(highEligible);
    let lowW = this.bestLowWinners(lowEligible);

    // Avoid stranding chips in pathological declarations. If no declared side can claim the board,
    // fall back to the best high hand among players eligible for that side pot.
    if (!highW.length && !lowW.length) highW = this.bestHighWinners(evals);
    return { highW, lowW, successfulBoth, choices: withChoice.map(e => ({ playerId: e.p.id, name: e.p.name, choice: e.choice })) };
  }

  cardKey(c) { return c ? `${c.rank}${c.suit}` : ''; }

  rankWord(n, plural = false) {
    const names = {14:'Ace',13:'King',12:'Queen',11:'Jack',10:'Ten',9:'Nine',8:'Eight',7:'Seven',6:'Six',5:'Five',4:'Four',3:'Three',2:'Two'};
    const x = names[n] || String(n); if (!plural) return x; return x === 'Six' ? 'Sixes' : x === 'Five' ? 'Fives' : x === 'Four' ? 'Fours' : x === 'Three' ? 'Threes' : x === 'Two' ? 'Twos' : `${x}s`;
  }

  describeHigh(ev) {
    if (!ev) return 'No made hand'; const s = ev.score || [];
    switch (ev.name) {
      case 'Royal Flush': return 'Royal Flush';
      case 'Straight Flush': return `${this.rankWord(s[1])}-high Straight Flush`;
      case 'Four of a Kind': return `Four of a Kind, ${this.rankWord(s[1], true)}`;
      case 'Full House': return `Full House, ${this.rankWord(s[1], true)} full of ${this.rankWord(s[2], true)}`;
      case 'Flush': return `${this.rankWord(s[1])}-high Flush`;
      case 'Straight': return `${this.rankWord(s[1])}-high Straight`;
      case 'Three of a Kind': return `Three of a Kind, ${this.rankWord(s[1], true)}`;
      case 'Two Pair': return `Two Pair, ${this.rankWord(s[1], true)} and ${this.rankWord(s[2], true)}`;
      case 'Pair': return `Pair of ${this.rankWord(s[1], true)}`;
      default: return `${this.rankWord(s[1])}-high`;
    }
  }

  describeLow(ev) {
    if (!ev) return 'No low available';
    const s = ev.score || [];
    if (ev.name === 'High Card') {
      const vals = s.slice(1); const hi = vals[0];
      const rank = n => n===1?'A':n===10?'T':n===11?'J':n===12?'Q':n===13?'K':String(n);
      return `${rank(hi)}-high low (${vals.slice().reverse().map(rank).join('-')})`;
    }
    return `${this.describeHigh({name:ev.name,score:ev.score.map((v,i)=>i? (v===1?14:v):v)})} (low)`;
  }

  declarationOptions(playerId, boardIndices) {
    const p = this.seats.find(x => x?.id === playerId); if (!p) return [];
    return boardIndices.map(boardIndex => {
      const board = this.boards[boardIndex] || [];
      const high = bestHigh(p.hole, board, this.config.construction);
      const low = bestLow(p.hole, board, this.config.construction);
      const highText = this.describeHigh(high), lowText = this.describeLow(low);
      return { boardIndex, high: highText, low: lowText, both: `${highText} / ${lowText}` };
    });
  }

  buildShowdownDetails() {
    return this.boards.map((board, boardIndex) => {
      const meta = this.boardMeta[boardIndex] || { baseBoard: boardIndex + 1, run: 1 };
      return {
        boardIndex,
        baseBoard: meta.baseBoard,
        run: meta.run,
        board: [...board],
        players: this.seats.filter(activeForHand).map(p => {
          const high = bestHigh(p.hole, board, this.config.construction);
          const low = this.config.hiLow ? bestLow(p.hole, board, this.config.construction) : null;
          const holeKeys = new Set(p.hole.map(c => this.cardKey(c)));
          return {
            playerId: p.id,
            name: p.name,
            hole: [...p.hole],
            choice: this.declarations.get(p.id)?.[boardIndex] || (this.config.hiLow ? null : 'high'),
            highName: high?.name || null,
            lowName: low ? this.describeLow(low) : null,
            highUsedHole: (high?.cards || []).filter(c => holeKeys.has(this.cardKey(c))).map(c => this.cardKey(c)),
            lowUsedHole: (low?.cards || []).filter(c => holeKeys.has(this.cardKey(c))).map(c => this.cardKey(c))
          };
        })
      };
    });
  }

  showdown() {
    this.phase = 'showdown';
    const results = [];
    const handWinners = [];
    const sidePots = this.buildSidePots();
    for (const p of this.seats.filter(activeForHand)) p.revealedCards = [...p.hole];

    sidePots.forEach((pot, potIndex) => {
      let remaining = pot.amount;
      this.boards.forEach((board, boardIndex) => {
        const boardAmount = boardIndex === this.boards.length - 1 ? remaining : round2(pot.amount / this.boards.length);
        remaining = round2(remaining - boardAmount);
        const evals = pot.eligible.map(p => ({
          p,
          high: bestHigh(p.hole, board, this.config.construction),
          low: this.config.hiLow ? bestLow(p.hole, board, this.config.construction) : null
        }));

        let highW, lowW, declarations = null;
        if (this.config.hiLow) {
          const d = this.declaredWinners(evals, boardIndex);
          highW = d.highW; lowW = d.lowW; declarations = d.choices;
        } else {
          highW = this.bestHighWinners(evals); lowW = [];
        }

        let highAmount = 0, lowAmount = 0;
        if (highW.length && lowW.length) {
          lowAmount = round2(boardAmount / 2); highAmount = round2(boardAmount - lowAmount);
        } else if (highW.length) highAmount = boardAmount;
        else if (lowW.length) lowAmount = boardAmount;

        this.splitAmount(highAmount, highW.map(e => e.p));
        this.splitAmount(lowAmount, lowW.map(e => e.p));
        handWinners.push(...highW.map(e=>e.p), ...lowW.map(e=>e.p));
        const meta = this.boardMeta[boardIndex] || { baseBoard: boardIndex + 1, run: 1 };
        results.push({
          pot: potIndex + 1, board: boardIndex + 1, baseBoard: meta.baseBoard, run: meta.run, amount: boardAmount,
          high: highW.length ? { names: highW.map(e => e.p.name), playerIds: highW.map(e => e.p.id), hand: highW[0].high.name, amount: highAmount } : null,
          low: lowW.length ? { names: lowW.map(e => e.p.name), playerIds: lowW.map(e => e.p.id), hand: lowW[0].low ? this.describeLow(lowW[0].low) : 'Low', amount: lowAmount } : null,
          declarations
        });
      });
    });

    const pot = this.potTotal();
    this.lastResult = { pot, summary: `Showdown complete. ${pot} awarded.`, boards: results, runCount: this.runCount, showdown: this.buildShowdownDetails() };
    this.debug('SHOWDOWN_SETTLED', { pot, sidePots:sidePots.map(p=>({amount:p.amount,eligible:p.eligible.map(x=>x.name)})), results, stacks:this.seats.filter(Boolean).map(p=>({id:p.id,name:p.name,stack:moneyValue(p.stack)})) });
    this.addLog(this.lastResult.summary);
    this.applySevenTwoBonus(handWinners);
    this.recordNitWinners(handWinners);
    this.completeHand();
  }

  completeHand() {
    this.debug('HAND_COMPLETING', { handNumber:this.handNumber, pot:this.potTotal(), lastResult:this.lastResult, stacks:this.seats.filter(Boolean).map(p=>({id:p.id,name:p.name,stack:moneyValue(p.stack)})) });
    this.phase = 'complete'; this.street = 'complete'; this.actorIndex = -1; this.needsAction.clear(); this.runoutVote = null; this.actionDeadline = null; this.allInReveal = null;
    this.nextHandAt = this.paused ? null : Date.now() + this.config.nextHandTimerSeconds * 1000;
    for (const p of this.seats.filter(Boolean)) { p.inHand = false; p.streetBet = 0; p.contributed = 0; p.allIn = false; }
    for (const p of [...this.seats].filter(x => x?.pendingLeave)) this.removeSeatAndCashOut(p.id, 'cash-out after hand');
    this.debug('HAND_COMPLETE', { handNumber:this.handNumber, nextHandAt:this.nextHandAt, paused:this.paused, stacks:this.seats.filter(Boolean).map(p=>({id:p.id,name:p.name,stack:p.stack})) });
  }

  tryAutoStart(now = Date.now()) {
    if (this.phase !== 'complete' || this.paused || this.gameEnded || !this.nextHandAt || now < this.nextHandAt) return false;
    this.nextHandAt = null;
    const eligible = this.seats.filter(p => p && p.stack > 0 && !p.away && !p.pendingLeave);
    if (eligible.length < 2 || !this.hostPlayerId) return true;
    this.debug('AUTO_START_TRIGGERED', { now, hostPlayerId:this.hostPlayerId, eligible:eligible.map(p=>({id:p.id,name:p.name,stack:p.stack})) });
    try { this.startHand(this.hostPlayerId); } catch (e) { this.debug('AUTO_START_ERROR',{message:e.message,stack:e.stack||null}); this.addLog(`Automatic next hand paused: ${e.message}`); }
    return true;
  }

  currentHandStrengths(viewerId) {
    const p = this.seats.find(x => x?.id === viewerId);
    if (!p?.hole?.length) return [];
    if (!this.boards.length || this.boards.every(b => b.length < 3)) {
      const counts = new Map();
      for (const c of p.hole) counts.set(c.rank, (counts.get(c.rank) || 0) + 1);
      return [{ label: 'Preflop', name: [...counts.values()].some(n => n >= 2) ? 'Pair' : 'High Card' }];
    }
    return this.boards.map((board, i) => {
      const ev = bestHigh(p.hole, board, this.config.construction);
      const meta = this.boardMeta[i] || { baseBoard: i + 1, run: 1 };
      return { boardIndex: i, baseBoard: meta.baseBoard, run: meta.run, name: ev?.name || 'High Card' };
    });
  }

  publicState(viewerId = null) {
    const viewer = this.seats.find(p => p?.id === viewerId);
    const valid = viewer ? this.validActions(viewerId) : null;
    const liveIds = this.seats.filter(activeForHand).map(p => p.id);
    const declarationComplete = ['showdown','complete'].includes(this.phase);
    const viewerDecl = this.declarations.get(viewerId) || null;
    const runout = this.runoutVote ? {
      maxRuns: this.runoutVote.maxRuns,
      votesReceived: this.runoutVote.votes.size,
      voterCount: this.runoutVote.voterIds.length,
      viewerEligible: this.runoutVote.voterIds.includes(viewerId),
      viewerVote: this.runoutVote.votes.get(viewerId) || null
    } : null;
    const reveal = this.allInReveal ? {
      boardIndex: this.allInReveal.boardIndex,
      nextAt: this.allInReveal.nextAt,
      leaders: this.allInReveal.leaders,
      boardResult: this.allInReveal.boardResult,
      meta: this.boardMeta[this.allInReveal.boardIndex] || null
    } : null;
    const declarationBoardIndex = this.phase === 'declare-runout' ? this.runoutDeclarationBoardIndex : null;
    return {
      config: this.config,
      hostPlayerId: this.hostPlayerId,
      handNumber: this.handNumber,
      dealerIndex: this.dealerIndex,
      phase: this.phase,
      street: this.street,
      boards: this.boards,
      boardMeta: this.boardMeta,
      baseBoardCount: this.baseBoardCount,
      runCount: this.runCount,
      currentBet: this.currentBet,
      pot: this.potTotal(),
      actorIndex: this.actorIndex,
      bombPot: this.bombPot,
      forceBombPotNext: this.forceBombPotNext,
      lastResult: this.lastResult,
      log: this.log,
      runoutVote: runout,
      allInReveal: reveal,
      actionTimer: this.actorIndex >= 0 && this.actionDeadline ? { deadline: this.actionDeadline, seconds: this.config.actionTimerSeconds, actorIndex: this.actorIndex } : null,
      nextHandAt: this.nextHandAt,
      paused: this.paused,
      gameEnded: this.gameEnded,
      ledger: this.ledgerSnapshot(),
      ledgerEvents: this.ledgerEvents.slice(-100),
      nitCoins: Object.fromEntries([...this.nitCoins.entries()]),
      nitCycleHands: this.nitCycleHands,
      deckCapacity: this.capacityAdvice(this.seats.filter(p=>p&&p.stack>0&&!p.away&&!p.pendingLeave).length, this.config),
      deckError: this.deckError,
      debugEventCount: viewerId === this.hostPlayerId ? this.debugLog.length : null,
      currentHandStrengths: this.currentHandStrengths(viewerId),
      declaration: this.phase === 'declare' ? {
        required: true,
        submitted: this.declarations.size,
        playerCount: liveIds.length,
        viewerSubmitted: this.declarations.has(viewerId),
        viewerChoices: viewerDecl,
        boardCount: this.boards.length,
        boardIndex: null,
        viewerOptions: this.declarationOptions(viewerId, this.boards.map((_, i) => i))
      } : this.phase === 'declare-runout' ? {
        required: true,
        submitted: liveIds.filter(id => this.declarations.get(id)?.[declarationBoardIndex]).length,
        playerCount: liveIds.length,
        viewerSubmitted: Boolean(this.declarations.get(viewerId)?.[declarationBoardIndex]),
        viewerChoices: this.declarations.get(viewerId)?.[declarationBoardIndex] ? [this.declarations.get(viewerId)[declarationBoardIndex]] : null,
        boardCount: 1,
        boardIndex: declarationBoardIndex,
        viewerOptions: this.declarationOptions(viewerId, [declarationBoardIndex])
      } : null,
      declarationsRevealed: declarationComplete && this.config.hiLow
        ? Object.fromEntries([...this.declarations.entries()]) : null,
      buyInRequests: viewerId === this.hostPlayerId
        ? this.buyInRequests.filter(r => r.status === 'pending').map(r => ({ ...r }))
        : this.buyInRequests.filter(r => r.playerId === viewerId && r.status === 'pending').map(r => ({ ...r })),
      seats: this.seats.map((p, i) => p ? {
        id: p.id, name: p.name, stack: p.stack, connected: p.connected, inHand: p.inHand, folded: p.folded,
        allIn: p.allIn, streetBet: p.streetBet, contributed: p.contributed, away: Boolean(p.away), pendingLeave: Boolean(p.pendingLeave), isTestBot: Boolean(p.isTestBot),
        hole: (p.id === viewerId || this.phase === 'showdown' || this.phase === 'complete')
          ? p.hole.map(c => p.id === viewerId || p.revealedCards.length ? c : null)
          : p.hole.map(() => null),
        holeCount: p.hole.length, isDealer: i === this.dealerIndex, nitCoins: this.nitCoins.get(p.id) || 0, antiNitDiscount: p.antiNitDiscount || 0
      } : null),
      viewer: {
        playerId: viewerId,
        seatIndex: this.seats.findIndex(p => p?.id === viewerId),
        isHost: viewerId === this.hostPlayerId,
        validActions: valid
      }
    };
  }
}
