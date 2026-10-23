'use strict';
/*
  Optimizador de carátulas.

  Detecta imágenes en cualquier formato (JPG, PNG, BMP, GIF, TIFF, AVIF, HEIC…),
  las convierte a .webp comprimido (máx. 600 px de ancho) y, una vez comprobado que
  el .webp es válido, ELIMINA el archivo original.

  Uso como comando (lee las carpetas de "caratulas" de config.json):
      node optimizar-caratulas.js
      node optimizar-caratulas.js /otra/carpeta
      node optimizar-caratulas.js --mantener-originales

  El servidor también lo ejecuta solo (config.json -> "optimizarCaratulas").
  Convierte con ffmpeg; si no está, prueba con cwebp o ImageMagick.
*/
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const RASTER = /\.(jpe?g|jfif|png|bmp|gif|tiff?|avif|heic|heif)$/i;   // .webp ya está optimizado
const MAX_WIDTH = 600;     // las carátulas 2:3 se ven bien a 600×900
const QUALITY = 80;

const run = (cmd, args) => new Promise(resolve =>
  execFile(cmd, args, { timeout: 90000 }, (err, _out, stderr) => resolve({ ok: !err, missing: err && err.code === 'ENOENT', error: (stderr || (err && err.message) || '').trim() })));

function isWebp(file) {
  try {
    const fd = fs.openSync(file, 'r'), b = Buffer.alloc(12);
    fs.readSync(fd, b, 0, 12, 0); fs.closeSync(fd);
    return b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
  } catch { return false; }
}

// Intenta con ffmpeg, luego cwebp y por último ImageMagick.
async function convertToWebp(src, tmp) {
  const attempts = [
    ['ffmpeg', ['-y', '-v', 'error', '-i', src, '-frames:v', '1',
      '-vf', `scale='min(${MAX_WIDTH},iw)':-2:flags=lanczos`,
      '-c:v', 'libwebp', '-quality', String(QUALITY), '-compression_level', '6', '-f', 'webp', tmp]],
    ['cwebp', ['-quiet', '-q', String(QUALITY), '-m', '6', src, '-o', tmp]],
    ['convert', [`${src}[0]`, '-resize', `${MAX_WIDTH}x>`, '-quality', String(QUALITY), `webp:${tmp}`]],
    ['magick', [`${src}[0]`, '-resize', `${MAX_WIDTH}x>`, '-quality', String(QUALITY), `webp:${tmp}`]]
  ];
  let last = null;
  for (const [cmd, args] of attempts) {
    const r = await run(cmd, args);
    if (r.ok && fs.existsSync(tmp) && fs.statSync(tmp).size > 0 && isWebp(tmp)) return null;
    if (!last && !r.missing && r.error) last = r.error.split('\n').pop().replace(/^\[[^\]]*\]\s*/, '');
    fs.rmSync(tmp, { force: true });
  }
  return last || 'No hay ffmpeg, cwebp ni ImageMagick instalados';
}

function* walk(dir) {
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of list) {
    if (d.name.startsWith('.')) continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) yield* walk(full);
    else if (RASTER.test(d.name)) yield full;
  }
}

let running = null;

/**
 * Optimiza todas las imágenes pendientes de las carpetas dadas.
 * @returns {{convertidas: object[], errores: object[]}}
 */
function optimizar(dirs, { mantener = false } = {}) {
  if (running) return running;                       // evita ejecuciones simultáneas
  running = (async () => {
    const convertidas = [], errores = [];
    for (const dir of dirs) {
      for (const src of walk(dir)) {
        const dst = src.replace(RASTER, '') + '.webp';
        const tmp = path.join(path.dirname(dst), `.${path.basename(dst)}.${process.pid}.tmp`);
        const antes = fs.statSync(src).size;
        const err = await convertToWebp(src, tmp);
        if (err) { errores.push({ archivo: src, error: err }); continue; }
        try {
          fs.renameSync(tmp, dst);                    // reemplaza un .webp previo del mismo nombre
          const despues = fs.statSync(dst).size;
          if (!mantener) fs.unlinkSync(src);          // solo se borra el original tras verificar el .webp
          convertidas.push({ origen: src, destino: dst, antes, despues });
        } catch (e) {
          fs.rmSync(tmp, { force: true });
          errores.push({ archivo: src, error: e.message });
        }
      }
    }
    return { convertidas, errores };
  })().finally(() => { running = null; });
  return running;
}

module.exports = { optimizar, RASTER };

/* ---------- Uso desde la terminal ---------- */
if (require.main === module) {
  const args = process.argv.slice(2);
  const mantener = args.includes('--mantener-originales');
  let dirs = args.filter(a => !a.startsWith('--')).map(a => path.resolve(a));

  if (!dirs.length) {
    let list = ['./caratulas'];
    try {
      const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).caratulas;
      if (c) list = [].concat(c);
    } catch {}
    dirs = list.map(p => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : path.resolve(__dirname, p)));
  }

  const kb = n => (n / 1024).toFixed(0) + ' KB';
  console.log('Buscando carátulas en:\n  ' + dirs.join('\n  ') + '\n');
  optimizar(dirs, { mantener }).then(({ convertidas, errores }) => {
    convertidas.forEach(c => console.log(`✔ ${path.basename(c.origen)} → ${path.basename(c.destino)}  (${kb(c.antes)} → ${kb(c.despues)})`));
    errores.forEach(e => console.log(`✖ ${path.basename(e.archivo)}: ${e.error}`));
    if (!convertidas.length && !errores.length) console.log('No hay imágenes pendientes: todas las carátulas ya son .webp.');
    else {
      const a = convertidas.reduce((s, c) => s + c.antes, 0), d = convertidas.reduce((s, c) => s + c.despues, 0);
      console.log(`\n${convertidas.length} convertida(s), ${errores.length} con error.` + (a ? ` Ahorro: ${kb(a - d)}.` : '') + (mantener ? ' (originales conservados)' : ''));
    }
    process.exit(errores.length ? 1 : 0);
  });
}
