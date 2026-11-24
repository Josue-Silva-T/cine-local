'use strict';
/*
  HLS bajo demanda (sin guardar la película completa).

  Para cada película el servidor publica:
      /hls/<id>/master.m3u8     manifiesto maestro: 1 variante de video + una pista de audio por cada
                                audio del archivo (#EXT-X-MEDIA con idioma, nombre y metadatos)
      /hls/<id>/v.m3u8          lista de segmentos de video
      /hls/<id>/a<N>.m3u8       lista de segmentos de la pista de audio N
      /hls/<id>/v/<n>.ts        segmento n de video
      /hls/<id>/a<N>/<n>.ts     segmento n de la pista de audio N

  Los segmentos NO existen de antemano: ffmpeg los produce cuando el reproductor los pide.
    - Video H.264 compatible  -> se COPIA sin recodificar (cortes en fotogramas clave, casi sin CPU).
    - Cualquier otro video    -> se recodifica a H.264 con fotogramas clave forzados cada 6 s.
    - Audio                   -> siempre AAC estéreo (una ejecución continua de ffmpeg, sin saltos entre segmentos).
  Cada flujo tiene un productor que genera unos segmentos por delante de la posición actual y se pausa;
  si el usuario salta a otro punto, se reinicia allí. En disco solo se conserva una ventana corta
  alrededor de la posición (nunca el archivo completo).
*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const SEG = 6;                 // duración objetivo de un segmento (s)
const LOOKAHEAD = 8;           // segmentos que se producen por delante de la posición
const BEHIND = 12;             // segmentos que se conservan detrás (para volver atrás o cambiar de pista sin regenerar)
const JUMP = 3;                // si piden un segmento a más de JUMP del último producido, se reinicia allí
const IDLE_MS = 45000;         // sin peticiones durante este tiempo se detiene el productor
const SESSION_IDLE_MS = 20 * 60 * 1000;
const MAX_COPY_SEG = 20;       // si los fotogramas clave están muy separados, se recodifica
const PLAN_VERSION = 'h5';

/* ---------- Idiomas y nombres de pista ---------- */
const B2 = { fre: 'fr', ger: 'de', chi: 'zh', dut: 'nl', gre: 'el', cze: 'cs', per: 'fa', ice: 'is', mac: 'mk', mao: 'mi', may: 'ms',
  rum: 'ro', slo: 'sk', tib: 'bo', wel: 'cy', arm: 'hy', baq: 'eu', bur: 'my', geo: 'ka', alb: 'sq', spa: 'es', eng: 'en', jpn: 'ja',
  por: 'pt', ita: 'it', rus: 'ru', kor: 'ko', ara: 'ar', hin: 'hi', tur: 'tr', pol: 'pl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi',
  hun: 'hu', heb: 'he', tha: 'th', vie: 'vi', ind: 'id', ukr: 'uk', cat: 'ca', lat: 'la', zho: 'zh', fra: 'fr', deu: 'de', nld: 'nl' };
const iso2 = c => { c = String(c || '').toLowerCase().trim(); return c.length === 2 ? c : (B2[c] || (c && c !== 'und' ? c : 'und')); };
let dn = null;
try { dn = new Intl.DisplayNames(['es'], { type: 'language' }); } catch {}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const langName = code => { try { const n = dn && dn.of(code); return n && n !== code ? cap(n) : code.toUpperCase(); } catch { return code.toUpperCase(); } };

const CODEC_LABEL = { ac3: 'Dolby Digital', eac3: 'Dolby Digital Plus', dts: 'DTS', truehd: 'Dolby TrueHD', aac: 'AAC', opus: 'Opus',
  flac: 'FLAC', mp3: 'MP3', vorbis: 'Vorbis', mp2: 'MP2' };
const layoutOf = n => ({ 1: '1.0', 2: '2.0', 3: '2.1', 6: '5.1', 8: '7.1' }[n] || `${n} canales`);
const GENERIC_TITLE = /^(\s*|stereo|mono|surround|dolby|ac-?3|e-?ac-?3|dts(-hd)?|aac|truehd|flac|mp3|\d(\.\d)?|audio|track \d+|pista \d+|5\.1|2\.0|7\.1|[-_ ·])+$/i;

// Nombre legible y metadatos de una pista de audio, a partir de lo que trae el archivo.
function describeAudio(a, n) {
  const lang = iso2(a.lang);
  const t = (a.title || '').trim();
  let variant = '';
  if (lang === 'es') variant = /latin|latam|m[eé]x|\blat\b/i.test(t) ? 'Latinoamérica' : /castell|espa[nñ]a|spain|ib[eé]ric|europ|\bcast\b/i.test(t) ? 'España' : '';
  else if (lang === 'pt') variant = /bra[sz]il|\bbr\b/i.test(t) ? 'Brasil' : /portugal|europ/i.test(t) ? 'Portugal' : '';
  else if (lang === 'fr') variant = /canad|qu[eé]b/i.test(t) ? 'Canadá' : '';
  else if (lang === 'en') variant = /\buk\b|brit/i.test(t) ? 'Reino Unido' : /\bus\b|americ/i.test(t) ? 'EE. UU.' : '';
  const original = !!a.original || /\boriginal\b|\bv\.?o\.?\b|\bo\.?v\.?\b/i.test(t);
  let name = lang !== 'und' ? langName(lang) : `Pista ${n + 1}`;
  if (variant) name += ` (${variant})`;
  if (original) name += ' · Original';
  const tech = `${CODEC_LABEL[a.codec] || String(a.codec || '').toUpperCase()} ${layoutOf(a.channels)}`.trim();
  const extra = t && !GENERIC_TITLE.test(t) && t.toLowerCase() !== name.toLowerCase() && !/^original$/i.test(t) ? t : '';
  return { lang, name, original, title: t, source: tech, description: [extra, tech].filter(Boolean).join(' · ') };
}

/* ---------- ffprobe ---------- */
function probe(abs) {
  return new Promise(resolve => execFile('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', abs],
    { maxBuffer: 16e6, timeout: 90000 }, (e, out) => {
      if (e) return resolve(null);
      try {
        const j = JSON.parse(out), streams = j.streams || [], f = j.format || {};
        const num = v => { const x = parseFloat(v); return isFinite(x) ? x : null; };
        const v = streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
        const fps = v && v.avg_frame_rate && v.avg_frame_rate.includes('/') ? (([a, b]) => (+b ? +a / +b : 0))(v.avg_frame_rate.split('/')) : 0;
        resolve({
          duration: num(f.duration) || 0, formatStart: num(f.start_time) || 0, bitrate: num(f.bit_rate) || 0,
          video: v ? { index: v.index, codec: v.codec_name, profile: v.profile || '', level: v.level, pix_fmt: v.pix_fmt, width: v.width, height: v.height,
            fps: fps || 24, start: num(v.start_time) || 0, bitrate: num(v.bit_rate) || 0 } : null,
          audio: streams.filter(s => s.codec_type === 'audio').map((s, i) => ({
            ordinal: i, index: s.index, codec: s.codec_name, channels: s.channels || 2, sampleRate: num(s.sample_rate) || 48000,
            lang: s.tags && (s.tags.language || s.tags.LANGUAGE) || '', title: s.tags && (s.tags.title || s.tags.TITLE) || '',
            default: !!(s.disposition && s.disposition.default), original: !!(s.disposition && s.disposition.original)
          })),
          subtitles: streams.filter(s => s.codec_type === 'subtitle').length
        });
      } catch { resolve(null); }
    }));
}

// Fin real del contenido: lee solo los últimos paquetes del video. La duración declarada en la cabecera
// puede incluir el desfase inicial del contenedor (p. ej. Matroska) y alargaría el último segmento.
function tailEnd(abs, vIndex, from, fps) {
  return new Promise(resolve => execFile('ffprobe', ['-v', 'error', '-select_streams', String(vIndex), '-read_intervals', `${Math.max(0, from).toFixed(3)}%`,
    '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', abs], { maxBuffer: 8e6, timeout: 60000 }, (e, out) => {
    if (e) return resolve(null);
    let end = null;
    for (const l of out.split('\n')) {
      const [p, d] = l.split(',');
      const pts = parseFloat(p); if (!isFinite(pts)) continue;
      const dur = isFinite(parseFloat(d)) ? parseFloat(d) : 1 / (fps || 24);
      end = Math.max(end === null ? -Infinity : end, pts + dur);
    }
    resolve(end);
  }));
}

// Lista de fotogramas clave del video (lee los paquetes sin decodificar). Se guarda en el plan.
function scanKeyframes(abs, vIndex, nice) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-select_streams', String(vIndex), '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', abs];
    const p = nice ? spawn('nice', ['-n', '10', 'ffprobe', ...args]) : spawn('ffprobe', args);
    const kf = []; let rest = '', err = '';
    p.stdout.on('data', d => {
      const lines = (rest + d.toString()).split('\n'); rest = lines.pop();
      for (const l of lines) { const i = l.indexOf(','); if (i > 0 && l[i + 1] === 'K') { const t = parseFloat(l.slice(0, i)); if (isFinite(t)) kf.push(t); } }
    });
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', code => code === 0 || kf.length ? resolve([...new Set(kf)].sort((a, b) => a - b)) : reject(new Error(err.trim().split('\n').pop() || 'ffprobe falló')));
  });
}

/* ---------- Plan de segmentos ---------- */
const AVC_PROFILE = { baseline: '42', 'constrained baseline': '42', main: '4d', extended: '58', high: '64' };
const copyable = v => v && v.codec === 'h264' && v.pix_fmt === 'yuv420p' && AVC_PROFILE[(v.profile || '').toLowerCase()];
const hex2 = n => ('0' + (n & 255).toString(16)).slice(-2);
const avcString = (v, copy) => {
  if (!copy) return 'avc1.640029';                                   // lo que produce la recodificación: High 4.1
  const lvl = v.level > 0 ? v.level : 40;
  return `avc1.${AVC_PROFILE[(v.profile || '').toLowerCase()] || '64'}${/constrained/i.test(v.profile) ? 'c0' : '00'}${hex2(lvl)}`;
};

const MIN_TAIL = 1;            // un resto de menos de 1 s se une al segmento anterior (evita segmentos vacíos)

function uniformSegs(D) {
  let n = Math.max(1, Math.floor(D / SEG));
  if (D - n * SEG >= MIN_TAIL) n++;
  const out = [];
  for (let i = 0; i < n; i++) out.push({ t: i * SEG, d: i === n - 1 ? D - i * SEG : SEG });
  return out;
}

// Une fotogramas clave en segmentos de >= SEG segundos (cada segmento empieza en un fotograma clave).
function keyframeSegs(kfRel, D) {
  const starts = [0]; let cur = 0;
  for (const k of kfRel) if (k > 0 && k - cur >= SEG) { starts.push(k); cur = k; }
  while (starts.length > 1 && D - starts[starts.length - 1] < MIN_TAIL) starts.pop();
  return starts.map((t, i) => ({ t, d: (i + 1 < starts.length ? starts[i + 1] : D) - t }));
}

function buildPlan(info, kf) {
  const v = info.video;
  const S = v.start;                                                          // el tiempo 0 de la película es el primer fotograma
  const D = Math.max(1, info.mediaEnd && info.mediaEnd > S + 1 ? info.mediaEnd - S : info.duration - Math.max(0, S - info.formatStart));
  let mode = 'transcode', vSegs = uniformSegs(D);
  if (copyable(v) && kf && kf.length) {
    const segs = keyframeSegs(kf.map(k => k - S).filter(k => k >= -0.001).map(k => Math.max(0, k)), D);
    if (Math.max(...segs.map(s => s.d)) <= MAX_COPY_SEG) { mode = 'copy'; vSegs = segs; }
  }
  return { version: PLAN_VERSION, mode, S, D, vSegs, aSegs: uniformSegs(D), tracks: info.audio.map((a, i) => ({ ...a, ...describeAudio(a, i) })) };
}

/* ---------- Manifiestos ---------- */
const attr = s => String(s).replace(/["\r\n]/g, ' ').trim();
const f3 = n => n.toFixed(3);

function masterPlaylist(sess) {
  const { info, plan } = sess, v = info.video, L = ['#EXTM3U', '#EXT-X-VERSION:4', '#EXT-X-INDEPENDENT-SEGMENTS'];
  const tracks = plan.tracks;
  let def = tracks.findIndex(t => t.default); if (def < 0) def = 0;
  const seen = {};
  tracks.forEach((t, i) => {
    let name = t.name; seen[name] = (seen[name] || 0) + 1;
    if (seen[name] > 1) name += ` (${seen[name]})`;
    L.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${attr(name)}",LANGUAGE="${attr(t.lang)}",DEFAULT=${i === def ? 'YES' : 'NO'},AUTOSELECT=YES,CHANNELS="2",URI="a${i}.m3u8",` +
      `X-ID="${t.index}",X-TITLE="${attr(t.title)}",X-SOURCE="${attr(t.source)}",X-DESCRIPTION="${attr(t.description)}",X-ORIGINAL=${t.original ? 'YES' : 'NO'}`);
  });
  const copy = plan.mode === 'copy';
  const bw = copy ? Math.max(1e6, (v.bitrate || info.bitrate || 8e6)) + 192000 : 8000000;
  const w = copy ? v.width : v.height > 1080 ? Math.round(v.width * 1080 / v.height / 2) * 2 : v.width, h = copy ? v.height : Math.min(v.height, 1080);
  L.push(`#EXT-X-STREAM-INF:BANDWIDTH=${Math.round(bw)},RESOLUTION=${w}x${h},FRAME-RATE=${(v.fps || 24).toFixed(3)},CODECS="${avcString(v, copy)}${tracks.length ? ',mp4a.40.2' : ''}"` +
    (tracks.length ? ',AUDIO="audio"' : ''));
  L.push('v.m3u8');
  return L.join('\n') + '\n';
}

function mediaPlaylist(segs, prefix) {
  const L = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...segs.map(s => s.d)))}`, '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS'];
  segs.forEach((s, i) => { L.push(`#EXTINF:${f3(s.d)},`, `${prefix}/${i}.ts`); });
  L.push('#EXT-X-ENDLIST');
  return L.join('\n') + '\n';
}

/* ---------- Productores de segmentos ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const exists = f => { try { fs.accessSync(f); return true; } catch { return false; } };

class Stream {
  constructor(sess, key, hooks) {
    this.sess = sess; this.key = key; this.hooks = hooks;
    this.dir = path.join(sess.dir, key);
    fs.mkdirSync(this.dir, { recursive: true });
    this.run = null; this.done = new Set(); this.last = 0; this.touched = Date.now(); this.paused = false; this.starting = null;
  }
  get segs() { return this.key === 'v' ? this.sess.plan.vSegs : this.sess.plan.aSegs; }
  file(i) { return path.join(this.dir, i + '.ts'); }
  label() { return `${this.sess.name} [${this.key}]`; }

  listed() {
    const out = [];
    try { for (const f of fs.readdirSync(this.dir)) { const m = /^(\d+)\.ts$/.exec(f); if (m) out.push(+m[1]); } } catch {}
    return out;
  }
  highest() { return this.listed().reduce((a, b) => Math.max(a, b), -1); }

  complete(i) {
    if (this.done.has(i)) return true;
    if (!exists(this.file(i))) return false;
    const r = this.run;
    if (exists(this.file(i + 1)) || (r && r.exited && r.ok && i >= r.from)) { this.done.add(i); return true; }
    return false;
  }

  buildArgs(i) {
    const { sess } = this, plan = sess.plan, info = sess.info, segs = this.segs, N = segs.length;
    const X = plan.S + segs[i].t;                                           // tiempo absoluto (línea de tiempo del archivo) del primer segmento
    const rel = []; for (let j = i + 1; j < N; j++) rel.push(f3(segs[j].t - segs[i].t));
    const out = ['-copyts', '-avoid_negative_ts', 'disabled', '-max_muxing_queue_size', '1024', '-f', 'segment', '-segment_format', 'mpegts', '-segment_format_options', 'avoid_negative_ts=disabled',
      '-segment_start_number', String(i), ...(rel.length ? ['-segment_times', rel.join(',')] : ['-segment_time', '86400']), path.join(this.dir, '%d.ts')];
    const head = ['-v', 'error', '-nostdin', '-seek_timestamp', '1', '-ss', f3(Math.max(0, this.key === 'v' ? X - 0.01 : X)), '-i', sess.abs];
    if (this.key === 'v') {
      const v = info.video;
      if (plan.mode === 'copy') return [...head, '-copypriorss', '0', '-map', `0:${v.index}`, '-an', '-sn', '-dn', '-c:v', 'copy', ...out];
      const keys = []; for (let j = i + 1; j < N; j++) keys.push(f3(plan.S + segs[j].t));
      return [...head, '-map', `0:${v.index}`, '-an', '-sn', '-dn',
        ...(v.height > 1080 ? ['-vf', "scale=-2:'min(1080,ih)'"] : []),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-maxrate', '10M', '-bufsize', '20M', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1',
        ...(keys.length ? ['-force_key_frames', keys.join(',')] : []), ...out];
    }
    const a = info.audio[+this.key.slice(1)];
    return [...head, '-map', `0:${a.index}`, '-vn', '-sn', '-dn', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000', ...out];
  }

  killRun() {
    const r = this.run;
    if (!r || r.exited) return Promise.resolve();
    r.killed = true;
    return new Promise(resolve => {
      r.proc.once('close', resolve);
      try { r.proc.kill('SIGKILL'); } catch { resolve(); }
      setTimeout(resolve, 1500);
    }).then(() => {
      const hi = this.highest();                                              // el último archivo de esa ejecución quedó a medias
      if (hi >= r.from && !this.done.has(hi) && !exists(this.file(hi + 1))) { try { fs.unlinkSync(this.file(hi)); } catch {} }
    });
  }

  async startAt(i) {
    await this.killRun();
    // La nueva ejecución reescribirá desde i: lo que hubiera de una ejecución anterior se descarta
    // (si no, se podría servir un archivo a medio escribir mientras el muxer lo trunca).
    for (const n of this.listed()) if (n >= i) { try { fs.unlinkSync(this.file(n)); } catch {} this.done.delete(n); }
    for (const n of [...this.done]) if (n >= i) this.done.delete(n);
    const run = { from: i, exited: false, ok: false, killed: false, err: '' };
    const proc = spawn('ffmpeg', this.buildArgs(i), { stdio: ['ignore', 'ignore', 'pipe'] });
    run.proc = proc; this.run = run; this.paused = false;
    proc.stderr.on('data', d => { if (run.err.length < 2000) run.err += d.toString(); });
    proc.on('error', e => { run.exited = true; run.err = e.message; });
    proc.on('close', code => {
      run.exited = true; run.ok = code === 0;
      if (!run.killed && code !== 0) this.hooks.log(`HLS: ffmpeg falló en ${this.label()} (segmento ${run.from}): ${run.err.trim().split('\n').pop() || 'código ' + code}`);
    });
  }

  // Devuelve la ruta del segmento i cuando está completo; lo produce si hace falta.
  async get(i, aborted) {
    this.touched = Date.now(); this.sess.touched = this.touched; this.last = i;
    const N = this.segs.length;
    if (i < 0 || i >= N) throw Object.assign(new Error('segmento fuera de rango'), { status: 404 });
    const deadline = Date.now() + (this.sess.plan.mode === 'transcode' && this.key === 'v' ? 150000 : 60000);
    for (;;) {
      if (aborted()) throw Object.assign(new Error('cancelado'), { status: 499 });
      if (this.complete(i)) { this.resume(); this.touched = Date.now(); return this.file(i); }
      const r = this.run, hi = this.highest();
      const covered = r && !r.exited && i >= r.from && i <= Math.max(hi, r.from) + JUMP && (i >= hi || exists(this.file(i)));
      if (!covered) {
        if (!this.starting) this.starting = this.startAt(i).finally(() => { this.starting = null; });
        await this.starting;
      } else this.resume();
      if (Date.now() > deadline) throw Object.assign(new Error(`tiempo de espera agotado generando el segmento ${i}`), { status: 504 });
      if (this.run && this.run.exited && !this.run.ok && !this.run.killed && !this.complete(i)) {
        throw Object.assign(new Error(this.run.err.trim().split('\n').pop() || 'ffmpeg terminó sin generar el segmento'), { status: 500 });
      }
      await sleep(60);
    }
  }

  // Precalienta la pista (p. ej. al abrir el menú de idioma): produce desde i sin esperar a que lo pidan.
  prewarm(i) {
    if (i < 0 || i >= this.segs.length) return;
    this.touched = Date.now(); this.sess.touched = this.touched; this.last = i;
    const r = this.run, hi = this.highest();
    const covered = this.complete(i) || (r && !r.exited && i >= r.from && i <= Math.max(hi, r.from) + JUMP && (i >= hi || exists(this.file(i))));
    if (covered) { this.resume(); return; }
    if (!this.starting) this.starting = this.startAt(i).finally(() => { this.starting = null; });
  }

  pause() { const r = this.run; if (r && !r.exited && !this.paused) { try { r.proc.kill('SIGSTOP'); this.paused = true; } catch {} } }
  resume() { const r = this.run; if (r && !r.exited && this.paused) { try { r.proc.kill('SIGCONT'); } catch {} this.paused = false; } }

  // Cada ~0,5 s: limita lo que se produce por delante, detiene lo que nadie usa y borra lo que quedó atrás.
  tick(now) {
    const r = this.run;
    if (r && !r.exited) {
      const hi = this.highest();
      if (!this.paused && hi - this.last >= LOOKAHEAD) this.pause();
      else if (this.paused && hi - this.last < LOOKAHEAD - 2) this.resume();
      if (now - this.touched > IDLE_MS) { this.resume(); this.killRun(); }
    }
    try {
      const hi = this.highest(), inProgress = r && !r.exited ? hi : -1;
      for (const f of fs.readdirSync(this.dir)) {
        const m = /^(\d+)\.ts$/.exec(f); if (!m) continue;
        const n = +m[1];
        if ((n < this.last - BEHIND || n > this.last + LOOKAHEAD + 4) && n !== inProgress) { fs.unlinkSync(path.join(this.dir, f)); this.done.delete(n); }
      }
    } catch {}
  }

  stop() { this.resume(); return this.killRun(); }
}

/* ---------- Gestor ---------- */
function createHls({ cacheDir, hasFfmpeg, nice, log }) {
  const root = path.join(cacheDir, 'hls');
  const sessions = new Map();      // sid -> sesión lista
  const analyzing = new Map();     // sid -> Promise (análisis en curso)
  const failed = new Map();        // sid -> mensaje de error

  const sidOf = (abs, st) => crypto.createHash('sha1').update([abs, st.size, Math.round(st.mtimeMs), PLAN_VERSION].join('|')).digest('hex').slice(0, 16);

  function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }

  // Al iniciar: borra segmentos que hubieran quedado de una ejecución anterior.
  function purgeStale() {
    try {
      for (const sid of fs.readdirSync(root)) for (const e of fs.readdirSync(path.join(root, sid))) if (e !== 'plan.json') rmrf(path.join(root, sid, e));
    } catch {}
  }

  function makeSession(sid, abs, st, info, plan) {
    const dir = path.join(root, sid);
    const sess = { sid, abs, size: st.size, mtimeMs: Math.round(st.mtimeMs), info, plan, dir, name: path.basename(abs), streams: {}, touched: Date.now() };
    return sess;
  }

  function loadFromDisk(sid) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(root, sid, 'plan.json'), 'utf8'));
      if (j.plan.version !== PLAN_VERSION) return null;
      const st = fs.statSync(j.abs);
      if (st.size !== j.size || Math.round(st.mtimeMs) !== j.mtimeMs) return null;
      return makeSession(sid, j.abs, st, j.info, j.plan);
    } catch { return null; }
  }

  async function analyze(sid, abs, st) {
    const info = await probe(abs);
    if (!info || !info.video) throw new Error('no se pudo analizar el video');
    info.mediaEnd = await tailEnd(abs, info.video.index, info.formatStart + info.duration - 30, info.video.fps);
    let kf = null;
    if (copyable(info.video)) {
      const t0 = Date.now();
      kf = await scanKeyframes(abs, info.video.index, nice());
      log(`HLS: ${path.basename(abs)}: ${kf.length} fotogramas clave analizados en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    }
    const plan = buildPlan(info, kf);
    const sess = makeSession(sid, abs, st, info, plan);
    fs.mkdirSync(sess.dir, { recursive: true });
    fs.writeFileSync(path.join(sess.dir, 'plan.json'), JSON.stringify({ abs, size: sess.size, mtimeMs: sess.mtimeMs, info, plan }));
    log(`HLS: ${path.basename(abs)}: video ${plan.mode === 'copy' ? 'en copia directa (sin recodificar)' : 'recodificado a H.264'}, ` +
      `${plan.tracks.length} pista(s) de audio${plan.tracks.length ? ' [' + plan.tracks.map(t => t.name).join(', ') + ']' : ''}, ${plan.vSegs.length} segmentos`);
    return sess;
  }

  // Estado de preparación: 'ready' con la sesión, 'working' mientras se analiza, 'error' si no es posible HLS.
  function prepare(abs, st) {
    if (!hasFfmpeg()) return { state: 'error', error: 'sin ffmpeg' };
    const sid = sidOf(abs, st);
    if (sessions.has(sid)) return { state: 'ready', sid };
    const disk = loadFromDisk(sid);
    if (disk) { sessions.set(sid, disk); return { state: 'ready', sid }; }
    if (failed.has(sid)) return { state: 'error', error: failed.get(sid) };
    if (!analyzing.has(sid)) {
      analyzing.set(sid, analyze(sid, abs, st)
        .then(sess => { sessions.set(sid, sess); })
        .catch(e => { failed.set(sid, e.message); log(`HLS: no se pudo preparar ${path.basename(abs)}: ${e.message}`); })
        .finally(() => analyzing.delete(sid)));
    }
    return { state: 'working' };
  }

  function session(sid) {
    if (sessions.has(sid)) return sessions.get(sid);
    const s = loadFromDisk(sid);
    if (s) sessions.set(sid, s);
    return s;
  }

  const stream = (sess, key) => sess.streams[key] || (sess.streams[key] = new Stream(sess, key, { log }));

  async function handle(req, res, p) {
    const m = /^\/hls\/([0-9a-f]{16})\/(.+)$/.exec(p);
    if (!m) return false;
    const sess = session(m[1]);
    const send = (code, type, body, extra = {}) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra }); res.end(body); return true; };
    if (!sess) return send(404, 'text/plain', 'Sesión HLS no encontrada');
    sess.touched = Date.now();
    const rest = m[2], MPL = 'application/vnd.apple.mpegurl';

    if (rest === 'master.m3u8') return send(200, MPL, masterPlaylist(sess));
    let w = /^warm\/(a\d+)\/(\d+)$/.exec(rest);
    if (w) { if (+w[1].slice(1) < sess.plan.tracks.length) stream(sess, w[1]).prewarm(+w[2]); return send(204, 'text/plain', ''); }
    if (rest === 'v.m3u8') return send(200, MPL, mediaPlaylist(sess.plan.vSegs, 'v'));
    let k = /^a(\d+)\.m3u8$/.exec(rest);
    if (k) return +k[1] < sess.plan.tracks.length ? send(200, MPL, mediaPlaylist(sess.plan.aSegs, 'a' + k[1])) : send(404, 'text/plain', 'Pista de audio inexistente');

    k = /^(v|a\d+)\/(\d+)\.ts$/.exec(rest);
    if (!k) return send(404, 'text/plain', 'No encontrado');
    if (k[1] !== 'v' && +k[1].slice(1) >= sess.plan.tracks.length) return send(404, 'text/plain', 'Pista de audio inexistente');
    let gone = false;
    const t0 = Date.now(), dbg = !!process.env.CINE_DEBUG_HLS;
    res.on('close', () => { gone = true; if (dbg) log(`[dbg] ${k[1]}/${k[2]} ${gone && !res.writableEnded ? 'CANCELADO' : 'ok'} ${Date.now() - t0}ms`); });   // el reproductor canceló (p. ej. al saltar)
    try {
      const file = await stream(sess, k[1]).get(+k[2], () => gone);
      if (gone) return true;
      const st = fs.statSync(file);
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
      const rs = fs.createReadStream(file);
      rs.on('error', () => res.destroy());
      res.on('close', () => rs.destroy());
      rs.pipe(res);
    } catch (e) {
      if (!gone) { if (e.status !== 499) log(`HLS: ${sess.name} ${k[1]}/${k[2]}: ${e.message}`); send(e.status || 500, 'text/plain', e.message); }
    }
    return true;
  }

  // Segundo plano: analiza la biblioteca (una película a la vez) para que el primer play sea inmediato.
  let warming = false;
  async function warm(items) {
    if (warming || !hasFfmpeg()) return;
    warming = true;
    try {
      for (const { abs, st } of items) {
        const r = prepare(abs, st);
        if (r.state === 'working') { while (analyzing.size) await sleep(300); }
      }
    } finally { warming = false; }
  }

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [sid, s] of sessions) {
      for (const st of Object.values(s.streams)) st.tick(now);
      if (now - s.touched > SESSION_IDLE_MS) {
        Promise.all(Object.values(s.streams).map(x => x.stop())).then(() => { for (const e of fs.existsSync(s.dir) ? fs.readdirSync(s.dir) : []) if (e !== 'plan.json') rmrf(path.join(s.dir, e)); });
        s.streams = {};
        sessions.delete(sid);
      }
    }
  }, 500);
  timer.unref();

  async function shutdown() {
    clearInterval(timer);
    await Promise.all([...sessions.values()].flatMap(s => Object.values(s.streams).map(x => x.stop())));
  }

  fs.mkdirSync(root, { recursive: true });
  purgeStale();

  return { prepare, handle, warm, shutdown, purgeStale, _internals: { sessions, probe, buildPlan, masterPlaylist, mediaPlaylist, describeAudio } };
}

module.exports = createHls;
module.exports.describeAudio = describeAudio;
