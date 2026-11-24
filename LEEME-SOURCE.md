# ANIME STUDIO — Código fuente completo

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
- **Mejoras de motor v4** (integradas de tu versión fixed):
  - *Seek exacto frame-a-frame en export*: el seek de export ya no acepta
    "cerca" (50 ms eran 1-3 frames → usaba un frame viejo y luego saltaba:
    micro-shake). Ahora espera el frame exacto con tope de 2.5 s.
  - *Preview suspendido durante el export*: el preview y el export comparten
    los mismos elementos de video; si el preview seguía buscándolos, los
    frames de export salían con el tiempo de source equivocado.
  - *Audio que ya no muere*: el source de WebAudio se crea UNA sola vez por
    elemento (crear dos veces lanza InvalidStateError y el clip quedaba
    mudo para siempre).
  - *UI más fluida*: re-render de React limitado (Timeline 66 ms, Inspector
    120 ms, timecode 100 ms) y el render en reposo no quema la GPU cuando
    nada cambió.
  - *Memoria*: texturas de clips lejanos al cabezal se liberan cada ~2 s;
    en export se liberan clips ya pasados; la textura de copia se
    reutiliza (copyTexSubImage2D) en vez de re-crearla por frame.
- **Shell móvil + efectos nuevos**: workspace estilo CapCut bajo 1024px
  (MobileWorkspace/MobileQuick), efectos Mirror, Tile/Split Screen, Beat
  Zoom, Chroma Key y Tilt-Shift con uniforms cableados, pack "Looks &
  Flash". Service worker en `as-v13`.

## Qué hay dentro

| Carpeta / archivo | Qué es |
|---|---|
| `src/app/` | Páginas Next.js + rutas API (`api/ai`, `api/media`, etc.) |
| `src/components/editor/` | El editor: Timeline, PreviewMonitor, Inspector, GraphEditor, AudioPanel, SpeedPanel, EnhancePanel, TrackerPanel, ExportDialog, AIAssistant, SettingsPanel… |
| `src/components/ui/` | Componentes de interfaz (shadcn/ui) |
| `src/lib/engine/` | Motor: compositor WebGL, keyframes, efectos, audio, export, tracker, speed/rampas, enhance |
| `src/lib/store/` | Estado global (Zustand) |
| `src/lib/media/` | Medios en IndexedDB, autoguardado, guardado/apertura de proyecto, modo estático, mediaManager (seek por sondeo + seekExact para export) |
| `src/lib/ai/` | Cliente IA (no tocar si no hace falta) |
| `public/` | Manifest, logo, `sw.js` (service worker, `CACHE_VERSION = as-v13`). Los PNG de iconos se generan con `node scripts/gen-icons.mjs` (no van en el repo) |
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

1. El repo lleva TODO el código fuente; el workflow `deploy-pages.yml` instala
   dependencias con Bun, genera los iconos y construye con base path
   `/anime-studio` en cada push a `main` (un solo artifact `github-pages`).
2. Para el .ipa: Actions → "Build unsigned iOS .ipa" → Run workflow
   (construye desde el código fuente, ya no necesita site.zip).
