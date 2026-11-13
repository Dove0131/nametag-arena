import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import QRCode from 'qrcode';
import { Server } from 'socket.io';
import { Room, GameError } from './lib/room.js';
import { ROLE_DEFS, CARD_DEFS, EVENT_DEFS, SPECIAL_SKILL_DEFS, LIMITS, DEFAULT_SETTINGS, WIN_LABEL } from './lib/constants.js';
import { createCardCode, redeemCardCode } from './lib/cardcodes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 200000,
  pingInterval: 20000,
  pingTimeout: 30000,
});
const PORT = Number(process.env.PORT || 4173);
const rooms = new Map();

app.set('trust proxy', true);
app.use(compression());
app.use(express.json({ limit: '64kb' }));

/* ---------------- helpers ---------------- */

function makeRoomCode() {
  for (let i = 0; i < 1000; i += 1) {
    const code = String(crypto.randomInt(100000, 1000000));
    if (!rooms.has(code)) return code;
  }
  throw new GameError('暂时没有空余房间，稍后再试');
}

function publicOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`;
  return `${proto}://${host}`;
}

function ok(res, data) { res.json({ ok: true, ...data }); }
function fail(res, status, message) { res.status(status).json({ ok: false, error: message }); }

function cleanName(raw) {
  return String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, LIMITS.nameMax);
}

function roomByCode(code) {
  return rooms.get(String(code || '').trim());
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
}

/* ---------------- REST API ---------------- */

app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) });
});

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    ok: true,
    roles: ROLE_DEFS,
    cards: CARD_DEFS,
    events: EVENT_DEFS,
    specialSkills: SPECIAL_SKILL_DEFS,
    limits: { maxPlayers: LIMITS.maxPlayers, nameMax: LIMITS.nameMax, chatMax: LIMITS.chatMax },
    defaults: DEFAULT_SETTINGS,
    winLabel: WIN_LABEL,
  });
});

app.post('/api/card-qr', async (req, res) => {
  try {
    const body = req.body || {};
    const scope = body.scope === 'room' ? 'room' : 'global';
    const requested = String(body.type || 'random');
    if (requested !== 'random' && !CARD_DEFS[requested]) return fail(res, 400, '技能卡类型不存在');
    const count = Math.max(1, Math.min(30, Math.round(Number(body.count) || 1)));

    let roomCode = null;
    if (scope === 'room') {
      const room = roomByCode(body.code);
      if (!room) return fail(res, 404, '房间不存在或已过期');
      if (room.status !== 'lobby') return fail(res, 400, '只能在游戏开始前生成本房间二维码');
      const p = room.players.get(String(body.playerId || ''));
      if (!p || p.token !== String(body.token || '') || p.role !== 'admin') {
        return fail(res, 403, '只有管理员能生成本房间二维码');
      }
      roomCode = room.code;
    }

    const types = Object.keys(CARD_DEFS);
    const items = [];
    for (let i = 0; i < count; i += 1) {
      const type = requested === 'random' ? types[Math.floor(Math.random() * types.length)] : requested;
      const entry = createCardCode(type, scope, roomCode);
      const qr = await QRCode.toDataURL(entry.payload, {
        width: 720, margin: 2, errorCorrectionLevel: 'M',
        color: { dark: '#0b120b', light: '#ffffff' },
      });
      items.push({
        token: entry.token, type, cardName: CARD_DEFS[type].name,
        scope, payload: entry.payload, roomCode, qr,
      });
    }
    return ok(res, {
      items, count: items.length,
      ...items[0],
      qr: items[0].qr,
    });
  } catch (e) {
    console.error('[card-qr]', e);
    return fail(res, 400, e.message || '生成二维码失败');
  }
});

app.post('/api/rooms', (req, res) => {
  try {
    const name = cleanName(req.body?.name);
    if (!name) return fail(res, 400, '请输入昵称');
    if (rooms.size >= LIMITS.maxRooms) return fail(res, 503, '服务器房间已满，稍后再试');
    const code = makeRoomCode();
    const room = new Room(code, name);
    rooms.set(code, room);
    const p = room.players.get(room.hostId);
    console.log(`[room] create ${code}`);
    return ok(res, {
      code, roomName: room.name,
      playerId: p.id, token: p.token,
      playerName: p.name,
    });
  } catch (e) {
    return fail(res, 400, e.message || '创建房间失败');
  }
});

app.get('/api/rooms/:code', (req, res) => {
  const room = roomByCode(req.params.code);
  if (!room) return fail(res, 404, '房间不存在');
  return ok(res, {
    code: room.code,
    name: room.name,
    status: room.status,
    playerCount: room.players.size,
    onlineCount: [...room.players.values()].filter((p) => p.online).length,
    locked: room.settings.locked,
    durationMin: room.settings.durationMin,
  });
});

app.post('/api/rooms/:code/join', (req, res) => {
  try {
    const room = roomByCode(req.params.code);
    if (!room) return fail(res, 404, '房间不存在，检查一下房间号');
    if (room.status === 'ended') return fail(res, 409, '这场游戏已经结束了');
    if (room.settings.locked) return fail(res, 403, '房间已锁定，暂时不能加入');
    if (room.players.size >= LIMITS.maxPlayers) return fail(res, 409, '房间人数已满');
    const name = cleanName(req.body?.name);
    if (!name) return fail(res, 400, '请输入昵称');
    const p = room.addPlayer(name, 'player');
    if (room.status === 'playing') {
      p.path = [];
      room.pushFeed(`🚪 ${p.name} 加入了战场（中途加入）`, 'info');
      room.notify(p.id, '你中途加入了战场。位置默认隐藏，注意倒计时。', { title: '加入战场', kind: 'info' });
      room.sig({ type: 'state' });
    } else {
      room.pushFeed(`👋 ${p.name} 加入了房间`, 'info');
      room.sig({ type: 'state' });
    }
    flushRoom(room);
    console.log(`[room] ${room.code} join`);
    return ok(res, { code: room.code, playerId: p.id, token: p.token, playerName: p.name });
  } catch (e) {
    return fail(res, 400, e.message || '加入失败');
  }
});

app.get('/api/rooms/:code/qr', async (req, res) => {
  const room = roomByCode(req.params.code);
  if (!room) return fail(res, 404, '房间不存在');
  const url = `${publicOrigin(req)}/?room=${room.code}`;
  try {
    const buf = await QRCode.toBuffer(url, {
      type: 'png', width: 520, margin: 1, errorCorrectionLevel: 'M',
      color: { dark: '#10150f', light: '#ffffff' },
    });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=600');
    res.send(buf);
  } catch (e) {
    return fail(res, 500, '二维码生成失败');
  }
});

app.get('/api/rooms/:code/replay', (req, res) => {
  const room = roomByCode(req.params.code);
  if (!room) return fail(res, 404, '房间不存在，回放数据可能已过期');
  const playerId = String(req.query.playerId || '');
  const token = String(req.query.token || '');
  const p = room.players.get(playerId);
  if (!p || p.token !== token) return fail(res, 403, '没有权限查看这场回放');
  if (room.status !== 'ended') return fail(res, 409, '游戏还没结束');
  const players = [...room.players.values()].map((x) => ({
    id: x.id, name: x.name, role: x.role, colorIndex: x.colorIndex,
    alive: x.alive, path: x.path, stats: x.stats,
    pos: x.pos, killedBy: x.killedBy, bondId: x.bondId, revivedById: x.revivedById,
  }));
  res.set('Cache-Control', 'no-store');
  return ok(res, {
    room: {
      code: room.code, name: room.name,
      startedAt: room.startedAt, endedAt: room.endedAt,
      durationMs: room.endedAt && room.startedAt ? room.endedAt - room.startedAt : 0,
      result: room.result, timeline: room.timeline,
      moments: room.moments, feed: room.feed,
    },
    players,
    chat: room.chat.slice(-200),
  });
});

app.get('/join/:code', (req, res) => {
  res.redirect(302, `/?room=${encodeURIComponent(req.params.code)}`);
});

/* ---------------- static files ---------------- */

app.get('/', (req, res, next) => {
  const inline = path.join(__dirname, 'public/index.inline.html');
  if (fs.existsSync(inline)) {
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(inline);
  }
  next();
});

app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules/leaflet/dist'), { maxAge: '7d' }));
app.use('/vendor/jsqr', express.static(path.join(__dirname, 'node_modules/jsqr/dist'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    if (filePath.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return fail(res, 404, '接口不存在');
  res.status(404).send('404');
});

/* ---------------- socket auth ---------------- */

io.use((socket, next) => {
  const { code, playerId, token } = socket.handshake.auth || {};
  const room = roomByCode(code);
  if (!room) return next(new Error('房间不存在或已过期'));
  const p = room.players.get(String(playerId || ''));
  if (!p || p.token !== String(token || '')) return next(new Error('身份验证失败，请重新加入'));
  socket.data.code = room.code;
  socket.data.playerId = p.id;
  next();
});

function playerSockets(room, playerId) {
  const out = [];
  for (const [sid, pid] of room.conns) {
    if (pid === playerId) {
      const s = io.sockets.sockets.get(sid);
      if (s) out.push(s);
    }
  }
  return out;
}

function broadcastState(room) {
  for (const [sid, pid] of [...room.conns]) {
    const s = io.sockets.sockets.get(sid);
    if (!s) { room.conns.delete(sid); continue; }
    const view = room.viewFor(pid);
    if (view) s.emit('state', view);
  }
}

function broadcastPositions(room) {
  for (const [sid, pid] of [...room.conns]) {
    const s = io.sockets.sockets.get(sid);
    if (!s) { room.conns.delete(sid); continue; }
    const payload = room.positionsFor(pid);
    if (payload) s.emit('positions', payload);
  }
  room.posDirty = false;
  room.lastPosBroadcast = Date.now();
}

function flushRoom(room) {
  if (!room) return;
  const signals = room.signals.splice(0);
  let needState = false;
  let needPositions = false;
  for (const sig of signals) {
    if (!sig) continue;
    if (sig.type === 'state') needState = true;
    else if (sig.type === 'positions') needPositions = true;
    else if (sig.type === 'feed') io.to(room.code).emit('feed', sig.item);
    else if (sig.type === 'chat') io.to(room.code).emit('chat', sig.item);
    else if (sig.type === 'notify') {
      const payload = { text: sig.text, title: sig.title, kind: sig.kind, sound: sig.sound, at: Date.now() };
      if (!sig.playerId) io.to(room.code).emit('notify', payload);
      else playerSockets(room, sig.playerId).forEach((s) => s.emit('notify', payload));
    } else if (sig.type === 'ended') {
      io.to(room.code).emit('game_ended', room.result);
    } else if (sig.type === 'kicked') {
      const sockets = playerSockets(room, sig.playerId);
      sockets.forEach((s) => {
        s.emit('kicked', { message: '你被管理员移出了房间' });
        room.conns.delete(s.id);
        s.disconnect(true);
      });
    } else if (sig.type === 'dissolve') {
      io.to(room.code).emit('room_dissolved', { message: '房主解散了房间' });
      const sockets = [...room.conns.keys()];
      room.conns.clear();
      sockets.forEach((sid) => io.sockets.sockets.get(sid)?.disconnect(true));
      setTimeout(() => rooms.delete(room.code), 1500);
    }
  }
  if (needState) broadcastState(room);
  if (needPositions) broadcastPositions(room);
}

/* ---------------- socket events ---------------- */

const rate = new Map();
function allowRate(key, ms) {
  const t = Date.now();
  const last = rate.get(key) || 0;
  if (t - last < ms) return false;
  rate.set(key, t);
  return true;
}

io.on('connection', (socket) => {
  const room = rooms.get(socket.data.code);
  const playerId = socket.data.playerId;
  if (!room || !room.players.has(playerId)) { socket.disconnect(true); return; }
  socket.join(room.code);
  room.conns.set(socket.id, playerId);
  room.setOnline(playerId, true);
  const p = room.players.get(playerId);
  p.lastSeen = Date.now();

  socket.emit('state', room.viewFor(playerId));
  socket.emit('positions', room.positionsFor(playerId));
  broadcastState(room);

  const action = (name, ms, handler) => {
    socket.on(name, (payload = {}, ack) => {
      try {
        if (!allowRate(`${socket.id}:${name}`, ms)) throw new GameError('操作太快了，慢一点');
        const res = handler(payload || {});
        if (typeof ack === 'function') ack({ ok: true, ...(res || {}) });
        if (res && res.message) socket.emit('action_result', { ok: true, message: res.message, ...(res.data || {}) });
        flushRoom(room);
      } catch (e) {
        const message = e instanceof GameError ? e.message : (console.error(e), '操作失败，请重试');
        if (typeof ack === 'function') ack({ ok: false, message });
        socket.emit('action_result', { ok: false, message });
        socket.emit('game_error', { message });
      }
    });
  };

  socket.on('position', (payload = {}) => {
    if (!allowRate(`${socket.id}:position`, 700)) return;
    const ok = room.recordPosition(playerId, payload.lat, payload.lng, payload.acc);
    if (ok) p.lastSeen = Date.now();
  });

  action('chat', 900, ({ text }) => {
    room.addChat(playerId, text);
  });

  action('rip', 1400, ({ targetId }) => room.rip(playerId, targetId));
  action('useCard', 900, ({ cardId, targetId }) => room.useCard(playerId, cardId, targetId));
  action('confirmCode', 900, ({ code }) => {
    const res = room.confirmCode(playerId, code);
    return { message: res.forName ? `见证成功，已为 ${res.forName} 确认` : '见证成功', data: res };
  });
  action('special', 900, ({ targetId }) => room.useSpecial(playerId, targetId || null));
  action('redeemCard', 500, ({ token }) => {
    room.assertCanReceiveCard(playerId);
    const entry = redeemCardCode(token, room.code);
    room.addCardTo(playerId, entry.type, 'qr');
    return { message: `核销成功：${CARD_DEFS[entry.type].name}`, data: { type: entry.type } };
  });
  action('moment', 1500, ({ note }) => {
    room.moment(playerId, note);
    return { message: '精彩瞬间已记录' };
  });

  /* admin */
  action('admin:setRole', 250, ({ targetId, role }) => { room.setRole(playerId, targetId, role); return { message: '身份已更新' }; });
  action('admin:settings', 250, ({ patch }) => { room.updateSettings(playerId, patch || {}); return { message: '设置已保存' }; });
  action('player:ready', 250, ({ ready }) => { room.setReady(playerId, ready !== false); return { message: ready === false ? '已取消准备' : '已准备就绪' }; });
  action('admin:start', 600, ({ force }) => {
    const r = room.start(playerId, { force: !!force });
    return { message: r?.message || '游戏开始' };
  });
  action('admin:skipPrep', 400, () => room.skipPrep(playerId));
  action('admin:end', 400, ({ winner, playerId: winId, reason }) => {
    room.finishByAdmin(playerId, { winner, playerId: winId, reason });
    return { message: '游戏已结束' };
  });
  action('admin:expose', 200, ({ targetId, minutes }) => { room.setExposure(playerId, targetId, minutes); return { message: '位置状态已更新' }; });
  action('admin:reveal', 200, ({ value }) => { room.setReveal(playerId, value); return { message: value ? '全员显形已开启' : '强制显形已关闭' }; });
  action('admin:giveCard', 200, ({ targetId, type }) => { room.giveCard(playerId, targetId, type); return { message: `已发放${CARD_DEFS[type]?.name || '技能卡'}` }; });
  action('admin:assignEvent', 300, ({ targetId, type }) => {
    const ev = room.assignEvent(playerId, targetId, type || null);
    return { message: `已指派事件：${EVENT_DEFS[ev.type]?.name || ''}` };
  });
  action('admin:eventResult', 200, ({ eventId, success }) => { room.completeEventByAdmin(playerId, eventId, success !== false); return { message: '事件状态已更新' }; });
  action('admin:kick', 400, ({ targetId }) => { room.kick(playerId, targetId); return { message: '已移出房间' }; });
  action('admin:extendTime', 250, ({ minutes }) => { room.extendTime(playerId, minutes); return { message: '倒计时已调整' }; });
  action('admin:announce', 500, ({ text }) => {
    const t = String(text || '').trim().slice(0, 120);
    if (!t) throw new GameError('公告不能为空');
    room.pushFeed(`📢 管理员公告：${t}`, 'announce');
    room.announce(t);
    return { message: '公告已发送' };
  });
  action('admin:customTask', 300, ({ targetId, title, desc, minutes, needWitness }) => {
    const res = room.assignCustom(playerId, targetId || 'all', { title, desc, minutes, needWitness: !!needWitness });
    return { message: `自定义任务已发给 ${res.count} 人` };
  });
  action('admin:setAlive', 300, ({ targetId, alive }) => {
    room.setAliveByAdmin(playerId, targetId, !!alive);
    return { message: alive ? '已复活' : '已淘汰' };
  });
  action('admin:reset', 600, () => { room.resetToLobby(playerId); return { message: '已回到大厅' }; });
  action('admin:dissolve', 600, () => { room.dissolve(playerId); return { message: '房间已解散' }; });

  socket.on('disconnect', () => {
    room.conns.delete(socket.id);
    const stillOnline = [...room.conns.values()].includes(playerId);
    if (!stillOnline) room.setOnline(playerId, false);
    flushRoom(room);
  });
});

/* ---------------- tick & cleanup ---------------- */

setInterval(() => {
  const t = Date.now();
  for (const room of rooms.values()) {
    if (room.status === 'playing' || room.status === 'preparing') {
      try { room.tick(t); } catch (e) { console.error('[tick]', room.code, e); }
      flushRoom(room);
      if (['playing', 'preparing'].includes(room.status) && room.posDirty && t - room.lastPosBroadcast > 2500) {
        broadcastPositions(room);
      }
    }
  }
}, 1000);

setInterval(() => {
  const t = Date.now();
  for (const [code, room] of rooms) {
    if (!room.conns.size) {
      if (room.status === 'playing' && t - room.startedAt > 4 * 60 * 60 * 1000) { rooms.delete(code); continue; }
      if (room.status !== 'playing' && t - room.createdAt > LIMITS.roomTtlMs) { rooms.delete(code); continue; }
    }
    if (room.status === 'ended' && t - (room.endedAt || room.createdAt) > LIMITS.endedRoomTtlMs) rooms.delete(code);
  }
  for (const [k, v] of rate) {
    if (t - v > 10 * 60 * 1000) rate.delete(k);
  }
}, 5 * 60 * 1000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`猎名场 server listening on http://0.0.0.0:${PORT}`);
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
