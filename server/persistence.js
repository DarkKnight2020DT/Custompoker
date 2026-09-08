import { PokerTable } from './engine.js';
import { all, one, run, uid, now, cents } from './db.js';

const encodeTable=table=>({
  version:1,
  props:{...table,
    needsAction:[...table.needsAction],
    declarations:[...table.declarations.entries()],
    ledger:[...table.ledger.entries()],
    nitCoins:[...table.nitCoins.entries()],
    runoutVote:table.runoutVote?{...table.runoutVote,votes:[...table.runoutVote.votes.entries()]}:null
  }
});
function decodeTable(snapshot){
  const raw=typeof snapshot==='string'?JSON.parse(snapshot):snapshot;const p=raw.props||raw;const t=new PokerTable(p.config||{});
  Object.assign(t,p);
  t.needsAction=new Set(p.needsAction||[]);t.declarations=new Map(p.declarations||[]);t.ledger=new Map(p.ledger||[]);t.nitCoins=new Map(p.nitCoins||[]);
  if(p.runoutVote)t.runoutVote={...p.runoutVote,votes:new Map(p.runoutVote.votes||[])};
  return t;
}
export function persistRoom(room){
  const payload={id:room.id,sessionId:room.sessionId,groupId:room.groupId||null,table:encodeTable(room.table),players:[...room.players.entries()],chat:room.chat||[]};
  run(`INSERT INTO active_rooms(room_id,snapshot_json,updated_at) VALUES(?,?,?) ON CONFLICT(room_id) DO UPDATE SET snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at`,room.id,JSON.stringify(payload),now());
}
export function deleteRoomSnapshot(roomId){run('DELETE FROM active_rooms WHERE room_id=?',roomId);}
export function loadRooms(){return all('SELECT * FROM active_rooms').map(r=>{try{const p=JSON.parse(r.snapshot_json);return {id:p.id,sessionId:p.sessionId,groupId:p.groupId,table:decodeTable(p.table),players:new Map(p.players||[]),chat:p.chat||[],clients:new Map(),persistedFinal:false};}catch(e){console.error('Could not restore room',r.room_id,e);return null}}).filter(Boolean);}

function memberUserMap(room){const m=new Map();for(const [,p] of room.players)m.set(p.id,p.accountId||null);return m;}
function settleRows(ledger,accountByPlayer){
  const creditors=[],debtors=[];
  for(const e of ledger){const userId=accountByPlayer.get(e.playerId);if(!userId)continue;const net=cents(e.net);if(net>0.009)creditors.push({userId,amt:net});else if(net<-0.009)debtors.push({userId,amt:-net});}
  const rows=[];let i=0,j=0;
  while(i<debtors.length&&j<creditors.length){const amt=cents(Math.min(debtors[i].amt,creditors[j].amt));if(amt>0)rows.push({from:debtors[i].userId,to:creditors[j].userId,amount:amt});debtors[i].amt=cents(debtors[i].amt-amt);creditors[j].amt=cents(creditors[j].amt-amt);if(debtors[i].amt<0.01)i++;if(creditors[j].amt<0.01)j++;}
  return rows;
}
const anomalyTypes=new Set(['API_ERROR','SERVER_TIMER_ERROR','DECK_CAPACITY_FAILURE','ZERO_POT_BOMB_CANCELLED']);
export function deriveBugs(room,ledger,debug){
  const bugs=[];for(const e of debug.events||[]){if(anomalyTypes.has(e.type))bugs.push({severity:e.type.includes('ERROR')?'error':'warning',code:e.type,title:e.type.replaceAll('_',' '),details:{event:e}});}
  const sum=cents(ledger.reduce((a,e)=>a+Number(e.net||0),0));if(Math.abs(sum)>0.01)bugs.push({severity:'error',code:'LEDGER_NOT_BALANCED',title:'Final ledger does not balance to zero',details:{netSum:sum,ledger}});
  const last=room.table.lastResult;if(last&&Number(last.pot)>0&&Array.isArray(last.boards)&&!last.boards.some(b=>b.high||b.low))bugs.push({severity:'error',code:'POT_WITHOUT_WINNER',title:'Positive pot completed without a recorded winner',details:{lastResult:last}});
  return bugs;
}
export function finalizeSession(room){
  if(room.persistedFinal)return;const s=one('SELECT * FROM poker_sessions WHERE id=?',room.sessionId);if(!s)return;
  const ledger=room.table.ledgerSnapshot();const debug=room.table.debugSnapshot();const accountByPlayer=memberUserMap(room);
  const isTest=room.table.seats.some(p=>p?.isTestBot)?1:0;
  run('UPDATE poker_sessions SET ended_at=?,status=?,final_ledger_json=?,final_debug_log_json=?,debug_event_count=?,finalized_at=?,is_test=? WHERE id=?',now(),'ended',JSON.stringify(ledger),JSON.stringify(debug),debug.eventCount||0,now(),isTest,room.sessionId);
  run('DELETE FROM session_players WHERE session_id=?',room.sessionId);
  for(const e of ledger){const userId=accountByPlayer.get(e.playerId);const user=userId?one('SELECT real_name,nickname FROM users WHERE id=?',userId):null;run('INSERT INTO session_players(session_id,user_id,player_id,real_name,nickname,total_buy_in,total_cash_out,net,status) VALUES(?,?,?,?,?,?,?,?,?)',room.sessionId,userId,e.playerId,user?.real_name||null,e.name||user?.nickname||'Player',cents(e.totalBuyIn),cents(e.totalCashOut),cents(e.net),e.status||null);}
  run('DELETE FROM settlements WHERE session_id=?',room.sessionId);
  if(room.groupId&&!isTest){for(const x of settleRows(ledger,accountByPlayer)){if(x.from!==x.to)run('INSERT INTO settlements(id,group_id,session_id,from_user_id,to_user_id,amount,status,created_at) VALUES(?,?,?,?,?,?,?,?)',uid(12),room.groupId,room.sessionId,x.from,x.to,x.amount,'open',now());}}
  for(const b of deriveBugs(room,ledger,debug))run('INSERT INTO bug_reports(id,session_id,room_id,severity,code,title,details_json,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)',uid(12),room.sessionId,room.id,b.severity,b.code,b.title,JSON.stringify(b.details||{}),'open',now());
  room.persistedFinal=true;deleteRoomSnapshot(room.id);
}
