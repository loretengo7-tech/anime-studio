#!/usr/bin/env python3
"""
ANIME STUDIO — Vocal/instrumental separation (stems)

Real source separation using Meta's Demucs model. This is NOT a browser
feature: it needs Python + the model weights (first run downloads ~80 MB).

Requirements:
    pip install demucs
    (ffmpeg available on PATH — Demucs uses it to decode)

Usage:
    python3 separate-vocals.py <input_audio> <output_dir>

Produces:
    <output_dir>/vocals.mp3
    <output_dir>/instrumental.mp3

Called by the /api/stems route when running the Node server locally.
The static (GitHub Pages) build cannot run Python — the UI explains this
and suggests running the editor locally (npm run dev) or using pre-separated
stems imported as normal audio files.
"""
import subprocess
import sys
import os
import glob


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: separate-vocals.py <input> <output_dir>", file=sys.stderr)
        return 2
    src, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)

    # Run Demucs on a copy-safe temp name and capture its two-stem output.
    # --two-stems=vocals gives exactly vocals + accompaniment (no vocals).
    cmd = [
        sys.executable, "-m", "demucs.separate",
        "--two-stems", "vocals",
        "-n", "htdemucs",
        "--mp3",  # encode outputs as mp3 (small, browser-friendly)
        "-o", outdir,
        src,
    ]
    print("running:", " ".join(cmd), file=sys.stderr)
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        print(proc.stderr[-2000:], file=sys.stderr)
        print(proc.stdout[-2000:], file=sys.stderr)
        return 1

    # Demucs writes <outdir>/htdemucs/<basename>/vocals.mp3 + no_vocals.mp3
    base = os.path.splitext(os.path.basename(src))[0]
    pattern = os.path.join(outdir, "**", "*.mp3")
    hits = glob.glob(pattern, recursive=True)
    vocals = next((h for h in hits if h.endswith("vocals.mp3")), None)
    inst = next((h for h in hits if h.endswith("no_vocals.mp3")), None)
    if not vocals or not inst:
        print(f"demucs finished but stems not found in {outdir}: {hits}", file=sys.stderr)
        return 1

    # Normalize names for the API route
    final_vocals = os.path.join(outdir, "vocals.mp3")
    final_inst = os.path.join(outdir, "instrumental.mp3")
    os.replace(vocals, final_vocals)
    os.replace(inst, final_inst)
    print(final_vocals)
    print(final_inst)
    return 0


if __name__ == "__main__":
    sys.exit(main())
