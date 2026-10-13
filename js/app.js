(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const grid = $('grid'), info = $('info'), warn = $('warn'), empty = $('empty'), detail = $('detail'), histEl = $('history'), q = $('q');
  const dlg = $('dlg'), player = $('player'), notice = $('notice');
  const profilesEl = $('profiles'), appHeader = $('appHeader'), appMain = $('appMain');
  const rateDlg = $('rateDlg'), newDlg = $('newDlg'), delDlg = $('delDlg');
  const MODALS = [rateDlg, newDlg, delDlg];

  const state = {
    lib: { movies: [], series: [], warnings: [], config: {} }, index: new Map(),
    me: null, profiles: [], hist: {}, mine: {}, summary: {},
    tab: 'movies', view: 'profiles', series: null, movie: null, season: null,
    seriesList: [], seriesKeys: [], seriesLabels: {}, back: null, managing: false
  };
  let playlist = [], current = -1, refreshers = [], epRefreshers = [];

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

  function recordProgress(entry, ended) {
    if (!state.me) return;
    const d = player.duration;
    if (!isFinite(d) || !d) return;
    const t = ended ? 0 : player.currentTime;
    if (!ended && t < 3) return;
    const prev = state.hist[entry.key];
    const now = ended || t > d - 8 ? 100 : Math.round(t / d * 100);
    const rec = { t, d, pct: Math.max(prev ? prev.pct || 0 : 0, now), at: Date.now() };
    state.hist[entry.key] = rec;
    fetch('/api/history', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ profile: state.me.id, key: entry.key, t: rec.t, d: rec.d, pct: rec.pct })
    }).catch(() => {});
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

  function posterCard(it, { meta, entry, onClick }) {
    const b = document.createElement('button');
    b.className = 'card'; b.type = 'button';
    b.dataset.title = it.title;
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
    state.me = null; state.view = 'profiles';
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

    state.tab = 'movies'; state.series = null; state.movie = null; state.view = 'home';
    detail.hidden = true; histEl.hidden = true; grid.innerHTML = '';
    info.textContent = 'Cargando…';
    try { await Promise.all([loadUser(), loadLibrary()]); }
    catch (e) { info.textContent = e.message; return; }
    showTab();
    const first = grid.firstElementChild;
    focusEl(first || document.querySelector('.tab.on'));
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

  /* ---------- vistas ---------- */
  function renderWarnings() {
    const w = state.lib.warnings || [];
    warn.hidden = !w.length;
    warn.innerHTML = '';
    w.forEach(t => { const p = document.createElement('p'); p.textContent = t; warn.append(p); });
  }

  const setTabs = () => document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === state.tab));
  const showTab = () => (state.tab === 'history' ? showHistory() : showHome());

  function showHome(focusTitle) {
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
          onClick: () => showMovie(m)
        }));
      });
    } else {
      const list = series.filter(s => norm(s.title).includes(term));
      info.textContent = plural(list.length, 'serie', 'series') + (term ? ' encontradas' : '');
      list.forEach(s => {
        const r = ratingOf(seriesKeysOf(s));
        grid.append(posterCard(s, {
          meta: (r.n ? `★ ${r.avg.toFixed(1)} · ` : '') + (s.seasons.length > 1 ? plural(s.seasons.length, 'temp.', 'temp.') + ' · ' : '') + plural(countEps(s), 'cap.', 'caps.'),
          onClick: () => showSeries(s)
        }));
      });
    }
    if (focusTitle) {
      const el = [...grid.children].find(c => c.dataset.title === focusTitle);
      if (el) focusEl(el);
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
      rows.push({ ix, h, r, at: Math.max(h ? h.at : 0, r ? r.at : 0) });
    });
    rows.sort((a, b) => b.at - a.at);
    info.textContent = rows.length ? `${state.me.name} · ${plural(rows.length, 'título', 'títulos')}` : '';
    if (!rows.length) {
      const p = document.createElement('p'); p.className = 'rv-empty';
      p.textContent = 'Aún no has visto ni calificado nada con este perfil.';
      histEl.append(p);
      return;
    }
    rows.forEach(({ ix, h, r, at }) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'hrow';
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
      b.onclick = () => (ix.kind === 'movie' ? showMovie(ix.movie, 'history') : showSeries(ix.series, { from: 'history', season: ix.season }));
      histEl.append(b);
    });
    focusEl(histEl.firstElementChild);
  }

  /* ---------- detalle (película / serie) ---------- */
  function setBack(label, fn) { $('back').textContent = '‹ ' + label; state.back = fn; }
  const goBack = () => { if (state.back) state.back(); };

  function showDetailShell(kind) {
    q.hidden = true; empty.hidden = true; grid.hidden = true; histEl.hidden = true; detail.hidden = false;
    info.textContent = '';
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
    r.onclick = () => play([{ entry: e, title: m.title }], 0);
    const rb = $('rateBtn');
    rb.textContent = mine ? `${starStr(mine.stars)}  Editar mi reseña` : '✩ Calificar';
    rb.onclick = () => openRate(e, m.title);
  }

  function showMovie(m, from) {
    state.view = 'movie'; state.movie = m; state.series = null;
    if (from === 'history') setBack('Mi historial', showHistory);
    else setBack('Películas', () => { state.tab = 'movies'; showHome(m.title); });
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
      title: `${s.title} · ${code(se.n, e.n ?? i + 1)}${e.title ? ' · ' + e.title : ''}`
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
    $('resume').onclick = () => play(list, r.idx);
  }

  function showSeries(s, opts = {}) {
    state.view = 'series'; state.series = s; state.movie = null;
    if (opts.from === 'history') setBack('Mi historial', showHistory);
    else setBack('Series', () => { state.tab = 'series'; showHome(s.title); });
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
      c.onclick = () => { state.season = se.n; renderSeasons(s, list); focusEl(chips.querySelector('.chip.on')); };
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
      b.onclick = () => play(list, idx);
      const refresh = () => {
        b.querySelector('.bar')?.remove();
        const w = barPct(e.entry);
        if (w) { const bar = document.createElement('div'); bar.className = 'bar'; bar.style.width = w + '%'; b.append(bar); }
      };
      refresh();
      epRefreshers.push(refresh);

      const rb = document.createElement('button');
      rb.type = 'button'; rb.className = 'rate-btn' + (mine ? ' on' : '');
      rb.dataset.key = e.entry.key;
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

  /* ---------- reproductor ---------- */
  let saveTick = 0, playToken = 0, silentTimer = 0;
  const fixKey = e => 'clfix:' + e.key;
  const audioCodec = () => (player.canPlayType('audio/mp4; codecs="mp4a.40.2"') ? 'aac' : 'opus');

  function say(html, bad) {
    notice.hidden = !html;
    notice.className = bad ? 'bad' : '';
    notice.innerHTML = html || '';
  }

  async function prepareAudio(entry, token) {
    const url = `/api/prepare?codec=${audioCodec()}&kind=${entry.kind}&root=${entry.root}&path=${encodeURIComponent(entry.rel)}`;
    for (;;) {
      let r, data;
      try { r = await fetch(url, { cache: 'no-store' }); data = await r.json(); }
      catch { say('No se pudo conectar con el servidor.', true); return null; }
      if (token !== playToken) return null;
      if (r.status === 501) { say('Para arreglar el audio hace falta ffmpeg. Instálalo con <code>sudo apt install ffmpeg</code> y vuelve a pulsar "Arreglar audio".', true); return null; }
      if (!r.ok || data.state === 'error') { say('No se pudo convertir el audio: ' + (data.error || r.status), true); return null; }
      if (data.state === 'ready') return data.url;
      const p = Math.round((data.progress || 0) * 100);
      say(`Preparando audio compatible… ${p}%<div class="prog"><i style="width:${p}%"></i></div>`);
      await new Promise(res => setTimeout(res, 1000));
    }
  }

  async function play(list, idx, opts = {}) {
    if (idx < 0 || idx >= list.length) return;
    playlist = list; current = idx;
    const token = ++playToken;
    clearTimeout(silentTimer);
    const it = list[idx];
    say('');
    $('title').textContent = it.title;
    $('prev').disabled = idx === 0;
    $('next').disabled = idx === list.length - 1;
    if (!dlg.open) dlg.showModal();

    let src = it.entry.url;
    let resumeAt = null;
    if (opts.resumeAt != null) resumeAt = opts.resumeAt;
    else { const p = getProg(it.entry); if (p && p.t > 5) resumeAt = p.t; }

    if (opts.fix || localStorage.getItem(fixKey(it.entry))) {
      player.pause();
      const fixed = await prepareAudio(it.entry, token);
      if (token !== playToken) return;
      if (fixed) { src = fixed; localStorage.setItem(fixKey(it.entry), '1'); say(''); }
      else if (opts.fix) return;
    }

    player.src = src;
    player.muted = false;
    player.onloadedmetadata = () => { if (resumeAt && resumeAt < player.duration - 5) player.currentTime = resumeAt; };
    player.play().catch(() => {});
    watchAudio(token, src !== it.entry.url);
  }

  function watchAudio(token, alreadyFixed) {
    if (alreadyFixed) return;
    silentTimer = setTimeout(function check() {
      if (token !== playToken) return;
      if (player.paused || player.currentTime < 1) { silentTimer = setTimeout(check, 1500); return; }
      const silent =
        (typeof player.webkitAudioDecodedByteCount === 'number' && player.webkitAudioDecodedByteCount === 0) ||
        player.mozHasAudio === false ||
        (player.audioTracks && player.audioTracks.length === 0);
      if (silent) play(playlist, current, { fix: true, resumeAt: player.currentTime });
    }, 2500);
  }

  $('fixAudio').onclick = () => { if (current >= 0) play(playlist, current, { fix: true, resumeAt: player.currentTime || null }); };

  player.addEventListener('timeupdate', () => {
    const now = Date.now();
    if (now - saveTick < 5000 || current < 0) return;
    saveTick = now;
    recordProgress(playlist[current].entry);
  });
  player.addEventListener('pause', () => { if (current >= 0 && dlg.open && !player.ended) recordProgress(playlist[current].entry); });
  player.addEventListener('ended', () => {
    recordProgress(playlist[current].entry, true);
    if (current < playlist.length - 1) play(playlist, current + 1);
  });
  player.addEventListener('error', () => {
    if (!player.getAttribute('src')) return;
    say('El navegador no pudo reproducir este archivo. Prueba "Arreglar audio"; si sigue igual, el códec de video no es compatible (usa MP4 H.264 o WebM).', true);
  });
  window.addEventListener('pagehide', () => { if (dlg.open && current >= 0) recordProgress(playlist[current].entry); });

  function closePlayer() {
    playToken++;
    clearTimeout(silentTimer);
    if (current >= 0 && !player.ended) recordProgress(playlist[current].entry);
    player.pause(); player.removeAttribute('src'); player.load();
    dlg.close();
    refreshers.forEach(f => f());
    epRefreshers.forEach(f => f());
    if (state.view === 'movie') { updateMovieHeader(); loadReviews([state.movie.entry.key], {}); }
    else if (state.view === 'series') { updateSeriesHeader(); loadReviews(state.seriesKeys, state.seriesLabels); }
  }

  $('close').onclick = closePlayer;
  dlg.addEventListener('cancel', e => { e.preventDefault(); closePlayer(); });
  $('prev').onclick = () => play(playlist, current - 1);
  $('next').onclick = () => play(playlist, current + 1);
  dlg.addEventListener('keydown', e => {
    if (e.key === 'n' || e.key === 'N') play(playlist, current + 1);
    else if (e.key === 'p' || e.key === 'P') play(playlist, current - 1);
    else if (e.key === 'f' || e.key === 'F') { document.fullscreenElement === player ? document.exitFullscreen() : player.requestFullscreen?.(); }
    else if (e.key === 'ArrowRight') { player.currentTime += 10; e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { player.currentTime -= 10; e.preventDefault(); }
    else if (e.key === 'ArrowUp') { player.volume = Math.min(1, player.volume + 0.1); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { player.volume = Math.max(0, player.volume - 0.1); e.preventDefault(); }
    else if (e.key === 'm' || e.key === 'M') { player.muted = !player.muted; }
    else if (e.key === ' ' && document.activeElement !== player) { player.paused ? player.play() : player.pause(); e.preventDefault(); }
  });

  /* ---------- pestañas, búsqueda, actualizar ---------- */
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => { state.tab = t.dataset.tab; showTab(); }));
  q.addEventListener('input', showHome);
  $('back').onclick = goBack;
  $('me').onclick = () => { state.managing = false; showProfiles(); };
  $('rescan').onclick = async () => {
    info.textContent = 'Leyendo carpetas…';
    try { await Promise.all([loadLibrary(), loadUser()]); }
    catch (e) { info.textContent = e.message; return; }
    if (state.view === 'series') {
      const again = state.lib.series.find(s => s.title === state.series.title);
      if (again) return showSeries(again, { season: state.season });
    } else if (state.view === 'movie') {
      const again = state.lib.movies.find(m => m.entry.key === state.movie.entry.key);
      if (again) return showMovie(again);
    }
    showTab();
  };

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

  const DIRS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  document.addEventListener('keydown', e => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const modal = MODALS.find(d => d.open);
    if (dlg.open && !modal) return;                 // el reproductor tiene sus propias teclas
    const a = document.activeElement, tag = a && a.tagName;
    const isTA = tag === 'TEXTAREA';
    const isIn = tag === 'INPUT' && (a.type === 'text' || a.type === 'search' || a.type === 'password');
    const dir = DIRS[e.key];

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
      return;                                       // Esc cierra el diálogo por sí solo
    }
    if (isTA || isIn) return;

    if (e.key === 'Escape' && state.view === 'profiles' && state.managing) {
      setManaging(false);
    } else if (e.key === 'Escape' || e.key === 'Backspace') {
      if (state.view === 'movie' || state.view === 'series') { e.preventDefault(); goBack(); }
    } else if (e.key === 'f' || e.key === 'F') {
      toggleFs();
    }
  });

  /* ---------- inicio ---------- */
  showProfiles();
})();
