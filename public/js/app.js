import {
  $, $$, esc, fmtTime, fmtClock, fmtKm, fmtDuration, distanceMeters, initials,
  storageGet, storageSet, storageDel, api, copyText, vibrate, PALETTE, clamp,
} from './util.js';
import { GameMap } from './map.js';

const app = $('#app');
const modalRoot = $('#modal-root');
const cameraRoot = $('#camera-root');
const toastsEl = $('#toasts');

const S = {
  meta: null,
  state: null,
  socket: null,
  creds: null,
  screen: 'landing',
  offset: 0,
  sound: storageGet('nt.sound', true),
  haptics: storageGet('nt.haptics', true),
  mapPrefs: storageGet('nt.map', { provider: 'amap', gcj: true }),
  game: { map: null, mounted: false, sheet: null, adminOpen: false, resultShown: false, lastEndedAt: null },
  gps: { watchId: null, error: null, lastSent: 0, lastPos: null },
  audioCtx: null,
  lowVibrateMinute: null,
  bannerTimer: null,
  unreadChat: 0,
  initializing: false,
  everConnected: false,
  aliveSnapshot: null,
  pendingJoinCode: '',
  qrVersion: Date.now(),
  cardQr: null,
  wakeLock: null,
  adminEl: null,
  modalAction: null,
  lastChatId: null,
};

/* ================= 常州欢乐谷 · 地点任务预设 ================= */
const HAPPY_VALLEY_TASKS = [
  {
    id: 'coaster',
    title: '🎢 过山车起飞照',
    desc: '到园区任意一台过山车入口（不必乘坐），和至少 1 位同学摆出“起飞”姿势合照；让同学拍照/确认（可勾选见证码）。安全第一，不要翻越围栏。',
    minutes: 10,
  },
  {
    id: 'drop',
    title: '🗼 高空喊话',
    desc: '找到园区最高的跳楼机或高空项目，在下方安全区域朝天空喊一次“猎名场，Out！”，再让同学确认（可勾选见证码）。',
    minutes: 10,
  },
  {
    id: 'haunted',
    title: '👻 NPC 合影',
    desc: '进入鬼屋或 NPC 互动项目，在不影响演出的前提下和 1 位 NPC 合影；让同学确认（可勾选见证码）。不要追吓其他游客。',
    minutes: 15,
  },
  {
    id: 'water',
    title: '💦 水花证据',
    desc: '找到园区水上项目，在水花能溅到的安全区域拍一张全队合照，让同学确认（可勾选见证码）；不要下水、不要翻越护栏。',
    minutes: 10,
  },
  {
    id: 'landmark',
    title: '📍 欢乐谷地标',
    desc: '找到“常州欢乐谷”主入口或标志性雕塑，全队比出撕名牌手势合照，让同学确认（可勾选见证码）。',
    minutes: 10,
  },
  {
    id: 'carousel',
    title: '🎠 浪漫比心',
    desc: '找到旋转木马或摩天轮等浪漫项目，和一位同学面对面比心合照，让同学确认（可勾选见证码）；不影响其他游客。',
    minutes: 10,
  },
];

/* ================= boot ================= */

async function boot() {
  bindGlobalEvents();
  try {
    S.meta = await api('/api/meta');
  } catch (e) {
    app.innerHTML = `<div class="loading-screen"><div class="center"><div class="spinner"></div>无法连接服务器<br><span class="tiny">${esc(e.message)}</span><br><br><button class="btn line" onclick="location.reload()">重试</button></div></div>`;
    return;
  }
  const params = new URLSearchParams(location.search);
  const roomCode = (params.get('room') || '').replace(/\D/g, '').slice(0, 6);
  const last = storageGet('nt.last', null);
  const session = roomCode ? loadSession(roomCode) : null;
  if (roomCode && session) {
    showLoading('正在回到房间 ' + roomCode);
    connectSocket(session, { initial: true });
    const t = setTimeout(() => {
      if (S.screen === 'loading') {
        renderLanding(roomCode, '连接超时，请重新加入');
      }
    }, 9000);
    S.bootTimer = t;
  } else {
    renderLanding(roomCode);
  }
  setInterval(tickClock, 250);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.screen === 'game') {
      requestWakeLock();
      if (state()) updateGame();
    }
  });
  window.addEventListener('online', () => toast('网络已恢复', 'good'));
  window.addEventListener('offline', () => toast('网络已断开，正在等待重连', 'warn'));
}

function state() { return S.state; }
function me() { return S.state?.me || null; }

function sessionKey(code) { return 'nt.session.' + code; }
function loadSession(code) {
  const v = storageGet(sessionKey(code), null);
  if (v && v.code === code && v.playerId && v.token) return v;
  return null;
}
function saveSession(cred) {
  storageSet(sessionKey(cred.code), cred);
  storageSet('nt.last', cred);
}
function clearSession(code) {
  if (code) storageDel(sessionKey(code));
  const last = storageGet('nt.last', null);
  if (last && last.code === code) storageDel('nt.last');
}

function showLoading(text) {
  S.screen = 'loading';
  app.innerHTML = `<div class="loading-screen"><div class="center"><div class="spinner"></div>${esc(text || '加载中')}</div></div>`;
}

function setRoomUrl(code) {
  try { history.replaceState({}, '', '/?room=' + encodeURIComponent(code)); } catch { /* ignore */ }
}
function clearRoomUrl() {
  try { history.replaceState({}, '', '/'); } catch { /* ignore */ }
}

/* ================= landing ================= */

function renderLanding(joinCode = '', message = '') {
  S.screen = 'landing';
  teardownGame();
  closeAdminPanel();
  removeResult();
  closeModal();
  closeAllSheets();
  if (S.socket) { S.socket.removeAllListeners(); S.socket.disconnect(); S.socket = null; }
  if (S.bootTimer) { clearTimeout(S.bootTimer); S.bootTimer = null; }
  S.state = null;
  S.initializing = false;
  S.unreadChat = 0;
  const savedName = storageGet('nt.name', '');
  const last = storageGet('nt.last', null);
  const code = String(joinCode || '').replace(/\D/g, '').slice(0, 6);
  S.pendingJoinCode = code;
  app.innerHTML = `
  <div class="landing">
    <div class="landing-inner">
      <div class="brand-row">
        <div class="logo-mark">猎</div>
        <div>
          <div class="brand-name">猎名场</div>
          <div class="brand-sub">NAMETAG ARENA</div>
        </div>
      </div>
      <div class="hero">
        <div class="hero-kicker">多人实况 · 公网联机</div>
        <h1>撕掉名牌，<br><em>活到最后。</em></h1>
        <p>实时定位、随机事件、技能卡、特殊人物。游戏结束后，每个人的移动轨迹都会变成一段可保存的回放。</p>
        <div class="feature-row">
          <span class="feature-chip">📍 实时定位</span>
          <span class="feature-chip">🎲 随机事件</span>
          <span class="feature-chip">🎴 技能卡</span>
          <span class="feature-chip">✨ 特殊人物</span>
          <span class="feature-chip">🎬 轨迹回放</span>
        </div>
      </div>
      <div class="entry-card">
        ${code ? `<div class="resume-card"><span style="font-size:20px">🎟️</span><div class="grow">你正在加入房间<br><b class="mono" style="letter-spacing:.16em;color:var(--accent)">${code}</b> · 输入昵称后加入</div></div>` : ''}
        ${last && !code && last.code ? `<button class="resume-card" data-act="resume" style="width:100%;text-align:left"><span style="font-size:20px">⏪</span><div class="grow">继续上次的房间<br><b class="mono" style="letter-spacing:.12em;color:var(--accent)">${esc(last.code)}</b> ${esc(last.name || '')}</div><span style="color:var(--dim)">→</span></button>` : ''}
        <div class="entry-label">你的昵称</div>
        <input id="nickname" class="name-input" maxlength="12" placeholder="例如：小明" value="${esc(savedName)}" autocomplete="nickname">
        <div class="entry-actions">
          <button class="btn lg" data-act="create-room">创建房间</button>
          <button class="btn ghost lg" data-act="join-room">加入房间</button>
        </div>
        <div class="join-row">
          <input id="join-code" inputmode="numeric" maxlength="6" placeholder="6 位房间号" value="${esc(code)}">
          <button class="btn line" data-act="join-with-code" style="flex:none;padding:0 16px">进入</button>
        </div>
        <button class="scan-btn" data-act="open-scanner"><span>▣</span> 扫二维码加入房间</button>
        <button class="scan-btn card-qr-entry" data-act="card-qr" data-scope="global"><span>🎴</span> 生成技能卡二维码 · 所有房间通用</button>
        <button class="scan-btn guide-entry" data-act="guide"><span>📖</span> 游戏说明 · 玩法 / 身份 / 技能</button>
        <div class="entry-foot"><span>无需局域网</span><span>手机浏览器直接玩</span><span>最多 40 人</span></div>
      </div>
      <div class="landing-footer"><span>猎名场 v1.0</span><span>GPS 仅在游戏期间共享</span></div>
    </div>
  </div>`;
  const nameInput = $('#nickname');
  if (nameInput) nameInput.addEventListener('change', () => storageSet('nt.name', nameInput.value.trim()));
  if (message) setTimeout(() => toast(message, 'warn', 3500), 250);
  if (code && !loadSession(code)) {
    setTimeout(() => nameInput?.focus(), 350);
  }
}

async function submitEntry(mode) {
  const name = ($('#nickname')?.value || '').trim();
  if (!name) { toast('先给自己取个昵称', 'warn'); $('#nickname')?.focus(); return; }
  storageSet('nt.name', name);
  let code = '';
  if (mode === 'join') {
    code = ($('#join-code')?.value || S.pendingJoinCode || '').replace(/\D/g, '').slice(0, 6);
    if (code.length !== 6) { toast('请输入 6 位房间号', 'warn'); $('#join-code')?.focus(); return; }
  }
  showLoading(mode === 'create' ? '正在创建房间…' : '正在加入房间…');
  try {
    let data;
    if (mode === 'create') {
      data = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name }) });
      S.qrVersion = Date.now();
    } else {
      data = await api(`/api/rooms/${code}/join`, { method: 'POST', body: JSON.stringify({ name }) });
    }
    const cred = { code: data.code, playerId: data.playerId, token: data.token, name: data.playerName || name };
    connectSocket(cred, { initial: true });
  } catch (e) {
    renderLanding(code, e.message || '进入失败');
  }
}

function connectSocket(cred, { initial = false } = {}) {
  if (S.socket) { S.socket.removeAllListeners(); S.socket.disconnect(); }
  S.creds = cred;
  saveSession(cred);
  setRoomUrl(cred.code);
  S.state = null;
  S.everConnected = false;
  S.initializing = true;
  S.screen = initial ? 'loading' : S.screen;
  if (initial) {
    if (S.bootTimer) clearTimeout(S.bootTimer);
    S.bootTimer = setTimeout(() => {
      if (S.screen === 'loading') {
        renderLanding(cred.code, '连接超时，请检查网络后重试');
      }
    }, 12000);
  }
  const socket = window.io({
    auth: { code: cred.code, playerId: cred.playerId, token: cred.token },
    reconnection: true,
    reconnectionDelay: 700,
    reconnectionDelayMax: 4000,
    timeout: 9000,
  });
  S.socket = socket;

  socket.on('connect', () => {
    S.everConnected = true;
    S.initializing = false;
    $('#offline-bar')?.classList.remove('show');
    $('#net-dot')?.classList.remove('dot-off');
    if (S.bootTimer) { clearTimeout(S.bootTimer); S.bootTimer = null; }
  });

  socket.on('state', (st) => {
    if (S.bootTimer) { clearTimeout(S.bootTimer); S.bootTimer = null; }
    S.initializing = false;
    onState(st);
  });

  socket.on('positions', (payload) => {
    if (!state()) return;
    applyPositions(payload);
  });

  socket.on('feed', (item) => {
    if (!state()) return;
    if (!state().feed.some((f) => f.id === item.id)) {
      state().feed.push(item);
      if (state().feed.length > 100) state().feed.splice(0, state().feed.length - 100);
    }
    updateChatDot();
    if (S.game.sheet === 'chat') updateChatList();
  });

  socket.on('chat', (msg) => {
    if (!state()) return;
    if (!state().chat.some((c) => c.id === msg.id)) state().chat.push(msg);
    if (state().chat.length > 120) state().chat.splice(0, state().chat.length - 120);
    if (S.game.sheet === 'chat') {
      updateChatList(true);
    } else {
      S.unreadChat += 1;
      updateChatDot();
    }
  });

  socket.on('notify', (n) => handleNotify(n));
  socket.on('action_result', (r) => {
    if (!r) return;
    if (r.ok === false) toast(r.message || '操作失败', 'bad', 3200);
    else if (r.message) toast(r.message, 'good', 1800);
  });
  socket.on('game_error', () => { /* action_result 已提示 */ });
  socket.on('game_ended', () => { if (state()) showResult(); });
  socket.on('kicked', (d) => {
    const code = S.creds?.code;
    clearSession(code);
    renderLanding('', d?.message || '你被移出了房间');
  });
  socket.on('room_dissolved', (d) => {
    const code = S.creds?.code;
    clearSession(code);
    renderLanding('', d?.message || '房间已解散');
  });

  socket.on('disconnect', () => {
    $('#offline-bar')?.classList.add('show');
    $('#net-dot')?.classList.add('dot-off');
  });

  socket.on('connect_error', (err) => {
    const msg = err?.message || '连接失败';
    if (!S.everConnected) {
      const authError = /房间不存在|身份验证|过期/.test(msg);
      if (authError) {
        const code = S.creds?.code;
        if (code) clearSession(code);
        renderLanding(code || S.pendingJoinCode, msg);
      } else if (S.initializing) {
        S.initializing = false;
        toast('连接失败：' + msg + '，正在重试…', 'bad', 3000);
      }
    }
  });
}

/* ================= OUT 淘汰播报 ================= */

let outQueue = [];
let outShowing = false;
let outTimer = null;

function detectOuts(st) {
  const before = S.aliveSnapshot;
  if (before) {
    for (const p of st.players) {
      if (p.role === 'photographer') continue;
      if (before.get(p.id) === true && p.alive === false) queueOut(p.name);
    }
  }
  S.aliveSnapshot = new Map(st.players.map((p) => [p.id, !!p.alive]));
}

function queueOut(name) {
  if (!name) return;
  outQueue.push(name);
  if (!outShowing) showNextOut();
}

function showNextOut() {
  if (!outQueue.length) { outShowing = false; return; }
  if (S.screen !== 'game' && S.screen !== 'result') { outQueue = []; outShowing = false; return; }
  const name = outQueue.shift();
  const el = $('#out-screen');
  const nameEl = $('#out-name');
  if (!el || !nameEl) { outShowing = false; return; }
  outShowing = true;
  nameEl.textContent = name;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  if (me()?.role === 'admin') {
    playCue('rip');
    speakOut(name);
  }
  clearTimeout(outTimer);
  outTimer = setTimeout(() => {
    el.classList.remove('show');
    outTimer = setTimeout(() => { outShowing = false; showNextOut(); }, 220);
  }, 3400);
}

function speakOut(name) {
  if (!S.sound || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(`${name}，OUT`);
    u.lang = 'zh-CN';
    u.rate = 0.92;
    u.pitch = 0.82;
    u.volume = 1;
    const voices = window.speechSynthesis.getVoices?.() || [];
    const zh = voices.find((v) => /zh[-_]?(CN|Hans)|Chinese|中文/i.test(`${v.lang} ${v.name}`));
    if (zh) u.voice = zh;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch { /* 某些浏览器不支持语音，只保留大屏 */ }
}

function clearOuts() {
  outQueue = [];
  outShowing = false;
  clearTimeout(outTimer);
  $('#out-screen')?.classList.remove('show');
  try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
}

/* ================= state routing ================= */

function onState(st) {
  const prev = S.state;
  S.state = st;
  S.offset = st.serverNow - Date.now();
  S.initializing = false;
  storageSet('nt.name', st.me.name);
  if (S.creds) { S.creds.name = st.me.name; saveSession(S.creds); }

  if (st.status === 'lobby') {
    S.aliveSnapshot = null;
    clearOuts();
    if (S.screen !== 'lobby') {
      teardownGame();
      removeResult();
      closeAdminPanel();
      closeAllSheets();
      S.screen = 'lobby';
    }
    renderLobby();
    return;
  }

  detectOuts(st);

  if (S.screen !== 'game' || !S.game.mounted) {
    S.screen = 'game';
    mountGame();
  }
  updateGame();
  if (st.status === 'ended') showResult();
}

function applyPositions(payload) {
  if (!state()) return;
  if (!payload || !Array.isArray(payload.players)) return;
  state().revealAll = !!payload.revealAll;
  const present = new Set();
  for (const pos of payload.players) {
    const p = state().players.find((x) => x.id === pos.id);
    if (!p) continue;
    p.lat = pos.lat; p.lng = pos.lng; p.acc = pos.acc; p.ts = pos.ts;
    p.alive = pos.alive;
    present.add(p.id);
    if (p.isMe) {
      state().me.pos = { lat: pos.lat, lng: pos.lng, acc: pos.acc, ts: pos.ts };
      if (typeof pos.lat === 'number') {
        S.gps.lastPos = { lat: pos.lat, lng: pos.lng, acc: pos.acc, ts: pos.ts };
      }
    }
  }
  refreshVisibilityLocal(present);
  $('#map-loading')?.classList.add('hidden');
  if (S.game.map) {
    S.game.map.update(state().players, state().me.id, { revealAll: state().revealAll });
  }
  renderStatusChips();
  updateEventPeek();
}

/* ================= lobby ================= */

function roleBadge(role, label) {
  const map = { admin: 'admin', player: 'player', photographer: 'photographer', special: 'special' };
  const defs = S.meta?.roles || {};
  return `<span class="badge ${map[role] || ''}">${esc(label || defs[role]?.name || role)}</span>`;
}

function renderLobby() {
  if (!state()) return;
  const st = state();
  const isAdmin = st.me.isAdmin;
  const players = st.players;
  const online = players.filter((p) => p.online).length;
  const canStart = players.length >= 2;
  const readyCount = Number(st.readyCount) || 0;
  const readyTotal = Number(st.readyTotal) || 0;
  const allReady = !!st.allReady;
  const invite = `${location.origin}/?room=${st.code}`;
  app.innerHTML = `
  <div class="screen">
    <div class="topbar">
      <button class="icon-btn" data-act="leave-room">←</button>
      <div class="grow">
        <div class="topbar-title">${isAdmin ? '你的战场' : '等待开始'}</div>
        <div class="topbar-sub">${isAdmin ? '房间已就绪，等人到齐就开撕' : '房主正在准备游戏'}</div>
      </div>
      ${isAdmin ? '<span class="badge admin">管理员</span>' : ''}
    </div>
    <div class="page">
      <div class="card">
        <div class="code-hero">
          <div class="code-box">
            <div class="code-label">ROOM CODE</div>
            <div class="room-code">${esc(st.code)}</div>
            <div class="small muted">扫码或输入房间号加入</div>
            <div class="share-row">
              <button class="btn tiny-btn line" data-act="copy-invite">复制邀请</button>
              <button class="btn tiny-btn ghost" data-act="share-invite">分享</button>
            </div>
          </div>
          <div class="qr-box"><img src="/api/rooms/${st.code}/qr?v=${S.qrVersion}" alt="房间二维码"></div>
        </div>
      </div>

      <div class="card">
        <div class="card-title"><span>玩家 <span class="count">${players.length} 人 · ${online} 在线</span></span></div>
        ${players.map((p) => playerRow(p, st, isAdmin)).join('')}
        ${players.length < 2 ? '<div class="empty" style="padding:16px 8px"><span class="big">👥</span>至少 2 人才能开始，把二维码发给同学吧</div>' : ''}
      </div>

      ${isAdmin ? `
      <div class="card">
        <div class="card-title"><span>房间设置</span><span class="count">仅管理员可见</span></div>
        <div class="field">
          <label>游戏时长</label>
          <div class="chip-row">
            ${[30, 45, 60, 90].map((m) => `<button class="choice ${st.settings.durationMin === m ? 'on' : ''}" data-act="duration" data-v="${m}">${m} 分钟</button>`).join('')}
            <input type="number" min="5" max="180" value="${st.settings.durationMin}" data-change="setting-number" data-k="durationMin" style="width:82px;padding:7px 9px;font-size:12px" aria-label="自定义时长">
          </div>
        </div>
        <div class="field">
          <label>开局准备时间</label>
          <div class="chip-row">
            ${[0, 5, 10, 15, 20].map((m) => `<button class="choice ${Number(st.settings.prepMin) === m ? 'on' : ''}" data-act="prep-min" data-v="${m}">${m === 0 ? '无' : m + ' 分钟'}</button>`).join('')}
            <input type="number" min="0" max="30" value="${st.settings.prepMin}" data-change="setting-number" data-k="prepMin" style="width:82px;padding:7px 9px;font-size:12px" aria-label="自定义准备时间">
          </div>
          <div class="small muted" style="margin-top:6px;line-height:1.6">准备期间所有人位置可见、身份隐藏，不能撕名牌或做任务；全员准备就绪后 10 秒自动开始。</div>
        </div>
        <div class="switch-row">
          <div><div class="t">自动随机事件</div><div class="d">每隔一段时间随机挑一名玩家派发任务</div></div>
          <button class="switch ${st.settings.autoEvents ? 'on' : ''}" data-act="toggle-setting" data-k="autoEvents"></button>
        </div>
        ${st.settings.autoEvents ? `<div class="settings-grid" style="padding:2px 0 8px">
          <div class="field"><label>最短间隔（分钟）</label><input type="number" min="2" max="60" value="${st.settings.eventMinMin}" data-change="setting-number" data-k="eventMinMin"></div>
          <div class="field"><label>最长间隔（分钟）</label><input type="number" min="3" max="90" value="${st.settings.eventMaxMin}" data-change="setting-number" data-k="eventMaxMin"></div>
        </div>` : ''}
        <div class="switch-row">
          <div><div class="t">撕名牌距离校验</div><div class="d">只有靠近到指定距离内才能撕，防远程误报</div></div>
          <select class="role-select" data-change="setting-number" data-k="ripRange">
            ${[[0, '不校验'], [20, '20 米'], [30, '30 米'], [50, '50 米'], [100, '100 米']].map(([v, l]) => `<option value="${v}" ${st.settings.ripRange === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <div class="switch-row">
          <div><div class="t">锁定房间</div><div class="d">锁定后新玩家不能加入</div></div>
          <button class="switch ${st.settings.locked ? 'on' : ''}" data-act="toggle-setting" data-k="locked"></button>
        </div>
        <div class="switch-row">
          <div><div class="t">特殊人物数量</div><div class="d">开局随机分配，身份公开；每人一个可复用技能（有冷却）</div></div>
          <select class="role-select" data-change="setting-number" data-k="specialCount">
            ${[0, 1, 2, 3, 4, 5, 6].map((v) => `<option value="${v}" ${Number(st.settings.specialCount) === v ? 'selected' : ''}>${v} 人</option>`).join('')}
          </select>
        </div>
        <button class="list-btn" data-act="card-qr" data-scope="room" style="margin-top:4px">
          <span class="li">🎴</span>
          <span class="grow">技能卡二维码<br><span class="tiny muted">开局前生成，玩家扫码核销领卡</span></span>
          <span class="arrow">生成 →</span>
        </button>
      </div>` : ''}

      <div class="card tight">
        <div class="card-title"><span>身份配置</span><span class="count">${isAdmin ? `特殊人物：${st.settings.specialCount} 人` : '特殊人物身份开局公开'}</span></div>
        <div class="small muted" style="line-height:1.7">
          🛠️ <b>管理员</b> 全权控制　🏷️ <b>玩家</b> 撕名牌活到最后<br>
          📷 <b>摄影</b> 看到所有人、记录精彩瞬间　✨ <b>特殊人物</b> 拥有特殊技能（有冷却）
        </div>
      </div>

      <div class="card tight">
        <div class="card-title"><span>玩法速览</span></div>
        <ul class="rule-list">
          <li>准备阶段位置全员可见、身份隐藏；正式开局后位置隐藏、身份公开。</li>
          <li>最后 <b>15 分钟</b> 全员位置自动暴露，倒计时变红抖动。</li>
          <li>管理员可设置 <b>0–6 名特殊人物</b>，开局随机分配并公开身份。</li>
          <li>最后一名存活的玩家立即获胜；时间到则存活的玩家一起获胜。</li>
          <li><b>复活卡</b> 让两人共生：一人被撕，两人一起淘汰。</li>
          <li>赛后可以查看并保存所有人的轨迹回放。</li>
        </ul>
      </div>
    </div>
    <div class="lobby-actions">
      <div class="ready-summary">${isAdmin ? '本房准备' : '你的准备状态'} <b>${readyCount}/${readyTotal}</b> · ${allReady ? '全员已准备' : `${Math.max(0, readyTotal - readyCount)} 人未准备`}</div>
      <div class="lobby-actions-inner">
        ${isAdmin
          ? `<button class="btn lg" data-act="start-game" ${canStart && allReady ? '' : 'disabled'}>${allReady ? '开始游戏' : '等待全员准备'} · ${st.settings.durationMin}分</button>
             <button class="btn lg force-btn" data-act="start-game" data-force="1" ${canStart ? '' : 'disabled'}>强制开始</button>`
          : `<button class="btn lg block ${st.me.ready ? 'ready-btn-on' : ''}" data-act="toggle-ready">${st.me.ready ? '已准备就绪 · 点击取消' : '准备就绪'}</button>`}
      </div>
      ${!isAdmin && allReady ? '<div class="ready-note">全员已准备，等管理员开始</div>' : ''}
    </div>
    <div id="toasts-inline"></div>
  </div>`;
}

function playerRow(p, st, isAdmin) {
  const isMe = p.isMe;
  const maySeeRole = isAdmin || isMe;
  const role = maySeeRole ? p.role : null;
  const roleOptions = ['player', 'photographer', 'admin'];
  return `<div class="player-row">
    <div class="avatar" style="--c:${PALETTE[(p.colorIndex || 0) % PALETTE.length]}">${esc(initials(p.name))}</div>
    <div class="player-main">
      <div class="player-name">${esc(p.name)} ${isMe ? '<span class="badge gold">你</span>' : ''} ${role ? roleBadge(role) : '<span class="badge">身份隐藏</span>'}
        ${st.status === 'lobby' && p.role !== 'admin' ? `<span class="badge ${p.ready ? 'ready' : 'notready'}">${p.ready ? '已准备' : '未准备'}</span>` : ''}</div>
      <div class="player-meta"><span class="dot-live ${p.online ? '' : 'dot-off'}"></span>${p.online ? '在线' : '离线'}${p.alive === false ? ' · 已淘汰' : ''}</div>
    </div>
    ${isAdmin && st.status === 'lobby' ? `<select class="role-select" data-change="role" data-id="${p.id}">
      ${roleOptions.map((r) => `<option value="${r}" ${p.role === r ? 'selected' : ''}>${S.meta.roles[r]?.name || r}</option>`).join('')}
    </select>` : ''}
  </div>`;
}

async function copyInvite() {
  const st = state();
  if (!st) return;
  const text = `来玩撕名牌！房间号 ${st.code}\n${location.origin}/?room=${st.code}`;
  try { await copyText(text); toast('邀请链接已复制', 'good'); } catch { toast('复制失败，请手动分享链接', 'warn'); }
}

async function shareInvite() {
  const st = state();
  if (!st) return;
  const url = `${location.origin}/?room=${st.code}`;
  const data = { title: '猎名场 · 撕名牌', text: `来加入我的撕名牌房间：${st.code}`, url };
  if (navigator.share) {
    try { await navigator.share(data); return; } catch { /* cancelled */ }
  }
  try { await copyText(`${data.text}\n${url}`); toast('邀请链接已复制', 'good'); } catch { toast('分享失败', 'warn'); }
}

/* ================= game shell ================= */

function mountGame() {
  if (!state()) return;
  if (S.game.mounted) return;
  const m = me();
  S.screen = 'game';
  S.unreadChat = 0;
  app.innerHTML = `
  <div class="game">
    <div id="map"></div>
    <div class="map-loading" id="map-loading"><div class="spinner"></div><div>正在获取定位…</div></div>
    <div class="map-vignette"></div>
    <header class="hud">
      <div class="hud-top">
        <div class="hud-left">
          <div class="room-chip"><span class="r">ROOM</span><span class="c">${esc(state().code)}</span></div>
          <span class="chip" style="padding:4px 6px"><span class="dot-live" id="net-dot"></span></span>
        </div>
        <div class="timer-card" id="timer-card">
          <div class="timer-label" id="timer-label">剩余时间</div>
          <div class="timer" id="timer">--:--</div>
        </div>
        <div class="hud-right">
          <button class="icon-btn" id="btn-sound" data-act="toggle-sound" aria-label="声音">${S.sound ? '🔊' : '🔇'}</button>
          <button class="icon-btn accent ${m.isAdmin ? '' : 'hidden'}" id="btn-admin" data-act="open-admin" aria-label="管理">🛠️</button>
        </div>
      </div>
      <div class="hud-status">
        <span class="chip" id="alive-chip">存活 —</span>
        <span class="chip" id="reveal-chip">位置隐藏</span>
        <span class="chip" id="gps-chip">定位中</span>
        <span class="chip" id="role-chip">${esc(S.meta.roles[m.role]?.icon || '')} ${esc(S.meta.roles[m.role]?.name || '')}</span>
      </div>
      <div class="alert-banner" id="alert-banner"></div>
    </header>

    <div class="prep-panel" id="prep-panel">
      <div class="prep-kicker"><span class="dot-live"></span> 准备阶段 · 位置全员可见 · 身份隐藏</div>
      <div class="prep-clock" id="prep-clock">--:--</div>
      <div class="prep-note" id="prep-note">不能撕名牌、不能做任务；所有人就绪后 10 秒自动开始。</div>
      <div class="prep-ready-line" id="prep-ready-line"></div>
      <div class="prep-actions">
        <button class="btn prep-ready-btn" id="prep-ready-btn" data-act="prep-ready">准备就绪</button>
        <button class="btn ghost prep-skip-btn" id="prep-skip-btn" data-act="prep-skip">跳过准备</button>
      </div>
    </div>

    <div class="map-tools">
      <button class="icon-btn" data-act="recenter" aria-label="回到我的位置">◎</button>
      <button class="icon-btn" data-act="map-settings" aria-label="地图设置">🗺️</button>
    </div>

    <div class="hidden-hint" id="hidden-hint">定位中…</div>
    <div class="event-peek" id="event-peek" data-act="open-sheet" data-tab="tasks"></div>

    <div class="fab-col" id="fab-col">
      <button class="fab fab-rip" id="btn-rip" data-act="open-rip">撕<small>名牌</small></button>
      <button class="fab fab-cards" id="btn-cards" data-act="open-sheet" data-tab="cards">🎴<span class="count-bubble" id="card-count">0</span></button>
    </div>

    <div class="tabbar" id="game-tabbar">
      <button class="active" data-act="game-tab" data-tab="map"><span class="ti">🗺️</span>地图</button>
      <button data-act="game-tab" data-tab="chat"><span class="ti">💬</span>聊天<i class="tab-dot" id="chat-dot" style="display:none"></i></button>
      <button data-act="game-tab" data-tab="tasks"><span class="ti">🎯</span>任务</button>
      <button data-act="game-tab" data-tab="me"><span class="ti">👤</span>我</button>
    </div>

    <div class="sheet-backdrop" id="sheet-backdrop" data-act="close-sheet"></div>
    <div class="sheet" id="sheet">
      <div class="sheet-grip"></div>
      <div class="sheet-head">
        <div class="sheet-title" id="sheet-title"></div>
        <button class="close-btn" data-act="close-sheet">✕</button>
      </div>
      <div class="sheet-body" id="sheet-body"></div>
    </div>

    <div class="offline-bar" id="offline-bar">连接断开，正在重连…</div>
    <div class="gps-warning" id="gps-warning">
      <span id="gps-warning-text">定位未开启</span>
      <button data-act="retry-gps">重新定位</button>
    </div>
  </div>`;
  S.game.mounted = true;
  document.body.classList.add('in-game');

  setTimeout(() => {
    if (!state() || S.screen !== 'game') return;
    if (!window.L) { toast('地图组件加载失败，请刷新页面', 'bad', 5000); return; }
    try {
      S.game.map = new GameMap($('#map'), {
        provider: S.mapPrefs.provider,
        gcj: S.mapPrefs.gcj,
        onMarkerClick: showPlayerCard,
        onMapClick: () => { if (S.game.sheet) closeSheet(); },
      });
      S.game.map.update(state().players, state().me.id, { revealAll: state().revealAll });
    } catch (e) {
      console.error(e);
      toast('地图初始化失败：' + e.message, 'bad', 5000);
    }
  }, 30);

  startGps();
  requestWakeLock();
  tickClock();
}

function teardownGame() {
  clearOuts();
  document.body.classList.remove('in-game', 'preparing');
  stopGps();
  releaseWakeLock();
  if (S.game.map) { S.game.map.destroy(); S.game.map = null; }
  S.game.mounted = false;
  S.game.sheet = null;
  document.body.classList.remove('low-time', 'sheet-open');
}

function updateGame() {
  if (!state() || !S.game.mounted) return;
  updateHUD();
  updateEventPeek();
  if (S.game.map) {
    S.game.map.update(state().players, state().me.id, { revealAll: state().revealAll });
  }
  refreshOpenSheet();
  if (S.game.adminOpen) renderAdminPanel();
}

function updateHUD() {
  if (!state() || !S.game.mounted) return;
  const st = state();
  const m = me();
  const alive = st.players.filter((p) => p.alive).length;
  $('#alive-chip').innerHTML = `存活 <b>${alive}</b>/${st.players.length}`;
  const roleChip = $('#role-chip');
  if (roleChip) {
    if (st.identityHidden || (st.status === 'preparing' && !m.isAdmin)) {
      roleChip.className = 'chip';
      roleChip.innerHTML = '🎭 身份隐藏';
    } else {
      roleChip.className = 'chip';
      roleChip.innerHTML = `${esc(S.meta.roles[m.role]?.icon || '')} ${esc(S.meta.roles[m.role]?.name || '')}${m.role === 'special' ? ' · 特殊技能' : ''}`;
    }
  }
  renderStatusChips();
  const btnSound = $('#btn-sound');
  if (btnSound) btnSound.textContent = S.sound ? '🔊' : '🔇';
  const btnAdmin = $('#btn-admin');
  if (btnAdmin) btnAdmin.classList.toggle('hidden', !m.isAdmin);
  const fab = $('#fab-col');
  if (fab) fab.classList.toggle('hidden', !m.alive || m.role === 'photographer' || st.status === 'ended' || st.status === 'preparing');
  const cc = $('#card-count');
  if (cc) cc.textContent = String((m.cards || []).length);
  const mapLoading = $('#map-loading');
  if (mapLoading) {
    const hasPos = !!S.gps.lastPos || !!S.gps.error || st.players.some((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    mapLoading.classList.toggle('hidden', hasPos);
  }
  tickClock();
}

function renderStatusChips() {
  if (!state() || !S.game.mounted) return;
  const st = state();
  const m = me();
  const revealChip = $('#reveal-chip');
  const hidden = st.players.filter((p) => p.alive && !p.visible && !p.isMe).length;
  if (revealChip) {
    if (st.status === 'preparing') {
      revealChip.className = 'chip';
      revealChip.innerHTML = '👁️ 准备阶段 · 位置可见';
    } else if (st.revealAll) {
      revealChip.className = 'chip red';
      revealChip.innerHTML = '👁️ 全员显形';
    } else if (m.isAdmin || m.role === 'photographer') {
      revealChip.className = 'chip';
      revealChip.innerHTML = '👁️ 全图视野';
    } else {
      revealChip.className = 'chip';
      revealChip.innerHTML = `🫥 <b>${hidden}</b> 人隐藏`;
    }
  }
  const gpsChip = $('#gps-chip');
  if (gpsChip) {
    if (S.gps.error) { gpsChip.className = 'chip red'; gpsChip.innerHTML = '📍 定位异常'; }
    else if (S.gps.lastPos) { gpsChip.className = 'chip good'; gpsChip.innerHTML = `📍 ±${Math.round(S.gps.lastPos.acc || 0)}m`; }
    else { gpsChip.className = 'chip'; gpsChip.innerHTML = '📍 定位中'; }
  }
  const hint = $('#hidden-hint');
  if (hint) {
    if (st.status === 'ended') hint.textContent = '🏁 游戏结束';
    else if (st.status === 'preparing') hint.innerHTML = '👁️ 准备阶段 · 所有人位置可见 · 身份隐藏';
    else if (st.revealAll) hint.innerHTML = '👁️ 所有人位置已公开';
    else hint.innerHTML = `🫥 ${hidden} 人位置隐藏 · 最后 15 分钟全员显形`;
  }
  const timerCard = $('#timer-card');
  const timerLabel = $('#timer-label');
  if (timerCard && timerLabel) {
    const remaining = st.status === 'playing' ? Math.max(0, st.endsAt - serverNow()) : 0;
    const low = st.status === 'playing' && remaining <= 15 * 60000;
    timerCard.classList.toggle('low', low);
    timerLabel.textContent = low ? '全员显形 · 位置公开' : (st.status === 'ended' ? '游戏结束' : '剩余时间');
    document.body.classList.toggle('low-time', low);
    const banner = $('#alert-banner');
    if (banner && low) {
      if (!S.bannerUntil || Date.now() > S.bannerUntil) {
        banner.className = 'alert-banner show';
        banner.textContent = '🚨 全体位置已公开 · 倒计时结束后幸存者获胜';
      }
    }
  }
  const dot = $('#chat-dot');
  if (dot) dot.style.display = S.unreadChat > 0 ? 'block' : 'none';
}

function updateEventPeek() {
  if (!state() || !S.game.mounted) return;
  const el = $('#event-peek');
  if (!el) return;
  const active = (me()?.events || [])
    .filter((e) => e.status === 'pending' || e.status === 'active')
    .sort((a, b) => a.deadline - b.deadline);
  if (state().status !== 'playing' || !active.length) { el.classList.remove('show'); return; }
  const e = active[0];
  el.classList.add('show');
  el.innerHTML = `<div class="ico">${esc(e.icon)}</div>
    <div class="grow"><div class="t">${esc(e.title)}${active.length > 1 ? ` <span class="dim">+${active.length - 1}</span>` : ''}</div>
    <div class="d ellipsis">${esc(e.short || e.desc)}</div></div>
    <div class="time" data-deadline="${e.deadline}">--:--</div>`;
  tickCountdowns();
}

function tickClock() {
  if (S.screen !== 'game' || !state() || !S.game.mounted) return;
  const st = state();
  if (st.status === 'preparing') { updatePrepClock(st); return; }
  document.body.classList.remove('preparing');
  $('#prep-panel')?.classList.remove('show', 'urgent');
  const remaining = st.status === 'playing' ? Math.max(0, st.endsAt - serverNow()) : 0;
  const timer = $('#timer');
  if (timer) timer.textContent = st.status === 'ended' ? '00:00' : fmtTime(remaining);
  const timerCard = $('#timer-card');
  const low = st.status === 'playing' && remaining > 0 && remaining <= 15 * 60000;
  if (timerCard) timerCard.classList.toggle('low', low);
  if (document.body.classList.contains('low-time') !== low) {
    document.body.classList.toggle('low-time', low);
    if (low) renderStatusChips();
  }
  const label = $('#timer-label');
  if (label) label.textContent = st.status === 'ended' ? '游戏结束' : (low ? '全员显形 · 位置公开' : '剩余时间');
  if (low) {
    const minute = Math.ceil(remaining / 60000);
    if (S.lowVibrateMinute !== minute && remaining > 0) {
      S.lowVibrateMinute = minute;
      if (S.haptics) vibrate([28, 50, 28]);
    }
    const banner = $('#alert-banner');
    if (banner && (!S.bannerUntil || Date.now() > S.bannerUntil) && !banner.classList.contains('show')) {
      banner.className = 'alert-banner show';
      banner.textContent = '🚨 全体位置已公开 · 倒计时结束后幸存者获胜';
    }
  } else {
    S.lowVibrateMinute = null;
    const banner = $('#alert-banner');
    if (banner && st.status !== 'ended' && (!S.bannerUntil || Date.now() > S.bannerUntil)) banner.classList.remove('show');
  }
  tickCountdowns();
  tickSpecialCooldownUI();
}

function tickSpecialCooldownUI() {
  const st = state();
  if (!st || st.status !== 'playing') return;
  const m = me();
  const sk = m?.specialSkill;
  if (!sk) return;
  const cd = Math.max(0, (sk.cooldownUntil || 0) - serverNow());
  const ready = cd <= 0;
  $$('[data-special-cd]').forEach((el) => {
    el.textContent = ready ? '可以使用' : `冷却中 ${fmtTime(cd)}`;
  });
  const key = `${sk.type}:${ready}`;
  if (S._specialReadyKey === key) return;
  S._specialReadyKey = key;
  if (S.game.sheet === 'tasks' || S.game.sheet === 'me') renderSheet(S.game.sheet);
}

function updatePrepClock(st) {
  const remaining = Math.max(0, (st.prepEndsAt || 0) - serverNow());
  const urgent = remaining <= 10000;
  document.body.classList.add('preparing');
  const panel = $('#prep-panel');
  if (panel) {
    panel.classList.add('show');
    panel.classList.toggle('urgent', urgent);
  }
  const clock = $('#prep-clock');
  if (clock) clock.textContent = fmtTime(remaining);
  const timer = $('#timer');
  if (timer) timer.textContent = fmtTime(remaining);
  const label = $('#timer-label');
  if (label) label.textContent = '准备阶段';
  const timerCard = $('#timer-card');
  if (timerCard) timerCard.classList.remove('low');
  document.body.classList.remove('low-time');
  const banner = $('#alert-banner');
  if (banner) { banner.classList.remove('show'); S.bannerUntil = 0; }
  const readyLine = $('#prep-ready-line');
  if (readyLine) {
    readyLine.textContent = st.prepAccelerated || urgent
      ? `全员就绪 · ${Math.max(1, Math.ceil(remaining / 1000))} 秒后开始`
      : `已准备 ${st.readyCount || 0}/${st.readyTotal || 0}${st.readyTotal ? ` · 还差 ${Math.max(0, (st.readyTotal || 0) - (st.readyCount || 0))} 人` : ''}`;
    readyLine.classList.toggle('urgent', urgent);
  }
  const note = $('#prep-note');
  if (note) {
    note.textContent = st.prepAccelerated || urgent
      ? '倒计时结束后身份公开、位置隐藏，游戏正式开始'
      : '不能撕名牌、不能做任务；所有人就绪后 10 秒自动开始。';
  }
  const readyBtn = $('#prep-ready-btn');
  const skipBtn = $('#prep-skip-btn');
  const m = me();
  if (readyBtn) {
    readyBtn.classList.toggle('hidden', !!m?.isAdmin);
    readyBtn.textContent = m?.ready ? '已准备就绪' : '准备就绪';
    readyBtn.disabled = !!(st.prepAccelerated && m?.ready);
  }
  if (skipBtn) skipBtn.classList.toggle('hidden', !m?.isAdmin);
  tickCountdowns();
}

function tickCountdowns() {
  const t = serverNow();
  $$('[data-deadline]').forEach((el) => {
    const dl = Number(el.dataset.deadline);
    if (!dl) return;
    const left = Math.max(0, dl - t);
    el.textContent = fmtTime(left);
    el.classList.toggle('red', left < 60000);
  });
  $$('[data-peek-deadline]').forEach((el) => {
    const dl = Number(el.dataset.peekDeadline);
    if (!dl) return;
    el.textContent = fmtTime(Math.max(0, dl - t));
  });
  const st = state();
  if (st?.status === 'preparing') {
    const left = Math.max(0, (st.prepEndsAt || 0) - t);
    $$('[data-prep-countdown]').forEach((el) => { el.textContent = fmtTime(left); });
  }
}

function serverNow() { return Date.now() + S.offset; }

/* ================= bottom sheet ================= */

const SHEET_TITLES = { chat: '战场频道', tasks: '任务与事件', me: '我的状态', cards: '技能卡' };

function openSheet(tab) {
  if (!S.game.mounted) return;
  if (tab === 'map') { closeSheet(); return; }
  if (tab === 'cards' && me()?.role === 'photographer') { /* 摄影师也能看 */ }
  S.game.sheet = tab;
  if (tab === 'chat') S.unreadChat = 0;
  const sheet = $('#sheet');
  const backdrop = $('#sheet-backdrop');
  const title = $('#sheet-title');
  if (title) title.innerHTML = SHEET_TITLES[tab] || '面板';
  sheet?.classList.add('open');
  backdrop?.classList.add('show');
  renderSheet(tab);
  setTabActive(tab);
  updateChatDot();
}

function closeSheet() {
  if (!S.game.sheet) return;
  S.game.sheet = null;
  $('#sheet')?.classList.remove('open');
  $('#sheet-backdrop')?.classList.remove('show');
  setTabActive('map');
  setTimeout(() => {
    if (!S.game.sheet) {
      const body = $('#sheet-body');
      if (body) { body.className = 'sheet-body'; body.innerHTML = ''; }
    }
  }, 250);
}

function closeAllSheets() {
  S.game.sheet = null;
  $('#sheet')?.classList.remove('open');
  $('#sheet-backdrop')?.classList.remove('show');
  setTabActive('map');
}

function setTabActive(tab) {
  $$('#game-tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
}

function updateChatDot() {
  const dot = $('#chat-dot');
  if (dot) dot.style.display = S.unreadChat > 0 ? 'block' : 'none';
}

function refreshOpenSheet() {
  const tab = S.game.sheet;
  if (!tab) return;
  if (tab === 'chat') { updateChatList(); return; }
  const preserve = {};
  $$('#sheet-body input, #sheet-body textarea').forEach((el) => {
    if (el.id) preserve[el.id] = el.value;
  });
  renderSheet(tab);
  for (const [id, val] of Object.entries(preserve)) {
    const el = document.getElementById(id);
    if (el) el.value = val;
  }
}

function renderSheet(tab) {
  const body = $('#sheet-body');
  if (!body) return;
  body.className = 'sheet-body';
  if (tab === 'chat') {
    body.classList.add('chat-body');
    body.innerHTML = chatSheetHTML();
    updateChatList(true);
    const input = $('#chat-input');
    if (input) {
      if (S.chatDraft) input.value = S.chatDraft;
      input.addEventListener('input', () => { S.chatDraft = input.value; });
      input.addEventListener('focus', () => { setTimeout(() => input.scrollIntoView({ block: 'center', behavior: 'smooth' }), 320); });
    }
  } else if (tab === 'tasks') {
    body.innerHTML = tasksSheetHTML();
  } else if (tab === 'me') {
    body.innerHTML = meSheetHTML();
  } else if (tab === 'cards') {
    body.innerHTML = cardsSheetHTML();
  }
  const title = $('#sheet-title');
  if (tab === 'tasks') {
    const active = (me()?.events || []).filter((e) => e.status === 'pending' || e.status === 'active').length;
    title.innerHTML = `任务与事件 ${active ? `<span class="sub">${active} 个进行中</span>` : ''}`;
  } else if (tab === 'me') {
    title.innerHTML = `我的状态 <span class="sub">${esc(me()?.name || '')}</span>`;
  } else if (tab === 'cards') {
    title.innerHTML = `技能卡 <span class="sub">${(me()?.cards || []).length} 张</span>`;
  }
}

/* ================= chat ================= */

function chatSheetHTML() {
  return `<div class="chat-list" id="chat-list"></div>
  <div class="quick-row">
    <button data-act="quick-chat" data-text="我在操场这边">我在操场这边</button>
    <button data-act="quick-chat" data-text="小心，有人在这边！">小心，有人在这边！</button>
    <button data-act="quick-chat" data-text="救命！">救命！</button>
    <button data-act="quick-chat" data-text="谁看到特殊人物了？">谁看到特殊人物了？</button>
  </div>
  <form class="chat-input-bar" id="chat-form">
    <input id="chat-input" maxlength="140" placeholder="说点什么…" autocomplete="off">
    <button type="submit" aria-label="发送">↑</button>
  </form>`;
}

function chatItems() {
  if (!state()) return [];
  const items = [
    ...(state().chat || []).map((c) => ({ ...c, _kind: 'chat' })),
    ...(state().feed || []).map((f) => ({ ...f, _kind: 'feed' })),
  ];
  return items.sort((a, b) => a.at - b.at).slice(-100);
}

function updateChatList(force = false) {
  const list = $('#chat-list');
  if (!list) return;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 100;
  const my = me();
  const items = chatItems();
  if (!items.length) {
    list.innerHTML = '<div class="empty" style="margin:auto"><span class="big">💬</span>还没有消息<br>打个招呼，或者报告你看到的情况</div>';
    return;
  }
  list.innerHTML = items.map((item) => {
    if (item._kind === 'feed') {
      return `<div class="sysmsg ${esc(item.kind || '')}">${esc(item.text)}</div>`;
    }
    const isMe = item.fromId === my?.id;
    const p = state().players.find((x) => x.id === item.fromId);
    const color = PALETTE[(p?.colorIndex || 0) % PALETTE.length];
    return `<div class="msg ${isMe ? 'me' : ''} ${item.alive === false ? 'dead' : ''}">
      ${isMe ? '' : `<div class="who"><span style="color:${color}">${esc(item.name)}</span></div>`}
      <div class="bubble">${esc(item.text)}</div>
      <div class="time">${fmtClock(item.at)}</div>
    </div>`;
  }).join('');
  if (force || nearBottom) list.scrollTop = list.scrollHeight;
}

function sendChat() {
  const input = $('#chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  if (!S.socket || !S.socket.connected) { toast('连接已断开，消息没有发出', 'bad'); return; }
  S.socket.emit('chat', { text });
  input.value = '';
  S.chatDraft = '';
  input.focus();
}

/* ================= tasks sheet ================= */

function taskCardHTML(e) {
  const active = e.status === 'pending' || e.status === 'active';
  const isCustom = e.type === 'custom' || e.custom;
  const statusText = e.status === 'done' ? '已完成' : e.status === 'failed' ? (isCustom ? '未完成' : '已超时') : '';
  return `<div class="task-card ${isCustom ? 'custom' : ''} ${e.status === 'done' ? 'done' : e.status === 'failed' ? 'failed' : ''}">
    <div class="task-head">
      <div class="task-ico">${esc(e.icon || (isCustom ? '📝' : '🎲'))}</div>
      <div class="grow">
        <div class="task-title">${esc(e.title)} ${isCustom ? '<span class="badge gold">管理员任务</span>' : ''} ${statusText ? `<span class="badge">${statusText}</span>` : ''}</div>
        <div class="task-desc">${esc(e.desc)}</div>
        ${active ? `<div class="task-foot">
          <span class="task-timer" data-deadline="${e.deadline || 0}">${e.deadline ? '--:--' : '无期限'}</span>
          ${e.distance !== null && e.distance !== undefined ? `<span class="badge">距离 ${fmtKm(e.distance)}</span>` : ''}
          ${e.targetName ? `<span class="badge">目标：${esc(e.targetName)}</span>` : ''}
          ${e.code ? `<span class="witness-code">#${esc(e.code)}</span>` : ''}
        </div>` : ''}
      </div>
    </div>
    ${e.type === 'team' && e.status === 'active' ? '<div class="task-desc" style="color:var(--gold)">组队计时中，坚持住！</div>' : ''}
    ${isCustom && e.status !== 'done' ? `<div class="task-foot"><span class="tiny muted">${e.witness ? '把见证码给同学输入即可完成，管理员也可手动判定' : '由管理员确认完成或失败'}</span></div>` : ''}
  </div>`;
}

function tasksSheetHTML() {
  const m = me();
  const st = state();
  const events = m?.events || [];
  const active = events.filter((e) => e.status === 'pending' || e.status === 'active');
  const history = events.filter((e) => e.status === 'done' || e.status === 'failed');
  const special = m?.role === 'special' ? m.specialSkill : null;
  const specialCd = special ? Math.max(0, (special.cooldownUntil || 0) - serverNow()) : 0;
  const specialReady = !!special && specialCd <= 0;
  if (st.status === 'preparing') {
    return `<div class="card tight prep-task-card">
      <div class="task-head">
        <div class="task-ico">⏳</div>
        <div class="grow"><div class="task-title">准备阶段</div><div class="task-desc">所有人位置可见，身份暂时隐藏；不能撕名牌或做任务。全员准备就绪后 10 秒自动开始。</div></div>
      </div>
      <div class="prep-task-count" data-prep-countdown>--:--</div>
      <div class="small muted center">${st.readyCount || 0}/${st.readyTotal || 0} 已准备</div>
      <div class="row" style="gap:8px;margin-top:10px">
        ${m.isAdmin ? `<button class="btn block" data-act="prep-skip">跳过准备，立即开始</button>` : `<button class="btn block ${m.ready ? 'ready-btn-on' : ''}" data-act="prep-ready">${m.ready ? '已准备就绪' : '准备就绪'}</button>`}
      </div>
    </div>`;
  }
  return `
  ${special ? `
    <div class="card tight special-card">
      <div class="row">
        <div style="font-size:28px">${esc(special.icon || '✨')}</div>
        <div class="grow"><div style="font-size:14px;font-weight:900">✨ 特殊技能 · ${esc(special.name)}</div>
          <div class="tiny muted">${esc(special.desc)}</div></div>
        <span class="badge ${specialReady ? 'gold' : ''}" data-special-cd>${specialReady ? '可以使用' : `冷却 ${fmtTime(specialCd)}`}</span>
      </div>
      <div class="tiny muted" style="margin-top:6px">每局可多次使用，每次用后冷却 ${Math.round((special.cooldownMs || 180000) / 60000)} 分钟。</div>
      ${specialReady
        ? `<button class="btn block" style="margin-top:10px" data-act="special-open">使用 ${esc(special.name)}</button>`
        : `<button class="btn block" style="margin-top:10px" disabled data-special-cd>冷却中 ${fmtTime(specialCd)}</button>`}
    </div>` : ''}

  ${st.status === 'playing' ? `
    <div class="card tight" style="background:linear-gradient(135deg,rgba(200,255,61,.08),rgba(255,255,255,.02))">
      <div class="row">
        <div style="font-size:24px">🙌</div>
        <div class="grow"><div style="font-size:13px;font-weight:800">见证别人的任务</div><div class="tiny muted">同学把 4 位见证码给你，输入即完成见证</div></div>
      </div>
      <div class="row" style="margin-top:9px">
        <input id="witness-code" inputmode="numeric" maxlength="4" placeholder="4 位见证码" style="flex:1;font-family:var(--mono);letter-spacing:.3em;text-align:center;font-size:18px" value="${esc(S.witnessDraft || '')}">
        <button class="btn" data-act="confirm-code" style="flex:none">确认</button>
      </div>
    </div>` : ''}

  <div class="card-title" style="margin-top:14px"><span>🎲 我的任务与事件</span><span class="count">${active.length} 个进行中</span></div>
  ${active.length ? active.map((e) => taskCardHTML(e)).join('') : `<div class="empty"><span class="big">🎯</span>${st.status === 'playing' ? '暂时没有任务，留意随机事件、管理员任务和聊天' : '本局没有进行中的事件'}</div>`}
  ${history.length ? `<div class="card-title" style="margin-top:14px"><span>历史</span></div>${history.slice(-4).map((e) => taskCardHTML(e)).join('')}` : ''}

  ${m?.role === 'photographer' ? `
    <button class="list-btn" data-act="record-moment"><span class="li">📸</span><span class="grow">记录一个精彩瞬间<br><span class="tiny muted">会出现在赛后轨迹回放里</span></span><span class="arrow">→</span></button>` : ''}
  <div class="small dim" style="margin-top:14px;line-height:1.7">提示：特殊人物身份开局公开，技能每局可多次使用，每次用后冷却 3 分钟。管理员可以给个人或全体发布自定义任务，并在控制台确认完成。</div>
  `;
}

/* ================= me sheet ================= */

function meSheetHTML() {
  const m = me();
  const st = state();
  if (!m) return '';
  const alive = m.alive;
  const role = S.meta.roles[m.role] || { name: m.role, icon: '❓', desc: '' };
  const effects = [];
  const now = serverNow();
  if (m.effects?.ghostUntil > now) effects.push(['👻 隐身', fmtTime(m.effects.ghostUntil - now)]);
  if (m.effects?.eyeUntil > now) effects.push(['👁️ 天眼', fmtTime(m.effects.eyeUntil - now)]);
  if (m.effects?.goldenUntil > now) effects.push(['🥇 金钟罩', fmtTime(m.effects.goldenUntil - now)]);
  if (m.effects?.freezeUntil > now) effects.push(['⛓️ 被定身', fmtTime(m.effects.freezeUntil - now)]);
  if (m.effects?.trackUntil > now && m.effects.trackTargetId) {
    const target = st.players.find((p) => p.id === m.effects.trackTargetId);
    effects.push(['🎯 追踪 ' + (target?.name || ''), fmtTime(m.effects.trackUntil - now)]);
  }
  const distance = m.stats?.distance || 0;
  return `
  <div class="big-card">
    <div class="row">
      <div class="avatar" style="--c:${PALETTE[(m.colorIndex || 0) % PALETTE.length]};width:48px;height:48px;font-size:20px;border-radius:15px">${esc(initials(m.name))}</div>
      <div class="grow">
        <div style="font-size:19px;font-weight:900">${esc(m.name)}</div>
        <div class="row" style="gap:5px;margin-top:3px">
          <span class="badge ${m.role === 'special' ? 'special' : m.role === 'admin' ? 'admin' : m.role === 'photographer' ? 'photographer' : ''}">${esc(role.icon)} ${esc(role.name)}</span>
          <span class="badge ${alive ? 'online' : ''}">${alive ? '在场上' : '已淘汰'}</span>
          ${m.role === 'special' ? '<span class="badge gold">特殊人物</span>' : ''}
        </div>
      </div>
    </div>
    <div class="task-desc" style="margin-top:9px">${esc(role.desc)}</div>
    ${m.bondName ? `<div class="effect-line" style="color:var(--gold)"><span>💫 共生搭档</span><b>${esc(m.bondName)}</b></div>` : ''}
    ${m.revivedByName ? `<div class="effect-line"><span>被复活者不能撕</span><b>${esc(m.revivedByName)}</b></div>` : ''}
    ${m.revivedPlayerName ? `<div class="effect-line"><span>你复活了</span><b>${esc(m.revivedPlayerName)}</b></div>` : ''}
  </div>

  <div class="stat-grid" style="margin-bottom:10px">
    <div class="stat"><div class="v">${m.stats?.rips || 0}</div><div class="k">撕掉</div></div>
    <div class="stat"><div class="v">${fmtKm(distance).replace(' km','').replace(' m','')}</div><div class="k">${distance >= 1000 ? '公里' : '米'}</div></div>
    <div class="stat"><div class="v">${m.stats?.eventsDone || 0}</div><div class="k">事件</div></div>
    <div class="stat"><div class="v">${m.stats?.cardsUsed || 0}</div><div class="k">用卡</div></div>
  </div>

  ${effects.length ? `<div class="card tight"><div class="card-title"><span>生效中</span></div>${effects.map(([k, v]) => `<div class="effect-line"><span>${esc(k)}</span><b class="mono">${v}</b></div>`).join('')}</div>` : ''}

  <div class="card tight">
    <div class="card-title"><span>操作</span></div>
    <button class="list-btn" data-act="open-sheet" data-tab="cards"><span class="li">🎴</span><span class="grow">我的技能卡 <span class="tiny muted">${(m.cards || []).length} 张</span></span><span class="arrow">→</span></button>
    ${st.status === 'playing' && m.alive ? `<button class="list-btn" data-act="redeem-card"><span class="li">📷</span><span class="grow">扫码核销技能卡<br><span class="tiny muted">扫描管理员发放的二维码，立即获得对应卡牌</span></span><span class="arrow">→</span></button>` : ''}
    ${m.role === 'special' && m.specialSkill ? (() => {
      const cd = Math.max(0, (m.specialSkill.cooldownUntil || 0) - serverNow());
      const ready = cd <= 0;
      const used = m.specialSkill.usesUsed || 0;
      return `<button class="list-btn" ${ready ? 'data-act="special-open"' : 'disabled'}><span class="li">${esc(m.specialSkill.icon)}</span><span class="grow">特殊技能 · ${esc(m.specialSkill.name)}<br><span class="tiny muted" data-special-cd>${ready ? (used ? `本局已用 ${used} 次 · 可以使用` : '本局可以使用') : `冷却中 ${fmtTime(cd)}`}</span></span><span class="arrow">→</span></button>`;
    })() : ''}
    ${m.role === 'photographer' ? `<button class="list-btn" data-act="record-moment"><span class="li">📸</span><span class="grow">记录精彩瞬间</span><span class="arrow">→</span></button>` : ''}
    <button class="list-btn" data-act="map-settings"><span class="li">🗺️</span><span class="grow">地图与定位设置</span><span class="arrow">→</span></button>
    <button class="list-btn" data-act="toggle-sound"><span class="li">${S.sound ? '🔊' : '🔇'}</span><span class="grow">声音提示 <span class="tiny muted">${S.sound ? '开' : '关'}</span></span><span class="arrow">→</span></button>
    <button class="list-btn" data-act="toggle-vibrate"><span class="li">📳</span><span class="grow">手机振动 <span class="tiny muted">${S.haptics ? '开' : '关'}</span></span><span class="arrow">→</span></button>
    ${m.isAdmin ? `<button class="list-btn" data-act="open-admin"><span class="li">🛠️</span><span class="grow">管理员控制台</span><span class="arrow">→</span></button>` : ''}
    ${st.status === 'ended' ? `<a class="list-btn" href="${replayHref()}" target="_blank" rel="noopener"><span class="li">🎬</span><span class="grow">查看轨迹回放</span><span class="arrow">→</span></a>` : ''}
    <button class="list-btn danger" data-act="leave-room"><span class="li">🚪</span><span class="grow">退出房间</span><span class="arrow">→</span></button>
  </div>

  <div class="small dim" style="text-align:center;padding:8px 0 2px">房间 ${esc(st.code)} · ${esc(st.status === 'playing' ? '游戏进行中' : '已结束')}</div>
  `;
}

/* ================= cards ================= */

function cardsSheetHTML() {
  const m = me();
  const cards = m?.cards || [];
  if (!cards.length) {
    return `<div class="empty"><span class="big">🎴</span>还没有技能卡<br>完成随机事件或等待管理员发放</div>
    <div class="small dim" style="line-height:1.8;padding:0 6px">技能卡包括复活、护盾、隐身、天眼、追踪、金钟罩、曝光、顺手牵羊。复活卡会让被复活者和使用者共生：一人被撕，两人一起淘汰。</div>`;
  }
  return `<div class="card-grid">
    ${cards.map((c) => {
      const def = S.meta.cards[c.type] || { name: c.type, icon: '🎴', desc: '', tone: '' };
      const passive = def.use === 'passive';
      return `<div class="skill-card">
        <div class="si">${esc(def.icon)}</div>
        <div class="sn">${esc(def.name)}</div>
        <div class="sd">${esc(def.desc)}</div>
        ${passive
          ? '<div class="use" style="color:var(--muted)">被撕时自动生效</div>'
          : `<button class="use ready" data-act="use-card" data-id="${c.id}">使用</button>`}
      </div>`;
    }).join('')}
  </div>
  <div class="small dim" style="margin-top:14px;line-height:1.7">复活卡选择已淘汰玩家；追踪/曝光/顺手牵羊选择存活玩家；金钟罩等对自己立即生效。</div>`;
}

function replayHref() {
  if (!state() || !S.creds) return '#';
  return `/replay.html?code=${encodeURIComponent(state().code)}&playerId=${encodeURIComponent(S.creds.playerId)}&token=${encodeURIComponent(S.creds.token)}`;
}

/* ================= actions ================= */

function bindGlobalEvents() {
  document.addEventListener('pointerdown', () => { ensureAudio(); }, { passive: true });
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (el.tagName === 'A' && act !== 'noop') { /* 让默认链接行为保留 */ }
    if (el.tagName === 'BUTTON') e.preventDefault();
    handleAction(act, el, e).catch((err) => {
      console.error(err);
      toast(err.message || '操作失败', 'bad');
    });
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-change]');
    if (!el) return;
    const kind = el.dataset.change;
    if (kind === 'role') {
      S.socket?.emit('admin:setRole', { targetId: el.dataset.id, role: el.value });
    } else if (kind === 'role-modal') {
      S.socket?.emit('admin:setRole', { targetId: el.dataset.id, role: el.value });
      closeModal();
    } else if (kind === 'custom-preset') {
      const preset = HAPPY_VALLEY_TASKS.find((t) => t.id === el.value);
      if (!preset) return;
      const title = $('#custom-title');
      const desc = $('#custom-desc');
      const minutes = $('#custom-minutes');
      const witness = $('#custom-witness');
      if (title) title.value = preset.title;
      if (desc) desc.value = preset.desc;
      if (minutes) minutes.value = preset.minutes;
      if (witness) witness.checked = true;
    } else if (kind === 'setting-number') {
      const key = el.dataset.k;
      let value = Number(el.value);
      if (!Number.isFinite(value)) return;
      if (key === 'durationMin') value = clamp(Math.round(value), 5, 180);
      if (key === 'prepMin') value = clamp(Math.round(value), 0, 30);
      const patch = { [key]: value };
      S.socket?.emit('admin:settings', { patch });
    } else if (kind === 'card-qr-type') {
      if (S.cardQr) {
        S.cardQr.type = el.value;
        S.cardQr.items = [];
        renderCardQrModal();
      }
    } else if (kind === 'card-qr-count') {
      if (S.cardQr) {
        S.cardQr.count = clamp(Math.round(Number(el.value) || 1), 1, 30);
        S.cardQr.items = [];
        renderCardQrModal();
      }
    } else if (kind === 'card-qr-name') {
      if (S.cardQr) {
        S.cardQr.showName = !!el.checked;
        renderCardQrModal();
      }
    }
  });
  document.addEventListener('submit', (e) => {
    if (e.target.id === 'chat-form') {
      e.preventDefault();
      sendChat();
    }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'chat-input') S.chatDraft = e.target.value;
    if (e.target.id === 'witness-code') S.witnessDraft = e.target.value;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (modalRoot.classList.contains('show')) closeModal();
      else if (S.game.sheet) closeSheet();
    }
  });
}

async function handleAction(act, el, event) {
  switch (act) {
    case 'close-modal': closeModal(); break;
    case 'modal-bg':
      if (event?.target === el) closeModal();
      break;
    case 'create-room': await submitEntry('create'); break;
    case 'join-room': await submitEntry('join'); break;
    case 'join-with-code': await submitEntry('join'); break;
    case 'resume': {
      const last = storageGet('nt.last', null);
      if (last) { showLoading('正在回到房间 ' + last.code); connectSocket(last, { initial: true }); }
      break;
    }
    case 'open-scanner': openScanner(); break;
    case 'redeem-card': openScanner('card'); break;
    case 'guide': openGameGuide(); break;
    case 'card-qr': openCardQrModal(el.dataset.scope === 'global' ? 'global' : 'room'); break;
    case 'card-qr-scope': openCardQrModal(el.dataset.scope === 'global' ? 'global' : 'room'); break;
    case 'card-qr-generate': generateCardQr(); break;
    case 'card-qr-save': saveCardQr(); break;
    case 'close-scanner': stopScanner(); break;
    case 'copy-invite': await copyInvite(); break;
    case 'share-invite': await shareInvite(); break;
    case 'leave-room': confirmLeaveRoom(); break;
    case 'start-game': S.socket?.emit('admin:start', { force: el.dataset.force === '1' }); break;
    case 'toggle-ready': S.socket?.emit('player:ready', { ready: !me()?.ready }); break;
    case 'prep-ready': S.socket?.emit('player:ready', { ready: !me()?.ready }); break;
    case 'prep-skip': S.socket?.emit('admin:skipPrep'); break;
    case 'prep-min': S.socket?.emit('admin:settings', { patch: { prepMin: Number(el.dataset.v) } }); break;
    case 'duration': S.socket?.emit('admin:settings', { patch: { durationMin: Number(el.dataset.v) } }); break;
    case 'toggle-setting': {
      const k = el.dataset.k;
      const current = !!state()?.settings?.[k];
      S.socket?.emit('admin:settings', { patch: { [k]: !current } });
      break;
    }
    case 'game-tab': openSheet(el.dataset.tab); break;
    case 'open-sheet': closeModal(); openSheet(el.dataset.tab); break;
    case 'close-sheet': closeSheet(); break;
    case 'open-admin': closeModal(); openAdminPanel(); break;
    case 'close-admin': closeAdminPanel(); break;
    case 'map-settings': openMapSettings(); break;
    case 'map-provider': setMapProvider(el.dataset.v); break;
    case 'map-gcj': setGcj(el.dataset.v === '1'); break;
    case 'recenter': S.game.map?.focusSelf(); break;
    case 'open-rip': openRipModal(); break;
    case 'rip-target': {
      const target = state()?.players.find((p) => p.id === el.dataset.id);
      closeModal();
      if (!target) break;
      const d = targetDistance(target);
      confirmDialog({
        title: `撕掉 ${target.name}？`,
        text: `确认你已经在现实中撕掉了 TA 的名牌。${d !== null ? `当前距离约 ${fmtKm(d)}。` : ''}\n误报可以由管理员复活，但请尽量确认。`,
        confirmLabel: '确认撕掉', danger: true,
      }, () => S.socket?.emit('rip', { targetId: target.id }));
      break;
    }
    case 'use-card': useCard(el.dataset.id); break;
    case 'card-target': {
      const card = (me()?.cards || []).find((c) => c.id === el.dataset.card);
      closeModal();
      if (card) S.socket?.emit('useCard', { cardId: card.id, targetId: el.dataset.id });
      break;
    }
    case 'special-open': openSpecialSkill(); break;
    case 'special-target': {
      const targetId = el.dataset.id;
      closeModal();
      S.socket?.emit('special', { targetId });
      break;
    }
    case 'admin-custom': openCustomTaskModal(el.dataset.id || 'all'); break;
    case 'admin-custom-send': {
      const targetId = $('#custom-target')?.value || el.dataset.target || 'all';
      const title = $('#custom-title')?.value || '';
      const desc = $('#custom-desc')?.value || '';
      const minutes = Number($('#custom-minutes')?.value || 0);
      const needWitness = !!$('#custom-witness')?.checked;
      if (!title.trim() || !desc.trim()) { toast('标题和描述都要填', 'warn'); return; }
      closeModal();
      S.socket?.emit('admin:customTask', { targetId, title, desc, minutes, needWitness });
      toast(needWitness ? '任务已发出，任务页带见证码' : '自定义任务已发出', 'good');
      break;
    }
    case 'confirm-code': {
      const input = $('#witness-code');
      const code = (input?.value || '').replace(/\D/g, '').slice(0, 4);
      if (code.length !== 4) { toast('请输入 4 位见证码', 'warn'); input?.focus(); return; }
      S.socket?.emit('confirmCode', { code });
      break;
    }
    case 'record-moment': openMomentModal(); break;
    case 'quick-chat': S.socket?.emit('chat', { text: el.dataset.text }); break;
    case 'toggle-sound': toggleSound(); break;
    case 'toggle-vibrate': toggleHaptics(); break;
    case 'retry-gps': startGps(true); break;
    case 'notice-tasks': closeModal(); openSheet('tasks'); break;

    /* admin */
    case 'admin-player': openAdminPlayerModal(el.dataset.id); break;
    case 'admin-expose': {
      const targetId = el.dataset.id;
      const minutes = Number(el.dataset.min);
      closeModal();
      S.socket?.emit('admin:expose', { targetId, minutes });
      break;
    }
    case 'admin-give': openGiveCard(el.dataset.id); break;
    case 'admin-event': openAssignEvent(el.dataset.id); break;
    case 'admin-alive': {
      const targetId = el.dataset.id;
      const alive = el.dataset.alive === '1';
      closeModal();
      S.socket?.emit('admin:setAlive', { targetId, alive });
      break;
    }
    case 'admin-kick': {
      const targetId = el.dataset.id;
      const p = state()?.players.find((x) => x.id === targetId);
      closeModal();
      confirmDialog({
        title: `移出 ${p?.name || '玩家'}？`,
        text: 'TA 会立即断开房间。游戏进行中移出玩家可能影响战局。',
        confirmLabel: '移出房间', danger: true,
      }, () => S.socket?.emit('admin:kick', { targetId }));
      break;
    }
    case 'admin-end': openEndGame(); break;
    case 'end-winner': {
      const winner = el.dataset.winner;
      closeModal();
      if (winner === 'player') { openEndPlayerPicker(); break; }
      confirmDialog({
        title: '结束本局？',
        text: `判定为「${winner === 'draw' ? '平局' : '幸存者胜利'}」，所有玩家会立即看到结果。`,
        confirmLabel: '结束游戏', danger: true,
      }, () => S.socket?.emit('admin:end', { winner }));
      break;
    }
    case 'admin-announce': openAnnounceModal(); break;
    case 'admin-reset': {
      closeModal();
      confirmDialog({
        title: '回到大厅？',
        text: '本局结果和轨迹回放数据会被清空。建议先让所有人保存回放。',
        confirmLabel: '清空并回大厅', danger: true,
      }, () => S.socket?.emit('admin:reset'));
      break;
    }
    case 'admin-dissolve': {
      closeModal();
      confirmDialog({
        title: '解散房间？',
        text: '所有玩家会立即断开，房间数据删除。这个操作不可撤销。',
        confirmLabel: '解散房间', danger: true,
      }, () => S.socket?.emit('admin:dissolve'));
      break;
    }
    case 'admin-reveal': {
      const v = !state()?.forcedReveal;
      S.socket?.emit('admin:reveal', { value: v });
      break;
    }
    case 'admin-time': S.socket?.emit('admin:extendTime', { minutes: Number(el.dataset.min) }); break;
    case 'admin-event-result': {
      const eventId = el.dataset.id;
      const success = el.dataset.success === '1';
      closeModal();
      S.socket?.emit('admin:eventResult', { eventId, success });
      break;
    }
    case 'result-home': {
      if (S.socket) { S.socket.removeAllListeners(); S.socket.disconnect(); S.socket = null; }
      clearRoomUrl();
      renderLanding();
      break;
    }
    case 'result-reset': S.socket?.emit('admin:reset'); break;
    default:
      console.warn('unknown action', act);
  }
}

function targetDistance(p) {
  const m = me();
  const selfP = state()?.players.find((x) => x.isMe);
  const from = m?.pos || (Number.isFinite(selfP?.lat) ? { lat: selfP.lat, lng: selfP.lng } : null);
  if (!from || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return null;
  return distanceMeters(from, { lat: p.lat, lng: p.lng });
}

function confirmLeaveRoom() {
  if (me()?.isAdmin) {
    confirmDialog({
      title: '解散房间并退出？',
      text: '你是管理员。直接离开会让房间失去管理，所以这里会解散房间并断开所有玩家。如果只是想暂时离开，请不要退出，直接关闭页面即可。',
      confirmLabel: '解散并退出', danger: true,
    }, () => {
      S.socket?.emit('admin:dissolve');
    });
    return;
  }
  const playing = state()?.status === 'playing';
  confirmDialog({
    title: '退出房间？',
    text: playing
      ? '游戏还在进行中。退出后你的位置会停止更新，但角色仍留在场上。你可以从首页继续上次的房间重新进入。'
      : '退出后会回到首页，你可以从首页继续上次的房间。',
    confirmLabel: '退出',
    danger: true,
  }, () => {
    if (S.socket) { S.socket.removeAllListeners(); S.socket.disconnect(); S.socket = null; }
    clearRoomUrl();
    renderLanding();
  });
}



/* ================= modals ================= */

function openModal(html, { staticBackdrop = false } = {}) {
  modalRoot.innerHTML = `<div class="modal-backdrop" data-act="modal-bg"><div class="modal-card" ${staticBackdrop ? 'data-static="1"' : ''}>${html}</div></div>`;
  modalRoot.classList.add('show');
}

function closeModal() {
  modalRoot.classList.remove('show');
  modalRoot.innerHTML = '';
}

function closeModalIf(event, el) { if (event?.target === el) closeModal(); }

function choose(title, sub, options, onPick) {
  openModal(`<button class="modal-close" data-act="close-modal">✕</button>
    <h2>${esc(title)}</h2>
    ${sub ? `<p class="m-sub">${esc(sub)}</p>` : ''}
    <div class="opt-list">
      ${options.map((o, i) => `<button class="opt ${o.on ? 'on' : ''}" data-pick="${i}">
        <span class="oi">${esc(o.icon || '•')}</span>
        <span class="grow"><span style="font-weight:700">${esc(o.label)}</span>${o.desc ? `<span class="os" style="display:block">${esc(o.desc)}</span>` : ''}</span>
        ${o.right ? `<span class="or">${esc(o.right)}</span>` : ''}
      </button>`).join('')}
    </div>`);
  $$('[data-pick]', modalRoot).forEach((btn) => {
    btn.addEventListener('click', () => {
      const opt = options[Number(btn.dataset.pick)];
      closeModal();
      onPick?.(opt, Number(btn.dataset.pick));
    });
  });
}

function confirmDialog({ title, text, confirmLabel = '确定', cancelLabel = '取消', danger = false }, onConfirm) {
  openModal(`<button class="modal-close" data-act="close-modal">✕</button>
    <h2>${esc(title)}</h2>
    <p class="m-sub">${esc(text)}</p>
    <div class="m-actions">
      <button class="btn ghost" id="m-cancel">${esc(cancelLabel)}</button>
      <button class="btn ${danger ? 'red' : ''}" id="m-ok">${esc(confirmLabel)}</button>
    </div>`);
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-ok').addEventListener('click', () => { closeModal(); onConfirm(); });
}

function promptModal({ title, text, placeholder = '', value = '', multiline = false, confirmLabel = '确定' }, onConfirm) {
  openModal(`<button class="modal-close" data-act="close-modal">✕</button>
    <h2>${esc(title)}</h2>
    ${text ? `<p class="m-sub">${esc(text)}</p>` : ''}
    ${multiline
      ? `<textarea id="m-input" rows="3" maxlength="120" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
      : `<input id="m-input" maxlength="80" placeholder="${esc(placeholder)}" value="${esc(value)}">`}
    <div class="m-actions">
      <button class="btn ghost" id="m-cancel">取消</button>
      <button class="btn" id="m-ok">${esc(confirmLabel)}</button>
    </div>`);
  const input = $('#m-input');
  setTimeout(() => input?.focus(), 120);
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-ok').addEventListener('click', () => {
    const v = input.value.trim();
    closeModal();
    onConfirm(v);
  });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !multiline) { e.preventDefault(); $('#m-ok')?.click(); }
  });
}

function showNotice({ icon = '📣', title, text, actionLabel = '知道了', action = null }) {
  if (modalRoot.classList.contains('show')) { toast(`${title}：${text}`, 'warn', 4200); return; }
  openModal(`<button class="modal-close" data-act="close-modal">✕</button>
    <div class="notice-icon">${esc(icon)}</div>
    <h2>${esc(title)}</h2>
    <p class="m-sub">${esc(text)}</p>
    <div class="m-actions">
      <button class="btn block" id="m-notice-ok">${esc(actionLabel)}</button>
    </div>`);
  $('#m-notice-ok').addEventListener('click', () => {
    closeModal();
    action?.();
  });
}

function openMomentModal() {
  promptModal({ title: '记录精彩瞬间', text: '写一句现场描述，它会出现在赛后回放的时间轴上。', placeholder: '例如：操场东侧的追逐战', confirmLabel: '记录' }, (note) => {
    if (!note) { toast('写点什么再记录吧', 'warn'); return; }
    S.socket?.emit('moment', { note });
  });
}

/* ================= rip / cards ================= */

function openSpecialSkill() {
  const m = me();
  const st = state();
  if (!m || m.role !== 'special' || !m.specialSkill) { toast('你不是特殊人物', 'warn'); return; }
  const sk = m.specialSkill;
  const cd = Math.max(0, (sk.cooldownUntil || 0) - serverNow());
  if (cd > 0) { toast(`技能冷却中，还需 ${fmtTime(cd)}`, 'warn'); return; }
  const cdNote = `每次使用后冷却 ${Math.round((sk.cooldownMs || 180000) / 60000)} 分钟。`;
  if (sk.target === 'alive') {
    const targets = st.players.filter((p) => p.alive && !p.isMe && p.role !== 'photographer');
    if (!targets.length) { toast('没有可以选择的目标', 'warn'); return; }
    choose(`${sk.icon} ${sk.name} · 选择目标`, `${sk.desc} ${cdNote}`, targets.map((p) => ({
      label: p.name, desc: p.visible ? '位置可见' : '位置隐藏', icon: '👤',
    })), (opt, i) => {
      S.socket?.emit('special', { targetId: targets[i].id });
    });
    return;
  }
  confirmDialog({ title: `使用 ${sk.name}？`, text: `${sk.desc} ${cdNote}`, confirmLabel: '使用技能' }, () => {
    S.socket?.emit('special');
  });
}

function openCustomTaskModal(targetId) {
  const st = state();
  const current = targetId && targetId !== 'all' ? targetId : 'all';
  const targets = st.players.filter((p) => p.alive && p.role !== 'photographer');
  const targetOpts = `<option value="all" ${current === 'all' ? 'selected' : ''}>全体玩家（不含管理员）</option>` +
    targets.map((p) => `<option value="${p.id}" ${current === p.id ? 'selected' : ''}>${esc(p.name)}${p.role === 'admin' ? '（管理员）' : ''}</option>`).join('');
  openModal(`<button class="modal-close" data-act="close-modal">✕</button>
    <h2>📝 自定义任务</h2>
    <p class="m-sub">选择发给谁，填好任务；默认由管理员确认完成或失败，也可以选择生成见证码，让同学输入后自动完成。</p>
    <label class="field" style="display:block;margin-bottom:10px"><span style="font-size:12px;color:var(--muted)">发给</span>
      <select id="custom-target" class="role-select" style="width:100%;min-width:0;margin-top:6px">${targetOpts}</select>
    </label>
    <label class="field" style="display:block;margin-bottom:10px"><span style="font-size:12px;color:var(--muted)">常州欢乐谷 · 地点任务（可选，自动填好）</span>
      <select id="custom-preset" class="role-select" data-change="custom-preset" style="width:100%;min-width:0;margin-top:6px">
        <option value="">— 选一个欢乐谷任务 —</option>
        ${HAPPY_VALLEY_TASKS.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join('')}
      </select>
      <span class="tiny" style="display:block;margin-top:5px;color:var(--muted);line-height:1.45">设施名称以现场为准；只要求在安全区域打卡，不必乘坐。</span>
    </label>
    <label class="field" style="display:block;margin-bottom:10px"><span style="font-size:12px;color:var(--muted)">任务标题</span>
      <input id="custom-title" maxlength="40" placeholder="例如：找到班主任合影" style="width:100%;margin-top:6px">
    </label>
    <label class="field" style="display:block;margin-bottom:10px"><span style="font-size:12px;color:var(--muted)">任务描述</span>
      <textarea id="custom-desc" maxlength="200" rows="3" placeholder="写清楚要做什么、怎么算完成" style="width:100%;margin-top:6px;resize:vertical"></textarea>
    </label>
    <label class="field" style="display:block"><span style="font-size:12px;color:var(--muted)">限时（分钟，0 = 无期限）</span>
      <input id="custom-minutes" type="number" min="0" max="180" value="10" style="width:100%;margin-top:6px">
    </label>
    <label class="checkline" style="margin-top:12px">
      <input type="checkbox" id="custom-witness">
      <span><b>需要见证码</b><span class="tiny muted" style="display:block;margin-top:2px">生成 4 位码；任一同学在任务页输入后自动完成。不勾选则由管理员手动判定。</span></span>
    </label>
    <button class="btn block" style="margin-top:16px" data-act="admin-custom-send">发布任务</button>`);
}

function openRipModal() {
  const st = state();
  if (!st || st.status !== 'playing') return;
  const m = me();
  if (!m.alive) { toast('你已经淘汰了', 'warn'); return; }
  if (m.role === 'photographer') { toast('摄影师不能撕名牌', 'warn'); return; }
  const targets = st.players
    .filter((p) => p.alive && !p.isMe && p.role !== 'photographer')
    .map((p) => ({ p, d: targetDistance(p) }))
    .sort((a, b) => (a.d === null ? 1e9 : a.d) - (b.d === null ? 1e9 : b.d));
  if (!targets.length) { toast('场上没有可以撕的人', 'warn'); return; }
  openModal(`<button class="modal-close" data-act="close-modal">✕</button>
    <h2>⚔️ 撕名牌</h2>
    <p class="m-sub">选择你刚刚在现实中撕掉的玩家。距离超过 ${st.settings.ripRange || 0} 米会被系统拒绝（0 表示不校验）。</p>
    <div class="opt-list">
      ${targets.map(({ p, d }) => `<button class="opt" data-act="rip-target" data-id="${p.id}">
        <div class="avatar" style="--c:${PALETTE[(p.colorIndex || 0) % PALETTE.length]};width:34px;height:34px;font-size:13px">${esc(initials(p.name))}</div>
        <span class="grow"><span style="font-weight:700">${esc(p.name)}</span>
        <span class="os" style="display:block">${p.visible ? '位置可见' : '位置隐藏'}${d !== null ? ` · 距离 ${fmtKm(d)}` : ''}</span></span>
        <span class="or">撕</span>
      </button>`).join('')}
    </div>`);
}

function useCard(cardId) {
  const m = me();
  const card = (m?.cards || []).find((c) => c.id === cardId);
  if (!card) return;
  const def = S.meta.cards[card.type];
  if (!def) return;
  if (def.use === 'passive') { toast('护盾卡会在被撕时自动抵挡，无需使用', 'info'); return; }
  if (card.type === 'revive') {
    const dead = state().players.filter((p) => !p.alive && p.role !== 'photographer');
    if (!dead.length) { toast('目前没有已淘汰的玩家', 'warn'); return; }
    choose('💫 复活谁？', '复活后你们共用一条命：一人被撕，两人一起淘汰。被复活者不能撕你。', dead.map((p) => ({
      label: p.name,
      desc: '已淘汰玩家',
      icon: '🕯️',
    })), (opt, i) => {
      const target = dead[i];
      S.socket?.emit('useCard', { cardId: card.id, targetId: target.id });
    });
    return;
  }
  if (['track', 'curse', 'steal'].includes(card.type)) {
    const alive = state().players.filter((p) => p.alive && !p.isMe && p.role !== 'photographer');
    if (!alive.length) { toast('没有可以选择的目标', 'warn'); return; }
    const hints = {
      track: '5 分钟内你可以持续看到 TA 的位置。',
      curse: '让 TA 的位置暴露 3 分钟。',
      steal: '随机偷走 TA 一张未使用的技能卡；TA 没有卡时会失败。',
    };
    choose(`${def.icon} ${def.name} · 选择目标`, hints[card.type], alive.map((p) => ({
      label: p.name, desc: p.visible ? '位置可见' : '位置隐藏', icon: '👤',
    })), (opt, i) => {
      S.socket?.emit('useCard', { cardId: card.id, targetId: alive[i].id });
    });
    return;
  }
  confirmDialog({
    title: `使用${def.name}？`,
    text: def.desc,
    confirmLabel: '使用',
  }, () => S.socket?.emit('useCard', { cardId: card.id }));
}

/* ================= map settings / player card ================= */

function openMapSettings() {
  const provider = S.mapPrefs.provider || 'amap';
  const gcj = S.mapPrefs.gcj !== false;
  openModal(`<button class="modal-close" data-act="close-modal">✕</button>
    <h2>🗺️ 地图与定位</h2>
    <p class="m-sub">默认使用高德地图（自动做 WGS84→GCJ02 纠偏）。如果所有人的位置整体偏移约 500 米，请切换纠偏或地图源。</p>
    <div class="opt-list">
      <button class="opt ${provider === 'amap' ? 'on' : ''}" data-act="map-provider" data-v="amap"><span class="oi">🇨🇳</span><span class="grow"><b>高德地图</b><span class="os" style="display:block">国内加载快，适合中国大陆</span></span>${provider === 'amap' ? '<span class="or">当前</span>' : ''}</button>
      <button class="opt ${provider === 'osm' ? 'on' : ''}" data-act="map-provider" data-v="osm"><span class="oi">🌍</span><span class="grow"><b>OpenStreetMap</b><span class="os" style="display:block">无需纠偏，海外网络更稳</span></span>${provider === 'osm' ? '<span class="or">当前</span>' : ''}</button>
      <button class="opt ${provider === 'none' ? 'on' : ''}" data-act="map-provider" data-v="none"><span class="oi">▦</span><span class="grow"><b>纯网格</b><span class="os" style="display:block">不加载地图瓦片，只显示相对位置</span></span>${provider === 'none' ? '<span class="or">当前</span>' : ''}</button>
      <button class="opt ${gcj ? 'on' : ''}" data-act="map-gcj" data-v="${gcj ? '0' : '1'}"><span class="oi">🧭</span><span class="grow"><b>坐标纠偏：${gcj ? '开' : '关'}</b><span class="os" style="display:block">高德地图需要开；位置整体偏移就切换试试</span></span><span class="or">切换</span></button>
    </div>
    <div class="m-actions"><button class="btn ghost" data-act="recenter">定位到我</button><button class="btn" data-act="close-modal">完成</button></div>`);
}

function setMapProvider(provider) {
  S.mapPrefs.provider = provider;
  if (provider === 'none') S.mapPrefs.gcj = false;
  storageSet('nt.map', S.mapPrefs);
  closeModal();
  if (S.game.map) {
    S.game.map.setProvider(S.mapPrefs.provider, S.mapPrefs.gcj);
    setTimeout(() => S.game.map?.fitAll(), 120);
  }
  toast('地图源已切换', 'good');
}

function setGcj(value) {
  S.mapPrefs.gcj = value;
  storageSet('nt.map', S.mapPrefs);
  closeModal();
  if (S.game.map) {
    S.game.map.setProvider(S.mapPrefs.provider, value);
    setTimeout(() => S.game.map?.fitAll(), 120);
  }
  toast('坐标纠偏已' + (value ? '开启' : '关闭'), 'good');
}

function showPlayerCard(playerId) {
  const st = state();
  const p = st?.players.find((x) => x.id === playerId);
  if (!p) return;
  if (st.me.isAdmin) { openAdminPlayerModal(playerId); return; }
  const d = targetDistance(p);
  const role = p.role ? S.meta.roles[p.role] : null;
  openModal(`<button class="modal-close" data-act="close-modal">✕</button>
    <div class="row">
      <div class="avatar" style="--c:${PALETTE[(p.colorIndex || 0) % PALETTE.length]};width:46px;height:46px;font-size:18px">${esc(initials(p.name))}</div>
      <div class="grow"><h2 style="margin:0">${esc(p.name)}</h2><div class="small muted">${p.alive ? '在场上' : '已淘汰'} · ${p.online ? '在线' : '离线'}</div></div>
    </div>
    <p class="m-sub" style="margin-top:12px">
      ${role ? `身份：${esc(role.name)}<br>` : ''}
      ${p.visible ? `位置可见${d !== null ? ` · 距离你 ${fmtKm(d)}` : ''}` : '位置隐藏'}
      ${p.exposureActive ? '<br>正在被强制暴露位置' : ''}
    </p>
    <div class="m-actions"><button class="btn block" data-act="close-modal">关闭</button></div>`);
}

/* ================= admin panel ================= */

function openAdminPanel() {
  if (!me()?.isAdmin) { toast('只有管理员能打开控制台', 'warn'); return; }
  if (S.game.sheet) closeSheet();
  S.game.adminOpen = true;
  let el = document.getElementById('admin-panel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'admin-panel';
    el.className = 'admin-panel';
    document.body.appendChild(el);
  }
  S.adminEl = el;
  renderAdminPanel();
}

function closeAdminPanel() {
  S.game.adminOpen = false;
  document.getElementById('admin-panel')?.remove();
  S.adminEl = null;
}

function renderAdminPanel() {
  if (!S.game.adminOpen || !state()) return;
  const st = state();
  const el = document.getElementById('admin-panel');
  if (!el) return;
  const scroller = el.querySelector('.admin-scroll');
  const scrollTop = scroller?.scrollTop || 0;
  const players = [...st.players].sort((a, b) => {
    const rank = (p) => p.alive ? 2 : 5;
    return rank(a) - rank(b);
  });
  const specials = st.players.filter((p) => p.role === 'special');
  el.innerHTML = `
    <div class="admin-head">
      <button class="icon-btn" data-act="close-admin">✕</button>
      <div class="grow">
        <div class="topbar-title">管理员控制台</div>
        <div class="topbar-sub">房间 ${esc(st.code)} · 存活 ${st.players.filter((p) => p.alive).length}/${st.players.length}</div>
      </div>
      <button class="btn tiny-btn ghost" data-act="admin-announce">📢 公告</button>
    </div>
    <div class="admin-scroll">
      <div class="admin-sec">
        <h3>战况</h3>
        <div class="card tight" style="margin-bottom:0">
          <div class="between">
            <div><div class="tiny muted">剩余时间</div><div class="mono" style="font-size:24px;font-weight:900;color:var(--accent)" data-deadline="${st.endsAt || 0}">--:--</div></div>
            <div class="row" style="gap:6px">
              <button class="btn tiny-btn ghost" data-act="admin-time" data-min="-5">−5 分</button>
              <button class="btn tiny-btn ghost" data-act="admin-time" data-min="5">+5 分</button>
            </div>
          </div>
          <div class="divider"></div>
          <div class="between">
            <div><div class="tiny muted">全员显形</div><div class="small">${st.revealAll ? '已开启' : '未开启'} ${st.globalReveal ? '（最后 15 分钟自动）' : ''}</div></div>
            <button class="switch ${st.forcedReveal ? 'on' : ''}" data-act="admin-reveal"></button>
          </div>
        </div>
      </div>

      <div class="admin-sec">
        <h3>玩家 <span style="letter-spacing:0;font-weight:400">点按管理</span> <span class="count-badge" style="background:rgba(200,255,61,.12);color:var(--accent)">${st.players.filter((p) => p.online).length} 在线</span></h3>
        ${players.map((p) => `<button class="admin-player" data-act="admin-player" data-id="${p.id}">
          <div class="avatar" style="--c:${PALETTE[(p.colorIndex || 0) % PALETTE.length]}">${esc(initials(p.name))}</div>
          <div class="grow" style="text-align:left">
            <div class="nm">${esc(p.name)} ${p.isMe ? '<span class="badge gold">你</span>' : ''} ${p.role === 'special' ? '<span class="badge special">特殊人物</span>' : p.role === 'admin' ? '<span class="badge admin">管理员</span>' : p.role === 'photographer' ? '<span class="badge photographer">摄影</span>' : '<span class="badge">玩家</span>'}</div>
            <div class="mt">${p.online ? '在线' : '离线'} · ${p.alive ? '存活' : '已淘汰'} · ${(p.cards || []).filter((c) => !c.used).length} 张卡 · ${(p.events || []).filter((e) => e.status === 'pending' || e.status === 'active').length} 个事件</div>
          </div>
          <span class="arrow" style="color:var(--dim)">›</span>
        </button>`).join('')}
      </div>

      ${specials.length ? `<div class="admin-sec">
        <h3>✨ 特殊人物 <span class="count-badge">${specials.length}</span></h3>
        ${specials.map((p) => {
          const cd = p.specialSkill ? Math.max(0, (p.specialSkill.cooldownUntil || 0) - serverNow()) : 0;
          const ready = !!p.specialSkill && cd <= 0;
          const used = p.specialSkill?.usesUsed || 0;
          return `<div class="admin-event">
            <div class="between"><b>${esc(p.name)}</b><span class="badge ${ready ? 'gold' : ''}">${p.specialSkill ? `${esc(p.specialSkill.icon)} ${esc(p.specialSkill.name)}` : '特殊人物'}</span></div>
            <div class="tiny muted" style="margin-top:4px">${p.specialSkill ? `${esc(p.specialSkill.desc)} · ${ready ? '可以使用' : `冷却中 ${fmtTime(cd)}`} · 已用 ${used} 次` : ''}</div>
          </div>`;
        }).join('')}
      </div>` : ''}

      <div class="admin-sec">
        <h3>游戏控制</h3>
        <div class="card tight">
          <div class="switch-row">
            <div><div class="t">自动随机事件</div><div class="d">每隔 ${st.settings.eventMinMin}–${st.settings.eventMaxMin} 分钟随机派发</div></div>
            <button class="switch ${st.settings.autoEvents ? 'on' : ''}" data-act="toggle-setting" data-k="autoEvents"></button>
          </div>
          <div class="settings-grid" style="padding:8px 0">
            <div class="field"><label>最短间隔</label><input type="number" min="2" max="60" value="${st.settings.eventMinMin}" data-change="setting-number" data-k="eventMinMin"></div>
            <div class="field"><label>最长间隔</label><input type="number" min="3" max="90" value="${st.settings.eventMaxMin}" data-change="setting-number" data-k="eventMaxMin"></div>
          </div>
          <div class="switch-row">
            <div><div class="t">撕名牌距离校验</div><div class="d">超距会被服务器拒绝</div></div>
            <select class="role-select" data-change="setting-number" data-k="ripRange">
              ${[[0, '不校验'], [20, '20 米'], [30, '30 米'], [50, '50 米'], [100, '100 米']].map(([v, l]) => `<option value="${v}" ${st.settings.ripRange === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          <div class="admin-actions-grid" style="margin-top:10px">
            <button class="btn ghost" data-act="admin-announce">📢 发布公告</button>
            <button class="btn line" data-act="admin-custom" data-id="all">📝 自定义任务（全体）</button>
            <button class="btn line" data-act="admin-end">🏁 结束游戏</button>
          </div>
        </div>
      </div>

      <div class="admin-sec">
        <h3>危险操作</h3>
        <div class="admin-actions-grid">
          <button class="btn ghost" data-act="admin-reset" ${st.status === 'playing' ? 'disabled' : ''}>↺ 回到大厅</button>
          <button class="btn danger" data-act="admin-dissolve">解散房间</button>
        </div>
        <div class="tiny dim" style="margin-top:8px;line-height:1.6">回到大厅会清空本局轨迹，建议先让所有人保存回放。</div>
      </div>
    </div>`;
  const scroll = el.querySelector('.admin-scroll');
  if (scroll) scroll.scrollTop = scrollTop;
  tickCountdowns();
}

function openAdminPlayerModal(playerId) {
  const st = state();
  const p = st?.players.find((x) => x.id === playerId);
  if (!p) return;
  const isSelf = p.isMe;
  const roleDef = S.meta.roles[p.role] || { name: p.role, icon: '' };
  const activeEvents = (p.events || []).filter((e) => e.status === 'pending' || e.status === 'active');
  openModal(`<button class="modal-close" data-act="close-modal">✕</button>
    <div class="row">
      <div class="avatar" style="--c:${PALETTE[(p.colorIndex || 0) % PALETTE.length]};width:46px;height:46px;font-size:18px">${esc(initials(p.name))}</div>
      <div class="grow"><h2 style="margin:0">${esc(p.name)} ${isSelf ? '（你）' : ''}</h2>
      <div class="small muted">${esc(roleDef.icon)} ${esc(roleDef.name)} · ${p.online ? '在线' : '离线'} · ${p.alive ? '存活' : '已淘汰'}</div></div>
    </div>
    <div class="stat-grid" style="margin-top:12px">
      <div class="stat"><div class="v">${p.stats?.rips || 0}</div><div class="k">撕掉</div></div>
      <div class="stat"><div class="v">${Math.round((p.stats?.distance || 0) / 100) / 10}</div><div class="k">公里</div></div>
      <div class="stat"><div class="v">${p.stats?.eventsDone || 0}</div><div class="k">事件</div></div>
      <div class="stat"><div class="v">${(p.cards || []).filter((c) => !c.used).length}</div><div class="k">手牌</div></div>
    </div>
    ${st.status === 'lobby' ? `<div class="field" style="margin-top:12px"><label>身份</label><select class="role-select" style="width:100%" data-change="role-modal" data-id="${p.id}">
      ${['player', 'photographer', 'admin'].map((r) => `<option value="${r}" ${p.role === r ? 'selected' : ''}>${S.meta.roles[r]?.name || r}</option>`).join('')}
    </select></div>` : ''}
    ${activeEvents.length ? `<div class="card-title" style="margin-top:14px"><span>进行中的事件</span></div>
      ${activeEvents.map((e) => `<div class="admin-event">
        <div class="between"><b>${esc(e.icon)} ${esc(e.title)}</b><span class="tiny mono" data-deadline="${e.deadline}">--:--</span></div>
        <div class="tiny muted" style="margin:3px 0 6px">${esc(e.desc)}</div>
        <div class="row" style="gap:6px"><button class="btn tiny-btn ghost" data-act="admin-event-result" data-id="${e.id}" data-success="1">标记完成</button><button class="btn tiny-btn ghost" data-act="admin-event-result" data-id="${e.id}" data-success="0">标记失败</button></div>
      </div>`).join('')}` : ''}
    ${(p.cards || []).length ? `<div class="card-title" style="margin-top:14px"><span>手牌</span></div><div class="small muted">${p.cards.map((c) => `${S.meta.cards[c.type]?.icon || '🎴'} ${S.meta.cards[c.type]?.name || c.type}${c.used ? '（已用）' : ''}`).join('　')}</div>` : ''}
    <div class="admin-actions-grid" style="margin-top:14px">
      <button class="btn ghost" data-act="admin-expose" data-id="${p.id}" data-min="5">暴露 5 分钟</button>
      <button class="btn ghost" data-act="admin-expose" data-id="${p.id}" data-min="10">暴露 10 分钟</button>
      <button class="btn ghost" data-act="admin-expose" data-id="${p.id}" data-min="30">暴露 30 分钟</button>
      <button class="btn ghost" data-act="admin-expose" data-id="${p.id}" data-min="0">解除暴露</button>
      <button class="btn line" data-act="admin-give" data-id="${p.id}">🎁 给技能卡</button>
      <button class="btn line" data-act="admin-event" data-id="${p.id}">🎲 指派事件</button>
      <button class="btn line" data-act="admin-custom" data-id="${p.id}">📝 自定义任务</button>
      <button class="btn ${p.alive ? 'danger' : 'orange'}" data-act="admin-alive" data-id="${p.id}" data-alive="${p.alive ? '0' : '1'}">${p.alive ? '淘汰 TA' : '复活 TA'}</button>
      ${isSelf ? '' : `<button class="btn danger" data-act="admin-kick" data-id="${p.id}">移出房间</button>`}
    </div>`);
}

function openGiveCard(playerId) {
  const p = state()?.players.find((x) => x.id === playerId);
  if (!p) return;
  choose(`🎁 给 ${p.name} 发技能卡`, '技能卡会立即出现在对方手牌里。', Object.entries(S.meta.cards).map(([type, def]) => ({
    label: def.name + ' ' + def.icon,
    desc: def.desc,
    icon: def.icon,
    value: type,
  })), (opt) => {
    S.socket?.emit('admin:giveCard', { targetId: playerId, type: opt.value });
  });
}

function openAssignEvent(playerId) {
  const p = state()?.players.find((x) => x.id === playerId);
  if (!p) return;
  const opts = [{ label: '随机事件', desc: '从事件池里随机抽一个', icon: '🎲', value: '' }];
  for (const [type, def] of Object.entries(S.meta.events)) {
    if (type === 'custom') continue;
    opts.push({ label: def.name + ' ' + def.icon, desc: def.desc.replaceAll('{target}', '随机目标'), icon: def.icon, value: type });
  }
  choose(`🎲 给 ${p.name} 指派事件`, '目标玩家会立即收到任务通知。', opts, (opt) => {
    S.socket?.emit('admin:assignEvent', { targetId: playerId, type: opt.value || null });
  });
}

function openAnnounceModal() {
  promptModal({ title: '📢 发布公告', text: '所有玩家会立即收到横幅和振动提示。', placeholder: '例如：操场西侧集合', multiline: true, confirmLabel: '发送' }, (text) => {
    if (!text) { toast('公告不能为空', 'warn'); return; }
    S.socket?.emit('admin:announce', { text });
  });
}

function openEndGame() {
  choose('结束本局', '选择获胜方。结束后会立即公开身份并进入结算。', [
    { label: '幸存者胜利', desc: '所有存活玩家一起获胜（时间到或管理员判定）', icon: '🏆' },
    { label: '指定玩家获胜', desc: '用于猎杀时刻或临时判定', icon: '⭐' },
    { label: '平局', desc: '全员出局或双方协商结束', icon: '🤝' },
  ], (opt, i) => {
    if (i === 1) { openEndPlayerPicker(); return; }
    const winner = i === 2 ? 'draw' : 'good';
    confirmDialog({
      title: '确认结束？',
      text: `判定为「${winner === 'draw' ? '平局' : '幸存者胜利'}」。`,
      confirmLabel: '结束游戏', danger: true,
    }, () => S.socket?.emit('admin:end', { winner }));
  });
}

function openEndPlayerPicker() {
  const players = state()?.players || [];
  choose('选择获胜玩家', '通常是完成了「猎杀时刻」的玩家。', players.map((p) => ({
    label: p.name, desc: p.alive ? '存活' : '已淘汰', icon: p.alive ? '🏷️' : '💀', value: p.id,
  })), (opt) => {
    confirmDialog({
      title: `判定 ${opt.label} 获胜？`,
      text: '结算页会显示为个人胜利。',
      confirmLabel: '确认获胜', danger: true,
    }, () => S.socket?.emit('admin:end', { winner: 'player', playerId: opt.value }));
  });
}

/* ================= result ================= */

function showResult() {
  const st = state();
  const result = st?.result;
  if (!result || st.status !== 'ended') return;
  if (S.game.resultShown && S.game.lastEndedAt === result.at) return;
  S.game.resultShown = true;
  S.game.lastEndedAt = result.at;
  stopGps();
  if (toastsEl) toastsEl.innerHTML = '';
  $('#result-screen')?.remove();
  $('#result-confetti')?.remove();
  const winner = result.winner;
  const winnerName = winner === 'player'
    ? (result.players.find((p) => p.id === result.playerId)?.name || '玩家')
    : winner === 'draw' ? '平局' : '幸存者';
  const title = winner === 'player'
    ? `${esc(winnerName)}<br><span class="glow">获胜</span>`
    : winner === 'draw'
      ? `本局<br><span class="glow">平局</span>`
      : `幸存者<br><span class="glow">胜利</span>`;
  const survivors = result.players.filter((p) => result.survivors?.includes(p.id));
  const players = [...result.players].sort((a, b) => {
    const rank = (p) => result.survivors?.includes(p.id) ? 0 : 2;
    return rank(a) - rank(b);
  });
  const screen = document.createElement('div');
  screen.className = 'result-screen';
  screen.id = 'result-screen';
  screen.innerHTML = `<div class="result-inner">
    <div class="result-kicker">GAME OVER · ${esc(st.code)}</div>
    <div class="result-title">${title}</div>
    <div class="result-reason">${esc(result.reason || '')}</div>
    ${(result.specials || []).length ? `<div class="card tight" style="border-color:rgba(200,255,61,.28)"><div class="card-title"><span>✨ 特殊人物</span><span class="count">${result.specials.length} 人</span></div>
      ${result.specials.map((sp) => `<div class="result-player"><span class="nm">${esc(sp.name)}</span><span class="badge special">${esc(sp.skill?.icon || '✨')} ${esc(sp.skill?.name || '特殊人物')}</span><span class="result-stat">${sp.skill?.usesUsed ? `使用 ${sp.skill.usesUsed} 次` : '未使用'}</span></div>`).join('')}
    </div>` : ''}
    <div class="card tight">
      <div class="card-title"><span>本局玩家</span><span class="count">${result.players.length} 人</span></div>
      ${players.map((p) => `<div class="result-player ${p.alive ? '' : 'dead'}">
        <div class="avatar" style="--c:${PALETTE[(p.colorIndex || 0) % PALETTE.length]};width:28px;height:28px;border-radius:8px;font-size:11px">${esc(initials(p.name))}</div>
        <span class="nm">${esc(p.name)}</span>
        <span class="badge ${p.role === 'special' ? 'special' : p.role === 'admin' ? 'admin' : p.role === 'photographer' ? 'photographer' : ''}">${esc(S.meta.roles[p.role]?.name || p.role)}</span>
        <span class="result-stat">撕 ${p.stats?.rips || 0} · 走 ${fmtKm(p.stats?.distance || 0)}</span>
      </div>`).join('')}
      ${survivors.length ? `<div class="small muted" style="margin-top:9px">🏆 ${survivors.map((p) => esc(p.name)).join('、')}</div>` : ''}
    </div>
    <div class="result-actions">
      <a class="btn lg block" href="${replayHref()}" target="_blank" rel="noopener">🎬 查看轨迹回放</a>
      ${st.me.isAdmin ? `<button class="btn ghost block" data-act="result-reset">↺ 再来一局</button>` : ''}
      <button class="btn ghost block" data-act="result-home">返回首页</button>
    </div>
    <div class="small dim center" style="margin-top:12px">回放页可以导出 HTML 动画、WebM 视频和轨迹数据</div>
  </div>`;
  const confetti = document.createElement('div');
  confetti.className = 'confetti';
  confetti.id = 'result-confetti';
  for (let i = 0; i < 22; i += 1) {
    const piece = document.createElement('i');
    piece.style.left = Math.random() * 100 + 'vw';
    piece.style.background = PALETTE[i % PALETTE.length];
    piece.style.animationDuration = 2.2 + Math.random() * 2.4 + 's';
    piece.style.animationDelay = Math.random() * .8 + 's';
    piece.style.transform = `rotate(${Math.random() * 180}deg)`;
    confetti.appendChild(piece);
  }
  screen.appendChild(confetti);
  document.body.appendChild(screen);
  renderAdminPanel();
}

function removeResult() {
  $('#result-screen')?.remove();
  $('#result-confetti')?.remove();
  S.game.resultShown = false;
  S.game.lastEndedAt = null;
}

/* ================= notifications / toast ================= */

const TOAST_ICONS = {
  info: 'ℹ️', good: '✅', warn: '⚠️', bad: '⛔', rip: '💀', special: '✨',
  event: '🎲', card: '🎴', alarm: '🚨', time: '⏰', announce: '📢', start: '🏁', end: '🏆',
};

function toast(text, kind = 'info', ms = 2600, title = '') {
  if (!toastsEl) return;
  const div = document.createElement('div');
  div.className = `toast ${kind}`;
  div.innerHTML = `<div class="ti">${TOAST_ICONS[kind] || '•'}</div><div class="grow">${title ? `<div class="tt">${esc(title)}</div>` : ''}<div class="td">${esc(text)}</div></div>`;
  toastsEl.appendChild(div);
  while (toastsEl.children.length > 2) toastsEl.firstElementChild.remove();
  setTimeout(() => {
    div.classList.add('out');
    setTimeout(() => div.remove(), 220);
  }, ms);
}

function showBanner(text, tone = '', ms = 6000) {
  const el = $('#alert-banner');
  if (!el) { toast(text, tone || 'info'); return; }
  if (S.bannerTimer) clearTimeout(S.bannerTimer);
  S.bannerUntil = Date.now() + ms;
  el.className = 'alert-banner show ' + (tone || '');
  el.textContent = text;
  S.bannerTimer = setTimeout(() => {
    el.classList.remove('show');
    S.bannerUntil = 0;
    renderStatusChips();
  }, ms);
}

function handleNotify(n) {
  if (!n) return;
  const kind = n.kind || 'info';
  if (S.haptics) {
    const pat = kind === 'rip' ? [280, 80, 280] : kind === 'alarm' ? [120, 60, 120, 60, 260]
      : kind === 'event' || kind === 'special' || kind === 'card' ? [55, 40, 55]
        : kind === 'time' ? [90, 60, 90] : [25, 30, 25];
    vibrate(pat);
  }
  playCue(n.sound || kind);
  if (kind === 'custom') {
    showNotice({
      icon: '📝', title: n.title || '管理员任务', text: n.text,
      actionLabel: '去完成任务', action: () => openSheet('tasks'),
    });
    return;
  }
  if (kind === 'event') {
    showNotice({
      icon: '🎲', title: n.title || '随机事件', text: n.text,
      actionLabel: '去完成任务', action: () => openSheet('tasks'),
    });
    return;
  }
  if (kind === 'special') {
    showNotice({
      icon: '✨', title: n.title || '特殊身份', text: n.text,
      actionLabel: '查看特殊技能', action: () => openSheet('tasks'),
    });
    return;
  }
  if (kind === 'rip') {
    showNotice({ icon: '💀', title: n.title || '你被淘汰了', text: n.text });
    return;
  }
  if (kind === 'alarm') {
    showBanner('🚨 ' + n.text, '', 9000);
    toast(n.text, 'bad', 4000, n.title || '全员显形');
    return;
  }
  if (kind === 'time') {
    showBanner('⏰ ' + n.text, 'info', 6000);
    toast(n.text, 'warn', 3000, n.title || '时间提醒');
    return;
  }
  if (kind === 'announce') {
    showBanner('📢 ' + n.text, 'info', 10000);
    toast(n.text, 'info', 5000, n.title || '管理员公告');
    return;
  }
  if (kind === 'start') {
    showBanner('🏁 ' + n.text, 'good', 5000);
    toast(n.text, 'good', 3000, n.title || '游戏开始');
    return;
  }
  if (kind === 'end') return;
  toast(n.text, kind, kind === 'warn' || kind === 'bad' ? 3600 : 2600, n.title || '');
}

/* ================= gps / wake lock ================= */

function startGps(force = false) {
  if (!state() || !['playing', 'preparing'].includes(state().status)) return;
  if (!navigator.geolocation) {
    S.gps.error = '当前浏览器不支持定位';
    updateGpsWarning();
    return;
  }
  if (S.gps.watchId !== null) {
    navigator.geolocation.clearWatch(S.gps.watchId);
    S.gps.watchId = null;
  }
  S.gps.error = null;
  updateGpsWarning();
  try {
    S.gps.watchId = navigator.geolocation.watchPosition(onGpsPosition, onGpsError, {
      enableHighAccuracy: true,
      maximumAge: 2500,
      timeout: 20000,
    });
    if (force) toast('正在重新获取定位…', 'info');
  } catch (e) {
    S.gps.error = e.message;
    updateGpsWarning();
  }
}

function stopGps() {
  if (S.gps.watchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(S.gps.watchId);
  }
  S.gps.watchId = null;
}

function onGpsPosition(pos) {
  const { latitude, longitude, accuracy } = pos.coords;
  const now = Date.now();
  const prev = S.gps.lastPos;
  S.gps.lastPos = { lat: latitude, lng: longitude, acc: accuracy, ts: now };
  S.gps.error = null;
  updateGpsWarning();
  if (state()) {
    state().me.pos = { lat: latitude, lng: longitude, acc: accuracy, ts: now };
    const p = state().players.find((x) => x.isMe);
    if (p) { p.lat = latitude; p.lng = longitude; p.acc = accuracy; p.ts = now; p.visible = true; }
    S.game.map?.update(state().players, state().me.id, { revealAll: state().revealAll });
    renderStatusChips();
  }
  $('#map-loading')?.classList.add('hidden');
  const moved = prev ? distanceMeters(prev, { lat: latitude, lng: longitude }) : 1e9;
  if (S.socket?.connected && (now - S.gps.lastSent > 3500 || moved > 8)) {
    S.gps.lastSent = now;
    S.socket.emit('position', { lat: latitude, lng: longitude, acc: accuracy });
  }
}

function onGpsError(err) {
  const map = {
    1: '定位被拒绝。请在浏览器设置里允许本站获取位置，否则队友看不到你。',
    2: '暂时无法获取位置，检查一下 GPS 或移动到开阔处。',
    3: '定位超时，正在重试…',
  };
  S.gps.error = map[err.code] || err.message || '定位失败';
  $('#map-loading')?.classList.add('hidden');
  updateGpsWarning();
  renderStatusChips();
}

function updateGpsWarning() {
  const el = $('#gps-warning');
  if (!el) return;
  if (S.gps.error) {
    el.classList.add('show');
    const t = $('#gps-warning-text');
    if (t) t.textContent = S.gps.error;
  } else {
    el.classList.remove('show');
  }
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    S.wakeLock = await navigator.wakeLock.request('screen');
    S.wakeLock.addEventListener('release', () => { S.wakeLock = null; });
  } catch { /* ignore */ }
}

function releaseWakeLock() {
  try { S.wakeLock?.release(); } catch { /* ignore */ }
  S.wakeLock = null;
}

/* ================= audio ================= */

function ensureAudio() {
  if (!S.sound) return;
  try {
    if (!S.audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      S.audioCtx = new Ctx();
    }
    if (S.audioCtx.state === 'suspended') S.audioCtx.resume();
  } catch { /* ignore */ }
}

function tone(freq, delay, dur, type = 'sine', gain = 0.045) {
  const ctx = S.audioCtx;
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g); g.connect(ctx.destination);
  osc.start(t0); osc.stop(t0 + dur + 0.03);
}

function playCue(name) {
  if (!S.sound) return;
  ensureAudio();
  if (!S.audioCtx) return;
  try {
    if (name === 'alarm' || name === 'time') {
      tone(880, 0, 0.18, 'square', 0.05);
      tone(660, 0.22, 0.18, 'square', 0.05);
      tone(880, 0.44, 0.22, 'square', 0.05);
    } else if (name === 'rip') {
      tone(180, 0, 0.26, 'sawtooth', 0.07);
      tone(120, 0.2, 0.3, 'sawtooth', 0.06);
    } else if (name === 'event') {
      tone(660, 0, 0.1, 'triangle', 0.05);
      tone(880, 0.12, 0.14, 'triangle', 0.05);
    } else if (name === 'special') {
      tone(440, 0, 0.12, 'triangle', 0.05);
      tone(330, 0.14, 0.16, 'triangle', 0.05);
      tone(494, 0.32, 0.18, 'triangle', 0.05);
    } else if (name === 'good' || name === 'start') {
      tone(523, 0, 0.12, 'triangle', 0.05);
      tone(659, 0.12, 0.12, 'triangle', 0.05);
      tone(784, 0.24, 0.2, 'triangle', 0.05);
    } else if (name === 'end') {
      tone(523, 0, 0.16, 'triangle', 0.05);
      tone(659, 0.16, 0.16, 'triangle', 0.05);
      tone(784, 0.32, 0.16, 'triangle', 0.05);
      tone(1046, 0.48, 0.3, 'triangle', 0.05);
    } else if (name === 'card') {
      tone(1046, 0, 0.08, 'triangle', 0.04);
      tone(1318, 0.08, 0.12, 'triangle', 0.04);
    } else if (name === 'warn') {
      tone(440, 0, 0.16, 'square', 0.04);
      tone(440, 0.2, 0.16, 'square', 0.04);
    } else {
      tone(880, 0, 0.09, 'sine', 0.04);
    }
  } catch { /* ignore */ }
}

function toggleSound() {
  S.sound = !S.sound;
  storageSet('nt.sound', S.sound);
  const btn = $('#btn-sound');
  if (btn) btn.textContent = S.sound ? '🔊' : '🔇';
  ensureAudio();
  refreshOpenSheet();
  toast(S.sound ? '声音提示已开启' : '声音提示已关闭', 'info', 1600);
}

function toggleHaptics() {
  S.haptics = !S.haptics;
  storageSet('nt.haptics', S.haptics);
  if (S.haptics) vibrate([30, 40, 30]);
  refreshOpenSheet();
  updateHUD();
  toast(S.haptics ? '手机振动已开启' : '手机振动已关闭', 'info', 1600);
}

/* ================= QR scanner ================= */

function openScanner(mode = 'room') {
  const cardMode = mode === 'card';
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('当前浏览器不支持扫码，请用系统相机扫描二维码', 'warn', 4000);
    return;
  }
  if (!window.jsQR) { toast('扫码组件没加载出来，请刷新页面', 'warn'); return; }
  cameraRoot.innerHTML = `<div style="position:fixed;inset:0;z-index:400;background:rgba(4,6,4,.92);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px">
    <div style="width:100%;max-width:390px">
      <div class="between" style="margin-bottom:12px"><div style="font-weight:800">${cardMode ? '扫描技能卡二维码' : '扫描房间二维码'}</div><button class="icon-btn" data-act="close-scanner">✕</button></div>
      <div style="position:relative;border-radius:20px;overflow:hidden;background:#000;aspect-ratio:1">
        <video id="scan-video" playsinline muted autoplay style="width:100%;height:100%;object-fit:cover"></video>
        <div style="position:absolute;inset:14%;border:2px solid rgba(200,255,61,.8);border-radius:18px;box-shadow:0 0 0 999px rgba(0,0,0,.35)"></div>
      </div>
      <div id="scan-status" class="small muted center" style="margin-top:12px">${cardMode ? '把技能卡二维码放进框里…' : '把邀请二维码放进框里…'}</div>
      <button class="btn ghost block" style="margin-top:12px" data-act="close-scanner">取消</button>
    </div>
    <canvas id="scan-canvas" style="display:none"></canvas>
  </div>`;
  const video = $('#scan-video');
  const canvas = $('#scan-canvas');
  const status = $('#scan-status');
  let stream = null;
  navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
    .then((s) => {
      if (!document.getElementById('scan-video')) {
        s.getTracks().forEach((t) => t.stop());
        return null;
      }
      stream = s;
      S.scanner = { stream, raf: null };
      video.srcObject = s;
      return video.play();
    })
    .then(() => {
      if (!document.getElementById('scan-video')) return;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const tick = () => {
        if (!S.scanner) return;
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          if (canvas.width) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = window.jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
            if (code?.data) {
              if (cardMode) {
                const m = String(code.data).trim().match(/NAMETAG-CARD:([A-Z0-9]{10})/i);
                if (m) {
                  stopScanner();
                  const token = m[1].toUpperCase();
                  confirmDialog({
                    title: '核销这张技能卡？',
                    text: '核销后二维码立即失效，卡牌会直接进入你的手牌。确认现在领取吗？',
                    confirmLabel: '确认核销',
                  }, () => S.socket?.emit('redeemCard', { token }));
                  return;
                }
                if (status) status.textContent = '不是技能卡二维码，继续扫描…';
              } else {
                const room = parseRoomText(code.data);
                if (room) {
                  stopScanner();
                  const input = $('#join-code');
                  if (input) input.value = room;
                  S.pendingJoinCode = room;
                  toast('已识别房间号 ' + room, 'good');
                  return;
                }
                if (status) status.textContent = '识别到了内容，但不是房间二维码，继续扫描…';
              }
            }
          }
        }
        S.scanner.raf = requestAnimationFrame(tick);
      };
      S.scanner.raf = requestAnimationFrame(tick);
    })
    .catch((err) => {
      const msg = err?.name === 'NotAllowedError' ? '相机权限被拒绝，无法扫码。可以到系统设置里允许相机权限。' : '无法打开相机：' + (err.message || err.name);
      if (status) status.textContent = msg;
      toast(msg, 'warn', 4000);
    });
}

function parseRoomText(text) {
  const s = String(text || '');
  const m = s.match(/[?&#]room=(\d{6})/i) || s.match(/\b(\d{6})\b/);
  return m ? m[1] : '';
}

/* ================= 游戏说明 ================= */

function openGameGuide() {
  if (!S.meta) { toast('说明还在加载，稍等', 'warn'); return; }
  const roles = Object.entries(S.meta.roles || {});
  const cards = Object.entries(S.meta.cards || {});
  const skills = Object.entries(S.meta.specialSkills || {});
  const roleWin = {
    admin: '掌控全局，可以开始/结束游戏、发任务、发卡、复活或淘汰；管理员也可以被撕。',
    player: '撕掉别人的名牌，活到最后；被撕后出局（可被复活卡救回）。',
    photographer: '能看到所有人位置，负责记录精彩瞬间；不参与胜负，也不能被复活。',
    special: '身份开局公开，拥有特殊技能（有冷却）；胜利条件和普通玩家完全一样，最后幸存也算赢。',
  };
  const roleHtml = roles.map(([key, r]) => `<div class="guide-role">
    <div class="guide-ico">${esc(r.icon || '👤')}</div>
    <div class="grow"><div class="guide-name">${esc(r.name)} <span class="badge">${esc(r.short || '')}</span></div>
      <div class="guide-desc">${esc(roleWin[key] || r.desc || '')}</div></div>
  </div>`).join('');
  const cardHtml = cards.map(([key, c]) => `<div class="guide-card">
    <div class="guide-ico">${esc(c.icon || '🎴')}</div>
    <div class="grow"><div class="guide-name">${esc(c.name)} ${c.use === 'passive' ? '<span class="badge">被动</span>' : ''}</div>
      <div class="guide-desc">${esc(c.desc || '')}</div></div>
  </div>`).join('');
  const skillHtml = skills.map(([key, sk]) => `<div class="guide-card">
    <div class="guide-ico">${esc(sk.icon || '✨')}</div>
    <div class="grow"><div class="guide-name">${esc(sk.name)}</div>
      <div class="guide-desc">${esc(sk.desc || '')}</div></div>
  </div>`).join('');
  openModal(`<button class="modal-close" data-act="close-modal">✕</button>
    <h2>📖 游戏说明</h2>
    <p class="m-sub">第一次玩先看这里。展开每一节可以看详细规则。</p>
    <details class="guide-sec" open>
      <summary>🎮 玩法流程</summary>
      <div class="guide-body">
        <ol class="guide-steps">
          <li><b>进房</b>：创建房间或输入 6 位房间号/扫码加入，昵称会显示给所有人。</li>
          <li><b>大厅</b>：管理员可以改时长、准备时间、特殊人物数量等；所有人准备好后管理员开始，也可以强制开始。</li>
          <li><b>准备阶段</b>：默认 10 分钟（可设 0）。所有人位置可见、身份隐藏，不能撕名牌、不能做任务。所有人点“准备就绪”后，屏幕出现红色大字 10 秒倒计时并自动开局；最后 10 秒也会提示。管理员可随时跳过。</li>
          <li><b>正式游戏</b>：位置重新隐藏，身份公开。倒计时结束或只剩最后一人时本局结束；最后 15 分钟全员位置自动显形，倒计时变红抖动并提示。</li>
          <li><b>撕名牌</b>：在现实中撕掉对方后，点右下角“撕名牌”选择对方；距离校验开启时，超过设定距离会被拒绝。被撕者出局，大屏会显示“名字 OUT”。</li>
          <li><b>任务与卡牌</b>：随机事件、管理员任务、技能卡都在“任务/我”里查看；技能卡二维码由管理员开局前生成，玩家游戏内扫码核销领卡。</li>
          <li><b>赛后</b>：查看所有人的移动轨迹回放，可导出 HTML 动画、WebM 视频、JSON 数据或 PNG；管理员可清空回大厅再来一局。</li>
        </ol>
      </div>
    </details>
    <details class="guide-sec">
      <summary>🪪 身份介绍</summary>
      <div class="guide-body">${roleHtml}
        <div class="guide-note">胜负通常只看最后幸存者；摄影师不参与胜负，特殊人物和普通玩家同条件。</div>
      </div>
    </details>
    <details class="guide-sec">
      <summary>🎴 技能卡（${cards.length} 种）</summary>
      <div class="guide-body">${cardHtml}
        <div class="guide-note">复活卡会绑定两人：一人被撕两人一起淘汰，被复活者不能撕复活者。护盾卡被动抵挡一次。</div>
      </div>
    </details>
    <details class="guide-sec">
      <summary>✨ 特殊人物技能（${skills.length} 种）</summary>
      <div class="guide-body">${skillHtml}
        <div class="guide-note">每名特殊人物开局随机 1 个技能；每局可多次使用，每次用后冷却 3 分钟。身份开局公开，胜利条件和普通玩家一样。</div>
      </div>
    </details>
    <details class="guide-sec">
      <summary>📡 定位、见证码与二维码</summary>
      <div class="guide-body">
        <ul class="guide-list">
          <li><b>定位</b>：准备阶段所有人可见；正式开局后默认隐藏，靠技能、曝光或最后 15 分钟显形。管理员和摄影师始终能看到所有人。</li>
          <li><b>见证码</b>：管理员发自定义任务时可勾选“需要见证码”，任务页会显示 4 位码；任意一位同学在“任务”页输入后自动完成任务。</li>
          <li><b>技能卡二维码</b>：管理员在大厅可生成本房间专用码，或在开始页生成所有房间通用码；可一次生成多张、一键保存成一张长图打印。玩家在“我 → 扫码核销技能卡”领取，每张只能核销一次。</li>
        </ul>
      </div>
    </details>
    <div class="guide-footer">祝你们玩得开心，注意安全，别在马路和危险区域奔跑。</div>`);
}

/* ================= skill-card QR ================= */

function openCardQrModal(scope = 'room') {
  const st = state();
  const canRoom = !!(st && st.me?.isAdmin && st.status === 'lobby');
  if (scope === 'room' && !canRoom) {
    toast('只有管理员能在开局前生成本房间二维码', 'warn');
    if (!st) scope = 'global';
    else return;
  }
  const prevCount = Number(S.cardQr?.count);
  S.cardQr = {
    scope: scope === 'room' && canRoom ? 'room' : 'global',
    type: S.cardQr?.type && S.meta.cards[S.cardQr.type] ? S.cardQr.type : 'random',
    count: Number.isFinite(prevCount) ? clamp(Math.round(prevCount), 1, 30) : 4,
    showName: S.cardQr?.showName !== false,
    items: [],
    generating: false,
  };
  renderCardQrModal();
}

function renderCardQrModal() {
  const c = S.cardQr;
  if (!c || !S.meta) return;
  const st = state();
  const canRoom = !!(st && st.me?.isAdmin && st.status === 'lobby');
  const cards = Object.entries(S.meta.cards || {});
  const typeOptions = `<option value="random" ${c.type === 'random' ? 'selected' : ''}>🎲 随机（每张随机）</option>` +
    cards.map(([key, def]) => `<option value="${key}" ${c.type === key ? 'selected' : ''}>${esc(def.icon)} ${esc(def.name)}</option>`).join('');
  const items = Array.isArray(c.items) ? c.items : [];
  const preview = items.length ? `
      <div class="card-qr-batch">
        ${items.map((it, i) => `<div class="card-qr-item">
          <img src="${it.qr}" alt="技能卡二维码 ${i + 1}">
          <div class="qri-name">${c.showName ? esc(it.cardName) : '技能卡'}</div>
          <div class="qri-sub">#${i + 1} · 一次性</div>
        </div>`).join('')}
      </div>
      <div class="tiny muted center" style="margin-top:8px">共 ${items.length} 张 · 每张只能核销一次</div>
      <div class="m-actions">
        <button class="btn ghost" data-act="card-qr-generate">重新生成</button>
        <button class="btn" data-act="card-qr-save">${items.length > 1 ? `保存整版（${items.length} 张）` : '保存二维码'}</button>
      </div>
      <div class="tiny dim center" style="margin-top:10px">保存为一张长图，可直接去相册打印；二维码不要提前公开给玩家。</div>` : `
      <button class="btn block" data-act="card-qr-generate" ${c.generating ? 'disabled' : ''}>${c.generating ? '生成中…' : `生成 ${c.count} 张二维码`}</button>
      <div class="tiny dim center" style="margin-top:10px">批量生成后可一键保存为一张长图，方便打印裁切。</div>`;
  openModal(`<button class="modal-close" data-act="close-modal">✕</button>
    <h2>🎴 技能卡二维码</h2>
    <p class="m-sub">生成一次性二维码。玩家在游戏内扫码核销后，卡牌直接进入手牌，二维码立即失效。可以一次生成多张。</p>
    <div class="chip-row card-qr-scopes">
      <button class="choice ${c.scope === 'room' ? 'on' : ''}" data-act="card-qr-scope" data-scope="room" ${canRoom ? '' : 'disabled'}>本房间专用</button>
      <button class="choice ${c.scope === 'global' ? 'on' : ''}" data-act="card-qr-scope" data-scope="global">所有房间通用</button>
    </div>
    <div class="row" style="gap:10px;margin-top:12px;align-items:flex-end">
      <div class="field grow" style="margin:0"><label>卡牌类型</label>
        <select class="role-select" id="card-qr-type" data-change="card-qr-type" style="width:100%;margin-top:5px">${typeOptions}</select>
      </div>
      <div class="field" style="margin:0;width:112px"><label>数量 1–30</label>
        <input class="role-select" id="card-qr-count" data-change="card-qr-count" type="number" min="1" max="30" step="1" value="${c.count}" style="width:100%;margin-top:5px">
      </div>
    </div>
    <label class="checkline" style="margin-top:12px">
      <input type="checkbox" id="card-qr-showname" data-change="card-qr-name" ${c.showName ? 'checked' : ''}>
      <span><b>显示技能名称</b><br><span class="tiny dim">关闭后只显示“技能卡”和编号，适合给玩家盲抽</span></span>
    </label>
    <div class="small dim" style="line-height:1.6;margin:8px 0 2px">${c.scope === 'room' ? '仅本房间可用，需管理员在开局前生成。' : '所有房间通用；适合打印后带到活动现场。'}</div>
    ${preview}`);
}

/*
 * 批量二维码保存：把多张 QR 合成一张长图，方便打印裁切。
 */
async function saveQrSheet(items, showName = true) {
  const cols = 3;
  const cellW = 400;
  const cellH = 450;
  const headerH = 120;
  const footerH = 60;
  const rows = Math.ceil(items.length / cols);
  const W = cols * cellW;
  const H = headerH + rows * cellH + footerH;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#111111';
  ctx.textAlign = 'center';
  ctx.font = 'bold 34px sans-serif';
  ctx.fillText('猎名场 · 技能卡二维码', W / 2, 48);
  ctx.fillStyle = '#666666';
  ctx.font = '18px sans-serif';
  const scopeLabel = items[0]?.scope === 'room' ? `本房间专用 · ${items[0]?.roomCode || ''}` : '所有房间通用';
  ctx.fillText(`${scopeLabel} · 共 ${items.length} 张 · 每张一次性使用`, W / 2, 82);

  const images = await Promise.all(items.map((it) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('二维码图片加载失败'));
    img.src = it.qr;
  })));

  items.forEach((it, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * cellW;
    const y = headerH + row * cellH;
    ctx.strokeStyle = '#dddddd';
    ctx.lineWidth = 1;
    ctx.setLineDash([8, 8]);
    ctx.strokeRect(x + 8, y + 8, cellW - 16, cellH - 16);
    ctx.setLineDash([]);
    ctx.drawImage(images[i], x + 50, y + 34, 300, 300);
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(`#${i + 1}  ${showName ? it.cardName : '技能卡'}`, x + cellW / 2, y + 372);
    ctx.fillStyle = '#777777';
    ctx.font = '16px sans-serif';
    ctx.fillText('一次性 · 核销后失效', x + cellW / 2, y + 402);
  });
  ctx.fillStyle = '#999999';
  ctx.font = '15px sans-serif';
  ctx.fillText('沿虚线裁切 · 用「我 → 扫码核销」领取技能卡', W / 2, H - 26);

  const dataUrl = canvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `猎名场-技能卡二维码-${items.length}张.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast(`已保存 ${items.length} 张二维码长图`, 'good', 3000);
}

async function generateCardQr() {
  const c = S.cardQr;
  if (!c || c.generating) return;
  const st = state();
  if (c.scope === 'room' && (!st || !S.creds || !st.me?.isAdmin || st.status !== 'lobby')) {
    toast('只有管理员能在开局前生成本房间二维码', 'warn');
    return;
  }
  c.generating = true;
  c.data = null;
  renderCardQrModal();
  try {
    c.count = clamp(Math.round(Number(c.count) || 1), 1, 30);
    const body = { type: c.type, scope: c.scope, count: c.count, showName: !!c.showName };
    if (c.scope === 'room') {
      body.code = st.code;
      body.playerId = S.creds.playerId;
      body.token = S.creds.token;
    }
    const data = await api('/api/card-qr', { method: 'POST', body: JSON.stringify(body) });
    c.items = Array.isArray(data.items) ? data.items : [data];
    toast(`已生成 ${c.items.length} 张二维码`, 'good');
  } catch (e) {
    toast(e.message || '生成二维码失败', 'bad', 4000);
  } finally {
    c.generating = false;
    if (S.cardQr === c) renderCardQrModal();
  }
}

async function saveCardQr() {
  const items = S.cardQr?.items || [];
  if (!items.length) { toast('先生成二维码', 'warn'); return; }
  try {
    if (items.length === 1) {
      const data = items[0];
      const a = document.createElement('a');
      a.href = data.qr;
      a.download = S.cardQr?.showName === false
        ? `猎名场-技能卡-${data.scope === 'room' ? data.roomCode : '通用'}.png`
        : `猎名场-技能卡-${data.type}-${data.scope === 'room' ? data.roomCode : '通用'}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('二维码已保存，可去相册打印', 'good', 3000);
      return;
    }
    toast('正在合成整版长图…', 'good', 1500);
    await saveQrSheet(items, S.cardQr?.showName !== false);
  } catch (e) {
    toast(e.message || '保存失败，请长按单张二维码保存', 'warn');
  }
}

function stopScanner() {
  if (S.scanner) {
    try { S.scanner.raf && cancelAnimationFrame(S.scanner.raf); } catch { /* ignore */ }
    try { S.scanner.stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    S.scanner = null;
  }
  cameraRoot.innerHTML = '';
}

/* ================= visibility ================= */

function refreshVisibilityLocal(present = new Set()) {
  const st = state();
  if (!st) return;
  const m = st.me;
  const now = serverNow();
  for (const p of st.players) {
    if (p.isMe) { p.visible = true; continue; }
    if (m.isAdmin || m.role === 'photographer') { p.visible = true; continue; }
    if (!p.alive) { p.visible = false; continue; }
    if (present.has(p.id)) { p.visible = true; continue; }
    if (st.revealAll) { p.visible = true; continue; }
    if (p.exposedUntil > now) { p.visible = true; continue; }
    if (p.ghostActive) { p.visible = false; continue; }
    if (m.effects?.eyeUntil > now) { p.visible = true; continue; }
    if (m.effects?.trackTargetId === p.id && m.effects.trackUntil > now) { p.visible = true; continue; }
    if (m.bondId && m.bondId === p.id) { p.visible = true; continue; }
    p.visible = false;
  }
}


boot();
