#!/usr/bin/env python3
"""
VoxCPM2 microservice for Marco's voice clone generation.
Run locally:  VOXCPM_MOCK=1 uvicorn server:app --host 0.0.0.0 --port 8001
Run on GPU:   uvicorn server:app --host 0.0.0.0 --port 8001
"""

import os
import uuid
import logging
from enum import Enum
from pathlib import Path
from typing import List, Optional

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("voxcpm-service")

app = FastAPI(title="VoxCPM2 Voice Clone Service")

_model = None
_model_path = os.getenv("VOXCPM_MODEL_PATH", "openbmb/VoxCPM2")


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _default_output_dir() -> str:
    if os.path.exists("/data"):
        return "/data/voice-clone/generated"
    return str(_repo_root() / "data" / "voice-clone" / "generated")


def _is_mock_mode() -> bool:
    if os.getenv("VOXCPM_MOCK", "").strip().lower() in ("1", "true", "yes"):
        return True
    # CPU dev: auto-mock when no CUDA unless explicitly disabled
    if os.getenv("VOXCPM_ALLOW_CPU_MOCK", "1").strip().lower() in ("0", "false", "no"):
        return False
    return not _is_cuda_available()


def get_model():
    global _model
    if _is_mock_mode():
        return None
    if _model is None:
        logger.info("Loading VoxCPM2 model from %s...", _model_path)
        from voxcpm import VoxCPM

        _model = VoxCPM.from_pretrained(_model_path, load_denoiser=False)
        logger.info("VoxCPM2 model loaded")
    return _model


class DeliveryStyle(str, Enum):
    energetic_hook = "energetic_hook"
    calm_explainer = "calm_explainer"
    warm_client = "warm_client"
    custom = "custom"


STYLE_PREFIXES = {
    "energetic_hook": "(energetic, punchy, high-energy, confident, fast-paced, exciting)",
    "calm_explainer": "(calm, clear, measured pace, authoritative, warm, professional)",
    "warm_client": "(warm, personal, conversational, genuine, friendly, caring)",
}


class GenerateRequest(BaseModel):
    script: str
    delivery_style: DeliveryStyle
    custom_style_description: Optional[str] = None
    reference_audio_path: str
    reference_transcript: Optional[str] = None
    voxcpm_mode: str = "ultimate"
    hook_variation_count: int = 1


class GenerateResponse(BaseModel):
    success: bool
    output_paths: List[str] = []
    duration_seconds: List[float] = []
    error: Optional[str] = None
    mock: bool = False


def _generate_mock_wav(script: str, variation_index: int, sample_rate: int = 24000) -> np.ndarray:
    """Placeholder audio for local/CPU testing — not Marco's voice."""
    base_duration = min(2.5 + len(script) / 80.0, 8.0)
    duration = base_duration + variation_index * 0.15
    t = np.linspace(0, duration, int(sample_rate * duration), endpoint=False)
    freq = 180 + variation_index * 40
    wav = 0.12 * np.sin(2 * np.pi * freq * t)
    # soft envelope
    envelope = np.minimum(t / 0.05, 1.0) * np.minimum((duration - t) / 0.1, 1.0)
    return wav * envelope


@app.get("/health")
def health():
    mock = _is_mock_mode()
    return {
        "status": "ok",
        "mock_mode": mock,
        "model_loaded": _model is not None,
        "model_path": _model_path if not mock else "mock",
        "cuda_available": _is_cuda_available(),
        "output_dir": os.getenv("VOXCPM_OUTPUT_DIR", _default_output_dir()),
    }


@app.post("/generate", response_model=GenerateResponse)
def generate_voiceover(req: GenerateRequest):
    output_dir = os.getenv("VOXCPM_OUTPUT_DIR", _default_output_dir())
    os.makedirs(output_dir, exist_ok=True)

    mock = _is_mock_mode()

    if not mock and not os.path.exists(req.reference_audio_path):
        raise HTTPException(
            status_code=400,
            detail=f"Reference audio not found: {req.reference_audio_path}",
        )

    if mock:
        logger.info("MOCK generate (%d variations) — not real VoxCPM output", req.hook_variation_count)
        output_paths: List[str] = []
        durations: List[float] = []
        variation_count = min(max(req.hook_variation_count, 1), 5)
        sample_rate = 24000

        for i in range(variation_count):
            wav = _generate_mock_wav(req.script, i, sample_rate)
            output_filename = f"mock_{uuid.uuid4()}_v{i + 1}.wav"
            output_path = os.path.join(output_dir, output_filename)
            sf.write(output_path, wav, sample_rate)
            duration = len(wav) / sample_rate
            output_paths.append(output_path)
            durations.append(round(duration, 2))

        return GenerateResponse(
            success=True,
            output_paths=output_paths,
            duration_seconds=durations,
            mock=True,
        )

    try:
        model = get_model()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Model load failed: {e}")

    if model is None:
        raise HTTPException(status_code=500, detail="Model not loaded")

    style_prefix = ""
    if req.delivery_style == DeliveryStyle.custom and req.custom_style_description:
        style_prefix = f"({req.custom_style_description})"
    elif req.delivery_style.value in STYLE_PREFIXES:
        style_prefix = STYLE_PREFIXES[req.delivery_style.value]

    output_paths = []
    durations = []
    variation_count = min(max(req.hook_variation_count, 1), 5)

    for i in range(variation_count):
        try:
            text_with_style = f"{style_prefix}{req.script}" if style_prefix else req.script

            if req.voxcpm_mode == "ultimate" and req.reference_transcript:
                wav = model.generate(
                    text=text_with_style,
                    prompt_wav_path=req.reference_audio_path,
                    prompt_text=req.reference_transcript,
                    reference_wav_path=req.reference_audio_path,
                )
            else:
                wav = model.generate(
                    text=text_with_style,
                    reference_wav_path=req.reference_audio_path,
                    cfg_value=2.0,
                    inference_timesteps=10,
                )

            output_filename = f"{uuid.uuid4()}_v{i + 1}.wav"
            output_path = os.path.join(output_dir, output_filename)
            sf.write(output_path, wav, model.tts_model.sample_rate)

            duration = len(wav) / model.tts_model.sample_rate
            output_paths.append(output_path)
            durations.append(round(duration, 2))

            logger.info(
                "Generated variation %d/%d: %s (%.1fs)",
                i + 1,
                variation_count,
                output_filename,
                duration,
            )

        except Exception as e:
            logger.error("Generation error on variation %d: %s", i + 1, e)
            if i == 0:
                return GenerateResponse(success=False, error=str(e))

    return GenerateResponse(
        success=True,
        output_paths=output_paths,
        duration_seconds=durations,
        mock=False,
    )


@app.get("/audio/{filename}")
def get_audio(filename: str):
    output_dir = os.getenv("VOXCPM_OUTPUT_DIR", _default_output_dir())
    file_path = os.path.join(output_dir, filename)
    norm_output = os.path.normpath(output_dir)
    norm_file = os.path.normpath(file_path)
    if not os.path.exists(file_path) or not norm_file.startswith(norm_output):
        raise HTTPException(status_code=404, detail="Audio file not found")
    return FileResponse(file_path, media_type="audio/wav")


def _is_cuda_available() -> bool:
    try:
        import torch

        return torch.cuda.is_available()
    except ImportError:
        return False
