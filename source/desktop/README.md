# AnimeStudio Desktop (Windows .exe)

Electron shell around the same editor, with GPU acceleration forced on, no tab
throttling, more memory for RAM previews and a bundled **ffmpeg** (MKV/HEVC/AVI/
ProRes import + fast preview proxies).

Build (done automatically by `.github/workflows/build-desktop.yml`):

```bash
# 1) static build of the editor (root base path)
bash scripts/build-static.sh
# 2) package
rm -rf desktop/app && cp -r dist-static desktop/app
cd desktop && npm install && npm run dist:win
```

Keys: F11 fullscreen · F12 dev tools. All After Effects shortcuts work (the
window has no browser menu stealing Ctrl+N / Ctrl+T).
