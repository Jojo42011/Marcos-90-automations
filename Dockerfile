# Marco Puga Realty — Automation System
# Multi-service: Node.js (port 3000) + OpenShorts Python sidecar (port 8000)

FROM node:18-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    supervisor \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
COPY public ./public
COPY services ./services
COPY supervisord.conf ./supervisord.conf
RUN npm run build && npm prune --omit=dev

WORKDIR /app/services/openshorts

RUN if [ ! -f "app.py" ]; then \
    git clone https://github.com/mutonby/openshorts.git temp_clone && \
    mv temp_clone/* temp_clone/.[!.]* . 2>/dev/null || true && \
    rm -rf temp_clone ; \
fi

RUN python3 -m pip install --no-cache-dir --break-system-packages \
    fastapi \
    uvicorn \
    google-genai \
    faster-whisper \
    ultralytics \
    mediapipe \
    opencv-python-headless \
    yt-dlp \
    httpx \
    python-multipart

COPY services/openshorts/prompts_marco.py ./prompts_marco.py
COPY services/openshorts/main_marco.py ./main_marco.py
COPY services/openshorts/app_marco.py ./app_marco.py

COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

RUN mkdir -p /data/uploads/videos /data/clips /data/uploads

WORKDIR /app

EXPOSE 3000
EXPOSE 8000

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
