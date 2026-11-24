# ANIME STUDIO

Editor de video y animación enfocado en anime, con experiencia estilo After Effects,
que funciona en el navegador y en el iPhone (PWA instalable). Edición multipista,
compositor WebGL, keyframes, efectos, audio, tracking, export real por WebCodecs.

- **Frontend**: Next.js 16 + TypeScript + Zustand + Tailwind v4, export estático.
  Funciona en GitHub Pages (PWA offline con IndexedDB) y en Vercel/Netlify/Cloudflare.
- **Backend de herramientas** (opcional): `backend/` — Node puro, cero dependencias npm,
  cola de trabajos con progreso real, para procesamiento pesado (FFmpeg, Whisper,
  yt-dlp, Earshot, Blender) cuando tu dispositivo no puede o no debe hacerlo.

## Estado de las integraciones (honesto, sin humo)

| Herramienta | Estado | Qué hace de verdad |
|---|---|---|
| **Editor completo** | ✅ funcionando | Timeline multipista, preview WebGL, keyframes con graph editor, efectos, texto animado, audio, tracking, speed/ramping, export MP4/WebM con audio garantizado |
| **FFmpeg** (backend) | ✅ funcionando | Panel "Studio": convertir MP4/WebM/MOV, comprimir, extraer audio y **loudness EBU R128 real** (Audio Lab). Progreso real del encoder y resultados que entran al proyecto/timeline |
| **Whisper** (backend opcional) | ✅ código listo, requiere servidor con `faster-whisper` | Transcripción real → SRT/VTT + segmentos → los subtítulos se agregan como capas de texto del timeline. Si el servidor no lo tiene, falla con mensaje claro (nunca finge) |
| **yt-dlp** (backend opcional) | ✅ código listo, requiere servidor con `yt-dlp` | Info + descarga de contenido **propio o autorizado**. Respeta las restricciones de cada plataforma: si no permite descarga, el intento falla explícitamente |
| **Earshot** (backend opcional) | ✅ código listo, requiere servidor con `earshot` | VERIFICADO: Earshot (pykeio) es **detección de voz (VAD)**, no un analizador de loudness — por eso el análisis de volumen/clipping se hace con FFmpeg, que es la herramienta correcta |
| **HyperFrames** | ⏳ Etapa 4 | VERIFICADO: framework real open-source de motion graphics browser-native (HTML/CSS/JS, Apache 2.0). Plan: escenas generadas por IA → render → clip del timeline |
| **Blender 3D** | ⏳ Etapa 6 | El backend ya reporta si tiene Blender instalado. El render 3D va en servidor remoto (no corre en GitHub Pages ni en el iPhone) |

Los botones que no tienen herramienta detrás **no existen o están deshabilitados con
el motivo** — cero botones falsos, cero errores silenciosos.

## Usar la app

- **GitHub Pages**: el workflow `.github/workflows/deploy-pages.yml` construye el
  proyecto desde el código fuente en cada push a `main` (build con la subruta
  `/anime-studio/`) y lo publica con UN único artifact `github-pages` por run.
- **Vercel / Netlify / Cloudflare (raíz)**: importá el repo y desplegá el build
  estático SIN base path (`bun install` + `bash scripts/build-static.sh`), o el
  preset Next.js en Vercel.
- **iPhone**: abrir la web en Safari → Compartir → "Agregar a inicio". La PWA funciona
  offline (los medios quedan en tu dispositivo). Tras actualizar, abrirla 2 veces para
  que el service worker refresque.

## Desarrollo

```bash
bun install            # o npm install
bun run dev            # editor en http://localhost:3000

# build estático para GitHub Pages (subruta /anime-studio/):
NEXT_PUBLIC_BASE_PATH=/anime-studio bash scripts/build-static.sh
# build estático para la raíz (Vercel/Netlify/Cloudflare):
bash scripts/build-static.sh
```

Al hacer cambios: subir `CACHE_VERSION` en `public/sw.js` antes de cada build.

## Backend de herramientas (opcional, gratis)

```bash
cd backend
BACKEND_TOKEN=un-secreto node server.js    # http://localhost:8787
```

En el editor: panel **Studio** (icono servidor) → URL del servidor → Probar.
El panel muestra las capacidades REALES detectadas (ffmpeg/whisper/yt-dlp/earshot/blender).
Guía completa de despliegue gratis (Render/Railway/Docker/PC): [backend/LEEME-BACKEND.md](backend/LEEME-BACKEND.md).
Plan de integración por etapas: [docs/PLAN-INTEGRACION.md](docs/PLAN-INTEGRACION.md).

## Seguridad

- Ninguna clave API vive en el bundle ni en el repo; las del asistente IA se guardan
  solo en tu dispositivo.
- El backend valida tamaño de archivos, autentica con `BACKEND_TOKEN` y aísla los
  trabajos por ID con vencimiento automático.
- yt-dlp nunca salta DRM ni accesos privados: solo contenido autorizado.
