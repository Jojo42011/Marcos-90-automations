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

# ── OpenShorts engine clone + Python deps (cached unless requirements change) ─
# Source-independent, so these stay cached across every source-only deploy.
WORKDIR /app/services/openshorts

RUN if [ ! -f "app.py" ]; then \
    git clone https://github.com/mutonby/openshorts.git temp_clone && \
    mv temp_clone/* temp_clone/.[!.]* . 2>/dev/null || true && \
    rm -rf temp_clone ; \
fi

# IMAGE-SIZE CRITICAL: Fly machines refuse images over 8GB uncompressed
# ("Not enough space to unpack image" → silent revert to the old image; this
# took production down on 2026-07-11). The default torch wheels bundle
# multi-GB NVIDIA CUDA libraries this CPU-only box can never use — install
# the CPU-only builds FIRST so requirements.txt sees torch/torchvision
# already satisfied (PEP 440: 2.11.0+cpu satisfies ==2.11.0).
# --extra-index-url (not --index-url): the +cpu wheels live only on the
# PyTorch index, while their dependencies (typing-extensions etc.) must come
# from PyPI — the PyTorch index's copies fail pip's name-normalization check.
RUN python3 -m pip install --no-cache-dir --break-system-packages \
    torch==2.11.0+cpu torchvision==0.26.0+cpu \
    --extra-index-url https://download.pytorch.org/whl/cpu

# OpenShorts main.py imports cv2 before scenedetect; install headless OpenCV first.
RUN python3 -m pip install --no-cache-dir --break-system-packages opencv-python-headless \
    && python3 -m pip install --no-cache-dir --break-system-packages -r requirements.txt \
    && rm -rf /root/.cache /app/services/openshorts/.git

# Marco-specific Python deps not guaranteed by the upstream OpenShorts clone
# (YouTube competitor transcript intelligence). Installed explicitly by an
# absolute path so it never collides with the clone's own requirements.txt.
COPY services/openshorts/requirements-marco.txt /tmp/requirements-marco.txt
RUN python3 -m pip install --no-cache-dir --break-system-packages -r /tmp/requirements-marco.txt

# Fail the image build if core clipping imports are broken (avoids "online" sidecar with no engine).
RUN python3 -c "import main; print('OpenShorts main import OK:', main.__file__)"
RUN python3 -c "from youtube_transcript_api import YouTubeTranscriptApi; print('youtube-transcript-api import OK')"

# ── CapCut draft-export service (ashreo/CapCutAPI, pinned commit) ──────────
# Generates CapCut DRAFT projects (clip + captions) the user opens in the
# CapCut desktop app; it renders nothing itself. Clone + deps are source-
# independent, so they cache too.
WORKDIR /app/services
RUN git clone https://github.com/ashreo/CapCutAPI.git capcutapi \
    && cd capcutapi \
    && git checkout 369fa2d45e3cce0e633c5f43004464c0db268c11
WORKDIR /app/services/capcutapi
# Explicit dep list on purpose: upstream requirements.txt pulls oss2 (native
# builds, cloud-upload only) which the oss.py override below removes the need for.
RUN python3 -m pip install --no-cache-dir --break-system-packages flask requests imageio psutil

# ════════════════════════════════════════════════════════════════════════════
# APP SOURCE — everything below changes often and is intentionally LAST so a
# source-only deploy reuses every cached layer above. Nothing heavy here.
# ════════════════════════════════════════════════════════════════════════════
WORKDIR /app
COPY tsconfig.json ./
COPY config ./config
COPY src ./src
RUN npm run build && npm prune --omit=dev && npm cache clean --force && rm -rf /root/.npm
COPY public ./public
COPY scripts ./scripts
COPY supervisord.conf ./supervisord.conf

# Marco source overrides — the whole services tree over the clones. COPY merges:
# the cloned OpenShorts/CapCut engine files stay, marco *.py modules and the
# capcutapi-marco assets are added on top. This is the single catch-all that
# guarantees every marco module (reel_analysis, gaze, emoji_fx, …) is present.
COPY services ./services

# Apply the CapCut overrides + text_segment shim onto the cloned engine.
COPY services/capcutapi-marco/config.json /app/services/capcutapi/config.json
COPY services/capcutapi-marco/oss.py /app/services/capcutapi/oss.py
COPY services/capcutapi-marco/text_segment_shim.py /tmp/text_segment_shim.py
RUN printf '\n\n' >> /app/services/capcutapi/pyJianYingDraft/text_segment.py \
    && cat /tmp/text_segment_shim.py >> /app/services/capcutapi/pyJianYingDraft/text_segment.py \
    && rm /tmp/text_segment_shim.py

# Fail the image build if the sidecar services can't import after overrides.
RUN cd /app/services/openshorts && python3 -c "import main; print('OpenShorts engine OK')"
RUN cd /app/services/capcutapi && python3 -c "import capcut_server; print('CapCutAPI import OK')"

COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

RUN mkdir -p /data/uploads/videos /data/clips /data/uploads

WORKDIR /app

EXPOSE 3000
EXPOSE 8000

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
