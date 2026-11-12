/* 淡蘭走訪紀錄 — 前端 App（PWA） */
'use strict';

const ROUTES = ['北路', '中路', '南路', '平原線', '文化徑'];
const ROUTE_COLOR = { '北路': '--north', '中路': '--mid', '南路': '--south', '平原線': '--plain', '文化徑': '--city' };
const DEFAULT_RADIUS = 150;

/* ================= 儲存（IndexedDB，失敗時退回記憶體） ================= */
const store = (() => {
  let dbp = null; const mem = new Map();
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      try {
        const r = indexedDB.open('danlan', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    });
    return dbp;
  }
  async function get(k) {
    try { const d = await db(); return await new Promise((res, rej) => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
    catch (e) { return mem.get(k); }
  }
  async function set(k, v) {
    mem.set(k, v);
    try { const d = await db(); await new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
    catch (e) { /* 記憶體備援 */ }
  }
  return { get, set };
})();

/* ================= 狀態 ================= */
const S = {
  base: null,          // data/trails.json（含軌跡）
  server: null,        // 從 GAS 取得的 {trails, landmarks, checkins}
  queue: [],           // 待上傳：{type:'checkin', item} 或 {type:'delete', uuid}
  settings: { api: '', token: '' },
  lastSync: null, syncing: false, syncError: '',
  trails: [], byId: {}, lmById: {},
  pos: null, watchId: null,
};

async function loadState() {
  S.settings = Object.assign({ api: '', token: '' }, await store.get('settings'));
  S.queue = (await store.get('queue')) || [];
  S.server = (await store.get('server')) || null;
  S.lastSync = (await store.get('lastSync')) || null;
  const q = new URLSearchParams(location.search);   // 可用 ?api=…&token=… 一次帶入設定
  if (q.get('api') || q.get('token')) {
    if (q.get('api')) S.settings.api = q.get('api').trim();
    if (q.get('token')) S.settings.token = q.get('token').trim();
    await store.set('settings', S.settings);
    history.replaceState(null, '', location.pathname + location.hash);
  }
  try {
    const r = await fetch('data/trails.json', { cache: 'no-cache' });
    S.base = await r.json(); await store.set('base', S.base);
  } catch (e) { S.base = await store.get('base'); }
  rebuild();
}
const saveQueue = () => store.set('queue', S.queue);

/** 把內建資料與試算表資料合併（試算表可改地標名稱、座標、半徑） */
function rebuild() {
  const base = (S.base && S.base.trails) || [];
  const srvT = S.server && S.server.trails && S.server.trails.length ? S.server.trails : null;
  const srvL = S.server && S.server.landmarks && S.server.landmarks.length ? S.server.landmarks : null;
  const baseById = Object.fromEntries(base.map(t => [t.id, t]));
  let list = srvT ? srvT.map(t => Object.assign({}, baseById[t.id] || {}, t)) : base.map(t => Object.assign({}, t));
  if (srvL) {
    const g = {};
    srvL.forEach(l => (g[l.trailId] = g[l.trailId] || []).push(l));
    list.forEach(t => { if (g[t.id]) t.landmarks = g[t.id].sort((a, b) => a.seq - b.seq); });
  }
  list.forEach(t => { t.landmarks = (t.landmarks || []).map(l => Object.assign({ r: DEFAULT_RADIUS }, l, { trailId: t.id })); t.track = t.track || []; });
  list.sort((a, b) => ROUTES.indexOf(a.route) - ROUTES.indexOf(b.route) || a.order - b.order);
  S.trails = list;
  S.byId = Object.fromEntries(list.map(t => [t.id, t]));
  S.lmById = {};
  list.forEach(t => t.landmarks.forEach(l => (S.lmById[l.id] = l)));
}

/** 目前有效的打卡（伺服器 + 本機佇列 − 待刪除） */
function checkins() {
  const del = new Set(S.queue.filter(q => q.type === 'delete').map(q => q.uuid));
  const out = new Map();
  ((S.server && S.server.checkins) || []).forEach(c => { if (!del.has(c.uuid)) out.set(c.uuid, Object.assign({}, c, { synced: true })); });
  S.queue.filter(q => q.type === 'checkin').forEach(q => out.set(q.item.uuid, Object.assign({}, out.get(q.item.uuid) || {}, q.item, { synced: false })));
  return [...out.values()].filter(c => !del.has(c.uuid)).sort((a, b) => String(b.time).localeCompare(String(a.time)));
}

/* ================= 進度計算 ================= */
function progress() {
  const cs = checkins();
  const doneLm = new Map();   // landmarkId -> 最新一筆打卡
  cs.forEach(c => { if (!doneLm.has(c.landmarkId)) doneLm.set(c.landmarkId, c); });
  const trail = {};
  S.trails.forEach(t => {
    const total = t.landmarks.length;
    const done = t.landmarks.filter(l => doneLm.has(l.id)).length;
    const p = total ? done / total : 0;
    trail[t.id] = { total, done, p, km: t.km || 0, kmDone: (t.km || 0) * p, complete: total > 0 && done === total };
  });
  const route = {};
  ROUTES.forEach(r => {
    const ts = S.trails.filter(t => t.route === r);
    const km = ts.reduce((s, t) => s + trail[t.id].km, 0);
    const kmDone = ts.reduce((s, t) => s + trail[t.id].kmDone, 0);
    route[r] = { n: ts.length, complete: ts.filter(t => trail[t.id].complete).length, km, kmDone, p: km ? kmDone / km : 0 };
  });
  const km = ROUTES.reduce((s, r) => s + route[r].km, 0), kmDone = ROUTES.reduce((s, r) => s + route[r].kmDone, 0);
  return { doneLm, trail, route, total: { km, kmDone, p: km ? kmDone / km : 0 }, checkins: cs };
}

/* ================= 同步 ================= */
const hasApi = () => !!(S.settings.api && S.settings.token);

async function sync(opts = {}) {
  if (!hasApi() || S.syncing) { renderStatus(); return; }
  if (!navigator.onLine) { renderStatus(); return; }
  S.syncing = true; S.syncError = ''; renderStatus();
  try {
    const ups = S.queue.filter(q => q.type === 'checkin').map(q => q.item);
    if (ups.length) {
      const r = await post({ action: 'checkin', items: ups });
      const ok = new Set(r.saved || []);
      S.queue = S.queue.filter(q => !(q.type === 'checkin' && ok.has(q.item.uuid)));
      await saveQueue();
    }
    const dels = S.queue.filter(q => q.type === 'delete').map(q => q.uuid);
    if (dels.length) {
      const r = await post({ action: 'delete', uuids: dels });
      const ok = new Set(r.deleted || []);
      S.queue = S.queue.filter(q => !(q.type === 'delete' && ok.has(q.uuid)));
      await saveQueue();
    }
    const u = new URL(S.settings.api); u.searchParams.set('token', S.settings.token); u.searchParams.set('action', 'data');
    const res = await fetchT(u.toString(), {}, 25000);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '讀取失敗');
    S.server = { trails: data.trails, landmarks: data.landmarks, checkins: data.checkins };
    await store.set('server', S.server);
    S.lastSync = new Date().toISOString(); await store.set('lastSync', S.lastSync);
    rebuild();
    if (opts.rerender !== false) render();
  } catch (e) {
    S.syncError = e.message || String(e);
    if (opts.loud) toast('同步失敗：' + S.syncError);
  } finally {
    S.syncing = false; renderStatus();
  }
}
async function post(body) {
  body.token = S.settings.token;
  const res = await fetchT(S.settings.api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) }, 30000);
  const d = await res.json();
  if (!d.ok) throw new Error(d.error || '寫入失敗');
  return d;
}
function fetchT(url, opt, ms) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  return fetch(url, Object.assign({ redirect: 'follow', signal: c.signal }, opt)).finally(() => clearTimeout(t));
}
let syncTimer = null;
const syncSoon = () => { clearTimeout(syncTimer); syncTimer = setTimeout(() => sync(), 800); };

/* ================= 打卡動作 ================= */
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2));

async function addCheckin(lm, extra) {
  const item = Object.assign({
    uuid: uuid(), time: new Date().toISOString(), landmarkId: lm.id, trailId: lm.trailId, landmarkName: lm.name,
    source: '現場', lat: null, lng: null, acc: null, dist: null, verify: '', note: ''
  }, extra);
  S.queue.push({ type: 'checkin', item }); await saveQueue();
  syncSoon();
  return item;
}
async function removeCheckin(id) {
  const i = S.queue.findIndex(q => q.type === 'checkin' && q.item.uuid === id);
  const wasQueued = i >= 0;
  if (wasQueued) S.queue.splice(i, 1);
  const onServer = ((S.server && S.server.checkins) || []).some(c => c.uuid === id);
  if (onServer || !wasQueued) S.queue.push({ type: 'delete', uuid: id });
  await saveQueue(); syncSoon();
}
async function setNote(id, note) {
  const q = S.queue.find(q => q.type === 'checkin' && q.item.uuid === id);
  if (q) q.item.note = note;
  else {
    const c = checkins().find(c => c.uuid === id); if (!c) return;
    S.queue.push({ type: 'checkin', item: Object.assign({}, c, { note, synced: undefined }) });
  }
  await saveQueue(); syncSoon();
}

/* ================= 定位 ================= */
function getPosition() {
  return new Promise((res, rej) => {
    if (!('geolocation' in navigator)) return rej(new Error('此裝置不支援定位'));
    navigator.geolocation.getCurrentPosition(p => { S.pos = p; res(p); }, err => {
      const msg = { 1: '沒有定位權限，請到手機設定允許此 App 使用位置', 2: '暫時抓不到位置，請到空曠處再試', 3: '定位逾時，請再試一次' }[err.code] || err.message;
      rej(new Error(msg));
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 });
  });
}
function startWatch(cb) {
  stopWatch();
  if (!('geolocation' in navigator)) return;
  S.watchId = navigator.geolocation.watchPosition(p => { S.pos = p; cb && cb(p); }, () => {}, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
}
function stopWatch() { if (S.watchId != null) { navigator.geolocation.clearWatch(S.watchId); S.watchId = null; } }
function distM(a1, o1, a2, o2) {
  const R = 6371000, r = d => d * Math.PI / 180;
  const h = Math.sin(r(a2 - a1) / 2) ** 2 + Math.cos(r(a1)) * Math.cos(r(a2)) * Math.sin(r(o2 - o1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const fmtDist = m => m == null ? '' : m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';

/** 現場打卡：trailId 有值時只找該路段；否則找全部 */
async function doCheckin(trailId) {
  toast('📡 定位中…', 0);
  let p;
  try { p = await getPosition(); } catch (e) { hideToast(); return openSheet(locErrorSheet(e.message, trailId)); }
  hideToast();
  const { latitude: lat, longitude: lng, accuracy: acc } = p.coords;
  const prog = progress();
  const pool = (trailId ? S.byId[trailId].landmarks : S.trails.flatMap(t => t.landmarks)).filter(l => l.lat && l.lng);
  const ranked = pool.map(l => ({ l, d: distM(lat, lng, l.lat, l.lng) })).sort((a, b) => a.d - b.d);
  const within = ranked.filter(x => x.d <= (x.l.r || DEFAULT_RADIUS) + Math.min(acc, 100));
  const target = within.find(x => !prog.doneLm.has(x.l.id));
  if (target) {
    const item = await addCheckin(target.l, { lat: r6(lat), lng: r6(lng), acc: Math.round(acc), dist: Math.round(target.d), verify: '✅' });
    render();
    toastUndo(`✅ 已打卡：${target.l.name}`, item.uuid);
    return;
  }
  openSheet(pickSheet(ranked.slice(0, 8), { lat, lng, acc }, prog, trailId));
}
const r6 = v => Math.round(v * 1e6) / 1e6;

function pickSheet(list, here, prog, trailId) {
  const box = el('div');
  box.append(el('h2', { style: 'margin-top:0' }, '選擇要打卡的地標'),
    el('p', { class: 'muted small' }, `目前位置精度 ±${Math.round(here.acc)} m。附近沒有在判定範圍內、且尚未打卡的地標，選擇後會標記為「⚠️ 位置偏差」。`));
  if (!list.length) box.append(el('p', { class: 'empty' }, '沒有可選的地標'));
  list.forEach(({ l, d }) => {
    const t = S.byId[l.trailId]; const done = prog.doneLm.has(l.id);
    const inRange = d <= (l.r || DEFAULT_RADIUS) + Math.min(here.acc, 100);
    const b = el('button', { class: 'pick' },
      el('div', { class: 'grow' }, el('div', { style: 'font-weight:700' }, l.name + (done ? ' ✔︎' : '')), el('div', { class: 'muted small' }, `${t.route}｜${t.name}`)),
      el('span', { class: 'dist' }, fmtDist(d)));
    b.onclick = async () => {
      closeSheet();
      const item = await addCheckin(l, { lat: r6(here.lat), lng: r6(here.lng), acc: Math.round(here.acc), dist: Math.round(d), verify: inRange ? '✅' : '⚠️' });
      render(); toastUndo(`${inRange ? '✅' : '⚠️'} 已打卡：${l.name}`, item.uuid);
    };
    box.append(b);
  });
  box.append(el('button', { class: 'btn secondary', style: 'margin-top:8px', onclick: closeSheet }, '取消'));
  if (trailId) box.append(el('button', { class: 'linkbtn', style: 'width:100%', onclick: () => { closeSheet(); doCheckin(null); } }, '改找所有路段的地標'));
  return box;
}
function locErrorSheet(msg, trailId) {
  return el('div', {},
    el('h2', { style: 'margin-top:0' }, '無法取得位置'), el('p', {}, msg),
    el('p', { class: 'muted small' }, '也可以改用「補登」，手動選擇地標與時間。'),
    el('button', { class: 'btn', onclick: () => { closeSheet(); doCheckin(trailId); } }, '再試一次'),
    el('a', { class: 'btn secondary', style: 'margin-top:10px', href: trailId ? `#/add?trail=${trailId}` : '#/add', onclick: closeSheet }, '改用補登'));
}

/* ================= UI 工具 ================= */
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e[k] = v; else if (k === 'html') e.innerHTML = v; else e.setAttribute(k, v === true ? '' : v);
  }
  kids.flat().forEach(k => { if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k))); });
  return e;
}
const pct = p => Math.round(p * 100);
const kmTxt = k => (Math.round(k * 10) / 10).toString();
function fmtTime(iso) {
  const d = new Date(iso); if (isNaN(d)) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const routeVar = r => `var(${ROUTE_COLOR[r] || '--brand'})`;
function bar(p, color) { return el('div', { class: 'bar' }, el('i', { style: `width:${pct(p)}%;${color ? 'background:' + color : ''}` })); }

let toastTimer = null;
function toast(msg, ms = 3000, actions = []) {
  const t = document.getElementById('toast');
  t.replaceChildren(el('div', { class: 'grow' }, msg), ...actions);
  t.hidden = false; clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { document.getElementById('toast').hidden = true; }
function toastUndo(msg, id) {
  toast(msg, 6000, [
    el('button', { onclick: () => { hideToast(); noteSheet(id); } }, '＋心得'),
    el('button', { onclick: async () => { hideToast(); await removeCheckin(id); render(); toast('已復原'); } }, '復原'),
  ]);
}
function noteSheet(id) {
  const c = checkins().find(c => c.uuid === id); if (!c) return;
  const ta = el('textarea', { class: 'in', placeholder: '天氣、路況、同行…' }); ta.value = c.note || '';
  openSheet(el('div', {}, el('h2', { style: 'margin-top:0' }, '心得：' + (c.landmarkName || '')), ta,
    el('button', { class: 'btn', style: 'margin-top:12px', onclick: async () => { await setNote(id, ta.value.trim()); closeSheet(); render(); toast('已儲存心得'); } }, '儲存')));
  setTimeout(() => ta.focus(), 250);
}
function openSheet(content) {
  document.getElementById('sheetBody').replaceChildren(content);
  document.getElementById('sheet').hidden = false;
}
function closeSheet() { document.getElementById('sheet').hidden = true; }
document.addEventListener('click', e => { if (e.target.matches('[data-close]')) closeSheet(); });

function renderStatus() {
  const dot = document.getElementById('netDot'), txt = document.getElementById('statusText');
  const pending = S.queue.length;
  dot.className = 'dot ' + (navigator.onLine ? 'on' : 'off');
  if (!hasApi()) txt.textContent = '未設定同步';
  else if (S.syncing) txt.textContent = '同步中…';
  else if (!navigator.onLine) txt.textContent = pending ? `離線・${pending} 筆待傳` : '離線';
  else if (S.syncError) txt.textContent = pending ? `${pending} 筆待傳・失敗` : '同步失敗';
  else txt.textContent = pending ? `${pending} 筆待傳` : '已同步';
}
(() => {
  const btn = document.getElementById('levelBtn'), box = document.getElementById('levelInfo');
  const set = open => { box.hidden = !open; btn.setAttribute('aria-expanded', open); };
  btn.onclick = e => { e.stopPropagation(); set(box.hidden); };
  document.addEventListener('click', e => { if (!box.hidden && !box.contains(e.target)) set(false); });
  window.addEventListener('hashchange', () => set(false));
})();
document.getElementById('statusBtn').onclick = () => {
  if (!hasApi()) { location.hash = '#/settings'; return; }
  openSheet(el('div', {},
    el('h2', { style: 'margin-top:0' }, '同步狀態'),
    el('dl', { class: 'kv' },
      el('dt', {}, '網路'), el('dd', {}, navigator.onLine ? '連線中' : '離線'),
      el('dt', {}, '待上傳'), el('dd', {}, S.queue.length + ' 筆'),
      el('dt', {}, '上次同步'), el('dd', {}, S.lastSync ? fmtTime(S.lastSync) : '尚未同步'),
      S.syncError ? el('dt', {}, '錯誤') : null, S.syncError ? el('dd', { class: 'warn' }, S.syncError) : null),
    el('p', { class: 'muted small' }, '沒有網路時打卡會先存在手機裡，恢復連線或重新開啟 App 時自動上傳。'),
    el('button', { class: 'btn', onclick: async () => { closeSheet(); await sync({ loud: true }); if (!S.syncError) toast('同步完成'); } }, '立即同步')));
};

/* ================= 頁面 ================= */
const view = document.getElementById('view');
const setView = (...kids) => view.replaceChildren(...kids.flat().filter(k => k != null && k !== false));
let mapObj = null;

function route() {
  const h = location.hash.replace(/^#\/?/, '') || 'home';
  const [path, qs] = h.split('?');
  const parts = path.split('/').map(decodeURIComponent);
  return { name: parts[0], arg: parts[1], q: new URLSearchParams(qs || '') };
}
function render() {
  const r = route();
  if (r.name !== 'trail') stopWatch();
  if (r.name !== 'map' && mapObj) { mapObj.remove(); mapObj = null; }
  document.querySelectorAll('.tabbar a').forEach(a => a.classList.toggle('active',
    a.dataset.tab === r.name || (a.dataset.tab === 'routes' && r.name === 'trail')));
  view.className = r.name === 'map' ? 'full' : '';
  const pages = { home: pageHome, routes: pageRoutes, trail: pageTrail, map: pageMap, add: pageAdd, settings: pageSettings };
  (pages[r.name] || pageHome)(r);
  renderStatus();
}
window.addEventListener('hashchange', () => { closeSheet(); render(); window.scrollTo(0, 0); });

/* ---------- 首頁 ---------- */
function pageHome() {
  const P = progress();
  const card = el('div', { class: 'card hero' },
    el('div', { class: 'muted' }, '總完成率'),
    el('div', { class: 'big' }, pct(P.total.p), el('small', {}, '%')),
    bar(P.total.p),
    el('div', { class: 'muted small' }, `已走 ${kmTxt(P.total.kmDone)} / ${kmTxt(P.total.km)} km・完成 ${S.trails.filter(t => P.trail[t.id].complete).length} / ${S.trails.length} 條`));
  const routes = el('div', { class: 'card' }, ROUTES.map(r => {
    const x = P.route[r];
    return el('a', { class: 'routebar', href: '#/routes/' + encodeURIComponent(r) },
      el('div', { class: 'row' }, el('b', { class: 'grow' }, r), el('span', { class: 'muted small' }, `${x.complete}/${x.n} 條・${kmTxt(x.kmDone)}/${kmTxt(x.km)} km・${pct(x.p)}%`)),
      bar(x.p, routeVar(r)));
  }));
  const badges = ROUTES.filter(r => P.route[r].n && P.route[r].complete === P.route[r].n);
  const recent = P.checkins.slice(0, 5);
  setView(
    card,
    el('div', { class: 'cta-wrap', style: 'position:static;margin:0 0 12px' }, el('button', { class: 'btn', onclick: () => doCheckin(null) }, '📍 在此打卡')),
    !hasApi() ? el('div', { class: 'card' }, el('b', {}, '尚未設定同步'), el('p', { class: 'muted small', style: 'margin:6px 0 10px' }, '打卡會先存在這支手機。設定 GAS 網址與通行碼後即可同步到試算表。'), el('a', { class: 'btn small secondary', href: '#/settings' }, '前往設定')) : null,
    badges.length ? el('div', { class: 'badge-row', style: 'margin-bottom:12px' }, badges.map(r => el('span', { class: 'badge' }, `🏅 ${r} 全制霸`))) : null,
    routes,
    el('h2', {}, '最近紀錄'),
    recent.length ? el('div', { class: 'card' }, recent.map(recRow)) : el('div', { class: 'empty card' }, '還沒有打卡紀錄，出發吧！'));
}
function recRow(c) {
  const t = S.byId[c.trailId]; const l = S.lmById[c.landmarkId];
  return el('a', { class: 'rec', href: '#/trail/' + c.trailId, style: 'text-decoration:none' },
    el('span', {}, c.verify || (c.source === '補登' ? '📝' : '✅')),
    el('div', { class: 'grow' }, el('div', {}, (l ? l.name : c.landmarkName) || '（地標已移除）'), el('div', { class: 'muted small' }, `${t ? t.route + '｜' + t.name : ''}・${fmtTime(c.time)}`)),
    c.synced ? null : el('span', { class: 'chip', title: '尚未上傳' }, '待傳'));
}

/* ---------- 路段列表 ---------- */
function pageRoutes(r) {
  const cur = ROUTES.includes(r.arg) ? r.arg : (sessionGet('route') || ROUTES[0]);
  sessionSet('route', cur);
  const P = progress(); const x = P.route[cur];
  const list = S.trails.filter(t => t.route === cur);
  setView(
    el('nav', { class: 'seg' }, ROUTES.map(n => el('a', { href: '#/routes/' + encodeURIComponent(n), class: n === cur ? 'active' : '' }, n))),
    el('div', { class: 'card' },
      el('div', { class: 'row', style: 'margin-bottom:8px' }, el('b', { class: 'grow' }, `${cur}・${pct(x.p)}%`), el('span', { class: 'muted small' }, `${x.complete}/${x.n} 條・${kmTxt(x.kmDone)}/${kmTxt(x.km)} km`)),
      bar(x.p, routeVar(cur))),
    ...list.map(t => {
      const tp = P.trail[t.id];
      return el('a', { class: 'card trail', href: '#/trail/' + t.id },
        el('div', { class: 'ring' + (tp.complete ? ' done' : ''), style: `--p:${pct(tp.p)}` }, el('span', {}, tp.complete ? '🏅' : pct(tp.p) + '%')),
        el('div', { class: 'grow' },
          el('div', { class: 'name' }, `${t.order}. ${t.name}`),
          el('div', { class: 'meta' }, `${t.km ?? '—'} km・${t.level || ''}・地標 ${tp.done}/${tp.total}`)),
        el('span', { class: 'chev' }, '›'));
    }));
}
function sessionGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
function sessionSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { } }

/* ---------- 路段詳情 ---------- */
function pageTrail(r) {
  const t = S.byId[r.arg];
  if (!t) { setView(el('div', { class: 'empty' }, '找不到這個路段'), el('a', { class: 'btn secondary', href: '#/routes' }, '回路段列表')); return; }
  const P = progress(); const tp = P.trail[t.id];
  const recs = P.checkins.filter(c => c.trailId === t.id);
  const lmList = el('div', { class: 'card' });
  const drawLms = () => {
    const pos = S.pos && S.pos.coords;
    lmList.replaceChildren(...t.landmarks.map(l => {
      const c = P.doneLm.get(l.id);
      const d = pos && l.lat ? distM(pos.latitude, pos.longitude, l.lat, l.lng) : null;
      return el('div', { class: 'lm' + (c ? ' done' : '') },
        el('div', { class: 'ic' }, c ? '✓' : l.seq),
        el('div', { class: 'grow' },
          el('div', { class: 'nm' }, l.name, l.kind === '途中點' ? el('span', { class: 'muted small' }, '　（GPX 推算）') : null),
          el('div', { class: 'sub' }, c ? `${c.verify || ''} ${fmtTime(c.time)}・${c.source}` : (l.kind || '') + (l.atKm != null ? `・約 ${l.atKm} km 處` : ''))),
        d != null ? el('span', { class: 'dist' }, fmtDist(d)) : null);
    }));
  };
  drawLms();
  startWatch(drawLms);
  setView(
    el('a', { href: '#/routes/' + encodeURIComponent(t.route), class: 'linkbtn', style: 'padding-left:0' }, `‹ ${t.route}`),
    el('h1', {}, t.name),
    el('div', { class: 'row', style: 'flex-wrap:wrap;gap:8px;margin-bottom:12px' },
      el('span', { class: 'chip' }, `${t.km ?? '—'} km`), t.level ? el('span', { class: 'chip' }, t.level) : null,
      el('span', { class: 'chip' }, `完成 ${pct(tp.p)}%`), tp.complete ? el('span', { class: 'badge' }, '🏅 完成') : null),
    el('div', { class: 'muted small', style: 'margin-bottom:12px' }, `${t.start} → ${t.end}`),
    lmList,
    el('div', { class: 'row', style: 'gap:8px' },
      t.url ? el('a', { class: 'btn small secondary grow', href: t.url, target: '_blank', rel: 'noopener' }, '官網介紹') : null,
      el('a', { class: 'btn small secondary grow', href: '#/map?trail=' + t.id }, '看地圖'),
      el('a', { class: 'btn small secondary grow', href: '#/add?trail=' + t.id }, '補登')),
    recs.length ? el('h2', {}, '這段的紀錄') : null,
    recs.length ? el('div', { class: 'card' }, recs.map(c => {
      const l = S.lmById[c.landmarkId];
      return el('div', { class: 'rec' },
        el('span', {}, c.verify || '✅'),
        el('div', { class: 'grow' },
          el('div', {}, (l ? l.name : c.landmarkName), c.synced ? null : el('span', { class: 'chip', style: 'margin-left:6px' }, '待傳')),
          el('div', { class: 'muted small' }, `${fmtTime(c.time)}・${c.source}${c.dist != null ? `・距 ${fmtDist(c.dist)}` : ''}${c.acc != null ? `（±${c.acc}m）` : ''}`),
          c.note ? el('div', { class: 'small' }, '💬 ' + c.note) : null),
        el('button', { class: 'linkbtn', onclick: () => noteSheet(c.uuid) }, '心得'),
        el('button', { class: 'linkbtn warn', onclick: () => confirmDelete(c) }, '刪除'));
    })) : null,
    t.note ? el('p', { class: 'muted small' }, 'ℹ️ 資料備註：' + t.note) : null,
    el('div', { class: 'cta-wrap' }, el('button', { class: 'btn', onclick: () => doCheckin(t.id) }, '📍 在此打卡')));
}
function confirmDelete(c) {
  openSheet(el('div', {}, el('h2', { style: 'margin-top:0' }, '刪除這筆紀錄？'),
    el('p', {}, `${c.landmarkName || ''}・${fmtTime(c.time)}`),
    el('button', { class: 'btn danger', onclick: async () => { closeSheet(); await removeCheckin(c.uuid); render(); toast('已刪除'); } }, '刪除'),
    el('button', { class: 'btn secondary', style: 'margin-top:10px', onclick: closeSheet }, '取消')));
}

/* ---------- 地圖 ---------- */
function pageMap(r) {
  const P = progress();
  const box = el('div', { id: 'map' });
  const fab = el('div', { class: 'mapfab' });
  const legend = el('div', { class: 'legend' },
    el('div', {}, el('i', { style: 'background:var(--ok)' }), '完成'),
    el('div', {}, el('i', { style: 'background:var(--warn)' }), '進行中'),
    el('div', {}, el('i', { style: 'background:#8a948e' }), '未走'));
  box.append(fab, legend);
  setView(box);
  if (typeof L === 'undefined') { box.append(el('div', { class: 'empty' }, '地圖元件尚未載入（需要網路一次）')); return; }
  const css = getComputedStyle(document.documentElement);
  const col = { done: css.getPropertyValue('--ok').trim(), part: css.getPropertyValue('--warn').trim(), none: '#8a948e' };
  mapObj = L.map(box, { zoomControl: false, attributionControl: true }).setView([25.0, 121.75], 10);
  const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenStreetMap, © OpenTopoMap' });
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
  topo.addTo(mapObj);
  L.control.layers({ '地形圖': topo, '街道圖': osm }, null, { position: 'topright' }).addTo(mapObj);
  const focus = r.q.get('trail');
  let focusBounds = null;
  S.trails.forEach(t => {
    const tp = P.trail[t.id];
    const c = tp.complete ? col.done : tp.done ? col.part : col.none;
    const popup = () => el('div', {}, el('b', {}, t.name), el('div', {}, `${t.route}・${t.km ?? '—'} km・完成 ${pct(tp.p)}%`), el('a', { class: 'btn', href: '#/trail/' + t.id }, '開啟路段'));
    if (t.track.length > 1) {
      const line = L.polyline(t.track, { color: c, weight: t.id === focus ? 7 : 5, opacity: .9 }).addTo(mapObj).bindPopup(popup);
      if (t.id === focus) focusBounds = line.getBounds();
    }
    t.landmarks.forEach(l => {
      if (!l.lat) return;
      const done = P.doneLm.has(l.id);
      L.circleMarker([l.lat, l.lng], { radius: l.kind === '途中點' ? 5 : 7, color: done ? col.done : '#555', weight: 2, fillColor: done ? col.done : '#fff', fillOpacity: 1 })
        .addTo(mapObj).bindPopup(() => el('div', {}, el('b', {}, l.name), el('div', { class: 'small' }, `${t.name}・${done ? '已打卡' : '未打卡'}`), el('a', { class: 'btn', href: '#/trail/' + t.id }, '開啟路段')));
      if (t.id === focus && !focusBounds) focusBounds = L.latLngBounds([[l.lat, l.lng]]);
      if (t.id === focus && focusBounds) focusBounds.extend([l.lat, l.lng]);
    });
  });
  if (focusBounds) mapObj.fitBounds(focusBounds.pad(0.2));
  let me = null;
  const locate = async () => {
    try {
      const p = await getPosition(); const ll = [p.coords.latitude, p.coords.longitude];
      if (me) me.remove();
      me = L.layerGroup([L.circle(ll, { radius: p.coords.accuracy, weight: 1, color: '#3b6fb6', fillOpacity: .12 }), L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#3b6fb6', fillOpacity: 1 })]).addTo(mapObj);
      mapObj.setView(ll, Math.max(mapObj.getZoom(), 15));
    } catch (e) { toast(e.message); }
  };
  fab.append(el('button', { onclick: locate, 'aria-label': '我的位置' }, '◎'), el('button', { onclick: () => doCheckin(null), 'aria-label': '打卡' }, '📍'));
  setTimeout(() => mapObj && mapObj.invalidateSize(), 50);
}

/* ---------- 補登 ---------- */
function pageAdd(r) {
  const P = progress();
  const pre = S.byId[r.q.get('trail')];
  let curRoute = pre ? pre.route : (sessionGet('route') || ROUTES[0]);
  let curTrail = pre ? pre.id : null;
  const selRoute = el('select', { class: 'in' }, ROUTES.map(n => el('option', { value: n }, n)));
  const selTrail = el('select', { class: 'in' });
  const checks = el('div', { class: 'checks' });
  const now = new Date(); const p2 = n => String(n).padStart(2, '0');
  const date = el('input', { class: 'in', type: 'date', value: `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`, max: `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}` });
  const time = el('input', { class: 'in', type: 'time', value: '12:00' });
  const note = el('textarea', { class: 'in', placeholder: '選填：天氣、路況、同行…' });
  const fillTrails = () => {
    const ts = S.trails.filter(t => t.route === curRoute);
    if (!ts.some(t => t.id === curTrail)) curTrail = ts[0] && ts[0].id;
    selTrail.replaceChildren(...ts.map(t => el('option', { value: t.id }, `${t.order}. ${t.name}（${pct(P.trail[t.id].p)}%）`)));
    selTrail.value = curTrail; fillChecks();
  };
  const fillChecks = () => {
    const t = S.byId[curTrail]; if (!t) { checks.replaceChildren(); return; }
    const all = el('label', {}, el('input', { type: 'checkbox', 'data-all': 1, onchange: e => checks.querySelectorAll('input[data-id]').forEach(i => { if (!i.disabled) i.checked = e.target.checked; }) }), el('b', {}, '整段全部'));
    checks.replaceChildren(all, ...t.landmarks.map(l => {
      const done = P.doneLm.has(l.id);
      return el('label', { class: done ? 'was' : '' }, el('input', { type: 'checkbox', 'data-id': l.id }),
        el('span', { class: 'grow' }, `${l.seq}. ${l.name}`), done ? el('span', { class: 'small ok' }, '已打卡') : null);
    }));
  };
  selRoute.value = curRoute;
  selRoute.onchange = () => { curRoute = selRoute.value; curTrail = null; fillTrails(); };
  selTrail.onchange = () => { curTrail = selTrail.value; fillChecks(); };
  fillTrails();
  const save = el('button', { class: 'btn' }, '儲存補登');
  save.onclick = async () => {
    const ids = [...checks.querySelectorAll('input[data-id]:checked')].map(i => i.dataset.id);
    if (!ids.length) return toast('請至少勾選一個地標');
    if (!date.value) return toast('請選日期');
    const ts = new Date(`${date.value}T${time.value || '12:00'}:00`);
    for (const [i, id] of ids.entries()) {
      const l = S.lmById[id];
      await addCheckin(l, { source: '補登', verify: '📝', time: new Date(ts.getTime() + i * 1000).toISOString(), note: note.value.trim() });
    }
    toast(`📝 已補登 ${ids.length} 個地標`);
    location.hash = '#/trail/' + curTrail;
  };
  setView(
    el('h1', {}, '補登紀錄'),
    el('label', { class: 'f' }, el('span', {}, '路線'), selRoute),
    el('label', { class: 'f' }, el('span', {}, '路段'), selTrail),
    el('div', { class: 'f', style: 'margin-bottom:14px' }, el('span', { class: 'muted small', style: 'display:block;margin-bottom:6px' }, '走過的地標'), checks),
    el('div', { class: 'two' }, el('label', { class: 'f' }, el('span', {}, '日期'), date), el('label', { class: 'f' }, el('span', {}, '時間'), time)),
    el('label', { class: 'f' }, el('span', {}, '心得'), note),
    el('div', { class: 'cta-wrap' }, save));
}

/* ---------- 設定 ---------- */
function pageSettings() {
  const api = el('input', { class: 'in', type: 'url', placeholder: 'https://script.google.com/macros/s/…/exec', value: S.settings.api, autocomplete: 'off' });
  const tok = el('input', { class: 'in', type: 'text', placeholder: '執行 setup 後得到的通行碼', value: S.settings.token, autocomplete: 'off', autocapitalize: 'off' });
  const saveBtn = el('button', { class: 'btn' }, '儲存並測試連線');
  saveBtn.onclick = async () => {
    S.settings = { api: api.value.trim(), token: tok.value.trim() };
    await store.set('settings', S.settings);
    if (!hasApi()) return toast('已儲存（未設定同步）');
    saveBtn.disabled = true; saveBtn.textContent = '測試中…';
    try {
      const u = new URL(S.settings.api); u.searchParams.set('token', S.settings.token); u.searchParams.set('action', 'ping');
      const d = await (await fetchT(u.toString(), {}, 20000)).json();
      if (!d.ok) throw new Error(d.error);
      toast('✅ 連線成功，開始同步'); await sync({ loud: true });
    } catch (e) { toast('連線失敗：' + (e.message || e)); }
    saveBtn.disabled = false; saveBtn.textContent = '儲存並測試連線';
  };
  const exportBtn = el('button', { class: 'btn secondary' }, '匯出備份（JSON）');
  exportBtn.onclick = () => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), checkins: checkins() }, null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `danlan-backup-${Date.now()}.json` }); document.body.append(a); a.click(); a.remove();
  };
  const theme = el('select', { class: 'in' }, el('option', { value: '' }, '跟隨系統'), el('option', { value: 'light' }, '淺色'), el('option', { value: 'dark' }, '深色'));
  theme.value = localGet('theme') || '';
  theme.onchange = () => { localSet('theme', theme.value); applyTheme(); };
  setView(
    el('h1', {}, '設定'),
    el('div', { class: 'card' },
      el('label', { class: 'f' }, el('span', {}, 'GAS 網頁應用程式網址'), api),
      el('label', { class: 'f' }, el('span', {}, '通行碼'), tok),
      saveBtn),
    el('div', { class: 'card' },
      el('dl', { class: 'kv' },
        el('dt', {}, '待上傳'), el('dd', {}, S.queue.length + ' 筆'),
        el('dt', {}, '上次同步'), el('dd', {}, S.lastSync ? fmtTime(S.lastSync) : '尚未同步'),
        el('dt', {}, '路段資料'), el('dd', {}, `${S.trails.length} 條・${Object.keys(S.lmById).length} 個地標`),
        el('dt', {}, '資料來源'), el('dd', {}, (S.base && S.base.source) || '')),
      el('div', { style: 'display:grid;gap:10px;margin-top:14px' },
        el('button', { class: 'btn secondary', onclick: () => sync({ loud: true }) }, '立即同步'), exportBtn)),
    el('div', { class: 'card' }, el('label', { class: 'f', style: 'margin:0' }, el('span', {}, '外觀'), theme)),
    el('p', { class: 'muted small' }, 'iPhone：用 Safari 開啟 → 分享 → 加入主畫面。Android：Chrome 選單 → 安裝應用程式。加到主畫面後再使用，資料才不會被系統清除。'));
}
function localGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function localSet(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { } }
function applyTheme() { const t = localGet('theme'); if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }

/* ================= 啟動 ================= */
(async function init() {
  applyTheme();
  await loadState();
  render();
  sync();
  window.addEventListener('online', () => { renderStatus(); sync(); });
  window.addEventListener('offline', renderStatus);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync({ rerender: route().name !== 'add' }); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });
})();
