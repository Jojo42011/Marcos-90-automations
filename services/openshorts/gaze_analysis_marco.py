"""
Marco Puga Realty — full-timeline gaze / eye-contact analysis.

Claude sees only ~16 sampled keyframes; that is enough to judge shot quality
but NOT enough to find every moment Marco looks away from the camera. This
module walks the ENTIRE video timeline locally with MediaPipe Face Mesh (the
same library the vertical-reframe pass already ships) and produces a
continuous camera-eye-contact map:

  • per sampled frame: is a face present, and is the head/gaze pointed at the
    camera (yaw/pitch from facial geometry + iris offset)?
  • merged into segments: [{start, end, dur, kind: "looking_away"|"no_face"}]

Downstream uses:
  1. Clip selection — a compact brief tells the model where eye contact breaks,
     so it avoids opening clips on an away-look.
  2. Generation-time cutting — sustained away-look segments inside a chosen
     clip are removed by the same keep/cut/concat machinery as dead-air removal.

Sampling: the timeline is scanned continuously at OPENSHORTS_GAZE_FPS
(default 12 samples/sec — one look every 83ms). Cuts only ever apply to
away-looks ≥0.8s, so nothing that matters can slip between samples; full
native-fps scanning is available (GAZE_FPS=0) but costs ~10-18 CPU minutes on
a 30-minute source for no additional cutting precision.

Everything is best-effort by contract: any failure returns
{"available": False} and the pipeline behaves exactly as before.
"""
from __future__ import annotations

import os
import time
from typing import Any

# Head-yaw beyond this ratio reads as "looking away". Derived from the nose
# position between the eye corners: 0 = dead-centre, 1 = fully profile.
_YAW_AWAY = float(os.environ.get("OPENSHORTS_GAZE_YAW_AWAY", "0.42"))
# Iris offset (fraction of eye width from eye centre) that reads as eyes-averted
# even when the head is square to camera.
_IRIS_AWAY = float(os.environ.get("OPENSHORTS_GAZE_IRIS_AWAY", "0.30"))
# Analysis sampling rate (samples/sec across the whole timeline). 0 = native fps.
_SAMPLE_FPS = float(os.environ.get("OPENSHORTS_GAZE_FPS", "12"))
# An away-look must persist this long before it becomes a segment; brief
# glances are natural delivery, not defects.
_MIN_AWAY_S = float(os.environ.get("OPENSHORTS_GAZE_MIN_AWAY_S", "0.8"))
# Merge segments separated by less than this (flicker suppression).
_MERGE_GAP_S = 0.25
# If a face is found in fewer than this fraction of frames, the footage is not
# a talking-head video (b-roll, walkthrough) — report but mark unreliable so
# nothing gets auto-cut.
_MIN_FACE_COVERAGE = 0.50
# Hard wall-clock ceiling for the scan; a stuck decode must never eat the job.
_SCAN_TIMEOUT_S = int(os.environ.get("OPENSHORTS_GAZE_TIMEOUT_S", "600"))
# Downscale frames to this width before FaceMesh — landmark accuracy at 480px
# is ample for yaw estimation and ~4x faster than 1080p.
_SCAN_WIDTH = 480

# FaceMesh landmark indices (canonical MediaPipe topology).
_L_EYE_OUTER, _L_EYE_INNER = 33, 133
_R_EYE_INNER, _R_EYE_OUTER = 362, 263
_NOSE_TIP = 1
_L_IRIS = (468, 469, 470, 471, 472)
_R_IRIS = (473, 474, 475, 476, 477)


def _frame_metrics(landmarks) -> dict[str, float]:
    """Yaw + iris-offset estimates from one FaceMesh result (all ratios, 0-centred)."""
    lx_o, lx_i = landmarks[_L_EYE_OUTER].x, landmarks[_L_EYE_INNER].x
    rx_i, rx_o = landmarks[_R_EYE_INNER].x, landmarks[_R_EYE_OUTER].x
    nose_x = landmarks[_NOSE_TIP].x

    face_left = min(lx_o, lx_i)
    face_right = max(rx_o, rx_i)
    face_w = max(1e-6, face_right - face_left)
    # 0 = nose centred between the eyes (facing camera); ±1 = fully to one side.
    yaw = ((nose_x - face_left) / face_w - 0.5) * 2.0

    # Iris offset within each eye (requires refine_landmarks=True).
    def iris_offset(iris_idx, inner_x, outer_x) -> float:
        eye_l, eye_r = min(inner_x, outer_x), max(inner_x, outer_x)
        eye_w = max(1e-6, eye_r - eye_l)
        cx = sum(landmarks[i].x for i in iris_idx) / len(iris_idx)
        return ((cx - eye_l) / eye_w - 0.5) * 2.0

    try:
        iris = (iris_offset(_L_IRIS, lx_i, lx_o) + iris_offset(_R_IRIS, rx_i, rx_o)) / 2.0
    except IndexError:  # refine_landmarks unavailable → head pose only
        iris = 0.0

    return {"yaw": yaw, "iris": iris}


def analyze_gaze(video_path: str, sample_fps: float | None = None) -> dict[str, Any]:
    """Scan the full timeline; return the camera-eye-contact map.

    Returns a dict that is always safe to consume:
      {"available": bool, "reliable": bool, "coverage": float,
       "away_segments": [{"start","end","dur","kind"}], "away_total_s": float,
       "frames_analyzed": int, "sample_fps": float}
    """
    result: dict[str, Any] = {
        "available": False,
        "reliable": False,
        "coverage": 0.0,
        "away_segments": [],
        "away_total_s": 0.0,
        "frames_analyzed": 0,
        "sample_fps": 0.0,
    }
    if not video_path or not os.path.isfile(video_path):
        return result

    try:
        import cv2  # noqa: PLC0415 — lazy: sidecar image has it, dev boxes may not
        import mediapipe as mp  # noqa: PLC0415
    except Exception as err:  # noqa: BLE001
        print(f"[gaze] mediapipe/cv2 unavailable — gaze analysis skipped: {err}")
        return result

    cap = None
    mesh = None
    try:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return result
        native_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        if native_fps <= 0 or native_fps > 240:
            native_fps = 30.0
        want_fps = sample_fps if sample_fps is not None else _SAMPLE_FPS
        stride = 1 if want_fps <= 0 else max(1, round(native_fps / want_fps))
        effective_fps = native_fps / stride

        mesh = mp.solutions.face_mesh.FaceMesh(
            static_image_mode=False,
            max_num_faces=1,
            refine_landmarks=True,  # iris landmarks 468-477
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
        )

        started = time.monotonic()
        frame_idx = 0
        samples: list[tuple[float, str]] = []  # (t, "ok"|"away"|"no_face")
        while True:
            if time.monotonic() - started > _SCAN_TIMEOUT_S:
                print(f"[gaze] scan hit {_SCAN_TIMEOUT_S}s ceiling — using partial map")
                break
            ok = cap.grab()
            if not ok:
                break
            if frame_idx % stride != 0:
                frame_idx += 1
                continue
            ok, frame = cap.retrieve()
            frame_idx += 1
            if not ok or frame is None:
                continue
            t = (frame_idx - 1) / native_fps
            h, w = frame.shape[:2]
            if w > _SCAN_WIDTH:
                frame = cv2.resize(
                    frame, (_SCAN_WIDTH, max(1, int(h * _SCAN_WIDTH / w))),
                    interpolation=cv2.INTER_AREA,
                )
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            res = mesh.process(rgb)
            if not res.multi_face_landmarks:
                samples.append((t, "no_face"))
                continue
            m = _frame_metrics(res.multi_face_landmarks[0].landmark)
            away = abs(m["yaw"]) >= _YAW_AWAY or abs(m["iris"]) >= _IRIS_AWAY
            samples.append((t, "away" if away else "ok"))

        if not samples:
            return result

        faced = sum(1 for _, s in samples if s != "no_face")
        coverage = faced / len(samples)

        # Runs of consecutive non-"ok" samples → raw segments.
        segments: list[dict[str, Any]] = []
        run_start: float | None = None
        run_kind: str | None = None
        sample_dt = 1.0 / effective_fps
        prev_t = samples[0][0]
        for t, state in samples:
            bad = state != "ok"
            if bad and run_start is None:
                run_start, run_kind = t, state
            elif bad and run_kind != state:
                segments.append({"start": run_start, "end": t, "kind": run_kind})
                run_start, run_kind = t, state
            elif not bad and run_start is not None:
                segments.append({"start": run_start, "end": t, "kind": run_kind})
                run_start, run_kind = None, None
            prev_t = t
        if run_start is not None:
            segments.append({"start": run_start, "end": prev_t + sample_dt, "kind": run_kind})

        # Merge near-adjacent, then drop blips shorter than the action threshold.
        merged: list[dict[str, Any]] = []
        for seg in segments:
            if merged and seg["start"] - merged[-1]["end"] <= _MERGE_GAP_S and seg["kind"] == merged[-1]["kind"]:
                merged[-1]["end"] = seg["end"]
            else:
                merged.append(dict(seg))
        away = [
            {
                "start": round(s["start"], 2),
                "end": round(s["end"], 2),
                "dur": round(s["end"] - s["start"], 2),
                "kind": "no_face" if s["kind"] == "no_face" else "looking_away",
            }
            for s in merged
            if s["end"] - s["start"] >= _MIN_AWAY_S
        ]

        result.update(
            available=True,
            reliable=coverage >= _MIN_FACE_COVERAGE,
            coverage=round(coverage, 3),
            away_segments=away,
            away_total_s=round(sum(s["dur"] for s in away), 2),
            frames_analyzed=len(samples),
            sample_fps=round(effective_fps, 2),
        )
        return result
    except Exception as err:  # noqa: BLE001 — best-effort, never fatal
        print(f"[gaze] analysis failed: {type(err).__name__}: {err}")
        return result
    finally:
        try:
            if cap is not None:
                cap.release()
            if mesh is not None:
                mesh.close()
        except Exception:
            pass


def gaze_prompt_block(gaze: dict[str, Any]) -> str:
    """Compact camera-eye-contact brief for the clip-selection prompt."""
    if not gaze or not gaze.get("available"):
        return ""
    away = gaze.get("away_segments", [])
    if not gaze.get("reliable"):
        return (
            "\nCAMERA EYE-CONTACT MAP: a face was visible in only "
            f"{gaze.get('coverage', 0) * 100:.0f}% of frames — this is likely NOT "
            "steady talking-head footage, so eye-contact data is unreliable here.\n"
        )
    if not away:
        return (
            "\nCAMERA EYE-CONTACT MAP (full-timeline scan): Marco holds eye contact "
            "with the camera throughout — no sustained look-aways detected.\n"
        )
    shown = ", ".join(
        f"{s['start']:.0f}-{s['end']:.0f}s ({s['kind'].replace('_', ' ')})" for s in away[:12]
    )
    more = f", … (+{len(away) - 12} more)" if len(away) > 12 else ""
    return (
        "\nCAMERA EYE-CONTACT MAP (full-timeline scan, every moment checked): Marco "
        f"breaks eye contact with the camera at: {shown}{more}. Total away time: "
        f"{gaze.get('away_total_s', 0):.0f}s.\n"
        "Guidance: NEVER open a clip inside one of these ranges (a hook with no eye "
        "contact dies). Prefer moments with locked-in eye contact; sustained "
        "away-looks inside your chosen clips will be trimmed automatically after "
        "rendering, so favour ranges that stay clean.\n"
    )


def away_cut_candidates(
    gaze: dict[str, Any],
    clip_start: float,
    clip_end: float,
) -> list[tuple[float, float]]:
    """Away-look segments overlapping [clip_start, clip_end], in CLIP-LOCAL time.

    Only returns candidates when the scan was reliable; the caller merges these
    with dead-air cuts and applies the usual snapping/min-length guards.
    """
    if not gaze or not gaze.get("available") or not gaze.get("reliable"):
        return []
    out: list[tuple[float, float]] = []
    for seg in gaze.get("away_segments", []):
        s = max(float(seg["start"]), clip_start)
        e = min(float(seg["end"]), clip_end)
        if e - s >= _MIN_AWAY_S:
            out.append((round(s - clip_start, 2), round(e - clip_start, 2)))
    return out
