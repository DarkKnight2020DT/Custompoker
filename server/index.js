import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PokerTable, sanitizeConfig } from './engine.js';
import { db, one, all, run, uid, now, cents, userPublic, groupPublic } from './db.js';
import { currentUser, requireUser, register, login, createSession, logout, updateNickname } from './auth.js';
import { persistRoom, loadRooms, finalizeSession } from './persistence.js';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const rootDir=path.join(__dirname,'..');
const publicDir=path.join(rootDir,'public');
const dataDir=process.env.DATA_DIR||path.join(rootDir,'data');
const uploadDir=path.join(dataDir,'uploads');
await mkdir(uploadDir,{recursive:true});
const rooms=new Map(loadRooms().map(r=>[r.id,r]));
const id=(bytes=6)=>randomBytes(bytes).toString('base64url');
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml'};
const rateBuckets=new Map();
function clientIp(req){return String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'local').split(',')[0].trim();}
function rateLimit(key,max,windowMs){const t=Date.now();let b=rateBuckets.get(key);if(!b||t-b.started>=windowMs)b={started:t,count:0};b.count++;rateBuckets.set(key,b);if(b.count>max)throw Object.assign(new Error('Too many requests. Try again shortly.'),{statusCode:429});}

function json(res,status,data){const body=JSON.stringify(data);res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(body),'cache-control':'no-store'});res.end(body);}
async function body(req,max=3_000_000){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>max)throw Error('Request too large.');}if(!raw)return{};try{return JSON.parse(raw)}catch{throw Error('Invalid JSON.')}}
function roomOr404(res,roomId){const r=rooms.get(roomId);if(!r)json(res,404,{error:'Room not found'});return r;}
function roomAuth(room,token,user){const p=token?room.players.get(token):null;if(!p)throw Error('Invalid or expired room token.');if(user&&p.accountId&&p.accountId!==user.id)throw Object.assign(new Error('This room identity belongs to a different account.'),{statusCode:403});return p;}
function sseSend(res,event,data){res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);}
function broadcast(room){for(const [token,clients] of room.clients){const p=room.players.get(token);if(!p)continue;const payload=room.table.publicState(p.id);payload.chat=room.chat;payload.sessionMeta={sessionId:room.sessionId,groupId:room.groupId||null};for(const res of clients){try{sseSend(res,'state',payload)}catch{}}}}
function error(res,e,status){json(res,status||e?.statusCode||400,{error:e?.message||String(e)});}
function mustAdmin(user){if(!user?.isSiteAdmin)throw Object.assign(new Error('Site admin access required.'),{statusCode:403});}
function mustGroupMember(userId,groupId){const m=one('SELECT role FROM group_members WHERE group_id=? AND user_id=?',groupId,userId);if(!m)throw Object.assign(new Error('You are not a member of that group.'),{statusCode:403});return m;}
function groupDetails(groupId,userId){
  const g=one(`SELECT g.*,gm.role FROM groups g JOIN group_members gm ON gm.group_id=g.id AND gm.user_id=? WHERE g.id=?`,userId,groupId);if(!g)return null;
  const members=all(`SELECT u.id,u.real_name,u.nickname,gm.role,gm.joined_at FROM group_members gm JOIN users u ON u.id=gm.user_id WHERE gm.group_id=? ORDER BY CASE gm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,u.real_name`,groupId).map(x=>({id:x.id,realName:x.real_name,nickname:x.nickname,role:x.role,joinedAt:x.joined_at}));
  const sessions=all(`SELECT ps.*,u.real_name host_real_name,u.nickname host_nickname FROM poker_sessions ps JOIN users u ON u.id=ps.host_user_id WHERE ps.group_id=? AND ps.status='ended' ORDER BY ps.ended_at DESC LIMIT 100`,groupId).map(s=>({id:s.id,roomId:s.room_id,roomName:s.room_name,startedAt:s.started_at,endedAt:s.ended_at,hostRealName:s.host_real_name,hostNickname:s.host_nickname,ledger:s.final_ledger_json?JSON.parse(s.final_ledger_json):[],isTest:Boolean(s.is_test)}));
  const leaderboard=all(`SELECT sp.user_id,u.real_name,u.nickname,ROUND(SUM(sp.net),2) net,COUNT(DISTINCT sp.session_id) sessions FROM session_players sp JOIN poker_sessions ps ON ps.id=sp.session_id JOIN users u ON u.id=sp.user_id WHERE ps.group_id=? AND ps.is_test=0 GROUP BY sp.user_id ORDER BY net DESC,u.real_name`,groupId).map(x=>({userId:x.user_id,realName:x.real_name,nickname:x.nickname,net:cents(x.net),sessions:Number(x.sessions)}));
  const settlements=all(`SELECT s.*,fu.real_name from_real,fu.nickname from_nick,tu.real_name to_real,tu.nickname to_nick FROM settlements s JOIN users fu ON fu.id=s.from_user_id JOIN users tu ON tu.id=s.to_user_id WHERE s.group_id=? ORDER BY CASE s.status WHEN 'open' THEN 0 ELSE 1 END,s.created_at DESC`,groupId).map(x=>({id:x.id,fromUserId:x.from_user_id,toUserId:x.to_user_id,fromRealName:x.from_real,fromNickname:x.from_nick,toRealName:x.to_real,toNickname:x.to_nick,amount:cents(x.amount),status:x.status,createdAt:x.created_at,settledAt:x.settled_at}));
  const presets=all('SELECT * FROM group_presets WHERE group_id=? ORDER BY updated_at DESC',groupId).map(p=>({id:p.id,name:p.name,config:JSON.parse(p.config_json),updatedAt:p.updated_at}));
  return {group:groupPublic(g),members,sessions,leaderboard,settlements,presets};
}
function dashboard(user){const groups=all(`SELECT g.*,gm.role FROM groups g JOIN group_members gm ON gm.group_id=g.id WHERE gm.user_id=? ORDER BY g.name`,user.id).map(groupPublic);const recent=all(`SELECT ps.*,g.name group_name FROM poker_sessions ps LEFT JOIN groups g ON g.id=ps.group_id WHERE ps.host_user_id=? OR ps.id IN (SELECT session_id FROM session_players WHERE user_id=?) ORDER BY ps.started_at DESC LIMIT 20`,user.id,user.id).map(s=>({id:s.id,roomId:s.room_id,roomName:s.room_name,groupName:s.group_name,status:s.status,startedAt:s.started_at,endedAt:s.ended_at}));const bugs=user.isSiteAdmin?all(`SELECT b.*,ps.room_name FROM bug_reports b LEFT JOIN poker_sessions ps ON ps.id=b.session_id WHERE b.status='open' ORDER BY CASE b.severity WHEN 'error' THEN 0 ELSE 1 END,b.created_at DESC LIMIT 100`).map(b=>({id:b.id,sessionId:b.session_id,roomId:b.room_id,severity:b.severity,code:b.code,title:b.title,details:b.details_json?JSON.parse(b.details_json):{},createdAt:b.created_at,roomName:b.room_name})):[];return {user,groups,recent,openBugs:bugs};}
async function serveStatic(req,res,pathname){
  let filePath;if(pathname==='/'||pathname.startsWith('/g/')||pathname.startsWith('/group/')||pathname==='/admin')filePath=path.join(publicDir,'index.html');else if(pathname.startsWith('/uploads/'))filePath=path.join(dataDir,pathname);else filePath=path.normalize(path.join(publicDir,pathname));
  const allowed=filePath.startsWith(publicDir)||filePath.startsWith(uploadDir);if(!allowed)return json(res,403,{error:'Forbidden'});
  try{const data=await readFile(filePath);res.writeHead(200,{'content-type':mime[path.extname(filePath)]||'application/octet-stream','cache-control':pathname.startsWith('/uploads/')?'private, max-age=86400':'no-store, no-cache, must-revalidate','x-content-type-options':'nosniff'});res.end(data);}catch{if(!pathname.includes('.')){const data=await readFile(path.join(publicDir,'index.html'));res.writeHead(200,{'content-type':mime['.html'],'cache-control':'no-store'});res.end(data);}else json(res,404,{error:'Not found'});}
}
async function saveChatImage(dataUrl){const m=String(dataUrl||'').match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/);if(!m)throw Error('Only pasted PNG, JPEG, WebP, or GIF images are allowed.');const buf=Buffer.from(m[2],'base64');if(buf.length>2_000_000)throw Error('Chat images must be 2 MB or smaller.');const ext=m[1]==='jpeg'?'jpg':m[1];const name=`${uid(16)}.${ext}`;await writeFile(path.join(uploadDir,name),buf);return `/uploads/${name}`;}

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');const pathname=url.pathname;let debugRoom=null;
  try{
    if(pathname==='/api/auth/me'&&req.method==='GET')return json(res,200,{user:currentUser(req)});
    if(pathname==='/api/auth/register'&&req.method==='POST'){rateLimit(`auth:${clientIp(req)}`,12,60_000);const b=await body(req);const u=register(b);createSession(u.id,res);return json(res,201,{user:u});}
    if(pathname==='/api/auth/login'&&req.method==='POST'){rateLimit(`auth:${clientIp(req)}`,12,60_000);const b=await body(req);const u=login(b);createSession(u.id,res);return json(res,200,{user:u});}
    if(pathname==='/api/auth/logout'&&req.method==='POST'){logout(req,res);return json(res,200,{ok:true});}
    if(pathname==='/api/profile'&&req.method==='POST'){const u=requireUser(req);const b=await body(req);return json(res,200,{user:updateNickname(u.id,b.nickname)});}
    if(pathname==='/api/dashboard'&&req.method==='GET'){const u=requireUser(req);return json(res,200,dashboard(u));}
    if(pathname==='/api/health'&&req.method==='GET')return json(res,200,{ok:true,version:'1.1.0-beta.1',activeRooms:rooms.size,time:Date.now()});

    if(pathname==='/api/groups'&&req.method==='POST'){const u=requireUser(req),b=await body(req),name=String(b.name||'').trim().slice(0,64);if(!name)throw Error('Group name is required.');const gid=uid(10),invite=uid(8);run('INSERT INTO groups(id,name,invite_code,owner_user_id,created_at) VALUES(?,?,?,?,?)',gid,name,invite,u.id,now());run('INSERT INTO group_members(group_id,user_id,role,joined_at) VALUES(?,?,?,?)',gid,u.id,'owner',now());return json(res,201,{group:groupPublic(one('SELECT *,? role FROM groups WHERE id=?','owner',gid))});}
    if(pathname==='/api/groups/join'&&req.method==='POST'){const u=requireUser(req),b=await body(req),g=one('SELECT * FROM groups WHERE invite_code=?',String(b.inviteCode||'').trim());if(!g)throw Error('Invalid group invite code.');run(`INSERT INTO group_members(group_id,user_id,role,joined_at) VALUES(?,?,?,?) ON CONFLICT(group_id,user_id) DO NOTHING`,g.id,u.id,'member',now());return json(res,200,{group:groupPublic({...g,role:one('SELECT role FROM group_members WHERE group_id=? AND user_id=?',g.id,u.id).role})});}
    const gm=pathname.match(/^\/api\/groups\/([^/]+)(?:\/(.*))?$/);
    if(gm){const u=requireUser(req),gid=gm[1],action=gm[2]||'';const membership=mustGroupMember(u.id,gid);if(req.method==='GET'&&!action){const details=groupDetails(gid,u.id);if(!details)return json(res,404,{error:'Group not found'});return json(res,200,details);}if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});const b=await body(req);
      if(action==='settlement-paid'){const s=one('SELECT * FROM settlements WHERE id=? AND group_id=?',b.settlementId,gid);if(!s)throw Error('Settlement not found.');if(!['owner','admin'].includes(membership.role)&&u.id!==s.from_user_id&&u.id!==s.to_user_id)throw Object.assign(new Error('Only involved players or group admins can mark this paid.'),{statusCode:403});run('UPDATE settlements SET status=?,settled_at=? WHERE id=?','paid',now(),s.id);return json(res,200,{ok:true});}
      if(action==='preset'){if(!['owner','admin'].includes(membership.role))throw Object.assign(new Error('Only group admins can save presets.'),{statusCode:403});const name=String(b.name||'Preset').trim().slice(0,48),config=sanitizeConfig(b.config||{}),pid=b.id||uid(10);run(`INSERT INTO group_presets(id,group_id,name,config_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,config_json=excluded.config_json,updated_at=excluded.updated_at`,pid,gid,name,JSON.stringify(config),u.id,now(),now());return json(res,200,{ok:true,id:pid});}
      return json(res,404,{error:'Unknown group action'});
    }

    if(pathname==='/api/admin/bugs'&&req.method==='GET'){const u=requireUser(req);mustAdmin(u);return json(res,200,{bugs:dashboard(u).openBugs});}
    const admDebug=pathname.match(/^\/api\/admin\/sessions\/([^/]+)\/debug$/);if(admDebug&&req.method==='GET'){const u=requireUser(req);mustAdmin(u);const ps=one('SELECT id,room_id,room_name,group_id,host_user_id,config_json,started_at,ended_at,is_test,debug_event_count,final_debug_log_json,final_ledger_json FROM poker_sessions WHERE id=?',admDebug[1]);if(!ps)return json(res,404,{error:'Session not found'});const bugs=all('SELECT id,severity,code,title,details_json,status,created_at,resolved_at FROM bug_reports WHERE session_id=? ORDER BY created_at',ps.id).map(b=>({...b,details:b.details_json?JSON.parse(b.details_json):{}}));return json(res,200,{version:'1.1.0-beta.1',sessionId:ps.id,roomId:ps.room_id,roomName:ps.room_name,groupId:ps.group_id,hostUserId:ps.host_user_id,isTest:Boolean(ps.is_test),startedAt:ps.started_at,endedAt:ps.ended_at,config:ps.config_json?JSON.parse(ps.config_json):{},debugEventCount:ps.debug_event_count,debug:ps.final_debug_log_json?JSON.parse(ps.final_debug_log_json):null,ledger:ps.final_ledger_json?JSON.parse(ps.final_ledger_json):[],bugs});}
    const bugm=pathname.match(/^\/api\/admin\/bugs\/([^/]+)\/resolve$/);if(bugm&&req.method==='POST'){const u=requireUser(req);mustAdmin(u);run('UPDATE bug_reports SET status=?,resolved_at=? WHERE id=?','resolved',now(),bugm[1]);return json(res,200,{ok:true});}

    if(req.method==='POST'&&pathname==='/api/rooms'){
      const u=requireUser(req),b=await body(req);const groupId=b.groupId||null;if(groupId)mustGroupMember(u.id,groupId);const roomId=id(6),hostId=id(12),token=id(24);const table=new PokerTable(sanitizeConfig(b.config));table.hostPlayerId=hostId;const sessionId=uid(12);
      const room={id:roomId,sessionId,groupId,table,players:new Map([[token,{id:hostId,name:u.nickname,accountId:u.id,realName:u.realName}]]),chat:[],clients:new Map(),persistedFinal:false};rooms.set(roomId,room);
      run('INSERT INTO poker_sessions(id,room_id,group_id,host_user_id,room_name,config_json,started_at,status) VALUES(?,?,?,?,?,?,?,?)',sessionId,roomId,groupId,u.id,table.config.name,JSON.stringify(table.config),now(),'active');
      table.debug('ROOM_CREATED',{roomId,sessionId,groupId,hostPlayerId:hostId,hostAccountId:u.id,hostName:u.nickname,config:{...table.config}});persistRoom(room);return json(res,201,{roomId,playerId:hostId,token,url:`/g/${roomId}`});
    }
    const m=pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(.*))?$/);
    if(m){const u=requireUser(req),roomId=m[1],action=m[2]||'';const room=roomOr404(res,roomId);if(!room)return;debugRoom=room;
      if(req.method==='GET'&&!action)return json(res,200,{roomId,config:room.table.config,phase:room.table.phase,seated:room.table.seats.filter(Boolean).length,groupId:room.groupId});
      if(req.method==='GET'&&action==='debug'){const token=req.headers['x-player-token']||url.searchParams.get('token');const player=roomAuth(room,token,u);if(player.id!==room.table.hostPlayerId)return json(res,403,{error:'Only the host can view the admin debug log.'});room.table.debug('DEBUG_LOG_VIEWED',{playerId:player.id,player:player.name});return json(res,200,{roomId,...room.table.debugSnapshot()});}
      if(req.method==='GET'&&action==='events'){const token=url.searchParams.get('token');const player=roomAuth(room,token,u);res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'});res.write(': connected\n\n');if(!room.clients.has(token))room.clients.set(token,new Set());room.clients.get(token).add(res);room.table.setConnected(player.id,true);room.table.debug('SSE_CONNECTED',{playerId:player.id,player:player.name,clientCount:room.clients.get(token).size});const initial=room.table.publicState(player.id);initial.chat=room.chat;initial.sessionMeta={sessionId:room.sessionId,groupId:room.groupId||null};sseSend(res,'state',initial);const heartbeat=setInterval(()=>{try{res.write(': ping\n\n')}catch{}},20000);req.on('close',()=>{clearInterval(heartbeat);room.clients.get(token)?.delete(res);room.table.debug('SSE_DISCONNECTED',{playerId:player.id,player:player.name,remainingClients:room.clients.get(token)?.size||0});if(room.clients.get(token)?.size===0){room.clients.delete(token);room.table.setConnected(player.id,false);persistRoom(room);broadcast(room);}});return;}
      if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});const b=await body(req);
      if(action==='join'){
        if(room.groupId)mustGroupMember(u.id,room.groupId);
        let found=[...room.players.entries()].find(([,p])=>p.accountId===u.id);let token=b.token,player=token?room.players.get(token):null;if(player&&player.accountId!==u.id)player=null;
        if(!player&&found){[token,player]=found;}if(!player){token=id(24);player={id:id(12),name:u.nickname,accountId:u.id,realName:u.realName};room.players.set(token,player);}else player.name=u.nickname;const seated=room.table.seats.find(x=>x?.id===player.id);if(seated){seated.name=u.nickname;room.table.ledgerEntry(player.id,u.nickname).name=u.nickname;}
        room.table.setConnected(player.id,true);room.table.debug('PLAYER_JOINED_ROOM',{playerId:player.id,accountId:u.id,player:player.name,reusedToken:Boolean(found||b.token)});persistRoom(room);return json(res,200,{token,playerId:player.id,name:player.name});
      }
      const token=req.headers['x-player-token']||b.token;const player=roomAuth(room,token,u);let shouldFinalize=false;const safePayload={...b};delete safePayload.token;room.table.debug('API_COMMAND',{action,playerId:player.id,accountId:u.id,player:player.name,payload:safePayload});
      if(action==='sit')room.table.seatPlayer(player,Number(b.seatIndex));
      else if(action==='leave-seat'||action==='leave-table')room.table.leave(player.id);
      else if(action==='away')room.table.toggleAway(player.id,Boolean(b.away));
      else if(action==='start-hand')room.table.startHand(player.id);
      else if(action==='action')room.table.act(player.id,b.action,b.amount);
      else if(action==='config')room.table.updateConfig(player.id,b.patch||b);
      else if(action==='stack')room.table.setStack(player.id,b.playerId,b.amount);
      else if(action==='force-bomb')room.table.forceBombPot(player.id);
      else if(action==='add-test-bot')room.table.addTestBot(player.id);
      else if(action==='remove-test-bot')room.table.removeTestBot(player.id,b.botId);
      else if(action==='runout-vote')room.table.voteRunout(player.id,b.runs);
      else if(action==='declare')room.table.declare(player.id,b.choices);
      else if(action==='buyin-request')room.table.requestBuyIn(player.id,b.amount);
      else if(action==='buyin-decision')room.table.decideBuyIn(player.id,b.requestId,Boolean(b.approve));
      else if(action==='pause-game')room.table.pauseGame(player.id);
      else if(action==='resume-game')room.table.resumeGame(player.id);
      else if(action==='end-game'){room.table.endGame(player.id);shouldFinalize=true;}
      else if(action==='report-bug'){if(player.id!==room.table.hostPlayerId)throw Object.assign(new Error('Only the host can flag a debug issue.'),{statusCode:403});const note=String(b.note||'Host flagged an issue').trim().slice(0,500);run('INSERT INTO bug_reports(id,session_id,room_id,severity,code,title,details_json,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)',uid(12),room.sessionId,room.id,'warning','HOST_FLAGGED',note,JSON.stringify({note,debugTail:room.table.debugLog.slice(-120)}),'open',now());room.table.debug('HOST_BUG_FLAGGED',{note});}
      else if(action==='chat'){
        rateLimit(`chat:${u.id}`,30,10_000);
        const text=String(b.text||'').trim().slice(0,1000);let imagePath=null;if(b.imageData)imagePath=await saveChatImage(b.imageData);if(!text&&!imagePath)throw Error('Message is empty.');const msg={id:id(8),at:Date.now(),name:player.name,accountId:u.id,text,image:imagePath||null};room.chat.push(msg);if(room.chat.length>200)room.chat.shift();run('INSERT INTO chat_messages(id,room_id,user_id,nickname,kind,text,image_path,created_at) VALUES(?,?,?,?,?,?,?,?)',msg.id,room.id,u.id,player.name,imagePath?'image':'text',text||null,imagePath,Date.now());
      } else return json(res,404,{error:'Unknown room action'});
      room.table.debug('API_COMMAND_OK',{action,playerId:player.id,player:player.name,phase:room.table.phase,street:room.table.street,pot:room.table.potTotal()});if(shouldFinalize)finalizeSession(room);else if(!room.table.gameEnded)persistRoom(room);broadcast(room);return json(res,200,{ok:true});
    }
    return serveStatic(req,res,pathname);
  }catch(e){try{debugRoom?.table?.debug('API_ERROR',{method:req.method,path:pathname,message:e?.message||String(e),stack:e?.stack||null});if(debugRoom&&!debugRoom.table.gameEnded)persistRoom(debugRoom);}catch{}return error(res,e);}
});

setInterval(()=>{const t=Date.now();for(const room of rooms.values()){if(room.table.gameEnded)continue;let changed=false;try{if(room.table.processTestBots(t))changed=true;if(room.table.timeoutCurrentAction(t))changed=true;if(room.table.advanceAllInReveal(t))changed=true;if(room.table.tryAutoStart(t))changed=true;}catch(e){room.table.debug('SERVER_TIMER_ERROR',{message:e.message,stack:e.stack||null});room.table.addLog(`Server timer warning: ${e.message}`);changed=true;}if(changed){persistRoom(room);broadcast(room);}}},250).unref();
setInterval(()=>run('DELETE FROM auth_sessions WHERE expires_at<?',now()),6*60*60*1000).unref();

const PORT=Number(process.env.PORT||3000);server.listen(PORT,'0.0.0.0',()=>console.log(`Custom Poker Hosted Beta listening on http://localhost:${PORT} · restored ${rooms.size} active room(s)`));
