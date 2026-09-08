import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const dataDir = process.env.DATA_DIR || path.resolve('data');
mkdirSync(dataDir,{recursive:true});
export const db = new DatabaseSync(process.env.DATABASE_PATH || path.join(dataDir,'custom-poker.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  real_name TEXT NOT NULL,
  real_name_key TEXT NOT NULL UNIQUE,
  nickname TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  is_site_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(group_id,user_id)
);
CREATE TABLE IF NOT EXISTS group_presets (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS poker_sessions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL UNIQUE,
  group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
  host_user_id TEXT NOT NULL REFERENCES users(id),
  room_name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  final_ledger_json TEXT,
  final_debug_log_json TEXT,
  debug_event_count INTEGER NOT NULL DEFAULT 0,
  finalized_at INTEGER,
  is_test INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS session_players (
  session_id TEXT NOT NULL REFERENCES poker_sessions(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  player_id TEXT NOT NULL,
  real_name TEXT,
  nickname TEXT NOT NULL,
  total_buy_in REAL NOT NULL DEFAULT 0,
  total_cash_out REAL NOT NULL DEFAULT 0,
  net REAL NOT NULL DEFAULT 0,
  status TEXT,
  PRIMARY KEY(session_id,player_id)
);
CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES poker_sessions(id) ON DELETE CASCADE,
  from_user_id TEXT NOT NULL REFERENCES users(id),
  to_user_id TEXT NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  nickname TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  text TEXT,
  image_path TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS active_rooms (
  room_id TEXT PRIMARY KEY,
  snapshot_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bug_reports (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES poker_sessions(id) ON DELETE CASCADE,
  room_id TEXT,
  severity TEXT NOT NULL,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  details_json TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_group ON poker_sessions(group_id,started_at DESC);
CREATE INDEX IF NOT EXISTS idx_settlements_group ON settlements(group_id,status);
CREATE INDEX IF NOT EXISTS idx_bug_status ON bug_reports(status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_room ON chat_messages(room_id,created_at);
`;
db.exec(schema);

export const uid=(bytes=12)=>randomBytes(bytes).toString('base64url');
export const now=()=>Date.now();
export const cents=n=>Math.round((Number(n)||0)*100)/100;
export const one=(sql,...args)=>db.prepare(sql).get(...args);
export const all=(sql,...args)=>db.prepare(sql).all(...args);
export const run=(sql,...args)=>db.prepare(sql).run(...args);

export function userPublic(row){if(!row)return null;return {id:row.id,realName:row.real_name,nickname:row.nickname,isSiteAdmin:Boolean(row.is_site_admin),createdAt:row.created_at};}
export function groupPublic(row){if(!row)return null;return {id:row.id,name:row.name,inviteCode:row.invite_code,ownerUserId:row.owner_user_id,createdAt:row.created_at,role:row.role||null};}
