# Marco Puga Realty — Automation System
# Multi-service: Node.js (port 3000) + OpenShorts Python sidecar (port 8000)

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

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
COPY public ./public
COPY services ./services
COPY scripts ./scripts
COPY supervisord.conf ./supervisord.conf
RUN npm run build && npm prune --omit=dev

WORKDIR /app/services/openshorts

RUN if [ ! -f "app.py" ]; then \
    git clone https://github.com/mutonby/openshorts.git temp_clone && \
    mv temp_clone/* temp_clone/.[!.]* . 2>/dev/null || true && \
    rm -rf temp_clone ; \
fi

# OpenShorts main.py imports cv2 before scenedetect; install headless OpenCV first.
RUN python3 -m pip install --no-cache-dir --break-system-packages opencv-python-headless \
    && python3 -m pip install --no-cache-dir --break-system-packages -r requirements.txt

# Marco-specific Python deps not guaranteed by the upstream OpenShorts clone
# (YouTube competitor transcript intelligence). Installed explicitly by an
# absolute path so it never collides with the clone's own requirements.txt.
COPY services/openshorts/requirements-marco.txt /tmp/requirements-marco.txt
RUN python3 -m pip install --no-cache-dir --break-system-packages -r /tmp/requirements-marco.txt

# Fail the image build if core clipping imports are broken (avoids "online" sidecar with no engine).
RUN python3 -c "import main; print('OpenShorts main import OK:', main.__file__)"
RUN python3 -c "from youtube_transcript_api import YouTubeTranscriptApi; print('youtube-transcript-api import OK')"

COPY services/openshorts/prompts_marco.py ./prompts_marco.py
COPY services/openshorts/llm_analysis.py ./llm_analysis.py
COPY services/openshorts/main_marco.py ./main_marco.py
COPY services/openshorts/captions_marco.py ./captions_marco.py
COPY services/openshorts/gaze_analysis_marco.py ./gaze_analysis_marco.py
COPY services/openshorts/take_analysis_marco.py ./take_analysis_marco.py
COPY services/openshorts/app_marco.py ./app_marco.py

COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

RUN mkdir -p /data/uploads/videos /data/clips /data/uploads

WORKDIR /app

EXPOSE 3000
EXPOSE 8000

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
