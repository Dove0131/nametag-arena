import crypto from 'node:crypto';
import {
  ROLE_DEFS, CARD_DEFS, CARD_WEIGHTS, EVENT_DEFS, SPECIAL_SKILL_DEFS,
  PLAYER_COLORS, LIMITS, DEFAULT_SETTINGS,
} from './constants.js';
import { clearRoomCodes } from './cardcodes.js';

const nowMs = () => Date.now();
const uid = (prefix = '') => prefix + crypto.randomBytes(8).toString('hex');
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export function distanceMeters(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export class GameError extends Error {}

export class Room {
  constructor(code, hostName) {
    this.code = code;
    this.name = '撕名牌战场';
    this.createdAt = nowMs();
    this.status = 'lobby';
    this.players = new Map();
    this.chat = [];
    this.feed = [];
    this.timeline = [];
    this.moments = [];
    this.accusations = [];
    this.settings = { ...DEFAULT_SETTINGS };
    this.conns = new Map();
    this.signals = [];
    this.hostId = null;
    this.startedAt = null;
    this.endsAt = null;
    this.endedAt = null;
    this.prepStartedAt = null;
    this.prepEndsAt = null;
    this.prepAccelerated = false;
    this.result = null;
    this.globalReveal = false;
    this.forcedReveal = false;
    this.spyId = null;
    this.nextEventAt = null;
    this.alertMarks = new Set();
    this.posDirty = false;
    this.lastPosBroadcast = 0;
    this._usedCodes = new Set();
    this._nextColor = 0;
    this._lastSpyPush = 0;
    const host = this.addPlayer(hostName, 'admin');
    this.hostId = host.id;
  }

  /* ---------- basic helpers ---------- */

  sig(signal) { this.signals.push(signal); }

  pushFeed(text, kind = 'system', extra = {}) {
    const item = { id: uid('f'), at: nowMs(), text, kind, ...extra };
    this.feed.push(item);
    if (this.feed.length > LIMITS.feedHistory) this.feed.splice(0, this.feed.length - LIMITS.feedHistory);
    this.sig({ type: 'feed', item });
    return item;
  }

  notify(playerId, text, opts = {}) {
    this.sig({
      type: 'notify', playerId, text,
      title: opts.title || null,
      kind: opts.kind || 'info',
      sound: opts.sound || null,
    });
  }

  announce(text) {
    this.sig({ type: 'notify', playerId: null, text, title: '管理员公告', kind: 'announce', sound: 'announce' });
  }

  addTimeline(type, text, extra = {}) {
    const t = this.startedAt ? Math.max(0, nowMs() - this.startedAt) : 0;
    const item = { id: uid('t'), t, type, text, ...extra };
    this.timeline.push(item);
    return item;
  }

  addPlayer(name, role = 'player') {
    name = String(name || '').trim().slice(0, LIMITS.nameMax);
    if (!name) throw new GameError('请输入昵称');
    if (this.players.size >= LIMITS.maxPlayers) throw new GameError('房间人数已满');
    for (const p of this.players.values()) {
      if (p.name.toLowerCase() === name.toLowerCase()) throw new GameError('这个昵称已经被用了，换一个吧');
    }
    const p = {
      id: uid('p_'),
      token: crypto.randomBytes(24).toString('base64url'),
      name,
      role,
      specialSkill: null,
      ready: false,
      alive: true,
      online: false,
      joinedAt: nowMs(),
      lastSeen: nowMs(),
      pos: null,
      path: [],
      exposedUntil: 0,
      exposureReason: '',
      cards: [],
      events: [],
      effects: { ghostUntil: 0, eyeUntil: 0, trackTargetId: null, trackUntil: 0, goldenUntil: 0, freezeUntil: 0 },
      bondId: null,
      revivedById: null,
      revivedPlayerId: null,
      spyTasks: [],
      accusationUsed: false,
      diedAt: null,
      killedBy: null,
      deathNote: '',
      stats: { rips: 0, distance: 0, eventsDone: 0, cardsUsed: 0, skillsUsed: 0 },
      colorIndex: this._nextColor++ % PLAYER_COLORS.length,
    };
    this.players.set(p.id, p);
    return p;
  }

  setOnline(playerId, online) {
    const p = this.players.get(playerId);
    if (!p) return;
    const was = p.online;
    p.online = !!online;
    p.lastSeen = nowMs();
    if (was !== p.online) this.sig({ type: 'state' });
  }

  isAdmin(playerId) {
    return this.players.get(playerId)?.role === 'admin';
  }

  _requireAdmin(playerId) {
    if (!this.isAdmin(playerId)) throw new GameError('只有管理员能做这件事');
    return this.players.get(playerId);
  }

  _requirePlaying() {
    if (this.status !== 'playing') throw new GameError('游戏不在进行中');
  }

  _readyInfo() {
    const list = [...this.players.values()].filter((p) => p.role !== 'admin');
    const ready = list.filter((p) => p.ready);
    return {
      total: list.length,
      ready: ready.length,
      all: list.length > 0 && ready.length === list.length,
      unready: list.filter((p) => !p.ready).map((p) => p.name),
    };
  }

  _allReady() {
    return this._readyInfo().all;
  }

  setReady(playerId, ready = true) {
    if (!['lobby', 'preparing'].includes(this.status)) throw new GameError('现在不能准备');
    const p = this._get(playerId);
    if (p.role === 'admin') throw new GameError('管理员直接开始游戏或跳过准备即可');
    if (this.status === 'preparing' && this.prepAccelerated && !ready) {
      throw new GameError('全员已就绪，倒计时已经开始了');
    }
    p.ready = !!ready;
    const info = this._readyInfo();
    if (this.status === 'preparing' && info.all && !this.prepAccelerated) {
      const t = nowMs();
      this.prepAccelerated = true;
      this.prepEndsAt = Math.min(this.prepEndsAt || Infinity, t + 10000);
      this.pushFeed('⏱️ 全员准备就绪，10 秒后自动开始', 'info');
      this.notify(null, '全员准备就绪，10 秒后自动开始游戏！', {
        title: '⏱️ 10 秒后开始', kind: 'prep', sound: 'good',
      });
      this.addTimeline('ready', '全员准备就绪，10 秒后开始');
    } else if (this.status === 'lobby' && info.all) {
      this.pushFeed('✅ 所有玩家已准备，管理员可以开始游戏', 'good');
      if (this.hostId) {
        this.notify(this.hostId, '所有玩家已准备，可以开始游戏了', {
          title: '✅ 全员就绪', kind: 'good', sound: 'good',
        });
      }
    }
    this.sig({ type: 'state' });
    return info;
  }

  _get(playerId) {
    const p = this.players.get(playerId);
    if (!p) throw new GameError('玩家不存在');
    return p;
  }

  _pickCardType() {
    const entries = Object.entries(CARD_WEIGHTS);
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * total;
    for (const [k, w] of entries) { r -= w; if (r <= 0) return k; }
    return 'shield';
  }

  _newCode() {
    for (let i = 0; i < 500; i += 1) {
      const c = String(randInt(1000, 9999));
      if (!this._usedCodes.has(c)) { this._usedCodes.add(c); return c; }
    }
    return String(randInt(100000, 999999)).slice(-4);
  }

  _visiblePositionsHint(a, b) {
    if (!a || !b || !a.pos || !b.pos) return null;
    if (nowMs() - a.pos.ts > 120000 || nowMs() - b.pos.ts > 120000) return null;
    return Math.round(distanceMeters(a.pos, b.pos));
  }

  /* ---------- views ---------- */

  _canSee(viewer, target, revealAll) {
    if (!target) return false;
    if (viewer.id === target.id) return true;
    const t = nowMs();
    if (!target.alive && viewer.role !== 'admin' && viewer.role !== 'photographer') return false;
    if (viewer.role === 'admin' || viewer.role === 'photographer') return true;
    if (revealAll) return true;
    if (target.exposedUntil > t) return true;
    if (target.effects.ghostUntil > t) return false;
    if (viewer.effects.eyeUntil > t) return true;
    if (viewer.effects.trackTargetId === target.id && viewer.effects.trackUntil > t) return true;
    if (viewer.bondId && viewer.bondId === target.id) return true;
    return false;
  }

  _eventView(e, viewerIsAdmin = false) {
    const def = EVENT_DEFS[e.type] || {};
    const isCustom = e.type === 'custom';
    const hasWitness = isCustom ? !!e.witness : !!def.witness;
    const assignee = this.players.get(e.assigneeId);
    const target = e.targetId ? this.players.get(e.targetId) : null;
    const defDesc = String(def.desc || '').replaceAll('{target}', target ? target.name : '目标');
    const desc = isCustom ? String(e.customDesc || '') : defDesc;
    const title = isCustom ? (e.customTitle || '自定义任务') : (def.name || e.type);
    const icon = isCustom ? '📝' : (def.icon || '🎲');
    const short = isCustom ? title : String(def.short || def.name || '').replaceAll('{target}', target ? target.name : '目标');
    const remaining = e.deadline ? Math.max(0, e.deadline - nowMs()) : 0;
    return {
      id: e.id, type: e.type, title, icon,
      desc, short,
      status: e.status, createdAt: e.createdAt, deadline: e.deadline || 0, remainingMs: remaining,
      code: (hasWitness && (viewerIsAdmin || e.assigneeId)) ? e.code : null,
      witness: hasWitness, auto: isCustom ? null : (def.auto || null),
      custom: isCustom, reward: !isCustom,
      targetId: e.targetId || null, targetName: target ? target.name : null,
      assigneeId: e.assigneeId, assigneeName: assignee ? assignee.name : '',
      distance: target && assignee ? this._visiblePositionsHint(assignee, target) : null,
      progress: e.progress || 0,
    };
  }

  _specialSkillView(p) {
    const skill = p.specialSkill;
    if (!skill) return null;
    const def = SPECIAL_SKILL_DEFS[skill.type] || {};
    const t = nowMs();
    const cooldownMs = def.cooldownMs || 3 * 60 * 1000;
    const cooldownRemainingMs = Math.max(0, (skill.cooldownUntil || 0) - t);
    return {
      type: skill.type, name: def.name || skill.type, icon: def.icon || '✨',
      desc: def.desc || '', target: def.target || 'self',
      cooldownMs, cooldownUntil: skill.cooldownUntil || 0,
      cooldownRemainingMs, ready: cooldownRemainingMs <= 0,
      usedAt: skill.usedAt || null, usesUsed: skill.usesUsed || 0,
    };
  }

  _assignSpecialRoles(fighters) {
    const count = Math.max(0, Math.min(6, Math.round(Number(this.settings.specialCount) || 0)));
    const candidates = fighters.filter((p) => p.role !== 'admin' && p.role !== 'photographer');
    const shuffled = [...candidates].sort(() => Math.random() - 0.5);
    const chosen = shuffled.slice(0, Math.min(count, shuffled.length));
    const skills = Object.keys(SPECIAL_SKILL_DEFS).sort(() => Math.random() - 0.5);
    chosen.forEach((p, i) => {
      p.role = 'special';
      p.specialSkill = { type: skills[i % skills.length], cooldownUntil: 0, usedAt: null, usesUsed: 0 };
    });
    return chosen;
  }

  _taskView(t, spy) {
    const def = SPY_TASK_DEFS[t.type] || {};
    const target = t.targetId ? this.players.get(t.targetId) : null;
    const desc = String(def.desc || '')
      .replaceAll('{target}', target ? target.name : '目标')
      .replaceAll('{need}', String(t.need || def.need || 1));
    return {
      id: t.id, type: t.type, title: def.name || t.type, icon: def.icon || '🕵️',
      desc, status: t.status, progress: Math.round(t.progress || 0), need: t.need,
      targetId: t.targetId || null, targetName: target ? target.name : null,
      distance: target && spy ? this._visiblePositionsHint(spy, target) : null,
      code: t.kind === 'witness' ? t.code : null,
      kind: t.kind || def.kind || '',
      startedAt: t.startedAt || null,
      confirmedCount: (t.confirmedByIds || []).length,
    };
  }

  viewFor(viewerId) {
    const viewer = this.players.get(viewerId);
    if (!viewer) return null;
    const isAdmin = viewer.role === 'admin';
    const revealAll = this.globalReveal || this.forcedReveal || this.status === 'preparing';
    const rolesVisible = isAdmin || this.status === 'playing' || this.status === 'ended';
    const t = nowMs();
    const remainingMs = this.status === 'playing' ? Math.max(0, this.endsAt - t) : 0;
    const prepRemainingMs = this.status === 'preparing' ? Math.max(0, this.prepEndsAt - t) : 0;
    const readyInfo = this._readyInfo();

    const players = [...this.players.values()].map((p) => {
      const canSee = this._canSee(viewer, p, revealAll);
      const o = {
        id: p.id, name: p.name, alive: p.alive, online: p.online,
        colorIndex: p.colorIndex, isMe: p.id === viewer.id,
        ready: !!p.ready,
        visible: canSee,
        bondId: p.bondId || null,
        exposedUntil: p.exposedUntil || 0,
        exposureActive: p.exposedUntil > t,
        ghostActive: p.effects.ghostUntil > t,
        eyeActive: p.effects.eyeUntil > t,
        goldenActive: p.effects.goldenUntil > t,
        frozenActive: p.effects.freezeUntil > t,
        special: rolesVisible && p.role === 'special',
        isSpy: false,
      };
      if (rolesVisible) {
        o.role = p.role;
        o.isSpy = false;
      }
      if (canSee && p.pos) {
        o.lat = p.pos.lat; o.lng = p.pos.lng; o.acc = p.pos.acc; o.ts = p.pos.ts;
      }
      if (isAdmin) {
        o.cards = p.cards.map((c) => ({ id: c.id, type: c.type, used: !!c.usedAt }));
        o.events = p.events.map((e) => this._eventView(e, true));
        o.stats = p.stats;
        o.accusationUsed = p.accusationUsed;
        if (p.role === 'special' && (isAdmin || p.id === viewer.id)) o.specialSkill = this._specialSkillView(p);
      }
      if (p.id === viewer.id) {
        o.cards = p.cards.filter((c) => !c.usedAt).map((c) => ({ id: c.id, type: c.type }));
      }
      return o;
    });

    const me = players.find((p) => p.isMe);

    return {
      serverNow: t,
      code: this.code,
      name: this.name,
      status: this.status,
      settings: this.settings,
      startedAt: this.startedAt,
      endsAt: this.endsAt,
      endedAt: this.endedAt,
      remainingMs,
      prepRemainingMs,
      prepStartedAt: this.prepStartedAt,
      prepEndsAt: this.prepEndsAt,
      prepMs: this.settings.prepMin * 60000,
      prepAccelerated: this.prepAccelerated,
      readyCount: readyInfo.ready,
      readyTotal: readyInfo.total,
      allReady: readyInfo.all,
      unreadyNames: readyInfo.unready,
      identityHidden: this.status === 'preparing' && !isAdmin,
      durationMs: this.settings.durationMin * 60000,
      lowTime: remainingMs > 0 && remainingMs <= 15 * 60000,
      globalReveal: this.globalReveal,
      forcedReveal: this.forcedReveal,
      revealAll,
      players,
      me: {
        ...me,
        role: viewer.role,
        cards: viewer.cards.filter((c) => !c.usedAt).map((c) => ({ id: c.id, type: c.type, givenAt: c.givenAt })),
        effects: {
          ghostUntil: viewer.effects.ghostUntil,
          eyeUntil: viewer.effects.eyeUntil,
          trackTargetId: viewer.effects.trackTargetId,
          trackUntil: viewer.effects.trackUntil,
          goldenUntil: viewer.effects.goldenUntil,
          freezeUntil: viewer.effects.freezeUntil,
        },
        bondName: viewer.bondId ? (this.players.get(viewer.bondId)?.name || null) : null,
        revivedByName: viewer.revivedById ? (this.players.get(viewer.revivedById)?.name || null) : null,
        revivedPlayerName: viewer.revivedPlayerId ? (this.players.get(viewer.revivedPlayerId)?.name || null) : null,
        ready: !!viewer.ready,
        specialSkill: rolesVisible && viewer.role === 'special' ? this._specialSkillView(viewer) : null,
        stats: viewer.stats,
        pos: viewer.pos,
        events: viewer.events.map((e) => this._eventView(e, false)),
        isAdmin,
      },
      chat: this.chat.slice(-80),
      feed: this.feed.slice(-60),
      moments: this.moments.slice(-20),
      accusations: this.accusations
        .filter((a) => isAdmin || a.byId === viewer.id || a.targetId === viewer.id)
        .map((a) => ({
          ...a,
          byName: this.players.get(a.byId)?.name || '?',
          targetName: this.players.get(a.targetId)?.name || '?',
        })),
      admin: isAdmin ? {
        spyId: this.spyId,
        spyName: this.spyId ? (this.players.get(this.spyId)?.name || null) : null,
        events: [...this.players.values()].flatMap((p) => p.events.map((e) => this._eventView(e, true))),
        specials: [...this.players.values()].filter((p) => p.role === 'special').map((p) => ({ id: p.id, name: p.name, skill: this._specialSkillView(p) })),
        pendingAccusations: this.accusations.filter((a) => a.status === 'pending').length,
        activeEvents: [...this.players.values()].reduce((n, p) => n + p.events.filter((e) => e.status === 'pending' || e.status === 'active').length, 0),
      } : null,
      result: this.status === 'ended' ? this.result : null,
    };
  }

  positionsFor(viewerId) {
    const viewer = this.players.get(viewerId);
    if (!viewer) return null;
    const revealAll = this.globalReveal || this.forcedReveal || this.status === 'preparing';
    const t = nowMs();
    return {
      t,
      revealAll,
      players: [...this.players.values()]
        .filter((p) => this._canSee(viewer, p, revealAll) && p.pos)
        .map((p) => ({
          id: p.id,
          lat: p.pos.lat, lng: p.pos.lng, acc: p.pos.acc, ts: p.pos.ts,
          alive: p.alive,
          exposed: p.exposedUntil > t,
        })),
    };
  }

  /* ---------- chat ---------- */

  addChat(playerId, text) {
    const p = this._get(playerId);
    text = String(text || '').trim();
    if (!text) throw new GameError('消息不能为空');
    if (text.length > LIMITS.chatMax) text = text.slice(0, LIMITS.chatMax);
    const msg = { id: uid('c'), at: nowMs(), fromId: p.id, name: p.name, text, alive: p.alive };
    this.chat.push(msg);
    if (this.chat.length > LIMITS.chatHistory) this.chat.splice(0, this.chat.length - LIMITS.chatHistory);
    this.sig({ type: 'chat', item: msg });
    return msg;
  }

  /* ---------- lobby ---------- */

  setRole(adminId, targetId, role) {
    this._requireAdmin(adminId);
    if (this.status !== 'lobby') throw new GameError('游戏开始后不能改身份');
    if (!ROLE_DEFS[role]) throw new GameError('身份不存在');
    const target = this._get(targetId);
    if (role === 'special') throw new GameError('特殊人物由房间设置的数量自动分配，不能单独指定');
    if (target.role === 'admin' && role !== 'admin') {
      const admins = [...this.players.values()].filter((p) => p.role === 'admin' && p.id !== target.id);
      if (admins.length === 0) throw new GameError('房间里至少要保留一名管理员');
    }
    target.role = role;
    if (role === 'admin' && this.status === 'lobby') this.hostId = target.id;
    this.pushFeed(`管理员调整了 ${target.name} 的身份`);
    this.sig({ type: 'state' });
  }

  updateSettings(adminId, patch = {}) {
    this._requireAdmin(adminId);
    const s = this.settings;
    if (patch.durationMin !== undefined && this.status === 'lobby') {
      s.durationMin = clamp(Math.round(Number(patch.durationMin) || 45), 5, 180);
    }
    if (patch.prepMin !== undefined && this.status === 'lobby') {
      s.prepMin = clamp(Math.round(Number(patch.prepMin) || 0), 0, 30);
    }
    if (patch.autoEvents !== undefined) s.autoEvents = !!patch.autoEvents;
    if (patch.eventMinMin !== undefined) s.eventMinMin = clamp(Math.round(Number(patch.eventMinMin) || 6), 2, 60);
    if (patch.eventMaxMin !== undefined) s.eventMaxMin = clamp(Math.round(Number(patch.eventMaxMin) || 12), 3, 90);
    if (s.eventMaxMin < s.eventMinMin + 1) s.eventMaxMin = s.eventMinMin + 1;
    if (patch.ripRange !== undefined) s.ripRange = clamp(Math.round(Number(patch.ripRange) || 0), 0, 200);
    if (patch.locked !== undefined) s.locked = !!patch.locked;
    if (patch.specialCount !== undefined && this.status === 'lobby') {
      s.specialCount = clamp(Math.round(Number(patch.specialCount) || 0), 0, 6);
    }
    if (this.status === 'playing' && s.autoEvents && !this.nextEventAt) {
      this.nextEventAt = nowMs() + randInt(s.eventMinMin, s.eventMaxMin) * 60000;
    }
    if (!s.autoEvents) this.nextEventAt = null;
    this.sig({ type: 'state' });
  }

  start(adminId, { force = false } = {}) {
    this._requireAdmin(adminId);
    if (this.status !== 'lobby') throw new GameError('游戏已经开始了');
    const list = [...this.players.values()];
    const fighters = list.filter((p) => p.role !== 'photographer');
    if (list.length < 2) throw new GameError('至少需要 2 名玩家才能开始');
    if (fighters.length < 2) throw new GameError('至少需要 2 名可参战玩家（摄影不计入）');
    if (!list.some((p) => p.role === 'admin')) throw new GameError('房间里没有管理员');
    if (!force) {
      const info = this._readyInfo();
      if (!info.all) {
        const names = info.unready.slice(0, 4).join('、');
        throw new GameError(`还有 ${info.unready.length} 人未准备${names ? `：${names}` : ''}。可等大家准备，或强制开始。`);
      }
    }

    const t = nowMs();
    this._resetRound(t);
    const prepMs = Math.max(0, Math.round(Number(this.settings.prepMin) || 0)) * 60000;
    if (prepMs > 0) {
      this.status = 'preparing';
      this.prepStartedAt = t;
      this.prepEndsAt = t + prepMs;
      this.prepAccelerated = false;
      this.startedAt = null;
      this.endsAt = null;
      for (const p of list) p.ready = false;
      const minutes = Math.round(prepMs / 60000);
      this.pushFeed(`⏳ 准备阶段开始，${minutes} 分钟内看得到所有人的位置，身份暂不公开`, 'info');
      this.notify(null, `准备阶段开始，${minutes} 分钟后自动进入游戏；全员准备就绪后等 10 秒立即开始。`, {
        title: '⏳ 准备阶段', kind: 'prep', sound: 'good',
      });
      this.addTimeline('prep', '准备阶段开始');
      this.sig({ type: 'state' });
      this.sig({ type: 'positions' });
      return { message: `准备阶段开始（${minutes} 分钟）` };
    }
    this._beginPlaying(t);
    return { message: '游戏开始' };
  }

  _resetRound(t = nowMs()) {
    const list = [...this.players.values()];
    this.status = 'lobby';
    this.startedAt = null;
    this.endsAt = null;
    this.endedAt = null;
    this.prepStartedAt = null;
    this.prepEndsAt = null;
    this.prepAccelerated = false;
    this.result = null;
    this.globalReveal = false;
    this.forcedReveal = false;
    this.spyId = null;
    this.nextEventAt = null;
    this.alertMarks = new Set();
    this.accusations = [];
    this.moments = [];
    this.timeline = [];
    this.chat = [];
    this.feed = [];
    this._usedCodes = new Set();
    this._lastSpyPush = 0;
    this.posDirty = false;
    this.lastPosBroadcast = 0;

    for (const p of list) {
      p.alive = true;
      p.ready = false;
      p.diedAt = null;
      p.killedBy = null;
      p.deathNote = '';
      p.exposedUntil = 0;
      p.exposureReason = '';
      p.cards = [];
      p.events = [];
      p.effects = { ghostUntil: 0, eyeUntil: 0, trackTargetId: null, trackUntil: 0, goldenUntil: 0, freezeUntil: 0 };
      p.bondId = null;
      p.revivedById = null;
      p.revivedPlayerId = null;
      p.spyTasks = [];
      p.accusationUsed = false;
      p.specialSkill = null;
      if (p.role === 'special' || p.role === 'spy') p.role = 'player';
      p.stats = { rips: 0, distance: 0, eventsDone: 0, cardsUsed: 0, skillsUsed: 0 };
      p.path = [];
    }

    const fighters = list.filter((p) => p.role !== 'photographer');
    this._assignSpecialRoles(fighters);
  }

  _beginPlaying(t = nowMs()) {
    if (!['lobby', 'preparing'].includes(this.status)) return;
    const list = [...this.players.values()];
    this.status = 'playing';
    this.startedAt = t;
    this.endsAt = t + this.settings.durationMin * 60000;
    this.endedAt = null;
    this.prepEndsAt = null;
    this.prepAccelerated = false;
    this.alertMarks = new Set([10, 5, 3, 1].filter((m) => m >= this.settings.durationMin));
    this.nextEventAt = this.settings.autoEvents
      ? t + randInt(this.settings.eventMinMin, this.settings.eventMaxMin) * 60000
      : null;
    this.globalReveal = false;
    this.forcedReveal = false;

    for (const p of list) {
      p.ready = false;
      p.path = [];
      p.stats.distance = 0;
      if (p.pos && t - p.pos.ts < 5 * 60000) p.path.push({ lat: p.pos.lat, lng: p.pos.lng, t });
    }

    const specials = list.filter((p) => p.role === 'special');
    this.pushFeed(`🏁 游戏开始！本局 ${this.settings.durationMin} 分钟，共 ${list.length} 人`, 'start');
    this.pushFeed('🎭 身份已公开。📍 从此刻起所有人位置隐藏，最后 15 分钟全员显形。', 'info');
    this.notify(null, `游戏开始，${this.settings.durationMin} 分钟后结束。身份公开，位置从现在起隐藏。`, {
      title: '🏁 游戏开始', kind: 'start', sound: 'start',
    });
    if (specials.length) {
      this.pushFeed(`✨ 本局特殊人物：${specials.map((p) => p.name).join('、')}`, 'info');
      for (const p of specials) {
        const sk = this._specialSkillView(p);
        this.notify(p.id, `你是特殊人物，本局技能：${sk.icon} ${sk.name}。${sk.desc}`, {
          title: '✨ 特殊身份', kind: 'special', sound: 'good',
        });
      }
      this.addTimeline('specials', `特殊人物：${specials.map((p) => `${p.name}(${this._specialSkillView(p).name})`).join('、')}`);
    }
    this.addTimeline('start', '游戏开始');
    this.sig({ type: 'state' });
    this.sig({ type: 'positions' });
  }

  skipPrep(adminId) {
    this._requireAdmin(adminId);
    if (this.status !== 'preparing') throw new GameError('当前不在准备阶段');
    this._beginPlaying(nowMs());
    return { message: '已跳过准备阶段，游戏开始' };
  }

  _generateSpyTasks(spy) {
    const others = [...this.players.values()].filter((p) => p.id !== spy.id && p.role !== 'photographer');
    const tasks = [];
    const used = new Set();
    const add = (type, extra = {}) => {
      if (used.has(type)) return;
      used.add(type);
      const def = SPY_TASK_DEFS[type];
      tasks.push({
        id: uid('st_'), type,
        need: extra.need ?? def.need,
        progress: 0, status: 'pending',
        code: def.kind === 'witness' ? this._newCode() : null,
        targetId: extra.targetId || null,
        confirmedByIds: [],
        startedAt: null,
      });
    };

    if (others.length >= 1) add('english', { need: Math.min(2, others.length) });

    const pool = [];
    if (others.length >= 1) pool.push('rip');
    pool.push('expose');
    if (others.length >= 1) pool.push('shadow');
    const first = pick(pool);
    add(first, first === 'shadow' ? { targetId: pick(others).id } : {});
    const rest = pool.filter((x) => x !== first);
    let second = null;
    if (rest.length) second = pick(rest);
    if (!second) second = 'expose';
    add(second, second === 'shadow' ? { targetId: pick(others).id } : {});
    if (tasks.length < 3) add('expose');

    spy.spyTasks = tasks;
    spy.spyTasks.forEach((task) => {
      if (task.kind === 'witness' && !task.code) task.code = this._newCode();
    });
    // attach kind for convenience
    for (const task of spy.spyTasks) task.kind = SPY_TASK_DEFS[task.type].kind;
  }

  /* ---------- timer / tick ---------- */

  tick(now = nowMs()) {
    if (this.status === 'preparing') {
      if (this.prepEndsAt && now >= this.prepEndsAt) this._beginPlaying(now);
      return;
    }
    if (this.status !== 'playing') return;
    if (now >= this.endsAt) {
      this.finish({ winner: 'good', reason: '时间到！存活的玩家守住了战场，幸存者获胜' });
      return;
    }
    const remaining = this.endsAt - now;
    if (!this.globalReveal && remaining <= 15 * 60000) {
      this.globalReveal = true;
      const mins = Math.max(1, Math.ceil(remaining / 60000));
      this.pushFeed(`🚨 全员显形：最后 ${mins} 分钟，所有人的位置已暴露`, 'alarm');
      this.notify(null, `最后 ${mins} 分钟：所有人位置已公开！`, { title: '全员显形', kind: 'alarm', sound: 'alarm' });
      this.addTimeline('reveal', `全员显形：最后 ${mins} 分钟`);
      this.sig({ type: 'state' });
      this.sig({ type: 'positions' });
    }
    for (const m of [10, 5, 3, 1]) {
      if (remaining <= m * 60000 && !this.alertMarks.has(m)) {
        this.alertMarks.add(m);
        this.pushFeed(`⏰ 距离结束还有 ${m} 分钟`, 'time');
        this.notify(null, `倒计时 ${m} 分钟！`, { title: '时间提醒', kind: 'time', sound: 'time' });
      }
    }

    const players = [...this.players.values()];
    for (const p of players) {
      if (!p.alive) continue;
      for (const e of p.events) this._tickEvent(p, e, now);
    }
    const spy = this.spyId ? this.players.get(this.spyId) : null;
    if (spy && spy.alive) this._tickSpyTasks(spy, now);

    if (this.status !== 'playing') return;

    if (this.settings.autoEvents && this.nextEventAt && now >= this.nextEventAt) {
      const candidates = players.filter((p) => p.alive && p.role !== 'photographer'
        && p.events.filter((e) => e.status === 'pending' || e.status === 'active').length === 0);
      if (candidates.length && players.filter((p) => p.alive).length >= 2) {
        try { this.assignEvent(null, pick(candidates).id, null, true); } catch (e) { /* ignore */ }
      }
      this.nextEventAt = now + randInt(this.settings.eventMinMin, this.settings.eventMaxMin) * 60000;
    }
    if (spy && spy.alive && now - this._lastSpyPush > 12000
      && spy.spyTasks.some((task) => task.kind === 'shadow' && task.status === 'active')) {
      this._lastSpyPush = now;
      this.sig({ type: 'state' });
    }
  }

  _tickEvent(p, e, now) {
    if (e.status !== 'pending' && e.status !== 'active') return;
    if (e.type === 'custom') {
      if (e.status === 'pending' && e.deadline && now >= e.deadline) this._failEvent(p, e);
      return;
    }
    const def = EVENT_DEFS[e.type];
    const target = e.targetId ? this.players.get(e.targetId) : null;
    if (e.status !== 'done' && e.status !== 'failed' && now >= e.deadline) {
      if (e.type === 'expose' && e.status === 'active') {
        this._completeEvent(p, e);
      } else {
        this._failEvent(p, e);
      }
      return;
    }
    if (e.type === 'find' && target) {
      const d = this._visiblePositionsHint(p, target);
      if (d !== null && d <= 30) this._completeEvent(p, e);
    } else if (e.type === 'team' && target) {
      if (e.status === 'pending') {
        const d = this._visiblePositionsHint(p, target);
        if (d !== null && d <= 30) {
          e.status = 'active';
          e.startedAt = now;
          e.deadline = Math.max(e.deadline, now + 5 * 60000 + 10000);
          this.pushFeed(`🤝 ${p.name} 和 ${target.name} 组队成功，坚持 5 分钟`, 'event');
          this.notify(p.id, `已和 ${target.name} 组队，5 分钟后完成`, { title: '组队开始', kind: 'event', sound: 'event' });
          this.notify(target.id, `你已和 ${p.name} 组队，5 分钟后完成`, { title: '组队开始', kind: 'event', sound: 'event' });
          this.sig({ type: 'state' });
        }
      } else if (e.status === 'active' && e.startedAt && now - e.startedAt >= 5 * 60000) {
        this._completeEvent(p, e);
      }
    } else if (e.type === 'sprint') {
      if (e.origin && p.pos) {
        const d = distanceMeters(e.origin, p.pos);
        if (d >= 150) this._completeEvent(p, e);
      }
    }
  }

  _tickSpyTasks(spy, now) {
    let changed = false;
    for (const task of spy.spyTasks) {
      if (task.status !== 'pending' && task.status !== 'active') continue;
      if (task.type === 'expose' && task.status === 'active') {
        if (task.startedAt) {
          const progress = Math.min(task.need, (now - task.startedAt) / 1000);
          if (progress > task.progress + 5) {
            task.progress = Math.min(task.need, Math.floor(progress));
            changed = true;
          }
          if (now - task.startedAt >= task.need * 1000) {
            task.progress = task.need;
            this._completeSpyTask(spy, task);
          }
        }
      } else if (task.type === 'shadow' && task.targetId) {
        const target = this.players.get(task.targetId);
        if (target && target.alive) {
          const d = this._visiblePositionsHint(spy, target);
          if (d !== null && d <= 40) {
            if (task.status === 'pending') { task.status = 'active'; task.startedAt = now; changed = true; }
            if (task.lastTickAt) task.progress = Math.min(task.need, task.progress + (now - task.lastTickAt) / 1000);
            task.lastTickAt = now;
            if (Math.floor(task.progress) % 15 === 0) changed = true;
            if (task.progress >= task.need) {
              task.progress = task.need;
              this._completeSpyTask(spy, task);
            }
          } else {
            task.lastTickAt = now;
            if (task.status === 'active') { task.status = 'pending'; changed = true; }
          }
        }
      }
    }
    if (changed && this.status === 'playing') this.sig({ type: 'state' });
  }

  _completeSpyTask(spy, task) {
    if (task.status === 'done') return;
    task.status = 'done';
    task.completedAt = nowMs();
    if (this.status !== 'playing') return;
    this.notify(spy.id, `秘密任务完成：${SPY_TASK_DEFS[task.type].name}`, { title: '内鬼任务进度', kind: 'spy', sound: 'spy' });
    const done = spy.spyTasks.filter((x) => x.status === 'done').length;
    this.pushFeed(`🕵️ 内鬼完成了一个秘密任务（${done}/${spy.spyTasks.length}）`, 'spy');
    this.addTimeline('spytask', `内鬼任务完成：${SPY_TASK_DEFS[task.type].name}`);
    this.sig({ type: 'state' });
    if (spy.spyTasks.length && spy.spyTasks.every((x) => x.status === 'done')) {
      this.finish({ winner: 'spy', reason: '内鬼完成了全部秘密任务，在无人察觉时赢下了游戏' });
    }
  }

  /* ---------- events ---------- */

  assignEvent(adminId, targetId, type = null, isAuto = false) {
    if (type === 'custom') throw new GameError('自定义任务请使用管理员自定义任务功能');
    if (!isAuto) this._requireAdmin(adminId);
    if (this.status !== 'playing') throw new GameError('游戏不在进行中');
    const p = this._get(targetId);
    if (!p.alive) throw new GameError('这个玩家已经淘汰了');
    if (p.role === 'photographer') throw new GameError('摄影师不参与随机事件');
    const active = p.events.filter((e) => e.status === 'pending' || e.status === 'active');
    if (active.length >= 2) throw new GameError('这个玩家已有 2 个进行中的事件');

    let def = type && EVENT_DEFS[type] ? EVENT_DEFS[type] : null;
    if (!def) {
      const pool = Object.entries(EVENT_DEFS).filter(([k, d]) => k !== 'custom' && (isAuto ? d.weight > 0 : true));
      let total = pool.reduce((s, [, d]) => s + (isAuto ? d.weight : 1), 0);
      let r = Math.random() * total;
      for (const [k, d] of pool) {
        r -= (isAuto ? d.weight : 1);
        if (r <= 0) { type = k; def = d; break; }
      }
      if (!type) { type = 'pushups'; def = EVENT_DEFS.pushups; }
    }

    let target = null;
    if (def.needsTarget) {
      const others = [...this.players.values()].filter((x) => x.alive && x.id !== p.id && x.role !== 'photographer');
      if (!others.length) {
        if (isAuto) return null;
        throw new GameError('没有可以被指定为目标的玩家');
      }
      target = pick(others);
    }

    const t = nowMs();
    const e = {
      id: uid('ev_'), type, assigneeId: p.id, targetId: target ? target.id : null,
      code: def.witness ? this._newCode() : null,
      status: 'pending', createdAt: t, deadline: t + def.minutes * 60000,
      startedAt: null, origin: p.pos ? { lat: p.pos.lat, lng: p.pos.lng } : null,
      progress: 0, completedAt: null,
    };
    if (type === 'expose') {
      e.status = 'active';
      e.startedAt = t;
      p.exposedUntil = Math.max(p.exposedUntil, t + 5 * 60000);
      p.exposureReason = 'event';
      this.sig({ type: 'positions' });
    }
    p.events.push(e);
    const desc = String(def.desc || '').replaceAll('{target}', target ? target.name : '目标');
    this.notify(p.id, `${def.name}：${desc}`, { title: `${def.icon} 随机事件`, kind: 'event', sound: 'event' });
    if (type === 'team' && target) {
      this.notify(target.id, `${p.name} 接到了组队任务，想和你组队 5 分钟。靠近后自动开始。`, { title: '🤝 组队邀请', kind: 'event', sound: 'event' });
    }
    this.pushFeed(`🎲 随机事件降临：一名玩家接到了「${def.name}」`, 'event');
    this.addTimeline('event', `随机事件：${p.name} 接到「${def.name}」`, { playerId: p.id });
    this.sig({ type: 'state' });
    return e;
  }

  assignCustom(adminId, targetId, data = {}) {
    this._requireAdmin(adminId);
    this._requirePlaying();
    const title = String(data.title || '').trim().slice(0, 40);
    const desc = String(data.desc || '').trim().slice(0, 200);
    if (!title) throw new GameError('请输入任务标题');
    if (!desc) throw new GameError('请输入任务描述');
    const minutes = clamp(Math.round(Number(data.minutes) || 0), 0, 180);
    const needWitness = !!data.needWitness;
    let targets;
    if (targetId === 'all') {
      targets = [...this.players.values()].filter((p) => p.alive && p.role !== 'photographer' && p.role !== 'admin');
    } else {
      const p = this._get(targetId);
      if (!p.alive) throw new GameError('这个玩家已经淘汰了');
      if (p.role === 'photographer') throw new GameError('摄影师不参与任务');
      targets = [p];
    }
    if (!targets.length) throw new GameError('没有可以接收任务的目标');
    const t = nowMs();
    for (const p of targets) {
      const code = needWitness ? this._newCode() : null;
      p.events.push({
        id: uid('ev_'), type: 'custom', assigneeId: p.id, targetId: null,
        customTitle: title, customDesc: desc, code, witness: needWitness,
        status: 'pending', createdAt: t, deadline: minutes > 0 ? t + minutes * 60000 : 0,
        startedAt: null, origin: null, progress: 0, completedAt: null,
      });
      this.notify(p.id, `自定义任务：${title}\n${desc}${minutes > 0 ? `（限时 ${minutes} 分钟）` : '（无期限）'}${code ? `\n见证码：${code}（让一位同学在任务页输入即可完成）` : ''}`, { title: '📝 管理员任务', kind: 'custom', sound: 'event' });
    }
    this.pushFeed(`📝 管理员发布了自定义任务「${title}」${targetId === 'all' ? '，发给全体玩家' : `，交给 ${targets[0].name}`}`, 'event');
    this.addTimeline('custom', `自定义任务：${title}`, { playerId: targets[0]?.id || null });
    this.sig({ type: 'state' });
    return { count: targets.length, minutes };
  }

  _completeEvent(p, e) {
    if (e.status === 'done' || e.status === 'failed') return;
    e.status = 'done';
    e.completedAt = nowMs();
    p.stats.eventsDone += 1;
    const def = EVENT_DEFS[e.type];
    if (e.type === 'custom') {
      this.pushFeed(`✅ ${p.name} 完成了自定义任务「${e.customTitle}」`, 'good');
      this.notify(p.id, `自定义任务完成：${e.customTitle}`, { title: '📝 任务完成', kind: 'good', sound: 'good' });
      this.addTimeline('customdone', `${p.name} 完成自定义任务「${e.customTitle}」`, { playerId: p.id });
      this.sig({ type: 'state' });
      return;
    }
    if (e.type === 'ripwin') {
      this.finish({ winner: 'player', playerId: p.id, reason: `${p.name} 完成了「猎杀时刻」，撕掉目标后直接获胜` });
      return;
    }
    const cardType = this._pickCardType();
    p.cards.push({ id: uid('cd_'), type: cardType, givenAt: nowMs() });
    this.pushFeed(`✅ ${p.name} 完成了随机事件「${def.name}」，获得一张技能卡`, 'good');
    this.notify(p.id, `完成「${def.name}」，获得技能卡：${CARD_DEFS[cardType].name}`, { title: '事件完成', kind: 'good', sound: 'good' });
    this.addTimeline('eventdone', `${p.name} 完成随机事件「${def.name}」`, { playerId: p.id });
    this.sig({ type: 'state' });
  }

  _failEvent(p, e) {
    if (e.status === 'done' || e.status === 'failed') return;
    e.status = 'failed';
    e.failedAt = nowMs();
    const def = EVENT_DEFS[e.type];
    if (e.type === 'custom') {
      this.pushFeed(`⌛ ${p.name} 的自定义任务「${e.customTitle}」未完成`, 'warn');
      this.notify(p.id, `自定义任务未完成：${e.customTitle}`, { title: '📝 任务失败', kind: 'warn', sound: 'warn' });
      this.addTimeline('customfail', `${p.name} 自定义任务「${e.customTitle}」未完成`, { playerId: p.id });
      this.sig({ type: 'state' });
      return;
    }
    if (p.alive) {
      p.exposedUntil = Math.max(p.exposedUntil, nowMs() + 3 * 60000);
      p.exposureReason = 'event-fail';
    }
    this.pushFeed(`⌛ ${p.name} 的随机事件「${def.name}」超时，位置暴露 3 分钟`, 'warn');
    this.notify(p.id, `「${def.name}」超时，你的位置暴露 3 分钟`, { title: '任务失败', kind: 'warn', sound: 'warn' });
    this.addTimeline('eventfail', `${p.name} 随机事件「${def.name}」超时`, { playerId: p.id });
    this.sig({ type: 'state' });
    this.sig({ type: 'positions' });
  }

  completeEventByAdmin(adminId, eventId, success = true) {
    this._requireAdmin(adminId);
    let found = null;
    for (const p of this.players.values()) {
      const e = p.events.find((x) => x.id === eventId);
      if (e) { found = { p, e }; break; }
    }
    if (!found) throw new GameError('事件不存在');
    if (success) this._completeEvent(found.p, found.e);
    else this._failEvent(found.p, found.e);
    this.sig({ type: 'state' });
  }

  confirmCode(playerId, code) {
    this._requirePlaying();
    const p = this._get(playerId);
    code = String(code || '').replace(/\D/g, '').slice(0, 4);
    if (code.length !== 4) throw new GameError('请输入 4 位见证码');
    for (const owner of this.players.values()) {
      for (const e of owner.events) {
        if (e.code === code && e.status === 'pending' && owner.id !== p.id) {
          const label = e.type === 'custom' ? (e.customTitle || '自定义任务') : (EVENT_DEFS[e.type]?.name || '任务');
          this._completeEvent(owner, e);
          this.pushFeed(`🙌 ${p.name} 为 ${owner.name} 见证了「${label}」`, 'good');
          return { ok: true, forName: owner.name, label };
        }
      }
    }
    const spy = this.spyId ? this.players.get(this.spyId) : null;
    if (spy) {
      for (const task of spy.spyTasks) {
        if (task.code === code && task.status !== 'done' && spy.id !== p.id
          && !(task.confirmedByIds || []).includes(p.id)) {
          task.confirmedByIds = task.confirmedByIds || [];
          task.confirmedByIds.push(p.id);
          task.progress = Math.min(task.need, task.progress + 1);
          this.notify(spy.id, `${p.name} 已确认一段英文对话（${task.progress}/${task.need}）`, { title: '暗号交谈', kind: 'spy', sound: 'spy' });
          this.pushFeed(`🙌 ${p.name} 完成了一次任务见证`, 'good');
          if (task.progress >= task.need) this._completeSpyTask(spy, task);
          this.sig({ type: 'state' });
          return { ok: true };
        }
      }
    }
    throw new GameError('见证码无效，或者已经用过了');
  }

  /* ---------- cards ---------- */

  assertCanReceiveCard(playerId) {
    this._requirePlaying();
    const p = this._get(playerId);
    if (!p.alive) throw new GameError('你已经淘汰了，不能领取技能卡');
    if (p.cards.filter((c) => !c.usedAt).length >= 6) throw new GameError('你的手牌已经满了（6 张）');
    return p;
  }

  addCardTo(playerId, type, source = 'card') {
    if (!CARD_DEFS[type]) throw new GameError('技能卡不存在');
    const p = this._get(playerId);
    const card = { id: uid('cd_'), type, givenAt: nowMs() };
    p.cards.push(card);
    const name = CARD_DEFS[type].name;
    if (source === 'qr') {
      this.notify(p.id, `核销成功，获得技能卡：${name}`, { title: '🎴 扫码领卡', kind: 'card', sound: 'card' });
      this.pushFeed(`🎴 ${p.name} 扫码核销了一张技能卡`, 'card');
      this.addTimeline('cardqr', `${p.name} 扫码获得「${name}」`, { playerId: p.id });
    } else {
      this.notify(p.id, `你收到了技能卡：${name}`, { title: '🎁 技能卡', kind: 'card', sound: 'card' });
      this.pushFeed('🎁 管理员发放了一张技能卡', 'card');
    }
    this.sig({ type: 'state' });
    return card;
  }

  giveCard(adminId, targetId, type) {
    this._requireAdmin(adminId);
    if (!CARD_DEFS[type]) throw new GameError('技能卡不存在');
    this.assertCanReceiveCard(targetId);
    return this.addCardTo(targetId, type, 'admin');
  }

  useCard(playerId, cardId, targetId = null) {
    this._requirePlaying();
    const p = this._get(playerId);
    if (!p.alive) throw new GameError('你已经淘汰了，不能使用技能卡');
    const card = p.cards.find((c) => c.id === cardId && !c.usedAt);
    if (!card) throw new GameError('技能卡不存在或已使用');
    const def = CARD_DEFS[card.type];
    const t = nowMs();
    if (p.effects.freezeUntil > t) throw new GameError('你被定身，暂时不能使用技能卡');
    let message = '';

    if (card.type === 'revive') {
      const target = this._get(targetId);
      if (target.id === p.id) throw new GameError('不能复活自己');
      if (target.alive) throw new GameError('TA 还活着');
      if (target.role === 'photographer') throw new GameError('摄影师不能被复活');
      if (p.bondId) throw new GameError('你已经有共生搭档了');
      if (target.bondId) throw new GameError('TA 还有共生搭档');
      target.alive = true;
      target.diedAt = null;
      target.killedBy = null;
      target.deathNote = '';
      target.revivedById = p.id;
      p.revivedPlayerId = target.id;
      target.bondId = p.id;
      p.bondId = target.id;
      message = `你复活了 ${target.name}，你们现在共用一条命`;
      this.pushFeed(`💫 ${p.name} 使用复活卡复活了 ${target.name}，两人共用一条命`, 'good');
      this.notify(target.id, `${p.name} 用复活卡复活了你。你们共用一条命，且你不能撕 ${p.name}。`, { title: '你被复活了', kind: 'good', sound: 'good' });
      this.notify(p.id, `你复活了 ${target.name}。一人被撕，两人一起淘汰。`, { title: '复活成功', kind: 'good', sound: 'good' });
      this.addTimeline('revive', `${p.name} 复活了 ${target.name}`, { playerId: target.id });
    } else if (card.type === 'shield') {
      throw new GameError('护盾卡会自动抵挡一次被撕，不需要手动使用');
    } else if (card.type === 'ghost') {
      p.effects.ghostUntil = t + 5 * 60000;
      message = '隐身 5 分钟，别人的地图上看不到你';
      this.pushFeed('👻 一名玩家使用了隐身卡', 'card');
      this.addTimeline('card', `${p.name} 使用了隐身卡`);
    } else if (card.type === 'eye') {
      p.effects.eyeUntil = t + 2 * 60000;
      message = '天眼开启，2 分钟内能看到所有人';
      this.pushFeed('👁️ 一名玩家使用了天眼卡', 'card');
      this.addTimeline('card', `${p.name} 使用了天眼卡`);
    } else if (card.type === 'track') {
      const target = this._get(targetId);
      if (target.id === p.id) throw new GameError('不能追踪自己');
      if (!target.alive) throw new GameError('TA 已经淘汰了');
      p.effects.trackTargetId = target.id;
      p.effects.trackUntil = t + 5 * 60000;
      message = `正在追踪 ${target.name}，持续 5 分钟`;
      this.notify(p.id, message, { title: '🎯 追踪卡', kind: 'card', sound: 'card' });
      this.pushFeed('🎯 一名玩家使用了追踪卡', 'card');
      this.addTimeline('card', `${p.name} 使用了追踪卡`);
    } else if (card.type === 'golden') {
      p.effects.goldenUntil = t + 3 * 60000;
      message = '金钟罩开启，3 分钟内免疫被撕';
      this.notify(p.id, message, { title: '🥇 金钟罩', kind: 'card', sound: 'good' });
      this.pushFeed('🥇 一名玩家使用了金钟罩', 'card');
      this.addTimeline('card', `${p.name} 使用了金钟罩`);
    } else if (card.type === 'curse') {
      const target = this._get(targetId);
      if (target.id === p.id) throw new GameError('不能对自己使用曝光卡');
      if (!target.alive) throw new GameError('TA 已经淘汰了');
      target.exposedUntil = Math.max(target.exposedUntil, t + 3 * 60000);
      target.exposureReason = 'card';
      message = `你让 ${target.name} 的位置暴露 3 分钟`;
      this.notify(target.id, '你被曝光卡锁定，位置暴露 3 分钟', { title: '🔮 被曝光', kind: 'warn', sound: 'warn' });
      this.notify(p.id, message, { title: '🔮 曝光卡', kind: 'card', sound: 'card' });
      this.pushFeed('🔮 一名玩家使用了曝光卡', 'card');
      this.addTimeline('card', `${p.name} 使用了曝光卡`, { targetId: target.id });
    } else if (card.type === 'steal') {
      const target = this._get(targetId);
      if (target.id === p.id) throw new GameError('不能偷自己的卡');
      if (!target.alive) throw new GameError('TA 已经淘汰了');
      const pool = target.cards.filter((c) => !c.usedAt);
      if (!pool.length) throw new GameError('TA 手上没有可偷的技能卡');
      const stolen = pick(pool);
      target.cards = target.cards.filter((c) => c.id !== stolen.id);
      p.cards.push({ id: uid('cd_'), type: stolen.type, givenAt: nowMs() });
      message = `你从 ${target.name} 手中偷到了「${CARD_DEFS[stolen.type].name}」`;
      this.notify(target.id, `你的「${CARD_DEFS[stolen.type].name}」被偷走了`, { title: '🪝 被偷卡', kind: 'warn', sound: 'warn' });
      this.notify(p.id, message, { title: '🪝 顺手牵羊', kind: 'good', sound: 'good' });
      this.pushFeed('🪝 一名玩家使用了顺手牵羊', 'card');
      this.addTimeline('card', `${p.name} 使用了顺手牵羊`, { targetId: target.id });
    } else {
      throw new GameError('未知技能卡');
    }

    card.usedAt = t;
    p.stats.cardsUsed += 1;
    if (p.role === 'spy' && p.id === this.spyId) {
      for (const task of p.spyTasks) {
        if (task.type === 'card' && task.status !== 'done') {
          task.progress = Math.min(task.need, task.progress + 1);
          if (task.progress >= task.need) this._completeSpyTask(p, task);
        }
      }
    }
    this.sig({ type: 'state' });
    this.sig({ type: 'positions' });
    return { message, card: def.name };
  }

  useSpecial(playerId, targetId = null) {
    this._requirePlaying();
    const p = this._get(playerId);
    if (!p.alive) throw new GameError('你已经淘汰了');
    if (p.role !== 'special') throw new GameError('只有特殊人物能使用特殊技能');
    if (!p.specialSkill) throw new GameError('特殊技能不存在');
    if (p.effects.freezeUntil > nowMs()) throw new GameError('你被定身，暂时不能使用特殊技能');
    const skill = p.specialSkill;
    const def = SPECIAL_SKILL_DEFS[skill.type];
    if (!def) throw new GameError('特殊技能不存在');
    const cooldownLeft = Math.max(0, (skill.cooldownUntil || 0) - nowMs());
    if (cooldownLeft > 0) {
      const sec = Math.ceil(cooldownLeft / 1000);
      throw new GameError(`技能冷却中，还需 ${Math.floor(sec / 60)} 分 ${sec % 60} 秒`);
    }
    let target = null;
    if (def.target === 'alive') {
      target = this._get(targetId);
      if (target.id === p.id) throw new GameError('不能选择自己');
      if (!target.alive) throw new GameError('TA 已经淘汰了');
      if (target.role === 'photographer') throw new GameError('不能对摄影师使用');
    }
    const t = nowMs();
    let message = '';
    if (skill.type === 'shadow') {
      p.effects.ghostUntil = t + 3 * 60000;
      message = '潜行 3 分钟，别人的地图上看不到你';
      this.pushFeed('🌫️ 一名特殊人物使用了潜行', 'card');
      this.addTimeline('special', `${p.name} 使用特殊技能：潜行`);
    } else if (skill.type === 'scan') {
      p.effects.eyeUntil = t + 90 * 1000;
      message = '扫描开启，90 秒内能看到所有人';
      this.pushFeed('📡 一名特殊人物使用了扫描', 'card');
      this.addTimeline('special', `${p.name} 使用特殊技能：扫描`);
    } else if (skill.type === 'bind') {
      target.effects.freezeUntil = Math.max(target.effects.freezeUntil, t + 2 * 60000);
      message = `${target.name} 被定身 2 分钟`;
      this.notify(target.id, '你被特殊人物定身，2 分钟内不能撕名牌或使用技能卡', { title: '⛓️ 被定身', kind: 'warn', sound: 'warn' });
      this.pushFeed(`⛓️ 一名特殊人物定身了 ${target.name}`, 'warn');
      this.addTimeline('special', `${p.name} 对 ${target.name} 使用定身`, { targetId: target.id });
    } else if (skill.type === 'steal') {
      const pool = target.cards.filter((c) => !c.usedAt);
      if (!pool.length) throw new GameError('TA 手上没有可偷的技能卡');
      const stolen = pick(pool);
      target.cards = target.cards.filter((c) => c.id !== stolen.id);
      p.cards.push({ id: uid('cd_'), type: stolen.type, givenAt: nowMs() });
      message = `你从 ${target.name} 手中偷到了「${CARD_DEFS[stolen.type].name}」`;
      this.notify(target.id, `你的「${CARD_DEFS[stolen.type].name}」被偷走了`, { title: '🪝 被偷卡', kind: 'warn', sound: 'warn' });
      this.pushFeed('🪝 一名特殊人物使用顺手牵羊偷走了一张卡', 'card');
      this.addTimeline('special', `${p.name} 对 ${target.name} 使用顺手牵羊`, { targetId: target.id });
    } else if (skill.type === 'lucky') {
      const type = this._pickCardType();
      p.cards.push({ id: uid('cd_'), type, givenAt: nowMs() });
      message = `幸运获得技能卡：${CARD_DEFS[type].name}`;
      this.pushFeed('🍀 一名特殊人物获得了一张技能卡', 'card');
      this.addTimeline('special', `${p.name} 使用特殊技能：幸运`);
    } else if (skill.type === 'pulse') {
      target.exposedUntil = Math.max(target.exposedUntil, t + 3 * 60000);
      target.exposureReason = 'special';
      message = `${target.name} 的位置暴露 3 分钟`;
      this.notify(target.id, '你被震爆命中，位置暴露 3 分钟', { title: '💥 被震爆', kind: 'warn', sound: 'warn' });
      this.pushFeed('💥 一名特殊人物使用了震爆', 'warn');
      this.addTimeline('special', `${p.name} 对 ${target.name} 使用震爆`, { targetId: target.id });
    } else {
      throw new GameError('未知特殊技能');
    }
    const cooldownMs = def.cooldownMs || 3 * 60 * 1000;
    skill.cooldownUntil = t + cooldownMs;
    skill.usedAt = t;
    skill.usesUsed = (skill.usesUsed || 0) + 1;
    p.stats.skillsUsed = (p.stats.skillsUsed || 0) + 1;
    const cooldownMin = Math.round(cooldownMs / 60000);
    this.notify(p.id, `${message}（冷却 ${cooldownMin} 分钟）`, { title: `✨ ${def.name}`, kind: 'good', sound: 'good' });
    this.sig({ type: 'state' });
    this.sig({ type: 'positions' });
    return { message, skill: def.name, cooldownMs, cooldownUntil: skill.cooldownUntil, usesUsed: skill.usesUsed };
  }

  /* ---------- ripping ---------- */

  rip(playerId, targetId) {
    this._requirePlaying();
    const attacker = this._get(playerId);
    const target = this._get(targetId);
    if (!attacker.alive) throw new GameError('你已经淘汰了');
    if (!target.alive) throw new GameError('TA 已经淘汰了');
    if (attacker.id === target.id) throw new GameError('不能撕自己');
    if (attacker.role === 'photographer') throw new GameError('摄影师不能撕名牌');
    if (target.role === 'photographer') throw new GameError('摄影师不能被撕');
    if (attacker.revivedById === target.id) throw new GameError(`你是被 ${target.name} 复活的，不能撕 TA`);
    if (attacker.bondId && attacker.bondId === target.id) throw new GameError('不能撕自己的共生搭档');
    if (attacker.effects.freezeUntil > nowMs()) throw new GameError('你被定身，暂时不能撕名牌');

    if (this.settings.ripRange > 0 && attacker.pos && target.pos
      && nowMs() - attacker.pos.ts < 120000 && nowMs() - target.pos.ts < 120000) {
      const d = distanceMeters(attacker.pos, target.pos);
      if (d > this.settings.ripRange) {
        throw new GameError(`你们相距约 ${Math.round(d)} 米，超出 ${this.settings.ripRange} 米的撕名牌范围`);
      }
    }

    if (target.effects.goldenUntil > nowMs()) {
      this.pushFeed(`🥇 ${target.name} 的金钟罩挡住了 ${attacker.name} 的撕名牌`, 'warn');
      this.notify(attacker.id, `${target.name} 的金钟罩还没结束，撕不动`, { title: '金钟罩', kind: 'warn', sound: 'warn' });
      this.notify(target.id, `你的金钟罩挡住了 ${attacker.name}`, { title: '金钟罩', kind: 'good', sound: 'good' });
      this.addTimeline('golden', `${target.name} 的金钟罩挡住了 ${attacker.name}`, { playerId: target.id });
      this.sig({ type: 'state' });
      return { blocked: true, message: `${target.name} 还在金钟罩保护中` };
    }

    const shield = target.cards.find((c) => c.type === 'shield' && !c.usedAt);
    if (shield) {
      shield.usedAt = nowMs();
      this.pushFeed(`🛡️ ${target.name} 的护盾抵挡了 ${attacker.name} 的撕名牌`, 'warn');
      this.notify(attacker.id, `${target.name} 的护盾挡住了你的攻击`, { title: '护盾抵挡', kind: 'warn', sound: 'warn' });
      this.notify(target.id, `你的护盾自动抵挡了 ${attacker.name} 的撕名牌`, { title: '护盾抵挡', kind: 'good', sound: 'good' });
      this.addTimeline('shield', `${target.name} 的护盾挡住了 ${attacker.name}`, { playerId: target.id });
      this.sig({ type: 'state' });
      return { blocked: true, message: `${target.name} 的护盾挡住了这次撕名牌` };
    }

    const targetName = target.name;
    const attackerName = attacker.name;
    const partner = target.bondId ? this.players.get(target.bondId) : null;
    target.alive = false;
    target.diedAt = nowMs();
    target.killedBy = attacker.id;
    target.bondId = null;
    attacker.stats.rips += 1;

    let partnerDied = null;
    if (partner && partner.alive) {
      partner.alive = false;
      partner.diedAt = nowMs();
      partner.killedBy = attacker.id;
      partner.deathNote = '共生淘汰';
      partner.bondId = null;
      partnerDied = partner.name;
    }

    this.pushFeed(`⚔️ ${attackerName} 撕掉了 ${targetName}${partnerDied ? `，共生的 ${partnerDied} 一起淘汰` : ''}`, 'rip');
    this.notify(target.id, `你被 ${attackerName} 撕掉了${partnerDied ? `，${partnerDied} 与你一起淘汰` : ''}`, { title: '你被淘汰了', kind: 'rip', sound: 'rip' });
    if (partnerDied) {
      this.notify(partner.id, `你的共生搭档被撕，你也被淘汰了`, { title: '共生淘汰', kind: 'rip', sound: 'rip' });
    }
    this.addTimeline('rip', `${attackerName} 撕掉了 ${targetName}`, {
      playerId: attacker.id, targetId: target.id, lat: target.pos?.lat, lng: target.pos?.lng,
    });

    const ripwin = attacker.events.find((e) => e.type === 'ripwin' && e.targetId === target.id
      && (e.status === 'pending' || e.status === 'active'));
    if (ripwin) {
      ripwin.status = 'done';
      ripwin.completedAt = nowMs();
      this.finish({ winner: 'player', playerId: attacker.id, reason: `${attackerName} 撕掉了目标 ${targetName}，触发「猎杀时刻」直接获胜` });
      return { eliminated: true, message: `你撕掉了 ${targetName}，触发猎杀时刻，直接获胜！` };
    }

    if (this._checkLastSurvivor()) {
      return { eliminated: true, message: `你撕掉了 ${targetName}，本局结束` };
    }

    this.sig({ type: 'state' });
    this.sig({ type: 'positions' });
    return { eliminated: true, message: `你撕掉了 ${targetName}` };
  }

  _checkLastSurvivor() {
    if (this.status !== 'playing') return false;
    const alive = [...this.players.values()].filter((p) => p.alive && p.role !== 'photographer');
    if (alive.length === 1) {
      this.finish({ winner: 'player', playerId: alive[0].id, reason: `最后一名幸存者 ${alive[0].name} 获胜` });
      return true;
    }
    if (alive.length === 0) {
      this.finish({ winner: 'draw', reason: '全员出局，本局平局' });
      return true;
    }
    return false;
  }

  /* ---------- accusations ---------- */

  accuse(playerId, targetId) {
    this._requirePlaying();
    const p = this._get(playerId);
    const target = this._get(targetId);
    if (!p.alive) throw new GameError('淘汰后不能指认');
    if (!target.alive) throw new GameError('TA 已经淘汰了');
    if (p.id === target.id) throw new GameError('不能指认自己');
    if (p.accusationUsed) throw new GameError('每局只能指认一次');
    if (this.accusations.some((a) => a.byId === p.id)) throw new GameError('你已经指认过了');
    p.accusationUsed = true;
    const a = {
      id: uid('ac_'), byId: p.id, targetId: target.id, at: nowMs(), status: 'pending', resolvedAt: null,
    };
    this.accusations.push(a);
    this.pushFeed(`⚖️ ${p.name} 指认 ${target.name} 是内鬼，等待管理员裁决`, 'warn');
    for (const admin of this.players.values()) {
      if (admin.role === 'admin') {
        this.notify(admin.id, `${p.name} 指认 ${target.name} 是内鬼，请裁决`, { title: '内鬼指认', kind: 'warn', sound: 'warn' });
      }
    }
    this.addTimeline('accuse', `${p.name} 指认 ${target.name} 是内鬼`, { playerId: p.id, targetId: target.id });
    this.sig({ type: 'state' });
    return a;
  }

  resolveAccusation(adminId, accusationId, accept) {
    this._requireAdmin(adminId);
    const a = this.accusations.find((x) => x.id === accusationId);
    if (!a || a.status !== 'pending') throw new GameError('指认不存在或已处理');
    const accuser = this.players.get(a.byId);
    const target = this.players.get(a.targetId);
    a.status = accept ? 'accepted' : 'rejected';
    a.resolvedAt = nowMs();
    if (accept && target?.role === 'spy') {
      target.alive = false;
      this.pushFeed(`🎯 指认成立！${target.name} 就是内鬼，好人阵营胜利`, 'good');
      this.finish({ winner: 'good', reason: `${accuser?.name || '玩家'} 成功找出内鬼 ${target.name}，阻止了秘密任务` });
      return;
    }
    if (accept) {
      this.pushFeed(`❌ 指认不成立：${target?.name || '?'} 不是内鬼，${accuser?.name || '玩家'} 的指认用掉了`, 'warn');
      if (accuser) this.notify(accuser.id, `${target?.name} 不是内鬼，你的指认机会已用完`, { title: '指认失败', kind: 'warn', sound: 'warn' });
    } else {
      this.pushFeed(`⚖️ 管理员驳回了 ${accuser?.name || '玩家'} 的指认`, 'info');
      if (accuser) this.notify(accuser.id, '管理员驳回了你的指认', { title: '指认被驳回', kind: 'info' });
    }
    this.sig({ type: 'state' });
  }

  /* ---------- admin actions ---------- */

  setExposure(adminId, targetId, minutes) {
    this._requireAdmin(adminId);
    const p = this._get(targetId);
    minutes = Math.max(0, Math.min(60, Number(minutes) || 0));
    if (minutes === 0) {
      p.exposedUntil = 0;
      this.pushFeed(`📍 管理员解除了 ${p.name} 的位置暴露`, 'info');
      this.notify(p.id, '你的位置不再公开', { title: '位置隐藏', kind: 'info' });
    } else {
      p.exposedUntil = Math.max(p.exposedUntil, nowMs() + minutes * 60000);
      p.exposureReason = 'admin';
      this.pushFeed(`📍 管理员暴露了 ${p.name} 的位置 ${minutes} 分钟`, 'warn');
      this.notify(p.id, `你的位置被管理员暴露 ${minutes} 分钟`, { title: '位置暴露', kind: 'warn', sound: 'warn' });
      this.addTimeline('expose', `${p.name} 被强制暴露位置 ${minutes} 分钟`, { playerId: p.id });
    }
    this.sig({ type: 'state' });
    this.sig({ type: 'positions' });
  }

  setReveal(adminId, value) {
    this._requireAdmin(adminId);
    this.forcedReveal = !!value;
    this.pushFeed(this.forcedReveal ? '👁️ 管理员开启了全员显形' : '👁️ 管理员关闭了强制显形', 'info');
    if (!this.forcedReveal && this.globalReveal) {
      this.pushFeed('⏰ 最后 15 分钟的自动显形仍然生效', 'info');
    }
    this.sig({ type: 'state' });
    this.sig({ type: 'positions' });
  }

  extendTime(adminId, minutes) {
    this._requireAdmin(adminId);
    if (this.status !== 'playing') throw new GameError('游戏不在进行中');
    const delta = clamp(Number(minutes) || 0, -60, 60);
    this.endsAt += delta * 60000;
    if (this.endsAt <= nowMs() + 30000) this.endsAt = nowMs() + 30000;
    this.pushFeed(`⏱️ 管理员把倒计时${delta >= 0 ? '延长' : '缩短'}了 ${Math.abs(delta)} 分钟`, 'info');
    this.notify(null, `倒计时${delta >= 0 ? '延长' : '缩短'} ${Math.abs(delta)} 分钟`, { title: '时间调整', kind: 'time', sound: 'time' });
    this.sig({ type: 'state' });
  }

  kick(adminId, targetId) {
    this._requireAdmin(adminId);
    const target = this._get(targetId);
    if (target.role === 'admin') throw new GameError('不能踢出管理员');
    if (target.id === adminId) throw new GameError('不能踢出自己');
    if (this.status === 'playing' && target.role === 'spy') {
      this.pushFeed(`🚪 ${target.name} 被移出房间，内鬼离场，好人阵营胜利`, 'good');
      this.finish({ winner: 'good', reason: '内鬼被移出房间' });
    }
    if (target.bondId) {
      const partner = this.players.get(target.bondId);
      if (partner) partner.bondId = null;
    }
    this.players.delete(target.id);
    this.pushFeed(`🚪 ${target.name} 被管理员移出了房间`, 'warn');
    this.sig({ type: 'state' });
    this.sig({ type: 'kicked', playerId: target.id });
  }

  dissolve(adminId) {
    this._requireAdmin(adminId);
    clearRoomCodes(this.code);
    this.sig({ type: 'dissolve' });
  }

  resetToLobby(adminId) {
    this._requireAdmin(adminId);
    if (this.status === 'playing') throw new GameError('游戏进行中不能重置，请先结束游戏');
    this.status = 'lobby';
    this.startedAt = null;
    this.endsAt = null;
    this.endedAt = null;
    this.prepStartedAt = null;
    this.prepEndsAt = null;
    this.prepAccelerated = false;
    this.result = null;
    this.globalReveal = false;
    this.forcedReveal = false;
    this.accusations = [];
    this.moments = [];
    this.timeline = [];
    this.nextEventAt = null;
    this.alertMarks = new Set();
    this.chat = [];
    this.feed = [];
    clearRoomCodes(this.code);
    for (const p of this.players.values()) {
      p.alive = true;
      p.ready = false;
      p.diedAt = null;
      p.killedBy = null;
      p.deathNote = '';
      p.exposedUntil = 0;
      p.cards = [];
      p.events = [];
      p.effects = { ghostUntil: 0, eyeUntil: 0, trackTargetId: null, trackUntil: 0, goldenUntil: 0, freezeUntil: 0 };
      p.bondId = null;
      p.revivedById = null;
      p.revivedPlayerId = null;
      p.spyTasks = [];
      p.accusationUsed = false;
      p.specialSkill = null;
      if (p.role === 'special' || p.role === 'spy') p.role = 'player';
      p.stats = { rips: 0, distance: 0, eventsDone: 0, cardsUsed: 0, skillsUsed: 0 };
      p.path = [];
    }
    this.spyId = null;
    this.pushFeed('回到大厅，准备下一局', 'info');
    this.sig({ type: 'state' });
    this.sig({ type: 'positions' });
  }

  /* ---------- finish ---------- */

  finish({ winner, playerId = null, reason }) {
    if (this.status !== 'playing') return;
    const t = nowMs();
    this.status = 'ended';
    this.endedAt = t;
    this.remainingMs = 0;
    const players = [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, role: p.role, alive: p.alive, online: p.online,
      colorIndex: p.colorIndex, stats: { ...p.stats }, diedAt: p.diedAt,
      killedBy: p.killedBy, bondId: p.bondId, revivedById: p.revivedById,
      pos: p.pos ? { ...p.pos } : null,
      pathPoints: p.path.length,
      specialSkill: p.specialSkill ? this._specialSkillView(p) : null,
    }));
    const survivors = players
      .filter((p) => p.alive && p.role !== 'photographer')
      .map((p) => p.id);
    this.result = {
      winner, playerId, reason,
      at: t, startedAt: this.startedAt, endedAt: t,
      durationMs: t - this.startedAt,
      survivors, players,
      specials: players.filter((p) => p.role === 'special').map((p) => ({
        id: p.id, name: p.name, skill: p.specialSkill || null,
      })),
    };
    this.addTimeline('end', reason, { winner });
    this.pushFeed(`🏁 ${reason}`, 'end');
    this.notify(null, reason, { title: '游戏结束', kind: 'end', sound: 'end' });
    this.sig({ type: 'state' });
    this.sig({ type: 'positions' });
    this.sig({ type: 'ended' });
  }

  /* ---------- position ---------- */

  recordPosition(playerId, lat, lng, acc = null) {
    if (!['playing', 'preparing'].includes(this.status)) return false;
    const p = this.players.get(playerId);
    if (!p || !p.alive) return false;
    lat = Number(lat); lng = Number(lng); acc = acc === null || acc === undefined ? null : Number(acc);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
    if (acc !== null && (!Number.isFinite(acc) || acc < 0 || acc > 3000)) acc = null;
    const t = nowMs();
    if (p.pos) {
      const dt = Math.max(0.5, (t - p.pos.ts) / 1000);
      const d = distanceMeters(p.pos, { lat, lng });
      if (dt < 60 && d / dt > 30) return false; // 108 km/h 的 GPS 跳点
      if (d < 1.5 && t - p.pos.ts < 4000) return false;
      if (dt < 120 && d < 400) p.stats.distance += d;
    }
    p.pos = { lat, lng, acc, ts: t };
    const last = p.path[p.path.length - 1];
    if (!last || t - last.t >= 10000 || distanceMeters(last, { lat, lng }) >= 12) {
      p.path.push({ lat, lng, t });
      if (p.path.length > 8000) p.path.splice(0, p.path.length - 8000);
    }
    this.posDirty = true;
    return true;
  }

  startSpyExpose(playerId, taskId) {
    this._requirePlaying();
    const spy = this._get(playerId);
    if (spy.role !== 'spy' || spy.id !== this.spyId) throw new GameError('只有内鬼能执行这个任务');
    if (!spy.alive) throw new GameError('你已经淘汰了');
    const task = spy.spyTasks.find((x) => x.id === taskId);
    if (!task || task.type !== 'expose') throw new GameError('任务不存在');
    if (task.status === 'done') throw new GameError('任务已经完了');
    if (task.status === 'active') throw new GameError('自曝进行中');
    task.status = 'active';
    task.startedAt = nowMs();
    spy.exposedUntil = Math.max(spy.exposedUntil, nowMs() + task.need * 1000);
    spy.exposureReason = 'spy-task';
    this.pushFeed('📍 一名玩家主动暴露了自己的位置 3 分钟', 'warn');
    this.notify(spy.id, '自曝开始，3 分钟后任务完成。撑住！', { title: '苦肉计', kind: 'spy', sound: 'warn' });
    this.addTimeline('expose', '内鬼启动苦肉计，自曝 3 分钟');
    this.sig({ type: 'state' });
    this.sig({ type: 'positions' });
  }

  completeSpyTaskByAdmin(adminId, taskId) {
    this._requireAdmin(adminId);
    const spy = this.spyId ? this.players.get(this.spyId) : null;
    if (!spy) throw new GameError('本局没有内鬼');
    const task = spy.spyTasks.find((x) => x.id === taskId);
    if (!task) throw new GameError('任务不存在');
    if (task.status !== 'done') {
      task.progress = task.need;
      this._completeSpyTask(spy, task);
    }
  }

  setAliveByAdmin(adminId, targetId, alive) {
    this._requireAdmin(adminId);
    const p = this._get(targetId);
    if (alive) {
      if (p.alive) throw new GameError('TA 还活着');
      p.alive = true;
      p.diedAt = null;
      p.killedBy = null;
      p.deathNote = '';
      p.bondId = null;
      p.revivedById = null;
      this.pushFeed(`♻️ 管理员复活了 ${p.name}`, 'good');
      this.notify(p.id, '管理员复活了你，回到战场！', { title: '你被复活了', kind: 'good', sound: 'good' });
      this.addTimeline('adminrevive', `管理员复活了 ${p.name}`, { playerId: p.id });
    } else {
      if (!p.alive) throw new GameError('TA 已经淘汰了');
      const partner = p.bondId ? this.players.get(p.bondId) : null;
      p.alive = false;
      p.diedAt = nowMs();
      p.killedBy = null;
      p.bondId = null;
      if (partner && partner.alive) {
        partner.alive = false;
        partner.diedAt = nowMs();
        partner.bondId = null;
        partner.deathNote = '共生淘汰';
        this.notify(partner.id, '你的共生搭档被管理员淘汰，你也一起出局', { title: '共生淘汰', kind: 'rip', sound: 'rip' });
      }
      this.pushFeed(`💀 管理员淘汰了 ${p.name}${partner ? `，共生的 ${partner.name} 一起出局` : ''}`, 'warn');
      this.notify(p.id, '你被管理员淘汰了', { title: '你被淘汰了', kind: 'rip', sound: 'rip' });
      this.addTimeline('adminkill', `管理员淘汰了 ${p.name}`, { playerId: p.id });
      if (this._checkLastSurvivor()) return;
    }
    this.sig({ type: 'state' });
    this.sig({ type: 'positions' });
  }

  finishByAdmin(adminId, { winner, playerId = null, reason = '' }) {
    this._requireAdmin(adminId);
    if (this.status !== 'playing') throw new GameError('游戏不在进行中');
    if (!['good', 'player', 'draw'].includes(winner)) throw new GameError('胜负类型无效');
    if (winner === 'player') {
      const p = this.players.get(playerId);
      if (!p) throw new GameError('请选择获胜玩家');
      this.finish({ winner, playerId, reason: reason || `管理员判定 ${p.name} 获胜` });
      return;
    }
    this.finish({
      winner,
      reason: reason || (winner === 'draw' ? '管理员判定本局平局' : '管理员判定幸存者获胜'),
    });
  }

  moment(playerId, note) {
    const p = this._get(playerId);
    if (p.role !== 'photographer' && p.role !== 'admin') throw new GameError('只有摄影师可以记录精彩瞬间');
    note = String(note || '').trim().slice(0, 40) || '精彩瞬间';
    const m = {
      id: uid('mo_'), at: nowMs(), byId: p.id, byName: p.name, note,
      lat: p.pos?.lat ?? null, lng: p.pos?.lng ?? null,
    };
    this.moments.push(m);
    this.pushFeed(`📸 ${p.name} 记录了精彩瞬间：${note}`, 'info');
    this.addTimeline('moment', `${p.name} 记录：${note}`, { lat: m.lat, lng: m.lng });
    this.sig({ type: 'state' });
    return m;
  }
}
