# VoxCPM2 Microservice

Separate Python service for Marco's voice clone generation.

## Requirements

- Python 3.10+
- PyTorch 2.5.0+ with CUDA 12.0+
- ~8GB VRAM GPU (NVIDIA RTX 3080/4080/4090 recommended)

## Setup

```bash
pip install -r requirements.txt
```

## Run

```bash
VOXCPM_OUTPUT_DIR=/data/voice-clone/generated uvicorn server:app --host 0.0.0.0 --port 8000
```

## Environment variables

- `VOXCPM_MODEL_PATH`: HuggingFace model ID or local path (default: `openbmb/VoxCPM2`)
- `VOXCPM_OUTPUT_DIR`: where to write `.wav` outputs (default: `/data/voice-clone/generated`)

## First run

Model downloads ~8GB on first request. Be patient.

## Deployment note

This service must run on a **separate GPU machine** (RunPod, Modal, or local GPU) — not on the Marco 90 Fly.io Node container.
