"""Deterministic audio features on synthetic clips (backend/audiofeat.py).

Run: .venv/bin/python backend/test_audiofeat.py
"""
import io
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent))
import audiofeat  # noqa: E402

SR = 16000


def clip(seconds=3.0, noise=0.01, seed=0):
    rng = np.random.default_rng(seed)
    return noise * rng.standard_normal(int(seconds * SR)).astype("float32")


def beep(x, start, ms, hz=2700, amp=0.5):
    t = np.arange(int(ms / 1000 * SR)) / SR
    a = int(start * SR)
    x[a:a + len(t)] += amp * np.sin(2 * np.pi * hz * t)


def click(x, start, amp=0.8):
    a = int(start * SR)
    n = int(0.004 * SR)
    x[a:a + n] += amp * np.random.default_rng(1).uniform(-1, 1, n) * np.hanning(n)


def wav(x):
    buf = io.BytesIO()
    sf.write(buf, x, SR, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def test_three_inverter_beeps():
    x = clip()
    for k in range(3):
        beep(x, 0.2 + k, 250)
    f = audiofeat.from_wav(wav(x))
    assert f["beeps"] == 3, f
    assert 220 <= f["beep_ms"] <= 280, f
    assert 950 <= f["beep_interval_ms"] <= 1050, f
    assert 2600 <= f["beep_hz"] <= 2800, f
    assert f["clicks"] == 0, f


def test_five_short_beeps():
    x = clip()
    for k in range(5):
        beep(x, 0.15 + 0.5 * k, 120, hz=3000)
    f = audiofeat.from_wav(wav(x))
    assert f["beeps"] == 5, f
    assert 100 <= f["beep_ms"] <= 140, f
    assert 450 <= f["beep_interval_ms"] <= 550, f


def test_start_button_clicks():
    x = clip()
    for s in (0.5, 1.4, 2.3):
        click(x, s)
    f = audiofeat.from_wav(wav(x))
    assert f["clicks"] == 3, f
    assert f["beeps"] == 0, f


def test_silence_has_no_events():
    f = audiofeat.from_wav(wav(clip()))
    assert f["beeps"] == 0 and f["clicks"] == 0, f


def test_summary_is_plain_numbers():
    x = clip()
    for k in range(3):
        beep(x, 0.2 + k, 250)
    s = audiofeat.summary(audiofeat.from_wav(wav(x)))
    assert "3 beeps" in s and "ms" in s and "Hz" in s, s


def test_stereo_48k_is_handled():
    x = clip(seconds=2.0)
    for k in range(2):
        beep(x, 0.3 + 0.8 * k, 200)
    up = np.repeat(x, 3)  # 48 kHz
    buf = io.BytesIO()
    sf.write(buf, np.stack([up, up], axis=1), 48000, format="WAV", subtype="PCM_16")
    f = audiofeat.from_wav(buf.getvalue())
    assert f["beeps"] == 2 and f["sample_rate"] == 48000, f


if __name__ == "__main__":
    tests = [(n, fn) for n, fn in sorted(globals().items()) if n.startswith("test_")]
    for name, fn in tests:
        fn()
        print(f"ok  {name}")
    print(f"\n{len(tests)} passed")
