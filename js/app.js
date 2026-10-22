(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const grid = $('grid'), info = $('info'), warn = $('warn'), empty = $('empty'), detail = $('detail'), histEl = $('history'), q = $('q');
  const pl = $('pl'), player = $('player');
  const profilesEl = $('profiles'), appHeader = $('appHeader'), appMain = $('appMain');
  const rateDlg = $('rateDlg'), newDlg = $('newDlg'), delDlg = $('delDlg');
  const MODALS = [rateDlg, newDlg, delDlg];

  const state = {
    lib: { movies: [], series: [], warnings: [], config: {} }, index: new Map(),
    me: null, profiles: [], hist: {}, mine: {}, summary: {},
    tab: 'movies', view: 'profiles', series: null, movie: null, season: null,
    seriesList: [], seriesKeys: [], seriesLabels: {}, managing: false, pending: null
  };
  let playlist = [], current = -1, refreshers = [], epRefreshers = [];

  /* ---------- marca, modo TV y teclas del mando ---------- */
  const IS_TV = /Tizen|Web0S|webOS|SMART-TV|SmartTV|BRAVIA|NetCast|HbbTV|VIDAA|Roku|CrKey|PhilipsTV|AFT[A-Z]|Android.*\bTV\b/i.test(navigator.userAgent) || /[?&]tv=1\b/.test(location.search);
  if (IS_TV) document.documentElement.classList.add('tv');
  // El anillo de foco solo se ve al navegar con teclado o mando, no al hacer clic.
  document.addEventListener('keydown', () => document.body.classList.add('kbd'), true);
  document.addEventListener('pointerdown', () => document.body.classList.remove('kbd'), true);

  // Teclas de mando a distancia → acción. Cubre PC, Tizen (Samsung), webOS (LG) y Android TV.
  const KEYMAP = {
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Enter: 'ok',
    Escape: 'back', Backspace: 'back', BrowserBack: 'back', GoBack: 'back', XF86Back: 'back',
    MediaPlayPause: 'playpause', MediaPlay: 'play', MediaPause: 'pause', MediaStop: 'stop',
    MediaRewind: 'rew', MediaFastForward: 'ffwd', MediaTrackNext: 'next', MediaTrackPrevious: 'prev'
  };
  const CODEMAP = {
    37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'ok', 8: 'back', 27: 'back',
    10009: 'back', 461: 'back',                                   // Tizen y webOS: «Atrás»
    179: 'playpause', 10252: 'playpause', 415: 'play', 19: 'pause', 413: 'stop',
    412: 'rew', 417: 'ffwd', 10232: 'prev', 10233: 'next', 176: 'next', 177: 'prev'
  };
  const remoteKey = e => KEYMAP[e.key] || CODEMAP[e.keyCode] || null;
  try {   // Tizen exige registrar las teclas multimedia
    if (window.tizen && window.tizen.tvinputdevice) ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaRewind', 'MediaFastForward', 'MediaTrackPrevious', 'MediaTrackNext']
      .forEach(k => { try { window.tizen.tvinputdevice.registerKey(k); } catch {} });
  } catch {}

  // Logo y nombre personalizables (config.json → "logo", "nombre").
  const brand = { name: 'Cine local', page: '' };
  function setTitle(t) { brand.page = t || ''; document.title = t ? `${t} · ${brand.name}` : brand.name; }
  async function loadBranding() {
    try {
      const b = await api('/api/branding');
      brand.name = b.name || brand.name;
      const v = Date.now();
      ['plLogo', 'plLogoBig'].forEach(id => {
        const img = $(id);
        img.onerror = () => { img.hidden = true; };
        img.onload = () => { img.hidden = false; };
        img.src = `${b.logo}?v=${v}`;
      });
      document.querySelectorAll('.brand-name').forEach(el => { el.textContent = brand.name; });
    } catch {}
    setTitle(brand.page);
  }

  /* ---------- utilidades ---------- */
  const fmtSize = b => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(0) + ' MB';
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const starStr = n => '★'.repeat(n) + '✩'.repeat(5 - n);
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const code = (season, n) => `T${season}C${n ?? '?'}`;

  function fmtDate(ts) {
    const d = new Date(ts), n = new Date();
    const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(n) - day(d)) / 864e5);
    if (diff === 0) return 'Hoy';
    if (diff === 1) return 'Ayer';
    return `${String(d.getDate()).padStart(2, '0')} ${MESES[d.getMonth()]} del ${d.getFullYear()}`;
  }

  async function api(path, body) {
    const r = await fetch(path, body === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data = null;
    try { data = await r.json(); } catch {}
    if (!r.ok) throw new Error((data && data.error) || 'Error ' + r.status);
    return data;
  }

  /* ---------- progreso del perfil actual ---------- */
  const getProg = e => state.hist[e.key] || null;
  const barPct = e => { const p = getProg(e); return p && p.d && p.t > 5 && p.t < p.d - 5 ? p.t / p.d * 100 : 0; };

  const LSP = 'cl:prog:';   // copia local: cl:prog:<perfil>:<clave del video>

  function sendProgress(key, rec, unloading) {
    const body = JSON.stringify({ profile: state.me.id, key, t: rec.t, d: rec.d, pct: rec.pct });
    if (unloading && navigator.sendBeacon) { navigator.sendBeacon('/api/history', new Blob([body], { type: 'application/json' })); return; }
    fetch('/api/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  }

  // Guarda posición y porcentaje: en memoria, en localStorage y en el servidor.
  function recordProgress(entry, ended, unloading) {
    if (!state.me) return;
    const d = player.duration;
    if (!isFinite(d) || !d) return;
    const t = player.currentTime;
    if (!ended && t < 3) return;
    const finished = ended || t > d - 8;
    const prev = state.hist[entry.key];
    const rec = { t: finished ? 0 : t, d, pct: Math.max(prev ? prev.pct || 0 : 0, finished ? 100 : Math.round(t / d * 100)), at: Date.now() };
    state.hist[entry.key] = rec;
    try { localStorage.setItem(LSP + state.me.id + ':' + entry.key, JSON.stringify(rec)); } catch {}
    sendProgress(entry.key, rec, unloading);
  }

  // Si el servidor no llegó a recibir algún guardado, se recupera de la copia local.
  function mergeLocalProgress() {
    const pre = LSP + state.me.id + ':';
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(pre)) continue;
      try {
        const rec = JSON.parse(localStorage.getItem(k)), key = k.slice(pre.length), cur = state.hist[key];
        if (rec && state.index.has(key) && (!cur || rec.at > cur.at)) { state.hist[key] = rec; sendProgress(key, rec); }
      } catch {}
    }
  }

  /* ---------- avatares y carátulas ---------- */
  const hue = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const initials = it => it.abbr || it.title.split(/\s+/).filter(Boolean).slice(0, 3).map(w => w[0]).join('').toUpperCase();

  function avatarEl(p, cls = '') {
    const a = document.createElement('span');
    a.className = 'avatar ' + cls;
    if (p.avatar) {
      const img = new Image();
      img.alt = ''; img.src = p.avatar;
      img.onerror = () => { img.remove(); a.style.background = `hsl(${hue(p.name)} 35% 38%)`; a.textContent = (p.name[0] || '?').toUpperCase(); };
      a.append(img);
    } else {
      a.style.background = `hsl(${hue(p.name)} 35% 38%)`;
      a.textContent = (p.name[0] || '?').toUpperCase();
    }
    return a;
  }

  function fillPoster(el, it) {
    const ph = document.createElement('div');
    ph.className = 'ph';
    ph.style.background = `hsl(${hue(it.title)} 28% 22%)`;
    const b = document.createElement('b'); b.textContent = initials(it); ph.append(b);
    el.prepend(ph);
    if (it.cover) {
      const img = new Image();
      img.alt = ''; img.loading = 'lazy'; img.src = it.cover;
      img.onerror = () => img.remove();
      el.prepend(img);
      el.prepend(ph);
    }
  }

  function posterCard(it, { meta, entry, onClick, fk }) {
    const b = document.createElement('button');
    b.className = 'card'; b.type = 'button';
    b.dataset.title = it.title;
    if (fk) b.dataset.fk = fk;
    b.addEventListener('click', onClick);
    b.innerHTML = `
      <div class="poster"><div class="play"><span><svg width="22" height="22" viewBox="0 0 24 24"><path d="M6 4l14 8-14 8z"/></svg></span></div></div>
      <p class="name"></p><p class="meta"></p>`;
    const poster = b.querySelector('.poster');
    fillPoster(poster, it);
    b.querySelector('.name').textContent = it.title;
    b.querySelector('.meta').textContent = meta;
    if (entry) {
      const refresh = () => {
        poster.querySelector('.bar')?.remove();
        const w = barPct(entry);
        if (w) { const bar = document.createElement('div'); bar.className = 'bar'; bar.style.width = w + '%'; poster.append(bar); }
      };
      refresh();
      refreshers.push(refresh);
    }
    return b;
  }

  /* ---------- calificaciones: promedios ---------- */
  function ratingOf(keys) {
    let sum = 0, n = 0;
    keys.forEach(k => { const s = state.summary[k]; if (s) { sum += s.sum; n += s.n; } });
    return { sum, n, avg: n ? sum / n : 0 };
  }
  const ratingText = keys => {
    const r = ratingOf(keys);
    return r.n ? `★ ${r.avg.toFixed(1)} · ${plural(r.n, 'calificación', 'calificaciones')}` : 'Sin calificaciones todavía';
  };
  const seriesKeysOf = s => s.seasons.flatMap(se => se.episodes.map(e => e.entry.key));
  const countEps = s => s.seasons.reduce((n, x) => n + x.episodes.length, 0);

  /* ---------- perfiles ---------- */
  function setManaging(on) {
    state.managing = on;
    $('profileRow').classList.toggle('managing', on);
    const b = $('pfManage');
    b.textContent = on ? 'Listo' : 'Administrar perfiles';
    b.setAttribute('aria-pressed', String(on));
  }

  async function showProfiles(focusId) {
    state.view = 'profiles';
    appHeader.hidden = true; appMain.hidden = true; profilesEl.hidden = false;
    const row = $('profileRow'), msg = $('pfMsg');
    msg.textContent = '';
    try { state.profiles = await api('/api/profiles'); }
    catch (e) { state.profiles = []; msg.textContent = 'No se pudo conectar con el servidor. ¿Sigue abierto "node server.js"?'; }

    row.innerHTML = '';
    state.profiles.forEach(p => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'pf'; b.dataset.id = p.id; b.setAttribute('role', 'listitem');
      b.append(avatarEl(p));
      const badge = document.createElement('span'); badge.className = 'edit-badge'; badge.textContent = '✎'; b.append(badge);
      const n = document.createElement('span'); n.className = 'pf-name'; n.textContent = p.name; b.append(n);
      b.onclick = () => (state.managing ? openEditProfile(p) : selectProfile(p));
      row.append(b);
    });
    const add = document.createElement('button');
    add.type = 'button'; add.className = 'pf add'; add.setAttribute('role', 'listitem');
    add.innerHTML = '<span class="avatar"><span>+</span></span><span class="pf-name">Nuevo perfil</span>';
    add.onclick = openNewProfile;
    row.append(add);
    if (!state.profiles.length && !msg.textContent) msg.textContent = 'Crea tu primer perfil para empezar.';

    $('pfManage').hidden = !state.profiles.length;
    if (!state.profiles.length) setManaging(false); else setManaging(state.managing);
    let last = focusId || null; try { last = last || localStorage.getItem('cl:last'); } catch {}
    focusEl(row.querySelector(`.pf[data-id="${last}"]`) || row.firstElementChild);
  }

  async function selectProfile(p) {
    state.me = p;
    try { localStorage.setItem('cl:last', p.id); } catch {}
    profilesEl.hidden = true; appHeader.hidden = false; appMain.hidden = false;
    const me = $('me');
    me.innerHTML = '';
    me.append(avatarEl(p, 'sm'));
    const n = document.createElement('span'); n.className = 'me-name'; n.textContent = p.name; me.append(n);

    state.series = null; state.movie = null; state.view = 'home';
    detail.hidden = true; histEl.hidden = true; grid.innerHTML = '';
    info.textContent = 'Cargando…';
    try { await Promise.all([loadUser(), loadLibrary()]); mergeLocalProgress(); }
    catch (e) { info.textContent = e.message; return; }
    pollConversion();
    const target = state.pending || '/';          // si llegó por un enlace directo, se abre ese contenido
    state.pending = null;
    const kind = parseRoute(...(u => [u.pathname, u.search])(new URL(target, location.origin))).name;
    if (kind === 'watch' || kind === 'episode') go(parentUrl(target));   // primero la ficha, para que «Volver» tenga adónde ir
    go(target);
  }

  /* nuevo perfil / editar perfil */
  const np = { photo: null, edit: null, removePhoto: false };
  const paintNpPreview = () => {
    const box = $('npPrev');
    box.innerHTML = '';
    const src = np.photo || (np.edit && !np.removePhoto ? np.edit.avatar : null);
    box.append(avatarEl({ name: $('npName').value.trim() || '?', avatar: src }));
    $('npClear').hidden = !src;
  };
  function openNewProfile() {
    Object.assign(np, { photo: null, edit: null, removePhoto: false });
    $('npTitle').textContent = 'Nuevo perfil';
    $('npCreate').textContent = 'Crear perfil';
    $('npDelete').hidden = true;
    $('npName').value = ''; $('npErr').hidden = true;
    paintNpPreview();
    newDlg.showModal();
    $('npName').focus();
  }
  function openEditProfile(p) {
    Object.assign(np, { photo: null, edit: p, removePhoto: false });
    $('npTitle').textContent = 'Editar perfil';
    $('npCreate').textContent = 'Guardar cambios';
    $('npDelete').hidden = false;
    $('npName').value = p.name; $('npErr').hidden = true;
    paintNpPreview();
    newDlg.showModal();
    $('npName').focus();
    $('npName').select();
  }
  function squareJpeg(file, size) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const s = Math.min(img.width, img.height), c = document.createElement('canvas');
        c.width = c.height = size;
        c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('imagen')); };
      img.src = url;
    });
  }
  $('npPick').onclick = () => $('npFile').click();
  $('npClear').onclick = () => { np.photo = null; np.removePhoto = true; paintNpPreview(); };
  $('npFile').onchange = async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { np.photo = await squareJpeg(f, 256); np.removePhoto = false; paintNpPreview(); $('npErr').hidden = true; }
    catch { $('npErr').textContent = 'No se pudo leer esa imagen.'; $('npErr').hidden = false; }
  };
  $('npName').addEventListener('input', paintNpPreview);
  $('npName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('npCreate').click(); } });
  $('npCancel').onclick = () => newDlg.close();
  $('npCreate').onclick = async () => {
    const name = $('npName').value.trim();
    const err = $('npErr');
    if (!name) { err.textContent = 'Escribe un nombre de usuario.'; err.hidden = false; $('npName').focus(); return; }
    try {
      let focusId;
      if (np.edit) {
        await api('/api/profiles/update', { id: np.edit.id, name, photo: np.photo, removePhoto: np.removePhoto });
        focusId = np.edit.id;
      } else {
        const p = await api('/api/profiles', { name, photo: np.photo });
        try { localStorage.setItem('cl:last', p.id); } catch {}
        focusId = p.id;
      }
      newDlg.close();
      await showProfiles(focusId);
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  };

  /* eliminar perfil (contraseña de administrador) */
  let delTarget = null;
  function openDelete(p) {
    delTarget = p;
    $('delTitle').textContent = `Eliminar a ${p.name}`;
    $('delText').textContent = `Se borrará el perfil junto con su historial, calificaciones y reseñas. Esta acción no se puede deshacer.`;
    $('delPass').value = ''; $('delErr').hidden = true;
    delDlg.showModal();
    $('delPass').focus();
  }
  $('npDelete').onclick = () => { const p = np.edit; newDlg.close(); openDelete(p); };
  $('delCancel').onclick = () => delDlg.close();
  $('delPass').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('delOk').click(); } });
  $('delOk').onclick = async () => {
    const err = $('delErr'), password = $('delPass').value;
    if (!password) { err.textContent = 'Escribe la contraseña de administrador.'; err.hidden = false; $('delPass').focus(); return; }
    try {
      await api('/api/profiles/delete', { id: delTarget.id, password });
      if (state.me && state.me.id === delTarget.id) state.me = null;
      try { if (localStorage.getItem('cl:last') === delTarget.id) localStorage.removeItem('cl:last'); } catch {}
      delDlg.close();
      await showProfiles();
    } catch (e) { err.textContent = e.message; err.hidden = false; $('delPass').select(); }
  };
  $('pfManage').onclick = () => setManaging(!state.managing);

  /* ---------- carga de datos ---------- */
  async function loadSummary() { state.summary = await api('/api/summary'); }

  async function loadUser() {
    const [h, s] = await Promise.all([api('/api/history?profile=' + encodeURIComponent(state.me.id)), api('/api/summary')]);
    state.hist = h.history || {};
    state.mine = h.ratings || {};
    state.summary = s;
  }

  function buildIndex() {
    const ix = new Map();
    state.lib.movies.forEach(m => ix.set(m.entry.key, { kind: 'movie', movie: m, poster: m, title: m.title, sub: '' }));
    state.lib.series.forEach(s => s.seasons.forEach(se => se.episodes.forEach((e, i) => {
      const n = e.n ?? i + 1;
      ix.set(e.entry.key, { kind: 'ep', series: s, season: se.n, poster: s, title: s.title, sub: code(se.n, n) + (e.title ? ' · ' + e.title : '') });
    })));
    state.index = ix;
  }

  async function loadLibrary() {
    let r;
    try { r = await fetch('/api/library', { cache: 'no-store' }); }
    catch { throw new Error('No se pudo conectar con el servidor. ¿Sigue abierto "node server.js"?'); }
    if (!r.ok) {
      let msg = 'código ' + r.status;
      try { msg = (await r.json()).error || msg; } catch {}
      throw new Error('El servidor falló al leer las carpetas: ' + msg + '. Revisa la consola donde corre node server.js.');
    }
    state.lib = await r.json();
    buildIndex();
  }

  /* ---------- conversión en segundo plano ---------- */
  let convTimer = 0, lastReplaced = null;
  async function pollConversion() {
    clearTimeout(convTimer);
    let c;
    try { c = await api('/api/conversion'); } catch { return; }
    const el = $('conv');
    if (lastReplaced === null) lastReplaced = c.replaced;
    if (c.active) {
      const cur = c.current;
      el.hidden = false;
      el.textContent = (cur && cur.phase === 'replacing' ? 'Sustituyendo el original por el MP4…' : 'Convirtiendo videos a MP4 (H.264 + AAC)…') +
        ` ${Math.min(c.done, c.total)} de ${c.total}` + (cur ? ` · ${cur.name}` + (cur.phase === 'replacing' ? '' : ` (${Math.round(cur.progress * 100)}%)`) : '');
      convTimer = setTimeout(pollConversion, 3000);
    } else {
      el.hidden = true;
      if (c.replaced !== lastReplaced && !playerOpen()) { lastReplaced = c.replaced; refreshAll(); }   // los archivos cambiaron de nombre
    }
  }

  /* ---------- vistas ---------- */
  function renderWarnings() {
    const w = state.lib.warnings || [];
    warn.hidden = !w.length;
    warn.innerHTML = '';
    w.forEach(t => { const p = document.createElement('p'); p.textContent = t; warn.append(p); });
  }

  const setTabs = () => document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === state.tab));
  function showHome() {
    state.view = 'home'; state.series = null; state.movie = null;
    detail.hidden = true; histEl.hidden = true;
    q.hidden = false;
    refreshers = []; epRefreshers = [];
    grid.innerHTML = '';
    const { movies, series } = state.lib;
    $('cMovies').textContent = movies.length;
    $('cSeries').textContent = series.length;
    setTabs();
    renderWarnings();

    const total = movies.length + series.length;
    empty.hidden = total > 0;
    grid.hidden = total === 0;
    if (!total) {
      info.textContent = '';
      const c = state.lib.config || {};
      $('paths').textContent = ['peliculas', 'series', 'caratulas'].map(k => k.padEnd(10) + ' ' + (c[k] || []).join('  |  ')).join('\n');
      return;
    }

    const term = norm(q.value.trim());
    if (state.tab === 'movies') {
      const list = movies.filter(m => norm(m.title).includes(term));
      info.textContent = plural(list.length, 'película', 'películas') + (term ? ' encontradas' : '');
      list.forEach(m => {
        const r = ratingOf([m.entry.key]);
        grid.append(posterCard(m, {
          meta: (r.n ? `★ ${r.avg.toFixed(1)} · ` : '') + fmtSize(m.entry.size), entry: m.entry,
          fk: 'm:' + m.id, onClick: () => go(movieUrl(m))
        }));
      });
    } else {
      const list = series.filter(s => norm(s.title).includes(term));
      info.textContent = plural(list.length, 'serie', 'series') + (term ? ' encontradas' : '');
      list.forEach(s => {
        const r = ratingOf(seriesKeysOf(s));
        grid.append(posterCard(s, {
          meta: (r.n ? `★ ${r.avg.toFixed(1)} · ` : '') + (s.seasons.length > 1 ? plural(s.seasons.length, 'temp.', 'temp.') + ' · ' : '') + plural(countEps(s), 'cap.', 'caps.'),
          fk: 's:' + s.id, onClick: () => go(showUrl(s))
        }));
      });
    }
  }

  /* ---------- historial del perfil ---------- */
  function showHistory() {
    state.view = 'history'; state.series = null; state.movie = null; state.tab = 'history';
    detail.hidden = true; grid.hidden = true; empty.hidden = true; q.hidden = true; histEl.hidden = false;
    histEl.innerHTML = '';
    refreshers = []; epRefreshers = [];
    setTabs();
    renderWarnings();

    const rows = [];
    new Set([...Object.keys(state.hist), ...Object.keys(state.mine)]).forEach(k => {
      const ix = state.index.get(k);
      if (!ix) return;
      const h = state.hist[k], r = state.mine[k];
      rows.push({ ix, h, r, k, at: Math.max(h ? h.at : 0, r ? r.at : 0) });
    });
    rows.sort((a, b) => b.at - a.at);
    info.textContent = rows.length ? `${state.me.name} · ${plural(rows.length, 'título', 'títulos')}` : '';
    if (!rows.length) {
      const p = document.createElement('p'); p.className = 'rv-empty';
      p.textContent = 'Aún no has visto ni calificado nada con este perfil.';
      histEl.append(p);
      return;
    }
    rows.forEach(({ ix, h, r, k, at }) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'hrow'; b.dataset.fk = 'h:' + k;
      b.innerHTML = '<div class="poster"></div><div class="hinfo"><b></b><span class="sub"></span><span class="line"></span><span class="when"></span></div>';
      fillPoster(b.querySelector('.poster'), ix.poster);
      b.querySelector('b').textContent = ix.title;
      const sub = b.querySelector('.sub'); sub.textContent = ix.sub; sub.hidden = !ix.sub;
      const line = b.querySelector('.line');
      line.append(document.createTextNode(h ? `Vio el ${h.pct || 0}%` : 'Sin ver'));
      if (r) {
        line.append(document.createTextNode(' · '));
        const st = document.createElement('span'); st.className = 'st'; st.textContent = starStr(r.stars); line.append(st);
      }
      b.querySelector('.when').textContent = fmtDate(at);
      b.onclick = () => go(ix.kind === 'movie' ? movieUrl(ix.movie) : showUrl(ix.series, ix.season));
      histEl.append(b);
    });
    focusEl(histEl.firstElementChild);
  }

  /* ---------- detalle (película / serie) ---------- */
  function showDetailShell(kind) {
    q.hidden = true; empty.hidden = true; grid.hidden = true; histEl.hidden = true; detail.hidden = false;
    info.textContent = '';
    $('back').textContent = '‹ Volver';
    $('rateBtn').hidden = kind !== 'movie';
    if (kind === 'movie') { $('chips').hidden = true; $('episodes').hidden = true; }
    else $('episodes').hidden = false;
    refreshers = []; epRefreshers = [];
    window.scrollTo(0, 0);
  }

  function updateMovieHeader() {
    const m = state.movie, e = m.entry, p = getProg(e), mine = state.mine[e.key];
    $('sMeta').textContent = fmtSize(e.size);
    $('sRating').textContent = ratingText([e.key]);
    const r = $('resume');
    r.textContent = p && p.t > 5 ? `Continuar viendo · ${p.pct || 0}%` : p && p.pct >= 95 ? 'Ver de nuevo' : 'Reproducir';
    r.onclick = () => go(watchUrl(m));
    const rb = $('rateBtn');
    rb.textContent = mine ? `${starStr(mine.stars)}  Editar mi reseña` : '✩ Calificar';
    rb.onclick = () => openRate(e, m.title);
  }

  function showMovie(m) {
    state.view = 'movie'; state.movie = m; state.series = null;
    showDetailShell('movie');
    $('dPoster').innerHTML = '';
    fillPoster($('dPoster'), m);
    $('sTitle').textContent = m.title;
    updateMovieHeader();
    loadReviews([m.entry.key], {});
    focusEl($('resume'));
  }

  function seriesPlaylist(s) {
    const list = [];
    s.seasons.forEach(se => se.episodes.forEach((e, i) => list.push({
      entry: e.entry, season: se.n, n: e.n ?? i + 1, epTitle: e.title,
      title: `${s.title} · ${code(se.n, e.n ?? i + 1)}${e.title ? ' · ' + e.title : ''}`,
      main: s.title, sub: code(se.n, e.n ?? i + 1) + (e.title ? ' · ' + e.title : ''),
      url: '/show/' + encodeURIComponent(s.id) + '/ep/' + encodeURIComponent(code(se.n, e.n ?? i + 1))
    })));
    return list;
  }

  function resumeInfo(list) {
    let best = -1, at = 0;
    list.forEach((it, i) => { const p = getProg(it.entry); if (p && p.at > at) { at = p.at; best = i; } });
    if (best < 0) return { idx: 0, label: 'Empezar a ver' };
    const p = getProg(list[best].entry);
    return { idx: p.t > 5 ? best : Math.min(best + 1, list.length - 1), label: 'Continuar viendo' };
  }

  function updateSeriesHeader() {
    const s = state.series, list = state.seriesList;
    $('sMeta').textContent = (s.seasons.length > 1 ? plural(s.seasons.length, 'temporada', 'temporadas') + ' · ' : '') + plural(countEps(s), 'capítulo', 'capítulos');
    $('sRating').textContent = ratingText(state.seriesKeys);
    const r = resumeInfo(list), it = list[r.idx];
    $('resume').textContent = `${r.label} · ${code(it.season, it.n)}`;
    $('resume').onclick = () => go(list[r.idx].url);
  }

  function showSeries(s, opts = {}) {
    state.view = 'series'; state.series = s; state.movie = null;
    showDetailShell('series');

    $('dPoster').innerHTML = '';
    fillPoster($('dPoster'), s);
    $('sTitle').textContent = s.title;

    const list = seriesPlaylist(s);
    state.seriesList = list;
    state.seriesKeys = list.map(x => x.entry.key);
    state.seriesLabels = {};
    list.forEach(x => { state.seriesLabels[x.entry.key] = code(x.season, x.n) + (x.epTitle ? ' · ' + x.epTitle : ''); });
    updateSeriesHeader();

    state.season = opts.season ?? list[resumeInfo(list).idx].season;
    renderSeasons(s, list);
    loadReviews(state.seriesKeys, state.seriesLabels);
    focusEl($('resume'));
  }

  function renderSeasons(s, list) {
    const chips = $('chips');
    chips.innerHTML = '';
    chips.hidden = s.seasons.length < 2;
    s.seasons.forEach(se => {
      const c = document.createElement('button');
      c.type = 'button'; c.className = 'chip' + (se.n === state.season ? ' on' : '');
      c.textContent = 'Temporada ' + se.n;
      c.onclick = () => { state.season = se.n; history.replaceState(history.state, '', showUrl(s, se.n)); renderSeasons(s, list); focusEl(chips.querySelector('.chip.on')); };
      chips.append(c);
    });

    epRefreshers = [];
    const ol = $('episodes');
    ol.innerHTML = '';
    const season = s.seasons.find(x => x.n === state.season) || s.seasons[0];
    season.episodes.forEach((e, i) => {
      const num = e.n ?? i + 1;
      const idx = list.findIndex(x => x.entry === e.entry);
      const mine = state.mine[e.entry.key];
      const li = document.createElement('li');
      li.className = 'ep-row';

      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ep';
      b.innerHTML = '<span class="n"></span><span class="et"><b></b><small></small></span><span class="sz"></span>';
      b.querySelector('.n').textContent = num;
      b.querySelector('b').textContent = 'Capítulo ' + num;
      b.querySelector('small').textContent = e.title;
      b.querySelector('small').hidden = !e.title;
      b.querySelector('.sz').textContent = fmtSize(e.entry.size);
      b.dataset.fk = 'e:' + code(season.n, num);
      b.onclick = () => go(list[idx].url);
      const refresh = () => {
        b.querySelector('.bar')?.remove();
        const w = barPct(e.entry);
        if (w) { const bar = document.createElement('div'); bar.className = 'bar'; bar.style.width = w + '%'; b.append(bar); }
      };
      refresh();
      epRefreshers.push(refresh);

      const rb = document.createElement('button');
      rb.type = 'button'; rb.className = 'rate-btn' + (mine ? ' on' : '');
      rb.dataset.key = e.entry.key; rb.dataset.fk = 'r:' + code(season.n, num);
      rb.textContent = mine ? starStr(mine.stars) : '✩ Calificar';
      rb.title = mine ? 'Editar mi reseña' : 'Calificar este capítulo';
      rb.onclick = () => openRate(e.entry, `${s.title} · ${code(season.n, num)}${e.title ? ' · ' + e.title : ''}`);

      li.append(b, rb);
      ol.append(li);
    });
  }

  /* ---------- reseñas junto al póster ---------- */
  let rvToken = 0;
  async function loadReviews(keys, labels) {
    const box = $('reviews'), tok = ++rvToken;
    const msg = t => { box.innerHTML = ''; const p = document.createElement('p'); p.className = 'rv-empty'; p.textContent = t; box.append(p); };
    msg('Cargando reseñas…');
    let data;
    try { data = await api('/api/reviews', { keys }); }
    catch { if (tok === rvToken) msg('No se pudieron cargar las reseñas.'); return; }
    if (tok !== rvToken) return;
    if (!data.reviews.length) return msg('Aún no hay reseñas. ¡Sé el primero en calificar!');

    box.innerHTML = '';
    data.reviews.forEach(r => {
      const art = document.createElement('article');
      art.className = 'rv';
      art.append(avatarEl(r.profile, 'xs'));

      const body = document.createElement('div'); body.className = 'rv-body';
      const head = document.createElement('p'); head.className = 'rv-head';
      const name = document.createElement('b'); name.textContent = r.profile.name;
      const when = document.createElement('span'); when.textContent = ' - ' + fmtDate(r.at);
      head.append(name, when);

      const stars = document.createElement('p'); stars.className = 'rv-stars';
      const st = document.createElement('span'); st.className = 'st'; st.textContent = starStr(r.stars);
      stars.append(st, document.createTextNode(` - Vio el ${r.pct}%` + (labels[r.key] ? ' · ' + labels[r.key] : '')));

      body.append(head, stars);
      if (r.review) { const t = document.createElement('p'); t.className = 'rv-text'; t.textContent = r.review; body.append(t); }
      art.append(body);
      box.append(art);
    });
  }

  /* ---------- calificar ---------- */
  let rate = null;
  function paintStars() {
    [...$('stars').children].forEach((b, i) => {
      const on = i < rate.stars;
      b.textContent = on ? '★' : '✩';
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(i + 1 === rate.stars));
    });
  }
  const setStars = v => { if (!rate) return; rate.stars = v; paintStars(); $('rtErr').hidden = true; };

  function openRate(entry, title) {
    const mine = state.mine[entry.key];
    rate = { entry, stars: mine ? mine.stars : 0 };
    $('rtTitle').textContent = title;
    $('rtText').value = mine ? mine.review : '';
    $('rtErr').hidden = true;
    $('rtDelete').hidden = !mine;
    paintStars();
    rateDlg.showModal();
    $('stars').children[Math.max(rate.stars, 1) - 1].focus();
  }
  [...$('stars').children].forEach(b => { b.onclick = () => setStars(+b.dataset.v); });
  $('rtCancel').onclick = () => rateDlg.close();

  async function afterRate(key) {
    try { await loadSummary(); } catch {}
    if (state.view === 'movie') {
      updateMovieHeader();
      loadReviews([state.movie.entry.key], {});
      focusEl($('rateBtn'));
    } else if (state.view === 'series') {
      updateSeriesHeader();
      renderSeasons(state.series, state.seriesList);
      loadReviews(state.seriesKeys, state.seriesLabels);
      focusEl([...document.querySelectorAll('.rate-btn')].find(b => b.dataset.key === key));
    }
  }

  async function saveRate() {
    if (!rate.stars) { $('rtErr').textContent = 'Elige de 1 a 5 estrellas.'; $('rtErr').hidden = false; return; }
    const key = rate.entry.key, review = $('rtText').value.trim();
    try {
      await api('/api/rating', { profile: state.me.id, key, stars: rate.stars, review });
      state.mine[key] = { stars: rate.stars, review, at: Date.now() };
      rateDlg.close();
      await afterRate(key);
    } catch (e) { $('rtErr').textContent = e.message; $('rtErr').hidden = false; }
  }
  $('rtSave').onclick = saveRate;
  rateDlg.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveRate(); } });
  $('rtDelete').onclick = async () => {
    const key = rate.entry.key;
    try {
      await api('/api/rating/delete', { profile: state.me.id, key });
      delete state.mine[key];
      rateDlg.close();
      await afterRate(key);
    } catch (e) { $('rtErr').textContent = e.message; $('rtErr').hidden = false; }
  };

  /* ---------- reproductor propio ---------- */
  let token = 0, lastFocus = null, idleTimer = 0, dragging = false, wake = null;
  const playerOpen = () => !pl.hidden;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
  const seekBar = $('plSeek'), volBar = $('plVol');
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const fmtT = s => {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  };

  /* --- controles que se ocultan solos --- */
  const msgVisible = () => !$('plMsg').hidden;
  function showControls() {
    pl.classList.add('show'); pl.classList.remove('idle');
    clearTimeout(idleTimer);
    if (!player.paused && !msgVisible()) idleTimer = setTimeout(hideControls, 3000);
  }
  function hideControls() {
    if (player.paused || dragging || msgVisible()) return;
    pl.classList.remove('show'); pl.classList.add('idle');
  }
  function showMsg(text, { error = false, progress = null } = {}) {
    $('plMsg').hidden = false;
    $('plMsg').classList.toggle('error', error);
    $('plMsgText').textContent = text;
    $('plMsgProg').hidden = progress == null;
    if (progress != null) $('plMsgProg').firstElementChild.style.width = progress + '%';
    pl.classList.add('busy');
    pl.classList.add('show'); pl.classList.remove('idle');
    clearTimeout(idleTimer);
  }
  function hideMsg() { $('plMsg').hidden = true; pl.classList.remove('busy'); }

  /* --- pantalla completa del reproductor --- */
  function lockLandscape() {
    try { if (matchMedia('(pointer: coarse)').matches && screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {}); } catch {}
  }
  let pendingFs = false;                              // un enlace directo no permite pantalla completa sin un gesto del usuario
  function enterFs() {
    if (fsEl() === pl) return;
    const f = pl.requestFullscreen || pl.webkitRequestFullscreen;
    if (!f) return;                                   // p. ej. iPhone: el reproductor ya ocupa toda la pantalla
    try { const p = f.call(pl); if (p && p.then) p.then(() => { pendingFs = false; lockLandscape(); }).catch(() => { pendingFs = true; }); } catch { pendingFs = true; }
  }
  ['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => { if (pendingFs && playerOpen()) { pendingFs = false; enterFs(); } }, true));
  function exitPlayerFs() {
    if (fsEl() === pl) { try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch {} }
    try { screen.orientation && screen.orientation.unlock && screen.orientation.unlock(); } catch {}
  }
  const togglePlayerFs = () => (fsEl() === pl ? exitPlayerFs() : enterFs());

  async function lockScreen() {
    try { if ('wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch {}
  }
  function unlockScreen() { try { wake && wake.release(); } catch {} wake = null; }

  /* --- progreso, tiempo y volumen --- */
  function paintProgress() {
    const d = player.duration, t = player.currentTime;
    if (!isFinite(d) || d <= 0) return;
    const p = Math.min(100, t / d * 100);
    let b = 0;
    try { const br = player.buffered; for (let i = 0; i < br.length; i++) if (br.start(i) <= t + 0.5 && br.end(i) >= t) b = br.end(i) / d * 100; } catch {}
    seekBar.style.setProperty('--p', p + '%');
    seekBar.style.setProperty('--b', Math.max(b, p) + '%');
  }
  function onTime() {
    const d = player.duration, t = player.currentTime;
    if (!dragging && isFinite(d) && d > 0) seekBar.value = Math.round(t / d * 1000);
    $('plCur').textContent = fmtT(t);
    $('plRem').textContent = '-' + fmtT((isFinite(d) ? d : 0) - t);
    paintProgress();
  }
  seekBar.addEventListener('input', () => {
    dragging = true;
    const d = player.duration;
    if (!isFinite(d)) return;
    const t = seekBar.value / 1000 * d;
    $('plCur').textContent = fmtT(t);
    $('plRem').textContent = '-' + fmtT(d - t);
    seekBar.style.setProperty('--p', seekBar.value / 10 + '%');
    showControls();
  });
  seekBar.addEventListener('change', () => {
    const d = player.duration;
    if (isFinite(d)) player.currentTime = seekBar.value / 1000 * d;
    dragging = false;
    showControls();
  });

  try { const v = parseFloat(localStorage.getItem('cl:vol')); if (!isNaN(v)) player.volume = clamp(v, 0, 1); } catch {}
  function paintVol() {
    const v = player.muted ? 0 : player.volume;
    volBar.value = Math.round(v * 100);
    volBar.style.setProperty('--p', Math.round(v * 100) + '%');
    volBar.style.setProperty('--b', Math.round(v * 100) + '%');
    pl.dataset.muted = String(player.muted || player.volume === 0);
  }
  player.addEventListener('volumechange', () => { paintVol(); try { localStorage.setItem('cl:vol', String(player.volume)); } catch {} });
  volBar.addEventListener('input', () => { const v = volBar.value / 100; player.muted = v === 0; player.volume = v; });
  const changeVol = d => { player.muted = false; player.volume = clamp(Math.round((player.volume + d) * 100) / 100, 0, 1); showControls(); };
  const toggleMute = () => { player.muted = !player.muted; showControls(); };
  paintVol();

  /* --- adelantar / atrasar con efecto visual --- */
  const ripAcc = { left: 0, right: 0 }, ripTimer = {};
  function ripple(side, secs) {
    const el = $(side === 'left' ? 'plRipL' : 'plRipR');
    ripAcc[side] += secs;
    el.querySelector('span').textContent = (side === 'left' ? '−' : '+') + ripAcc[side] + ' s';
    el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
    clearTimeout(ripTimer[side]);
    ripTimer[side] = setTimeout(() => { ripAcc[side] = 0; }, 900);
  }
  ['plRipL', 'plRipR'].forEach(id => $(id).addEventListener('animationend', e => e.currentTarget.classList.remove('on')));   // evita que la animación se repita al reabrir
  function skip(sec) {
    const d = player.duration;
    if (!isFinite(d)) return;
    player.currentTime = clamp(player.currentTime + sec, 0, d - 0.1);
    ripple(sec < 0 ? 'left' : 'right', Math.abs(sec));
    showControls(); onTime();
  }
  const togglePlay = () => { if (player.paused) player.play().catch(() => {}); else player.pause(); showControls(); };

  /* --- gestos: táctil (toque, doble toque) y ratón (clic, doble clic) --- */
  const surface = $('plSurface');
  const sideOf = x => { const w = surface.clientWidth; return x < w * 0.38 ? 'left' : x > w * 0.62 ? 'right' : 'center'; };
  let tapTimer = 0, clickTimer = 0, lastTap = { t: 0, side: '' }, streak = { side: '', until: 0 }, lastMouse = 0;
  surface.addEventListener('pointerup', e => {
    const now = Date.now();
    if (e.pointerType === 'mouse') {
      if (e.button !== 0) return;
      if (now - lastMouse < 260) { clearTimeout(clickTimer); lastMouse = 0; togglePlayerFs(); }       // doble clic: pantalla completa
      else { lastMouse = now; clickTimer = setTimeout(togglePlay, 260); }                              // clic: reproducir / pausar
      return;
    }
    const side = sideOf(e.clientX - surface.getBoundingClientRect().left);
    const dbl = now - lastTap.t < 320 && lastTap.side === side;
    if (side !== 'center' && (dbl || (streak.side === side && now < streak.until))) {                                            // doble toque lateral: ±10 s
      clearTimeout(tapTimer);
      skip(side === 'left' ? -10 : 10);
      streak = { side, until: now + 800 };
      lastTap = { t: now, side };
      return;
    }
    if (side === 'center' && dbl) { clearTimeout(tapTimer); togglePlay(); lastTap = { t: 0, side: '' }; return; }
    lastTap = { t: now, side };
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => (pl.classList.contains('show') ? hideControls() : showControls()), 300);   // un toque: mostrar/ocultar
  });
  pl.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') showControls(); });

  /* --- reproducir un elemento de la lista --- */
  async function resolvePlayable(entry, my) {
    const url = `/api/play?kind=${entry.kind}&root=${entry.root}&path=${encodeURIComponent(entry.rel)}`;
    for (;;) {
      let r, data;
      try { r = await fetch(url, { cache: 'no-store' }); data = await r.json(); }
      catch { throw new Error('No se pudo conectar con el servidor.'); }
      if (my !== token) return null;
      if (!r.ok) throw new Error(data.error || 'Error ' + r.status);
      if (data.note === 'sin-ffmpeg') state.noFfmpeg = true;
      if (data.state === 'ready') return data.url;
      const p = Math.round((data.progress || 0) * 100);
      showMsg(`Optimizando el video para reproducirlo… ${p}%`, { progress: p });
      await sleep(1000);
    }
  }

  function updateNav() {
    $('plPrev').disabled = current <= 0;
    $('plNext').disabled = current >= playlist.length - 1;
    const multi = playlist.length > 1;
    $('plPrev').hidden = $('plNext').hidden = !multi;
  }

  async function play(list, idx) {
    if (idx < 0 || idx >= list.length) return;
    const wasOpen = playerOpen();
    if (wasOpen && current >= 0 && player.getAttribute('src') && !player.ended) recordProgress(playlist[current].entry);
    playlist = list; current = idx;
    const my = ++token;
    const it = list[idx];
    if (it.url && it.url !== curUrl()) history.replaceState(history.state, '', it.url);      // cada video tiene su URL
    setTitle(it.main ? it.main + (it.sub ? ' · ' + it.sub : '') : it.title);
    if (!wasOpen) {                                  // se abre en pantalla completa (dentro del gesto del usuario)
      lastFocus = document.activeElement;
      pl.hidden = false;
      document.body.classList.add('pl-open');
      enterFs();
    }
    $('plTitle').textContent = it.main || it.title;
    $('plSub').textContent = it.sub || '';
    updateNav();
    pl.dataset.playing = 'false';
    seekBar.value = 0; seekBar.style.setProperty('--p', '0%'); seekBar.style.setProperty('--b', '0%');
    $('plCur').textContent = '0:00'; $('plRem').textContent = '-0:00';
    showMsg('Preparando el video…');
    if (!wasOpen) $('plPlay').focus({ preventScroll: true });

    const p = getProg(it.entry);
    const resumeAt = p && p.t > 5 ? p.t : null;      // reanuda desde el último segundo guardado

    let url;
    try { url = await resolvePlayable(it.entry, my); }
    catch (e) { if (my === token) showMsg(e.message, { error: true }); return; }
    if (my !== token || !url) return;
    hideMsg();
    player.src = url;
    player.onloadedmetadata = () => { if (resumeAt && resumeAt < player.duration - 5) player.currentTime = resumeAt; onTime(); };
    player.play().catch(() => showControls());
  }

  let saveTick = 0;
  player.addEventListener('timeupdate', () => {
    onTime();
    const now = Date.now();
    if (now - saveTick < 5000 || current < 0 || player.paused) return;      // guarda cada 5 s mientras se reproduce
    saveTick = now;
    recordProgress(playlist[current].entry);
  });
  ['progress', 'durationchange', 'loadedmetadata'].forEach(ev => player.addEventListener(ev, onTime));
  player.addEventListener('play', () => { pl.dataset.playing = 'true'; showControls(); lockScreen(); });
  player.addEventListener('pause', () => {
    pl.dataset.playing = 'false'; showControls(); unlockScreen();
    if (playerOpen() && current >= 0 && !player.ended && player.getAttribute('src')) recordProgress(playlist[current].entry);   // al pausar
  });
  player.addEventListener('seeked', () => { if (playerOpen() && current >= 0 && player.getAttribute('src')) recordProgress(playlist[current].entry); });
  player.addEventListener('waiting', () => { $('plSpin').hidden = false; });
  ['playing', 'canplay', 'seeked'].forEach(ev => player.addEventListener(ev, () => { $('plSpin').hidden = true; }));
  player.addEventListener('ended', () => {
    recordProgress(playlist[current].entry, true);
    if (current < playlist.length - 1) play(playlist, current + 1);
    else closePlayer();
  });
  player.addEventListener('error', () => {
    if (!player.getAttribute('src')) return;
    showMsg(state.noFfmpeg
      ? 'El navegador no puede reproducir este formato. Instala ffmpeg (sudo apt install ffmpeg) para convertirlo automáticamente.'
      : 'El navegador no pudo reproducir este archivo.', { error: true });
  });

  // Último guardado antes de cerrar la pestaña, minimizar o cambiar de aplicación.
  const flushProgress = () => { if (playerOpen() && current >= 0 && state.me && player.getAttribute('src')) recordProgress(playlist[current].entry, false, true); };
  window.addEventListener('pagehide', flushProgress);
  window.addEventListener('beforeunload', flushProgress);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushProgress(); });

  // Cierra el reproductor solo (la ruta ya no es de reproducción).
  function hidePlayer() {
    token++;
    clearTimeout(idleTimer);
    if (current >= 0 && player.getAttribute('src') && !player.ended) recordProgress(playlist[current].entry);
    player.pause(); player.removeAttribute('src'); player.load();
    hideMsg();
    pl.hidden = true; pl.classList.remove('show', 'idle');
    $('plRipL').classList.remove('on'); $('plRipR').classList.remove('on');
    document.body.classList.remove('pl-open');
    exitPlayerFs(); unlockScreen();
    refreshers.forEach(f => f());
    epRefreshers.forEach(f => f());
    if (state.view === 'movie') { updateMovieHeader(); loadReviews([state.movie.entry.key], {}); }
    else if (state.view === 'series') { updateSeriesHeader(); loadReviews(state.seriesKeys, state.seriesLabels); }
    // Al salir de pantalla completa el navegador suelta el foco: se devuelve al botón que abrió el video.
    const back = () => { const t = lastFocus && document.contains(lastFocus) && lastFocus.getClientRects().length ? lastFocus : $('resume'); focusEl(t); };
    back();
    setTimeout(() => { if (!playerOpen() && (!document.activeElement || document.activeElement === document.body)) back(); }, 150);
    pollConversion();
  }

  // «Volver»: retrocede en el historial del navegador; en un enlace directo, va a la ficha del contenido.
  function closePlayer() { if (playerOpen()) goBack(); }

  $('plBack').onclick = closePlayer;
  $('plPlay').onclick = togglePlay;
  $('plRew').onclick = () => skip(-10);
  $('plFwd').onclick = () => skip(10);
  $('plPrev').onclick = () => play(playlist, current - 1);
  $('plNext').onclick = () => play(playlist, current + 1);
  $('plMute').onclick = toggleMute;
  $('plFs').onclick = togglePlayerFs;

  document.addEventListener('keydown', e => {
    if (!playerOpen() || e.ctrlKey || e.altKey || e.metaKey) return;
    const k = e.key, rk = remoteKey(e), ae = document.activeElement;
    const onCtl = pl.contains(ae) && ae.matches('button, input[type=range]');
    const visible = pl.classList.contains('show') && !msgVisible();
    let handled = true;
    if (IS_TV && (rk === 'left' || rk === 'right' || rk === 'up' || rk === 'down')) {
      if (!visible || !onCtl) {                         // controles ocultos: ←/→ saltan 10 s, ↑/↓ los muestran
        if (rk === 'left') skip(-10); else if (rk === 'right') skip(10);
        else { showControls(); focusEl($('plPlay')); }
      } else if (ae.id === 'plSeek' && (rk === 'left' || rk === 'right')) skip(rk === 'left' ? -10 : 10);
      else move(rk);                                    // cruceta: se mueve entre los botones
    }
    else if (rk === 'playpause' || k === ' ' || k === 'k' || k === 'K') togglePlay();
    else if (rk === 'play') { player.play().catch(() => {}); showControls(); }
    else if (rk === 'pause') { player.pause(); showControls(); }
    else if (rk === 'ok') { if (onCtl && ae.tagName === 'BUTTON') handled = false; else togglePlay(); }   // OK sobre un botón lo activa
    else if (rk === 'right' || rk === 'ffwd') skip(10);
    else if (rk === 'left' || rk === 'rew') skip(-10);
    else if (rk === 'up') changeVol(0.1);
    else if (rk === 'down') changeVol(-0.1);
    else if (k === 'm' || k === 'M') toggleMute();
    else if (k === 'f' || k === 'F') togglePlayerFs();
    else if (rk === 'next' || k === 'n' || k === 'N') { if (current < playlist.length - 1) play(playlist, current + 1); }
    else if (rk === 'prev' || k === 'p' || k === 'P') { if (current > 0) play(playlist, current - 1); }
    else if (rk === 'back' || rk === 'stop') closePlayer();
    else if (/^[0-9]$/.test(k) && isFinite(player.duration)) { player.currentTime = player.duration * (+k / 10); showControls(); onTime(); }
    else handled = false;
    if (handled) e.preventDefault(); else showControls();
  });

  /* ---------- pestañas, búsqueda, actualizar ---------- */
  const TAB_URL = { movies: '/', series: '/series', history: '/historial' };
  document.querySelectorAll('.tab').forEach(t => { t.dataset.fk = 't:' + t.dataset.tab; t.addEventListener('click', () => go(TAB_URL[t.dataset.tab])); });
  q.addEventListener('input', showHome);
  $('back').onclick = () => goBack();
  $('me').onclick = () => { state.managing = false; go('/perfiles'); };

  // Vuelve a leer carpetas y datos, y redibuja la pantalla actual (los ids de las URL son estables).
  async function refreshAll() {
    info.textContent = 'Leyendo carpetas…';
    try { await Promise.all([loadLibrary(), loadUser()]); mergeLocalProgress(); }
    catch (e) { info.textContent = e.message; return; }
    pollConversion();
    state.view = ''; state.movie = null; state.series = null;
    route();
  }
  $('rescan').onclick = refreshAll;

  /* ---------- pantalla completa ---------- */
  const root = document.documentElement;
  const fsButtons = [...document.querySelectorAll('.fs-toggle')];
  if (!root.requestFullscreen) fsButtons.forEach(b => { b.hidden = true; });
  const toggleFs = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else root.requestFullscreen().catch(() => {});
  };
  fsButtons.forEach(b => { b.onclick = toggleFs; });
  document.addEventListener('fullscreenchange', () => {
    pl.dataset.fs = String(fsEl() === pl);
    const on = !!document.fullscreenElement;
    fsButtons.forEach(b => {
      b.dataset.on = on;
      b.title = on ? 'Salir de pantalla completa (F)' : 'Pantalla completa (F)';
      b.setAttribute('aria-label', b.title);
    });
  });

  /* ---------- navegación con flechas ---------- */
  const NAV_MAIN = 'header button, header input, .card, .hrow, .ep, .rate-btn, .chip, #back, #resume, #rateBtn, #reviews';
  const shown = el => !el.closest('[hidden]') && el.getClientRects().length;

  function navItems() {
    if (playerOpen()) return [...pl.querySelectorAll('button, input[type=range]')].filter(el => !el.disabled && shown(el));
    const modal = MODALS.find(d => d.open);
    if (modal) return [...modal.querySelectorAll('button, textarea, input:not([type=file])')].filter(shown);
    if (!profilesEl.hidden) return [...profilesEl.querySelectorAll('button')].filter(shown);
    return [...document.querySelectorAll(NAV_MAIN)].filter(shown);
  }

  function focusEl(el) {
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function move(dir) {
    const list = navItems();
    const cur = list.includes(document.activeElement) ? document.activeElement : null;
    if (!cur) return focusEl(list.find(el => el.matches('.card, .ep, .hrow, .pf, #resume, .star, input, textarea')) || list[0]);
    const r = cur.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const horiz = dir === 'left' || dir === 'right';
    let best = null, bestScore = Infinity;
    for (const el of list) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      const ex = b.left + b.width / 2, ey = b.top + b.height / 2;
      let primary, secondary, ok;
      if (horiz) {
        primary = dir === 'right' ? ex - cx : cx - ex;
        secondary = Math.abs(ey - cy);
        ok = primary > 1 && b.top < r.bottom && b.bottom > r.top;   // misma fila
      } else {
        primary = dir === 'down' ? ey - cy : cy - ey;
        secondary = Math.abs(ex - cx);
        ok = primary > 1;
      }
      if (!ok) continue;
      const score = primary + secondary * (horiz ? 4 : 2.5);
      if (score < bestScore) { best = el; bestScore = score; }
    }
    focusEl(best);
  }

  const DIRS = ['left', 'right', 'up', 'down'];
  document.addEventListener('keydown', e => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (playerOpen()) return;                       // el reproductor tiene sus propias teclas
    const modal = MODALS.find(d => d.open);
    const a = document.activeElement, tag = a && a.tagName;
    const isTA = tag === 'TEXTAREA';
    const isIn = tag === 'INPUT' && (a.type === 'text' || a.type === 'search' || a.type === 'password');
    const rk = remoteKey(e);
    const dir = DIRS.includes(rk) ? rk : null;

    if (dir) {
      if (isIn && dir === 'left' && !(a.selectionStart === 0 && a.selectionEnd === 0)) return;
      if (isIn && dir === 'right' && !(a.selectionStart === a.value.length && a.selectionEnd === a.value.length)) return;
      if (isTA) {
        if (dir === 'left' || dir === 'right') return;
        if (dir === 'up' && a.selectionStart !== 0) return;
        if (dir === 'down' && a.selectionEnd !== a.value.length) return;
      }
      // El panel de reseñas se desplaza con arriba/abajo antes de ceder el foco.
      if (a.id === 'reviews' && (dir === 'up' || dir === 'down')) {
        const can = dir === 'down' ? a.scrollTop + a.clientHeight < a.scrollHeight - 1 : a.scrollTop > 0;
        if (can) { a.scrollBy({ top: dir === 'down' ? 90 : -90 }); e.preventDefault(); return; }
      }
      e.preventDefault();
      move(dir);
      return;
    }

    if (modal) {
      if (modal === rateDlg && !isTA && /^[1-5]$/.test(e.key)) setStars(+e.key);
      else if (rk === 'back' && e.key !== 'Escape' && e.key !== 'Backspace') modal.close();   // botón «Atrás» del mando
      return;                                       // Esc cierra el diálogo por sí solo
    }
    if (isTA || isIn) return;

    if (rk === 'back') {
      if (state.view === 'profiles') { if (state.managing) setManaging(false); }
      else if (state.view === 'movie' || state.view === 'series') { e.preventDefault(); goBack(); }
      else if (state.view === 'history' || state.tab !== 'movies' || IS_TV) { e.preventDefault(); goBack('/'); }
    } else if (e.key === 'f' || e.key === 'F') {
      toggleFs();
    }
  });

  /* ---------- rutas con URL propia e historial del navegador ----------
     /                      películas              /movie/:id         ficha de una película
     /series                series                 /watch?v=:id       reproduciendo una película
     /historial             mi historial           /show/:id[?s=N]    ficha de una serie
     /perfiles              elegir perfil          /show/:id/ep/T1C4  reproduciendo un capítulo        */
  const focusMem = new Map();                       // URL -> elemento que tenía el foco al salir
  const curUrl = () => location.pathname + location.search;
  const depth = () => (history.state && history.state.idx) || 0;
  const activeFk = () => { const a = document.activeElement; return (a && a.dataset && a.dataset.fk) || null; };
  const focusFk = fk => {
    if (!fk) return false;
    const el = [...document.querySelectorAll('[data-fk]')].find(x => x.dataset.fk === fk && x.getClientRects().length);
    if (el) focusEl(el);
    return !!el;
  };

  const movieUrl = m => '/movie/' + encodeURIComponent(m.id);
  const watchUrl = m => '/watch?v=' + encodeURIComponent(m.id);
  const showUrl = (s, season) => '/show/' + encodeURIComponent(s.id) + (season ? '?s=' + season : '');
  const findMovie = id => state.lib.movies.find(m => m.id === id);
  const findSeries = id => state.lib.series.find(s => s.id === id);

  function parseRoute(pathname = location.pathname, search = location.search) {
    const p = pathname.replace(/\/+$/, '') || '/', q = new URLSearchParams(search);
    const dec = v => { try { return decodeURIComponent(v); } catch { return v; } };
    let m;
    if (p === '/') return { name: 'home', tab: 'movies' };
    if (p === '/series') return { name: 'home', tab: 'series' };
    if (p === '/historial') return { name: 'history' };
    if (p === '/perfiles') return { name: 'profiles' };
    if (p === '/watch') return { name: 'watch', id: q.get('v') || '' };
    if ((m = p.match(/^\/movie\/([^/]+)$/))) return { name: 'movie', id: dec(m[1]) };
    if ((m = p.match(/^\/show\/([^/]+)\/ep\/([^/]+)$/))) return { name: 'episode', sid: dec(m[1]), code: dec(m[2]) };
    if ((m = p.match(/^\/show\/([^/]+)$/))) return { name: 'show', sid: dec(m[1]), season: q.get('s') };
    return { name: 'notfound' };
  }
  const parentUrl = url => {
    const u = url ? new URL(url, location.origin) : location;
    const r = parseRoute(u.pathname, u.search);
    return r.name === 'watch' ? '/movie/' + encodeURIComponent(r.id) : r.name === 'episode' ? '/show/' + encodeURIComponent(r.sid) : r.name === 'show' ? '/series' : '/';
  };

  function go(url, { replace = false } = {}) {
    if (url !== curUrl()) focusMem.set(curUrl(), activeFk());
    if (replace) history.replaceState({ idx: depth() }, '', url);
    else if (url !== curUrl()) history.pushState({ idx: depth() + 1 }, '', url);
    route();
  }

  // Atrás: vuelve a la URL anterior del historial; si es la primera entrada (enlace directo), sube un nivel.
  function goBack(fallback) {
    if (depth() > 0) history.back();
    else go(typeof fallback === 'string' ? fallback : parentUrl(), { replace: true });
  }

  function notFound() {
    go('/', { replace: true });
    info.textContent = 'No se encontró el contenido de ese enlace.';
  }

  function route() {
    MODALS.forEach(d => { if (d.open) d.close(); });
    const r = parseRoute();
    if (r.name === 'profiles') { if (playerOpen()) hidePlayer(); setTitle('Perfiles'); showProfiles(); return; }
    if (!state.me) {                                 // enlace directo sin perfil: se elige y luego se abre
      state.pending = curUrl();
      history.replaceState({ idx: 0 }, '', '/perfiles');
      setTitle('Perfiles');
      showProfiles();
      return;
    }
    profilesEl.hidden = true; appHeader.hidden = false; appMain.hidden = false;   // vuelve la interfaz (p. ej. «Atrás» desde /perfiles)
    const playing = r.name === 'watch' || r.name === 'episode';
    if (!playing && playerOpen()) hidePlayer();

    if (r.name === 'home') { state.tab = r.tab; setTitle(r.tab === 'series' ? 'Series' : 'Películas'); showHome(); }
    else if (r.name === 'history') { setTitle('Mi historial'); showHistory(); }
    else if (r.name === 'movie' || r.name === 'watch') {
      const m = findMovie(r.id);
      if (!m) return notFound();
      if (!(state.view === 'movie' && state.movie && state.movie.id === m.id)) showMovie(m);
      if (r.name === 'movie') setTitle(m.title);
      else play([{ entry: m.entry, title: m.title, main: m.title, sub: '', url: watchUrl(m) }], 0);
    }
    else if (r.name === 'show' || r.name === 'episode') {
      const s = findSeries(r.sid);
      if (!s) return notFound();
      const season = r.season ? parseInt(r.season, 10) : null;
      if (!(state.view === 'series' && state.series && state.series.id === s.id)) showSeries(s, { season });
      else if (season && season !== state.season && s.seasons.some(x => x.n === season)) { state.season = season; renderSeasons(s, state.seriesList); }
      if (r.name === 'show') setTitle(s.title);
      else {
        const idx = state.seriesList.findIndex(x => ('T' + x.season + 'C' + x.n) === r.code);
        if (idx < 0) return notFound();
        play(state.seriesList, idx);
      }
    }
    else return notFound();

    if (!playing && !focusFk(focusMem.get(curUrl())) && state.view === 'home') {   // al volver, el foco regresa donde estaba
      const ae = document.activeElement;
      if (!(ae && ae.classList && ae.classList.contains('tab'))) focusEl(grid.firstElementChild || document.querySelector('.tab.on'));   // si no, a la primera carátula
    }
  }

  /* ---------- inicio ---------- */
  window.addEventListener('popstate', route);
  history.scrollRestoration = 'manual';
  if (!history.state) history.replaceState({ idx: 0 }, '', curUrl());
  loadBranding();
  route();
})();
