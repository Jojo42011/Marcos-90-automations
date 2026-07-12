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
import threading
import traceback
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

try:
    import resource  # POSIX only — available on the Fly/Linux runtime
except ImportError:
    resource = None

# Serialize heavy video jobs. Concurrent ffmpeg + OpenCV/MediaPipe reframe passes
# each hold ~1-2GB of decoded frames; two at once on a 4GB machine trips the
# kernel OOM killer (which is what was killing ffmpeg mid-job). Default to one
# job at a time; raise OPENSHORTS_MAX_CONCURRENT_JOBS if the machine is bigger.
_MAX_CONCURRENT_JOBS = max(1, int(os.environ.get("OPENSHORTS_MAX_CONCURRENT_JOBS", "1")))
_PROCESS_SLOT = threading.Semaphore(_MAX_CONCURRENT_JOBS)
# Refuse to start a job if free memory is already below this floor, rather than
# starting and getting silently OOM-killed after minutes of apparent progress.
_MIN_MEMORY_MB = int(os.environ.get("OPENSHORTS_MIN_MEMORY_MB", "700"))
# Cap how long a queued job waits for a free slot before failing clearly.
_SLOT_WAIT_TIMEOUT_S = int(os.environ.get("OPENSHORTS_SLOT_WAIT_TIMEOUT_S", "900"))
# Hard timeout for a single ffmpeg cut/caption pass. A clip re-encode at
# <=1080p/veryfast finishes in well under a minute; if ffmpeg hasn't returned
# in this window it is hung — kill it and fail that clip fast instead of the
# whole job silently polling to the 960s ceiling.
_FFMPEG_TIMEOUT_S = int(os.environ.get("OPENSHORTS_FFMPEG_TIMEOUT_S", "180"))
# Overall wall-clock budget for one job (transcription + all clips). Bounds how
# long a single job can hold the processing slot so one bad video can't freeze
# the whole batch. Default is 2 hours; set OPENSHORTS_JOB_MAX_SECONDS=0 to disable.
_JOB_MAX_SECONDS = int(os.environ.get("OPENSHORTS_JOB_MAX_SECONDS", "7200"))

# Generation-time automatic dead-air removal. When on, every freshly generated
# clip has clear dead air removed and its captions re-synced, so new clips come
# out tight without Marco touching the editor. DEAD AIR ONLY — intentional
# dramatic pauses (short + sentence-final) are preserved, and filler-word removal
# stays a manual editor choice. Best-effort: any error/low-memory/negligible
# saving leaves the clip untouched (never fails or fatally slows a job).
AUTO_TIGHTEN_CLIPS = os.environ.get("AUTO_TIGHTEN_CLIPS", "true").strip().lower() in ("1", "true", "yes", "on")
_AUTO_TIGHTEN_MAX_GAP = float(os.environ.get("AUTO_TIGHTEN_MAX_GAP", "0.6"))
_AUTO_TIGHTEN_MIN_SAVINGS = float(os.environ.get("AUTO_TIGHTEN_MIN_SAVINGS", "0.5"))
# Full-timeline smart cuts (generation time): remove sustained looking-away
# segments and inferior repeated takes from freshly generated clips, through
# the same keep/cut/concat + caption-resync path as dead-air removal.
GAZE_CUTS = os.environ.get("OPENSHORTS_GAZE_CUTS", "true").strip().lower() in ("1", "true", "yes", "on")
TAKE_CUTS = os.environ.get("OPENSHORTS_TAKE_CUTS", "true").strip().lower() in ("1", "true", "yes", "on")
# Generation-time auto-zoom: subtle zoom-in/zoom-out emphasis pairs at the
# highest speech-density moments (Submagic-style dynamic feel). Applied to the
# reframed clip BEFORE captions so the caption text is never scaled.
AUTO_ZOOM = os.environ.get("OPENSHORTS_AUTO_ZOOM", "true").strip().lower() in ("1", "true", "yes", "on")
_AUTO_ZOOM_AMOUNT = float(os.environ.get("OPENSHORTS_AUTO_ZOOM_AMOUNT", "0.05"))
# Pexels B-roll overlay (optional): requires PEXELS_API_KEY. Dormant without it.
BROLL_ENABLED = (
    os.environ.get("OPENSHORTS_BROLL", "true").strip().lower() in ("1", "true", "yes", "on")
    and bool(os.environ.get("PEXELS_API_KEY", "").strip())
)

from fastapi import FastAPI, File, UploadFile, Form, HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

import main_marco  # noqa: F401 — patches openshorts when available

import captions_marco
import audio_features_marco
import edit_effects_marco
import gaze_analysis_marco
import take_analysis_marco
import broll_marco
from llm_analysis import any_llm_configured, configured_llm_summary, NoUsableClipsError

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


def _cut_clip(
    input_path: str,
    output_path: str,
    start_time: float,
    end_time: float,
    audio_fade_s: float = 0.0,
) -> str:
    """Cut a precise sub-clip with ffmpeg (re-encode for frame accuracy).

    audio_fade_s: when > 0 and the segment is long enough, a tiny fade-in at
    the start and fade-out at the end are baked in. At 0.035s they are
    imperceptible to the ear but eliminate the audio click/pop at hard-cut
    splice points, making multi-segment joins feel seamless.
    """
    # Phase 4c — veryfast over fast: 3-5x faster encode for a quality delta
    # that's negligible at social-media output resolution/bitrate.
    dur = max(0.1, end_time - start_time)
    cmd = [
        "ffmpeg", "-y",
        "-ss", str(start_time),
        "-to", str(end_time),
        "-i", input_path,
        # Cap height at 1080p-vertical (1920) so the downstream reframe and
        # caption passes decode ~1080p frames instead of full 4K. Re-encoding
        # a 4K source is what spiked ffmpeg to ~2GB RSS and tripped the OOM
        # killer; 1920 tall is plenty for a 1080x1920 vertical output. The
        # single quotes protect the comma in min() from ffmpeg's filtergraph
        # parser. -threads 2 matches the 2-core machine and bounds the frame
        # buffers each encoder thread holds.
        "-vf", "scale=-2:'min(1920,ih)'",
        "-threads", "2",
        "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
    ]
    if audio_fade_s > 0 and dur > audio_fade_s * 4:
        fade_out_start = max(0.0, dur - audio_fade_s)
        cmd += [
            "-af",
            f"afade=t=in:st=0:d={audio_fade_s:.3f},afade=t=out:st={fade_out_start:.3f}:d={audio_fade_s:.3f}",
            "-c:a", "aac",
        ]
    else:
        cmd += ["-c:a", "aac"]
    cmd.append(output_path)
    result = subprocess.run(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=_FFMPEG_TIMEOUT_S,
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


def _available_memory_mb() -> Optional[int]:
    """Free-to-use RAM in MB from /proc/meminfo (MemAvailable), or None if unknown."""
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except Exception:
        return None
    return None


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
    user_context: str = "",
    script_text: str = "",
    enable_auto_zoom: Optional[bool] = None,
    enable_broll: Optional[bool] = None,
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
    slot_acquired = False
    # Per-job enhancement flags: explicit request value wins, else env default.
    auto_zoom_on = AUTO_ZOOM if enable_auto_zoom is None else enable_auto_zoom
    broll_on = BROLL_ENABLED if enable_broll is None else (enable_broll and broll_marco.enabled())
    try:
        # Serialize heavy jobs so concurrent ffmpeg/reframe passes don't stack up
        # and trip the OOM killer. While waiting the job stays "queued".
        if not _PROCESS_SLOT.acquire(timeout=_SLOT_WAIT_TIMEOUT_S):
            _fail_job(
                job_id,
                f"Timed out after {_SLOT_WAIT_TIMEOUT_S}s waiting for a free processing "
                "slot — another job is still running.",
            )
            return
        slot_acquired = True

        # Memory guard: fail early and clearly if RAM is already low, instead of
        # starting the encode and getting silently OOM-killed minutes later.
        avail_mb = _available_memory_mb()
        print(f"[openshorts] Job {job_id} acquired processing slot — {avail_mb}MB memory available")
        if avail_mb is not None and avail_mb < _MIN_MEMORY_MB:
            _fail_job(
                job_id,
                f"Not enough memory to start safely: {avail_mb}MB available, need "
                f"~{_MIN_MEMORY_MB}MB. Retry once other work finishes.",
            )
            return

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
        # transcribe_video() does not return duration — probe the file directly.
        video_duration = transcript.get("duration") or _probe_duration(video_path)

        # Guard: catch hallucinated / empty / non-speech transcripts BEFORE the
        # expensive AI analysis call. faster-whisper hallucinates fluent text
        # (often in a wrong language) on silent/non-speech audio; sending that to
        # the model wastes an analysis call and produces a confusing failure.
        quality = main_marco.assess_transcript_quality(transcript, video_duration)
        if not quality["ok"]:
            print(
                f"[openshorts] Job {job_id} transcript rejected before analysis: "
                f"{quality['debug']} | signals={quality['signals']}"
            )
            _fail_job(job_id, quality["message"])
            return

        try:
            clips_data = main_marco.get_viral_clips_marco(
                transcript_result=transcript,
                video_duration=video_duration,
                pillar=pillar,
                trend_brief=trend_brief,
                target_clips=target_clips,
                video_path=video_path,
                user_context=user_context,
                script_text=script_text,
            )
        except NoUsableClipsError as no_clips:
            # The model responded fine but found no viable clip moments — a
            # content outcome, not an API/auth failure. Distinct, honest message.
            print(f"[openshorts] Job {job_id} — no usable clips: {no_clips}")
            _fail_job(
                job_id,
                "The AI reviewed the transcript but found no viable clip moments in this "
                "video. Try a longer clip, or one with clearer talking-head content.",
            )
            return
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
            # Per-job wall-clock budget: stop starting new clips once the job has
            # run too long, so one slow/stuck video can't hold the processing
            # slot (and freeze the queue behind it) indefinitely. Whatever clips
            # already succeeded are kept; if none, the check below fails clearly.
            elapsed = time.monotonic() - timer.job_started_at
            if _JOB_MAX_SECONDS > 0 and elapsed > _JOB_MAX_SECONDS:
                print(
                    f"[openshorts] Job {job_id} hit the {_JOB_MAX_SECONDS}s budget after "
                    f"{elapsed:.0f}s — stopping with {len(output_clips)} clip(s) done, "
                    f"skipping the remaining {len(clips_list) - i}"
                )
                clip_errors.append(
                    f"Job exceeded {_JOB_MAX_SECONDS}s budget; {len(clips_list) - i} clip(s) skipped"
                )
                break
            try:
                clip_id = str(uuid.uuid4())
                clip_filename = f"clip_{i + 1}_{clip_id[:8]}.mp4"
                thumbnail_filename = f"thumb_{i + 1}_{clip_id[:8]}.jpg"
                clip_path = str(clip_output_dir / clip_filename)
                thumb_path = str(clip_output_dir / thumbnail_filename)
                # What actually got applied to THIS clip — travels with the
                # result so the dashboard can badge it.
                clip_enhancements: list[str] = []

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
                        clip_enhancements.append("vertical_reframe")
                        # Visual polish BEFORE captions so caption text is never
                        # scaled by zoom or covered logic-side by b-roll (it
                        # renders on top). Both best-effort, in-place.
                        if auto_zoom_on and _apply_auto_zoom_pass(
                            reframed_path, transcript.get("segments", []),
                            clip["start_time"], clip["end_time"], i + 1,
                        ):
                            clip_enhancements.append("auto_zoom")
                        if broll_on and broll_marco.apply_broll(
                            reframed_path, transcript.get("segments", []),
                            clip["start_time"], clip["end_time"], i + 1,
                        ):
                            clip_enhancements.append("broll")
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
                    ass_kept = False
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
                                clip_enhancements.append("captions")
                                # Persist the uncaptioned base + ASS next to the clip so the
                                # editor can re-edit captions / re-render without the source
                                # (small: one vertical clip + a text file). Sibling naming
                                # (_base.mp4 / _base.ass) is derived from the clip stem by the
                                # edit engine and protected by disk cleanup while in review.
                                base_kept = reframed_path.replace("_vertical.mp4", "_base.mp4")
                                ass_kept_path = reframed_path.replace("_vertical.mp4", "_base.ass")
                                lines_src = ass_path.replace(".ass", ".lines.json")
                                lines_kept = reframed_path.replace("_vertical.mp4", "_base.lines.json")
                                try:
                                    os.replace(reframed_path, base_kept)
                                    os.replace(ass_path, ass_kept_path)
                                    if os.path.exists(lines_src):
                                        os.replace(lines_src, lines_kept)
                                    ass_kept = True
                                    print(f"[openshorts] Captions burned in for clip {i + 1}; persisted editable base+ASS")
                                except Exception as persist_err:
                                    print(f"[openshorts] Could not persist base/ASS for clip {i + 1}: {persist_err}")
                                    if os.path.exists(reframed_path):
                                        try:
                                            os.remove(reframed_path)
                                        except Exception:
                                            pass
                        else:
                            print(f"[openshorts] No transcript words in clip {i + 1} range — skipping captions")
                    except Exception as caption_err:
                        print(f"Caption burn-in failed for clip {i + 1}: {caption_err}. Using uncaptioned clip.")
                    finally:
                        # Only delete the ASS if we did NOT keep it as the editable copy.
                        try:
                            if ass_path and not ass_kept and os.path.exists(ass_path):
                                os.remove(ass_path)
                        except Exception:
                            pass

                # Phase 1 (this task) — automatic dead-air removal. Runs only when
                # the editable base+lines were persisted (final is the captioned
                # clip). Best-effort: on None nothing changes. On success we swap in
                # the tightened clip AND update the persisted base+lines so the
                # manual editor stays consistent with the delivered clip.
                if AUTO_TIGHTEN_CLIPS and enable_captions and final_clip_path.endswith("_captioned.mp4") and os.path.isfile(final_clip_path):
                    base_p = final_clip_path.replace("_captioned.mp4", "_base.mp4")
                    lines_p = final_clip_path.replace("_captioned.mp4", "_base.lines.json")
                    # Full-timeline smart cuts for THIS clip: sustained away-looks
                    # + inferior repeated takes, rebased to clip-local time.
                    extra_cuts: list[tuple[float, float]] = []
                    retake_cuts: list[tuple[float, float]] = []
                    try:
                        if GAZE_CUTS:
                            raw_gaze = gaze_analysis_marco.away_cut_candidates(
                                clips_data.get("gaze", {}), clip["start_time"], clip["end_time"]
                            )
                            if raw_gaze:
                                # Snap each gaze cut to the nearest word boundary so cuts
                                # fall in the natural silence between spoken words instead
                                # of mid-word (avoids the "sharp and abrupt" feel). Words
                                # are sliced to THIS clip (clip-local) so a boundary can
                                # never snap to a word outside the clip.
                                _words = [
                                    (w["start"], w["end"])
                                    for w in captions_marco.slice_words_for_clip(
                                        transcript.get("segments", []),
                                        clip["start_time"], clip["end_time"],
                                    )
                                ]
                                for gc in raw_gaze:
                                    extra_cuts.append(_snap_cut_to_words(gc, _words))
                        if TAKE_CUTS:
                            retake_cuts += take_analysis_marco.inferior_cut_candidates(
                                clips_data.get("retakes", {}), clip["start_time"], clip["end_time"]
                            )
                        if extra_cuts or retake_cuts:
                            print(
                                f"[openshorts] Clip {i + 1}: {len(extra_cuts)} gaze + "
                                f"{len(retake_cuts)} retake smart-cut candidate(s)"
                            )
                    except Exception as smart_err:
                        print(f"[openshorts] smart-cut candidates failed for clip {i + 1}: {smart_err}")
                        extra_cuts = []
                        retake_cuts = []
                    tightened = _auto_tighten_generated_clip(
                        base_p, lines_p, i + 1, extra_cuts=extra_cuts, retake_cuts=retake_cuts
                    )
                    if tightened:
                        try:
                            old_final = final_clip_path
                            os.replace(tightened["tight_base"], base_p)  # keep base consistent
                            with open(lines_p, "w") as lf:
                                json.dump(tightened["new_lines"], lf)
                            final_clip_path = tightened["new_captioned"]
                            if old_final != final_clip_path and os.path.exists(old_final):
                                os.remove(old_final)
                            clip_enhancements.append("smart_cuts")
                            print(
                                f"[openshorts] Clip {i + 1} auto-tightened: removed {tightened['removed']}s dead air "
                                f"across {tightened['cuts']} cut(s) → {tightened['new_duration']:.1f}s"
                            )
                        except Exception as swap_err:
                            print(f"[openshorts] auto-tighten swap failed for clip {i + 1} (keeping original): {swap_err}")

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
                        # Actual delivered length (shorter than end-start when the
                        # clip was auto-tightened); falls back to the source span.
                        "duration": _probe_duration(final_clip_path) or (clip["end_time"] - clip["start_time"]),
                        "viral_score": clip.get("viral_score", 50),
                        "hook_type": clip.get("hook_type", "uncategorized"),
                        "hook_preview": clip.get("hook_preview", ""),
                        "transcript_segment": clip.get("why_this_clip", ""),
                        "suggested_title": clip.get("suggested_title", f"Clip {i + 1}"),
                        "suggested_caption": clip.get("suggested_caption", ""),
                        "pillar": clip.get("pillar", pillar),
                        "why_this_clip": clip.get("why_this_clip", ""),
                        "enhancements_applied": clip_enhancements,
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
    finally:
        if slot_acquired:
            _PROCESS_SLOT.release()


@app.post("/api/process")
async def process_video(
    background_tasks: BackgroundTasks,
    file: Optional[UploadFile] = File(None),
    file_path: Optional[str] = Form(None),
    pillar: str = Form("brand"),
    trend_brief: str = Form(""),
    target_clips: int = Form(7),
    enable_captions: str = Form("true"),
    # Per-job enhancement overrides. Empty string = use the env default
    # (OPENSHORTS_AUTO_ZOOM / PEXELS_API_KEY presence); "true"/"false" override.
    enable_auto_zoom: str = Form(""),
    enable_broll: str = Form(""),
    # Human direction: what the uploader said to focus on, and any script text.
    # Both are injected into the viral-moment prompt so the AI cuts with
    # direction instead of guessing.
    user_context: str = Form(""),
    script_text: str = Form(""),
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
        "user_context": user_context,
        "script_text": script_text,
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
    def _tri(v: str) -> Optional[bool]:
        v = (v or "").strip().lower()
        if v in ("1", "true", "yes", "on"):
            return True
        if v in ("0", "false", "no", "off"):
            return False
        return None  # absent → env default

    background_tasks.add_task(
        process_video_job,
        job_id=job_id,
        video_path=video_path,
        pillar=pillar,
        trend_brief=trend_brief,
        target_clips=target_clips,
        enable_captions=(enable_captions.lower() == "true"),
        user_context=user_context,
        script_text=script_text,
        enable_auto_zoom=_tri(enable_auto_zoom),
        enable_broll=_tri(enable_broll),
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


# Minimum length of a trimmed clip — anything shorter is almost certainly a
# mis-drag and produces an unusable micro-clip.
_MIN_TRIM_SECONDS = float(os.environ.get("OPENSHORTS_MIN_TRIM_SECONDS", "3.0"))
# Auto-tighten floor: smart cuts (gaze/retake/dead-air) will not shorten a
# generated clip below this. The LLM selects clips at ≥35s; after all smart
# cuts the output must remain at least this long so story flow is preserved.
_MIN_AUTO_TIGHTEN_S = float(os.environ.get("OPENSHORTS_MIN_AUTO_TIGHTEN_S", "25.0"))
# Audio fade duration applied at each splice point when segments are joined.
# 35ms is imperceptible to the ear but eliminates the hard-cut pop/click that
# makes multi-segment edits feel jarring. Applied only when > 1 segment.
_SPLICE_FADE_S = float(os.environ.get("OPENSHORTS_SPLICE_FADE_S", "0.035"))
# Trim waits only briefly for the shared processing slot — if a batch job holds
# it, fail fast with a clear "busy" instead of hanging the user's request.
_TRIM_SLOT_WAIT_S = int(os.environ.get("OPENSHORTS_TRIM_SLOT_WAIT_S", "8"))


@app.post("/api/clips/trim")
async def trim_clip(
    clip_path: str = Form(...),
    start: float = Form(...),
    end: float = Form(...),
):
    """
    Re-cut an ALREADY-GENERATED clip to a new [start, end] range (both relative
    to the clip's own timeline, in seconds) and return the new file.

    Reuses the exact batch-pipeline rendering primitive (_cut_clip) and the same
    memory-safety guardrails: the shared processing slot (so a trim never runs
    concurrently with a batch encode), a low-memory pre-check, a disk pre-check,
    and _cut_clip's own ffmpeg timeout + non-zero-exit fail-fast. Captions are
    already burned into the clip's frames, so cutting the clip preserves them in
    sync — no re-transcription. NEVER deletes the original; the caller (Node)
    repoints the clip and cleans up the old file only after this returns success.
    """
    # Confine to the clips dir — never read/write outside it, even if asked.
    clips_root = os.path.realpath(str(CLIPS_OUTPUT_DIR))
    abs_clip = os.path.realpath(clip_path)
    if os.path.commonpath([abs_clip, clips_root]) != clips_root:
        raise HTTPException(status_code=400, detail="clip_path is outside the clips directory")
    if not os.path.isfile(abs_clip):
        raise HTTPException(status_code=410, detail="Clip file no longer available on disk")

    duration = _probe_duration(abs_clip)
    if duration <= 0:
        raise HTTPException(status_code=422, detail="Could not read clip duration (file may be corrupt)")

    # Authoritative range validation against the real file duration.
    if start < 0 or end <= start:
        raise HTTPException(status_code=400, detail="Invalid range: need 0 <= start < end")
    if end > duration + 0.25:
        raise HTTPException(status_code=400, detail=f"End {end:.2f}s exceeds clip duration {duration:.2f}s")
    end = min(end, duration)
    if (end - start) < _MIN_TRIM_SECONDS:
        raise HTTPException(
            status_code=400,
            detail=f"Trimmed length must be at least {_MIN_TRIM_SECONDS:.0f}s (got {end - start:.2f}s)",
        )

    # Serialize against batch jobs — brief wait, then fail fast if busy.
    if not _PROCESS_SLOT.acquire(timeout=_TRIM_SLOT_WAIT_S):
        raise HTTPException(status_code=503, detail="Video processor busy with another job — try again shortly")

    new_path = None
    try:
        avail_mb = _available_memory_mb()
        if avail_mb is not None and avail_mb < _MIN_MEMORY_MB:
            raise HTTPException(
                status_code=503,
                detail=f"Not enough memory to trim safely: {avail_mb}MB available, need ~{_MIN_MEMORY_MB}MB",
            )
        has_space, available_mb = check_disk_space(clips_root, required_mb=300)
        if not has_space:
            raise HTTPException(
                status_code=507,
                detail=f"Insufficient disk space: only {available_mb}MB free, need 300MB to render a trim",
            )

        new_name = f"{Path(abs_clip).stem}_trim_{uuid.uuid4().hex[:8]}.mp4"
        new_path = str(Path(abs_clip).parent / new_name)

        # Same rendering primitive as the batch pipeline, scoped to the new range.
        _cut_clip(input_path=abs_clip, output_path=new_path, start_time=start, end_time=end)

        # Confirm the new file is real and playable BEFORE reporting success, so
        # the caller never repoints the clip at a broken render.
        if not os.path.isfile(new_path) or not validate_video_file(new_path):
            raise HTTPException(status_code=500, detail="Trim produced no readable output file")

        new_duration = _probe_duration(new_path)
        rel_url = os.path.relpath(new_path, clips_root).replace(os.sep, "/")
        print(f"[openshorts] Trimmed {os.path.basename(abs_clip)} -> {new_name} ({new_duration:.1f}s)")
        return {
            "new_clip_path": new_path,
            "new_clip_url": f"/clips/{rel_url}",
            "new_duration": round(new_duration, 2),
        }
    except HTTPException:
        # Clean up any partial output, then re-raise unchanged.
        if new_path and os.path.exists(new_path):
            try:
                os.remove(new_path)
            except Exception:
                pass
        raise
    except Exception as e:
        if new_path and os.path.exists(new_path):
            try:
                os.remove(new_path)
            except Exception:
                pass
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Trim failed: {type(e).__name__}: {e}")
    finally:
        _PROCESS_SLOT.release()


def _concat_segments(segment_paths: list, output_path: str) -> str:
    """Join same-codec segments with the concat DEMUXER (stream copy).

    This is the memory-safe way to splice: benchmarks showed a single
    filter_complex concat spikes to ~3.4GB (OOM risk on the 4GB machine),
    while segment-then-concat-demuxer stays ~300MB (bounded by one re-encode).
    """
    list_path = output_path + ".concat.txt"
    with open(list_path, "w") as f:
        for p in segment_paths:
            f.write(f"file '{os.path.abspath(p)}'\n")
    try:
        result = subprocess.run(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", list_path, "-c", "copy", output_path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=_FFMPEG_TIMEOUT_S,
        )
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg concat failed: {result.stderr.decode()[-500:]}")
        return output_path
    finally:
        try:
            os.remove(list_path)
        except Exception:
            pass


def _strip_audio(input_path: str, output_path: str) -> str:
    """Copy video, drop audio (mute/remove) — no re-encode, trivial cost."""
    result = subprocess.run(
        ["ffmpeg", "-y", "-i", input_path, "-map", "0:v", "-an", "-c:v", "copy", output_path],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=_FFMPEG_TIMEOUT_S,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg mute failed: {result.stderr.decode()[-500:]}")
    return output_path


def _replace_audio(input_video: str, audio_file: str, output_path: str) -> str:
    """Swap in a new audio track (video copied, audio re-encoded to AAC), cut to
    the shorter of the two so a long music file doesn't extend the clip."""
    result = subprocess.run(
        [
            "ffmpeg", "-y", "-i", input_video, "-i", audio_file,
            "-map", "0:v", "-map", "1:a",
            "-c:v", "copy", "-c:a", "aac", "-shortest",
            output_path,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=_FFMPEG_TIMEOUT_S,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg audio replace failed: {result.stderr.decode()[-500:]}")
    return output_path


def _load_caption_lines_from(lines_path: str) -> list:
    """Best-effort read of a persisted caption-lines JSON file. Returns [] on any
    problem (missing file / bad JSON)."""
    try:
        p = Path(lines_path)
        if p.is_file():
            data = json.loads(p.read_text())
            return data if isinstance(data, list) else []
    except Exception as err:  # noqa: BLE001
        print(f"[edit] could not read caption lines {os.path.basename(str(lines_path))}: {err}")
    return []


def _load_caption_lines(abs_clip: str) -> list:
    """Best-effort read of a clip's persisted editable caption lines
    (<base>_base.lines.json). Used so pause classification can tell a
    sentence-final dramatic beat from a mid-sentence stumble."""
    stem = re.sub(r"_(edit|trim)_[0-9a-f]+$", "", Path(abs_clip).stem)
    stem = re.sub(r"_(captioned|vertical)$", "", stem)
    return _load_caption_lines_from(str(Path(abs_clip).parent / f"{stem}_base.lines.json"))


def _apply_visual_pass(input_path: str, output_path: str, filtergraph: str) -> str:
    """Apply a Phase-2 visual filtergraph (colour correct + zoom/punch-in) in one
    re-encode. Audio is stream-copied so A/V sync is untouched; the same
    veryfast/crf18/2-thread profile as _cut_clip keeps memory bounded on the 4GB
    machine."""
    result = subprocess.run(
        [
            "ffmpeg", "-y", "-i", input_path,
            "-vf", filtergraph,
            "-threads", "2",
            "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p",
            "-c:a", "copy",
            output_path,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=_FFMPEG_TIMEOUT_S,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg visual pass failed: {result.stderr.decode()[-500:]}")
    return output_path


def _snap_cut_to_caption_lines(
    cut: tuple[float, float],
    lines: list[dict],
) -> tuple[float, float] | None:
    """Adjust one visual cut so it never slices a caption line in half.

    A cut that covers ≥60% of a caption line swallows the whole line (the
    away-look owns that speech); a cut that merely clips a line's edge is
    truncated at the line boundary instead. Returns None when nothing
    meaningful survives the adjustment.
    """
    s, e = cut
    for ln in lines or []:
        try:
            ls, le = float(ln["start"]), float(ln["end"])
        except (KeyError, TypeError, ValueError):
            continue
        if le <= s or ls >= e or le <= ls:
            continue  # no overlap
        overlap = (min(e, le) - max(s, ls)) / (le - ls)
        if overlap >= 0.6:
            s, e = min(s, ls), max(e, le)  # own the whole line
        elif ls < s < le:
            s = le  # cut starts inside a mostly-kept line — start after it
        elif ls < e < le:
            e = ls  # cut ends inside a mostly-kept line — end before it
    s, e = round(s, 2), round(e, 2)
    if e - s < 0.6 - 1e-6:  # epsilon: 0.6-wide remnants survive float noise
        return None
    return (s, e)


def _snap_cut_to_words(
    cut_local: tuple[float, float],
    words_local: list[tuple[float, float]],
    max_snap_s: float = 1.5,
) -> tuple[float, float]:
    """Snap a clip-local gaze cut to the nearest inter-word gap.

    Gaze cuts applied at raw MediaPipe timestamps can fall mid-word, producing
    jarring abrupt transitions. This moves each boundary to the nearest word
    edge so the edit always cuts in the natural silence between spoken words.

    cut_local: (start, end) in clip-local seconds
    words_local: sorted (ws, we) word timestamps, ALSO clip-local — the caller
        must slice words to the clip range first, so a boundary can never snap
        to a word outside the clip
    max_snap_s: furthest a boundary may move to reach a word edge; a boundary
        with no word edge inside this radius keeps its original position

    Returns a clip-local (start, end), or the original cut unchanged if
    snapping would collapse it below 0.3 s.
    """
    if not words_local:
        return cut_local

    def nearest(target: float, edge_index: int) -> float:
        # edge_index 1 = word ends (for cut starts: cutting after a word ends
        # is inaudible), 0 = word starts (for cut ends: resuming at a word
        # start never chops a word off).
        edge = min(words_local, key=lambda p: abs(p[edge_index] - target))[edge_index]
        return edge if abs(edge - target) <= max_snap_s else target

    new_s = round(max(0.0, nearest(cut_local[0], 1)), 2)
    new_e = round(nearest(cut_local[1], 0), 2)

    if new_e - new_s < 0.3:
        return cut_local  # snapping collapsed the cut — use original
    return (new_s, new_e)


def _auto_zoom_effects(words_local: list, duration: float) -> list:
    """Pick subtle zoom emphasis moments from speech density.

    Each emphasis is a zoom_in immediately followed by a matching zoom_out, so
    the scale eases 1.0 → 1.05 → 1.0 with no snap — the motion always flows.
    One emphasis per clip; a second for clips ≥40s, placed in the later half.
    Windows avoid the first 4s (the hook must stay stable) and the last 6s.
    """
    if duration < 15 or len(words_local) < 12:
        return []
    density: dict[int, int] = {}
    for ws, _we in words_local:
        density[int(ws)] = density.get(int(ws), 0) + 1

    def window_score(t: int) -> int:
        return sum(density.get(s, 0) for s in range(t, t + 3))

    hi = int(duration) - 10
    if hi <= 4:
        return []
    candidates = list(range(4, hi))
    best = max(candidates, key=window_score)
    a = _AUTO_ZOOM_AMOUNT
    effects = [
        {"type": "zoom_in", "start": float(best), "end": float(best + 2.2), "amount": a},
        {"type": "zoom_out", "start": float(best + 2.2), "end": float(best + 4.2), "amount": a},
    ]
    if duration >= 40:
        later = [t for t in range(max(4, int(duration * 0.55)), hi) if abs(t - best) > 10]
        if later:
            b2 = max(later, key=window_score)
            effects += [
                {"type": "zoom_in", "start": float(b2), "end": float(b2 + 2.2), "amount": a},
                {"type": "zoom_out", "start": float(b2 + 2.2), "end": float(b2 + 4.2), "amount": a},
            ]
    return effects


def _apply_auto_zoom_pass(
    reframed_path: str,
    segments: list,
    clip_start: float,
    clip_end: float,
    clip_index: int,
) -> bool:
    """Bake subtle speech-driven zoom emphasis into the reframed clip in place.

    Runs BEFORE the caption burn so caption text is never scaled by the zoom.
    Best-effort: any failure leaves the clip untouched and returns False.
    """
    try:
        duration = _probe_duration(reframed_path)
        words = [
            (w["start"], w["end"])
            for w in captions_marco.slice_words_for_clip(segments, clip_start, clip_end)
        ]
        effects = _auto_zoom_effects(words, duration)
        if not effects:
            return False
        w, h = edit_effects_marco.probe_resolution(reframed_path)
        fps = edit_effects_marco.probe_fps(reframed_path)
        graph = edit_effects_marco.build_visual_filtergraph(effects, None, w, h, fps)
        if not graph:
            return False
        out = reframed_path.replace(".mp4", "_zoom.mp4")
        _apply_visual_pass(reframed_path, out, graph)
        if os.path.isfile(out) and validate_video_file(out):
            os.replace(out, reframed_path)
            zoom_at = ", ".join(
                f"{e['start']:.0f}s" for e in effects if e["type"] == "zoom_in"
            )
            print(f"[openshorts] Clip {clip_index}: auto-zoom applied at {zoom_at}")
            return True
        try:
            if os.path.exists(out):
                os.remove(out)
        except Exception:
            pass
        return False
    except Exception as err:  # noqa: BLE001 — best-effort, never fail the clip
        print(f"[openshorts] auto-zoom failed for clip {clip_index} (keeping original): {err}")
        return False


def _auto_tighten_generated_clip(
    base_path: str,
    lines_path: str,
    clip_index: int,
    extra_cuts: list[tuple[float, float]] | None = None,
    retake_cuts: list[tuple[float, float]] | None = None,
):
    """Generation-time smart cutting for one freshly generated clip.

    Removes dead air (as before) PLUS any `extra_cuts` — clip-local intervals
    from the full-timeline analysis (sustained looking-away segments, inferior
    repeated takes). Visual cuts are snapped to caption-line boundaries so a
    cut never slices a sentence in half; take cuts arrive spanning whole
    segments already. Cuts the UNcaptioned base into keep-segments, re-syncs
    the caption lines to the new shorter timeline, and re-burns them. Returns
    a dict {new_captioned, tight_base, new_lines, removed, cuts, new_duration}
    the caller swaps in — or None to mean "no change, keep the original clip".

    Best-effort by contract: any failure, low memory, or a saving below the
    threshold returns None. Runs inside process_video_job, which already holds
    the single processing slot, so it does not re-acquire it.
    """
    import caption_edit
    tmp: list[str] = []
    try:
        if not os.path.isfile(base_path):
            return None
        lines = _load_caption_lines_from(lines_path)
        avail = _available_memory_mb()
        if avail is not None and avail < _MIN_MEMORY_MB:
            print(f"[openshorts] auto-tighten skipped for clip {clip_index} (low memory {avail}MB)")
            return None
        duration = _probe_duration(base_path)
        if duration <= 0:
            return None

        pauses = audio_features_marco.detect_pauses(
            base_path, noise_db=-30.0, min_silence_s=min(_AUTO_TIGHTEN_MAX_GAP, 0.45)
        )
        classified = edit_effects_marco.classify_pauses(pauses, lines, max_keep_gap=_AUTO_TIGHTEN_MAX_GAP)
        deadair = edit_effects_marco.deadair_cuts_from_pauses(classified["cut"], 0.0, duration)

        # Snap the full-timeline analysis cuts so no caption line is ever
        # half-cut, and clamp to the clip's bounds. Retake cuts are kept in a
        # separate bucket: they remove DUPLICATED content, so they take
        # priority when the length floor forces a choice.
        def _snap_list(raw_cuts) -> list[tuple[float, float]]:
            out: list[tuple[float, float]] = []
            for raw in raw_cuts or []:
                c = (max(0.0, float(raw[0])), min(duration, float(raw[1])))
                if c[1] - c[0] < 0.4:
                    continue
                snapped = _snap_cut_to_caption_lines(c, lines)
                if snapped:
                    out.append(snapped)
            return out

        snapped_extra = _snap_list(extra_cuts)
        snapped_retake = _snap_list(retake_cuts)

        def _keeps_for(cut_set: list) -> list[tuple[float, float]]:
            ks: list[tuple[float, float]] = []
            cursor = 0.0
            for cs, ce in cut_set:
                if cs - cursor > 0.05:
                    ks.append((cursor, cs))
                cursor = max(cursor, ce)
            if duration - cursor > 0.05:
                ks.append((cursor, duration))
            return ks

        cuts = edit_effects_marco.merge_intervals(list(deadair) + snapped_extra + snapped_retake)
        removed = sum(e - s for s, e in cuts)
        if not cuts or (removed < _AUTO_TIGHTEN_MIN_SAVINGS and not snapped_extra and not snapped_retake):
            return None  # nothing worth cutting — keep the original clip

        keeps = _keeps_for(cuts)
        total_kept = sum(e - s for s, e in keeps)
        # Story-flow floor: the full cut set must not shrink the clip below
        # _MIN_AUTO_TIGHTEN_S. If it would, fall back to retake cuts ONLY —
        # a shorter clip beats one where Marco visibly repeats the same line —
        # and if even that over-shortens, leave the clip alone.
        if not keeps or total_kept < _MIN_AUTO_TIGHTEN_S:
            if not snapped_retake:
                return None  # only dead-air/gaze cuts — skip, keep full length
            cuts = edit_effects_marco.merge_intervals(list(snapped_retake))
            removed = sum(e - s for s, e in cuts)
            keeps = _keeps_for(cuts)
            total_kept = sum(e - s for s, e in keeps)
            if not keeps or total_kept < _MIN_TRIM_SECONDS:
                return None
            print(
                f"[openshorts] Clip {clip_index}: full smart-cut set would leave "
                f"{total_kept:.1f}s — applying retake cuts only"
            )

        parent = Path(base_path).parent
        stem = Path(base_path).stem
        token = uuid.uuid4().hex[:8]

        # Cut + concat the kept segments from the uncaptioned base. When there
        # are multiple segments (i.e. something was actually cut out), apply a
        # tiny audio fade at each boundary so the splice is inaudible.
        fade_s = _SPLICE_FADE_S if len(keeps) > 1 else 0.0
        segs = []
        for idx, (s, e) in enumerate(keeps):
            seg = str(parent / f"{stem}_tt{idx}_{token}.mp4")
            _cut_clip(input_path=base_path, output_path=seg, start_time=s, end_time=e, audio_fade_s=fade_s)
            segs.append(seg)
            tmp.append(seg)
        if len(segs) == 1:
            tight_base = segs[0]
        else:
            tight_base = str(parent / f"{stem}_ttbase_{token}.mp4")
            _concat_segments(segs, tight_base)
            tmp.append(tight_base)

        # Re-sync captions to the new timeline. write_edited_ass re-syncs the
        # ORIGINAL lines against `keeps` internally, so it must receive the
        # original lines (passing the already-synced ones would double-shift and
        # mis-time every caption). new_lines is the single-resynced set we persist.
        new_lines = caption_edit.resync_caption_lines(lines, keeps)
        cap_w, cap_h = captions_marco.get_video_resolution(tight_base)
        new_captioned = str(parent / f"{stem}_tight_{token}.mp4")
        ass_out = str(parent / f"{stem}_tight_{token}.ass")
        burned = False
        try:
            written = caption_edit.write_edited_ass(lines, keeps, cap_w, cap_h, ass_out) if lines else None
            if written:
                captions_marco.burn_captions(tight_base, ass_out, new_captioned)
                burned = os.path.isfile(new_captioned)
        finally:
            try:
                if os.path.exists(ass_out):
                    os.remove(ass_out)
            except Exception:
                pass
        if not burned:
            # No caption lines survived (or burn failed) — deliver the tightened
            # video uncaptioned rather than dropping the tighten.
            shutil.copyfile(tight_base, new_captioned)

        if not os.path.isfile(new_captioned) or not validate_video_file(new_captioned):
            return None

        # Clean seg intermediates, but keep tight_base (caller moves it onto _base.mp4).
        for f in tmp:
            if f != tight_base and os.path.exists(f):
                try:
                    os.remove(f)
                except Exception:
                    pass

        return {
            "new_captioned": new_captioned,
            "tight_base": tight_base,
            "new_lines": new_lines,
            "removed": round(removed, 2),
            "cuts": len(cuts),
            "new_duration": round(_probe_duration(new_captioned), 2),
        }
    except Exception as e:  # noqa: BLE001 — best-effort, never fail the clip
        print(f"[openshorts] auto-tighten error for clip {clip_index} (keeping original): {type(e).__name__}: {e}")
        for f in tmp:
            try:
                if os.path.exists(f):
                    os.remove(f)
            except Exception:
                pass
        return None


@app.post("/api/clips/edit")
async def edit_clip(
    clip_path: str = Form(...),
    edit_spec: str = Form(...),
):
    """
    Structural edit of an already-generated clip: trim the ends, remove one or
    more middle sections, and/or mute/remove the audio track. Re-renders with
    the same batch primitive (_cut_clip) + the memory-safe concat DEMUXER, under
    the shared processing slot and the same memory/disk guardrails. Captions are
    burned into the frames, so they ride along with every kept segment and stay
    in sync automatically. Never deletes the original — the caller repoints the
    clip only after this returns a confirmed-good file.

    edit_spec (JSON): {
      "trim":  {"start": float, "end": float} | null,   # clip-relative seconds
      "cuts":  [[start, end], ...],                       # middle sections to REMOVE
      "audio": "keep" | "mute" | "remove" | "replace",
      "captions": [{start, end, text}, ...] | null,       # re-synced caption lines

      # ── Phase 2 skills (all optional) ──────────────────────────────────────
      "color":  "auto"|"warm"|"cool"|"punch"|"flat"|null, # exposure/colour correct
      "effects": [                                         # zoom / punch-in (EDITED-
        {"type":"zoom_in"|"zoom_out"|"punch_in",           #  timeline seconds)
         "start": float, "end": float, "amount": 0.15}
      ],
      "autoTighten": true | {"maxGap": 0.6, "noiseDb": -30}, # remove dead air
      "snapToScenes": true                                  # snap cuts to scene changes
    }

    Coordinate spaces: trim/cuts/autoTighten/snapToScenes operate on the SOURCE
    clip timeline (before assembly); effects operate on the EDITED timeline (what
    the viewer sees after trim+cuts). Auto-generated cuts (dead-air tightening)
    are unioned with the caller's cuts, then optionally snapped to scene cuts, so
    the result is always a clean set of non-overlapping REMOVE intervals.
    """
    clips_root = os.path.realpath(str(CLIPS_OUTPUT_DIR))
    abs_clip = os.path.realpath(clip_path)
    if os.path.commonpath([abs_clip, clips_root]) != clips_root:
        raise HTTPException(status_code=400, detail="clip_path is outside the clips directory")
    if not os.path.isfile(abs_clip):
        raise HTTPException(status_code=410, detail="Clip file no longer available on disk")

    try:
        spec = json.loads(edit_spec)
    except Exception:
        raise HTTPException(status_code=400, detail="edit_spec is not valid JSON")

    duration = _probe_duration(abs_clip)
    if duration <= 0:
        raise HTTPException(status_code=422, detail="Could not read clip duration (file may be corrupt)")

    trim = spec.get("trim") or {"start": 0.0, "end": duration}
    t_start = max(0.0, float(trim.get("start", 0.0)))
    t_end = min(duration, float(trim.get("end", duration)))
    if t_end <= t_start:
        raise HTTPException(status_code=400, detail="Invalid trim range: end must be after start")

    audio_mode = str(spec.get("audio", "keep")).lower()
    if audio_mode not in ("keep", "mute", "remove", "replace"):
        raise HTTPException(status_code=400, detail="audio must be keep, mute, remove, or replace")

    # For replace: validate the uploaded audio file is real and inside /data.
    audio_replace_path = None
    if audio_mode == "replace":
        raw = spec.get("audioReplacePath")
        data_root = os.path.dirname(clips_root)
        aud_abs = os.path.realpath(str(raw)) if raw else ""
        if not aud_abs or not os.path.isfile(aud_abs) or os.path.commonpath([aud_abs, data_root]) != data_root:
            raise HTTPException(status_code=400, detail="Replacement audio file not found on the server")
        audio_replace_path = aud_abs

    # Normalize cuts, clamp into [t_start, t_end].
    raw_cuts = spec.get("cuts") or []
    cuts = []
    for c in raw_cuts:
        try:
            cs, ce = float(c[0]), float(c[1])
        except Exception:
            raise HTTPException(status_code=400, detail="each cut must be [start, end]")
        cs = max(t_start, min(cs, t_end))
        ce = max(t_start, min(ce, t_end))
        if ce - cs > 0.05:
            cuts.append([cs, ce])

    # NOTE: cut augmentation (auto-tighten dead air, snap-to-scenes) runs ffmpeg,
    # so it happens UNDER the processing slot below — after render_source and the
    # edited caption lines are resolved. keeps + the min-length check are built
    # there too, once the final cut set is known.

    # Parse the Phase-2 visual skills up front (pure validation, no ffmpeg).
    color_mode = spec.get("color")
    if color_mode is not None:
        color_mode = str(color_mode).lower()
        if color_mode not in edit_effects_marco._COLOR_PRESETS:
            raise HTTPException(
                status_code=400,
                detail=f"color must be one of {sorted(edit_effects_marco._COLOR_PRESETS)} or null",
            )
    effects = spec.get("effects") if isinstance(spec.get("effects"), list) else []

    if not _PROCESS_SLOT.acquire(timeout=_TRIM_SLOT_WAIT_S):
        raise HTTPException(status_code=503, detail="Video processor busy with another job — try again shortly")

    tmp_files = []
    new_path = None
    try:
        avail_mb = _available_memory_mb()
        if avail_mb is not None and avail_mb < _MIN_MEMORY_MB:
            raise HTTPException(status_code=503, detail=f"Not enough memory to edit safely: {avail_mb}MB available")
        has_space, available_mb = check_disk_space(clips_root, required_mb=300)
        if not has_space:
            raise HTTPException(status_code=507, detail=f"Insufficient disk space: only {available_mb}MB free")

        parent = Path(abs_clip).parent
        stem = Path(abs_clip).stem
        token = uuid.uuid4().hex[:8]

        # Caption editing renders from the persisted UNCAPTIONED base so text can
        # change, then re-burns the re-synced edited lines. Trim/cut/audio-only
        # edits render from the clip itself (captions ride along as burned pixels
        # — the existing behavior, no regression).
        edit_captions = spec.get("captions") if isinstance(spec.get("captions"), list) else None
        render_source = abs_clip
        if edit_captions is not None:
            base_stem = re.sub(r"_(edit|trim)_[0-9a-f]+$", "", stem)
            base_stem = re.sub(r"_(captioned|vertical)$", "", base_stem)
            base_path = str(parent / f"{base_stem}_base.mp4")
            if not os.path.isfile(base_path):
                raise HTTPException(
                    status_code=400,
                    detail="Caption editing isn't available for this clip (it was generated before editing support). Trim, cut, and audio still work.",
                )
            render_source = base_path

        # ── Phase 2/3: dead-air tightening (runs ffmpeg → under the slot) ──────
        # Detect silences in the render source within [t_start, t_end], keep the
        # intentional/dramatic pauses, and add REMOVE cuts for the genuine dead air.
        tighten = spec.get("autoTighten")
        if tighten:
            opts = tighten if isinstance(tighten, dict) else {}
            try:
                max_gap = float(opts.get("maxGap", 0.6))
                noise_db = float(opts.get("noiseDb", -30.0))
                pauses = audio_features_marco.detect_pauses(
                    render_source, noise_db=noise_db, min_silence_s=min(max_gap, 0.45)
                )
                # Prefer the caption lines being edited; otherwise fall back to the
                # clip's persisted lines so dramatic pauses are still recognised.
                classify_lines = edit_captions if edit_captions is not None else _load_caption_lines(abs_clip)
                classified = edit_effects_marco.classify_pauses(
                    pauses, classify_lines, max_keep_gap=max_gap
                )
                auto_cuts = edit_effects_marco.deadair_cuts_from_pauses(
                    classified["cut"], t_start, t_end
                )
                if auto_cuts:
                    print(
                        f"[edit] auto-tighten: {len(pauses)} pause(s) → {len(auto_cuts)} dead-air "
                        f"cut(s) added, {len(classified['keep'])} dramatic pause(s) kept"
                    )
                    cuts.extend(auto_cuts)
            except Exception as tighten_err:  # noqa: BLE001 — never fatal
                print(f"[edit] auto-tighten skipped: {type(tighten_err).__name__}: {tighten_err}")

        # ── Phase 2: scene-aware cut points ───────────────────────────────────
        if spec.get("snapToScenes") and cuts:
            try:
                scenes = edit_effects_marco.detect_scene_changes(render_source)
                if scenes:
                    cuts = edit_effects_marco.snap_cuts_to_scenes(cuts, scenes)
                    print(f"[edit] snap-to-scenes: {len(scenes)} scene change(s) detected")
            except Exception as snap_err:  # noqa: BLE001
                print(f"[edit] snap-to-scenes skipped: {type(snap_err).__name__}: {snap_err}")

        # Union overlapping/adjacent cuts — removing sections is commutative, so an
        # overlap is unambiguous (merge). This also absorbs any auto-generated cut
        # that abuts a caller cut.
        cuts = [tuple(c) for c in edit_effects_marco.merge_intervals(cuts)]

        # Build the ordered KEEP intervals = [t_start, t_end] minus the cuts.
        keeps = []
        cursor = t_start
        for cs, ce in cuts:
            if cs - cursor > 0.05:
                keeps.append((cursor, cs))
            cursor = max(cursor, ce)
        if t_end - cursor > 0.05:
            keeps.append((cursor, t_end))
        if not keeps:
            raise HTTPException(status_code=400, detail="Nothing left after trim + cuts")
        total_kept = sum(e - s for s, e in keeps)
        if total_kept < _MIN_TRIM_SECONDS:
            raise HTTPException(
                status_code=400,
                detail=f"Result must be at least {_MIN_TRIM_SECONDS:.0f}s (got {total_kept:.2f}s)",
            )

        # 1) Re-encode each kept interval (bounded ~300MB each via _cut_clip).
        # Multi-segment joins get the same tiny splice fades as the batch
        # auto-tighten path, so manual/AI edits never pop at cut points.
        edit_fade_s = _SPLICE_FADE_S if len(keeps) > 1 else 0.0
        segments = []
        for idx, (s, e) in enumerate(keeps):
            seg = str(parent / f"{stem}_seg{idx}_{token}.mp4")
            _cut_clip(input_path=render_source, output_path=seg, start_time=s, end_time=e, audio_fade_s=edit_fade_s)
            segments.append(seg)
            tmp_files.append(seg)

        # 2) One segment => no splice needed; else concat with the demuxer.
        if len(segments) == 1:
            joined = segments[0]
        else:
            joined = str(parent / f"{stem}_joined_{token}.mp4")
            _concat_segments(segments, joined)
            tmp_files.append(joined)

        # 3) Audio: keep as-is, strip for mute/remove, or swap for replace.
        if audio_mode in ("mute", "remove"):
            audio_out = str(parent / f"{stem}_aud_{token}.mp4")
            _strip_audio(joined, audio_out)
            tmp_files.append(audio_out)
        elif audio_mode == "replace":
            audio_out = str(parent / f"{stem}_aud_{token}.mp4")
            _replace_audio(joined, audio_replace_path, audio_out)
            tmp_files.append(audio_out)
        else:
            audio_out = joined

        # 3b) Phase 2 visual polish — colour/exposure correct + zoom/punch-in in ONE
        # re-encode, applied BEFORE captions so burned-in text is never scaled or
        # cropped by a zoom. Effects are in edited-timeline seconds (audio_out is
        # already the edited timeline). No-op when neither color nor effects are set.
        if color_mode or effects:
            try:
                vw, vh = edit_effects_marco.probe_resolution(audio_out)
                vfps = edit_effects_marco.probe_fps(audio_out)
                visual_fg = edit_effects_marco.build_visual_filtergraph(
                    effects, color_mode, vw, vh, vfps
                )
            except Exception as fg_err:  # noqa: BLE001
                print(f"[edit] visual filter build skipped: {type(fg_err).__name__}: {fg_err}")
                visual_fg = None
            if visual_fg:
                fx_out = str(parent / f"{stem}_fx_{token}.mp4")
                _apply_visual_pass(audio_out, fx_out, visual_fg)
                tmp_files.append(fx_out)
                audio_out = fx_out
                print(f"[edit] visual pass applied (color={color_mode or 'none'}, effects={len(effects)})")

        # 4) Captions: burn the re-synced edited lines onto the base-rendered video.
        new_path = str(parent / f"{stem}_edit_{token}.mp4")
        if edit_captions is not None:
            import caption_edit
            cap_w, cap_h = captions_marco.get_video_resolution(audio_out)
            ass_out = str(parent / f"{stem}_edit_{token}.ass")
            written = caption_edit.write_edited_ass(edit_captions, keeps, cap_w, cap_h, ass_out)
            try:
                if written:
                    captions_marco.burn_captions(audio_out, ass_out, new_path)
                else:
                    # No caption lines survive the edit → keep the uncaptioned render.
                    if audio_out in tmp_files:
                        tmp_files.remove(audio_out)
                    os.replace(audio_out, new_path)
            finally:
                try:
                    if os.path.exists(ass_out):
                        os.remove(ass_out)
                except Exception:
                    pass
        else:
            if audio_out in tmp_files:
                tmp_files.remove(audio_out)
            os.replace(audio_out, new_path)

        if not os.path.isfile(new_path) or not validate_video_file(new_path):
            raise HTTPException(status_code=500, detail="Edit produced no readable output file")

        new_duration = _probe_duration(new_path)
        rel_url = os.path.relpath(new_path, clips_root).replace(os.sep, "/")
        print(
            f"[openshorts] Edited {os.path.basename(abs_clip)} -> {os.path.basename(new_path)} "
            f"({new_duration:.1f}s, {len(keeps)} kept segment(s), audio={audio_mode})"
        )
        return {
            "new_clip_path": new_path,
            "new_clip_url": f"/clips/{rel_url}",
            "new_duration": round(new_duration, 2),
        }
    except HTTPException:
        if new_path and os.path.exists(new_path):
            try:
                os.remove(new_path)
            except Exception:
                pass
        raise
    except Exception as e:
        if new_path and os.path.exists(new_path):
            try:
                os.remove(new_path)
            except Exception:
                pass
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Edit failed: {type(e).__name__}: {e}")
    finally:
        for f in tmp_files:
            try:
                if os.path.exists(f):
                    os.remove(f)
            except Exception:
                pass
        _PROCESS_SLOT.release()


@app.post("/api/clips/suggest-cuts")
async def suggest_cuts(
    clip_path: str = Form(...),
    max_gap: float = Form(0.6),
    noise_db: float = Form(-30.0),
):
    """Phase 3 — analyse a clip and SUGGEST edits without applying any.

    Returns the dead-air cuts the engine would make, the dramatic pauses it would
    KEEP (so the caller can see the engine isn't flattening deliberate beats),
    filler-only caption lines, and scene-change timestamps. The caller (UI or an
    autonomous cycle) can then apply the ones it wants via /api/clips/edit. This
    is read-only: it renders nothing and never mutates the clip.
    """
    clips_root = os.path.realpath(str(CLIPS_OUTPUT_DIR))
    abs_clip = os.path.realpath(clip_path)
    if os.path.commonpath([abs_clip, clips_root]) != clips_root:
        raise HTTPException(status_code=400, detail="clip_path is outside the clips directory")
    if not os.path.isfile(abs_clip):
        raise HTTPException(status_code=410, detail="Clip file no longer available on disk")

    duration = _probe_duration(abs_clip)
    if duration <= 0:
        raise HTTPException(status_code=422, detail="Could not read clip duration (file may be corrupt)")

    # Reuse the persisted editable caption lines if this clip has them, so pause
    # classification can tell a mid-sentence stumble from a sentence-final beat.
    lines = _load_caption_lines(abs_clip)

    if not _PROCESS_SLOT.acquire(timeout=_TRIM_SLOT_WAIT_S):
        raise HTTPException(status_code=503, detail="Video processor busy with another job — try again shortly")
    try:
        pauses = audio_features_marco.detect_pauses(
            abs_clip, noise_db=noise_db, min_silence_s=min(max_gap, 0.45)
        )
        classified = edit_effects_marco.classify_pauses(pauses, lines, max_keep_gap=max_gap)
        deadair = edit_effects_marco.merge_intervals(
            edit_effects_marco.deadair_cuts_from_pauses(classified["cut"], 0.0, duration)
        )
        scenes = edit_effects_marco.detect_scene_changes(abs_clip)
        est_removed = round(sum(e - s for s, e in deadair), 2)
        return {
            "duration": round(duration, 2),
            "suggested_cuts": [[round(s, 2), round(e, 2)] for s, e in deadair],
            "estimated_removed_seconds": est_removed,
            "estimated_result_seconds": round(max(0.0, duration - est_removed), 2),
            "dramatic_pauses_kept": classified["keep"],
            "filler_lines": classified["fillers"],
            "scene_changes": scenes,
        }
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"suggest-cuts failed: {type(e).__name__}: {e}")
    finally:
        _PROCESS_SLOT.release()


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
