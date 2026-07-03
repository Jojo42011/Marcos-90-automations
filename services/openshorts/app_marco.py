"""
Marco Puga Realty — OpenShorts FastAPI wrapper
"""
import os
import re
import time
import uuid
import json
import shutil
import subprocess
import traceback
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

try:
    import resource  # POSIX only — available on the Fly/Linux runtime
except ImportError:
    resource = None

from fastapi import FastAPI, File, UploadFile, Form, HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

import main_marco  # noqa: F401 — patches openshorts when available

import captions_marco
from llm_analysis import any_llm_configured, configured_llm_summary

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
    # Phase 4c — veryfast over fast: 3-5x faster encode for a quality delta
    # that's negligible at social-media output resolution/bitrate.
    result = subprocess.run(
        [
            "ffmpeg", "-y",
            "-ss", str(start_time),
            "-to", str(end_time),
            "-i", input_path,
            "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
            "-c:a", "aac",
            output_path,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg cut failed: {result.stderr.decode()[-500:]}")
    return output_path


def validate_video_file(video_path: str) -> bool:
    """Return True if ffprobe can read the file (format/duration)."""
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                video_path,
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        return result.returncode == 0
    except Exception:
        return False


def _fail_job(job_id: str, error_detail: str) -> None:
    jobs[job_id].update({"status": "failed", "error": error_detail, "updated_at": time.time()})
    print(f"[ERROR] Job {job_id} failed: {error_detail}")


def _resource_snapshot() -> str:
    """Best-effort CPU/memory snapshot using stdlib only (no psutil dependency)."""
    parts = []
    try:
        load1, load5, load15 = os.getloadavg()
        parts.append(f"load={load1:.2f}/{load5:.2f}/{load15:.2f}")
    except (OSError, AttributeError):
        pass
    if resource is not None:
        try:
            rss_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
            parts.append(f"rss={rss_mb:.0f}MB")
        except Exception:
            pass
    return " ".join(parts) if parts else "unavailable"


class _StageTimer:
    """Tracks per-stage wall-clock time for one job and logs + records it on transition."""

    def __init__(self, job_id: str):
        self.job_id = job_id
        self.stage_name = "queued"
        self.stage_started_at = time.monotonic()
        self.job_started_at = self.stage_started_at

    def transition(self, next_status: str) -> None:
        elapsed = time.monotonic() - self.stage_started_at
        print(
            f"[openshorts] Job {self.job_id} stage '{self.stage_name}' took {elapsed:.1f}s "
            f"({_resource_snapshot()})"
        )
        jobs[self.job_id].setdefault("stage_timings", {})[self.stage_name] = round(elapsed, 1)
        jobs[self.job_id]["status"] = next_status
        jobs[self.job_id]["updated_at"] = time.time()
        self.stage_name = next_status
        self.stage_started_at = time.monotonic()

    def finish(self) -> None:
        elapsed = time.monotonic() - self.stage_started_at
        total = time.monotonic() - self.job_started_at
        print(
            f"[openshorts] Job {self.job_id} stage '{self.stage_name}' took {elapsed:.1f}s — "
            f"total job time {total:.1f}s ({_resource_snapshot()})"
        )
        jobs[self.job_id].setdefault("stage_timings", {})[self.stage_name] = round(elapsed, 1)
        jobs[self.job_id]["total_seconds"] = round(total, 1)


def check_disk_space(path: str, required_mb: int = 500) -> tuple[bool, int]:
    """Check if enough disk space is available. Returns (ok, available_mb)."""
    try:
        usage = shutil.disk_usage(path)
        available_mb = usage.free // (1024 * 1024)
        return available_mb >= required_mb, available_mb
    except Exception:
        return True, -1


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

@asynccontextmanager
async def lifespan(_app: FastAPI):
    if _anthropic_key := os.environ.get("ANTHROPIC_API_KEY", "").strip():
        if _anthropic_key.startswith("sk-ant-"):
            print(f"ANTHROPIC_API_KEY configured: {_anthropic_key[:8]}...")
        else:
            print(
                f"[content-ai] WARNING: ANTHROPIC_API_KEY invalid format (got {_anthropic_key[:8]}…, "
                f"expected sk-ant-…) — will use fallback LLM if available"
            )
    else:
        print("[content-ai] NOTE: ANTHROPIC_API_KEY not set — will use OpenAI for clip analysis")

    if _openai_key := os.environ.get("OPENAI_API_KEY", "").strip():
        print(f"OPENAI_API_KEY configured: {_openai_key[:8]}...")

    if not any_llm_configured():
        print("[content-ai] WARNING: No LLM configured for clip analysis (need ANTHROPIC_API_KEY or OPENAI_API_KEY)")
    else:
        print(f"Clip analysis LLM providers available: {configured_llm_summary()}")

    if openshorts_main is None:
        print("FATAL: OpenShorts main module not available — run setup-openshorts.sh")
    else:
        print(f"OpenShorts engine loaded: {openshorts_main.__file__}")

    try:
        import faster_whisper  # noqa: F401

        print("faster-whisper loaded: version available")
    except ImportError as e:
        print(f"FATAL: faster-whisper import failed: {e}")

    yield


app = FastAPI(title="OpenShorts — Marco Puga Realty", version="1.0.0", lifespan=lifespan)

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


def process_video_job(
    job_id: str,
    video_path: str,
    pillar: str,
    trend_brief: str,
    target_clips: int,
    enable_captions: bool = True,
):
    """
    Runs the actual video processing. This is intentionally a PLAIN (synchronous)
    function, not `async def`. FastAPI/Starlette dispatch BackgroundTasks
    differently based on that: an `async def` task is awaited directly on the
    main event loop, while a plain `def` task is run in a worker thread via
    anyio's threadpool. Every call in this function (faster-whisper, ffmpeg
    subprocesses, the OpenCV/MediaPipe reframe loop) is fully synchronous and
    CPU/subprocess-bound with no internal `await`, so previously — declared
    `async def` — this ran directly on the event loop and blocked it for the
    entire job, meaning /health and /api/jobs/:id could not respond to ANY
    request while a job was in progress. That's what produced the "status
    check timed out ... sidecar busy" loop. Keeping this synchronous moves the
    work onto a separate thread so the event loop (and its two endpoints)
    stays responsive throughout.
    """
    timer = _StageTimer(job_id)
    try:
        if openshorts_main is None:
            raise RuntimeError("OpenShorts not installed — run setup-openshorts.sh")

        disk_root = "/data" if os.path.exists("/data") else str(CLIPS_OUTPUT_DIR.parent)
        has_space, available_mb = check_disk_space(disk_root, required_mb=500)
        if not has_space:
            error_msg = (
                f"Insufficient disk space: only {available_mb}MB available, need 500MB minimum. "
                "Run disk cleanup on /data/clips and /data/uploads."
            )
            print(f"[ERROR] {error_msg}")
            _fail_job(job_id, error_msg)
            return

        print(f"[openshorts] Disk space OK: {available_mb}MB available")
        if enable_captions:
            print(f"[openshorts] Burned-in captions enabled: word-highlight karaoke style, lower third")
        else:
            print(f"[openshorts] Captions disabled for this job")

        if not validate_video_file(video_path):
            error_detail = (
                "Video file could not be read — check format "
                f"(ffprobe failed on {video_path})"
            )
            print(f"[ERROR] {error_detail}")
            _fail_job(job_id, error_detail)
            return

        timer.transition("transcribing")
        try:
            transcript = openshorts_main.transcribe_video(video_path)
        except Exception as transcribe_err:
            error_detail = (
                f"Transcription failed: {type(transcribe_err).__name__}: {transcribe_err}"
            )
            print(f"[ERROR] {error_detail}")
            traceback.print_exc()
            _fail_job(job_id, error_detail)
            return

        timer.transition("analyzing")
        try:
            # transcribe_video() does not return duration — probe the file directly.
            video_duration = transcript.get("duration") or _probe_duration(video_path)
            clips_data = main_marco.get_viral_clips_marco(
                transcript_result=transcript,
                video_duration=video_duration,
                pillar=pillar,
                trend_brief=trend_brief,
                target_clips=target_clips,
            )
        except Exception as analyze_err:
            error_detail = (
                f"AI analysis failed: {type(analyze_err).__name__}: {analyze_err}"
            )
            print(f"[ERROR] {error_detail}")
            traceback.print_exc()
            _fail_job(job_id, error_detail)
            return

        timer.transition("reframing")
        output_clips = []
        clip_errors = []
        clip_output_dir = CLIPS_OUTPUT_DIR / job_id
        clip_output_dir.mkdir(parents=True, exist_ok=True)

        # Boundary between analysis output and reframing input. Log what actually
        # arrived and fail with a specific message (not the generic "no clips")
        # if analysis handed off nothing usable.
        clips_list = clips_data.get("clips", [])
        print(
            f"[openshorts] analysis handed off {len(clips_list)} clip(s) to reframing; "
            f"first-clip keys: {sorted(clips_list[0].keys()) if clips_list else 'none'}"
        )
        if not clips_list:
            _fail_job(
                job_id,
                "Analysis produced zero clips — the AI returned no usable timestamps "
                "(see [content-ai] logs for the raw response).",
            )
            return

        for i, clip in enumerate(clips_list):
            try:
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
                    # process_video_to_vertical() takes only (input, output) — no caption kwargs.
                    # Captions are burned in as a separate ffmpeg pass below, after reframing,
                    # so the ASS overlay is never cropped by the vertical reframe step.
                    success = openshorts_main.process_video_to_vertical(clip_path, reframed_path)
                    if success and os.path.exists(reframed_path):
                        final_clip_path = reframed_path
                        try:
                            os.remove(clip_path)
                            print(f"[openshorts] Cleaned up intermediate file: {clip_path}")
                        except Exception as cleanup_err:
                            print(f"[openshorts] Could not remove intermediate file: {cleanup_err}")
                    else:
                        final_clip_path = clip_path
                except Exception as reframe_err:
                    print(f"Reframe failed for clip {i + 1}: {reframe_err}. Using original cut.")
                    final_clip_path = clip_path

                if enable_captions and final_clip_path == reframed_path:
                    ass_path = None
                    try:
                        cap_width, cap_height = captions_marco.get_video_resolution(reframed_path)
                        ass_path = reframed_path.replace(".mp4", ".ass")
                        ass_file = captions_marco.generate_captions_ass(
                            transcript.get("segments", []),
                            clip_start=clip["start_time"],
                            clip_end=clip["end_time"],
                            video_width=cap_width,
                            video_height=cap_height,
                            output_path=ass_path,
                        )
                        if ass_file:
                            captioned_path = reframed_path.replace("_vertical.mp4", "_captioned.mp4")
                            captions_marco.burn_captions(reframed_path, ass_file, captioned_path)
                            if os.path.exists(captioned_path):
                                final_clip_path = captioned_path
                                os.remove(reframed_path)
                                print(f"[openshorts] Captions burned in for clip {i + 1}")
                        else:
                            print(f"[openshorts] No transcript words in clip {i + 1} range — skipping captions")
                    except Exception as caption_err:
                        print(f"Caption burn-in failed for clip {i + 1}: {caption_err}. Using uncaptioned clip.")
                    finally:
                        try:
                            if ass_path and os.path.exists(ass_path):
                                os.remove(ass_path)
                        except Exception:
                            pass

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
            except Exception as clip_err:
                error_detail = (
                    f"Clip {i + 1} failed: {type(clip_err).__name__}: {clip_err}"
                )
                print(f"[ERROR] {error_detail}")
                traceback.print_exc()
                clip_errors.append(error_detail)

        if not output_clips:
            # Surface why every clip failed instead of the generic message, so a
            # systematic problem (bad timestamps, ffmpeg) is diagnosable at a glance.
            detail = (
                "; ".join(clip_errors[:5])
                if clip_errors
                else "analysis returned no usable clips"
            )
            _fail_job(job_id, f"Reframing produced no clips — {detail}")
            return

        # Phase 5b — re-verify on disk right now, not just that the loop above
        # didn't raise. Guards against a clip having been written then lost
        # (disk pressure, a concurrent cleanup sweep, etc.) between being
        # added to output_clips and this point.
        clips_confirmed_on_disk = [c for c in output_clips if os.path.isfile(c["clip_path"])]
        if not clips_confirmed_on_disk:
            _fail_job(job_id, "Clips were generated but none are present on disk at completion time")
            return
        if len(clips_confirmed_on_disk) < len(output_clips):
            print(
                f"[openshorts] WARNING: {len(output_clips) - len(clips_confirmed_on_disk)} clip(s) "
                f"went missing between generation and completion — proceeding with the "
                f"{len(clips_confirmed_on_disk)} confirmed on disk"
            )
            output_clips = clips_confirmed_on_disk

        timer.finish()
        jobs[job_id].update(
            {
                "status": "complete",
                "clips": output_clips,
                "total_clips": len(output_clips),
                "transcript": transcript.get("text", "")[:500],
            },
        )

        try:
            if video_path.startswith("/data/uploads/") and os.path.isfile(video_path):
                st = os.stat(video_path)
                os.remove(video_path)
                freed_gb = st.st_size / (1024 ** 3)
                print(f"[cleanup] Source deleted: {os.path.basename(video_path)} ({freed_gb:.2f}GB freed)")
                try:
                    free_mb = shutil.disk_usage("/data" if os.path.exists("/data") else ".").free / (1024 * 1024)
                    print(f"[cleanup] /data now has {free_mb / 1024:.1f}GB free")
                except Exception:
                    pass
        except Exception as cleanup_err:
            print(f"[openshorts] Could not clean up source video: {cleanup_err}")

    except Exception as e:
        error_detail = f"{type(e).__name__}: {e}"
        print(f"[ERROR] Job {job_id} failed: {error_detail}")
        traceback.print_exc()
        _fail_job(job_id, error_detail)


@app.post("/api/process")
async def process_video(
    background_tasks: BackgroundTasks,
    file: Optional[UploadFile] = File(None),
    file_path: Optional[str] = Form(None),
    pillar: str = Form("brand"),
    trend_brief: str = Form(""),
    target_clips: int = Form(7),
    enable_captions: str = Form("true"),
):
    if not any_llm_configured():
        raise HTTPException(
            status_code=400,
            detail="LLM API key required — set ANTHROPIC_API_KEY (sk-ant-…) or OPENAI_API_KEY",
        )

    job_id = str(uuid.uuid4())

    if file_path and Path(file_path).exists():
        video_path = file_path
    elif file:
        # Phase 4a — stream to disk in chunks instead of `await file.read()`,
        # which buffers the entire upload in RAM before writing a single byte.
        # For a 4GB file that's a 4GB RSS spike for no reason. This branch
        # isn't on the normal Node -> sidecar path (that sends file_path, see
        # above) but closes the gap for any direct multipart call.
        save_path = UPLOADS_INPUT_DIR / f"{job_id}_{file.filename}"
        save_path.parent.mkdir(parents=True, exist_ok=True)
        chunk_size = 8 * 1024 * 1024  # 8MB
        with open(save_path, "wb") as f:
            while chunk := await file.read(chunk_size):
                f.write(chunk)
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
        "created_at": time.time(),
        "updated_at": time.time(),
        "stage_timings": {},
    }

    # process_video_job is a plain (sync) function — see its docstring for why
    # that matters. BackgroundTasks runs sync callables in a worker thread,
    # keeping this event loop (and /health, /api/jobs/:id) responsive during
    # the job instead of blocking on it.
    background_tasks.add_task(
        process_video_job,
        job_id=job_id,
        video_path=video_path,
        pillar=pillar,
        trend_brief=trend_brief,
        target_clips=target_clips,
        enable_captions=(enable_captions.lower() == "true"),
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
    """
    Extract an 11-char YouTube video ID from any URL form
    (watch?v=, youtu.be/, /shorts/, /embed/, /v/) or return the input
    unchanged if it already looks like a bare ID.
    """
    raw = (raw or "").strip()
    match = re.search(r"(?:v=|/shorts/|youtu\.be/|/embed/|/v/)([a-zA-Z0-9_-]{11})", raw)
    if match:
        return match.group(1)
    # No URL pattern matched — assume it's already a bare video ID.
    return raw


def _fetch_transcript_segments(video_id: str, language: str):
    """
    Fetch a transcript as a list of {text, start, duration} dicts using the
    youtube-transcript-api v1.x instance API (the v0.x static
    get_transcript()/list_transcripts() were removed in v1.0.0). Prefers a
    manually-created caption track and falls back to an auto-generated one.
    Retries once after a short pause on a transient (network/rate) error;
    re-raises the deterministic "no captions" exceptions so callers classify
    them. Raises on failure.
    """
    from youtube_transcript_api import (
        YouTubeTranscriptApi,
        NoTranscriptFound,
        TranscriptsDisabled,
        VideoUnavailable,
    )

    # Preferred languages, de-duped while preserving order.
    langs, seen = [], set()
    for lang in [language, "en", "en-US"]:
        if lang and lang not in seen:
            seen.add(lang)
            langs.append(lang)

    def _attempt():
        api = YouTubeTranscriptApi()
        transcripts = api.list(video_id)
        try:
            transcript = transcripts.find_manually_created_transcript(langs)
        except NoTranscriptFound:
            transcript = transcripts.find_generated_transcript(langs)
        # .to_raw_data() -> list of {text, start, duration} dicts (v0.x shape),
        # so downstream dict access keeps working unchanged.
        return transcript.fetch().to_raw_data()

    try:
        return _attempt()
    except (NoTranscriptFound, TranscriptsDisabled, VideoUnavailable):
        raise  # deterministic no-captions outcome — do not retry
    except Exception as err:
        print(f"[youtube-transcript] {video_id}: transient error, retrying once in 2s — {err}")
        time.sleep(2)
        return _attempt()


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
            # A single video without captions must never block the rest of the
            # analysis — log clearly and skip it, continuing with the others.
            print(f"[youtube-transcript] skipping {clean_id}: {type(e).__name__}: {e}")
            results.append(
                {
                    "video_id": clean_id,
                    "status": "failed",
                    "error": str(e),
                    "full_text": None,
                }
            )

    successful = [r for r in results if r["status"] == "success"]
    print(
        f"[youtube-transcript] batch complete: {len(successful)}/{len(ids)} transcripts fetched"
    )

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
        "model": configured_llm_summary() or "none",
        "llm_providers": configured_llm_summary(),
        "clips_dir": str(CLIPS_OUTPUT_DIR),
        "openshorts_installed": openshorts_main is not None,
        "active_jobs": len(
            [j for j in jobs.values() if j["status"] not in ["complete", "failed"]],
        ),
    }


if __name__ == "__main__":
    port = int(os.environ.get("OPENSHORTS_PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
