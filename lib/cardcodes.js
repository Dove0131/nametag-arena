import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CARD_DEFS } from './constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const GLOBAL_FILE = path.join(DATA_DIR, 'global-card-codes.json');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PREFIX = 'NAMETAG-CARD:';
const MAX_GLOBAL = 1000;

/** token -> { token, type, scope, roomCode, used, createdAt, usedAt } */
const globalCodes = new Map();
/** roomCode -> Map(token -> entry) */
const roomCodes = new Map();

function loadGlobal() {
  try {
    const raw = fs.readFileSync(GLOBAL_FILE, 'utf8');
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return;
    for (const x of list) {
      if (!x?.token || !CARD_DEFS[x.type]) continue;
      globalCodes.set(x.token, {
        token: x.token, type: x.type, scope: 'global', roomCode: null,
        used: !!x.used, createdAt: Number(x.createdAt) || Date.now(),
        usedAt: x.usedAt || null,
      });
    }
  } catch { /* first run / unreadable cache */ }
}

function saveGlobal() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const list = [...globalCodes.values()];
    const tmp = GLOBAL_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list));
    fs.renameSync(tmp, GLOBAL_FILE);
  } catch (e) {
    console.error('[cardcodes] 写入失败', e.message);
  }
}

function newToken() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let out = '';
    for (let i = 0; i < 10; i += 1) out += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
    if (!globalCodes.has(out) && ![...roomCodes.values()].some((m) => m.has(out))) return out;
  }
  throw new Error('生成二维码失败，请重试');
}

function normalize(token) {
  return String(token || '').trim().replace(/^NAMETAG-CARD:/i, '').toUpperCase();
}

export function createCardCode(type, scope = 'global', roomCode = null) {
  if (!CARD_DEFS[type]) throw new Error('技能卡类型不存在');
  if (scope === 'room' && !roomCode) throw new Error('缺少房间号');
  if (scope === 'global' && globalCodes.size >= MAX_GLOBAL) {
    // 先清理已使用且超过 7 天的旧码，避免无限增长
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const [k, v] of globalCodes) {
      if (v.used && v.usedAt && v.usedAt < cutoff) globalCodes.delete(k);
    }
    if (globalCodes.size >= MAX_GLOBAL) throw new Error('通用二维码数量已达上限');
  }
  const token = newToken();
  const entry = {
    token, type, scope,
    roomCode: scope === 'room' ? String(roomCode) : null,
    used: false, createdAt: Date.now(), usedAt: null,
  };
  if (scope === 'global') {
    globalCodes.set(token, entry);
    saveGlobal();
  } else {
    const key = String(roomCode);
    if (!roomCodes.has(key)) roomCodes.set(key, new Map());
    roomCodes.get(key).set(token, entry);
  }
  return { ...entry, payload: PREFIX + token };
}

export function redeemCardCode(token, roomCode) {
  const key = normalize(token);
  if (!key) throw new Error('二维码内容无效');
  let entry = globalCodes.get(key);
  if (!entry) {
    const m = roomCodes.get(String(roomCode || ''));
    entry = m?.get(key) || null;
  }
  if (!entry) throw new Error('二维码无效，或不属于当前房间');
  if (entry.used) throw new Error('这张二维码已经被使用过了');
  entry.used = true;
  entry.usedAt = Date.now();
  if (entry.scope === 'global') saveGlobal();
  return { ...entry };
}

export function clearRoomCodes(roomCode) {
  if (roomCode) roomCodes.delete(String(roomCode));
}

export function cardCodeSummary() {
  let used = 0;
  for (const v of globalCodes.values()) if (v.used) used += 1;
  let roomCount = 0;
  for (const m of roomCodes.values()) roomCount += m.size;
  return { global: globalCodes.size, globalUsed: used, room: roomCount };
}

loadGlobal();
