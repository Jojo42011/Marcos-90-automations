# VoxCPM2 service

Optional standalone FastAPI voice-generation service. It is not started by the repository's Node Docker image.

## Real generation and fixtures

Real VoxCPM generation requires compatible PyTorch/CUDA hardware and the model dependencies in requirements.txt. Model loading occurs lazily on the first generation request.

server.py supports VOXCPM_MOCK=1. It also defaults to mock behavior when CUDA is unavailable unless VOXCPM_ALLOW_CPU_MOCK=0. Mock output is not real cloned speech; check the service mode before treating a response as a successful voice-generation integration.

## Run from this directory

```bash
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8001
```

Use requirements-local.txt for the local fixture dependencies where appropriate.

## Configuration

- VOXCPM_MODEL_PATH: model ID or local path; default openbmb/VoxCPM2.
- VOXCPM_OUTPUT_DIR: generated WAV directory. Default /data/voice-clone/generated when /data exists, otherwise the repository's data/voice-clone/generated.
- VOXCPM_MOCK: explicitly selects fixture mode.
- VOXCPM_ALLOW_CPU_MOCK: disable automatic CPU mock fallback with 0.

The Node integration reads VOXCPM_API_URL. Under account isolation, this is not automatically inherited from the parent environment. A standalone service deployment does not by itself connect every account.
