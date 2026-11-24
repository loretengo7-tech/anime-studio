FROM node:24-trixie-slim

ENV PATH=/opt/anime-python/bin:$PATH \
    NODE_ENV=production \
    PORT=10000 \
    ALLOWED_ORIGIN=https://loretengo7-tech.github.io \
    CONCURRENCY=1 \
    MAX_UPLOAD_MB=16 \
    MAX_OUTPUT_MB=32 \
    MAX_DURATION_SECONDS=120 \
    JOB_TTL_MIN=30 \
    HF_HOME=/opt/anime-models

WORKDIR /app
COPY anime-studio-backend.zip /tmp/anime-studio-backend.zip

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-venv unzip \
 && rm -rf /var/lib/apt/lists/* \
 && unzip -q /tmp/anime-studio-backend.zip -d /app \
 && rm /tmp/anime-studio-backend.zip \
 && python3 -m venv /opt/anime-python \
 && pip install --no-cache-dir faster-whisper==1.2.1 earshot==1.2.2 \
 && HF_HUB_DISABLE_XET=1 python3 -c 'from faster_whisper.utils import download_model; download_model("tiny")' \
 && chmod -R a+rX /opt/anime-models

ENV HF_HUB_OFFLINE=1
USER node
EXPOSE 10000
CMD ["node", "server.js"]
