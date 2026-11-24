# PLAN DE INTEGRACIÓN — Herramientas profesionales y sistema de producción con IA

Este documento cumple la ETAPA 1 (auditoría) de la especificación: diagnóstico de
la arquitectura actual + plan concreto por etapas. Se actualiza a medida que se
completa cada etapa.

## 1. Diagnóstico de la arquitectura actual (Etapa 1)

### Qué es hoy

- **Frontend único y estático**: Next.js 16 (App Router) exportado a HTML/JS puro
  (`scripts/build-static.sh` → `dist-static/`). Corre en GitHub Pages (subruta
  `/anime-studio/`), Vercel, Netlify o Cloudflare como PWA instalable con
  service worker (`public/sw.js`, `CACHE_VERSION`) y todos los medios en
  IndexedDB del dispositivo (modo estático).
- **Motor propio en el navegador** (`src/lib/engine/`):
  - `compositor.ts` — composición WebGL (efectos, blend, máscaras, camera, 3D-lite).
  - `playback.ts` — bucle de render con idle-gating, suspensión durante export,
    suscripciones con throttle para la UI.
  - `exporter.ts` — export real: WebCodecs frame-a-frame con seek exacto
    (`mediaManager.seekExact`) + fallback realtime MediaRecorder; audio garantizado
    (AAC/Opus embebido o WAV sidecar).
  - `mediaManager.ts` — pool de elementos de video con seek por sondeo + seekExact.
  - `audio.ts`, `keyframes.ts`, `effects.ts`, `textRenderer.ts`, `speed.ts`,
    `tracker.ts`, `enhance.ts`, `plugins.ts`, `proceduralSources.ts`.
- **Estado**: Zustand (`src/lib/store/editorStore.ts`) con undo/redo, panel registry
  (`panelRegistry.ts`), shell móvil propio (<1024px) y desktop estilo AE con docks.
- **Proyectos**: JSON propio (`.aeproject`), autoguardado en IndexedDB, sin servidor.
- **IA (existente, no tocar)**: `AIAssistant.tsx` + `src/lib/ai/` + rutas `api/ai`
  (solo modo servidor) — capa separada del motor.

### Problemas que resuelve este plan

1. GitHub Pages no puede ejecutar Python/FFmpeg/Blender ni procesos del sistema.
2. El iPhone no debe renderizar cosas pesadas (batería, memoria).
3. Las herramientas profesionales son binarios de servidor: necesitan un backend
   con cola de trabajos, progreso y transferencia de archivos.

### Decisión de arquitectura

- **Frontend sigue siendo estático** (regla 11 de la especificación).
- **Backend independiente** (`backend/server.js`, Node puro, cero dependencias):
  API con token + CORS + límites, cola de trabajos con concurrencia, progreso real
  por sondeo, resultados en disco con TTL, detección honesta de capacidades.
  Desplegable gratis (Render/Railway/Fly) o en la PC del usuario; Dockerfile incluido.
- **Comunicación**: fetch + JSON (input en base64 con tope de tamaño; resultados por
  download). Sin WebSockets: el sondeo cada ~1.2 s es suficiente y sobrevive
  mejor en redes móviles.
- **Integración con el timeline**: TODO resultado vuelve como archivo →
  `importMediaFile()` → asset del proyecto → clip en timeline (o capas de texto
  para subtítulos). Nada queda aislado.

## 2. Estado por etapas

| Etapa | Alcance | Estado |
|---|---|---|
| 1 — Auditoría | Este documento | ✅ |
| 2 — Backend | `backend/` completo: API + auth + cola + progreso + storage + capacidades; panel **Studio** en el editor (desktop y móvil) con config de servidor | ✅ probado end-to-end (compresión FFmpeg real con progreso + loudness EBU R128 real + auth 401 + cancelación) |
| 3 — AV processing | FFmpeg ✅ (convertir/comprimir/extraer/loudness) · Whisper ✅ código (requiere `pip install faster-whisper` en el servidor) + subtítulos → capas de texto del timeline ✅ · yt-dlp ✅ código (requiere `pip install yt-dlp`) · Reference Analyzer ⏳ siguiente | 🔄 en curso |
| 4 — Motion Graphics | HyperFrames (verificado: framework browser-native HTML/CSS/JS Apache 2.0). Plan: escenas generadas → render → clip. Sin backend necesario (corre en el navegador) | ⏳ |
| 5 — Referencias | yt-dlp (código listo) + Reference Analyzer (detección de cortes por análisis de frames, informe visual, marcas en timeline) | ⏳ |
| 6 — 3D | Blender en servidor remoto; el backend ya reporta su presencia | ⏳ |
| 7 — Audio Lab | Loudness/clipping real con FFmpeg ✅ · VAD con Earshot ✅ código · normalización (loudnorm two-pass) ⏳ | 🔄 en curso |
| 8 — Integración y pruebas | Pruebas reales por etapa; el build de cada etapa se verifica con `tsc` + build estático + prueba en navegador | 🔄 permanente |

## 3. Reglas que se respetan (de la especificación)

1. Se trabaja SOBRE el código existente; nada se reescribe desde cero.
2. Las funciones que ya funcionan no se tocan (el fix de export as-v11 quedó intacto).
3. Sin datos simulados: si una herramienta no está instalada en el servidor, el
   panel lo muestra y el trabajo falla con mensaje claro.
4. Sin botones que no hagan nada.
5. Ninguna clave en el bundle ni en el repo; token del backend solo en el
   dispositivo del usuario.
6. GitHub Pages sigue siendo el frontend; el workflow `deploy-pages.yml` construye
   desde el código fuente y produce UN solo artefacto `github-pages` por run.
7. Cada etapa termina con pruebas y un build verificable.

## 4. Siguiente paso concreto (Etapa 3 → cierre)

- Reference Analyzer: análisis de cortes/ritmo con ffprobe + detección de cambios
  de escena (histogramas por frame con FFmpeg), informe + marcas en el timeline.
- Normalización de audio (loudnorm two-pass real) y balance música/voz.
- AI Studio: orquestador que usa los trabajos del backend como herramientas reales
  (sin tocar la capa IA existente).
