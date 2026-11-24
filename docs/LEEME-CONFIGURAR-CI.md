# ANIME STUDIO — Configurar los workflows de CI (2 minutos)

El token de integración con el que se subió este código **no tiene el permiso
"Workflows: write"**, así que los archivos de `.github/workflows/` no pudieron
actualizarse de forma automática (GitHub lo bloquea a propósito por seguridad).
Todo el resto del repo (código fuente, docs, scripts) sí se subió completo.

En `docs/workflows/` están los 3 workflows listos para copiar y pegar:

| Archivo en `docs/workflows/` | Va en | Qué hace |
|---|---|---|
| `deploy-pages.yml.txt` | `.github/workflows/deploy-pages.yml` (REEMPLAZA el actual) | Instala con Bun, genera los iconos PWA, construye el export estático con base path `/anime-studio` y lo publica en GitHub Pages con UN solo artifact `github-pages` por run |
| `build-ipa.yml.txt` | `.github/workflows/build-ipa.yml` (REEMPLAZA el actual) | Construye el .ipa sin firmar desde el código fuente (ya no necesita `site.zip`) |
| `ci-test.yml.txt` | `.github/workflows/ci-test.yml` (NUEVO) | Build de prueba en cada rama que no sea `main` — no despliega nada |

## Opción A — Copiar y pegar en la web (2 minutos, sin permisos extra)

1. En el repo: **Add file → Create new file**.
2. En el nombre escribí la ruta completa, por ejemplo:
   `.github/workflows/deploy-pages.yml`
3. Pegá el contenido de `docs/workflows/deploy-pages.yml.txt` (abrilo, botón
   "Raw" para copiar limpio).
4. Repetí para los otros dos (`build-ipa.yml` reemplaza al existente
   abriéndolo con el lápiz ✏️; `ci-test.yml` es nuevo).
5. Commit en la rama que corresponda (o en `main` directamente).

## Opción B — Dar el permiso al plugin (recomendado a futuro)

GitHub → **Settings → Applications → Installed GitHub Apps** → la app del
plugin → **Repository permissions → Workflows: Read and write**. Con eso, la
próxima sesión puedo subir y actualizar los workflows yo mismo.

## Después de activarlos

- Cada push a `main` → build desde el código fuente → Pages con la última
  versión (`CACHE_VERSION` de `public/sw.js`, ahora `as-v13`).
- Cada push a cualquier otra rama → `ci-test.yml` compila y verifica (sin
  deploy).
- Cuando el workflow nuevo de Pages esté activo, los archivos
  `site-pages.zip` y `site.zip` de la raíz ya no se usan y se pueden borrar.
