const app = document.querySelector('#app');
const toastRoot = document.querySelector('#toast-root');
const pathRoom = location.pathname.match(/^\/g\/([^/]+)/)?.[1] || null;
const pathGroup = location.pathname.match(/^\/group\/([^/]+)/)?.[1] || null;
let account = null;
const preselectedGroup = new URLSearchParams(location.search).get('group') || '';
const SUIT = { s:'♠', h:'♥', d:'♦', c:'♣' };
const RANK_VALUE = { A:14, K:13, Q:12, J:11, T:10, '9':9, '8':8, '7':7, '6':6, '5':5, '4':4, '3':3, '2':2 };
const SUIT_ORDER = { s:4, h:3, c:2, d:1 };
let socket = null, state = null, chat = [], identity = null, activeTab = 'game', handLogOpen = false;
let declareDraft = [], declareDraftKey = '';

function esc(s=''){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function money(n){const v=Number(n||0);return v.toLocaleString(undefined,{minimumFractionDigits:Number.isInteger(v)?0:2,maximumFractionDigits:2});}
function toast(message,type='error'){const d=document.createElement('div');d.className=`toast ${type}`;d.textContent=message;toastRoot.append(d);setTimeout(()=>d.remove(),3200);}
function roomStoreKey(id){return `custom-poker:${id}`;}
function getIdentity(id){try{return JSON.parse(localStorage.getItem(roomStoreKey(id))||'null')}catch{return null}}
function saveIdentity(id,x){localStorage.setItem(roomStoreKey(id),JSON.stringify(x));identity=x;}
function cardKey(c){return c?`${c.rank}${c.suit}`:'';}

async function requestJSON(url,options={}){const r=await fetch(url,{...options,headers:{'content-type':'application/json',...(options.headers||{})}});const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error||'Request failed');return data;}
async function getAccount(){try{return (await requestJSON('/api/auth/me')).user}catch{return null}}
function authScreen(message='Sign in to continue'){
  app.innerHTML=`<main class="portal-shell"><section class="auth-card"><div class="brand">CUSTOM <span>POKER</span></div><h1>${esc(message)}</h1><div class="auth-grid"><form id="login-form"><h2>Sign in</h2><label>Player ID / real name<input name="realName" required autocomplete="name"></label><label>Password<input name="password" type="password" required autocomplete="current-password"></label><button class="primary">Sign in</button></form><form id="register-form"><h2>Create account</h2><label>Player ID / real name<input name="realName" required maxlength="80" autocomplete="name"></label><small>Your real name is the permanent identity used for group ledgers and settlements.</small><label>Table nickname<input name="nickname" required maxlength="24"></label><label>Password<input name="password" type="password" minlength="8" required autocomplete="new-password"></label><button class="primary">Create account</button></form></div></section></main>`;
  document.querySelector('#login-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await requestJSON('/api/auth/login',{method:'POST',body:JSON.stringify({realName:f.get('realName'),password:f.get('password')})});location.reload()}catch(x){toast(x.message)}};
  document.querySelector('#register-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await requestJSON('/api/auth/register',{method:'POST',body:JSON.stringify({realName:f.get('realName'),nickname:f.get('nickname'),password:f.get('password')})});location.reload()}catch(x){toast(x.message)}};
}
function createRoomForm(groups=[]){return `<section class="portal-card create-game-card"><h2>Create a game</h2><p class="muted">Games created inside a group automatically save their final ledger and debug trace when the host ends the session.</p><form id="create-form" class="form-grid">
  <div class="field wide"><label>Group</label><select name="groupId"><option value="">Personal / ungrouped game</option>${groups.map(g=>`<option value="${g.id}" ${g.id===preselectedGroup?'selected':''}>${esc(g.name)}</option>`).join('')}</select></div>
  <div class="field wide"><label>Room name</label><input name="gameName" value="Friday Custom Game" maxlength="48"></div>
  <div class="field"><label>Construction</label><select name="construction"><option value="omaha">Omaha (exactly 2 hole)</option><option value="holdem">Hold'em (best 5)</option></select></div>
  <div class="field"><label>Hole cards</label><select name="holeCards">${[2,3,4,5,6,7,8].map(n=>`<option ${n===4?'selected':''}>${n}</option>`).join('')}</select></div>
  <div class="field"><label>Boards</label><select name="boards">${[1,2,3,4].map(n=>`<option>${n}</option>`).join('')}</select></div>
  <div class="field"><label>Betting</label><select name="betting"><option value="pot-limit">Pot Limit</option><option value="no-limit">No Limit</option></select></div>
  <div class="field"><label>Small blind</label><input name="smallBlind" type="number" min="0" step="0.01" value="0.10"></div><div class="field"><label>Big blind</label><input name="bigBlind" type="number" min="0.01" step="0.01" value="0.20"></div>
  <div class="field"><label>Starting stack</label><input name="startingStack" type="number" min="0.01" step="0.01" value="20.00"></div><div class="field"><label>Max players</label><input name="maxPlayers" type="number" min="2" max="10" value="8"></div>
  <div class="field"><label>Action timer</label><input name="actionTimerSeconds" type="number" min="10" max="30" value="20"></div><div class="field"><label>Next-hand timer</label><input name="nextHandTimerSeconds" type="number" min="10" max="30" value="10"></div>
  <label class="checkline wide"><input type="checkbox" name="hiLow"> Declare High / Low / Both</label><label class="checkline wide"><input type="checkbox" name="bombPotEnabled"> Scheduled bomb pots</label><label class="checkline wide"><input type="checkbox" name="sevenTwoEnabled"> 7-2 offsuit game</label><div class="field wide"><label>7-2 payment</label><input name="sevenTwoPayment" type="number" min="0" step="0.01" value="1.00"></div><label class="checkline wide"><input type="checkbox" name="antiNitEnabled"> Anti-nit bomb-pot discount</label><button class="primary wide">Create private room</button></form></section>`}
async function createLanding(){
  account=await getAccount();if(!account)return authScreen();const d=await requestJSON('/api/dashboard');
  app.innerHTML=`<main class="portal-shell"><header class="portal-top"><div><div class="brand">CUSTOM <span>POKER</span></div><small>Hosted Beta 1.1</small></div><div class="account-chip"><b>${esc(account.nickname)}</b><span>${esc(account.realName)}</span><button class="ghost" id="edit-nick">Edit nickname</button><button class="ghost" id="logout">Sign out</button></div></header><section class="portal-grid"><div class="portal-column"><section class="portal-card"><h2>Your groups</h2><div class="group-list">${d.groups.length?d.groups.map(g=>`<a class="group-row" href="/group/${g.id}"><div><b>${esc(g.name)}</b><small>${esc(g.role||'member')}</small></div><span>Open →</span></a>`).join(''):'<p class="muted">No groups yet.</p>'}</div><div class="group-actions"><form id="create-group"><input name="name" maxlength="64" placeholder="New group name" required><button class="ghost">Create group</button></form><form id="join-group"><input name="inviteCode" placeholder="Invite code" required><button class="ghost">Join group</button></form></div></section>${createRoomForm(d.groups)}<section class="portal-card"><h2>Recent sessions</h2>${d.recent.length?d.recent.map(x=>`<div class="history-row"><div><b>${esc(x.roomName)}</b><small>${x.groupName?esc(x.groupName)+' · ':''}${new Date(x.startedAt).toLocaleString()}</small></div><span class="status ${esc(x.status)}">${esc(x.status)}</span></div>`).join(''):'<p class="muted">No sessions yet.</p>'}</section></div><div class="portal-column">${account.isSiteAdmin?`<section class="portal-card bug-inbox"><h2>Admin bug inbox <span class="count-pill">${d.openBugs.length}</span></h2><p class="muted">Automatic backend anomalies plus issues manually flagged by a host. Full final debug logs are stored with each ended session.</p>${d.openBugs.length?d.openBugs.map(b=>`<div class="bug-row ${esc(b.severity)}"><div><b>${esc(b.code)}</b><span>${esc(b.title)}</span><small>${b.roomName?esc(b.roomName)+' · ':''}${new Date(b.createdAt).toLocaleString()}</small></div><div class="bug-actions"><button class="ghost view-bug-debug" data-session="${b.sessionId||''}">Debug</button><button class="ghost resolve-bug" data-bug="${b.id}">Resolve</button></div></div>`).join(''):'<div class="success-box">No open automatically detected bugs.</div>'}</section>`:''}<section class="portal-card"><h2>How hosted sessions work</h2><p>Accounts keep real-name identity separate from the nickname shown at the table. Group games permanently record the final ledger; settlements are tracked as accounting only and are paid outside the site.</p><p>Active rooms are checkpointed so a normal server restart can restore the current table state.</p></section></div></section></main>`;
  document.querySelector('#logout').onclick=async()=>{await requestJSON('/api/auth/logout',{method:'POST'});location.reload()};
  document.querySelector('#edit-nick').onclick=async()=>{const n=prompt('New table nickname:',account.nickname);if(n)try{await requestJSON('/api/profile',{method:'POST',body:JSON.stringify({nickname:n})});location.reload()}catch(e){toast(e.message)}};
  document.querySelector('#create-group').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{const x=await requestJSON('/api/groups',{method:'POST',body:JSON.stringify({name:f.get('name')})});location.href=`/group/${x.group.id}`}catch(x){toast(x.message)}};
  document.querySelector('#join-group').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{const x=await requestJSON('/api/groups/join',{method:'POST',body:JSON.stringify({inviteCode:f.get('inviteCode')})});location.href=`/group/${x.group.id}`}catch(x){toast(x.message)}};
  document.querySelectorAll('.resolve-bug').forEach(b=>b.onclick=async()=>{await requestJSON(`/api/admin/bugs/${b.dataset.bug}/resolve`,{method:'POST'});b.closest('.bug-row').remove();});
  document.querySelectorAll('.view-bug-debug').forEach(b=>b.onclick=async()=>{if(!b.dataset.session)return toast('No finished session debug is attached yet.');try{const x=await requestJSON(`/api/admin/sessions/${b.dataset.session}/debug`);const bundle=JSON.stringify(x,null,2);const m=document.createElement('div');m.className='modal';m.innerHTML=`<div class="modal-card debug-modal"><div class="modal-head"><div><h2>${esc(x.roomName||'Session')} debug bundle</h2><p class="muted">Stored automatically when the host ended the game. Includes build version, config, ledger, detected bugs, and the full backend trace.</p></div><button class="ghost" id="saved-debug-close">Close</button></div><div class="debug-toolbar"><button class="ghost" id="saved-debug-copy">Copy Bug Report</button><button class="primary" id="saved-debug-download">Download Debug Bundle</button></div><pre class="debug-log">${esc(bundle)}</pre></div>`;document.body.append(m);m.querySelector('#saved-debug-close').onclick=()=>m.remove();m.querySelector('#saved-debug-copy').onclick=async()=>{try{await navigator.clipboard.writeText(bundle);toast('Bug report copied.','ok')}catch{toast('Could not copy bug report.')}};m.querySelector('#saved-debug-download').onclick=()=>{const blob=new Blob([bundle],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`custom-poker-debug-${x.sessionId}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)};}catch(e){toast(e.message)}});
  document.querySelector('#create-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);const config={name:f.get('gameName'),construction:f.get('construction'),holeCards:+f.get('holeCards'),boards:+f.get('boards'),betting:f.get('betting'),smallBlind:+f.get('smallBlind'),bigBlind:+f.get('bigBlind'),startingStack:+f.get('startingStack'),maxPlayers:+f.get('maxPlayers'),actionTimerSeconds:+f.get('actionTimerSeconds'),nextHandTimerSeconds:+f.get('nextHandTimerSeconds'),hiLow:f.has('hiLow'),bombPotEnabled:f.has('bombPotEnabled'),sevenTwoEnabled:f.has('sevenTwoEnabled'),sevenTwoPayment:+f.get('sevenTwoPayment'),antiNitEnabled:f.has('antiNitEnabled')};try{const data=await requestJSON('/api/rooms',{method:'POST',body:JSON.stringify({groupId:f.get('groupId')||null,config})});saveIdentity(data.roomId,{token:data.token,playerId:data.playerId,name:account.nickname});location.href=data.url}catch(err){toast(err.message)}};
}
async function renderGroup(){account=await getAccount();if(!account)return authScreen('Sign in to open this poker group');let d;try{d=await requestJSON(`/api/groups/${pathGroup}`)}catch(e){app.innerHTML=`<main class="portal-shell"><section class="portal-card"><h1>${esc(e.message)}</h1><a href="/">Back home</a></section></main>`;return}const g=d.group;
  app.innerHTML=`<main class="portal-shell"><header class="portal-top"><div><a href="/" class="back-link">← Home</a><h1>${esc(g.name)}</h1><small>${d.members.length} members · Your role: ${esc(g.role)}</small></div><div class="invite-chip">Invite code <b>${esc(g.inviteCode)}</b><button class="ghost" id="copy-invite">Copy</button></div></header><section class="portal-grid"><div class="portal-column"><section class="portal-card"><h2>All-time leaderboard</h2>${d.leaderboard.length?d.leaderboard.map((x,i)=>`<div class="leader-row"><span>#${i+1}</span><div><b>${esc(x.realName)}</b><small>${esc(x.nickname)} · ${x.sessions} sessions</small></div><strong class="${x.net>=0?'positive':'negative'}">${x.net>=0?'+':''}${money(x.net)}</strong></div>`).join(''):'<p class="muted">No completed real-player sessions yet.</p>'}</section><section class="portal-card"><h2>Outstanding settlements</h2><p class="muted">Accounting only. Payments happen outside this website.</p>${d.settlements.filter(x=>x.status==='open').length?d.settlements.filter(x=>x.status==='open').map(x=>`<div class="settlement-row"><div><b>${esc(x.fromRealName)} → ${esc(x.toRealName)}</b><small>${money(x.amount)}</small></div><button class="ghost settlement-paid" data-id="${x.id}">Mark paid</button></div>`).join(''):'<div class="success-box">Nothing outstanding.</div>'}</section><section class="portal-card"><h2>Past game ledgers</h2>${d.sessions.length?d.sessions.map(s=>`<details class="session-card ${s.isTest?'test-session':''}"><summary><div><b>${esc(s.roomName)}${s.isTest?' · TEST SESSION':''}</b><small>${new Date(s.endedAt).toLocaleString()} · hosted by ${esc(s.hostRealName)}</small></div></summary>${s.isTest?'<div class="test-session-note">TEST SESSION — contains host testing bots. Saved for history/debugging but excluded from leaderboard and settlements.</div>':''}<div class="session-ledger">${(s.ledger||[]).map(x=>`<div><span>${esc(x.name)}</span><span>Buy-in ${money(x.totalBuyIn)}</span><strong class="${x.net>=0?'positive':'negative'}">${x.net>=0?'+':''}${money(x.net)}</strong></div>`).join('')}</div></details>`).join(''):'<p class="muted">No completed sessions.</p>'}</section></div><div class="portal-column"><section class="portal-card"><h2>Members</h2>${d.members.map(m=>`<div class="member-row"><div><b>${esc(m.realName)}</b><small>${esc(m.nickname)}</small></div><span>${esc(m.role)}</span></div>`).join('')}</section><section class="portal-card"><h2>Start a group game</h2><a href="/?group=${encodeURIComponent(g.id)}" class="primary link-button">Create game from dashboard</a><p class="muted">Select this group in the Create Game form. Its final ledger and debug trace will save here automatically.</p></section></div></section></main>`;
  document.querySelector('#copy-invite').onclick=async()=>{await navigator.clipboard.writeText(g.inviteCode);toast('Invite code copied.','ok')};document.querySelectorAll('.settlement-paid').forEach(b=>b.onclick=async()=>{await requestJSON(`/api/groups/${g.id}/settlement-paid`,{method:'POST',body:JSON.stringify({settlementId:b.dataset.id})});b.closest('.settlement-row').remove();toast('Marked paid.','ok')});
}

function seatPos(index,total){
  const viewer=state.viewer?.seatIndex ?? -1;
  const angleDeg=viewer>=0 ? 90 + (360/total)*((index-viewer+total)%total) : -90 + (360/total)*index;
  const angle=angleDeg*Math.PI/180;
  return {left:50+46*Math.cos(angle),top:50+43*Math.sin(angle)};
}
function sortCards(cards){return [...cards].filter(Boolean).sort((a,b)=>(RANK_VALUE[b.rank]-RANK_VALUE[a.rank])||(SUIT_ORDER[b.suit]-SUIT_ORDER[a.suit]));}
function cardHTML(c,extra=''){if(!c)return `<div class="card back ${extra}"></div>`;return `<div class="card suit-${c.suit} ${extra}"><span>${esc(c.rank)}</span><span class="suit">${SUIT[c.suit]}</span></div>`;}
function boardLabel(i){const m=state.boardMeta?.[i]||{baseBoard:i+1,run:1};return state.runCount>1?`BOARD ${m.baseBoard} · RUN ${m.run}`:`BOARD ${m.baseBoard}`;}
function boardsHTML(){
  const compact=state.boards.length>4?' compact':'';
  const active=state.allInReveal?.boardIndex;
  return state.boards.map((b,i)=>`<div class="board-instance${compact}${active===i?' reveal-active':''}"><div class="board-tag">${state.boards.length>1?boardLabel(i):''}</div><div class="board-row">${[0,1,2,3,4].map(x=>b[x]?cardHTML(b[x]):'<div class="empty-card"></div>').join('')}</div></div>`).join('');
}
function seatsHTML(){
  return state.seats.map((p,i)=>{
    const pos=seatPos(i,state.seats.length);
    if(!p)return `<div class="seat" style="left:${pos.left}%;top:${pos.top}%"><button class="sit-button" data-sit="${i}">Sit Here</button></div>`;
    const isMe=p.id===state.viewer?.playerId;
    const cards=isMe?'':(p.hole||[]).map(c=>cardHTML(c)).join('');
    const cls=[i===state.actorIndex?'active':'',p.folded?'folded':'',!p.connected?'disconnected':'',p.away?'away':'',isMe?'viewer-seat':''].join(' ');
    const timer=i===state.actorIndex&&state.actionTimer?`<div class="seat-timer" data-deadline="${state.actionTimer.deadline}"><span class="action-timer-text"></span><i class="action-timer-fill"></i></div>`:'';
    return `<div class="seat ${cls} ${p.isTestBot?'test-bot-seat':''}" style="left:${pos.left}%;top:${pos.top}%"><div class="seat-cards">${cards}</div><div class="seat-box"><div class="name">${esc(p.name)}${p.isTestBot?' <span class="test-bot-badge" title="Host testing bot: automatically checks/calls, votes to run once, and auto-declares BOTH">AUTO</span>':''}${p.id===state.hostPlayerId?' ★':''}${p.away?' · AWAY':''}${state.config.antiNitEnabled?` <span class="nit-coin" title="Anti-nit wins this cycle">●${p.nitCoins||0}</span>`:''}</div><div class="stack">${money(p.stack)}</div></div>${timer}${p.streetBet>0?`<div class="bet-chip">${money(p.streetBet)}</div>`:''}${p.isDealer?'<div class="dealer">D</div>':''}</div>`;
  }).join('');
}
function handStrengthHTML(){
  const s=state.currentHandStrengths||[]; if(!s.length)return '';
  return `<div class="hand-strengths">${s.map((x,i)=>`<span>◆ ${s.length===1?esc(x.label||'Hand'):boardLabel(i)}: <b>${esc(x.name)}</b></span>`).join('')}</div>`;
}
function localHandHTML(){
  const i=state.viewer?.seatIndex; if(i==null||i<0)return '';
  const p=state.seats[i]; if(!p?.hole?.length)return '';
  const cards=sortCards(p.hole);
  return `<div class="local-hand"><div class="local-hand-title">YOUR HAND · ${esc(p.name)}</div>${handStrengthHTML()}<div class="local-card-grid">${cards.map(c=>cardHTML(c,'local-card')).join('')}</div></div>`;
}

function actionDock(){
  const v=state.viewer?.validActions;
  if(v){
    const callLabel=v.canCheck?'Check':`Call ${money(v.toCall)}`;
    const capButton=v.canAllIn
      ? '<button class="ghost cap-action" data-action="allin">All-in</button>'
      : `<button class="ghost cap-action" id="max-pot-btn">Max Pot</button>`;
    return `<div class="action-row"><button class="action-btn fold" data-action="fold">Fold</button><button class="action-btn call" data-action="${v.canCheck?'check':'call'}">${callLabel}</button><button class="action-btn raise" id="raise-btn" ${!v.canBetOrRaise?'disabled':''}>${state.currentBet?'Raise':'Bet'}</button></div>${v.canBetOrRaise?`<div class="raise-row"><span>${money(v.minTarget)}</span><input id="raise-range" type="range" min="${v.minTarget}" max="${v.maxTarget}" step="0.01" value="${v.minTarget}"><input id="raise-number" type="number" min="${v.minTarget}" max="${v.maxTarget}" step="0.01" value="${v.minTarget}">${capButton}</div>`:''}`;
  }
  const me=state.viewer?.seatIndex>=0;
  if(!me)return `<div class="status-dock">Choose an open seat to join the table.</div>`;
  if(state.phase==='runout-vote')return `<div class="status-dock">All-in runout vote in progress.</div>`;
  if(state.phase==='allin-reveal')return `<div class="status-dock">All-in runout reveal in progress.</div>`;
  if(['declare','declare-runout'].includes(state.phase))return `<div class="status-dock">Showdown declarations in progress.</div>`;
  if(state.phase==='complete')return `<div class="status-dock">${state.paused?'Game paused.':`Next hand starts automatically in <b class="next-hand-countdown">${Number(state.config.nextHandTimerSeconds||10).toFixed(1)}</b>s.`}</div>`;
  if(state.phase==='ended')return `<div class="status-dock">Game ended · final ledger locked.</div>`;
  if(state.deckError)return `<div class="status-dock">Game paused for deck capacity: ${esc(state.deckError.message)}</div>`;
  if(state.phase==='waiting')return `<div class="status-dock">${state.viewer.isHost?'Start the next hand when everyone is ready.':'Waiting for the host to start the next hand.'}</div>`;
  return `<div class="status-dock">Waiting for ${esc(state.seats[state.actorIndex]?.name||'action')}…</div>`;
}

function runoutOverlay(){
  const v=state.runoutVote;if(state.phase!=='runout-vote'||!v)return '';
  if(!v.viewerEligible)return `<div class="center-overlay"><div class="overlay-card"><h2>All-in Runout Vote</h2><p>Waiting for players still holding cards to vote.</p><strong>${v.votesReceived} / ${v.voterCount} votes submitted</strong></div></div>`;
  return `<div class="center-overlay"><div class="overlay-card"><h2>How many times should we run it?</h2><p>Majority wins. If there is no majority, the lower run count has priority: 1 → 2 → 3 → 4.</p><div class="run-votes">${[1,2,3,4].map(n=>`<button class="run-vote ${v.viewerVote===n?'selected':''}" data-run-vote="${n}" ${n>v.maxRuns?'disabled':''}>${n}<small>${n===1?'Once':n===2?'Twice':n===3?'Thrice':'4 Times'}</small></button>`).join('')}</div><div class="vote-progress">${v.votesReceived} / ${v.voterCount} votes submitted${v.maxRuns<4?` · deck capacity forces a maximum of ${v.maxRuns}`:''}</div></div></div>`;
}

function allInRevealShowcase(){
  const r=state.allInReveal;if(!r||state.phase!=='allin-reveal')return '';
  const label=r.meta?`BOARD ${r.meta.baseBoard}${state.runCount>1?` · RUN ${r.meta.run}`:''}`:'ALL-IN';
  const leaders=(r.leaders?.players||[]).map(e=>`<div class="equity-player ${e.highLeader||e.lowLeader?'current-leader':''}"><b>${esc(e.name)} ${e.highLeader?'🏆 HIGH':''}${e.lowLeader?' 🏆 LOW':''}</b><span>${esc(e.high||'Not enough cards')}</span>${state.config.hiLow&&e.low?`<span>Low: ${esc(e.low)}</span>`:''}</div>`).join('');
  const result=r.boardResult?`<div class="reveal-result">${r.boardResult.high?`<b>${esc(r.boardResult.high.names.join(', '))}</b> — ${esc(r.boardResult.high.hand)}`:''}${r.boardResult.low?`<br>Low: <b>${esc(r.boardResult.low.names.join(', '))}</b> — ${esc(r.boardResult.low.hand)}`:''}</div>`:'';
  return `<div class="reveal-showcase"><div class="reveal-label">${label}</div>${result||`<div class="ahead-title">CURRENTLY AHEAD</div><div class="equity-grid">${leaders}</div>`}<div class="reveal-countdown" data-deadline="${r.nextAt||0}"></div></div>`;
}

function ensureDeclareDraft(){
  if(!['declare','declare-runout'].includes(state.phase)||!state.declaration)return;
  const b=state.declaration.boardIndex;
  const key=`${state.handNumber}:${state.phase}:${b??'all'}:${state.declaration.boardCount}`;
  if(declareDraftKey!==key){declareDraftKey=key;declareDraft=state.declaration.viewerChoices?[...state.declaration.viewerChoices]:Array(state.declaration.boardCount).fill(null);}
}
function declarationOverlay(){
  if(!['declare','declare-runout'].includes(state.phase)||!state.declaration)return '';
  ensureDeclareDraft(); const submitted=state.declaration.viewerSubmitted;
  const indices=state.declaration.boardIndex==null?state.boards.map((_,i)=>i):[state.declaration.boardIndex];
  const options=state.declaration.viewerOptions||[];
  return `<div class="center-overlay declaration-overlay"><div class="overlay-card declaration-card"><h2>${indices.length===1?`Declare ${boardLabel(indices[0])}`:'Declare each board'}</h2><p>Choose <b>High</b>, <b>Low</b>, or <b>Both</b>. <b>Both is all-or-nothing:</b> you must win/tie both High and Low on that board or you lose both halves.</p><div class="declare-grid">${indices.map((absoluteIndex,localIndex)=>{const b=state.boards[absoluteIndex];const o=options[localIndex]||{};return `<div class="declare-board"><div class="declare-title">${boardLabel(absoluteIndex)}</div><div class="declare-mini">${b.map(c=>cardHTML(c,'mini-card')).join('')}</div><div class="declare-buttons detailed"><button type="button" data-declare-index="${localIndex}" data-declare="high" class="${declareDraft[localIndex]==='high'?'selected':''}"><b>HIGH</b><small>${esc(o.high||'—')}</small></button><button type="button" data-declare-index="${localIndex}" data-declare="low" class="${declareDraft[localIndex]==='low'?'selected':''}"><b>LOW</b><small>${esc(o.low||'—')}</small></button><button type="button" data-declare-index="${localIndex}" data-declare="both" class="${declareDraft[localIndex]==='both'?'selected':''}"><b>BOTH</b><small>${esc(o.both||'—')}</small></button></div></div>`;}).join('')}</div><button class="primary declare-submit" id="declare-submit" ${declareDraft.some(x=>!x)?'disabled':''}>${submitted?'Update declaration':'Submit declaration'}</button><div class="vote-progress">${state.declaration.submitted} / ${state.declaration.playerCount} players submitted. Choices stay hidden until everyone is done.</div></div></div>`;
}

function usedClass(card,detail){const k=cardKey(card);const h=detail.highUsedHole?.includes(k),l=detail.lowUsedHole?.includes(k);return h&&l?'used-both':h?'used-high':l?'used-low':'';}
function showdownWinnerBadges(boardDetail, player){
  const results=(state.lastResult?.boards||[]).filter(r=>r.baseBoard===boardDetail.baseBoard&&r.run===boardDetail.run);
  const high=results.some(r=>r.high?.playerIds?.includes(player.playerId));
  const low=results.some(r=>r.low?.playerIds?.includes(player.playerId));
  if(high&&low)return '<span class="winner-chip scoop">🏆 SCOOP</span>';
  return `${high?'<span class="winner-chip high">🏆 HIGH</span>':''}${low?'<span class="winner-chip low">🏆 LOW</span>':''}`;
}
function showdownBoardWinnerSummary(boardDetail){
  const results=(state.lastResult?.boards||[]).filter(r=>r.baseBoard===boardDetail.baseBoard&&r.run===boardDetail.run);
  const uniq=a=>[...new Set(a.filter(Boolean))];
  const highs=uniq(results.flatMap(r=>r.high?.names||[]));
  const lows=uniq(results.flatMap(r=>r.low?.names||[]));
  if(state.config.hiLow){
    if(highs.length&&lows.length&&highs.length===lows.length&&highs.every(n=>lows.includes(n))) return `<div class="board-winner-summary scoop">🏆 SCOOP: <b>${esc(highs.join(', '))}</b></div>`;
    const parts=[];
    if(highs.length)parts.push(`🏆 HIGH: <b>${esc(highs.join(', '))}</b>`);
    if(lows.length)parts.push(`🏆 LOW: <b>${esc(lows.join(', '))}</b>`);
    return `<div class="board-winner-summary">${parts.join('<span class="winner-sep">·</span>')}</div>`;
  }
  return highs.length?`<div class="board-winner-summary">🏆 WINNER: <b>${esc(highs.join(', '))}</b></div>`:'';
}
function showdownOverlay(){
  if(state.phase!=='complete'||!state.lastResult?.showdown?.length)return '';
  const auto=state.paused?'PAUSED':`Next hand in <b class="next-hand-countdown">${Number(state.config.nextHandTimerSeconds||10).toFixed(1)}</b>s`;
  const hostControls=state.viewer.isHost?`<div class="showdown-host-controls">${state.paused?'<button class="primary" id="resume-game">Resume Game</button>':'<button class="ghost" id="pause-game">Pause Game</button>'}<button class="danger" id="end-game">End Game</button></div>`:'';
  return `<div class="showdown-overlay"><div class="showdown-card"><div class="showdown-head"><div><h2>SHOWDOWN</h2><p>${esc(state.lastResult.summary)}</p></div><div class="next-auto">${auto}</div></div>${hostControls}<div class="showdown-boards">${state.lastResult.showdown.map((b,i)=>`<section class="showdown-board"><h3>${state.lastResult.runCount>1?`Board ${b.baseBoard} · Run ${b.run}`:`Board ${b.baseBoard}`}</h3>${showdownBoardWinnerSummary(b)}<div class="showdown-community">${b.board.map(c=>cardHTML(c,'mini-card')).join('')}</div>${b.players.map(p=>`<div class="showdown-player ${showdownWinnerBadges(b,p)?'winner-row':''}"><div class="showdown-name"><div class="winner-badges">${showdownWinnerBadges(b,p)}</div><b>${esc(p.name)}</b>${p.choice?`<span>${esc(p.choice.toUpperCase())}</span>`:''}<small>High: ${esc(p.highName||'—')}${p.lowName?` · Low: ${esc(p.lowName)}`:''}</small></div><div class="showdown-hole">${sortCards(p.hole).map(c=>cardHTML(c,`showdown-hole-card ${usedClass(c,p)}`)).join('')}</div></div>`).join('')}</section>`).join('')}</div><div class="showdown-legend"><span class="legend-high">High used card</span>${state.config.hiLow?'<span class="legend-low">Low used card</span><span class="legend-both">Used for both</span>':''}</div></div></div>`;
}

function buyInControls(){
  const me=state.viewer?.seatIndex>=0?state.seats[state.viewer.seatIndex]:null;
  if(!me||!['waiting','complete'].includes(state.phase)||me.stack>0)return '';
  const pending=state.buyInRequests?.find(r=>r.playerId===me.id);
  return pending?`<div class="buyin-box"><b>Buy-in requested: ${money(pending.amount)}</b><small>Waiting for host approval.</small></div>`:`<div class="buyin-box"><button class="primary" id="request-buyin">Request buy-in</button><small>Enter any chip amount; the host must approve it.</small></div>`;
}
function hostBuyInRequests(){
  if(!state.viewer.isHost)return ''; const reqs=state.buyInRequests||[];if(!reqs.length)return '';
  return `<h3>Buy-in requests</h3>${reqs.map(r=>`<div class="buyin-request"><div><b>${esc(r.playerName)}</b><small>requests ${money(r.amount)}</small></div><button class="primary buyin-approve" data-request="${esc(r.id)}">Approve</button><button class="danger buyin-decline" data-request="${esc(r.id)}">Decline</button></div>`).join('')}`;
}
function ledgerHTML(final=false){
  const rows=state.ledger||[];
  return `<div class="ledger ${final?'final-ledger':''}"><div class="ledger-head"><span>Player</span><span>Buy-ins</span><span>Cash out</span><span>Current</span><span>Net</span></div>${rows.map((r,i)=>`<div class="ledger-row ${r.net>0?'positive':r.net<0?'negative':''}"><span><b>${i+1}. ${esc(r.name)}</b><small>${esc(r.status||'')}</small></span><span>${money(r.totalBuyIn)}</span><span>${money(r.totalCashOut)}</span><span>${money(r.currentStack)}</span><strong>${r.net>=0?'+':''}${money(r.net)}</strong></div>`).join('')}</div>`;
}
function finalLedgerPage(){
  const gid=state.sessionMeta?.groupId||null;return `<div class="final-ledger-page"><div class="final-ledger-card"><div class="brand">CUSTOM <span>POKER</span></div><h1>Final Ledger</h1><p>Session complete · ${state.handNumber} hands played</p>${ledgerHTML(true)}<div class="final-ledger-actions"><a class="ghost link-button" href="/">Home</a>${gid?`<a class="ghost link-button" href="/group/${encodeURIComponent(gid)}">Back to Group</a>`:''}<a class="primary link-button" href="/${gid?`?group=${encodeURIComponent(gid)}`:''}">Create Another Game</a></div></div></div>`;
}

function debugLine(e){
  const stamp=new Date(e.at).toISOString();
  let details='';try{details=JSON.stringify(e.details??{});}catch{details=String(e.details??'');}
  return `[${String(e.seq).padStart(5,'0')}] ${stamp} H${e.hand} ${e.phase}/${e.street} ${e.type} ${details}`;
}
async function fetchDebugLog(){
  const r=await fetch(`/api/rooms/${pathRoom}/debug`,{headers:{'x-player-token':identity?.token||''},cache:'no-store'});
  const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error||'Could not load debug log');return data;
}
async function showDebugPanel(){
  if(!state?.viewer?.isHost)return;
  const m=document.createElement('div');m.className='modal';
  m.innerHTML=`<div class="modal-card debug-modal"><div class="modal-head"><div><h2>Admin Debug</h2><p class="muted">Host-only backend trace. Hidden hole-card values are intentionally not logged before showdown.</p></div><button type="button" class="ghost" id="debug-close">Close</button></div><div class="debug-toolbar"><span id="debug-meta">Loading…</span><button class="ghost" id="debug-refresh">Refresh</button><button class="primary" id="debug-copy">Copy all</button></div><pre class="debug-log" id="debug-log">Loading backend events…</pre></div>`;
  document.body.append(m);
  const logEl=m.querySelector('#debug-log'),meta=m.querySelector('#debug-meta');let latest='';
  async function load(){
    try{const data=await fetchDebugLog();latest=(data.events||[]).map(debugLine).join('\n');logEl.textContent=latest||'No debug events yet.';meta.textContent=`v${data.version||'5.1.0'} · ${(data.events||[]).length} events · Hand #${data.handNumber} · ${data.phase}`;logEl.scrollTop=logEl.scrollHeight;}catch(e){logEl.textContent=`ERROR LOADING DEBUG LOG: ${e.message}`;}
  }
  m.querySelector('#debug-close').onclick=()=>m.remove();
  m.querySelector('#debug-refresh').onclick=load;
  m.querySelector('#debug-copy').onclick=async()=>{await load();try{await navigator.clipboard.writeText(latest);toast('Full debug log copied.','ok');}catch{toast('Could not copy debug log.');}};
  await load();
}
function sidePanel(){
  const c=state.config;
  const me=state.viewer.seatIndex>=0?state.seats[state.viewer.seatIndex]:null;
  const tableButtons=me?`<div class="player-state-controls"><button class="ghost" id="away-toggle">${me.away?'I’m Back':'Away'}</button><button class="danger" id="leave-table">Leave / Cash Out</button></div>`:'';
  const log=`<div class="handlog-box"><button class="handlog-toggle" id="handlog-toggle"><span>Hand log</span><span>${handLogOpen?'▲':'▼'}</span></button>${handLogOpen?`<div class="handlog-scroll">${[...state.log].reverse().map(x=>`<div class="log-entry">${esc(x.text)}</div>`).join('')}</div>`:''}</div>`;
  return `<aside class="sidepanel"><div class="tabs"><button class="tab ${activeTab==='game'?'active':''}" data-tab="game">Game</button><button class="tab ${activeTab==='chat'?'active':''}" data-tab="chat">Chat</button></div>${activeTab==='game'?`<div class="panel-scroll"><div class="rule-summary"><div class="stat"><small>Variant</small><strong>${c.construction==='omaha'?'Omaha':'Hold’em'} · ${c.holeCards} cards</strong></div><div class="stat"><small>Boards</small><strong>${c.boards}${state.runCount>1?` × ${state.runCount} runs`:''}</strong></div><div class="stat"><small>Betting</small><strong>${c.betting==='pot-limit'?'Pot Limit':'No Limit'}</strong></div><div class="stat"><small>Showdown</small><strong>${c.hiLow?'Declare H/L/B · custom low':'High only'}</strong></div><div class="stat"><small>Blinds</small><strong>${money(c.smallBlind)} / ${money(c.bigBlind)}</strong></div><div class="stat"><small>Timers</small><strong>${c.actionTimerSeconds}s action · ${c.nextHandTimerSeconds}s next</strong></div><div class="stat"><small>7-2</small><strong>${c.sevenTwoEnabled?`${money(c.sevenTwoPayment)} each`:'Off'}</strong></div><div class="stat"><small>Anti-nit</small><strong>${c.antiNitEnabled?'On':'Off'}</strong></div></div>${state.deckCapacity?`<div class="capacity-box ${state.deckCapacity.baseSetupFits?'ok':'bad'}"><b>Deck capacity</b><small>${esc(state.deckCapacity.message)}</small></div>`:''}<div class="host-controls">${state.viewer.isHost?`<button class="primary" id="start-hand" ${(!['waiting','complete'].includes(state.phase)||state.paused||state.deckCapacity?.baseSetupFits===false)?'disabled':''}>Start Hand</button><button class="ghost" id="rules-btn">Rules</button>`:''}</div><div class="help-entry"><button class="ghost" id="help-guide">? Help & Rules</button><small>Explains every feature and highlights the rules active in this game.</small></div>${tableButtons}${state.viewer.isHost?`<div class="host-controls"><button class="ghost" id="force-bomb">${state.forceBombPotNext?'Bomb queued':'Bomb Next'}</button>${state.paused?'<button class="primary" id="resume-game-side">Resume</button>':''}</div><div class="test-bot-controls"><div><b>Host testing bots</b><small>TEST ONLY · Bots automatically CHECK/CALL every betting decision, vote RUN ONCE on all-ins, and auto-declare BOTH in Hi/Low so test hands keep moving.</small></div><button class="ghost" id="add-test-bot" ${(!['waiting','complete'].includes(state.phase)||state.seats.every(Boolean))?'disabled':''}>+ Add Auto Check/Call Bot</button></div><div class="admin-debug-entry"><button class="ghost debug-open" id="debug-open">Admin Debug <span>${state.debugEventCount??0}</span></button><button class="ghost" id="flag-bug">Flag issue</button><small>Debug traces are saved to the backend when the game ends. Flag semantic issues that automatic checks cannot detect.</small></div>`:''}${buyInControls()}${state.viewer.isHost?`<h3>Players</h3>${state.seats.filter(Boolean).map(p=>`<div class="log-entry player-admin-row"><span>${esc(p.name)}${p.isTestBot?' · AUTO CHECK/CALL BOT':''}${p.away?' · AWAY':''} · ${money(p.stack)}</span><span class="player-admin-actions"><button class="ghost stack-edit" data-player="${p.id}">Set stack</button>${p.isTestBot?`<button class="danger remove-test-bot" data-bot="${p.id}">Remove</button>`:''}</span></div>`).join('')}${hostBuyInRequests()}`:''}<h3>Ledger</h3>${ledgerHTML()}${log}</div>`:`<div class="panel-scroll" id="chat-list">${chat.map(x=>`<div class="chat-entry"><b>${esc(x.name)}</b>${x.text?` <span>${esc(x.text)}</span>`:''}${x.image?`<img class="chat-image" src="${esc(x.image)}" alt="Pasted chat image">`:''}</div>`).join('')}</div><form class="chat-compose chat-compose-rich" id="chat-form"><input maxlength="1000" placeholder="Message, emoji, or paste an image…"><input type="hidden" id="chat-image-data"><div id="chat-image-preview"></div><button class="ghost">Send</button></form>`}</aside>`;
}
function winnerBanner(){
  if(!state.lastResult||state.phase==='complete')return '';
  const lines=state.lastResult.boards?.slice(-10).map(r=>{const label=state.lastResult.runCount>1?`B${r.baseBoard}/R${r.run}`:`B${r.baseBoard}`;const hi=r.high?`High: ${esc(r.high.names.join(', '))} — ${esc(r.high.hand)}`:'';const lo=r.low?`Low: ${esc(r.low.names.join(', '))}`:'';return `${label}: ${[hi,lo].filter(Boolean).join(' / ')}`;}).join('<br>')||esc(state.lastResult.summary);
  return `<div class="winner-banner">${lines}</div>`;
}
function renderGame(){
  if(!state)return;
  if(state.phase==='ended'){app.innerHTML=finalLedgerPage();bindGame();return;}
  app.innerHTML=`<div class="game-shell"><header class="topbar"><div class="brand">CUSTOM <span>POKER</span></div><button class="copy-btn" id="copy-link">Copy invite link</button><div class="room-code">Room ${esc(pathRoom)} · Hand #${state.handNumber}</div></header><div class="game-layout"><main class="table-zone">${winnerBanner()}<div class="table-wrap"><div class="rail"></div><div class="felt"></div><div class="pot-label">Pot ${money(state.pot)}${state.bombPot?' · BOMB POT':''}</div><div class="boards">${boardsHTML()}</div>${seatsHTML()}</div>${localHandHTML()}<div class="action-dock">${actionDock()}</div>${runoutOverlay()}${allInRevealShowcase()}${declarationOverlay()}${showdownOverlay()}</main>${sidePanel()}</div></div>`;
  bindGame(); updateClocks();
}
function bindGame(){
  document.querySelectorAll('[data-sit]').forEach(b=>b.onclick=()=>socket.emit('sit',{seatIndex:+b.dataset.sit}));
  document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>socket.emit('action',{action:b.dataset.action}));
  document.querySelector('#raise-btn')?.addEventListener('click',()=>socket.emit('action',{action:state.currentBet?'raise':'bet',amount:+document.querySelector('#raise-number').value}));
  document.querySelector('#max-pot-btn')?.addEventListener('click',()=>socket.emit('action',{action:state.currentBet?'raise':'bet',amount:state.viewer.validActions.maxTarget}));
  const range=document.querySelector('#raise-range'),num=document.querySelector('#raise-number');if(range&&num){range.oninput=()=>num.value=range.value;num.oninput=()=>range.value=num.value;}
  document.querySelector('#start-hand')?.addEventListener('click',()=>socket.emit('start-hand'));
  document.querySelector('#leave-seat')?.addEventListener('click',()=>socket.emit('leave-seat'));
  document.querySelector('#leave-table')?.addEventListener('click',()=>{if(confirm('Leave the table and cash out?'))socket.emit('leave-table');});
  document.querySelector('#away-toggle')?.addEventListener('click',()=>{const me=state.seats[state.viewer.seatIndex];socket.emit('away',{away:!me.away});});
  document.querySelector('#rules-btn')?.addEventListener('click',showRules);
  document.querySelector('#help-guide')?.addEventListener('click',showHelpGuide);
  document.querySelector('#flag-bug')?.addEventListener('click',()=>{const note=prompt('Describe what looked wrong. The recent backend trace will be attached:');if(note)socket.emit('report-bug',{note});});
  document.querySelector('#force-bomb')?.addEventListener('click',()=>socket.emit('force-bomb',{}));
  document.querySelector('#add-test-bot')?.addEventListener('click',()=>socket.emit('add-test-bot',{}));
  document.querySelectorAll('.remove-test-bot').forEach(b=>b.addEventListener('click',()=>socket.emit('remove-test-bot',{botId:b.dataset.bot})));
  document.querySelector('#pause-game')?.addEventListener('click',()=>socket.emit('pause-game',{}));
  document.querySelector('#resume-game')?.addEventListener('click',()=>socket.emit('resume-game',{}));
  document.querySelector('#resume-game-side')?.addEventListener('click',()=>socket.emit('resume-game',{}));
  document.querySelector('#end-game')?.addEventListener('click',()=>{if(confirm('End this game for everyone and lock the final ledger?'))socket.emit('end-game',{});});
  document.querySelector('#handlog-toggle')?.addEventListener('click',()=>{handLogOpen=!handLogOpen;renderGame();});
  document.querySelector('#debug-open')?.addEventListener('click',showDebugPanel);
  document.querySelectorAll('.stack-edit').forEach(b=>b.addEventListener('click',()=>{const p=state.seats.find(x=>x?.id===b.dataset.player);const v=prompt(`Set ${p.name}'s stack:`,p.stack);if(v!==null&&v!=='')socket.emit('set-stack',{playerId:p.id,amount:+v});}));
  document.querySelector('#request-buyin')?.addEventListener('click',()=>{const v=prompt('How much do you want to buy back in for?','20.00');if(v!==null&&v!=='')socket.emit('buyin-request',{amount:+v});});
  document.querySelectorAll('.buyin-approve').forEach(b=>b.onclick=()=>socket.emit('buyin-decision',{requestId:b.dataset.request,approve:true}));
  document.querySelectorAll('.buyin-decline').forEach(b=>b.onclick=()=>socket.emit('buyin-decision',{requestId:b.dataset.request,approve:false}));
  document.querySelectorAll('[data-run-vote]').forEach(b=>b.onclick=()=>socket.emit('runout-vote',{runs:+b.dataset.runVote}));
  document.querySelectorAll('[data-declare-index]').forEach(b=>b.onclick=()=>{declareDraft[+b.dataset.declareIndex]=b.dataset.declare;renderGame();});
  document.querySelector('#declare-submit')?.addEventListener('click',()=>socket.emit('declare',{choices:[...declareDraft]}));
  document.querySelector('#copy-link')?.addEventListener('click',async()=>{await navigator.clipboard.writeText(location.href);toast('Invite link copied.','ok')});
  document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{activeTab=b.dataset.tab;renderGame();});
  document.querySelector('#chat-form')?.addEventListener('submit',e=>{e.preventDefault();const input=e.currentTarget.querySelector('input');const img=document.querySelector('#chat-image-data');socket.emit('chat',{text:input.value,imageData:img?.value||null});input.value='';if(img)img.value='';const preview=document.querySelector('#chat-image-preview');if(preview)preview.innerHTML='';});
  const chatInput=document.querySelector('#chat-form input:not([type=hidden])');chatInput?.addEventListener('paste',ev=>{const file=[...ev.clipboardData.files].find(f=>f.type.startsWith('image/'));if(!file)return;if(file.size>2_000_000){toast('Chat images must be 2 MB or smaller.');return}ev.preventDefault();const r=new FileReader();r.onload=()=>{const hidden=document.querySelector('#chat-image-data');if(hidden)hidden.value=r.result;const preview=document.querySelector('#chat-image-preview');if(preview)preview.innerHTML=`<img src="${r.result}" alt="Image ready to send"><button type="button" class="ghost" id="clear-chat-image">Remove image</button>`;document.querySelector('#clear-chat-image')?.addEventListener('click',()=>{hidden.value='';preview.innerHTML='';});};r.readAsDataURL(file);});
}
function showHelpGuide(){
  const c=state.config;const active=(on)=>on?'active-rule':'';
  const rules=[
    ['Variant',`${c.construction==='omaha'?'Omaha':'Hold’em'} with ${c.holeCards} hole cards`,true, c.construction==='omaha'?'Omaha requires exactly 2 hole cards and exactly 3 board cards for every five-card hand.':'Hold’em may use 0, 1, or 2 hole cards.'],
    ['Boards',`${c.boards} board${c.boards===1?'':'s'}`,true,'Each board receives its configured share of the pot. All-in runouts create clearly labeled additional board instances when physically possible.'],
    ['Betting',c.betting==='pot-limit'?'Pot Limit':'No Limit',true,c.betting==='pot-limit'?'Raises cannot exceed the current pot-limit maximum. The Max Pot button becomes All-in only when the full stack is legal.':'Any legal amount up to the player’s stack may be wagered.'],
    ['Declare High / Low / Both','Per-board declaration',c.hiLow,'High uses normal poker ranking. Low means the weakest legal normal five-card poker hand, with Ace below 2; pairs, straights and flushes count against the low. BOTH must win both halves or loses both claims.'],
    ['Bomb pots',`Every ${c.bombPotEvery} hands · ${money(c.bombPotAmount)} base`,c.bombPotEnabled,'When enabled, scheduled bomb pots charge the configured amount and may skip preflop.'],
    ['Anti-nit bomb discount','Win-based discount',c.antiNitEnabled,'A sole winner of an entire non-bomb hand earns one nit coin. Chopped hands award no coin. Coins reduce the next bomb contribution proportionally and are then cashed in.'],
    ['7-2 offsuit game',`${money(c.sevenTwoPayment)} from each active player`,c.sevenTwoEnabled,'Hold’em only. Winning with exactly 7-2 offsuit triggers the configured payment even when 7-2 makes the actual best hand. Away players do not pay.'],
    ['All-in run voting','1–4 runs',true,'Every live player votes. A strict majority wins; otherwise lower run counts have priority. Impossible run counts are disabled by physical deck-capacity checks.'],
    ['Action timer',`${c.actionTimerSeconds} seconds`,true,'When time expires the server checks if checking is legal; otherwise it folds the hand.'],
    ['Away mode','Sit out without leaving',true,'Away players keep their seat but are not dealt into new hands until they return.'],
    ['Rebuys','Host approval required',true,'A player may request any amount after busting. Chips are not added until the host approves.'],
    ['Testing bots','Host only',state.viewer.isHost,'Clearly labeled AUTO bots only check/call, vote run once, and auto-declare BOTH. Sessions containing testing bots are excluded from group rankings and debt settlements.']
  ];
  const m=document.createElement('div');m.className='modal';m.innerHTML=`<div class="modal-card help-modal"><div class="modal-head"><div><h2>Help & Rules</h2><p class="muted">Green items are active in this game. Other entries explain features that may appear in other rooms.</p></div><button class="ghost" id="help-close">Close</button></div><div class="help-rules">${rules.map(([name,value,on,desc])=>`<section class="help-rule ${active(on)}"><div><b>${on?'✓':'○'} ${esc(name)}</b><strong>${esc(value)}</strong></div><p>${esc(desc)}</p></section>`).join('')}</div></div>`;document.body.append(m);m.querySelector('#help-close').onclick=()=>m.remove();
}

function showRules(){
  const c=state.config;const m=document.createElement('div');m.className='modal';m.innerHTML=`<form class="modal-card" id="rules-form"><div class="modal-head"><h2>Game rules</h2><button type="button" class="ghost" id="close-modal">Close</button></div><div class="form-grid">
<div class="field wide"><label>Room name</label><input name="name" value="${esc(c.name)}"></div><div class="field"><label>Construction</label><select name="construction"><option value="omaha" ${c.construction==='omaha'?'selected':''}>Omaha (exact 2+3)</option><option value="holdem" ${c.construction==='holdem'?'selected':''}>Hold'em (best 5)</option></select></div><div class="field"><label>Hole cards</label><input name="holeCards" type="number" min="2" max="8" value="${c.holeCards}"></div><div class="field"><label>Boards</label><input name="boards" type="number" min="1" max="4" value="${c.boards}"></div><div class="field"><label>Betting</label><select name="betting"><option value="pot-limit" ${c.betting==='pot-limit'?'selected':''}>Pot Limit</option><option value="no-limit" ${c.betting==='no-limit'?'selected':''}>No Limit</option></select></div><div class="field"><label>Small blind</label><input name="smallBlind" type="number" min="0" step="0.01" value="${c.smallBlind}"></div><div class="field"><label>Big blind</label><input name="bigBlind" type="number" min="0.01" step="0.01" value="${c.bigBlind}"></div><div class="field"><label>Ante</label><input name="ante" type="number" min="0" step="0.01" value="${c.ante}"></div><div class="field"><label>Starting stack (new seats)</label><input name="startingStack" type="number" min="0.01" step="0.01" value="${c.startingStack}"></div><div class="field"><label>Max players</label><input name="maxPlayers" type="number" min="2" max="10" value="${c.maxPlayers}"></div><div class="field"><label>Action timer (10–30 sec)</label><input name="actionTimerSeconds" type="number" min="10" max="30" step="1" value="${c.actionTimerSeconds}"></div><div class="field"><label>Next hand timer (10–30 sec)</label><input name="nextHandTimerSeconds" type="number" min="10" max="30" step="1" value="${c.nextHandTimerSeconds}"></div><label class="checkline wide"><input name="hiLow" type="checkbox" ${c.hiLow?'checked':''}> Declare High / Low / Both on every board (custom weakest normal poker hand; Ace low; straights/flushes count)</label><label class="checkline wide"><input name="bombPotEnabled" type="checkbox" ${c.bombPotEnabled?'checked':''}> Scheduled bomb pots</label><div class="field"><label>Bomb amount</label><input name="bombPotAmount" type="number" min="0" step="0.01" value="${c.bombPotAmount}"></div><div class="field"><label>Every N hands</label><input name="bombPotEvery" type="number" min="1" value="${c.bombPotEvery}"></div><label class="checkline wide"><input name="bombPotSkipPreflop" type="checkbox" ${c.bombPotSkipPreflop?'checked':''}> Skip preflop on bomb pots</label><label class="checkline wide"><input name="antiNitEnabled" type="checkbox" ${c.antiNitEnabled?'checked':''}> Anti-nit bomb-pot discount: each non-bomb hand won earns a coin; coins reduce the next bomb contribution proportionally</label><label class="checkline wide"><input name="sevenTwoEnabled" type="checkbox" ${c.sevenTwoEnabled?'checked':''}> 7-2 offsuit game (requires 2-card Hold’em)</label><div class="field wide"><label>7-2 payment from each non-away seated player</label><input name="sevenTwoPayment" type="number" min="0" step="0.01" value="${c.sevenTwoPayment}"></div></div><p class="muted">Timed-out actions check when possible and fold when facing a bet. All-in runs are voted on by live players and then revealed sequentially at five-second intervals.</p><div class="modal-actions"><button class="primary">Save rules</button></div></form>`;
  document.body.append(m);document.querySelector('#close-modal').onclick=()=>m.remove();document.querySelector('#rules-form').onsubmit=e=>{e.preventDefault();const f=new FormData(e.currentTarget),patch={};for(const [k,v] of f.entries())patch[k]=['holeCards','boards','smallBlind','bigBlind','ante','startingStack','maxPlayers','bombPotAmount','bombPotEvery','actionTimerSeconds','nextHandTimerSeconds','sevenTwoPayment'].includes(k)?+v:v;patch.hiLow=f.has('hiLow');patch.bombPotEnabled=f.has('bombPotEnabled');patch.bombPotSkipPreflop=f.has('bombPotSkipPreflop');patch.sevenTwoEnabled=f.has('sevenTwoEnabled');patch.antiNitEnabled=f.has('antiNitEnabled');socket.emit('update-config',patch);m.remove();};
}

function updateClocks(){
  const now=Date.now();
  document.querySelectorAll('.seat-timer').forEach(el=>{const deadline=+el.dataset.deadline;const total=(state?.config?.actionTimerSeconds||20)*1000;const left=Math.max(0,deadline-now);const pct=Math.max(0,Math.min(100,left/total*100));el.querySelector('.action-timer-text').textContent=(left/1000).toFixed(1);el.querySelector('.action-timer-fill').style.width=`${pct}%`;});
  document.querySelectorAll('.next-hand-countdown').forEach(el=>{el.textContent=(Math.max(0,(state?.nextHandAt||now)-now)/1000).toFixed(1);});
  document.querySelectorAll('.reveal-countdown').forEach(el=>{const left=Math.max(0,+el.dataset.deadline-now);el.textContent=left?`Next reveal in ${(left/1000).toFixed(1)}s`:'';});
}
setInterval(updateClocks,200);

async function apiAction(action,payload={}){const r=await fetch(`/api/rooms/${pathRoom}/${action}`,{method:'POST',headers:{'content-type':'application/json','x-player-token':identity?.token||''},body:JSON.stringify(payload)});const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error||'Request failed');return data;}
function makeTransport(){return {emit(event,payload={}){const map={'sit':'sit','leave-seat':'leave-seat','start-hand':'start-hand','action':'action','update-config':'config','set-stack':'stack','force-bomb':'force-bomb','add-test-bot':'add-test-bot','remove-test-bot':'remove-test-bot','chat':'chat','runout-vote':'runout-vote','declare':'declare','buyin-request':'buyin-request','buyin-decision':'buyin-decision','away':'away','leave-table':'leave-table','pause-game':'pause-game','resume-game':'resume-game','end-game':'end-game','report-bug':'report-bug'};const action=map[event];if(!action)return;const body=event==='update-config'?{patch:payload}:event==='chat'?(typeof payload==='string'?{text:payload}:payload):payload;apiAction(action,body).catch(e=>toast(e.message));}}}
async function joinRoom(){
  account=await getAccount();if(!account)return authScreen('Sign in to join this poker table');
  const existing=getIdentity(pathRoom);identity=existing||{name:account.nickname};
  try{const data=await requestJSON(`/api/rooms/${pathRoom}/join`,{method:'POST',body:JSON.stringify({token:identity?.token})});saveIdentity(pathRoom,{token:data.token,playerId:data.playerId,name:data.name});socket=makeTransport();const es=new EventSource(`/api/rooms/${pathRoom}/events?token=${encodeURIComponent(identity.token)}`);es.addEventListener('state',ev=>{const incoming=JSON.parse(ev.data);chat=incoming.chat||[];delete incoming.chat;state=incoming;renderGame()});es.onerror=()=>{if(!state)toast('Connection interrupted. Retrying…');};}
  catch(e){if(e.message==='Room not found'){app.innerHTML='<main class="portal-shell"><section class="portal-card"><h1>Room not found</h1><p>The room may have been ended or removed.</p><a href="/">Back home</a></section></main>';}else toast(e.message);}
}

if(pathRoom)joinRoom();else if(pathGroup)renderGroup();else createLanding();
