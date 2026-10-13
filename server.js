'use strict';
/*
  Cine local - servidor sin dependencias (solo Node.js).

  Las rutas donde se buscan los archivos se definen en config.json
  (por defecto, las carpetas peliculas/, series/ y caratulas/ junto a este archivo).

    peliculas/   videos sueltos            ->  ABREV_Nombre completo.mkv
    series/      una carpeta por serie     ->  ABREV_Nombre de la serie/  con T1C4_lucha.mkv (temporada 1, capítulo 4, "lucha")
    caratulas/   imágenes 2:3 vertical     ->  ABREV.jpg

  Uso:  node server.js            (solo este equipo)
        node server.js --lan      (también otros dispositivos de tu red)
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec, execFile, spawn } = require('child_process');

const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'config.json');
const CACHE_DIR = path.join(ROOT, '.cache');
const LAN = process.argv.includes('--lan');
const NO_OPEN = process.argv.includes('--no-open');

const VIDEO = /\.(mp4|m4v|webm|mov|mkv|ogv|avi)$/i;
const IMAGE = /\.(jpe?g|png|webp)$/i;
const KINDS = ['peliculas', 'series', 'caratulas'];
const DEFAULTS = { puerto: 3000, peliculas: ['./peliculas'], series: ['./series'], caratulas: ['./caratulas'] };

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.ogv': 'video/ogg', '.avi': 'video/x-msvideo',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp'
};

let FFMPEG = false;
execFile('ffmpeg', ['-version'], e => {
  FFMPEG = !e;
  if (!FFMPEG) console.log('  Aviso: ffmpeg no está instalado; no se podrá arreglar el audio.\n  Instálalo con:  sudo apt install ffmpeg\n');
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
  const cfg = { puerto: Number(user.puerto) || DEFAULTS.puerto };
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

/* ---------- Conversión de audio (video se copia, audio -> AAC u Opus) ---------- */
const jobs = new Map();

function probeDuration(abs) {
  return new Promise(res => execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', abs],
    (e, out) => res(e ? 0 : parseFloat(out) || 0)));
}

function startJob(job, abs, out, codec) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const part = out + '.part';
  const audio = codec === 'opus'
    ? ['-c:a', 'libopus', '-b:a', '160k', '-ac', '2', '-strict', '-2']
    : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2'];
  probeDuration(abs).then(dur => {
    const args = ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-i', abs,
      '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', ...audio, '-sn', '-dn',
      '-movflags', '+faststart', '-f', 'mp4', part];
    const ff = spawn('ffmpeg', args);
    let errText = '';
    ff.stdout.on('data', d => {
      const line = d.toString().split('\n').reverse().find(l => l.startsWith('out_time_')) || '';
      const m = /out_time_(?:us|ms)=(\d+)/.exec(line);
      if (m && dur) job.progress = Math.min(parseInt(m[1], 10) / 1e6 / dur, 0.99);
    });
    ff.stderr.on('data', d => { errText += d.toString(); });
    ff.on('error', () => { job.state = 'error'; job.error = 'ffmpeg'; });
    ff.on('close', code => {
      if (code === 0) {
        fs.rename(part, out, e => { job.state = e ? 'error' : 'ready'; job.progress = 1; if (e) job.error = e.message; });
      } else {
        fs.unlink(part, () => {});
        job.state = 'error';
        job.error = errText.trim().split('\n').pop() || ('ffmpeg salió con código ' + code);
      }
    });
  });
}

async function prepare(kind, idx, rel, codec) {
  const abs = resolveMedia(kind, idx, rel);
  if (!abs || !VIDEO.test(abs)) return [400, { error: 'ruta no válida' }];
  if (!FFMPEG) return [501, { error: 'ffmpeg' }];
  const st = await fs.promises.stat(abs).catch(() => null);
  if (!st || !st.isFile()) return [404, { error: 'no encontrado' }];
  codec = codec === 'opus' ? 'opus' : 'aac';
  const id = crypto.createHash('sha1').update([abs, st.size, st.mtimeMs, codec].join('|')).digest('hex').slice(0, 24);
  const out = path.join(CACHE_DIR, id + '.mp4');
  const url = '/cache/' + id + '.mp4';
  if (fs.existsSync(out)) return [200, { state: 'ready', progress: 1, url }];
  let job = jobs.get(id);
  if (!job || job.state === 'error') {
    job = { state: 'working', progress: 0, error: null };
    jobs.set(id, job);
    startJob(job, abs, out, codec);
  }
  return [200, { state: job.state, progress: job.progress, error: job.error, url: job.state === 'ready' ? url : null }];
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);

    if (p === '/api/library') return json(res, 200, await scan());

    if (p === '/api/prepare') {
      const [code, body] = await prepare(url.searchParams.get('kind'), parseInt(url.searchParams.get('root'), 10),
        url.searchParams.get('path') || '', url.searchParams.get('codec'));
      return json(res, code, body);
    }

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
    json(res, 500, { error: e.message || String(e) });
  }
});

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
  console.log('\n  Rutas editables en config.json. Ctrl + C para detener.\n');
  if (!NO_OPEN) {
    const cmd = process.platform === 'darwin' ? `open "${local}"` : `xdg-open "${local}"`;
    exec(cmd, () => {});
  }
});
