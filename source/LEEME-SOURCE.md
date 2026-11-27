# ANIME STUDIO — Código fuente completo

## v25 — Cuentas y IA de pago (Pro) con Supabase

- **Cuentas**: crear cuenta / iniciar sesión / recuperar contraseña (Supabase Auth) en
  Settings → Account y dentro de las funciones de IA. `src/lib/account/account.ts`,
  `src/components/editor/AccountPanel.tsx`.
- **La IA es Pro** y ya no hay menú de keys: la app llama a la función `ai` de Supabase, que
  verifica el usuario, el plan (admin / suscripción activa) y la cuota mensual, y llama a Claude
  con la key guardada como secret del servidor (`ANTHROPIC_API_KEY`). El usuario nunca la ve.
- **Base de datos** (`supabase/migrations`): `profiles` (is_admin), `subscriptions` (status,
  período), `ai_usage` (tokens por pedido). RLS: cada usuario solo lee lo suyo y no puede
  modificarse el plan (probado: 403).
- Probado de punta a punta con un usuario temporal (ya borrado): gate sin sesión, contraseña
  incorrecta, plan free → 402 del servidor, admin → pasa hasta el servidor.
- Falta: cargar `ANTHROPIC_API_KEY` en Supabase, configurar las URLs de Auth y conectar Paddle.

## v24 — IA con Claude: plantillas desde un edit + asistente

- **AI Templates** (pestaña derecha): elegís un edit de referencia → se mide en el dispositivo
  (cortes por diferencia de cuadros, flashes blancos —incluido el corte escondido detrás del
  flash—, movimiento por toma, beats y BPM) → Claude mira cuadros de cada toma (inicio/medio/fin)
  y describe cada una (rol, qué clip encaja, zoom/paneo/shake, rampa de velocidad, efectos,
  flash, texto) → se crea un proyecto plantilla con la música, un "slot" por toma con sus
  movimientos y efectos, capas de flash, look global, marcadores de corte y grilla de beats →
  "Fill slots with my clips" pone tus clips (Shuffle = otra mezcla). Las plantillas se guardan
  en "My templates". Los tiempos siempre salen de la medición, nunca del modelo.
  `src/lib/ai/editTemplate.ts`, `src/components/editor/AITemplatesPanel.tsx`.
- **Solo Claude**, con el SDK oficial `@anthropic-ai/sdk` (`src/lib/ai/aiClient.ts`): modelo por
  defecto `claude-opus-5-5`, effort configurable y fallback del servidor en la API oficial.
  **Base URL** para endpoints compatibles con Anthropic (la key se manda como Bearer o x-api-key);
  en la app de PC las llamadas a endpoints propios pasan por el proceso principal (sin CORS).
  Se quitaron Gemini, Z.ai y la ruta de servidor `/api/ai`.
- Dónde poner la API: **Settings (engranaje) → AI (Claude)**: API key, Base URL, modelo.

## v23 — Flow arreglado de verdad, AI Cut-out tipo chroma, máscaras como en After

- **Flow (Video Lab y cámara lenta)**: los cuadros intermedios salían boca abajo, con
  "fantasmas" y rayas. Causas: lectura de píxeles invertida (cuadros y campo de flujo), flujo
  inicial de −64 px en vez de 0, gradientes escalados por la resolución, precisión de 8 bits
  (el solver se trababa), texturas de flujo compartidas entre niveles de la pirámide, flujo
  dividido por el tamaño de la grilla y síntesis que muestreaba en la dirección contraria.
  Ahora: flujo 16 bits por nivel, Horn–Schunck con warping correcto, síntesis bidireccional con
  punto fijo y oclusión. Verificado con prueba sintética (error de fondo 9 → 0.06).
- **Modelos tipo Topaz**: Sharpen ahora realmente enfoca (componente unsharp); pipeline
  verificado (PSNR 40.9 dB en pasada neutra).
- **AI Cut-out como un chroma**: Threshold, Softness, Grow/Shrink, Fill holes, Smooth edges,
  Temporal smoothing, Screen key (Auto/Green/Blue) + Key strength, Spill suppression, Edge color
  fix, vistas Final/Matte/Status, presets, calidad 512/768/1024 y "Add part" (sumar pelo/objetos).
- **Máscaras**: el cuadradito (marcador del ancla dibujado en la esquina) arreglado; Rectángulo /
  Elipse con una capa seleccionada crean MÁSCARA (como After); la pluma y los puntos funcionan en
  la zona oscura alrededor del cuadro (pasteboard); la máscara se dibuja con curvas bezier.
- **Fuentes personalizadas / autoguardado**: compartían base de datos y una rompía a la otra.
- **Plug-ins OpenFX (app de PC)**: host OFX propio (`desktop/ofxhost/ofxhost.cpp`, headers
  oficiales OpenFX BSD-3) que corre como proceso aparte: si un plug-in se cuelga se desactiva y el
  editor sigue. Busca `.ofx.bundle` en `C:\Program Files\Common Files\OFX\Plugins`, la carpeta
  propia de AnimeStudio y las que agregues (Plugins › OpenFX). Los plug-ins aparecen en Effects &
  Presets con sus controles en Effect Controls (keyframeables). Preview asíncrono, export y RAM
  Preview esperan el cuadro. `desktop/ofx.cjs` (proceso, escaneo, caché), `src/lib/engine/ofx.ts`.
  Limitaciones: sin acceso a otros cuadros (efectos temporales tipo Twixtor OFX pueden fallar), sin
  overlays en el visor, render por CPU (los plug-ins que exigen GPU OpenGL/CUDA no corren).
  El CI compila `ofxhost.exe` (MSVC) y un plug-in de prueba y verifica que el instalador lo use.

## v22 — Pantalla de inicio con proyectos, proyectos de After Effects, presets .ffx, arreglos

- **Home (como After Effects)**: al iniciar muestra *Recent projects*; cada proyecto se guarda
  por separado (IndexedDB, autosave) — New Project ya no pisa el anterior. Abrir, renombrar,
  duplicar, borrar. Botón Home, File › Home / New Project / Open Project. `HomeScreen.tsx`,
  `src/lib/store/projectLibrary.ts`.
- **Proyectos de After Effects (.aep / .aepx)**: comps (tamaño, fps, duración), capas en orden
  (footage, sólidos, nulls, texto, shapes, cámaras, ajuste, 3D, precomps) y efectos con
  equivalente. El footage entra *offline* y se re-vincula solo al importar el archivo con el
  mismo nombre. `src/lib/media/aepImport.ts`. Expresiones/efectos propios de AE no se convierten.
- **Presets de After (.ffx)**: Effects & Presets › Animation Presets (+ Install .ffx), doble clic
  aplica; Animation › Apply Animation Preset / Save Animation Preset (`.aspreset` propio con
  efectos + keyframes + expresiones). `src/lib/extensions/ffx.ts`.
- **Scripts**: .jsx, .js, .jsxinc, `#include` resueltos dentro de .zip/.zxp, zip con varios
  scripts; arrastrar .jsx/.ffx/.aep a la ventana los ejecuta/aplica/abre. `.jsxbin` sigue sin
  poder ejecutarse (bytecode cifrado de Adobe).
- **Arreglos**: marcadores de beat borrables (Delete, clic derecho, borrar todos); zoom-out del
  timeline; CTI azul que se salía; borrar ítems del panel Project; mano sólo al arrastrar;
  soltar clips en cualquier parte; preview con muchas capas / máscaras pen / motion blur /
  texto / AI cut-out + texto detrás; Easy Ease en todos los keyframes seleccionados; selección
  azul por arrastre de keyframes; doble clic para escribir valores; workspace acoplable.
- **Time Warp (estilo Twixtor)**: horneado con RIFE/flujo óptico desde el panel de velocidad.

## v21 — IA neuronal (RIFE + Real-ESRGAN), arreglos de scripts, Enhance y reproducción

- **IA neuronal en el Video Lab (app de PC)**: RIFE 4.6 (interpolación, el modelo de Flowframes)
  y Real-ESRGAN AnimeVideo v3 / x4plus Anime (upscale), builds oficiales ncnn-vulkan incluidos por
  el CI en `resources/ai`. Requieren GPU con Vulkan. Vista previa antes/después neuronal.
- **Ajustes de modelo estilo Topaz siempre visibles**: Reduce noise, Fix compression, Improve
  detail, Sharpen, Anti-alias + botón Auto.
- **Enhance volteado**: la cadena de pasadas GPU invertía la imagen (pasadas pares / ImageBitmap).
  También se liberan las texturas por cuadro (antes se acumulaban en renders largos).
- **Submenús (Window › Extensions, File › Scripts)**: estaban recortados por el scroll del menú.
- **Scripts con diálogos** (File.openDialog, Folder.selectDialog, saveDialog) e importación
  (app.project.importFile, ImportOptions, layers.add): el script se re-ejecuta con lo elegido.
  Scripts sin interfaz muestran un botón *Run*.
- **Video que "vuelve al principio"**: al pasar el final del archivo, play() rebobinaba a 0.
  Ahora se mantiene el último cuadro (video y audio).

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
