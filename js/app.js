(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const grid = $('grid'), info = $('info'), warn = $('warn'), empty = $('empty'), detail = $('detail'), q = $('q');
  const dlg = $('dlg'), player = $('player'), notice = $('notice');

  const state = { lib: { movies: [], series: [], warnings: [], config: {} }, tab: 'movies', series: null, season: null };
  let playlist = [], current = -1, refreshers = [], epRefreshers = [];

  /* ---------- utilidades ---------- */
  const fmtSize = b => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(0) + ' MB';
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const getProg = e => { try { return JSON.parse(localStorage.getItem('cl:' + e.key)); } catch { return null; } };
  const setProg = (e, v) => { try { localStorage.setItem('cl:' + e.key, JSON.stringify(v)); } catch {} };
  const pct = e => { const p = getProg(e); return p && p.d && p.t > 5 && p.t < p.d - 5 ? p.t / p.d * 100 : 0; };

  /* ---------- carátulas ---------- */
  const hue = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const initials = it => it.abbr || it.title.split(/\s+/).filter(Boolean).slice(0, 3).map(w => w[0]).join('').toUpperCase();

  // Pone la carátula (o un marcador con la abreviatura si no existe la imagen).
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
        const w = pct(entry);
        if (w) { const bar = document.createElement('div'); bar.className = 'bar'; bar.style.width = w + '%'; poster.append(bar); }
      };
      refresh();
      refreshers.push(refresh);
    }
    return b;
  }

  /* ---------- vistas ---------- */
  function renderWarnings() {
    const w = state.lib.warnings || [];
    warn.hidden = !w.length;
    warn.innerHTML = '';
    w.forEach(t => { const p = document.createElement('p'); p.textContent = t; warn.append(p); });
  }

  function showHome(focusTitle) {
    state.series = null;
    detail.hidden = true;
    q.hidden = false;
    refreshers = []; epRefreshers = [];
    grid.innerHTML = '';
    const { movies, series } = state.lib;
    $('cMovies').textContent = movies.length;
    $('cSeries').textContent = series.length;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === state.tab));
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
      list.forEach(m => grid.append(posterCard(m, {
        meta: fmtSize(m.entry.size), entry: m.entry,
        onClick: () => play([{ entry: m.entry, title: m.title }], 0)
      })));
    } else {
      const list = series.filter(s => norm(s.title).includes(term));
      info.textContent = plural(list.length, 'serie', 'series') + (term ? ' encontradas' : '');
      list.forEach(s => grid.append(posterCard(s, {
        meta: (s.seasons.length > 1 ? plural(s.seasons.length, 'temporada', 'temporadas') + ' · ' : '') + plural(countEps(s), 'capítulo', 'capítulos'),
        onClick: () => showSeries(s)
      })));
    }
    if (focusTitle) {
      const el = [...grid.children].find(c => c.dataset.title === focusTitle);
      if (el) focusEl(el);
    }
  }

  const countEps = s => s.seasons.reduce((n, x) => n + x.episodes.length, 0);
  const code = (season, n) => `T${season}C${n ?? '?'}`;

  // Lista plana (todas las temporadas en orden) para que "siguiente" pase de una temporada a otra.
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

  function showSeries(s) {
    state.series = s;
    q.hidden = true;
    empty.hidden = true;
    grid.hidden = true;
    detail.hidden = false;
    info.textContent = '';
    refreshers = []; epRefreshers = [];
    window.scrollTo(0, 0);

    $('dPoster').innerHTML = '';
    fillPoster($('dPoster'), s);
    $('sTitle').textContent = s.title;
    $('sMeta').textContent = (s.seasons.length > 1 ? plural(s.seasons.length, 'temporada', 'temporadas') + ' · ' : '') + plural(countEps(s), 'capítulo', 'capítulos');

    const list = seriesPlaylist(s);
    const setResume = () => {
      const r = resumeInfo(list), it = list[r.idx];
      $('resume').textContent = `${r.label} · ${code(it.season, it.n)}`;
      $('resume').onclick = () => play(list, r.idx);
    };
    setResume();
    refreshers.push(setResume);

    state.season = list[resumeInfo(list).idx].season;
    renderSeasons(s, list);
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
      const li = document.createElement('li');
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
        const w = pct(e.entry);
        if (w) { const bar = document.createElement('div'); bar.className = 'bar'; bar.style.width = w + '%'; b.append(bar); }
      };
      refresh();
      epRefreshers.push(refresh);
      li.append(b);
      ol.append(li);
    });
  }

  /* ---------- reproductor ---------- */
  let saveTick = 0, playToken = 0, silentTimer = 0;
  const fixKey = e => 'clfix:' + e.key;
  const audioCodec = () => (player.canPlayType('audio/mp4; codecs="mp4a.40.2"') ? 'aac' : 'opus');

  function say(html, bad) {
    notice.hidden = !html;
    notice.className = bad ? 'bad' : '';
    notice.innerHTML = html || '';
  }

  // Pide al servidor una copia con audio compatible y espera a que esté lista.
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

  // Si el navegador no puede decodificar el audio, lo detectamos y lo arreglamos solo.
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
    if (now - saveTick < 3000 || current < 0 || !player.currentTime) return;
    saveTick = now;
    setProg(playlist[current].entry, { t: player.currentTime, d: player.duration, at: now });
  });
  player.addEventListener('ended', () => {
    setProg(playlist[current].entry, { t: 0, d: player.duration, at: Date.now() });
    if (current < playlist.length - 1) play(playlist, current + 1);
  });
  player.addEventListener('error', () => {
    if (!player.getAttribute('src')) return;
    say('El navegador no pudo reproducir este archivo. Prueba "Arreglar audio"; si sigue igual, el códec de video no es compatible (usa MP4 H.264 o WebM).', true);
  });

  function closePlayer() {
    playToken++;
    clearTimeout(silentTimer);
    if (current >= 0 && player.currentTime > 0 && !player.ended) setProg(playlist[current].entry, { t: player.currentTime, d: player.duration, at: Date.now() });
    player.pause(); player.removeAttribute('src'); player.load();
    dlg.close();
    refreshers.forEach(f => f());
    epRefreshers.forEach(f => f());
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

  /* ---------- carga de la biblioteca ---------- */
  async function load(initial) {
    info.textContent = 'Leyendo carpetas…';
    try {
      const r = await fetch('/api/library', { cache: 'no-store' });
      if (!r.ok) {
        let msg = 'código ' + r.status;
        try { msg = (await r.json()).error || msg; } catch {}
        info.textContent = 'El servidor falló al leer las carpetas: ' + msg + '. Revisa la consola donde corre node server.js.';
        return;
      }
      state.lib = await r.json();
    } catch {
      info.textContent = 'No se pudo conectar con el servidor. ¿Sigue abierto "node server.js"?';
      return;
    }
    if (state.series) {
      const again = state.lib.series.find(s => s.title === state.series.title);
      if (again) { renderWarnings(); return showSeries(again); }
    }
    showHome();
    if (initial && grid.firstElementChild) focusEl(grid.firstElementChild);
  }

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => { state.tab = t.dataset.tab; showHome(); }));
  q.addEventListener('input', showHome);
  const goBack = () => { const t = state.series && state.series.title; state.tab = 'series'; showHome(t); };
  $('back').onclick = goBack;
  $('rescan').onclick = () => load();

  /* ---------- pantalla completa ---------- */
  const fsBtn = $('fs');
  const root = document.documentElement;
  if (!root.requestFullscreen) fsBtn.hidden = true;
  const toggleFs = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else root.requestFullscreen().catch(() => {});
  };
  fsBtn.onclick = toggleFs;
  document.addEventListener('fullscreenchange', () => {
    const on = !!document.fullscreenElement;
    fsBtn.dataset.on = on;
    fsBtn.title = fsBtn.ariaLabel = on ? 'Salir de pantalla completa (F)' : 'Pantalla completa (F)';
  });

  /* ---------- navegación con flechas ---------- */
  const NAV = 'header button, header input, .card, .ep, .chip, #back, #resume';
  const navItems = () => [...document.querySelectorAll(NAV)].filter(el => !el.closest('[hidden]') && el.getClientRects().length);

  function focusEl(el) {
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function move(dir) {
    const list = navItems();
    const cur = list.includes(document.activeElement) ? document.activeElement : null;
    if (!cur) return focusEl(list.find(el => el.matches('.card, .ep, #resume')) || list[0]);
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
    if (dlg.open || e.altKey || e.ctrlKey || e.metaKey) return;
    const a = document.activeElement;
    const typing = a === q;
    const dir = DIRS[e.key];
    if (dir) {
      // En el buscador, izquierda/derecha mueven el cursor salvo en los extremos.
      if (typing && dir === 'left' && !(q.selectionStart === 0 && q.selectionEnd === 0)) return;
      if (typing && dir === 'right' && !(q.selectionStart === q.value.length && q.selectionEnd === q.value.length)) return;
      e.preventDefault();
      move(dir);
    } else if ((e.key === 'Escape' || (e.key === 'Backspace' && !typing)) && state.series) {
      e.preventDefault();
      goBack();
    } else if ((e.key === 'f' || e.key === 'F') && !typing) {
      toggleFs();
    }
  });

  load(true);
})();
