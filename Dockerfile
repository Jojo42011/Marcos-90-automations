# Marco Puga Realty — Automation System
# Multi-service: Node.js (port 3000) + OpenShorts Python sidecar (port 8000)
#
# LAYER ORDER IS DELIBERATE FOR DEPLOY SPEED. Everything that does NOT depend on
# app source — apt packages, npm deps, the heavy torch/mediapipe/whisper pip
# installs, the OpenShorts + CapCut clones — is installed FIRST, before any app
# source is copied in. So a normal source-only deploy (a Python/TS/HTML change)
# reuses all those cached layers and only re-runs the cheap tail, turning a
# ~9-minute cold build into a ~1-2 minute one. KEEP SOURCE COPYs AT THE BOTTOM.

FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    supervisor \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    libgomp1 \
    git \
    curl \
    build-essential \
    fonts-liberation \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Caption emojis: libass renders through FreeType and CANNOT draw color bitmap
# fonts, so emoji are NOT burned as ASS text at all — emoji_fx_marco.py
# rasterizes them to real colorful PNG stickers with Pillow, using the
# fonts-noto-color-emoji package installed above, and composites them as an
# animated video overlay instead (see that module's docstring).

# Caption font: chunky bold uppercase sans matching Marco's reference style
# (heavy weight, black outline, high-impact viral-caption look). Archivo Black
# is OFL-licensed and freely redistributable; captions_marco.py selects it by
# name in the ASS [V4+ Styles] Fontname field.
RUN mkdir -p /usr/share/fonts/truetype/archivo-black && \
    curl -fsSL -o "/usr/share/fonts/truetype/archivo-black/ArchivoBlack.ttf" \
      "https://raw.githubusercontent.com/google/fonts/main/ofl/archivoblack/ArchivoBlack-Regular.ttf" && \
    fc-cache -f

# ── Node dependencies (cached unless package*.json changes) ────────────────
WORKDIR /app
COPY package*.json ./
RUN npm ci

# The OpenShorts video engine, its Python/torch dependency layer and the
# CapCutAPI draft service were removed with the Content Manager on 2026-09-20.
# They were the bulk of this image and of its build time; whatever replaces the
# content pipeline can add back only what it actually needs.

COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

RUN mkdir -p /data/uploads/videos /data/clips /data/uploads

WORKDIR /app

EXPOSE 3000
EXPOSE 8000

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
