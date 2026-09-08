import test from 'node:test';
import assert from 'node:assert/strict';
import { PokerTable } from '../server/engine.js';

const p=(id,name)=>({id,name});
function seated(config={}){
  const t=new PokerTable({construction:'holdem',holeCards:2,boards:1,smallBlind:5,bigBlind:10,startingStack:100,...config});
  t.seatPlayer(p('a','A'),0);t.seatPlayer(p('b','B'),1);t.seatPlayer(p('c','C'),2);return t;
}
function checkThrough(t){
  let guard=0;
  while(!['complete','declare','runout-vote'].includes(t.phase)&&guard++<100){
    const actor=t.seats[t.actorIndex];assert.ok(actor,`actor missing in ${t.phase}`);
    const v=t.validActions(actor.id);assert.ok(v);
    if(v.canCheck)t.act(actor.id,'check');else t.act(actor.id,'call');
  }
}

test('deals exactly configured hole-card count',()=>{
  const t=seated({construction:'omaha',holeCards:8});t.startHand('a');
  for(const x of t.seats.filter(Boolean))assert.equal(x.hole.length,8);
});

test('supports four configured boards when the deck can cover them',()=>{
  const t=new PokerTable({construction:'holdem',holeCards:2,boards:4,maxPlayers:4,startingStack:100,smallBlind:1,bigBlind:2});
  t.seatPlayer(p('a','A'),0);t.seatPlayer(p('b','B'),1);t.startHand('a');
  assert.equal(t.boards.length,4);
});

test('only current actor gets valid actions',()=>{
  const t=seated();t.startHand('a');const actor=t.seats[t.actorIndex];assert.ok(t.validActions(actor.id));
  const other=t.seats.find(x=>x&&x.id!==actor.id);assert.equal(t.validActions(other.id),null);
});

test('folds can end hand and award pot',()=>{
  const t=seated();t.startHand('a');
  while(t.phase!=='complete'){const actor=t.seats[t.actorIndex];if(!actor)break;t.act(actor.id,'fold');}
  assert.equal(t.phase,'complete');assert.ok(t.lastResult?.summary.includes('uncontested'));
});

test('bomb pot can skip preflop and deal flop immediately',()=>{
  const t=seated({bombPotEnabled:true,bombPotEvery:1,bombPotAmount:20,bombPotSkipPreflop:true});t.startHand('a');
  assert.equal(t.phase,'flop');assert.equal(t.boards[0].length,3);assert.equal(t.potTotal(),60);
  for(const x of t.seats.filter(Boolean))assert.equal(x.streetBet,0);
});

test('Hi/Low requires a separate declaration for every board',()=>{
  const t=new PokerTable({construction:'omaha',holeCards:4,boards:3,hiLow:true,startingStack:100,maxPlayers:3,smallBlind:1,bigBlind:2});
  t.seatPlayer(p('a','A'),0);t.seatPlayer(p('b','B'),1);t.startHand('a');
  checkThrough(t);assert.equal(t.phase,'declare');assert.equal(t.boards.length,3);
  assert.throws(()=>t.declare('a',['high','low']),/all 3/);
  t.declare('a',['high','low','both']);assert.equal(t.phase,'declare');
  t.declare('b',['both','high','low']);assert.equal(t.phase,'complete');
  assert.equal(t.seats.filter(Boolean).reduce((s,x)=>s+x.stack,0),200);
});

test('all-in runout voting uses lower choice when there is no majority',()=>{
  const t=new PokerTable({construction:'holdem',holeCards:2,boards:1,betting:'no-limit',startingStack:20,maxPlayers:2,smallBlind:1,bigBlind:2});
  t.seatPlayer(p('a','A'),0);t.seatPlayer(p('b','B'),1);t.startHand('a');
  let actor=t.seats[t.actorIndex];t.act(actor.id,'allin');
  actor=t.seats[t.actorIndex];t.act(actor.id,'call');
  assert.equal(t.phase,'runout-vote');assert.ok(t.runoutVote.maxRuns>=4);
  t.voteRunout('a',2);t.voteRunout('b',4);
  assert.equal(t.runCount,2);assert.equal(t.boards.length,2);assert.equal(t.phase,'allin-reveal');
  let now=Date.now()+4000,guard=0;while(t.phase==='allin-reveal'&&guard++<30){t.advanceAllInReveal(now);now+=4000;}
  assert.equal(t.boards[0].length,5);assert.equal(t.boards[1].length,5);assert.equal(t.phase,'complete');
});

test('strict majority wins runout vote',()=>{
  const t=seated({betting:'no-limit',startingStack:20,smallBlind:1,bigBlind:2});t.startHand('a');
  // Drive everybody all-in/called.
  let guard=0;
  while(t.phase!=='runout-vote'&&guard++<20){const actor=t.seats[t.actorIndex];assert.ok(actor);const v=t.validActions(actor.id);if(actor.stack>0)t.act(actor.id,'allin');else if(v?.canCall)t.act(actor.id,'call');}
  assert.equal(t.phase,'runout-vote');
  for(const id of t.runoutVote.voterIds.slice(0,2))t.voteRunout(id,4);
  const last=t.runoutVote?.voterIds.find(id=>!t.runoutVote.votes.has(id));if(last)t.voteRunout(last,1);
  assert.equal(t.runCount,4);
});

test('buy-back request requires host approval and supports cents',()=>{
  const t=new PokerTable({startingStack:10.25,smallBlind:.1,bigBlind:.2,maxPlayers:2});t.seatPlayer(p('a','A'),0);t.seatPlayer(p('b','B'),1);
  t.setStack('a','b',0);const req=t.requestBuyIn('b',12.34);assert.equal(t.seats[1].stack,0);
  t.decideBuyIn('a',req.id,true);assert.equal(t.seats[1].stack,12.34);
  assert.equal(t.config.smallBlind,.1);assert.equal(t.config.bigBlind,.2);
});

test('BOTH declaration loses the high half when it fails the low half',()=>{
  const t=new PokerTable({construction:'holdem',holeCards:2,boards:1,hiLow:true,startingStack:100,maxPlayers:2,smallBlind:1,bigBlind:2});
  t.seatPlayer(p('a','A'),0);t.seatPlayer(p('b','B'),1);
  const card=s=>({rank:s[0],suit:s[1]});
  t.seats[0].inHand=true;t.seats[1].inHand=true;t.seats[0].stack=90;t.seats[1].stack=90;t.seats[0].contributed=10;t.seats[1].contributed=10;
  t.seats[0].hole=[card('Kh'),card('Kd')]; // best high, no qualifying low
  t.seats[1].hole=[card('As'),card('5s')]; // qualifying wheel low
  t.boards=[[card('2c'),card('3d'),card('4h'),card('9s'),card('Kc')]];t.boardMeta=[{baseBoard:1,run:1}];
  t.declarations=new Map([['a',['both']],['b',['low']]]);
  t.showdown();
  assert.equal(t.lastResult.boards[0].high,null);
  assert.deepEqual(t.lastResult.boards[0].low.names,['B']);
  assert.equal(t.lastResult.boards[0].low.amount,20);
  assert.equal(t.seats[0].stack,90);assert.equal(t.seats[1].stack,110);
});


test('action timer checks when possible and folds when facing a bet',()=>{
  const t=seated({actionTimerSeconds:10});t.startHand('a');
  const first=t.seats[t.actorIndex];assert.ok(t.actionDeadline);const v=t.validActions(first.id);
  t.timeoutCurrentAction(t.actionDeadline+1);
  assert.ok(t.log.at(-1).text.includes(v.canCheck?'checks (timer)':'folds (timer)'));
});

test('complete hand schedules next hand for ten seconds later',()=>{
  const t=seated();t.startHand('a');
  while(t.phase!=='complete'){const actor=t.seats[t.actorIndex];if(!actor)break;t.act(actor.id,'fold');}
  assert.ok(t.nextHandAt>Date.now());assert.ok(t.nextHandAt-Date.now()<=10000);
  const old=t.handNumber;t.tryAutoStart(t.nextHandAt+1);assert.equal(t.handNumber,old+1);
});

test('showdown details identify hole cards used for Omaha high',()=>{
  const t=new PokerTable({construction:'omaha',holeCards:4,boards:1,startingStack:100,maxPlayers:2,smallBlind:1,bigBlind:2});
  t.seatPlayer(p('a','A'),0);t.seatPlayer(p('b','B'),1);const card=s=>({rank:s[0],suit:s[1]});
  t.seats[0].inHand=true;t.seats[1].inHand=true;t.seats[0].contributed=10;t.seats[1].contributed=10;t.seats[0].stack=90;t.seats[1].stack=90;
  t.seats[0].hole=[card('Ah'),card('Kh'),card('2c'),card('3c')];t.seats[1].hole=[card('As'),card('Ad'),card('4c'),card('5c')];
  t.boards=[[card('Qh'),card('Jh'),card('Th'),card('9s'),card('8d')]];t.boardMeta=[{baseBoard:1,run:1}];
  t.showdown();const a=t.lastResult.showdown[0].players.find(x=>x.playerId==='a');assert.equal(a.highUsedHole.length,2);assert.deepEqual(new Set(a.highUsedHole),new Set(['Ah','Kh']));
});

test('all-in Hi/Low runout pauses for a declaration on each completed board',()=>{
  const t=new PokerTable({construction:'omaha',holeCards:4,boards:2,hiLow:true,betting:'no-limit',startingStack:20,maxPlayers:2,smallBlind:1,bigBlind:2});
  t.seatPlayer(p('a','A'),0);t.seatPlayer(p('b','B'),1);t.startHand('a');
  let actor=t.seats[t.actorIndex];t.act(actor.id,'allin');actor=t.seats[t.actorIndex];t.act(actor.id,'call');
  t.voteRunout('a',1);t.voteRunout('b',1);
  let now=Date.now()+4000,guard=0;
  while(t.phase==='allin-reveal'&&guard++<10){t.advanceAllInReveal(now);now+=4000;}
  assert.equal(t.phase,'declare-runout');assert.equal(t.runoutDeclarationBoardIndex,0);
  t.declare('a',['high']);assert.equal(t.phase,'declare-runout');t.declare('b',['low']);assert.equal(t.phase,'allin-reveal');
  t.advanceAllInReveal(now+4000); // move to board 2
  now+=8000;guard=0;while(t.phase==='allin-reveal'&&guard++<10){t.advanceAllInReveal(now);now+=4000;}
  assert.equal(t.phase,'declare-runout');assert.equal(t.runoutDeclarationBoardIndex,1);
  t.declare('a',['both']);t.declare('b',['high']);assert.equal(t.phase,'allin-reveal');
});

test('preflop hand-strength indicator never reports above Pair',()=>{
  const t=new PokerTable({construction:'omaha',holeCards:4,boards:1,startingStack:100,maxPlayers:2,smallBlind:1,bigBlind:2});
  t.seatPlayer(p('a','A'),0);t.seatPlayer(p('b','B'),1);t.startHand('a');
  t.seats[0].hole=[{rank:'A',suit:'s'},{rank:'A',suit:'h'},{rank:'A',suit:'d'},{rank:'K',suit:'s'}];
  assert.equal(t.currentHandStrengths('a')[0].name,'Pair');
});

test('custom next-hand timer supports 10 to 30 seconds',()=>{
  const t=seated({nextHandTimerSeconds:27});t.startHand('a');
  while(t.phase!=='complete'){const actor=t.seats[t.actorIndex];if(!actor)break;t.act(actor.id,'fold');}
  const left=t.nextHandAt-Date.now();assert.ok(left>26000&&left<=27000);
});

test('away players keep their seat but are dealt out of the next hand',()=>{
  const t=new PokerTable({startingStack:100,maxPlayers:3,smallBlind:1,bigBlind:2});
  t.seatPlayer(p('a','A'),0);t.seatPlayer(p('b','B'),1);t.seatPlayer(p('c','C'),2);
  t.toggleAway('c',true);t.startHand('a');
  assert.equal(t.seats[2].away,true);assert.equal(t.seats[2].inHand,false);assert.equal(t.seats[2].hole.length,0);
  t.toggleAway('c',false);assert.equal(t.seats[2].away,false);
});

test('ledger tracks initial buy-ins, rebuys and cash-outs',()=>{
  const t=new PokerTable({startingStack:20,maxPlayers:2,smallBlind:.1,bigBlind:.2});
  t.seatPlayer(p('a','A'),0);t.seatPlayer(p('b','B'),1);
  let a=t.ledgerSnapshot().find(x=>x.playerId==='a');assert.equal(a.totalBuyIn,20);assert.equal(a.net,0);
  t.seats[0].stack=0;const r=t.requestBuyIn('a',7.25);t.decideBuyIn('a',r.id,true);
  a=t.ledgerSnapshot().find(x=>x.playerId==='a');assert.equal(a.totalBuyIn,27.25);assert.equal(a.currentStack,7.25);assert.equal(a.net,-20);
  t.leave('a');a=t.ledgerSnapshot().find(x=>x.playerId==='a');assert.equal(a.totalCashOut,7.25);assert.equal(a.net,-20);
});

test('host can pause and resume automatic next hand',()=>{
  const t=seated({nextHandTimerSeconds:15});t.startHand('a');
  while(t.phase!=='complete'){const actor=t.seats[t.actorIndex];if(!actor)break;t.act(actor.id,'fold');}
  t.pauseGame('a');assert.equal(t.paused,true);assert.equal(t.nextHandAt,null);
  t.resumeGame('a');assert.equal(t.paused,false);assert.ok(t.nextHandAt>Date.now()+14000);
});

test('ending game cashes out everyone and exposes final ledger',()=>{
  const t=seated({startingStack:20});
  t.endGame('a');assert.equal(t.phase,'ended');assert.equal(t.gameEnded,true);
  const rows=t.ledgerSnapshot();assert.equal(rows.length,3);assert.ok(rows.every(x=>x.currentStack===0));assert.ok(rows.every(x=>x.status==='finished'));
  assert.equal(rows.reduce((s,x)=>s+x.totalCashOut,0),60);
});

test('declaration state includes exact high and low descriptions for viewer',()=>{
  const t=new PokerTable({construction:'omaha',holeCards:4,boards:1,hiLow:true,startingStack:100,maxPlayers:2,smallBlind:1,bigBlind:2});
  t.seatPlayer(p('a','A'),0);t.seatPlayer(p('b','B'),1);
  const card=s=>({rank:s[0],suit:s[1]});t.seats[0].inHand=true;t.seats[1].inHand=true;
  t.seats[0].hole=[card('5s'),card('5h'),card('Ac'),card('2c')];t.boards=[[card('5d'),card('Ks'),card('Kh'),card('3c'),card('4d')]];t.boardMeta=[{baseBoard:1,run:1}];t.phase='declare';
  const d=t.publicState('a').declaration.viewerOptions[0];assert.match(d.high,/Full House/);assert.ok(d.low.length>0);assert.match(d.both,/\//);
});

test('deck capacity uses burns and matches 8-card Omaha examples',()=>{
  const five=new PokerTable({construction:'omaha',holeCards:8,boards:1,maxPlayers:5,startingStack:20,smallBlind:.1,bigBlind:.2});
  assert.equal(five.capacityAdvice(5).needed,48);
  assert.equal(five.capacityAdvice(5).maxRunsPreflop,1);
  const six=new PokerTable({construction:'omaha',holeCards:8,boards:1,maxPlayers:6,startingStack:20,smallBlind:.1,bigBlind:.2});
  assert.equal(six.capacityAdvice(6).baseSetupFits,false);
  const four=new PokerTable({construction:'omaha',holeCards:8,boards:1,maxPlayers:4,startingStack:20,smallBlind:.1,bigBlind:.2});
  assert.equal(four.capacityAdvice(4).needed,40);
  assert.equal(four.capacityAdvice(4).maxRunsPreflop,2);
});

test('start hand blocks an impossible deck configuration with actionable advice',()=>{
  const t=new PokerTable({construction:'omaha',holeCards:8,boards:1,maxPlayers:6,startingStack:20,smallBlind:.1,bigBlind:.2});
  for(let i=0;i<6;i++)t.seatPlayer(p(String(i),String(i)),i);
  assert.throws(()=>t.startHand('0'),/Not enough cards/);
});

test('community dealing burns one card before flop turn and river per board',()=>{
  const t=new PokerTable({construction:'holdem',holeCards:2,boards:1,maxPlayers:2,startingStack:100,smallBlind:1,bigBlind:2});
  t.seatPlayer(p('a','A'),0);t.seatPlayer(p('b','B'),1);t.startHand('a');
  // Finish preflop without an all-in.
  let guard=0;while(t.street==='preflop'&&guard++<10){const a=t.seats[t.actorIndex],v=t.validActions(a.id);t.act(a.id,v.canCheck?'check':'call');}
  assert.equal(t.boards[0].length,3);assert.equal(t.burnedCards.length,1);
  while(t.street==='flop'&&guard++<20){const a=t.seats[t.actorIndex],v=t.validActions(a.id);t.act(a.id,v.canCheck?'check':'call');}
  assert.equal(t.boards[0].length,4);assert.equal(t.burnedCards.length,2);
  while(t.street==='turn'&&guard++<30){const a=t.seats[t.actorIndex],v=t.validActions(a.id);t.act(a.id,v.canCheck?'check':'call');}
  assert.equal(t.boards[0].length,5);assert.equal(t.burnedCards.length,3);
});

test('7-2 offsuit bonus charges every non-away seated player except winner',()=>{
  const t=new PokerTable({construction:'holdem',holeCards:2,boards:1,maxPlayers:3,startingStack:100,smallBlind:1,bigBlind:2,sevenTwoEnabled:true,sevenTwoPayment:5});
  t.seatPlayer(p('a','A'),0);t.seatPlayer(p('b','B'),1);t.seatPlayer(p('c','C'),2);
  t.seats[0].hole=[{rank:'7',suit:'s'},{rank:'2',suit:'h'}];
  for(const x of t.seats)x.inHand=true;
  t.seats[0].contributed=2;t.seats[1].contributed=2;t.seats[2].contributed=2;
  t.awardUncontested(t.seats[0]);
  assert.equal(t.seats[0].stack,116); // 100 + pot 6 + two 5 payments
  assert.equal(t.seats[1].stack,95);assert.equal(t.seats[2].stack,95);
});

test('away player does not pay the 7-2 bonus',()=>{
  const t=new PokerTable({construction:'holdem',holeCards:2,maxPlayers:3,startingStack:100,sevenTwoEnabled:true,sevenTwoPayment:5});
  t.seatPlayer(p('a','A'),0);t.seatPlayer(p('b','B'),1);t.seatPlayer(p('c','C'),2);t.seats[2].away=true;
  t.seats[0].hole=[{rank:'7',suit:'c'},{rank:'2',suit:'d'}];for(const x of t.seats)x.inHand=true;
  t.awardUncontested(t.seats[0]);assert.equal(t.seats[1].stack,95);assert.equal(t.seats[2].stack,100);
});

test('anti-nit coins discount the next bomb contribution proportionally',()=>{
  const t=new PokerTable({construction:'holdem',holeCards:2,maxPlayers:2,startingStack:100,smallBlind:1,bigBlind:2,bombPotEnabled:true,bombPotEvery:3,bombPotAmount:20,bombPotSkipPreflop:true,antiNitEnabled:true});
  t.seatPlayer(p('a','A'),0);t.seatPlayer(p('b','B'),1);
  t.recordNitWinners([t.seats[0]]);t.recordNitWinners([t.seats[0]]); // A won both two normal hands before bomb #3
  t.handNumber=2;t.startHand('a');
  assert.equal(t.bombPot,true);assert.equal(t.seats[0].contributed,0);assert.equal(t.seats[1].contributed,20);
  assert.equal(t.nitCoins.get('a'),0);assert.equal(t.nitCycleHands,0);
});

test('all-in runout choices are capped by physical deck capacity including burns',()=>{
  const t=new PokerTable({construction:'omaha',holeCards:8,boards:1,maxPlayers:4,startingStack:20,smallBlind:1,bigBlind:2,betting:'no-limit'});
  for(let i=0;i<4;i++)t.seatPlayer(p(String(i),String(i)),i);
  t.startHand('0');
  assert.equal(t.maxAvailableRuns(),2);
});

test('all monetary chip movements stay rounded to cents',()=>{
  const t=new PokerTable({construction:'holdem',holeCards:2,maxPlayers:2,startingStack:10.01,smallBlind:.1,bigBlind:.2,bombPotEnabled:true,bombPotEvery:1,bombPotAmount:2,bombPotSkipPreflop:true,antiNitEnabled:true});
  t.seatPlayer(p('a','A'),0);t.seatPlayer(p('b','B'),1);
  // Simulate one coin out of six non-bomb hands: $2 * (1 - 1/6) = 1.666... -> $1.67.
  t.nitCoins.set('a',1);t.nitCoins.set('b',0);t.nitCycleHands=6;
  t.startHand('a');
  assert.equal(t.seats[0].contributed,1.67);
  assert.equal(t.seats[1].contributed,2);
  for(const x of t.seats.filter(Boolean)){
    assert.equal(Math.round(x.stack*100),x.stack*100);
    assert.equal(Math.round(x.contributed*100),x.contributed*100);
  }
});


test('anti-nit gives no coin when a hand is chopped between players',()=>{
  const t=new PokerTable({construction:'holdem',holeCards:2,maxPlayers:2,startingStack:20,antiNitEnabled:true});
  t.seatPlayer(p('a','A'),0);t.seatPlayer(p('b','B'),1);
  t.recordNitWinners([t.seats[0],t.seats[1]]);
  assert.equal(t.nitCoins.get('a'),0);
  assert.equal(t.nitCoins.get('b'),0);
  assert.equal(t.nitCycleHands,1);
});

test('anti-nit awards at most one coin when one player scoops the whole hand',()=>{
  const t=new PokerTable({construction:'holdem',holeCards:2,maxPlayers:2,startingStack:20,antiNitEnabled:true});
  t.seatPlayer(p('a','A'),0);t.seatPlayer(p('b','B'),1);
  // Same winner appearing multiple times represents winning multiple boards/sides.
  t.recordNitWinners([t.seats[0],t.seats[0],t.seats[0]]);
  assert.equal(t.nitCoins.get('a'),1);
  assert.equal(t.nitCoins.get('b'),0);
  assert.equal(t.nitCycleHands,1);
});

test('zero-dollar bomb pot is cancelled and game pauses defensively',()=>{
  const t=new PokerTable({construction:'holdem',holeCards:2,maxPlayers:2,startingStack:20,bombPotEnabled:true,bombPotEvery:2,bombPotAmount:20,bombPotSkipPreflop:true,antiNitEnabled:true});
  t.seatPlayer(p('a','A'),0);t.seatPlayer(p('b','B'),1);
  // Simulate corrupted/legacy state where both players have a full-cycle discount.
  t.nitCoins.set('a',1);t.nitCoins.set('b',1);t.nitCycleHands=1;t.handNumber=1;
  t.startHand('a');
  assert.equal(t.paused,true);
  assert.equal(t.phase,'waiting');
  assert.equal(t.potTotal(),0);
  assert.ok(t.debugLog.some(x=>x.type==='ZERO_POT_BOMB_CANCELLED'));
});

test('admin debug trace records backend commands and chip actions without private hole values',()=>{
  const t=new PokerTable({construction:'holdem',holeCards:2,maxPlayers:2,startingStack:20,smallBlind:1,bigBlind:2});
  t.seatPlayer(p('a','A'),0);t.seatPlayer(p('b','B'),1);t.startHand('a');
  const actor=t.seats[t.actorIndex],v=t.validActions(actor.id);t.act(actor.id,v.canCheck?'check':'call');
  const snap=t.debugSnapshot();
  assert.equal(snap.version,'hosted-beta-1.0.0');
  assert.ok(snap.events.some(e=>e.type==='START_HAND_REQUEST'));
  assert.ok(snap.events.some(e=>e.type==='HAND_STARTED'));
  assert.ok(snap.events.some(e=>e.type==='CHIPS_COMMIT'));
  assert.ok(snap.events.some(e=>e.type==='PLAYER_ACTION_REQUEST'));
  assert.ok(snap.events.some(e=>e.type==='PLAYER_ACTION_APPLIED'));
  const serialized=JSON.stringify(snap.events.filter(e=>['START_HAND_REQUEST','HAND_STARTED'].includes(e.type)));
  for(const player of t.seats.filter(Boolean))for(const c of player.hole)assert.equal(serialized.includes(`${c.rank}${c.suit}`),false);
});

test('debug event count is exposed only to the host',()=>{
  const t=new PokerTable({maxPlayers:2,startingStack:20,smallBlind:1,bigBlind:2});
  t.seatPlayer(p('a','A'),0);t.seatPlayer(p('b','B'),1);
  assert.ok(Number.isInteger(t.publicState('a').debugEventCount));
  assert.equal(t.publicState('b').debugEventCount,null);
});


test('host can add a testing bot and non-host cannot',()=>{
  const t=new PokerTable({construction:'holdem',holeCards:2,maxPlayers:3,startingStack:20,smallBlind:.1,bigBlind:.2});
  t.hostPlayerId='a';t.seatPlayer(p('a','A'),0);t.seatPlayer(p('b','B'),1);
  assert.throws(()=>t.addTestBot('b'),/Only the host/);
  const bot=t.addTestBot('a');
  assert.equal(bot.isTestBot,true);assert.equal(t.seats.filter(Boolean).length,3);
  assert.equal(t.publicState('a').seats.find(x=>x?.id===bot.id).isTestBot,true);
});

test('testing bot automatically checks or calls and votes to run once',()=>{
  const t=new PokerTable({construction:'holdem',holeCards:2,maxPlayers:2,startingStack:20,smallBlind:1,bigBlind:2,betting:'no-limit'});
  t.hostPlayerId='a';t.seatPlayer(p('a','A'),0);const bot=t.addTestBot('a');
  t.startHand('a');
  let guard=0;
  while(t.phase==='preflop'&&guard++<30){
    const actor=t.seats[t.actorIndex];
    if(actor?.isTestBot)t.processTestBots();
    else { const v=t.validActions(actor.id); t.act(actor.id,v.canCheck?'check':'call'); }
  }
  assert.ok(t.debugLog.some(e=>e.type==='TEST_BOT_DECISION'));
  // Force a fresh heads-up all-in scenario to verify the bot's deterministic run-once vote.
  const u=new PokerTable({construction:'holdem',holeCards:2,maxPlayers:2,startingStack:10,smallBlind:1,bigBlind:2,betting:'no-limit'});
  u.hostPlayerId='h';u.seatPlayer(p('h','Host'),0);const b=u.addTestBot('h');u.startHand('h');
  guard=0;
  while(u.phase!=='runout-vote'&&guard++<20){const a=u.seats[u.actorIndex];if(a.isTestBot){const v=u.validActions(a.id);u.act(a.id,v.canCheck?'check':'call');}else u.act(a.id,'allin');}
  assert.equal(u.phase,'runout-vote');
  u.processTestBots();
  assert.equal(u.runoutVote.votes.get(b.id),1);
});
