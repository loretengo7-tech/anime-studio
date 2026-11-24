# LEEME-BACKEND — Backend de herramientas de ANIME STUDIO

Servidor Node **sin dependencias npm** (solo módulos nativos) que ejecuta el
procesamiento pesado: FFmpeg, Whisper, yt-dlp, Earshot y (pronto) Blender.
El editor (GitHub Pages / Vercel) le manda trabajos, muestra el progreso real
e importa los resultados al proyecto.

## Correrlo donde sea

### A) Tu compu (2 minutos)

```bash
cd backend
node server.js                          # http://localhost:8787
# con token de seguridad:
BACKEND_TOKEN=mi-secreto node server.js
```

Necesita instalado: [ffmpeg](https://ffmpeg.org) (`apt install ffmpeg` / `brew install ffmpeg`).
Opcional: `pip install faster-whisper earshot yt-dlp`.

### B) Render.com (gratis, se duerme sin uso)

1. GitHub → subir la carpeta `backend/` a un repo (o al mismo repo, subcarpeta).
2. Render → New → Web Service → conectar el repo.
3. Runtime: **Docker** (usa el `Dockerfile` incluido, ya instala todo) o
   Node: Build `npm install` (no instala nada, es cero deps) · Start `node server.js`.
4. Variables de entorno: `BACKEND_TOKEN` (un secreto largo), `ALLOWED_ORIGIN`
   (la URL de tu página, ej `https://loretengo7-tech.github.io`).
5. Copiar la URL (`https://xxx.onrender.com`) → pegarla en el panel **Studio** del editor.

Plan gratis: 512 MB RAM y el servicio se apaga tras 15 min sin tráfico (el primer
trabajo después de dormir tarda ~50 s en despertar). FFmpeg CPU funciona bien;
Whisper modelo `tiny`/`base` corre en CPU (lento pero real).

### C) Railway (crédito de prueba) / Fly.io / VPS

Mismo Dockerfile. En Railway existe además plantilla de faster-whisper si querés
un servidor de transcripción dedicado.

## Variables de entorno

| Variable | Default | Qué hace |
|---|---|---|
| `PORT` | 8787 | Puerto HTTP |
| `BACKEND_TOKEN` | (sin token) | Si se define, exige `Authorization: Bearer <token>` en todo excepto `/api/health` y `/api/capabilities` |
| `ALLOWED_ORIGIN` | `*` | CORS: dominio del frontend (separado por comas si son varios) |
| `MAX_UPLOAD_MB` | 200 | Límite de archivo de entrada |
| `CONCURRENCY` | 2 | Trabajos en paralelo |
| `JOB_TTL_MIN` | 120 | Minutos antes de borrar trabajos y resultados |

## API

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/health` | ¿Está vivo? (sin auth) |
| GET | `/api/capabilities` | Qué herramientas hay REALMENTE instaladas |
| POST | `/api/jobs` | Crear trabajo: `{ type, ..., input: { name, dataB64 } }` o `{ type: 'media.importUrl', url }` |
| GET | `/api/jobs/:id` | Estado: `{ state, progress, message, files, result, error }` |
| GET | `/api/jobs/:id/files/:i` | Descargar resultado i |
| DELETE | `/api/jobs/:id` | Cancelar (mata el proceso real) |

Tipos de trabajo implementados: `media.convert`, `media.compress`,
`media.extractAudio`, `media.probe`, `media.loudness` (EBU R128),
`media.transcribe` (faster-whisper), `media.vad` (Earshot),
`media.importUrl` (yt-dlp: `mode: 'info' | 'download'`).

## Seguridad

- El token viaja solo en el header `Authorization` y se guarda **solo en tu
  dispositivo** (localStorage del editor) — nunca en el repo ni en el bundle.
- Límite estricto de tamaño; nombres de archivo sanitizados; los trabajos se
  aíslan por ID aleatorio y expiran solos.
- yt-dlp: solo contenido autorizado; no salta DRM ni accesos privados.
