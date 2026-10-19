# 🎬 Cine local

Tu propio servicio de streaming para películas y series que ya tienes en tu equipo. Lee tus carpetas, muestra las carátulas en formato vertical y reproduce los videos desde el navegador, en tu computadora o en cualquier dispositivo de tu red local (celular, tablet, TV).

Sin dependencias, sin base de datos externa, sin internet: solo **Node.js**.

<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/368b7788-53e5-48e0-8f86-47633a6a8c3f" />

## Requisitos

| Requisito | Detalle |
|---|---|
| Sistema | Probado en Linux y Windows 11 |
| [Node.js](https://nodejs.org) | Versión 14 o superior |
| [ffmpeg](https://ffmpeg.org) | **Opcional.** Solo para arreglar el audio de videos incompatibles |
| Navegador | Chrome, Chromium, Brave, Edge o Firefox recientes |

En Debian/Ubuntu:

```bash
sudo apt install nodejs ffmpeg
```
## Instalación y uso

```bash
git clone https://github.com/Josue-Silva-T/cine-local.git
cd cine-local
./iniciar.sh
```

También puedes ejecutar `node server.js`. Se abre el navegador en `http://localhost:3000`.

### Opciones

| Comando | Qué hace |
|---|---|
| `node server.js` | Accesible solo desde el mismo equipo |
| `node server.js --lan` | Accesible desde otros dispositivos de tu red |
| `PORT=3001 node server.js` | Usa otro puerto sin tocar `config.json` |

### Verlo desde otros dispositivos

1. Inicia con `--lan`. La consola muestra una línea como `En tu red: http://192.168.1.50:3000`.
2. Abre esa dirección (con `http://`) en el celular o la TV.
3. Si tienes firewall, abre el puerto:
   ```bash
   sudo ufw allow 3000/tcp
   ```

## Cómo organizar tus archivos

Por defecto, el programa busca en tres carpetas junto a `server.js`:

```
cine-local/
├─ peliculas/
│  ├─ CDO_Cielo de Octubre.mkv
│  └─ LJJ_La joven jane austen.mp4
├─ series/
│  └─ GOT_Game of Thrones/
│     ├─ T1C1_inicio.mkv
│     ├─ T1C4_lucha.mkv
│     └─ T2C1_nueva era.mkv
└─ caratulas/
   ├─ GOT.jpg
   └─ LJJ.jpg
   └─ CDO.webp
```

### Reglas de nombres

| Qué | Formato | Ejemplo | Resultado |
|---|---|---|---|
| Película | `ABREV_Nombre completo.ext` | `CDO_Cielo de Octubre.mkv` | Título «Cielo de Octubre», carátula `CDO.jpg` |
| Serie | carpeta `ABREV_Nombre de la serie` | `GOT_Game of Thrones/` | Una sola tarjeta con todas sus temporadas |
| Capítulo | `T{temporada}C{capítulo}_nombre.ext` | `T1C4_lucha.mkv` | Temporada 1, capítulo 4, «lucha» |
| Carátula | `ABREV.jpg` (o `.png`, `.webp`) | `GOT.jpg` | Se asigna por la abreviatura |

Detalles:

- La abreviatura es lo que va antes del primer `_` (hasta 10 caracteres, sin espacios). Si no hay abreviatura, la carátula se busca por el nombre completo.
- Las carátulas deben ser **verticales 2:3** (por ejemplo 600×900). Si falta, se muestra un marcador con la abreviatura.
- Los capítulos se ordenan por número (`C2` antes que `C10`). Puedes ponerlos en subcarpetas por temporada si lo prefieres, porque la temporada sale del nombre del archivo.
- Si un capítulo no sigue el formato `T#C#`, se toma la temporada de su subcarpeta (por ejemplo `Temporada 2`) y el capítulo del primer número del nombre.
- Después de agregar archivos, pulsa **Actualizar** en la página. No hace falta reiniciar.

### Formatos de video

MP4 (H.264), WebM, MOV y M4V se reproducen directamente. MKV y AVI dependen del códec.

## Configuración (`config.json`)

```json
{
  "puerto": 3000,
  "claveAdmin": "admin",
  "peliculas": ["./peliculas"],
  "series": ["./series"],
  "caratulas": ["./caratulas"]
}
```

| Campo | Descripción |
|---|---|
| `puerto` | Puerto del servidor (requiere reiniciar). |
| `claveAdmin` | Contraseña para **eliminar perfiles**. **Cámbiala.** Si la dejas vacía (`""`), no se podrán eliminar perfiles. |
| `peliculas`, `series`, `caratulas` | Lista de carpetas donde buscar. Pueden ser varias, en distintos discos. |

Las rutas pueden ser relativas a la carpeta del programa (`./peliculas`), absolutas (`/mnt/disco2/videos`) o empezar con `~` (`~/Videos`). Los cambios en las rutas se aplican al pulsar **Actualizar**.

Ejemplo con varios discos:

```json
{
  "peliculas": ["./peliculas", "/mnt/disco_d/peliculas", "/media/usuario/externo/cine"],
  "series": ["./series", "/mnt/disco_d/series"],
  "caratulas": ["./caratulas"]
}
```

## Perfiles, historial y reseñas

- Al abrir la página eliges tu perfil o creas uno (nombre de usuario y foto opcional).
<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/a48f4da9-4671-4c0b-b829-01b47895d76f" />
- **Administrar perfiles** permite editar el nombre y la foto. Para **eliminar** un perfil se pide la contraseña `claveAdmin`; al borrarlo se eliminan también su foto, historial, calificaciones y reseñas.
<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/8054b38b-2b3f-4455-96f5-e2019839eca7" />
- En la ficha de cada película o serie, junto al póster, aparecen las reseñas de todos los usuarios:
<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/a87c92f8-b0c6-49c1-a0be-1b7d23ea0346" />
- **Mi historial** lista lo que ese perfil ha visto o calificado.
<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/0dfdd514-7284-4ea1-a069-cdde085f179b" />
- Los perfiles **no tienen contraseña**: cualquiera en tu red puede entrar a cualquiera.

### Dónde se guardan los datos

En la carpeta `data/` (se crea sola):

```
data/
├─ db.json        perfiles, historial y reseñas
└─ avatars/       fotos de perfil
```

**Respalda `data/`** de vez en cuando. Si `db.json` se daña, el servidor guarda una copia (`db.json.corrupto-…`) y empieza de cero.

## Teclado

Todo el sistema se puede usar sin ratón.

| Dónde | Tecla | Acción |
|---|---|---|
| Navegación | `←` `→` `↑` `↓` | Mover el foco |
| | `Enter` | Abrir / confirmar |
| | `Esc` o `Retroceso` | Volver |
| | `F` | Pantalla completa |
| Reproductor | `←` `→` | Retroceder / adelantar 10 s |
| | `↑` `↓` | Volumen |
| | `Espacio` | Pausa / reproducir |
| | `M` | Silenciar |
| | `N` / `P` | Siguiente / anterior |
| | `F` | Pantalla completa del video |
| | `Esc` | Cerrar |
| Calificar | `1` a `5` | Elegir estrellas |
| | `Ctrl` + `Enter` | Guardar |




