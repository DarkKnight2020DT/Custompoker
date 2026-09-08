import { bestHigh, bestLow, compareHigh, compareLow, combinations } from './evaluator.js';

function sampleWithoutReplacement(deck, count) {
  const a = [...deck];
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(Math.random() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, count);
}

function highWinners(players, board, construction) {
  const evals = players.map(p => ({ p, ev: bestHigh(p.hole, board, construction) })).filter(x => x.ev);
  if (!evals.length) return [];
  let best = evals[0];
  for (const x of evals.slice(1)) if (compareHigh(x.ev, best.ev) > 0) best = x;
  return evals.filter(x => compareHigh(x.ev, best.ev) === 0).map(x => x.p.id);
}

function lowWinners(players, board, construction, qualifier) {
  const evals = players.map(p => ({ p, ev: bestLow(p.hole, board, construction, qualifier) })).filter(x => x.ev);
  if (!evals.length) return [];
  let best = evals[0];
  for (const x of evals.slice(1)) if (compareLow(x.ev, best.ev) < 0) best = x;
  return evals.filter(x => compareLow(x.ev, best.ev) === 0).map(x => x.p.id);
}

export function calculateBoardEquity({ players, board, remainingDeck, construction = 'omaha', hiLow = false, lowQualifier = 8, maxSamples = 1200 }) {
  const missing = Math.max(0, 5 - board.length);
  const scores = new Map(players.map(p => [p.id, { playerId: p.id, name: p.name, high: 0, low: 0 }]));
  let runouts = [];
  let exact = false;
  if (missing === 0) { runouts = [[]]; exact = true; }
  else {
    const exactAllowed = missing === 1 || (missing === 2 && construction === 'holdem' && players.length <= 4);
    const exactCount = exactAllowed ? combinations(remainingDeck, missing).length : Infinity;
    if (exactCount <= 1800) { runouts = combinations(remainingDeck, missing); exact = true; }
    else {
      const count = Math.max(300, Math.min(maxSamples, 1800));
      runouts = Array.from({ length: count }, () => sampleWithoutReplacement(remainingDeck, missing));
    }
  }
  for (const fill of runouts) {
    const full = [...board, ...fill];
    const highs = highWinners(players, full, construction);
    if (highs.length) for (const id of highs) scores.get(id).high += 1 / highs.length;
    if (hiLow) {
      const lows = lowWinners(players, full, construction, lowQualifier);
      if (lows.length) for (const id of lows) scores.get(id).low += 1 / lows.length;
    }
  }
  const total = Math.max(1, runouts.length);
  return [...scores.values()].map(x => ({
    playerId: x.playerId,
    name: x.name,
    highPct: Math.round((x.high / total) * 1000) / 10,
    lowPct: hiLow ? Math.round((x.low / total) * 1000) / 10 : null,
    equityPct: hiLow ? null : Math.round((x.high / total) * 1000) / 10,
    samples: total,
    exact
  }));
}
