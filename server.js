'use strict';
/*
  Cine local - servidor sin dependencias (solo Node.js).

  Las rutas donde se buscan los archivos se definen en config.json
  (por defecto, las carpetas peliculas/, series/ y caratulas/ junto a este archivo).

    peliculas/   videos sueltos            ->  ABREV_Nombre completo.mkv
    series/      una carpeta por serie     ->  ABREV_Nombre de la serie/  con T1C4_lucha.mkv (temporada 1, capítulo 4, "lucha")
    caratulas/   imágenes 2:3 vertical     ->  ABREV.jpg

  Eliminar perfiles pide la contraseña "claveAdmin" de config.json.
  Perfiles, historial, calificaciones y reseñas se guardan en data/db.json
  (las fotos de perfil en data/avatars/). Respalda esa carpeta para no perderlos.

  Uso:  node server.js            (solo este equipo)
        node server.js --lan      (también otros dispositivos de tu red)
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec, execFile, spawn } = require('child_process');
const { optimizar: optimizarCaratulas } = require('./optimizar-caratulas.js');

const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'config.json');
const CACHE_DIR = path.join(ROOT, '.cache');
const LAN = process.argv.includes('--lan');
const NO_OPEN = process.argv.includes('--no-open');

const VIDEO = /\.(mp4|m4v|webm|mov|mkv|ogv|avi)$/i;
const IMAGE = /\.(jpe?g|png|webp)$/i;
const KINDS = ['peliculas', 'series', 'caratulas'];
const DEFAULTS = { puerto: 3000, claveAdmin: 'admin', convertirVideos: true, optimizarCaratulas: true, peliculas: ['./peliculas'], series: ['./series'], caratulas: ['./caratulas'] };

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.ogv': 'video/ogg', '.avi': 'video/x-msvideo',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp'
};

let FFMPEG = false, NICE = false;
const ffmpegReady = new Promise(resolve => {
  execFile('ffmpeg', ['-version'], e => {
    FFMPEG = !e;
    if (!FFMPEG) console.log('  Aviso: ffmpeg no está instalado. Los videos que el navegador no soporta (MKV, AVI, HEVC…)\n  no se podrán convertir a MP4. Instálalo con:  sudo apt install ffmpeg\n');
    execFile('nice', ['-n', '10', 'true'], err => { NICE = !err; resolve(); });
  });
});

const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const visible = n => !n.startsWith('.') && !n.startsWith('$');
const readdir = dir => fs.promises.readdir(dir, { withFileTypes: true });
// Tipo real de una entrada de carpeta; sigue enlaces simbólicos y descarta los rotos.
async function kindOf(dir, d) {
  if (d.isSymbolicLink()) {
    try { const st = await fs.promises.stat(path.join(dir, d.name)); return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null; }
    catch { return null; }
  }
  return d.isDirectory() ? 'dir' : d.isFile() ? 'file' : null;
}
const encodeRel = rel => rel.split('/').map(encodeURIComponent).join('/');
const mediaUrl = (kind, idx, rel) => `/media/${kind}/${idx}/${encodeRel(rel)}`;

/* ---------- Configuración ---------- */
function loadConfig() {
  let user = {}, error = null;
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2) + '\n');
  } else {
    try { user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
    catch (e) { error = 'config.json tiene un error de formato (' + e.message + '). Se usan las rutas por defecto.'; }
  }
  const cfg = {
    puerto: Number(user.puerto) || DEFAULTS.puerto,
    claveAdmin: typeof user.claveAdmin === 'string' ? user.claveAdmin : DEFAULTS.claveAdmin,
    convertirVideos: user.convertirVideos !== false,
    optimizarCaratulas: user.optimizarCaratulas !== false
  };
  for (const k of KINDS) {
    const v = user[k];
    const list = (Array.isArray(v) ? v : v ? [v] : []).filter(x => typeof x === 'string' && x.trim());
    cfg[k] = list.length ? list : DEFAULTS[k];
  }
  return { cfg, error };
}

const WIN_PATH = /^[a-z]:[\\/]/i;

// Devuelve la ruta absoluta, o null si no es válida en este sistema (ej. "Z:/videos" en Linux).
function expand(p) {
  p = p.trim();
  if (WIN_PATH.test(p) && process.platform !== 'win32') return null;
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(ROOT, p);
}
const rootsOf = (cfg, kind) => cfg[kind].map(expand);

function ensureLocalDirs(cfg) {
  for (const k of KINDS) for (const abs of rootsOf(cfg, k)) {
    if (abs && abs.startsWith(ROOT + path.sep) && !fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
  }
}

/* ---------- Nombres: ABREV_Nombre completo ---------- */
const tidy = s => (/\s/.test(s) ? s : s.replace(/[._]+/g, ' ')).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

function parseName(base) {
  const i = base.indexOf('_');
  if (i > 0 && i <= 10) {
    const abbr = base.slice(0, i);
    if (!/\s/.test(abbr) && !/^\d+$/.test(abbr)) return { abbr, title: tidy(base.slice(i + 1)) };
  }
  return { abbr: '', title: tidy(base) };
}

function episodeNumber(text) {
  const m = /(?:^|[^a-z])(?:e|ep|cap|capitulo|capítulo|episodio)[\s._-]*(\d{1,3})(?!\d)/i.exec(text) || /(?<!\d)(\d{1,3})(?!\d)/.exec(text);
  return m ? parseInt(m[1], 10) : null;
}
const stripNumber = t => t.replace(/^\s*(?:cap(?:[ií]tulo)?|ep(?:isodio)?|e)?[\s._-]*0*\d+\s*[-–:.)_]*\s*/i, '').trim();

/* ---------- Escaneo ---------- */
async function walkVideos(abs, rel, out) {
  let list;
  try { list = await readdir(abs); } catch { return; }
  list = list.filter(d => visible(d.name)).sort((a, b) => natural(a.name, b.name));
  for (const d of list) {
    const r = rel ? rel + '/' + d.name : d.name;
    const kind = await kindOf(abs, d);
    if (kind === 'dir') await walkVideos(path.join(abs, d.name), r, out);
    else if (kind === 'file' && VIDEO.test(d.name)) out.push({ abs: path.join(abs, d.name), rel: r });
  }
}

async function makeEntry(kind, idx, f) {
  const st = await fs.promises.stat(f.abs);
  return {
    kind, root: idx, rel: f.rel, key: `${kind}:${f.rel}:${st.size}`,
    url: mediaUrl(kind, idx, f.rel), size: st.size, mtime: Math.round(st.mtimeMs)
  };
}

async function scan() {
  const { cfg, error } = loadConfig();
  ensureLocalDirs(cfg);
  const warnings = error ? [error] : [];

  // Solo rutas que existen; el índice se conserva para armar las URL.
  const existing = async kind => {
    const out = [];
    for (const [i, abs] of rootsOf(cfg, kind).entries()) {
      try { if (abs && (await fs.promises.stat(abs)).isDirectory()) { out.push({ abs, i }); continue; } } catch {}
      const raw = cfg[kind][i];
      warnings.push(`No se encontró la carpeta de ${kind}: ${raw}` + (abs === null ? ' (en Linux las rutas son como /mnt/disco/videos)' : ''));
    }
    return out;
  };

  // Carátulas: convierte a .webp (y borra el original) cualquier imagen pendiente
  if (cfg.optimizarCaratulas) {
    const dirs = (await existing('caratulas')).map(r => r.abs);
    const rep = await optimizarCaratulas(dirs);
    rep.convertidas.forEach(c => console.log(`  Carátula optimizada: ${path.basename(c.origen)} → ${path.basename(c.destino)} (${(c.antes / 1024).toFixed(0)} KB → ${(c.despues / 1024).toFixed(0)} KB)`));
    rep.errores.forEach(e => warnings.push(`No se pudo optimizar la carátula ${path.basename(e.archivo)}: ${e.error}`));
  }

  // Carátulas, indexadas por nombre de archivo (sin extensión), ej. GOT.jpg -> "got"
  const covers = new Map();
  for (const r of await existing('caratulas')) {
    let imgs = [];
    try { imgs = await readdir(r.abs); } catch (e) { warnings.push(`No se pudo leer la carpeta de caratulas: ${e.code || e.message}`); }
    for (const f of imgs) {
      if (IMAGE.test(f.name) && (await kindOf(r.abs, f)) === 'file') {
        const key = path.parse(f.name).name.toLowerCase();
        if (!covers.has(key)) covers.set(key, mediaUrl('caratulas', r.i, f.name));
      }
    }
  }
  const findCover = (...names) => {
    for (const n of names) if (n && covers.has(n.toLowerCase())) return covers.get(n.toLowerCase());
    return null;
  };

  // Películas
  const movies = [];
  for (const r of await existing('peliculas')) {
    const files = [];
    await walkVideos(r.abs, '', files);
    for (const f of files) {
      try {
        const base = path.parse(path.basename(f.rel)).name;
        const { abbr, title } = parseName(base);
        movies.push({ abbr, title, cover: findCover(abbr, base, title), entry: await makeEntry('peliculas', r.i, f) });
      } catch (e) { warnings.push(`Se omitió ${f.rel}: ${e.code || e.message}`); }
    }
  }
  movies.sort((a, b) => natural(a.title, b.title));

  // Series: cada subcarpeta es una serie (ej. "GOT_Game of Thrones").
  // Temporada y capítulo salen del nombre del archivo: T1C4_lucha.mkv
  const series = [];
  for (const r of await existing('series')) {
    let dirs = [];
    try {
      const all = (await readdir(r.abs)).filter(d => visible(d.name));
      for (const d of all) if ((await kindOf(r.abs, d)) === 'dir') dirs.push(d);
    } catch (e) { warnings.push(`No se pudo leer la carpeta de series: ${e.code || e.message}`); }
    for (const d of dirs) {
      const files = [];
      await walkVideos(path.join(r.abs, d.name), d.name, files);
      if (!files.length) continue;
      const { abbr, title } = parseName(d.name);
      const bySeason = new Map();
      for (const f of files) {
        const parts = f.rel.split('/');                       // [serie, ...subcarpetas, archivo]
        let base = path.parse(parts[parts.length - 1]).name;
        if (abbr && base.toLowerCase().startsWith(abbr.toLowerCase() + '_')) base = base.slice(abbr.length + 1);
        let season, n, epTitle;
        const m = /^t(\d+)c(\d+)(?:[\s._-]+(.*))?$/i.exec(base);
        if (m) {
          season = parseInt(m[1], 10); n = parseInt(m[2], 10); epTitle = tidy(m[3] || '');
        } else {                                              // sin T#C#: temporada por subcarpeta, capítulo por número
          const sm = /(\d+)/.exec(parts.slice(1, -1).join(' '));
          season = sm ? parseInt(sm[1], 10) : 1;
          const text = tidy(base);
          n = episodeNumber(text); epTitle = stripNumber(text);
        }
        let entry;
        try { entry = await makeEntry('series', r.i, f); }
        catch (e) { warnings.push(`Se omitió ${f.rel}: ${e.code || e.message}`); continue; }
        if (!bySeason.has(season)) bySeason.set(season, []);
        bySeason.get(season).push({ n, title: epTitle, rel: f.rel, entry });
      }
      if (!bySeason.size) continue;
      const seasons = [...bySeason.entries()].sort((x, y) => x[0] - y[0]).map(([num, episodes]) => ({
        n: num,
        episodes: episodes.sort((x, y) => (x.n ?? 1e9) - (y.n ?? 1e9) || natural(x.rel, y.rel))
      }));
      series.push({ abbr, title, cover: findCover(abbr, d.name, title), seasons });
    }
  }
  series.sort((a, b) => natural(a.title, b.title));

  return { movies, series, warnings, config: { peliculas: cfg.peliculas, series: cfg.series, caratulas: cfg.caratulas } };
}

/* ---------- Resolver archivos de las rutas configuradas ---------- */
function resolveMedia(kind, idx, rel) {
  if (!KINDS.includes(kind)) return null;
  const root = rootsOf(loadConfig().cfg, kind)[idx];
  if (!root) return null;
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) return null;
  if (!(VIDEO.test(abs) || IMAGE.test(abs))) return null;
  return abs;
}

function serveFile(req, res, abs, cacheable) {
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('No encontrado'); }
    const head = {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheable ? 'public, max-age=3600' : 'no-cache'
    };
    let stream;
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) {
      let start = range[1] ? parseInt(range[1], 10) : 0;
      let end = range[2] ? parseInt(range[2], 10) : st.size - 1;
      if (!range[1] && range[2]) { start = Math.max(st.size - parseInt(range[2], 10), 0); end = st.size - 1; }
      end = Math.min(end, st.size - 1);
      if (start >= st.size || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      stream = fs.createReadStream(abs, { start, end });
    } else {
      res.writeHead(200, { ...head, 'Content-Length': st.size });
      stream = fs.createReadStream(abs);
    }
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}

/* ---------- Conversión automática a MP4 (H.264 + AAC) ----------
   - Los videos compatibles con el navegador se sirven tal cual.
   - Los demás (MKV, AVI, MOV, HEVC, audio AC3/DTS…) se convierten a .mp4 en .cache/:
     el video se copia si ya es H.264 y solo se recodifica cuando hace falta; el audio pasa a AAC.
   - Un proceso en segundo plano convierte toda la biblioteca; si alguien reproduce un video
     que aún no está listo, ese video pasa al frente.
*/
const CACHE_VERSION = 'v2';
const PROBE_FILE = path.join(CACHE_DIR, 'probe.json');
const jobs = new Map();            // id -> { state, progress, error, abs, out, name, decision, bg }
const bgQueue = [];                // trabajos en cola (segundo plano)
const probeQueue = [];             // archivos por analizar
const stats = { total: 0, done: 0, failed: 0 };
let bgRunning = 0, probing = false, probeCache = null, probeTimer = null;

const cacheId = (abs, st) => crypto.createHash('sha1').update([abs, st.size, Math.round(st.mtimeMs), CACHE_VERSION].join('|')).digest('hex').slice(0, 24);
const cachedPath = id => path.join(CACHE_DIR, id + '.mp4');

function loadProbeCache() {
  if (probeCache) return probeCache;
  try { probeCache = JSON.parse(fs.readFileSync(PROBE_FILE, 'utf8')); } catch { probeCache = {}; }
  try { for (const f of fs.readdirSync(CACHE_DIR)) if (f.endsWith('.part')) fs.unlinkSync(path.join(CACHE_DIR, f)); } catch {}
  return probeCache;
}
function saveProbeSoon() {
  if (probeTimer) return;
  probeTimer = setTimeout(() => {
    probeTimer = null;
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(PROBE_FILE, JSON.stringify(probeCache)); } catch {}
  }, 1000);
}

function ffprobe(abs) {
  return new Promise(resolve => execFile('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', abs],
    { maxBuffer: 8e6, timeout: 60000 }, (e, out) => {
      if (e) return resolve(null);
      try {
        const j = JSON.parse(out), streams = j.streams || [];
        const v = streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
        const a = streams.find(s => s.codec_type === 'audio');
        resolve({
          duration: parseFloat(j.format && j.format.duration) || 0,
          video: v ? { codec: v.codec_name, pix_fmt: v.pix_fmt } : null,
          audio: a ? { codec: a.codec_name, channels: a.channels || 2 } : null
        });
      } catch { resolve(null); }
    }));
}

// ¿Lo reproduce cualquier navegador tal cual? Si no, cómo convertirlo.
function decide(info, abs) {
  const v = info.video, a = info.audio;
  if (!v) return { convert: false };
  const ext = path.extname(abs).toLowerCase();
  const h264Ok = v.codec === 'h264' && v.pix_fmt === 'yuv420p';
  const audioOk = !a || a.codec === 'aac' || a.codec === 'mp3';
  if ((ext === '.mp4' || ext === '.m4v') && h264Ok && audioOk) return { convert: false };
  if (ext === '.webm' && ['vp8', 'vp9', 'av1'].includes(v.codec) && (!a || ['opus', 'vorbis'].includes(a.codec))) return { convert: false };
  return { convert: true, copyVideo: h264Ok, copyAudio: !!a && a.codec === 'aac' };
}

function buildArgs(job, part) {
  const d = job.decision;
  return ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-fflags', '+genpts', '-i', job.abs,
    '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_chapters', '-1',
    ...(d.copyVideo
      ? ['-c:v', 'copy', '-avoid_negative_ts', 'make_zero']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-profile:v', 'high']),
    ...(d.copyAudio
      ? ['-c:a', 'copy']
      : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-af', 'aresample=async=1:first_pts=0']),
    '-movflags', '+faststart', '-f', 'mp4', part];
}

function startJob(job) {
  job.state = 'working';
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const part = job.out + '.part';
  const args = buildArgs(job, part);
  const ff = job.bg && NICE ? spawn('nice', ['-n', '10', 'ffmpeg', ...args]) : spawn('ffmpeg', args);
  let errText = '';
  const finish = (ok, error) => {
    if (job.state !== 'working') return;
    job.state = ok ? 'ready' : 'error';
    job.progress = ok ? 1 : job.progress;
    job.error = ok ? null : error;
    ok ? stats.done++ : stats.failed++;
    if (!ok) fs.unlink(part, () => {});
    if (job.bg) { bgRunning--; pumpBg(); }
  };
  ff.stdout.on('data', d => {
    const line = d.toString().split('\n').reverse().find(l => l.startsWith('out_time_us=') || l.startsWith('out_time_ms=')) || '';
    const m = /=(\d+)/.exec(line);
    if (m && job.duration) job.progress = Math.min(parseInt(m[1], 10) / 1e6 / job.duration, 0.99);
  });
  ff.stderr.on('data', d => { errText += d.toString(); });
  ff.on('error', e => finish(false, e.message));
  ff.on('close', code => {
    if (code === 0) fs.rename(part, job.out, e => finish(!e, e && e.message));
    else finish(false, errText.trim().split('\n').pop() || `ffmpeg salió con código ${code}`);
  });
}

function pumpBg() {
  if (bgRunning > 0) return;
  const job = bgQueue.shift();
  if (!job) return;
  bgRunning++;
  startJob(job);
}

function makeJob(id, abs, info, bg) {
  const job = { id, state: 'queued', progress: 0, error: null, abs, out: cachedPath(id), name: path.basename(abs), decision: info.decision, duration: info.duration || 0, bg };
  jobs.set(id, job);
  stats.total++;
  return job;
}

async function infoFor(abs, id) {
  const cache = loadProbeCache();
  if (cache[id]) return cache[id];
  const raw = await ffprobe(abs);
  if (!raw) return null;
  cache[id] = { ...raw, decision: decide(raw, abs) };
  saveProbeSoon();
  return cache[id];
}

// Segundo plano: analiza la biblioteca y encola lo que haga falta convertir.
async function enqueueLibrary(lib) {
  await ffmpegReady;
  if (!FFMPEG || !loadConfig().cfg.convertirVideos) return;
  const entries = [...lib.movies.map(m => m.entry), ...lib.series.flatMap(s => s.seasons.flatMap(se => se.episodes.map(e => e.entry)))];
  probeQueue.push(...entries);
  if (probing) return;
  probing = true;
  try {
    while (probeQueue.length) {
      const e = probeQueue.shift();
      const abs = resolveMedia(e.kind, e.root, e.rel);
      if (!abs) continue;
      const st = await fs.promises.stat(abs).catch(() => null);
      if (!st) continue;
      const id = cacheId(abs, st);
      if (jobs.has(id) || fs.existsSync(cachedPath(id))) continue;
      const info = await infoFor(abs, id);
      if (info && info.decision.convert) { bgQueue.push(makeJob(id, abs, info, true)); pumpBg(); }
    }
  } finally { probing = false; }
}

// Al reproducir: devuelve la URL lista, o el avance si todavía se está convirtiendo.
async function playable(kind, idx, rel) {
  const abs = resolveMedia(kind, idx, rel);
  if (!abs || !VIDEO.test(abs)) return [400, { error: 'ruta no válida' }];
  const st = await fs.promises.stat(abs).catch(() => null);
  if (!st || !st.isFile()) return [404, { error: 'no encontrado' }];
  const direct = { state: 'ready', url: mediaUrl(kind, idx, rel), converted: false };
  await ffmpegReady;
  if (!FFMPEG) return [200, { ...direct, note: 'sin-ffmpeg' }];

  const id = cacheId(abs, st);
  if (fs.existsSync(cachedPath(id))) return [200, { state: 'ready', url: '/cache/' + id + '.mp4', converted: true }];

  let job = jobs.get(id);
  if (!job) {
    const info = await infoFor(abs, id);
    if (!info || !info.decision.convert) return [200, direct];
    job = makeJob(id, abs, info, false);
    startJob(job);
  } else if (job.state === 'queued') {                       // estaba en cola: pasa al frente
    const i = bgQueue.indexOf(job);
    if (i >= 0) bgQueue.splice(i, 1);
    job.bg = false;
    startJob(job);
  }
  if (job.state === 'error') return [200, { ...direct, warning: job.error }];   // intenta el original
  if (job.state === 'ready') return [200, { state: 'ready', url: '/cache/' + id + '.mp4', converted: true }];
  return [200, { state: 'working', progress: job.progress }];
}

function conversionStatus() {
  const working = [...jobs.values()].filter(j => j.state === 'working');
  const cur = working[0];
  return {
    active: probing || bgQueue.length > 0 || working.length > 0,
    total: stats.total, done: stats.done, failed: stats.failed, pending: bgQueue.length,
    current: cur ? { name: cur.name, progress: cur.progress } : null
  };
}

/* ---------- Servidor ---------- */
const STATIC = {
  '/': 'index.html', '/index.html': 'index.html',
  '/css/styles.css': 'css/styles.css', '/js/app.js': 'js/app.js'
};
const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

/* ---------- Perfiles, historial y reseñas (data/db.json) ---------- */
const DATA_DIR = path.join(ROOT, 'data');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { profiles: [], history: {}, ratings: {} };
let saveTimer = null;

function loadDb() {
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) return;
  try {
    const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db = { profiles: d.profiles || [], history: d.history || {}, ratings: d.ratings || {} };
  } catch (e) {
    const bak = DB_FILE + '.corrupto-' + Date.now();
    fs.renameSync(DB_FILE, bak);
    console.error(`  Aviso: data/db.json estaba dañado. Se guardó una copia en ${path.basename(bak)} y se empieza de cero.`);
  }
}
function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db));
    fs.renameSync(DB_FILE + '.tmp', DB_FILE);
  } catch (e) { console.error('No se pudo guardar data/db.json:', e.message); }
}
const scheduleSave = () => { if (!saveTimer) saveTimer = setTimeout(saveNow, 400); };
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => { saveNow(); process.exit(0); }));

const publicProfile = p => ({ id: p.id, name: p.name, avatar: p.avatar ? `/avatars/${p.avatar}` : null });
const findProfile = id => db.profiles.find(p => p.id === id);
const num = (v, max = 1e9) => Math.min(Math.max(Number(v) || 0, 0), max);

const cleanName = v => String(v || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24);
const nameTaken = (name, exceptId) => db.profiles.some(x => x.id !== exceptId && x.name.toLowerCase() === name.toLowerCase());
const adminFails = new Map();
const safeEqual = (a, b) => {
  const h = v => crypto.createHash('sha256').update(v).digest();
  return crypto.timingSafeEqual(h(a), h(b));
};

function removeAvatar(prof) {
  if (prof.avatar) fs.unlink(path.join(AVATAR_DIR, prof.avatar), () => {});
  prof.avatar = null;
}

// Guarda la foto (data URL). Devuelve null si todo salió bien o [código, mensaje].
function storeAvatar(prof, dataUrl) {
  const mm = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!mm) return [400, 'La foto no es válida'];
  const buf = Buffer.from(mm[2], 'base64');
  if (buf.length > 1.5e6) return [413, 'La foto es demasiado grande'];
  const file = `${prof.id}-${Date.now().toString(36)}.${mm[1] === 'jpeg' ? 'jpg' : mm[1]}`;
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  fs.writeFileSync(path.join(AVATAR_DIR, file), buf);
  removeAvatar(prof);
  prof.avatar = file;
  return null;
}

function readBody(req, limit = 3e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Contenido demasiado grande'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('JSON no válido'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// Devuelve true si la ruta era de la API de perfiles.
async function profileApi(req, res, p, url) {
  const m = req.method;
  const fail = (code, msg) => { json(res, code, { error: msg }); return true; };
  const ok = (body, code = 200) => { json(res, code, body); return true; };

  if (p === '/api/profiles' && m === 'GET') return ok(db.profiles.map(publicProfile));

  if (p === '/api/profiles' && m === 'POST') {
    const b = await readBody(req, 2.5e6);
    const name = cleanName(b.name);
    if (!name) return fail(400, 'Escribe un nombre de usuario');
    if (nameTaken(name)) return fail(409, 'Ya existe un perfil con ese nombre');
    const prof = { id: 'p' + crypto.randomBytes(5).toString('hex'), name, avatar: null, created: Date.now() };
    if (b.photo) { const err = storeAvatar(prof, b.photo); if (err) return fail(err[0], err[1]); }
    db.profiles.push(prof);
    saveNow();
    return ok(publicProfile(prof), 201);
  }

  if (p === '/api/profiles/update' && m === 'POST') {
    const b = await readBody(req, 2.5e6);
    const prof = findProfile(b.id);
    if (!prof) return fail(404, 'Perfil no encontrado');
    const name = cleanName(b.name);
    if (!name) return fail(400, 'Escribe un nombre de usuario');
    if (nameTaken(name, prof.id)) return fail(409, 'Ya existe un perfil con ese nombre');
    if (b.photo) { const err = storeAvatar(prof, b.photo); if (err) return fail(err[0], err[1]); }
    else if (b.removePhoto) removeAvatar(prof);
    prof.name = name;
    saveNow();
    return ok(publicProfile(prof));
  }

  if (p === '/api/profiles/delete' && m === 'POST') {
    const b = await readBody(req, 1e4);
    const ip = req.socket.remoteAddress || '?';
    const f = adminFails.get(ip);
    if (f && f.until > Date.now()) return fail(429, 'Demasiados intentos. Espera un minuto e inténtalo de nuevo.');
    const admin = loadConfig().cfg.claveAdmin;
    if (!admin) return fail(400, 'No hay contraseña de administrador. Define "claveAdmin" en config.json.');
    if (!safeEqual(String(b.password || ''), admin)) {
      const n = ((f && f.n) || 0) + 1;
      adminFails.set(ip, n >= 5 ? { n: 0, until: Date.now() + 60000 } : { n, until: 0 });
      return fail(403, 'Contraseña de administrador incorrecta');
    }
    adminFails.delete(ip);
    const prof = findProfile(b.id);
    if (!prof) return fail(404, 'Perfil no encontrado');
    removeAvatar(prof);
    db.profiles = db.profiles.filter(x => x.id !== prof.id);
    delete db.history[prof.id];
    for (const key of Object.keys(db.ratings)) {
      delete db.ratings[key][prof.id];
      if (!Object.keys(db.ratings[key]).length) delete db.ratings[key];
    }
    saveNow();
    return ok({ ok: true });
  }

  if (p === '/api/history' && m === 'GET') {
    const pid = url.searchParams.get('profile');
    if (!findProfile(pid)) return fail(404, 'Perfil no encontrado');
    const ratings = {};
    for (const [key, byProfile] of Object.entries(db.ratings)) if (byProfile[pid]) ratings[key] = byProfile[pid];
    return ok({ history: db.history[pid] || {}, ratings });
  }

  if (p === '/api/history' && m === 'POST') {
    const b = await readBody(req, 1e5);
    if (!findProfile(b.profile) || typeof b.key !== 'string' || !b.key || b.key.length > 400) return fail(400, 'Datos no válidos');
    if (!db.history[b.profile]) db.history[b.profile] = {};
    const prev = db.history[b.profile][b.key];
    const rec = { t: num(b.t), d: num(b.d), pct: Math.max(prev ? prev.pct || 0 : 0, Math.round(num(b.pct, 100))), at: Date.now() };
    db.history[b.profile][b.key] = rec;
    scheduleSave();
    return ok({ ok: true, pct: rec.pct });
  }

  if (p === '/api/summary' && m === 'GET') {
    const out = {};
    for (const [key, byProfile] of Object.entries(db.ratings)) {
      const list = Object.values(byProfile);
      if (list.length) out[key] = { sum: list.reduce((a, r) => a + r.stars, 0), n: list.length };
    }
    return ok(out);
  }

  if (p === '/api/reviews' && m === 'POST') {
    const b = await readBody(req, 5e5);
    const keys = Array.isArray(b.keys) ? b.keys.slice(0, 1000) : [];
    const out = [];
    for (const key of keys) {
      const byProfile = db.ratings[key];
      if (!byProfile) continue;
      for (const [pid, r] of Object.entries(byProfile)) {
        const prof = findProfile(pid);
        if (!prof) continue;
        const h = db.history[pid] && db.history[pid][key];
        out.push({ key, profile: publicProfile(prof), stars: r.stars, review: r.review || '', at: r.at, pct: h ? h.pct || 0 : 0 });
      }
    }
    out.sort((a, b2) => b2.at - a.at);
    return ok({ reviews: out });
  }

  if (p === '/api/rating' && m === 'POST') {
    const b = await readBody(req, 1e5);
    const stars = Number(b.stars);
    if (!findProfile(b.profile) || typeof b.key !== 'string' || !b.key || b.key.length > 400) return fail(400, 'Datos no válidos');
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) return fail(400, 'Elige de 1 a 5 estrellas');
    const review = String(b.review || '').trim().slice(0, 1000);
    if (!db.ratings[b.key]) db.ratings[b.key] = {};
    db.ratings[b.key][b.profile] = { stars, review, at: Date.now() };
    saveNow();
    return ok({ ok: true });
  }

  if (p === '/api/rating/delete' && m === 'POST') {
    const b = await readBody(req, 1e5);
    if (db.ratings[b.key]) {
      delete db.ratings[b.key][b.profile];
      if (!Object.keys(db.ratings[b.key]).length) delete db.ratings[b.key];
      saveNow();
    }
    return ok({ ok: true });
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);

    if (p === '/api/library') {
      const lib = await scan();
      enqueueLibrary(lib).catch(() => {});
      return json(res, 200, lib);
    }

    if (p.startsWith('/api/') && await profileApi(req, res, p, url)) return;

    if (/^\/avatars\/p[a-f0-9]+(-[a-z0-9]+)?\.(jpg|png|webp)$/.test(p)) return serveFile(req, res, path.join(AVATAR_DIR, p.slice(9)), true);

    if (p === '/api/play') {
      const [code, body] = await playable(url.searchParams.get('kind'), parseInt(url.searchParams.get('root'), 10), url.searchParams.get('path') || '');
      return json(res, code, body);
    }

    if (p === '/api/conversion') return json(res, 200, conversionStatus());

    if (p.startsWith('/media/')) {
      const [, , kind, idx, ...rest] = p.split('/');
      const abs = resolveMedia(kind, parseInt(idx, 10), rest.join('/'));
      if (!abs) { res.writeHead(403); return res.end('Prohibido'); }
      return serveFile(req, res, abs, true);
    }

    if (/^\/cache\/[a-f0-9]{24}\.mp4$/.test(p)) return serveFile(req, res, path.join(CACHE_DIR, p.slice(7)), true);

    if (STATIC[p]) return serveFile(req, res, path.join(ROOT, STATIC[p]), false);
    res.writeHead(404); res.end('No encontrado');
  } catch (e) {
    console.error('Error en', req.url, '->', e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.message || String(e) });
  }
});

loadDb();
const PORT = Number(process.env.PORT) || loadConfig().cfg.puerto;

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`\nEl puerto ${PORT} ya está en uso. Cambia "puerto" en config.json o usa:\n  PORT=3001 node server.js\n`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, LAN ? '0.0.0.0' : '127.0.0.1', () => {
  const { cfg } = loadConfig();
  ensureLocalDirs(cfg);
  const local = `http://localhost:${PORT}`;
  console.log('\n  Cine local funcionando');
  for (const k of KINDS) console.log(`  ${k.padEnd(10)} ${rootsOf(cfg, k).map((r, i) => r || cfg[k][i] + ' (no válida)').join('  |  ')}`);
  console.log(`\n  Abrir:     ${local}`);
  if (LAN) {
    Object.values(os.networkInterfaces()).flat()
      .filter(i => i && i.family === 'IPv4' && !i.internal)
      .forEach(i => console.log(`  En tu red: http://${i.address}:${PORT}`));
  }
  console.log(`  Perfiles y reseñas: ${DATA_DIR}`);
  if (cfg.claveAdmin === 'admin') console.log('  Aviso: la contraseña de administrador sigue siendo "admin". Cámbiala en config.json (claveAdmin).');
  else if (!cfg.claveAdmin) console.log('  Aviso: sin contraseña de administrador (claveAdmin vacía): no se podrán eliminar perfiles.');
  console.log('\n  Rutas editables en config.json. Ctrl + C para detener.\n');
  scan().then(enqueueLibrary).catch(e => console.error('Escaneo inicial:', e.message));
  if (!NO_OPEN) {
    const cmd = process.platform === 'darwin' ? `open "${local}"` : `xdg-open "${local}"`;
    exec(cmd, () => {});
  }
});
