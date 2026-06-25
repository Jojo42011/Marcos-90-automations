"""
Marco Puga Realty — OpenShorts FastAPI wrapper
"""
import os
import uuid
import json
import subprocess
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


def _probe_duration(video_path: str) -> float:
    """Return media duration in seconds via ffprobe (0.0 if it can't be read)."""
    try:
        out = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                video_path,
            ],
            capture_output=True,
            text=True,
        )
        return float(out.stdout.strip())
    except Exception:
        return 0.0


def _cut_clip(input_path: str, output_path: str, start_time: float, end_time: float) -> str:
    """Cut a precise sub-clip with ffmpeg (re-encode for frame accuracy)."""
    result = subprocess.run(
        [
            "ffmpeg", "-y",
            "-ss", str(start_time),
            "-to", str(end_time),
            "-i", input_path,
            "-c:v", "libx264", "-crf", "18", "-preset", "fast",
            "-c:a", "aac",
            output_path,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg cut failed: {result.stderr.decode()[-500:]}")
    return output_path


def _extract_thumbnail(video_path: str, output_path: str, timestamp: float = 1.0) -> str:
    """Grab a single still frame as the clip thumbnail."""
    result = subprocess.run(
        [
            "ffmpeg", "-y",
            "-ss", str(timestamp),
            "-i", video_path,
            "-frames:v", "1",
            "-q:v", "2",
            output_path,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg thumbnail failed: {result.stderr.decode()[-300:]}")
    return output_path

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

        # transcribe_video() does not return duration — probe the file directly.
        video_duration = transcript.get("duration") or _probe_duration(video_path)
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

            _cut_clip(
                input_path=video_path,
                output_path=clip_path,
                start_time=clip["start_time"],
                end_time=clip["end_time"],
            )

            reframed_path = clip_path.replace(".mp4", "_vertical.mp4")
            try:
                success = openshorts_main.process_video_to_vertical(clip_path, reframed_path)
                final_clip_path = reframed_path if success and os.path.exists(reframed_path) else clip_path
            except Exception as reframe_err:
                print(f"Reframe failed for clip {i + 1}: {reframe_err}. Using original cut.")
                final_clip_path = clip_path

            try:
                _extract_thumbnail(
                    video_path=final_clip_path,
                    output_path=thumb_path,
                    timestamp=1.0,
                )
            except Exception as thumb_err:
                print(f"Thumbnail failed for clip {i + 1}: {thumb_err}")
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


@app.get("/api/youtube/channel-videos")
async def get_channel_videos(channel_url: str, max_videos: int = 10):
    """
    Uses yt-dlp (already installed) to list the most recent video IDs from a
    YouTube channel URL without downloading any video. No API key required.
    Accepts a full channel URL, /channel/UCxxx, or a bare @handle.
    """
    import subprocess

    if not channel_url.startswith("http"):
        handle = channel_url if channel_url.startswith("@") else f"@{channel_url}"
        channel_url = f"https://www.youtube.com/{handle}"

    try:
        result = subprocess.run(
            [
                "yt-dlp",
                "--flat-playlist",
                "--dump-json",
                "--playlist-end",
                str(max_videos),
                "--no-warnings",
                "--quiet",
                channel_url,
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )

        if result.returncode != 0 and not result.stdout.strip():
            raise HTTPException(
                status_code=400,
                detail=f"Could not fetch channel: {result.stderr[:200]}",
            )

        videos = []
        for line in result.stdout.strip().split("\n"):
            if not line.strip():
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue
            vid = data.get("id", "")
            videos.append(
                {
                    "video_id": vid,
                    "title": data.get("title", ""),
                    "url": f"https://www.youtube.com/watch?v={vid}",
                    "upload_date": data.get("upload_date", ""),
                    "view_count": data.get("view_count", 0),
                    "duration": data.get("duration", 0),
                    "channel": data.get("channel", ""),
                    "channel_id": data.get("channel_id", ""),
                }
            )

        return {
            "channel_url": channel_url,
            "videos_found": len(videos),
            "videos": videos,
        }

    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=408, detail="Channel fetch timed out after 30 seconds")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _extract_video_id(raw: str) -> str:
    if "youtube.com" in raw or "youtu.be" in raw:
        import re

        match = re.search(r"(?:v=|youtu\.be/)([a-zA-Z0-9_-]{11})", raw)
        if match:
            return match.group(1)
    return raw


def _fetch_transcript_segments(video_id: str, language: str):
    """Returns a list of {text, start, duration} segments or raises."""
    from youtube_transcript_api import YouTubeTranscriptApi, NoTranscriptFound

    try:
        return YouTubeTranscriptApi.get_transcript(video_id, languages=[language, "en"])
    except NoTranscriptFound:
        transcripts = YouTubeTranscriptApi.list_transcripts(video_id)
        return transcripts.find_generated_transcript(["en"]).fetch()


@app.post("/api/youtube/transcript")
async def get_video_transcript(video_id: str = Form(...), language: str = Form("en")):
    """
    Fetches the full transcript for a YouTube video using youtube-transcript-api.
    Free, no API key, no audio download. Returns full text plus hook/body/cta sections.
    """
    try:
        from youtube_transcript_api import TranscriptsDisabled, NoTranscriptFound

        video_id = _extract_video_id(video_id)

        try:
            transcript_list = _fetch_transcript_segments(video_id, language)
        except TranscriptsDisabled:
            return {
                "video_id": video_id,
                "error": "transcripts_disabled",
                "message": "This video has transcripts disabled by the creator.",
            }
        except NoTranscriptFound:
            return {
                "video_id": video_id,
                "error": "no_transcript",
                "message": "No transcript available for this video.",
            }

        full_text = " ".join(entry["text"].strip() for entry in transcript_list)

        segments = [
            {"text": e["text"], "start": e["start"], "duration": e.get("duration", 0)}
            for e in transcript_list
        ]

        hook_text = " ".join(s["text"] for s in segments if s["start"] < 60)

        if segments:
            total_duration = segments[-1]["start"]
            cta_cutoff = max(0, total_duration - 90)
            cta_text = " ".join(s["text"] for s in segments if s["start"] >= cta_cutoff)
            body_text = " ".join(
                s["text"] for s in segments if 60 <= s["start"] < (total_duration - 90)
            )
        else:
            total_duration = 0
            cta_text = ""
            body_text = ""

        return {
            "video_id": video_id,
            "language": language,
            "total_segments": len(transcript_list),
            "estimated_duration_seconds": total_duration,
            "full_text": full_text,
            "word_count": len(full_text.split()),
            "sections": {"hook": hook_text, "body": body_text, "cta": cta_text},
            "raw_segments": transcript_list,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcript fetch failed: {str(e)}")


@app.post("/api/youtube/batch-transcripts")
async def batch_fetch_transcripts(video_ids: str = Form(...), language: str = Form("en")):
    """
    Fetches transcripts for multiple videos in one call.
    Skips videos with no transcripts rather than failing.
    """
    ids = [vid.strip() for vid in video_ids.split(",") if vid.strip()]
    results = []

    for video_id in ids:
        clean_id = _extract_video_id(video_id)
        try:
            transcript_list = _fetch_transcript_segments(clean_id, language)
            full_text = " ".join(entry["text"].strip() for entry in transcript_list)

            hook_text = " ".join(s["text"] for s in transcript_list if s["start"] < 60)

            if transcript_list:
                last_start = transcript_list[-1]["start"]
                cta_text = " ".join(
                    s["text"] for s in transcript_list if s["start"] >= max(0, last_start - 90)
                )
            else:
                cta_text = ""

            results.append(
                {
                    "video_id": clean_id,
                    "status": "success",
                    "word_count": len(full_text.split()),
                    "full_text": full_text,
                    "hook_text": hook_text,
                    "cta_text": cta_text,
                }
            )
        except Exception as e:
            results.append(
                {
                    "video_id": clean_id,
                    "status": "failed",
                    "error": str(e),
                    "full_text": None,
                }
            )

    successful = [r for r in results if r["status"] == "success"]

    return {
        "total_requested": len(ids),
        "total_fetched": len(successful),
        "total_failed": len(ids) - len(successful),
        "results": results,
    }


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
