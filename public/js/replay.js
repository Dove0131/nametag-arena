import { PALETTE, esc, fmtTime, clamp } from './util.js';

const app = document.getElementById('replay-app');
const modalRoot = document.getElementById('replay-modal');
const params = new URLSearchParams(location.search);
const CODE = (params.get('code') || '').replace(/\D/g, '').slice(0, 6);
const PLAYER = params.get('playerId') || '';
const TOKEN = params.get('token') || '';

const ROLE_NAMES = { admin: '管理员', player: '玩家', photographer: '摄影', special: '特殊人物' };

const S = {
  data: null,
  code: CODE,
  duration: 0,
  current: 0,
  playing: false,
  speed: 1,
  players: [],
  events: [],
  timeline: [],
  visible: new Set(),
  startedAt: 0,
  canvas: null,
  ctx: null,
  dpr: 1,
  w: 0,
  h: 0,
  proj: null,
  dirty: true,
  lastTs: 0,
  raf: 0,
  recording: false,
  recorder: null,
  chunks: [],
  recordTimer: null,
  recordStart: 0,
  winnerText: '',
  reason: '',
  tickerKey: '',
  reduced: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
};

function toast(text, ms = 2600) {
  let el = document.getElementById('replay-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'replay-toast';
    el.className = 'toast-replay';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

async function boot() {
  if (!CODE || !PLAYER || !TOKEN) {
    showError('链接不完整', '请从游戏结算页重新打开回放链接。');
    return;
  }
  app.innerHTML = '<div class="loading"><div class="spinner"></div>正在加载轨迹数据…</div>';
  let json;
  try {
    const res = await fetch(`/api/rooms/${CODE}/replay?playerId=${encodeURIComponent(PLAYER)}&token=${encodeURIComponent(TOKEN)}`);
    json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.error || '加载失败');
  } catch (e) {
    showError('回放加载失败', e.message || '服务器上的回放数据可能已经过期。回放数据保存在内存中，服务器重启后会丢失。');
    return;
  }
  prepare(json);
  buildUI();
  resize();
  bindEvents();
  requestAnimationFrame(loop);
  if (!S.reduced) {
    setTimeout(() => { if (!S.playing) play(); }, 700);
  } else {
    draw();
  }
}

function prepare(json) {
  S.data = json;
  const room = json.room || {};
  const startedAt = room.startedAt || Math.min(...(json.players || []).flatMap((p) => (p.path || []).map((x) => x.t)).filter(Boolean), Date.now());
  S.startedAt = startedAt;
  let maxT = 0;
  for (const p of json.players || []) {
    for (const pt of p.path || []) maxT = Math.max(maxT, pt.t - startedAt);
  }
  S.duration = Math.max(1000, room.durationMs || (room.endedAt && startedAt ? room.endedAt - startedAt : 0) || maxT || 60000);
  S.timeline = (room.timeline || []).filter((e) => Number.isFinite(e.t)).sort((a, b) => a.t - b.t);
  S.winnerText = winnerLabel(room.result, json.players || []);
  S.reason = room.result?.reason || '';

  S.players = (json.players || []).map((p, idx) => {
    let points = (p.path || [])
      .filter((pt) => Number.isFinite(pt.lat) && Number.isFinite(pt.lng) && Number.isFinite(pt.t))
      .map((pt) => ({ lat: pt.lat, lng: pt.lng, t: clamp(pt.t - startedAt, 0, S.duration) }))
      .sort((a, b) => a.t - b.t);
    if (points.length > 1400) {
      const step = Math.ceil(points.length / 1400);
      points = points.filter((_, i) => i % step === 0 || i === points.length - 1);
    }
    return {
      ...p,
      points,
      color: PALETTE[(p.colorIndex || idx) % PALETTE.length],
      roleName: ROLE_NAMES[p.role] || p.role,
      visible: true,
    };
  });
  S.players.sort((a, b) => {
    const rank = (p) => p.alive ? 1 : 2;
    return rank(a) - rank(b);
  });
  S.visible = new Set(S.players.map((p) => p.id));
  for (const p of S.players) {
    const first = p.points[0]?.t ?? 0;
    const last = p.points[p.points.length - 1]?.t ?? 0;
    if (p.points.length) S.duration = Math.max(S.duration, last);
  }
  const withCoords = S.timeline.filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lng));
  S.events = withCoords.map((e) => ({
    ...e,
    icon: e.type === 'rip' ? '⚔️' : e.type === 'moment' ? '📸' : e.type === 'special' ? '✨' : e.type === 'custom' ? '📝' : e.type === 'expose' ? '📍' : e.type === 'revive' ? '💫' : '•',
  }));
  computeBounds();
}

function winnerLabel(result, players) {
  if (!result) return '游戏结束';
  if (result.winner === 'draw') return '平局';
  if (result.winner === 'player') {
    const p = players.find((x) => x.id === result.playerId);
    return `${p?.name || '玩家'} 获胜`;
  }
  return '幸存者胜利';
}

function computeBounds() {
  const pts = [];
  for (const p of S.players) for (const pt of p.points) pts.push(pt);
  if (!pts.length) {
    S.bounds = { minLat: 30.0, maxLat: 30.002, minLng: 120.0, maxLng: 120.002 };
    return;
  }
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  const minSpan = 0.0009; // 约 100 米
  if (maxLat - minLat < minSpan) { const c = (minLat + maxLat) / 2; minLat = c - minSpan / 2; maxLat = c + minSpan / 2; }
  if (maxLng - minLng < minSpan) { const c = (minLng + maxLng) / 2; minLng = c - minSpan / 2; maxLng = c + minSpan / 2; }
  S.bounds = { minLat, maxLat, minLng, maxLng };
}

function buildUI() {
  const total = fmtTime(S.duration);
  app.innerHTML = `
  <canvas id="replay-canvas"></canvas>
  <div class="replay-top">
    <button class="icon-btn" id="btn-back" aria-label="返回">←</button>
    <div class="replay-title">
      <h1>轨迹回放 <span class="winner-pill ${S.data.room?.result?.winner === 'player' ? 'good' : ''}">${esc(S.winnerText)}</span></h1>
      <div class="sub">房间 <b>${esc(S.code)}</b> · ${S.players.length} 人 · ${esc(total)} · ${S.timeline.length} 个事件</div>
    </div>
    <button class="export-btn" id="btn-export">保存 / 导出</button>
  </div>
  <div class="legend" id="legend"></div>
  <div class="ticker" id="ticker"></div>
  <div class="rec-overlay" id="rec-overlay">
    <div class="rec-dot"></div>
    <div id="rec-text">正在录制视频…</div>
    <div class="rec-bar"><i id="rec-bar"></i></div>
  </div>
  <div class="controls">
    <div class="control-row">
      <button class="play-btn" id="btn-play" aria-label="播放">▶</button>
      <div class="seek-wrap">
        <div class="seek-labels"><span class="now" id="time-now">00:00</span><span id="time-total">${esc(total)}</span></div>
        <input id="seek" type="range" min="0" max="${Math.max(1, Math.round(S.duration))}" value="0" step="100" aria-label="进度">
      </div>
      <button class="speed-btn" id="btn-speed">1×</button>
    </div>
    <div class="tool-row">
      <button class="tool-btn" id="btn-full">⛶ 全屏</button>
      <button class="tool-btn accent" id="btn-export2">⬇ 保存回放</button>
    </div>
  </div>`;
  S.canvas = document.getElementById('replay-canvas');
  S.ctx = S.canvas.getContext('2d');
  renderLegend();
  updateUI();
}

function renderLegend() {
  const el = document.getElementById('legend');
  if (!el) return;
  el.innerHTML = S.players.map((p) => `<button class="lg-chip ${p.visible ? '' : 'off'}" data-id="${esc(p.id)}">
    <span class="dot" style="--c:${p.color}"></span>${p.role === 'special' ? '✨ ' : p.role === 'photographer' ? '📷 ' : ''}${esc(p.name)}${p.alive ? '' : ' · 淘汰'}
  </button>`).join('');
  el.querySelectorAll('.lg-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = S.players.find((x) => x.id === btn.dataset.id);
      if (!p) return;
      p.visible = !p.visible;
      if (p.visible) S.visible.add(p.id); else S.visible.delete(p.id);
      btn.classList.toggle('off', !p.visible);
      S.dirty = true;
    });
  });
}

function resize() {
  if (!S.canvas) return;
  S.dpr = Math.min(window.devicePixelRatio || 1, 2);
  S.w = window.innerWidth;
  S.h = window.innerHeight;
  S.canvas.width = Math.round(S.w * S.dpr);
  S.canvas.height = Math.round(S.h * S.dpr);
  S.canvas.style.width = S.w + 'px';
  S.canvas.style.height = S.h + 'px';
  S.ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  computeProjection();
  S.dirty = true;
  draw();
}

function computeProjection() {
  if (!S.bounds) return;
  const { minLat, maxLat, minLng, maxLng } = S.bounds;
  const lat0 = (minLat + maxLat) / 2;
  const lng0 = (minLng + maxLng) / 2;
  const cos = Math.cos(lat0 * Math.PI / 180);
  const mPerDeg = 111320;
  const padL = 30, padR = 30, padT = 138, padB = 160;
  const minX = (minLng - lng0) * cos * mPerDeg;
  const maxX = (maxLng - lng0) * cos * mPerDeg;
  const minY = (lat0 - maxLat) * mPerDeg;
  const maxY = (lat0 - minLat) * mPerDeg;
  const spanX = Math.max(20, maxX - minX);
  const spanY = Math.max(20, maxY - minY);
  const scale = Math.min((S.w - padL - padR) / spanX, (S.h - padT - padB) / spanY);
  const offX = padL + (S.w - padL - padR - spanX * scale) / 2 - minX * scale;
  const offY = padT + (S.h - padT - padB - spanY * scale) / 2 - minY * scale;
  S.proj = { lat0, lng0, cos, mPerDeg, scale, offX, offY, minX, maxX, minY, maxY };
  for (const p of S.players) {
    p.screen = p.points.map((pt) => {
      const x = (pt.lng - lng0) * cos * mPerDeg * scale + offX;
      const y = (lat0 - pt.lat) * mPerDeg * scale + offY;
      return { x, y, t: pt.t };
    });
  }
  for (const e of S.events) {
    const x = (e.lng - lng0) * cos * mPerDeg * scale + offX;
    const y = (lat0 - e.lat) * mPerDeg * scale + offY;
    e.x = x; e.y = y;
  }
}

function project(lat, lng) {
  if (!S.proj) return { x: 0, y: 0 };
  const { lat0, lng0, cos, mPerDeg, scale, offX, offY } = S.proj;
  return {
    x: (lng - lng0) * cos * mPerDeg * scale + offX,
    y: (lat0 - lat) * mPerDeg * scale + offY,
  };
}

function upperBound(times, value) {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function draw() {
  if (!S.ctx) return;
  const ctx = S.ctx;
  const w = S.w, h = S.h;
  ctx.clearRect(0, 0, w, h);
  drawBackground(ctx, w, h);
  drawGrid(ctx, w, h);
  drawPaths(ctx);
  drawEvents(ctx);
  if (S.recording) drawFooter(ctx, w, h);
  drawFinal(ctx, w, h);
  S.dirty = false;
}

function drawBackground(ctx, w, h) {
  const g = ctx.createRadialGradient(w * 0.52, h * 0.42, 20, w * 0.52, h * 0.42, Math.max(w, h) * 0.78);
  g.addColorStop(0, '#0d160e');
  g.addColorStop(0.55, '#081009');
  g.addColorStop(1, '#050805');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(200,255,61,.025)';
  ctx.lineWidth = 1;
  for (let r = 80; r < Math.max(w, h); r += 90) {
    ctx.beginPath();
    ctx.arc(w * 0.52, h * 0.42, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function niceStepMeters(span) {
  const raw = Math.max(10, span / 7);
  const steps = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000];
  for (const s of steps) if (s >= raw) return s;
  return 50000;
}

function drawGrid(ctx, w, h) {
  if (!S.proj) return;
  const { scale, minX, maxX, minY, maxY } = S.proj;
  const span = Math.max(maxX - minX, maxY - minY);
  const step = niceStepMeters(span);
  const px = step * scale;
  if (!Number.isFinite(px) || px < 8) return;
  const x0 = Math.ceil(minX / step) * step;
  const y0 = Math.ceil(minY / step) * step;
  ctx.save();
  ctx.strokeStyle = 'rgba(200,255,61,.055)';
  ctx.lineWidth = 1;
  ctx.font = '9px ui-monospace, monospace';
  ctx.fillStyle = 'rgba(200,255,61,.18)';
  let n = 0;
  for (let x = x0; x <= maxX; x += step) {
    const sx = (x - minX) * scale + S.proj.offX;
    ctx.beginPath(); ctx.moveTo(sx, 90); ctx.lineTo(sx, h - 130); ctx.stroke();
    n += 1;
  }
  n = 0;
  for (let y = y0; y <= maxY; y += step) {
    const sy = (y - minY) * scale + S.proj.offY;
    ctx.beginPath(); ctx.moveTo(20, sy); ctx.lineTo(w - 20, sy); ctx.stroke();
    n += 1;
  }
  ctx.restore();
}

function drawPaths(ctx) {
  if (!S.proj) return;
  const t = S.current;
  for (const p of S.players) {
    if (!p.visible || !p.screen?.length) continue;
    const pts = p.screen;
    const times = p.points.map((x) => x.t);
    if (t < times[0]) continue;
    const idx = Math.max(0, upperBound(times, t) - 1);
    if (idx >= pts.length) continue;
    let ex = pts[idx].x, ey = pts[idx].y;
    if (idx < pts.length - 1 && times[idx + 1] > times[idx]) {
      const f = clamp((t - times[idx]) / (times[idx + 1] - times[idx]), 0, 1);
      ex = pts[idx].x + (pts[idx + 1].x - pts[idx].x) * f;
      ey = pts[idx].y + (pts[idx + 1].y - pts[idx].y) * f;
    }
    const ended = t > times[times.length - 1] + 20000;
    const alpha = p.alive ? 0.92 : 0.7;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = hexA(p.color, ended ? 0.3 : alpha);
    ctx.lineWidth = 2.2;
    ctx.shadowColor = hexA(p.color, 0.5);
    ctx.shadowBlur = 7;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i <= idx; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.restore();

    // 起点
    ctx.save();
    ctx.strokeStyle = hexA(p.color, 0.35);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, 3.2, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();

    const dotAlpha = t > times[times.length - 1] + 90000 ? 0.35 : 1;
    ctx.save();
    ctx.globalAlpha = dotAlpha;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.arc(ex, ey, 4.6, 0, Math.PI * 2);
    ctx.fillStyle = p.color; ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.6; ctx.strokeStyle = '#07100b'; ctx.stroke();
    ctx.restore();

    drawLabel(ctx, p.name, ex + 8, ey - 9, p.color, dotAlpha, p.role === 'special');
  }
}

function drawLabel(ctx, text, x, y, color, alpha = 1, special = false) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = '700 10px "PingFang SC", "Noto Sans SC", system-ui, sans-serif';
  const label = (special ? '✨ ' : '') + text;
  const tw = ctx.measureText(label).width;
  const px = Math.min(x, S.w - tw - 16);
  const py = y;
  ctx.fillStyle = 'rgba(4,8,4,.66)';
  roundRect(ctx, px - 3, py - 10, tw + 7, 15, 4);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(label, px, py - 2);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawEvents(ctx) {
  const t = S.current;
  for (const e of S.events) {
    if (e.t > t) continue;
    if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
    const age = t - e.t;
    const a = age < 6000 ? 1 : 0.35;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.arc(e.x, e.y, age < 3000 ? 11 : 8, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(8,12,8,.75)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,209,102,.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(e.icon || '•', e.x, e.y + 1);
    ctx.restore();
  }
}

function drawFooter(ctx, w, h) {
  ctx.save();
  ctx.font = '700 10px "PingFang SC", system-ui, sans-serif';
  ctx.fillStyle = 'rgba(238,244,230,.38)';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('猎名场 · 房间 ' + S.code, 18, 22);
  ctx.textAlign = 'right';
  ctx.fillText(fmtTime(S.current) + ' / ' + fmtTime(S.duration), w - 18, 22);
  ctx.restore();

  // 比例尺
  if (S.proj) {
    const span = Math.max(S.proj.maxX - S.proj.minX, S.proj.maxY - S.proj.minY);
    const step = niceStepMeters(span);
    const px = step * S.proj.scale;
    if (Number.isFinite(px) && px > 20) {
      const x = 20, y = h - 112;
      ctx.save();
      ctx.strokeStyle = 'rgba(238,244,230,.4)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + px, y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + px, y - 4); ctx.lineTo(x + px, y + 4); ctx.stroke();
      ctx.fillStyle = 'rgba(238,244,230,.5)';
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillText(step >= 1000 ? (step / 1000) + ' km' : step + ' m', x + 4, y - 7);
      ctx.restore();
    }
    // 北向
    const nx = w - 26, ny = 128;
    ctx.save();
    ctx.strokeStyle = 'rgba(238,244,230,.35)';
    ctx.fillStyle = 'rgba(238,244,230,.5)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(nx, ny - 10); ctx.lineTo(nx, ny + 8); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(nx, ny - 12); ctx.lineTo(nx - 4, ny - 4); ctx.lineTo(nx + 4, ny - 4); ctx.closePath(); ctx.fill();
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('N', nx, ny + 19);
    ctx.restore();
  }
}

function drawFinal(ctx, w, h) {
  if (S.current < S.duration - 400) return;
  const a = clamp((S.current - (S.duration - 400)) / 800, 0, 1);
  ctx.save();
  ctx.globalAlpha = a;
  const bw = Math.min(w - 50, 340);
  const bh = 92;
  const x = (w - bw) / 2;
  const y = h / 2 - bh / 2;
  ctx.fillStyle = 'rgba(6,10,6,.86)';
  ctx.strokeStyle = 'rgba(200,255,61,.35)';
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, bw, bh, 16);
  ctx.fill(); ctx.stroke();
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(200,255,61,.9)';
  ctx.font = '800 22px "PingFang SC", system-ui, sans-serif';
  ctx.fillText(S.winnerText, w / 2, y + 36);
  ctx.fillStyle = 'rgba(238,244,230,.6)';
  ctx.font = '11px "PingFang SC", system-ui, sans-serif';
  wrapText(ctx, S.reason || '游戏结束', w / 2, y + 58, bw - 30, 15, 2);
  ctx.restore();
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  const chars = [...String(text || '')];
  let line = '';
  let lines = 0;
  for (const ch of chars) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, y + lines * lineHeight);
      lines += 1;
      line = ch;
      if (lines >= maxLines) return;
    } else {
      line = test;
    }
  }
  if (line && lines < maxLines) ctx.fillText(line, x, y + lines * lineHeight);
}

function hexA(hex, a) {
  const h = String(hex || '#c8ff3d').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function loop(ts) {
  if (!S.lastTs) S.lastTs = ts;
  const dt = Math.min(80, ts - S.lastTs);
  S.lastTs = ts;
  if (S.playing) {
    const base = clamp(S.duration / 60000 * 1.15, 15, 75) * 1000;
    const rate = S.duration / base * S.speed;
    S.current = Math.min(S.duration, S.current + dt * rate);
    if (S.current >= S.duration) {
      S.current = S.duration;
      S.playing = false;
      onReplayEnd();
    }
    S.dirty = true;
  }
  if (S.dirty || S.playing || S.recording) {
    draw();
    updateUI();
  }
  S.raf = requestAnimationFrame(loop);
}

function onReplayEnd() {
  updateUI();
  if (S.recording) {
    clearTimeout(S.recordTimer);
    S.recordTimer = setTimeout(() => stopRecording(), 1800);
  }
}

function updateUI() {
  const now = document.getElementById('time-now');
  const total = document.getElementById('time-total');
  const seek = document.getElementById('seek');
  const play = document.getElementById('btn-play');
  if (now) now.textContent = fmtTime(S.current);
  if (total) total.textContent = fmtTime(S.duration);
  if (seek) {
    seek.max = String(Math.max(1, Math.round(S.duration)));
    if (document.activeElement !== seek) seek.value = String(Math.round(S.current));
    const p = S.duration ? (S.current / S.duration) * 100 : 0;
    seek.style.setProperty('--p', p + '%');
  }
  if (play) play.textContent = S.playing ? '❚❚' : (S.current >= S.duration ? '↺' : '▶');
  if (S.recording) {
    const bar = document.getElementById('rec-bar');
    if (bar) bar.style.width = (S.duration ? (S.current / S.duration) * 100 : 0) + '%';
    const txt = document.getElementById('rec-text');
    if (txt) txt.textContent = `正在录制 ${fmtTime(S.current)} / ${fmtTime(S.duration)}`;
  }
  updateTicker();
}

function updateTicker() {
  const el = document.getElementById('ticker');
  if (!el) return;
  let latest = null;
  for (const e of S.timeline) {
    if (e.t <= S.current) latest = e; else break;
  }
  const key = latest ? latest.id : '';
  if (key === S.tickerKey) return;
  S.tickerKey = key;
  if (!latest || S.current - latest.t > 8000) { el.classList.remove('show'); return; }
  el.innerHTML = `<b>${fmtTime(latest.t)}</b> ${esc(latest.text)}`;
  el.classList.add('show');
}

function play() {
  if (S.current >= S.duration - 10) S.current = 0;
  S.playing = true;
  S.lastTs = 0;
  S.dirty = true;
  updateUI();
}

function pause() {
  S.playing = false;
  S.dirty = true;
  updateUI();
}

function seekTo(ms) {
  S.current = clamp(ms, 0, S.duration);
  S.dirty = true;
  updateUI();
  draw();
}

function bindEvents() {
  document.getElementById('btn-back')?.addEventListener('click', () => {
    if (history.length > 1) history.back();
    else location.href = '/';
  });
  document.getElementById('btn-play')?.addEventListener('click', () => {
    if (S.playing) pause(); else play();
  });
  document.getElementById('seek')?.addEventListener('input', (e) => {
    pause();
    seekTo(Number(e.target.value));
  });
  document.getElementById('btn-speed')?.addEventListener('click', () => {
    const speeds = [1, 2, 4, 8];
    S.speed = speeds[(speeds.indexOf(S.speed) + 1) % speeds.length];
    document.getElementById('btn-speed').textContent = S.speed + '×';
    S.dirty = true;
  });
  document.getElementById('btn-export')?.addEventListener('click', openExportModal);
  document.getElementById('btn-export2')?.addEventListener('click', openExportModal);
  document.getElementById('btn-full')?.addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => toast('当前浏览器不支持全屏'));
    else document.exitFullscreen?.();
  });
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); if (S.playing) pause(); else play(); }
    if (e.code === 'ArrowRight') { pause(); seekTo(S.current + 15000); }
    if (e.code === 'ArrowLeft') { pause(); seekTo(S.current - 15000); }
  });
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => { if (document.hidden && S.playing && !S.recording) pause(); });
}

/* ---------------- export ---------------- */

function openExportModal() {
  const supported = !!(S.canvas.captureStream && window.MediaRecorder);
  modalRoot.innerHTML = `<div class="replay-modal-bg" id="export-bg">
    <div class="replay-modal-card">
      <button class="modal-close-x" id="export-close">✕</button>
      <h2>保存回放</h2>
      <p>HTML 动画最稳妥，双击就能离线播放；视频适合直接发到群里。</p>
      <button class="export-option" id="ex-html"><span class="ei">📄</span><span><span class="et">保存为 HTML 动画</span><span class="ed">单文件、离线可播，附完整轨迹和事件</span></span></button>
      <button class="export-option" id="ex-video" ${supported ? '' : 'disabled'}><span class="ei">🎬</span><span><span class="et">录制 WebM 视频</span><span class="ed">${supported ? '自动从头播放并录制，约 1 分钟' : '当前浏览器不支持 MediaRecorder'}</span></span></button>
      <button class="export-option" id="ex-json"><span class="ei">🧾</span><span><span class="et">导出轨迹数据 JSON</span><span class="ed">包含所有人的原始路径、事件和结果</span></span></button>
      <button class="export-option" id="ex-png"><span class="ei">🖼️</span><span><span class="et">保存当前画面 PNG</span><span class="ed">把此刻的地图和轨迹截成图片</span></span></button>
    </div>
  </div>`;
  modalRoot.classList.add('show');
  const close = () => { modalRoot.classList.remove('show'); modalRoot.innerHTML = ''; };
  document.getElementById('export-close').addEventListener('click', close);
  document.getElementById('export-bg').addEventListener('click', (e) => { if (e.target.id === 'export-bg') close(); });
  document.getElementById('ex-html').addEventListener('click', () => { close(); exportHtml(); });
  document.getElementById('ex-json').addEventListener('click', () => { close(); exportJson(); });
  document.getElementById('ex-png').addEventListener('click', () => { close(); exportPng(); });
  document.getElementById('ex-video').addEventListener('click', () => { if (supported) { close(); startRecording(); } });
}

function exportJson() {
  const blob = new Blob([JSON.stringify(S.data, null, 1)], { type: 'application/json' });
  download(blob, `猎名场-轨迹-${S.code}.json`);
  toast('轨迹数据已导出');
}

function exportPng() {
  S.canvas.toBlob((blob) => {
    if (!blob) { toast('截图失败'); return; }
    download(blob, `猎名场-回放-${S.code}.png`);
    toast('当前画面已保存');
  }, 'image/png');
}

function exportHtml() {
  const data = {
    code: S.code,
    winner: S.winnerText,
    reason: S.reason,
    duration: Math.round(S.duration),
    players: S.players.map((p) => ({
      name: p.name, color: p.color, role: p.roleName || p.role, alive: !!p.alive,
      points: p.points.map((pt) => [Number(pt.lat.toFixed(6)), Number(pt.lng.toFixed(6)), Math.round(pt.t)]),
    })),
    events: S.timeline.map((e) => ({
      t: Math.round(e.t), text: e.text,
      icon: e.type === 'rip' ? '⚔️' : e.type === 'moment' ? '📸' : e.type === 'special' ? '✨' : e.type === 'custom' ? '📝' : e.type === 'expose' ? '📍' : e.type === 'revive' ? '💫' : '•',
      lat: Number.isFinite(e.lat) ? e.lat : null,
      lng: Number.isFinite(e.lng) ? e.lng : null,
    })),
    startedAt: S.data.room?.startedAt || 0,
  };
  const html = standaloneHTML(data);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  download(blob, `猎名场-回放-${S.code}.html`);
  toast('HTML 回放已保存，可离线播放');
}

function standaloneHTML(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>猎名场 · 轨迹回放</title>
<style>
:root{--accent:#c8ff3d;--text:#eef4e6;--muted:#8d9b86}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%;background:#060906;color:var(--text);font-family:"PingFang SC","Noto Sans SC",system-ui,sans-serif;overflow:hidden}
canvas{position:fixed;inset:0;width:100vw;height:100vh;display:block}
.top{position:fixed;left:0;right:0;top:0;z-index:2;padding:14px 16px 30px;background:linear-gradient(180deg,rgba(5,8,5,.92),transparent);pointer-events:none}
.top h1{margin:0;font-size:17px;font-weight:900;letter-spacing:.03em;display:flex;align-items:center;gap:8px}
.top .sub{font-size:10px;color:var(--muted);margin-top:3px;line-height:1.5}
.pill{font-size:10px;padding:2px 7px;border-radius:6px;background:rgba(200,255,61,.12);color:var(--accent);border:1px solid rgba(200,255,61,.22)}
.legend{position:fixed;z-index:3;top:96px;left:0;right:0;display:flex;gap:6px;padding:0 14px 8px;overflow-x:auto;scrollbar-width:none}
.legend::-webkit-scrollbar{display:none}
.chip{flex:none;display:flex;align-items:center;gap:5px;font-size:10px;font-weight:700;padding:5px 8px;border-radius:99px;background:rgba(10,15,9,.78);border:1px solid rgba(255,255,255,.1);color:#dce7d4}
.chip i{width:7px;height:7px;border-radius:50%;display:block}
.chip.off{opacity:.32}
.bar{position:fixed;left:0;right:0;bottom:0;z-index:4;padding:12px 14px calc(12px + env(safe-area-inset-bottom));background:linear-gradient(0deg,#050805 45%,rgba(5,8,5,.8) 80%,transparent);display:flex;align-items:center;gap:9px}
.bar button{width:42px;height:42px;border:0;border-radius:50%;background:var(--accent);color:#0b1009;font-size:16px;font-weight:900;flex:none}
.bar input{flex:1;accent-color:var(--accent);min-width:0}
.bar .time{font-family:ui-monospace,monospace;font-size:10px;color:var(--muted);white-space:nowrap}
.bar .sp{width:auto;height:32px;border-radius:8px;background:rgba(20,28,18,.9);color:var(--accent);font-size:11px;padding:0 9px;border:1px solid rgba(200,255,61,.2)}
.ticker{position:fixed;left:50%;bottom:80px;transform:translateX(-50%);z-index:3;width:min(92vw,480px);text-align:center;font-size:11px;color:#e7f0df;background:rgba(8,12,8,.72);border:1px solid rgba(200,255,61,.14);border-radius:9px;padding:7px 10px;opacity:0;transition:.2s;pointer-events:none}
.ticker.show{opacity:1}
</style></head><body>
<canvas id="c"></canvas>
<div class="top"><h1>猎名场 · 轨迹回放 <span class="pill">${esc(data.winner)}</span></h1><div class="sub">房间 ${esc(data.code)} · ${data.players.length} 人 · ${esc(fmtTime(data.duration))} · ${data.events.length} 个事件<br>${esc(data.reason || '')}</div></div>
<div class="legend" id="legend"></div>
<div class="ticker" id="ticker"></div>
<div class="bar"><button id="play">▶</button><input id="seek" type="range" min="0" max="${Math.max(1, data.duration)}" value="0" step="100"><span class="time" id="time">00:00 / ${esc(fmtTime(data.duration))}</span><button class="sp" id="speed">1×</button></div>
<script>
(function(){
var D=${json};
var c=document.getElementById('c'),ctx=c.getContext('2d'),w=0,h=0,dpr=1;
var current=0,playing=true,speed=1,last=0,proj=null,pts={},events=D.events||[],tickKey='';
var players=D.players.map(function(p,i){return {name:p.name,color:p.color,role:p.role,alive:p.alive,points:p.points,screen:[],visible:true};});
var all=[];players.forEach(function(p){p.points.forEach(function(pt){all.push(pt)})});
if(!all.length){all=[[30,120,0]];}
var minLat=90,maxLat=-90,minLng=180,maxLng=-180;
all.forEach(function(pt){if(pt[0]<minLat)minLat=pt[0];if(pt[0]>maxLat)maxLat=pt[0];if(pt[1]<minLng)minLng=pt[1];if(pt[1]>maxLng)maxLng=pt[1]});
var span=Math.max(maxLat-minLat,maxLng-minLng,0.0009);var clat=(minLat+maxLat)/2,clng=(minLng+maxLng)/2;if(maxLat-minLat<span){minLat=clat-span/2;maxLat=clat+span/2}if(maxLng-minLng<span){minLng=clng-span/2;maxLng=clng+span/2}
function resize(){dpr=Math.min(window.devicePixelRatio||1,2);w=innerWidth;h=innerHeight;c.width=w*dpr;c.height=h*dpr;c.style.width=w+'px';c.style.height=h+'px';ctx.setTransform(dpr,0,0,dpr,0,0);calc();draw()}
function calc(){var lat0=(minLat+maxLat)/2,lng0=(minLng+maxLng)/2,cos=Math.cos(lat0*Math.PI/180),m=111320;var padL=26,padR=26,padT=150,padB=130;var minX=(minLng-lng0)*cos*m,maxX=(maxLng-lng0)*cos*m,minY=(lat0-maxLat)*m,maxY=(lat0-minLat)*m;var sx=Math.max(20,maxX-minX),sy=Math.max(20,maxY-minY);var sc=Math.min((w-padL-padR)/sx,(h-padT-padB)/sy);var ox=padL+(w-padL-padR-sx*sc)/2-minX*sc,oy=padT+(h-padT-padB-sy*sc)/2-minY*sc;proj={lat0:lat0,lng0:lng0,cos:cos,m:m,sc:sc,ox:ox,oy:oy,minX:minX,maxX:maxX,minY:minY,maxY:maxY};players.forEach(function(p){p.screen=p.points.map(function(pt){return {x:(pt[1]-lng0)*cos*m*sc+ox,y:(lat0-pt[0])*m*sc+oy,t:pt[2]}})});events.forEach(function(e){if(e.lng===null||e.lat===null){e.x=NaN;e.y=NaN;return}e.x=(e.lng-lng0)*cos*m*sc+ox;e.y=(lat0-e.lat)*m*sc+oy})}
function fmt(ms){var s=Math.max(0,Math.round(ms/1000)),m=Math.floor(s/60),r=s%60,h=Math.floor(m/60);m%=60;return (h?h+':':'')+String(m).padStart(2,'0')+':'+String(r).padStart(2,'0')}
function up(times,v){var lo=0,hi=times.length;while(lo<hi){var mid=(lo+hi)>>1;if(times[mid]<=v)lo=mid+1;else hi=mid}return lo}
function hexA(hex,a){var h=hex.replace('#','');var n=parseInt(h.length===3?h.split('').map(function(x){return x+x}).join(''):h,16);return 'rgba('+((n>>16)&255)+','+((n>>8)&255)+','+(n&255)+','+a+')'}
function rr(x,y,w2,h2,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w2,y,x+w2,y+h2,r);ctx.arcTo(x+w2,y+h2,x,y+h2,r);ctx.arcTo(x,y+h2,x,y,r);ctx.arcTo(x,y,x+w2,y,r);ctx.closePath()}
function draw(){if(!proj)return;ctx.clearRect(0,0,w,h);var g=ctx.createRadialGradient(w*.52,h*.42,20,w*.52,h*.42,Math.max(w,h)*.8);g.addColorStop(0,'#0d160e');g.addColorStop(1,'#050805');ctx.fillStyle=g;ctx.fillRect(0,0,w,h);grid();paths();evs();final();}
function grid(){var st=100;var spanM=Math.max(proj.maxX-proj.minX,proj.maxY-proj.minY);var opts=[10,20,25,50,100,200,250,500,1000,2000,5000];for(var i=0;i<opts.length;i++){if(opts[i]>=spanM/7){st=opts[i];break}}ctx.save();ctx.strokeStyle='rgba(200,255,61,.055)';ctx.lineWidth=1;var x0=Math.ceil(proj.minX/st)*st;for(var x=x0;x<=proj.maxX;x+=st){var sx=x*proj.sc+proj.ox;ctx.beginPath();ctx.moveTo(sx,90);ctx.lineTo(sx,h-110);ctx.stroke()}var y0=Math.ceil(proj.minY/st)*st;for(var y=y0;y<=proj.maxY;y+=st){var sy=y*proj.sc+proj.oy;ctx.beginPath();ctx.moveTo(18,sy);ctx.lineTo(w-18,sy);ctx.stroke()}ctx.restore()}
function paths(){var t=current;for(var k=0;k<players.length;k++){var p=players[k];if(!p.visible||!p.screen.length)continue;var times=p.points.map(function(x){return x[2]});if(t<times[0])continue;var idx=Math.max(0,up(times,t)-1);var ex=p.screen[idx].x,ey=p.screen[idx].y;if(idx<p.screen.length-1&&times[idx+1]>times[idx]){var f=Math.min(1,Math.max(0,(t-times[idx])/(times[idx+1]-times[idx])));ex=p.screen[idx].x+(p.screen[idx+1].x-p.screen[idx].x)*f;ey=p.screen[idx].y+(p.screen[idx+1].y-p.screen[idx].y)*f}ctx.save();ctx.lineJoin='round';ctx.lineCap='round';ctx.strokeStyle=hexA(p.color,t>times[times.length-1]+20000?.3:.9);ctx.lineWidth=2.2;ctx.shadowColor=hexA(p.color,.5);ctx.shadowBlur=7;ctx.beginPath();ctx.moveTo(p.screen[0].x,p.screen[0].y);for(var j=1;j<=idx;j++)ctx.lineTo(p.screen[j].x,p.screen[j].y);ctx.lineTo(ex,ey);ctx.stroke();ctx.restore();ctx.save();ctx.shadowColor=p.color;ctx.shadowBlur=12;ctx.beginPath();ctx.arc(ex,ey,4.6,0,6.2832);ctx.fillStyle=p.color;ctx.fill();ctx.shadowBlur=0;ctx.lineWidth=1.6;ctx.strokeStyle='#07100b';ctx.stroke();ctx.restore();label(p.name,ex+8,ey-9,p.color)}}
function label(text,x,y,color){ctx.save();ctx.font='700 10px "PingFang SC",system-ui,sans-serif';var tw=ctx.measureText(text).width;var px=Math.min(x,w-tw-16);ctx.fillStyle='rgba(4,8,4,.66)';rr(px-3,y-10,tw+7,15,4);ctx.fill();ctx.fillStyle=color;ctx.textBaseline='middle';ctx.fillText(text,px,y-2);ctx.restore()}
function evs(){for(var i=0;i<events.length;i++){var e=events[i];if(e.t>current||!isFinite(e.x))continue;var a=current-e.t<6000?1:.3;ctx.save();ctx.globalAlpha=a;ctx.beginPath();ctx.arc(e.x,e.y,8,0,6.2832);ctx.fillStyle='rgba(8,12,8,.72)';ctx.fill();ctx.strokeStyle='rgba(255,209,102,.5)';ctx.stroke();ctx.font='11px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(e.icon||'•',e.x,e.y+1);ctx.restore()}}
function footer(){ctx.save();ctx.font='700 10px "PingFang SC",system-ui,sans-serif';ctx.fillStyle='rgba(238,244,230,.4)';ctx.fillText('猎名场 · 房间 '+D.code,16,20);ctx.textAlign='right';ctx.fillText(fmt(current)+' / '+fmt(D.duration),w-16,20);ctx.restore()}
function final(){if(current<D.duration-400)return;var a=Math.min(1,Math.max(0,(current-(D.duration-400))/800));ctx.save();ctx.globalAlpha=a;var bw=Math.min(w-44,330),bh=86,x=(w-bw)/2,y=h/2-bh/2;ctx.fillStyle='rgba(6,10,6,.86)';ctx.strokeStyle='rgba(200,255,61,.35)';rr(x,y,bw,bh,16);ctx.fill();ctx.stroke();ctx.textAlign='center';ctx.fillStyle='rgba(200,255,61,.9)';ctx.font='800 21px "PingFang SC",system-ui,sans-serif';ctx.fillText(D.winner,w/2,y+34);ctx.fillStyle='rgba(238,244,230,.6)';ctx.font='11px "PingFang SC",system-ui,sans-serif';ctx.fillText((D.reason||'游戏结束').slice(0,34),w/2,y+58);ctx.restore()}
function loop(ts){if(!last)last=ts;var dt=Math.min(80,ts-last);last=ts;if(playing){var base=Math.max(15000,Math.min(75000,D.duration/60000*1.15));current=Math.min(D.duration,current+dt*(D.duration/base)*speed);if(current>=D.duration){current=D.duration;playing=false;var b=document.getElementById('play');b.textContent='↺'}}draw();upd();requestAnimationFrame(loop)}
function upd(){document.getElementById('time').textContent=fmt(current)+' / '+fmt(D.duration);var s=document.getElementById('seek');if(document.activeElement!==s)s.value=String(Math.round(current));var t=null;for(var i=0;i<events.length;i++){if(events[i].t<=current)t=events[i];else break}var el=document.getElementById('ticker');if(t&&current-t.t<8000){if(tickKey!==String(t.t)+t.text){tickKey=String(t.t)+t.text;el.innerHTML='<b>'+fmt(t.t)+'</b> '+t.text;el.classList.add('show')}}else{el.classList.remove('show')}}
document.getElementById('play').onclick=function(){if(playing){playing=false;this.textContent='▶'}else{if(current>=D.duration)current=0;playing=true;last=0;this.textContent='❚❚'}};
document.getElementById('seek').oninput=function(){playing=false;document.getElementById('play').textContent='▶';current=Number(this.value)};
document.getElementById('speed').onclick=function(){var a=[1,2,4,8];speed=a[(a.indexOf(speed)+1)%a.length];this.textContent=speed+'×'};
var lg=document.getElementById('legend');players.forEach(function(p,k){var b=document.createElement('button');b.className='chip';b.innerHTML='<i style="background:'+p.color+'"></i>'+(p.role==='special'?'✨ ':'')+p.name;b.onclick=function(){p.visible=!p.visible;b.classList.toggle('off',!p.visible)};lg.appendChild(b)});
window.addEventListener('resize',resize);
resize();
document.getElementById('play').textContent='❚❚';
requestAnimationFrame(loop);
})();
</script>
</body></html>`;
}

function startRecording() {
  if (!S.canvas.captureStream || !window.MediaRecorder) {
    toast('当前浏览器不支持录制视频，请用 HTML 动画保存');
    return;
  }
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) { toast('当前浏览器不支持 WebM 录制'); return; }
  try {
    const stream = S.canvas.captureStream(30);
    S.chunks = [];
    S.recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5000000 });
    S.recorder.ondataavailable = (e) => { if (e.data && e.data.size) S.chunks.push(e.data); };
    S.recorder.onstop = () => {
      S.recording = false;
      document.getElementById('rec-overlay')?.classList.remove('show');
      try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      const blob = new Blob(S.chunks, { type: 'video/webm' });
      if (blob.size) {
        download(blob, `猎名场-回放-${S.code}.webm`);
        toast('视频已录制完成');
      } else {
        toast('录制失败，没有生成视频');
      }
      S.recorder = null;
      S.chunks = [];
      updateUI();
    };
    S.recording = true;
    S.chunks = [];
    document.getElementById('rec-overlay')?.classList.add('show');
    S.recorder.start(500);
    S.current = 0;
    S.playing = true;
    S.lastTs = 0;
    S.dirty = true;
    updateUI();
  } catch (e) {
    toast('无法开始录制：' + e.message);
    S.recording = false;
  }
}

function stopRecording() {
  if (!S.recording || !S.recorder) return;
  try { S.recorder.stop(); } catch { /* ignore */ }
}

function showError(title, text) {
  app.innerHTML = `<div class="error"><div style="font-size:44px">🎞️</div><h2>${esc(title)}</h2><p>${esc(text)}</p><a href="/" style="color:var(--accent);font-size:13px;margin-top:8px">← 返回猎名场</a></div>`;
}

boot();
