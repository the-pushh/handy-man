"""Deterministic audio features for beeps, clicks and loudness.

Input: a short mono WAV (the browser records 3-5s with echo cancellation,
noise suppression and auto-gain all off). Output: numbers a model can
reason over, passed to diagnose() as structured text. Muse Wonder hears
the same clip as a cross-check; the numbers here are the source of
truth for counts and timings (Wonder counts well, times poorly).

Method (all numpy, no learned parts):
  - 10 ms frames, RMS energy in dB.
  - Noise floor = 20th percentile frame energy; a frame is "loud" when
    it is 12 dB over the floor and within 30 dB of the loudest frame.
  - Loud runs (gaps < 40 ms merged) become events.
  - An event >= 60 ms that is tonal (one spectral peak dominates) is a
    beep; an event < 60 ms with a sharp energy jump is a click.
"""

import io
import math

import numpy as np

FRAME_S = 0.010
FLOOR_PCTL = 20
OVER_FLOOR_DB = 12.0
BELOW_PEAK_DB = 30.0
MERGE_GAP_S = 0.040
BEEP_MIN_S = 0.060
CLICK_MAX_S = 0.060
TONAL_RATIO = 8.0  # peak bin / median bin magnitude


def load_wav(data: bytes) -> tuple:
    """WAV bytes -> (mono float32 in [-1, 1], sample rate)."""
    import soundfile as sf

    x, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    return x.mean(axis=1), int(sr)


def _db(v: float) -> float:
    return 20 * math.log10(max(v, 1e-9))


def _events(loud: np.ndarray) -> list:
    """Boolean frame mask -> [(start_frame, end_frame)] with gaps merged."""
    runs, start = [], None
    for i, on in enumerate(loud):
        if on and start is None:
            start = i
        elif not on and start is not None:
            runs.append([start, i])
            start = None
    if start is not None:
        runs.append([start, len(loud)])
    merged = []
    gap = int(round(MERGE_GAP_S / FRAME_S))
    for r in runs:
        if merged and r[0] - merged[-1][1] < gap:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    return [tuple(r) for r in merged]


def _tone(seg: np.ndarray, sr: int) -> tuple:
    """(dominant frequency Hz, tonality ratio) of a segment."""
    if len(seg) < 32:
        return 0.0, 0.0
    win = seg * np.hanning(len(seg))
    mag = np.abs(np.fft.rfft(win))
    freqs = np.fft.rfftfreq(len(seg), 1 / sr)
    band = (freqs > 150) & (freqs < min(8000, sr / 2))
    if not band.any():
        return 0.0, 0.0
    m, f = mag[band], freqs[band]
    k = int(np.argmax(m))
    return float(f[k]), float(m[k] / (np.median(m) + 1e-9))


def features(x: np.ndarray, sr: int) -> dict:
    hop = max(1, int(sr * FRAME_S))
    n = len(x) // hop
    duration = len(x) / sr if sr else 0.0
    if n < 5:
        return {"duration_s": round(duration, 2), "beeps": 0, "clicks": 0,
                "events": [], "rms_dbfs": None, "peak_dbfs": None,
                "noise_floor_dbfs": None, "beep_ms": None,
                "beep_interval_ms": None, "beep_hz": None}
    frames = x[: n * hop].reshape(n, hop)
    rms = np.sqrt((frames ** 2).mean(axis=1))
    edb = np.array([_db(v) for v in rms])
    floor = float(np.percentile(edb, FLOOR_PCTL))
    top = float(edb.max())
    loud = (edb > floor + OVER_FLOOR_DB) & (edb > top - BELOW_PEAK_DB)

    events = []
    for a, b in _events(loud):
        seg = x[a * hop: b * hop]
        dur = (b - a) * FRAME_S
        hz, ratio = _tone(seg, sr)
        jump = float(edb[a] - edb[max(0, a - 2)])
        if dur >= BEEP_MIN_S and ratio >= TONAL_RATIO:
            kind = "beep"
        elif dur < CLICK_MAX_S and jump >= OVER_FLOOR_DB:
            kind = "click"
        else:
            kind = "sound"
        events.append({"kind": kind, "start_s": round(a * FRAME_S, 3),
                       "duration_ms": int(round(dur * 1000)),
                       "hz": int(round(hz)) if kind == "beep" else None,
                       "level_dbfs": round(float(edb[a:b].max()), 1)})

    beeps = [e for e in events if e["kind"] == "beep"]
    starts = [e["start_s"] for e in beeps]
    intervals = [b - a for a, b in zip(starts, starts[1:])]
    med = lambda v: float(np.median(v)) if v else None  # noqa: E731
    return {
        "duration_s": round(duration, 2),
        "rms_dbfs": round(_db(float(np.sqrt((x ** 2).mean()))), 1),
        "peak_dbfs": round(_db(float(np.abs(x).max())), 1),
        "noise_floor_dbfs": round(floor, 1),
        "beeps": len(beeps),
        "beep_ms": int(med([e["duration_ms"] for e in beeps])) if beeps else None,
        "beep_interval_ms": int(med(intervals) * 1000) if intervals else None,
        "beep_hz": int(med([e["hz"] for e in beeps])) if beeps else None,
        "clicks": sum(1 for e in events if e["kind"] == "click"),
        "other_sounds": sum(1 for e in events if e["kind"] == "sound"),
        "events": events[:40],
    }


def from_wav(data: bytes) -> dict:
    x, sr = load_wav(data)
    out = features(x, sr)
    out["sample_rate"] = sr
    return out


def summary(f: dict) -> str:
    """Structured text for diagnose(): measured numbers only."""
    if f.get("rms_dbfs") is None:
        return "Sound clip: too short to measure."
    parts = [f"Sound clip measured over {f['duration_s']}s "
             f"(loudness {f['rms_dbfs']} dBFS, peak {f['peak_dbfs']} dBFS)"]
    if f["beeps"]:
        b = f"{f['beeps']} beep{'s' if f['beeps'] != 1 else ''}"
        if f.get("beep_ms"):
            b += f", each ~{f['beep_ms']} ms"
        if f.get("beep_interval_ms"):
            b += f", repeating every ~{f['beep_interval_ms']} ms"
        if f.get("beep_hz"):
            b += f", tone ~{f['beep_hz']} Hz"
        parts.append(b)
    else:
        parts.append("no beeps")
    parts.append(f"{f['clicks']} click{'s' if f['clicks'] != 1 else ''}")
    if f.get("other_sounds"):
        parts.append(f"{f['other_sounds']} other non-tonal sound(s)")
    return "; ".join(parts) + "."
