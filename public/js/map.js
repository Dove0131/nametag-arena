import { esc, wgs84ToGcj02, distanceMeters, PALETTE } from './util.js';

const L = window.L;

export class GameMap {
  constructor(el, opts = {}) {
    this.el = el;
    this.provider = opts.provider || 'amap';
    this.gcj = opts.gcj !== false;
    this.onMarkerClick = opts.onMarkerClick || (() => {});
    this.onMapClick = opts.onMapClick || (() => {});
    this.markers = new Map();
    this.fitted = false;
    this.fittedOthers = false;
    this.selfTrail = [];
    this.tileErrors = 0;
    this.tileLayer = null;
    this.polyline = null;
    this.accuracy = null;
    this.meId = null;

    this.map = L.map(el, {
      zoomControl: false,
      attributionControl: true,
      preferCanvas: true,
      maxZoom: 19,
      minZoom: 3,
      zoomSnap: 0.25,
      tap: true,
    });
    this.map.setView([34.5, 108.9], 4);
    this.map.attributionControl.setPrefix('');
    this.map.on('click', () => this.onMapClick());
    this._applyProvider();
  }

  project(lat, lng) {
    if (this.provider === 'amap' && this.gcj) return wgs84ToGcj02(lat, lng);
    return [lat, lng];
  }

  _applyProvider() {
    if (this.tileLayer) { this.map.removeLayer(this.tileLayer); this.tileLayer = null; }
    this.el.classList.remove('no-map-tiles');
    this.tileErrors = 0;
    if (this.provider === 'none') { this.el.classList.add('no-map-tiles'); return; }
    let url, options;
    if (this.provider === 'osm') {
      url = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
      options = { maxZoom: 19, subdomains: 'abc', attribution: '&copy; OpenStreetMap' };
    } else {
      url = 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}';
      options = { maxZoom: 18, subdomains: ['1', '2', '3', '4'], attribution: '&copy; 高德地图' };
    }
    this.tileLayer = L.tileLayer(url, { ...options, detectRetina: false });
    this.tileLayer.on('tileerror', () => {
      this.tileErrors += 1;
      if (this.tileErrors === 8) this.el.classList.add('no-map-tiles');
    });
    this.tileLayer.addTo(this.map);
  }

  setProvider(provider, gcj = true) {
    this.provider = provider;
    this.gcj = gcj;
    this._applyProvider();
    // 重新放置 marker
    for (const { marker, player } of this.markers.values()) {
      const [lat, lng] = this.project(player.lat, player.lng);
      marker.setLatLng([lat, lng]);
    }
    if (this.lastPlayers) this.update(this.lastPlayers, this.meId, this.lastOpts || {});
    this.map.invalidateSize();
  }

  _icon(player, meId) {
    const isMe = player.id === meId;
    const cls = ['nt-marker'];
    if (isMe) cls.push('self');
    if (player.exposedUntil > Date.now()) cls.push('exposed');
    if (!player.alive) cls.push('dead');
    const roleShort = player.role ? ({ admin: '管', photographer: '摄', special: '特', player: '玩' }[player.role] || '') : '';
    const color = isMe ? '#c8ff3d' : (player.color || '#c8ff3d');
    const html = `<div class="m-inner" style="--c:${color}">
      <div class="dot">${esc(roleShort)}</div>
      <div class="m-name">${isMe ? '我 · ' : ''}${esc(player.name)}</div>
    </div>`;
    return L.divIcon({ className: cls.join(' '), html, iconSize: [0, 0], iconAnchor: [0, 0] });
  }

  update(players, meId, opts = {}) {
    this.meId = meId;
    this.lastPlayers = players;
    this.lastOpts = opts;
    const now = Date.now();
    const visible = players
      .filter((p) => p.visible && Number.isFinite(p.lat) && Number.isFinite(p.lng))
      .map((p) => ({ ...p, color: p.id === meId ? '#c8ff3d' : PALETTE[(p.colorIndex || 0) % PALETTE.length] }));
    const aliveIds = new Set(visible.map((p) => p.id));

    for (const [id, entry] of [...this.markers]) {
      if (!aliveIds.has(id)) {
        this.map.removeLayer(entry.marker);
        this.markers.delete(id);
      }
    }

    for (const p of visible) {
      const [lat, lng] = this.project(p.lat, p.lng);
      const sig = [p.name, p.alive, p.exposedUntil > now, p.id === meId, p.role, p.colorIndex].join('|');
      let entry = this.markers.get(p.id);
      if (!entry) {
        const marker = L.marker([lat, lng], {
          icon: this._icon(p, meId),
          keyboard: false,
          zIndexOffset: p.id === meId ? 1000 : 100,
          riseOnHover: true,
        }).addTo(this.map);
        marker.on('click', (ev) => {
          L.DomEvent.stopPropagation(ev);
          this.onMarkerClick(p.id);
        });
        entry = { marker, sig: '', player: p };
        this.markers.set(p.id, entry);
      }
      if (entry.sig !== sig) {
        entry.marker.setIcon(this._icon(p, meId));
        entry.sig = sig;
      }
      entry.player = p;
      entry.marker.setLatLng([lat, lng]);

      if (p.id === meId) {
        if (Number.isFinite(p.acc) && p.acc > 5) {
          const [clat, clng] = this.project(p.lat, p.lng);
          if (!this.accuracy) {
            this.accuracy = L.circle([clat, clng], {
              radius: Math.min(p.acc, 200), color: '#c8ff3d', weight: 1,
              opacity: 0.35, fillColor: '#c8ff3d', fillOpacity: 0.06,
            }).addTo(this.map);
          } else {
            this.accuracy.setLatLng([clat, clng]);
            this.accuracy.setRadius(Math.min(p.acc, 200));
          }
        } else if (this.accuracy) {
          this.map.removeLayer(this.accuracy);
          this.accuracy = null;
        }
        const last = this.selfTrail[this.selfTrail.length - 1];
        if (!last || distanceMeters(last, { lat, lng }) > 6) {
          this.selfTrail.push({ lat, lng });
          if (this.selfTrail.length > 80) this.selfTrail.shift();
          if (!this.polyline) {
            this.polyline = L.polyline(this.selfTrail, {
              color: '#c8ff3d', weight: 3, opacity: 0.4, dashArray: '4 8',
            }).addTo(this.map);
          } else {
            this.polyline.setLatLngs(this.selfTrail);
          }
        }
      }
    }

    if (!this.fitted && visible.length) {
      const hasOther = visible.some((p) => p.id !== meId);
      const me = visible.find((p) => p.id === meId);
      if (hasOther) { this.fitAll(); this.fittedOthers = true; }
      else if (me) {
        const [lat, lng] = this.project(me.lat, me.lng);
        this.map.setView([lat, lng], 17);
      }
      this.fitted = true;
    } else if (!this.fittedOthers && visible.some((p) => p.id !== meId)) {
      this.fittedOthers = true;
      this.fitAll();
    }
  }

  fitAll() {
    const pts = [...this.markers.values()].map((e) => e.marker.getLatLng());
    if (!pts.length) return;
    if (pts.length === 1) { this.map.setView(pts[0], 17); return; }
    this.map.fitBounds(L.latLngBounds(pts), {
      paddingTopLeft: [34, 150],
      paddingBottomRight: [34, 200],
      maxZoom: 18,
    });
  }

  focusSelf() {
    const me = this.markers.get(this.meId);
    if (me) this.map.setView(me.marker.getLatLng(), Math.max(this.map.getZoom(), 17), { animate: true });
    else this.fitAll();
  }

  invalidate() { this.map.invalidateSize(); }

  destroy() {
    try { this.map.remove(); } catch { /* ignore */ }
    this.markers.clear();
  }
}
