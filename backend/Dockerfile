# ANIME STUDIO backend — imagen con todas las herramientas opcionales instaladas.
# Desplegable gratis en Render / Railway / Fly.io (plan de la Etapa 2).
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-pip curl \
 && rm -rf /var/lib/apt/lists/*

# Herramientas opcionales: si algo falla, el backend sigue andando y las
# capacidades se reportan como no disponibles (nada se simula).
RUN pip3 install --break-system-packages --no-cache-dir faster-whisper earshot yt-dlp \
 || pip3 install --break-system-packages --no-cache-dir faster-whisper yt-dlp \
 || true

WORKDIR /app
COPY package.json server.js ./

ENV PORT=8787 \
    MAX_UPLOAD_MB=200 \
    CONCURRENCY=2

EXPOSE 8787
CMD ["node", "server.js"]
