import { scryptSync, timingSafeEqual, randomBytes } from 'node:crypto';
import { one, run, uid, now, userPublic } from './db.js';

const COOKIE='cp_session';
const MAX_AGE=60*60*24*30;
const norm=s=>String(s||'').trim().replace(/\s+/g,' ');
const key=s=>norm(s).toLocaleLowerCase('en-US');

export function hashPassword(password,salt=randomBytes(16).toString('hex')){
  const hash=scryptSync(String(password),salt,64).toString('hex');
  return {salt,hash};
}
export function verifyPassword(password,row){
  const got=scryptSync(String(password),row.password_salt,64);
  const expected=Buffer.from(row.password_hash,'hex');
  return got.length===expected.length && timingSafeEqual(got,expected);
}
export function parseCookies(req){
  const out={};for(const part of String(req.headers.cookie||'').split(';')){const i=part.indexOf('=');if(i>0)out[decodeURIComponent(part.slice(0,i).trim())]=decodeURIComponent(part.slice(i+1).trim());}return out;
}
export function setSessionCookie(res,token){res.setHeader('set-cookie',`${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${process.env.NODE_ENV==='production'?'; Secure':''}`);}
export function clearSessionCookie(res){res.setHeader('set-cookie',`${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV==='production'?'; Secure':''}`);}
export function createSession(userId,res){const token=uid(32);run('INSERT INTO auth_sessions(token,user_id,expires_at,created_at) VALUES(?,?,?,?)',token,userId,now()+MAX_AGE*1000,now());setSessionCookie(res,token);return token;}
export function currentUser(req){const token=parseCookies(req)[COOKIE];if(!token)return null;const row=one(`SELECT u.* FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?`,token,now());return row?userPublic(row):null;}
export function requireUser(req){const u=currentUser(req);if(!u)throw Object.assign(new Error('Please sign in first.'),{statusCode:401});return u;}
export function register({realName,nickname,password}){
  realName=norm(realName);nickname=norm(nickname)||realName;
  if(realName.length<2||realName.length>80)throw new Error('Real name must be 2–80 characters.');
  if(nickname.length<1||nickname.length>24)throw new Error('Nickname must be 1–24 characters.');
  if(String(password||'').length<8)throw new Error('Password must be at least 8 characters.');
  if(one('SELECT 1 FROM users WHERE real_name_key=?',key(realName)))throw new Error('An account with that real name already exists.');
  const {salt,hash}=hashPassword(password);const id=uid(12);const count=one('SELECT COUNT(*) n FROM users').n;const admin=count===0?1:0;
  run('INSERT INTO users(id,real_name,real_name_key,nickname,password_hash,password_salt,is_site_admin,created_at) VALUES(?,?,?,?,?,?,?,?)',id,realName,key(realName),nickname,hash,salt,admin,now());
  return userPublic(one('SELECT * FROM users WHERE id=?',id));
}
export function login({realName,password}){const row=one('SELECT * FROM users WHERE real_name_key=?',key(realName));if(!row||!verifyPassword(password,row))throw new Error('Incorrect real name or password.');return userPublic(row);}
export function updateNickname(userId,nickname){nickname=norm(nickname);if(!nickname||nickname.length>24)throw new Error('Nickname must be 1–24 characters.');run('UPDATE users SET nickname=? WHERE id=?',nickname,userId);return userPublic(one('SELECT * FROM users WHERE id=?',userId));}
export function logout(req,res){const token=parseCookies(req)[COOKIE];if(token)run('DELETE FROM auth_sessions WHERE token=?',token);clearSessionCookie(res);}
