const RANK_VALUE = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const LOW_RANK_VALUE = { A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13 };

export function combinations(arr, choose) {
  const out = [];
  const rec = (start, picked) => {
    if (picked.length === choose) { out.push([...picked]); return; }
    for (let i = start; i <= arr.length - (choose - picked.length); i++) {
      picked.push(arr[i]); rec(i + 1, picked); picked.pop();
    }
  };
  rec(0, []);
  return out;
}

function lexCompare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0, bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

export function evaluateFive(cards) {
  if (cards.length !== 5) throw new Error('evaluateFive requires exactly five cards');
  const ranks = cards.map(c => RANK_VALUE[c.rank]).sort((a,b) => b-a);
  const suits = cards.map(c => c.suit);
  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  const groups = [...counts.entries()].sort((a,b) => b[1]-a[1] || b[0]-a[0]);
  const unique = [...new Set(ranks)];
  let straightHigh = 0;
  if (unique.length === 5) {
    if (unique[0] - unique[4] === 4) straightHigh = unique[0];
    else if (JSON.stringify(unique) === JSON.stringify([14,5,4,3,2])) straightHigh = 5;
  }
  const flush = suits.every(s => s === suits[0]);

  if (straightHigh && flush) return { score: [8, straightHigh], name: straightHigh === 14 ? 'Royal Flush' : 'Straight Flush' };
  if (groups[0][1] === 4) return { score: [7, groups[0][0], groups[1][0]], name: 'Four of a Kind' };
  if (groups[0][1] === 3 && groups[1][1] === 2) return { score: [6, groups[0][0], groups[1][0]], name: 'Full House' };
  if (flush) return { score: [5, ...ranks], name: 'Flush' };
  if (straightHigh) return { score: [4, straightHigh], name: 'Straight' };
  if (groups[0][1] === 3) {
    const kickers = groups.filter(g => g[1] === 1).map(g => g[0]).sort((a,b)=>b-a);
    return { score: [3, groups[0][0], ...kickers], name: 'Three of a Kind' };
  }
  if (groups[0][1] === 2 && groups[1]?.[1] === 2) {
    const pairs = groups.filter(g => g[1] === 2).map(g => g[0]).sort((a,b)=>b-a);
    const kicker = groups.find(g => g[1] === 1)[0];
    return { score: [2, ...pairs, kicker], name: 'Two Pair' };
  }
  if (groups[0][1] === 2) {
    const kickers = groups.filter(g => g[1] === 1).map(g => g[0]).sort((a,b)=>b-a);
    return { score: [1, groups[0][0], ...kickers], name: 'Pair' };
  }
  return { score: [0, ...ranks], name: 'High Card' };
}

// Custom home-game low: choose the weakest normal five-card poker hand.
// Ace is rank 1, straights/flushes/pairs all count normally, and there is no qualifier.
export function evaluateLowFive(cards) {
  if (cards.length !== 5) throw new Error('evaluateLowFive requires exactly five cards');
  const ranks = cards.map(c => LOW_RANK_VALUE[c.rank]).sort((a,b) => b-a);
  const suits = cards.map(c => c.suit);
  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  const groups = [...counts.entries()].sort((a,b) => b[1]-a[1] || b[0]-a[0]);
  const unique = [...new Set(ranks)];
  let straightHigh = 0;
  if (unique.length === 5 && unique[0] - unique[4] === 4) straightHigh = unique[0];
  const flush = suits.every(s => s === suits[0]);

  if (straightHigh && flush) return { score: [8, straightHigh], name: 'Straight Flush' };
  if (groups[0][1] === 4) return { score: [7, groups[0][0], groups[1][0]], name: 'Four of a Kind' };
  if (groups[0][1] === 3 && groups[1][1] === 2) return { score: [6, groups[0][0], groups[1][0]], name: 'Full House' };
  if (flush) return { score: [5, ...ranks], name: 'Flush' };
  if (straightHigh) return { score: [4, straightHigh], name: 'Straight' };
  if (groups[0][1] === 3) {
    const kickers = groups.filter(g => g[1] === 1).map(g => g[0]).sort((a,b)=>b-a);
    return { score: [3, groups[0][0], ...kickers], name: 'Three of a Kind' };
  }
  if (groups[0][1] === 2 && groups[1]?.[1] === 2) {
    const pairs = groups.filter(g => g[1] === 2).map(g => g[0]).sort((a,b)=>b-a);
    const kicker = groups.find(g => g[1] === 1)[0];
    return { score: [2, ...pairs, kicker], name: 'Two Pair' };
  }
  if (groups[0][1] === 2) {
    const kickers = groups.filter(g => g[1] === 1).map(g => g[0]).sort((a,b)=>b-a);
    return { score: [1, groups[0][0], ...kickers], name: 'Pair' };
  }
  return { score: [0, ...ranks], name: 'High Card' };
}

function candidateHands(hole, board, construction) {
  if (construction === 'omaha') {
    if (hole.length < 2 || board.length < 3) return [];
    const out = [];
    for (const h of combinations(hole, 2)) for (const b of combinations(board, 3)) out.push([...h, ...b]);
    return out;
  }
  if (hole.length + board.length < 5) return [];
  return combinations([...hole, ...board], 5);
}

export function bestHigh(hole, board, construction = 'holdem') {
  let best = null;
  for (const cards of candidateHands(hole, board, construction)) {
    const ev = evaluateFive(cards);
    if (!best || lexCompare(ev.score, best.score) > 0) best = { ...ev, cards };
  }
  return best;
}

export function bestLow(hole, board, construction = 'holdem') {
  let best = null;
  for (const cards of candidateHands(hole, board, construction)) {
    const ev = evaluateLowFive(cards);
    if (!best || lexCompare(ev.score, best.score) < 0) best = { ...ev, cards };
  }
  return best;
}

export function compareHigh(a, b) { return lexCompare(a.score, b.score); }
export function compareLow(a, b) { return lexCompare(a.score, b.score); }
