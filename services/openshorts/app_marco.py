"""
Marco Puga Realty — OpenShorts FastAPI wrapper
"""
import os
import uuid
import json
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, UploadFile, Form, Header, HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

import main_marco  # noqa: F401 — patches openshorts when available

try:
    import main as openshorts_main
except ImportError:
    openshorts_main = None

app = FastAPI(title="OpenShorts — Marco Puga Realty", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "https://marco-90-automation.fly.dev",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

jobs: dict = {}

CLIPS_OUTPUT_DIR = Path(os.environ.get("CLIPS_OUTPUT_DIR", "/data/clips"))
UPLOADS_INPUT_DIR = Path(os.environ.get("UPLOADS_INPUT_DIR", "/data/uploads/videos"))
CLIPS_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


async def process_video_job(
    job_id: str,
    video_path: str,
    gemini_api_key: str,
    pillar: str,
    trend_brief: str,
    target_clips: int,
):
    try:
        if openshorts_main is None:
            raise RuntimeError("OpenShorts not installed — run setup-openshorts.sh")

        jobs[job_id]["status"] = "transcribing"
        transcript = openshorts_main.transcribe_video(video_path)
        jobs[job_id]["status"] = "analyzing"

        video_duration = transcript.get("duration", 0)
        clips_data = main_marco.get_viral_clips_marco(
            transcript_result=transcript,
            video_duration=video_duration,
            pillar=pillar,
            trend_brief=trend_brief,
            target_clips=target_clips,
            gemini_api_key=gemini_api_key,
        )

        jobs[job_id]["status"] = "reframing"
        output_clips = []
        clip_output_dir = CLIPS_OUTPUT_DIR / job_id
        clip_output_dir.mkdir(parents=True, exist_ok=True)

        for i, clip in enumerate(clips_data.get("clips", [])):
            clip_id = str(uuid.uuid4())
            clip_filename = f"clip_{i + 1}_{clip_id[:8]}.mp4"
            thumbnail_filename = f"thumb_{i + 1}_{clip_id[:8]}.jpg"
            clip_path = str(clip_output_dir / clip_filename)
            thumb_path = str(clip_output_dir / thumbnail_filename)

            openshorts_main.cut_clip(
                input_path=video_path,
                output_path=clip_path,
                start_time=clip["start_time"],
                end_time=clip["end_time"],
            )

            reframed_path = clip_path.replace(".mp4", "_vertical.mp4")
            try:
                openshorts_main.reframe_to_vertical(
                    input_path=clip_path,
                    output_path=reframed_path,
                )
                final_clip_path = reframed_path
            except Exception as reframe_err:
                print(f"Reframe failed for clip {i + 1}: {reframe_err}. Using original cut.")
                final_clip_path = clip_path

            try:
                openshorts_main.extract_thumbnail(
                    video_path=final_clip_path,
                    output_path=thumb_path,
                    timestamp=1.0,
                )
            except Exception:
                thumb_path = None

            output_clips.append(
                {
                    "clip_id": clip_id,
                    "clip_path": final_clip_path,
                    "clip_url": f"/clips/{job_id}/{os.path.basename(final_clip_path)}",
                    "thumbnail_path": thumb_path,
                    "thumbnail_url": (
                        f"/clips/{job_id}/{os.path.basename(thumb_path)}" if thumb_path else None
                    ),
                    "start_time": clip["start_time"],
                    "end_time": clip["end_time"],
                    "duration": clip["end_time"] - clip["start_time"],
                    "viral_score": clip.get("viral_score", 50),
                    "hook_type": clip.get("hook_type", "uncategorized"),
                    "hook_preview": clip.get("hook_preview", ""),
                    "transcript_segment": clip.get("why_this_clip", ""),
                    "suggested_title": clip.get("suggested_title", f"Clip {i + 1}"),
                    "suggested_caption": clip.get("suggested_caption", ""),
                    "pillar": clip.get("pillar", pillar),
                    "why_this_clip": clip.get("why_this_clip", ""),
                },
            )

        jobs[job_id].update(
            {
                "status": "complete",
                "clips": output_clips,
                "total_clips": len(output_clips),
                "transcript": transcript.get("text", "")[:500],
            },
        )

    except Exception as e:
        jobs[job_id].update({"status": "failed", "error": str(e)})
        print(f"Job {job_id} failed: {e}")


@app.post("/api/process")
async def process_video(
    background_tasks: BackgroundTasks,
    file: Optional[UploadFile] = File(None),
    file_path: Optional[str] = Form(None),
    pillar: str = Form("brand"),
    trend_brief: str = Form(""),
    target_clips: int = Form(7),
    x_gemini_key: Optional[str] = Header(None),
):
    gemini_api_key = x_gemini_key or os.environ.get("GEMINI_API_KEY")
    if not gemini_api_key:
        raise HTTPException(
            status_code=400,
            detail="GEMINI_API_KEY required via X-Gemini-Key header or environment",
        )

    job_id = str(uuid.uuid4())

    if file_path and Path(file_path).exists():
        video_path = file_path
    elif file:
        save_path = UPLOADS_INPUT_DIR / f"{job_id}_{file.filename}"
        save_path.parent.mkdir(parents=True, exist_ok=True)
        content = await file.read()
        with open(save_path, "wb") as f:
            f.write(content)
        video_path = str(save_path)
    else:
        raise HTTPException(status_code=400, detail="Either file or file_path is required")

    jobs[job_id] = {
        "status": "queued",
        "video_path": video_path,
        "pillar": pillar,
        "target_clips": target_clips,
        "clips": [],
        "error": None,
    }

    background_tasks.add_task(
        process_video_job,
        job_id=job_id,
        video_path=video_path,
        gemini_api_key=gemini_api_key,
        pillar=pillar,
        trend_brief=trend_brief,
        target_clips=target_clips,
    )

    return {"job_id": job_id, "status": "queued"}


@app.get("/api/jobs/{job_id}")
async def get_job_status(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    return jobs[job_id]


@app.get("/clips/{job_id}/{filename}")
async def serve_clip(job_id: str, filename: str):
    file_path = CLIPS_OUTPUT_DIR / job_id / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(str(file_path))


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "openshorts-marco",
        "model": "gemini-2.5-flash",
        "clips_dir": str(CLIPS_OUTPUT_DIR),
        "openshorts_installed": openshorts_main is not None,
        "active_jobs": len(
            [j for j in jobs.values() if j["status"] not in ["complete", "failed"]],
        ),
    }


if __name__ == "__main__":
    port = int(os.environ.get("OPENSHORTS_PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
