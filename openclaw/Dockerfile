FROM ghcr.io/openclaw/openclaw:main-slim

# openclaw.json includes gateway.mode + WhatsApp allowlist (+19804430453)
COPY openclaw.json /defaults/openclaw.json
COPY boot.sh /boot.sh

USER root
ENTRYPOINT ["sh", "/boot.sh"]
