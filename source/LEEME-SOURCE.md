# ANIME STUDIO — Código fuente completo

## v20 — AI Video Lab, extensiones/scripts de After Effects, Influx

- **AI Video Lab** (botón *Video Lab* arriba, Layer > AI Video Lab, pestaña Enhance): estilo
  Topaz Video + Flowframes para clips completos → archivo nuevo que reemplaza el clip.
  Mejora (denoise, deblock, upscale 1.5×/2×/4×, líneas, detalle) + interpolación a 48–480 fps
  (2×/4×/8×, cámara lenta, detección de cortes). Motores: *Flow* (flujo óptico GPU, cualquier
  equipo) y *MCI* (ffmpeg con compensación de movimiento, app de escritorio).
  `src/lib/engine/videolab.ts`, `src/components/editor/VideoLab.tsx`.
- **Arreglo**: los cuadros intermedios de la interpolación salían negros (filtro de textura
  inválido) — afectaba también al slow-motion existente.
- **Extensiones y scripts de After Effects**: instala `.zxp`/`.zip` (paneles CEP, ej. NeuCurve)
  y `.jsx` (ScriptUI). Se acoplan como pestañas (Window > Extensions) o flotan. Capa de
  scripting de AE emulada (`src/lib/extensions/`): app.project, capas, Transform, efectos,
  keyframes, KeyframeEase → curvas bezier reales, expresiones, ScriptUI. File > Scripts.
- **Influx**: File > Import with Influx / botón INFLUX — cualquier formato (AVI, WMV, MXF, MTS,
  VOB, ProRes, GIF…) vía ffmpeg, conservando la transparencia (WebM VP9 alpha). Sufijo
  `.influx` como en el plug-in.
- **Pestañas del panel derecho**: se desplazan con la rueda del mouse, flechas ‹ › y menú ».

## v19 — Preview sin parpadeo, audio fluido, Enhance arreglado, instalador de PC

- **Parpadeo negro del preview**: la caché RAM pausaba los videos en cada cuadro cacheado y el
  siguiente cuadro "en vivo" tenía que volver a buscar (seek) → cuadro negro. Ahora los videos
  siguen corriendo y, si un video se está re-cargando, se muestra su último cuadro (nunca negro).
- **Audio trabado**: el motor hacía seek a los videos cada vez que el reloj se desviaba 80 ms
  (cortaba el audio). Ahora corrige la desviación ajustando la velocidad ±6 % (inaudible) y solo
  hace seek en saltos reales. Los videos no enrutados al mezclador quedan mudos (antes sonaban doble).
- **Enhance**: el shader no compilaba (`flat` es palabra reservada en GLSL). Arreglado, y nuevo
  botón **"Apply enhance to clip (live)"** → efecto *Detail Restore* en vivo (preview + export).
- **Escritorio**: registro en `%APPDATA%\AnimeStudio\logs\main.log`, mensajes de error en vez de
  cerrarse en silencio, modo GPU seguro automático (`--safe-gpu`), una sola instancia, sin service
  worker (servía archivos viejos tras actualizar). El CI instala el Setup.exe y verifica que la app
  instalada y la portable abran antes de publicar.

Paquete con TODO el código del proyecto. Esta versión incluye:

- **FIX DE EXPORT** (el arreglo de los errores al exportar video):
  - *Frames trabados / colgados*: ahora cada seek de video se confirma por
    sondeo real del estado (iOS Safari a veces pierde el evento `seeked`,
    lo que congelaba frames ~350 ms) y todos los videos se precalientan
    ANTES del bucle de frames (antes los primeros frames salían negros o
    viejos porque el elemento se creaba perezosamente).
  - *Parpadeos y shakes de 1 fotograma*: el compositor de export usa un
    contexto WebGL con `preserveDrawingBuffer` (Safari leía un buffer ya
    limpiado al capturar el frame → parpadeo de 1 frame). Solo se activa
    en el canvas de export, el preview sigue igual.
  - *Export congelado*: el render de export es por temporizador
    (`setTimeout`), no por `requestAnimationFrame` (rAF se detiene si la
    pestaña pasa a segundo plano o se bloquea el iPhone; la grabación
    quedaba colgada en un frame congelado para siempre).
  - *Fallos honestos*: si el encoder de video falla o su cola se atasca,
    el export avisa con error claro y pasa al modo captura en tiempo
    real — nada de videos corruptos en silencio.
- **Arreglo del timeline**: los clips ya no se dibujan ~2s a la derecha
  de su posición real (caen clavados en 00:00).
- **Shell móvil + efectos nuevos**: workspace estilo CapCut bajo 1024px
  (MobileWorkspace/MobileQuick), efectos Mirror, Tile/Split Screen, Beat
  Zoom, Chroma Key y Tilt-Shift con uniforms cableados, pack "Looks &
  Flash". Service worker en `as-v8`.

## Qué hay dentro

| Carpeta / archivo | Qué es |
|---|---|
| `src/app/` | Páginas Next.js + rutas API (`api/ai`, `api/media`, etc.) |
| `src/components/editor/` | El editor: Timeline, PreviewMonitor, Inspector, GraphEditor, AudioPanel, SpeedPanel, EnhancePanel, TrackerPanel, ExportDialog, AIAssistant, SettingsPanel… |
| `src/components/ui/` | Componentes de interfaz (shadcn/ui) |
| `src/lib/engine/` | Motor: compositor WebGL, keyframes, efectos, audio, export, tracker, speed/rampas, enhance |
| `src/lib/store/` | Estado global (Zustand) |
| `src/lib/media/` | Medios en IndexedDB, autoguardado, guardado/apertura de proyecto, modo estático, mediaManager (seek por sondeo) |
| `src/lib/ai/` | Cliente IA (no tocar si no hace falta) |
| `public/` | Iconos PWA, manifest, `sw.js` (service worker, `CACHE_VERSION = as-v8`) |
| `prisma/` | Esquema de base de datos (modo servidor) |
| `scripts/` | `build-static.sh` (build estático, crea `.nojekyll` solo), `gen-icons.mjs`, `separate-vocals.py`, tests |
| `.github/workflows/` | `deploy-pages.yml` (publica en GitHub Pages) y `build-ipa.yml` (genera el .ipa sin firmar) |
| `cloudflare-worker/` | `zai-proxy.js` — proxy para las llamadas IA en Cloudflare |
| `package.json`, `bun.lock` | Dependencias exactas |
| `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`, `components.json`, `eslint.config.mjs` | Configuración del proyecto |
| `capacitor.config.json` | Configuración del envoltorio iOS (PWA → .ipa) |

## NO viene dentro (y por qué)

- `node_modules/` — se regenera al instalar. Pesa cientos de MB.
- `db/` — base de datos y medios de prueba locales; se crea sola con `db:push`.
- `.env` — nunca va en zips ni repos: ahí viven claves secretas. Si corres el
  modo servidor con IA, crea tu propio `.env` con tus claves (no las compartas
  en chats ni las subas a GitHub).
- `dist-static/` — es el resultado del build, no código fuente.

## Cómo correrlo en tu compu

1. Instala Node 20+ y (opcional, recomendado) Bun.
2. En la carpeta descomprimida:

```bash
bun install          # o: npm install
bun run db:generate  # o: npm run db:generate   (solo modo servidor)
bun run db:push      # o: npm run db:push
bun run dev          # o: npm run dev  → http://localhost:3000
```

3. El build estático (para GitHub Pages / Netlify / Cloudflare):

```bash
# Para GitHub Pages (subruta /anime-studio/):
NEXT_PUBLIC_BASE_PATH=/anime-studio bash scripts/build-static.sh
# → genera dist-static/

# Para hosting en la raíz (Netlify Drop, Cloudflare Pages):
bash scripts/build-static.sh
```

4. IMPORTANTE al hacer cambios: sube `CACHE_VERSION` dentro de `public/sw.js`
   antes de cada build, para que la PWA del iPhone refresque (abrir 2 veces).

## Deploy a GitHub Pages

1. Sube el contenido de este paquete a tu repo (rama `main`).
2. El workflow `deploy-pages.yml` publica automáticamente en cada push:
   usa `site-pages.zip` (build con base path `/anime-studio`).
3. Para el .ipa: Actions → "Build unsigned iOS .ipa" → Run workflow
   (necesita `site.zip` en el repo).
